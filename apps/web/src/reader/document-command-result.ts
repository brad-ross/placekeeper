import type { DocumentStateView } from "../../../../packages/core/src/document-model.js";

export interface RejectedDocumentCommand {
  readonly accepted: false;
  readonly state: DocumentStateView;
  readonly message: string;
  readonly reason?: 'rejected' | 'save-destination' | 'stale-authoring' | 'generation-conflict'
    | 'persistence-pending';
}
