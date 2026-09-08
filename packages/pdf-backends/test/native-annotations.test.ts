import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { PdfAnnotationSubtype } from '@embedpdf/models';
import { projectReviewItem } from '../../core/src/annotation-projection.js';
import { nativeAnnotationsFromPages, rewriteNativePdfAnnotations } from '../src/native-annotations.js';

const mark = {
  id: 'adobe-mark', pageIndex: 0, type: PdfAnnotationSubtype.HIGHLIGHT as const,
  strokeColor: '#00ff00', opacity: 0.37,
  segmentRects: [{ origin: { x: 40, y: 50 }, size: { width: 100, height: 12 } }],
  rect: { origin: { x: 40, y: 50 }, size: { width: 100, height: 12 } },
  contents: 'Original comment', author: 'Another reviewer', flags: ['print'] as ['print'],
};

describe('standard PDF comment interoperability', () => {
  it('imports standard marks without private metadata, including empty comments', () => {
    const native = nativeAnnotationsFromPages([[mark, { ...mark, id: 'second', contents: '' }]], []);
    expect(native).toHaveLength(2);
    expect(native[0]?.item).toMatchObject({ kind: 'pdfAnnotation', payload: { subtype: 'highlight', comment: 'Original comment', author: 'Another reviewer' } });
    expect(native[1]?.item.payload.comment).toBe('');
    expect(native[0]?.item.id).not.toBe(native[1]?.item.id);
  });

  it('preserves the original appearance and author when editing a comment', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const appearance = pdf.context.register(pdf.context.flateStream('0 1 0 rg 0 0 100 12 re f', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 12],
    }));
    const annotation = pdf.context.obj({
      Type: 'Annot', Subtype: 'Highlight', Rect: [40, 730, 140, 742],
      QuadPoints: [40, 742, 140, 742, 40, 730, 140, 730], C: [0, 1, 0], CA: 0.37,
      Contents: PDFString.of('Original comment'), T: PDFString.of('Another reviewer'),
      AP: { N: appearance }, NM: PDFString.of('adobe-mark'),
    });
    page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(annotation)]));
    const source = await pdf.save();
    const native = nativeAnnotationsFromPages([[mark]], []);
    const item = native[0]!.item;
    const edited = { ...item, payload: { ...item.payload, comment: 'Edited in Placekeeper' } };
    const output = await rewriteNativePdfAnnotations(source, native, [projectReviewItem(edited)]);
    const reopened = await PDFDocument.load(output);
    const annots = reopened.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const saved = annots.lookup(0, PDFDict);
    expect(saved.lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe('Edited in Placekeeper');
    expect(saved.lookup(PDFName.of('T'), PDFString).decodeText()).toBe('Another reviewer');
    expect(saved.lookup(PDFName.of('C'), PDFArray).toString()).toBe('[ 0 1 0 ]');
    expect(saved.get(PDFName.of('CA'))?.toString()).toBe('0.37');
    const savedAppearance = saved.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'));
    expect(savedAppearance!.toString()).toBe(pdf.context.lookup(appearance)!.toString());
    const deleted = await PDFDocument.load(await rewriteNativePdfAnnotations(output, native, []));
    expect(deleted.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).size()).toBe(0);
  });
});
