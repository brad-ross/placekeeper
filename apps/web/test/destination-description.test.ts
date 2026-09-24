import {
  PdfZoomMode,
  type PdfDocumentObject,
  type PdfEngine,
  type PdfGlyphObject,
  type Rect,
} from '@embedpdf/models';
import { describe, expect, it, vi } from 'vitest';

import {
  createDestinationDescriptionResolver,
  createEngineDestinationPageReader,
  describePdfDestination,
  destinationOrderLocation,
  destinationSpot,
  isReferenceCode,
  type DestinationPageGeometry,
  type DestinationPageReader,
  type DestinationPageText,
  type DescribePdfDestinationInput,
} from '../src/pdf/destination-description.js';
import { MAX_PDF_NAVIGATION_LABEL_LENGTH } from '../src/pdf/pdf-navigation-metadata.js';
import type { PdfNavigationTarget } from '../src/pdf/pdf-navigation-target.js';
import type { PdfOutlineDiscovery, PdfOutlineItem } from '../src/pdf/pdf-outline.js';
import { createPdfOutlineTargetOrderLocation } from '../src/pdf/document-order-location.js';
import { createOutlineContainmentResolver } from '../src/review/navigation-coordinator.js';

// ---------------------------------------------------------------------------
// Fixture helpers: synthetic page text in device space (top-left origin).
// ---------------------------------------------------------------------------

interface LineSpec {
  readonly text: string;
  readonly x: number;
  readonly top: number;
  readonly size?: number;
  readonly weight?: number;
  readonly charWidth?: number;
  /** Characters at these offsets get extra horizontal space before them. */
  readonly gapBefore?: Readonly<Record<number, number>>;
}

const GEOMETRY: DestinationPageGeometry = {
  width: 600,
  height: 800,
  cropLeft: 0,
  cropBottom: 0,
};

function pageText(lines: readonly LineSpec[]): DestinationPageText {
  let text = '';
  const glyphs: PdfGlyphObject[] = [];
  const textRects: { content: string; rect: Rect }[] = [];
  const styleRuns: { charIndex: number; charCount: number; fontSize: number; fontWeight: number }[] = [];
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      text += '\n';
      glyphs.push({ origin: { x: 0, y: 0 }, size: { width: 0, height: 0 }, isEmpty: true });
    }
    const size = line.size ?? 10;
    const charWidth = line.charWidth ?? 5;
    const start = Array.from(text).length;
    let x = line.x;
    Array.from(line.text).forEach((character, index) => {
      x += line.gapBefore?.[index] ?? 0;
      glyphs.push({
        origin: { x, y: line.top },
        size: { width: charWidth, height: size },
        ...(character === ' ' ? { isSpace: true } : {}),
      });
      x += charWidth;
    });
    text += line.text;
    textRects.push({
      content: line.text,
      rect: { origin: { x: line.x, y: line.top }, size: { width: x - line.x, height: size } },
    });
    styleRuns.push({
      charIndex: start,
      charCount: Array.from(line.text).length,
      fontSize: size,
      fontWeight: line.weight ?? 400,
    });
  });
  return { text, glyphs, textRects, styleRuns };
}

function xyz(pageIndex: number, x: number, y: number, generation = 1): PdfNavigationTarget {
  return {
    documentGeneration: generation,
    pageIndex,
    zoom: { mode: PdfZoomMode.XYZ, params: [x, y, 0] },
    identity: JSON.stringify([generation, pageIndex, PdfZoomMode.XYZ, x, y, 0]),
  };
}

function target(pageIndex: number, mode: PdfZoomMode, params: readonly number[]): PdfNavigationTarget {
  return {
    documentGeneration: 1,
    pageIndex,
    zoom: { mode, params },
    identity: JSON.stringify([1, pageIndex, mode, ...params]),
  };
}

/** Converts a device-space y into the PDF bottom-origin y an XYZ link carries. */
function pdfY(deviceY: number, geometry: DestinationPageGeometry = GEOMETRY): number {
  return geometry.cropBottom + geometry.height - deviceY;
}

