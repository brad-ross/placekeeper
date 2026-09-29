import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  type PDFObject,
  type PDFPage,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
} from 'pdf-lib';

import { projectReviewItem } from '../../../packages/core/src/annotation-projection.js';
import type { ReviewItem } from '../../../packages/core/src/review-model.js';
import { createSelectedPdfWriter } from '../../../packages/pdf-backends/src/selected-writer.js';

const reportedMathSymbolInventory = [
  '·', 'Π', 'α', 'δ', 'θ', 'κ', 'λ', 'ν', 'ξ', 'ρ', 'σ', 'τ', 'ϕ', 'ϵ', '𝟘', '˜',
  '→', '∂', '∈', '∑', '−', '∗', '∝', '∫', '≡', '≤', '≥', '⏐', '+', '<', '=', '>', '|', '/',
] as const;

const utf16BeHex = (glyph: string): string => {
  const codePoint = glyph.codePointAt(0);
  if (codePoint === undefined) throw new Error('Math symbol fixture requires one scalar');
  if (codePoint <= 0xffff) return codePoint.toString(16).toUpperCase().padStart(4, '0');
  const scalar = codePoint - 0x10000;
  const high = 0xd800 + (scalar >>> 10);
  const low = 0xdc00 + (scalar & 0x3ff);
  return `${high.toString(16).toUpperCase()}${low.toString(16).toUpperCase()}`;
};

