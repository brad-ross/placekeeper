import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFStream, PDFString } from 'pdf-lib';
import { READER_APPEARANCE_KEY } from '../../core/src/annotation-appearance.js';
import { type PdfAnnotationObject } from '@embedpdf/models';
import { canEditPdfAnnotationComment, canDeletePdfAnnotation, isEditablePdfAnnotationSubtype, nativePdfAnnotationIdentity, VERIFIED_NATIVE_PDF_ANNOTATION_NAME_PREFIX } from '../../core/src/native-pdf-annotation.js';
import { PdfWriterError, type ReviewAnnotation, type PdfWriteRequest, type PdfWriteResult, type PdfRewriteEligibility, type PdfWrittenAnnotationEvidence } from '../../core/src/pdf-writer.js';
import { embedPdfSubtypeName } from './embedpdf-annotation.js';
import type { ReviewItem } from '../../core/src/review-model.js';
import { assertReviewItem } from '../../core/src/review-reducer.js';
import { projectReviewItems } from '../../core/src/annotation-projection.js';

export interface NativePdfAnnotation {
  readonly item: ReviewItem;
  readonly pageIndex: number;
  readonly annotationIndex: number;
  readonly annotationId: string;
}

export interface NativePdfSnapshot {
  readonly portableItems?: readonly ReviewItem[];
  readonly nativeAnnotations: readonly NativePdfAnnotation[];
  readonly annotations: readonly (PdfWrittenAnnotationEvidence & { readonly pageIndex: number })[];
}

interface PortableCommentEdit {
  readonly pageIndex: number;
  readonly annotationIndex: number;
  readonly requested: ReviewAnnotation;
}

function portableCommentEdits(source: NativePdfSnapshot, requested: readonly ReviewAnnotation[]): PortableCommentEdit[] {
  const projections = projectReviewItems((source.portableItems ?? []).filter(({ kind }) => kind !== 'pdfAnnotation'));
  const geometry = (annotation: ReviewAnnotation) => JSON.stringify({ kind: annotation.kind,
    pageIndex: annotation.pageIndex, rect: annotation.rect, quads: annotation.quadPoints, author: annotation.author });
  return projections.flatMap((before) => {
    const after = requested.find(({ pageIndex, id }) => pageIndex === before.pageIndex && id === before.id);
    if (!after?.custom || geometry(before) !== geometry(after) || JSON.stringify(before.custom) === JSON.stringify(after.custom)) return [];
    const annotationIndex = source.annotations.filter(({ pageIndex }) => pageIndex === before.pageIndex)
      .findIndex(({ id }) => id === before.id);
    return annotationIndex < 0 ? [] : [{ pageIndex: before.pageIndex, annotationIndex, requested: after }];
  });
}

function popupRemovals(pdf: PDFDocument, source: readonly NativePdfAnnotation[], retainedIds: ReadonlySet<string>): { pageIndex: number; annotationIndex: number }[] {
  if (!source.some(({ item }) => !retainedIds.has(item.id))) return [];
  const removed = new Set(source.filter(({ item }) => !retainedIds.has(item.id)).map(({ pageIndex, annotationIndex }) =>
    pdf.getPage(pageIndex).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.get(annotationIndex).toString()));
  return pdf.getPages().flatMap((page, pageIndex) => {
    const annotations = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annotations) return [];
    return Array.from({ length: annotations.size() }, (_, annotationIndex) => {
      const dictionary = annotations.lookupMaybe(annotationIndex, PDFDict);
      const parent = dictionary?.get(PDFName.of('Parent'))?.toString();
      return parent !== undefined && dictionary?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() === 'Popup' && removed.has(parent)
        ? [{ pageIndex, annotationIndex }] : [];
    }).flat();
  });
}

export async function deletedNativePdfPopups(bytes: Uint8Array, source: readonly NativePdfAnnotation[], retainedIds: ReadonlySet<string>) {
  if (!source.some(({ item }) => !retainedIds.has(item.id))) return [];
  return popupRemovals(await PDFDocument.load(bytes, { updateMetadata: false }), source, retainedIds);
}

