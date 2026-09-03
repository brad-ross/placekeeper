import { createHash, randomBytes } from "node:crypto";
import { chmod, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import {
  CHROME_RUNTIME_PROTOCOL,
  CHROME_RUNTIME_PROTOCOL_VERSION,
  CHROME_RUNTIME_RESOURCE_CHUNK_BYTES,
  parseChromeRuntimeExtensionMessage,
  sanitizeChromeRuntimeProjection,
  type ChromeRuntimeExtensionMessage,
  type ChromeRuntimeHostMessage,
} from "../../../../packages/core/src/chrome-native-runtime-protocol.js";
import {
  sanitizeChromeReviewRuntimeResponse,
  type ReviewRuntimeBrokerMethod,
} from "../../../../packages/core/src/review-runtime-protocol.js";
import { deadlineWasSubstantiallyDelayed } from "../../../../packages/core/src/suspend-aware-deadline.js";
import { CHROME_EXTENSION_ORIGIN } from "./chrome-handoff.js";
import { ensurePrivateDirectory } from "../recovery/source-snapshot.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const NON_IDEMPOTENT_METHODS = new Set<ReviewRuntimeBrokerMethod>([
  "command", "chooseCopy", "chooseFolder", "chooseOriginal", "retrySave", "locateSave",
  "exportReviewedCopy",
]);

export interface ChromeRuntimeProjection {
  readonly sessionId: string;
  readonly generation: number;
  readonly revision: number;
  readonly state: unknown;
  readonly scope: unknown;
  readonly saveStatus: unknown;
  readonly canonicalLinkBase: string;
  readonly protected: boolean;
  readonly location?: unknown;
  readonly document: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly generation: number;
  };
}

export interface ChromeRuntimeStageRequest {
  /** SHA-256 of the native-normalized source URL/path identity. This opaque
   * identity is necessary but never sufficient: the backend must also verify
   * the exact byte digest and generation before canonical resolution. */
  readonly sourceIdentity: string;
  readonly disposition: "remote-temporary" | "local";
  readonly displayName?: string;
  readonly sourceUrl?: string;
  readonly fileUrl?: string;
}

export interface ChromeRuntimeStagedReview {
  readonly canonicalKey: string;
  readonly projection: ChromeRuntimeProjection;
}

export interface ChromeRuntimeRecovery {
  readonly choices: readonly ["resume", "discard", "fork"];
  readonly offer: { readonly id: string; readonly expiresAt: string };
  choose(
    decision: "resume" | "discard" | "fork",
    operationId: string,
  ): Promise<ChromeRuntimeStagedReview>;
}

