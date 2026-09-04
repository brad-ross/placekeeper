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

import type { ReviewAnnotation } from '../../core/src/pdf-writer.js';

const ENCRYPT_MARKER = new TextEncoder().encode('/Encrypt');
const DOC_MDP_MARKER = new TextEncoder().encode('/DocMDP');

export type SupportedOutputAnnotation =
  | PdfStrikeOutAnnoObject
  | PdfHighlightAnnoObject
  | PdfTextAnnoObject;

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
