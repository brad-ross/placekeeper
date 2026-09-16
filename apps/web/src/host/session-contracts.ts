import type {
  ReadingLocationResolutionRequestV1,
  ReadingLocationResolutionV1,
  ReviewExportFence,
} from "../../../../packages/core/src/review-runtime-protocol.js";
import type { ReviewCommand, ReviewState, SaveDestinationConfirmation } from "../../../../packages/core/src/review-model.js";
import type { SaveStatus } from "../../../../packages/core/src/save-status.js";
import type { LiveContextBindingStatus } from "../../../../packages/core/src/live-context.js";
import type { RejectedReviewCommand } from "../review/review-command-result.js";
import type { ReviewInteractionTransport } from "../review/authoring-session.js";

export interface ProductionSession {
  readonly sessionId: string;
  /** Browser-only memory credential. VS Code keeps this in the extension host. */
  readonly credential?: string;
  /** Present for top-level readable views; embedded bootstrap sessions omit it. */
  readonly appLinkBase?: string;
}

export interface ProductionScope {
  readonly documentTitle: string;
  readonly sourceDisposition?: 'local' | 'remote-temporary';
  readonly sourceDisplayName?: string;
  readonly sourceRootPath?: string;
  readonly launchSurface?: 'browser' | 'finder' | 'codex' | 'vscode' | 'chrome' | 'macos' | 'static';
  /** Static hosting keeps review state only in this tab and offers explicit PDF export. */
  readonly persistenceMode?: 'export-only';
  /** A restarted browser is awaiting task-scoped Codex reattachment. */
  readonly reconnectPending?: true;
  readonly codexContext?: LiveContextBindingStatus;
}

export type SaveCopyProposal =
  | {
      readonly sourceDisposition: 'local';
      readonly filename: string;
      readonly folder: string;
    }
  | {
      readonly sourceDisposition: 'remote-temporary';
      readonly folder?: string;
    };

export interface ProductionExportResult {
  readonly kind: "reviewed-copy";
  readonly path: string;
  readonly revision: number;
  readonly digest: string;
  readonly warning?: string;
}

export type SaveDestinationResult = SaveStatus & {
  readonly nameResult?: ReviewState | RejectedReviewCommand;
};

export interface ReviewInteractionAttachment {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly incarnationId: string;
  readonly capability: string;
  readonly protocolVersion: 1;
  readonly capabilities: readonly string[];
}

export interface ProductionSessionApi extends Partial<ReviewInteractionTransport> {
  readonly capabilities?: {
    readonly localDocumentRefresh: boolean;
    readonly interactionLifecycleVersion?: 1;
  };
  subscribeInteractionReconnect?(
    listener: (identity: { readonly generation: number; readonly revision: number }) => Promise<void>,
  ): () => void;
  presence?(): () => void;
  command(
    command: ReviewCommand,
    attachment?: ReviewInteractionAttachment,
  ): Promise<ReviewState | RejectedReviewCommand>;
  saveStatus(): Promise<SaveStatus>;
  saveProposal(): Promise<SaveCopyProposal>;
  chooseCopy(filename?: string, folderSelectionId?: string, confirmation?: SaveDestinationConfirmation): Promise<SaveDestinationResult>;
  chooseFolder(): Promise<{ readonly cancelled: boolean; readonly selectionId?: string; readonly folder?: string }>;
  chooseOriginal(confirmation?: SaveDestinationConfirmation): Promise<SaveDestinationResult>;
  retrySave(): Promise<SaveStatus>;
  locateSave(): Promise<SaveStatus>;
  resolveReadingLocation?(input: ReadingLocationResolutionRequestV1): Promise<ReadingLocationResolutionV1>;
  exportReviewedCopy?(confirmPossiblyStale?: true, fence?: ReviewExportFence): Promise<ProductionExportResult>;
  scope(signal?: AbortSignal): Promise<ProductionScope>;
}

export interface ReverseSyncTexRequest {
  readonly pageIndex: number;
  readonly point: { readonly x: number; readonly y: number };
}

export interface ForwardSyncTexRequest {
  readonly documentGeneration: number;
  readonly pageIndex: number;
  readonly point: { readonly x: number; readonly y: number };
}

export type HostForwardSyncTexRequest = ForwardSyncTexRequest & {
  readonly token: number;
};
