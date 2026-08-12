import type { JsonValue, ReviewItem } from "./review-model.js";

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
  readonly coordinates: {
    readonly rect: Record<string, number>;
    readonly segmentRects?: readonly Record<string, number>[];
  };
  readonly anchor:
    | { readonly kind: "selection"; readonly quote: string; readonly prefix: string; readonly suffix: string }
    | { readonly kind: "caret"; readonly leftContext: string; readonly rightContext: string }
    | { readonly kind: "page"; readonly nearbyText?: string };
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly sourceHint?: SourceHint;
}

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Canonical review geometry is missing");
  }
  return value;
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
  const geometry = object(item.payload[item.kind === "insert" || item.kind === "pageNote" ? "position" : "rect"]);
  const segmentRects = Array.isArray(item.payload.segmentRects)
    ? item.payload.segmentRects.map((value) => object(value))
    : undefined;
  const coordinates = {
    rect: geometry as Record<string, number>,
    ...(segmentRects === undefined ? {} : { segmentRects: segmentRects as Record<string, number>[] }),
  };
  const anchor: StructuredReviewItem["anchor"] = item.kind === "insert"
    ? { kind: "caret", leftContext: string(item, "leftContext"), rightContext: string(item, "rightContext") }
    : item.kind === "pageNote"
      ? { kind: "page", ...(typeof item.payload.nearbyText === "string" ? { nearbyText: item.payload.nearbyText } : {}) }
      : { kind: "selection", quote: string(item, "quote"), prefix: string(item, "prefix"), suffix: string(item, "suffix") };
  return {
    id: item.id,
    intent: item.kind,
    pageIndex: item.pageIndex,
    coordinates,
    anchor,
    payload: payload(item),
    ...(sourceHint === undefined ? {} : { sourceHint }),
  };
}