function rect(x: number, y: number, width: number, height: number): Rect {
  return { origin: { x, y }, size: { width, height } };
}

const BIBLIOGRAPHY = pageText([
  { text: 'References', x: 72, top: 60, size: 14, weight: 700 },
  { text: '[1] Abadie, A. Synthetic controls. Journal', x: 72, top: 100 },
  { text: 'of Statistics, 2010.', x: 90, top: 112 },
  { text: '[2] Agarwal, A., Dahleh, M., et al. On', x: 72, top: 128 },
  { text: 'robust multi-dimensional estimation', x: 90, top: 140 },
  { text: 'under missing data. Annals of', x: 90, top: 152 },
  { text: 'Statistics, 2023.', x: 90, top: 164 },
  { text: '[3] Zeng, Z. Something else.', x: 72, top: 180 },
]);

const SOURCE_TEXT = pageText([
  { text: 'as shown by Agarwal, Dahleh, et al. (2023) in', x: 72, top: 300 },
  { text: 'Section 2.3 and equation 1 or Lemma 3.', x: 72, top: 312 },
]);

/** Device-space rectangle covering characters [from, to) of a SOURCE_TEXT line. */
function sourceSpan(line: 0 | 1, from: number, to: number): Rect {
  return rect(72 + from * 5, line === 0 ? 300 : 312, (to - from) * 5, 10);
}

function describe_(input: Partial<DescribePdfDestinationInput> & { target: PdfNavigationTarget }) {
  return describePdfDestination({
    geometry: GEOMETRY,
    destinationText: BIBLIOGRAPHY,
    sourceText: SOURCE_TEXT,
    sourceRects: [],
    heading: null,
    ...input,
  });
}

// ---------------------------------------------------------------------------

describe('destination spot (KTD4)', () => {
  it('accepts an XYZ top inside the crop box and converts it to device space', () => {
    expect(destinationSpot(xyz(0, 72, pdfY(124)), GEOMETRY)).toEqual({ x: 72, y: 124 });
  });

  it('Covers AE5. treats null-top XYZ, Fit, and FitH without a top as whole-page destinations', () => {
    expect(destinationSpot(xyz(0, 0, 0), GEOMETRY)).toBeNull();
    expect(destinationSpot(target(0, PdfZoomMode.FitPage, []), GEOMETRY)).toBeNull();
    expect(destinationSpot(target(0, PdfZoomMode.FitHorizontal, [0]), GEOMETRY)).toBeNull();
    expect(destinationSpot(target(0, PdfZoomMode.Unknown, []), GEOMETRY)).toBeNull();
    for (const t of [xyz(0, 0, 0), target(0, PdfZoomMode.FitPage, []), target(0, PdfZoomMode.FitHorizontal, [0])]) {
      const description = describe_({ target: t });
      expect(description.spot).toBeNull();
      expect(description.extent).toBeNull();
    }
  });

  it('rejects tops within one point of the crop bottom, above the crop top, or non-finite', () => {
    const cropped: DestinationPageGeometry = { width: 540, height: 720, cropLeft: 36, cropBottom: 36 };
    expect(destinationSpot(xyz(0, 72, 36.5), cropped)).toBeNull();
    expect(destinationSpot(xyz(0, 72, 20), cropped)).toBeNull();
    expect(destinationSpot(xyz(0, 72, 757), cropped)).toBeNull();
    expect(destinationSpot(xyz(0, 72, 756), cropped)).toEqual({ x: 36, y: 0 });
    expect(destinationSpot(xyz(0, 72, Number.NaN), cropped)).toBeNull();
    expect(destinationSpot(xyz(0, 72, 400), { ...cropped, height: 0 })).toBeNull();
  });
});

