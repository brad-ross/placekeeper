import { appendDocumentHistory, createDocumentHistoryEntry, normalizeDocumentHistory, replayDocumentHistoryEntry } from './review-history.js';
import { hasSafePortableAnnotationShape } from "./portable-annotation-shape.js";
import { projectAnnotations } from "./annotation-projection.js";
import { assertPortableAnnotationWritable, PORTABLE_ANNOTATION_MAX_BYTES } from "./portable-annotation.js";
import { canEditPdfAnnotationComment, canDeletePdfAnnotation } from './native-pdf-annotation.js';
import {
  canonicalizeAnnotation,
  normalizeAnnotationName,
  documentSelectionPayload,
  synchronizeAnnotationAnchor,
  type JsonValue,
  type PendingDocumentDraftV1,
  type DocumentAnchorEvidenceV1,
  type DocumentCommand,
  type DocumentDiscardAuditV1,
  type Annotation,
  type DocumentState,
} from "./review-model.js";
import {
  assertDisposition,
  assertDocumentAnchorEvidence,
  assertAnnotation,
  InvalidDocumentCommandError,
} from './review-item-validation.js';
export {
  assertDocumentAnchorEvidence,
  assertAnnotation,
  InvalidDocumentCommandError,
  MAX_DOCUMENT_SELECTION_SEGMENTS,
} from './review-item-validation.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class DocumentConflictError extends Error {
  readonly code = "REVISION_CONFLICT";

  constructor(expected: number, actual: number) {
    super(`Expected review revision ${expected}, but current revision is ${actual}`);
    this.name = "ReviewConflictError";
  }
}

export class DocumentDraftConflictError extends Error {
  readonly code = "DRAFT_REVISION_CONFLICT";

  constructor(expected: number, actual: number) {
    super(`Expected draft revision ${expected}, but current draft revision is ${actual}`);
    this.name = "ReviewDraftConflictError";
  }
}

function assertMutable(state: DocumentState, command: DocumentCommand): void {
  if (state.lifecycle !== "active") {
    throw new InvalidDocumentCommandError("A completed review cannot be mutated");
  }
  if (command.expectedRevision !== state.revision) {
    throw new DocumentConflictError(command.expectedRevision, state.revision);
  }
}

function assertAnchorMatchesAnnotation(item: Annotation, anchor: DocumentAnchorEvidenceV1): void {
  const expectedKind = item.kind === "insert"
    ? "caret"
    : (item.kind === "pageNote" || item.kind === "pdfAnnotation")
      ? "page"
      : "selection";
  if (anchor.kind !== expectedKind) {
    throw new InvalidDocumentCommandError(`Review item ${item.kind} requires a ${expectedKind} anchor`);
  }
}

function assertDraft(draft: PendingDocumentDraftV1): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(draft.id) ||
    draft.ownerViewId.length === 0 ||
    !Number.isSafeInteger(draft.baseGeneration) || draft.baseGeneration < 0 ||
    !Number.isSafeInteger(draft.revision) || draft.revision < 0 ||
    !Number.isFinite(Date.parse(draft.createdAt)) || !Number.isFinite(Date.parse(draft.updatedAt)) ||
    (draft.targetItemId !== undefined && draft.targetItemId.length === 0)
  ) throw new InvalidDocumentCommandError("Pending review draft is malformed");
  assertDocumentAnchorEvidence(draft.anchor);
  assertDisposition(draft.disposition);
}

