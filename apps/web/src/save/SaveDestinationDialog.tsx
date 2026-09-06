import { useId, useLayoutEffect, useRef, useState } from "react";

import { trapDialogFocus } from "../app/dialog-focus.js";
import type { SaveCopyProposal } from "../app/ProductionReviewApp.js";
import { ReviewIcon } from "../review/ReviewIcon.js";
import type { PdfRewriteEligibility } from "../../../../packages/core/src/pdf-writer.js";
import type { SaveFailureReason } from "../../../../packages/core/src/save-status.js";

export interface SaveDestinationDialogProps {
  readonly open: boolean;
  readonly proposal?: SaveCopyProposal;
  readonly sourceDisposition?: "local" | "remote-temporary";
  readonly protectedRecovery?: boolean;
  readonly establishing?: boolean;
  readonly error?: string;
  readonly rewriteEligibility?: PdfRewriteEligibility;
  readonly recoveryTarget?: string;
  readonly recoveryFailure?: SaveFailureReason;
  readonly onConfirm: (choice: "copy" | "original", filename: string) => void | Promise<void>;
  readonly onCancel: () => void;
  readonly onChooseLocation?: () => void | Promise<void>;
  readonly onRetry?: () => void | Promise<void>;
  readonly onLocate?: () => void | Promise<void>;
}