describe('destination extent (KTD5)', () => {
  it('selects a bibliography entry near the XYZ top and ends at the next hanging indent', () => {
    const description = describe_({ target: xyz(13, 72, pdfY(96)) });
    expect(description.spot).toEqual({ x: 72, y: 96 });
    expect(description.extent).toHaveLength(2);
    expect(description.extent?.[0]).toEqual(rect(72, 100, Array.from('[1] Abadie, A. Synthetic controls. Journal').length * 5, 10));
    expect(description.extent?.[1]?.origin).toEqual({ x: 90, y: 112 });
  });

  it('caps a long entry at three lines', () => {
    const description = describe_({ target: xyz(13, 72, pdfY(124)) });
    expect(description.extent?.map(({ origin }) => origin.y)).toEqual([128, 140, 152]);
  });

  it('gives a section heading a one-line extent when the next line changes size or weight', () => {
    const page = pageText([
      { text: '2.3 The Aggregated Projection Matrix', x: 72, top: 200, size: 12, weight: 700 },
      { text: 'We now define the matrix that aggregates', x: 72, top: 214 },
      { text: 'the projections across units.', x: 72, top: 226 },
    ]);
    const heavy = describe_({ target: xyz(4, 72, pdfY(196)), destinationText: page });
    expect(heavy.extent?.map(({ origin }) => origin.y)).toEqual([200]);

    const boldOnly = pageText([
      { text: '2.3 The Aggregated Projection Matrix', x: 72, top: 200, weight: 700 },
      { text: 'We now define the matrix that aggregates', x: 72, top: 212 },
    ]);
    expect(describe_({ target: xyz(4, 72, pdfY(196)), destinationText: boldOnly }).extent)
      .toHaveLength(1);
  });

  it('stops a block at a vertical gap beyond 1.5 times the median line pitch', () => {
    const page = pageText([
      { text: 'First paragraph line one.', x: 72, top: 100 },
      { text: 'First paragraph line two.', x: 72, top: 112 },
      { text: 'Second block after a gap.', x: 72, top: 140 },
      { text: 'Second block line two.', x: 72, top: 152 },
    ]);
    expect(describe_({ target: xyz(0, 72, pdfY(98)), destinationText: page }).extent?.map(({ origin }) => origin.y))
      .toEqual([100, 112]);
  });

  it('keeps a far-right equation number on the same line as its equation', () => {
    const page = pageText([
      { text: 'We consider the linear model in which', x: 72, top: 252 },
      { text: 'the outcome depends on the design', x: 72, top: 264 },
      { text: 'matrix as follows:', x: 72, top: 276 },
      { text: 'y = Ax + b (1)', x: 150, top: 300, gapBefore: { 11: 300 } },
      { text: 'where A is fixed and b is a vector', x: 72, top: 320 },
      { text: 'of offsets that varies by unit.', x: 72, top: 332 },
      { text: 'Estimation proceeds in two steps.', x: 72, top: 344 },
    ]);
    const description = describe_({ target: xyz(2, 150, pdfY(295)), destinationText: page, sourceRects: [sourceSpan(1, 25, 26)] });
    expect(description.extent).toHaveLength(1);
    expect(description.kindLabel).toBe('Eq. 1');
  });

  it('tolerates engine glyph holes for generated characters, such as the space before "(1)"', () => {
    const page = pageText([
      { text: 'matrix as follows:', x: 72, top: 276 },
      { text: 'Y = P X + E (1)', x: 150, top: 300, gapBefore: { 12: 200 } },
      { text: 'where P is the aggregated projection.', x: 72, top: 320 },
    ]);
    // PDFium returns a sparse glyph array: the generated space has no entry.
    const holeIndex = Array.from(page.text).indexOf('(') - 1;
    const glyphs = [...page.glyphs];
    delete glyphs[holeIndex];
    expect(holeIndex in glyphs).toBe(false);
    const description = describe_({
      target: xyz(2, 72, pdfY(292)),
      destinationText: { ...page, glyphs },
      sourceRects: [sourceSpan(1, 25, 26)],
    });
    expect(description.extent).toHaveLength(1);
    expect(description.name).toBe('Eq. 1');
  });

  it('finds a centered equation when the XYZ left sits at the text margin', () => {
    const page = pageText([
      { text: 'We consider the linear model in which', x: 72, top: 264 },
      { text: 'matrix as follows:', x: 72, top: 276 },
      { text: 'y = Ax + b (1)', x: 150, top: 300, gapBefore: { 11: 300 } },
      { text: 'where A is fixed and b is a vector', x: 72, top: 320 },
      { text: 'of offsets that varies by unit.', x: 72, top: 332 },
    ]);
    const description = describe_({ target: xyz(2, 72, pdfY(292)), destinationText: page, sourceRects: [sourceSpan(1, 25, 26)] });
    expect(description.extent?.map(({ origin }) => origin)).toEqual([{ x: 150, y: 300 }]);
    expect(description.name).toBe('Eq. 1');
  });

  it('falls back to glyph heights for block breaks when style runs are unavailable', () => {
    const page = pageText([
      { text: 'Heading Set Larger', x: 72, top: 200, size: 14 },
      { text: 'Body text follows the heading here', x: 72, top: 216 },
      { text: 'and continues on this line.', x: 72, top: 228 },
      { text: 'Still the same paragraph.', x: 72, top: 240 },
    ]);
    const { styleRuns: _unused, ...withoutRuns } = page;
    expect(describe_({ target: xyz(0, 72, pdfY(198)), destinationText: withoutRuns }).extent)
      .toHaveLength(1);
    expect(describe_({ target: xyz(0, 72, pdfY(214)), destinationText: withoutRuns }).extent)
      .toHaveLength(3);
  });

  it('maps the spot through a cropped page (textPdf({crop}) geometry) to the correct line', () => {
    // textPdf({crop}): a 612x792 page cropped to 36,36,540x720. Lines are drawn
    // at PDF y=690 (14pt) and y=660 (12pt), i.e. device tops near 56 and 86.
    const cropped: DestinationPageGeometry = { width: 540, height: 720, cropLeft: 36, cropBottom: 36 };
    const page = pageText([
      { text: 'Selectable placekeeper text: unique equilibrium clearly.', x: 36, top: 56, size: 14 },
      { text: 'Multiline selection with soft-hyphen-like and combining context.', x: 36, top: 86, size: 12 },
    ]);
    const first = describe_({ target: xyz(0, 72, 704), geometry: cropped, destinationText: page });
    expect(first.spot).toEqual({ x: 36, y: 52 });
    expect(first.extent?.map(({ origin }) => origin.y)).toEqual([56]);
    const second = describe_({ target: xyz(0, 72, 676), geometry: cropped, destinationText: page });
    expect(second.spot).toEqual({ x: 36, y: 80 });
    expect(second.extent?.map(({ origin }) => origin.y)).toEqual([86]);
  });

  it('prefers the column that horizontally contains the spot', () => {
    const page = pageText([
      { text: 'Left column text line.', x: 50, top: 100 },
      { text: 'Right column target line.', x: 320, top: 104 },
    ]);
    const description = describe_({ target: xyz(0, 320, pdfY(100)), destinationText: page });
    expect(description.extent?.[0]?.origin).toEqual({ x: 320, y: 104 });
  });

  it('keeps the spot but returns no extent for unreliable page text', () => {
    const unreliable: DestinationPageText = { ...BIBLIOGRAPHY, textRects: [] };
    const description = describe_({ target: xyz(13, 72, pdfY(124)), destinationText: unreliable });
    expect(description.spot).toEqual({ x: 72, y: 124 });
    expect(description.extent).toBeNull();

    const badGlyphs: DestinationPageText = {
      ...BIBLIOGRAPHY,
      glyphs: BIBLIOGRAPHY.glyphs.map((glyph, index) => (
        index === 3 ? { ...glyph, size: { width: Number.NaN, height: 10 } } : glyph
      )),
    };
    expect(describe_({ target: xyz(13, 72, pdfY(124)), destinationText: badGlyphs }).extent).toBeNull();
    expect(describe_({ target: xyz(13, 72, pdfY(124)), destinationText: null }).extent).toBeNull();
  });

  it('returns no extent when no line lies at or below the spot', () => {
    expect(describe_({ target: xyz(13, 72, pdfY(400)) }).extent).toBeNull();
  });
});