export interface ChromeRuntimeSourceSink {
  append(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  finish(claim?: { readonly sha256: string; readonly byteLength: number }, signal?: AbortSignal): Promise<ChromeRuntimeStagedReview | ChromeRuntimeRecovery>;
  cancel(): Promise<void>;
}

export interface ChromeRuntimeBackend {
  readonly quota?: ChromeRuntimeAggregateQuota;
  begin(request: ChromeRuntimeStageRequest, signal?: AbortSignal): Promise<ChromeRuntimeSourceSink>;
  activate(canonicalKey: string, presentationLease: string, signal?: AbortSignal): Promise<ChromeRuntimeProjection>;
  current(canonicalKey: string, signal?: AbortSignal): Promise<ChromeRuntimeProjection>;
  invoke(
    canonicalKey: string,
    method: ReviewRuntimeBrokerMethod,
    payload: unknown,
    operation: { readonly idempotencyKey?: string; readonly payloadDigest: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
  readDocument(canonicalKey: string, generation: number, offset: number, length: number, signal?: AbortSignal): Promise<Buffer>;
  detach(canonicalKey: string, presentationLease: string): Promise<void>;
  release(canonicalKey: string): Promise<void>;
}

export interface ChromeRuntimeAggregateQuotaOptions {
  readonly maxPorts?: number;
  readonly maxRequests?: number;
  readonly maxBufferedBytes?: number;
  readonly maxResources?: number;
}

export class ChromeRuntimeAggregateQuota {
  readonly #limits: Required<ChromeRuntimeAggregateQuotaOptions>;
  #ports = 0;
  #requests = 0;
  #bufferedBytes = 0;
  #resources = 0;

  constructor(options: ChromeRuntimeAggregateQuotaOptions = {}) {
    this.#limits = {
      maxPorts: options.maxPorts ?? 8,
      maxRequests: options.maxRequests ?? 32,
      maxBufferedBytes: options.maxBufferedBytes ?? 32 * 1024 * 1024,
      maxResources: options.maxResources ?? 8,
    };
  }

  acquirePort(): boolean {
    if (this.#ports >= this.#limits.maxPorts) return false;
    this.#ports += 1;
    return true;
  }
  releasePort(): void { this.#ports = Math.max(0, this.#ports - 1); }
  acquireRequest(): boolean {
    if (this.#requests >= this.#limits.maxRequests) return false;
    this.#requests += 1;
    return true;
  }
  releaseRequest(): void { this.#requests = Math.max(0, this.#requests - 1); }
  addBufferedBytes(value: number): boolean {
    if (!Number.isSafeInteger(value) || value < 0 || this.#bufferedBytes + value > this.#limits.maxBufferedBytes) return false;
    this.#bufferedBytes += value;
    return true;
  }
  releaseBufferedBytes(value: number): void { this.#bufferedBytes = Math.max(0, this.#bufferedBytes - value); }
  acquireResource(): boolean {
    if (this.#resources >= this.#limits.maxResources) return false;
    this.#resources += 1;
    return true;
  }
  releaseResource(): void { this.#resources = Math.max(0, this.#resources - 1); }
  snapshot(): { readonly ports: number; readonly requests: number; readonly bufferedBytes: number; readonly resources: number } {
    return { ports: this.#ports, requests: this.#requests, bufferedBytes: this.#bufferedBytes, resources: this.#resources };
  }
}

interface OperationRecord {
  readonly fingerprint: string;
  readonly result: Promise<unknown>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** Connection-independent operation results. Production can retain one
 * journal with the service host so dropped native responses replay the result
 * rather than the side effect. */
export class ChromeRuntimeOperationJournal {
  readonly #records = new Map<string, OperationRecord>();
  readonly #admissions = new Map<string, Promise<void>>();
  readonly #root: string | undefined;

  constructor(options: { readonly root?: string } = {}) {
    this.#root = options.root;
  }

  async commit<T>(canonicalKey: string, operationKey: string, payload: unknown, operation: () => Promise<T>): Promise<T> {
    const key = `${canonicalKey}\0${operationKey}`;
    const fingerprint = createHash("sha256").update(canonicalJson(payload)).digest("hex");
    const predecessor = this.#admissions.get(key) ?? Promise.resolve();
    const { promise: admission, resolve: releaseAdmission } = Promise.withResolvers<void>();
    this.#admissions.set(key, admission);
    await predecessor;
    try {
      const persisted = this.#root === undefined ? undefined : await this.#readPersisted(key);
      const existing = this.#records.get(key) ?? persisted;
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) throw new Error("idempotency-conflict");
        return await existing.result as T;
      }
      // Persist the fingerprint before executing. If the service exits after
      // the effect but before its completed result is durable, a restarted
      // service returns outcome-unknown and never repeats the effect.
      if (this.#root !== undefined) await this.#persist(key, fingerprint, undefined, "pending");
      const result = operation();
      this.#records.set(key, { fingerprint, result });
      try {
        const resolved = await result;
        if (this.#root !== undefined) await this.#persist(key, fingerprint, resolved, "completed");
        return resolved;
      } catch (error) {
        this.#records.delete(key);
        throw error;
      }
    } finally {
      releaseAdmission();
      if (this.#admissions.get(key) === admission) this.#admissions.delete(key);
    }
  }

  async #readPersisted(key: string): Promise<OperationRecord | undefined> {
    const path = join(this.#root!, `${createHash("sha256").update(key).digest("hex")}.json`);
    try {
      const bytes = await readFile(path);
      if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("operation-journal-invalid");
      const value = JSON.parse(bytes.toString("utf8")) as { readonly schemaVersion?: unknown; readonly fingerprint?: unknown; readonly status?: unknown; readonly result?: unknown };
      if (value.schemaVersion !== 1 || typeof value.fingerprint !== "string" || !SHA256.test(value.fingerprint) ||
        (value.status !== "pending" && value.status !== "completed")) {
        throw new Error("operation-journal-invalid");
      }
      const record = {
        fingerprint: value.fingerprint,
        result: value.status === "completed"
          ? Promise.resolve(value.result)
          : Promise.reject(new Error("operation-outcome-unknown")),
      };
      record.result.catch(() => undefined);
      this.#records.set(key, record);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #persist(key: string, fingerprint: string, result: unknown, status: "pending" | "completed"): Promise<void> {
    await ensurePrivateDirectory(this.#root!);
    const stem = createHash("sha256").update(key).digest("hex");
    const destination = join(this.#root!, `${stem}.json`);
    const temporary = join(this.#root!, `.${stem}.${randomBytes(12).toString("hex")}.tmp`);
    const body = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      fingerprint,
      status,
      ...(status === "completed" ? { result } : {}),
    }), "utf8");
    if (body.byteLength > 8 * 1024 * 1024) throw new Error("operation-result-too-large");
    let handle: FileHandle | undefined = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);
      await chmod(destination, 0o600);
      const directory = await open(this.#root!, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/** Long-lived daemon owner for admission and exactly-once operation records.
 * Native-host processes connect through this authority; they do not own the
 * authoritative counters or replay journal. */
export class ChromeRuntimeServiceAuthority implements ChromeRuntimeBackend {
  readonly quota: ChromeRuntimeAggregateQuota;
  readonly #delegate: ChromeRuntimeBackend;
  readonly #journal: ChromeRuntimeOperationJournal;

  constructor(delegate: ChromeRuntimeBackend, options: {
    readonly quota?: ChromeRuntimeAggregateQuota;
    readonly journal?: ChromeRuntimeOperationJournal;
  } = {}) {
    this.#delegate = delegate;
    this.quota = options.quota ?? new ChromeRuntimeAggregateQuota();
    this.#journal = options.journal ?? new ChromeRuntimeOperationJournal();
  }

  begin(request: ChromeRuntimeStageRequest, signal?: AbortSignal): Promise<ChromeRuntimeSourceSink> {
    return this.#delegate.begin(request, signal);
  }
  readDocument(canonicalKey: string, generation: number, offset: number, length: number, signal?: AbortSignal): Promise<Buffer> {
    return this.#delegate.readDocument(canonicalKey, generation, offset, length, signal);
  }
  activate(canonicalKey: string, presentationLease: string, signal?: AbortSignal): Promise<ChromeRuntimeProjection> {
    return this.#delegate.activate(canonicalKey, presentationLease, signal);
  }
  current(canonicalKey: string, signal?: AbortSignal): Promise<ChromeRuntimeProjection> {
    return this.#delegate.current(canonicalKey, signal);
  }
  invoke(
    canonicalKey: string,
    method: ReviewRuntimeBrokerMethod,
    payload: unknown,
    operation: { readonly idempotencyKey?: string; readonly payloadDigest: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const invoke = () => this.#delegate.invoke(canonicalKey, method, payload, operation, signal);
    if (!NON_IDEMPOTENT_METHODS.has(method)) return invoke();
    if (operation.idempotencyKey === undefined) return Promise.reject(new Error("idempotency-required"));
    return this.#journal.commit(
      canonicalKey,
      operation.idempotencyKey,
      { method, payloadDigest: operation.payloadDigest },
      invoke,
    );
  }
  detach(canonicalKey: string, presentationLease: string): Promise<void> {
    return this.#delegate.detach(canonicalKey, presentationLease);
  }
  release(canonicalKey: string): Promise<void> { return this.#delegate.release(canonicalKey); }
}

export interface CanonicalReviewResolution<T> {
  readonly review: T;
  readonly canonicalKey: string;
  readonly joined: boolean;
}

/** Single-flight resolution keyed by all three service-verified coordinates.
 * A source URL identity by itself can never join a review. */
export class ChromeCanonicalReviewIndex<T> {
  readonly #reviews = new Map<string, Promise<T>>();

  async resolve(input: { readonly sourceIdentity: string; readonly sha256: string; readonly generation: number }, create: () => Promise<T>): Promise<CanonicalReviewResolution<T>> {
    if (!SHA256.test(input.sourceIdentity) || !SHA256.test(input.sha256) ||
      !Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error("invalid-canonical-identity");
    const canonicalKey = `${input.sourceIdentity}:${input.sha256}:${input.generation}`;
    const existing = this.#reviews.get(canonicalKey);
    if (existing !== undefined) return { review: await existing, canonicalKey, joined: true };
    const pending = create();
    this.#reviews.set(canonicalKey, pending);
    try {
      return { review: await pending, canonicalKey, joined: false };
    } catch (error) {
      if (this.#reviews.get(canonicalKey) === pending) this.#reviews.delete(canonicalKey);
      throw error;
    }
  }

  delete(canonicalKey: string): void { this.#reviews.delete(canonicalKey); }
}

interface AcquisitionState {
  readonly transferId: string;
  readonly disposition: "remote-temporary" | "local";
  readonly sourceIdentity: string;
  readonly sourceUrl?: string;
  readonly fileUrl?: string;
  readonly displayName?: string;
  readonly digest: ReturnType<typeof createHash>;
  readonly sink: ChromeRuntimeSourceSink;
  sequence: number;
  byteLength: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface ResourceState {
  readonly requestId: string;
  readonly chunkLength: number;
  offset: number;
  sequence: number;
  timer?: ReturnType<typeof setTimeout>;
}

type ConnectionPhase = "negotiating" | "acquiring" | "recovery" | "provisional" | "active" | "update-required" | "closed";

export interface ChromeRuntimeConnectionOptions {
  readonly callerOrigin: string;
  readonly backend: ChromeRuntimeBackend;
  readonly quota?: ChromeRuntimeAggregateQuota;
  readonly requestTimeoutMs?: number;
  readonly idleLeaseMs?: number;
  readonly now?: () => number;
  readonly onAsyncMessage?: (message: ChromeRuntimeHostMessage) => void;
  readonly onClosed?: () => void;
}

export class ChromeRuntimeConnection {
  readonly #backend: ChromeRuntimeBackend;
  readonly #quota: ChromeRuntimeAggregateQuota;
  readonly #requestTimeoutMs: number;
  readonly #idleLeaseMs: number;
  readonly #now: () => number;
  readonly #onAsyncMessage: ((message: ChromeRuntimeHostMessage) => void) | undefined;
  readonly #onClosed: (() => void) | undefined;
  readonly #presentationLease = randomBytes(32).toString("base64url");
  #phase: ConnectionPhase = "negotiating";
  #connectionId: string | undefined;
  #acquisition: AcquisitionState | undefined;
  #resource: ResourceState | undefined;
  #staged: ChromeRuntimeStagedReview | undefined;
  #recovery: ChromeRuntimeRecovery | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #portHeld = false;

  constructor(options: ChromeRuntimeConnectionOptions) {
    if (options.callerOrigin !== CHROME_EXTENSION_ORIGIN) throw new Error("unauthorized-origin");
    this.#backend = options.backend;
    this.#quota = options.quota ?? options.backend.quota ?? new ChromeRuntimeAggregateQuota();
    if (!this.#quota.acquirePort()) throw new Error("host-busy");
    this.#portHeld = true;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#idleLeaseMs = options.idleLeaseMs ?? 90_000;
    this.#now = options.now ?? Date.now;
    this.#onAsyncMessage = options.onAsyncMessage;
    this.#onClosed = options.onClosed;
  }

  diagnostics(): { readonly phase: ConnectionPhase; readonly negotiated: boolean; readonly generation?: number; readonly bufferedBytes: number } {
    return {
      phase: this.#phase,
      negotiated: this.#connectionId !== undefined,
      ...(this.#staged === undefined ? {} : { generation: this.#staged.projection.generation }),
      bufferedBytes: this.#acquisition?.byteLength ?? 0,
    };
  }

  async handle(raw: unknown): Promise<ChromeRuntimeHostMessage> {
    const rawRecord = typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? raw as Record<string, unknown> : undefined;
    if (rawRecord?.protocolVersion !== CHROME_RUNTIME_PROTOCOL_VERSION) {
      return this.#versionFailure(typeof rawRecord?.requestId === "string" ? rawRecord.requestId : undefined);
    }
    const message = parseChromeRuntimeExtensionMessage(raw);
    if (message === undefined) return this.#failure("lifecycle", "invalid-message", typeof rawRecord?.requestId === "string" ? rawRecord.requestId : undefined);
    if (this.#phase === "closed") return this.#failure(message.type === "hello" ? "lifecycle" : message.lane, "connection-closed", "requestId" in message ? message.requestId : undefined);
    if (message.type === "hello") return this.#hello(message);
    if (this.#connectionId === undefined || message.connectionId !== this.#connectionId) {
      return this.#versionFailure(message.requestId);
    }
    if (this.#phase === "update-required") return this.#updateRequired(message.requestId);
    if (!this.#quota.acquireRequest()) return this.#failure(message.lane, "host-busy", message.requestId);
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    try {
      return await this.#dispatch(message);
    } finally {
      this.#quota.releaseRequest();
      if (!this.#isClosed()) this.#armIdleDeadline();
    }
  }

  async disconnect(): Promise<void> {
    if (this.#phase === "closed") return;
    const staged = this.#staged;
    const wasActive = this.#phase === "active" || this.#phase === "update-required";
    this.#phase = "closed";
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    await this.#releaseAcquisition();
    this.#releaseResource();
    if (staged !== undefined) {
      if (wasActive) await this.#backend.detach(staged.canonicalKey, this.#presentationLease).catch(() => undefined);
      else await this.#backend.release(staged.canonicalKey).catch(() => undefined);
    }
    if (this.#portHeld) {
      this.#portHeld = false;
      this.#quota.releasePort();
    }
    this.#onClosed?.();
  }

  async #dispatch(message: Exclude<ChromeRuntimeExtensionMessage, { readonly type: "hello" }>): Promise<ChromeRuntimeHostMessage> {
    if (message.lane === "acquisition") return this.#acquisitionMessage(message);
    if (message.lane === "lifecycle") return this.#lifecycleMessage(message);
    if (message.lane === "runtime") return this.#runtimeMessage(message);
    return this.#resourceMessage(message);
  }

  #hello(message: Extract<ChromeRuntimeExtensionMessage, { readonly type: "hello" }>): ChromeRuntimeHostMessage {
    if (this.#phase !== "negotiating" || this.#connectionId !== undefined) return this.#versionFailure();
    this.#connectionId = message.connectionId;
    this.#phase = "acquiring";
    this.#armIdleDeadline();
    return { type: "hello-ack", protocol: CHROME_RUNTIME_PROTOCOL, protocolVersion: 2, connectionId: message.connectionId, leaseMs: this.#idleLeaseMs };
  }

  async #acquisitionMessage(message: Extract<ChromeRuntimeExtensionMessage, { readonly lane: "acquisition" }>): Promise<ChromeRuntimeHostMessage> {
    if (message.type === "begin") {
      if (this.#phase !== "acquiring" || this.#acquisition !== undefined) return this.#failure("acquisition", "invalid-state", message.requestId);
      const identity = message.disposition === "remote-temporary"
        ? normalizeRemoteSourceIdentity(message.sourceUrl)
        : normalizeLocalSourceIdentity(message.fileUrl);
      if (identity === undefined) return this.#failure("acquisition", "invalid-source", message.requestId);
      const request: ChromeRuntimeStageRequest = {
        sourceIdentity: createHash("sha256").update(identity).digest("hex"),
        disposition: message.disposition,
        ...(message.disposition === "remote-temporary" ? { sourceUrl: message.sourceUrl } : { fileUrl: message.fileUrl }),
        ...(message.disposition === "remote-temporary" && message.displayName !== undefined ? { displayName: message.displayName } : {}),
      };
      try {
        const sink = await this.#backend.begin(request);
        this.#acquisition = {
          transferId: message.transferId, disposition: message.disposition,
          sourceIdentity: request.sourceIdentity,
          ...(request.sourceUrl === undefined ? {} : { sourceUrl: request.sourceUrl }),
          ...(request.fileUrl === undefined ? {} : { fileUrl: request.fileUrl }),
          ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
          digest: createHash("sha256"), sink, sequence: 0, byteLength: 0,
        };
        this.#armAcquisitionDeadline();
      } catch {
        return this.#failure("acquisition", "service-unavailable", message.requestId);
      }
      return this.#ack("acquisition", message.requestId);
    }
    const acquisition = this.#acquisition;
    if (acquisition === undefined || message.transferId !== acquisition.transferId) {
      await this.#releaseAcquisition();
      return this.#failure("acquisition", acquisition === undefined ? "invalid-state" : "request-timeout", message.requestId);
    }
    if (message.type === "cancel") {
      await this.#releaseAcquisition();
      return this.#ack("acquisition", message.requestId);
    }
    if (message.type === "chunk") {
      if (message.sequence !== acquisition.sequence) return this.#failure("acquisition", "out-of-order", message.requestId);
      const bytes = Buffer.from(message.data, "base64");
      if (bytes.byteLength === 0 || bytes.toString("base64") !== message.data || !this.#quota.addBufferedBytes(bytes.byteLength)) {
        await this.#releaseAcquisition();
        return this.#failure("acquisition", "host-byte-budget", message.requestId);
      }
      try {
        await acquisition.sink.append(bytes);
      } catch {
        this.#quota.releaseBufferedBytes(bytes.byteLength);
        await this.#releaseAcquisition();
        return this.#failure("acquisition", "service-unavailable", message.requestId);
      }
      this.#quota.releaseBufferedBytes(bytes.byteLength);
      acquisition.digest.update(bytes); acquisition.byteLength += bytes.byteLength; acquisition.sequence += 1;
      this.#armAcquisitionDeadline();
      return this.#ack("acquisition", message.requestId, message.sequence);
    }
    if (message.sequence !== acquisition.sequence ||
      (acquisition.disposition === "remote-temporary" && acquisition.byteLength === 0)) {
      await this.#releaseAcquisition();
      return this.#failure("acquisition", "out-of-order", message.requestId);
    }
    const sha256 = acquisition.digest.digest("hex");
    let staged: ChromeRuntimeStagedReview | undefined;
    try {
      const finished = await acquisition.sink.finish(
        acquisition.disposition === "remote-temporary" ? { sha256, byteLength: acquisition.byteLength } : undefined,
      );
      if ("choose" in finished) {
        this.#recovery = finished;
        this.#phase = "recovery";
        return {
          type: "recovery-offered", lane: "lifecycle", protocolVersion: 2,
          connectionId: this.#connectionId!, requestId: message.requestId,
          choices: finished.choices, offer: finished.offer,
        };
      }
      staged = finished;
      const safeProjection = sanitizeChromeRuntimeProjection(staged.projection);
      if (safeProjection === undefined || staged.projection.generation < 1 ||
        (acquisition.disposition === "remote-temporary" && (
          staged.projection.document.byteLength !== acquisition.byteLength ||
          staged.projection.document.sha256 !== sha256
        ))) throw new Error("source-integrity");
      this.#staged = {
        canonicalKey: staged.canonicalKey,
        projection: safeProjection as ChromeRuntimeProjection,
      };
      this.#phase = "provisional";
      return this.#projection("projection", message.requestId, this.#staged.projection);
    } catch {
      if (staged !== undefined) await this.#backend.release(staged.canonicalKey).catch(() => undefined);
      this.#staged = undefined;
      return this.#failure("acquisition", "service-unavailable", message.requestId);
    } finally {
      await this.#releaseAcquisition(false);
    }
  }

  async #lifecycleMessage(message: Extract<ChromeRuntimeExtensionMessage, { readonly lane: "lifecycle" }>): Promise<ChromeRuntimeHostMessage> {
    if (message.type === "recover") {
      if (this.#phase !== "recovery" || this.#recovery === undefined ||
        message.offer.id !== this.#recovery.offer.id ||
        message.offer.expiresAt !== this.#recovery.offer.expiresAt) {
        return this.#failure("lifecycle", "invalid-state", message.requestId);
      }
      try {
        const staged = await this.#recovery.choose(message.decision, message.idempotencyKey);
        const safeProjection = sanitizeChromeRuntimeProjection(staged.projection);
        if (safeProjection === undefined) throw new Error("invalid-service-response");
        this.#recovery = undefined;
        this.#staged = { canonicalKey: staged.canonicalKey, projection: safeProjection as ChromeRuntimeProjection };
        this.#phase = "provisional";
        return this.#projection("projection", message.requestId, this.#staged.projection);
      } catch {
        return this.#failure("lifecycle", "operation-rejected", message.requestId);
      }
    }
    if (message.type === "refresh") {
      if (this.#phase !== "active" || this.#staged === undefined) {
        return this.#failure("lifecycle", "invalid-state", message.requestId);
      }
      try {
        const current = await this.#backend.current(this.#staged.canonicalKey);
        this.#staged = { ...this.#staged, projection: current };
        return this.#projection("projection", message.requestId, current);
      } catch {
        return this.#failure("lifecycle", "service-unavailable", message.requestId);
      }
    }
    if (message.type === "keepalive") {
      this.#armIdleDeadline();
      if (this.#phase === "active" && this.#staged !== undefined) {
        try {
          const current = await this.#backend.current(this.#staged.canonicalKey);
          const previous = this.#staged.projection;
          this.#staged = { ...this.#staged, projection: current };
          const saveChanged = canonicalJson(current.saveStatus) !== canonicalJson(previous.saveStatus);
          if (current.generation !== previous.generation || current.revision !== previous.revision || saveChanged) {
            return {
              type: "invalidation", lane: "runtime", protocolVersion: 2,
              connectionId: this.#connectionId!, revision: current.revision,
              generation: current.generation,
              reason: current.generation !== previous.generation
                ? "generation"
                : current.revision !== previous.revision ? "revision" : "save",
            };
          }
        } catch {
          return this.#failure("lifecycle", "service-unavailable", message.requestId);
        }
      }
      return this.#ack("lifecycle", message.requestId);
    }
    if (message.type === "detach") {
      await this.disconnect();
      return this.#ack("lifecycle", message.requestId);
    }
    if (this.#phase !== "provisional" || this.#staged === undefined) return this.#failure("lifecycle", "invalid-state", message.requestId);
    try {
      const active = await this.#backend.activate(this.#staged.canonicalKey, this.#presentationLease);
      this.#staged = { ...this.#staged, projection: active };
      this.#phase = "active";
      this.#armIdleDeadline();
      return this.#projection("active", message.requestId, active);
    } catch {
      await this.#backend.release(this.#staged.canonicalKey).catch(() => undefined);
      this.#staged = undefined;
      return this.#failure("lifecycle", "activation-rejected", message.requestId);
    }
  }

  async #runtimeMessage(message: Extract<ChromeRuntimeExtensionMessage, { readonly lane: "runtime" }>): Promise<ChromeRuntimeHostMessage> {
    if (this.#phase !== "active" || this.#staged === undefined) return this.#failure("runtime", "read-only", message.requestId);
    if (NON_IDEMPOTENT_METHODS.has(message.method) && message.idempotencyKey === undefined) {
      return this.#failure("runtime", "idempotency-required", message.requestId);
    }
    try {
      if (NON_IDEMPOTENT_METHODS.has(message.method)) {
        const previous = this.#staged.projection;
        const current = await this.#backend.current(this.#staged.canonicalKey);
        this.#staged = { ...this.#staged, projection: current };
        if (message.generation !== current.generation || message.revision !== current.revision) {
          this.#onAsyncMessage?.({
            type: "invalidation", lane: "runtime", protocolVersion: 2,
            connectionId: this.#connectionId!, revision: current.revision,
            generation: current.generation,
            reason: current.generation === previous.generation ? "revision" : "generation",
          });
          return this.#failure("runtime", "stale-presentation", message.requestId);
        }
      }
      const payloadDigest = createHash("sha256")
        .update(canonicalJson({ method: message.method, payload: message.payload }))
        .digest("hex");
      const result = await this.#backend.invoke(
        this.#staged.canonicalKey,
        message.method,
        message.payload,
        {
          ...(message.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey }),
          payloadDigest,
        },
      );
      const payload = sanitizeChromeReviewRuntimeResponse(message.method, result);
      if (payload === undefined) return this.#failure("runtime", "invalid-service-response", message.requestId);
      return { type: "result", lane: "runtime", protocolVersion: 2, connectionId: this.#connectionId!, requestId: message.requestId, method: message.method, payload };
    } catch (error) {
      return this.#failure("runtime", error instanceof Error && error.message === "idempotency-conflict" ? "idempotency-conflict" : "operation-rejected", message.requestId);
    }
  }

  async #resourceMessage(message: Extract<ChromeRuntimeExtensionMessage, { readonly lane: "resource" }>): Promise<ChromeRuntimeHostMessage> {
    if ((this.#phase !== "provisional" && this.#phase !== "active") || this.#staged === undefined) {
      return this.#failure("resource", "read-only", message.requestId);
    }
    if (message.type === "cancel") {
      if (this.#resource?.requestId !== message.requestId) return this.#failure("resource", "invalid-state", message.requestId);
      this.#releaseResource();
      return this.#ack("resource", message.requestId);
    }
    if (message.type === "read") {
      if (message.generation !== this.#staged.projection.generation) return this.#failure("resource", "stale-generation", message.requestId);
      if (this.#resource !== undefined || !this.#quota.acquireResource()) return this.#failure("resource", "host-busy", message.requestId);
      this.#resource = { requestId: message.requestId, chunkLength: message.length, offset: message.offset, sequence: 0 };
      this.#armResourceDeadline();
      return this.#nextResourceChunk();
    }
    if (this.#resource === undefined || this.#resource.requestId !== message.requestId ||
      message.sequence !== this.#resource.sequence - 1) {
      this.#releaseResource();
      return this.#failure("resource", "invalid-state", message.requestId);
    }
    return this.#nextResourceChunk();
  }

  async #nextResourceChunk(): Promise<ChromeRuntimeHostMessage> {
    const resource = this.#resource!;
    const start = resource.offset;
    const expectedLength = Math.min(resource.chunkLength, CHROME_RUNTIME_RESOURCE_CHUNK_BYTES);
    let bytes: Buffer;
    try {
      bytes = await this.#backend.readDocument(this.#staged!.canonicalKey, this.#staged!.projection.generation, start, expectedLength);
    } catch {
      this.#releaseResource();
      return this.#failure("resource", "service-unavailable", resource.requestId);
    }
    const end = start + bytes.byteLength;
    const done = end >= this.#staged!.projection.document.byteLength;
    const message: ChromeRuntimeHostMessage = { type: "resource-chunk", lane: "resource", protocolVersion: 2, connectionId: this.#connectionId!, requestId: resource.requestId, sequence: resource.sequence, data: bytes.toString("base64"), done };
    resource.offset = end; resource.sequence += 1;
    if (done) this.#releaseResource();
    else this.#armResourceDeadline();
    return message;
  }

  async #releaseAcquisition(cancel = true): Promise<void> {
    if (this.#acquisition?.timer !== undefined) clearTimeout(this.#acquisition.timer);
    if (cancel && this.#acquisition !== undefined) await this.#acquisition.sink.cancel().catch(() => undefined);
    this.#acquisition = undefined;
  }
  #releaseResource(): void {
    if (this.#resource?.timer !== undefined) clearTimeout(this.#resource.timer);
    if (this.#resource !== undefined) this.#quota.releaseResource();
    this.#resource = undefined;
  }
  #armIdleDeadline(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    const armedAt = this.#now();
    this.#idleTimer = setTimeout(() => {
      if (this.#phase === "closed") return;
      if (deadlineWasSubstantiallyDelayed(armedAt, this.#idleLeaseMs, this.#now())) {
        this.#armIdleDeadline();
        return;
      }
      const message = this.#failure("lifecycle", "idle-timeout");
      this.#onAsyncMessage?.(message);
      void this.disconnect();
    }, this.#idleLeaseMs);
    this.#idleTimer.unref?.();
  }
  #isClosed(): boolean { return this.#phase === "closed"; }
  #armAcquisitionDeadline(): void {
    const acquisition = this.#acquisition;
    if (acquisition === undefined) return;
    if (acquisition.timer !== undefined) clearTimeout(acquisition.timer);
    acquisition.timer = setTimeout(() => {
      if (this.#acquisition !== acquisition) return;
      const message = this.#failure("acquisition", "request-timeout");
      void this.#releaseAcquisition().then(() => this.#onAsyncMessage?.(message));
    }, this.#requestTimeoutMs);
    acquisition.timer.unref?.();
  }
  #armResourceDeadline(): void {
    const resource = this.#resource;
    if (resource === undefined) return;
    if (resource.timer !== undefined) clearTimeout(resource.timer);
    resource.timer = setTimeout(() => {
      if (this.#resource !== resource) return;
      const message = this.#failure("resource", "request-timeout", resource.requestId);
      this.#releaseResource();
      this.#onAsyncMessage?.(message);
    }, this.#requestTimeoutMs);
    resource.timer.unref?.();
  }
  #ack(lane: "acquisition" | "resource" | "lifecycle", requestId: string, sequence?: number): ChromeRuntimeHostMessage {
    return { type: "ack", lane, protocolVersion: 2, connectionId: this.#connectionId!, requestId, ...(sequence === undefined ? {} : { sequence }) };
  }
  #failure(lane: "acquisition" | "runtime" | "resource" | "lifecycle", reason: string, requestId?: string): ChromeRuntimeHostMessage {
    return { type: "failure", lane, protocolVersion: 2, connectionId: this.#connectionId ?? "unnegotiated", ...(requestId === undefined ? {} : { requestId }), reason };
  }
  #versionFailure(requestId?: string): ChromeRuntimeHostMessage {
    if (this.#phase === "active" || this.#phase === "update-required") {
      this.#phase = "update-required";
      return this.#updateRequired(requestId);
    }
    return this.#failure("lifecycle", "protocol-mismatch", requestId);
  }
  #updateRequired(requestId?: string): ChromeRuntimeHostMessage {
    return { type: "update-required", lane: "lifecycle", protocolVersion: 2, connectionId: this.#connectionId ?? "unnegotiated", ...(requestId === undefined ? {} : { requestId }) };
  }
  #projection(type: "projection" | "active", requestId: string, payload: ChromeRuntimeProjection): ChromeRuntimeHostMessage {
    const safe = sanitizeChromeRuntimeProjection(payload);
    if (safe === undefined) return this.#failure("lifecycle", "invalid-service-response", requestId);
    return { type, lane: "lifecycle", protocolVersion: 2, connectionId: this.#connectionId!, requestId, payload: safe };
  }
}

export class ChromeRuntimeManager {
  readonly #backend: ChromeRuntimeBackend;
  readonly #connectionOptions: { readonly idleLeaseMs?: number; readonly requestTimeoutMs?: number };
  readonly #connections = new Map<string, ChromeRuntimeConnection>();
  readonly #events = new Map<string, ChromeRuntimeHostMessage[]>();

  constructor(
    backend: ChromeRuntimeBackend,
    options: { readonly idleLeaseMs?: number; readonly requestTimeoutMs?: number } = {},
  ) {
    this.#backend = backend;
    this.#connectionOptions = options;
  }

  activity(): { readonly connections: number; readonly queuedEvents: number } {
    return {
      connections: this.#connections.size,
      queuedEvents: [...this.#events.values()].reduce((sum, events) => sum + events.length, 0),
    };
  }

  async handle(portId: string, raw: unknown): Promise<readonly ChromeRuntimeHostMessage[]> {
    let connection = this.#connections.get(portId);
    if (connection === undefined) {
      const record = typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? raw as Record<string, unknown> : undefined;
      if (record?.type !== "hello") {
        const lane = record?.lane === "acquisition" || record?.lane === "runtime" ||
          record?.lane === "resource" || record?.lane === "lifecycle"
          ? record.lane : "lifecycle";
        return [{
          type: "failure", lane, protocolVersion: 2,
          connectionId: typeof record?.connectionId === "string" ? record.connectionId : "unnegotiated",
          ...(typeof record?.requestId === "string" ? { requestId: record.requestId } : {}),
          reason: "connection-closed",
        }];
      }
      try {
        connection = new ChromeRuntimeConnection({
          callerOrigin: CHROME_EXTENSION_ORIGIN,
          backend: this.#backend,
          ...this.#connectionOptions,
          onAsyncMessage: (message) => {
            const events = this.#events.get(portId) ?? [];
            events.push(message);
            this.#events.set(portId, events);
          },
          onClosed: () => {
            this.#connections.delete(portId);
            this.#events.delete(portId);
          },
        });
      } catch {
        return [{
          type: "failure", lane: "lifecycle", protocolVersion: 2,
          connectionId: typeof record.connectionId === "string" ? record.connectionId : "unnegotiated",
          ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}),
          reason: "host-busy",
        }];
      }
      this.#connections.set(portId, connection);
    }
    const response = await connection.handle(raw);
    if (response.type === "failure" && response.reason === "protocol-mismatch") {
      await connection.disconnect();
    }
    const events = this.#events.get(portId) ?? [];
    this.#events.delete(portId);
    return [response, ...events];
  }

  async detach(portId: string): Promise<void> {
    const connection = this.#connections.get(portId);
    this.#connections.delete(portId);
    this.#events.delete(portId);
    await connection?.disconnect();
  }

  async close(): Promise<void> {
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    this.#events.clear();
    await Promise.all(connections.map((connection) => connection.disconnect()));
  }
}

function normalizeRemoteSourceIdentity(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") return undefined;
    url.hash = "";
    return url.href;
  } catch { return undefined; }
}

function normalizeLocalSourceIdentity(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || url.hostname !== "" || url.search !== "" || url.hash !== "") return undefined;
    return url.href;
  } catch { return undefined; }
}
