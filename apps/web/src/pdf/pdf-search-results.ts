import type { PdfSearchResult } from './pdf-search-model.js';

export function orderSearchResults(results: readonly PdfSearchResult[]): PdfSearchResult[] {
  return [...results].sort((left, right) => (
    left.pageIndex - right.pageIndex
    || left.charIndex - right.charIndex
    || left.matchedForm.localeCompare(right.matchedForm)
  ));
}

/** Add one newly indexed page; result IDs include the page index. */
export function insertSearchPageResults(
  existing: readonly PdfSearchResult[],
  pageResults: readonly PdfSearchResult[],
): readonly PdfSearchResult[] {
  const byId = new Map<string, PdfSearchResult>();
  for (const result of pageResults) byId.set(result.id, result);
  const added = orderSearchResults([...byId.values()]);
  const first = added[0];
  if (!first) return existing;
  let low = 0;
  let high = existing.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (existing[middle]!.pageIndex < first.pageIndex) low = middle + 1;
    else high = middle;
  }
  // Published arrays remain immutable, including when pages complete out of order.
  return existing.slice(0, low).concat(added, existing.slice(low));
}
