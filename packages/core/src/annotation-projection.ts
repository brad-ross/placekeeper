import { nativePdfAnnotationSubtype } from './native-pdf-annotation.js';
import type { ReviewAnnotation } from "./pdf-writer.js";
import type { JsonValue, ReviewItem } from "./review-model.js";
import {
  anchorEvidenceFromReviewItem,
  normalizeReviewSelectionAnchor,
  normalizeAnnotationName,
} from "./review-model.js";
import {
  portableAnnotationProjectionId,
  serializePortableAnnotationGroup,
} from "./grouped-annotation-envelope.js";
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
  author = item.importedAnnotationAuthor ?? PORTABLE_ANNOTATION_AUTHOR,
): ReviewAnnotation {
  const anchor = anchorEvidenceFromReviewItem(item);
  const projectedRect = anchor.rect;
  if (!projectedRect) {
    throw new Error(`Review item ${item.id} has no valid PDF geometry`);
  }
  const segmentRects = anchor.kind === "selection" ? anchor.segmentRects : undefined;
  const annotation: ReviewAnnotation = {
    ...annotationBase(item, author),
    id: item.id,
    reviewItemId: item.id,
    projectionIndex: 0,
    projectionCount: 1,
    pageIndex: anchor.pageIndex,
    rect: projectedRect,
    ...(segmentRects && segmentRects.length > 0
      ? { quadPoints: segmentRects }
      : {}),
  };
  if (item.kind === 'pdfAnnotation') return annotation;
  return {
    ...annotation,
    custom: createPortableAnnotationCustom(item, annotation),
  };
}

function annotationBase(item: ReviewItem, author: string) {
  return {
    kind: item.kind,
    contents: item.kind === "replace" || item.kind === "insert"
      ? text(item.payload, "proposedText")
      : text(item.payload, "comment"),
    author: item.kind === 'pdfAnnotation' ? String(item.payload.author ?? '') : author,
    ...(item.kind === 'pdfAnnotation' ? { nativeSubtype: nativePdfAnnotationSubtype(item)! } : {}),
    createdAt: item.createdAt,
    modifiedAt: item.updatedAt,
    ...((item.kind === "pageNote" || item.kind === "pdfAnnotation")
      ? {}
      : { textAnchorReliable: item.payload.reliable === true }),
  };
}

function projectedAnnotation(input: {
  readonly item: ReviewItem;
  readonly pageIndex: number;
  readonly rect: ReviewAnnotation['rect'];
  readonly quadPoints?: readonly ReviewAnnotation['rect'][];
  readonly projectionIndex: number;
  readonly projectionCount: number;
  readonly projectionId?: string;
  readonly author: string;
  readonly custom?: unknown;
}): ReviewAnnotation {
  const { item, projectionIndex, projectionCount } = input;
  const projectionId = input.projectionId ?? portableAnnotationProjectionId(
    item.id,
    projectionIndex,
    projectionCount,
  );
  const annotation: ReviewAnnotation = {
    ...annotationBase(item, input.author),
    id: projectionId,
    reviewItemId: item.id,
    projectionIndex,
    projectionCount,
    pageIndex: input.pageIndex,
    rect: input.rect,
    ...(input.quadPoints && input.quadPoints.length > 0
      ? { quadPoints: input.quadPoints }
      : {}),
  };
  if (item.kind === 'pdfAnnotation') return annotation;
  if (input.custom !== undefined) return { ...annotation, custom: input.custom };
  if (projectionCount > 1) return annotation;
  return {
    ...annotation,
    custom: createPortableAnnotationCustom(item, annotation),
  };
}

/** Projects one logical item into deterministic page-local visual annotations. */
export function projectReviewItemProjections(
  item: ReviewItem,
  author = item.importedAnnotationAuthor ?? PORTABLE_ANNOTATION_AUTHOR,
  options: { readonly includePortableMetadata?: boolean } = {},
): ReviewAnnotation[] {
  const anchor = anchorEvidenceFromReviewItem(item);
  if (anchor.kind === 'selection') {
    const pages = normalizeReviewSelectionAnchor(anchor).pages;
    const portableGroup = options.includePortableMetadata !== false
      && pages.length > 1
      ? serializePortableAnnotationGroup(item, author)
      : [];
    return pages.map((page, projectionIndex) => {
      const portableChild = portableGroup[projectionIndex];
      return projectedAnnotation({
        item,
        pageIndex: portableChild?.pageIndex ?? page.pageIndex,
        rect: page.rect,
        quadPoints: page.segmentRects,
        projectionIndex: portableChild?.projectionIndex ?? projectionIndex,
        projectionCount: portableChild?.projectionCount ?? pages.length,
        author,
        ...(portableChild === undefined ? {} : {
          projectionId: portableChild.projectionId,
          custom: portableChild.custom,
        }),
      });
    });
  }

  return [projectedAnnotation({
    item,
    pageIndex: anchor.pageIndex,
    rect: anchor.rect,
    projectionIndex: 0,
    projectionCount: 1,
    author,
  })];
}

export function projectReviewItems(
  items: readonly ReviewItem[],
  documentGeneration?: number,
  options: { readonly includePortableMetadata?: boolean; readonly annotationName?: string } = {},
): ReviewAnnotation[] {
  return documentOrderedItems(items)
    .filter((item) => documentGeneration === undefined || reviewItemIsResolvedForGeneration(item, documentGeneration))
    .flatMap((item) => projectReviewItemProjections(item, options.annotationName === undefined ? undefined : normalizeAnnotationName(options.annotationName), options));
}

export function reviewItemPageRange(item: ReviewItem): {
  readonly firstPageIndex: number;
  readonly lastPageIndex: number;
} {
  try {
    const anchor = anchorEvidenceFromReviewItem(item);
    if (anchor.kind === 'selection') {
      const pages = normalizeReviewSelectionAnchor(anchor).pages;
      return {
        firstPageIndex: pages[0]?.pageIndex ?? item.pageIndex,
        lastPageIndex: pages.at(-1)?.pageIndex ?? item.pageIndex,
      };
    }
  } catch {
    // Retain legacy tray rendering if imported evidence is malformed.
  }
  return { firstPageIndex: item.pageIndex, lastPageIndex: item.pageIndex };
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
