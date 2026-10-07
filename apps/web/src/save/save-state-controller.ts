import type { SaveStatus } from "../../../../packages/core/src/save-status.js";
import type { ReviewCommand, ReviewState } from "../../../../packages/core/src/review-model.js";

export type SaveGatedCommand =
  | { readonly kind: "submit"; readonly command: ReviewCommand }
  | { readonly kind: "submit-and-choose-destination"; readonly command: ReviewCommand }
  | { readonly kind: "choose-destination"; readonly pending: ReviewCommand };

export function gateReviewCommand(
  state: Pick<ReviewState, "workflow">,
  status: SaveStatus,
  command: ReviewCommand,
  sourceDisposition: "local" | "remote-temporary" | "ephemeral" = "local",
): SaveGatedCommand {
  if (state.workflow.mode === "generated-output" || sourceDisposition === "ephemeral") {
    return { kind: "submit", command };
  }
  if (status.destination.phase !== "none") return { kind: "submit", command };
  return sourceDisposition === "remote-temporary"
    ? { kind: "submit-and-choose-destination", command }
    : { kind: "choose-destination", pending: command };
}

/** Save completion can advance without a review revision. Only adopt it for
 * the current document, and never replace newer locally observed progress. */
export function canonicalSaveStatusCanApply(
  currentState: ReviewState,
  canonicalState: ReviewState,
  currentStatus: SaveStatus,
  canonicalStatus: SaveStatus,
): boolean {
  return canonicalState.sessionId === currentState.sessionId
    && canonicalState.workflow.documentGeneration === currentState.workflow.documentGeneration
    && canonicalState.source.fileId === currentState.source.fileId
    && canonicalState.source.digest === currentState.source.digest
    && canonicalState.revision >= currentState.revision
    && canonicalStatus.destination.generation >= currentStatus.destination.generation
    && canonicalStatus.sync.desiredRevision >= currentStatus.sync.desiredRevision
    && canonicalStatus.sync.savedRevision >= currentStatus.sync.savedRevision;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export async function pollSaveStatusUntilSettled(
  fetchStatus: () => Promise<SaveStatus>,
  publish: (status: SaveStatus) => void,
  signal: AbortSignal,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void> = delay,
): Promise<void> {
  while (!signal.aborted) {
    await wait(350, signal);
    if (signal.aborted) return;
    try {
      const next = await fetchStatus();
      if (signal.aborted) return;
      publish(next);
      if (next.sync.phase !== "saving") return;
    } catch {
      // A transient local request failure must not strand the visible state at Saving.
    }
  }
}
