import { useMemo, useState } from "react";

import { createReviewStateSummary, type ReviewStateSummaryV1 } from "../../../../packages/core/src/live-context.js";
import { anchorEvidenceFromReviewItem } from "../../../../packages/core/src/review-model.js";
import type {
  PendingReviewDraftV1,
  ReviewAnchorEvidenceV1,
  ReviewCommand,
  ReviewItem,
  ReviewState,
} from "../../../../packages/core/src/review-model.js";
import type { GenerationRefreshStatus } from "../generation-status.js";
import type { CaretAnchor } from "../pdf/selection-anchor.js";
import type { SelectionUpdate } from "../pdf/selection-state.js";

export type ReattachmentTarget =
  | {
      readonly kind: "item";
      readonly id: string;
      readonly revision: number;
      readonly ownerViewId: string;
    }
  | {
      readonly kind: "draft";
      readonly draft: PendingReviewDraftV1;
    };

export function buildReattachmentCommand(input: {
  readonly target: ReattachmentTarget;
  readonly stateRevision: number;
  readonly documentGeneration: number;
  readonly anchor: ReviewAnchorEvidenceV1;
  readonly updatedAt: string;
}): ReviewCommand {
  if (input.target.kind === "item") {
    return {
      type: "reattach",
      expectedRevision: input.stateRevision,
      id: input.target.id,
      expectedReconciliationRevision: input.target.revision,
      ownerViewId: input.target.ownerViewId,
      anchor: input.anchor,
      updatedAt: input.updatedAt,
    };
  }
  return {
    type: "put-draft",
    expectedRevision: input.stateRevision,
    expectedDraftRevision: input.target.draft.revision,
    draft: {
      ...input.target.draft,
      baseGeneration: input.documentGeneration,
      pageIndex: input.anchor.pageIndex,
      anchor: input.anchor,
      disposition: { kind: "resolved", generation: input.documentGeneration },
      status: "protected",
      updatedAt: input.updatedAt,
    },
  };
}

export interface ReconciliationExportPresentation {
  readonly canExport: boolean;
  readonly requiresStaleConfirmation: boolean;
  readonly message: string;
}

export function reconciliationExportPresentation(input: {
  readonly refreshStatus: GenerationRefreshStatus;
  readonly summary: ReviewStateSummaryV1;
}): ReconciliationExportPresentation {
  if (input.refreshStatus === "reconciling") {
    return {
      canExport: false,
      requiresStaleConfirmation: false,
      message: "Export becomes available after document reconciliation finishes.",
    };
  }
  const unresolvedItems = input.summary.reconciliation.unresolvedItemIds.length;
  const pendingDrafts = input.summary.reconciliation.pendingDraftIds.length;
  if (unresolvedItems > 0 || pendingDrafts > 0) {
    const parts = [
      unresolvedItems > 0
        ? `${unresolvedItems} Review Item${unresolvedItems === 1 ? "" : "s"}`
        : "",
      pendingDrafts > 0
        ? `${pendingDrafts} pending draft${pendingDrafts === 1 ? "" : "s"}`
        : "",
    ].filter(Boolean);
    return {
      canExport: false,
      requiresStaleConfirmation: false,
      message: `Resolve ${parts.join(" and ")} before export.`,
    };
  }
  if (input.summary.export.requiresStaleConfirmation || input.refreshStatus === "failed") {
    return {
      canExport: true,
      requiresStaleConfirmation: true,
      message: "The last successful PDF may be stale. Confirm before exporting this generation.",
    };
  }
  return {
    canExport: input.summary.export.eligible,
    requiresStaleConfirmation: false,
    message: "All Review Items are reconciled. The latest generation is ready to export.",
  };
}

function targetAnchor(target: ReviewItem | PendingReviewDraftV1): ReviewAnchorEvidenceV1 {
  return "payload" in target ? anchorEvidenceFromReviewItem(target) : target.anchor;
}

function selectionEvidence(
  update: SelectionUpdate,
): Extract<ReviewAnchorEvidenceV1, { readonly kind: "selection" }> | null {
  if (update.kind !== "reliable") return null;
  const { reliable: _reliable, ...anchor } = update.anchor;
  return { kind: "selection", ...anchor };
}

function caretEvidence(
  caret: CaretAnchor | null | undefined,
): Extract<ReviewAnchorEvidenceV1, { readonly kind: "caret" }> | null {
  if (caret === null || caret === undefined) return null;
  return {
    kind: "caret",
    pageIndex: caret.pageIndex,
    leftContext: caret.leftContext,
    rightContext: caret.rightContext,
    rect: caret.position,
  };
}

