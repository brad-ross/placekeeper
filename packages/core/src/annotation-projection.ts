import type { ReviewAnnotation } from "./pdf-writer.js";
import type { JsonValue, ReviewItem } from "./review-model.js";
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

function rect(value: JsonValue | undefined): ReviewAnnotation["rect"] | undefined {
  const item = record(value);
  if (!item) return undefined;
  const { x, y, width, height } = item;
  return [x, y, width, height].every((part) => typeof part === "number")
    ? {
        x: x as number,
        y: y as number,
        width: width as number,
        height: height as number,
      }
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
  const projectedRect = rect(item.payload.rect) ?? rect(item.payload.position);
  if (!projectedRect) {
    throw new Error(`Review item ${item.id} has no valid PDF geometry`);
  }
  const segmentRects = Array.isArray(item.payload.segmentRects)
    ? item.payload.segmentRects
        .map(rect)
        .filter(
          (value): value is NonNullable<typeof value> => value !== undefined,
        )
    : undefined;
  const contents =
    item.kind === "replace" || item.kind === "insert"
      ? text(item.payload, "proposedText")
      : text(item.payload, "comment");
  const annotation: ReviewAnnotation = {
    kind: item.kind,
    id: item.id,
    pageIndex: item.pageIndex,
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
): ReviewAnnotation[] {
  return documentOrderedItems(items).map((item) => projectReviewItem(item));
}

export function documentOrderedItems(
  items: readonly ReviewItem[],
): ReviewItem[] {
  const coordinate = (item: ReviewItem, field: "x" | "y"): number => {
    const value = record(item.payload.rect) ?? record(item.payload.position);
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
