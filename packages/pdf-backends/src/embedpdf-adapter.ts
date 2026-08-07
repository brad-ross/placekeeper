import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { PdfiumNative } from '@embedpdf/engines/pdfium';
import {
  PdfAnnotationName,
  PdfAnnotationSubtype,
  PdfPermissionFlag,
  Rotation,
  type PdfAnnotationFlagName,
  type PdfAnnotationObject,
  type PdfDocumentObject,
  type PdfHighlightAnnoObject,
  type PdfStrikeOutAnnoObject,
  type PdfTextAnnoObject,
  type Rect,
} from '@embedpdf/models';
import { init } from '@embedpdf/pdfium';

import type {
  PdfStructuralEvidence,
  PdfWriteRequest,
  PdfWriteResult,
  PdfWriter,
  ReviewAnnotation,
} from '../../core/src/pdf-writer.js';
import {
  PdfWriterError,
  SEMANTIC_MARKUP_KINDS,
} from '../../core/src/pdf-writer.js';

const EMBEDPDF_VERSION = '2.14.4';
const NORMAL_APPEARANCE = 1;

export interface InspectedPdfAnnotation {
  id: string;
  pageIndex: number;
  subtype: string;
  contents: string;
  author?: string;
  flags: readonly string[];
  hasNormalAppearance: boolean;
  rect: Rect;
  segmentRects?: readonly Rect[];
  preservationFingerprint: string;
}

export interface InspectedPdf {
  pageCount: number;
  pageFingerprints: readonly string[];
  annotationSubtypes: string[];
  annotations: InspectedPdfAnnotation[];
}

type SupportedOutputAnnotation =
  | PdfStrikeOutAnnoObject
  | PdfHighlightAnnoObject
  | PdfTextAnnoObject;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function toEngineRect(rect: ReviewAnnotation['rect']): Rect {
  return {
    origin: { x: rect.x, y: rect.y },
    size: { width: rect.width, height: rect.height },
  };
}

function subtypeName(type: PdfAnnotationSubtype): string {
  switch (type) {
    case PdfAnnotationSubtype.STRIKEOUT:
      return 'strikeOut';
    case PdfAnnotationSubtype.FREETEXT:
      return 'freeText';
    case PdfAnnotationSubtype.FILEATTACHMENT:
      return 'fileAttachment';
    default:
      return PdfAnnotationSubtype[type]?.toLowerCase() ?? 'unknown';
  }
}

function common(annotation: ReviewAnnotation, type: PdfAnnotationSubtype) {
  return {
    id: annotation.id,
    type,
    pageIndex: annotation.pageIndex,
    rect: toEngineRect(annotation.rect),
    contents: annotation.contents,
    author: annotation.author,
    created: new Date(annotation.createdAt),
    modified: new Date(annotation.modifiedAt),
    flags: ['print'] as PdfAnnotationFlagName[],
  };
}

function mapAnnotation(annotation: ReviewAnnotation): SupportedOutputAnnotation {
  const segmentRects = annotation.quadPoints?.map(toEngineRect) ?? [toEngineRect(annotation.rect)];
  switch (annotation.kind) {
    case 'replace':
    case 'delete':
      return {
        ...common(annotation, PdfAnnotationSubtype.STRIKEOUT),
        type: PdfAnnotationSubtype.STRIKEOUT,
        strokeColor: '#d32f2f',
        opacity: 1,
        segmentRects,
      };
    case 'insert':
      return {
        ...common(annotation, PdfAnnotationSubtype.TEXT),
        type: PdfAnnotationSubtype.TEXT,
        strokeColor: '#1565c0',
        opacity: 1,
        name: PdfAnnotationName.Insert,
      };
    case 'highlight':
      return {
        ...common(annotation, PdfAnnotationSubtype.HIGHLIGHT),
        type: PdfAnnotationSubtype.HIGHLIGHT,
        strokeColor: '#ffd54f',
        opacity: 0.45,
        segmentRects,
      };
    case 'pageNote':
      return {
        ...common(annotation, PdfAnnotationSubtype.TEXT),
        type: PdfAnnotationSubtype.TEXT,
        strokeColor: '#ffc107',
        opacity: 1,
        name: PdfAnnotationName.Note,
      };
  }
}

