import type { ReviewCommand, ReviewState } from "../../../../packages/core/src/review-model.js";
import type { ProductionSaveStatus } from "../app/ProductionReviewApp.js";

export type SaveGatedCommand =
  | { readonly kind: "submit"; readonly command: ReviewCommand }
  | { readonly kind: "submit-and-choose-destination"; readonly command: ReviewCommand }
  | { readonly kind: "choose-destination"; readonly pending: ReviewCommand };

export function gateReviewCommand(
  state: ReviewState,
  status: ProductionSaveStatus,
  command: ReviewCommand,
  sourceDisposition: "local" | "remote-temporary",
): SaveGatedCommand {
  void state;
  if (status.destination.phase !== "none") return { kind: "submit", command };
  return sourceDisposition === "remote-temporary"
    ? { kind: "submit-and-choose-destination", command }
    : { kind: "choose-destination", pending: command };
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
  fetchStatus: () => Promise<ProductionSaveStatus>,
  publish: (status: ProductionSaveStatus) => void,
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
