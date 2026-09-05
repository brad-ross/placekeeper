import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import {
  MACOS_HELPER_RESOURCE_CHUNK_BYTES,
  parseMacosReviewHelperMessage,
  sanitizeMacosRuntimeProjection,
  type MacosReviewHelperMessage,
  type MacosReviewHelperResponse,
  type MacosRuntimeProjection,
} from "../../../../packages/core/src/macos-helper-protocol.js";
import {
  decodePlacekeeperLink,
  encodePlacekeeperLinkFragment,
  type PlacekeeperLinkLocation,
} from "../../../../packages/core/src/placekeeper-link.js";
import {
  sanitizeMacosReviewRuntimeResponse,
  sanitizeReviewRuntimeDisplayString,
  type ReviewRuntimeBrokerMethod,
} from "../../../../packages/core/src/review-runtime-protocol.js";
import type {
  ChromeRuntimeBackend,
  ChromeRuntimeProjection,
  ChromeRuntimeRecovery,
  ChromeRuntimeSourceSink,
  ChromeRuntimeStagedReview,
} from "../browser/chrome-runtime.js";

export type MacosRuntimeBackend = ChromeRuntimeBackend;
export type MacosRuntimeTrustedProjection = ChromeRuntimeProjection;
export type { MacosRuntimeProjection };

const NON_IDEMPOTENT = new Set<ReviewRuntimeBrokerMethod>([
  "command", "chooseCopy", "chooseFolder", "chooseOriginal", "retrySave", "locateSave", "exportReviewedCopy",
]);

interface RuntimeRecordBase {
  readonly helperId: string;
  readonly windowId: string;
  readonly attemptId: string;
  readonly displayName: string;
}

interface StagedRuntimeRecord extends RuntimeRecordBase {
  readonly canonicalKey: string;
  readonly resourceId: string;
  readonly provisionalId: string;
  readonly presentationLease: string;
  phase: "provisional" | "active";
  trustedProjection: ChromeRuntimeProjection;
  projection: MacosRuntimeProjection;
}

interface RecoveryRuntimeRecord extends RuntimeRecordBase {
  readonly phase: "recovery";
  readonly recovery: ChromeRuntimeRecovery;
  readonly location?: PlacekeeperLinkLocation;
}

type RuntimeRecord = StagedRuntimeRecord | RecoveryRuntimeRecord;

interface RequestRecord {
  readonly fingerprint: string;
  readonly controller: AbortController;
  readonly releaseRequest: () => void;
  result: Promise<MacosReviewHelperResponse>;
  releaseResource: (() => void) | undefined;
  completed: boolean;
}

export interface MacosRuntimeManagerOptions {
  readonly maxHelpers?: number;
  readonly maxConcurrentRequests?: number;
  readonly maxConcurrentRequestsPerHelper?: number;
  readonly maxResources?: number;
  readonly maxResourcesPerHelper?: number;
  readonly maxRetainedRequestsPerHelper?: number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function opaque(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("request-aborted");
}

function rawEnvelope(raw: unknown): {
  readonly windowId: string;
  readonly attemptId: string;
  readonly requestId: string;
} {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  const safe = (value: unknown, fallback: string) => typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value)
    ? value : fallback;
  return {
    windowId: safe(record.windowId, "window_invalid"),
    attemptId: safe(record.attemptId, "attempt_invalid"),
    requestId: safe(record.requestId, "request_invalid"),
  };
}

export class MacosRuntimeManager {
  readonly #backend: MacosRuntimeBackend;
  readonly #limits: Required<MacosRuntimeManagerOptions>;
  readonly #records = new Map<string, RuntimeRecord>();
  readonly #requests = new Map<string, RequestRecord>();
  readonly #completedRequestKeysByHelper = new Map<string, string[]>();
  readonly #activeRequestsByHelper = new Map<string, number>();
  readonly #activeResourcesByHelper = new Map<string, number>();
  #activeRequests = 0;
  #activeResources = 0;

