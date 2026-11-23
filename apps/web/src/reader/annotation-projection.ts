import type { PdfWriterAnnotation } from '../../../../packages/core/src/pdf-writer.js';

export {
  documentOrderedItems,
  projectAnnotation,
  projectAnnotationProjections,
  projectAnnotations,
  annotationPageRange,
} from "../../../../packages/core/src/annotation-projection.js";

export function annotationIdForPdfAnnotation(annotation: PdfWriterAnnotation): string {
  return annotation.annotationItemId ?? annotation.id;
}

/** Replaces every visible projection for the one logical item being edited. */
export function mergeAuthoringPreviewProjections(
  owned: readonly PdfWriterAnnotation[],
  preview: readonly PdfWriterAnnotation[] | null,
): readonly PdfWriterAnnotation[] {
  if (preview === null) return owned;
  const previewItemIds = new Set(preview.map(annotationIdForPdfAnnotation));
  return [
    ...owned.filter((annotation) => !previewItemIds.has(annotationIdForPdfAnnotation(annotation))),
    ...preview,
  ];
}
