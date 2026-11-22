import { isEditablePdfAnnotationSubtype } from './native-pdf-annotation.js';
import {
  anchorEvidenceFromAnnotation,
  normalizeDocumentSelectionAnchor,
  PDF_SELECTION_PAGE_LIMIT,
  type DocumentAnchorEvidenceV1,
  type Annotation,
} from './document-model.js';
import {
  assertPortableAnnotationGroupWritable,
  PortableAnnotationGroupError,
} from './grouped-annotation-envelope.js';

export const MAX_DOCUMENT_SELECTION_SEGMENTS = 256;

export class InvalidDocumentCommandError extends Error {
  readonly code = "INVALID_DOCUMENT_COMMAND";

  constructor(message: string) {
    super(message);
    this.name = "InvalidDocumentCommandError";
  }
}

export function assertAnnotation(
  item: Annotation,
  options: { readonly maxSelectionSegments?: number } = {},
): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(item.id)) {
    throw new InvalidDocumentCommandError("Review item IDs must be UUIDs");
  }
  if (!Number.isSafeInteger(item.pageIndex) || item.pageIndex < 0) {
    throw new InvalidDocumentCommandError("Review item pageIndex must be non-negative");
  }
  if (
    !["replace", "delete", "insert", "highlight", "pageNote", "pdfAnnotation"].includes(
      item.kind,
    )
  ) {
    throw new InvalidDocumentCommandError("Review item kind is not supported");
  }
  if (!Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt))) {
    throw new InvalidDocumentCommandError("Review item dates must be valid timestamps");
  }

  const keys = Object.keys(item.payload);
  const allowedByKind: Record<Annotation['kind'], readonly string[]> = {
    replace: ['quote', 'prefix', 'suffix', 'rect', 'segmentRects', 'pages', 'pageBoundaries', 'reliable', 'proposedText'],
    delete: ['quote', 'prefix', 'suffix', 'rect', 'segmentRects', 'pages', 'pageBoundaries', 'reliable'],
    insert: ['position', 'leftContext', 'rightContext', 'reliable', 'proposedText'],
    highlight: ['quote', 'prefix', 'suffix', 'rect', 'segmentRects', 'pages', 'pageBoundaries', 'reliable', 'comment'],
    pageNote: ['position', 'comment', 'nearbyText'],
    pdfAnnotation: ['position', 'comment', 'subtype', 'author', 'contentsLocked', 'deletionLocked', 'identityProvenance', 'sourceObjectPageIndex', 'sourceObjectAnnotationIndex'],
  };
  if (keys.some((key) => !allowedByKind[item.kind].includes(key))) {
    throw new InvalidDocumentCommandError("Review item payload has unsupported fields");
  }
  const text = (field: string, allowEmpty = true) =>
    typeof item.payload[field] === 'string' && (allowEmpty || item.payload[field] !== '');
  const geometry = (field: string) => {
    const value = item.payload[field];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    return ['x', 'y', 'width', 'height'].every((key) =>
      typeof object[key] === 'number' && Number.isFinite(object[key])) &&
      (object.width as number) > 0 && (object.height as number) > 0;
  };
  const selection = () =>
    text('quote', false) && text('prefix') && text('suffix') && item.payload.reliable === true && geometry('rect') &&
    Array.isArray(item.payload.segmentRects) && item.payload.segmentRects.length > 0 &&
    item.payload.segmentRects.every((_, index) => {
      const segments = item.payload.segmentRects as unknown[];
      const value = segments[index];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      const object = value as Record<string, unknown>;
      return ['x', 'y', 'width', 'height'].every((key) =>
        typeof object[key] === 'number' && Number.isFinite(object[key])) &&
        (object.width as number) > 0 && (object.height as number) > 0;
    });

  const valid =
    (item.kind === 'pdfAnnotation' && ['contentsLocked', 'deletionLocked'].every((key) => item.payload[key] === undefined || item.payload[key] === true) &&
      (item.payload.identityProvenance === undefined || item.payload.identityProvenance === 'verified' || item.payload.identityProvenance === 'generation-ordinal') &&
      (item.payload.sourceObjectPageIndex === undefined || Number.isSafeInteger(item.payload.sourceObjectPageIndex)) &&
      (item.payload.sourceObjectAnnotationIndex === undefined || Number.isSafeInteger(item.payload.sourceObjectAnnotationIndex)) &&
      geometry('position') && text('comment') && text('author') && text('subtype') && isEditablePdfAnnotationSubtype(String(item.payload.subtype))) ||
    (item.kind === 'replace' && selection() && text('proposedText', false)) ||
    (item.kind === 'delete' && selection()) ||
    (item.kind === 'insert' && item.payload.reliable === true && geometry('position') && text('leftContext') && text('rightContext') && text('proposedText', false) && item.payload.quote === undefined) ||
    (item.kind === 'highlight' && selection() && (item.payload.comment === undefined || text('comment'))) ||
    (item.kind === 'pageNote' && geometry('position') && text('comment', false) && (item.payload.nearbyText === undefined || text('nearbyText')));
  if (!valid) throw new InvalidDocumentCommandError("Review item payload does not match its kind");
  if (item.reconciliation !== undefined) {
    const reconciliation = item.reconciliation;
    if (
      reconciliation.schemaVersion !== 1 ||
      reconciliation.ownerViewId.length === 0 ||
      !Number.isSafeInteger(reconciliation.baseGeneration) || reconciliation.baseGeneration < 0 ||
      !Number.isSafeInteger(reconciliation.revision) || reconciliation.revision < 0
    ) throw new InvalidDocumentCommandError("Review item reconciliation is malformed");
    assertDocumentAnchorEvidence(reconciliation.anchor);
    assertDisposition(reconciliation.disposition);
  }
  if (item.kind === 'replace' || item.kind === 'delete' || item.kind === 'highlight') {
    try {
      const anchor = anchorEvidenceFromAnnotation(item);
      if (anchor.kind !== 'selection') throw new Error('Selection evidence is missing');
      assertSelectionAnchorEvidence(anchor, options.maxSelectionSegments);
      assertPortableAnnotationGroupWritable(item);
    } catch (error) {
      if (error instanceof InvalidDocumentCommandError) throw error;
      if (error instanceof PortableAnnotationGroupError) {
        throw new InvalidDocumentCommandError(error.message);
      }
      throw new InvalidDocumentCommandError('Review selection evidence is malformed');
    }
  }
}

