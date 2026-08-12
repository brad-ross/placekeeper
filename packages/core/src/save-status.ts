export type SaveFailureReason =
  | "destination-unconfigured"
  | "missing"
  | "invalid-annotation-geometry"
  | "target-changed"
  | "permission-denied"
  | "verification-failed"
  | "write-failed";

export type SaveDestination =
  | { readonly phase: "none"; readonly generation: 0 }
  | { readonly phase: "establishing"; readonly generation: number }
  | {
      readonly phase: "active";
      readonly generation: number;
      readonly kind: "original" | "copy";
      readonly targetPath: string;
      readonly capabilityId?: string;
      readonly fingerprint?: string;
    };

export interface SaveSync {
  readonly phase: "clean" | "saving" | "not-saved";
  readonly desiredRevision: number;
  readonly desiredDigest: string;
  readonly savedRevision: number;
  readonly savedDigest?: string;
  readonly failure?: SaveFailureReason;
}

export interface SaveStatus {
  readonly destination: SaveDestination;
  readonly rewriteEligibility?: import("./pdf-writer.js").PdfRewriteEligibility;
  readonly sync: Pick<
    SaveSync,
    "phase" | "desiredRevision" | "savedRevision" | "failure"
  >;
}