describe('clicked text (KTD6)', () => {
  it('Covers AE1. merges a split natbib citation into the full clicked text and names the tab', () => {
    // "Agarwal, Dahleh, et al." spans chars 12..35 and "(2023)" chars 36..42.
    const description = describe_({
      target: xyz(13, 72, pdfY(124)),
      sourceRects: [sourceSpan(0, 12, 35), sourceSpan(0, 36, 42)],
    });
    expect(description.clickedText).toBe('Agarwal, Dahleh, et al. (2023)');
    expect(description.name).toBe('Agarwal, Dahleh, et al. (2023)');
    expect(description.nameSource).toBe('clicked-text');
    expect(description.pageNumeral).toBe('14');
  });

  it('merges a citation wrapped across lines and ignores duplicated areas', () => {
    const description = describe_({
      target: xyz(13, 72, pdfY(124)),
      sourceRects: [sourceSpan(0, 36, 42), sourceSpan(0, 36, 42), sourceSpan(1, 0, 7)],
    });
    expect(description.clickedText).toBe('(2023) Section');
  });

  it('sanitizes and bounds extracted text containing control, bidi, or markup characters', () => {
    const hostile = pageText([
      { text: `‮<b>Agarwal</b>\u0000 et‏ al. ${'x'.repeat(300)}`, x: 0, top: 10, charWidth: 1 },
    ]);
    const description = describe_({
      target: xyz(13, 72, pdfY(124)),
      sourceText: hostile,
      sourceRects: [rect(0, 10, 400, 10)],
    });
    expect(description.clickedText).not.toMatch(/[<>\u0000-\u001f‮‏]/u);
    expect(description.clickedText?.startsWith('bAgarwal/b et al.')).toBe(true);
    expect(Array.from(description.clickedText ?? '')).toHaveLength(MAX_PDF_NAVIGATION_LABEL_LENGTH);
    expect(description.clickedText?.endsWith('…')).toBe(true);
    expect(Array.from(description.name).length).toBeLessThanOrEqual(MAX_PDF_NAVIGATION_LABEL_LENGTH);
  });

  it('yields no clicked text for unreliable source text or no source areas', () => {
    expect(describe_({ target: xyz(13, 72, pdfY(124)), sourceRects: [] }).clickedText).toBeNull();
    expect(describe_({
      target: xyz(13, 72, pdfY(124)),
      sourceText: { ...SOURCE_TEXT, textRects: [] },
      sourceRects: [sourceSpan(0, 12, 35)],
    }).clickedText).toBeNull();
    expect(describe_({
      target: xyz(13, 72, pdfY(124)),
      sourceText: null,
      sourceRects: [sourceSpan(0, 12, 35)],
    }).clickedText).toBeNull();
    expect(describe_({
      target: xyz(13, 72, pdfY(124)),
      sourceRects: [rect(Number.NaN, 0, 10, 10)],
    }).clickedText).toBeNull();
  });
});

