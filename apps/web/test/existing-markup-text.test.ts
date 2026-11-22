import { randomUUID } from 'node:crypto';
import { PdfiumNative } from '@embedpdf/engines/pdfium';
import type { PdfEngine, PdfGlyphObject } from '@embedpdf/models';
import { init } from '@embedpdf/pdfium';
import { PDFArray, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inventoryDocumentAnnotations } from '../src/pdf/existing-annotations.js';
import { markedTextFromGlyphs } from '../src/pdf/markup-text.js';
import { annotationContent, existingAnnotationContent, withImportedMarkedText } from '../src/review/annotation-content.js';
import { importedMarkedTextBySourceObject } from '../src/pdf/existing-annotations.js';
import type { Annotation } from '../../../packages/core/src/review-model.js';
import { projectExistingAnnotationReader } from '../src/review/annotation-reader.js';

const LINE_ONE = 'The design compares outcomes within narrowly defined markets.';
const LINE_TWO = 'Aggregate shocks are absorbed before the coefficient is estimated.';
const FONT_SIZE = 12;

/** A page with two lines of text and markup another app wrote over parts of them. */
async function markedUpPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText(LINE_ONE, { x: 72, y: 700, size: FONT_SIZE, font });
  page.drawText(LINE_TWO, { x: 72, y: 680, size: FONT_SIZE, font });
  const width = (text: string) => font.widthOfTextAtSize(text, FONT_SIZE);
  // Quad for a run of text on a baseline, in PDF user space.
  const quad = (baseline: number, startText: string, text: string) => {
    const left = 72 + width(startText);
    const right = left + width(text);
    const top = baseline + FONT_SIZE * 0.95;
    const bottom = baseline - FONT_SIZE * 0.25;
    return [left, top, right, top, left, bottom, right, bottom];
  };
  const annotate = (subtype: string, id: string, contents: string, quads: number[]) => {
    const xs = quads.filter((_, index) => index % 2 === 0);
    const ys = quads.filter((_, index) => index % 2 === 1);
    const annotation = document.context.obj({
      Type: 'Annot',
      Subtype: subtype,
      NM: PDFString.of(id),
      Contents: PDFString.of(contents),
      Rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      QuadPoints: quads,
      C: [1, 0.9, 0.2],
      F: 4,
    });
    let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) {
      annots = PDFArray.withContext(document.context);
      page.node.set(PDFName.of('Annots'), annots);
    }
    annots.push(document.context.register(annotation));
  };
  annotate('Highlight', 'single-line', 'Which markets?', quad(700, 'The design compares ', 'outcomes within narrowly'));
  annotate('Highlight', 'two-lines', 'Spans the break.', [
    ...quad(700, 'The design compares outcomes within narrowly ', 'defined markets.'),
    ...quad(680, '', 'Aggregate shocks'),
  ]);
  annotate('StrikeOut', 'struck', '', quad(680, 'Aggregate shocks are absorbed before the ', 'coefficient'));
  return document.save();
}

let engine: PdfiumNative;

beforeAll(async () => {
  engine = new PdfiumNative(await init({}), { fontFallback: null });
});

afterAll(async () => {
  await engine?.destroy().toPromise();
});

describe('text under markup another app wrote into the PDF', () => {
  it('recovers the highlighted and struck words with page context', async () => {
    const bytes = await markedUpPdf();
    const document = await engine
      .openDocumentBuffer({ id: randomUUID(), content: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer })
      .toPromise();
    try {
      // The native executor reads one page at a time; the app's engine gathers
      // every page the same way behind getAllAnnotations.
      const adapter = {
        getAllAnnotations: () => ({
          toPromise: async () => Object.fromEntries(await Promise.all(document.pages.map(async (page) =>
            [page.index, await engine.getPageAnnotations(document, page).toPromise()] as const))),
        }),
        extractText: engine.extractText.bind(engine),
        getPageGlyphs: engine.getPageGlyphs.bind(engine),
      } as unknown as PdfEngine;
      const annotations = await inventoryDocumentAnnotations(adapter, document);
      const byId = new Map(annotations.map((annotation) => [annotation.contents || annotation.subtype, annotation]));

      const single = byId.get('Which markets?')!;
      expect(single.markedText?.quote).toBe('outcomes within narrowly');
      expect(single.markedText?.prefix).toContain('The design compares');
      expect(single.markedText?.suffix.startsWith(' defined')).toBe(true);

      const twoLines = byId.get('Spans the break.')!;
      expect(twoLines.markedText?.quote).toBe('defined markets. Aggregate shocks');

      const struck = annotations.find(({ subtype }) => subtype.toLowerCase() === 'strikeout')!;
      expect(struck.markedText?.quote).toBe('coefficient');
      expect(existingAnnotationContent(struck)).toMatchObject({
        sourceText: 'coefficient',
        sourceTreatment: 'struck',
      });
    } finally {
      await engine.closeDocument(document).toPromise();
    }
  });
});

