import { hasSafePortableAnnotationShape } from "./portable-annotation-shape.js";
import { projectReviewItems } from "./annotation-projection.js";
import { assertPortableAnnotationWritable, PORTABLE_ANNOTATION_MAX_BYTES } from "./portable-annotation.js";
import { canEditPdfAnnotationComment, canDeletePdfAnnotation } from './native-pdf-annotation.js';
import {
  canonicalizeReviewItem,
  normalizeAnnotationName,
  reviewSelectionPayload,
  synchronizeReviewItemAnchor,
  type JsonValue,
  type PendingReviewDraftV1,
  type ReviewAnchorEvidenceV1,
  type ReviewCommand,
  type ReviewDiscardAuditV1,
  type ReviewItem,
  type ReviewState,
} from "./review-model.js";
import {
  assertDisposition,
  assertReviewAnchorEvidence,
  assertReviewItem,
  InvalidReviewCommandError,
} from './review-item-validation.js';
export {
  assertReviewAnchorEvidence,
  assertReviewItem,
  InvalidReviewCommandError,
  MAX_REVIEW_SELECTION_SEGMENTS,
} from './review-item-validation.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class ReviewConflictError extends Error {
  readonly code = "REVISION_CONFLICT";

  constructor(expected: number, actual: number) {
    super(`Expected review revision ${expected}, but current revision is ${actual}`);
    this.name = "ReviewConflictError";
  }
}

export class ReviewDraftConflictError extends Error {
  readonly code = "DRAFT_REVISION_CONFLICT";

  constructor(expected: number, actual: number) {
    super(`Expected draft revision ${expected}, but current draft revision is ${actual}`);
    this.name = "ReviewDraftConflictError";
  }
}

function assertMutable(state: ReviewState, command: ReviewCommand): void {
  if (state.lifecycle !== "active") {
    throw new InvalidReviewCommandError("A completed review cannot be mutated");
  }
  if (command.expectedRevision !== state.revision) {
    throw new ReviewConflictError(command.expectedRevision, state.revision);
  }
}

function assertAnchorMatchesReviewItem(item: ReviewItem, anchor: ReviewAnchorEvidenceV1): void {
  const expectedKind = item.kind === "insert"
    ? "caret"
    : (item.kind === "pageNote" || item.kind === "pdfAnnotation")
      ? "page"
      : "selection";
  if (anchor.kind !== expectedKind) {
    throw new InvalidReviewCommandError(`Review item ${item.kind} requires a ${expectedKind} anchor`);
  }
}

function assertDraft(draft: PendingReviewDraftV1): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(draft.id) ||
    draft.ownerViewId.length === 0 ||
    !Number.isSafeInteger(draft.baseGeneration) || draft.baseGeneration < 0 ||
    !Number.isSafeInteger(draft.revision) || draft.revision < 0 ||
    !Number.isFinite(Date.parse(draft.createdAt)) || !Number.isFinite(Date.parse(draft.updatedAt)) ||
    (draft.targetItemId !== undefined && draft.targetItemId.length === 0)
  ) throw new InvalidReviewCommandError("Pending review draft is malformed");
  assertReviewAnchorEvidence(draft.anchor);
  assertDisposition(draft.disposition);
}

export function assertReviewCommand(command: unknown): asserts command is ReviewCommand {
  if (
    !isRecord(command) ||
    !Number.isSafeInteger(command.expectedRevision) ||
    (command.expectedRevision as number) < 0
  ) {
    throw new InvalidReviewCommandError("Review command is malformed");
  }
  switch (command.type) {
    case "set-annotation-name":
      if (typeof command.annotationName !== "string") throw new InvalidReviewCommandError("Annotation name must be text");
      return;
    case "add":
      if (!isRecord(command.item) || !isRecord(command.item.payload)) {
        throw new InvalidReviewCommandError("Review command is malformed");
      }
      return;
    case "put-draft":
      if (!isRecord(command.draft)) throw new InvalidReviewCommandError("Review command is malformed");
      return;
    case "apply-draft":
      if (
        typeof command.id !== "string" ||
        !Number.isSafeInteger(command.expectedDraftRevision) ||
        typeof command.ownerViewId !== "string" ||
        typeof command.updatedAt !== "string"
      ) throw new InvalidReviewCommandError("Review command is malformed");
      return;
    case "reattach":
      if (
        typeof command.id !== "string" ||
        !Number.isSafeInteger(command.expectedReconciliationRevision) ||
        typeof command.ownerViewId !== "string" ||
        typeof command.updatedAt !== "string" ||
        !isRecord(command.anchor)
      ) throw new InvalidReviewCommandError("Review command is malformed");
      return;
    case "discard-reconciliation":
      if (
        (command.target !== "item" && command.target !== "draft") ||
        typeof command.id !== "string" ||
        !Number.isSafeInteger(command.expectedTargetRevision) ||
        typeof command.ownerViewId !== "string" ||
        typeof command.reason !== "string" ||
        typeof command.discardedAt !== "string"
      ) throw new InvalidReviewCommandError("Review command is malformed");
      return;
    case "edit":
      if (
        typeof command.id !== "string" ||
        typeof command.updatedAt !== "string" ||
        !isRecord(command.payload)
      ) {
        throw new InvalidReviewCommandError("Review command is malformed");
      }
      return;
    case "remove":
      if (typeof command.id !== "string") {
        throw new InvalidReviewCommandError("Review command is malformed");
      }
      return;
    case "undo":
    case "redo":
      return;
    default:
      throw new InvalidReviewCommandError("Review command type is not supported");
  }
}

