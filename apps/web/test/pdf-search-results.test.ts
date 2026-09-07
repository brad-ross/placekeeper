import { describe, expect, it } from 'vitest';
import { insertSearchPageResults } from '../src/pdf/pdf-search-results.js';
import type { PdfSearchResult } from '../src/pdf/pdf-search-model.js';

function result(id: string, pageIndex: number, charIndex: number, matchedForm: string): PdfSearchResult {
  return {
    id, pageIndex, charIndex, matchedForm, charCount: 1,
    navigationPoint: { x: 0, y: 0 }, rects: [], excerpt: '',
    excerptMatch: { start: 0, length: 1 }, kind: 'exact',
  };
}

describe('progressive page result insertion', () => {
  it('keeps the last duplicate value, matched-form ordering and stable ties', () => {
    const last = result('same', 1, 3, 'a');
    const inserted = insertSearchPageResults([], [
      result('same', 1, 3, 'z'), result('tie', 1, 3, 'a'),
      result('later', 1, 3, 'b'), result('first', 1, 0, 'z'), last,
    ]);
    expect(inserted.map(({ id }) => id)).toEqual(['first', 'same', 'tie', 'later']);
    expect(inserted[1]).toBe(last);
  });

  it('inserts a complete page between existing pages without changing published arrays', () => {
    const existing = [result('left', 0, 0, 'x'), result('right', 2, 0, 'x')];
    expect(insertSearchPageResults(existing, [result('middle', 1, 0, 'x')]).map(({ id }) => id))
      .toEqual(['left', 'middle', 'right']);
    expect(existing.map(({ id }) => id)).toEqual(['left', 'right']);
    expect(insertSearchPageResults(existing, [])).toBe(existing);
  });
});