describe('reference codes', () => {
  it('treats text without a run of two letters as a reference code', () => {
    for (const code of ['1', '2.3', '(1)', '[12]', '1b', 'A.3']) expect(isReferenceCode(code)).toBe(true);
    for (const text of ['Lemma 3', 'Agarwal (2023)', 'Eq']) expect(isReferenceCode(text)).toBe(false);
  });
});

describe('tab name precedence (R7, KTD7)', () => {
  it('lets an author contents name win over clicked text', () => {
    const description = describe_({
      target: xyz(13, 72, pdfY(124)),
      sourceRects: [sourceSpan(0, 12, 35)],
      contents: ' Author name ',
    });
    expect(description.name).toBe('Author name');
    expect(description.nameSource).toBe('author');
    expect(describe_({ target: xyz(13, 72, pdfY(124)), subject: 'Subject name' }).name).toBe('Subject name');
  });

  it('Covers AE2. names a numeric section reference after its heading', () => {
    const page = pageText([
      { text: '2.3 The Aggregated Projection Matrix', x: 72, top: 200, size: 12, weight: 700 },
    ]);
    const description = describe_({
      target: xyz(4, 72, pdfY(196)),
      destinationText: page,
      sourceRects: [sourceSpan(1, 8, 11)],
      heading: '2.3 The Aggregated Projection Matrix',
    });
    expect(description.clickedText).toBe('2.3');
    expect(description.name).toBe('2.3 The Aggregated Projection Matrix');
    expect(description.nameSource).toBe('heading');
  });

  it('keeps non-code clicked text ahead of the heading', () => {
    const description = describe_({
      target: xyz(4, 72, pdfY(196)),
      sourceRects: [sourceSpan(1, 30, 37)],
      heading: 'Proofs',
    });
    expect(description.name).toBe('Lemma 3');
  });

  it('Covers AE3. names an equation reference "Eq. 1" when no heading is available', () => {
    const page = pageText([
      { text: 'y = Ax + b (1)', x: 150, top: 300, gapBefore: { 11: 300 } },
    ]);
    const description = describe_({
      target: xyz(2, 72, pdfY(295)),
      destinationText: page,
      sourceRects: [sourceSpan(1, 25, 26)],
    });
    expect(description.clickedText).toBe('1');
    expect(description.name).toBe('Eq. 1');
    expect(description.nameSource).toBe('kind');
  });

  it('names an equation reference "Eq. 1" ahead of its enclosing section heading', () => {
    const page = pageText([
      { text: 'y = Ax + b (1)', x: 150, top: 300, gapBefore: { 11: 300 } },
    ]);
    const description = describe_({
      target: xyz(2, 72, pdfY(295)),
      destinationText: page,
      sourceRects: [sourceSpan(1, 25, 26)],
      heading: '2 Setup and Intuition',
    });
    expect(description.heading).toBe('2 Setup and Intuition');
    expect(description.name).toBe('Eq. 1');
    expect(description.nameSource).toBe('kind');
  });

  it('falls back to the bare page numeral for an unrecognized destination', () => {
    const page = pageText([{ text: 'Plain prose without a number.', x: 72, top: 300 }]);
    const description = describe_({
      target: xyz(13, 72, pdfY(295)),
      destinationText: page,
      sourceRects: [sourceSpan(1, 25, 26)],
    });
    expect(description.name).toBe('14');
    expect(description.nameSource).toBe('page');
  });

  it('labels section, figure, and table destinations conservatively', () => {
    const section = pageText([{ text: '2.3 The Aggregated Projection Matrix', x: 72, top: 200 }]);
    expect(describe_({ target: xyz(4, 72, pdfY(196)), destinationText: section, sourceRects: [sourceSpan(1, 8, 11)] }).name)
      .toBe('Section 2.3');
    const figure = pageText([{ text: 'Figure 4: Estimated effects by unit.', x: 72, top: 200 }]);
    expect(describe_({ target: xyz(4, 72, pdfY(196)), destinationText: figure, sourceRects: [sourceSpan(1, 25, 26)] }).name)
      .toBe('Figure 4');
    const table = pageText([{ text: 'Table 2. Summary statistics.', x: 72, top: 200 }]);
    expect(describe_({ target: xyz(4, 72, pdfY(196)), destinationText: table, sourceRects: [sourceSpan(1, 25, 26)] }).name)
      .toBe('Table 2');
    // A section number that does not match the clicked number is not labelled.
    expect(describe_({ target: xyz(4, 72, pdfY(196)), destinationText: section, sourceRects: [sourceSpan(1, 25, 26)] }).name)
      .toBe('5');
  });

  it('Covers AE5. names a whole-page destination without a spot-derived kind', () => {
    const description = describe_({
      target: target(6, PdfZoomMode.FitPage, []),
      sourceRects: [sourceSpan(1, 25, 26)],
    });
    expect(description.spot).toBeNull();
    expect(description.extent).toBeNull();
    expect(description.kindLabel).toBeNull();
    expect(description.name).toBe('7');
  });
});

