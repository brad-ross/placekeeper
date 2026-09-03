import type { ReviewAnnotation } from "./pdf-writer.js";
import type {
  ReviewItem,
  ReviewItemKind,
  ReviewSourceIdentity,
  ReviewState,
  ReviewWorkflowMode,
} from "./review-model.js";
import { canonicalizeReviewItem } from "./review-model.js";
import {
  assertReviewItem,
  InvalidReviewCommandError,
  MAX_REVIEW_SELECTION_SEGMENTS,
} from "./review-reducer.js";
export {
  assertPortableAnnotationGroupWritable,
  PORTABLE_ANNOTATION_MAX_BYTES,
  serializePortableAnnotationGroup,
} from './grouped-annotation-envelope.js';
import {
  PORTABLE_ANNOTATION_MAX_BYTES,
  PORTABLE_ANNOTATION_TOO_LARGE_MESSAGE,
} from './grouped-annotation-envelope.js';

export const PORTABLE_ANNOTATION_AUTHOR = "Placekeeper";
const PORTABLE_ANNOTATION_OWNER = "placekeeper";
const MAX_DEPTH = 12;
const MAX_PORTABLE_ARRAY_ENTRIES = MAX_REVIEW_SELECTION_SEGMENTS;
const MAX_OBJECT_ENTRIES = 128;
const MAX_NODES = 4_096;
const MAX_STRING_LENGTH = 16 * 1024;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const KINDS = new Set<ReviewItemKind>([
  "replace",
  "delete",
  "insert",
  "highlight",
  "pageNote",
]);

interface PortableProjection {
  readonly id: string;
  readonly pageIndex: number;
  readonly subtype: string;
  readonly contents: string;
  readonly author: string;
  readonly rect: EngineRect;
  readonly segmentRects?: readonly EngineRect[];
}

interface PortableAnnotationEnvelope {
  readonly schemaVersion: 2;
  readonly owner: typeof PORTABLE_ANNOTATION_OWNER;
  readonly itemId: string;
  readonly item: ReviewItem;
  readonly projection: PortableProjection;
}

export interface PortableAnnotationCustom {
  readonly placekeeper: PortableAnnotationEnvelope;
}

interface EngineRect {
  readonly origin: { readonly x: number; readonly y: number };
  readonly size: { readonly width: number; readonly height: number };
}

export interface VisiblePortableAnnotation {
  readonly id: string;
  readonly pageIndex: number;
  readonly subtype: string;
  readonly contents: string;
  readonly author?: string;
  readonly rect: EngineRect;
  readonly segmentRects?: readonly EngineRect[];
}

