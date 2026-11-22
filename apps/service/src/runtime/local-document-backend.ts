import type { DocumentCommand, SaveDestinationConfirmation } from "../../../../packages/core/src/document-model.js";
import type { DocumentExportFence, DocumentRuntimeBrokerMethod } from "../../../../packages/core/src/document-runtime-protocol.js";
import type { ExportCoordinator } from "../export/export-coordinator.js";
import { rejectedDestinationName, type PdfSaveCoordinator } from "../saving/pdf-save-coordinator.js";
import type { SessionBroker } from "../sessions/session-broker.js";
import type { DocumentInteractionAttachment } from "../sessions/document-interactions.js";

const documentSideEffectMethods = new Set<DocumentRuntimeBrokerMethod>([
  "command", "chooseCopy", "chooseFolder", "chooseOriginal", "retrySave", "locateSave", "exportReviewedCopy",
]);

export function isDocumentSideEffectMethod(method: DocumentRuntimeBrokerMethod): boolean {
  return documentSideEffectMethods.has(method);
}

/** Trusted session effects shared by host adapters. The caller owns admission,
 * operation journaling, source staging, and host-specific destination defaults.
 * All durable review state and physical PDF writes remain broker/coordinator owned. */
export class LocalDocumentBackend {
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
    method: Exclude<DocumentRuntimeBrokerMethod, "saveProposal">,
    payload: unknown,
    options: { readonly expectedDocumentGeneration?: number; readonly assertAuthority?: () => void;
      readonly trustedDestinationSelection?: { readonly selectedPath: string | null; readonly assertAuthority: () => void } } = {},
  ): Promise<unknown> {
    if (isDocumentSideEffectMethod(method)) {
      // Establish the durable recovery boundary before attempting a side
      // effect. A rejected operation may conservatively retain a clean draft;
      // a committed operation can never lose its protection marker.
      await this.#broker.protectChromeReview(sessionId);
    }
    options.assertAuthority?.();
    let result: unknown;
    switch (method) {
      case "command":
        result = await this.#broker.acceptMutation(sessionId, payload as DocumentCommand, {
          expectedGeneration: generation,
          ...(options.assertAuthority === undefined ? {} : { assertAuthority: options.assertAuthority }),
        });
        if ((payload as DocumentCommand).type !== "put-draft" && this.#broker.saveStatus(sessionId)?.destination.phase === "active") {
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
            ? await this.#saving.chooseCopyFilename(sessionId, value.filename, value.folderSelectionId, value.confirmation, options.expectedDocumentGeneration, options.assertAuthority)
            : await this.#saving.chooseOriginal(sessionId, value.confirmation, options.expectedDocumentGeneration, options.assertAuthority);
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
      case "chooseFolder": result = await this.#saving.chooseFolder(sessionId, options.expectedDocumentGeneration, options.trustedDestinationSelection, options.assertAuthority); break;
      case "retrySave":
        await this.#saving.retry(sessionId, options.expectedDocumentGeneration);
        result = this.#broker.saveStatus(sessionId);
        break;
      case "locateSave":
        await this.#saving.locate(sessionId, options.expectedDocumentGeneration, options.trustedDestinationSelection, options.assertAuthority);
        result = this.#broker.saveStatus(sessionId);
        break;
      case "scope": result = await this.#broker.sessionScope(sessionId); break;
      case "resolveReadingLocation":
        result = await this.#broker.resolveReadingLocation(sessionId, payload as import("../../../../packages/core/src/document-runtime-protocol.js").ReadingLocationResolutionRequestV1);
        break;
      case "exportReviewedCopy": {
        const value = payload as { readonly confirmPossiblyStale?: true; readonly fence?: DocumentExportFence };
        const frozen = await this.#broker.freezeDelivery(sessionId, value.fence, options.expectedDocumentGeneration);
        options.assertAuthority?.();
        result = await this.#exporting.exportReviewedCopy({
          ...frozen,
          ...(value.confirmPossiblyStale === true ? { staleConfirmed: true as const } : {}),
        }, options.assertAuthority);
        break;
      }
      default: throw new Error("review-method-forbidden");
    }
    return result;
  }

  async interaction(
    sessionId: string,
    attachment: DocumentInteractionAttachment,
    action: "begin" | "finalize" | "release" | "acknowledge",
    payload: unknown,
    assertAuthority?: () => void,
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
    if (action === "release") return this.#broker.releaseDocumentInteraction(common);
    if (action === "acknowledge") return this.#broker.acknowledgeDocumentInteraction(common);
    const result = await this.#broker.finalizeDocumentInteraction({
      ...common,
      outcome: value.outcome as "applied" | "discarded",
      draftId: value.draftId as string,
      expectedDraftRevision: value.expectedDraftRevision as number,
      ...(assertAuthority === undefined ? {} : { assertAuthority }),
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
