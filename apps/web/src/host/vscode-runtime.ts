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

interface PendingRequest {
  readonly method: string;
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

function abortError(): Error {
  return new DOMException("The runtime request was cancelled.", "AbortError");
}

export function createRpcHostRuntime(port: VscodeMessagePort & { readonly panelId: string }): HostRuntime {
  if (!ID.test(port.panelId)) throw new Error("A safe panel identity is required.");
  const pending = new Map<string, PendingRequest>();
  const invalidations = new Set<(event: HostRuntimeInvalidation) => void>();
  let identity: HostRuntimeIdentity | undefined;
  let disposed = false;

  const unsubscribe = port.subscribe((message) => {
    if (!isObject(message) || message.protocol !== HOST_RUNTIME_PROTOCOL ||
      message.version !== HOST_RUNTIME_VERSION || message.panelId !== port.panelId) return;
    if (message.kind === "event" && message.event === "document-successor") {
      if (!validIdentity(message.payload) || !isObject(message.payload) ||
        !Number.isSafeInteger(message.payload.previousGeneration) ||
        !isObject(message.payload.resources) ||
        typeof message.payload.resources.document !== "string" ||
        typeof message.payload.resources.pdfiumWasm !== "string") return;
      identity = message.payload;
      const issued = new Set<string>([
        message.payload.resources.document,
        message.payload.resources.pdfiumWasm,
        ...(typeof message.payload.resources.worker === "string" ? [message.payload.resources.worker] : []),
      ]);
      const event: HostRuntimeInvalidation = {
        ...message.payload,
        previousGeneration: message.payload.previousGeneration as number,
        viewerAssets: {
          documentUrl: message.payload.resources.document,
          pdfiumWasm: message.payload.resources.pdfiumWasm,
          ...(typeof message.payload.resources.worker === "string"
            ? { workerUrl: message.payload.resources.worker }
            : {}),
        },
        resourcePolicy: { host: "vscode", issued },
      } as HostRuntimeInvalidation;
      for (const listener of invalidations) listener(event);
      return;
    }
    if (message.kind !== "response" || typeof message.requestId !== "string") return;
    const current = pending.get(message.requestId);
    if (current === undefined) return;
    if (!validIdentity(message)) return;
    if (current.method === "bootstrap") {
      if (!isObject(message.payload) || message.payload.sessionId !== message.sessionId ||
        message.payload.generation !== message.generation || message.payload.revision !== message.revision) return;
    } else if (identity === undefined || message.sessionId !== identity.sessionId ||
      message.generation !== identity.generation || message.revision !== identity.revision) return;
    pending.delete(message.requestId);
    current.abort?.();
    if (message.ok === true) current.resolve(message.payload);
    else current.reject(new Error("The trusted host rejected the review action."));
  });

  const invoke = <T>(method: string, payload: unknown = {}, signal?: AbortSignal): Promise<T> => {
    if (disposed) return Promise.reject(new Error("The review runtime is disposed."));
    if (signal?.aborted === true) return Promise.reject(abortError());
    const id = requestId();
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
        ...(identity === undefined ? {} : identity),
        method,
        payload,
      });
    });
  };

  const updateIdentityFromState = (value: unknown): void => {
    if (identity === undefined || !isObject(value)) return;
    const state = value.accepted === false ? value.state : value;
    if (!isObject(state) || !Number.isSafeInteger(state.revision)) return;
    identity = { ...identity, revision: state.revision as number };
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
      const issued = new Set<string>([
        value.resources.document,
        value.resources.pdfiumWasm,
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
          pdfiumWasm: value.resources.pdfiumWasm,
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
      updateIdentityFromState(value);
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
      return () => invalidations.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const request of pending.values()) request.reject(new Error("The review runtime was disposed."));
      pending.clear();
      invalidations.clear();
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