export type PortableAnnotationInspection =
  | { readonly status: "foreign" }
  | { readonly status: "invalid"; readonly reason: string }
  | {
      readonly status: "owned";
      readonly item: ReviewItem;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasSafeShape(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
  budget.nodes += 1;
  if (depth > MAX_DEPTH || budget.nodes > MAX_NODES) return false;
  if (typeof value === "string") return value.length <= MAX_STRING_LENGTH;
  if (value === null || typeof value === "boolean" || isFiniteNumber(value)) return true;
  if (Array.isArray(value)) {
    if (value.length > MAX_PORTABLE_ARRAY_ENTRIES) return false;
    return value.every((entry) => hasSafeShape(entry, depth + 1, budget));
  }
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length > MAX_OBJECT_ENTRIES ||
    keys.some((key) => FORBIDDEN_KEYS.has(key))
  ) return false;
  return keys.every((key) => hasSafeShape(value[key], depth + 1, budget));
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function isRect(value: unknown): value is EngineRect {
  return (
    isRecord(value) &&
    isRecord(value.origin) &&
    isRecord(value.size) &&
    isFiniteNumber(value.origin.x) &&
    isFiniteNumber(value.origin.y) &&
    isFiniteNumber(value.size.width) &&
    isFiniteNumber(value.size.height) &&
    value.size.width >= 0 &&
    value.size.height >= 0
  );
}

function isReviewItem(value: unknown): value is ReviewItem {
  if (!isRecord(value)) return false;
  const shallowlyValid = (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 128 &&
    KINDS.has(value.kind as ReviewItemKind) &&
    Number.isSafeInteger(value.pageIndex) &&
    (value.pageIndex as number) >= 0 &&
    isIsoDate(value.createdAt) &&
    isIsoDate(value.updatedAt) &&
    isRecord(value.payload)
  );
  if (!shallowlyValid) return false;
  try {
    assertReviewItem(value as unknown as ReviewItem, {
      maxSelectionSegments: MAX_PORTABLE_ARRAY_ENTRIES,
    });
    return true;
  } catch {
    return false;
  }
}

function subtypeFor(kind: ReviewItemKind): string {
  switch (kind) {
    case "replace":
    case "delete":
      return "strikeOut";
    case "highlight":
      return "highlight";
    case "insert":
    case "pageNote":
      return "text";
  }
}

function engineRect(rect: ReviewAnnotation["rect"]): EngineRect {
  return {
    origin: { x: rect.x, y: rect.y },
    size: { width: rect.width, height: rect.height },
  };
}

function projectionFor(item: ReviewItem, annotation: ReviewAnnotation): PortableProjection {
  return {
    id: annotation.id,
    pageIndex: annotation.pageIndex,
    subtype: subtypeFor(item.kind),
    contents: annotation.contents,
    author: annotation.author,
    rect: engineRect(annotation.rect),
    ...(annotation.quadPoints === undefined
      ? {}
      : { segmentRects: annotation.quadPoints.map(engineRect) }),
  };
}

function rectMatches(
  expected: EngineRect,
  actual: EngineRect,
  originTolerance: number,
  sizeTolerance = originTolerance,
): boolean {
  return (
    Math.abs(expected.origin.x - actual.origin.x) <= originTolerance &&
    Math.abs(expected.origin.y - actual.origin.y) <= originTolerance &&
    Math.abs(expected.size.width - actual.size.width) <= sizeTolerance &&
    Math.abs(expected.size.height - actual.size.height) <= sizeTolerance
  );
}

function projectionMatches(
  item: ReviewItem,
  expected: PortableProjection,
  visible: VisiblePortableAnnotation,
): boolean {
  // PDFium expands text-note icons and may shift their origin by one icon
  // width on rotated pages. All other semantic evidence remains exact.
  const textIcon = item.kind === "insert" || item.kind === "pageNote";
  const originTolerance = textIcon ? 20.01 : 0.01;
  const sizeTolerance = item.kind === "insert" ? 6.01 : item.kind === "pageNote" ? 2.01 : 0.01;
  const expectedSegments = expected.segmentRects;
  const visibleSegments = visible.segmentRects;
  return (
    expected.id === visible.id &&
    expected.pageIndex === visible.pageIndex &&
    expected.subtype === visible.subtype &&
    expected.contents === visible.contents &&
    expected.author === (visible.author ?? "") &&
    rectMatches(expected.rect, visible.rect, originTolerance, sizeTolerance) &&
    (expectedSegments === undefined
      ? visibleSegments === undefined
      : visibleSegments !== undefined &&
        expectedSegments.length === visibleSegments.length &&
        expectedSegments.every((rect, index) => rectMatches(rect, visibleSegments[index]!, 0.01)))
  );
}

function payloadRect(value: unknown): EngineRect | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(isFiniteNumber)) return undefined;
  return {
    origin: { x: x as number, y: y as number },
    size: { width: width as number, height: height as number },
  };
}

function itemMatchesProjection(item: ReviewItem, projection: PortableProjection): boolean {
  const expectedRect = payloadRect(item.payload.rect) ?? payloadRect(item.payload.position);
  if (expectedRect === undefined) return false;
  const expectedContents = item.kind === "replace" || item.kind === "insert"
    ? item.payload.proposedText
    : item.payload.comment ?? "";
  const expectedSegments = Array.isArray(item.payload.segmentRects)
    ? item.payload.segmentRects.map(payloadRect)
    : undefined;
  return (
    projection.id === item.id &&
    projection.pageIndex === item.pageIndex &&
    projection.subtype === subtypeFor(item.kind) &&
    projection.contents === expectedContents &&
    rectMatches(projection.rect, expectedRect, 0.000_001) &&
    (expectedSegments === undefined
      ? projection.segmentRects === undefined
      : projection.segmentRects !== undefined &&
        expectedSegments.every((rect) => rect !== undefined) &&
        expectedSegments.length === projection.segmentRects.length &&
        expectedSegments.every((rect, index) =>
          rectMatches(projection.segmentRects![index]!, rect!, 0.000_001)))
  );
}

function isProjection(value: unknown): value is PortableProjection {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Number.isSafeInteger(value.pageIndex) &&
    typeof value.subtype === "string" &&
    typeof value.contents === "string" &&
    typeof value.author === "string" &&
    isRect(value.rect) &&
    (value.segmentRects === undefined ||
      (Array.isArray(value.segmentRects) && value.segmentRects.every(isRect)))
  );
}

export function isPortableAnnotationAuthor(author: string): boolean {
  return author === PORTABLE_ANNOTATION_AUTHOR;
}

export function createPortableAnnotationCustom(
  item: ReviewItem,
  annotation: ReviewAnnotation,
): PortableAnnotationCustom {
  return {
    placekeeper: {
      schemaVersion: 2,
      owner: PORTABLE_ANNOTATION_OWNER,
      itemId: item.id,
      item,
      projection: projectionFor(item, annotation),
    },
  };
}

