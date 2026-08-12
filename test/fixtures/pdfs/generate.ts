import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  PDFArray,
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

const outputDirectory = resolve('test/fixtures/pdfs');
const encryptedNoAnnotationBase64 =
  'JVBERi0xLjcKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGRlOTU0NjMwYzIwMGU1MTc2YmYwNjdhOTAxMWYxNjBjMjZlN2Y5M2NiMDg1YzNmMTc0MzAzYmQ5NmVlYWU5ODU+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0hlbHZldGljYS03MDk4NDgwNzg5IDUgMCBSCi9IZWx2ZXRpY2EtOTc0MjY4MjU2OCA1IDAgUgo+PgovWE9iamVjdCA8PAo+PgovRXh0R1N0YXRlIDw8Cj4+Cj4+Ci9NZWRpYUJveCBbIDAgMCA2MTIgNzkyIF0KL0Fubm90cyBbIF0KL0NvbnRlbnRzIFsgNiAwIFIgXQovUGFyZW50IDIgMCBSCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9UeXBlIC9Gb250Ci9TdWJ0eXBlIC9UeXBlMQovQmFzZUZvbnQgL0hlbHZldGljYQovRW5jb2RpbmcgL1dpbkFuc2lFbmNvZGluZwo+PgplbmRvYmoKNiAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoIDI1Ngo+PgpzdHJlYW0K+D741cssH9mtvMVGLzls9Uow/5r8LccUtB9r7Lwh1mStk3Na1fAdvsTJ4jNo7Ar07jFUILdMwU1qaQIQ4cQbQzSkxonj+kiYVngxdZLOUPnASxVGRFuZuTOp9h/+/8Go4xRIoK4IDYF9sTEbyUzr/28knmX1oJtUOV1CENJeHcU4IENHxw3P99W18tTKufF4DrjyKqsVCo3QrbrhvesjJNWiINW3cmTJlPWMMc23UP4nxs3QFqXLSyZXp/6RVTwfSb9w5hNeiaV0rdRuLf0upQ2i9glRC4GT1H3Xq+iqtkShFfjDpJlPX7VFzd/+SBv+PXfRIN7Cui271Ps2WhfnlQplbmRzdHJlYW0KZW5kb2JqCjcgMCBvYmoKPDwKL1YgNQovUiA2Ci9MZW5ndGggMjU2Ci9QIDQKL0ZpbHRlciAvU3RhbmRhcmQKL08gPDUxZGNjOGJmM2FkYjYzNDMwMDc1NTA1ZWI4ODk1ZmVlOWQyMDRhOTg5ZjhjMjZjOWY1ZDQ0OWNiMGI2MjRmZTkwNTJjMGQxNGIzYzhiYzhiNmU5ZGE4NGUzM2UzM2I5ZD4KL1UgPGM1NjJmYTI4YTU3YzE5MTQ3MDE0ZTdkNzA4ZTJjZjJiZjRmN2Y2NjMxMzljMzIxZDM5MmNhNmJhM2M0NzJmZmU3MjVjMjlkNTliODliZWFmMGIyOTJjNWQ0MzJlNGQxZD4KL0NGIDw8Ci9TdGRDRiA8PAovQXV0aEV2ZW50IC9Eb2NPcGVuCi9DRk0gL0FFU1YzCi9MZW5ndGggMzIKPj4KPj4KL1N0bUYgL1N0ZENGCi9TdHJGIC9TdGRDRgovT0UgPGFlOWI4OGVhZDM2MWVlMjUyOTYyZGY2NmNmNWYzMjQ2NDdlMDliNWNhZDMwNzZmYzJlMDI4OGE3MzA0YmY2MTU+Ci9VRSA8ZTQ4NWM4MjNhNTM2MzVkMTdkYmZlZDk4ZTAzNDIxYzEwYTU2MGI5ZWM3NDlkZGM1MzY0ZWNlMGFkY2MyY2UxMj4KL1Blcm1zIDw3MDBlMDE5YmRlNjE4ZGRmMzk0NzNhYjdiMzMxMWMyMz4KPj4KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMTEzIDAwMDAwIG4gCjAwMDAwMDAxNzIgMDAwMDAgbiAKMDAwMDAwMDIyMSAwMDAwMCBuIAowMDAwMDAwNDQzIDAwMDAwIG4gCjAwMDAwMDA1NDAgMDAwMDAgbiAKMDAwMDAwMDg2OCAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDgKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDM1MzQzOTMxNjMzOTYxMzczMjY1NjEzOTM5NjMzNDY0MzEzMTMxNjMzNjY1MzQ2MTY0Mzg2NTM0MzE2NjMyMzc+IDwzNTM0MzkzMTYzMzk2MTM3MzI2NTYxMzkzOTYzMzQ2NDMxMzEzMTYzMzY2NTM0NjE2NDM4NjUzNDMxNjYzMjM3PiBdCi9FbmNyeXB0IDcgMCBSCj4+CnN0YXJ0eHJlZgoxNDE0CiUlRU9GCg==';

