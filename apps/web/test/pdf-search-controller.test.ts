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
    expect(state.groups[1]?.results.map(({ matchedForm }) => matchedForm)).toEqual([
      'stability',
      'stabilizes',
    ]);
    expect(state.groups[1]?.results.map(({ pageIndex }) => pageIndex)).toEqual([0, 1]);
    expect(state.coverage.unsearchablePages).toEqual([2]);
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

    expect(result?.rects[0]?.origin).toEqual({ x: 36, y: 766 });
    expect(result?.navigationPoint).toEqual({ x: 36, y: 746 });
  });

  it('matches supplementary-plane symbols without shifting source geometry', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['Let 𝔼 be positive. stable follows.']),
    });

    const symbol = await controller.search('𝔼');
    expect(symbol.groups[0]?.results[0]).toMatchObject({ charIndex: 4, charCount: 1 });

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
      reader: reader(['Let λ be positive and β be fixed.']),
    });
    const state = await controller.search('\\theta');

    expect(state.groups).toEqual([]);
    expect(state.alternatives.map(({ query }) => query)).toEqual(['β', 'λ']);
    expect(state.message).toContain('could not be matched confidently');
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

  it('prepares a detected-symbol catalog before a query is entered', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['Let λ be positive and β be fixed.']),
    });

    const state = await controller.prepare();

    expect(state.status).toBe('idle');
    expect(state.symbolCatalog.map(({ query }) => query)).toEqual(['β', 'λ']);
    expect(state.symbolCatalog.map(({ label }) => label)).toEqual([
      'β beta (\\beta)',
      'λ lambda (\\lambda)',
    ]);
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
