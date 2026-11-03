import { assertHostLocalPath } from "../links/placekeeper-link.js";
import type { NativeTaskLaunchAdmission, NativeTaskLaunchClaim, NativeTaskLaunchStage } from "./native-task-launches.js";
import type { NativeSyncTex } from "../synctex/native-synctex.js";
import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import {
  NATIVE_HELPER_RESOURCE_CHUNK_BYTES,
  parseNativeReviewHelperMessage,
  sanitizeNativeRuntimeProjection,
  type NativeReviewHelperMessage,
  type NativeReviewHelperResponse,
  type NativeRuntimeProjection,
} from "../../../../packages/core/src/native-helper-protocol.js";
import {
  decodePlacekeeperLink,
  encodePlacekeeperLinkFragment,
  type PlacekeeperLinkLocation,
} from "../../../../packages/core/src/placekeeper-link.js";
import {
  sanitizeNativeReviewRuntimeResponse,
  type NativeRuntimeHost,
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

import { canonicalJson } from "../runtime/canonical-json.js";

export type NativeRuntimeBackend = ChromeRuntimeBackend;
export type NativeRuntimeTrustedProjection = ChromeRuntimeProjection;
export type { NativeRuntimeProjection };

const NON_IDEMPOTENT = new Set<ReviewRuntimeBrokerMethod>([
  "command", "beginInteraction", "finalizeInteraction", "releaseInteraction", "acknowledgeInteraction",
  "chooseCopy", "chooseFolder", "chooseOriginal", "retrySave", "locateSave", "exportReviewedCopy",
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
  projection: NativeRuntimeProjection;
  readonly documents: Map<number, { readonly byteLength: number; readonly digest: string }>;
  adoptedResourceGeneration: number;
  taskLaunch?: NativeTaskLaunchAdmission;
  taskLaunchAwaitingActivation?: boolean;
  interactionAttachment?: import("../sessions/review-interactions.js").ReviewInteractionAttachment;
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
  result: Promise<NativeReviewHelperResponse>;
  releaseResource: (() => void) | undefined;
  completed: boolean;
}

export interface NativeRuntimeManagerOptions {
  readonly maxHelpers?: number;
  readonly maxConcurrentRequests?: number;
  readonly maxConcurrentRequestsPerHelper?: number;
  readonly maxResources?: number;
  readonly maxResourcesPerHelper?: number;
  readonly maxRetainedRequestsPerHelper?: number;
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

export class NativeRuntimeManager {
  readonly #host: NativeRuntimeHost;
  readonly #backend: NativeRuntimeBackend;
  navigation?: NativeSyncTex;
  admitsNavigation?: (helperId: string, navigationHandle: string, canonicalPdfPath: string) => boolean;
  readonly #limits: Required<NativeRuntimeManagerOptions>;
  readonly #records = new Map<string, RuntimeRecord>();
  readonly #requests = new Map<string, RequestRecord>();
  readonly #pendingResultsByHelper = new Map<string, Set<Promise<NativeReviewHelperResponse>>>();
  readonly #completedRequestKeysByHelper = new Map<string, string[]>();
  readonly #activeRequestsByHelper = new Map<string, number>();
  readonly #activeResourcesByHelper = new Map<string, number>();
  #activeRequests = 0;
  #activeResources = 0;

  constructor(host: NativeRuntimeHost, backend: NativeRuntimeBackend, options: NativeRuntimeManagerOptions = {}) {
    this.#host = host;
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

  stageLaunch(input: NativeTaskLaunchStage) {
    return this.#host === "electron" ? this.#backend.nativeTaskLaunches?.stageLaunch(input) : undefined;
  }

  resolveLaunch(launchId: string) {
    return this.#host === "electron" ? this.#backend.nativeTaskLaunches?.resolveLaunch(launchId) : undefined;
  }

  claimLaunch(input: NativeTaskLaunchClaim): boolean {
    return this.#host === "electron" && (this.#backend.nativeTaskLaunches?.claimLaunch(input) ?? false);
  }

  cancelLaunch(launchId: string): boolean {
    return this.#host === "electron" && (this.#backend.nativeTaskLaunches?.cancelLaunch(launchId) ?? false);
  }

  activity(): { readonly helpers: number; readonly activeHelpers: number; readonly resources: number } {
    return {
      helpers: this.#records.size,
      activeHelpers: [...this.#records.values()].filter((record) => record.phase === "active").length,
      resources: this.#activeResources,
    };
  }

  navigationSessionId(helperId: string): string | undefined {
    const record = this.#records.get(helperId);
    return record === undefined || record.phase === "recovery" ? undefined : record.projection.sessionId;
  }

  resourceId(helperId: string): string | undefined {
    const record = this.#records.get(helperId);
    return record?.phase === "recovery" ? undefined : record?.resourceId;
  }

  async handle(helperId: string, raw: unknown): Promise<NativeReviewHelperResponse> {
    const message = parseNativeReviewHelperMessage(this.#host, raw);
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
    const pending = this.#pendingResultsByHelper.get(helperId) ?? new Set<Promise<NativeReviewHelperResponse>>();
    this.#pendingResultsByHelper.set(helperId, pending);
    pending.add(result);
    const settled = () => {
      pending.delete(result);
      if (pending.size === 0 && this.#pendingResultsByHelper.get(helperId) === pending) this.#pendingResultsByHelper.delete(helperId);
    };
    void result.then(settled, settled);
    return result;
  }

  async #dispatch(
    helperId: string,
    message: NativeReviewHelperMessage,
    signal: AbortSignal,
    request: RequestRecord,
  ): Promise<NativeReviewHelperResponse> {
    const existing = this.#records.get(helperId);
    if (existing === undefined) {
      if (message.type === "admit-launch") return this.#admitLaunch(helperId, message, signal);
      return message.type === "admit" || message.type === "admit-link"
        ? this.#admit(helperId, message, signal)
        : this.#failure(message, "invalid");
    }
    if (message.windowId !== existing.windowId || message.attemptId !== existing.attemptId
      || message.type === "admit" || message.type === "admit-link") {
      return this.#failure(message, "invalid");
    }
    if (message.type === "admit-launch") return this.#admitLaunch(helperId, message, signal, existing);
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
    if (message.type === "destination-selection") {
      return this.#invoke(existing, { ...message, type: "invoke", payload: {} }, signal,
        { selectedPath: message.selectedPath });
    }
    if (message.type === "invoke") return this.#invoke(existing, message, signal);
    if (message.type === "read-resource") return this.#read(existing, message, signal, request);
    if (message.type === "adopt-resource") return this.#adoptResource(existing, message);
    if (message.type === "copy-link") return this.#copyLink(existing, message);
    return this.#failure(message, "invalid");
  }

  async #admitLaunch(
    helperId: string,
    message: Extract<NativeReviewHelperMessage, { readonly type: "admit-launch" }>,
    signal: AbortSignal,
    existing?: RuntimeRecord,
  ): Promise<NativeReviewHelperResponse> {
    const launches = this.#backend.nativeTaskLaunches;
    const admission = launches?.reserve(message.launchId);
    if (admission === undefined || launches === undefined) return this.#failure(message, "invalid");
    try {
      if (existing !== undefined) {
        if (existing.phase !== "active") throw new Error("native-window-not-active");
        const trusted = await this.#backend.current(existing.canonicalKey, signal);
        throwIfAborted(signal);
        if (this.#records.get(helperId) !== existing ||
          !launches.matches(admission, trusted.sessionId, trusted.generation)) throw new Error("native-launch-target-mismatch");
        const located = admission.location === undefined ? trusted : { ...trusted, location: admission.location };
        const projection = sanitizeNativeRuntimeProjection(this.#host, located);
        if (projection === undefined) throw new Error("invalid-projection");
        if (existing.taskLaunch !== undefined) launches.detach(existing.taskLaunch);
        existing.taskLaunch = admission;
        existing.taskLaunchAwaitingActivation = true;
        existing.trustedProjection = located;
        existing.projection = projection;
        return { ...this.#envelope(message), type: "refreshed", projection };
      }
      const result = await this.#admit(helperId, { ...message, type: "admit", sourcePath: admission.sourcePath }, signal);
      throwIfAborted(signal);
      const record = this.#records.get(helperId);
      if (result.type !== "admitted" || record === undefined || record.phase !== "provisional" ||
        !launches.matches(admission, record.projection.sessionId, record.projection.generation)) {
        if (record !== undefined) await this.detach(helperId);
        throw new Error("native-launch-target-mismatch");
      }
      record.taskLaunch = admission;
      record.taskLaunchAwaitingActivation = true;
      if (admission.location !== undefined) {
        record.trustedProjection = { ...record.trustedProjection, location: admission.location };
        const projection = sanitizeNativeRuntimeProjection(this.#host, record.trustedProjection);
        if (projection === undefined) throw new Error("invalid-projection");
        record.projection = projection;
        return { ...result, projection };
      }
      return result;
    } catch {
      launches.detach(admission);
      return this.#failure(message, "unavailable");
    }
  }

  async #admit(
    helperId: string,
    message: Extract<NativeReviewHelperMessage, { readonly type: "admit" | "admit-link" }>,
    signal: AbortSignal,
  ): Promise<NativeReviewHelperResponse> {
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
      assertHostLocalPath(sourcePath);
    } catch {
      return this.#failure(message, "invalid");
    }
    const fileUrl = pathToFileURL(sourcePath).href;
    let canonicalKey: string | undefined;
    let sink: ChromeRuntimeSourceSink | undefined;
    try {
      let initialWorkflowMode: "generated-output" | undefined;
      if (message.type === "admit" && message.navigationHandle !== undefined) {
        const canonicalPath = await realpath(sourcePath);
        if (this.admitsNavigation?.(helperId, message.navigationHandle, canonicalPath) !== true) return this.#failure(message, "invalid");
        initialWorkflowMode = "generated-output";
      }
      sink = await this.#backend.begin({
        sourceIdentity: createHash("sha256").update(fileUrl).digest("hex"),
        disposition: "local",
        fileUrl,
        ...(initialWorkflowMode === undefined ? {} : { initialWorkflowMode }),
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
    message: Extract<NativeReviewHelperMessage, { readonly type: "recover" }>,
    signal: AbortSignal,
  ): Promise<NativeReviewHelperResponse> {
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
    message: Pick<NativeReviewHelperMessage, "windowId" | "attemptId" | "requestId">,
    displayName: string,
    staged: ChromeRuntimeStagedReview,
    location?: PlacekeeperLinkLocation,
  ): NativeReviewHelperResponse {
    const trustedProjection = location === undefined
      ? staged.projection
      : { ...staged.projection, location };
    const projection = sanitizeNativeRuntimeProjection(this.#host, trustedProjection);
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
      documents: new Map([[projection.generation, {
        byteLength: projection.document.byteLength, digest: projection.document.sha256,
      }]]),
      adoptedResourceGeneration: projection.generation,
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
    message: Extract<NativeReviewHelperMessage, { readonly type: "activate" }>,
    signal: AbortSignal,
  ): Promise<NativeReviewHelperResponse> {
    if (record.phase !== "provisional" && !record.taskLaunchAwaitingActivation) return this.#failure(message, "invalid");
    const taskLaunch = record.taskLaunch;
    if (record.taskLaunchAwaitingActivation) {
      if (taskLaunch === undefined || !this.#backend.nativeTaskLaunches?.matchesActivation(taskLaunch, message.launchId)) {
        return this.#failure(message, "invalid");
      }
    } else if (message.launchId !== undefined) return this.#failure(message, "invalid");
    const wasActive = record.phase === "active";
    try {
      const current = wasActive ? await this.#backend.current(record.canonicalKey, signal)
        : await this.#backend.activate(record.canonicalKey, record.presentationLease, signal);
      const trusted = taskLaunch?.location === undefined ? current : { ...current, location: taskLaunch.location };
      if (signal.aborted) {
        await this.#backend.detach(record.canonicalKey, record.presentationLease).catch(() => undefined);
        return this.#failure(message, "unavailable");
      }
      if (this.#records.get(record.helperId) !== record) throw new Error("native-window-detached");
      if (record.taskLaunch !== taskLaunch) return this.#failure(message, "stale");
      // Backend activation has acquired a presentation lease. Any subsequent
      // launch-fence failure must detach that lease rather than release admission.
      record.phase = "active";
      const projection = sanitizeNativeRuntimeProjection(this.#host, trusted);
      if (projection === undefined) throw new Error("invalid-projection");
      if (record.taskLaunch !== undefined && !this.#backend.nativeTaskLaunches?.matches(
        record.taskLaunch, trusted.sessionId, trusted.generation,
      )) throw new Error("stale-native-launch");
      const interactionAttachment = wasActive ? undefined : this.#backend.registerInteraction?.(
        record.canonicalKey, `${this.#host}:${record.helperId}:${record.attemptId}`,
      );
      if (interactionAttachment !== undefined) record.interactionAttachment = interactionAttachment;
      record.trustedProjection = trusted;
      record.projection = projection;
      this.#rememberDocument(record, projection);
      if (record.taskLaunch !== undefined && !this.#backend.nativeTaskLaunches?.visible(record.taskLaunch,
        () => this.#records.get(record.helperId) === record && record.phase === "active" && record.taskLaunch === taskLaunch)) {
        throw new Error("stale-native-launch");
      }
      delete record.taskLaunchAwaitingActivation;
      return { ...this.#envelope(message), type: "active", projection };
    } catch {
      if (wasActive && record.taskLaunch === taskLaunch) {
        if (record.taskLaunch !== undefined) this.#backend.nativeTaskLaunches?.detach(record.taskLaunch);
        delete record.taskLaunch;
        delete record.taskLaunchAwaitingActivation;
      } else if (!wasActive && this.#records.get(record.helperId) === record) await this.detach(record.helperId);
      return this.#failure(message, "unavailable");
    }
  }

  async #refresh(
    record: StagedRuntimeRecord,
    message: Extract<NativeReviewHelperMessage, { readonly type: "refresh" }>,
    signal: AbortSignal,
  ): Promise<NativeReviewHelperResponse> {
    try {
      const trusted = await this.#backend.current(record.canonicalKey, signal);
      throwIfAborted(signal);
      const projection = sanitizeNativeRuntimeProjection(this.#host, trusted);
      if (projection === undefined) throw new Error("invalid-projection");
      record.trustedProjection = trusted;
      record.projection = projection;
      this.#rememberDocument(record, projection);
      return { ...this.#envelope(message), type: "refreshed", projection };
    } catch {
      return this.#failure(message, "unavailable");
    }
  }

  async #keepalive(
    record: StagedRuntimeRecord,
    message: Extract<NativeReviewHelperMessage, { readonly type: "keepalive" }>,
    signal: AbortSignal,
  ): Promise<NativeReviewHelperResponse> {
    if (record.phase !== "active") return this.#failure(message, "invalid");
    try {
      const previous = record.projection;
      const trusted = await this.#backend.current(record.canonicalKey, signal);
      throwIfAborted(signal);
      const projection = sanitizeNativeRuntimeProjection(this.#host, trusted);
      if (projection === undefined) throw new Error("invalid-projection");
      record.trustedProjection = trusted;
      record.projection = projection;
      this.#rememberDocument(record, projection);
      if (record.taskLaunch !== undefined) this.#backend.nativeTaskLaunches?.renew(record.taskLaunch);
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
    message: Extract<NativeReviewHelperMessage, { readonly type: "invoke" }>,
    signal: AbortSignal,
    trustedDestinationSelection?: { readonly selectedPath: string | null },
  ): Promise<NativeReviewHelperResponse> {
    if (record.phase !== "active") return this.#failure(message, "invalid");
    const navigation = message.method === "forwardSyncTex" || message.method === "reverseSyncTex";
    if (message.generation !== record.projection.generation || (!navigation && message.revision !== record.projection.revision)) {
      return this.#failure(message, "stale");
    }
    if (NON_IDEMPOTENT.has(message.method) && message.idempotencyKey === undefined) {
      return this.#failure(message, "invalid");
    }
    try {
      if (NON_IDEMPOTENT.has(message.method)) {
        const trusted = await this.#backend.current(record.canonicalKey, signal);
        throwIfAborted(signal);
        const projection = sanitizeNativeRuntimeProjection(this.#host, trusted);
        if (projection === undefined) throw new Error("invalid-projection");
        record.trustedProjection = trusted;
        record.projection = projection;
        this.#rememberDocument(record, projection);
        if (message.generation !== projection.generation || message.revision !== projection.revision) {
          return this.#failure(message, "stale");
        }
      }
      const payloadDigest = createHash("sha256")
        .update(canonicalJson({ method: message.method, payload: message.payload,
          ...(trustedDestinationSelection === undefined ? {} : { trustedDestinationSelection, generation: message.generation, revision: message.revision }) }))
        .digest("hex");
      const interactionAction = message.method === "beginInteraction" ? "begin"
        : message.method === "finalizeInteraction" ? "finalize"
          : message.method === "releaseInteraction" ? "release"
            : message.method === "acknowledgeInteraction" ? "acknowledge" : undefined;
      const result = message.method === "forwardSyncTex" || message.method === "reverseSyncTex"
        ? await this.navigation?.invoke(record.helperId, record.trustedProjection.sessionId, message.generation, message.method, message.payload)
        : interactionAction === undefined
        ? await this.#backend.invoke(record.canonicalKey, message.method, message.payload, {
        ...(message.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey }),
        payloadDigest,
        expectedDocumentGeneration: message.generation,
        ...(trustedDestinationSelection === undefined ? {} : {
          trustedDestinationSelection,
          expectedReviewRevision: message.revision,
          assertAuthority: () => {
            throwIfAborted(signal);
            if (this.#records.get(record.helperId) !== record || record.phase !== "active") {
              throw new Error("stale-native-window");
            }
          },
        }),
      }, signal)
        : await this.#backend.interaction?.(
            record.canonicalKey,
            record.interactionAttachment!,
            interactionAction,
            message.payload,
          ) ?? { status: "unauthorized" };
      throwIfAborted(signal);
      const payload = sanitizeNativeReviewRuntimeResponse(this.#host, message.method, result);
      if (payload === undefined) return this.#failure(message, "unavailable");
      const current = await this.#backend.current(record.canonicalKey, signal);
      throwIfAborted(signal);
      const projection = sanitizeNativeRuntimeProjection(this.#host, current);
      if (projection !== undefined) {
        record.trustedProjection = current;
        record.projection = projection;
        this.#rememberDocument(record, projection);
      }
      return { ...this.#envelope(message), type: "result", method: message.method, payload };
    } catch {
      return this.#failure(message, "unavailable");
    }
  }

  async #read(
    record: StagedRuntimeRecord,
    message: Extract<NativeReviewHelperMessage, { readonly type: "read-resource" }>,
    signal: AbortSignal,
    request: RequestRecord,
  ): Promise<NativeReviewHelperResponse> {
    const descriptor = record.documents.get(message.generation);
    if (message.resourceId !== record.resourceId || descriptor === undefined
      || message.offset + message.length > descriptor.byteLength) {
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
      const done = message.offset + bytes.byteLength >= descriptor.byteLength;
      return {
        ...this.#envelope(message),
        type: "resource-bytes",
        sequence: Math.floor(message.offset / NATIVE_HELPER_RESOURCE_CHUNK_BYTES),
        data: bytes.toString("base64"),
        done,
      };
    } catch {
      return this.#failure(message, "unavailable");
    } finally {
      releaseResource();
      if (request.releaseResource === releaseResource) request.releaseResource = undefined;
    }
  }

  #adoptResource(
    record: StagedRuntimeRecord,
    message: Extract<NativeReviewHelperMessage, { readonly type: "adopt-resource" }>,
  ): NativeReviewHelperResponse {
    const descriptor = record.documents.get(message.generation);
    if (message.resourceId !== record.resourceId || descriptor === undefined
      || descriptor.byteLength !== message.byteLength || descriptor.digest !== message.digest
      || message.generation < record.adoptedResourceGeneration) {
      return this.#failure(message, "stale");
    }
    record.adoptedResourceGeneration = message.generation;
    for (const generation of record.documents.keys()) {
      if (generation < message.generation) record.documents.delete(generation);
    }
    return { ...this.#envelope(message), type: "resource-adopted", generation: message.generation };
  }

  #rememberDocument(record: StagedRuntimeRecord, projection: NativeRuntimeProjection): void {
    record.documents.set(projection.generation, {
      byteLength: projection.document.byteLength,
      digest: projection.document.sha256,
    });
    while (record.documents.size > 3) {
      const oldest = [...record.documents.keys()]
        .find((generation) => generation !== record.adoptedResourceGeneration);
      if (oldest === undefined) break;
      record.documents.delete(oldest);
    }
  }

  #copyLink(
    record: StagedRuntimeRecord,
    message: Extract<NativeReviewHelperMessage, { readonly type: "copy-link" }>,
  ): NativeReviewHelperResponse {
    if (record.phase !== "active") return this.#failure(message, "invalid");
    const link = `${record.trustedProjection.canonicalLinkBase}#${encodePlacekeeperLinkFragment(message.location)}`;
    return { ...this.#envelope(message), type: "placekeeper-link", link };
  }

  async helperDied(helperId: string): Promise<void> {
    await this.detach(helperId);
  }

  /** App retirement keeps its activity reservation until accepted work settles.
   * Direct detach remains nonblocking for release requests and renderer failure. */
  async detachAndSettle(helperId: string): Promise<void> {
    const pending = [...(this.#pendingResultsByHelper.get(helperId) ?? [])];
    await this.detach(helperId);
    await Promise.allSettled(pending);
  }

  async detach(helperId: string): Promise<void> {
    this.navigation?.detach(helperId);
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
    if (record.phase !== "recovery" && record.taskLaunch !== undefined) this.#backend.nativeTaskLaunches?.detach(record.taskLaunch);
    if (record.phase === "active") {
      if (record.interactionAttachment !== undefined) {
        this.#backend.disconnectInteraction?.(record.canonicalKey, record.interactionAttachment);
      }
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
    this.#backend.nativeTaskLaunches?.close();
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

  #envelope(message: Pick<NativeReviewHelperMessage, "windowId" | "attemptId" | "requestId">) {
    return {
      protocolVersion: 1 as const,
      windowId: message.windowId,
      attemptId: message.attemptId,
      requestId: message.requestId,
    };
  }

  #failure(
    message: { readonly windowId: string; readonly attemptId: string; readonly requestId: string },
    code: Extract<NativeReviewHelperResponse, { readonly type: "failure" }>["code"],
  ): NativeReviewHelperResponse {
    return { ...this.#envelope(message), type: "failure", code };
  }
}
