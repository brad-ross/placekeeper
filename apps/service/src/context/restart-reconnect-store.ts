import { randomUUID } from "node:crypto";
import { chmod, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { digestSecretHex } from "../../../../packages/core/src/session-security.js";
import { ensurePrivateDirectory } from "../recovery/source-snapshot.js";

const DEFAULT_TTL_MS = 15 * 60_000;

interface RestartReconnectRecord {
  readonly schemaVersion: 1;
  readonly ticketId: string;
  readonly taskSessionHash: string;
  readonly reviewSessionHash: string;
  readonly browserTokenHash: string;
  readonly sourcePathHash: string;
  readonly sourceDigest: string;
  readonly expiresAtMs: number;
}

interface RestartReconnectEnvelope {
  readonly checksum: string;
  readonly payload: RestartReconnectRecord;
}

export interface MatchedRestartReconnectTicket {
  readonly ticketId: string;
  readonly taskSessionHash: string;
  readonly browserTokenHash: string;
  readonly sourcePathHash: string;
  readonly sourceDigest: string;
  readonly expiresAtMs: number;
}

export interface RestartReconnectStoreOptions {
  readonly now?: () => Date;
  readonly ttlMs?: number;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isTicketId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/u.test(value);
}

function parse(contents: string): RestartReconnectRecord | undefined {
  try {
    const envelope = JSON.parse(contents) as RestartReconnectEnvelope;
    const payload = JSON.stringify(envelope.payload);
    const record = envelope.payload;
    return envelope.checksum === digestSecretHex(payload) &&
      record.schemaVersion === 1 &&
      isTicketId(record.ticketId) &&
      isDigest(record.taskSessionHash) &&
      isDigest(record.reviewSessionHash) &&
      isDigest(record.browserTokenHash) &&
      isDigest(record.sourcePathHash) &&
      isDigest(record.sourceDigest) &&
      Number.isSafeInteger(record.expiresAtMs) && record.expiresAtMs > 0
      ? record
      : undefined;
  } catch {
    return undefined;
  }
}

function serialize(record: RestartReconnectRecord): string {
  const payload = JSON.stringify(record);
  return JSON.stringify({ checksum: digestSecretHex(payload), payload: record } satisfies RestartReconnectEnvelope);
}

export class RestartReconnectStore {
  readonly directory: string;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  #tail = Promise.resolve();

  constructor(directory: string, options: RestartReconnectStoreOptions = {}) {
    this.directory = directory;
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new RangeError("ttlMs must be a positive safe integer");
    }
  }

  async initialize(): Promise<void> {
    await this.#serialize(async () => {
      await ensurePrivateDirectory(this.directory);
      const entries = await readdir(this.directory, { withFileTypes: true });
      await Promise.all(entries
        .filter((entry) => entry.isFile() && /^\.ticket-.*\.tmp$/u.test(entry.name))
        .map((entry) => rm(join(this.directory, entry.name), { force: true })));
    });
  }

  async issue(input: {
    readonly taskSessionId: string;
    readonly reviewSessionId: string;
    readonly browserToken: string;
    readonly canonicalSourcePath: string;
    readonly sourceDigest: string;
  }): Promise<void> {
    if (
      input.taskSessionId.length === 0 ||
      input.reviewSessionId.length === 0 ||
      input.browserToken.length === 0 ||
      input.canonicalSourcePath.length === 0
    ) throw new TypeError("Reconnect scope is invalid");
    await this.#serialize(async () => {
      await ensurePrivateDirectory(this.directory);
      const now = this.#nowMs();
      const record: RestartReconnectRecord = {
        schemaVersion: 1,
        ticketId: randomUUID(),
        taskSessionHash: digestSecretHex(input.taskSessionId),
        reviewSessionHash: digestSecretHex(input.reviewSessionId),
        browserTokenHash: digestSecretHex(input.browserToken),
        sourcePathHash: digestSecretHex(input.canonicalSourcePath),
        sourceDigest: input.sourceDigest,
        expiresAtMs: now + this.#ttlMs,
      };
      if (!isDigest(record.sourceDigest)) throw new TypeError("Reconnect source digest is invalid");
      const current = await this.#read(record.browserTokenHash);
      const unchangedAndFresh =
        current?.taskSessionHash === record.taskSessionHash &&
        current.reviewSessionHash === record.reviewSessionHash &&
        current.sourcePathHash === record.sourcePathHash &&
        current.sourceDigest === record.sourceDigest &&
        current.expiresAtMs > now + this.#ttlMs / 2;
      if (!unchangedAndFresh) {
        await this.#write(record);
        const records = await this.#records();
        await Promise.all(records
          .filter((candidate) =>
            candidate.taskSessionHash === record.taskSessionHash &&
            candidate.browserTokenHash !== record.browserTokenHash)
          .map((candidate) => rm(this.#path(candidate.browserTokenHash), { force: true })));
      }
    });
  }

  async matchBrowser(input: {
    readonly browserToken: string;
    readonly canonicalSourcePath: string;
    readonly sourceDigest: string;
  }): Promise<MatchedRestartReconnectTicket | undefined> {
    return this.#serialize(async () => {
      const browserTokenHash = digestSecretHex(input.browserToken);
      const record = await this.#read(browserTokenHash);
      if (record === undefined) return undefined;
      if (record.expiresAtMs <= this.#nowMs()) {
        await rm(this.#path(browserTokenHash), { force: true });
        return undefined;
      }
      if (
        record.sourcePathHash !== digestSecretHex(input.canonicalSourcePath) ||
        record.sourceDigest !== input.sourceDigest
      ) return undefined;
      return record;
    });
  }

  matchesTask(ticket: MatchedRestartReconnectTicket, taskSessionId: string): boolean {
    return ticket.taskSessionHash === digestSecretHex(taskSessionId) &&
      ticket.expiresAtMs > this.#nowMs();
  }

  /** Atomically verifies that this exact, still-current ticket belongs to the
   * task and consumes it. A staged copy must never outlive revocation or a
   * second use of the same browser token. */
  async consumeForTask(ticket: MatchedRestartReconnectTicket, taskSessionId: string): Promise<boolean> {
    return this.#serialize(async () => {
      const current = await this.#read(ticket.browserTokenHash);
      if (
        current?.taskSessionHash === ticket.taskSessionHash &&
        current.ticketId === ticket.ticketId &&
        current.sourcePathHash === ticket.sourcePathHash &&
        current.sourceDigest === ticket.sourceDigest &&
        current.expiresAtMs === ticket.expiresAtMs &&
        current.expiresAtMs > this.#nowMs() &&
        current.taskSessionHash === digestSecretHex(taskSessionId)
      ) {
        await rm(this.#path(ticket.browserTokenHash), { force: true });
        return true;
      }
      return false;
    });
  }

  async revokeTask(taskSessionId: string): Promise<void> {
    await this.#removeMatching("taskSessionHash", digestSecretHex(taskSessionId));
  }

  async revokeSession(reviewSessionId: string): Promise<void> {
    await this.#removeMatching("reviewSessionHash", digestSecretHex(reviewSessionId));
  }

  #nowMs(): number {
    return this.#now().getTime();
  }

  #path(browserTokenHash: string): string {
    return join(this.directory, `${browserTokenHash}.json`);
  }

  async #read(browserTokenHash: string): Promise<RestartReconnectRecord | undefined> {
    try {
      return parse(await readFile(this.#path(browserTokenHash), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #records(): Promise<RestartReconnectRecord[]> {
    await ensurePrivateDirectory(this.directory);
    const entries = await readdir(this.directory, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
      .map((entry) => this.#read(entry.name.slice(0, 64))));
    return records.filter((record): record is RestartReconnectRecord => record !== undefined);
  }

  async #write(record: RestartReconnectRecord): Promise<void> {
    const temporaryPath = join(this.directory, `.ticket-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(serialize(record), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.#path(record.browserTokenHash));
      await chmod(this.#path(record.browserTokenHash), 0o600);
      const directoryHandle = await open(this.directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async #removeMatching(
    field: "taskSessionHash" | "reviewSessionHash",
    digest: string,
  ): Promise<void> {
    await this.#serialize(async () => {
      const records = await this.#records();
      await Promise.all(records
        .filter((record) => record[field] === digest)
        .map((record) => rm(this.#path(record.browserTokenHash), { force: true })));
    });
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work, work);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
