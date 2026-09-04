import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { PdfiumNative } from '@embedpdf/engines/pdfium';
import {
  PdfPermissionFlag,
  Rotation,
  type PdfAnnotationObject,
  type PdfDocumentObject,
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
  inspectProjectedPortableAnnotations,
} from '../../core/src/portable-annotation.js';
import type { JsonValue, ReviewItem, ReviewState } from '../../core/src/review-model.js';
import {
  PdfWriterError,
  SEMANTIC_MARKUP_KINDS,
} from '../../core/src/pdf-writer.js';
import {
  annotationPreservationSignature,
  canonicalEmbedPdfValue as canonical,
  embedPdfSubtypeName,
  mapReviewAnnotationToEmbedPdf,
  pdfAnnotationIdentity,
  pdfRewriteMarkers,
  portableItemsFromAnnotationPages,
} from './embedpdf-annotation.js';

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

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export async function assessPdfRewriteEligibility(
  bytes: Uint8Array,
): Promise<PdfRewriteEligibility> {
  const markers = pdfRewriteMarkers(bytes);
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
  const configuredWasm = process.env.PLACEKEEPER_PDFIUM_WASM;
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
      subtype: embedPdfSubtypeName(annotation.type),
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
        .update(annotationPreservationSignature(annotation, pageIndex))
        .digest('hex'),
    };
  });
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
      return [...portableItemsFromAnnotationPages(pages).items];
    } finally {
      await engine.closeDocument(document).toPromise();
    }
  } catch (error) {
    if (error instanceof PdfWriterError) throw error;
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
    const portableItems = [...portableItemsFromAnnotationPages(pages).items];
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
    if (error instanceof PdfWriterError) throw error;
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
      portableItems: [...portableItemsFromAnnotationPages(pages).items],
    };
  } catch (error) {
    if (error instanceof PdfWriterError) throw error;
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
  const reopenedByIdentity = new Map<string, InspectedPdfAnnotation>();
  for (const annotation of after) {
    const identity = pdfAnnotationIdentity(annotation.pageIndex, annotation.id);
    if (!reopenedByIdentity.has(identity)) reopenedByIdentity.set(identity, annotation);
  }
  for (const annotation of before) {
    const reopened = reopenedByIdentity.get(pdfAnnotationIdentity(annotation.pageIndex, annotation.id));
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
  const markers = pdfRewriteMarkers(request.sourcePdf);
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
    const portable = portableItemsFromAnnotationPages(beforePages);
    const ownedIdentities = new Set(portable.owned.map(({ pageIndex, annotation }) =>
      pdfAnnotationIdentity(pageIndex, annotation.id)));
    const foreignPreexisting = preexisting.filter(({ id, pageIndex }) =>
      !ownedIdentities.has(pdfAnnotationIdentity(pageIndex, id)));
    const requestedPortable = inspectProjectedPortableAnnotations(request.annotations);
    if (requestedPortable.status === 'invalid') {
      throw new PdfWriterError(
        'backend-error',
        `The requested portable annotation set is incomplete or inconsistent (${requestedPortable.reason}).`,
      );
    }
    const requestedItemById = new Map(
      requestedPortable.status === 'owned'
        ? requestedPortable.items.map((item) => [item.id, item] as const)
        : [],
    );
    const requestedPortableIndexes = new Set(
      requestedPortable.status === 'owned' ? requestedPortable.ownedIndexes : [],
    );
    const requestedPortableItems = new Map(
      request.annotations.flatMap((annotation, index) => {
        if (
          requestedPortable.status !== 'owned' ||
          !requestedPortableIndexes.has(index)
        ) return [];
        const item = requestedItemById.get(annotation.reviewItemId ?? annotation.id);
        return item === undefined ? [] : [[
          pdfAnnotationIdentity(annotation.pageIndex, annotation.id), item,
        ] as const];
      }),
    );
    const requestedCanonical = new Map(
      [...requestedPortableItems].map(([identity, item]) => [
        identity, JSON.stringify(canonical(item)),
      ]),
    );
    const existingCanonical = new Map(
      portable.items.map((item) => [item.id, JSON.stringify(canonical(item))]),
    );
    const preservedOwnedIdentities = new Set<string>();

    for (const owned of portable.owned) {
      const identity = pdfAnnotationIdentity(owned.pageIndex, owned.annotation.id);
      const requested = requestedPortableItems.get(identity);
      if (
        requested !== undefined &&
        requestedCanonical.get(identity) === existingCanonical.get(owned.item.id)
      ) {
        preservedOwnedIdentities.add(identity);
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
      if (preservedOwnedIdentities.has(pdfAnnotationIdentity(annotation.pageIndex, annotation.id))) continue;
      const page = document.pages[annotation.pageIndex]!;
      await engine.createPageAnnotation(
        document,
        page,
        mapReviewAnnotationToEmbedPdf(annotation),
      ).toPromise();
    }

    const output = new Uint8Array(await engine.saveAsCopy(document).toPromise());
    await engine.closeDocument(document).toPromise();
    document = undefined;

    const reopened = await inspectWithEngine(engine, output);
    assertPreexistingPreserved([
      ...foreignPreexisting,
      ...preexisting.filter(({ id, pageIndex }) =>
        preservedOwnedIdentities.has(pdfAnnotationIdentity(pageIndex, id))),
    ], reopened.annotations);
    const requestedIdentities = new Set(request.annotations.map(({ id, pageIndex }) =>
      pdfAnnotationIdentity(pageIndex, id)));
    const created = reopened.annotations.filter(({ id, pageIndex }) =>
      requestedIdentities.has(pdfAnnotationIdentity(pageIndex, id)));
    if (created.length !== request.annotations.length) {
      throw new PdfWriterError('backend-error', 'Not every requested annotation reopened.');
    }
    if (created.some(({ hasNormalAppearance }) => !hasNormalAppearance)) {
      throw new PdfWriterError(
        'backend-error',
        'At least one annotation lacks an explicit normal appearance.',
      );
    }
    const reopenedItems = reopened.portableItems;
    const reopenedItemById = new Map(
      reopenedItems.map((item) => [item.id, JSON.stringify(canonical(item))]),
    );
    if (
      reopenedItems.length !== requestedItemById.size ||
      [...requestedItemById].some(([id, item]) => {
        const reopenedItem = reopenedItemById.get(id);
        return reopenedItem === undefined ||
          reopenedItem !== JSON.stringify(canonical(item));
      })
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
      coverage: 'exhaustive-preservation',
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