function rawMarkers(bytes: Uint8Array): { encrypted: boolean; docMdp: boolean } {
  const raw = new TextDecoder('latin1').decode(bytes);
  return {
    encrypted: raw.includes('/Encrypt'),
    docMdp: raw.includes('/DocMDP'),
  };
}

async function newEngine(): Promise<PdfiumNative> {
  const configuredWasm = process.env.PDF_PROOFREADER_PDFIUM_WASM;
  if (configuredWasm !== undefined && !isAbsolute(configuredWasm)) {
    throw new PdfWriterError(
      'backend-error',
      'The packaged PDFium runtime path must be absolute.',
    );
  }
  const module = await init(
    configuredWasm === undefined
      ? {}
      : { locateFile: (path: string) => path.endsWith('.wasm') ? configuredWasm : path },
  );
  return new PdfiumNative(module, { fontFallback: null });
}

function inspectAnnotations(
  annotations: readonly PdfAnnotationObject[],
  pageIndex: number,
): InspectedPdfAnnotation[] {
  return annotations.map((annotation) => {
    const segmentRects =
      'segmentRects' in annotation && Array.isArray(annotation.segmentRects)
        ? annotation.segmentRects
        : undefined;
    return {
      id: annotation.id,
      pageIndex,
      subtype: subtypeName(annotation.type),
      contents: annotation.contents ?? '',
      ...(annotation.author === undefined ? {} : { author: annotation.author }),
      flags: annotation.flags ?? [],
      hasNormalAppearance: ((annotation.appearanceModes ?? 0) & NORMAL_APPEARANCE) !== 0,
      rect: annotation.rect,
      ...(segmentRects === undefined ? {} : { segmentRects }),
      // PDFium synthesizes a fresh UUID on every open when an annotation has no
      // persistent /NM entry (common for generated links). That runtime ID is
      // not part of the PDF dictionary and must not make preservation checks
      // nondeterministic. The writer still verifies persistent IDs separately.
      preservationFingerprint: createHash('sha256')
        .update(JSON.stringify(canonical(
          Object.fromEntries(Object.entries(annotation).filter(([key]) => key !== 'id')),
        )))
        .digest('hex'),
    };
  });
}

async function inspectWithEngine(engine: PdfiumNative, bytes: Uint8Array): Promise<InspectedPdf> {
  const document = await engine
    .openDocumentBuffer({ id: randomUUID(), content: toArrayBuffer(bytes) })
    .toPromise();
  try {
    const pageFingerprints: string[] = [];
    for (const page of document.pages) {
      const rendered = await engine
        .renderPageRaw(document, page, {
          scaleFactor: 1,
          dpr: 1,
          rotation: Rotation.Degree0,
          withAnnotations: false,
          withForms: false,
          transparentBackground: false,
        })
        .toPromise();
      const fingerprint = createHash('sha256');
      fingerprint.update(
        JSON.stringify(
          canonical({
            index: page.index,
            size: page.size,
            rotation: page.rotation,
            boxes: page.boxes ?? null,
            renderedSize: { width: rendered.width, height: rendered.height },
          }),
        ),
      );
      fingerprint.update(rendered.data);
      pageFingerprints.push(fingerprint.digest('hex'));
    }
    const pages = await Promise.all(
      document.pages.map((page) => engine.getPageAnnotations(document, page).toPromise()),
    );
    const annotations = pages.flatMap((pageAnnotations, pageIndex) =>
      inspectAnnotations(pageAnnotations, pageIndex),
    );
    return {
      pageCount: document.pageCount,
      pageFingerprints,
      annotations,
      annotationSubtypes: annotations.map(({ subtype }) => subtype),
    };
  } finally {
    await engine.closeDocument(document).toPromise();
  }
}

export async function inspectPdfWithEmbedPdf(bytes: Uint8Array): Promise<InspectedPdf> {
  const engine = await newEngine();
  try {
    return await inspectWithEngine(engine, bytes);
  } catch (error) {
    throw new PdfWriterError('invalid-pdf', 'EmbedPDF could not reopen the PDF.', { cause: error });
  } finally {
    await engine.destroy().toPromise();
  }
}

function assertSemanticGeometry(annotations: readonly ReviewAnnotation[]): void {
  const invalid = annotations.find(
    (annotation) =>
      SEMANTIC_MARKUP_KINDS.has(annotation.kind) && annotation.textAnchorReliable !== true,
  );
  if (invalid) {
    throw new PdfWriterError(
      'unreliable-text-geometry',
      `Annotation ${invalid.id} requires reliable selectable text geometry.`,
    );
  }
}

