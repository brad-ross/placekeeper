import type { ReviewCommand, SaveDestinationConfirmation } from "../../../../packages/core/src/review-model.js";
import type { ReviewExportFence, ReviewRuntimeBrokerMethod } from "../../../../packages/core/src/review-runtime-protocol.js";
import type { ExportCoordinator } from "../export/export-coordinator.js";
import { rejectedDestinationName, type PdfSaveCoordinator } from "../saving/pdf-save-coordinator.js";
import type { SessionBroker } from "../sessions/session-broker.js";
import type { ReviewInteractionAttachment } from "../sessions/review-interactions.js";

/** Trusted session effects shared by host adapters. The caller owns admission,
 * operation journaling, source staging, and host-specific destination defaults.
 * All durable review state and physical PDF writes remain broker/coordinator owned. */
export class LocalReviewBackend {
  readonly #broker: SessionBroker;
  readonly #saving: PdfSaveCoordinator;
  readonly #exporting: ExportCoordinator;

  constructor(options: {
    readonly broker: SessionBroker;
    readonly saving: PdfSaveCoordinator;
    readonly exporting: ExportCoordinator;
  }) {
    this.#broker = options.broker;
    this.#saving = options.saving;
    this.#exporting = options.exporting;
  }

  async invoke(
    sessionId: string,
    generation: number,
    method: Exclude<ReviewRuntimeBrokerMethod, "saveProposal">,
    payload: unknown,
    options: { readonly expectedDocumentGeneration?: number } = {},
  ): Promise<unknown> {
    if (["command", "chooseCopy", "chooseFolder", "chooseOriginal", "retrySave", "locateSave", "exportReviewedCopy"].includes(method)) {
      // Establish the durable recovery boundary before attempting a side
      // effect. A rejected operation may conservatively retain a clean draft;
      // a committed operation can never lose its protection marker.
      await this.#broker.protectChromeReview(sessionId);
    }
    let result: unknown;
    switch (method) {
      case "command":
        result = await this.#broker.acceptMutation(sessionId, payload as ReviewCommand, { expectedGeneration: generation });
        if (this.#broker.saveStatus(sessionId)?.destination.phase === "active") {
          void this.#saving.requestSave(sessionId);
        }
        break;
      case "saveStatus": result = this.#broker.saveStatus(sessionId); break;
      case "chooseCopy":
      case "chooseOriginal": {
        const value = payload as { readonly filename?: string; readonly folderSelectionId?: string;
          readonly confirmation?: SaveDestinationConfirmation };
        let nameResult;
        try {
          const state = method === "chooseCopy"
            ? await this.#saving.chooseCopyFilename(sessionId, value.filename, value.folderSelectionId, value.confirmation, options.expectedDocumentGeneration)
            : await this.#saving.chooseOriginal(sessionId, value.confirmation, options.expectedDocumentGeneration);
          if (value.confirmation !== undefined) nameResult = state;
        } catch (error) {
          if (value.confirmation === undefined) throw error;
          nameResult = rejectedDestinationName(error, this.#broker.state(sessionId));
          if (nameResult === undefined) throw error;
        }
        result = { ...this.#broker.saveStatus(sessionId),
          ...(nameResult === undefined ? {} : { nameResult }),
        };
        break;
      }
      case "chooseFolder": result = await this.#saving.chooseFolder(sessionId, options.expectedDocumentGeneration); break;
      case "retrySave":
        await this.#saving.retry(sessionId, options.expectedDocumentGeneration);
        result = this.#broker.saveStatus(sessionId);
        break;
      case "locateSave":
        await this.#saving.locate(sessionId, options.expectedDocumentGeneration);
        result = this.#broker.saveStatus(sessionId);
        break;
      case "scope": result = await this.#broker.sessionScope(sessionId); break;
      case "resolveReadingLocation":
        result = await this.#broker.resolveReadingLocation(sessionId, payload as import("../../../../packages/core/src/review-runtime-protocol.js").ReadingLocationResolutionRequestV1);
        break;
      case "exportReviewedCopy": {
        const value = payload as { readonly confirmPossiblyStale?: true; readonly fence?: ReviewExportFence };
        const frozen = await this.#broker.freezeDelivery(sessionId, value.fence, options.expectedDocumentGeneration);
        result = await this.#exporting.exportReviewedCopy({
          ...frozen,
          ...(value.confirmPossiblyStale === true ? { staleConfirmed: true as const } : {}),
        });
        break;
      }
      default: throw new Error("review-method-forbidden");
    }
    return result;
  }

  async interaction(
    sessionId: string,
    attachment: ReviewInteractionAttachment,
    action: "begin" | "finalize" | "release" | "acknowledge",
    payload: unknown,
  ): Promise<unknown> {
    const value = payload as Record<string, unknown>;
    const common = {
      sessionId,
      attachment,
      interactionToken: value.interactionToken as string,
      order: value.order as number,
    };
    if (action === "begin") {
      return this.#broker.beginReviewInteraction({ ...common, generation: value.generation as number,
        ...(typeof value.draftId === "string" ? { draftId: value.draftId } : {}) });
    }
    if (action === "release") return this.#broker.releaseReviewInteraction(common);
    if (action === "acknowledge") return this.#broker.acknowledgeReviewInteraction(common);
    const result = await this.#broker.finalizeReviewInteraction({
      ...common,
      outcome: value.outcome as "applied" | "discarded",
      draftId: value.draftId as string,
      expectedDraftRevision: value.expectedDraftRevision as number,
    });
    // Durable finalization receipts replay their recorded outcome, even when
    // a retry requests another outcome. Rejections and discarded receipts do
    // not authorize a save of newly accepted PDF edits.
    if (typeof result === "object" && result !== null && "status" in result && result.status === "finalized" &&
      "outcome" in result && result.outcome === "applied" && this.#broker.saveStatus(sessionId)?.destination.phase === "active") {
      void this.#saving.requestSave(sessionId);
    }
    return result;
  }

}
