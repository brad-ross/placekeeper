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
  PORTABLE_ANNOTATION_UNSAFE_SHAPE_MESSAGE,
  portableAnnotationProjectionId,
  serializePortableAnnotationGroup,
  type SerializedPortableAnnotationChild,
} from './grouped-annotation-envelope.js';
import { hasSafePortableAnnotationShape } from './portable-annotation-shape.js';

export const PORTABLE_ANNOTATION_AUTHOR = "Placekeeper";
const PORTABLE_ANNOTATION_OWNER = "placekeeper";
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

type GroupedPortableAnnotationEnvelope =
  SerializedPortableAnnotationChild["custom"]["placekeeper"];
type GroupedPortableProjection = GroupedPortableAnnotationEnvelope["projection"];

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

export interface PortableAnnotationCandidate {
  readonly custom: unknown;
  readonly visible: VisiblePortableAnnotation;
}

export type PortableAnnotationCollectionInspection =
  | { readonly status: "foreign" }
  | { readonly status: "invalid"; readonly reason: string }
  | {
      readonly status: "owned";
      readonly items: readonly ReviewItem[];
      readonly ownedIndexes: readonly number[];
      readonly ownedCandidates: readonly {
        readonly candidateIndex: number;
        readonly item: ReviewItem;
      }[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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

function isPdfRect(value: unknown): value is ReviewAnnotation["rect"] {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    value.width > 0 &&
    value.height > 0
  );
}

function canonicalJson(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (isRecord(entry)) {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return entry;
  };
  return JSON.stringify(canonical(value));
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
      maxSelectionSegments: MAX_REVIEW_SELECTION_SEGMENTS,
    });
    return true;
  } catch {
    return false;
  }
}

