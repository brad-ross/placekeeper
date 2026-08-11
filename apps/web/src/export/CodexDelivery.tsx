import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from "react";

import type { ReviewState } from "../../../../packages/core/src/review-model.js";
import { deliveryUnavailableReason } from "./delivery-availability.js";
import {
  focusDeliveryConfirmation,
  handleDeliveryConfirmationKey,
} from "./delivery-confirmation.js";
import { ReviewIcon, type ReviewIconName } from "../review/ReviewIcon.js";

export interface CodexDeliveryScope {
  readonly sourceRoot: string;
  readonly provider: string;
  readonly revisedPdfDestination: string;
  readonly retention: string;
}

export function codexDeliveryScopeSignature(scope: CodexDeliveryScope): string {
  return JSON.stringify({
    sourceRoot: scope.sourceRoot,
    provider: scope.provider,
    revisedPdfDestination: scope.revisedPdfDestination,
    retention: scope.retention,
  });
}

export function scopeConfirmationRequired(
  confirmedSignature: string | null,
  scope: CodexDeliveryScope,
): boolean {
  return confirmedSignature !== codexDeliveryScopeSignature(scope);
}

export interface PreparedCodexHandoff {
  readonly prompt: string;
  readonly handoffPath: string;
  readonly handoffSha256: string;
  readonly reviewedPdfPath: string;
  readonly reviewedPdfSha256: string;
}

export interface CheckedCodexResult {
  readonly status: "Complete" | "Partial" | "Invalid";
  readonly message: string;
}

type DeliveryNoticeTone = "notice" | "success" | "warning" | "error";

interface DeliveryNotice {
  readonly message: string;
  readonly tone: DeliveryNoticeTone;
}

export interface CodexDeliveryProps extends CodexDeliveryScope {
  readonly state: ReviewState;
  readonly confirmedScopeSignature: string | null;
  readonly onConfirmScope: (signature: string) => void | Promise<void>;
  readonly onPrepare: () => Promise<PreparedCodexHandoff>;
  readonly onSaveInstruction: (prompt: string) => void | Promise<void>;
  readonly onCheckResult: (files: {
    readonly disposition: File;
    readonly revisedPdf?: File;
  }) => Promise<CheckedCodexResult>;
  readonly onConfirmationActiveChange?: (active: boolean) => void;
}

