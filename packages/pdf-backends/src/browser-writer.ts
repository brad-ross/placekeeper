import { createPdfiumEngine } from '@embedpdf/engines/pdfium-worker-engine';
import {
  PdfPermissionFlag,
  type PdfAnnotationObject,
  type PdfDocumentObject,
  type PdfEngine,
} from '@embedpdf/models';

import {
  PdfWriterError,
  SEMANTIC_MARKUP_KINDS,
  type PdfRewriteEligibility,
  type PdfStructuralEvidence,
  type PdfWriteRequest,
  type PdfWriteResult,
  type ReviewAnnotation,
} from '../../core/src/pdf-writer.js';
import { inspectPortableAnnotations, inspectProjectedPortableAnnotations } from '../../core/src/portable-annotation.js';
import {
  embedPdfSubtypeName,
  mapReviewAnnotationToEmbedPdf,
  pdfAnnotationIdentity,
  pdfRewriteMarkers,
  portableItemsFromAnnotationPages,
  visibleEmbedPdfAnnotation,
} from './embedpdf-annotation.js';
import type { DisposablePdfWriter } from './browser-document-session.js';

const EMBEDPDF_VERSION = '2.14.4';
const NORMAL_APPEARANCE = 1;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function closeEngine(engine: PdfEngine<Blob>, document?: PdfDocumentObject): Promise<unknown> {
  return (async () => {
    if (document !== undefined) {
      await engine.closeDocument(document).toPromise().catch(() => false);
    }
    await engine.destroy?.().toPromise().catch(() => false);
  })();
}

function assertSemanticGeometry(annotations: readonly ReviewAnnotation[]): void {
  const invalid = annotations.find((annotation) => (
    SEMANTIC_MARKUP_KINDS.has(annotation.kind) && annotation.textAnchorReliable !== true
  ));
  if (invalid !== undefined) {
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
  const invalid = [annotation.rect, ...(annotation.quadPoints ?? [])].find((rect) => (
    !Number.isFinite(rect.x) || !Number.isFinite(rect.y)
    || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)
    || rect.width <= 0 || rect.height <= 0
    || rect.x < -epsilon || rect.y < -epsilon
    || rect.x + rect.width > page.size.width + epsilon
    || rect.y + rect.height > page.size.height + epsilon
  ));
  if (invalid !== undefined) {
    throw new PdfWriterError(
      'invalid-annotation-geometry',
      `Annotation ${annotation.id} has geometry outside page ${annotation.pageIndex}'s canvas.`,
    );
  }
}

async function annotationPages(
  engine: PdfEngine<Blob>,
  document: PdfDocumentObject,
): Promise<PdfAnnotationObject[][]> {
  return Promise.all(document.pages.map(
    (page) => engine.getPageAnnotations(document, page).toPromise(),
  ));
}

function unavailableFromMarkers(bytes: Uint8Array): PdfRewriteEligibility | undefined {
  const markers = pdfRewriteMarkers(bytes);
  if (markers.encrypted) {
    return { eligible: false, code: 'encrypted', message: 'This encrypted PDF cannot be annotated safely.' };
  }
  if (markers.docMdp) {
    return {
      eligible: false,
      code: 'signature-restricted',
      message: 'This certification-protected PDF cannot be annotated safely.',
    };
  }
  return undefined;
}