function assertPreexistingPreserved(
  before: readonly InspectedPdfAnnotation[],
  after: readonly InspectedPdfAnnotation[],
): void {
  for (const annotation of before) {
    const reopened = after.find(({ id }) => id === annotation.id);
    const stableBefore = JSON.stringify(annotation);
    const stableAfter = reopened && JSON.stringify(reopened);
    if (!reopened || stableAfter !== stableBefore) {
      throw new PdfWriterError(
        'backend-error',
        `Pre-existing annotation ${annotation.id} was not preserved unchanged.`,
      );
    }
  }
}

async function writeWithEmbedPdf(request: PdfWriteRequest): Promise<PdfWriteResult> {
  assertSemanticGeometry(request.annotations);
  const markers = rawMarkers(request.sourcePdf);
  if (markers.encrypted) {
    throw new PdfWriterError('encrypted', 'Encrypted PDF annotation is unavailable in v1.');
  }
  if (markers.docMdp) {
    throw new PdfWriterError(
      'signature-restricted',
      'The PDF signature certification prevents safe annotation.',
    );
  }

  const engine = await newEngine();
  let document: PdfDocumentObject | undefined;
  try {
    document = await engine
      .openDocumentBuffer({ id: randomUUID(), content: toArrayBuffer(request.sourcePdf) })
      .toPromise();
    if (document.isEncrypted) {
      throw new PdfWriterError('encrypted', 'Encrypted PDF annotation is unavailable in v1.');
    }
    if (
      document.permissions !== -1 &&
      (document.permissions & PdfPermissionFlag.ModifyAnnotations) === 0
    ) {
      throw new PdfWriterError(
        'permission-denied',
        'The PDF does not permit adding or modifying annotations.',
      );
    }
    const signatures = await engine.getSignatures(document).toPromise();
    if (signatures.length > 0) {
      throw new PdfWriterError(
        'signature-restricted',
        'Signed PDF annotation is unavailable until the signature fixture is approved.',
      );
    }

    const beforePages = await Promise.all(
      document.pages.map((page) => engine.getPageAnnotations(document!, page).toPromise()),
    );
    const preexisting = beforePages.flatMap((pageAnnotations, pageIndex) =>
      inspectAnnotations(pageAnnotations, pageIndex),
    );

    for (const annotation of request.annotations) {
      const page = document.pages[annotation.pageIndex];
      if (!page) {
        throw new PdfWriterError(
          'invalid-pdf',
          `Annotation ${annotation.id} targets missing page ${annotation.pageIndex}.`,
        );
      }
      await engine.createPageAnnotation(document, page, mapAnnotation(annotation)).toPromise();
    }

    const output = new Uint8Array(await engine.saveAsCopy(document).toPromise());
    await engine.closeDocument(document).toPromise();
    document = undefined;

    const reopened = await inspectWithEngine(engine, output);
    assertPreexistingPreserved(preexisting, reopened.annotations);
    const created = reopened.annotations.filter(({ id }) =>
      request.annotations.some((annotation) => annotation.id === id),
    );
    if (created.length !== request.annotations.length) {
      throw new PdfWriterError('backend-error', 'Not every requested annotation reopened.');
    }
    if (created.some(({ hasNormalAppearance }) => !hasNormalAppearance)) {
      throw new PdfWriterError(
        'backend-error',
        'At least one annotation lacks an explicit normal appearance.',
      );
    }

    const evidence: PdfStructuralEvidence = {
      backend: 'embedpdf',
      backendVersion: EMBEDPDF_VERSION,
      originalSha256: request.sourceSha256,
      outputSha256: sha256(output),
      pageCount: reopened.pageCount,
      structurallyValid: true,
      preexistingAnnotationIds: preexisting.map(({ id }) => id),
      annotations: created,
    };
    return { pdfBytes: output, evidence };
  } catch (error) {
    if (error instanceof PdfWriterError) throw error;
    throw new PdfWriterError('invalid-pdf', 'EmbedPDF could not safely write the PDF.', {
      cause: error,
    });
  } finally {
    if (document) await engine.closeDocument(document).toPromise().catch(() => false);
    await engine.destroy().toPromise();
  }
}

export async function createEmbedPdfWriter(): Promise<PdfWriter> {
  return { write: writeWithEmbedPdf };
}
