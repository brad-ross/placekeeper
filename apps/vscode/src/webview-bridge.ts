import { ReviewExportConflictError, isReviewExportFence, isSaveDestinationConfirmation } from "../../../packages/core/src/review-runtime-protocol.js";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import {
  REVIEW_RUNTIME_PROTOCOL,
  REVIEW_RUNTIME_VERSION,
  isReviewRuntimeMethodForHost,
  type ReviewRuntimeBrokerMethod,
  type ReviewRuntimeInvokeMethod,
  type ReviewRuntimeMethod,
} from "../../../packages/core/src/review-runtime-protocol.js";

const SAFE_ID = /^[A-Za-z0-9_-]{16,128}$/u;
const MAX_MESSAGE_BYTES = 65_536;

export interface WebviewRpcIdentity {
  readonly panelId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly revision: number;
}

export interface WebviewRpcRequest {
  readonly protocol: typeof REVIEW_RUNTIME_PROTOCOL;
  readonly version: typeof REVIEW_RUNTIME_VERSION;
  readonly kind: "request";
  readonly panelId: string;
  readonly requestId: string;
  readonly sessionId?: string;
  readonly generation?: number;
  readonly revision?: number;
  readonly method: ReviewRuntimeMethod;
  readonly payload: unknown;
}

export interface ForwardSyncTexTarget {
  readonly documentGeneration: number;
  readonly pageIndex: number;
  readonly point: { readonly x: number; readonly y: number };
}

const FORWARD_SYNC_TEX_STATUS_VALUES = [
  "ok", "missing", "pending", "stale", "ambiguous", "out-of-root",
  "unavailable-tool", "timeout", "oversized", "malformed", "failed",
] as const;

export type ForwardSyncTexStatus = typeof FORWARD_SYNC_TEX_STATUS_VALUES[number];

const FORWARD_SYNC_TEX_STATUSES = new Set<string>(FORWARD_SYNC_TEX_STATUS_VALUES);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRuntimeRequestFailure(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  if (/^Trusted broker request failed \([1-5][0-9]{2}\)$/u.test(error.message) ||
    error.message === "Source navigation is unavailable in this workspace") return error.message;
  return error.name;
}

export function forwardSyncTexTarget(value: unknown): ForwardSyncTexTarget | undefined {
  if (!isObject(value) || value.status !== "ok" ||
    !Number.isSafeInteger(value.documentGeneration) || (value.documentGeneration as number) < 0 ||
    !isObject(value.target) ||
    !Number.isSafeInteger(value.target.pageIndex) || (value.target.pageIndex as number) < 0 ||
    !Number.isFinite(value.target.x) || !Number.isFinite(value.target.y)) return undefined;
  return {
    documentGeneration: value.documentGeneration as number,
    pageIndex: value.target.pageIndex as number,
    point: { x: value.target.x as number, y: value.target.y as number },
  };
}

export function forwardSyncTexRetryable(value: unknown): boolean {
  return isObject(value) && (value.status === "pending" || value.status === "stale");
}

export function forwardSyncTexStatus(value: unknown): ForwardSyncTexStatus | undefined {
  if (!isObject(value) || typeof value.status !== "string") return undefined;
  if (value.status === "ok" && forwardSyncTexTarget(value) === undefined) return undefined;
  return FORWARD_SYNC_TEX_STATUSES.has(value.status)
    ? value.status as ForwardSyncTexStatus
    : undefined;
}

function bounded(value: unknown): boolean {
  try { return Buffer.byteLength(JSON.stringify(value)) <= MAX_MESSAGE_BYTES; }
  catch { return false; }
}

function containsCapabilityPrimitive(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (Array.isArray(value)) return value.some((item) => containsCapabilityPrimitive(item, depth + 1));
  if (!isObject(value)) return false;
  const forbidden = /^(?:url|uri|path|credential|authorization|headers|executable|commandId)$/iu;
  return Object.entries(value).some(([key, item]) => (
    forbidden.test(key) || containsCapabilityPrimitive(item, depth + 1)
  ));
}

