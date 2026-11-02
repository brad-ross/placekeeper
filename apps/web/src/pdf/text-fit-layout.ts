import {
  PdfErrorCode,
  boundingRect,
  transformRect,
  transformSize,
  type PdfDocumentObject,
  type PdfEngine,
  type PdfGlyphObject,
  type PdfPageObject,
  type Rect,
  type Rotation,
  type Size,
} from '@embedpdf/models';

import { mergeGlyphLineRects } from './glyph-lines.js';
import { combinePageRotation } from './owned-overlay.js';

export type ReadingAlignment = 'page' | 'text';
export type ReadingBounds = readonly (Rect | null)[];

export interface TextFitLayoutSnapshot {
  readonly document: PdfDocumentObject | null;
  readonly generation: number;
  readonly alignment: ReadingAlignment;
  /** Natural, crop-relative bounds; null until every page has been examined. */
  readonly bounds: ReadingBounds | null;
}

export interface TextFitLayout {
  getSnapshot(): TextFitLayoutSnapshot;
  subscribe(listener: () => void): () => void;
  replaceDocument(document: PdfDocumentObject | null, generation: number): void;
  prepare(engine: PdfEngine, document: PdfDocumentObject, generation: number, signal: AbortSignal): Promise<ReadingBounds>;
  setAlignment(alignment: ReadingAlignment): void;
  dispose(): void;
}

function quantile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor((ordered.length - 1) * fraction)] ?? 0;
}

export function detectReadingBounds(glyphs: readonly PdfGlyphObject[], pageSize: Size): Rect | null {
  if (!Number.isFinite(pageSize.width) || !Number.isFinite(pageSize.height)
    || pageSize.width <= 0 || pageSize.height <= 0) return null;
  const segments = mergeGlyphLineRects(glyphs, 0, glyphs.length).filter(({ origin, size }) => (
    origin.x >= 0 && origin.y >= 0
    && origin.x + size.width <= pageSize.width + 1
    && origin.y + size.height <= pageSize.height + 1
  ));
  if (segments.length < 4) return null;
  const bodyHeight = quantile(segments.map(({ size }) => size.height), 0.5);
  const rows: Rect[] = [];
  for (const segment of segments.filter(({ size }) => (
    size.height >= bodyHeight * 0.75 && size.height <= bodyHeight * 1.4
  )).sort((a, b) => a.origin.y - b.origin.y || a.origin.x - b.origin.x)) {
    const previous = rows.at(-1);
    if (previous && Math.abs(previous.origin.y - segment.origin.y) <= bodyHeight * 0.5) {
      rows[rows.length - 1] = boundingRect([previous, segment])!;
    } else {
      rows.push(segment);
    }
  }
  const substantial = rows.filter(({ size }) => size.width >= pageSize.width * 0.2);
  if (substantial.length < 4) return null;
  const width = quantile(substantial.map(({ size }) => size.width), 0.5);
  const body = substantial.filter(({ size }) => size.width >= width * 0.6 && size.width <= width * 1.35);
  if (body.length < 4) return null;
  const left = quantile(body.map(({ origin }) => origin.x), 0.15);
  const right = quantile(body.map(({ origin, size }) => origin.x + size.width), 0.85);
  const top = Math.min(...body.map(({ origin }) => origin.y));
  const bottom = Math.max(...body.map(({ origin, size }) => origin.y + size.height));
  if (bottom - top < bodyHeight * 4 || right <= left) return null;
  return { origin: { x: left, y: top }, size: { width: right - left, height: bottom - top } };
}

export function readingPageOffset(page: PdfPageObject, bounds: Rect | null | undefined, documentRotation: Rotation, zoom = 1): number {
  if (!bounds) return 0;
  const rotation = combinePageRotation(page.rotation, documentRotation);
  const rotated = transformRect(page.size, bounds, rotation, zoom);
  return transformSize(page.size, rotation, zoom).width / 2
    - rotated.origin.x - rotated.size.width / 2;
}

export function readingLayoutPadding(pages: readonly PdfPageObject[], bounds: ReadingBounds, documentRotation: Rotation, zoom = 1): number {
  return pages.reduce((padding, page, index) => Math.max(
    padding, Math.abs(readingPageOffset(page, bounds[index], documentRotation, zoom)),
  ), 0);
}

export function representativeReadingWidth(pages: readonly PdfPageObject[], bounds: ReadingBounds, documentRotation: Rotation): number | null {
  const widths: number[] = [];
  pages.forEach((page, index) => {
    const rect = bounds[index];
    if (rect) widths.push(transformRect(page.size, rect, combinePageRotation(page.rotation, documentRotation), 1).size.width);
  });
  return widths.length ? quantile(widths, 0.5) : null;
}

function cancelled(): DOMException {
  return new DOMException('Text fitting cancelled', 'AbortError');
}

export function createTextFitLayout(): TextFitLayout {
  let snapshot: TextFitLayoutSnapshot = { document: null, generation: 0, alignment: 'page', bounds: null };
  const listeners = new Set<() => void>();
  const preparations = new Set<AbortController>();
  const publish = (next: TextFitLayoutSnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const replaceDocument = (document: PdfDocumentObject | null, generation: number) => {
    if (snapshot.document === document && snapshot.generation === generation) return;
    preparations.forEach((controller) => controller.abort());
    publish({ document, generation, alignment: 'page', bounds: null });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    replaceDocument,
    async prepare(engine, document, generation, parentSignal) {
      const current = () => snapshot.document === document && snapshot.generation === generation;
      if (parentSignal.aborted || !current()) throw cancelled();
      if (snapshot.bounds) return snapshot.bounds;
      const controller = new AbortController();
      preparations.add(controller);
      const abort = () => controller.abort();
      parentSignal.addEventListener('abort', abort, { once: true });
      const bounds: (Rect | null)[] = Array(document.pages.length).fill(null);
      let nextPage = 0;
      const scan = async () => {
        while (nextPage < document.pages.length) {
          if (controller.signal.aborted || !current()) throw cancelled();
          const index = nextPage++;
          const page = document.pages[index]!;
          const task = engine.getPageGlyphs(document, page);
          const glyphs = await new Promise<readonly PdfGlyphObject[]>((resolve, reject) => {
            const cancel = () => {
              reject(cancelled());
              try { task.abort({ code: PdfErrorCode.Cancelled, message: 'Text fitting cancelled' }); }
              catch {}
            };
            controller.signal.addEventListener('abort', cancel, { once: true });
            if (controller.signal.aborted) cancel();
            task.toPromise().then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancel));
          });
          if (controller.signal.aborted || !current()) throw cancelled();
          bounds[index] = detectReadingBounds(glyphs, page.size);
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(4, document.pages.length) }, scan));
        if (controller.signal.aborted || !current()) throw cancelled();
        publish({ ...snapshot, bounds });
        return bounds;
      } catch (error) {
        controller.abort();
        throw error;
      } finally {
        parentSignal.removeEventListener('abort', abort);
        preparations.delete(controller);
      }
    },
    setAlignment(alignment) {
      if (snapshot.alignment !== alignment) publish({ ...snapshot, alignment });
    },
    dispose() {
      replaceDocument(null, snapshot.generation + 1);
      listeners.clear();
    },
  };
}