export function assertDisposition(value: { readonly kind: string; readonly generation?: number; readonly reason?: string }): void {
  if (value.kind === "resolved") {
    if (!Number.isSafeInteger(value.generation) || (value.generation ?? -1) < 0) {
      throw new InvalidDocumentCommandError("Resolved review anchors require a generation");
    }
    return;
  }
  if (!["ambiguous", "missing", "unsupported"].includes(value.kind) || typeof value.reason !== "string" || value.reason.length === 0) {
    throw new InvalidDocumentCommandError("Review anchor disposition is malformed");
  }
}

function assertRect(value: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): void {
  if (![value.x, value.y, value.width, value.height].every(Number.isFinite) || value.width <= 0 || value.height <= 0) {
    throw new InvalidDocumentCommandError("Review anchor geometry is malformed");
  }
}

function sameRect(
  left: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  right: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): boolean {
  return left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height;
}

function assertSelectionAnchorEvidence(
  anchor: Extract<DocumentAnchorEvidenceV1, { readonly kind: 'selection' }>,
  maxSelectionSegments = MAX_DOCUMENT_SELECTION_SEGMENTS,
): void {
  const canonical = normalizeDocumentSelectionAnchor(anchor);
  if (canonical.pages.length === 0) {
    throw new InvalidDocumentCommandError('Selection reconciliation evidence is incomplete');
  }
  if (canonical.pages.length > PDF_SELECTION_PAGE_LIMIT) {
    throw new InvalidDocumentCommandError(
      `Selections can span at most ${PDF_SELECTION_PAGE_LIMIT} pages. Shorten the selection and try again.`,
    );
  }
  if (canonical.pages[0]!.pageIndex !== canonical.pageIndex) {
    throw new InvalidDocumentCommandError('Selection lead page does not match its ordered page evidence');
  }
  canonical.pages.forEach((page, index) => {
    if (
      !Number.isSafeInteger(page.pageIndex) || page.pageIndex < 0 ||
      (index > 0 && page.pageIndex !== canonical.pages[index - 1]!.pageIndex + 1) ||
      typeof page.quote !== 'string' || page.quote.length === 0 ||
      typeof page.prefix !== 'string' || typeof page.suffix !== 'string' ||
      !Array.isArray(page.segmentRects) || page.segmentRects.length === 0
    ) {
      throw new InvalidDocumentCommandError('Selection pages must be non-empty and consecutive in document order');
    }
    assertRect(page.rect);
    page.segmentRects.forEach(assertRect);
  });
  if (canonical.pageBoundaries.length !== canonical.pages.length - 1) {
    throw new InvalidDocumentCommandError('Selection page boundaries do not match its page span');
  }
  canonical.pageBoundaries.forEach((boundary, index) => {
    if (
      boundary.afterPageIndex !== canonical.pages[index]!.pageIndex ||
      typeof boundary.separator !== 'string' || boundary.separator.length === 0
    ) throw new InvalidDocumentCommandError('Selection page boundaries are malformed');
  });
  const assembled = canonical.pages.map((page, index) =>
    page.quote + (canonical.pageBoundaries[index]?.separator ?? '')).join('');
  const first = canonical.pages[0]!;
  const last = canonical.pages.at(-1)!;
  if (
    assembled !== canonical.quote ||
    canonical.prefix !== first.prefix || canonical.suffix !== last.suffix ||
    !sameRect(canonical.rect, first.rect) ||
    canonical.segmentRects.length !== first.segmentRects.length ||
    canonical.segmentRects.some((rect, index) => !sameRect(rect, first.segmentRects[index]!))
  ) throw new InvalidDocumentCommandError('Selection text or lead-page evidence does not match its complete span');
  const segmentCount = canonical.pages.reduce((count, page) => count + page.segmentRects.length, 0);
  if (segmentCount > maxSelectionSegments) {
    throw new InvalidDocumentCommandError(
      `Selections can contain at most ${maxSelectionSegments} text segments. Shorten the selection and try again.`,
    );
  }
}

