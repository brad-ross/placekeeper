import type { PdfGlyphObject } from '@embedpdf/models';
import { describe, expect, it } from 'vitest';

import {
  createPdfSearchController,
  type PdfSearchPageGeometry,
  type PdfSearchPageReader,
} from '../src/pdf/pdf-search-controller.js';

const PAGE_GEOMETRY: PdfSearchPageGeometry = {
  width: 600,
  height: 800,
  cropLeft: 0,
  cropTop: 0,
  cropBottom: 0,
};

function glyphs(text: string): PdfGlyphObject[] {
  return Array.from(text, (_character, index) => ({
    origin: { x: index * 5, y: 10 },
    size: { width: 5, height: 8 },
  }));
}

function reader(pages: readonly string[]): PdfSearchPageReader {
  return {
    pageCount: pages.length,
    async read(pageIndex) {
      const text = pages[pageIndex] ?? '';
      return {
        text,
        glyphs: glyphs(text),
        geometry: PAGE_GEOMETRY,
        textRects: text.length === 0 ? [] : [{
          content: text,
          rect: { origin: { x: 0, y: 10 }, size: { width: text.length * 5, height: 8 } },
        }],
      };
    },
  };
}

describe('PDF search controller', () => {
  it('separates exact and related matches in document order', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 7,
      reader: reader(['A stable model. Stability matters.', 'The model stabilizes.', '']),
    });

    const state = await controller.search('stable');

    expect(state.status).toBe('partial');
    expect(state.groups[0]?.id).toBe('exact');
    expect(state.groups[0]?.results).toHaveLength(1);
    expect(state.groups[1]?.id).toBe('related');
    expect(state.groups[1]?.label).toBe('Related matches');
    expect(state.groups[1]?.results.map(({ matchedForm }) => matchedForm)).toEqual([
      'stability',
      'stabilizes',
    ]);
    expect(state.groups[1]?.results.map(({ pageIndex }) => pageIndex)).toEqual([0, 1]);
    expect(state.groups.flatMap(({ results }) => results).map((result) => (
      result.excerpt.slice(
        result.excerptMatch.start,
        result.excerptMatch.start + result.excerptMatch.length,
      )
    ))).toEqual(['stable', 'Stability', 'stabilizes']);
    expect(state.coverage.unsearchablePages).toEqual([2]);
    expect(state.message).toBe('');
  });

  it('keeps a newer query authoritative while indexing completes', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayedReader: PdfSearchPageReader = {
      pageCount: 1,
      async read() {
        await gate;
        const text = 'stable beta';
        return {
          text,
          glyphs: glyphs(text),
          geometry: PAGE_GEOMETRY,
          textRects: [{ content: text, rect: { origin: { x: 0, y: 10 }, size: { width: 55, height: 8 } } }],
        };
      },
    };
    const controller = createPdfSearchController({ documentGeneration: 2, reader: delayedReader });
    const first = controller.search('stable');
    const second = controller.search('beta');
    release?.();
    await Promise.all([first, second]);

    expect(controller.getState().query).toBe('beta');
    expect(controller.getState().groups[0]?.results[0]?.matchedForm).toBe('beta');
  });

  it('keeps raw phrase spacing in the controlled query value', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['a stable model']),
    });

    const state = await controller.search('stable ');

    expect(state.query).toBe('stable ');
    expect(state.groups[0]?.results[0]?.matchedForm).toBe('stable');
  });

  it('maps collapsed source whitespace to the displayed match range', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['A stable\n model follows.']),
    });

    const result = (await controller.search('stable model')).groups[0]?.results[0];

    expect(result?.excerpt).toBe('A stable model follows.');
    expect(result?.excerpt.slice(
      result.excerptMatch.start,
      result.excerptMatch.start + result.excerptMatch.length,
    )).toBe('stable model');
  });

  it('converts engine glyph geometry for overlays and PDF navigation', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: {
        pageCount: 1,
        async read() {
          const text = 'stable';
          return {
            text,
            glyphs: glyphs(text),
            geometry: {
              width: 540,
              height: 720,
              cropLeft: 36,
              cropTop: 756,
              cropBottom: 36,
            },
            textRects: [{
              content: text,
              rect: { origin: { x: 0, y: 10 }, size: { width: 30, height: 8 } },
            }],
          };
        },
      },
    });

    const result = (await controller.search('stable')).groups[0]?.results[0];

    expect(result?.rects).toEqual([{
      origin: { x: 36, y: 766 },
      size: { width: 30, height: 8 },
    }]);
    expect(result?.navigationPoint).toEqual({ x: 36, y: 746 });
  });

  it('keeps wrapped matches as one highlight rectangle per line', async () => {
    const text = 'stable';
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: {
        pageCount: 1,
        async read() {
          return {
            text,
            glyphs: Array.from(text, (_character, index) => ({
              origin: { x: (index % 3) * 5, y: index < 3 ? 10 : 30 },
              size: { width: 5, height: 8 },
            })),
            geometry: PAGE_GEOMETRY,
            textRects: [{
              content: text,
              rect: { origin: { x: 0, y: 10 }, size: { width: 15, height: 28 } },
            }],
          };
        },
      },
    });

    const result = (await controller.search(text)).groups[0]?.results[0];

    expect(result?.rects).toEqual([
      { origin: { x: 0, y: 10 }, size: { width: 15, height: 8 } },
      { origin: { x: 0, y: 30 }, size: { width: 15, height: 8 } },
    ]);
  });

  it('matches supplementary-plane symbols by literal and official name without shifting geometry', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['Let 𝔼 be positive. stable follows.']),
    });

    const symbol = await controller.search('𝔼');
    expect(symbol.groups[0]?.results[0]).toMatchObject({ charIndex: 4, charCount: 1 });
    const symbolResult = symbol.groups[0]?.results[0];
    expect(symbolResult?.excerpt.slice(
      symbolResult.excerptMatch.start,
      symbolResult.excerptMatch.start + symbolResult.excerptMatch.length,
    )).toBe('𝔼');

    const named = await controller.search('mathematical double-struck capital e');
    expect(named.groups[0]?.results[0]).toMatchObject({
      charIndex: 4,
      charCount: 1,
      matchedForm: '𝔼',
    });

    const prose = await controller.search('stable');
    expect(prose.groups[0]?.results[0]?.charIndex).toBe(19);
  });

  it('publishes stable actionable hits before remaining pages finish', async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const progressiveReader: PdfSearchPageReader = {
      pageCount: 2,
      async read(pageIndex) {
        await (pageIndex === 0 ? firstGate : secondGate);
        const text = pageIndex === 0 ? 'stable first' : 'stable second';
        return {
          text,
          glyphs: glyphs(text),
          geometry: PAGE_GEOMETRY,
          textRects: [{ content: text, rect: { origin: { x: 0, y: 10 }, size: { width: 60, height: 8 } } }],
        };
      },
    };
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: progressiveReader,
      maxConcurrentPageReads: 1,
    });

    const completed = controller.search('stable');
    releaseFirst?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(controller.getState().status).toBe('searching');
    expect(controller.getState().groups[0]?.results).toHaveLength(1);
    expect(controller.getState().message).toContain('1 of 2 checked');

    releaseSecond?.();
    const final = await completed;
    expect(final.status).toBe('results');
    expect(final.groups[0]?.results).toHaveLength(2);
  });

  it('offers detected symbol alternatives without promoting them to matches', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['Let λ be positive and β be fixed']),
    });
    const state = await controller.search('\\theta');

    expect(state.groups).toEqual([]);
    expect(state.alternatives.map(({ query }) => query)).toEqual(['β', 'λ']);
    expect(state.message).toContain('could not be matched confidently');
  });

  it('caps no-match alternatives only after ranking the detected catalog', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader([', ) ( = - + 𝟙 𝟘 λ β α']),
    });

    const state = await controller.search('\\doesnotexist');

    expect(state.groups).toEqual([]);
    expect(state.alternatives.map(({ query }) => query)).toEqual([
      'α', 'β', 'λ', '𝟘', '𝟙', '+', '-', '=',
    ]);
  });

  it('offers detected constituent symbols for an unmatched formula', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['Let λ and β be positive.']),
    });

    const state = await controller.search('λx+β');

    expect(state.groups).toEqual([]);
    expect(state.alternatives.map(({ query }) => query)).toEqual(['β', 'λ']);
  });

  it('resolves a typed symbol name through the detected document inventory', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['Let λ be positive.']),
    });

    const state = await controller.search('lambda');

    expect(state.groups[0]?.results[0]).toMatchObject({
      matchedForm: 'λ',
    });
  });

  it('recognizes omitted Greek and punctuation-class LaTeX symbols from extracted text', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['κ · κ']),
    });

    const kappa = await controller.search('\\kappa');
    expect(kappa.groups[0]?.results).toHaveLength(2);
    expect(kappa.groups[0]?.results[0]?.matchedForm).toBe('κ');

    const centerDot = await controller.search('\\cdot');
    expect(centerDot.groups[0]?.results).toHaveLength(1);
    expect(centerDot.groups[0]?.results[0]?.matchedForm).toBe('·');
  });

  it('searches every mathematical symbol extracted from the reported PDF', async () => {
    const extractedSymbols = [
      ['·', '\\cdot'],
      ['Π', '\\Pi'],
      ['α', '\\alpha'],
      ['δ', '\\delta'],
      ['θ', '\\theta'],
      ['κ', '\\kappa'],
      ['λ', '\\lambda'],
      ['ν', '\\nu'],
      ['ξ', '\\xi'],
      ['ρ', '\\rho'],
      ['σ', '\\sigma'],
      ['τ', '\\tau'],
      ['ϕ', 'varphi'],
      ['ϵ', 'varepsilon'],
      ['˜', 'small tilde'],
      ['→', '\\rightarrow'],
      ['∂', '\\partial'],
      ['∈', '\\in'],
      ['∑', '\\sum'],
      ['−', 'minus'],
      ['∗', '\\ast'],
      ['∝', '\\propto'],
      ['∫', '\\int'],
      ['≡', '\\equiv'],
      ['≤', '\\leq'],
      ['≥', '\\geq'],
      ['⏐', 'vertical line extension'],
      ['+', 'plus sign'],
      ['<', 'less-than sign'],
      ['=', 'equals sign'],
      ['>', 'greater-than sign'],
      ['|', 'vertical line'],
      ['/', 'solidus'],
    ] as const;
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader([extractedSymbols.map(([glyph]) => glyph).join(' ')]),
    });

    for (const [glyph, query] of extractedSymbols) {
      const state = await controller.search(query);
      expect(state.groups.flatMap(({ results }) => results).map(({ matchedForm }) => matchedForm), query)
        .toContain(glyph);
    }
  });

  it('returns every detected glyph in a shared command without inventing other aliases', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['| ⏐ ϕ φ']),
    });

    const verticalBars = await controller.search('\\vert');
    expect(verticalBars.groups[0]?.results.map(({ matchedForm }) => matchedForm))
      .toEqual(['|']);

    const phiVariants = await controller.search('\\phi');
    expect(phiVariants.groups[0]?.results.map(({ matchedForm }) => matchedForm))
      .toEqual(['ϕ', 'φ']);
  });

  it('searches every detected Greek epsilon family member without matching IPA open e', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['ε ϵ 𝛆 𝛜 ɛ']),
    });

    const epsilon = await controller.search('\\varepsilon');

    expect(epsilon.groups[0]?.results.map(({ matchedForm }) => matchedForm))
      .toEqual(['ε', 'ϵ', '𝛆', '𝛜']);
    expect(epsilon.groups[0]?.results.map(({ matchedForm }) => matchedForm))
      .not.toContain('ɛ');
  });

  it('keeps ASCII hyphen and Unicode minus searches code-point exact', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['ride-hailing − cost']),
    });

    const hyphen = await controller.search('-');
    expect(hyphen.groups[0]?.results.map(({ matchedForm }) => matchedForm)).toEqual(['-']);

    const minus = await controller.search('minus');
    expect(minus.groups[0]?.results.map(({ matchedForm }) => matchedForm)).toEqual(['−']);
  });

  it('keeps dangerous lookalike literals code-point exact', async () => {
    const lookalikes = ['-', '−', '|', '∣', '⏐', '∅', '⌀', '~', '˜', '∼', '×', '∗', '·', '⋅'];
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader([lookalikes.join(' ')]),
    });

    for (const glyph of lookalikes) {
      expect((await controller.search(glyph)).groups[0]?.results.map(({ matchedForm }) => matchedForm))
        .toEqual([glyph]);
    }
  });

  it('keeps canonically equivalent-looking symbols code-point exact', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['Ω Ω φ ϕ']),
    });

    expect((await controller.search('Ω')).groups[0]?.results.map(({ matchedForm }) => matchedForm))
      .toEqual(['Ω']);
    expect((await controller.search('Ω')).groups[0]?.results.map(({ matchedForm }) => matchedForm))
      .toEqual(['Ω']);
    expect((await controller.search('φ')).groups[0]?.results.map(({ matchedForm }) => matchedForm))
      .toEqual(['φ']);
    expect((await controller.search('ϕ')).groups[0]?.results.map(({ matchedForm }) => matchedForm))
      .toEqual(['ϕ']);
  });

  it('does not NFC-collapse a missing literal glyph into a detected suggestion', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['Ω']),
    });

    const state = await controller.search('Ω');

    expect(state.groups).toEqual([]);
    expect(state.alternatives).toEqual([]);
  });

  it('removes formula layout whitespace without changing scalar identity or order', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['Ω + Ω']),
    });

    const result = await controller.search('Ω+Ω');
    expect(result.groups[0]?.results[0]).toMatchObject({
      charIndex: 0,
      charCount: 5,
      matchedForm: 'Ω+Ω',
    });
    expect((await controller.search('Ω+Ω')).groups).toEqual([]);
  });

  it('searches private-use scalars literally without naming or suggesting them', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['value \u{E000} value']),
    });

    const prepared = await controller.prepare();
    expect(prepared.symbolCatalog).toEqual([]);
    const result = await controller.search('\u{E000}');
    expect(result.groups[0]?.results).toHaveLength(1);
    expect(result.groups[0]?.results[0]).toMatchObject({ matchedForm: '\u{E000}', charIndex: 6 });
  });

  it('does not populate semantic suggestions from ordinary prose letters', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['Café remains stable']),
    });

    expect((await controller.prepare()).symbolCatalog).toEqual([]);
  });

  it('includes admitted target punctuation in the detected-symbol catalog', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['/']),
    });

    expect((await controller.prepare()).symbolCatalog).toEqual([
      expect.objectContaining({
        label: '/ solidus',
        query: '/',
      }),
    ]);
    expect((await controller.search('/')).groups[0]?.results[0]?.matchedForm).toBe('/');
  });

  it('prepares a detected-symbol catalog before a query is entered', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['Let λ be positive and β be fixed']),
    });

    const state = await controller.prepare();

    expect(state.status).toBe('idle');
    expect(state.symbolCatalog.map(({ query }) => query)).toEqual(['β', 'λ']);
    expect(state.symbolCatalog.map(({ label }) => label)).toEqual([
      'β greek small letter beta (\\beta)',
      'λ greek small letter lamda (\\lambda)',
    ]);
    expect(state.symbolCatalog[1]).toMatchObject({
      symbolSearch: {
        glyph: 'λ',
        commands: expect.arrayContaining(['\\lambda']),
        entities: expect.arrayContaining(['lambda']),
        naturalTerms: expect.arrayContaining(['greek small letter lamda']),
      },
    });
  });

  it('publishes each progressively detected catalog in ranked order', async () => {
    const releases: Array<(() => void) | undefined> = [];
    const gates = Array.from({ length: 3 }, (_, pageIndex) => (
      new Promise<void>((resolve) => { releases[pageIndex] = resolve; })
    ));
    const texts = [', value', '+ value', 'α value'];
    const controller = createPdfSearchController({
      documentGeneration: 1,
      maxConcurrentPageReads: 3,
      reader: {
        pageCount: texts.length,
        async read(pageIndex) {
          await gates[pageIndex];
          const text = texts[pageIndex] ?? '';
          return {
            text,
            glyphs: glyphs(text),
            geometry: PAGE_GEOMETRY,
            textRects: [{
              content: text,
              rect: { origin: { x: 0, y: 10 }, size: { width: text.length * 5, height: 8 } },
            }],
          };
        },
      },
    });
    const completed = controller.search('missing');

    releases[0]?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.getState().symbolCatalog.map(({ query }) => query)).toEqual([',']);

    releases[1]?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.getState().symbolCatalog.map(({ query }) => query)).toEqual(['+', ',']);

    releases[2]?.();
    await completed;
    expect(controller.getState().symbolCatalog.map(({ query }) => query)).toEqual(['α', '+', ',']);
  });

  it('renders sourced command labels and exposes every detected command without inventing one', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['φ ⏐']),
    });

    const state = await controller.prepare();
    const phi = state.symbolCatalog.find(({ query }) => query === 'φ');
    const verticalLineExtension = state.symbolCatalog.find(({ query }) => query === '⏐');

    expect(phi?.label).toBe('φ greek small letter phi (\\phi)');
    expect(phi?.symbolSearch?.commands).toEqual(expect.arrayContaining(['\\phi', '\\varphi']));
    expect(verticalLineExtension?.label).toBe('⏐ vertical line extension');
    expect(verticalLineExtension?.label).not.toContain('()');
    expect(verticalLineExtension?.symbolSearch?.commands).toEqual([]);
  });

  it('does not duplicate an exact substring as a related word occurrence', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['models model']),
    });

    const state = await controller.search('model');

    expect(state.groups[0]?.results).toHaveLength(2);
    expect(state.groups.find(({ id }) => id === 'related')).toBeUndefined();
  });

  it('rejects oversized queries without starting document work', async () => {
    let reads = 0;
    const controlledReader: PdfSearchPageReader = {
      pageCount: 1,
      async read() {
        reads += 1;
        return { text: 'anything', glyphs: glyphs('anything'), geometry: PAGE_GEOMETRY, textRects: [] };
      },
    };
    const controller = createPdfSearchController({ documentGeneration: 1, reader: controlledReader });
    const state = await controller.search('x'.repeat(513));

    expect(state.status).toBe('unavailable');
    expect(reads).toBe(0);
  });

  it('keeps a cleared or oversized query terminal while indexing finishes', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayedReader: PdfSearchPageReader = {
      pageCount: 1,
      async read() {
        await gate;
        const text = 'stable';
        return {
          text,
          glyphs: glyphs(text),
          geometry: PAGE_GEOMETRY,
          textRects: [{ content: text, rect: { origin: { x: 0, y: 10 }, size: { width: 30, height: 8 } } }],
        };
      },
    };
    const cleared = createPdfSearchController({ documentGeneration: 1, reader: delayedReader });
    const pending = cleared.search('stable');
    await cleared.search('');
    release?.();
    await pending;
    expect(cleared.getState().status).toBe('idle');

    let releaseOversized: (() => void) | undefined;
    const oversizedGate = new Promise<void>((resolve) => { releaseOversized = resolve; });
    const oversized = createPdfSearchController({
      documentGeneration: 1,
      reader: {
        ...delayedReader,
        async read(pageIndex, signal) {
          await oversizedGate;
          return delayedReader.read(pageIndex, signal);
        },
      },
    });
    const indexing = oversized.search('stable');
    await oversized.search('x'.repeat(513));
    releaseOversized?.();
    await indexing;
    expect(oversized.getState()).toMatchObject({
      status: 'unavailable',
      query: 'x'.repeat(513),
      message: 'Search queries are limited to 512 characters.',
    });
    release?.();
  });

  it('discloses index-budget, read, and malformed-geometry failures', async () => {
    const limited = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['stable']),
      maxIndexBytes: 1,
    });
    const limitedState = await limited.search('stable');
    expect(limitedState.status).toBe('unavailable');
    expect(limitedState.coverage.limitedPages).toEqual([0]);

    const failed = createPdfSearchController({
      documentGeneration: 1,
      reader: { pageCount: 1, async read() { throw new Error('damaged page'); } },
    });
    const failedState = await failed.search('stable');
    expect(failedState.status).toBe('unavailable');
    expect(failedState.coverage.unsearchablePages).toEqual([0]);

    const malformed = createPdfSearchController({
      documentGeneration: 1,
      reader: {
        pageCount: 1,
        async read() {
          return {
            text: 'x',
            glyphs: [{ origin: { x: Number.NaN, y: 10 }, size: { width: 5, height: 8 } }],
            geometry: PAGE_GEOMETRY,
            textRects: [{ content: 'x', rect: { origin: { x: 0, y: 10 }, size: { width: 5, height: 8 } } }],
          };
        },
      },
    });
    const malformedState = await malformed.search('x');
    expect(malformedState.status).toBe('unavailable');
    expect(malformedState.coverage.unsearchablePages).toEqual([0]);
  });
});