function addReportedMathSymbolInventory(document: PDFDocument, page: PDFPage): void {
  const context = document.context;
  const glyphNames = reportedMathSymbolInventory.map((_, index) => `math${index + 1}`);
  const glyphProcedure = context.register(context.flateStream('600 0 0 0 560 650 d1 40 40 480 570 re S'));
  const charProcs = context.obj(Object.fromEntries(glyphNames.map((name) => [name, glyphProcedure])));
  const encoding = context.obj({
    Type: 'Encoding',
    Differences: [1, ...glyphNames.map((name) => PDFName.of(name))],
  });
  const mappings = reportedMathSymbolInventory.map((glyph, index) =>
    `<${(index + 1).toString(16).toUpperCase().padStart(2, '0')}> <${utf16BeHex(glyph)}>`);
  const toUnicode = context.register(context.flateStream([
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /PlacekeeperMathSymbols def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<01> <FF>',
    'endcodespacerange',
    `${mappings.length} beginbfchar`,
    ...mappings,
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n')));
  const font = context.register(context.obj({
    Type: 'Font',
    Subtype: 'Type3',
    Name: 'FMathInventory',
    FontBBox: [0, 0, 600, 700],
    FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    CharProcs: charProcs,
    Encoding: encoding,
    FirstChar: 1,
    LastChar: reportedMathSymbolInventory.length,
    Widths: reportedMathSymbolInventory.map(() => 600),
    Resources: {},
    ToUnicode: toUnicode,
  }));
  const resources = page.node.Resources() ?? context.obj({});
  page.node.set(PDFName.of('Resources'), resources);
  const fonts = resources.lookupMaybe(PDFName.of('Font'), PDFDict) ?? context.obj({});
  fonts.set(PDFName.of('FMathInventory'), font);
  resources.set(PDFName.of('Font'), fonts);
  const encoded = reportedMathSymbolInventory
    .map((_, index) => (index + 1).toString(16).toUpperCase().padStart(2, '0'))
    .join('');
  page.node.addContentStream(context.register(context.flateStream(
    `BT /FMathInventory 12 Tf 72 630 Td <${encoded}> Tj ET`,
  )));
}
const outputDirectory = resolve('test/fixtures/pdfs');
const fixtureMetadataDate = new Date('2024-01-01T00:00:00.000Z');
const encryptedNoAnnotationBase64 =
  'JVBERi0xLjcKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGRlOTU0NjMwYzIwMGU1MTc2YmYwNjdhOTAxMWYxNjBjMjZlN2Y5M2NiMDg1YzNmMTc0MzAzYmQ5NmVlYWU5ODU+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0hlbHZldGljYS03MDk4NDgwNzg5IDUgMCBSCi9IZWx2ZXRpY2EtOTc0MjY4MjU2OCA1IDAgUgo+PgovWE9iamVjdCA8PAo+PgovRXh0R1N0YXRlIDw8Cj4+Cj4+Ci9NZWRpYUJveCBbIDAgMCA2MTIgNzkyIF0KL0Fubm90cyBbIF0KL0NvbnRlbnRzIFsgNiAwIFIgXQovUGFyZW50IDIgMCBSCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9UeXBlIC9Gb250Ci9TdWJ0eXBlIC9UeXBlMQovQmFzZUZvbnQgL0hlbHZldGljYQovRW5jb2RpbmcgL1dpbkFuc2lFbmNvZGluZwo+PgplbmRvYmoKNiAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoIDI1Ngo+PgpzdHJlYW0K+D741cssH9mtvMVGLzls9Uow/5r8LccUtB9r7Lwh1mStk3Na1fAdvsTJ4jNo7Ar07jFUILdMwU1qaQIQ4cQbQzSkxonj+kiYVngxdZLOUPnASxVGRFuZuTOp9h/+/8Go4xRIoK4IDYF9sTEbyUzr/28knmX1oJtUOV1CENJeHcU4IENHxw3P99W18tTKufF4DrjyKqsVCo3QrbrhvesjJNWiINW3cmTJlPWMMc23UP4nxs3QFqXLSyZXp/6RVTwfSb9w5hNeiaV0rdRuLf0upQ2i9glRC4GT1H3Xq+iqtkShFfjDpJlPX7VFzd/+SBv+PXfRIN7Cui271Ps2WhfnlQplbmRzdHJlYW0KZW5kb2JqCjcgMCBvYmoKPDwKL1YgNQovUiA2Ci9MZW5ndGggMjU2Ci9QIDQKL0ZpbHRlciAvU3RhbmRhcmQKL08gPDUxZGNjOGJmM2FkYjYzNDMwMDc1NTA1ZWI4ODk1ZmVlOWQyMDRhOTg5ZjhjMjZjOWY1ZDQ0OWNiMGI2MjRmZTkwNTJjMGQxNGIzYzhiYzhiNmU5ZGE4NGUzM2UzM2I5ZD4KL1UgPGM1NjJmYTI4YTU3YzE5MTQ3MDE0ZTdkNzA4ZTJjZjJiZjRmN2Y2NjMxMzljMzIxZDM5MmNhNmJhM2M0NzJmZmU3MjVjMjlkNTliODliZWFmMGIyOTJjNWQ0MzJlNGQxZD4KL0NGIDw8Ci9TdGRDRiA8PAovQXV0aEV2ZW50IC9Eb2NPcGVuCi9DRk0gL0FFU1YzCi9MZW5ndGggMzIKPj4KPj4KL1N0bUYgL1N0ZENGCi9TdHJGIC9TdGRDRgovT0UgPGFlOWI4OGVhZDM2MWVlMjUyOTYyZGY2NmNmNWYzMjQ2NDdlMDliNWNhZDMwNzZmYzJlMDI4OGE3MzA0YmY2MTU+Ci9VRSA8ZTQ4NWM4MjNhNTM2MzVkMTdkYmZlZDk4ZTAzNDIxYzEwYTU2MGI5ZWM3NDlkZGM1MzY0ZWNlMGFkY2MyY2UxMj4KL1Blcm1zIDw3MDBlMDE5YmRlNjE4ZGRmMzk0NzNhYjdiMzMxMWMyMz4KPj4KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMTEzIDAwMDAwIG4gCjAwMDAwMDAxNzIgMDAwMDAgbiAKMDAwMDAwMDIyMSAwMDAwMCBuIAowMDAwMDAwNDQzIDAwMDAwIG4gCjAwMDAwMDA1NDAgMDAwMDAgbiAKMDAwMDAwMDg2OCAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDgKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDM1MzQzOTMxNjMzOTYxMzczMjY1NjEzOTM5NjMzNDY0MzEzMTMxNjMzNjY1MzQ2MTY0Mzg2NTM0MzE2NjMyMzc+IDwzNTM0MzkzMTYzMzk2MTM3MzI2NTYxMzkzOTYzMzQ2NDMxMzEzMTYzMzY2NTM0NjE2NDM4NjUzNDMxNjYzMjM3PiBdCi9FbmNyeXB0IDcgMCBSCj4+CnN0YXJ0eHJlZgoxNDE0CiUlRU9GCg==';

async function writeFixture(name: string, bytes: Uint8Array): Promise<void> {
  const path = resolve(outputDirectory, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function createFixturePdf(): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  // pdf-lib otherwise stamps both values with the wall clock. These fixtures
  // are integrity-pinned release inputs, so their metadata must be reproducible.
  document.setCreationDate(fixtureMetadataDate);
  document.setModificationDate(fixtureMetadataDate);
  return document;
}

function addExistingAnnotations(document: PDFDocument): void {
  const page = document.getPage(0);
  const context = document.context;
  const appearance = context.flateStream('0.8 0.8 0 rg 0 0 120 18 re f', {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 120, 18],
    Resources: {},
  });
  const appearanceRef = context.register(appearance);
  const normalAppearance = context.obj({ N: appearanceRef });

  const highlight = context.obj({
    Type: 'Annot',
    Subtype: 'Highlight',
    NM: PDFString.of('existing-highlight'),
    Contents: PDFString.of('Existing supported highlight'),
    Rect: [72, 680, 220, 698],
    QuadPoints: [72, 698, 220, 698, 72, 680, 220, 680],
    C: [1, 1, 0],
    F: 4,
    AP: normalAppearance,
  });
  const stamp = context.obj({
    Type: 'Annot',
    Subtype: 'Stamp',
    Name: 'Approved',
    NM: PDFString.of('existing-stamp'),
    Contents: PDFString.of('Existing unsupported stamp'),
    Rect: [430, 650, 550, 668],
    F: 4,
    AP: normalAppearance,
  });

  const annotations = PDFArray.withContext(context);
  annotations.push(context.register(highlight));
  annotations.push(context.register(stamp));
  page.node.set(PDFName.of('Annots'), annotations);
}

async function textPdf(options: { annotations?: boolean; rotation?: number; crop?: boolean } = {}) {
  const document = await createFixturePdf();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('Selectable placekeeper text: unique equilibrium clearly.', {
    x: 72,
    y: 690,
    size: 14,
    font,
  });
  page.drawText('Multiline selection with soft-hyphen-like and combining context.', {
    x: 72,
    y: 660,
    size: 12,
    font,
  });
  if (options.rotation !== undefined) page.setRotation(degrees(options.rotation));
  if (options.crop) page.setCropBox(36, 36, 540, 720);
  if (options.annotations) addExistingAnnotations(document);
  return document.save({ useObjectStreams: true });
}

async function imageOnlyPdf() {
  const document = await createFixturePdf();
  const page = document.addPage([612, 792]);
  const png = await document.embedPng(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  );
  page.drawImage(png, { x: 72, y: 600, width: 300, height: 120 });
  return document.save({ useObjectStreams: false });
}

async function mixedTextImagePdf() {
  const document = await createFixturePdf();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const textPage = document.addPage([612, 792]);
  textPage.drawText('Reliable selectable text on page one.', {
    x: 72,
    y: 690,
    size: 14,
    font,
  });
  const imagePage = document.addPage([612, 792]);
  const png = await document.embedPng(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  );
  imagePage.drawImage(png, { x: 72, y: 600, width: 300, height: 120 });
  return document.save({ useObjectStreams: false });
}

async function equationSelectionPdf() {
  const document = await createFixturePdf();
  const page = document.addPage([612, 792]);
  const roman = await document.embedFont(StandardFonts.TimesRoman);
  const italic = await document.embedFont(StandardFonts.TimesRomanItalic);
  const symbol = await document.embedFont(StandardFonts.Symbol);

  let inlineX = 72;
  const drawInline = (text: string, y: number, size: number, font = roman) => {
    page.drawText(text, { x: inlineX, y, size, font });
    inlineX += font.widthOfTextAtSize(text, size);
  };
  drawInline('Inline equation: distance ', 690, 14);
  drawInline('d', 690, 14, italic);
  drawInline('ij', 686, 9, italic);
  drawInline(' remains selectable.', 690, 14);

  let displayX = 190;
  const drawDisplay = (text: string, y: number, size: number, font = roman) => {
    page.drawText(text, { x: displayX, y, size, font });
    displayX += font.widthOfTextAtSize(text, size);
  };
  drawDisplay('t', 620, 14, italic);
  drawDisplay('k|ij', 616, 9, italic);
  drawDisplay(' = ', 620, 14);
  drawDisplay('ν', 620, 14, symbol);
  drawDisplay('-1', 629, 9);
  drawDisplay('k', 616, 9, italic);
  drawDisplay(' · d', 620, 14);
  drawDisplay('k|ij', 616, 9, italic);
  drawDisplay('.', 620, 14);

  return document.save({ useObjectStreams: true });
}

async function multiPageTextPdf() {
  const document = await createFixturePdf();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const [index, pageLabel] of ['one', 'two'].entries()) {
    const page = document.addPage([612, 792]);
    const repeatedText = 'Repeated insertion context.';
    page.drawText(repeatedText, { x: 72, y: 690, size: 14, font });
    page.drawText(repeatedText, { x: 72, y: 660, size: 14, font });
    page.drawText(`Repeated context for page ${index + 1}.`, { x: 72, y: 630, size: 12, font });
    page.drawText(`End of page ${pageLabel}.`, { x: 72, y: 600, size: 12, font });
  }
  return document.save({ useObjectStreams: false });
}

async function crossPageSelectionPdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= 13; pageNumber += 1) {
    const page = document.addPage([612, 792]);
    const label = String(pageNumber).padStart(2, '0');
    page.drawText(`PAGE ${label}: cross-page semantic selection contract.`, {
      x: 72,
      y: 690,
      size: 14,
      font,
    });
  }
  return document.save({ useObjectStreams: false });
}