export function assertPortableAnnotationWritable(annotation: ReviewAnnotation): void {
  if (!hasSafeShape(annotation.custom)) {
    throw new InvalidReviewCommandError(
      "This annotation is too complex to preserve as editable metadata. Shorten the selection and try again.",
    );
  }
  if (
    new TextEncoder().encode(JSON.stringify(annotation.custom)).byteLength >
      PORTABLE_ANNOTATION_MAX_BYTES
  ) {
    throw new InvalidReviewCommandError(
      PORTABLE_ANNOTATION_TOO_LARGE_MESSAGE,
    );
  }
}

export function inspectPortableAnnotation(
  custom: unknown,
  visible: VisiblePortableAnnotation,
  options: { readonly visibleIdCount?: number } = {},
): PortableAnnotationInspection {
  if (!isRecord(custom) || !("placekeeper" in custom)) return { status: "foreign" };
  if (!hasSafeShape(custom)) return { status: "invalid", reason: "unsafe-shape" };
  const envelope = custom.placekeeper;
  if (!isRecord(envelope)) return { status: "invalid", reason: "invalid-envelope" };
  if (
    envelope.schemaVersion !== 2 ||
    envelope.owner !== PORTABLE_ANNOTATION_OWNER
  ) {
    return { status: "invalid", reason: "unsupported-schema" };
  }
  if (!isReviewItem(envelope.item) || !isProjection(envelope.projection)) {
    return { status: "invalid", reason: "invalid-payload" };
  }
  if (
    options.visibleIdCount !== undefined && options.visibleIdCount !== 1 ||
    envelope.itemId !== envelope.item.id ||
    envelope.item.id !== visible.id ||
    envelope.item.pageIndex !== visible.pageIndex ||
    envelope.projection.id !== visible.id ||
    envelope.projection.pageIndex !== visible.pageIndex ||
    !itemMatchesProjection(envelope.item, envelope.projection) ||
    !projectionMatches(envelope.item, envelope.projection, visible)
  ) {
    return { status: "invalid", reason: "projection-mismatch" };
  }
  if (!isPortableAnnotationAuthor(envelope.projection.author)) {
    return { status: "invalid", reason: "unsupported-author" };
  }
  return {
    status: "owned",
    item: envelope.item,
  };
}

export function inspectProjectedPortableAnnotation(
  annotation: ReviewAnnotation,
): PortableAnnotationInspection {
  return inspectPortableAnnotation(annotation.custom, {
    id: annotation.id,
    pageIndex: annotation.pageIndex,
    subtype: subtypeFor(annotation.kind),
    contents: annotation.contents,
    author: annotation.author,
    rect: engineRect(annotation.rect),
    ...(annotation.quadPoints === undefined
      ? {}
      : { segmentRects: annotation.quadPoints.map(engineRect) }),
  });
}

export function decodePortableAnnotationJson(raw: string): PortableAnnotationInspection {
  if (new TextEncoder().encode(raw).byteLength > PORTABLE_ANNOTATION_MAX_BYTES) {
    return { status: "invalid", reason: "too-large" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!hasSafeShape(parsed)) return { status: "invalid", reason: "unsafe-shape" };
    return isRecord(parsed) && "placekeeper" in parsed
      ? { status: "invalid", reason: "requires-visible-annotation" }
      : { status: "foreign" };
  } catch {
    return { status: "invalid", reason: "invalid-json" };
  }
}

export function createImportedReviewState(input: {
  readonly sessionId: string;
  readonly source: ReviewSourceIdentity;
  readonly sourceRootId?: string;
  readonly items: readonly ReviewItem[];
  readonly workflowMode?: ReviewWorkflowMode;
  readonly documentGeneration?: number;
}): ReviewState {
  const mode = input.workflowMode ?? "standard";
  const documentGeneration = input.documentGeneration ?? 1;
  return {
    schemaVersion: 2,
    sessionId: input.sessionId,
    source: input.source,
    ...(input.sourceRootId === undefined ? {} : { sourceRootId: input.sourceRootId }),
    revision: 0,
    lifecycle: "active",
    items: mode === "generated-output"
      ? input.items.map((item) => canonicalizeReviewItem(item, {
          ownerViewId: item.reconciliation?.ownerViewId ?? "portable-import",
          baseGeneration: item.reconciliation?.baseGeneration ?? documentGeneration,
        }))
      : [...input.items],
    workflow: {
      schemaVersion: 1,
      mode,
      documentRole: mode === "generated-output" ? "generated-output" : "source-pdf",
      documentGeneration,
      freshness: "current",
      historyBoundary: 0,
    },
    pendingDrafts: [],
    discardAudit: [],
    history: [],
    historyCursor: 0,
  };
}