describe('heading lookup integration', () => {
  function outline(items: readonly PdfOutlineItem[]): PdfOutlineDiscovery {
    return { status: 'loaded-tree', documentGeneration: 1, items };
  }

  it('Covers AE2. resolves the section containing a spot through the outline resolver', () => {
    const sectionTarget = xyz(4, 72, pdfY(196));
    const items: PdfOutlineItem[] = [
      { id: 'a', label: '2 Model', pageContext: 'Page 3', target: xyz(2, 72, pdfY(80)), children: [
        { id: 'b', label: '2.3 The Aggregated Projection Matrix', pageContext: 'Page 5', target: sectionTarget, children: [] },
      ] },
    ];
    const resolver = createOutlineContainmentResolver({
      discovery: outline(items),
      resolveTarget: (t) => createPdfOutlineTargetOrderLocation(t, {
        documentGeneration: 1,
        page: { width: 600, height: 800, cropOrigin: { x: 0, y: 0 } },
      }),
    });
    const spot = destinationSpot(sectionTarget, GEOMETRY);
    expect(resolver(destinationOrderLocation(sectionTarget, spot))?.label)
      .toBe('2.3 The Aggregated Projection Matrix');
    // A whole-page destination orders at the top of its page.
    const wholePage = target(4, PdfZoomMode.FitPage, []);
    expect(destinationOrderLocation(wholePage, null)).toEqual({ pageIndex: 4, anchor: { x: 0, y: 0 } });
    expect(resolver(destinationOrderLocation(wholePage, null))?.label).toBe('2 Model');
  });
});

