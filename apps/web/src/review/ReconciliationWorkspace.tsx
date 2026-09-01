import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { anchorEvidenceFromReviewItem } from "../../../../packages/core/src/review-model.js";
import type {
  PendingReviewDraftV1,
  ReviewAnchorEvidenceV1,
  ReviewCommand,
  ReviewItem,
  ReviewItemKind,
  ReviewState,
} from "../../../../packages/core/src/review-model.js";
import type { GenerationRefreshStatus } from "../generation-status.js";
import type { CaretAnchor } from "../pdf/selection-anchor.js";
import { reliableSelection, type SelectionUpdate } from "../pdf/selection-state.js";
import { AnnotationMetadata, annotationKindLabel } from "./AnnotationMetadata.js";
import { ReviewIcon } from "./ReviewIcon.js";

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

const DEFAULT_SELECTION_REATTACHMENT_MESSAGE = "Select one reliable replacement passage in the current PDF.";

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

function targetAnchor(target: ReviewItem | PendingReviewDraftV1): ReviewAnchorEvidenceV1 {
  return "payload" in target ? anchorEvidenceFromReviewItem(target) : target.anchor;
}

function selectionEvidence(
  update: SelectionUpdate,
): Extract<ReviewAnchorEvidenceV1, { readonly kind: "selection" }> | null {
  const selection = reliableSelection(update);
  if (selection === null) return null;
  const { reliable: _reliable, ...anchor } = selection;
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
        : DEFAULT_SELECTION_REATTACHMENT_MESSAGE,
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

function quote(target: ReviewItem | PendingReviewDraftV1): string {
  const anchor = targetAnchor(target);
  if (anchor.kind === "selection") return anchor.quote;
  if (anchor.kind === "caret") return `${anchor.leftContext}▏${anchor.rightContext}`;
  return anchor.nearbyText ?? `Page ${anchor.pageIndex + 1}`;
}

const REATTACHMENT_TITLES: Readonly<Record<ReviewItemKind, string>> = {
  delete: "Reattach deletion",
  highlight: "Reattach highlight",
  insert: "Reattach insertion",
  pageNote: "Reattach page note",
  replace: "Reattach replacement",
};

export function reattachmentTitle(kind: ReviewItemKind): string {
  return REATTACHMENT_TITLES[kind];
}

function meaningfulPriorSourceText(
  target: ReviewItem | PendingReviewDraftV1,
  authored: string,
): string | undefined {
  const anchor = targetAnchor(target);
  const source = anchor.kind === "selection"
    ? anchor.quote
    : anchor.kind === "caret"
      ? `${anchor.leftContext}▏${anchor.rightContext}`
      : anchor.nearbyText;
  const normalizedSource = source?.trim();
  if (!normalizedSource || normalizedSource === `Page ${anchor.pageIndex + 1}`) return undefined;
  return normalizedSource === authored.trim() ? undefined : normalizedSource;
}

function reattachmentInstruction(
  expected: ReviewAnchorEvidenceV1["kind"],
  candidate: { readonly anchor: ReviewAnchorEvidenceV1 | null; readonly message: string },
): string {
  if (candidate.anchor === null && candidate.message !== DEFAULT_SELECTION_REATTACHMENT_MESSAGE) {
    return candidate.message;
  }
  if (expected === "caret") return "Place the caret at the intended insertion point in the PDF, then confirm.";
  if (expected === "page") return "Select text or place the caret on the intended page in the PDF, then confirm.";
  return "Select the intended text in the PDF, then confirm.";
}

export interface ReconciliationWorkspaceProps {
  readonly state: ReviewState;
  readonly selectionUpdate: SelectionUpdate;
  readonly caretAnchor?: CaretAnchor | null;
  readonly refreshStatus: GenerationRefreshStatus;
  readonly onCommand: (command: ReviewCommand) => Promise<unknown>;
  readonly onDetailOpenChange?: (open: boolean) => void;
}

type ResolutionMode = "apply" | "reattach" | "discard";

interface ResolutionDetail {
  readonly key: string;
  readonly mode: ResolutionMode;
  readonly generation: number;
}

interface ResolutionRecord {
  readonly key: string;
  readonly target: ReattachmentTarget;
  readonly value: ReviewItem | PendingReviewDraftV1;
  readonly kind: ReviewItem["kind"] | PendingReviewDraftV1["kind"];
  readonly pageNumber: number;
  readonly priorSourceText: string | undefined;
  readonly authoredText: string;
  readonly stateLabel: string;
}

function authoredText(target: ReviewItem | PendingReviewDraftV1): string {
  if (!("payload" in target)) return target.text;
  const fields = ["proposedText", "comment", "quote"] as const;
  return fields
    .map((field) => target.payload[field])
    .find((value): value is string => typeof value === "string" && value.length > 0) ?? quote(target);
}

function resolutionStateLabel(target: ReviewItem | PendingReviewDraftV1): string {
  if (!("payload" in target)) {
    if (target.status === "protected" && target.disposition.kind === "resolved") return "Ready to apply";
    return target.status === "frozen" ? "Needs new location" : "Needs review";
  }
  const disposition = target.reconciliation?.disposition;
  if (disposition?.kind === "ambiguous") return "Multiple matches";
  if (disposition?.kind === "missing") return "Missing text";
  return "Needs review";
}

export function ReconciliationWorkspace(props: ReconciliationWorkspaceProps) {
  const records = useMemo<readonly ResolutionRecord[]>(() => [
    ...props.state.items.filter(
      (item) => item.reconciliation !== undefined && item.reconciliation.disposition.kind !== "resolved",
    ).map((item): ResolutionRecord => ({
      key: `item:${item.id}`,
      target: {
        kind: "item",
        id: item.id,
        revision: item.reconciliation!.revision,
        ownerViewId: item.reconciliation!.ownerViewId,
      },
      value: item,
      kind: item.kind,
      pageNumber: item.pageIndex + 1,
      authoredText: authoredText(item),
      priorSourceText: meaningfulPriorSourceText(item, authoredText(item)),
      stateLabel: resolutionStateLabel(item),
    })),
    ...props.state.pendingDrafts.map((draft): ResolutionRecord => ({
      key: `draft:${draft.id}`,
      target: { kind: "draft", draft },
      value: draft,
      kind: draft.kind,
      pageNumber: draft.pageIndex + 1,
      authoredText: authoredText(draft),
      priorSourceText: meaningfulPriorSourceText(draft, authoredText(draft)),
      stateLabel: resolutionStateLabel(draft),
    })),
  ], [props.state.items, props.state.pendingDrafts]);
  const recordsByKey = useMemo(
    () => new Map(records.map((record) => [record.key, record] as const)),
    [records],
  );
  const [detail, setDetail] = useState<ResolutionDetail | null>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const entryRefs = useRef(new Map<string, HTMLButtonElement>());
  const detailBackRef = useRef<HTMLButtonElement>(null);
  const returnFocusKeyRef = useRef<string | null>(null);
  const activeRecord = detail === null
    ? undefined
    : recordsByKey.get(detail.key);
  const candidate = useMemo(() => detail?.mode !== "reattach" || activeRecord === undefined
    ? null
    : reattachmentCandidateFor(
      targetAnchor(activeRecord.value).kind,
      props.selectionUpdate,
      props.caretAnchor,
    ), [
      activeRecord,
      detail?.mode,
      props.caretAnchor,
      props.selectionUpdate,
    ]);

  useEffect(() => {
    props.onDetailOpenChange?.(activeRecord !== undefined);
  }, [activeRecord !== undefined, props.onDetailOpenChange]);

  useEffect(() => () => props.onDetailOpenChange?.(false), [props.onDetailOpenChange]);

  useLayoutEffect(() => {
    if (activeRecord !== undefined) {
      detailBackRef.current?.focus({ preventScroll: true });
      return;
    }
    const returnFocusKey = returnFocusKeyRef.current;
    if (returnFocusKey === null) return;
    entryRefs.current.get(returnFocusKey)?.focus({ preventScroll: true });
    returnFocusKeyRef.current = null;
  }, [activeRecord]);

  const openDetail = (record: ResolutionRecord, mode: ResolutionMode) => {
    setMessage("");
    returnFocusKeyRef.current = null;
    setDetail({
      key: record.key,
      mode,
      generation: props.state.workflow.documentGeneration,
    });
  };
  const closeDetail = () => {
    if (detail !== null) returnFocusKeyRef.current = detail.key;
    setDetail(null);
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
      setDetail(null);
      returnFocusKeyRef.current = null;
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

  if (activeRecord !== undefined && detail !== null) {
    const typeLabel = annotationKindLabel(activeRecord.kind);
    const draft = "payload" in activeRecord.value ? undefined : activeRecord.value;
    const canApplyDraft = draft?.status === "protected" && draft.disposition.kind === "resolved";
    return <section
      className="reconciliation-workspace reconciliation-workspace--detail full-annotation-reader"
      data-reconciliation-workspace
      data-reconciliation-detail={detail.mode}
      aria-label={`Resolve previous ${typeLabel} annotation on page ${activeRecord.pageNumber}`}
    >
      <header className="reconciliation-workspace__detail-header">
        <button
          ref={detailBackRef}
          type="button"
          className="full-annotation-reader__back"
          aria-label="Back"
          title="Back to previous annotations"
          disabled={pending}
          onClick={closeDetail}
        ><ReviewIcon name="arrow-left" size={15} /></button>
        <h2>{detail.mode === "reattach" ? reattachmentTitle(activeRecord.kind) : `${detail.mode === "apply" ? "Apply" : "Discard"} ${typeLabel.toLocaleLowerCase()}`}</h2>
        <span className="reconciliation-workspace__state-pill" data-reconciliation-status={activeRecord.stateLabel}>{activeRecord.stateLabel}</span>
        {detail.mode === "discard" ? <span className="reconciliation-workspace__header-spacer" /> : <button
          type="button"
          className="full-annotation-reader__edit reconciliation-workspace__discard"
          data-reconciliation-action="discard"
          aria-label={`Discard ${typeLabel} annotation on page ${activeRecord.pageNumber}`}
          title="Discard annotation"
          disabled={pending}
          onClick={() => openDetail(activeRecord, "discard")}
        ><ReviewIcon name="delete" size={15} /></button>}
      </header>

      <div className="full-annotation-reader__body">
        <section className="reconciliation-workspace__intent">
          <p className="reconciliation-workspace__kicker">Your annotation</p>
          <p className="reconciliation-workspace__annotation-text">{activeRecord.authoredText}</p>
        </section>
        <section className="reconciliation-workspace__prior-context">
          <p className="reconciliation-workspace__kicker">Previously attached to <span aria-hidden="true">·</span> Page {activeRecord.pageNumber}</p>
          {activeRecord.priorSourceText === undefined ? null : <p className="reconciliation-workspace__source-text">
            <span className="sr-only">Original PDF text: </span>{activeRecord.priorSourceText}
          </p>}
        </section>
      </div>

      {detail.mode === "reattach" && candidate !== null ? <section className="reconciliation-workspace__resolution" data-reattachment-selection-mode>
        <p className="reconciliation-workspace__instruction" role={candidate.anchor === null ? "alert" : "status"}>
          {reattachmentInstruction(targetAnchor(activeRecord.value).kind, candidate)}
        </p>
        <div className="reconciliation-workspace__editor-actions">
          <button className="review-button review-button--secondary" type="button" title="Keep this annotation unresolved" disabled={pending} onClick={() => {
            setMessage(cancelledReattachmentPresentation().message);
            closeDetail();
          }}><ReviewIcon name="close" size={15} /><span>Cancel</span></button>
          <button className="review-button review-button--primary" type="button" title="Attach this annotation to the selected text" disabled={pending || candidate.anchor === null} onClick={() => {
            if (candidate.anchor === null) return;
            if (!reattachmentGenerationIsCurrent(detail.generation, props.state.workflow.documentGeneration)) {
              setMessage("The PDF changed. Select the text again.");
              return;
            }
            void submit(buildReattachmentCommand({
              target: activeRecord.target,
              stateRevision: props.state.revision,
              documentGeneration: props.state.workflow.documentGeneration,
              anchor: candidate.anchor,
              updatedAt: new Date().toISOString(),
            }), "Reattachment saved.");
          }}><ReviewIcon name="check" size={15} /><span>Confirm</span></button>
        </div>
      </section> : null}

      {detail.mode === "apply" && canApplyDraft ? <section className="reconciliation-workspace__resolution" data-apply-confirmation>
        <div className="reconciliation-workspace__editor-actions">
          <button className="review-button review-button--secondary" type="button" title="Keep this draft pending" disabled={pending} onClick={closeDetail}><ReviewIcon name="close" size={15} /><span>Cancel</span></button>
          <button className="review-button review-button--primary" type="button" title="Add this draft to the current PDF" disabled={pending} onClick={() => void submit({
            type: "apply-draft",
            expectedRevision: props.state.revision,
            id: draft.id,
            expectedDraftRevision: draft.revision,
            ownerViewId: draft.ownerViewId,
            updatedAt: new Date().toISOString(),
          }, "Draft applied as a Review Item.")}><ReviewIcon name="check" size={15} /><span>Apply</span></button>
        </div>
      </section> : null}

      {detail.mode === "discard" ? <section className="reconciliation-workspace__resolution" data-discard-confirmation>
        <p className="reconciliation-workspace__instruction">Discard this annotation from the reviewed PDF?</p>
        <div className="reconciliation-workspace__editor-actions">
          <button className="review-button review-button--secondary" type="button" title="Keep this annotation" disabled={pending} onClick={closeDetail}><ReviewIcon name="close" size={15} /><span>Cancel</span></button>
          <button className="review-button review-button--secondary reconciliation-workspace__destructive" type="button" title="Discard this annotation" disabled={pending} onClick={() => void submit(discardCommand(activeRecord.target), "Discard recorded.")}><ReviewIcon name="delete" size={15} /><span>Discard</span></button>
        </div>
      </section> : null}

      {message ? <p className="reconciliation-workspace__message" role="status">{message}</p> : null}
    </section>;
  }

  return <section className="reconciliation-workspace" data-reconciliation-workspace aria-label="Previous Annotations to Resolve">
    <header className="reconciliation-workspace__header annotation-drawer__header">
      <h2>Previous Annotations to Resolve</h2>
      <p data-document-freshness={props.state.workflow.freshness}>
        Generation {props.state.workflow.documentGeneration} is {props.state.workflow.freshness === "current" ? "current" : "possibly stale"}.
      </p>
    </header>
    {props.refreshStatus === "reconciling" ? <p className="reconciliation-workspace__notice" role="status">A rebuilt PDF is loading and previous annotations are reconciling.</p> : null}
    {props.refreshStatus === "failed" ? <p className="reconciliation-workspace__notice" role="alert">The rebuilt PDF could not be validated. The last successful PDF remains reviewable and may be stale.</p> : null}
    {records.length === 0 ? <p className="annotation-empty" data-reconciliation-status="empty">No previous annotations need attention.</p> : <ol className="reconciliation-workspace__list" aria-label="Previous annotations needing resolution">
      {records.map((record) => {
        const typeLabel = annotationKindLabel(record.kind);
        const canApplyDraft = !("payload" in record.value)
          && record.value.status === "protected"
          && record.value.disposition.kind === "resolved";
        return <li
          key={record.key}
          data-reconciliation-entry={record.key}
          {...(record.target.kind === "item"
            ? { "data-reconciliation-item": record.target.id }
            : { "data-reconciliation-draft": record.target.draft.id })}
          data-annotation-origin="previous"
          data-annotation-kind={record.kind}
          data-active="false"
          data-corresponding="false"
          data-item-copy-link="false"
        >
          <div className="annotation-item__content">
            <button
              ref={(node) => {
                if (node) entryRefs.current.set(record.key, node);
                else entryRefs.current.delete(record.key);
              }}
              type="button"
              className="annotation-item__navigation"
              aria-label={`${canApplyDraft ? "Apply" : "Reattach"} previous ${typeLabel} annotation on page ${record.pageNumber}`}
              title={canApplyDraft ? "Apply annotation" : "Reattach annotation"}
              onClick={() => openDetail(record, canApplyDraft ? "apply" : "reattach")}
            />
            <div className="annotation-item__title-row">
              <AnnotationMetadata kind={record.kind} pageNumber={record.pageNumber} sectionLabel={record.stateLabel} />
              <div className="annotation-item__title-actions" role="group" aria-label={`${typeLabel} resolution actions`}>
                <button
                  type="button"
                  className="annotation-item__action annotation-item__delete"
                  data-reconciliation-action="discard"
                  aria-label={`Discard ${typeLabel} annotation on page ${record.pageNumber}`}
                  title="Discard annotation"
                  onClick={() => openDetail(record, "discard")}
                ><ReviewIcon name="delete" size={13} /></button>
              </div>
            </div>
            <div className="annotation-item__body-row">
              <span className="annotation-item__excerpt">{record.authoredText}</span>
            </div>
          </div>
        </li>;
      })}
    </ol>}

    {message ? <p className="reconciliation-workspace__message" role="status">{message}</p> : null}
  </section>;
}