export function reduceReview(
  state: ReviewState,
  command: ReviewCommand,
): ReviewState {
  assertReviewCommand(command);
  assertMutable(state, command);

  if (command.type === "set-annotation-name") {
    const annotationName = normalizeAnnotationName(command.annotationName);
    if (!hasSafePortableAnnotationShape(annotationName) || new TextEncoder().encode(JSON.stringify(annotationName)).byteLength > PORTABLE_ANNOTATION_MAX_BYTES) {
      throw new InvalidReviewCommandError("Annotation name is too long");
    }
    for (const annotation of projectReviewItems(state.items, undefined, { annotationName })) {
      assertPortableAnnotationWritable(annotation);
    }
    if (state.annotationName === annotationName) return state;
    return { ...state, annotationName, revision: state.revision + 1 };
  }

  const history = state.history;
  const historyCursor = state.historyCursor;

  if (command.type === "undo") {
    if (historyCursor <= state.workflow.historyBoundary) {
      if (state.workflow.historyBoundary > 0) {
        throw new InvalidReviewCommandError("Undo cannot cross the rebuild history boundary");
      }
      throw new InvalidReviewCommandError("There is no review command to undo");
    }
    const entry = history[historyCursor - 1]!;
    return {
      ...state,
      revision: state.revision + 1,
      items: entry.beforeItems,
      pendingDrafts: entry.beforePendingDrafts ?? state.pendingDrafts,
      discardAudit: entry.beforeDiscardAudit ?? state.discardAudit,
      history,
      historyCursor: historyCursor - 1,
    };
  }
  if (command.type === "redo") {
    if (historyCursor >= history.length) {
      throw new InvalidReviewCommandError("There is no review command to redo");
    }
    const entry = history[historyCursor]!;
    return {
      ...state,
      revision: state.revision + 1,
      items: entry.afterItems,
      pendingDrafts: entry.afterPendingDrafts ?? state.pendingDrafts,
      discardAudit: entry.afterDiscardAudit ?? state.discardAudit,
      history,
      historyCursor: historyCursor + 1,
    };
  }

  let items: readonly ReviewItem[] = state.items;
  let pendingDrafts: readonly PendingReviewDraftV1[] = state.pendingDrafts;
  let discardAudit: readonly ReviewDiscardAuditV1[] = state.discardAudit;
  switch (command.type) {
    case "add": {
      assertReviewItem(command.item);
      if (state.items.some((item) => item.id === command.item.id)) {
        throw new InvalidReviewCommandError("Review item ID already exists");
      }
      const authoring = command.authoring ?? {
        ownerViewId: "legacy-view",
        baseGeneration: state.workflow.documentGeneration,
      };
      if (authoring.baseGeneration !== state.workflow.documentGeneration) {
        throw new InvalidReviewCommandError("Review item authoring belongs to a stale document generation");
      }
      items = [
        ...state.items,
        canonicalizeReviewItem(command.item, authoring),
      ];
      break;
    }
    case "put-draft": {
      assertDraft(command.draft);
      if (command.draft.baseGeneration !== state.workflow.documentGeneration || command.draft.status !== "protected") {
        throw new InvalidReviewCommandError("Pending authoring belongs to a stale document generation");
      }
      const index = state.pendingDrafts.findIndex(({ id }) => id === command.draft.id);
      const currentRevision = index < 0 ? -1 : state.pendingDrafts[index]!.revision;
      if (currentRevision !== command.expectedDraftRevision) {
        throw new ReviewDraftConflictError(command.expectedDraftRevision, currentRevision);
      }
      const nextDraft = index < 0
        ? command.draft
        : { ...command.draft, revision: currentRevision + 1 };
      pendingDrafts = index < 0
        ? [...state.pendingDrafts, nextDraft]
        : state.pendingDrafts.map((draft, draftIndex) => draftIndex === index ? nextDraft : draft);
      break;
    }
    case "apply-draft": {
      const draft = state.pendingDrafts.find(({ id }) => id === command.id);
      if (draft === undefined) throw new InvalidReviewCommandError("Pending review draft does not exist");
      if (
        draft.revision !== command.expectedDraftRevision ||
        draft.ownerViewId !== command.ownerViewId
      ) {
        throw new ReviewDraftConflictError(command.expectedDraftRevision, draft.revision);
      }
      if (
        draft.baseGeneration !== state.workflow.documentGeneration ||
        draft.status !== "protected" ||
        draft.disposition.kind !== "resolved" ||
        draft.disposition.generation !== state.workflow.documentGeneration
      ) {
        throw new InvalidReviewCommandError("Pending review draft must be reattached before Apply");
      }
      const anchorPayload: Readonly<Record<string, JsonValue>> = draft.anchor.kind === "selection"
        ? reviewSelectionPayload(draft.anchor, { canonical: true })
        : draft.anchor.kind === "caret"
          ? {
              position: { ...draft.anchor.rect },
              leftContext: draft.anchor.leftContext,
              rightContext: draft.anchor.rightContext,
              reliable: true,
            }
          : {
              position: { ...draft.anchor.rect },
              ...(draft.anchor.nearbyText === undefined ? {} : { nearbyText: draft.anchor.nearbyText }),
            };
      const textField = draft.kind === "replace" || draft.kind === "insert"
        ? "proposedText"
        : "comment";
      if (draft.targetItemId === undefined) {
        if (draft.kind === "delete") {
          throw new InvalidReviewCommandError("Deletion cannot be applied from a text draft");
        }
        const item: ReviewItem = {
          id: draft.id,
          kind: draft.kind,
          pageIndex: draft.anchor.pageIndex,
          createdAt: draft.createdAt,
          updatedAt: command.updatedAt,
          payload: { ...anchorPayload, [textField]: draft.text },
          reconciliation: {
            schemaVersion: 1,
            ownerViewId: draft.ownerViewId,
            baseGeneration: draft.baseGeneration,
            revision: draft.revision,
            anchor: draft.anchor,
            disposition: draft.disposition,
            previousAnchors: [],
          },
        };
        assertReviewItem(item);
        if (state.items.some(({ id }) => id === item.id)) {
          throw new InvalidReviewCommandError("Review item ID already exists");
        }
        items = [...state.items, item];
      } else {
        const itemIndex = state.items.findIndex(({ id }) => id === draft.targetItemId);
        if (itemIndex < 0) throw new InvalidReviewCommandError("Edited Review Item no longer exists");
        const existing = state.items[itemIndex]!;
        if (!canEditPdfAnnotationComment(existing)) throw new InvalidReviewCommandError("This PDF annotation comment is locked");
        if (existing.kind !== draft.kind || existing.kind === "delete") {
          throw new InvalidReviewCommandError("Pending review draft kind does not match its Review Item");
        }
        const edited: ReviewItem = {
          ...existing,
          pageIndex: draft.anchor.pageIndex,
          updatedAt: command.updatedAt,
          payload: { ...existing.payload, ...anchorPayload, [textField]: draft.text },
          ...(existing.reconciliation === undefined ? {} : {
            reconciliation: {
              ...existing.reconciliation,
              ownerViewId: draft.ownerViewId,
              revision: existing.reconciliation.revision + 1,
              anchor: draft.anchor,
              disposition: draft.disposition,
            },
          }),
        };
        assertReviewItem(edited);
        items = state.items.map((item, index) => index === itemIndex
          ? edited
          : item);
      }
      pendingDrafts = state.pendingDrafts.filter(({ id }) => id !== draft.id);
      break;
    }
    case "reattach": {
      const index = state.items.findIndex(({ id }) => id === command.id);
      if (index < 0) throw new InvalidReviewCommandError("Review item does not exist");
      const existing = canonicalizeReviewItem(state.items[index]!, {
        ownerViewId: command.ownerViewId,
        baseGeneration: state.workflow.documentGeneration,
      });
      const reconciliation = existing.reconciliation!;
      if (reconciliation.revision !== command.expectedReconciliationRevision) {
        throw new ReviewDraftConflictError(command.expectedReconciliationRevision, reconciliation.revision);
      }
      assertReviewAnchorEvidence(command.anchor);
      assertAnchorMatchesReviewItem(existing, command.anchor);
      const synchronized = synchronizeReviewItemAnchor(existing, command.anchor);
      const reattached: ReviewItem = {
        ...synchronized,
        updatedAt: command.updatedAt,
        reconciliation: {
          ...reconciliation,
          ownerViewId: command.ownerViewId,
          revision: reconciliation.revision + 1,
          anchor: command.anchor,
          disposition: { kind: "resolved", generation: state.workflow.documentGeneration },
        },
      };
      assertReviewItem(reattached);
      items = state.items.map((item, itemIndex) => itemIndex === index ? reattached : item);
      break;
    }
    case "discard-reconciliation": {
      if (command.reason.trim().length === 0 || !Number.isFinite(Date.parse(command.discardedAt))) {
        throw new InvalidReviewCommandError("Discard audit metadata is malformed");
      }
      const collection = command.target === "item" ? state.items : state.pendingDrafts;
      const target = collection.find(({ id }) => id === command.id);
      if (target === undefined) throw new InvalidReviewCommandError("Review reconciliation target does not exist");
      const targetRevision = command.target === "item"
        ? canonicalizeReviewItem(target as ReviewItem, {
            ownerViewId: command.ownerViewId,
            baseGeneration: state.workflow.documentGeneration,
          }).reconciliation!.revision
        : (target as PendingReviewDraftV1).revision;
      if (targetRevision !== command.expectedTargetRevision) {
        throw new ReviewDraftConflictError(command.expectedTargetRevision, targetRevision);
      }
      if (command.target === "item") items = state.items.filter(({ id }) => id !== command.id);
      else pendingDrafts = state.pendingDrafts.filter(({ id }) => id !== command.id);
      discardAudit = [...state.discardAudit, {
        target: command.target,
        id: command.id,
        generation: state.workflow.documentGeneration,
        revision: state.revision + 1,
        ownerViewId: command.ownerViewId,
        reason: command.reason,
        discardedAt: command.discardedAt,
      }];
      break;
    }
    case "edit": {
      const index = state.items.findIndex((item) => item.id === command.id);
      if (index < 0) {
        throw new InvalidReviewCommandError("Review item does not exist");
      }
      const existing = state.items[index]!;
      if (!canEditPdfAnnotationComment(existing)) throw new InvalidReviewCommandError('This PDF annotation comment is locked');
      const mutable = existing.kind === 'replace' || existing.kind === 'insert'
        ? ['proposedText']
        : existing.kind === 'highlight' || existing.kind === 'pageNote' || existing.kind === 'pdfAnnotation'
          ? ['comment']
          : [];
      if (Object.keys(command.payload).length === 0 || Object.keys(command.payload).some((key) => !mutable.includes(key))) {
        throw new InvalidReviewCommandError("Only proposed text or comments may be edited");
      }
      const edited: ReviewItem = {
        ...existing,
        payload: { ...existing.payload, ...command.payload },
        updatedAt: command.updatedAt,
      };
      assertReviewItem(edited);
      items = state.items.map((item, itemIndex) => itemIndex === index ? edited : item);
      break;
    }
    case "remove": {
      if (!state.items.some((item) => item.id === command.id)) {
        throw new InvalidReviewCommandError("Review item does not exist");
      }
      const existing = state.items.find((item) => item.id === command.id)!;
      if (!canDeletePdfAnnotation(existing)) throw new InvalidReviewCommandError('This PDF annotation is locked against deletion');
      items = state.items.filter((item) => item.id !== command.id);
      break;
    }
    default:
      throw new InvalidReviewCommandError("Review command type is not supported");
  }

  const retainedHistory = history.slice(0, historyCursor);
  return {
    ...state,
    revision: state.revision + 1,
    items,
    pendingDrafts,
    discardAudit,
    history: [...retainedHistory, {
      beforeItems: state.items,
      afterItems: items,
      generation: state.workflow.documentGeneration,
      beforePendingDrafts: state.pendingDrafts,
      afterPendingDrafts: pendingDrafts,
      beforeDiscardAudit: state.discardAudit,
      afterDiscardAudit: discardAudit,
    }],
    historyCursor: retainedHistory.length + 1,
  };
}
