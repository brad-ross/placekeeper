import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { PdfiumNative } from '@embedpdf/engines/pdfium';
import { init } from '@embedpdf/pdfium';

import type { PdfWriteRequest, ReviewAnnotation } from '../../packages/core/src/pdf-writer.js';
import { PdfWriterError } from '../../packages/core/src/pdf-writer.js';
import {
  documentOrderedItems,
  projectReviewItem,
  projectReviewItemProjections,
} from '../../packages/core/src/annotation-projection.js';
import { MAX_REVIEW_SELECTION_SEGMENTS } from '../../packages/core/src/review-reducer.js';
import type { ReviewItem, ReviewState } from '../../packages/core/src/review-model.js';
import {
  createEmbedPdfWriter,
  inspectPdfWithEmbedPdf,
  migrateLegacyReviewStateGeometry,
  readPortableReviewItems,
} from '../../packages/pdf-backends/src/embedpdf-adapter.js';
import { runPdfBackend } from '../../packages/pdf-backends/src/backend-host.js';

const fixtures = resolve('test/fixtures/pdfs');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const annotations: readonly ReviewAnnotation[] = [
  {
    kind: 'replace',
    id: '11111111-1111-4111-8111-111111111111',
    pageIndex: 0,
    rect: { x: 72, y: 92, width: 150, height: 16 },
    quadPoints: [{ x: 72, y: 92, width: 150, height: 16 }],
    contents: 'locally unique equilibrium',
    author: 'Placekeeper',
    createdAt: '2026-08-06T12:00:00.000Z',
    modifiedAt: '2026-08-06T12:00:00.000Z',
    textAnchorReliable: true,
  },
  {
    kind: 'delete',
    id: '22222222-2222-4222-8222-222222222222',
    pageIndex: 0,
    rect: { x: 230, y: 92, width: 55, height: 16 },
    quadPoints: [{ x: 230, y: 92, width: 55, height: 16 }],
    contents: '',
    author: 'Placekeeper',
    createdAt: '2026-08-06T12:00:00.000Z',
    modifiedAt: '2026-08-06T12:00:00.000Z',
    textAnchorReliable: true,
  },
  {
    kind: 'insert',
    id: '33333333-3333-4333-8333-333333333333',
    pageIndex: 0,
    rect: { x: 292, y: 88, width: 14, height: 20 },
    contents: 'however',
    author: 'Placekeeper',
    createdAt: '2026-08-06T12:00:00.000Z',
    modifiedAt: '2026-08-06T12:00:00.000Z',
    textAnchorReliable: true,
  },
  {
    kind: 'highlight',
    id: '44444444-4444-4444-8444-444444444444',
    pageIndex: 0,
    rect: { x: 72, y: 120, width: 220, height: 34 },
    quadPoints: [
      { x: 72, y: 120, width: 220, height: 16 },
      { x: 72, y: 138, width: 130, height: 16 },
    ],
    contents: 'Check this argument.',
    author: 'Placekeeper',
    createdAt: '2026-08-06T12:00:00.000Z',
    modifiedAt: '2026-08-06T12:00:00.000Z',
    textAnchorReliable: true,
  },
  {
    kind: 'pageNote',
    id: '55555555-5555-4555-8555-555555555555',
    pageIndex: 0,
    rect: { x: 500, y: 700, width: 24, height: 24 },
    contents: 'Page-level comment.',
    author: 'Placekeeper',
    createdAt: '2026-08-06T12:00:00.000Z',
    modifiedAt: '2026-08-06T12:00:00.000Z',
  },
  {
    kind: 'highlight',
    id: '66666666-6666-4666-8666-666666666666',
    pageIndex: 0,
    rect: { x: 320, y: 120, width: 90, height: 16 },
    quadPoints: [{ x: 320, y: 120, width: 90, height: 16 }],
    contents: '',
    author: 'Placekeeper',
    createdAt: '2026-08-06T12:00:00.000Z',
    modifiedAt: '2026-08-06T12:00:00.000Z',
    textAnchorReliable: true,
  },
];

async function requestFor(name: string, items = annotations): Promise<PdfWriteRequest> {
  const sourcePdf = new Uint8Array(await readFile(resolve(fixtures, name)));
  return {
    sourcePdf,
    sourceSha256: sha256(sourcePdf),
    revision: 7,
    annotations: items,
  };
}