function validPayload(method: ReviewRuntimeMethod, payload: unknown): boolean {
  if (!isObject(payload) || containsCapabilityPrimitive(payload)) return false;
  const keys = Object.keys(payload);
  if (["bootstrap", "presence", "detach", "saveStatus", "saveProposal", "chooseFolder",
    "retrySave", "locateSave", "scope", "forwardSyncTex"].includes(method)) {
    return keys.length === 0;
  }
  if (method === "chooseOriginal") {
    return keys.every((key) => key === "confirmation") &&
      (payload.confirmation === undefined || isSaveDestinationConfirmation(payload.confirmation));
  }
  if (method === "chooseCopy") {
    return keys.every((key) => key === "filename" || key === "folderSelectionId" || key === "confirmation") &&
      (payload.confirmation === undefined || isSaveDestinationConfirmation(payload.confirmation)) &&
      (payload.filename === undefined || (typeof payload.filename === "string" && payload.filename.length <= 255)) &&
      (payload.folderSelectionId === undefined || (typeof payload.folderSelectionId === "string" && SAFE_ID.test(payload.folderSelectionId)));
  }
  if (method === "exportReviewedCopy") {
    return keys.length <= 2 && keys.every((key) => key === "confirmPossiblyStale" || key === "fence") &&
      (payload.fence === undefined || isReviewExportFence(payload.fence)) &&
      (payload.confirmPossiblyStale === undefined || payload.confirmPossiblyStale === true);
  }
  if (method === "reverseSyncTex") {
    return keys.length === 2 && Number.isSafeInteger(payload.pageIndex) && (payload.pageIndex as number) >= 0 &&
      isObject(payload.point) && Object.keys(payload.point).length === 2 &&
      Number.isFinite(payload.point.x) && Number.isFinite(payload.point.y);
  }
  return method === "command";
}

export function parseWebviewRequest(
  value: unknown,
  expected: WebviewRpcIdentity,
  replayedRequestIds: ReadonlySet<string>,
): WebviewRpcRequest | undefined {
  if (!isObject(value) || !bounded(value) || value.protocol !== REVIEW_RUNTIME_PROTOCOL ||
    value.version !== REVIEW_RUNTIME_VERSION || value.kind !== "request" ||
    value.panelId !== expected.panelId || typeof value.requestId !== "string" ||
    !SAFE_ID.test(value.requestId) || replayedRequestIds.has(value.requestId) ||
    !isReviewRuntimeMethodForHost("vscode", value.method) || !("payload" in value) ||
    !validPayload(value.method, value.payload)) return undefined;
  if (value.method !== "bootstrap" && (
    value.sessionId !== expected.sessionId || value.generation !== expected.generation || value.revision !== expected.revision
  )) return undefined;
  if (value.method === "bootstrap" && (
    value.sessionId !== undefined || value.generation !== undefined || value.revision !== undefined
  )) return undefined;
  return value as unknown as WebviewRpcRequest;
}

export function parseWebviewCancel(
  value: unknown,
  expectedPanelId: string,
): { readonly requestId: string } | undefined {
  if (!isObject(value) || !bounded(value) || value.protocol !== REVIEW_RUNTIME_PROTOCOL ||
    value.version !== REVIEW_RUNTIME_VERSION || value.kind !== "cancel" ||
    value.panelId !== expectedPanelId || typeof value.requestId !== "string" || !SAFE_ID.test(value.requestId)) return undefined;
  return { requestId: value.requestId };
}

export interface TrustedRuntimeClient {
  readonly identity: WebviewRpcIdentity;
  bootstrap(signal: AbortSignal): Promise<unknown>;
  invoke(method: ReviewRuntimeInvokeMethod, payload: unknown, signal: AbortSignal): Promise<unknown>;
  subscribeInvalidations?(listener: (payload: unknown) => void): () => void;
  dispose(): void;
}

export class VersionedWebviewBridge {
  readonly #client: TrustedRuntimeClient;
  readonly #postMessage: (message: unknown) => unknown;
  readonly #seen = new Set<string>();
  readonly #active = new Map<string, AbortController>();
  readonly #unsubscribeInvalidations: () => void;
  #disposed = false;