export function reattachmentCandidateFor(
  expected: ReviewAnchorEvidenceV1["kind"],
  selectionUpdate: SelectionUpdate,
  caret: CaretAnchor | null | undefined,
): { readonly anchor: ReviewAnchorEvidenceV1 | null; readonly message: string } {
  const selection = selectionEvidence(selectionUpdate);
  const caretAnchor = caretEvidence(caret);
  if (expected === "selection") {
    if (selection !== null) return { anchor: selection, message: "Replacement text is valid." };
    return {
      anchor: null,
      message: selectionUpdate.kind === "unreliable"
        ? selectionUpdate.userMessage
        : "Select one reliable replacement passage in the current PDF.",
    };
  }
  if (expected === "caret") {
    return caretAnchor === null
      ? { anchor: null, message: "Place the caret at one valid insertion point in the current PDF." }
      : { anchor: caretAnchor, message: "Replacement caret is valid." };
  }
  if (selection !== null) {
    return {
      anchor: {
        kind: "page",
        pageIndex: selection.pageIndex,
        nearbyText: selection.quote,
        rect: selection.rect,
      },
      message: "Replacement page evidence is valid.",
    };
  }
  return caretAnchor === null
    ? { anchor: null, message: "Select text or place the caret on the replacement page." }
    : {
        anchor: { kind: "page", pageIndex: caretAnchor.pageIndex, rect: caretAnchor.rect },
        message: "Replacement page evidence is valid.",
      };
}

export function reattachmentGenerationIsCurrent(expected: number, current: number): boolean {
  return Number.isSafeInteger(expected) && expected === current;
}

export function reconciliationCommandPresentation(
  result: unknown,
  successMessage: string,
): { readonly accepted: boolean; readonly message: string } {
  if (typeof result === "object" && result !== null && "accepted" in result && result.accepted === false) {
    return {
      accepted: false,
      message: "message" in result && typeof result.message === "string"
        ? result.message
        : "The review state changed. Refresh the target and try again.",
    };
  }
  return { accepted: true, message: successMessage };
}

export function cancelledReattachmentPresentation(): {
  readonly unresolved: true;
  readonly message: string;
} {
  return {
    unresolved: true,
    message: "Reattachment cancelled. The item remains unresolved.",
  };
}

function reason(target: ReviewItem | PendingReviewDraftV1): string {
  const disposition = "payload" in target ? target.reconciliation?.disposition : target.disposition;
  return disposition?.kind === "resolved" ? "Pending authoring must be completed." : disposition?.reason ?? "Anchor unresolved.";
}

function quote(target: ReviewItem | PendingReviewDraftV1): string {
  const anchor = targetAnchor(target);
  if (anchor.kind === "selection") return anchor.quote;
  if (anchor.kind === "caret") return `${anchor.leftContext}▏${anchor.rightContext}`;
  return anchor.nearbyText ?? `Page ${anchor.pageIndex + 1}`;
}

export interface ReconciliationWorkspaceProps {
  readonly state: ReviewState;
  readonly selectionUpdate: SelectionUpdate;
  readonly caretAnchor?: CaretAnchor | null;
  readonly refreshStatus: GenerationRefreshStatus;
  readonly onCommand: (command: ReviewCommand) => Promise<unknown>;
  readonly onExport: (confirmPossiblyStale?: true) => Promise<unknown>;
}

