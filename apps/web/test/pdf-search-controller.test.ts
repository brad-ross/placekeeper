import type { PdfGlyphObject } from '@embedpdf/models';
import { describe, expect, it } from 'vitest';

import {
  createPdfSearchController,
  type PdfSearchPageReader,
} from '../src/pdf/pdf-search-controller.js';

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
          textRects: [{ content: text, rect: { origin: { x: 0, y: 10 }, size: { width: 60, height: 8 } } }],
        };
      },
    };
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: progressiveReader,
      maxPageReads: 1,
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

  it('resolves a typed symbol name through the detected document inventory', async () => {
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: reader(['Let λ be positive.']),
    });

    const state = await controller.search('lambda');

    expect(state.groups[0]?.results[0]).toMatchObject({
      kind: 'symbol', matchedForm: 'λ',
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
  });

  it('rejects oversized queries without starting document work', async () => {
    let reads = 0;
    const controlledReader: PdfSearchPageReader = {
      pageCount: 1,
      async read() {
        reads += 1;
        return { text: 'anything', glyphs: glyphs('anything'), textRects: [] };
      },
    };
    const controller = createPdfSearchController({ documentGeneration: 1, reader: controlledReader });
    const state = await controller.search('x'.repeat(513));

    expect(state.status).toBe('unavailable');
    expect(reads).toBe(0);
  });
});
