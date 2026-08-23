import { describe, expect, it } from 'vitest';

import {
  PAGE_TEXT_UNAVAILABLE_MESSAGE,
  SELECTION_UNAVAILABLE_MESSAGE,
  assessPageTextReliability,
  assessSelectionReliability,
} from '../src/pdf/text-reliability.js';

const rect = (x: number, y: number, width = 40, height = 12) => ({
  origin: { x, y },
  size: { width, height },
});

describe('text reliability gates', () => {
  it('requires nonempty text and finite, positive page geometry', () => {
    expect(assessPageTextReliability({ extractedText: '', textRects: [] })).toMatchObject({
      reliable: false,
      userMessage: PAGE_TEXT_UNAVAILABLE_MESSAGE,
      diagnostic: 'page-has-no-text',
    });
    expect(
      assessPageTextReliability({
        extractedText: 'text',
        textRects: [{ content: 'text', rect: rect(Number.NaN, 0) }],
      }),
    ).toMatchObject({ reliable: false, diagnostic: 'page-geometry-invalid' });
    expect(
      assessPageTextReliability({
        extractedText: 'text',
        textRects: [{ content: 'text', rect: rect(10, 20) }],
      }),
    ).toEqual({ reliable: true });
  });

  it.each([
    ['ligature', 'of\ufb01ce', 'selection-has-ambiguous-characters'],
    ['soft hyphen', 'soft\u00adhyphen', 'selection-has-ambiguous-characters'],
    ['RTL', '\u0645\u0631\u062d\u0628\u0627', 'selection-reading-order-unsupported'],
    ['CJK', '\u65e5\u672c\u8a9e', 'selection-reading-order-unsupported'],
  ])('fails closed for %s text without changing it', (_label, quote, diagnostic) => {
    const result = assessSelectionReliability({
      page: { extractedText: `prefix ${quote} suffix`, textRects: [{ content: quote, rect: rect(0, 0) }] },
      pageIndexes: [0],
      quote,
      glyphCount: Array.from(quote).length,
      segmentRects: [rect(0, 0)],
    });

    expect(result).toMatchObject({
      reliable: false,
      userMessage: SELECTION_UNAVAILABLE_MESSAGE,
      diagnostic,
    });
    expect(quote).toBe(quote);
  });

  it('rejects cross-page, ambiguous-count, glyph-count, and nonmonotone-column selections', () => {
    const page = {
      extractedText: 'unique equilibrium and unique equilibrium',
      textRects: [{ content: 'unique equilibrium', rect: rect(0, 0) }],
    };
    expect(
      assessSelectionReliability({
        page,
        pageIndexes: [0, 1],
        quote: 'unique equilibrium',
        glyphCount: 18,
        segmentRects: [rect(0, 0)],
      }),
    ).toMatchObject({ reliable: false, diagnostic: 'selection-crosses-pages' });
    expect(
      assessSelectionReliability({
        page,
        pageIndexes: [0],
        quote: 'unique equilibrium',
        glyphCount: 18,
        segmentRects: [rect(0, 0)],
      }),
    ).toMatchObject({ reliable: false, diagnostic: 'selection-quote-not-unique' });
    expect(
      assessSelectionReliability({
        page: { ...page, extractedText: 'unique equilibrium' },
        pageIndexes: [0],
        quote: 'unique equilibrium',
        glyphCount: 17,
        segmentRects: [rect(0, 0)],
      }),
    ).toMatchObject({ reliable: false, diagnostic: 'selection-glyph-count-mismatch' });
    expect(
      assessSelectionReliability({
        page: { ...page, extractedText: 'unique equilibrium' },
        pageIndexes: [0],
        quote: 'unique equilibrium',
        glyphCount: 18,
        segmentRects: [rect(300, 400), rect(20, 40)],
      }),
    ).toMatchObject({ reliable: false, diagnostic: 'selection-reading-order-ambiguous' });
  });

  it('accepts exact, unique single- and multiline Latin selections', () => {
    const quote = 'unique\nequilibrium';
    expect(
      assessSelectionReliability({
        page: {
          extractedText: `prefix ${quote} suffix`,
          textRects: [
            { content: 'unique', rect: rect(10, 10) },
            { content: 'equilibrium', rect: rect(10, 30) },
          ],
        },
        pageIndexes: [0],
        quote,
        glyphCount: Array.from(quote).length,
        segmentRects: [rect(10, 10), rect(10, 30)],
      }),
    ).toEqual({ reliable: true });
  });

  it('accepts exact indexed selections with TeX superscript and subscript geometry', () => {
    const quote = 'tk|ij = ν\r\n−1\r\nk\r\n· dk|ij .';
    const prefix = 'before ';
    const segmentRects = [
      rect(264, 200, 4, 12),
      rect(268, 205, 13, 14),
      rect(286, 196, 18, 17),
      rect(305, 198, 6, 14),
      rect(311, 195, 4, 12),
      rect(304, 206, 4, 8),
      rect(319, 200, 12, 21),
      rect(331, 205, 13, 14),
      rect(345, 200, 3, 12),
    ];

    expect(
      assessSelectionReliability({
        page: {
          extractedText: `${prefix}${quote} after`,
          textRects: [{ content: quote, rect: rect(255, 190, 100, 40) }],
        },
        pageIndexes: [0],
        quote,
        quoteStart: prefix.length,
        glyphCount: Array.from(quote).length,
        segmentRects,
      }),
    ).toEqual({ reliable: true });
  });

  it('still rejects invalid or text-free geometry for exact indexed selections', () => {
    const page = {
      extractedText: 'before equation after',
      textRects: [{ content: 'equation', rect: rect(20, 20) }],
    };
    const indexedSelection = {
      page,
      pageIndexes: [0],
      quote: 'equation',
      quoteStart: 'before '.length,
      glyphCount: 'equation'.length,
    };

    expect(
      assessSelectionReliability({
        ...indexedSelection,
        segmentRects: [rect(20, 20, 0, 12)],
      }),
    ).toMatchObject({ reliable: false, diagnostic: 'selection-geometry-invalid' });
    expect(
      assessSelectionReliability({
        ...indexedSelection,
        segmentRects: [rect(300, 300)],
      }),
    ).toMatchObject({ reliable: false, diagnostic: 'selection-text-geometry-mismatch' });
  });
});
