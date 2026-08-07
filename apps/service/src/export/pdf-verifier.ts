import { createHash } from "node:crypto";

import type {
  PdfStructuralEvidence,
  ReviewAnnotation,
} from "../../../../packages/core/src/pdf-writer.js";
import {
  inspectPdfWithEmbedPdf,
  type InspectedPdfAnnotation,
} from "../../../../packages/pdf-backends/src/embedpdf-adapter.js";

export interface PdfVerificationInput {
  readonly sourcePdf: Uint8Array;
  readonly candidatePdf: Uint8Array;
  readonly evidence: PdfStructuralEvidence;
  readonly annotations: readonly ReviewAnnotation[];
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
    Math.abs(inspected.origin.x - requested.x) <= 4 &&
    Math.abs(inspected.origin.y - requested.y) <= 4
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
}) => {
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
    inspectPdfWithEmbedPdf(sourcePdf),
    inspectPdfWithEmbedPdf(candidatePdf),
  ]);
  if (source.pageCount !== candidate.pageCount || candidate.pageCount !== evidence.pageCount) {
    fail("The reviewed PDF page inventory differs from the source.");
  }
  if (JSON.stringify(source.pageFingerprints) !== JSON.stringify(candidate.pageFingerprints)) {
    fail("The reviewed PDF page content or geometry differs from the source.");
  }

  const requestedIds = new Set(annotations.map(({ id }) => id));
  if (requestedIds.size !== annotations.length) {
    fail("The frozen review contains duplicate annotation IDs.");
  }
  const sourceIds = new Set(source.annotations.map(({ id }) => id));
  if ([...requestedIds].some((id) => sourceIds.has(id))) {
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
    .filter(({ id }) => !requestedIds.has(id))
    .map((annotation) => stableAnnotation(annotation, persistentIds))
    .sort();
  const sourceInventory = source.annotations
    .map((annotation) => stableAnnotation(annotation, persistentIds))
    .sort();
  if (JSON.stringify(preservedInventory) !== JSON.stringify(sourceInventory)) {
    fail("A pre-existing annotation changed or disappeared from the reviewed PDF.");
  }
  if (candidate.annotations.length !== source.annotations.length + annotations.length) {
    fail("The reviewed PDF annotation inventory contains unexpected entries.");
  }

  const candidateById = new Map<string, InspectedPdfAnnotation[]>();
  for (const annotation of candidate.annotations) {
    const matches = candidateById.get(annotation.id);
    if (matches === undefined) candidateById.set(annotation.id, [annotation]);
    else matches.push(annotation);
  }
  for (const requested of annotations) {
    const matches = candidateById.get(requested.id) ?? [];
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