/** Shared by the service and the browser so import/export semantics cannot drift. */
export async function writeWithNativePdfAnnotations(
  request: PdfWriteRequest,
  backend: {
    readonly inspect: (bytes: Uint8Array) => Promise<NativePdfSnapshot>;
    readonly write: (request: PdfWriteRequest) => Promise<PdfWriteResult>;
    readonly assess: (bytes: Uint8Array) => Promise<PdfRewriteEligibility>;
    readonly sha256: (bytes: Uint8Array) => string | Promise<string>;
  },
): Promise<PdfWriteResult> {
  const nativeRequests = request.annotations.filter(({ kind }) => kind === 'pdfAnnotation');
  const manageNative = request.manageNativeAnnotations || nativeRequests.length > 0;
  if (!manageNative && !request.annotations.some(({ custom }) => custom !== undefined)) return backend.write(request);
  if (await backend.sha256(request.sourcePdf) !== request.sourceSha256) {
    throw new PdfWriterError('source-digest-mismatch', 'The source PDF changed before export.');
  }
  const eligibility = await backend.assess(request.sourcePdf);
  if (!eligibility.eligible) throw new PdfWriterError(eligibility.code, eligibility.message);
  const source = await backend.inspect(request.sourcePdf);
  const ordinalRequestsByPage = new Map<number, Map<number, ReviewAnnotation>>();
  for (const annotation of nativeRequests) {
    if (annotation.nativeIdentityProvenance !== 'generation-ordinal' || annotation.nativeSourceObject === undefined) continue;
    let requestsByIndex = ordinalRequestsByPage.get(annotation.nativeSourceObject.pageIndex);
    if (requestsByIndex === undefined) {
      requestsByIndex = new Map();
      ordinalRequestsByPage.set(annotation.nativeSourceObject.pageIndex, requestsByIndex);
    }
    if (!requestsByIndex.has(annotation.nativeSourceObject.annotationIndex)) {
      requestsByIndex.set(annotation.nativeSourceObject.annotationIndex, annotation);
    }
  }
  const mappedNativeAnnotations = source.nativeAnnotations.map((entry) => {
    if (entry.item.payload.identityProvenance === 'verified') return entry;
    const requested = ordinalRequestsByPage.get(entry.pageIndex)?.get(entry.annotationIndex);
    return requested === undefined ? entry : { ...entry, item: { ...entry.item, id: requested.id } };
  });
  const prepared = await prepareNativePdfAnnotations(request.sourcePdf, manageNative ? mappedNativeAnnotations : [], nativeRequests,
    portableCommentEdits(source, request.annotations));
  const written = await backend.write({
    ...request, sourcePdf: prepared.pdfBytes, sourceSha256: await backend.sha256(prepared.pdfBytes),
    annotations: request.annotations.filter(({ kind }) => kind !== 'pdfAnnotation'),
    manageNativeAnnotations: false,
  });
  if (!manageNative) return { ...written, evidence: { ...written.evidence, originalSha256: request.sourceSha256 } };
  const pdfBytes = await removeGeneratedNativeAppearances(written.pdfBytes, prepared.appearanceLessNames);
  const inspectedCandidate = await backend.inspect(pdfBytes);
  const newAnnotationIds = new Set(request.annotations.filter(({ kind }) => kind !== 'pdfAnnotation').map(({ pageIndex, id }) => `${pageIndex}:${id}`));
  const candidate = { ...inspectedCandidate,
    nativeAnnotations: inspectedCandidate.nativeAnnotations.filter(({ pageIndex, annotationId }) => !newAnnotationIds.has(`${pageIndex}:${annotationId}`)),
  };
  if (candidate.nativeAnnotations.length !== nativeRequests.length) {
    throw new PdfWriterError('backend-error', 'The exported PDF has a different imported annotation inventory.');
  }
  const evidence = nativeRequests.map((requested) => {
    const reopened = candidate.nativeAnnotations.find(({ item }) => item.id === requested.id);
    const annotation = reopened && candidate.annotations.find(({ id, pageIndex }) =>
      id === reopened.annotationId && pageIndex === reopened.pageIndex);
    const position = reopened?.item.payload.position as Record<string, number> | undefined;
    if (!annotation || !reopened || reopened.item.payload.comment !== requested.contents ||
      reopened.item.payload.author !== requested.author || reopened.item.payload.subtype !== requested.nativeSubtype ||
      reopened.pageIndex !== requested.pageIndex || !position ||
      ['x', 'y', 'width', 'height'].some((key) => Math.abs(position[key]! - requested.rect[key as keyof typeof requested.rect]) > 0.01)) {
      throw new PdfWriterError('backend-error', 'An imported annotation did not reopen with the requested comment and original geometry.');
    }
    return { ...annotation, id: requested.id };
  });
  const managedNames = new Set(nativeRequests.map(({ id }) => `${VERIFIED_NATIVE_PDF_ANNOTATION_NAME_PREFIX}${id}`));
  const common = { originalSha256: request.sourceSha256, outputSha256: await backend.sha256(pdfBytes), annotations: [...written.evidence.annotations, ...evidence] };
  return {
    ...written, pdfBytes,
    // The cached inspection belongs to the earlier bytes; the service rechecks the final PDF.
    ...(pdfBytes === written.pdfBytes ? {} : { inspection: undefined }),
    evidence: written.evidence.coverage === 'owned-output'
      ? { ...written.evidence, ...common }
      : { ...written.evidence, ...common,
          preexistingAnnotationIds: written.evidence.preexistingAnnotationIds.filter((id) => !managedNames.has(id)) },
  };
}

