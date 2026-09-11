import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { startReviewGeneration, type ReviewState } from "../../../../packages/core/src/review-model.js";
import { reconcilePdfAnchorState, type PdfAnchorPage } from "../reconciliation/pdf-anchor-reconciler.js";
import type { StagedGenerationSnapshot } from "../recovery/source-snapshot.js";
import type { SessionBrokerOptions } from "./session-contracts.js";

export async function inspectReplacementCandidate(
  staged: StagedGenerationSnapshot,
  inspectGeneration: NonNullable<SessionBrokerOptions["inspectGeneration"]>,
) {
  const candidateBytes = await readFile(staged.path);
  if (
    candidateBytes.byteLength !== staged.byteLength ||
    createHash("sha256").update(candidateBytes).digest("hex") !== staged.digest
  ) throw new Error("The private generation snapshot failed digest validation");
  const inspected = await inspectGeneration(candidateBytes);
  if (
    !Number.isSafeInteger(inspected.pageCount) || inspected.pageCount <= 0 ||
    inspected.pages.some(({ pageIndex }) =>
      !Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= inspected.pageCount
    )
  ) throw new Error("The private generation snapshot failed structural PDF validation");
  return inspected;
}

// This stays synchronous inside the broker's fenced tail: no new scheduling
// boundary may separate the currentness checks from state preparation.
export function prepareReplacementReview(
  state: ReviewState,
  successorGeneration: number,
  fileId: string,
  source: { readonly digest: string; readonly byteLength: number },
  pages: readonly PdfAnchorPage[],
): ReviewState {
  let nextState = startReviewGeneration(state, {
    documentGeneration: successorGeneration,
  });
  nextState = reconcilePdfAnchorState(nextState, {
    generation: successorGeneration,
    pages,
  });
  nextState = {
    ...nextState,
    source: {
      fileId,
      digest: source.digest,
      byteLength: source.byteLength,
    },
    workflow: { ...nextState.workflow, freshness: "current" },
  };
  return nextState;
}
