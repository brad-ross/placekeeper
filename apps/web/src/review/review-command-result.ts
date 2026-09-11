import type { ReviewState } from "../../../../packages/core/src/review-model.js";

export interface RejectedReviewCommand {
  readonly accepted: false;
  readonly state: ReviewState;
  readonly message: string;
  readonly reason?: 'rejected' | 'save-destination' | 'stale-authoring' | 'generation-conflict';
}
