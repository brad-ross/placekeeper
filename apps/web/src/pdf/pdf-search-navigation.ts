import { PdfZoomMode } from '@embedpdf/models';

import type { PdfNavigationTarget } from './pdf-navigation-target.js';
import type { PdfSearchResult } from './pdf-search-model.js';

export function pdfSearchResultTarget(
  result: PdfSearchResult,
  documentGeneration: number,
): PdfNavigationTarget | null {
  const rect = result.rects[0];
  if (!rect || rect.size.width <= 0 || rect.size.height <= 0) return null;
  const x = rect.origin.x;
  const y = rect.origin.y + rect.size.height;
  if (![x, y].every(Number.isFinite)) return null;
  return {
    documentGeneration,
    pageIndex: result.pageIndex,
    zoom: { mode: PdfZoomMode.XYZ, params: [x, y, 0] },
    identity: result.id,
  };
}
