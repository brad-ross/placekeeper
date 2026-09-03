import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';

export {
  documentOrderedItems,
  projectReviewItem,
  projectReviewItemProjections,
  projectReviewItems,
  reviewItemPageRange,
} from "../../../../packages/core/src/annotation-projection.js";

export function reviewItemIdForAnnotation(annotation: ReviewAnnotation): string {
  return annotation.reviewItemId ?? annotation.id;
}

/** Replaces every visible projection for the one logical item being edited. */
export function mergeAuthoringPreviewProjections(
  owned: readonly ReviewAnnotation[],
  preview: readonly ReviewAnnotation[] | null,
): readonly ReviewAnnotation[] {
  if (preview === null) return owned;
  const previewItemIds = new Set(preview.map(reviewItemIdForAnnotation));
  return [
    ...owned.filter((annotation) => !previewItemIds.has(reviewItemIdForAnnotation(annotation))),
    ...preview,
  ];
}
