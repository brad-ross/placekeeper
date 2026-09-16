import type { Stats } from "node:fs";
import { watch } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export type LocalDocumentObservationReason =
  | "startup"
  | "activation"
  | "reconnect"
  | "watcher"
  | "identity"
  | "audit"
  | "retry"
  | "host-hint";

export interface LocalDocumentIdentity {
  readonly device: number;
  readonly inode: number;
  readonly byteLength: number;
  readonly modifiedAtMs: number;
}

export interface LocalDocumentCandidate {
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly sequence: number;
  readonly reason: LocalDocumentObservationReason;
  readonly identity?: LocalDocumentIdentity;
  readonly hostHintToken?: string;
}

export interface LocalDocumentInspectionResult {
  readonly status: "current" | "retry";
}

export interface LocalDocumentWatch {
  on(event: "change", listener: (eventType: string, filename?: string | Buffer | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  close(): void;
  unref?(): void;
}

export interface LocalDocumentObserverOptions<Result extends LocalDocumentInspectionResult = LocalDocumentInspectionResult> {
  readonly inspectCandidate: (candidate: LocalDocumentCandidate) => Promise<Result>;
  readonly admitCandidate?: (candidate: Omit<LocalDocumentCandidate, "identity">) => void;
  readonly settleUnchangedCandidate?: (candidate: Omit<LocalDocumentCandidate, "identity">) => void;
  readonly watchDirectory?: (directory: string) => LocalDocumentWatch;
  readonly inspectIdentity?: (path: string) => Promise<Stats>;
  readonly coalesceMs?: number;
  readonly identityIntervalMs?: number;
  readonly auditIntervalMs?: number;
  readonly maxRetryMs?: number;
}

interface ObservedDocument<Result extends LocalDocumentInspectionResult> {
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly directory: string;
  readonly basename: string;
  lastIdentity?: LocalDocumentIdentity;
  explicitIdentity?: LocalDocumentIdentity;
  explicitSequence?: number;
  explicitIdentityReady?: Promise<LocalDocumentIdentity | undefined>;
  latestSequence: number;
  unvalidatedWatcherSequence?: number;
  retryMs: number;
  pending?: { reason: LocalDocumentObservationReason; sequence: number };
  coalesceTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  identityTimer: ReturnType<typeof setInterval>;
  auditTimer: ReturnType<typeof setInterval>;
  completion: Promise<Result | undefined>;
}

interface DirectoryWatch<Result extends LocalDocumentInspectionResult> {
  readonly sessions: Map<string, ObservedDocument<Result>>;
  watcher?: LocalDocumentWatch;
  retryTimer?: ReturnType<typeof setTimeout>;
}

interface QueuedInspection<Result extends LocalDocumentInspectionResult> {
  readonly record: ObservedDocument<Result>;
  readonly candidate: Omit<LocalDocumentCandidate, "identity">;
  readonly completion: Promise<Result | undefined>;
  readonly resolveCompletion: (result: Result | undefined) => void;
}

function identity(info: Stats): LocalDocumentIdentity | undefined {
  if (!info.isFile() || info.isSymbolicLink()) return undefined;
  return {
    device: info.dev,
    inode: info.ino,
    byteLength: info.size,
    modifiedAtMs: info.mtimeMs,
  };
}

function sameIdentity(left: LocalDocumentIdentity | undefined, right: LocalDocumentIdentity | undefined): boolean {
  return left !== undefined && right !== undefined &&
    left.device === right.device && left.inode === right.inode &&
    left.byteLength === right.byteLength && left.modifiedAtMs === right.modifiedAtMs;
}

/** Service-owned wakeup and ordering authority for active local documents.
 * Filesystem notifications only schedule a safely revalidated candidate check. */
export class LocalDocumentObserver<Result extends LocalDocumentInspectionResult = LocalDocumentInspectionResult> {
  readonly #inspectCandidate: LocalDocumentObserverOptions<Result>["inspectCandidate"];
  readonly #admitCandidate: NonNullable<LocalDocumentObserverOptions<Result>["admitCandidate"]>;
  readonly #settleUnchangedCandidate: NonNullable<LocalDocumentObserverOptions<Result>["settleUnchangedCandidate"]>;
  readonly #watchDirectory: NonNullable<LocalDocumentObserverOptions<Result>["watchDirectory"]>;
  readonly #inspectIdentity: NonNullable<LocalDocumentObserverOptions<Result>["inspectIdentity"]>;
  readonly #coalesceMs: number;
  readonly #identityIntervalMs: number;
  readonly #auditIntervalMs: number;
  readonly #maxRetryMs: number;
  readonly #documents = new Map<string, ObservedDocument<Result>>();
  readonly #directories = new Map<string, DirectoryWatch<Result>>();
  readonly #queuedInspections = new Map<string, QueuedInspection<Result>>();
  #nextSequence = 0;
  #draining = false;
  #disposed = false;
  readonly #idleWaiters = new Set<() => void>();

  constructor(options: LocalDocumentObserverOptions<Result>) {
    this.#inspectCandidate = options.inspectCandidate;
    this.#admitCandidate = options.admitCandidate ?? (() => undefined);
    this.#settleUnchangedCandidate = options.settleUnchangedCandidate ?? (() => undefined);
    this.#watchDirectory = options.watchDirectory ?? ((directory) => watch(directory, { persistent: false }));
    this.#inspectIdentity = options.inspectIdentity ?? lstat;
    this.#coalesceMs = options.coalesceMs ?? 250;
    this.#identityIntervalMs = options.identityIntervalMs ?? 5_000;
    this.#auditIntervalMs = options.auditIntervalMs ?? 60_000;
    this.#maxRetryMs = options.maxRetryMs ?? 5_000;
  }

  has(sessionId: string): boolean { return this.#documents.has(sessionId); }
  isCurrent(sessionId: string, sequence: number): boolean {
    return this.#documents.get(sessionId)?.latestSequence === sequence;
  }

  observe(input: {
    readonly sessionId: string;
    readonly sourcePath: string;
    readonly initialSequence?: number;
    readonly initialIdentity?: LocalDocumentIdentity;
  }): void {
    if (this.#disposed || this.#documents.has(input.sessionId)) return;
    const sourcePath = resolve(input.sourcePath);
    this.#nextSequence = Math.max(this.#nextSequence, input.initialSequence ?? 0);
    const record: ObservedDocument<Result> = {
      sessionId: input.sessionId,
      sourcePath,
      directory: dirname(sourcePath),
      basename: basename(sourcePath),
      ...(input.initialIdentity === undefined ? {} : { lastIdentity: input.initialIdentity }),
      latestSequence: input.initialSequence ?? 0,
      retryMs: this.#coalesceMs,
      identityTimer: setInterval(() => this.#request(record, "identity"), this.#identityIntervalMs),
      auditTimer: setInterval(() => this.#request(record, "audit"), this.#auditIntervalMs),
      completion: Promise.resolve(undefined),
    };
    record.identityTimer.unref?.();
    record.auditTimer.unref?.();
    this.#documents.set(record.sessionId, record);
    let directory = this.#directories.get(record.directory);
    if (directory === undefined) {
      directory = { sessions: new Map() };
      this.#directories.set(record.directory, directory);
      this.#startWatch(record.directory, directory);
    }
    directory.sessions.set(record.sessionId, record);
    this.#request(record, "startup", true);
  }

  hint(sessionId: string, input: { readonly token?: string } = {}): Promise<Result | undefined> {
    const record = this.#documents.get(sessionId);
    if (record === undefined || this.#disposed) return Promise.resolve(undefined);
    return this.#run(record, "host-hint", input.token);
  }

  orderHint(sessionId: string): number | undefined {
    const record = this.#documents.get(sessionId);
    if (record === undefined || this.#disposed) return undefined;
    const sequence = ++this.#nextSequence;
    record.latestSequence = sequence;
    this.#admitCandidate({ sessionId, sourcePath: record.sourcePath, sequence, reason: "host-hint" });
    return sequence;
  }

  async reserveExplicitHint(sessionId: string): Promise<number | undefined> {
    const record = this.#documents.get(sessionId);
    if (record === undefined || this.#disposed) return undefined;
    if (record.coalesceTimer !== undefined) clearTimeout(record.coalesceTimer);
    delete record.coalesceTimer;
    delete record.pending;
    const sequence = ++this.#nextSequence;
    record.explicitSequence = sequence;
    record.latestSequence = sequence;
    this.#admitCandidate({ sessionId, sourcePath: record.sourcePath, sequence, reason: "host-hint" });
    const identityReady = this.#inspectIdentity(record.sourcePath)
      .then((info) => identity(info))
      .catch(() => undefined);
    record.explicitIdentityReady = identityReady;
    const currentIdentity = await identityReady;
    if (this.#documents.get(sessionId) !== record || this.#disposed) return undefined;
    if (record.explicitSequence !== sequence) return sequence;
    if (currentIdentity === undefined) delete record.explicitIdentity;
    else record.explicitIdentity = currentIdentity;
    return sequence;
  }

  completeExplicitHint(sessionId: string, sequence: number): void {
    const record = this.#documents.get(sessionId);
    if (record?.explicitSequence !== sequence) return;
    delete record.explicitSequence;
    delete record.explicitIdentity;
    delete record.explicitIdentityReady;
  }

  check(sessionId: string, reason: "activation" | "reconnect"): Promise<Result | undefined> {
    const record = this.#documents.get(sessionId);
    if (record === undefined || this.#disposed) return Promise.resolve(undefined);
    return this.#run(record, reason);
  }

  async flush(sessionId: string): Promise<Result | undefined> {
    const record = this.#documents.get(sessionId);
    if (record === undefined) return undefined;
    if (record.coalesceTimer !== undefined) {
      clearTimeout(record.coalesceTimer);
      delete record.coalesceTimer;
    }
    const pending = record.pending;
    delete record.pending;
    if (pending !== undefined) return this.#run(record, pending.reason, undefined, pending.sequence);
    return record.completion;
  }

  stop(sessionId: string): void {
    const record = this.#documents.get(sessionId);
    if (record === undefined) return;
    this.#documents.delete(sessionId);
    const queued = this.#queuedInspections.get(sessionId);
    if (queued !== undefined) {
      this.#queuedInspections.delete(sessionId);
      queued.resolveCompletion(undefined);
    }
    clearInterval(record.identityTimer);
    clearInterval(record.auditTimer);
    if (record.coalesceTimer !== undefined) clearTimeout(record.coalesceTimer);
    if (record.retryTimer !== undefined) clearTimeout(record.retryTimer);
    const directory = this.#directories.get(record.directory);
    directory?.sessions.delete(sessionId);
    if (directory !== undefined && directory.sessions.size === 0) {
      if (directory.retryTimer !== undefined) clearTimeout(directory.retryTimer);
      directory.watcher?.close();
      this.#directories.delete(record.directory);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const sessionId of [...this.#documents.keys()]) this.stop(sessionId);
  }

  async settle(): Promise<void> {
    if (!this.#draining) return;
    await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  #startWatch(path: string, directory: DirectoryWatch<Result>): void {
    try {
      const watcher = this.#watchDirectory(path);
      directory.watcher = watcher;
      watcher.unref?.();
      watcher.on("change", (_eventType, filename) => {
        const name = filename === null || filename === undefined ? undefined : filename.toString();
        for (const record of directory.sessions.values()) {
          if (name === record.basename) {
            if (record.explicitSequence === undefined) this.#request(record, "watcher");
            else void this.#requestWatcher(record);
          }
          else if (name === undefined) this.#request(record, "identity");
        }
      });
      watcher.on("error", () => {
        watcher.close();
        if (directory.watcher === watcher) delete directory.watcher;
        for (const record of directory.sessions.values()) this.#request(record, "watcher");
        this.#retryWatch(path, directory);
      });
    } catch {
      for (const record of directory.sessions.values()) this.#request(record, "watcher");
      this.#retryWatch(path, directory);
    }
  }

  async #requestWatcher(record: ObservedDocument<Result>): Promise<void> {
    if (this.#disposed || this.#documents.get(record.sessionId) !== record) return;
    const sequence = ++this.#nextSequence;
    const candidate = { sessionId: record.sessionId, sourcePath: record.sourcePath,
      sequence, reason: "watcher" as const };
    // A filesystem notification blocks physical saves immediately. Identity
    // validation decides only whether it advances authoritative ordering.
    this.#admitCandidate(candidate);
    await record.explicitIdentityReady;
    const info = await this.#inspectIdentity(record.sourcePath).catch(() => undefined);
    if (this.#disposed || this.#documents.get(record.sessionId) !== record) return;
    const nextIdentity = info === undefined ? undefined : identity(info);
    if (sameIdentity(record.explicitIdentity, nextIdentity)) {
      this.#settleUnchangedCandidate(candidate);
      return;
    }
    delete record.explicitIdentity;
    delete record.explicitSequence;
    delete record.explicitIdentityReady;
    if (sequence < record.latestSequence) {
      this.#settleUnchangedCandidate(candidate);
      return;
    }
    this.#request(record, "watcher", false, sequence);
  }

  #retryWatch(path: string, directory: DirectoryWatch<Result>): void {
    if (this.#disposed || directory.retryTimer !== undefined) return;
    directory.retryTimer = setTimeout(() => {
      delete directory.retryTimer;
      if (!this.#disposed && directory.sessions.size > 0) this.#startWatch(path, directory);
    }, this.#maxRetryMs);
    directory.retryTimer.unref?.();
  }

  #request(
    record: ObservedDocument<Result>,
    reason: LocalDocumentObservationReason,
    immediate = false,
    reservedSequence?: number,
  ): void {
    if (this.#disposed || !this.#documents.has(record.sessionId)) return;
    const sequence = reservedSequence ?? ++this.#nextSequence;
    record.latestSequence = sequence;
    if (reason === "watcher") record.unvalidatedWatcherSequence = sequence;
    record.pending = { reason, sequence };
    if (reservedSequence === undefined) {
      this.#admitCandidate({ sessionId: record.sessionId, sourcePath: record.sourcePath, sequence, reason });
    }
    if (record.coalesceTimer !== undefined) clearTimeout(record.coalesceTimer);
    record.coalesceTimer = setTimeout(() => {
      delete record.coalesceTimer;
      const pending = record.pending;
      delete record.pending;
      if (pending !== undefined) void this.#run(record, pending.reason, undefined, pending.sequence);
    }, immediate ? 0 : this.#coalesceMs);
    record.coalesceTimer.unref?.();
  }

  #run(
    record: ObservedDocument<Result>,
    reason: LocalDocumentObservationReason,
    hostHintToken?: string,
    reservedSequence?: number,
  ): Promise<Result | undefined> {
    const sequence = reservedSequence ?? ++this.#nextSequence;
    if (reservedSequence !== undefined && sequence < record.latestSequence) {
      return Promise.resolve(undefined);
    }
    record.latestSequence = sequence;
    const orderedCandidate = {
      sessionId: record.sessionId,
      sourcePath: record.sourcePath,
      sequence,
      reason,
      ...(hostHintToken === undefined ? {} : { hostHintToken }),
    };
    if (reservedSequence === undefined) this.#admitCandidate(orderedCandidate);
    const queued = this.#queuedInspections.get(record.sessionId);
    let completion: Promise<Result | undefined>;
    if (queued === undefined) {
      const deferred = Promise.withResolvers<Result | undefined>();
      completion = deferred.promise;
      this.#queuedInspections.set(record.sessionId, {
        record,
        candidate: orderedCandidate,
        completion,
        resolveCompletion: deferred.resolve,
      });
    } else {
      completion = queued.completion;
      this.#queuedInspections.set(record.sessionId, {
        record,
        candidate: orderedCandidate,
        completion,
        resolveCompletion: queued.resolveCompletion,
      });
    }
    record.completion = completion;
    void this.#drainInspections();
    return completion;
  }

  async #drainInspections(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (!this.#disposed && this.#queuedInspections.size > 0) {
        const queued = this.#queuedInspections.values().next().value as QueuedInspection<Result> | undefined;
        if (queued === undefined) break;
        this.#queuedInspections.delete(queued.record.sessionId);
        const result = await this.#inspectQueued(queued);
        queued.resolveCompletion(result);
      }
    } finally {
      this.#draining = false;
      if (!this.#disposed && this.#queuedInspections.size > 0) {
        void this.#drainInspections();
      } else {
        for (const resolve of this.#idleWaiters) resolve();
        this.#idleWaiters.clear();
      }
    }
  }

  async #inspectQueued(queued: QueuedInspection<Result>): Promise<Result | undefined> {
    const { record, candidate } = queued;
    if (
      this.#disposed || !this.#documents.has(record.sessionId) ||
      !this.isCurrent(record.sessionId, candidate.sequence)
    ) return undefined;
    const info = await this.#inspectIdentity(record.sourcePath).catch(() => undefined);
    const nextIdentity = info === undefined ? undefined : identity(info);
    if (
      candidate.reason === "identity" &&
      record.unvalidatedWatcherSequence === undefined &&
      sameIdentity(record.lastIdentity, nextIdentity)
    ) {
      this.#settleUnchangedCandidate(candidate);
      return undefined;
    }
    let result: Result;
    try {
      result = await this.#inspectCandidate({
        ...candidate,
        ...(nextIdentity === undefined ? {} : { identity: nextIdentity }),
      });
    } catch {
      if (!this.#disposed && this.isCurrent(record.sessionId, candidate.sequence)) this.#scheduleRetry(record);
      return undefined;
    }
    if (this.#disposed || !this.isCurrent(record.sessionId, candidate.sequence)) return result;
    if (result.status === "current") {
      if (
        record.unvalidatedWatcherSequence !== undefined &&
        candidate.sequence >= record.unvalidatedWatcherSequence
      ) delete record.unvalidatedWatcherSequence;
      if (nextIdentity === undefined) delete record.lastIdentity;
      else record.lastIdentity = nextIdentity;
      record.retryMs = this.#coalesceMs;
      if (record.retryTimer !== undefined) clearTimeout(record.retryTimer);
      delete record.retryTimer;
    } else this.#scheduleRetry(record);
    return result;
  }

  #scheduleRetry(record: ObservedDocument<Result>): void {
    if (record.retryTimer !== undefined) return;
    const delay = record.retryMs;
    record.retryMs = Math.min(this.#maxRetryMs, Math.max(this.#coalesceMs, delay * 2));
    record.retryTimer = setTimeout(() => {
      delete record.retryTimer;
      this.#request(record, "retry", true);
    }, delay);
    record.retryTimer.unref?.();
  }
}
