import type { ReviewState } from "../../../../packages/core/src/review-model.js";

export interface DeliveryArtifact {
  readonly path: string;
  readonly warning?: string;
}

export const EMPTY_DELIVERY_EXPLANATION =
  "There are no annotations to hand off. Add an annotation first.";

export function deliveryUnavailableReason(
  state: Pick<ReviewState, "items">,
  restriction?: string,
): string | undefined {
  if (state.items.length === 0) return EMPTY_DELIVERY_EXPLANATION;
  return restriction;
}