async function pdfSearchPdf() {
  const document = await createFixturePdf();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const first = document.addPage([612, 792]);
  first.drawText('A stable model is defined here. Stability matters for the proof. A 90° angle is fixed.', {
    x: 72,
    y: 690,
    size: 14,
    font,
  });
  first.drawText('Reported extracted mathematical symbol inventory:', {
    x: 72,
    y: 650,
    size: 12,
    font,
  });
  addReportedMathSymbolInventory(document, first);
  const second = document.addPage([612, 792]);
  second.drawText('The model stabilizes after iteration. A stable limit follows.', {
    x: 72,
    y: 690,
    size: 14,
    font,
  });
  const imageOnly = document.addPage([612, 792]);
  const png = await document.embedPng(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  );
  imageOnly.drawImage(png, { x: 72, y: 600, width: 300, height: 120 });
  return document.save({ useObjectStreams: false });
}

async function hostileActionsPdf() {
  const document = await createFixturePdf();
  const page = document.addPage([612, 792]);
  page.drawRectangle({ x: 72, y: 650, width: 200, height: 40, color: rgb(0.9, 0.9, 0.9) });
  const context = document.context;
  const javaScript = context.obj({
    S: 'JavaScript',
    JS: PDFString.of("globalThis.__pdfActionExecuted = true"),
  });
  document.catalog.set(PDFName.of('OpenAction'), context.register(javaScript));
  const uriAction = context.obj({ S: 'URI', URI: PDFString.of('https://example.invalid/remote') });
  const link = context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [72, 650, 272, 690],
    A: context.register(uriAction),
  });
  const annotations = PDFArray.withContext(context);
  annotations.push(context.register(link));
  page.node.set(PDFName.of('Annots'), annotations);
  page.node.set(
    PDFName.of('AA'),
    context.obj({
      O: context.register(context.obj({ S: 'Launch', F: PDFString.of('/Applications/Calculator.app') })),
    }),
  );
  await document.attach(new TextEncoder().encode('Untrusted embedded fixture payload.'), 'payload.txt', {
    mimeType: 'text/plain',
    description: 'Inert embedded-file fixture',
  });
  return document.save({ useObjectStreams: false });
}