describe('EmbedPDF writer gate', () => {
  it('updates an app-drawn highlight when a comment is attached or removed', async () => {
    let item: ReviewItem = {
      id: '70000000-0000-4000-8000-000000000010', kind: 'highlight', pageIndex: 0,
      createdAt: '2026-09-08T12:00:00.000Z', updatedAt: '2026-09-08T12:00:00.000Z',
      payload: { rect: { x: 72, y: 120, width: 100, height: 16 }, segmentRects: [{ x: 72, y: 120, width: 100, height: 16 }], quote: 'test', prefix: '', suffix: '', reliable: true, comment: '' },
    };
    const writer = await createEmbedPdfWriter();
    let result = await runPdfBackend(writer, await requestFor('text-native.pdf', [projectReviewItem(item)]));
    expect(await readPortableReviewItems(result.pdfBytes)).toEqual([item]);
    for (const [comment, opacity] of [['Attached comment', .25], ['', .36]] as const) {
      item = { ...item, payload: { ...item.payload, comment }, updatedAt: comment ? '2026-09-08T12:01:00.000Z' : '2026-09-08T12:02:00.000Z' };
      result = await runPdfBackend(writer, { sourcePdf: result.pdfBytes, sourceSha256: sha256(result.pdfBytes), revision: 2, annotations: [projectReviewItem(item)] });
      expect(await readPortableReviewItems(result.pdfBytes)).toEqual([item]);
      const pdf = await PDFDocument.load(result.pdfBytes);
      const dictionary = pdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
      const stream = dictionary.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
      expect(stream.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('ExtGState'), PDFDict)
        .lookup(PDFName.of('PKFill'), PDFDict).lookup(PDFName.of('ca'), PDFNumber).asNumber()).toBe(opacity);
    }
  });

  it('renders correction lines, comment underlines, carets and note outlines without flattening them', async () => {
    const source = await PDFDocument.create();
    source.addPage([612, 792]);
    const sourcePdf = await source.save();
    const result = await runPdfBackend(await createEmbedPdfWriter(), {
      sourcePdf, sourceSha256: sha256(sourcePdf), revision: 1, annotations,
    });
    const engine = new PdfiumNative(await init({}), { fontFallback: null });
    const document = await engine.openDocumentBuffer({ id: 'appearance-shapes', content: result.pdfBytes.slice().buffer }).toPromise();
    try {
      const render = (withAnnotations: boolean) => engine.renderPageRaw(document, document.pages[0]!, {
        scaleFactor: 2, dpr: 1, rotation: 0, withAnnotations, withForms: false, transparentBackground: false,
      }).toPromise();
      const image = await render(true);
      const inkPixels = (x: number, y: number, width: number, height: number, matches: (r: number, g: number, b: number) => boolean) => {
        let count = 0;
        for (let row = y * 2; row < (y + height) * 2; row++) for (let column = x * 2; column < (x + width) * 2; column++) {
          const i = (row * image.width + column) * 4;
          if (matches(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!)) count++;
        }
        return count;
      };
      const red = (r: number, g: number, b: number) => r > g + 60 && g < 170 && b < 170;
      const gold = (r: number, g: number, b: number) => r > g && g > b + 50 && g < 170;
      const slate = (r: number, g: number, b: number) => b > g && g > r && b < 180;
      expect(inkPixels(72, 98, 150, 4, red)).toBeGreaterThan(300); // Replacement strike
      expect(inkPixels(230, 98, 55, 4, red)).toBeGreaterThan(100); // Deletion strike
      expect(inkPixels(72, 105, 150, 3, red)).toBeGreaterThan(100); // Replacement underline
      expect(inkPixels(72, 133, 220, 4, gold)).toBeGreaterThan(150); // Comment underline
      expect(inkPixels(292, 88, 20, 20, slate)).toBeGreaterThan(15); // Insertion caret
      expect(inkPixels(500, 700, 24, 24, gold)).toBeGreaterThan(15); // Note outline
      const hidden = await render(false);
      expect(hidden.data.every((channel) => channel === 255)).toBe(true);
    } finally {
      await engine.closeDocument(document).toPromise();
      await engine.destroy().toPromise();
    }
  });

  it('exports reader-style appearances without flattening editable annotation dictionaries', async () => {
    const result = await runPdfBackend(await createEmbedPdfWriter(), await requestFor('text-native.pdf'));
    const pdf = await PDFDocument.load(result.pdfBytes);
    const annots = pdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    for (let index = 0; index < annotations.length; index++) {
      const dictionary = annots.lookup(index, PDFDict);
      const stream = dictionary.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
      const resources = stream.dict.lookup(PDFName.of('Resources'), PDFDict);
      const states = resources.lookup(PDFName.of('ExtGState'), PDFDict);
      expect(states.lookup(PDFName.of('PKInk'), PDFDict).lookup(PDFName.of('CA'), PDFNumber).asNumber()).toBe(1);
      expect(new TextDecoder().decode(decodePDFRawStream(stream).decode())).toContain('/PKInk gs');
      expect(dictionary.has(PDFName.of('Contents'))).toBe(true);
      expect(dictionary.has(PDFName.of('NM'))).toBe(true);
    }
    const commented = annots.lookup(3, PDFDict).lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
    const plain = annots.lookup(5, PDFDict).lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
    const alpha = (stream: PDFRawStream) => stream.dict.lookup(PDFName.of('Resources'), PDFDict)
      .lookup(PDFName.of('ExtGState'), PDFDict).lookup(PDFName.of('PKFill'), PDFDict)
      .lookup(PDFName.of('ca'), PDFNumber).asNumber();
    expect(alpha(commented)).toBe(.25);
    expect(alpha(plain)).toBe(.36);
    expect(annots.lookup(3, PDFDict).lookup(PDFName.of('CA'), PDFNumber).asNumber()).toBe(.25);
    expect(annots.lookup(5, PDFDict).lookup(PDFName.of('CA'), PDFNumber).asNumber()).toBe(.36);

    const engine = new PdfiumNative(await init({}), { fontFallback: null });
    const document = await engine.openDocumentBuffer({ id: 'appearance-raster', content: result.pdfBytes.slice().buffer }).toPromise();
    try {
      const rendered = await engine.renderPageRaw(document, document.pages[0]!, {
        scaleFactor: 1, dpr: 1, rotation: 0, withAnnotations: true, withForms: false, transparentBackground: false,
      }).toPromise();
      const pixel = (x: number, y: number) => Array.from(rendered.data.slice((y * rendered.width + x) * 4, (y * rendered.width + x) * 4 + 4));
      // Blank portions of the two highlights: their wash must be translucent,
      // with no double application of /CA and the appearance's fill alpha.
      expect(pixel(80, 140)).toEqual([252, 240, 200, 255]);
      expect(pixel(350, 130)).toEqual([251, 233, 176, 255]);
    } finally {
      await engine.closeDocument(document).toPromise();
      await engine.destroy().toPromise();
    }
  });

  it.each([0, 90, 180, 270])('keeps a narrow insertion editable with a readable caret on a %i-degree cropped page', async (rotation) => {
    const item: ReviewItem = {
      id: '70000000-0000-4000-8000-000000000009', kind: 'insert', pageIndex: 0,
      createdAt: '2026-09-08T12:00:00.000Z', updatedAt: '2026-09-08T12:00:00.000Z',
      payload: { position: { x: 150, y: 120, width: 2, height: 18 }, leftContext: 'before', rightContext: 'after', reliable: true, proposedText: 'new text' },
    };
    const result = await runPdfBackend(await createEmbedPdfWriter(), await requestFor(`rotation-${rotation}-crop.pdf`, [projectReviewItem(item)]));
    expect(await readPortableReviewItems(result.pdfBytes)).toEqual([item]);
    const pdf = await PDFDocument.load(result.pdfBytes);
    const page = pdf.getPage(0);
    const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
    const dictionary = annots.lookup(annots.size() - 1, PDFDict);
    const stream = dictionary.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
    expect(stream.dict.lookup(PDFName.of('BBox'), PDFArray).asArray().map((value) => (value as PDFNumber).asNumber())).toEqual([0, 0, 20, 20]);
    const rect = dictionary.lookup(PDFName.of('Rect'), PDFArray).asArray().map((value) => (value as PDFNumber).asNumber());
    expect(rect[2]! - rect[0]!).toBe(20);
    expect(rect[3]! - rect[1]!).toBe(20);
    expect(new TextDecoder().decode(decodePDFRawStream(stream).decode())).toContain('1.5 w');
  });
  it('writes a three-page group with visible unique children and reopens one canonical item', async () => {
    const timestamp = '2026-09-03T12:00:00.000Z';
    const pages = [0, 1, 2].map((pageIndex) => ({
      pageIndex,
      quote: `page ${pageIndex + 1}`,
      prefix: pageIndex === 0 ? 'before ' : '',
      suffix: pageIndex === 2 ? ' after' : '',
      rect: { x: 72, y: 92 + pageIndex * 12, width: 120, height: 16 },
      segmentRects: [{ x: 72, y: 92 + pageIndex * 12, width: 120, height: 16 }],
    }));
    const item: ReviewItem = {
      id: '70000000-0000-4000-8000-000000000007',
      kind: 'highlight',
      pageIndex: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      payload: {
        quote: pages.map(({ quote }) => quote).join('\n'),
        prefix: pages[0]!.prefix,
        suffix: pages[2]!.suffix,
        rect: pages[0]!.rect,
        segmentRects: pages[0]!.segmentRects,
        pages,
        pageBoundaries: [
          { afterPageIndex: 0, separator: '\n' },
          { afterPageIndex: 1, separator: '\n' },
        ],
        reliable: true,
        comment: 'Cross-page evidence.',
      },
    };
    const projected = projectReviewItemProjections(item);
    const result = await runPdfBackend(
      await createEmbedPdfWriter(),
      await requestFor('pdf-search.pdf', projected),
    );
    const reopened = await inspectPdfWithEmbedPdf(result.pdfBytes);

    expect(await readPortableReviewItems(result.pdfBytes)).toEqual([item]);
    expect(reopened.portableItems).toEqual([item]);
    expect(reopened.annotations.filter(({ id }) => id.startsWith(`${item.id}:projection:`)))
      .toMatchObject(projected.map((annotation) => ({
        id: annotation.id,
        pageIndex: annotation.pageIndex,
        subtype: 'highlight',
        contents: 'Cross-page evidence.',
        author: 'Placekeeper',
        hasNormalAppearance: true,
      })));
  });

  it('rejects an incomplete requested v3 group before producing output', async () => {
    const timestamp = '2026-09-03T12:00:00.000Z';
    const item: ReviewItem = {
      id: '70000000-0000-4000-8000-000000000008',
      kind: 'delete',
      pageIndex: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      payload: {
        quote: 'page 1\npage 2',
        prefix: '',
        suffix: '',
        rect: { x: 72, y: 92, width: 120, height: 16 },
        segmentRects: [{ x: 72, y: 92, width: 120, height: 16 }],
        pages: [
          { pageIndex: 0, quote: 'page 1', prefix: '', suffix: '', rect: { x: 72, y: 92, width: 120, height: 16 }, segmentRects: [{ x: 72, y: 92, width: 120, height: 16 }] },
          { pageIndex: 1, quote: 'page 2', prefix: '', suffix: '', rect: { x: 72, y: 92, width: 120, height: 16 }, segmentRects: [{ x: 72, y: 92, width: 120, height: 16 }] },
        ],
        pageBoundaries: [{ afterPageIndex: 0, separator: '\n' }],
        reliable: true,
      },
    };
    const incomplete = projectReviewItemProjections(item).slice(0, 1);

    await expect(runPdfBackend(
      await createEmbedPdfWriter(),
      await requestFor('multi-page-text.pdf', incomplete),
    )).rejects.toMatchObject({ code: 'backend-error' });
  });

  it('round-trips editable metadata for every app annotation kind', async () => {
    const timestamp = '2026-08-11T12:00:00.000Z';
    const semanticItems: ReviewItem[] = [
      {
        id: '71111111-1111-4111-8111-111111111111', kind: 'replace', pageIndex: 0,
        createdAt: timestamp, updatedAt: timestamp,
        payload: { quote: 'unique', prefix: '', suffix: '', proposedText: 'locally unique', rect: { x: 72, y: 92, width: 90, height: 16 }, segmentRects: [{ x: 72, y: 92, width: 90, height: 16 }], reliable: true },
      },
      {
        id: '72222222-2222-4222-8222-222222222222', kind: 'delete', pageIndex: 0,
        createdAt: timestamp, updatedAt: timestamp,
        payload: { quote: 'clearly', prefix: '', suffix: '', rect: { x: 170, y: 92, width: 55, height: 16 }, segmentRects: [{ x: 170, y: 92, width: 55, height: 16 }], reliable: true },
      },
      {
        id: '73333333-3333-4333-8333-333333333333', kind: 'insert', pageIndex: 0,
        createdAt: timestamp, updatedAt: timestamp,
        payload: { proposedText: 'however', position: { x: 232, y: 88, width: 14, height: 20 }, leftContext: '', rightContext: '', reliable: true },
      },
      {
        id: '74444444-4444-4444-8444-444444444444', kind: 'highlight', pageIndex: 0,
        createdAt: timestamp, updatedAt: timestamp,
        payload: { quote: 'argument', prefix: '', suffix: '', comment: 'Check this.', rect: { x: 72, y: 120, width: 220, height: 16 }, segmentRects: [{ x: 72, y: 120, width: 220, height: 16 }], reliable: true },
      },
      {
        id: '75555555-5555-4555-8555-555555555555', kind: 'pageNote', pageIndex: 0,
        createdAt: timestamp, updatedAt: timestamp,
        payload: { position: { x: 500, y: 700, width: 18, height: 18 }, comment: 'Page-level comment.' },
      },
    ];
    const result = await runPdfBackend(
      await createEmbedPdfWriter(),
      await requestFor(
        'text-native-with-annotations.pdf',
        documentOrderedItems(semanticItems).map((item) => projectReviewItem(item)),
      ),
    );

    expect(await readPortableReviewItems(result.pdfBytes)).toEqual(documentOrderedItems(semanticItems));
  });

  it('round-trips editable Page Note metadata on a rotated cropped page', async () => {
    const note: ReviewItem = {
      id: '76666666-6666-4666-8666-666666666666',
      kind: 'pageNote',
      pageIndex: 0,
      createdAt: '2026-08-11T12:00:00.000Z',
      updatedAt: '2026-08-11T12:00:00.000Z',
      payload: {
        position: { x: 200, y: 300, width: 18, height: 18 },
        comment: 'Rotated geometry note.',
      },
    };
    const result = await runPdfBackend(
      await createEmbedPdfWriter(),
      await requestFor('rotation-90-crop.pdf', [projectReviewItem(note)]),
    );

    expect(await readPortableReviewItems(result.pdfBytes)).toEqual([note]);
  });

  it('reopens, edits, and deletes app annotations using portable PDF metadata', async () => {
    const originalItem: ReviewItem = {
      id: '77777777-7777-4777-8777-777777777777',
      kind: 'highlight',
      pageIndex: 0,
      createdAt: '2026-08-11T12:00:00.000Z',
      updatedAt: '2026-08-11T12:00:00.000Z',
      payload: {
        quote: 'unique equilibrium',
        prefix: 'text: ',
        suffix: ' clearly',
        rect: { x: 72, y: 92, width: 150, height: 16 },
        segmentRects: [{ x: 72, y: 92, width: 150, height: 16 }],
        reliable: true,
        comment: 'First comment',
      },
    };
    const first = await runPdfBackend(
      await createEmbedPdfWriter(),
      await requestFor('text-native-with-annotations.pdf', [projectReviewItem(originalItem)]),
    );
    expect(await readPortableReviewItems(first.pdfBytes)).toEqual([originalItem]);

    const editedItem: ReviewItem = {
      ...originalItem,
      updatedAt: '2026-08-11T12:01:00.000Z',
      payload: { ...originalItem.payload, comment: 'Edited after reopen' },
    };
    const edited = await runPdfBackend(await createEmbedPdfWriter(), {
      sourcePdf: first.pdfBytes,
      sourceSha256: sha256(first.pdfBytes),
      revision: 2,
      annotations: [projectReviewItem(editedItem)],
    });
    expect(await readPortableReviewItems(edited.pdfBytes)).toEqual([editedItem]);
    expect(edited.evidence.preexistingAnnotationIds).toEqual(
      expect.arrayContaining(['existing-highlight', 'existing-stamp']),
    );

    const deleted = await runPdfBackend(await createEmbedPdfWriter(), {
      sourcePdf: edited.pdfBytes,
      sourceSha256: sha256(edited.pdfBytes),
      revision: 3,
      annotations: [],
    });
    expect(await readPortableReviewItems(deleted.pdfBytes)).toEqual([]);
    expect((await inspectPdfWithEmbedPdf(deleted.pdfBytes)).annotations.map(({ id }) => id)).toEqual(
      expect.arrayContaining(['existing-highlight', 'existing-stamp']),
    );
  });

  it('round-trips a 33-segment highlight with prior Placekeeper marks and source links intact', async () => {
    const timestamp = '2026-08-25T12:00:00.000Z';
    const priorHighlight: ReviewItem = {
      id: '80000000-0000-4000-8000-000000000008',
      kind: 'highlight',
      pageIndex: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      payload: {
        quote: 'prior highlight',
        prefix: '',
        suffix: '',
        rect: { x: 72, y: 72, width: 90, height: 8 },
        segmentRects: [{ x: 72, y: 72, width: 90, height: 8 }],
        reliable: true,
      },
    };
    const segmentRects = Array.from({ length: 33 }, (_, index) => ({
      x: 72,
      y: 92 + index * 8,
      width: 120,
      height: 8,
    }));
    const longHighlight: ReviewItem = {
      id: '90000000-0000-4000-8000-000000000009',
      kind: 'highlight',
      pageIndex: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      payload: {
        quote: 'legitimate long selection',
        prefix: '',
        suffix: '',
        rect: { x: 72, y: 92, width: 120, height: 264 },
        segmentRects,
        reliable: true,
      },
    };
    const first = await runPdfBackend(
      await createEmbedPdfWriter(),
      await requestFor('preservation-corpus.pdf', [projectReviewItem(priorHighlight)]),
    );
    const second = await runPdfBackend(await createEmbedPdfWriter(), {
      sourcePdf: first.pdfBytes,
      sourceSha256: sha256(first.pdfBytes),
      revision: 7,
      annotations: [projectReviewItem(priorHighlight), projectReviewItem(longHighlight)],
    });
    const reopened = await inspectPdfWithEmbedPdf(second.pdfBytes);

    expect(reopened.portableItems).toEqual(
      expect.arrayContaining([priorHighlight, longHighlight]),
    );
    expect(reopened.portableItems).toHaveLength(2);
    expect(reopened.annotations.map(({ id }) => id)).toEqual(expect.arrayContaining([
      'preserved-link',
      priorHighlight.id,
      longHighlight.id,
    ]));
    expect(reopened.annotations.find(({ id }) => id === longHighlight.id)?.segmentRects)
      .toEqual(segmentRects.map(({ x, y, width, height }) => ({
        origin: { x, y },
        size: { width, height },
      })));
  });

  it('round-trips editable metadata for a highlight at the shared segment limit', async () => {
    const timestamp = '2026-08-25T12:00:00.000Z';
    const segmentRects = Array.from({ length: MAX_REVIEW_SELECTION_SEGMENTS }, (_, index) => ({
      x: 72,
      y: 92 + index * 2,
      width: 120,
      height: 2,
    }));
    const highlight: ReviewItem = {
      id: 'a0000000-0000-4000-8000-00000000000a',
      kind: 'highlight',
      pageIndex: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      payload: {
        quote: 'maximum legitimate selection',
        prefix: '',
        suffix: '',
        rect: { x: 72, y: 92, width: 120, height: MAX_REVIEW_SELECTION_SEGMENTS * 2 },
        segmentRects,
        reliable: true,
      },
    };
    const result = await runPdfBackend(
      await createEmbedPdfWriter(),
      await requestFor('preservation-corpus.pdf', [projectReviewItem(highlight)]),
    );

    expect(await readPortableReviewItems(result.pdfBytes)).toEqual([highlight]);
    const reopened = await inspectPdfWithEmbedPdf(result.pdfBytes);
    expect(reopened.portableItems).toEqual([highlight]);
    expect(reopened.annotations.find(({ id }) => id === highlight.id)?.segmentRects)
      .toEqual(segmentRects.map(({ x, y, width, height }) => ({
        origin: { x, y },
        size: { width, height },
      })));
  });

  it('writes all five standard mappings, reopens, and preserves the source and existing annotations', async () => {
    const request = await requestFor('text-native-with-annotations.pdf');
    const original = request.sourcePdf.slice();
    const writer = await createEmbedPdfWriter();

    const result = await runPdfBackend(writer, request, {
      timeoutMs: 15_000,
      maxSourceBytes: 2_000_000,
      maxOutputBytes: 4_000_000,
    });

    expect(request.sourcePdf).toEqual(original);
    expect(result.pdfBytes).not.toEqual(original);
    expect(result.evidence.originalSha256).toBe(request.sourceSha256);
    expect(result.evidence.outputSha256).toBe(sha256(result.pdfBytes));
    expect(result.evidence.pageCount).toBe(1);
    expect(result.evidence.structurallyValid).toBe(true);
    expect(result.evidence.preexistingAnnotationIds).toEqual(
      expect.arrayContaining(['existing-highlight', 'existing-stamp']),
    );

    await mkdir(resolve('output/pdf'), { recursive: true });
    await writeFile(resolve('output/pdf/u1-all-annotations-golden.pdf'), result.pdfBytes);

    const reopened = await inspectPdfWithEmbedPdf(result.pdfBytes);
    expect(reopened.annotationSubtypes).toEqual(
      expect.arrayContaining(['strikeOut', 'highlight', 'text', 'stamp']),
    );
    const expectedSubtype: Partial<Record<ReviewAnnotation['kind'], string>> = {
      replace: 'strikeOut',
      delete: 'strikeOut',
      insert: 'text',
      highlight: 'highlight',
      pageNote: 'text',
    };
    for (const annotation of annotations) {
      const written = reopened.annotations.find((candidate) => candidate.id === annotation.id);
      expect(written, annotation.id).toBeDefined();
      expect(written?.subtype).toBe(expectedSubtype[annotation.kind]);
      expect(written?.contents).toBe(annotation.contents);
      expect(written?.author).toBe(annotation.author);
      expect(written?.flags).toContain('print');
      expect(written?.hasNormalAppearance).toBe(true);
    }
  });

  it.each([0, 90, 180, 270])(
    'preserves annotation geometry on a %i-degree cropped page',
    async (rotation) => {
      const request = await requestFor(`rotation-${rotation}-crop.pdf`, [annotations[3]!]);
      const result = await runPdfBackend(await createEmbedPdfWriter(), request);
      const reopened = await inspectPdfWithEmbedPdf(result.pdfBytes);
      const written = reopened.annotations.find(({ id }) => id === annotations[3]!.id);

      expect(written?.segmentRects?.[0]).toEqual({
        origin: {
          x: annotations[3]!.quadPoints![0]!.x,
          y: annotations[3]!.quadPoints![0]!.y,
        },
        size: {
          width: annotations[3]!.quadPoints![0]!.width,
          height: annotations[3]!.quadPoints![0]!.height,
        },
      });
      expect(written?.hasNormalAppearance).toBe(true);
    },
  );

  it('rejects annotation geometry outside the crop-relative page canvas', async () => {
    const offPage = {
      ...annotations[1]!,
      rect: { x: 391, y: 881, width: 5, height: 16 },
      quadPoints: [{ x: 391, y: 89, width: 5, height: 16 }],
    };

    await expect(
      runPdfBackend(
        await createEmbedPdfWriter(),
        await requestFor('text-native.pdf', [offPage]),
      ),
    ).rejects.toMatchObject({
      code: 'invalid-annotation-geometry',
      message: expect.stringMatching(/outside page 0/iu),
    });
  });

  it('rejects an off-page quad even when the enclosing annotation rect is valid', async () => {
    const invalidQuad = {
      ...annotations[1]!,
      rect: { x: 391, y: 89, width: 5, height: 16 },
      quadPoints: [{ x: 391, y: 881, width: 5, height: 16 }],
    };

    await expect(
      runPdfBackend(
        await createEmbedPdfWriter(),
        await requestFor('text-native.pdf', [invalidQuad]),
      ),
    ).rejects.toMatchObject({ code: 'invalid-annotation-geometry' });
  });

  it('migrates legacy draft items and undo history from CropBox-offset geometry', async () => {
    const sourcePdf = new Uint8Array(await readFile(resolve(fixtures, 'text-native.pdf')));
    const legacyItem: ReviewItem = {
      id: '78888888-8888-4888-8888-888888888888',
      kind: 'highlight',
      pageIndex: 0,
      createdAt: '2026-08-11T12:00:00.000Z',
      updatedAt: '2026-08-11T12:00:00.000Z',
      payload: {
        quote: 'unique',
        prefix: '',
        suffix: '',
        rect: { x: 72, y: 884, width: 90, height: 16 },
        segmentRects: [{ x: 72, y: 884, width: 90, height: 16 }],
        reliable: true,
        comment: '',
      },
    };
    const legacyState: ReviewState = {
      schemaVersion: 1,
      sessionId: 'legacy-session',
      source: { fileId: 'source', digest: sha256(sourcePdf), byteLength: sourcePdf.byteLength },
      revision: 1,
      lifecycle: 'active',
      items: [legacyItem],
      workflow: { schemaVersion: 1, mode: 'standard', documentRole: 'source-pdf', documentGeneration: 1, freshness: 'current', historyBoundary: 0 },
      pendingDrafts: [],
      discardAudit: [],
      history: [{ beforeItems: [], afterItems: [legacyItem] }],
      historyCursor: 1,
    };

    const migrated = await migrateLegacyReviewStateGeometry(sourcePdf, legacyState);

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.items[0]?.payload.rect).toEqual({ x: 72, y: 92, width: 90, height: 16 });
    expect(migrated.items[0]?.payload.segmentRects).toEqual([
      { x: 72, y: 92, width: 90, height: 16 },
    ]);
    expect(migrated.history[0]?.afterItems[0]?.payload.rect).toEqual({
      x: 72,
      y: 92,
      width: 90,
      height: 16,
    });
  });

  it('round-trips Unicode review content without inventing source text', async () => {
    const contents = '日本語; العربية; ﬁ; soft\u00adhyphen; e\u0301';
    const unicodeAnnotation = { ...annotations[3]!, contents };
    const result = await runPdfBackend(
      await createEmbedPdfWriter(),
      await requestFor('text-native.pdf', [unicodeAnnotation]),
    );
    const reopened = await inspectPdfWithEmbedPdf(result.pdfBytes);

    expect(reopened.annotations.find(({ id }) => id === unicodeAnnotation.id)?.contents).toBe(
      contents,
    );
  });

  it('preserves hostile-action annotations as inert source objects while adding review data', async () => {
    const result = await runPdfBackend(
      await createEmbedPdfWriter(),
      await requestFor('hostile-actions.pdf', [annotations[4]!]),
    );

    expect(result.evidence.preexistingAnnotationIds).toHaveLength(1);
    expect((await inspectPdfWithEmbedPdf(result.pdfBytes)).annotationSubtypes).toContain('link');
  });

  it('rejects malformed PDFs with a typed failure', async () => {
    await expect(
      runPdfBackend(
        await createEmbedPdfWriter(),
        await requestFor('malformed.pdf', [annotations[4]!]),
      ),
    ).rejects.toMatchObject({ code: 'invalid-pdf' });
  });

  it('rejects unreliable semantic markup without emitting output', async () => {
    const request = await requestFor('image-only.pdf', [
      { ...annotations[0]!, textAnchorReliable: false },
    ]);
    const writer = await createEmbedPdfWriter();

    await expect(runPdfBackend(writer, request)).rejects.toMatchObject({
      code: 'unreliable-text-geometry',
    });
  });

  it.each([
    ['encrypted-no-annotation.pdf', 'encrypted'],
    ['docmdp-no-annotation.pdf', 'signature-restricted'],
  ] as const)('fails closed for %s', async (name, code) => {
    const writer = await createEmbedPdfWriter();
    await expect(runPdfBackend(writer, await requestFor(name))).rejects.toMatchObject({ code });
  });

  it('enforces digest, resource, cancellation, and timeout boundaries with typed errors', async () => {
    const writer = await createEmbedPdfWriter();
    const mismatched = await requestFor('text-native.pdf');
    mismatched.sourceSha256 = '0'.repeat(64);
    await expect(runPdfBackend(writer, mismatched)).rejects.toMatchObject({
      code: 'source-digest-mismatch',
    });

    const oversized = await requestFor('text-native.pdf');
    await expect(runPdfBackend(writer, oversized, { maxSourceBytes: 1 })).rejects.toMatchObject({
      code: 'resource-limit',
    });

    await expect(
      runPdfBackend(writer, await requestFor('text-native.pdf'), { maxOutputBytes: 1 }),
    ).rejects.toMatchObject({ code: 'resource-limit' });

    const controller = new AbortController();
    controller.abort();
    await expect(
      runPdfBackend(writer, await requestFor('text-native.pdf'), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });

    const neverWriter = { write: () => new Promise<never>(() => undefined) };
    await expect(
      runPdfBackend(neverWriter, await requestFor('text-native.pdf'), { timeoutMs: 10 }),
    ).rejects.toEqual(expect.any(PdfWriterError));
    await expect(
      runPdfBackend(neverWriter, await requestFor('text-native.pdf'), { timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});
