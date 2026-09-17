/** The exact viewer instance that produced transient PDF interaction evidence. */
export type PdfAnnotationSurface =
  | { readonly kind: 'main'; readonly documentGeneration: number }
  | {
      readonly kind: 'reference';
      readonly documentGeneration: number;
      readonly tabIdentity: string;
    };

export function mainPdfAnnotationSurface(documentGeneration: number): PdfAnnotationSurface {
  return Object.freeze({ kind: 'main', documentGeneration });
}

/** Reject evidence from another document generation or Reference tab. */
export function samePdfAnnotationSurface(
  left: PdfAnnotationSurface,
  right: PdfAnnotationSurface,
): boolean {
  return left.kind === right.kind
    && left.documentGeneration === right.documentGeneration
    && (left.kind === 'main' || (
      right.kind === 'reference' && left.tabIdentity === right.tabIdentity
    ));
}