describe('existing annotation presentation', () => {
  const base = {
    id: 'a', pageIndex: 0, rect: { x: 0, y: 0, width: 10, height: 10 },
    author: '', flags: [], appearanceModes: [], supportedAppearance: true,
  };

  it('shows a highlight\'s words above its comment, in page context', () => {
    const content = existingAnnotationContent({
      ...base,
      subtype: 'Highlight',
      contents: 'Which markets?',
      markedText: { quote: 'outcomes within narrowly', prefix: 'The design compares ', suffix: ' defined markets.' },
    });
    expect(content).toEqual({
      content: 'Which markets?',
      quoteText: 'outcomes within narrowly',
      quoteContext: { before: 'The design compares ', after: ' defined markets.' },
    });
  });

  it('keeps comment-only cards when no words could be read', () => {
    expect(existingAnnotationContent({ ...base, subtype: 'Highlight', contents: 'Note' })).toEqual({ content: 'Note' });
  });

  it('opens a highlight with no comment in the full reader by its words', () => {
    const record = projectExistingAnnotationReader({
      ...base,
      subtype: 'Highlight',
      contents: '',
      markedText: { quote: 'outcomes within narrowly', prefix: '', suffix: '' },
    }, { documentGeneration: 1, discoveryGeneration: 1 });
    expect(record?.quoteText).toBe('outcomes within narrowly');
    expect(record?.content).toBe('');
  });
});

describe('markedTextFromGlyphs', () => {
  const glyph = (x: number, options: Partial<PdfGlyphObject> = {}): PdfGlyphObject => ({
    origin: { x, y: 10 }, size: { width: 5, height: 10 }, ...options,
  });

  it('rejoins a word hyphenated across a line break without a gap', () => {
    const text = 'iden￾tify';
    const glyphs = [...'iden'].map((_, index) => glyph(index * 5))
      .concat([glyph(20, { isEmpty: true })])
      .concat([...'tify'].map((_, index) => glyph(25 + index * 5)));
    const marked = markedTextFromGlyphs(text, glyphs, [{ origin: { x: 0, y: 10 }, size: { width: 50, height: 10 } }]);
    expect(marked?.quote).toBe('identify');
  });

  it('returns nothing when the markup covers no text', () => {
    expect(markedTextFromGlyphs('abc', [glyph(0), glyph(5), glyph(10)], [
      { origin: { x: 100, y: 100 }, size: { width: 10, height: 10 } },
    ])).toBeUndefined();
  });
});

describe('highlights imported as editable annotations', () => {
  const imported: Annotation = {
    id: 'native-1', kind: 'pdfAnnotation', pageIndex: 0, createdAt: '', updatedAt: '',
    payload: {
      position: { x: 0, y: 0, width: 10, height: 10 },
      comment: 'Which markets?', author: '', subtype: 'highlight',
      identityProvenance: 'name', sourceObjectPageIndex: 0, sourceObjectAnnotationIndex: 2,
    },
  };
  const markedText = { quote: 'outcomes within narrowly', prefix: 'The design compares ', suffix: ' defined.' };

  it('carries the words read from the page onto the displayed item only', () => {
    const map = importedMarkedTextBySourceObject([{
      id: 'x', subtype: 'Highlight', pageIndex: 0, rect: { x: 0, y: 0, width: 1, height: 1 },
      contents: '', author: '', flags: [], appearanceModes: [], supportedAppearance: true,
      sourceObjectPageIndex: 0, sourceObjectAnnotationIndex: 2, markedText,
    }]);
    const items = [imported];
    const displayed = withImportedMarkedText(items, map);
    expect(displayed).not.toBe(items);
    expect(imported.payload).not.toHaveProperty('displayedMarkedText');
    expect(annotationContent(displayed[0]!)).toEqual({
      content: 'Which markets?',
      quoteText: 'outcomes within narrowly',
      quoteContext: { before: 'The design compares ', after: ' defined.' },
    });
    expect(annotationContent(imported)).toEqual({ content: 'Which markets?' });
  });

  it('leaves the items untouched when no words were read', () => {
    const items = [imported];
    expect(withImportedMarkedText(items, new Map())).toBe(items);
    expect(withImportedMarkedText(items, undefined)).toBe(items);
  });
});