export function assertDocumentCommand(command: unknown): asserts command is DocumentCommand {
  if (
    !isRecord(command) ||
    !Number.isSafeInteger(command.expectedRevision) ||
    (command.expectedRevision as number) < 0
  ) {
    throw new InvalidDocumentCommandError("Review command is malformed");
  }
  switch (command.type) {
    case "set-annotation-name":
      if (typeof command.annotationName !== "string") throw new InvalidDocumentCommandError("Annotation name must be text");
      return;
    case "add":
      if (!isRecord(command.item) || !isRecord(command.item.payload)) {
        throw new InvalidDocumentCommandError("Review command is malformed");
      }
      return;
    case "put-draft":
      if (!isRecord(command.draft)) throw new InvalidDocumentCommandError("Review command is malformed");
      return;
    case "apply-draft":
      if (
        typeof command.id !== "string" ||
        !Number.isSafeInteger(command.expectedDraftRevision) ||
        typeof command.ownerViewId !== "string" ||
        typeof command.updatedAt !== "string"
      ) throw new InvalidDocumentCommandError("Review command is malformed");
      return;
    case "reattach":
      if (
        typeof command.id !== "string" ||
        !Number.isSafeInteger(command.expectedReconciliationRevision) ||
        typeof command.ownerViewId !== "string" ||
        typeof command.updatedAt !== "string" ||
        !isRecord(command.anchor)
      ) throw new InvalidDocumentCommandError("Review command is malformed");
      return;
    case "discard-reconciliation":
      if (
        (command.target !== "item" && command.target !== "draft") ||
        typeof command.id !== "string" ||
        !Number.isSafeInteger(command.expectedTargetRevision) ||
        typeof command.ownerViewId !== "string" ||
        typeof command.reason !== "string" ||
        typeof command.discardedAt !== "string"
      ) throw new InvalidDocumentCommandError("Review command is malformed");
      return;
    case "edit":
      if (
        typeof command.id !== "string" ||
        typeof command.updatedAt !== "string" ||
        !isRecord(command.payload)
      ) {
        throw new InvalidDocumentCommandError("Review command is malformed");
      }
      return;
    case "remove":
      if (typeof command.id !== "string") {
        throw new InvalidDocumentCommandError("Review command is malformed");
      }
      return;
    case "undo":
    case "redo":
      return;
    default:
      throw new InvalidDocumentCommandError("Review command type is not supported");
  }
}

