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
  PdfRewriteEligibility,
  ReviewAnnotation,
} from '../../core/src/pdf-writer.js';
import {
  inspectPortableAnnotation,
  inspectProjectedPortableAnnotation,
  type VisiblePortableAnnotation,
} from '../../core/src/portable-annotation.js';
import type { JsonValue, ReviewItem, ReviewState } from '../../core/src/review-model.js';
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
  custom?: unknown;
}

export interface InspectedPdf {
  pageCount: number;
  pageFingerprints: readonly string[];
  annotationSubtypes: string[];
  annotations: InspectedPdfAnnotation[];
  portableItems: ReviewItem[];
}

export interface InspectedPdfAnnotationCatalog {
  pageCount: number;
  annotations: InspectedPdfAnnotation[];
  portableItems: ReviewItem[];
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
    ...(annotation.custom === undefined ? {} : { custom: annotation.custom }),
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

export async function assessPdfRewriteEligibility(
  bytes: Uint8Array,
): Promise<PdfRewriteEligibility> {
  const markers = rawMarkers(bytes);
  if (markers.encrypted) {
    return { eligible: false, code: 'encrypted', message: 'This encrypted PDF cannot be annotated safely.' };
  }
  if (markers.docMdp) {
    return {
      eligible: false,
      code: 'signature-restricted',
      message: 'This PDF is certification-protected and cannot be annotated safely.',
    };
  }
  const engine = await newEngine();
  let document: PdfDocumentObject | undefined;
  try {
    document = await engine
      .openDocumentBuffer({ id: randomUUID(), content: toArrayBuffer(bytes) })
      .toPromise();
    if (document.isEncrypted) {
      return { eligible: false, code: 'encrypted', message: 'This encrypted PDF cannot be annotated safely.' };
    }
    if (
      document.permissions !== -1 &&
      (document.permissions & PdfPermissionFlag.ModifyAnnotations) === 0
    ) {
      return {
        eligible: false,
        code: 'permission-denied',
        message: 'This PDF does not permit adding or modifying annotations.',
      };
    }
    if ((await engine.getSignatures(document).toPromise()).length > 0) {
      return {
        eligible: false,
        code: 'signature-restricted',
        message: 'This signed PDF cannot be annotated without invalidating its signature.',
      };
    }
    return { eligible: true };
  } catch (error) {
    if (error instanceof PdfWriterError) throw error;
    return { eligible: false, code: 'invalid-pdf', message: 'This PDF cannot be rewritten safely.' };
  } finally {
    if (document) await engine.closeDocument(document).toPromise().catch(() => false);
    await engine.destroy().toPromise();
  }
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
      ...(annotation.custom === undefined ? {} : { custom: annotation.custom }),
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

function visibleAnnotation(
  annotation: PdfAnnotationObject,
  pageIndex: number,
): VisiblePortableAnnotation {
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
    rect: annotation.rect,
    ...(segmentRects === undefined ? {} : { segmentRects }),
  };
}

function translateLegacyRect(value: JsonValue | undefined, left: number, top: number): JsonValue | undefined {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    typeof value.x !== 'number' ||
    typeof value.y !== 'number'
  ) {
    return value;
  }
  return { ...value, x: value.x - left, y: value.y - top };
}

function migrateLegacyItemGeometry(
  item: ReviewItem,
  page: PdfDocumentObject['pages'][number] | undefined,
): ReviewItem {
  if (!page) {
    throw new PdfWriterError(
      'invalid-annotation-geometry',
      `Annotation ${item.id} targets missing page ${item.pageIndex}.`,
    );
  }
  const left = page.boxes?.crop.left ?? 0;
  const top = page.boxes?.crop.top ?? 0;
  const payload: Record<string, JsonValue> = { ...item.payload };
  if (item.kind === 'insert' || item.kind === 'pageNote') {
    const position = translateLegacyRect(payload.position, left, top);
    if (position !== undefined) payload.position = position;
  } else {
    const rect = translateLegacyRect(payload.rect, left, top);
    if (rect !== undefined) payload.rect = rect;
    if (Array.isArray(payload.segmentRects)) {
      payload.segmentRects = payload.segmentRects.map(
        (segment) => translateLegacyRect(segment, left, top) ?? segment,
      );
    }
  }
  return { ...item, payload };
}

function migrateLegacyStateWithPages(
  state: ReviewState,
  pages: PdfDocumentObject['pages'],
): ReviewState {
  if (state.schemaVersion === 2) return state;
  const migrate = (item: ReviewItem) => migrateLegacyItemGeometry(item, pages[item.pageIndex]);
  return {
    ...state,
    schemaVersion: 2,
    items: state.items.map(migrate),
    history: state.history.map((entry) => ({
      beforeItems: entry.beforeItems.map(migrate),
      afterItems: entry.afterItems.map(migrate),
    })),
  };
}

