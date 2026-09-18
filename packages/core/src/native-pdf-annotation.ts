import type { ReviewItem } from './review-model.js';

/** Standard reviewer annotations whose comments can be changed without redrawing them. */
const COMMENT_SUBTYPES = new Set([
  'text', 'freetext', 'line', 'square', 'circle', 'polygon', 'polyline',
  'highlight', 'underline', 'squiggly', 'strikeout', 'stamp', 'caret', 'ink',
  'fileattachment', 'sound', 'redact', 'watermark',
  'movie', 'screen', 'printermark', 'trapnet', '3d', 'richmedia',
]);

export function isEditablePdfAnnotationSubtype(subtype: string): boolean {
  return COMMENT_SUBTYPES.has(subtype.replaceAll(/[^a-z0-9]/gi, '').toLowerCase());
}

export const NATIVE_PDF_ANNOTATION_NAME_PREFIX = 'placekeeper-native:';
export const VERIFIED_NATIVE_PDF_ANNOTATION_NAME_PREFIX = 'placekeeper-native:v1:';

export type NativePdfAnnotationIdentityProvenance = 'verified' | 'generation-ordinal';

export function nativePdfAnnotationIdentity(
  _pageIndex: number,
  _annotationIndex: number,
  name = '',
): { readonly id: string; readonly provenance: NativePdfAnnotationIdentityProvenance } {
  const saved = name.startsWith(VERIFIED_NATIVE_PDF_ANNOTATION_NAME_PREFIX)
    ? name.slice(VERIFIED_NATIVE_PDF_ANNOTATION_NAME_PREFIX.length) : '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved)) {
    return { id: saved, provenance: 'verified' };
  }
  return {
    id: globalThis.crypto.randomUUID(),
    provenance: 'generation-ordinal',
  };
}

/** /NM is optional. Enumeration gives unnamed annotations an identity until first save. */
export function nativePdfAnnotationId(pageIndex: number, annotationIndex: number, name = ''): string {
  const saved = name.startsWith(NATIVE_PDF_ANNOTATION_NAME_PREFIX)
    ? name.slice(NATIVE_PDF_ANNOTATION_NAME_PREFIX.length) : '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved)) return saved;
  if (![pageIndex, annotationIndex].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffff)) {
    throw new Error('PDF annotation index is out of range');
  }
  return `5e14134c-6d1b-4bbd-8000-${pageIndex.toString(16).padStart(6, '0')}${annotationIndex.toString(16).padStart(6, '0')}`;
}

export function nativePdfAnnotationSubtype(item: ReviewItem): string | undefined {
  return item.kind === 'pdfAnnotation' && typeof item.payload.subtype === 'string'
    ? item.payload.subtype : undefined;
}

export function canEditPdfAnnotationComment(item: ReviewItem): boolean {
  return item.kind !== 'pdfAnnotation' || item.payload.contentsLocked !== true;
}

export function canDeletePdfAnnotation(item: ReviewItem): boolean {
  return item.kind !== 'pdfAnnotation' || item.payload.deletionLocked !== true;
}
