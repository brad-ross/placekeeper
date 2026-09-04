import type {
  PdfAnnotationObject,
  PdfDocumentObject,
  PdfEngine,
} from '@embedpdf/models';
import { describe, expect, it } from 'vitest';

import { annotationPages } from '../src/browser-writer.js';

describe('annotationPages', () => {
  it('bounds page reads while retaining document page order', async () => {
    const pageCount = 40;
    const pages = Array.from({ length: pageCount }, (_, index) => ({ index }));
    const document = { pages } as unknown as PdfDocumentObject;
    let activeReads = 0;
    let maximumActiveReads = 0;

    const engine = {
      getPageAnnotations: (_document: PdfDocumentObject, page: { index: number }) => ({
        toPromise: async () => {
          activeReads += 1;
          maximumActiveReads = Math.max(maximumActiveReads, activeReads);
          try {
            await new Promise((resolve) => setTimeout(resolve, (pageCount - page.index) % 7));
            return [{ id: `page-${page.index}` }] as PdfAnnotationObject[];
          } finally {
            activeReads -= 1;
          }
        },
      }),
    } as unknown as PdfEngine<Blob>;

    const results = await annotationPages(engine, document);

    expect(maximumActiveReads).toBe(8);
    expect(results.map(([annotation]) => annotation?.id)).toEqual(
      pages.map(({ index }) => `page-${index}`),
    );
  });
});
