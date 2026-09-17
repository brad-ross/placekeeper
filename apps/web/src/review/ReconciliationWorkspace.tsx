import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";

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
import {
  beginReviewInteraction,
  type ReviewInteractionHandle,
  type ReviewInteractionReceipt,
  type ReviewInteractionTransport,
} from "./authoring-session.js";
import type { CaretAnchor } from "../pdf/selection-anchor.js";
import { reliableSelection, type SelectionUpdate } from "../pdf/selection-state.js";
import { annotationKindLabel } from "./AnnotationMetadata.js";
import {
  AnnotationRowContent,
  type AnnotationAttentionPresentation,
} from "./AnnotationList.js";
import { ReviewIcon } from "./ReviewIcon.js";
import { ReviewTooltipButton } from "./ReviewTooltipButton.js";
import { existingAnnotationKey } from "../pdf/existing-annotations.js";

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

export function reconciliationCommandRejectionMessage(result: unknown): string | null {
  if (typeof result === "object" && result !== null && "accepted" in result && result.accepted === false) {
    return "message" in result && typeof result.message === "string"
      ? result.message
      : "The review state changed. Refresh the target and try again.";
  }
  return null;
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
  pdfAnnotation: "Imported PDF annotation",
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
  readonly activeAuthoringDraftId?: string;
  readonly selectionUpdate: SelectionUpdate;
  readonly caretAnchor?: CaretAnchor | null;
  readonly refreshStatus: GenerationRefreshStatus;
  readonly onCommand: (command: ReviewCommand) => Promise<unknown>;
  readonly focusRequestToken?: number;
  readonly onFocusFallback?: () => void;
  readonly interactionLifecycle?: ReviewInteractionTransport;
  readonly interactionLifecycleRequired?: boolean;
  readonly subscribeInteractionReconnect?: (
    listener: (identity: { readonly generation: number; readonly revision: number }) => Promise<void>,
  ) => () => void;
  readonly onDetailEscapeHandlerChange?: (handler: (() => void) | null) => void;
  readonly renderSummary: (summary: ReconciliationSummaryPresentation) => ReactNode;
}

export type ReconciliationSummaryPresentation = AnnotationAttentionPresentation;

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

