import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { ReviewState } from "../../../../packages/core/src/review-model.js";
import {
  focusDeliveryConfirmation,
  handleDeliveryConfirmationKey,
} from "./delivery-confirmation.js";
import { ReviewIcon } from "../review/ReviewIcon.js";

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
  const [messageTone, setMessageTone] = useState<"success" | "warning">("success");
  const [error, setError] = useState<string | null>(null);
  const replaceTriggerRef = useRef<HTMLButtonElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
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
    if (confirmReplace) focusDeliveryConfirmation(confirmationRef.current);
  }, [busyAction, confirmReplace]);

  const closeReplaceConfirmation = () => {
    setConfirmReplace(false);
    requestAnimationFrame(() => {
      const trigger = replaceTriggerRef.current;
      if (!trigger?.closest('[aria-hidden="true"]')) trigger?.focus();
    });
  };

  const run = async (
    action: "save" | "replace",
    operation: () => Promise<DeliveryArtifact>,
  ) => {
    setBusyAction(action);
    setMessage(null);
    setMessageTone("success");
    setError(null);
    try {
      const artifact = await operation();
      const success =
        action === "save"
          ? `Reviewed copy saved to ${artifact.path}`
          : `Original explicitly replaced at ${artifact.path}`;
      setMessage(artifact.warning ? `${success} ${artifact.warning}` : success);
      setMessageTone(artifact.warning ? "warning" : "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PDF delivery failed safely.");
    } finally {
      setBusyAction(null);
      if (action === "replace") closeReplaceConfirmation();
    }
  };

  return (
    <section className="review-delivery review-delivery--human" data-delivery-kind="human" aria-labelledby="human-delivery-heading">
      <header className="review-delivery__header">
        <ReviewIcon name="save" className="review-icon review-delivery__header-icon" />
        <div>
          <h2 id="human-delivery-heading">Human delivery</h2>
          <p>Save creates a separate reviewed PDF and keeps the original unchanged.</p>
        </div>
      </header>
      {saveReason ? (
        <p className="review-status review-status--empty" data-review-status="empty" id="delivery-disabled-reason">
          <ReviewIcon name="file" /><span>{saveReason}</span>
        </p>
      ) : null}
      <div className="review-delivery__actions">
        <button
          className="review-button review-button--primary"
          data-primary-action="true"
          type="button"
          disabled={saveReason !== undefined || busyAction !== null}
          aria-describedby={saveReason ? "delivery-disabled-reason" : undefined}
          onClick={() => void run("save", onSave)}
        >
          <ReviewIcon name={busyAction === "save" ? "loading" : "save"} />
          <span>{busyAction === "save" ? "Saving reviewed copy…" : "Save reviewed copy"}</span>
        </button>
        <button
          className="review-button review-button--secondary"
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
          <ReviewIcon name="replace" /><span>Replace Original…</span>
        </button>
      </div>
      {replaceReason && replaceReason !== saveReason ? (
        <p className="review-status review-status--empty" data-review-status="empty" id="replace-disabled-reason">
          <ReviewIcon name="file" /><span>{replaceReason}</span>
        </p>
      ) : null}
      {confirmReplace ? (
        <div className="delivery-confirmation-backdrop">
          <div
            ref={confirmationRef}
            className="delivery-confirmation"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="replace-heading"
            tabIndex={-1}
            onKeyDown={(event) =>
              handleDeliveryConfirmationKey(
                event,
                closeReplaceConfirmation,
                busyAction === null,
              )
            }
          >
            <div className="delivery-confirmation__notice">
              <ReviewIcon name="warning" className="review-icon delivery-confirmation__icon" />
              <div>
                <h3 id="replace-heading">Replace the original PDF?</h3>
                <p>
                  This explicit action replaces the original only after a final safety and
                  drift check. Saving a reviewed copy is the safer default.
                </p>
              </div>
            </div>
            <div className="delivery-confirmation__actions">
              <button
                className="review-button review-button--destructive"
                type="button"
                disabled={busyAction !== null}
                onClick={() => void run("replace", onReplaceOriginal)}
              >
                <ReviewIcon name={busyAction === "replace" ? "loading" : "replace"} />
                <span>Confirm Replace Original</span>
              </button>
              <button
                className="review-button review-button--secondary"
                type="button"
                disabled={busyAction !== null}
                onClick={closeReplaceConfirmation}
              >
                <span>Cancel</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {message ? (
        <p className={`review-status review-status--${messageTone}`} data-review-status={messageTone} role="status">
          <ReviewIcon name={messageTone === "warning" ? "warning" : "check"} /><span>{message}</span>
        </p>
      ) : null}
      {error ? (
        <p className="review-status review-status--error" data-review-status="error" role="alert">
          <ReviewIcon name="alert" /><span>{error}</span>
        </p>
      ) : null}
      {showLifecycleActions ? (
        <div className="review-delivery__lifecycle" aria-label="Review lifecycle">
          <button className="review-button review-button--primary" type="button" onClick={() => void onFinish()}>
            <ReviewIcon name="check" /><span>Finish review</span>
          </button>
          <button className="review-button review-button--destructive" type="button" onClick={() => void onDiscard()}>
            <ReviewIcon name="delete" /><span>Discard review</span>
          </button>
        </div>
      ) : null}
    </section>
  );
}