async function referenceNavigationPdf() {
  const document = await createFixturePdf();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const pages = Array.from({ length: 4 }, (_, index) => {
    const page = document.addPage([612, 792]);
    page.drawText(`Reference navigation fixture — page ${index + 1}`, {
      x: 72,
      y: 730,
      size: 16,
      font,
    });
    return page;
  });
  const [tocPage, primaryPage, detailPage, hostilePage] = pages;
  if (!tocPage || !primaryPage || !detailPage || !hostilePage) {
    throw new Error('reference navigation fixture requires four pages');
  }
  tocPage.drawText('Body TOC: repeated, aliased, page-only, and distinct-coordinate links', {
    x: 72,
    y: 690,
    size: 11,
    font,
  });
  primaryPage.drawText('Primary target. Follow the target-to-target link for details.', {
    x: 72,
    y: 640,
    size: 11,
    font,
  });
  detailPage.drawText('Detail target with a footnote return to the body TOC.', {
    x: 72,
    y: 430,
    size: 11,
    font,
  });
  hostilePage.drawText('Rejected URI, RemoteGoto, Launch, malformed, missing, and out-of-bounds links.', {
    x: 72,
    y: 690,
    size: 10,
    font,
  });

  const context = document.context;
  const primaryDestination = context.obj([
    primaryPage.ref,
    PDFName.of('XYZ'),
    72,
    640,
    0,
  ]);
  const detailDestination = context.obj([
    detailPage.ref,
    PDFName.of('XYZ'),
    72,
    430,
    0,
  ]);
  const distinctPrimaryDestination = context.obj([
    primaryPage.ref,
    PDFName.of('XYZ'),
    72,
    320,
    0,
  ]);
  document.catalog.set(
    PDFName.of('Dests'),
    context.obj({
      PrimaryTarget: primaryDestination,
      PrimaryAlias: primaryDestination,
      DetailTarget: detailDestination,
    }),
  );

  type LinkOptions = {
    readonly rect: readonly [number, number, number, number];
    readonly contents?: string;
    readonly subject?: string;
    readonly destination?: PDFObject;
    readonly action?: PDFObject;
  };
  function addLink(page: PDFPage, options: LinkOptions): void {
    const annotation = context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [...options.rect],
      Border: [0, 0, 1],
      ...(options.contents === undefined
        ? {}
        : { Contents: PDFHexString.fromText(options.contents) }),
      ...(options.subject === undefined
        ? {}
        : { Subj: PDFHexString.fromText(options.subject) }),
    });
    if (options.destination !== undefined) {
      annotation.set(PDFName.of('Dest'), options.destination);
    }
    if (options.action !== undefined) {
      annotation.set(PDFName.of('A'), options.action);
    }
    let annotations = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annotations) {
      annotations = PDFArray.withContext(context);
      page.node.set(PDFName.of('Annots'), annotations);
    }
    annotations.push(context.register(annotation));
  }

  const reviewAppearance = context.register(context.flateStream(
    '0.95 0.83 0.2 rg 0 0 148 18 re f',
    {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 148, 18],
      Resources: {},
    },
  ));
  function addReviewAnnotation(
    page: PDFPage,
    id: string,
    contents: string,
    rect: readonly [number, number, number, number],
  ): void {
    const annotation = context.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      NM: PDFString.of(id),
      Contents: PDFString.of(contents),
      Rect: [...rect],
      QuadPoints: [rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]],
      C: [0.95, 0.83, 0.2],
      F: 4,
      AP: context.obj({ N: reviewAppearance }),
    });
    let annotations = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annotations) {
      annotations = PDFArray.withContext(context);
      page.node.set(PDFName.of('Annots'), annotations);
    }
    annotations.push(context.register(annotation));
  }

  addReviewAnnotation(
    tocPage,
    'reference-overview-note',
    'Unsectioned review note',
    [72, 700, 220, 718],
  );
  addReviewAnnotation(
    detailPage,
    'reference-details-note',
    'Nested result review note',
    [72, 360, 220, 378],
  );

  addLink(tocPage, {
    rect: [72, 650, 230, 670],
    contents: 'Primary result',
    destination: primaryDestination,
  });
  addLink(tocPage, {
    rect: [72, 620, 230, 640],
    subject: 'Repeated primary result',
    destination: primaryDestination,
  });
  addLink(tocPage, {
    rect: [72, 590, 230, 610],
    contents: 'Named alias for primary result',
    action: context.obj({ S: 'GoTo', D: PDFName.of('PrimaryAlias') }),
  });
  addLink(tocPage, {
    rect: [72, 560, 230, 580],
    contents: 'Page-only detail destination',
    destination: context.obj([detailPage.ref, PDFName.of('Fit')]),
  });
  addLink(tocPage, {
    rect: [72, 530, 230, 550],
    contents: 'Distinct coordinate on primary page',
    destination: distinctPrimaryDestination,
  });
  addLink(tocPage, {
    rect: [72, 500, 360, 520],
    contents: '\u202e<img src=x onerror=alert(1)>\u0000\n hostile\tlabel',
    destination: detailDestination,
  });
  addLink(primaryPage, {
    rect: [72, 600, 300, 620],
    contents: 'Target-to-target detail link',
    action: context.obj({ S: 'GoTo', D: PDFName.of('DetailTarget') }),
  });
  addLink(detailPage, {
    rect: [72, 390, 250, 410],
    contents: 'Footnote return to body TOC',
    destination: context.obj([tocPage.ref, PDFName.of('XYZ'), 72, 690, 0]),
  });

  addLink(hostilePage, {
    rect: [72, 650, 200, 668],
    contents: 'Rejected external URI',
    action: context.obj({ S: 'URI', URI: PDFString.of('https://example.invalid/reference') }),
  });
  addLink(hostilePage, {
    rect: [72, 620, 200, 638],
    contents: 'Rejected cross-document destination',
    action: context.obj({
      S: 'GoToR',
      F: PDFString.of('other-document.pdf'),
      D: PDFString.of('ExternalTarget'),
    }),
  });
  addLink(hostilePage, {
    rect: [72, 590, 200, 608],
    contents: 'Rejected launch action',
    action: context.obj({ S: 'Launch', F: PDFString.of('/Applications/Calculator.app') }),
  });
  addLink(hostilePage, {
    rect: [72, 560, 200, 578],
    contents: 'Malformed local destination',
    destination: context.obj([PDFString.of('not-a-page'), PDFName.of('XYZ'), 0, 0, 0]),
  });
  addLink(hostilePage, {
    rect: [72, 530, 200, 548],
    contents: 'Missing destination',
  });
  addLink(hostilePage, {
    rect: [72, 500, 200, 518],
    contents: 'Out-of-bounds destination',
    destination: context.obj([99, PDFName.of('Fit')]),
  });

  const outlines = context.obj({ Type: 'Outlines', Count: 5 });
  const outlinesRef = context.register(outlines);
  const overview = context.obj({
    Title: PDFHexString.fromText('Overview'),
    Parent: outlinesRef,
    Dest: PDFName.of('PrimaryTarget'),
  });
  const details = context.obj({
    Title: PDFHexString.fromText('Details'),
    Parent: outlinesRef,
    Dest: [detailPage.ref, PDFName.of('Fit')],
    Count: 2,
  });
  const overviewRef = context.register(overview);
  const detailsRef = context.register(details);
  const nested = context.obj({
    Title: PDFHexString.fromText('Nested result'),
    Parent: detailsRef,
    A: { S: 'GoTo', D: PDFName.of('DetailTarget') },
  });
  const hostileOutline = context.obj({
    Title: PDFHexString.fromText('\u202e<script>alert(1)</script>\u0000 hostile outline'),
    Parent: detailsRef,
    Dest: primaryDestination,
  });
  const pageOnlyOutline = context.obj({
    Title: PDFHexString.fromText('Page-only appendix'),
    Parent: outlinesRef,
    Dest: [hostilePage.ref],
  });
  const nestedRef = context.register(nested);
  const hostileOutlineRef = context.register(hostileOutline);
  const pageOnlyOutlineRef = context.register(pageOnlyOutline);
  overview.set(PDFName.of('Next'), detailsRef);
  details.set(PDFName.of('Prev'), overviewRef);
  details.set(PDFName.of('Next'), pageOnlyOutlineRef);
  details.set(PDFName.of('First'), nestedRef);
  details.set(PDFName.of('Last'), hostileOutlineRef);
  nested.set(PDFName.of('Next'), hostileOutlineRef);
  hostileOutline.set(PDFName.of('Prev'), nestedRef);
  pageOnlyOutline.set(PDFName.of('Prev'), detailsRef);
  outlines.set(PDFName.of('First'), overviewRef);
  outlines.set(PDFName.of('Last'), pageOnlyOutlineRef);
  document.catalog.set(PDFName.of('Outlines'), outlinesRef);
  document.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));

  await document.attach(
    new TextEncoder().encode('Embedded content must remain local and inert.'),
    'reference-payload.txt',
    { mimeType: 'text/plain', description: 'Rejected embedded-content fixture' },
  );
  return document.save({ useObjectStreams: false });
}

