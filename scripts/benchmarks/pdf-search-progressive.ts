// Run with node --import tsx scripts/benchmarks/pdf-search-progressive.ts.
import { performance } from 'node:perf_hooks';
import { createPdfSearchController, type PdfSearchPageSnapshot } from '../../apps/web/src/pdf/pdf-search-controller.js';

const text = 'x '.repeat(150);
const snapshot: PdfSearchPageSnapshot = {
  text,
  glyphs: Array.from(text, (_, index) => ({ origin: { x: index * 5, y: 10 }, size: { width: 5, height: 8 } })),
  geometry: { width: 1600, height: 800, cropLeft: 0, cropTop: 0, cropBottom: 0 },
  textRects: [{ content: text, rect: { origin: { x: 0, y: 10 }, size: { width: 1500, height: 8 } } }],
};
for (const pageCount of [250, 1000]) {
  const durations: number[] = [];
  for (let run = 0; run < 4; run += 1) {
    let publications = 0;
    const controller = createPdfSearchController({
      documentGeneration: 1,
      reader: { pageCount, async read() { return snapshot; } },
    });
    controller.subscribe(() => { publications += 1; });
    const start = performance.now();
    const state = await controller.search('x');
    const duration = performance.now() - start;
    if (state.groups[0]?.results.length !== pageCount * 150 || publications !== pageCount + 2) {
      throw new Error('Benchmark search results or publication cadence changed');
    }
    if (run > 0) durations.push(duration);
    controller.dispose();
  }
  durations.sort((a, b) => a - b);
  console.log(JSON.stringify({ pageCount, matches: pageCount * 150, publications: pageCount + 2, medianMs: durations[1], durations }));
}
