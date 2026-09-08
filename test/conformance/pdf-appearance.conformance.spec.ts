import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import { projectReviewItem } from '../../packages/core/src/annotation-projection.js';
import type { ReviewItem } from '../../packages/core/src/review-model.js';
import { readPortableReviewItems } from '../../packages/pdf-backends/src/embedpdf-adapter.js';

/** Exercise the real browser worker and serializer, independent of authoring gestures. */
test('browser export draws and reimports all five editable mark types', async ({ page }) => {
  const source = new Uint8Array(await readFile(resolve('test/fixtures/pdfs/text-native.pdf')));
  const kinds = ['highlight', 'replace', 'delete', 'insert', 'pageNote'] as const;
  const items: ReviewItem[] = kinds.map((kind, index) => {
    const rect = { x: 72, y: 120 + index * 40, width: kind === 'insert' ? 2 : kind === 'pageNote' ? 18 : 120, height: 18 };
    return {
      id: `70000000-0000-4000-8000-00000000002${index}`, kind, pageIndex: 0,
      createdAt: '2026-09-08T12:00:00.000Z', updatedAt: '2026-09-08T12:00:00.000Z',
      payload: kind === 'pageNote' ? { position: rect, comment: 'Page comment' }
        : kind === 'insert' ? { position: rect, leftContext: 'before', rightContext: 'after', reliable: true, proposedText: 'Inserted' }
        : { rect, segmentRects: [rect], quote: 'text', prefix: '', suffix: '', reliable: true,
            ...(kind === 'replace' ? { proposedText: 'Replacement' } : kind === 'highlight' ? { comment: 'Comment' } : {}) },
    };
  });
  await page.goto('/test/conformance/viewer-harness/index.html');
  const bytes = await page.evaluate(async (request) => {
    const modulePath = '/packages/pdf-backends/src/browser-writer.ts';
    const { createBrowserEmbedPdfWriter } = await import(modulePath);
    const writer = await createBrowserEmbedPdfWriter(new URL('/test/fixtures/pdfium/pdfium.wasm', location.href).href);
    try {
      const result = await writer.write({ ...request, sourcePdf: new Uint8Array(request.sourcePdf) });
      return Array.from(result.pdfBytes as Uint8Array);
    } finally { await writer.dispose(); }
  }, { sourcePdf: Array.from(source), sourceSha256: createHash('sha256').update(source).digest('hex'), revision: 1, annotations: items.map((item) => projectReviewItem(item)) });
  const pdfBytes = new Uint8Array(bytes);
  expect(await readPortableReviewItems(pdfBytes)).toEqual(items);
  const pdf = await PDFDocument.load(pdfBytes);
  const annots = pdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
  expect(annots.size()).toBe(5);
  for (let index = 0; index < annots.size(); index++) {
    const stream = annots.lookup(index, PDFDict).lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
    expect(stream.dict.lookup(PDFName.of('PlacekeeperStyleVersion'), PDFNumber).asNumber()).toBe(1);
  }
});
