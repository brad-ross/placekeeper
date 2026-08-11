import type { Rect } from '@embedpdf/models';

export const PDF_SEARCH_MAX_QUERY_CODE_POINTS = 512;
export const PDF_SEARCH_MAX_INDEX_BYTES = 64 * 1024 * 1024;
export const PDF_SEARCH_MAX_CONCURRENT_PAGE_READS = 4;

export type PdfSearchQueryKind = 'prose' | 'symbol-command' | 'formula';
export type PdfSearchMatchKind = 'exact' | 'variant' | 'symbol' | 'formula';
export type PdfSearchStatus =
  | 'idle'
  | 'indexing'
  | 'searching'
  | 'results'
  | 'no-results'
  | 'partial'
  | 'unavailable';

export interface PdfSearchCoverage {
  readonly totalPages: number;
  readonly searchedPages: number;
  readonly unsearchablePages: readonly number[];
  readonly limitedPages: readonly number[];
}

export interface PdfSearchResult {
  readonly id: string;
  readonly pageIndex: number;
  readonly charIndex: number;
  readonly charCount: number;
  /** First match point in canonical bottom-origin PDF coordinates. */
  readonly navigationPoint: { readonly x: number; readonly y: number };
  /** Match bounds in the review overlay's canonical top-origin coordinates. */
  readonly rects: readonly Rect[];
  readonly excerpt: string;
  readonly kind: PdfSearchMatchKind;
  readonly matchedForm: string;
}

export interface PdfSearchResultGroup {
  readonly id: 'exact' | 'related';
  readonly label: string;
  readonly results: readonly PdfSearchResult[];
}

export interface PdfSearchAlternative {
  readonly label: string;
  readonly query: string;
}

export interface PdfSearchState {
  readonly status: PdfSearchStatus;
  readonly query: string;
  readonly groups: readonly PdfSearchResultGroup[];
  readonly selectedResultId: string | null;
  readonly coverage: PdfSearchCoverage;
  readonly alternatives: readonly PdfSearchAlternative[];
  readonly symbolCatalog: readonly PdfSearchAlternative[];
  readonly message: string;
}

export function canonicalizeProse(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase().replace(/\s+/gu, ' ');
}

export function canonicalizeFormula(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, '');
}

export function classifyPdfSearchQuery(value: string): PdfSearchQueryKind {
  const query = value.trim();
  if (/^\\[A-Za-z]+$/u.test(query)) return 'symbol-command';
  if (
    /[°\u0370-\u03ff\u2190-\u22ff\u27c0-\u27ef\u2980-\u2aff]/u.test(query)
    || /[=<>+*/^_|{}[\]]/u.test(query)
  ) return 'formula';
  return 'prose';
}

export function buildSearchResultId(
  documentGeneration: number,
  pageIndex: number,
  charIndex: number,
  charCount: number,
  firstRectOrigin: { readonly x: number; readonly y: number },
): string {
  return JSON.stringify([
    documentGeneration,
    pageIndex,
    charIndex,
    charCount,
    firstRectOrigin.x,
    firstRectOrigin.y,
  ]);
}

export function initialPdfSearchState(totalPages = 0): PdfSearchState {
  return {
    status: 'idle',
    query: '',
    groups: [],
    selectedResultId: null,
    coverage: {
      totalPages,
      searchedPages: 0,
      unsearchablePages: [],
      limitedPages: [],
    },
    alternatives: [],
    symbolCatalog: [],
    message: '',
  };
}
