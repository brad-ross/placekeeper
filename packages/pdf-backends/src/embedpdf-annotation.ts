import {
  PdfAnnotationName,
  PdfAnnotationSubtype,
  type PdfAnnotationObject,
  type PdfAnnotationFlagName,
  type PdfHighlightAnnoObject,
  type PdfStrikeOutAnnoObject,
  type PdfTextAnnoObject,
  type Rect,
} from '@embedpdf/models';

import { PdfWriterError, type ReviewAnnotation } from '../../core/src/pdf-writer.js';
import {
  inspectPortableAnnotations,
  type VisiblePortableAnnotation,
} from '../../core/src/portable-annotation.js';
import type { ReviewItem } from '../../core/src/review-model.js';

const ENCRYPT_MARKER = new TextEncoder().encode('/Encrypt');
const DOC_MDP_MARKER = new TextEncoder().encode('/DocMDP');

export type SupportedOutputAnnotation =
  | PdfStrikeOutAnnoObject
  | PdfHighlightAnnoObject
  | PdfTextAnnoObject;

export interface PortablePdfAnnotationCatalog {
  readonly items: readonly ReviewItem[];
  readonly owned: readonly {
    readonly pageIndex: number;
    readonly annotation: PdfAnnotationObject;
    readonly item: ReviewItem;
  }[];
}

export function pdfAnnotationIdentity(pageIndex: number, annotationId: string): string {
  return `${pageIndex}:${annotationId}`;
}

export function embedPdfSubtypeName(type: PdfAnnotationSubtype): string {
  switch (type) {
    case PdfAnnotationSubtype.STRIKEOUT:
      return 'strikeOut';
    case PdfAnnotationSubtype.FREETEXT:
      return 'freeText';
    case PdfAnnotationSubtype.FILEATTACHMENT:
      return 'fileAttachment';
    default:
      return PdfAnnotationSubtype[type]?.toLowerCase() ?? 'unknown';
  }
}

export function visibleEmbedPdfAnnotation(
  annotation: PdfAnnotationObject,
  pageIndex: number,
): VisiblePortableAnnotation {
  const segmentRects =
    'segmentRects' in annotation && Array.isArray(annotation.segmentRects)
      ? annotation.segmentRects
      : undefined;
  return {
    id: annotation.id,
    pageIndex,
    subtype: embedPdfSubtypeName(annotation.type),
    contents: annotation.contents ?? '',
    ...(annotation.author === undefined ? {} : { author: annotation.author }),
    rect: annotation.rect,
    ...(segmentRects === undefined ? {} : { segmentRects }),
  };
}

export function portableItemsFromAnnotationPages(
  annotationPages: readonly (readonly PdfAnnotationObject[])[],
  options: { readonly invalidMetadata: 'reject' | 'foreign' } = { invalidMetadata: 'reject' },
): PortablePdfAnnotationCatalog {
  const flattened = annotationPages.flatMap((annotations, pageIndex) =>
    annotations.map((annotation) => ({ pageIndex, annotation })),
  );
  const inspected = inspectPortableAnnotations(flattened.map(({ pageIndex, annotation }) => ({
    custom: annotation.custom,
    visible: visibleEmbedPdfAnnotation(annotation, pageIndex),
  })));
  if (inspected.status === 'invalid') {
    if (options.invalidMetadata === 'foreign') return { items: [], owned: [] };
    throw new PdfWriterError(
      'invalid-portable-annotation',
      `Placekeeper portable annotation metadata is incomplete or inconsistent (${inspected.reason}).`,
    );
  }
  if (inspected.status === 'foreign') return { items: [], owned: [] };
  return {
    items: [...inspected.items],
    owned: inspected.ownedCandidates.map(({ candidateIndex, item }) => ({
      ...flattened[candidateIndex]!,
      item,
    })),
  };
}

export function canonicalEmbedPdfValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalEmbedPdfValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalEmbedPdfValue(entry)]),
    );
  }
  return value;
}

/**
 * Captures every model-exposed annotation property except `id`. PDFium creates
 * a fresh runtime ID when a PDF annotation has no persistent /NM entry, so the
 * ID cannot participate in reopen preservation checks. Page location remains
 * part of the signature even if a future model shape omits `pageIndex`.
 */
export function annotationPreservationSignature(
  annotation: PdfAnnotationObject,
  pageIndex: number,
): string {
  const annotationWithoutRuntimeId = Object.fromEntries(
    Object.entries(annotation).filter(([key]) => key !== 'id'),
  );
  return JSON.stringify(canonicalEmbedPdfValue({
    pageIndex,
    annotation: annotationWithoutRuntimeId,
  }));
}

function containsBytes(bytes: Uint8Array, pattern: Uint8Array): boolean {
  const firstByte = pattern[0];
  if (firstByte === undefined) return true;
  const lastStart = bytes.byteLength - pattern.byteLength;
  let start = bytes.indexOf(firstByte);
  while (start !== -1 && start <= lastStart) {
    let matches = true;
    for (let offset = 0; offset < pattern.byteLength; offset += 1) {
      if (bytes[start + offset] !== pattern[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
    start = bytes.indexOf(firstByte, start + 1);
  }
  return false;
}

export function pdfRewriteMarkers(
  bytes: Uint8Array,
): { readonly encrypted: boolean; readonly docMdp: boolean } {
  return {
    encrypted: containsBytes(bytes, ENCRYPT_MARKER),
    docMdp: containsBytes(bytes, DOC_MDP_MARKER),
  };
}

export function toEmbedPdfRect(rect: ReviewAnnotation['rect']): Rect {
  return {
    origin: { x: rect.x, y: rect.y },
    size: { width: rect.width, height: rect.height },
  };
}

function common(annotation: ReviewAnnotation, type: PdfAnnotationSubtype) {
  return {
    id: annotation.id,
    type,
    pageIndex: annotation.pageIndex,
    rect: toEmbedPdfRect(annotation.rect),
    contents: annotation.contents,
    author: annotation.author,
    created: new Date(annotation.createdAt),
    modified: new Date(annotation.modifiedAt),
    flags: ['print'] as PdfAnnotationFlagName[],
    ...(annotation.custom === undefined ? {} : { custom: annotation.custom }),
  };
}

export function mapReviewAnnotationToEmbedPdf(
  annotation: ReviewAnnotation,
): SupportedOutputAnnotation {
  const segmentRects = annotation.quadPoints?.map(toEmbedPdfRect)
    ?? [toEmbedPdfRect(annotation.rect)];
  switch (annotation.kind) {
    case 'replace':
    case 'delete':
      return {
        ...common(annotation, PdfAnnotationSubtype.STRIKEOUT),
        type: PdfAnnotationSubtype.STRIKEOUT,
        strokeColor: '#d32f2f',
        opacity: 1,
        segmentRects,
      };
    case 'insert':
      return {
        ...common(annotation, PdfAnnotationSubtype.TEXT),
        type: PdfAnnotationSubtype.TEXT,
        strokeColor: '#1565c0',
        opacity: 1,
        name: PdfAnnotationName.Insert,
      };
    case 'highlight':
      return {
        ...common(annotation, PdfAnnotationSubtype.HIGHLIGHT),
        type: PdfAnnotationSubtype.HIGHLIGHT,
        strokeColor: '#ffd54f',
        opacity: 0.45,
        segmentRects,
      };
    case 'pageNote':
      return {
        ...common(annotation, PdfAnnotationSubtype.TEXT),
        type: PdfAnnotationSubtype.TEXT,
        strokeColor: '#ffc107',
        opacity: 1,
        name: PdfAnnotationName.Note,
      };
  }
}