export function reduceDocument(
  state: DocumentState,
  command: DocumentCommand,
): DocumentState {
  assertDocumentCommand(command);
  assertMutable(state, command);

  if (command.type === "set-annotation-name") {
    const annotationName = normalizeAnnotationName(command.annotationName);
    if (!hasSafePortableAnnotationShape(annotationName) || new TextEncoder().encode(JSON.stringify(annotationName)).byteLength > PORTABLE_ANNOTATION_MAX_BYTES) {
      throw new InvalidDocumentCommandError("Annotation name is too long");
    }
    for (const annotation of projectAnnotations(state.items, undefined, { annotationName })) {
      assertPortableAnnotationWritable(annotation);
    }
    if (state.annotationName === annotationName) return state;
    return { ...state, annotationName, revision: state.revision + 1 };
  }

  const draftOnly = command.type === 'put-draft' || (command.type === 'discard-reconciliation' && command.target === 'draft');
  const normalized = draftOnly ? null : normalizeDocumentHistory(state.history, state.historyCursor, state.workflow.historyBoundary);
  const history = normalized?.history ?? [];
  const historyCursor = normalized?.historyCursor ?? state.historyCursor;

  if (command.type === "undo") {
    if (historyCursor <= normalized!.historyBoundary) {
      throw new InvalidDocumentCommandError("There is no review command to undo");
    }
    const entry = history[historyCursor - 1]!;
    return {
      ...replayDocumentHistoryEntry(state, entry, 'undo'),
      revision: state.revision + 1,
      workflow: { ...state.workflow, historyBoundary: normalized!.historyBoundary },
      history,
      historyCursor: historyCursor - 1,
    };
  }
  if (command.type === "redo") {
    if (historyCursor >= history.length) {
      throw new InvalidDocumentCommandError("There is no review command to redo");
    }
    return {
      ...replayDocumentHistoryEntry(state, history[historyCursor]!, 'redo'),
      revision: state.revision + 1,
      workflow: { ...state.workflow, historyBoundary: normalized!.historyBoundary },
      history,
      historyCursor: historyCursor + 1,
    };
  }

  let items: readonly Annotation[] = state.items;
  let pendingDrafts: readonly PendingDocumentDraftV1[] = state.pendingDrafts;
  let discardAudit: readonly DocumentDiscardAuditV1[] = state.discardAudit;
  switch (command.type) {
    case "add": {
      assertAnnotation(command.item);
      if (state.items.some((item) => item.id === command.item.id)) {
        throw new InvalidDocumentCommandError("Review item ID already exists");
      }
      const authoring = command.authoring ?? {
        ownerViewId: "legacy-view",
        baseGeneration: state.workflow.documentGeneration,
      };
      if (authoring.baseGeneration !== state.workflow.documentGeneration) {
        throw new InvalidDocumentCommandError("Review item authoring belongs to a stale document generation");
      }
      items = [
        ...state.items,
        canonicalizeAnnotation(command.item, authoring),
      ];
      break;
    }
    case "put-draft": {
      assertDraft(command.draft);
      if (command.draft.baseGeneration !== state.workflow.documentGeneration || command.draft.status !== "protected") {
        throw new InvalidDocumentCommandError("Pending authoring belongs to a stale document generation");
      }
      const index = state.pendingDrafts.findIndex(({ id }) => id === command.draft.id);
      const currentRevision = index < 0 ? -1 : state.pendingDrafts[index]!.revision;
      if (currentRevision !== command.expectedDraftRevision) {
        throw new DocumentDraftConflictError(command.expectedDraftRevision, currentRevision);
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
      if (draft === undefined) throw new InvalidDocumentCommandError("Pending review draft does not exist");
      if (
        draft.revision !== command.expectedDraftRevision ||
        draft.ownerViewId !== command.ownerViewId
      ) {
        throw new DocumentDraftConflictError(command.expectedDraftRevision, draft.revision);
      }
      if (
        draft.baseGeneration !== state.workflow.documentGeneration ||
        draft.status !== "protected" ||
        draft.disposition.kind !== "resolved" ||
        draft.disposition.generation !== state.workflow.documentGeneration
      ) {
        throw new InvalidDocumentCommandError("Pending review draft must be reattached before Apply");
      }
      const anchorPayload: Readonly<Record<string, JsonValue>> = draft.anchor.kind === "selection"
        ? documentSelectionPayload(draft.anchor, { canonical: true })
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
          throw new InvalidDocumentCommandError("Deletion cannot be applied from a text draft");
        }
        const item: Annotation = {
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
        assertAnnotation(item);
        if (state.items.some(({ id }) => id === item.id)) {
          throw new InvalidDocumentCommandError("Review item ID already exists");
        }
        items = [...state.items, item];
      } else {
        const itemIndex = state.items.findIndex(({ id }) => id === draft.targetItemId);
        if (itemIndex < 0) throw new InvalidDocumentCommandError("Edited Review Item no longer exists");
        const existing = state.items[itemIndex]!;
        if (!canEditPdfAnnotationComment(existing)) throw new InvalidDocumentCommandError("This PDF annotation comment is locked");
        if (existing.kind !== draft.kind || existing.kind === "delete") {
          throw new InvalidDocumentCommandError("Pending review draft kind does not match its Review Item");
        }
        const anchored = synchronizeAnnotationAnchor(existing, draft.anchor);
        const edited: Annotation = {
          ...anchored,
          pageIndex: draft.anchor.pageIndex,
          updatedAt: command.updatedAt,
          payload: { ...anchored.payload, [textField]: draft.text },
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
        assertAnnotation(edited);
        items = state.items.map((item, index) => index === itemIndex
          ? edited
          : item);
      }
      pendingDrafts = state.pendingDrafts.filter(({ id }) => id !== draft.id);
      break;
    }
    case "reattach": {
      const index = state.items.findIndex(({ id }) => id === command.id);
      if (index < 0) throw new InvalidDocumentCommandError("Review item does not exist");
      const existing = canonicalizeAnnotation(state.items[index]!, {
        ownerViewId: command.ownerViewId,
        baseGeneration: state.workflow.documentGeneration,
      });
      const reconciliation = existing.reconciliation!;
      if (reconciliation.revision !== command.expectedReconciliationRevision) {
        throw new DocumentDraftConflictError(command.expectedReconciliationRevision, reconciliation.revision);
      }
      assertDocumentAnchorEvidence(command.anchor);
      assertAnchorMatchesAnnotation(existing, command.anchor);
      const synchronized = synchronizeAnnotationAnchor(existing, command.anchor);
      const reattached: Annotation = {
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
      assertAnnotation(reattached);
      items = state.items.map((item, itemIndex) => itemIndex === index ? reattached : item);
      break;
    }
    case "discard-reconciliation": {
      if (command.reason.trim().length === 0 || !Number.isFinite(Date.parse(command.discardedAt))) {
        throw new InvalidDocumentCommandError("Discard audit metadata is malformed");
      }
      const collection = command.target === "item" ? state.items : state.pendingDrafts;
      const target = collection.find(({ id }) => id === command.id);
      if (target === undefined) throw new InvalidDocumentCommandError("Review reconciliation target does not exist");
      const targetRevision = command.target === "item"
        ? canonicalizeAnnotation(target as Annotation, {
            ownerViewId: command.ownerViewId,
            baseGeneration: state.workflow.documentGeneration,
          }).reconciliation!.revision
        : (target as PendingDocumentDraftV1).revision;
      if (targetRevision !== command.expectedTargetRevision) {
        throw new DocumentDraftConflictError(command.expectedTargetRevision, targetRevision);
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
        throw new InvalidDocumentCommandError("Review item does not exist");
      }
      const existing = state.items[index]!;
      if (!canEditPdfAnnotationComment(existing)) throw new InvalidDocumentCommandError('This PDF annotation comment is locked');
      const mutable = existing.kind === 'replace' || existing.kind === 'insert'
        ? ['proposedText']
        : existing.kind === 'highlight' || existing.kind === 'pageNote' || existing.kind === 'pdfAnnotation'
          ? ['comment']
          : [];
      if (Object.keys(command.payload).length === 0 || Object.keys(command.payload).some((key) => !mutable.includes(key))) {
        throw new InvalidDocumentCommandError("Only proposed text or comments may be edited");
      }
      const edited: Annotation = {
        ...existing,
        payload: { ...existing.payload, ...command.payload },
        updatedAt: command.updatedAt,
      };
      assertAnnotation(edited);
      items = state.items.map((item, itemIndex) => itemIndex === index ? edited : item);
      break;
    }
    case "remove": {
      if (!state.items.some((item) => item.id === command.id)) {
        throw new InvalidDocumentCommandError("Review item does not exist");
      }
      const existing = state.items.find((item) => item.id === command.id)!;
      if (!canDeletePdfAnnotation(existing)) throw new InvalidDocumentCommandError('This PDF annotation is locked against deletion');
      items = state.items.filter((item) => item.id !== command.id);
      break;
    }
    default:
      throw new InvalidDocumentCommandError("Review command type is not supported");
  }

  const next = { ...state, revision: state.revision + 1, items, pendingDrafts, discardAudit };
  if (draftOnly) return next;
  const appended = appendDocumentHistory(history, historyCursor, normalized!.historyBoundary,
    createDocumentHistoryEntry(state, next, state.workflow.documentGeneration));
  return {
    ...next,
    workflow: { ...state.workflow, historyBoundary: appended.historyBoundary },
    history: appended.history,
    historyCursor: appended.historyCursor,
  };
}
