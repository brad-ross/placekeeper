import { documentOrderedItems } from "./annotation-projection.js";
import type { LiveExecutionBaselineV1 } from "./live-context.js";
import type { ReviewItem } from "./review-model.js";
import { assertReviewItem } from "./review-reducer.js";

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

export const LIVE_DISPOSITION_STATUSES = [
  "applied",
  "already-satisfied",
  "adapted",
  "skipped-conflict",
  "skipped-ambiguous",
  "removed-before-processing",
  "not-applied",
] as const;

export type LiveDispositionStatus = (typeof LIVE_DISPOSITION_STATUSES)[number];

export interface LiveDispositionItemV1 {
  readonly itemId: string;
  readonly status: LiveDispositionStatus;
  readonly explanation: string;
  readonly changedPaths?: readonly string[];
}

export interface LaterReviewItemDispositionV1 {
  readonly item: ReviewItem;
  readonly status: "preserved-unprocessed";
  readonly explanation: string;
}

export interface CompleteDispositionV1 {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly baselineDigest: string;
  readonly completedAt: string;
  readonly items: readonly LiveDispositionItemV1[];
  readonly laterItems: readonly LaterReviewItemDispositionV1[];
}

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function assertExplanation(explanation: string): void {
  if (explanation.trim().length === 0) throw new Error("Disposition explanations must not be empty");
}

export function createCompleteDisposition(input: {
  readonly baseline: LiveExecutionBaselineV1;
  readonly completedAt: string;
  readonly items: readonly LiveDispositionItemV1[];
  readonly laterItems: readonly LaterReviewItemDispositionV1[];
}): CompleteDispositionV1 {
  if (!Number.isFinite(Date.parse(input.completedAt))) {
    throw new Error("Disposition completedAt must be a valid timestamp");
  }
  const baselineIds = input.baseline.items.map(({ id }) => id);
  const dispositionIds = input.items.map(({ itemId }) => itemId);
  if (duplicate(dispositionIds)) {
    throw new Error("Every baseline item must be disposed exactly once; duplicate item IDs were provided");
  }
  if (
    baselineIds.length !== dispositionIds.length ||
    baselineIds.some((id) => !dispositionIds.includes(id))
  ) {
    throw new Error("The disposition must account for every baseline item exactly once");
  }
  const byId = new Map(input.items.map((item) => [item.itemId, item]));
  const items = baselineIds.map((itemId) => {
    const item = byId.get(itemId)!;
    assertExplanation(item.explanation);
    if (item.status === "applied" && (item.changedPaths === undefined || item.changedPaths.length === 0)) {
      throw new Error(`Applied baseline item ${itemId} must identify a changed path`);
    }
    return {
      ...item,
      ...(item.changedPaths === undefined ? {} : { changedPaths: [...item.changedPaths].toSorted() }),
    };
  });

  const laterIds = input.laterItems.map(({ item }) => item.id);
  if (duplicate(laterIds)) throw new Error("Later Review Items must have unique stable IDs");
  if (laterIds.some((id) => baselineIds.includes(id))) {
    throw new Error("A baseline Review Item cannot also be reported as a later item");
  }
  for (const later of input.laterItems) {
    assertReviewItem(later.item);
    assertExplanation(later.explanation);
  }
  const laterItems = documentOrderedItems(input.laterItems.map(({ item }) => item)).map((item) => {
    const disposition = input.laterItems.find((candidate) => candidate.item.id === item.id)!;
    return { ...disposition, item };
  });
  return {
    schemaVersion: 1,
    executionId: input.baseline.executionId,
    baselineDigest: input.baseline.baselineDigest,
    completedAt: input.completedAt,
    items,
    laterItems,
  };
}