/**
 * LaTeX-style links with no author-provided names (no /Contents): hyperref
 * and natbib emit bare link rectangles over the visible citation, section,
 * and equation text. With `outline: false` the same document carries no
 * outline, so headings are unavailable and equation links fall back to their
 * kind label.
 */
async function legibleLinkDestinationsPdf(options: { readonly outline: boolean }) {
  const document = await createFixturePdf();
  const roman = await document.embedFont(StandardFonts.TimesRoman);
  const bold = await document.embedFont(StandardFonts.TimesRomanBold);
  const pages = Array.from({ length: 6 }, (_, index) => {
    const page = document.addPage([612, 792]);
    page.drawText(`Legible link destinations fixture — page ${index + 1}`, {
      x: 72,
      y: 740,
      size: 9,
      font: roman,
    });
    return page;
  });
  const [bodyPage, sectionPage, equationPage, bibliographyPage, appendixPage, closingPage] = pages;
  if (!bodyPage || !sectionPage || !equationPage || !bibliographyPage || !appendixPage || !closingPage) {
    throw new Error('legible link destinations fixture requires six pages');
  }
  const context = document.context;
  const bodySize = 11;
  const drawParagraph = (
    page: PDFPage,
    lines: readonly string[],
    top: number,
    pitch = 14,
    size = bodySize,
  ) => {
    lines.forEach((line, index) => page.drawText(line, { x: 72, y: top - index * pitch, size, font: roman }));
  };
  const xyz = (page: PDFPage, x: number, top: number) => context.obj([page.ref, PDFName.of('XYZ'), x, top, null]);

  // Body text, page 1. Each link rectangle covers only the linked words.
  bodyPage.drawText('1 Introduction', { x: 72, y: 690, size: 13, font: bold });
  type LinkSpan = { readonly prefix: string; readonly linked: string; readonly y: number };
  const linkRect = ({ prefix, linked, y }: LinkSpan): [number, number, number, number] => {
    const left = 72 + roman.widthOfTextAtSize(prefix, bodySize);
    return [left, y - 3, left + roman.widthOfTextAtSize(linked, bodySize), y + bodySize];
  };
  const citationLineOne = { prefix: 'Matrix completion under confounding was studied by ', linked: 'Agarwal, Dahleh,', y: 660 };
  const citationLineTwo = { prefix: '', linked: 'et al. (2023)', y: 646 };
  const sectionReference = { prefix: 'The projection is constructed in Section ', linked: '2.3', y: 618 };
  const equationReference = { prefix: 'The estimator then follows from equation (', linked: '1', y: 604 };
  const wholePageReference = { prefix: 'Derivations are collected in the ', linked: 'supplementary appendix', y: 590 };
  const longCitationLineOne = {
    prefix: 'A related bound appears in ',
    linked: 'Montgomery-Hernandez, Oyelaran-Whitfield, Castellanos-Ruiz,',
    y: 562,
  };
  const longCitationLineTwo = { prefix: '', linked: 'and Van der Berghe-Nakamura (2021)', y: 548 };
  drawParagraph(bodyPage, [
    `${citationLineOne.prefix}${citationLineOne.linked}`,
    `${citationLineTwo.linked} and extended to panel data in later work.`,
  ], 660);
  drawParagraph(bodyPage, [
    `${sectionReference.prefix}${sectionReference.linked} from the observed entries.`,
    `${equationReference.prefix}${equationReference.linked}) without further assumptions.`,
    `${wholePageReference.prefix}${wholePageReference.linked} at the end of the paper.`,
  ], 618);
  drawParagraph(bodyPage, [
    `${longCitationLineOne.prefix}${longCitationLineOne.linked}`,
    `${longCitationLineTwo.linked}, which we do not repeat here.`,
  ], 562);

  // Section heading, page 2.
  const sectionHeadingTop = 652;
  sectionPage.drawText('2.3 The Aggregated Projection Matrix', { x: 72, y: 640, size: 13, font: bold });
  drawParagraph(sectionPage, [
    'We aggregate the unit-level projections into a single matrix that maps observed',
    'entries onto the latent factor space. The aggregation keeps the rank fixed and',
    'preserves the ordering of units used throughout the estimation procedure.',
    'Subsequent sections rely on this construction when bounding the error terms.',
  ], 620);

  // Display equation with a right-aligned number, page 3.
  equationPage.drawText('3 Estimation', { x: 72, y: 690, size: 13, font: bold });
  drawParagraph(equationPage, [
    'Combining the projection with the observation model yields the estimator',
  ], 660);
  const equationBaseline = 628;
  equationPage.drawText('Y = P X + E', { x: 250, y: equationBaseline, size: bodySize, font: roman });
  equationPage.drawText('(1)', {
    x: 540 - roman.widthOfTextAtSize('(1)', bodySize),
    y: equationBaseline,
    size: bodySize,
    font: roman,
  });
  drawParagraph(equationPage, [
    'where P is the aggregated projection and E collects the idiosyncratic noise.',
  ], 600);

  // Bibliography with hanging-indent entries, page 4.
  bibliographyPage.drawText('References', { x: 72, y: 690, size: 13, font: bold });
  const bibliographySize = 10;
  const bibliographyPitch = 12;
  const entries = [
    [
      'Abadie, A. and Imbens, G. W. Matching on the estimated propensity score.',
      'Econometrica, 84(2):781-807, 2016.',
    ],
    [
      'Agarwal, A., Dahleh, M., Shah, D., and Shen, D. Causal matrix completion.',
      'In Proceedings of the Thirty Sixth Conference on Learning Theory,',
      'pages 3821-3826. PMLR, 2023.',
    ],
    [
      'Montgomery-Hernandez, R., Oyelaran-Whitfield, T., Castellanos-Ruiz, M., and',
      'Van der Berghe-Nakamura, K. Sharp bounds for low-rank panels. Journal of',
      'Econometric Methods, 12(1):1-44, 2021.',
    ],
    [
      'Zhang, L. and Ortiz, P. Factor models with missing entries. Biometrika,',
      '108(3):591-610, 2019.',
    ],
  ] as const;
  const entryTops: number[] = [];
  let baseline = 664;
  for (const entry of entries) {
    // hyperref anchors a bibliography target slightly above the entry's first baseline.
    entryTops.push(baseline + bibliographySize);
    entry.forEach((line, index) => {
      bibliographyPage.drawText(line, {
        x: index === 0 ? 72 : 90,
        y: baseline,
        size: bibliographySize,
        font: roman,
      });
      baseline -= bibliographyPitch;
    });
    baseline -= 2;
  }

  // Appendix and a closing page with one more citation, pages 5 and 6.
  appendixPage.drawText('Appendix A. Supplementary derivations', { x: 72, y: 690, size: 13, font: bold });
  drawParagraph(appendixPage, [
    'This appendix collects the derivations omitted from the main text.',
  ], 660);
  const closingCitation = { prefix: 'Closing remarks; missing entries are treated as in ', linked: 'Zhang and Ortiz (2019)', y: 690 };
  drawParagraph(closingPage, [`${closingCitation.prefix}${closingCitation.linked}.`], 690);

  const agarwalDestination = xyz(bibliographyPage, 72, entryTops[1]!);
  const longCitationDestination = xyz(bibliographyPage, 72, entryTops[2]!);
  const closingCitationDestination = xyz(bibliographyPage, 72, entryTops[3]!);
  const sectionDestination = xyz(sectionPage, 72, sectionHeadingTop);
  const equationDestination = xyz(equationPage, 72, equationBaseline + bodySize + 2);
  // A null-top XYZ destination names no spot: the whole appendix page.
  const wholePageDestination = context.obj([appendixPage.ref, PDFName.of('XYZ'), null, null, null]);

  const annotations = PDFArray.withContext(context);
  const addLink = (span: LinkSpan, destination: PDFObject) => {
    annotations.push(context.register(context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: linkRect(span),
      Border: [0, 0, 0],
      Dest: destination,
    })));
  };
  // natbib splits one citation across a line break into two link annotations
  // sharing one destination.
  addLink(citationLineOne, agarwalDestination);
  addLink(citationLineTwo, agarwalDestination);
  addLink(sectionReference, sectionDestination);
  addLink(equationReference, equationDestination);
  addLink(wholePageReference, wholePageDestination);
  addLink(longCitationLineOne, longCitationDestination);
  addLink(longCitationLineTwo, longCitationDestination);
  bodyPage.node.set(PDFName.of('Annots'), annotations);
  closingPage.node.set(PDFName.of('Annots'), context.obj([context.register(context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: linkRect(closingCitation),
    Border: [0, 0, 0],
    Dest: closingCitationDestination,
  }))]));

  if (options.outline) {
    const outlines = context.obj({ Type: 'Outlines', Count: 5 });
    const outlinesRef = context.register(outlines);
    const entriesSpec = [
      ['1 Introduction', xyz(bodyPage, 72, 704)],
      ['2.3 The Aggregated Projection Matrix', sectionDestination],
      ['3 Estimation', xyz(equationPage, 72, 704)],
      ['References', xyz(bibliographyPage, 72, 704)],
      ['Appendix A. Supplementary derivations', xyz(appendixPage, 72, 704)],
    ] as const;
    const items = entriesSpec.map(([title, destination]) => context.obj({
      Title: PDFHexString.fromText(title),
      Parent: outlinesRef,
      Dest: destination,
    }));
    const refs = items.map((item) => context.register(item));
    items.forEach((item, index) => {
      if (index > 0) item.set(PDFName.of('Prev'), refs[index - 1]!);
      if (index < items.length - 1) item.set(PDFName.of('Next'), refs[index + 1]!);
    });
    outlines.set(PDFName.of('First'), refs[0]!);
    outlines.set(PDFName.of('Last'), refs.at(-1)!);
    document.catalog.set(PDFName.of('Outlines'), outlinesRef);
  }
  return document.save({ useObjectStreams: false });
}

