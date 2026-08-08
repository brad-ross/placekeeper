import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import type { ReviewState } from "../../../../packages/core/src/review-model.js";

export interface DeliveryArtifact {
  readonly path: string;
  readonly warning?: string;
}

export interface HumanDeliveryProps {
  readonly state: ReviewState;
  readonly exportUnavailableReason?: string;
  readonly replaceUnavailableReason?: string;
  readonly onSave: () => Promise<DeliveryArtifact>;
  readonly onReplaceOriginal: () => Promise<DeliveryArtifact>;
  readonly onFinish: () => void | Promise<void>;
  readonly onDiscard: () => void | Promise<void>;
  readonly showLifecycleActions?: boolean;
  readonly onConfirmationActiveChange?: (active: boolean) => void;
}

export const EMPTY_DELIVERY_EXPLANATION =
  "There is no review feedback to deliver. Add an annotation first. Human and Codex delivery are unavailable.";

export function deliveryUnavailableReason(
  state: Pick<ReviewState, "items">,
  restriction?: string,
): string | undefined {
  if (state.items.length === 0) return EMPTY_DELIVERY_EXPLANATION;
  return restriction;
}

export function HumanDelivery({
  state,
  exportUnavailableReason,
  replaceUnavailableReason,
  onSave,
  onReplaceOriginal,
  onFinish,
  onDiscard,
  showLifecycleActions = true,
  onConfirmationActiveChange,
}: HumanDeliveryProps) {
  const [busyAction, setBusyAction] = useState<"save" | "replace" | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const replaceTriggerRef = useRef<HTMLButtonElement>(null);
  const confirmReplaceRef = useRef<HTMLButtonElement>(null);
  const saveReason = deliveryUnavailableReason(state, exportUnavailableReason);
  const replaceReason = deliveryUnavailableReason(
    state,
    replaceUnavailableReason ?? exportUnavailableReason,
  );

  useLayoutEffect(() => {
    onConfirmationActiveChange?.(confirmReplace);
    return () => onConfirmationActiveChange?.(false);
  }, [confirmReplace, onConfirmationActiveChange]);

  useEffect(() => {
    if (confirmReplace) confirmReplaceRef.current?.focus();
  }, [confirmReplace]);

  const closeReplaceConfirmation = () => {
    setConfirmReplace(false);
    queueMicrotask(() => {
      const trigger = replaceTriggerRef.current;
      if (!trigger?.closest('[aria-hidden="true"]')) trigger?.focus();
    });
  };

  const confirmationKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeReplaceConfirmation();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const run = async (
    action: "save" | "replace",
    operation: () => Promise<DeliveryArtifact>,
  ) => {
    setBusyAction(action);
    setMessage(null);
    setError(null);
    try {
      const artifact = await operation();
      const success =
        action === "save"
          ? `Reviewed copy saved to ${artifact.path}`
          : `Original explicitly replaced at ${artifact.path}`;
      setMessage(artifact.warning ? `${success} ${artifact.warning}` : success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PDF delivery failed safely.");
    } finally {
      setBusyAction(null);
      if (action === "replace") closeReplaceConfirmation();
    }
  };

  return (
    <section aria-labelledby="human-delivery-heading">
      <h2 id="human-delivery-heading">Human delivery</h2>
      <p>Save creates a separate reviewed PDF and keeps the original unchanged.</p>
      {saveReason ? <p id="delivery-disabled-reason">{saveReason}</p> : null}
      <div>
        <button
          data-primary-action="true"
          type="button"
          disabled={saveReason !== undefined || busyAction !== null}
          aria-describedby={saveReason ? "delivery-disabled-reason" : undefined}
          onClick={() => void run("save", onSave)}
        >
          {busyAction === "save" ? "Saving reviewed copy…" : "Save reviewed copy"}
        </button>
        <button
          ref={replaceTriggerRef}
          type="button"
          disabled={replaceReason !== undefined || busyAction !== null}
          aria-describedby={
            replaceReason
              ? replaceReason === saveReason
                ? "delivery-disabled-reason"
                : "replace-disabled-reason"
              : undefined
          }
          onClick={() => setConfirmReplace(true)}
        >
          Replace Original…
        </button>
      </div>
      {replaceReason && replaceReason !== saveReason ? (
        <p id="replace-disabled-reason">{replaceReason}</p>
      ) : null}
      {confirmReplace ? (
        <div role="alertdialog" aria-modal="true" aria-labelledby="replace-heading" onKeyDown={confirmationKeyDown}>
          <h3 id="replace-heading">Replace the original PDF?</h3>
          <p>
            This explicit action replaces the original only after a final safety and
            drift check. Saving a reviewed copy is the safer default.
          </p>
          <button
            ref={confirmReplaceRef}
            type="button"
            disabled={busyAction !== null}
            onClick={() => void run("replace", onReplaceOriginal)}
          >
            Confirm Replace Original
          </button>
          <button type="button" onClick={closeReplaceConfirmation}>
            Cancel
          </button>
        </div>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {showLifecycleActions ? (
        <div aria-label="Review lifecycle">
          <button type="button" onClick={() => void onFinish()}>
            Finish review
          </button>
          <button type="button" onClick={() => void onDiscard()}>
            Discard review
          </button>
        </div>
      ) : null}
    </section>
  );
}