function portableItemsFromPages(
  annotationPages: readonly (readonly PdfAnnotationObject[])[],
  documentPages: PdfDocumentObject['pages'],
): {
  items: ReviewItem[];
  owned: Array<{ pageIndex: number; annotation: PdfAnnotationObject; item: ReviewItem }>;
} {
  const counts = new Map<string, number>();
  for (const annotations of annotationPages) {
    for (const annotation of annotations) {
      counts.set(annotation.id, (counts.get(annotation.id) ?? 0) + 1);
    }
  }
  const items: ReviewItem[] = [];
  const owned: Array<{
    pageIndex: number;
    annotation: PdfAnnotationObject;
    item: ReviewItem;
  }> = [];
  annotationPages.forEach((annotations, pageIndex) => {
    for (const annotation of annotations) {
      const inspected = inspectPortableAnnotation(
        annotation.custom,
        visibleAnnotation(annotation, pageIndex),
        counts.has(annotation.id)
          ? { visibleIdCount: counts.get(annotation.id)! }
          : {},
      );
      if (inspected.status === 'owned') {
        const item = inspected.geometryVersion === 1
          ? migrateLegacyItemGeometry(inspected.item, documentPages[pageIndex])
          : inspected.item;
        items.push(item);
        owned.push({ pageIndex, annotation, item });
      }
    }
  });
  return { items, owned };
}

export async function readPortableReviewItems(bytes: Uint8Array): Promise<ReviewItem[]> {
  const engine = await newEngine();
  try {
    const document = await engine
      .openDocumentBuffer({ id: randomUUID(), content: toArrayBuffer(bytes) })
      .toPromise();
    try {
      const pages = await Promise.all(
        document.pages.map((page) => engine.getPageAnnotations(document, page).toPromise()),
      );
      return portableItemsFromPages(pages, document.pages).items;
    } finally {
      await engine.closeDocument(document).toPromise();
    }
  } catch (error) {
    throw new PdfWriterError('invalid-pdf', 'EmbedPDF could not read portable annotations.', {
      cause: error,
    });
  } finally {
    await engine.destroy().toPromise();
  }
}

