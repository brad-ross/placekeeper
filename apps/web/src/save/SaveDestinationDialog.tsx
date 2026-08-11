import { useId, useLayoutEffect, useRef, useState } from "react";

import type { SaveCopyProposal } from "../app/ProductionReviewApp.js";
import type { PdfRewriteEligibility } from "../../../../packages/core/src/pdf-writer.js";

export interface SaveDestinationDialogProps {
  readonly open: boolean;
  readonly proposal?: SaveCopyProposal;
  readonly establishing?: boolean;
  readonly error?: string;
  readonly rewriteEligibility?: PdfRewriteEligibility;
  readonly onConfirm: (choice: "copy" | "original", filename: string) => void | Promise<void>;
  readonly onCancel: () => void;
  readonly onChooseLocation?: () => void | Promise<void>;
}

export function SaveDestinationDialog(props: SaveDestinationDialogProps) {
  const [choice, setChoice] = useState<"copy" | "original">("copy");
  const [filename, setFilename] = useState("");
  const titleId = useId();
  const descriptionId = useId();
  const firstRef = useRef<HTMLInputElement>(null);
  const lastProposalFilename = useRef<string>();

  useLayoutEffect(() => {
    if (!props.open) return;
    setChoice("copy");
    lastProposalFilename.current = props.proposal?.filename;
    setFilename(props.proposal?.filename ?? "");
    requestAnimationFrame(() => firstRef.current?.focus({ preventScroll: true }));
  }, [props.open]);

  useLayoutEffect(() => {
    if (!props.open || props.proposal?.filename === undefined) return;
    const proposed = props.proposal.filename;
    const previous = lastProposalFilename.current;
    lastProposalFilename.current = proposed;
    setFilename((current) =>
      current === "" || current === previous ? proposed : current);
  }, [props.open, props.proposal?.filename]);

  if (!props.open) return null;
  const restricted = props.rewriteEligibility?.eligible === false;
  return (
    <div className="save-destination-backdrop" data-save-destination-backdrop>
      <section
        className="save-destination-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (!props.establishing) props.onCancel();
          }
        }}
      >
        <h2 id={titleId}>Save annotations automatically</h2>
        <p id={descriptionId}>
          Choose where this PDF should stay up to date. Your annotations remain editable when you reopen it.
        </p>
        <label className="save-destination-choice">
          <input
            ref={firstRef}
            type="radio"
            name="save-destination"
            checked={choice === "copy"}
            disabled={restricted}
            onChange={() => setChoice("copy")}
          />
          <span><strong>Save to a copy</strong><small>Keeps the original unchanged</small></span>
        </label>
        {choice === "copy" ? (
          <label className="save-destination-filename">
            Copy name
            <input
              value={filename}
              disabled={props.establishing || restricted || props.proposal === undefined}
              onChange={(event) => setFilename(event.currentTarget.value)}
              aria-invalid={props.error !== undefined}
            />
            <small>{props.proposal?.folder}</small>
            {props.onChooseLocation ? (
              <button
                type="button"
                className="save-destination-location"
                disabled={props.establishing || restricted || props.proposal === undefined}
                onClick={() => void props.onChooseLocation?.()}
              >
                Change location…
              </button>
            ) : null}
          </label>
        ) : null}
        <label className="save-destination-choice">
          <input
            type="radio"
            name="save-destination"
            checked={choice === "original"}
            disabled={restricted}
            onChange={() => setChoice("original")}
          />
          <span><strong>Modify the original PDF</strong><small>Annotations are written into the file you opened</small></span>
        </label>
        {restricted ? (
          <p className="save-destination-error" role="alert">{props.rewriteEligibility?.message}</p>
        ) : null}
        {props.error ? <p className="save-destination-error" role="alert">{props.error}</p> : null}
        <footer>
          <button type="button" disabled={props.establishing} onClick={props.onCancel}>Cancel</button>
          <button
            type="button"
            disabled={
              restricted ||
              props.establishing ||
              (choice === "copy" && (props.proposal === undefined || filename.trim() === ""))
            }
            onClick={() => void props.onConfirm(choice, filename)}
          >
            {props.establishing ? "Setting up…" : "Confirm"}
          </button>
        </footer>
      </section>
    </div>
  );
}
