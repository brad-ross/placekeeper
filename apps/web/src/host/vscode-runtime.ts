import type { ReviewCommand, ReviewState } from "../../../../packages/core/src/review-model.js";
import type { PlacekeeperLinkLocation } from "../../../../packages/core/src/placekeeper-link.js";
import {
  REVIEW_RUNTIME_PROTOCOL,
  REVIEW_RUNTIME_VERSION,
  isReviewRuntimeMethodForHost,
  sanitizeChromeReviewRuntimeRequest,
  sanitizeChromeReviewRuntimeResponse,
  type ReviewRuntimeHost,
  type ReviewRuntimeMethod,
} from "../../../../packages/core/src/review-runtime-protocol.js";
import type {
  ProductionExportResult,
  ProductionSaveStatus,
  ProductionScope,
  SaveCopyProposal,
} from "../app/ProductionReviewApp.js";
import type { RejectedReviewCommand } from "../app/ReviewShell.js";
import {
  type HostRuntime,
  type HostRuntimeBootstrap,
  type HostRuntimeCommand,
  type HostRuntimeIdentity,
  type HostRuntimeInvalidation,
} from "./runtime.js";
import { MemoryReviewLocationHistory } from "../review/review-location-history.js";

const ID = /^[A-Za-z0-9_-]{16,128}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface VscodeMessagePort {
  postMessage(message: unknown): unknown;
  subscribe(listener: (message: unknown) => void): () => void;
}

export interface MaterializedViewerResource {
  readonly url: string;
  dispose(): void;
}

export interface RpcHostRuntimeOptions {
  readonly host?: ReviewRuntimeHost;
  readonly extensionOrigin?: string;
  readonly materializePdfiumWasm?: (sourceUrl: string) => Promise<MaterializedViewerResource>;
  readonly materializePdfiumWorker?: (sourceUrl: string) => Promise<MaterializedViewerResource>;
}

const MAX_PDFIUM_WASM_BYTES = 16 * 1024 * 1024;
const MAX_PDFIUM_WORKER_BYTES = 4 * 1024 * 1024;

export async function materializeVscodeWasmResource(
  sourceUrl: string,
  environment: {
    readonly fetch?: typeof fetch;
    readonly createObjectURL?: (blob: Blob) => string;
    readonly revokeObjectURL?: (url: string) => void;
  } = {},
): Promise<MaterializedViewerResource> {
  const fetchImpl = environment.fetch ?? fetch;
  const response = await fetchImpl(sourceUrl, { credentials: "omit" });
  if (!response.ok) throw new Error("The packaged PDF engine could not be loaded.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PDFIUM_WASM_BYTES ||
    bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("The packaged PDF engine was invalid.");
  }
  const createObjectURL = environment.createObjectURL ?? URL.createObjectURL.bind(URL);
  const revokeObjectURL = environment.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);
  const url = createObjectURL(new Blob([bytes], { type: "application/wasm" }));
  return { url, dispose: () => revokeObjectURL(url) };
}

export async function materializeVscodeWorkerResource(
  sourceUrl: string,
  environment: {
    readonly fetch?: typeof fetch;
    readonly createObjectURL?: (blob: Blob) => string;
    readonly revokeObjectURL?: (url: string) => void;
  } = {},
): Promise<MaterializedViewerResource> {
  const fetchImpl = environment.fetch ?? fetch;
  const response = await fetchImpl(sourceUrl, { credentials: "omit" });
  if (!response.ok) throw new Error("The packaged PDF worker could not be loaded.");
  const source = await response.text();
  if (source.length === 0 || new TextEncoder().encode(source).byteLength > MAX_PDFIUM_WORKER_BYTES ||
    !source.includes("class PdfiumEngineRunner") || !source.includes('type === "wasmInit"')) {
    throw new Error("The packaged PDF worker was invalid.");
  }
  const createObjectURL = environment.createObjectURL ?? URL.createObjectURL.bind(URL);
  const revokeObjectURL = environment.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);
  const url = createObjectURL(new Blob([source], { type: "application/javascript" }));
  return { url, dispose: () => revokeObjectURL(url) };
}