export function assertDocumentAnchorEvidence(anchor: DocumentAnchorEvidenceV1): void {
  if (!Number.isSafeInteger(anchor.pageIndex) || anchor.pageIndex < 0) {
    throw new InvalidDocumentCommandError("Review anchor pageIndex must be non-negative");
  }
  assertRect(anchor.rect);
  switch (anchor.kind) {
    case "selection":
      if (
        typeof anchor.quote !== "string" || anchor.quote.length === 0 ||
        typeof anchor.prefix !== "string" || typeof anchor.suffix !== "string" ||
        !Array.isArray(anchor.segmentRects) || anchor.segmentRects.length === 0
      ) throw new InvalidDocumentCommandError("Selection reconciliation evidence is incomplete");
      anchor.segmentRects.forEach(assertRect);
      assertSelectionAnchorEvidence(anchor);
      return;
    case "caret":
      if (typeof anchor.leftContext !== "string" || typeof anchor.rightContext !== "string") {
        throw new InvalidDocumentCommandError("Caret reconciliation evidence is incomplete");
      }
      return;
    case "page":
      if (anchor.nearbyText !== undefined && typeof anchor.nearbyText !== "string") {
        throw new InvalidDocumentCommandError("Page reconciliation evidence is incomplete");
      }
      return;
    default:
      throw new InvalidDocumentCommandError("Review anchor kind is not supported");
  }
}