async function writeFixture(name: string, bytes: Uint8Array): Promise<void> {
  const path = resolve(outputDirectory, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
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
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('Selectable proofreader text: unique equilibrium clearly.', {
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
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const png = await document.embedPng(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  );
  page.drawImage(png, { x: 72, y: 600, width: 300, height: 120 });
  return document.save({ useObjectStreams: false });
}

async function mixedTextImagePdf() {
  const document = await PDFDocument.create();
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

async function pdfSearchPdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const first = document.addPage([612, 792]);
  first.drawText('A stable model is defined here. Stability matters for the proof. A 90° angle is fixed.', {
    x: 72,
    y: 690,
    size: 14,
    font,
  });
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
  const document = await PDFDocument.create();
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
  const document = await PDFDocument.create();
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

  const outlines = context.obj({ Type: 'Outlines', Count: 4 });
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
  const nestedRef = context.register(nested);
  const hostileOutlineRef = context.register(hostileOutline);
  overview.set(PDFName.of('Next'), detailsRef);
  details.set(PDFName.of('Prev'), overviewRef);
  details.set(PDFName.of('First'), nestedRef);
  details.set(PDFName.of('Last'), hostileOutlineRef);
  nested.set(PDFName.of('Next'), hostileOutlineRef);
  hostileOutline.set(PDFName.of('Prev'), nestedRef);
  outlines.set(PDFName.of('First'), overviewRef);
  outlines.set(PDFName.of('Last'), detailsRef);
  document.catalog.set(PDFName.of('Outlines'), outlinesRef);
  document.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));

  await document.attach(
    new TextEncoder().encode('Embedded content must remain local and inert.'),
    'reference-payload.txt',
    { mimeType: 'text/plain', description: 'Rejected embedded-content fixture' },
  );
  return document.save({ useObjectStreams: false });
}

async function preservationCorpusPdf() {
  const document = await PDFDocument.load(await textPdf());
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
  const document = await PDFDocument.load(await textPdf());
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
await Promise.all([
  writeFile(
    resolve('test/fixtures/pdfium/pdfium.wasm'),
    await readFile(resolve('node_modules/@embedpdf/pdfium/dist/pdfium.wasm')),
  ),
  writeFixture('text-native.pdf', await textPdf()),
  writeFixture('text-native-with-annotations.pdf', await textPdf({ annotations: true })),
  writeFixture('image-only.pdf', await imageOnlyPdf()),
  writeFixture('mixed-text-image.pdf', await mixedTextImagePdf()),
  writeFixture('pdf-search.pdf', await pdfSearchPdf()),
  writeFixture('rotation-0-crop.pdf', await textPdf({ rotation: 0, crop: true })),
  writeFixture('rotation-90-crop.pdf', await textPdf({ rotation: 90, crop: true })),
  writeFixture('rotation-180-crop.pdf', await textPdf({ rotation: 180, crop: true })),
  writeFixture('rotation-270-crop.pdf', await textPdf({ rotation: 270, crop: true })),
  writeFixture('hostile-actions.pdf', await hostileActionsPdf()),
  writeFixture('reference-navigation.pdf', await referenceNavigationPdf()),
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