export function ReconciliationWorkspace(props: ReconciliationWorkspaceProps) {
  const unresolvedItems = props.state.items.filter(
    (item) => item.reconciliation !== undefined && item.reconciliation.disposition.kind !== "resolved",
  );
  const [active, setActive] = useState<{
    readonly target: ReattachmentTarget;
    readonly expectedKind: ReviewAnchorEvidenceV1["kind"];
    readonly generation: number;
  } | null>(null);
  const [discard, setDiscard] = useState<ReattachmentTarget | null>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [staleConfirmation, setStaleConfirmation] = useState(false);
  const exportState = reconciliationExportPresentation({
    refreshStatus: props.refreshStatus,
    summary: createReviewStateSummary(props.state),
  });
  const candidate = useMemo(() => active === null
    ? null
    : reattachmentCandidateFor(active.expectedKind, props.selectionUpdate, props.caretAnchor), [
      active,
      props.caretAnchor,
      props.selectionUpdate,
    ]);
  const begin = (target: ReviewItem | PendingReviewDraftV1, commandTarget: ReattachmentTarget) => {
    setDiscard(null);
    setMessage("");
    setActive({
      target: commandTarget,
      expectedKind: targetAnchor(target).kind,
      generation: props.state.workflow.documentGeneration,
    });
  };
  const submit = async (command: ReviewCommand, success: string) => {
    setPending(true);
    setMessage("");
    try {
      const result = await props.onCommand(command);
      const presentation = reconciliationCommandPresentation(result, success);
      if (!presentation.accepted) {
        setMessage(presentation.message);
        return;
      }
      setActive(null);
      setDiscard(null);
      setMessage(presentation.message);
    } catch {
      setMessage("The review state changed or the command was rejected. Nothing was moved.");
    } finally {
      setPending(false);
    }
  };
  const discardCommand = (target: ReattachmentTarget): ReviewCommand => ({
    type: "discard-reconciliation",
    expectedRevision: props.state.revision,
    target: target.kind,
    id: target.kind === "item" ? target.id : target.draft.id,
    expectedTargetRevision: target.kind === "item" ? target.revision : target.draft.revision,
    ownerViewId: target.kind === "item" ? target.ownerViewId : target.draft.ownerViewId,
    reason: "discarded-by-reviewer-during-reconciliation",
    discardedAt: new Date().toISOString(),
  });

  return <section className="reconciliation-workspace" data-reconciliation-workspace aria-label="Reconciliation">
    <header>
      <h2>Reconciliation</h2>
      <p data-document-freshness={props.state.workflow.freshness}>
        Generation {props.state.workflow.documentGeneration} is {props.state.workflow.freshness === "current" ? "current" : "possibly stale"}.
      </p>
    </header>
    {props.refreshStatus === "reconciling" ? <p role="status">A rebuilt PDF is loading and Review Items are reconciling.</p> : null}
    {props.refreshStatus === "failed" ? <p role="alert">The rebuilt PDF could not be validated. The last successful PDF remains reviewable and may be stale.</p> : null}
    {unresolvedItems.map((item) => {
      const reconciliation = item.reconciliation!;
      const target: ReattachmentTarget = {
        kind: "item",
        id: item.id,
        revision: reconciliation.revision,
        ownerViewId: reconciliation.ownerViewId,
      };
      return <article key={item.id} data-reconciliation-item={item.id}>
        <h3>Unresolved Review Item</h3>
        <blockquote>{quote(item)}</blockquote>
        <p>{reason(item)}</p>
        <button type="button" onClick={() => begin(item, target)}>Reattach</button>
        <button type="button" onClick={() => { setActive(null); setDiscard(target); }}>Discard</button>
      </article>;
    })}
    {props.state.pendingDrafts.map((draft) => {
      const target: ReattachmentTarget = { kind: "draft", draft };
      return <article key={draft.id} data-reconciliation-draft={draft.id}>
        <h3>{draft.status === "frozen" ? "Frozen draft" : "Pending draft"}</h3>
        <p>{draft.text}</p>
        <blockquote>{quote(draft)}</blockquote>
        <p>{reason(draft)}</p>
        <button type="button" onClick={() => begin(draft, target)}>Reattach</button>
        <button type="button" onClick={() => { setActive(null); setDiscard(target); }}>Discard</button>
      </article>;
    })}

    {active !== null && candidate !== null ? <section data-reattachment-selection-mode>
      <h3>Select replacement evidence</h3>
      <p role={candidate.anchor === null ? "alert" : "status"}>{candidate.message}</p>
      {candidate.anchor !== null ? <p data-reattachment-preview>
        Preview: page {candidate.anchor.pageIndex + 1}, x {Math.round(candidate.anchor.rect.x)}, y {Math.round(candidate.anchor.rect.y)}.
      </p> : null}
      <button type="button" disabled={pending || candidate.anchor === null} onClick={() => {
        if (candidate.anchor === null) return;
        if (!reattachmentGenerationIsCurrent(active.generation, props.state.workflow.documentGeneration)) {
          setMessage("The PDF generation changed. Select replacement evidence again.");
          return;
        }
        void submit(buildReattachmentCommand({
          target: active.target,
          stateRevision: props.state.revision,
          documentGeneration: props.state.workflow.documentGeneration,
          anchor: candidate.anchor,
          updatedAt: new Date().toISOString(),
        }), "Reattachment saved.");
      }}>Confirm reattachment</button>
      <button type="button" disabled={pending} onClick={() => {
        setActive(null);
        setMessage(cancelledReattachmentPresentation().message);
      }}>Cancel</button>
    </section> : null}

    {discard !== null ? <section data-discard-confirmation>
      <p>Discard this unresolved work? This audited action removes it from export.</p>
      <button type="button" disabled={pending} onClick={() => void submit(discardCommand(discard), "Discard recorded.")}>Confirm discard</button>
      <button type="button" disabled={pending} onClick={() => setDiscard(null)}>Cancel</button>
    </section> : null}

    {message ? <p role="status">{message}</p> : null}
    <footer data-export-eligibility={exportState.canExport ? "eligible" : "blocked"}>
      <p>{exportState.message}</p>
      {staleConfirmation ? <div data-stale-export-confirmation>
        <p>Export the last successful, possibly stale generation?</p>
        <button type="button" disabled={pending} onClick={() => {
          setPending(true);
          void props.onExport(true).then(() => {
            setMessage("Reviewed PDF exported.");
            setStaleConfirmation(false);
          }).catch(() => setMessage("Export failed safely; generated output was not changed."))
            .finally(() => setPending(false));
        }}>Confirm export</button>
        <button type="button" disabled={pending} onClick={() => setStaleConfirmation(false)}>Cancel</button>
      </div> : <button type="button" disabled={!exportState.canExport || pending} onClick={() => {
        if (exportState.requiresStaleConfirmation) {
          setStaleConfirmation(true);
          return;
        }
        setPending(true);
        void props.onExport().then(() => setMessage("Reviewed PDF exported."))
          .catch(() => setMessage("Export failed safely; generated output was not changed."))
          .finally(() => setPending(false));
      }}>Export reviewed PDF</button>}
    </footer>
  </section>;
}