// ---------------------------------------------------------------------------
// Engine-backed reader and resolver.
// ---------------------------------------------------------------------------

function task<T>(value: T | Error) {
  return {
    toPromise: () => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)),
    abort: vi.fn(),
  };
}

function fakeEngine(pages: Record<number, DestinationPageText>, failing: ReadonlySet<number> = new Set()) {
  const calls: number[] = [];
  const engine = {
    extractText: (_doc: unknown, [pageIndex]: number[]) => {
      calls.push(pageIndex!);
      return task(failing.has(pageIndex!) ? new Error('read failed') : pages[pageIndex!]!.text);
    },
    getPageGlyphs: (_doc: unknown, page: { index: number }) => task(pages[page.index]?.glyphs ?? []),
    getPageTextRects: (_doc: unknown, page: { index: number }) => task(
      (pages[page.index]?.textRects ?? []).map((entry) => ({ ...entry, font: { family: 'x', size: 10 } })),
    ),
    getPageTextRuns: (_doc: unknown, page: { index: number }) => task({
      runs: (pages[page.index]?.styleRuns ?? []).map((run) => ({
        text: '',
        rect: rect(0, 0, 1, 1),
        font: { name: 'x', familyName: 'x', weight: run.fontWeight, italic: false, monospaced: false, embedded: true },
        fontSize: run.fontSize,
        color: { red: 0, green: 0, blue: 0, alpha: 255 },
        charIndex: run.charIndex,
        charCount: run.charCount,
      })),
    }),
  };
  const document = {
    id: 'doc',
    pageCount: 16,
    pages: Array.from({ length: 16 }, (_value, index) => ({
      index,
      size: { width: 600, height: 800 },
      rotation: 0,
      objectNumber: index + 1,
      boxes: {
        media: { left: 0, top: 800, right: 600, bottom: 0 },
        crop: { left: 0, top: 800, right: 600, bottom: 0 },
      },
    })),
  };
  return {
    engine: engine as unknown as PdfEngine,
    document: document as unknown as PdfDocumentObject,
    calls,
  };
}

