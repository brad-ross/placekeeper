import type { ReviewExportFence } from "../../../../packages/core/src/review-runtime-protocol.js";
import type { SaveStatus } from "../../../../packages/core/src/save-status.js";
import type { ReviewCommand, ReviewState, SaveDestinationConfirmation } from "../../../../packages/core/src/review-model.js";
import type {
  ProductionExportResult,
  ProductionScope,
  ProductionSession,
  SaveCopyProposal,
} from "./session-contracts.js";
import type { RejectedReviewCommand } from "../review/review-command-result.js";
import { loadProductionSession } from "../app/session-api.js";
import type { HostRuntime, HostRuntimeInvalidation } from "./runtime.js";
interface ReviewInteractionAttachment {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly incarnationId: string;
  readonly capability: string;
  readonly protocolVersion: 1;
  readonly capabilities: readonly string[];
}

export function createBrowserHostRuntime(session: ProductionSession): HostRuntime {
  let loaded: Awaited<ReturnType<typeof loadProductionSession>> | undefined;
  const invalidationListeners = new Set<(event: HostRuntimeInvalidation) => void>();
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelayMs = 1_000;
  let stopped = false;
  const viewIdentity = crypto.randomUUID();
  let interactionAttachment: ReviewInteractionAttachment | undefined;
  let attachmentReady = Promise.withResolvers<ReviewInteractionAttachment>();
  let pendingFinalizations = 0;
  let deferredInvalidation: HostRuntimeInvalidation | undefined;

  const ensureLoaded = async () => loaded ??= await loadProductionSession(session);
  const connectInvalidations = (): void => {
    if (stopped || socket !== undefined || session.credential === undefined) return;
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(
      `${scheme}//${window.location.host}/s/${session.sessionId}/control`,
      ["placekeeper", `placekeeper-auth.${session.credential}`, `placekeeper-view.${viewIdentity}`],
    );
    socket.addEventListener("open", () => {
      retryDelayMs = 1_000;
      const previous = loaded;
      if (previous === undefined) return;
      loaded = undefined;
      const reconnectHint: HostRuntimeInvalidation = {
        sessionId: session.sessionId,
        generation: previous.state.workflow.documentGeneration,
        revision: previous.state.revision,
        reason: "freshness",
      };
      for (const listener of invalidationListeners) listener(reconnectHint);
    });
    socket.addEventListener("message", (event) => {
      try {
        const value = JSON.parse(String(event.data)) as {
          kind?: unknown;
          previousGeneration?: unknown;
          documentGeneration?: unknown;
          reviewRevision?: unknown;
          reason?: unknown;
        };
        if (value.kind === "interaction-attachment") {
          interactionAttachment = (value as unknown as { attachment: ReviewInteractionAttachment }).attachment;
          attachmentReady.resolve(interactionAttachment);
          return;
        }
        const successor = value.kind === "document-successor" &&
          Number.isSafeInteger(value.previousGeneration) &&
          Number.isSafeInteger(value.documentGeneration) &&
          Number.isSafeInteger(value.reviewRevision);
        const sameGeneration = value.kind === "session-invalidated" &&
          Number.isSafeInteger(value.documentGeneration) &&
          Number.isSafeInteger(value.reviewRevision) &&
          (value.reason === "revision" || value.reason === "freshness");
        if (!successor && !sameGeneration) return;
        loaded = undefined;
        const next: HostRuntimeInvalidation = {
          sessionId: session.sessionId,
          generation: value.documentGeneration as number,
          revision: value.reviewRevision as number,
          reason: successor ? "generation" : value.reason as "revision" | "freshness",
          ...(successor ? { previousGeneration: value.previousGeneration as number } : {}),
        };
        if (pendingFinalizations > 0) deferredInvalidation = next;
        else for (const listener of invalidationListeners) listener(next);
      } catch {
        // Untrusted control messages are ignored; the next bootstrap rehydrates.
      }
    });
    socket.addEventListener("close", () => {
      socket = undefined;
      interactionAttachment = undefined;
      attachmentReady = Promise.withResolvers<ReviewInteractionAttachment>();
      if (!stopped) {
        retry = setTimeout(connectInvalidations, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      }
    });
  };

  const browserViewerAssets = (currentSession: ProductionSession, state: ReviewState) => ({
    pdfiumWasm: currentSession.appLinkBase === undefined
      ? `/s/${currentSession.sessionId}/assets/pdfium.wasm`
      : "/assets/pdfium.wasm",
    workerUrl: currentSession.appLinkBase === undefined
      ? `/s/${currentSession.sessionId}/assets/pdfium-worker.js`
      : "/assets/pdfium-worker.js",
    documentUrl: `/s/${currentSession.sessionId}/document/${state.source.fileId}?generation=${state.workflow.documentGeneration}`,
    ...(currentSession.credential === undefined
      ? {}
      : { requestHeaders: { authorization: `Bearer ${currentSession.credential}` } }),
  });
  const fetchInteraction = async (action: "begin" | "finalize" | "release" | "acknowledge", payload: unknown): Promise<unknown> => {
    if (session.credential === undefined) throw new Error("Authenticated interaction lifecycle is unavailable.");
    connectInvalidations();
    const attachment = interactionAttachment ?? await attachmentReady.promise;
    const response = await fetch(`/s/${session.sessionId}/interactions/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ ...(payload as object), attachment }),
    });
    if (!response.ok) throw new Error(`Interaction lifecycle failed (${response.status})`);
    return response.json();
  };

  return {
    host: "browser",
    get capabilities() { return interactionAttachment?.protocolVersion === 1
      ? { localDocumentRefresh: true as const, interactionLifecycleVersion: 1 as const }
      : { localDocumentRefresh: true as const }; },
    async bootstrap() {
      const current = await ensureLoaded();
      connectInvalidations();
      return {
        sessionId: session.sessionId,
        generation: current.state.workflow.documentGeneration,
        revision: current.state.revision,
        session,
        state: current.state,
        scope: current.scope,
        saveStatus: current.saveStatus,
        viewerAssets: browserViewerAssets(session, current.state),
        resourcePolicy: { host: "browser", origin: globalThis.location.origin },
      };
    },
    presence() {
      connectInvalidations();
      return () => undefined;
    },
    async command(command: ReviewCommand): Promise<ReviewState | RejectedReviewCommand> {
      return (await ensureLoaded()).api.command(command);
    },
    async saveStatus(): Promise<SaveStatus> { return (await ensureLoaded()).api.saveStatus(); },
    async saveProposal(): Promise<SaveCopyProposal> { return (await ensureLoaded()).api.saveProposal(); },
    async chooseCopy(filename?: string, folderSelectionId?: string, confirmation?: SaveDestinationConfirmation) {
      return (await ensureLoaded()).api.chooseCopy(filename, folderSelectionId, confirmation);
    },
    async chooseFolder() { return (await ensureLoaded()).api.chooseFolder(); },
    async chooseOriginal(confirmation?: SaveDestinationConfirmation) { return (await ensureLoaded()).api.chooseOriginal(confirmation); },
    async retrySave() { return (await ensureLoaded()).api.retrySave(); },
    async locateSave() { return (await ensureLoaded()).api.locateSave(); },
    async resolveReadingLocation(input) {
      const resolve = (await ensureLoaded()).api.resolveReadingLocation;
      if (resolve === undefined) throw new Error("Reading location resolution is unavailable.");
      return resolve(input);
    },
    async exportReviewedCopy(confirmPossiblyStale?: true, fence?: ReviewExportFence): Promise<ProductionExportResult> {
      const method = (await ensureLoaded()).api.exportReviewedCopy;
      if (method === undefined) throw new Error("Reviewed export is unavailable.");
      return method(confirmPossiblyStale, fence);
    },
    async scope(signal?: AbortSignal): Promise<ProductionScope> {
      return (await ensureLoaded()).api.scope(signal);
    },
    subscribeInvalidations(listener) {
      invalidationListeners.add(listener);
      connectInvalidations();
      return () => invalidationListeners.delete(listener);
    },
    async forwardSyncTex() { throw new Error("SyncTeX is available through the trusted host only."); },
    async reverseSyncTex() { throw new Error("SyncTeX is available through the trusted host only."); },
    beginInteraction: (input) => fetchInteraction("begin", input),
    async finalizeInteraction(input) {
      pendingFinalizations += 1;
      try { return await fetchInteraction("finalize", input); }
      finally {
        pendingFinalizations -= 1;
        if (pendingFinalizations === 0 && deferredInvalidation !== undefined) {
          const next = deferredInvalidation;
          deferredInvalidation = undefined;
          setTimeout(() => {
            if (!stopped) for (const listener of invalidationListeners) listener(next);
          }, 0);
        }
      }
    },
    releaseInteraction: (input) => fetchInteraction("release", input),
    acknowledgeInteraction: (input) => fetchInteraction("acknowledge", input),
    dispose() {
      stopped = true;
      if (retry !== undefined) clearTimeout(retry);
      socket?.close();
      socket = undefined;
      invalidationListeners.clear();
    },
  };
}