function timestamp(date: Date | undefined): string {
  return date instanceof Date && Number.isFinite(date.getTime())
    ? date.toISOString() : '1970-01-01T00:00:00.000Z';
}

export function nativeAnnotationsFromPages(
  pages: readonly (readonly PdfAnnotationObject[])[],
  owned: readonly { readonly pageIndex: number; readonly annotation: PdfAnnotationObject }[],
): NativePdfAnnotation[] {
  const ownedObjects = new Set(owned.map(({ annotation }) => annotation));
  const result: NativePdfAnnotation[] = [];
  const seenIds = new Set<string>();
  pages.forEach((annotations, pageIndex) => annotations.forEach((annotation, annotationIndex) => {
    const subtype = embedPdfSubtypeName(annotation.type);
    if (ownedObjects.has(annotation) || !isEditablePdfAnnotationSubtype(subtype)) return;
    const identity = nativePdfAnnotationIdentity(pageIndex, annotationIndex, annotation.id);
    const id = identity.id;
    // Ambiguous persistent identity cannot authorize an edit or deletion.
    if (seenIds.has(id)) {
      const previous = result.findIndex(({ item }) => item.id === id);
      if (previous >= 0) result.splice(previous, 1);
      return;
    }
    seenIds.add(id);
    const item: ReviewItem = {
      id, kind: 'pdfAnnotation', pageIndex,
      createdAt: timestamp(annotation.created),
      updatedAt: timestamp(annotation.modified ?? annotation.created),
      payload: {
        position: { x: annotation.rect.origin.x, y: annotation.rect.origin.y,
          width: annotation.rect.size.width, height: annotation.rect.size.height },
        comment: annotation.contents ?? '', author: annotation.author ?? '', subtype,
        identityProvenance: identity.provenance,
        sourceObjectPageIndex: pageIndex,
        sourceObjectAnnotationIndex: annotationIndex,
        ...(annotation.flags?.some((flag) => flag === 'readOnly' || flag === 'lockedContents') ? { contentsLocked: true } : {}),
        ...(annotation.flags?.some((flag) => flag === 'readOnly' || flag === 'locked') ? { deletionLocked: true } : {}),
      },
    };
    try { assertReviewItem(item); } catch { return; }
    result.push({ item, pageIndex, annotationIndex, annotationId: annotation.id });
  }));
  return result;
}

/**
 * Edit the original dictionaries. The drawing, /AP, color, opacity, quads,
 * attachments, author, and reply relationships are never reconstructed.
 */