  constructor(backend: MacosRuntimeBackend, options: MacosRuntimeManagerOptions = {}) {
    this.#backend = backend;
    this.#limits = {
      maxHelpers: options.maxHelpers ?? 8,
      maxConcurrentRequests: options.maxConcurrentRequests ?? 32,
      maxConcurrentRequestsPerHelper: options.maxConcurrentRequestsPerHelper ?? 8,
      maxResources: options.maxResources ?? 8,
      maxResourcesPerHelper: options.maxResourcesPerHelper ?? 1,
      maxRetainedRequestsPerHelper: Math.max(0, options.maxRetainedRequestsPerHelper ?? 256),
    };
  }

  activity(): { readonly helpers: number; readonly activeHelpers: number; readonly resources: number } {
    return {
      helpers: this.#records.size,
      activeHelpers: [...this.#records.values()].filter((record) => record.phase === "active").length,
      resources: this.#activeResources,
    };
  }

  resourceId(helperId: string): string | undefined {
    const record = this.#records.get(helperId);
    return record?.phase === "recovery" ? undefined : record?.resourceId;
  }

  async handle(helperId: string, raw: unknown): Promise<MacosReviewHelperResponse> {
    const message = parseMacosReviewHelperMessage(raw);
    if (message === undefined || !/^[A-Za-z0-9_-]{8,128}$/u.test(helperId)) {
      return this.#failure(rawEnvelope(raw), "invalid");
    }
    const requestKey = `${helperId}\0${message.requestId}`;
    const fingerprint = createHash("sha256").update(canonicalJson(message)).digest("hex");
    const existing = this.#requests.get(requestKey);
    if (existing !== undefined) {
      return existing.fingerprint === fingerprint
        ? existing.result
        : this.#failure(message, "invalid");
    }
    const activeForHelper = this.#activeRequestsByHelper.get(helperId) ?? 0;
    if (this.#activeRequests >= this.#limits.maxConcurrentRequests
      || activeForHelper >= this.#limits.maxConcurrentRequestsPerHelper) return this.#failure(message, "budget");
    const controller = new AbortController();
    const request: RequestRecord = {
      fingerprint,
      controller,
      releaseRequest: this.#reserveRequest(helperId),
      result: Promise.resolve(this.#failure(message, "unavailable")),
      releaseResource: undefined,
      completed: false,
    };
    // Install the record before dispatch so a synchronous release request can
    // detach and reclaim its own reservation without leaving a replay entry.
    this.#requests.set(requestKey, request);
    const result = this.#dispatch(helperId, message, controller.signal, request).finally(() => {
      request.releaseRequest();
      if (this.#requests.get(requestKey) !== request) return;
      if (message.type === "read-resource") this.#requests.delete(requestKey);
      else this.#retainCompletedRequest(helperId, requestKey, request);
    });
    request.result = result;
    return result;
  }

  async #dispatch(
    helperId: string,
    message: MacosReviewHelperMessage,
    signal: AbortSignal,
    request: RequestRecord,
  ): Promise<MacosReviewHelperResponse> {
    const existing = this.#records.get(helperId);
    if (existing === undefined) {
      return message.type === "admit" || message.type === "admit-link"
        ? this.#admit(helperId, message, signal)
        : this.#failure(message, "invalid");
    }
    if (message.windowId !== existing.windowId || message.attemptId !== existing.attemptId
      || message.type === "admit" || message.type === "admit-link") {
      return this.#failure(message, "invalid");
    }
    if (message.type === "release") {
      await this.detach(helperId);
      return { ...this.#envelope(message), type: "released" };
    }
    if (existing.phase === "recovery") {
      return message.type === "recover" ? this.#recover(existing, message, signal) : this.#failure(message, "invalid");
    }
    if (message.type === "recover") return this.#failure(message, "invalid");
    if (message.type === "activate") return this.#activate(existing, message, signal);
    if (message.type === "refresh") return this.#refresh(existing, message, signal);
    if (message.type === "keepalive") return this.#keepalive(existing, message, signal);
    if (message.type === "invoke") return this.#invoke(existing, message, signal);
    if (message.type === "read-resource") return this.#read(existing, message, signal, request);
    if (message.type === "copy-link") return this.#copyLink(existing, message);
    return this.#failure(message, "invalid");
  }

  async #admit(
    helperId: string,
    message: Extract<MacosReviewHelperMessage, { readonly type: "admit" | "admit-link" }>,
    signal: AbortSignal,
  ): Promise<MacosReviewHelperResponse> {
    if (this.#records.size >= this.#limits.maxHelpers) return this.#failure(message, "budget");
    let sourcePath: string;
    let location: PlacekeeperLinkLocation | undefined;
    try {
      if (message.type === "admit-link") {
        const target = decodePlacekeeperLink(message.link);
        sourcePath = target.path;
        location = target.location;
      } else {
        sourcePath = message.sourcePath;
      }
    } catch {
      return this.#failure(message, "invalid");
    }
    const fileUrl = pathToFileURL(sourcePath).href;
    let canonicalKey: string | undefined;
    let sink: ChromeRuntimeSourceSink | undefined;
    try {
      sink = await this.#backend.begin({
        sourceIdentity: createHash("sha256").update(fileUrl).digest("hex"),
        disposition: "local",
        fileUrl,
      }, signal);
      throwIfAborted(signal);
      const staged = await sink.finish(undefined, signal);
      if (!("choose" in staged)) canonicalKey = staged.canonicalKey;
      throwIfAborted(signal);
      const displayName = sanitizeReviewRuntimeDisplayString(basename(sourcePath));
      if (displayName === undefined) throw new Error("invalid-display-name");
      if ("choose" in staged) {
        this.#records.set(helperId, {
          helperId,
          windowId: message.windowId,
          attemptId: message.attemptId,
          displayName,
          phase: "recovery",
          recovery: staged,
          ...(location === undefined ? {} : { location }),
        });
        return {
          ...this.#envelope(message),
          type: "recovery-offered",
          choices: staged.choices,
          offer: staged.offer,
        };
      }
      return this.#stage(helperId, message, displayName, staged, location);
    } catch {
      if (signal.aborted) await sink?.cancel().catch(() => undefined);
      if (canonicalKey !== undefined) await this.#backend.release(canonicalKey).catch(() => undefined);
      return this.#failure(message, "unavailable");
    }
  }

  async #recover(
    record: RecoveryRuntimeRecord,
    message: Extract<MacosReviewHelperMessage, { readonly type: "recover" }>,
    signal: AbortSignal,
  ): Promise<MacosReviewHelperResponse> {
    if (message.offer.id !== record.recovery.offer.id || message.offer.expiresAt !== record.recovery.offer.expiresAt) {
      return this.#failure(message, "invalid");
    }
    let staged: ChromeRuntimeStagedReview | undefined;
    try {
      staged = await record.recovery.choose(message.decision, message.idempotencyKey);
      throwIfAborted(signal);
      return this.#stage(record.helperId, message, record.displayName, staged, record.location);
    } catch {
      if (staged !== undefined) await this.#backend.release(staged.canonicalKey).catch(() => undefined);
      return this.#failure(message, "recovery");
    }
  }

  #stage(
    helperId: string,
    message: Pick<MacosReviewHelperMessage, "windowId" | "attemptId" | "requestId">,
    displayName: string,
    staged: ChromeRuntimeStagedReview,
    location?: PlacekeeperLinkLocation,
  ): MacosReviewHelperResponse {
    const trustedProjection = location === undefined
      ? staged.projection
      : { ...staged.projection, location };
    const projection = sanitizeMacosRuntimeProjection(trustedProjection);
    if (projection === undefined) throw new Error("invalid-projection");
    const record: StagedRuntimeRecord = {
      helperId,
      windowId: message.windowId,
      attemptId: message.attemptId,
      canonicalKey: staged.canonicalKey,
      resourceId: opaque("resource"),
      provisionalId: opaque("claim"),
      displayName,
      presentationLease: randomBytes(32).toString("base64url"),
      phase: "provisional",
      trustedProjection,
      projection,
    };
    this.#records.set(helperId, record);
    return {
      ...this.#envelope(message),
      type: "admitted",
      provisionalId: record.provisionalId,
      resourceId: record.resourceId,
      generation: projection.generation,
      byteLength: projection.document.byteLength,
      digest: projection.document.sha256,
      displayName,
      projection,
    };
  }

  async #activate(
    record: StagedRuntimeRecord,
    message: Extract<MacosReviewHelperMessage, { readonly type: "activate" }>,
    signal: AbortSignal,
  ): Promise<MacosReviewHelperResponse> {
    if (record.phase !== "provisional") return this.#failure(message, "invalid");
    try {
      const trusted = await this.#backend.activate(record.canonicalKey, record.presentationLease, signal);
      if (signal.aborted) {
        await this.#backend.detach(record.canonicalKey, record.presentationLease).catch(() => undefined);
        return this.#failure(message, "unavailable");
      }
      const projection = sanitizeMacosRuntimeProjection(trusted);
      if (projection === undefined) throw new Error("invalid-projection");
      record.phase = "active";
      record.trustedProjection = trusted;
      record.projection = projection;
      return { ...this.#envelope(message), type: "active", projection };
    } catch {
      await this.#backend.release(record.canonicalKey).catch(() => undefined);
      if (this.#records.get(record.helperId) === record) this.#records.delete(record.helperId);
      return this.#failure(message, "unavailable");
    }
  }

  async #refresh(
    record: StagedRuntimeRecord,
    message: Extract<MacosReviewHelperMessage, { readonly type: "refresh" }>,
    signal: AbortSignal,
  ): Promise<MacosReviewHelperResponse> {
    try {
      const trusted = await this.#backend.current(record.canonicalKey, signal);
      throwIfAborted(signal);
      const projection = sanitizeMacosRuntimeProjection(trusted);
      if (projection === undefined) throw new Error("invalid-projection");
      record.trustedProjection = trusted;
      record.projection = projection;
      return { ...this.#envelope(message), type: "refreshed", projection };
    } catch {
      return this.#failure(message, "unavailable");
    }
  }

  async #keepalive(
    record: StagedRuntimeRecord,
    message: Extract<MacosReviewHelperMessage, { readonly type: "keepalive" }>,
    signal: AbortSignal,
  ): Promise<MacosReviewHelperResponse> {
    if (record.phase !== "active") return this.#failure(message, "invalid");
    try {
      const previous = record.projection;
      const trusted = await this.#backend.current(record.canonicalKey, signal);
      throwIfAborted(signal);
      const projection = sanitizeMacosRuntimeProjection(trusted);
      if (projection === undefined) throw new Error("invalid-projection");
      record.trustedProjection = trusted;
      record.projection = projection;
      const saveChanged = canonicalJson(previous.saveStatus) !== canonicalJson(projection.saveStatus);
      const recoveryChanged = previous.protected !== projection.protected;
      if (projection.generation !== previous.generation || projection.revision !== previous.revision
        || saveChanged || recoveryChanged) {
        return {
          ...this.#envelope(message),
          type: "invalidation",
          generation: projection.generation,
          revision: projection.revision,
          reason: projection.generation !== previous.generation
            ? "generation"
            : projection.revision !== previous.revision
              ? "revision"
              : recoveryChanged ? "recovery" : "save",
        };
      }
      return { ...this.#envelope(message), type: "refreshed", projection };
    } catch {
      return this.#failure(message, "unavailable");
    }
  }

  async #invoke(
    record: StagedRuntimeRecord,
    message: Extract<MacosReviewHelperMessage, { readonly type: "invoke" }>,
    signal: AbortSignal,
  ): Promise<MacosReviewHelperResponse> {
    if (record.phase !== "active") return this.#failure(message, "invalid");
    if (message.generation !== record.projection.generation || message.revision !== record.projection.revision) {
      return this.#failure(message, "stale");
    }
    if (NON_IDEMPOTENT.has(message.method) && message.idempotencyKey === undefined) {
      return this.#failure(message, "invalid");
    }
    try {
      if (NON_IDEMPOTENT.has(message.method)) {
        const trusted = await this.#backend.current(record.canonicalKey, signal);
        throwIfAborted(signal);
        const projection = sanitizeMacosRuntimeProjection(trusted);
        if (projection === undefined) throw new Error("invalid-projection");
        record.trustedProjection = trusted;
        record.projection = projection;
        if (message.generation !== projection.generation || message.revision !== projection.revision) {
          return this.#failure(message, "stale");
        }
      }
      const payloadDigest = createHash("sha256")
        .update(canonicalJson({ method: message.method, payload: message.payload }))
        .digest("hex");
      const result = await this.#backend.invoke(record.canonicalKey, message.method, message.payload, {
        ...(message.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey }),
        payloadDigest,
      }, signal);
      throwIfAborted(signal);
      const payload = sanitizeMacosReviewRuntimeResponse(message.method, result);
      if (payload === undefined) return this.#failure(message, "unavailable");
      const current = await this.#backend.current(record.canonicalKey, signal);
      throwIfAborted(signal);
      const projection = sanitizeMacosRuntimeProjection(current);
      if (projection !== undefined) {
        record.trustedProjection = current;
        record.projection = projection;
      }
      return { ...this.#envelope(message), type: "result", method: message.method, payload };
    } catch {
      return this.#failure(message, "unavailable");
    }
  }

  async #read(
    record: StagedRuntimeRecord,
    message: Extract<MacosReviewHelperMessage, { readonly type: "read-resource" }>,
    signal: AbortSignal,
    request: RequestRecord,
  ): Promise<MacosReviewHelperResponse> {
    if (message.resourceId !== record.resourceId || message.generation !== record.projection.generation
      || message.offset + message.length > record.projection.document.byteLength) {
      return this.#failure(message, "stale");
    }
    const resourcesForHelper = this.#activeResourcesByHelper.get(record.helperId) ?? 0;
    if (this.#activeResources >= this.#limits.maxResources
      || resourcesForHelper >= this.#limits.maxResourcesPerHelper) return this.#failure(message, "budget");
    const releaseResource = this.#reserveResource(record.helperId);
    request.releaseResource = releaseResource;
    try {
      const bytes = await this.#backend.readDocument(
        record.canonicalKey,
        message.generation,
        message.offset,
        message.length,
        signal,
      );
      throwIfAborted(signal);
      return {
        ...this.#envelope(message),
        type: "resource-bytes",
        sequence: Math.floor(message.offset / MACOS_HELPER_RESOURCE_CHUNK_BYTES),
        data: bytes.toString("base64"),
        done: message.offset + bytes.byteLength >= record.projection.document.byteLength,
      };
    } catch {
      return this.#failure(message, "unavailable");
    } finally {
      releaseResource();
      if (request.releaseResource === releaseResource) request.releaseResource = undefined;
    }
  }

  #copyLink(
    record: StagedRuntimeRecord,
    message: Extract<MacosReviewHelperMessage, { readonly type: "copy-link" }>,
  ): MacosReviewHelperResponse {
    if (record.phase !== "active") return this.#failure(message, "invalid");
    const link = `${record.trustedProjection.canonicalLinkBase}#${encodePlacekeeperLinkFragment(message.location)}`;
    return { ...this.#envelope(message), type: "placekeeper-link", link };
  }

  async helperDied(helperId: string): Promise<void> {
    await this.detach(helperId);
  }

  async detach(helperId: string): Promise<void> {
    const record = this.#records.get(helperId);
    if (record !== undefined) this.#records.delete(helperId);
    for (const [key, request] of [...this.#requests.entries()]) {
      if (!key.startsWith(`${helperId}\0`)) continue;
      request.controller.abort();
      request.releaseResource?.();
      request.releaseResource = undefined;
      request.releaseRequest();
      this.#requests.delete(key);
    }
    this.#completedRequestKeysByHelper.delete(helperId);
    this.#activeRequestsByHelper.delete(helperId);
    this.#activeResourcesByHelper.delete(helperId);
    if (record === undefined) return;
    if (record.phase === "active") {
      await this.#backend.detach(record.canonicalKey, record.presentationLease).catch(() => undefined);
    } else if (record.phase === "provisional") {
      await this.#backend.release(record.canonicalKey).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const helperIds = new Set([
      ...this.#records.keys(),
      ...[...this.#requests.keys()].map((key) => key.slice(0, key.indexOf("\0"))),
    ]);
    await Promise.all([...helperIds].map((helperId) => this.detach(helperId)));
  }

  #reserveRequest(helperId: string): () => void {
    this.#activeRequests += 1;
    this.#activeRequestsByHelper.set(helperId, (this.#activeRequestsByHelper.get(helperId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeRequests = Math.max(0, this.#activeRequests - 1);
      const remaining = Math.max(0, (this.#activeRequestsByHelper.get(helperId) ?? 0) - 1);
      if (remaining === 0) this.#activeRequestsByHelper.delete(helperId);
      else this.#activeRequestsByHelper.set(helperId, remaining);
    };
  }

  #reserveResource(helperId: string): () => void {
    this.#activeResources += 1;
    this.#activeResourcesByHelper.set(helperId, (this.#activeResourcesByHelper.get(helperId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeResources = Math.max(0, this.#activeResources - 1);
      const remaining = Math.max(0, (this.#activeResourcesByHelper.get(helperId) ?? 0) - 1);
      if (remaining === 0) this.#activeResourcesByHelper.delete(helperId);
      else this.#activeResourcesByHelper.set(helperId, remaining);
    };
  }

  #retainCompletedRequest(helperId: string, requestKey: string, request: RequestRecord): void {
    request.completed = true;
    const completed = this.#completedRequestKeysByHelper.get(helperId) ?? [];
    completed.push(requestKey);
    this.#completedRequestKeysByHelper.set(helperId, completed);
    while (completed.length > this.#limits.maxRetainedRequestsPerHelper) {
      const evictedKey = completed.shift();
      if (evictedKey === undefined) break;
      const evicted = this.#requests.get(evictedKey);
      if (evicted?.completed === true) this.#requests.delete(evictedKey);
    }
    if (completed.length === 0) this.#completedRequestKeysByHelper.delete(helperId);
  }

  #envelope(message: Pick<MacosReviewHelperMessage, "windowId" | "attemptId" | "requestId">) {
    return {
      protocolVersion: 1 as const,
      windowId: message.windowId,
      attemptId: message.attemptId,
      requestId: message.requestId,
    };
  }

  #failure(
    message: { readonly windowId: string; readonly attemptId: string; readonly requestId: string },
    code: Extract<MacosReviewHelperResponse, { readonly type: "failure" }>["code"],
  ): MacosReviewHelperResponse {
    return { ...this.#envelope(message), type: "failure", code };
  }
}
