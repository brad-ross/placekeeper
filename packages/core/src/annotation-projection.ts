import type { ReviewAnnotation } from "./pdf-writer.js";
import type { JsonValue, ReviewItem } from "./review-model.js";
import { anchorEvidenceFromReviewItem } from "./review-model.js";
import {
  createPortableAnnotationCustom,
  PORTABLE_ANNOTATION_AUTHOR,
} from "./portable-annotation.js";

function record(
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function text(payload: ReviewItem["payload"], field: string): string {
  const value = payload[field];
  return typeof value === "string" ? value : "";
}

export function projectReviewItem(
  item: ReviewItem,
  author = PORTABLE_ANNOTATION_AUTHOR,
): ReviewAnnotation {
  const anchor = anchorEvidenceFromReviewItem(item);
  const projectedRect = anchor.rect;
  if (!projectedRect) {
    throw new Error(`Review item ${item.id} has no valid PDF geometry`);
  }
  const segmentRects = anchor.kind === "selection" ? anchor.segmentRects : undefined;
  const contents =
    item.kind === "replace" || item.kind === "insert"
      ? text(item.payload, "proposedText")
      : text(item.payload, "comment");
  const annotation: ReviewAnnotation = {
    kind: item.kind,
    id: item.id,
    pageIndex: anchor.pageIndex,
    rect: projectedRect,
    contents,
    author,
    createdAt: item.createdAt,
    modifiedAt: item.updatedAt,
    ...(segmentRects && segmentRects.length > 0
      ? { quadPoints: segmentRects }
      : {}),
    ...(item.kind === "pageNote"
      ? {}
      : { textAnchorReliable: item.payload.reliable === true }),
  };
  return {
    ...annotation,
    custom: createPortableAnnotationCustom(item, annotation),
  };
}

export function projectReviewItems(
  items: readonly ReviewItem[],
  documentGeneration?: number,
): ReviewAnnotation[] {
  return documentOrderedItems(items)
    .filter((item) => documentGeneration === undefined || reviewItemIsResolvedForGeneration(item, documentGeneration))
    .map((item) => projectReviewItem(item));
}

export function reviewItemIsResolvedForGeneration(
  item: ReviewItem,
  documentGeneration: number,
): boolean {
  if (item.reconciliation === undefined) return true;
  const disposition = item.reconciliation.disposition;
  return disposition.kind === "resolved" && disposition.generation === documentGeneration;
}

export function documentOrderedItems(
  items: readonly ReviewItem[],
): ReviewItem[] {
  const coordinate = (item: ReviewItem, field: "x" | "y"): number => {
    const value = item.reconciliation?.anchor.rect ?? record(item.payload.rect) ?? record(item.payload.position);
    return typeof value?.[field] === "number"
      ? (value[field] as number)
      : Number.MAX_SAFE_INTEGER;
  };
  return items.toSorted(
    (left, right) =>
      left.pageIndex - right.pageIndex ||
      coordinate(left, "y") - coordinate(right, "y") ||
      coordinate(left, "x") - coordinate(right, "x") ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}
