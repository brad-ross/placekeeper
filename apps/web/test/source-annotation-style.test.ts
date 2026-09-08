import { describe, expect, it, vi } from 'vitest';
import { PdfAnnotationSubtype, type PdfEngine, type PdfDocumentObject } from '@embedpdf/models';
import { sourceMarkVariables } from '../src/pdf/SourceAnnotationMark.js';
import { inventoryDocumentAnnotations } from '../src/pdf/existing-annotations.js';
import { PDFDocument } from 'pdf-lib';
import { fetchSourceAnnotationStyles, readSourceAnnotationStyles } from '../src/pdf/source-annotation-style.js';

describe('source annotation reader styling', () => {
  it('uses reader defaults only where the PDF leaves styling unspecified', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const entries = [
      { Subtype: 'Highlight' },
      { Subtype: 'StrikeOut', C: [0, 1, 0], CA: 0.4 },
      { Subtype: 'Highlight', AP: { N: pdf.context.register(pdf.context.stream('custom drawing')) } },
      { Subtype: 'Text', Name: 'Key' },
      { Subtype: 'Ink' },
      { Subtype: 'Highlight', CA: 0 },
      { Subtype: 'Highlight', CA: 1 },
      { Subtype: 'Underline', BS: { W: 4 } },
    ];
    page.node.set(pdf.context.obj('Annots'), pdf.context.obj(entries.map((entry) => pdf.context.register(pdf.context.obj({ Type: 'Annot', Rect: [0, 0, 100, 20], ...entry })))));
    const styles = await readSourceAnnotationStyles(await pdf.save());
    expect(styles.byIndex.get('0:0')).toEqual({});
    expect(styles.byIndex.get('0:1')).toEqual({ hasExplicitColor: true, opacity: 0.4 });
    for (const index of [2, 3, 4, 7]) expect(styles.byIndex.has(`0:${index}`)).toBe(false);
    expect(styles.byIndex.get('0:5')).toEqual({ opacity: 0 });
    expect(styles.byIndex.get('0:6')).toEqual({ opacity: 1 });
  });
});


it('ignores synthetic engine defaults and retains explicitly saved opacity including zero', () => {
  const annotation = { id: 'source', pageIndex: 0, type: PdfAnnotationSubtype.HIGHLIGHT as const,
    rect: { origin: { x: 0, y: 0 }, size: { width: 100, height: 18 } },
    segmentRects: [], opacity: 1, strokeColor: '#00ff00' };
  expect(sourceMarkVariables(annotation, {})).toEqual({});
  expect(sourceMarkVariables(annotation, { hasExplicitColor: true, opacity: 0.65 })).toMatchObject({
    opacity: 0.65, '--pdf-note-ink': '#00ff00', '--pdf-edit-ink': '#00ff00',
  });
  expect(sourceMarkVariables(annotation, { opacity: 0 })).toMatchObject({ opacity: 0 });
});

it('preserves native rendering if source and engine annotation inventories disagree', async () => {
  const annotation = { id: 'source', pageIndex: 0, type: PdfAnnotationSubtype.HIGHLIGHT,
    rect: { origin: { x: 0, y: 0 }, size: { width: 100, height: 18 } },
    segmentRects: [], opacity: 1 };
  const engine = { getAllAnnotations: () => ({ toPromise: async () => ({ 0: [annotation] }) }) } as unknown as PdfEngine;
  const document = { pages: [{}] } as PdfDocumentObject;
  const mismatched = await inventoryDocumentAnnotations(engine, document, {
    byIndex: new Map([['0:0', {}]]), pageAnnotationCounts: [2],
  });
  expect(mismatched[0]?.readerStyle).toBeUndefined();
  const matched = await inventoryDocumentAnnotations(engine, document, {
    byIndex: new Map([['0:0', {}]]), pageAnnotationCounts: [1],
  });
  expect(matched[0]?.readerStyle).toEqual({});
});


it('falls back to native rendering when the optional source request fails or reaches its deadline', async () => {
  const controller = new AbortController();
  const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const fetchStub = vi.fn((_url: string, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('request deadline')), { once: true });
  }));
  vi.stubGlobal('fetch', fetchStub);
  try {
    const result = fetchSourceAnnotationStyles({ url: 'https://reader.test/document.pdf', requestOptions: { credentials: 'omit' } });
    controller.abort();
    expect(await result).toEqual({ byIndex: new Map(), pageAnnotationCounts: [] });
    expect(deadline).toHaveBeenCalledWith(10_000);
    expect(fetchStub).toHaveBeenCalledWith('https://reader.test/document.pdf', expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
    fetchStub.mockRejectedValueOnce(new Error('source unavailable'));
    expect(await fetchSourceAnnotationStyles({ url: 'https://reader.test/document.pdf' })).toEqual({ byIndex: new Map(), pageAnnotationCounts: [] });
  } finally {
    deadline.mockRestore();
    vi.unstubAllGlobals();
  }
});
