import { useState, type ReactNode } from "react";

import type { ReviewState } from "../../../../packages/core/src/review-model.js";
import { ReviewIcon } from "../review/ReviewIcon.js";

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
  const lifecycleState = error ? "error" : message ? "success" : busyAction ? "busy" : "idle";

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
          <ReviewIcon name="close" />
        </button>
      </header>
      <p className="finish-review-drawer__summary">
        <strong>{itemLabel}</strong><span aria-hidden="true"> · </span><span>Revision {state.revision}</span>
      </p>
      <p className="finish-review-drawer__guidance">
        The PDF stays open while you save a reviewed copy or prepare a Codex handoff.
      </p>
      <div className="finish-review-drawer__delivery-options">{children}</div>
      <section
        className="finish-review-drawer__lifecycle"
        data-lifecycle-state={lifecycleState}
        aria-labelledby="review-lifecycle-heading"
      >
        <h3 id="review-lifecycle-heading">Close the review</h3>
        <p>Finish after delivering what you need. Discard closes the review without delivering its feedback.</p>
        <div className="finish-review-drawer__lifecycle-actions">
          <button
            className="review-button review-button--primary"
            type="button"
            disabled={busyAction !== null}
            onClick={() => void runLifecycle("finish", onFinish)}
          >
            <ReviewIcon name={busyAction === "finish" ? "loading" : "check"} />
            <span>{busyAction === "finish" ? "Finishing…" : "Finish review"}</span>
          </button>
          <button
            type="button"
            className="review-button review-button--destructive finish-review-drawer__discard"
            disabled={busyAction !== null}
            onClick={() => void runLifecycle("discard", onDiscard)}
          >
            <ReviewIcon name={busyAction === "discard" ? "loading" : "delete"} />
            <span>{busyAction === "discard" ? "Discarding…" : "Discard review"}</span>
          </button>
        </div>
        {message ? (
          <p className="review-status review-status--success" data-review-status="success" role="status">
            <ReviewIcon name="check" /><span>{message}</span>
          </p>
        ) : null}
        {error ? (
          <p className="review-status review-status--error" data-review-status="error" role="alert">
            <ReviewIcon name="alert" /><span>{error}</span>
          </p>
        ) : null}
      </section>
    </aside>
  );
}
