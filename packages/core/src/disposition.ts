export const DISPOSITION_STATUSES = [
  "Applied",
  "Already satisfied",
  "Ambiguous",
  "Not applied",
] as const;

export type DispositionStatus = (typeof DISPOSITION_STATUSES)[number];

export interface DispositionItemV1 {
  readonly id: string;
  readonly status: DispositionStatus;
  readonly explanation: string;
  readonly changedPaths?: readonly string[];
}

export interface DispositionV1 {
  readonly schemaVersion: "1.0";
  readonly reviewId: string;
  readonly handoffSha256: string;
  readonly reviewedPdfSha256: string;
  readonly build:
    | { readonly status: "succeeded"; readonly outputSha256: string; readonly logSha256?: string }
    | { readonly status: "failed"; readonly logSha256?: string };
  readonly changedPaths: readonly string[];
  readonly revisedPdf?: { readonly path: string; readonly sha256: string };
  readonly items: readonly DispositionItemV1[];
}