  constructor(client: TrustedRuntimeClient, postMessage: (message: unknown) => unknown) {
    this.#client = client;
    this.#postMessage = postMessage;
    this.#unsubscribeInvalidations = client.subscribeInvalidations?.((payload) => {
      this.#postMessage({
        protocol: REVIEW_RUNTIME_PROTOCOL,
        version: REVIEW_RUNTIME_VERSION,
        kind: "event",
        event: "session-invalidated",
        panelId: this.#client.identity.panelId,
        payload,
      });
    }) ?? (() => undefined);
  }

  async receive(value: unknown): Promise<void> {
    if (this.#disposed) return;
    if (isObject(value) && bounded(value) && value.protocol === REVIEW_RUNTIME_PROTOCOL &&
      value.panelId === this.#client.identity.panelId && value.kind === "request" &&
      Number.isSafeInteger(value.version) && value.version !== REVIEW_RUNTIME_VERSION &&
      typeof value.requestId === "string" && SAFE_ID.test(value.requestId)) {
      this.#postMessage({ protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION,
        kind: "response", panelId: this.#client.identity.panelId, requestId: value.requestId,
        ok: false, error: { kind: "runtime-version-mismatch" } });
      return;
    }
    const cancelled = parseWebviewCancel(value, this.#client.identity.panelId);
    if (cancelled !== undefined) { this.#active.get(cancelled.requestId)?.abort(); return; }
    const request = parseWebviewRequest(value, this.#client.identity, this.#seen);
    if (request === undefined) return;
    this.#seen.add(request.requestId);
    if (this.#seen.size > 512) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    const controller = new AbortController();
    this.#active.set(request.requestId, controller);
    const requestIdentity = request.method === "bootstrap"
      ? undefined
      : {
          panelId: request.panelId,
          sessionId: request.sessionId!,
          generation: request.generation!,
          revision: request.revision!,
        };
    try {
      const payload = request.method === "bootstrap"
        ? await this.#client.bootstrap(controller.signal)
        : await this.#client.invoke(request.method, request.payload, controller.signal);
      if (controller.signal.aborted) return;
      this.#postMessage({
        protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION, kind: "response",
        ...(requestIdentity ?? this.#client.identity), requestId: request.requestId, ok: true, payload,
      });
    } catch (error) {
      console.error(
        `[Placekeeper] trusted runtime request failed: ${request.method} (${safeRuntimeRequestFailure(error)})`,
      );
      if (!controller.signal.aborted) this.#postMessage({
        protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION, kind: "response",
        ...(requestIdentity ?? this.#client.identity), requestId: request.requestId, ok: false,
        error: { kind: error instanceof ReviewExportConflictError ? "export-conflict" : "rejected" },
      });
    } finally { this.#active.delete(request.requestId); }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeInvalidations();
    for (const controller of this.#active.values()) controller.abort();
    this.#active.clear();
    this.#client.dispose();
  }
}

export interface LoopbackRuntimeClientOptions {
  readonly panelId: string;
  readonly launch: {
    readonly origin: string;
    readonly sessionId: string;
    readonly credential: string;
  };
  readonly assets: {
    readonly pdfiumWasm: string;
    readonly worker?: string;
  };
  readonly materializeDocument: (input: {
    readonly bytes: Uint8Array;
    readonly digest: string;
    readonly byteLength: number;
    readonly generation: number;
  }) => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly forwardSourceLocation?: () => {
    readonly sourcePath: string;
    readonly line: number;
    readonly column?: number;
  } | undefined;
  readonly sourceNavigationAllowed?: () => boolean;
  readonly openSourceLocation?: (location: {
    readonly sourcePath: string;
    readonly line: number;
    readonly column?: number;
  }) => Promise<void>;
}

function safeScope(value: unknown): unknown {
  if (!isObject(value)) return value;
  const { sourceRootPath: _sourceRootPath, ...safe } = value;
  return safe;
}

function safeState(value: unknown): unknown {
  if (!isObject(value)) return value;
  const { sourceRootId: _sourceRootId, ...safe } = value;
  return safe;
}

function safeSaveStatus(value: unknown): unknown {
  if (!isObject(value) || !isObject(value.destination) || value.destination.phase !== "active") return value;
  const { targetPath: _targetPath, capabilityId: _capabilityId, fingerprint: _fingerprint, ...destination } = value.destination;
  return { ...value, destination: { ...destination, targetPath: "Reviewed PDF" } };
}

function safeResult(method: ReviewRuntimeBrokerMethod, value: unknown): unknown {
  switch (method) {
    case "scope":
      return safeScope(value);
    case "saveStatus":
    case "chooseCopy":
    case "chooseOriginal": {
      const status = safeSaveStatus(value);
      if (!isObject(value) || value.nameResult === undefined || !isObject(status)) return status;
      const named = value.nameResult;
      return { ...status, nameResult: isObject(named) && named.accepted === false
        ? { ...named, state: safeState(named.state) } : safeState(named) };
    }

    case "retrySave":
    case "locateSave":
      return safeSaveStatus(value);
    case "saveProposal":
      return isObject(value) ? { ...value, folder: "Local folder" } : value;
    case "chooseFolder": {
      if (!isObject(value)) return value;
      const { folder: _folder, ...safe } = value;
      return safe;
    }
    case "exportReviewedCopy":
      return isObject(value) ? { ...value, path: "Reviewed PDF" } : value;
    case "command":
    case "forwardSyncTex":
    case "reverseSyncTex":
      return value;
    default:
      return method satisfies never;
  }
}

export function createLoopbackRuntimeClient(options: LoopbackRuntimeClientOptions): TrustedRuntimeClient {
  const fetchImpl = options.fetch ?? fetch;
  const identity: { panelId: string; sessionId: string; generation: number; revision: number } = {
    panelId: options.panelId,
    sessionId: options.launch.sessionId,
    generation: 0,
    revision: 0,
  };
  const invalidationListeners = new Set<(payload: unknown) => void>();
  let socket: WebSocket | undefined;
  let socketRetry: ReturnType<typeof setTimeout> | undefined;
  let socketRetryDelayMs = 1_000;
  let observedFreshness: string | undefined;
  let disposed = false;
  const request = async (
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
    acceptedStatuses: readonly number[] = [],
  ): Promise<Response> => {
    const response = await fetchImpl(`${options.launch.origin}/s/${options.launch.sessionId}${path}`, {
      ...init,
      ...(signal === undefined ? {} : { signal }),
      headers: {
        ...init.headers,
        authorization: `Bearer ${options.launch.credential}`,
        origin: options.launch.origin,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
    });
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      if (path === "/export" && response.status === 409) {
        const rejected = await response.json().catch(() => undefined) as { error?: { kind?: string } } | undefined;
        if (rejected?.error?.kind === "export-conflict") throw new ReviewExportConflictError();
      }
      throw new Error(`Trusted broker request failed (${response.status})`);
    }
    return response;
  };
  const json = async (path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> => {
    const response = await request(path, init, signal);
    const text = await response.text();
    if (Buffer.byteLength(text) > 1_048_576) throw new Error("Trusted broker response exceeded the limit");
    return JSON.parse(text) as unknown;
  };
  const post = (path: string, payload: unknown, signal: AbortSignal) => json(path, {
    method: "POST", body: JSON.stringify(payload),
  }, signal);
  const routes = {
    scope: { method: "GET", path: "/scope" },
    saveStatus: { method: "GET", path: "/save/status" },
    saveProposal: { method: "GET", path: "/save/proposal" },
    command: { method: "POST", path: "/commands" },
    chooseCopy: { method: "POST", path: "/save/copy" },
    chooseFolder: { method: "POST", path: "/save/folder" },
    chooseOriginal: { method: "POST", path: "/save/original" },
    retrySave: { method: "POST", path: "/save/retry" },
    locateSave: { method: "POST", path: "/save/locate" },
    forwardSyncTex: { method: "POST", path: "/synctex/forward" },
    reverseSyncTex: { method: "POST", path: "/synctex/reverse" },
    exportReviewedCopy: { method: "POST", path: "/export" },
  } satisfies Readonly<Record<ReviewRuntimeBrokerMethod, {
    readonly method: "GET" | "POST";
    readonly path: string;
  }>>;
  const client: TrustedRuntimeClient = {
    get identity() { return identity; },
    async bootstrap(signal) {
      const [stateValue, scopeValue, saveStatus] = await Promise.all([
        json("/state", {}, signal), json("/scope", {}, signal), json("/save/status", {}, signal),
      ]);
      if (!isObject(stateValue) || !isObject(stateValue.source) || !isObject(stateValue.workflow) ||
        typeof stateValue.source.fileId !== "string" || typeof stateValue.source.digest !== "string" ||
        !Number.isSafeInteger(stateValue.source.byteLength) ||
        !Number.isSafeInteger(stateValue.workflow.documentGeneration) || !Number.isSafeInteger(stateValue.revision)) {
        throw new Error("Trusted broker state was invalid");
      }
      const generation = stateValue.workflow.documentGeneration as number;
      const document = await request(
        `/document/${stateValue.source.fileId}?generation=${generation}`,
        {},
        signal,
      );
      const bytes = new Uint8Array(await document.arrayBuffer());
      const documentUri = await options.materializeDocument({
        bytes,
        digest: stateValue.source.digest,
        byteLength: stateValue.source.byteLength as number,
        generation,
      });
      identity.generation = generation;
      identity.revision = stateValue.revision as number;
      observedFreshness = typeof stateValue.workflow.freshness === "string"
        ? stateValue.workflow.freshness
        : undefined;
      const bootstrap = {
        sessionId: identity.sessionId,
        generation: identity.generation,
        revision: identity.revision,
        state: safeState(stateValue),
        scope: safeScope(scopeValue),
        saveStatus: safeSaveStatus(saveStatus),
        resources: {
          document: documentUri,
          pdfiumWasm: options.assets.pdfiumWasm,
          ...(options.assets.worker === undefined ? {} : { worker: options.assets.worker }),
        },
      };
      connectInvalidations();
      return bootstrap;
    },
    async invoke(method, payload, signal) {
      if (method === "presence") { connectInvalidations(); return {}; }
      if (method === "detach") return {};
      const route = routes[method];
      if (route === undefined) throw new Error("Runtime method is not allowlisted");
      let trustedPayload = payload;
      if (method === "forwardSyncTex") {
        const location = options.forwardSourceLocation?.();
        if (location === undefined) throw new Error("An active local LaTeX source location is required");
        trustedPayload = {
          ...location,
          operationToken: randomBytes(18).toString("base64url"),
        };
      } else if (method === "reverseSyncTex") {
        if (options.sourceNavigationAllowed?.() === false) {
          return { status: "failed", reason: "workspace-untrusted" };
        }
        trustedPayload = {
          ...(isObject(payload) ? payload : {}),
          operationToken: randomBytes(18).toString("base64url"),
        };
      }
      let value: unknown;
      if (method === "command") {
        const response = await request(route.path, {
          method: "POST",
          body: JSON.stringify(trustedPayload),
          headers: { "x-placekeeper-generation": String(identity.generation) },
        }, signal, [409]);
        const responseText = await response.text();
        if (Buffer.byteLength(responseText) > 1_048_576) {
          throw new Error("Trusted broker response exceeded the limit");
        }
        const responseValue = JSON.parse(responseText) as unknown;
        if (response.status === 409) {
          const currentState = await json("/state", {}, signal);
          const generationConflict = isObject(responseValue) && responseValue.ok === false &&
            isObject(responseValue.error) && responseValue.error.kind === "generation-conflict";
          value = {
            accepted: false,
            state: safeState(currentState),
            message: generationConflict
              ? "The PDF was rebuilt before this command could be applied. Review the current generation and retry explicitly."
              : "Another review window changed this draft. Review the current revision and retry explicitly.",
            ...(generationConflict ? { reason: "generation-conflict" } : {}),
          };
        } else {
          value = responseValue;
        }
      } else {
        value = route.method === "GET"
          ? await json(route.path, {}, signal)
          : await post(route.path, trustedPayload, signal);
      }
      if (method === "reverseSyncTex" && isObject(value) && value.status === "ok" &&
        isObject(value.target) && typeof value.target.path === "string" &&
        Number.isSafeInteger(value.target.line)) {
        const target = value.target;
        const sourcePath = target.path as string;
        await options.openSourceLocation?.({
          sourcePath,
          line: target.line as number,
          ...(Number.isSafeInteger(target.column) ? { column: target.column as number } : {}),
        });
        const { path: _path, ...safeTarget } = target;
        return { ...value, target: safeTarget };
      }
      if (["command", "chooseCopy", "chooseOriginal"].includes(method) && isObject(value)) {
        const named = method === "command" ? value : value.nameResult;
        const state = isObject(named) && named.accepted === false ? named.state : named;
        if (isObject(state) && isObject(state.workflow) &&
          Number.isSafeInteger(state.workflow.documentGeneration) &&
          Number.isSafeInteger(state.revision)) {
          identity.generation = state.workflow.documentGeneration as number;
          identity.revision = state.revision as number;
        }
      }
      return safeResult(method, value);
    },
    subscribeInvalidations(listener) {
      invalidationListeners.add(listener);
      return () => invalidationListeners.delete(listener);
    },
    dispose() {
      disposed = true;
      if (socketRetry !== undefined) clearTimeout(socketRetry);
      socket?.close();
      socket = undefined;
      invalidationListeners.clear();
    },
  };
  async function reconcileInvalidations(): Promise<void> {
    try {
      const value = await json("/state");
      if (!isObject(value) || !isObject(value.workflow) ||
        !Number.isSafeInteger(value.workflow.documentGeneration) ||
        !Number.isSafeInteger(value.revision)) return;
      const generation = value.workflow.documentGeneration as number;
      const revision = value.revision as number;
      const freshness = typeof value.workflow.freshness === "string"
        ? value.workflow.freshness
        : undefined;
      if (generation === identity.generation && revision === identity.revision &&
        freshness === observedFreshness) return;
      const payload = {
        sessionId: identity.sessionId,
        generation,
        revision,
        reason: generation !== identity.generation
          ? "generation"
          : revision !== identity.revision ? "revision" : "freshness",
        ...(generation === identity.generation
          ? {}
          : { previousGeneration: identity.generation }),
      };
      for (const listener of invalidationListeners) listener(payload);
    } catch {
      // A later control reconnect or explicit bootstrap will retry canonical state.
    }
  }
  function connectInvalidations(): void {
    if (disposed || socket !== undefined) return;
    const controlUrl = new URL(`/s/${options.launch.sessionId}/control`, options.launch.origin);
    controlUrl.protocol = controlUrl.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(controlUrl, [
      "placekeeper",
      `placekeeper-auth.${options.launch.credential}`,
    ]);
    socket.addEventListener("open", () => {
      socketRetryDelayMs = 1_000;
      void reconcileInvalidations();
    });
    socket.addEventListener("message", (event) => {
      try {
        const value: unknown = JSON.parse(String(event.data));
        if (!isObject(value)) return;
        const successor = value.kind === "document-successor" &&
          Number.isSafeInteger(value.previousGeneration) &&
          Number.isSafeInteger(value.documentGeneration) &&
          Number.isSafeInteger(value.reviewRevision);
        const sameGeneration = value.kind === "session-invalidated" &&
          Number.isSafeInteger(value.documentGeneration) &&
          Number.isSafeInteger(value.reviewRevision) &&
          (value.reason === "revision" || value.reason === "freshness");
        if (!successor && !sameGeneration) return;
        const payload = {
          sessionId: identity.sessionId,
          generation: value.documentGeneration as number,
          revision: value.reviewRevision as number,
          reason: successor ? "generation" : value.reason,
          ...(successor ? { previousGeneration: value.previousGeneration } : {}),
        };
        for (const listener of invalidationListeners) listener(payload);
      } catch {
        // The next ready/resubscribe handshake replays current state.
      }
    });
    socket.addEventListener("error", () => {
      // The close event owns reconnect scheduling; errors must not escape the host.
    });
    socket.addEventListener("close", () => {
      socket = undefined;
      if (!disposed) {
        socketRetry = setTimeout(connectInvalidations, socketRetryDelayMs);
        socketRetryDelayMs = Math.min(socketRetryDelayMs * 2, 30_000);
      }
    });
  }
  return client;
}