export function SaveDestinationDialog(props: SaveDestinationDialogProps) {
  const [choice, setChoice] = useState<"copy" | "original">("copy");
  const [filename, setFilename] = useState("");
  const titleId = useId();
  const descriptionId = useId();
  const firstRef = useRef<HTMLInputElement>(null);
  const lastProposalFilename = useRef<string | undefined>(undefined);
  const remote = props.sourceDisposition === "remote-temporary";
  const proposalFilename = props.proposal?.sourceDisposition === "local"
    ? props.proposal.filename
    : undefined;
  const proposalFolder = props.proposal?.folder;

  useLayoutEffect(() => {
    if (!props.open) return;
    setChoice("copy");
    lastProposalFilename.current = proposalFilename;
    setFilename(proposalFilename ?? "");
    requestAnimationFrame(() => firstRef.current?.focus());
  }, [props.open]);

  useLayoutEffect(() => {
    if (!props.open || proposalFilename === undefined) return;
    const proposed = proposalFilename;
    const previous = lastProposalFilename.current;
    lastProposalFilename.current = proposed;
    setFilename((current) =>
      current === "" || current === previous ? proposed : current);
  }, [props.open, proposalFilename]);

  if (!props.open) return null;
  const restricted = props.rewriteEligibility?.eligible === false;
  return (
    <div className="save-destination-backdrop" data-save-destination-backdrop>
      <section
        className="save-destination-dialog compact-editorial-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!props.establishing) props.onCancel();
            return;
          }
          trapDialogFocus(event);
        }}
      >
        <header className="compact-editorial-modal__header">
          <h2 id={titleId}>Choose where to save annotations</h2>
          <p id={descriptionId} className="compact-editorial-modal__description">
            {remote
              ? "Choose a new PDF name and location. The private browser source is never modified."
              : "You can change this later by clicking the filename."}
          </p>
        </header>
        <div className="compact-editorial-modal__body">
          {props.recoveryTarget && props.recoveryFailure === "invalid-annotation-geometry" ? (
            <aside className="save-destination-recovery" aria-label="Save recovery">
              <div>
                <strong>An annotation is outside the page</strong>
                <p>Remove or reposition that annotation, then save again. Your latest changes are protected.</p>
              </div>
              <div className="save-destination-recovery__actions">
                <button
                  className="review-button review-button--primary"
                  type="button"
                  title="Return to annotations"
                  onClick={props.onCancel}
                >
                  <ReviewIcon name="arrow-left" />
                  <span>Return to annotations</span>
                </button>
              </div>
            </aside>
          ) : props.recoveryTarget && props.onRetry && props.onLocate ? (
            <aside className="save-destination-recovery" aria-label="Save recovery">
              <div>
                <strong>This PDF isn’t up to date</strong>
                <p>Your latest annotations are protected. Retry saving to {props.recoveryTarget}, or locate the PDF if it moved.</p>
              </div>
              <div className="save-destination-recovery__actions">
                <button
                  className="review-button review-button--primary"
                  type="button"
                  title="Retry saving"
                  disabled={props.establishing}
                  onClick={() => void props.onRetry?.()}
                >
                  <ReviewIcon name="redo" />
                  <span>Retry</span>
                </button>
                <button
                  className="review-button"
                  type="button"
                  title="Locate the PDF"
                  disabled={props.establishing}
                  onClick={() => void props.onLocate?.()}
                >
                  <ReviewIcon name="locate" />
                  <span>Locate PDF…</span>
                </button>
              </div>
            </aside>
          ) : null}
          {props.protectedRecovery ? (
            <aside className="save-destination-recovery" aria-label="Protected Recovery">
              <div>
                <strong>Protected Recovery</strong>
                <p>Your annotation is protected while you choose where to save it.</p>
              </div>
            </aside>
          ) : null}
          <fieldset className="save-destination-options">
          <legend className="sr-only">Automatic save location</legend>
          {remote ? null : <label className="save-destination-choice" data-selected={choice === "original"}>
            <input
              type="radio"
              title="Modify the original PDF"
              name="save-destination"
              checked={choice === "original"}
              disabled={restricted}
              onChange={() => setChoice("original")}
            />
            <strong>Modify the original PDF</strong>
          </label>}
          <label className="save-destination-choice" data-selected={choice === "copy"}>
            <input
              ref={firstRef}
              type="radio"
              title="Save to a new copy"
              name="save-destination"
              checked={choice === "copy"}
              disabled={restricted}
              onChange={() => setChoice("copy")}
            />
            <strong>Save to a new copy</strong>
          </label>
          {choice === "copy" ? (
            <div className="save-destination-copy-details">
              {props.onChooseLocation ? (
                <button
                  type="button"
                  className="save-destination-location"
                  aria-label={proposalFolder
                    ? `Change save location. Current location: ${proposalFolder}`
                    : "Choose save location"}
                  title={proposalFolder ? "Change save location" : "Choose save location"}
                  disabled={props.establishing || restricted || (!remote && props.proposal === undefined)}
                  onClick={() => void props.onChooseLocation?.()}
                >
                  <span title={proposalFolder}>{proposalFolder ?? (remote ? "Choose a location…" : "Preparing location…")}</span>
                </button>
              ) : proposalFolder ? <p className="save-destination-location-path" title={proposalFolder}>{proposalFolder}</p> : null}
              <label className="save-destination-filename">
                <span className="sr-only">{remote ? "PDF name" : "Copy name"}</span>
                <input
                  value={filename}
                  aria-label={remote ? "PDF name" : "Copy name"}
                  title="Enter a name for the PDF copy"
                  disabled={props.establishing || restricted || (!remote && props.proposal === undefined)}
                  onChange={(event) => setFilename(event.currentTarget.value)}
                  aria-invalid={props.error !== undefined}
                />
              </label>
            </div>
          ) : null}
          </fieldset>
          {restricted ? (
            <p className="save-destination-error" role="alert">{props.rewriteEligibility?.message}</p>
          ) : null}
          {props.error ? <p className="save-destination-error" role="alert">{props.error}</p> : null}
        </div>
        <footer className="compact-editorial-modal__footer">
          <button
            className="review-button"
            type="button"
            title="Cancel save setup"
            disabled={props.establishing}
            onClick={props.onCancel}
          >
            <ReviewIcon name="close" />
            <span>Cancel</span>
          </button>
          <button
            type="button"
            className="review-button review-button--primary"
            title="Confirm automatic save options"
            disabled={
              restricted ||
              props.establishing ||
              (choice === "copy" && (
                filename.trim() === "" ||
                (remote ? proposalFolder === undefined : props.proposal === undefined)
              ))
            }
            onClick={() => void props.onConfirm(choice, filename)}
          >
            <ReviewIcon name={props.establishing ? "loading" : "check"} />
            <span>{props.establishing ? "Setting up…" : "Confirm"}</span>
          </button>
        </footer>
      </section>
    </div>
  );
}
