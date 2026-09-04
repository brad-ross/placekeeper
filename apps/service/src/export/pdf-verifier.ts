import { createHash } from "node:crypto";

import type {
  PdfStructuralEvidence,
  ReviewAnnotation,
} from "../../../../packages/core/src/pdf-writer.js";
import {
  inspectPortableAnnotations,
  inspectProjectedPortableAnnotations,
} from "../../../../packages/core/src/portable-annotation.js";
import type { ReviewItem } from "../../../../packages/core/src/review-model.js";
import {
  inspectPdfWithEmbedPdf,
  type InspectedPdf,
  type InspectedPdfAnnotation,
} from "../../../../packages/pdf-backends/src/embedpdf-adapter.js";
import { pdfAnnotationIdentity } from "../../../../packages/pdf-backends/src/embedpdf-annotation.js";

export interface PdfVerificationInput {
  readonly sourcePdf: Uint8Array;
  readonly candidatePdf: Uint8Array;
  readonly evidence: PdfStructuralEvidence;
  readonly annotations: readonly ReviewAnnotation[];
  readonly sourceInspection?: InspectedPdf;
  readonly candidateInspection?: InspectedPdf;
}

export interface PdfVerificationReport {
  readonly pageCount: number;
  readonly annotationIds: readonly string[];
}

export type PdfExportVerifier = (
  input: PdfVerificationInput,
) => Promise<PdfVerificationReport>;

export class PdfVerificationError extends Error {
  readonly code = "OUTPUT_VERIFICATION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "PdfVerificationError";
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message: string): never {
  throw new PdfVerificationError(message);
}

function portableInventory(inspection: InspectedPdf): {
  readonly items: readonly ReviewItem[];
  readonly physicalIdentities: ReadonlySet<string>;
} {
  const result = inspectPortableAnnotations(inspection.annotations.map((annotation) => ({
    custom: annotation.custom,
    visible: annotation,
  })));
  if (result.status === "invalid") {
    fail(`The reviewed PDF contains an incomplete portable annotation group (${result.reason}).`);
  }
  if (result.status === "foreign") return { items: [], physicalIdentities: new Set() };
  return {
    items: result.items,
    physicalIdentities: new Set(result.ownedCandidates.map(
      ({ candidateIndex }) => {
        const annotation = inspection.annotations[candidateIndex]!;
        return pdfAnnotationIdentity(annotation.pageIndex, annotation.id);
      },
    )),
  };
}

const annotationIdentity = (
  annotation: { readonly id: string; readonly pageIndex: number },
): string => pdfAnnotationIdentity(annotation.pageIndex, annotation.id);

function stableAnnotation(
  annotation: InspectedPdfAnnotation,
  persistentIds: ReadonlySet<string>,
): string {
  return JSON.stringify({
    id: persistentIds.has(annotation.id) ? annotation.id : null,
    pageIndex: annotation.pageIndex,
    subtype: annotation.subtype,
    contents: annotation.contents,
    author: annotation.author ?? null,
    flags: annotation.flags.toSorted(),
    hasNormalAppearance: annotation.hasNormalAppearance,
    rect: annotation.rect,
    segmentRects: annotation.segmentRects ?? null,
    preservationFingerprint: annotation.preservationFingerprint,
  });
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.01;
}

function sameRect(
  inspected: InspectedPdfAnnotation["rect"],
  requested: ReviewAnnotation["rect"],
): boolean {
  return (
    sameNumber(inspected.origin.x, requested.x) &&
    sameNumber(inspected.origin.y, requested.y) &&
    sameNumber(inspected.size.width, requested.width) &&
    sameNumber(inspected.size.height, requested.height)
  );
}

function sameIconAnchor(
  inspected: InspectedPdfAnnotation["rect"],
  requested: ReviewAnnotation["rect"],
): boolean {
  return (
    Math.abs(inspected.origin.x - requested.x) <= 20.01 &&
    Math.abs(inspected.origin.y - requested.y) <= 20.01
  );
}

function sameSegments(
  inspected: readonly InspectedPdfAnnotation["rect"][] | undefined,
  requested: readonly ReviewAnnotation["rect"][] | undefined,
): boolean {
  if (requested === undefined || requested.length === 0) return true;
  return (
    inspected?.length === requested.length &&
    requested.every((rect, index) => {
      const candidate = inspected[index];
      return candidate !== undefined && sameRect(candidate, rect);
    })
  );
}

const subtypeByKind: Readonly<Record<ReviewAnnotation["kind"], string>> = {
  replace: "strikeOut",
  delete: "strikeOut",
  insert: "text",
  highlight: "highlight",
  pageNote: "text",
};