interface PendingRequest {
  readonly method: ReviewRuntimeMethod;
  readonly identity?: HostRuntimeIdentity;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly abort?: () => void;
}

function requestId(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "_");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIdentity(value: unknown): value is HostRuntimeIdentity {
  return isObject(value) && typeof value.sessionId === "string" && UUID.test(value.sessionId) &&
    Number.isSafeInteger(value.generation) && (value.generation as number) >= 0 &&
    Number.isSafeInteger(value.revision) && (value.revision as number) >= 0;
}

function validHostCommand(value: unknown): value is HostRuntimeCommand {
  if (!isObject(value) || typeof value.command !== "string") return false;
  if (value.command === "reattach" || value.command === "reverse-synctex") {
    return Object.keys(value).length === 1;
  }
  return value.command === "forward-synctex" && Object.keys(value).length === 4 &&
    Number.isSafeInteger(value.documentGeneration) && (value.documentGeneration as number) >= 0 &&
    Number.isSafeInteger(value.pageIndex) && (value.pageIndex as number) >= 0 &&
    isObject(value.point) && Object.keys(value.point).length === 2 &&
    Number.isFinite(value.point.x) && Number.isFinite(value.point.y);
}

function abortError(): Error {
  return new DOMException("The runtime request was cancelled.", "AbortError");
}