describe('destination description resolver', () => {
  it('Covers AE1. resolves a link invocation end to end through the engine-backed reader', async () => {
    const { engine, document, calls } = fakeEngine({ 13: BIBLIOGRAPHY, 0: SOURCE_TEXT });
    const reader = createEngineDestinationPageReader(engine, document);
    const resolveHeading = vi.fn(() => 'References');
    const resolver = createDestinationDescriptionResolver({ documentGeneration: 1, reader, resolveHeading });
    const request = {
      target: xyz(13, 72, pdfY(124)),
      sourcePageIndex: 0,
      sourceRects: [sourceSpan(0, 12, 35), sourceSpan(0, 36, 42)],
    };

    const description = await resolver.resolve(request, new AbortController().signal);

    expect(description).toMatchObject({
      documentGeneration: 1,
      targetIdentity: request.target.identity,
      pageIndex: 13,
      pageNumeral: '14',
      clickedText: 'Agarwal, Dahleh, et al. (2023)',
      heading: 'References',
      name: 'Agarwal, Dahleh, et al. (2023)',
    });
    expect(description?.extent?.map(({ origin }) => origin.y)).toEqual([128, 140, 152]);
    expect(resolveHeading).toHaveBeenCalledWith({ pageIndex: 13, anchor: { x: 72, y: 124 } });

    await resolver.resolve(request, new AbortController().signal);
    expect(calls.sort()).toEqual([0, 13]);
  });

  it('drops a request from another document generation', async () => {
    const { engine, document } = fakeEngine({ 13: BIBLIOGRAPHY, 0: SOURCE_TEXT });
    const resolver = createDestinationDescriptionResolver({
      documentGeneration: 2,
      reader: createEngineDestinationPageReader(engine, document),
    });
    await expect(resolver.resolve({
      target: xyz(13, 72, pdfY(124), 1),
      sourcePageIndex: 0,
      sourceRects: [],
    }, new AbortController().signal)).resolves.toBeNull();
  });

  it('fails closed to the page numeral when page text cannot be read', async () => {
    const { engine, document } = fakeEngine({ 13: BIBLIOGRAPHY, 0: SOURCE_TEXT }, new Set([0, 13]));
    const resolver = createDestinationDescriptionResolver({
      documentGeneration: 1,
      reader: createEngineDestinationPageReader(engine, document),
      resolveHeading: () => {
        throw new Error('outline unavailable');
      },
    });
    const description = await resolver.resolve({
      target: xyz(13, 72, pdfY(124)),
      sourcePageIndex: 0,
      sourceRects: [sourceSpan(0, 12, 35)],
    }, new AbortController().signal);
    expect(description).toMatchObject({ spot: { x: 72, y: 124 }, extent: null, clickedText: null, heading: null, name: '14' });
  });

  it('returns null once the request is aborted or the resolver is disposed', async () => {
    const { engine, document } = fakeEngine({ 13: BIBLIOGRAPHY, 0: SOURCE_TEXT });
    const resolver = createDestinationDescriptionResolver({
      documentGeneration: 1,
      reader: createEngineDestinationPageReader(engine, document),
    });
    const aborted = new AbortController();
    aborted.abort();
    const request = { target: xyz(13, 72, pdfY(124)), sourcePageIndex: 0, sourceRects: [] };
    await expect(resolver.resolve(request, aborted.signal)).resolves.toBeNull();
    resolver.dispose();
    await expect(resolver.resolve(request, new AbortController().signal)).resolves.toBeNull();
  });

  it('rejects out-of-range pages without reading', async () => {
    const { engine, document, calls } = fakeEngine({});
    const reader: DestinationPageReader = createEngineDestinationPageReader(engine, document);
    const resolver = createDestinationDescriptionResolver({ documentGeneration: 1, reader });
    await expect(resolver.resolve({
      target: xyz(40, 72, pdfY(124)),
      sourcePageIndex: 0,
      sourceRects: [],
    }, new AbortController().signal)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });
});
