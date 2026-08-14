/** Link annotations are navigation affordances, not reviewer feedback. */
export function isNavigationalPdfAnnotationSubtype(subtype: string): boolean {
  return subtype.trim().toLowerCase() === "link";
}
