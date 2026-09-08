import type { ReviewItemKind } from './review-model.js';

export type ReviewAnnotationKind = ReviewItemKind;

export type PdfWriterErrorCode =
  | 'backend-error'
  | 'cancelled'
  | 'encrypted'
  | 'invalid-pdf'
  | 'invalid-portable-annotation'
  | 'invalid-annotation-geometry'
  | 'permission-denied'
  | 'resource-limit'
  | 'signature-restricted'
  | 'source-digest-mismatch'
  | 'timeout'
  | 'unreliable-text-geometry';

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ReviewAnnotationBase {
  kind: ReviewAnnotationKind;
  /** Deterministic identity of this page-local physical projection. */
  id: string;
  /** Canonical Review Item identity shared by every page-local projection. */
  reviewItemId?: string;
  projectionIndex?: number;
  projectionCount?: number;
  pageIndex: number;
  rect: PdfRect;
  contents: string;
  author: string;
  createdAt: string;
  modifiedAt: string;
  textAnchorReliable?: boolean;
  custom?: unknown;
  /** Present for a comment-only edit of an existing standard PDF annotation. */
  nativeSubtype?: string;
}

export type ReviewAnnotation = ReviewAnnotationBase & {
  quadPoints?: readonly PdfRect[];
};

export interface PdfWriteRequest {
  sourcePdf: Uint8Array;
  sourceSha256: string;
  revision: number;
  annotations: readonly ReviewAnnotation[];
  /** The request contains the complete editable source-annotation inventory. */
  manageNativeAnnotations?: boolean;
}

export interface PdfWrittenAnnotationEvidence {
  id: string;
  pageIndex?: number;
  subtype: string;
  contents: string;
  author?: string;
  flags: readonly string[];
  hasNormalAppearance: boolean;
}

interface PdfStructuralEvidenceBase {
  backend: 'embedpdf';
  backendVersion: string;
  originalSha256: string;
  outputSha256: string;
  pageCount: number;
  structurallyValid: boolean;
  annotations: readonly PdfWrittenAnnotationEvidence[];
}

export interface PdfOwnedOutputEvidence extends PdfStructuralEvidenceBase {
  /** Browser-bounded verification of only the newly owned output projections. */
  coverage: 'owned-output';
  preexistingAnnotationIds?: never;
}

export interface PdfExhaustivePreservationEvidence extends PdfStructuralEvidenceBase {
  /** Omitted by legacy callers; service verification still treats it as exhaustive. */
  coverage?: 'exhaustive-preservation';
  preexistingAnnotationIds: readonly string[];
}

export type PdfStructuralEvidence =
  | PdfOwnedOutputEvidence
  | PdfExhaustivePreservationEvidence;

export interface PdfWriteResult {
  pdfBytes: Uint8Array;
  evidence: PdfStructuralEvidence;
  inspection?: unknown;
}

export type PdfRewriteEligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly code: "encrypted" | "permission-denied" | "signature-restricted" | "invalid-pdf";
      readonly message: string;
    };

export interface PdfWriter {
  write(request: PdfWriteRequest): Promise<PdfWriteResult>;
  assess?(sourcePdf: Uint8Array): Promise<PdfRewriteEligibility>;
}

export class PdfWriterError extends Error {
  readonly code: PdfWriterErrorCode;
  readonly cause?: unknown;

  constructor(code: PdfWriterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'PdfWriterError';
    this.code = code;
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

export const SEMANTIC_MARKUP_KINDS: ReadonlySet<ReviewAnnotationKind> = new Set([
  'replace',
  'delete',
  'insert',
  'highlight',
]);