function subtypeFor(kind: ReviewItemKind): string {
  switch (kind) {
    case "pdfAnnotation": return "unknown";
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
  // A real insertion starts as a 2pt caret, which PDFium persists as a 20pt
  // Text icon. Keep the allowance bounded to that observed 18pt expansion.
  const sizeTolerance = item.kind === "insert" ? 18.01 : item.kind === "pageNote" ? 2.01 : 0.01;
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

function isGroupedProjection(value: unknown): value is GroupedPortableProjection {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Number.isSafeInteger(value.pageIndex) &&
    (value.pageIndex as number) >= 0 &&
    (value.subtype === "strikeOut" || value.subtype === "highlight") &&
    typeof value.contents === "string" &&
    typeof value.author === "string" &&
    isPdfRect(value.rect) &&
    Array.isArray(value.segmentRects) &&
    value.segmentRects.length > 0 &&
    value.segmentRects.every(isPdfRect) &&
    typeof value.quote === "string" &&
    value.quote.length > 0 &&
    typeof value.prefix === "string" &&
    typeof value.suffix === "string"
  );
}

function groupedEnvelope(value: unknown): GroupedPortableAnnotationEnvelope | undefined {
  if (!isRecord(value) || !hasSafePortableAnnotationShape(value)) return undefined;
  const envelope = value.placekeeper;
  if (
    !isRecord(envelope) ||
    envelope.schemaVersion !== 3 ||
    envelope.owner !== PORTABLE_ANNOTATION_OWNER ||
    typeof envelope.itemId !== "string" ||
    envelope.itemId.length === 0 ||
    envelope.itemId.length > 128 ||
    typeof envelope.projectionId !== "string" ||
    !Number.isSafeInteger(envelope.projectionIndex) ||
    (envelope.projectionIndex as number) < 0 ||
    !Number.isSafeInteger(envelope.projectionCount) ||
    (envelope.projectionCount as number) < 2 ||
    !isRecord(envelope.item) ||
    !isRecord(envelope.item.payload) ||
    !isGroupedProjection(envelope.projection)
  ) return undefined;
  return envelope as unknown as GroupedPortableAnnotationEnvelope;
}

function isGroupedEnvelopeCandidate(custom: unknown): boolean {
  if (!isRecord(custom)) return false;
  const envelope = custom.placekeeper;
  return isRecord(envelope) && (
    envelope.schemaVersion === 3 ||
    "projectionIndex" in envelope ||
    "projectionCount" in envelope ||
    "projectionId" in envelope
  );
}

function visibleMatchesGroupedProjection(
  projection: GroupedPortableProjection,
  visible: VisiblePortableAnnotation,
): boolean {
  const expectedRect = engineRect(projection.rect);
  const expectedSegments = projection.segmentRects.map(engineRect);
  return (
    projection.id === visible.id &&
    projection.pageIndex === visible.pageIndex &&
    projection.subtype === visible.subtype &&
    projection.contents === visible.contents &&
    projection.author === (visible.author ?? "") &&
    rectMatches(expectedRect, visible.rect, 0.01) &&
    visible.segmentRects?.length === expectedSegments.length &&
    expectedSegments.every((rect, index) =>
      rectMatches(rect, visible.segmentRects![index]!, 0.01))
  );
}

function reconstructGroupedItem(
  children: readonly GroupedPortableAnnotationEnvelope[],
): ReviewItem | undefined {
  const first = children[0]?.projection;
  const last = children.at(-1)?.projection;
  const portableItem = children[0]?.item;
  if (first === undefined || last === undefined || portableItem === undefined) return undefined;
  const copyRect = (rect: ReviewAnnotation["rect"]) => ({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });
  const item: ReviewItem = {
    ...portableItem,
    pageIndex: first.pageIndex,
    payload: {
      ...portableItem.payload,
      prefix: first.prefix,
      suffix: last.suffix,
      rect: copyRect(first.rect),
      segmentRects: first.segmentRects.map(copyRect),
      pages: children.map(({ projection }) => ({
        pageIndex: projection.pageIndex,
        quote: projection.quote,
        prefix: projection.prefix,
        suffix: projection.suffix,
        rect: copyRect(projection.rect),
        segmentRects: projection.segmentRects.map(copyRect),
      })),
    },
  };
  try {
    assertReviewItem(item, { maxSelectionSegments: MAX_REVIEW_SELECTION_SEGMENTS });
    return item;
  } catch {
    return undefined;
  }
}

function withImportedAuthor(item: ReviewItem, author: string): ReviewItem {
  const { importedAnnotationAuthor: _untrusted, ...clean } = item;
  return author === PORTABLE_ANNOTATION_AUTHOR ? clean : { ...clean, importedAnnotationAuthor: author };
}

export function isPortableAnnotationAuthor(author: string): boolean {
  return author === PORTABLE_ANNOTATION_AUTHOR;
}

export function createPortableAnnotationCustom(
  item: ReviewItem,
  annotation: ReviewAnnotation,
): PortableAnnotationCustom {
  const { importedAnnotationAuthor: _importedAuthor, ...portableItem } = item;
  return {
    placekeeper: {
      schemaVersion: 2,
      owner: PORTABLE_ANNOTATION_OWNER,
      itemId: item.id,
      item: portableItem,
      projection: projectionFor(item, annotation),
    },
  };
}

export function assertPortableAnnotationWritable(annotation: ReviewAnnotation): void {
  if (annotation.kind === "pdfAnnotation") return;
  if (!hasSafePortableAnnotationShape(annotation.custom)) {
    throw new InvalidReviewCommandError(
      PORTABLE_ANNOTATION_UNSAFE_SHAPE_MESSAGE,
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
  if (!hasSafePortableAnnotationShape(custom)) return { status: "invalid", reason: "unsafe-shape" };
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
  return {
    status: "owned",
    item: withImportedAuthor(envelope.item, envelope.projection.author),
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

/**
 * Validate the complete physical annotation inventory before exposing any
 * portable semantic item. V3 children are accepted in any enumeration order,
 * but a malformed or incomplete group invalidates the collection as a whole.
 */
export function inspectPortableAnnotations(
  candidates: readonly PortableAnnotationCandidate[],
): PortableAnnotationCollectionInspection {
  const projectionIdentity = ({ id, pageIndex }: VisiblePortableAnnotation) =>
    `${pageIndex}:${id}`;
  const visibleIdCounts = new Map<string, number>();
  for (const { visible } of candidates) {
    const identity = projectionIdentity(visible);
    visibleIdCounts.set(identity, (visibleIdCounts.get(identity) ?? 0) + 1);
  }

  const groups = new Map<string, Array<{
    readonly candidateIndex: number;
    readonly envelope: GroupedPortableAnnotationEnvelope;
  }>>();
  const orderedEntries: Array<
    | { readonly kind: "v2"; readonly item: ReviewItem; readonly candidateIndex: number }
    | { readonly kind: "v3"; readonly itemId: string }
  > = [];
  const seenGroupOrder = new Set<string>();
  const ownedIndexes: number[] = [];

  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (isGroupedEnvelopeCandidate(candidate.custom)) {
      if (
        new TextEncoder().encode(JSON.stringify(candidate.custom)).byteLength >
          PORTABLE_ANNOTATION_MAX_BYTES
      ) {
        return { status: "invalid", reason: "too-large" };
      }
      const envelope = groupedEnvelope(candidate.custom);
      if (envelope === undefined) {
        return { status: "invalid", reason: "invalid-group-child" };
      }
      if ((visibleIdCounts.get(projectionIdentity(candidate.visible)) ?? 0) !== 1) {
        return { status: "invalid", reason: "duplicate-projection-id" };
      }
      if (!visibleMatchesGroupedProjection(envelope.projection, candidate.visible)) {
        return { status: "invalid", reason: "projection-mismatch" };
      }
      const group = groups.get(envelope.itemId) ?? [];
      group.push({ candidateIndex, envelope });
      groups.set(envelope.itemId, group);
      ownedIndexes.push(candidateIndex);
      if (!seenGroupOrder.has(envelope.itemId)) {
        seenGroupOrder.add(envelope.itemId);
        orderedEntries.push({ kind: "v3", itemId: envelope.itemId });
      }
      continue;
    }

    const inspected = inspectPortableAnnotation(
      candidate.custom,
      candidate.visible,
      { visibleIdCount: visibleIdCounts.get(projectionIdentity(candidate.visible)) ?? 0 },
    );
    if (inspected.status === "owned") {
      orderedEntries.push({ kind: "v2", item: inspected.item, candidateIndex });
      ownedIndexes.push(candidateIndex);
    }
  }

  const groupedItems = new Map<string, ReviewItem>();
  for (const [itemId, entries] of groups) {
    const children = entries
      .map(({ envelope }) => envelope)
      .toSorted((left, right) => left.projectionIndex - right.projectionIndex);
    const projectionCount = children[0]?.projectionCount;
    if (
      projectionCount === undefined ||
      children.length !== projectionCount ||
      children.some((child, projectionIndex) =>
        child.itemId !== itemId ||
        child.item.id !== itemId ||
        child.projectionCount !== projectionCount ||
        child.projectionIndex !== projectionIndex ||
        child.projectionId !== child.projection.id ||
        child.projectionId !== portableAnnotationProjectionId(
          itemId,
          projectionIndex,
          projectionCount,
        ) ||
        (projectionIndex > 0 &&
          child.projection.pageIndex <= children[projectionIndex - 1]!.projection.pageIndex)
      )
    ) {
      return { status: "invalid", reason: "incomplete-group" };
    }
    const canonicalItem = canonicalJson(children[0]!.item);
    if (children.some(({ item }) => canonicalJson(item) !== canonicalItem)) {
      return { status: "invalid", reason: "canonical-payload-mismatch" };
    }
    const item = reconstructGroupedItem(children);
    if (item === undefined) {
      return { status: "invalid", reason: "invalid-group-item" };
    }
    const expected = serializePortableAnnotationGroup(item, children[0]!.projection.author);
    if (
      expected.length !== children.length ||
      expected.some((child, index) =>
        canonicalJson(child.custom) !== canonicalJson({ placekeeper: children[index] }))
    ) {
      return { status: "invalid", reason: "group-evidence-mismatch" };
    }
    groupedItems.set(itemId, withImportedAuthor(item, children[0]!.projection.author));
  }

  const items = orderedEntries.map((entry) =>
    entry.kind === "v2" ? entry.item : groupedItems.get(entry.itemId)!
  );
  const itemIds = items.map(({ id }) => id);
  if (new Set(itemIds).size !== itemIds.length) {
    return { status: "invalid", reason: "duplicate-item-id" };
  }
  if (items.length === 0) return { status: "foreign" };
  const itemById = new Map(items.map((item) => [item.id, item]));
  return {
    status: "owned",
    items,
    ownedIndexes: ownedIndexes.toSorted((left, right) => left - right),
    ownedCandidates: ownedIndexes
      .toSorted((left, right) => left - right)
      .map((candidateIndex) => {
        const candidate = candidates[candidateIndex]!;
        const custom = candidate.custom as {
          readonly placekeeper?: { readonly itemId?: unknown };
        };
        const itemId = typeof custom.placekeeper?.itemId === "string"
          ? custom.placekeeper.itemId
          : candidate.visible.id;
        return { candidateIndex, item: itemById.get(itemId)! };
      }),
  };
}

export function inspectProjectedPortableAnnotations(
  annotations: readonly ReviewAnnotation[],
): PortableAnnotationCollectionInspection {
  return inspectPortableAnnotations(annotations.map((annotation) => ({
    custom: annotation.custom,
    visible: {
      id: annotation.id,
      pageIndex: annotation.pageIndex,
      subtype: subtypeFor(annotation.kind),
      contents: annotation.contents,
      author: annotation.author,
      rect: engineRect(annotation.rect),
      ...(annotation.quadPoints === undefined
        ? {}
        : { segmentRects: annotation.quadPoints.map(engineRect) }),
    },
  })));
}

/** Recover independent valid groups while leaving externally changed groups to the PDF importer. */
export function inspectPortableAnnotationsForImport(
  candidates: readonly PortableAnnotationCandidate[],
): PortableAnnotationCollectionInspection {
  const complete = inspectPortableAnnotations(candidates);
  if (complete.status !== 'invalid') return complete;
  const groups = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const envelope = isRecord(candidate.custom) ? candidate.custom.placekeeper : undefined;
    const key = isRecord(envelope) && isGroupedEnvelopeCandidate(candidate.custom) && typeof envelope.itemId === 'string'
      ? `group:${envelope.itemId}` : `single:${index}`;
    const entries = groups.get(key) ?? [];
    entries.push(index);
    groups.set(key, entries);
  });
  const valid = new Set<number>();
  for (const indices of groups.values()) {
    const inspected = inspectPortableAnnotations(indices.map((index) => candidates[index]!));
    if (inspected.status === 'owned') {
      inspected.ownedIndexes.forEach((index) => valid.add(indices[index]!));
    }
  }
  const recovered = inspectPortableAnnotations(candidates.map((candidate, index) =>
    valid.has(index) ? candidate : { ...candidate, custom: undefined }));
  return recovered.status === 'invalid' ? { status: 'foreign' } : recovered;
}

export function decodePortableAnnotationJson(raw: string): PortableAnnotationInspection {
  if (new TextEncoder().encode(raw).byteLength > PORTABLE_ANNOTATION_MAX_BYTES) {
    return { status: "invalid", reason: "too-large" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!hasSafePortableAnnotationShape(parsed)) return { status: "invalid", reason: "unsafe-shape" };
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
  // Only validated owned imports carry author evidence. Native PDF annotations
  // retain their own authors and cannot establish a document-wide name.
  const ownedAuthors = new Set(input.items
    .filter((item) => item.kind !== "pdfAnnotation")
    .map((item) => item.importedAnnotationAuthor ?? PORTABLE_ANNOTATION_AUTHOR));
  const annotationName = ownedAuthors.size === 1 ? [...ownedAuthors][0] : undefined;
  const mode = input.workflowMode ?? "standard";
  const documentGeneration = input.documentGeneration ?? 1;
  return {
    schemaVersion: 2,
    sessionId: input.sessionId,
    source: input.source,
    ...(annotationName === undefined ? {} : { annotationName }),
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