export const verifyReviewedPdf: PdfExportVerifier = async ({
  sourcePdf,
  candidatePdf,
  evidence,
  annotations,
  sourceInspection,
  candidateInspection,
}) => {
  if (evidence.coverage === "owned-output") {
    fail("Service export requires exhaustive preservation evidence; browser-only evidence is insufficient.");
  }
  const sourceDigest = sha256(sourcePdf);
  const outputDigest = sha256(candidatePdf);
  if (
    !evidence.structurallyValid ||
    evidence.originalSha256 !== sourceDigest ||
    evidence.outputSha256 !== outputDigest
  ) {
    fail("Writer structural evidence does not match the candidate PDF.");
  }

  const [source, candidate] = await Promise.all([
    sourceInspection ?? inspectPdfWithEmbedPdf(sourcePdf),
    candidateInspection ?? inspectPdfWithEmbedPdf(candidatePdf),
  ]);
  const sourcePortable = portableInventory(source);
  const candidatePortable = portableInventory(candidate);
  const candidatePortableItems = candidatePortable.items;
  if (source.pageCount !== candidate.pageCount || candidate.pageCount !== evidence.pageCount) {
    fail("The reviewed PDF page inventory differs from the source.");
  }
  if (JSON.stringify(source.pageFingerprints) !== JSON.stringify(candidate.pageFingerprints)) {
    fail("The reviewed PDF page content or geometry differs from the source.");
  }

  const requestedIdentities = new Set(annotations.map(annotationIdentity));
  if (requestedIdentities.size !== annotations.length) {
    fail("The frozen review contains duplicate page-local annotation identities.");
  }
  const sourceIdentities = new Set(source.annotations.map(annotationIdentity));
  const sourceOwnedIdentities = sourcePortable.physicalIdentities;
  if ([...requestedIdentities].some((identity) =>
    sourceIdentities.has(identity) && !sourceOwnedIdentities.has(identity))) {
    fail("A review annotation ID collides with a pre-existing annotation.");
  }

  // PDFium invents IDs for annotations without /NM. IDs that independently
  // match the writer's source inventory are persistent and remain mandatory;
  // only engine-generated IDs are excluded from cross-engine comparison.
  const writerSourceIds = new Set(evidence.preexistingAnnotationIds);
  const persistentIds = new Set(
    source.annotations
      .filter(({ id }) => writerSourceIds.has(id))
      .map(({ id }) => id),
  );

  const preservedInventory = candidate.annotations
    .filter((annotation) => !requestedIdentities.has(annotationIdentity(annotation)))
    .map((annotation) => stableAnnotation(annotation, persistentIds))
    .sort();
  const sourceInventory = source.annotations
    .filter((annotation) => !sourceOwnedIdentities.has(annotationIdentity(annotation)))
    .map((annotation) => stableAnnotation(annotation, persistentIds))
    .sort();
  if (JSON.stringify(preservedInventory) !== JSON.stringify(sourceInventory)) {
    fail("A pre-existing annotation changed or disappeared from the reviewed PDF.");
  }
  if (candidate.annotations.length !== sourceInventory.length + annotations.length) {
    fail("The reviewed PDF annotation inventory contains unexpected entries.");
  }
  const requestedPortable = inspectProjectedPortableAnnotations(annotations);
  if (requestedPortable.status === "invalid") {
    fail(`The frozen review contains an incomplete portable annotation group (${requestedPortable.reason}).`);
  }
  const portableIds = candidatePortableItems.map(({ id }) => id).sort();
  const requestedPortableIds = requestedPortable.status === "owned"
    ? requestedPortable.items.map(({ id }) => id).sort()
    : [];
  if (JSON.stringify(portableIds) !== JSON.stringify(requestedPortableIds)) {
    fail("The reviewed PDF portable annotation inventory is incomplete.");
  }
  const candidatePortableById = new Map(
    candidatePortableItems.map((item) => [item.id, JSON.stringify(item)]),
  );
  if (
    requestedPortable.status === "owned" &&
    requestedPortable.items.some((item) => {
      const reopened = candidatePortableById.get(item.id);
      return reopened === undefined || reopened !== JSON.stringify(item);
    })
  ) {
    fail("The reviewed PDF portable annotation payload differs from the frozen review.");
  }

  const candidateByIdentity = new Map<string, InspectedPdfAnnotation[]>();
  for (const annotation of candidate.annotations) {
    const identity = annotationIdentity(annotation);
    const matches = candidateByIdentity.get(identity);
    if (matches === undefined) candidateByIdentity.set(identity, [annotation]);
    else matches.push(annotation);
  }
  for (const requested of annotations) {
    const matches = candidateByIdentity.get(annotationIdentity(requested)) ?? [];
    const written = matches[0];
    if (
      matches.length !== 1 ||
      written === undefined ||
      written.pageIndex !== requested.pageIndex ||
      written.subtype !== subtypeByKind[requested.kind] ||
      written.contents !== requested.contents ||
      written.author !== requested.author ||
      !written.flags.includes("print") ||
      !written.hasNormalAppearance ||
      !(requested.kind === "insert" || requested.kind === "pageNote"
        ? sameIconAnchor(written.rect, requested.rect)
        : sameRect(written.rect, requested.rect)) ||
      !sameSegments(written.segmentRects, requested.quadPoints)
    ) {
      fail(`Review annotation ${requested.id} failed structural verification.`);
    }
  }

  const evidenceIds = evidence.annotations.map(({ id }) => id).sort();
  const annotationIds = annotations.map(({ id }) => id).sort();
  if (JSON.stringify(evidenceIds) !== JSON.stringify(annotationIds)) {
    fail("Writer evidence does not account for the frozen annotation set.");
  }

  return { pageCount: candidate.pageCount, annotationIds };
};
