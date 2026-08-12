import { PdfZoomMode } from '@embedpdf/models';
import { describe, expect, it } from 'vitest';

import { pdfSearchResultTarget } from '../src/pdf/pdf-search-navigation.js';

describe('PDF search navigation', () => {
  it('keeps occurrence identity while framing its first reliable rectangle', () => {
    expect(pdfSearchResultTarget({
      id: 'occurrence-2',
      pageIndex: 4,
      charIndex: 20,
      charCount: 2,
      navigationPoint: { x: 10, y: 42 },
      rects: [{ origin: { x: 10, y: 30 }, size: { width: 8, height: 12 } }],
      excerpt: 'β is fixed',
      excerptMatch: { start: 0, length: 1 },
      kind: 'symbol',
      matchedForm: 'β',
    }, 7)).toEqual({
      documentGeneration: 7,
      pageIndex: 4,
      zoom: { mode: PdfZoomMode.XYZ, params: [10, 42, 0] },
      identity: 'occurrence-2',
    });
  });

  it('rejects results without reliable geometry', () => {
    expect(pdfSearchResultTarget({
      id: 'missing', pageIndex: 0, charIndex: 0, charCount: 1,
      navigationPoint: { x: 0, y: 0 }, rects: [], excerpt: '',
      excerptMatch: { start: 0, length: 0 }, kind: 'exact', matchedForm: 'x',
    }, 1)).toBeNull();
  });
});