export function CodexDelivery(props: CodexDeliveryProps) {
  const [phase, setPhase] = useState<"Setup" | "Ready" | "Result">("Setup");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<PreparedCodexHandoff | null>(null);
  const [disposition, setDisposition] = useState<File | null>(null);
  const [revisedPdf, setRevisedPdf] = useState<File | null>(null);
  const [notice, setNotice] = useState<DeliveryNotice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prepareTriggerRef = useRef<HTMLButtonElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const readyFocusRef = useRef<HTMLTextAreaElement>(null);
  const unavailable = deliveryUnavailableReason(props.state);
  const scope: CodexDeliveryScope = {
    sourceRoot: props.sourceRoot,
    provider: props.provider,
    revisedPdfDestination: props.revisedPdfDestination,
    retention: props.retention,
  };

  useLayoutEffect(() => {
    props.onConfirmationActiveChange?.(confirming);
    return () => props.onConfirmationActiveChange?.(false);
  }, [confirming, props.onConfirmationActiveChange]);

  useEffect(() => {
    if (confirming) focusDeliveryConfirmation(confirmationRef.current);
  }, [busy, confirming]);

  useEffect(() => {
    if (confirming) return;
    const target = phase === "Ready" ? readyFocusRef.current : prepareTriggerRef.current;
    if (!target?.closest('[aria-hidden="true"]')) target?.focus();
  }, [confirming, phase]);

  const closeConfirmation = () => {
    setConfirming(false);
    requestAnimationFrame(() => {
      const trigger = prepareTriggerRef.current;
      if (!trigger?.closest('[aria-hidden="true"]')) trigger?.focus();
    });
  };

  const prepare = async () => {
    if (scopeConfirmationRequired(props.confirmedScopeSignature, scope)) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPrepared(await props.onPrepare());
      setPhase("Ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Codex handoff preparation failed safely.");
    } finally {
      setBusy(false);
    }
  };

  const confirmAndPrepare = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.onConfirmScope(codexDeliveryScopeSignature(scope));
      setPrepared(await props.onPrepare());
      setPhase("Ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Codex handoff preparation failed safely.");
    } finally {
      setConfirming(false);
      setBusy(false);
    }
  };

  const copyInstruction = async () => {
    if (!prepared) return;
    try {
      await navigator.clipboard.writeText(prepared.prompt);
      setNotice({
        message: "Instruction copied. Start a fresh Codex task and paste it when you are ready.",
        tone: "notice",
      });
    } catch {
      setNotice({
        message: "Clipboard access was denied. The full instruction remains selectable and saveable below.",
        tone: "notice",
      });
    }
  };

  const saveInstruction = async () => {
    if (!prepared) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSaveInstruction(prepared.prompt);
      setNotice({ message: "Instruction saved locally.", tone: "success" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The instruction could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const checkResult = async () => {
    if (!disposition) return;
    setBusy(true);
    setError(null);
    try {
      const result = await props.onCheckResult({
        disposition,
        ...(revisedPdf === null ? {} : { revisedPdf }),
      });
      const tone: DeliveryNoticeTone = result.status === "Complete"
        ? "success"
        : result.status === "Partial"
          ? "warning"
          : "error";
      setNotice({ message: `${result.status}: ${result.message}`, tone });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Result checking failed safely.");
    } finally {
      setBusy(false);
    }
  };

  const firstFile = (event: ChangeEvent<HTMLInputElement>) => event.currentTarget.files?.[0] ?? null;
  const phaseIcon: ReviewIconName = phase === "Setup" ? "clipboard" : phase === "Ready" ? "check" : "upload";
  const messageIcon: ReviewIconName = notice?.tone === "success"
    ? "check"
    : notice?.tone === "warning"
      ? "warning"
      : notice?.tone === "error"
        ? "alert"
        : "clipboard";

  return (
    <section
      className="review-delivery review-delivery--codex"
      data-delivery-kind="codex"
      data-delivery-phase={phase.toLowerCase()}
      aria-labelledby="codex-delivery-heading"
    >
      <header className="review-delivery__header">
        <ReviewIcon name="clipboard" className="review-icon review-delivery__header-icon" />
        <div>
          <h2 id="codex-delivery-heading">Codex delivery</h2>
          <p className="review-delivery__phase" data-review-status="phase">
            <ReviewIcon name={phaseIcon} /><span><strong>{phase}</strong> — no task is submitted or monitored by this app.</span>
          </p>
        </div>
      </header>
      <dl className="review-delivery__metadata" aria-label="Codex data flow summary">
        <dt>Approved source root</dt><dd>{props.sourceRoot}</dd>
        <dt>Provider</dt><dd>{props.provider}</dd>
        <dt>Destination</dt><dd>{props.revisedPdfDestination}</dd>
        <dt>Retention</dt><dd>{props.retention}</dd>
        <dt>External fields</dt>
        <dd>Reviewed PDF and digest; handoff JSON; stable IDs; semantic intent; pageIndex; coordinates; quote, caret, or page context; proposed text or comment; optional relative SyncTeX file and line.</dd>
      </dl>
      <p className="review-delivery__body">
        The reviewed PDF and handoff stay local until you deliberately use them. Writes are limited to the approved source root and fresh result directory; read containment depends on the external Codex sandbox.
      </p>
      <p className="review-delivery__body">Your automatically saved PDF remains separate from this optional Codex handoff.</p>

      {phase === "Setup" ? (
        <div className="review-delivery__phase-panel" data-phase-panel="setup">
          {unavailable ? (
            <p className="review-status review-status--empty" data-review-status="empty" id="codex-disabled-reason">
              <ReviewIcon name="file" /><span>{unavailable}</span>
            </p>
          ) : null}
          <button
            className="review-button review-button--primary"
            ref={prepareTriggerRef}
            data-primary-action="true"
            type="button"
            disabled={unavailable !== undefined || busy}
            aria-describedby={unavailable ? "codex-disabled-reason" : undefined}
            onClick={() => void prepare()}
          >
            <ReviewIcon name={busy ? "loading" : "clipboard"} />
            <span>{busy ? "Preparing…" : "Prepare Codex handoff"}</span>
          </button>
        </div>
      ) : null}

      {confirming ? (
        <div className="delivery-confirmation-backdrop">
          <div
            ref={confirmationRef}
            className="delivery-confirmation"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="codex-confirm-heading"
            tabIndex={-1}
            onKeyDown={(event) =>
              handleDeliveryConfirmationKey(event, closeConfirmation, !busy)
            }
          >
            <div className="delivery-confirmation__notice">
              <ReviewIcon name="warning" className="review-icon delivery-confirmation__icon" />
              <div>
                <h3 id="codex-confirm-heading">Confirm this external data flow</h3>
                <p>Confirm the source root, provider, destination, and retention setting shown above.</p>
              </div>
            </div>
            <div className="delivery-confirmation__actions">
              <button className="review-button review-button--primary" type="button" disabled={busy} onClick={() => void confirmAndPrepare()}>
                <ReviewIcon name={busy ? "loading" : "check"} /><span>Confirm and prepare</span>
              </button>
              <button className="review-button review-button--secondary" type="button" disabled={busy} onClick={closeConfirmation}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}

      {phase === "Ready" && prepared ? (
        <div className="review-delivery__phase-panel" data-phase-panel="ready">
          <div className="review-delivery__artifact-metadata">
            <p>Reviewed PDF: {prepared.reviewedPdfPath}</p>
            <p>Reviewed PDF SHA-256: {prepared.reviewedPdfSha256}</p>
            <p>Handoff JSON: {prepared.handoffPath}</p>
            <p>Handoff SHA-256: {prepared.handoffSha256}</p>
          </div>
          <label className="review-delivery__field" htmlFor="codex-instruction">
            <span>Ready-to-paste instruction</span>
            <textarea ref={readyFocusRef} id="codex-instruction" readOnly value={prepared.prompt} rows={16} />
          </label>
          <div className="review-delivery__actions">
            <button className="review-button review-button--secondary" type="button" onClick={() => void copyInstruction()}>
              <ReviewIcon name="clipboard" /><span>Copy instruction</span>
            </button>
            <button className="review-button review-button--secondary" type="button" disabled={busy} onClick={() => void saveInstruction()}>
              <ReviewIcon name={busy ? "loading" : "save"} /><span>Save instruction</span>
            </button>
            <button className="review-button review-button--primary" type="button" data-primary-action="true" onClick={() => setPhase("Result") }>
              <ReviewIcon name="upload" /><span>Continue to Result</span>
            </button>
          </div>
        </div>
      ) : null}

      {phase === "Result" ? (
        <div className="review-delivery__phase-panel" data-phase-panel="result">
          <label className="review-delivery__field">
            <span>Returned disposition JSON</span>
            <input type="file" accept="application/json,.json" onChange={(event) => setDisposition(firstFile(event))} />
          </label>
          <label className="review-delivery__field">
            <span>Revised PDF, if the build succeeded</span>
            <input type="file" accept="application/pdf,.pdf" onChange={(event) => setRevisedPdf(firstFile(event))} />
          </label>
          <button className="review-button review-button--primary" type="button" disabled={disposition === null || busy} onClick={() => void checkResult()}>
            <ReviewIcon name={busy ? "loading" : "check"} /><span>{busy ? "Checking…" : "Check Result"}</span>
          </button>
        </div>
      ) : null}
      {notice ? (
        <p className={`review-status review-status--${notice.tone}`} data-review-status={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
          <ReviewIcon name={messageIcon} /><span>{notice.message}</span>
        </p>
      ) : null}
      {error ? (
        <p className="review-status review-status--error" data-review-status="error" role="alert">
          <ReviewIcon name="alert" /><span>{error}</span>
        </p>
      ) : null}
    </section>
  );
}
