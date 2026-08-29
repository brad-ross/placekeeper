import type { ReviewCommand, ReviewState } from "../../../../packages/core/src/review-model.js";
import type {
  ProductionExportResult,
  ProductionSaveStatus,
  ProductionScope,
  SaveCopyProposal,
} from "../app/ProductionReviewApp.js";
import type { RejectedReviewCommand } from "../app/ReviewShell.js";
import {
  HOST_RUNTIME_PROTOCOL,
  HOST_RUNTIME_VERSION,
  type HostRuntime,
  type HostRuntimeBootstrap,
  type HostRuntimeCommand,
  type HostRuntimeIdentity,
  type HostRuntimeInvalidation,
} from "./runtime.js";

export { HOST_RUNTIME_PROTOCOL, HOST_RUNTIME_VERSION } from "./runtime.js";

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
  readonly materializePdfiumWasm?: (sourceUrl: string) => Promise<MaterializedViewerResource>;
}

const MAX_PDFIUM_WASM_BYTES = 16 * 1024 * 1024;

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

interface PendingRequest {
  readonly method: string;
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
  return value.command === "forward-synctex" && Object.keys(value).length === 3 &&
    Number.isSafeInteger(value.pageIndex) && (value.pageIndex as number) >= 0 &&
    isObject(value.point) && Object.keys(value.point).length === 2 &&
    Number.isFinite(value.point.x) && Number.isFinite(value.point.y);
}

function abortError(): Error {
  return new DOMException("The runtime request was cancelled.", "AbortError");
}

export function createRpcHostRuntime(
  port: VscodeMessagePort & { readonly panelId: string },
  options: RpcHostRuntimeOptions = {},
): HostRuntime {
  if (!ID.test(port.panelId)) throw new Error("A safe panel identity is required.");
  const pending = new Map<string, PendingRequest>();
  const invalidations = new Set<(event: HostRuntimeInvalidation) => void>();
  const hostCommands = new Set<(command: HostRuntimeCommand) => void>();
  let identity: HostRuntimeIdentity | undefined;
  let pendingInvalidation: HostRuntimeInvalidation | undefined;
  let pendingHostCommand: HostRuntimeCommand | undefined;
  let disposed = false;
  const materializedPdfium = new Map<string, Promise<MaterializedViewerResource>>();

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

  const unsubscribe = port.subscribe((message) => {
    if (!isObject(message) || message.protocol !== HOST_RUNTIME_PROTOCOL ||
      message.version !== HOST_RUNTIME_VERSION || message.panelId !== port.panelId) return;
    if (message.kind === "event" && message.event === "host-command") {
      if (!validHostCommand(message.payload)) return;
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
      if (invalidations.size === 0) pendingInvalidation = event;
      else for (const listener of invalidations) listener(event);
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
    if (message.ok === true) current.resolve(message.payload);
    else current.reject(new Error("The trusted host rejected the review action."));
  });

  const invoke = <T>(method: string, payload: unknown = {}, signal?: AbortSignal): Promise<T> => {
    if (disposed) return Promise.reject(new Error("The review runtime is disposed."));
    if (signal?.aborted === true) return Promise.reject(abortError());
    const id = requestId();
    const requestIdentity = method === "bootstrap" || identity === undefined
      ? undefined
      : { ...identity };
    return new Promise<T>((resolve, reject) => {
      const onAbort = signal === undefined ? undefined : () => {
        if (!pending.delete(id)) return;
        port.postMessage({
          protocol: HOST_RUNTIME_PROTOCOL,
          version: HOST_RUNTIME_VERSION,
          kind: "cancel",
          panelId: port.panelId,
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
        protocol: HOST_RUNTIME_PROTOCOL,
        version: HOST_RUNTIME_VERSION,
        kind: "request",
        panelId: port.panelId,
        requestId: id,
        ...(requestIdentity === undefined ? {} : requestIdentity),
        method,
        payload,
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
    host: "vscode",
    async bootstrap(signal?: AbortSignal): Promise<HostRuntimeBootstrap> {
      const value = await invoke<Record<string, unknown>>("bootstrap", {}, signal);
      if (!validIdentity(value) || !isObject(value.state) || !isObject(value.scope) ||
        !isObject(value.saveStatus) || !isObject(value.resources) ||
        typeof value.resources.document !== "string" ||
        typeof value.resources.pdfiumWasm !== "string") {
        throw new Error("The trusted host returned an invalid bootstrap.");
      }
      identity = value;
      const pdfium = await pdfiumResource(value.resources.pdfiumWasm);
      const issued = new Set<string>([
        value.resources.document,
        value.resources.pdfiumWasm,
        pdfium.url,
        ...(typeof value.resources.worker === "string" ? [value.resources.worker] : []),
      ]);
      return {
        ...value,
        session: { sessionId: value.sessionId },
        state: value.state as unknown as ReviewState,
        scope: value.scope as unknown as ProductionScope,
        saveStatus: value.saveStatus as unknown as ProductionSaveStatus,
        viewerAssets: {
          documentUrl: value.resources.document,
          pdfiumWasm: pdfium.url,
          ...(typeof value.resources.worker === "string" ? { workerUrl: value.resources.worker } : {}),
        },
        resourcePolicy: { host: "vscode", issued },
      };
    },
    presence() {
      void invoke("presence").catch(() => undefined);
      return () => { void invoke("detach").catch(() => undefined); };
    },
    async command(command: ReviewCommand): Promise<ReviewState | RejectedReviewCommand> {
      const value = await invoke<ReviewState | RejectedReviewCommand>("command", command);
      const conflictInvalidation = updateIdentityFromState(value);
      if (conflictInvalidation !== undefined) {
        for (const listener of invalidations) listener(conflictInvalidation);
      }
      return value;
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
      pending.clear();
      invalidations.clear();
      pendingInvalidation = undefined;
      pendingHostCommand = undefined;
      hostCommands.clear();
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
