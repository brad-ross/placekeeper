import type { JsonValue, ReviewAnchorDisposition, ReviewItem } from "./review-model.js";
import {
  anchorEvidenceFromReviewItem,
  normalizeReviewSelectionAnchor,
} from "./review-model.js";

export interface SourceHint {
  readonly path: string;
  readonly line: number;
  readonly confidence: "high" | "low";
  readonly provenance: "synctex";
}

/** Complete model-readable projection of one canonical Review Item. */
export interface StructuredReviewItem {
  readonly id: string;
  readonly intent: ReviewItem["kind"];
  readonly pageIndex: number;
  readonly pageRange?: {
    readonly firstPageIndex: number;
    readonly lastPageIndex: number;
  };
  readonly coordinates: {
    readonly rect: Record<string, number>;
    readonly segmentRects?: readonly Record<string, number>[];
    readonly pages?: readonly {
      readonly pageIndex: number;
      readonly rect: Record<string, number>;
      readonly segmentRects: readonly Record<string, number>[];
    }[];
  };
  readonly anchor:
    | { readonly kind: "selection"; readonly quote: string; readonly prefix: string; readonly suffix: string }
    | { readonly kind: "caret"; readonly leftContext: string; readonly rightContext: string }
    | { readonly kind: "page"; readonly nearbyText?: string };
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly sourceHint?: SourceHint;
  readonly reconciliation?: {
    readonly baseGeneration: number;
    readonly revision: number;
    readonly disposition: ReviewAnchorDisposition;
  };
}

function string(item: ReviewItem, key: string): string {
  const value = item.payload[key];
  if (typeof value !== "string") throw new Error(`Review item ${item.id} is missing ${key}`);
  return value;
}

function payload(item: ReviewItem): Record<string, JsonValue> {
  switch (item.kind) {
    case "replace":
    case "insert":
      return { proposedText: string(item, "proposedText") };
    case "highlight":
      return typeof item.payload.comment === "string"
        ? { comment: item.payload.comment }
        : {};
    case "pageNote":
      return { comment: string(item, "comment") };
    case "delete":
      return {};
  }
}

export function projectStructuredReviewItem(
  item: ReviewItem,
  sourceHint?: SourceHint,
): StructuredReviewItem {
  const evidence = anchorEvidenceFromReviewItem(item);
  const geometry = evidence.rect;
  const segmentRects = evidence.kind === "selection" ? evidence.segmentRects : undefined;
  const selectionPages = evidence.kind === "selection"
    ? normalizeReviewSelectionAnchor(evidence).pages
    : undefined;
  const coordinates = {
    rect: { ...geometry },
    ...(segmentRects === undefined ? {} : { segmentRects: segmentRects.map((rect) => ({ ...rect })) }),
    ...(selectionPages === undefined ? {} : {
      pages: selectionPages.map((page) => ({
        pageIndex: page.pageIndex,
        rect: { ...page.rect },
        segmentRects: page.segmentRects.map((rect) => ({ ...rect })),
      })),
    }),
  };
  const anchor: StructuredReviewItem["anchor"] = item.kind === "insert"
    ? { kind: "caret", leftContext: string(item, "leftContext"), rightContext: string(item, "rightContext") }
    : item.kind === "pageNote"
      ? { kind: "page", ...(typeof item.payload.nearbyText === "string" ? { nearbyText: item.payload.nearbyText } : {}) }
      : { kind: "selection", quote: string(item, "quote"), prefix: string(item, "prefix"), suffix: string(item, "suffix") };
  return {
    id: item.id,
    intent: item.kind,
    pageIndex: evidence.pageIndex,
    pageRange: {
      firstPageIndex: selectionPages?.[0]?.pageIndex ?? evidence.pageIndex,
      lastPageIndex: selectionPages?.at(-1)?.pageIndex ?? evidence.pageIndex,
    },
    coordinates,
    anchor,
    payload: payload(item),
    ...(item.reconciliation === undefined ? {} : {
      reconciliation: {
        baseGeneration: item.reconciliation.baseGeneration,
        revision: item.reconciliation.revision,
        disposition: item.reconciliation.disposition,
      },
    }),
    ...(sourceHint === undefined ? {} : { sourceHint }),
  };
}
