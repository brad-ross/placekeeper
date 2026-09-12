import { readFileSync } from 'node:fs';
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { restoreDemoPageNumbers } from '../src/landing/create-demo-document.js';
import pageMap from '../src/landing/assets/demo-page-map.json';

const excerpt = readFileSync(new URL('../src/landing/assets/counterfactual-matrix-means.pdf', import.meta.url));

describe('demo paper excerpt', () => {
  it('ships only retained pages and restores original numbering with empty placeholders', async () => {
    expect(excerpt.byteLength).toBeLessThan(1_000_000);
    expect((await PDFDocument.load(excerpt)).getPageCount()).toBe(33);
    const restored = await PDFDocument.load(await restoreDemoPageNumbers(excerpt));
    expect(restored.getPageCount()).toBe(100);
    restored.getPages().forEach((page, index) => {
      expect(page.node.Contents() !== undefined).toBe(pageMap.originalPages.includes(index + 1));
    });
    const retainedRefs = new Set(pageMap.originalPages.map((page) => restored.getPage(page - 1).ref.toString()));
    let links = 0;
    for (const page of [14, 15, 16]) {
      const annotations = restored.getPage(page - 1).node.Annots()!;
      for (let i = 0; i < annotations.size(); i += 1) {
        const annotation = annotations.lookup(i, PDFDict);
        const destination = annotation.lookup(PDFName.of('Dest'), PDFArray);
        expect(retainedRefs.has(destination.get(0).toString())).toBe(true);
        links += 1;
      }
    }
    expect(links).toBe(59);
  });

  it('rejects a document that does not match the committed page map', async () => {
    const invalid = await PDFDocument.create();
    invalid.addPage();
    await expect(restoreDemoPageNumbers(await invalid.save())).rejects.toThrow('page map');
  });
});
