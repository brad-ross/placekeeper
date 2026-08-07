import { documentOrderedItems } from "./annotation-projection.js";
import type { JsonValue, ReviewItem, ReviewState } from "./review-model.js";

export interface SourceHint {
  readonly path: string;
  readonly line: number;
  readonly confidence: "high" | "low";
  readonly provenance: "synctex";
}

export interface HandoffArtifact {
  readonly path: string;
  readonly sha256: string;
}

export interface HandoffItem {
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

export interface HandoffV1 {
  readonly schemaVersion: "1.0";
  readonly reviewId: string;
  readonly frozenRevision: number;
  readonly createdAt: string;
  readonly sourcePdfSha256: string;
  readonly reviewedPdf: HandoffArtifact;
  readonly sourceRoot: string;
  readonly resultDirectory: string;
  readonly revisedPdfDestination: string;
  readonly items: readonly HandoffItem[];
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

export function projectHandoffItem(item: ReviewItem, sourceHint?: SourceHint): HandoffItem {
  const geometry = object(item.payload[item.kind === "insert" || item.kind === "pageNote" ? "position" : "rect"]);
  const segmentRects = Array.isArray(item.payload.segmentRects)
    ? item.payload.segmentRects.map((value) => object(value))
    : undefined;
  const coordinates = {
    rect: geometry as Record<string, number>,
    ...(segmentRects === undefined ? {} : { segmentRects: segmentRects as Record<string, number>[] }),
  };
  const anchor: HandoffItem["anchor"] = item.kind === "insert"
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

export function createHandoff(input: {
  readonly state: Pick<ReviewState, "sessionId" | "source" | "revision" | "items">;
  readonly createdAt: string;
  readonly reviewedPdf: HandoffArtifact;
  readonly sourceRoot: string;
  readonly resultDirectory: string;
  readonly revisedPdfDestination: string;
  readonly sourceHints?: ReadonlyMap<string, SourceHint>;
}): HandoffV1 {
  if (input.state.items.length === 0) throw new Error("An empty review cannot create a Codex handoff");
  const ordered = documentOrderedItems(input.state.items);
  if (new Set(ordered.map(({ id }) => id)).size !== ordered.length) {
    throw new Error("The frozen review contains duplicate stable IDs");
  }
  return {
    schemaVersion: "1.0",
    reviewId: input.state.sessionId,
    frozenRevision: input.state.revision,
    createdAt: input.createdAt,
    sourcePdfSha256: input.state.source.digest,
    reviewedPdf: { ...input.reviewedPdf },
    sourceRoot: input.sourceRoot,
    resultDirectory: input.resultDirectory,
    revisedPdfDestination: input.revisedPdfDestination,
    items: ordered.map((item) => projectHandoffItem(item, input.sourceHints?.get(item.id))),
  };
}
