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
});
