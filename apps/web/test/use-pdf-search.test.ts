import { expect, it, vi } from 'vitest';
import type { PdfDocumentObject, PdfEngine } from '@embedpdf/models';
// Exercise the hook's retained controller and query ownership without a DOM renderer.
vi.mock('react', () => ({ useRef: (current: unknown) => ({ current }), useState: (initial: () => unknown) => [initial(), () => {}] }));
import { usePdfSearch } from '../src/pdf/use-pdf-search.js';
function fixture() {
  let release!: (value: string) => void;
  const text = new Promise<string>(resolve => { release = resolve; });
  const task = (value: unknown) => ({ abort: () => {}, toPromise: async () => value });
  const engine = { extractText: () => task(text), getPageGlyphs: () => task(Array.from('word', (_, index) => ({ origin: { x: index * 5, y: 10 }, size: { width: 5, height: 8 } }))), getPageTextRects: () => task([{ content: 'word', rect: { origin: { x: 0, y: 10 }, size: { width: 20, height: 8 } } }]) } as unknown as PdfEngine;
  const document = { pages: [{ size: { width: 600, height: 800 } }] } as unknown as PdfDocumentObject;
  const search = usePdfSearch(); search.initialize(engine, document, 7, () => {}, () => {});
  return { search, release: () => release('word') };
}
it('rejects an interrupted tool search even when its replacement repeats the same query', async () => {
  const f = fixture();
  const first = f.search.searchQuery('word'); const rejected = expect(first).rejects.toThrow('search changed');
  const second = f.search.searchQuery('word'); f.release();
  await rejected; expect((await second).status).toBe('results'); f.search.dispose();
});
it('invalidates tool results while a different reader query is waiting for its debounce', async () => {
  const f = fixture(); const pending = f.search.searchQuery('word'); f.release(); await pending;
  expect(f.search.getState()?.groups[0]?.results).toHaveLength(1);
  f.search.submitSearchQuery('other'); expect(f.search.getState()).toBeUndefined(); f.search.dispose();
});
it('rejects pending search results after document replacement', async () => {
  const f = fixture(); const pending = f.search.searchQuery('word'); const rejected = expect(pending).rejects.toThrow('document or search changed');
  f.search.reset(); f.release(); await rejected; expect(f.search.getState()).toBeUndefined();
});