export async function createBrowserEmbedPdfWriter(
  pdfiumWasm: string,
  pdfiumWorker?: string,
): Promise<DisposablePdfWriter> {
  const newEngine = () => createPdfiumEngine(pdfiumWasm, {
    encoderPoolSize: 1,
    fontFallback: null,
    ...(pdfiumWorker === undefined
      ? {}
      : { worker: new Worker(pdfiumWorker, { type: 'module' }) }),
  });
  const activeEngines = new Map<PdfEngine<Blob>, PdfDocumentObject | undefined>();
  let disposed = false;

  const openEngine = (): PdfEngine<Blob> => {
    if (disposed) throw new PdfWriterError('cancelled', 'The browser PDF session is closed.');
    const engine = newEngine();
    activeEngines.set(engine, undefined);
    return engine;
  };
  const trackDocument = (engine: PdfEngine<Blob>, document: PdfDocumentObject | undefined): void => {
    if (activeEngines.has(engine)) activeEngines.set(engine, document);
  };
  const releaseEngine = async (
    engine: PdfEngine<Blob>,
    document?: PdfDocumentObject,
  ): Promise<void> => {
    activeEngines.delete(engine);
    await closeEngine(engine, document);
  };

  let cachedAssessment: {
    readonly digest: string;
    readonly eligibility: PdfRewriteEligibility;
  } | undefined;

  const assessUncached = async (bytes: Uint8Array): Promise<PdfRewriteEligibility> => {
    const markerFailure = unavailableFromMarkers(bytes);
    if (markerFailure !== undefined) return markerFailure;
    const engine = openEngine();
    let document: PdfDocumentObject | undefined;
    try {
      document = await engine.openDocumentBuffer({
        id: crypto.randomUUID(),
        content: toArrayBuffer(bytes),
      }).toPromise();
      trackDocument(engine, document);
      if (disposed) throw new PdfWriterError('cancelled', 'The browser PDF session is closed.');
      if (document.isEncrypted) {
        return { eligible: false, code: 'encrypted', message: 'This encrypted PDF cannot be annotated safely.' };
      }
      if (
        document.permissions !== -1
        && (document.permissions & PdfPermissionFlag.ModifyAnnotations) === 0
      ) {
        return {
          eligible: false,
          code: 'permission-denied',
          message: 'This PDF does not permit adding annotations.',
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
    } catch {
      return { eligible: false, code: 'invalid-pdf', message: 'This PDF cannot be rewritten safely.' };
    } finally {
      await releaseEngine(engine, document);
    }
  };

  const assess = async (bytes: Uint8Array): Promise<PdfRewriteEligibility> => {
    if (disposed) throw new PdfWriterError('cancelled', 'The browser PDF session is closed.');
    const digest = await sha256(bytes);
    if (cachedAssessment?.digest === digest) return cachedAssessment.eligibility;
    const eligibility = await assessUncached(bytes);
    cachedAssessment = { digest, eligibility };
    return eligibility;
  };

  const inspect = async (bytes: Uint8Array) => {
    if (disposed) throw new PdfWriterError('cancelled', 'The browser PDF session is closed.');
    const engine = openEngine();
    let document: PdfDocumentObject | undefined;
    try {
      document = await engine.openDocumentBuffer({
        id: crypto.randomUUID(),
        content: toArrayBuffer(bytes),
      }).toPromise();
      trackDocument(engine, document);
      const catalog = portableItemsFromAnnotationPages(
        await annotationPages(engine, document),
        { invalidMetadata: 'foreign' },
      );
      return {
        portableItems: catalog.items,
        ownedProjections: catalog.owned.map(({ pageIndex, annotation }) => ({
          pageIndex,
          annotationId: annotation.id,
        })),
      };
    } catch (error) {
      if (error instanceof PdfWriterError) throw error;
      throw new PdfWriterError('invalid-pdf', 'The browser could not inspect this PDF.', { cause: error });
    } finally {
      await releaseEngine(engine, document);
    }
  };

  const write = async (request: PdfWriteRequest): Promise<PdfWriteResult> => {
    if (disposed) throw new PdfWriterError('cancelled', 'The browser PDF session is closed.');
    assertSemanticGeometry(request.annotations);
    const sourceDigest = await sha256(request.sourcePdf);
    if (sourceDigest !== request.sourceSha256) {
      throw new PdfWriterError('source-digest-mismatch', 'The selected PDF changed before export.');
    }
    const eligible = cachedAssessment?.digest === sourceDigest
      ? cachedAssessment.eligibility
      : await assess(request.sourcePdf);
    if (!eligible.eligible) throw new PdfWriterError(eligible.code, eligible.message);

    const engine = openEngine();
    let document: PdfDocumentObject | undefined;
    try {
      document = await engine.openDocumentBuffer({
        id: crypto.randomUUID(),
        content: toArrayBuffer(request.sourcePdf),
      }).toPromise();
      trackDocument(engine, document);
      if (disposed) throw new PdfWriterError('cancelled', 'The browser PDF session is closed.');
      for (const annotation of request.annotations) {
        const page = document.pages[annotation.pageIndex];
        if (page === undefined) {
          throw new PdfWriterError('invalid-pdf', `Annotation ${annotation.id} targets a missing page.`);
        }
        assertAnnotationWithinPage(annotation, page);
      }
      const sourcePageCount = document.pageCount;

      const sourcePages = await annotationPages(engine, document);
      const sourceCatalog = portableItemsFromAnnotationPages(sourcePages, {
        invalidMetadata: 'foreign',
      });
      for (const { pageIndex, annotation } of sourceCatalog.owned) {
        const page = document.pages[pageIndex];
        if (page === undefined || !(await engine.removePageAnnotation(document, page, annotation).toPromise())) {
          throw new PdfWriterError(
            'backend-error',
            `Could not replace owned annotation ${annotation.id} on page ${pageIndex}.`,
          );
        }
      }
      const requestedPortable = inspectProjectedPortableAnnotations(request.annotations);
      if (requestedPortable.status === 'invalid') {
        throw new PdfWriterError(
          'backend-error',
          `The requested portable annotation set is incomplete or inconsistent (${requestedPortable.reason}).`,
        );
      }
      for (const annotation of request.annotations) {
        await engine.createPageAnnotation(
          document,
          document.pages[annotation.pageIndex]!,
          mapReviewAnnotationToEmbedPdf(annotation),
        ).toPromise();
      }
      const output = new Uint8Array(await engine.saveAsCopy(document).toPromise());
      await engine.closeDocument(document).toPromise();
      document = undefined;
      trackDocument(engine, undefined);

      const reopened = await engine.openDocumentBuffer({
        id: crypto.randomUUID(),
        content: toArrayBuffer(output),
      }).toPromise();
      document = reopened;
      trackDocument(engine, document);
      if (disposed) throw new PdfWriterError('cancelled', 'The browser PDF session is closed.');
      if (reopened.pageCount !== sourcePageCount) {
        throw new PdfWriterError('backend-error', 'The exported copy has a different page count.');
      }
      const requestedPages = new Set(request.annotations.map(({ pageIndex }) => pageIndex));
      const reopenedAnnotations = (await Promise.all([...requestedPages].map(async (pageIndex) => {
        const page = reopened.pages[pageIndex];
        if (page === undefined) return [];
        const annotations = await engine.getPageAnnotations(reopened, page).toPromise();
        return annotations.map((annotation) => ({ annotation, pageIndex }));
      }))).flat();
      const requestedIdentities = new Set(request.annotations.map(({ pageIndex, id }) =>
        pdfAnnotationIdentity(pageIndex, id)));
      const created = reopenedAnnotations.filter(({ annotation, pageIndex }) =>
        requestedIdentities.has(pdfAnnotationIdentity(pageIndex, annotation.id)));
      const createdCounts = new Map<string, number>();
      for (const { annotation, pageIndex } of created) {
        const identity = pdfAnnotationIdentity(pageIndex, annotation.id);
        createdCounts.set(identity, (createdCounts.get(identity) ?? 0) + 1);
      }
      if (
        created.length !== request.annotations.length
        || [...requestedIdentities].some((identity) => createdCounts.get(identity) !== 1)
      ) {
        throw new PdfWriterError('backend-error', 'Not every requested annotation reopened after export.');
      }
      if (created.some(({ annotation }) => (
        ((annotation.appearanceModes ?? 0) & NORMAL_APPEARANCE) === 0
      ))) {
        throw new PdfWriterError('backend-error', 'An exported annotation lacks a normal appearance.');
      }
      const reopenedPortable = inspectPortableAnnotations(created.map(({ annotation, pageIndex }) => ({
        custom: annotation.custom,
        visible: visibleEmbedPdfAnnotation(annotation, pageIndex),
      })));
      const requestedItems = requestedPortable.status === 'owned' ? requestedPortable.items : [];
      const reopenedItems = reopenedPortable.status === 'owned' ? reopenedPortable.items : [];
      const canonicalItems = (items: typeof requestedItems) => items
        .map((item) => `${item.id}:${JSON.stringify(item)}`)
        .toSorted();
      if (
        reopenedPortable.status === 'invalid'
        || JSON.stringify(canonicalItems(reopenedItems)) !== JSON.stringify(canonicalItems(requestedItems))
      ) {
        throw new PdfWriterError(
          'backend-error',
          'At least one exported annotation did not reopen with its exact editable identity.',
        );
      }

      const evidence: PdfStructuralEvidence = {
        coverage: 'owned-output',
        backend: 'embedpdf',
        backendVersion: EMBEDPDF_VERSION,
        originalSha256: request.sourceSha256,
        outputSha256: await sha256(output),
        pageCount: reopened.pageCount,
        structurallyValid: true,
        annotations: created.map(({ annotation, pageIndex }) => ({
          id: annotation.id,
          pageIndex,
          subtype: embedPdfSubtypeName(annotation.type),
          contents: annotation.contents ?? '',
          ...(annotation.author === undefined ? {} : { author: annotation.author }),
          flags: annotation.flags ?? [],
          hasNormalAppearance: true,
        })),
      };
      return { pdfBytes: output, evidence };
    } catch (error) {
      if (error instanceof PdfWriterError) throw error;
      throw new PdfWriterError('invalid-pdf', 'The browser could not safely export this PDF.', {
        cause: error,
      });
    } finally {
      await releaseEngine(engine, document);
    }
  };

  return {
    assess,
    inspect,
    write,
    async dispose() {
      if (disposed) return;
      disposed = true;
      cachedAssessment = undefined;
      const engines = [...activeEngines.entries()];
      activeEngines.clear();
      await Promise.all(engines.map(([engine, document]) => closeEngine(engine, document)));
    },
  };
}