async function annotatedReferenceNavigationPdf(sourcePdf: Uint8Array): Promise<Uint8Array> {
  const timestamp = '2026-08-23T12:00:00.000Z';
  const item: ReviewItem = {
    id: '51000000-0000-4000-8000-000000000051',
    kind: 'delete',
    pageIndex: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    payload: {
      quote: 'Reference navigation fixture',
      prefix: '',
      suffix: ' — page 1',
      rect: { x: 72, y: 46, width: 214, height: 18 },
      segmentRects: [{ x: 72, y: 46, width: 214, height: 18 }],
      reliable: true,
    },
  };
  const writer = await createSelectedPdfWriter();
  const written = await writer.write({
    sourcePdf,
    sourceSha256: createHash('sha256').update(sourcePdf).digest('hex'),
    revision: 1,
    annotations: [projectReviewItem(item)],
  });
  return written.pdfBytes;
}

async function preservationCorpusPdf() {
  const document = await PDFDocument.load(await textPdf(), { updateMetadata: false });
  const page = document.getPage(0);
  const context = document.context;
  const appearance = context.flateStream("0.3 0.6 0.9 rg 0 0 80 18 re f", {
    Type: "XObject",
    Subtype: "Form",
    BBox: [0, 0, 80, 18],
    Resources: {},
  });
  const normalAppearance = context.obj({ N: context.register(appearance) });
  const common = { Type: "Annot", F: 4, AP: normalAppearance };
  const annotations = [
    context.obj({
      ...common,
      Subtype: "Highlight",
      NM: PDFString.of("preserved-highlight"),
      Contents: PDFString.of("Existing highlight"),
      Rect: [72, 620, 210, 638],
      QuadPoints: [72, 638, 210, 638, 72, 620, 210, 620],
    }),
    context.obj({
      ...common,
      Subtype: "Stamp",
      Name: "Approved",
      NM: PDFString.of("preserved-stamp"),
      Contents: PDFString.of("Existing stamp"),
      Rect: [430, 620, 510, 638],
    }),
    context.obj({
      ...common,
      Subtype: "Ink",
      NM: PDFString.of("preserved-ink"),
      Contents: PDFString.of("Existing drawing"),
      Rect: [72, 580, 160, 610],
      InkList: [[72, 590, 100, 605, 150, 585]],
    }),
    context.obj({
      ...common,
      Subtype: "Link",
      NM: PDFString.of("preserved-link"),
      Contents: PDFString.of("Existing link"),
      Rect: [180, 580, 280, 600],
      A: context.register(
        context.obj({ S: "URI", URI: PDFString.of("https://example.invalid") }),
      ),
    }),
    context.obj({
      ...common,
      Subtype: "Widget",
      FT: "Tx",
      T: PDFString.of("preserved-widget-field"),
      NM: PDFString.of("preserved-widget"),
      Contents: PDFString.of("Existing widget"),
      Rect: [300, 580, 400, 600],
    }),
  ];
  const annotationArray = PDFArray.withContext(context);
  for (const annotation of annotations) {
    annotationArray.push(context.register(annotation));
  }
  page.node.set(PDFName.of("Annots"), annotationArray);
  return document.save({ useObjectStreams: false });
}

