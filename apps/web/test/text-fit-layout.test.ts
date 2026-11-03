import { Rotation, type PdfDocumentObject, type PdfEngine, type PdfGlyphObject, type PdfPageObject } from '@embedpdf/models';
import { describe, expect, it, vi } from 'vitest';
import {
  createTextFitLayout,
  detectReadingBounds,
  readingLayoutPadding,
  readingPageOffset,
  representativeReadingWidth,
} from '../src/pdf/text-fit-layout.js';

const size = { width: 600, height: 800 };
const page = (index = 0, rotation = Rotation.Degree0): PdfPageObject => ({ index, size, rotation, objectNumber: index + 1 });
const document = (count = 1): PdfDocumentObject => ({ id: 'book', pages: Array.from({ length: count }, (_, i) => page(i)) }) as PdfDocumentObject;
const row = (x: number, y: number, width = 300): PdfGlyphObject[] => Array.from({ length: width / 5 }, (_, i) => ({ origin: { x: x + i * 5, y }, size: { width: 5, height: 10 } }));
const body = (x = 100): PdfGlyphObject[] => Array.from({ length: 12 }, (_, i) => row(x, 100 + i * 20)).flat();
const rect = (x: number, y = 100, width = 300, height = 230) => ({ origin: { x, y }, size: { width, height } });

function engine(read: (index: number) => Promise<readonly PdfGlyphObject[]>): PdfEngine {
  return { getPageGlyphs: vi.fn((_document: PdfDocumentObject, p: PdfPageObject) => ({
    toPromise: () => read(p.index),
    abort: vi.fn(),
  })) } as unknown as PdfEngine;
}

describe('reading bounds', () => {
  it('finds alternating body blocks while excluding page numbers and a wide isolated row', () => {
    expect(detectReadingBounds([...body(), ...row(280, 760, 20), ...row(20, 400, 550)], size)).toEqual(rect(100));
    expect(detectReadingBounds(body(180), size)).toEqual(rect(180));
  });

  it('includes both columns and their gutter', () => {
    const glyphs = Array.from({ length: 12 }, (_, i) => [
      ...row(50, 100 + i * 20, 200), ...row(300, 100 + i * 20, 200),
    ]).flat();
    expect(detectReadingBounds(glyphs, size)).toEqual(rect(50, 100, 450));
  });

  it('rejects sparse, blank and invalid evidence and tolerates sparse glyph holes', () => {
    expect(detectReadingBounds([], size)).toBeNull();
    expect(detectReadingBounds(row(100, 100), size)).toBeNull();
    expect(detectReadingBounds(body(), { width: NaN, height: 800 })).toBeNull();
    const glyphs = body();
    delete glyphs[50];
    glyphs.push({ origin: { x: NaN, y: 0 }, size: { width: 5, height: 10 } });
    expect(detectReadingBounds(glyphs, size)).toEqual(rect(100));
  });

  it('rotates crop-relative bounds with page and document rotation', () => {
    const cropped = { ...page(), boxes: { media: { left: 0, bottom: 0, right: 700, top: 900 }, crop: { left: 30, bottom: 40, right: 630, top: 840 } } };
    expect(readingPageOffset(cropped, rect(100), Rotation.Degree0, 2)).toBe(100);
    expect(readingPageOffset(page(), null, Rotation.Degree0, 2)).toBe(0);
    expect(readingPageOffset(page(0, Rotation.Degree90), rect(100), Rotation.Degree90)).toBe(-50);
    expect(readingPageOffset(page(), rect(100), Rotation.Degree90)).toBe(-185);
    expect(readingLayoutPadding([page(), page(1)], [rect(100), rect(180)], Rotation.Degree0, 2)).toBe(100);
  });

  it('uses a robust shared width across mixed pages and excludes undetectable pages', () => {
    expect(representativeReadingWidth([page(), page(1), page(2), page(3)], [rect(100), rect(180), rect(20, 100, 550), null], Rotation.Degree0)).toBe(300);
    expect(representativeReadingWidth([page()], [null], Rotation.Degree0)).toBeNull();
    expect(representativeReadingWidth([page()], [rect(100)], Rotation.Degree90)).toBe(230);
  });
});

describe('document reading layout', () => {
  it('prepares all pages with bounded concurrency, retains only bounds, and caches the result', async () => {
    const doc = document(9);
    let active = 0;
    let maxActive = 0;
    const pdf = engine(async (index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return index < 5 ? [] : body(index % 2 ? 100 : 180);
    });
    const layout = createTextFitLayout();
    layout.replaceDocument(doc, 1);
    const listener = vi.fn();
    layout.subscribe(listener);
    const bounds = await layout.prepare(pdf, doc, 1, new AbortController().signal);
    expect(bounds).toHaveLength(9);
    expect(bounds.slice(0, 5)).toEqual(Array(5).fill(null));
    expect(bounds[5]).toEqual(rect(100));
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThan(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(await layout.prepare(pdf, doc, 1, new AbortController().signal)).toBe(bounds);
    expect(pdf.getPageGlyphs).toHaveBeenCalledTimes(9);
    expect(layout.getSnapshot().bounds).toBe(bounds);
    layout.setAlignment('text');
    expect(layout.getSnapshot().alignment).toBe('text');
    layout.replaceDocument(document(), 2);
    expect(layout.getSnapshot()).toMatchObject({ generation: 2, alignment: 'page', bounds: null });
  });

  it('never publishes aborted or stale preparation, even if an engine ignores abort', async () => {
    const doc = document();
    let finish!: (value: readonly PdfGlyphObject[]) => void;
    const pdf = engine(() => new Promise((resolve) => { finish = resolve; }));
    const layout = createTextFitLayout();
    layout.replaceDocument(doc, 1);
    const controller = new AbortController();
    const preparing = layout.prepare(pdf, doc, 1, controller.signal);
    const rejected = expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    expect(vi.mocked(pdf.getPageGlyphs).mock.results[0]?.value.abort).toHaveBeenCalledOnce();
    finish(body());
    await rejected;
    expect(layout.getSnapshot().bounds).toBeNull();
    const stale = layout.prepare(pdf, doc, 1, new AbortController().signal);
    const staleRejected = expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    layout.replaceDocument(document(), 2);
    finish(body());
    await staleRejected;
    expect(layout.getSnapshot().bounds).toBeNull();
    layout.dispose();
    expect(layout.getSnapshot().document).toBeNull();
  });
});