/** Upgrades recovery state written by the pre-v2 coordinate contract. */
export async function migrateLegacyReviewStateGeometry(
  bytes: Uint8Array,
  state: ReviewState,
): Promise<ReviewState> {
  if (state.schemaVersion === 2) return state;
  const engine = await newEngine();
  try {
    const document = await engine
      .openDocumentBuffer({ id: randomUUID(), content: toArrayBuffer(bytes) })
      .toPromise();
    try {
      return migrateLegacyStateWithPages(state, document.pages);
    } finally {
      await engine.closeDocument(document).toPromise();
    }
  } catch (error) {
    if (error instanceof PdfWriterError) throw error;
    throw new PdfWriterError('invalid-pdf', 'EmbedPDF could not migrate legacy review geometry.', {
      cause: error,
    });
  } finally {
    await engine.destroy().toPromise();
  }
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
    const portableItems = portableItemsFromPages(pages, document.pages).items;
    return {
      pageCount: document.pageCount,
      pageFingerprints,
      annotations,
      portableItems,
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

/**
 * Reads the source annotation catalog without rendering every page. Live
 * context uses this bounded structural pass; conformance inspection keeps the
 * heavier page fingerprints above.
 */
export async function inspectPdfAnnotationCatalogWithEmbedPdf(
  bytes: Uint8Array,
): Promise<InspectedPdfAnnotationCatalog> {
  const engine = await newEngine();
  let document: PdfDocumentObject | undefined;
  try {
    document = await engine
      .openDocumentBuffer({ id: randomUUID(), content: toArrayBuffer(bytes) })
      .toPromise();
    const pages = await Promise.all(
      document.pages.map((page) => engine.getPageAnnotations(document!, page).toPromise()),
    );
    return {
      pageCount: document.pageCount,
      annotations: pages.flatMap((annotations, pageIndex) =>
        inspectAnnotations(annotations, pageIndex)),
      portableItems: portableItemsFromPages(pages, document.pages).items,
    };
  } catch (error) {
    throw new PdfWriterError('invalid-pdf', 'EmbedPDF could not inspect PDF annotations.', {
      cause: error,
    });
  } finally {
    if (document !== undefined) {
      await engine.closeDocument(document).toPromise().catch(() => false);
    }
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

function assertAnnotationWithinPage(
  annotation: ReviewAnnotation,
  page: PdfDocumentObject['pages'][number],
): void {
  const epsilon = 0.001;
  const rects = [annotation.rect, ...(annotation.quadPoints ?? [])];
  const invalid = rects.find((rect) =>
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x < -epsilon ||
    rect.y < -epsilon ||
    rect.x + rect.width > page.size.width + epsilon ||
    rect.y + rect.height > page.size.height + epsilon,
  );
  if (invalid) {
    throw new PdfWriterError(
      'invalid-annotation-geometry',
      `Annotation ${annotation.id} has geometry outside page ${annotation.pageIndex}'s crop-relative canvas.`,
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

    for (const annotation of request.annotations) {
      const page = document.pages[annotation.pageIndex];
      if (!page) {
        throw new PdfWriterError(
          'invalid-pdf',
          `Annotation ${annotation.id} targets missing page ${annotation.pageIndex}.`,
        );
      }
      assertAnnotationWithinPage(annotation, page);
    }

    const beforePages = await Promise.all(
      document.pages.map((page) => engine.getPageAnnotations(document!, page).toPromise()),
    );
    const preexisting = beforePages.flatMap((pageAnnotations, pageIndex) =>
      inspectAnnotations(pageAnnotations, pageIndex),
    );
    const portable = portableItemsFromPages(beforePages, document.pages);
    const ownedIds = new Set(portable.owned.map(({ annotation }) => annotation.id));
    const foreignPreexisting = preexisting.filter(({ id }) => !ownedIds.has(id));
    const requestedPortableItems = new Map(
      request.annotations.flatMap((annotation) => {
        const inspected = inspectProjectedPortableAnnotation(annotation);
        return inspected.status === 'owned' ? [[annotation.id, inspected.item] as const] : [];
      }),
    );
    const preservedOwnedIds = new Set<string>();

    for (const owned of portable.owned) {
      const requested = requestedPortableItems.get(owned.annotation.id);
      if (
        requested !== undefined &&
        JSON.stringify(canonical(requested)) === JSON.stringify(canonical(owned.item))
      ) {
        preservedOwnedIds.add(owned.annotation.id);
        continue;
      }
      const page = document.pages[owned.pageIndex];
      if (!page || !(await engine.removePageAnnotation(document, page, owned.annotation).toPromise())) {
        throw new PdfWriterError(
          'backend-error',
          `Could not replace owned annotation ${owned.annotation.id}.`,
        );
      }
    }

    for (const annotation of request.annotations) {
      if (preservedOwnedIds.has(annotation.id)) continue;
      const page = document.pages[annotation.pageIndex]!;
      await engine.createPageAnnotation(document, page, mapAnnotation(annotation)).toPromise();
    }

    const output = new Uint8Array(await engine.saveAsCopy(document).toPromise());
    await engine.closeDocument(document).toPromise();
    document = undefined;

    const reopened = await inspectWithEngine(engine, output);
    assertPreexistingPreserved([
      ...foreignPreexisting,
      ...preexisting.filter(({ id }) => preservedOwnedIds.has(id)),
    ], reopened.annotations);
    const requestedIds = new Set(request.annotations.map(({ id }) => id));
    const created = reopened.annotations.filter(({ id }) => requestedIds.has(id));
    if (created.length !== request.annotations.length) {
      throw new PdfWriterError('backend-error', 'Not every requested annotation reopened.');
    }
    if (created.some(({ hasNormalAppearance }) => !hasNormalAppearance)) {
      throw new PdfWriterError(
        'backend-error',
        'At least one annotation lacks an explicit normal appearance.',
      );
    }
    const portableRequested = request.annotations.filter(
      (annotation) => annotation.custom !== undefined,
    );
    const reopenedItems = reopened.portableItems;
    if (
      reopenedItems.length !== portableRequested.length ||
      portableRequested.some(({ id }) => !reopenedItems.some((item) => item.id === id))
    ) {
      const diagnostics = created.map((annotation) => ({
        id: annotation.id,
        inspection: inspectPortableAnnotation(annotation.custom, annotation),
      }));
      throw new PdfWriterError(
        'backend-error',
        `At least one app annotation did not reopen with editable metadata: ${JSON.stringify(diagnostics)}.`,
      );
    }

    const evidence: PdfStructuralEvidence = {
      backend: 'embedpdf',
      backendVersion: EMBEDPDF_VERSION,
      originalSha256: request.sourceSha256,
      outputSha256: sha256(output),
      pageCount: reopened.pageCount,
      structurallyValid: true,
      preexistingAnnotationIds: foreignPreexisting.map(({ id }) => id),
      annotations: created,
    };
    return { pdfBytes: output, evidence, inspection: reopened };
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
  return { write: writeWithEmbedPdf, assess: assessPdfRewriteEligibility };
}
