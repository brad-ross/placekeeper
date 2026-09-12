import { PDFDocument } from 'pdf-lib';
import pageMap from './assets/demo-page-map.json';

/** Preserve original destination indices without shipping omitted page content. */
export async function restoreDemoPageNumbers(excerpt: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(excerpt);
  if (pdf.getPageCount() !== pageMap.originalPages.length) throw new Error('The demo page map does not match its document.');
  const retained = new Set(pageMap.originalPages);
  const { width, height } = pdf.getPage(0).getSize();
  for (let page = 1; page <= pageMap.originalPageCount; page += 1) {
    if (!retained.has(page)) pdf.insertPage(page - 1, [width, height]);
  }
  // Insertion preserves retained page objects, so links and outline destinations
  // continue to point to them, now at their original indices. Placeholders are
  // created only in memory and cannot be reached through the filtered outline.
  return pdf.save();
}

export async function createDemoDocument(): Promise<Uint8Array> {
  const response = await fetch(new URL('./assets/counterfactual-matrix-means.pdf', import.meta.url));
  if (!response.ok) throw new Error('The demo document could not load.');
  return restoreDemoPageNumbers(new Uint8Array(await response.arrayBuffer()));
}
