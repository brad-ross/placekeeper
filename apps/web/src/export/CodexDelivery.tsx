import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from "react";

import type { ReviewState } from "../../../../packages/core/src/review-model.js";
import { deliveryUnavailableReason } from "./HumanDelivery.js";
import {
  focusDeliveryConfirmation,
  handleDeliveryConfirmationKey,
} from "./delivery-confirmation.js";

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
  const [message, setMessage] = useState<string | null>(null);
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
      setMessage("Instruction copied. Start a fresh Codex task and paste it when you are ready.");
    } catch {
      setMessage("Clipboard access was denied. The full instruction remains selectable and saveable below.");
    }
  };

  const saveInstruction = async () => {
    if (!prepared) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSaveInstruction(prepared.prompt);
      setMessage("Instruction saved locally.");
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
      setMessage(`${result.status}: ${result.message}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Result checking failed safely.");
    } finally {
      setBusy(false);
    }
  };

  const firstFile = (event: ChangeEvent<HTMLInputElement>) => event.currentTarget.files?.[0] ?? null;

  return (
    <section aria-labelledby="codex-delivery-heading">
      <h2 id="codex-delivery-heading">Codex delivery</h2>
      <p><strong>{phase}</strong> — no task is submitted or monitored by this app.</p>
      <dl aria-label="Codex data flow summary">
        <dt>Approved source root</dt><dd>{props.sourceRoot}</dd>
        <dt>Provider</dt><dd>{props.provider}</dd>
        <dt>Destination</dt><dd>{props.revisedPdfDestination}</dd>
        <dt>Retention</dt><dd>{props.retention}</dd>
        <dt>External fields</dt>
        <dd>Reviewed PDF and digest; handoff JSON; stable IDs; semantic intent; pageIndex; coordinates; quote, caret, or page context; proposed text or comment; optional relative SyncTeX file and line.</dd>
      </dl>
      <p>
        The reviewed PDF and handoff stay local until you deliberately use them. Writes are limited to the approved source root and fresh result directory; read containment depends on the external Codex sandbox.
      </p>
      <p>The local-only Human delivery remains available if you only want to share the reviewed PDF.</p>

      {phase === "Setup" ? (
        <div>
          {unavailable ? <p id="codex-disabled-reason">{unavailable}</p> : null}
          <button
            ref={prepareTriggerRef}
            data-primary-action="true"
            type="button"
            disabled={unavailable !== undefined || busy}
            aria-describedby={unavailable ? "codex-disabled-reason" : undefined}
            onClick={() => void prepare()}
          >
            {busy ? "Preparing…" : "Prepare Codex handoff"}
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
            <h3 id="codex-confirm-heading">Confirm this external data flow</h3>
            <p>Confirm the source root, provider, destination, and retention setting shown above.</p>
            <div className="delivery-confirmation__actions">
              <button type="button" disabled={busy} onClick={() => void confirmAndPrepare()}>Confirm and prepare</button>
              <button type="button" disabled={busy} onClick={closeConfirmation}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}

      {phase === "Ready" && prepared ? (
        <div>
          <p>Reviewed PDF: {prepared.reviewedPdfPath}</p>
          <p>Reviewed PDF SHA-256: {prepared.reviewedPdfSha256}</p>
          <p>Handoff JSON: {prepared.handoffPath}</p>
          <p>Handoff SHA-256: {prepared.handoffSha256}</p>
          <label htmlFor="codex-instruction">Ready-to-paste instruction</label>
          <textarea ref={readyFocusRef} id="codex-instruction" readOnly value={prepared.prompt} rows={16} />
          <button type="button" onClick={() => void copyInstruction()}>Copy instruction</button>
          <button type="button" disabled={busy} onClick={() => void saveInstruction()}>Save instruction</button>
          <button type="button" data-primary-action="true" onClick={() => setPhase("Result")}>Continue to Result</button>
        </div>
      ) : null}

      {phase === "Result" ? (
        <div>
          <label>Returned disposition JSON<input type="file" accept="application/json,.json" onChange={(event) => setDisposition(firstFile(event))} /></label>
          <label>Revised PDF, if the build succeeded<input type="file" accept="application/pdf,.pdf" onChange={(event) => setRevisedPdf(firstFile(event))} /></label>
          <button type="button" disabled={disposition === null || busy} onClick={() => void checkResult()}>
            {busy ? "Checking…" : "Check Result"}
          </button>
        </div>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
