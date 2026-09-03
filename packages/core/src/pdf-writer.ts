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
}

export type ReviewAnnotation = ReviewAnnotationBase & {
  quadPoints?: readonly PdfRect[];
};

export interface PdfWriteRequest {
  sourcePdf: Uint8Array;
  sourceSha256: string;
  revision: number;
  annotations: readonly ReviewAnnotation[];
}

export interface PdfWrittenAnnotationEvidence {
  id: string;
  subtype: string;
  contents: string;
  author?: string;
  flags: readonly string[];
  hasNormalAppearance: boolean;
}

export interface PdfStructuralEvidence {
  backend: 'embedpdf';
  backendVersion: string;
  originalSha256: string;
  outputSha256: string;
  pageCount: number;
  structurallyValid: boolean;
  preexistingAnnotationIds: readonly string[];
  annotations: readonly PdfWrittenAnnotationEvidence[];
}

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