export function reconciliationFocusKeyAfterRemoval(
  keys: readonly string[],
  removedKey: string,
): string | null {
  const index = keys.indexOf(removedKey);
  if (index < 0) return null;
  return keys[index + 1] ?? keys[index - 1] ?? null;
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
    ).map((item): ResolutionRecord => {
      const text = authoredText(item);
      return {
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
        authoredText: text,
        priorSourceText: meaningfulPriorSourceText(item, text),
        stateLabel: resolutionStateLabel(item),
      };
    }),
    ...props.state.pendingDrafts.filter(
      (draft) => draft.id !== props.activeAuthoringDraftId
        || draft.status !== "protected"
        || draft.disposition.kind !== "resolved",
    ).map((draft): ResolutionRecord => {
      const text = authoredText(draft);
      return {
        key: `draft:${draft.id}`,
        target: { kind: "draft", draft },
        value: draft,
        kind: draft.kind,
        pageNumber: draft.pageIndex + 1,
        authoredText: text,
        priorSourceText: meaningfulPriorSourceText(draft, text),
        stateLabel: resolutionStateLabel(draft),
      };
    }),
  ], [props.activeAuthoringDraftId, props.state.items, props.state.pendingDrafts]);
  const recordsByKey = useMemo(
    () => new Map(records.map((record) => [record.key, record] as const)),
    [records],
  );
  const [detail, setDetail] = useState<ResolutionDetail | null>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  pendingRef.current = pending;
  const entryRefs = useRef(new Map<string, HTMLButtonElement>());
  const editorRef = useRef<HTMLElement>(null);
  const returnFocusKeyRef = useRef<string | null>(null);
  const acceptedFocusKeyRef = useRef<string | null>(null);
  const acceptedFocusPendingRef = useRef(false);
  const interactionRef = useRef<ReviewInteractionHandle | null>(null);
  const interactionAdmissionPendingRef = useRef(false);
  const terminalAttemptRef = useRef<{
    readonly interaction: ReviewInteractionHandle;
    readonly draftId: string;
    readonly expectedDraftRevision: number;
  } | null>(null);
  const mountedRef = useRef(true);
  const automaticTerminalRetryKeyRef = useRef<string | null>(null);
  const priorRecordKeysRef = useRef(records.map(({ key }) => key));
  const onFocusFallbackRef = useRef(props.onFocusFallback);
  onFocusFallbackRef.current = props.onFocusFallback;
  const pendingReceiptRef = useRef<{
    readonly interaction: ReviewInteractionHandle;
    readonly receipt: ReviewInteractionReceipt;
  } | null>(null);
  const closeDetailRef = useRef<() => Promise<void>>(async () => undefined);
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
  const detailFocusIdentity = detail === null || activeRecord === undefined
    ? null
    : `${detail.key}:${detail.mode}:${detail.generation}`;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const terminal = terminalAttemptRef.current;
      const interaction = interactionRef.current;
      if (terminal !== null) {
        void terminal.interaction.finalize(
          'applied', terminal.draftId, terminal.expectedDraftRevision,
        ).then((receipt) => terminal.interaction.acknowledge(receipt)).catch(() => undefined);
      } else {
        void interaction?.release().catch(() => undefined);
      }
    };
  }, []);
  useEffect(() => {
    const pendingReceipt = pendingReceiptRef.current;
    if (pendingReceipt === null) return;
    void pendingReceipt.interaction.acknowledge(pendingReceipt.receipt).then(() => {
      if (pendingReceiptRef.current === pendingReceipt) pendingReceiptRef.current = null;
    }).catch(() => undefined);
  }, [props.interactionLifecycle, props.state.workflow.documentGeneration]);

  useLayoutEffect(() => {
    if (detail === null || activeRecord !== undefined) {
      priorRecordKeysRef.current = records.map(({ key }) => key);
    }
  }, [activeRecord, detail, records]);

  useLayoutEffect(() => {
    if (detail !== null && activeRecord === undefined) {
      if (pending || terminalAttemptRef.current !== null) return;
      const returnFocusKey = reconciliationFocusKeyAfterRemoval(
        priorRecordKeysRef.current,
        detail.key,
      );
      const interaction = interactionRef.current;
      interactionRef.current = null;
      automaticTerminalRetryKeyRef.current = null;
      returnFocusKeyRef.current = null;
      acceptedFocusKeyRef.current = null;
      acceptedFocusPendingRef.current = false;
      setMessage("");
      setDetail(null);
      void interaction?.release().catch(() => undefined);
      if (returnFocusKey === null) onFocusFallbackRef.current?.();
      else entryRefs.current.get(returnFocusKey)?.focus({ preventScroll: true });
      return;
    }
    const returnFocusKey = returnFocusKeyRef.current;
    if (returnFocusKey !== null) {
      entryRefs.current.get(returnFocusKey)?.focus({ preventScroll: true });
      returnFocusKeyRef.current = null;
      return;
    }
    if (detail !== null || pending || !acceptedFocusPendingRef.current) return;
    const acceptedFocusKey = acceptedFocusKeyRef.current;
    if (acceptedFocusKey === null) {
      acceptedFocusPendingRef.current = false;
      props.onFocusFallback?.();
      return;
    }
    const acceptedFocusTarget = entryRefs.current.get(acceptedFocusKey);
    if (acceptedFocusTarget === undefined) {
      acceptedFocusPendingRef.current = false;
      acceptedFocusKeyRef.current = null;
      props.onFocusFallback?.();
      return;
    }
    acceptedFocusPendingRef.current = false;
    acceptedFocusKeyRef.current = null;
    acceptedFocusTarget.focus({ preventScroll: true });
  }, [activeRecord, detail, pending, props.onFocusFallback, records]);

  useLayoutEffect(() => {
    if (detailFocusIdentity === null) return;
    editorRef.current?.querySelector<HTMLElement>('button:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, [detailFocusIdentity]);

  useLayoutEffect(() => {
    if (props.focusRequestToken === undefined || props.focusRequestToken === 0) return;
    const frame = requestAnimationFrame(() => {
      const first = records[0];
      if (first === undefined) props.onFocusFallback?.();
      else entryRefs.current.get(first.key)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.focusRequestToken]);

  const openDetail = async (record: ResolutionRecord, mode: ResolutionMode) => {
    if (pending || interactionAdmissionPendingRef.current || interactionRef.current !== null) return;
    setMessage("");
    returnFocusKeyRef.current = null;
    if (mode === 'reattach' && props.interactionLifecycleRequired && props.interactionLifecycle === undefined) {
      setMessage('The annotation safety connection is still starting. Try again.');
      return;
    }
    if (mode === 'reattach' && props.interactionLifecycle !== undefined) {
      interactionAdmissionPendingRef.current = true;
      setPending(true);
      try {
        const interaction = await beginReviewInteraction(
          props.interactionLifecycle,
          props.state.workflow.documentGeneration,
          `reattach_${crypto.randomUUID()}`,
        );
        if (!mountedRef.current) {
          await interaction.release().catch(() => undefined);
          return;
        }
        interactionRef.current = interaction;
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Reattachment could not start safely.');
        return;
      } finally {
        interactionAdmissionPendingRef.current = false;
        setPending(false);
      }
    }
    setDetail({
      key: record.key,
      mode,
      generation: props.state.workflow.documentGeneration,
    });
  };
  const closeDetail = async () => {
    if (pending) return;
    if (detail !== null) returnFocusKeyRef.current = detail.key;
    const terminal = terminalAttemptRef.current;
    if (terminal !== null) {
      setPending(true);
      try {
        await settleReattachment(terminal);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Reattachment completion is still pending.');
      } finally {
        setPending(false);
      }
      return;
    }
    const interaction = interactionRef.current;
    interactionRef.current = null;
    void interaction?.release().catch(() => undefined);
    setDetail(null);
  };
  closeDetailRef.current = closeDetail;

  useLayoutEffect(() => {
    if (detail === null) {
      props.onDetailEscapeHandlerChange?.(null);
      return;
    }
    const handler = () => {
      if (!pendingRef.current) void closeDetailRef.current();
    };
    props.onDetailEscapeHandlerChange?.(handler);
    return () => props.onDetailEscapeHandlerChange?.(null);
  }, [detail, props.onDetailEscapeHandlerChange]);

  const settleReattachment = async (terminal: NonNullable<typeof terminalAttemptRef.current>) => {
    const receipt = await terminal.interaction.finalize(
      'applied', terminal.draftId, terminal.expectedDraftRevision,
    );
    terminalAttemptRef.current = null;
    interactionRef.current = null;
    setDetail(null);
    pendingReceiptRef.current = { interaction: terminal.interaction, receipt };
    await terminal.interaction.acknowledge(receipt);
    pendingReceiptRef.current = null;
  };

  useEffect(() => props.subscribeInteractionReconnect?.(async ({ generation }) => {
    const interaction = interactionRef.current;
    if (interaction === null) return;
    setPending(true);
    try {
      if (!reattachmentGenerationIsCurrent(interaction.generation, generation)) {
        throw new Error('The PDF changed. Select the text again.');
      }
      const receipt = await interaction.reacquire();
      if (receipt === undefined) return;
      if (receipt.generation !== interaction.generation || receipt.outcome !== 'applied') {
        throw new Error('The saved reattachment receipt did not match this editor.');
      }
      terminalAttemptRef.current = null;
      interactionRef.current = null;
      setDetail(null);
      pendingReceiptRef.current = { interaction, receipt };
      await interaction.acknowledge(receipt);
      pendingReceiptRef.current = null;
    } catch (error) {
      terminalAttemptRef.current = null;
      interactionRef.current = null;
      await interaction.release().catch(() => undefined);
      setDetail(null);
      setMessage(error instanceof Error
        ? error.message
        : 'Reattachment could not resume safely. Select the target again.');
    } finally {
      setPending(false);
    }
  }), [props.subscribeInteractionReconnect]);

  useEffect(() => {
    const terminal = terminalAttemptRef.current;
    if (pending || terminal === null) return;
    const retryKey = `${props.state.workflow.documentGeneration}:${props.state.revision}`;
    if (automaticTerminalRetryKeyRef.current === retryKey) return;
    automaticTerminalRetryKeyRef.current = retryKey;
    setPending(true);
    void settleReattachment(terminal).catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : 'Reattachment completion is still pending.');
    }).finally(() => setPending(false));
  }, [
    pending,
    props.interactionLifecycle,
    props.state.revision,
    props.state.workflow.documentGeneration,
  ]);

  const submitReattachment = async (record: ResolutionRecord, anchor: ReviewAnchorEvidenceV1) => {
    const interaction = interactionRef.current;
    if (interaction === null) {
      await submit(buildReattachmentCommand({
        target: record.target,
        stateRevision: props.state.revision,
        documentGeneration: props.state.workflow.documentGeneration,
        anchor,
        updatedAt: new Date().toISOString(),
      }));
      return;
    }
    setPending(true);
    setMessage('');
    try {
      if (terminalAttemptRef.current !== null) {
        await settleReattachment(terminalAttemptRef.current);
        return;
      }
      if (!reattachmentGenerationIsCurrent(interaction.generation, props.state.workflow.documentGeneration)) {
        throw new Error('The PDF changed. Select the text again.');
      }
      const now = new Date().toISOString();
      const existingDraft = record.target.kind === 'draft' ? record.target.draft : undefined;
      const draftId = existingDraft?.id ?? crypto.randomUUID();
      const result = await props.onCommand({
        type: 'put-draft',
        expectedRevision: props.state.revision,
        expectedDraftRevision: existingDraft?.revision ?? -1,
        draft: {
          id: draftId,
          ownerViewId: interaction.ownerViewId,
          baseGeneration: props.state.workflow.documentGeneration,
          revision: existingDraft?.revision ?? 0,
          kind: record.kind,
          ...(record.target.kind === 'item' ? { targetItemId: record.target.id } : {}),
          pageIndex: anchor.pageIndex,
          text: record.authoredText,
          anchor,
          disposition: { kind: 'resolved', generation: props.state.workflow.documentGeneration },
          status: 'protected',
          createdAt: existingDraft?.createdAt ?? now,
          updatedAt: now,
        },
      });
      const rejection = reconciliationCommandRejectionMessage(result);
      if (rejection !== null) throw new Error(rejection);
      const next = result as ReviewState;
      const protectedDraft = next.pendingDrafts.find(({ id }) => id === draftId);
      if (protectedDraft === undefined) throw new Error('The reattachment draft was not acknowledged.');
      acceptedFocusKeyRef.current = reconciliationFocusKeyAfterRemoval(
        records.map(({ key }) => key),
        record.key,
      );
      acceptedFocusPendingRef.current = true;
      terminalAttemptRef.current = {
        interaction,
        draftId: protectedDraft.id,
        expectedDraftRevision: protectedDraft.revision,
      };
      automaticTerminalRetryKeyRef.current = null;
      await settleReattachment(terminalAttemptRef.current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Reattachment could not be saved.');
    } finally {
      setPending(false);
    }
  };
  const submit = async (command: ReviewCommand) => {
    acceptedFocusKeyRef.current = detail === null
      ? null
      : reconciliationFocusKeyAfterRemoval(records.map(({ key }) => key), detail.key);
    setPending(true);
    setMessage("");
    try {
      const result = await props.onCommand(command);
      const rejectionMessage = reconciliationCommandRejectionMessage(result);
      if (rejectionMessage !== null) {
        acceptedFocusKeyRef.current = null;
        acceptedFocusPendingRef.current = false;
        setMessage(rejectionMessage);
        return;
      }
      acceptedFocusPendingRef.current = true;
      setDetail(null);
      returnFocusKeyRef.current = null;
    } catch {
      acceptedFocusKeyRef.current = null;
      acceptedFocusPendingRef.current = false;
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

  const notice = props.refreshStatus === "reconciling"
    ? <p className="reconciliation-workspace__notice" role="status">A rebuilt PDF is loading and previous annotations are reconciling.</p>
    : props.refreshStatus === "failed"
      ? <p className="reconciliation-workspace__notice" role="alert">The rebuilt PDF could not be validated. The last successful PDF remains reviewable and may be stale.</p>
      : null;
  const rows = records.map((record) => {
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
          <AnnotationRowContent
            item={"payload" in record.value ? record.value : {
              id: record.value.id,
              kind: record.value.kind,
              pageIndex: record.value.pageIndex,
              payload: { comment: record.authoredText },
              createdAt: record.value.createdAt,
              updatedAt: record.value.updatedAt,
            }}
            presentation={{ content: record.authoredText }}
            pageNumber={record.pageNumber}
            readerRecord={null}
            statusIcon="warning"
            statusIconLabel={record.stateLabel}
            navigationRef={(node) => {
              if (node) entryRefs.current.set(record.key, node);
              else entryRefs.current.delete(record.key);
            }}
            navigationFocusToken={`reconciliation:${record.key}`}
            navigationExpanded={detail?.key === record.key}
            navigationDisabled={pending}
            {...(detail?.key === record.key
              ? { navigationControls: `reconciliation-editor-${record.key.replace(':', '-')}` }
              : {})}
            navigationLabel={`${canApplyDraft ? "Apply" : "Reattach"} previous ${typeLabel} annotation on page ${record.pageNumber} · ${record.stateLabel}`}
            navigationTitle={canApplyDraft ? "Apply annotation" : "Reattach annotation"}
            onNavigate={() => { void openDetail(record, canApplyDraft ? "apply" : "reattach"); }}
            extraActions={[{
              id: "discard",
              kind: "command",
              icon: "remove",
              label: `Discard ${typeLabel} annotation on page ${record.pageNumber}`,
              title: "Discard annotation",
              disabled: pending,
              onInvoke: () => { void openDetail(record, "discard"); },
            }]}
          />
      </li>;
  });
  const messageNode = message && activeRecord === undefined
    ? <p className="reconciliation-workspace__message" role="status">{message}</p>
    : null;
  const existingAnnotationKeys = useMemo(() => records.flatMap((record) => record.target.kind === "item"
    ? [existingAnnotationKey({ id: record.target.id, pageIndex: record.pageNumber - 1 })]
    : []), [records]);
  const ownedItemIds = useMemo(() => records.flatMap((record) => record.target.kind === "item"
    ? [record.target.id]
    : []), [records]);
  let editor: ReactElement | null = null;
  if (activeRecord !== undefined && detail !== null) {
    const typeLabel = annotationKindLabel(activeRecord.kind);
    const draft = "payload" in activeRecord.value ? undefined : activeRecord.value;
    const canApplyDraft = draft?.status === "protected" && draft.disposition.kind === "resolved";
    const title = detail.mode === "reattach"
      ? reattachmentTitle(activeRecord.kind)
      : `${detail.mode === "apply" ? "Apply" : "Discard"} ${typeLabel.toLocaleLowerCase()}`;
    editor = <section
      ref={editorRef}
      id={`reconciliation-editor-${activeRecord.key.replace(':', '-')}`}
      className="reconciliation-workspace reconciliation-workspace--detail full-annotation-reader"
      data-reconciliation-workspace
      data-reconciliation-reader
      data-reconciliation-detail={detail.mode}
      data-full-annotation-reader="true"
      role="region"
      aria-label={`${title}, previously page ${activeRecord.pageNumber}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || pending) return;
        event.preventDefault();
        event.stopPropagation();
        void closeDetail();
      }}
    >
      <header className="reconciliation-workspace__detail-header full-annotation-reader__metadata-bar">
        <ReviewTooltipButton
          type="button"
          className="full-annotation-reader__back"
          data-full-annotation-action="back"
          label="Back"
          tooltip="Back to annotations"
          disabled={pending}
          onClick={() => { void closeDetail(); }}
        ><ReviewIcon name="arrow-left" size={16} /></ReviewTooltipButton>
        <h2>{title}</h2>
      </header>
      <div className="full-annotation-reader__body">
        {message ? <p className="reconciliation-workspace__message" role="status">{message}</p> : null}
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
        <div className="comment-composer__actions reconciliation-workspace__editor-actions">
          <button className="review-button review-button--secondary" type="button" title="Cancel" disabled={pending} onClick={closeDetail}><span>Cancel</span></button>
          <button
            className="review-button review-button--primary"
            type="button"
            title="Attach this annotation to the selected text"
            disabled={pending || candidate.anchor === null}
            onClick={() => {
              if (candidate.anchor === null) return;
              if (!reattachmentGenerationIsCurrent(detail.generation, props.state.workflow.documentGeneration)) {
                setMessage("The PDF changed. Select the text again.");
                return;
              }
              void submitReattachment(activeRecord, candidate.anchor);
            }}
          >{pending ? <ReviewIcon name="loading" /> : null}<span>Attach</span></button>
        </div>
      </section> : null}
      {detail.mode === "apply" && canApplyDraft ? <section className="reconciliation-workspace__resolution" data-apply-confirmation>
        <div className="comment-composer__actions reconciliation-workspace__editor-actions">
          <button className="review-button review-button--secondary" type="button" title="Cancel" disabled={pending} onClick={closeDetail}><span>Cancel</span></button>
          <button className="review-button review-button--primary" type="button" title="Add this draft to the current PDF" disabled={pending} onClick={() => void submit({
            type: "apply-draft",
            expectedRevision: props.state.revision,
            id: draft.id,
            expectedDraftRevision: draft.revision,
            ownerViewId: draft.ownerViewId,
            updatedAt: new Date().toISOString(),
          })}>{pending ? <ReviewIcon name="loading" /> : null}<span>Apply</span></button>
        </div>
      </section> : null}
      {detail.mode === "discard" ? <section className="reconciliation-workspace__resolution" data-discard-confirmation>
        <p className="reconciliation-workspace__instruction">Discard this annotation from the reviewed PDF?</p>
        <div className="comment-composer__actions reconciliation-workspace__editor-actions">
          <button className="review-button review-button--secondary" type="button" title="Cancel" disabled={pending} onClick={closeDetail}><span>Cancel</span></button>
          <button className="review-button review-button--secondary reconciliation-workspace__destructive" type="button" title="Discard this annotation" disabled={pending} onClick={() => void submit(discardCommand(activeRecord.target))}><span>Discard</span></button>
        </div>
      </section> : null}
    </section>;
  }
  return props.renderSummary({
    count: records.length,
    rows,
    notice,
    message: messageNode,
    editor,
    ownedItemIds,
    existingAnnotationKeys,
  });
}