export function createRpcHostRuntime(
  port: VscodeMessagePort & (
    | { readonly panelId: string; readonly runtimeId?: never }
    | { readonly runtimeId: string; readonly panelId?: never }
  ),
  options: RpcHostRuntimeOptions = {},
): HostRuntime {
  const host = options.host ?? "vscode";
  const runtimeId = "runtimeId" in port && port.runtimeId !== undefined ? port.runtimeId : port.panelId;
  if (!ID.test(runtimeId)) throw new Error("A safe runtime identity is required.");
  if (host === "chrome" && options.extensionOrigin === undefined) {
    throw new Error("A Chrome extension origin is required.");
  }
  const envelopeIdentity = host === "chrome" ? { runtimeId } : { panelId: runtimeId };
  const pending = new Map<string, PendingRequest>();
  const invalidations = new Set<(event: HostRuntimeInvalidation) => void>();
  const hostCommands = new Set<(command: HostRuntimeCommand) => void>();
  let identity: HostRuntimeIdentity | undefined;
  let pendingInvalidation: HostRuntimeInvalidation | undefined;
  let deferredCommandInvalidation: HostRuntimeInvalidation | undefined;
  let pendingHostCommand: HostRuntimeCommand | undefined;
  let disposed = false;
  let chromeLocationHistory: MemoryReviewLocationHistory | undefined;
  const materializedPdfium = new Map<string, Promise<MaterializedViewerResource>>();
  const materializedWorkers = new Map<string, Promise<MaterializedViewerResource>>();

  const pdfiumResource = async (sourceUrl: string): Promise<MaterializedViewerResource> => {
    if (options.materializePdfiumWasm === undefined) return { url: sourceUrl, dispose() {} };
    let pending = materializedPdfium.get(sourceUrl);
    if (pending === undefined) {
      pending = options.materializePdfiumWasm(sourceUrl);
      materializedPdfium.set(sourceUrl, pending);
    }
    const resource = await pending;
    if (disposed) {
      resource.dispose();
      throw new Error("The review runtime is disposed.");
    }
    return resource;
  };

  const workerResource = async (sourceUrl: string): Promise<MaterializedViewerResource> => {
    if (options.materializePdfiumWorker === undefined) return { url: sourceUrl, dispose() {} };
    let pending = materializedWorkers.get(sourceUrl);
    if (pending === undefined) {
      pending = options.materializePdfiumWorker(sourceUrl);
      materializedWorkers.set(sourceUrl, pending);
    }
    const resource = await pending;
    if (disposed) {
      resource.dispose();
      throw new Error("The review runtime is disposed.");
    }
    return resource;
  };

  const publishInvalidation = (event: HostRuntimeInvalidation) => {
    if (invalidations.size === 0) pendingInvalidation = event;
    else for (const listener of invalidations) listener(event);
  };

  const revisionAlreadyObserved = (event: HostRuntimeInvalidation) => (
    event.reason === "revision"
    && identity !== undefined
    && event.sessionId === identity.sessionId
    && event.generation === identity.generation
    && event.revision <= identity.revision
  );

  const releaseDeferredCommandInvalidation = () => {
    if (
      deferredCommandInvalidation === undefined
      || [...pending.values()].some((request) => request.method === "command")
    ) return;
    const deferred = deferredCommandInvalidation;
    deferredCommandInvalidation = undefined;
    if (!revisionAlreadyObserved(deferred)) publishInvalidation(deferred);
  };

  const unsubscribe = port.subscribe((message) => {
    if (!isObject(message) || message.protocol !== REVIEW_RUNTIME_PROTOCOL ||
      message.version !== REVIEW_RUNTIME_VERSION ||
      (host === "chrome" ? message.runtimeId !== runtimeId : message.panelId !== runtimeId)) return;
    if (message.kind === "event" && message.event === "host-command") {
      if (host !== "vscode" || !validHostCommand(message.payload)) return;
      if (hostCommands.size === 0) pendingHostCommand = message.payload;
      else for (const listener of hostCommands) listener(message.payload);
      return;
    }
    if (message.kind === "event" && message.event === "session-invalidated") {
      if (!validIdentity(message.payload) || !isObject(message.payload) ||
        (message.payload.reason !== "generation" && message.payload.reason !== "revision" &&
          message.payload.reason !== "freshness") ||
        (message.payload.previousGeneration !== undefined &&
          !Number.isSafeInteger(message.payload.previousGeneration))) return;
      const event: HostRuntimeInvalidation = {
        sessionId: message.payload.sessionId,
        generation: message.payload.generation,
        revision: message.payload.revision,
        reason: message.payload.reason,
        ...(message.payload.previousGeneration === undefined
          ? {}
          : { previousGeneration: message.payload.previousGeneration as number }),
      };
      if (revisionAlreadyObserved(event)) return;
      if (
        event.reason === "revision"
        && [...pending.values()].some((request) => request.method === "command")
      ) {
        if (
          deferredCommandInvalidation === undefined
          || event.generation > deferredCommandInvalidation.generation
          || (event.generation === deferredCommandInvalidation.generation
            && event.revision > deferredCommandInvalidation.revision)
        ) deferredCommandInvalidation = event;
        return;
      }
      publishInvalidation(event);
      return;
    }
    if (message.kind !== "response" || typeof message.requestId !== "string") return;
    const current = pending.get(message.requestId);
    if (current === undefined) return;
    if (!validIdentity(message)) return;
    if (current.method === "bootstrap") {
      if (!isObject(message.payload) || message.payload.sessionId !== message.sessionId ||
        message.payload.generation !== message.generation || message.payload.revision !== message.revision) return;
    } else if (current.identity === undefined || message.sessionId !== current.identity.sessionId ||
      message.generation !== current.identity.generation || message.revision !== current.identity.revision) return;
    pending.delete(message.requestId);
    current.abort?.();
    if (message.ok === true) {
      const payload = host === "chrome"
        ? sanitizeChromeReviewRuntimeResponse(current.method, message.payload)
        : message.payload;
      if (payload === undefined) current.reject(new Error("The trusted host returned an invalid response."));
      else current.resolve(payload);
    } else current.reject(new Error("The trusted host rejected the review action."));
  });

  const invoke = <T>(method: ReviewRuntimeMethod, payload: unknown = {}, signal?: AbortSignal): Promise<T> => {
    if (disposed) return Promise.reject(new Error("The review runtime is disposed."));
    if (!isReviewRuntimeMethodForHost(host, method)) {
      return Promise.reject(new Error(`The ${method} capability is unavailable in ${host === "chrome" ? "Chrome" : "this host"}.`));
    }
    const outboundPayload = host === "chrome"
      ? sanitizeChromeReviewRuntimeRequest(method, payload)
      : payload;
    if (outboundPayload === undefined) {
      return Promise.reject(new Error("The review runtime request was invalid."));
    }
    if (signal?.aborted === true) return Promise.reject(abortError());
    const id = requestId();
    const requestIdentity = method === "bootstrap" || identity === undefined
      ? undefined
      : { ...identity };
    return new Promise<T>((resolve, reject) => {
      const onAbort = signal === undefined ? undefined : () => {
        if (!pending.delete(id)) return;
        port.postMessage({
          protocol: REVIEW_RUNTIME_PROTOCOL,
          version: REVIEW_RUNTIME_VERSION,
          kind: "cancel",
          ...envelopeIdentity,
          requestId: id,
        });
        reject(abortError());
      };
      if (onAbort !== undefined) signal!.addEventListener("abort", onAbort, { once: true });
      pending.set(id, {
        method,
        ...(requestIdentity === undefined ? {} : { identity: requestIdentity }),
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(onAbort === undefined ? {} : { abort: () => signal!.removeEventListener("abort", onAbort) }),
      });
      port.postMessage({
        protocol: REVIEW_RUNTIME_PROTOCOL,
        version: REVIEW_RUNTIME_VERSION,
        kind: "request",
        ...envelopeIdentity,
        requestId: id,
        ...(requestIdentity === undefined ? {} : requestIdentity),
        method,
        payload: outboundPayload,
      });
    });
  };

  const updateIdentityFromState = (value: unknown): HostRuntimeInvalidation | undefined => {
    if (identity === undefined || !isObject(value)) return;
    const state = value.accepted === false ? value.state : value;
    if (!isObject(state) || !isObject(state.workflow) ||
      !Number.isSafeInteger(state.workflow.documentGeneration) ||
      !Number.isSafeInteger(state.revision)) return;
    const previous = identity;
    identity = {
      ...identity,
      generation: state.workflow.documentGeneration as number,
      revision: state.revision as number,
    };
    if (value.accepted !== false || identity.generation === previous.generation) return;
    return {
      sessionId: identity.sessionId,
      generation: identity.generation,
      revision: identity.revision,
      reason: "generation",
      previousGeneration: previous.generation,
    };
  };

  return {
    host,
    async bootstrap(signal?: AbortSignal): Promise<HostRuntimeBootstrap> {
      const value = await invoke<Record<string, unknown>>("bootstrap", {}, signal);
      if (!validIdentity(value) || !isObject(value.state) || !isObject(value.scope) ||
        !isObject(value.saveStatus) || !isObject(value.resources) ||
        typeof value.resources.document !== "string" ||
        typeof value.resources.pdfiumWasm !== "string") {
        throw new Error("The trusted host returned an invalid bootstrap.");
      }
      identity = {
        sessionId: value.sessionId,
        generation: value.generation,
        revision: value.revision,
      };
      const [pdfium, worker] = await Promise.all([
        pdfiumResource(value.resources.pdfiumWasm),
        typeof value.resources.worker === "string"
          ? workerResource(value.resources.worker)
          : Promise.resolve(undefined),
      ]);
      const issued = new Set<string>([
        value.resources.document,
        value.resources.pdfiumWasm,
        pdfium.url,
        ...(typeof value.resources.worker === "string" ? [value.resources.worker] : []),
        ...(worker === undefined ? [] : [worker.url]),
      ]);
      const chromeResources = host === "chrome" && typeof value.resources.worker === "string"
        ? {
            document: value.resources.document,
            pdfiumWasm: value.resources.pdfiumWasm,
            worker: value.resources.worker,
          }
        : undefined;
      if (host === "chrome" && chromeResources === undefined) {
        throw new Error("The trusted host returned incomplete Chrome resources.");
      }
      if (host === "chrome" && chromeLocationHistory === undefined) {
        chromeLocationHistory = new MemoryReviewLocationHistory(
          isObject(value.location)
            ? value.location as unknown as PlacekeeperLinkLocation
            : { kind: "page", page: 1 },
        );
      }
      return {
        ...value,
        session: { sessionId: value.sessionId },
        state: value.state as unknown as ReviewState,
        scope: value.scope as unknown as ProductionScope,
        saveStatus: value.saveStatus as unknown as ProductionSaveStatus,
        viewerAssets: {
          documentUrl: value.resources.document,
          pdfiumWasm: pdfium.url,
          ...(worker === undefined ? {} : { workerUrl: worker.url }),
        },
        resourcePolicy: host === "chrome"
          ? {
              host: "chrome",
              extensionOrigin: options.extensionOrigin!,
              resources: chromeResources!,
            }
          : { host: "vscode", issued },
        ...(chromeLocationHistory === undefined ? {} : { locationHistory: chromeLocationHistory }),
        ...(typeof value.canonicalLinkBase === "string"
          ? { canonicalLinkBase: value.canonicalLinkBase }
          : {}),
      };
    },
    presence() {
      void invoke("presence").catch(() => undefined);
      return () => { void invoke("detach").catch(() => undefined); };
    },
    async command(command: ReviewCommand): Promise<ReviewState | RejectedReviewCommand> {
      try {
        const value = await invoke<ReviewState | RejectedReviewCommand>("command", command);
        const conflictInvalidation = updateIdentityFromState(value);
        if (conflictInvalidation !== undefined) {
          publishInvalidation(conflictInvalidation);
        }
        return value;
      } finally {
        releaseDeferredCommandInvalidation();
      }
    },
    saveStatus: () => invoke<ProductionSaveStatus>("saveStatus"),
    saveProposal: () => invoke<SaveCopyProposal>("saveProposal"),
    chooseCopy: (filename, folderSelectionId) => invoke("chooseCopy", {
      ...(filename === undefined ? {} : { filename }),
      ...(folderSelectionId === undefined ? {} : { folderSelectionId }),
    }),
    chooseFolder: () => invoke("chooseFolder"),
    chooseOriginal: () => invoke("chooseOriginal"),
    retrySave: () => invoke("retrySave"),
    locateSave: () => invoke("locateSave"),
    exportReviewedCopy: (confirmPossiblyStale) => invoke<ProductionExportResult>(
      "exportReviewedCopy",
      confirmPossiblyStale === true ? { confirmPossiblyStale: true } : {},
    ),
    scope: (signal) => invoke<ProductionScope>("scope", {}, signal),
    forwardSyncTex: (input) => invoke("forwardSyncTex", input),
    reverseSyncTex: (input) => invoke("reverseSyncTex", input),
    subscribeInvalidations(listener) {
      invalidations.add(listener);
      if (pendingInvalidation !== undefined) {
        const event = pendingInvalidation;
        pendingInvalidation = undefined;
        listener(event);
      }
      return () => invalidations.delete(listener);
    },
    subscribeHostCommands(listener) {
      hostCommands.add(listener);
      if (pendingHostCommand !== undefined) {
        const command = pendingHostCommand;
        pendingHostCommand = undefined;
        listener(command);
      }
      return () => hostCommands.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const request of pending.values()) request.reject(new Error("The review runtime was disposed."));
      for (const resource of materializedPdfium.values()) void resource.then((value) => value.dispose());
      materializedPdfium.clear();
      for (const resource of materializedWorkers.values()) void resource.then((value) => value.dispose());
      materializedWorkers.clear();
      pending.clear();
      invalidations.clear();
      pendingInvalidation = undefined;
      deferredCommandInvalidation = undefined;
      pendingHostCommand = undefined;
      hostCommands.clear();
      chromeLocationHistory?.dispose();
    },
  };
}

export function createVscodeMessagePort(
  panelId: string,
  vscode: { postMessage(message: unknown): unknown },
): VscodeMessagePort & { readonly panelId: string } {
  return {
    panelId,
    postMessage: (message) => vscode.postMessage(message),
    subscribe(listener) {
      const receive = (event: MessageEvent<unknown>) => listener(event.data);
      globalThis.addEventListener("message", receive);
      return () => globalThis.removeEventListener("message", receive);
    },
  };
}