async function prepareNativePdfAnnotations(
  bytes: Uint8Array,
  source: readonly NativePdfAnnotation[],
  requested: readonly ReviewAnnotation[],
  ownedEdits: readonly PortableCommentEdit[] = [],
): Promise<{ pdfBytes: Uint8Array; appearanceLessNames: Map<number, Set<string>> }> {
  const appearanceLessNames = new Map<number, Set<string>>();
  const sourceIds = new Set(source.map(({ item }) => item.id));
  const requestedById = new Map(requested.map((annotation) => [annotation.id, annotation]));
  if (requestedById.size !== requested.length || requested.some((annotation) =>
    annotation.kind !== 'pdfAnnotation' || !sourceIds.has(annotation.id))) {
    throw new PdfWriterError('invalid-portable-annotation', 'An imported annotation no longer matches the source PDF.');
  }
  if (source.length === 0 && ownedEdits.length === 0) return { pdfBytes: bytes, appearanceLessNames };
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const { pageIndex, annotationIndex, requested: annotation } of ownedEdits) {
    const dictionary = pdf.getPage(pageIndex).node.lookup(PDFName.of('Annots'), PDFArray).lookup(annotationIndex, PDFDict);
    const appearance = dictionary.lookupMaybe(PDFName.of('AP'), PDFDict)?.lookup(PDFName.of('N'));
    const contents = dictionary.lookup(PDFName.of('Contents'));
    if ((annotation.kind === 'highlight' || annotation.kind === 'replace') &&
      appearance instanceof PDFStream && appearance.dict.lookupMaybe(PDFName.of(READER_APPEARANCE_KEY), PDFNumber)?.asNumber() === 1 &&
      (contents instanceof PDFString || contents instanceof PDFHexString) &&
      (contents.decodeText().trim().length > 0) !== (annotation.contents.trim().length > 0)) {
      // Our wash/underline depends on attached text. Leave the old metadata for
      // the writer to detect a changed item and regenerate this owned mark.
      continue;
    }
    dictionary.set(PDFName.of('Contents'), PDFHexString.fromText(annotation.contents));
    dictionary.set(PDFName.of('M'), PDFString.fromDate(new Date(annotation.modifiedAt)));
    dictionary.delete(PDFName.of('RC'));
    const custom = dictionary.lookup(PDFName.of('EPDFCustom'));
    let preserved: Record<string, unknown> = {};
    if (custom instanceof PDFString || custom instanceof PDFHexString) {
      try {
        const value = JSON.parse(custom.decodeText());
        if (value && typeof value === 'object' && !Array.isArray(value)) preserved = value;
      } catch { /* Valid portable metadata is regenerated below. */ }
    }
    dictionary.set(PDFName.of('EPDFCustom'), PDFHexString.fromText(JSON.stringify({
      ...preserved, ...(annotation.custom as Record<string, unknown>),
    })));
  }
  const removals = new Map<number, Set<number>>();
  const removedReferences = new Set<string>();
  for (const { pageIndex, annotationIndex } of popupRemovals(pdf, source, new Set(requestedById.keys()))) {
    const indices = removals.get(pageIndex) ?? new Set<number>();
    indices.add(annotationIndex);
    removals.set(pageIndex, indices);
  }
  for (const entry of source) {
    const page = pdf.getPage(entry.pageIndex);
    const annotations = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const dictionary = annotations?.lookupMaybe(entry.annotationIndex, PDFDict);
    if (!annotations || !dictionary) throw new PdfWriterError('invalid-pdf', 'An imported annotation is missing.');
    const rawSubtype = dictionary.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
    if (rawSubtype?.toLowerCase() !== String(entry.item.payload.subtype).toLowerCase()) {
      throw new PdfWriterError('invalid-pdf', 'The PDF annotation inventory changed before saving.');
    }
    const requestedAnnotation = requestedById.get(entry.item.id);
    if (!requestedAnnotation) {
      if (!canDeletePdfAnnotation(entry.item)) throw new PdfWriterError('permission-denied', 'This PDF annotation is locked against deletion.');
      const indices = removals.get(entry.pageIndex) ?? new Set<number>();
      indices.add(entry.annotationIndex);
      removals.set(entry.pageIndex, indices);
      removedReferences.add(annotations.get(entry.annotationIndex).toString());
      continue;
    }
    const position = entry.item.payload.position as Record<string, number>;
    if (requestedAnnotation.pageIndex !== entry.pageIndex ||
      requestedAnnotation.nativeSubtype !== entry.item.payload.subtype ||
      requestedAnnotation.author !== entry.item.payload.author ||
      ['x', 'y', 'width', 'height'].some((key) =>
        requestedAnnotation.rect[key as keyof typeof requestedAnnotation.rect] !== position[key])) {
      throw new PdfWriterError('invalid-annotation-geometry', 'Imported annotations support comment edits and deletion only.');
    }
    if (!dictionary.has(PDFName.of('AP'))) {
      const names = appearanceLessNames.get(entry.pageIndex) ?? new Set<string>();
      names.add(`${VERIFIED_NATIVE_PDF_ANNOTATION_NAME_PREFIX}${entry.item.id}`);
      appearanceLessNames.set(entry.pageIndex, names);
    }
    // A standard /NM supplies stable identity even if another reader strips private data.
    dictionary.set(PDFName.of('NM'), PDFString.of(`${VERIFIED_NATIVE_PDF_ANNOTATION_NAME_PREFIX}${entry.item.id}`));
    if (requestedAnnotation.contents !== entry.item.payload.comment) {
      if (!canEditPdfAnnotationComment(entry.item)) throw new PdfWriterError('permission-denied', 'This PDF annotation comment is locked.');
      dictionary.set(PDFName.of('Contents'), PDFHexString.fromText(requestedAnnotation.contents));
      dictionary.set(PDFName.of('M'), PDFString.fromDate(new Date(requestedAnnotation.modifiedAt)));
      // Rich-text comments must not keep displaying the previous plain-text value.
      dictionary.delete(PDFName.of('RC'));
    }
    // External edits make old Placekeeper projections stale. Retain other custom data.
    // Provenance lives in the versioned /NM namespace. Leave unrelated or
    // malformed application-owned EPDFCustom bytes untouched.
  }
  // Replies to a deleted parent become standalone comments; their content and appearance survive.
  if (removals.size > 0) pdf.getPages().forEach((page, pageIndex) => {
    const annotations = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annotations) return;
    const indices = removals.get(pageIndex) ?? new Set<number>();
    for (let index = 0; index < annotations.size(); index++) {
      const dictionary = annotations.lookupMaybe(index, PDFDict);
      if (dictionary && removedReferences.has(dictionary.get(PDFName.of('IRT'))?.toString() ?? '')) {
        dictionary.delete(PDFName.of('IRT'));
        dictionary.delete(PDFName.of('RT'));
      }
    }
    [...indices].sort((a, b) => b - a).forEach((index) => annotations.remove(index));
  });
  return { pdfBytes: await pdf.save({ useObjectStreams: false, addDefaultPage: false }), appearanceLessNames };
}


