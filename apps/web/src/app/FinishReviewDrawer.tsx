import { useState, type ReactNode } from "react";

import type { ReviewState } from "../../../../packages/core/src/review-model.js";

export interface FinishReviewDrawerProps {
  readonly state: Pick<ReviewState, "items" | "revision">;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onFinish: () => void | Promise<void>;
  readonly onDiscard: () => void | Promise<void>;
  readonly children: ReactNode;
}

export function FinishReviewDrawer({
  state,
  open,
  onClose,
  onFinish,
  onDiscard,
  children,
}: FinishReviewDrawerProps) {
  const [busyAction, setBusyAction] = useState<"finish" | "discard" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const itemLabel = `${state.items.length} review ${state.items.length === 1 ? "item" : "items"}`;

  const runLifecycle = async (
    action: "finish" | "discard",
    operation: () => void | Promise<void>,
  ) => {
    if (busyAction !== null) return;
    setBusyAction(action);
    setMessage(null);
    setError(null);
    try {
      await operation();
      setMessage(action === "finish" ? "Review finished." : "Review discarded.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The review could not be closed safely.");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <aside
      id="review-finish-drawer"
      className="review-finish-drawer"
      data-review-finish-slot
      data-surface-open={open ? "true" : "false"}
      aria-labelledby="finish-review-heading"
      aria-hidden={!open}
      inert={!open}
    >
      <header className="finish-review-drawer__header">
        <div>
          <p className="finish-review-drawer__eyebrow">Review summary</p>
          <h2 id="finish-review-heading">Finish review</h2>
        </div>
        <button type="button" className="finish-review-drawer__close" aria-label="Close finish options" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <p className="finish-review-drawer__summary">
        <strong>{itemLabel}</strong><span aria-hidden="true"> · </span><span>Revision {state.revision}</span>
      </p>
      <p className="finish-review-drawer__guidance">
        The PDF stays open while you save a reviewed copy or prepare a Codex handoff.
      </p>
      <div className="finish-review-drawer__delivery-options">{children}</div>
      <section className="finish-review-drawer__lifecycle" aria-labelledby="review-lifecycle-heading">
        <h3 id="review-lifecycle-heading">Close the review</h3>
        <p>Finish after delivering what you need. Discard closes the review without delivering its feedback.</p>
        <div className="finish-review-drawer__lifecycle-actions">
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => void runLifecycle("finish", onFinish)}
          >
            {busyAction === "finish" ? "Finishing…" : "Finish review"}
          </button>
          <button
            type="button"
            className="finish-review-drawer__discard"
            disabled={busyAction !== null}
            onClick={() => void runLifecycle("discard", onDiscard)}
          >
            {busyAction === "discard" ? "Discarding…" : "Discard review"}
          </button>
        </div>
        {message ? <p role="status">{message}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </section>
    </aside>
  );
}