async function certifiedPdf() {
  const document = await PDFDocument.load(await textPdf(), { updateMetadata: false });
  const context = document.context;
  const signature = context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, 0, 0, 0],
    Contents: PDFHexString.of('00'),
    Reference: [
      {
        Type: 'SigRef',
        TransformMethod: 'DocMDP',
        TransformParams: { Type: 'TransformParams', P: 1, V: '1.2' },
      },
    ],
  });
  const signatureRef = context.register(signature);
  const field = context.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    T: PDFString.of('Certification'),
    Rect: [0, 0, 0, 0],
    F: 132,
    V: signatureRef,
  });
  const fieldRef = context.register(field);
  const annotations = PDFArray.withContext(context);
  annotations.push(fieldRef);
  document.getPage(0).node.set(PDFName.of('Annots'), annotations);
  document.catalog.set(PDFName.of('AcroForm'), context.obj({ SigFlags: 3, Fields: [fieldRef] }));
  document.catalog.set(PDFName.of('Perms'), context.obj({ DocMDP: signatureRef }));
  return document.save({ useObjectStreams: false });
}

await mkdir(outputDirectory, { recursive: true });
await mkdir(resolve('test/fixtures/pdfium'), { recursive: true });
const referenceNavigation = referenceNavigationPdf();
await Promise.all([
  writeFile(
    resolve('test/fixtures/pdfium/pdfium.wasm'),
    await readFile(resolve('node_modules/@embedpdf/pdfium/dist/pdfium.wasm')),
  ),
  writeFixture('text-native.pdf', await textPdf()),
  writeFixture('text-native-with-annotations.pdf', await textPdf({ annotations: true })),
  writeFixture('image-only.pdf', await imageOnlyPdf()),
  writeFixture('mixed-text-image.pdf', await mixedTextImagePdf()),
  writeFixture('equation-selection.pdf', await equationSelectionPdf()),
  writeFixture('multi-page-text.pdf', await multiPageTextPdf()),
  writeFixture('cross-page-selection.pdf', await crossPageSelectionPdf()),
  writeFixture('pdf-search.pdf', await pdfSearchPdf()),
  writeFixture('rotation-0-crop.pdf', await textPdf({ rotation: 0, crop: true, annotations: true })),
  // These fixtures back the intentionally small cross-engine release profile:
  // cropped selectable text plus unrelated supported and unsupported marks,
  // with rotated variants retained for the exhaustive corpus.
  // Any Firefox/WebKit-only regression found with the exhaustive corpus must
  // be reduced into this fixture/profile before returning to the small gate.
  writeFixture('rotation-90-crop.pdf', await textPdf({ rotation: 90, crop: true })),
  writeFixture('rotation-180-crop.pdf', await textPdf({ rotation: 180, crop: true })),
  writeFixture('rotation-270-crop.pdf', await textPdf({ rotation: 270, crop: true })),
  writeFixture('hostile-actions.pdf', await hostileActionsPdf()),
  writeFixture('reference-navigation.pdf', await referenceNavigation),
  writeFixture(
    'reference-navigation-annotated.pdf',
    await annotatedReferenceNavigationPdf(await referenceNavigation),
  ),
  writeFixture('legible-link-destinations.pdf', await legibleLinkDestinationsPdf({ outline: true })),
  writeFixture(
    'legible-link-destinations-no-outline.pdf',
    await legibleLinkDestinationsPdf({ outline: false }),
  ),
  writeFixture('preservation-corpus.pdf', await preservationCorpusPdf()),
  writeFixture(
    'encrypted-no-annotation.pdf',
    new Uint8Array(Buffer.from(encryptedNoAnnotationBase64, 'base64')),
  ),
  writeFixture('docmdp-no-annotation.pdf', await certifiedPdf()),
  writeFixture(
    'malformed.pdf',
    new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Length 999999 >>\nstream\ntruncated'),
  ),
]);