export async function rewriteNativePdfAnnotations(
  bytes: Uint8Array,
  source: readonly NativePdfAnnotation[],
  requested: readonly ReviewAnnotation[],
  ownedEdits: readonly PortableCommentEdit[] = [],
): Promise<Uint8Array> {
  return (await prepareNativePdfAnnotations(bytes, source, requested, ownedEdits)).pdfBytes;
}

/** PDFium synthesizes AP on save; absence in the source must remain absence on reopen. */
async function removeGeneratedNativeAppearances(bytes: Uint8Array, namesByPage: ReadonlyMap<number, ReadonlySet<string>>): Promise<Uint8Array> {
  if (namesByPage.size === 0) return bytes;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  let changed = false;
  for (const [pageIndex, names] of namesByPage) {
    const annotations = pdf.getPage(pageIndex).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annotations) continue;
    for (let index = 0; index < annotations.size(); index++) {
      const annotation = annotations.lookupMaybe(index, PDFDict);
      const name = annotation?.lookup(PDFName.of('NM'));
      if (annotation && (name instanceof PDFString || name instanceof PDFHexString) && names.has(name.decodeText()) && annotation.has(PDFName.of('AP'))) {
        annotation.delete(PDFName.of('AP'));
        changed = true;
      }
    }
  }
  return changed ? pdf.save({ useObjectStreams: false, addDefaultPage: false }) : bytes;
}
