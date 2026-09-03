import {
  anchorEvidenceFromReviewItem,
  canonicalizeReviewItem,
  normalizeReviewSelectionAnchor,
  PDF_SELECTION_PAGE_LIMIT,
  reviewSelectionPayload,
  type JsonValue,
  type PendingReviewDraftV1,
  type ReviewAnchorEvidenceV1,
  type ReviewCommand,
  type ReviewDiscardAuditV1,
  type ReviewItem,
  type ReviewState,
} from "./review-model.js";
import {
  assertPortableAnnotationGroupWritable,
  PortableAnnotationGroupError,
} from './grouped-annotation-envelope.js';

export const MAX_REVIEW_SELECTION_SEGMENTS = 256;

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

export class InvalidReviewCommandError extends Error {
  readonly code = "INVALID_REVIEW_COMMAND";

  constructor(message: string) {
    super(message);
    this.name = "InvalidReviewCommandError";
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

export function assertReviewItem(
  item: ReviewItem,
  options: { readonly maxSelectionSegments?: number } = {},
): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(item.id)) {
    throw new InvalidReviewCommandError("Review item IDs must be UUIDs");
  }
  if (!Number.isSafeInteger(item.pageIndex) || item.pageIndex < 0) {
    throw new InvalidReviewCommandError("Review item pageIndex must be non-negative");
  }
  if (
    !["replace", "delete", "insert", "highlight", "pageNote"].includes(
      item.kind,
    )
  ) {
    throw new InvalidReviewCommandError("Review item kind is not supported");
  }
  if (!Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt))) {
    throw new InvalidReviewCommandError("Review item dates must be valid timestamps");
  }

  const keys = Object.keys(item.payload);
  const allowedByKind: Record<ReviewItem['kind'], readonly string[]> = {
    replace: ['quote', 'prefix', 'suffix', 'rect', 'segmentRects', 'pages', 'pageBoundaries', 'reliable', 'proposedText'],
    delete: ['quote', 'prefix', 'suffix', 'rect', 'segmentRects', 'pages', 'pageBoundaries', 'reliable'],
    insert: ['position', 'leftContext', 'rightContext', 'reliable', 'proposedText'],
    highlight: ['quote', 'prefix', 'suffix', 'rect', 'segmentRects', 'pages', 'pageBoundaries', 'reliable', 'comment'],
    pageNote: ['position', 'comment', 'nearbyText'],
  };
  if (keys.some((key) => !allowedByKind[item.kind].includes(key))) {
    throw new InvalidReviewCommandError("Review item payload has unsupported fields");
  }
  const text = (field: string, allowEmpty = true) =>
    typeof item.payload[field] === 'string' && (allowEmpty || item.payload[field] !== '');
  const geometry = (field: string) => {
    const value = item.payload[field];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    return ['x', 'y', 'width', 'height'].every((key) =>
      typeof object[key] === 'number' && Number.isFinite(object[key])) &&
      (object.width as number) > 0 && (object.height as number) > 0;
  };
  const selection = () =>
    text('quote', false) && text('prefix') && text('suffix') && item.payload.reliable === true && geometry('rect') &&
    Array.isArray(item.payload.segmentRects) && item.payload.segmentRects.length > 0 &&
    item.payload.segmentRects.every((_, index) => {
      const segments = item.payload.segmentRects as unknown[];
      const value = segments[index];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      const object = value as Record<string, unknown>;
      return ['x', 'y', 'width', 'height'].every((key) =>
        typeof object[key] === 'number' && Number.isFinite(object[key])) &&
        (object.width as number) > 0 && (object.height as number) > 0;
    });

  const valid =
    (item.kind === 'replace' && selection() && text('proposedText', false)) ||
    (item.kind === 'delete' && selection()) ||
    (item.kind === 'insert' && item.payload.reliable === true && geometry('position') && text('leftContext') && text('rightContext') && text('proposedText', false) && item.payload.quote === undefined) ||
    (item.kind === 'highlight' && selection() && (item.payload.comment === undefined || text('comment'))) ||
    (item.kind === 'pageNote' && geometry('position') && text('comment', false) && (item.payload.nearbyText === undefined || text('nearbyText')));
  if (!valid) throw new InvalidReviewCommandError("Review item payload does not match its kind");
  if (item.reconciliation !== undefined) {
    const reconciliation = item.reconciliation;
    if (
      reconciliation.schemaVersion !== 1 ||
      reconciliation.ownerViewId.length === 0 ||
      !Number.isSafeInteger(reconciliation.baseGeneration) || reconciliation.baseGeneration < 0 ||
      !Number.isSafeInteger(reconciliation.revision) || reconciliation.revision < 0
    ) throw new InvalidReviewCommandError("Review item reconciliation is malformed");
    assertReviewAnchorEvidence(reconciliation.anchor);
    assertDisposition(reconciliation.disposition);
  }
  if (item.kind === 'replace' || item.kind === 'delete' || item.kind === 'highlight') {
    try {
      const anchor = anchorEvidenceFromReviewItem(item);
      if (anchor.kind !== 'selection') throw new Error('Selection evidence is missing');
      assertSelectionAnchorEvidence(anchor, options.maxSelectionSegments);
      assertPortableAnnotationGroupWritable(item);
    } catch (error) {
      if (error instanceof InvalidReviewCommandError) throw error;
      if (error instanceof PortableAnnotationGroupError) {
        throw new InvalidReviewCommandError(error.message);
      }
      throw new InvalidReviewCommandError('Review selection evidence is malformed');
    }
  }
}

function assertDisposition(value: { readonly kind: string; readonly generation?: number; readonly reason?: string }): void {
  if (value.kind === "resolved") {
    if (!Number.isSafeInteger(value.generation) || (value.generation ?? -1) < 0) {
      throw new InvalidReviewCommandError("Resolved review anchors require a generation");
    }
    return;
  }
  if (!["ambiguous", "missing", "unsupported"].includes(value.kind) || typeof value.reason !== "string" || value.reason.length === 0) {
    throw new InvalidReviewCommandError("Review anchor disposition is malformed");
  }
}

function assertRect(value: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): void {
  if (![value.x, value.y, value.width, value.height].every(Number.isFinite) || value.width <= 0 || value.height <= 0) {
    throw new InvalidReviewCommandError("Review anchor geometry is malformed");
  }
}

function sameRect(
  left: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  right: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): boolean {
  return left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height;
}

function assertSelectionAnchorEvidence(
  anchor: Extract<ReviewAnchorEvidenceV1, { readonly kind: 'selection' }>,
  maxSelectionSegments = MAX_REVIEW_SELECTION_SEGMENTS,
): void {
  const canonical = normalizeReviewSelectionAnchor(anchor);
  if (canonical.pages.length === 0) {
    throw new InvalidReviewCommandError('Selection reconciliation evidence is incomplete');
  }
  if (canonical.pages.length > PDF_SELECTION_PAGE_LIMIT) {
    throw new InvalidReviewCommandError(
      `Selections can span at most ${PDF_SELECTION_PAGE_LIMIT} pages. Shorten the selection and try again.`,
    );
  }
  if (canonical.pages[0]!.pageIndex !== canonical.pageIndex) {
    throw new InvalidReviewCommandError('Selection lead page does not match its ordered page evidence');
  }
  canonical.pages.forEach((page, index) => {
    if (
      !Number.isSafeInteger(page.pageIndex) || page.pageIndex < 0 ||
      (index > 0 && page.pageIndex !== canonical.pages[index - 1]!.pageIndex + 1) ||
      typeof page.quote !== 'string' || page.quote.length === 0 ||
      typeof page.prefix !== 'string' || typeof page.suffix !== 'string' ||
      !Array.isArray(page.segmentRects) || page.segmentRects.length === 0
    ) {
      throw new InvalidReviewCommandError('Selection pages must be non-empty and consecutive in document order');
    }
    assertRect(page.rect);
    page.segmentRects.forEach(assertRect);
  });
  if (canonical.pageBoundaries.length !== canonical.pages.length - 1) {
    throw new InvalidReviewCommandError('Selection page boundaries do not match its page span');
  }
  canonical.pageBoundaries.forEach((boundary, index) => {
    if (
      boundary.afterPageIndex !== canonical.pages[index]!.pageIndex ||
      typeof boundary.separator !== 'string' || boundary.separator.length === 0
    ) throw new InvalidReviewCommandError('Selection page boundaries are malformed');
  });
  const assembled = canonical.pages.map((page, index) =>
    page.quote + (canonical.pageBoundaries[index]?.separator ?? '')).join('');
  const first = canonical.pages[0]!;
  const last = canonical.pages.at(-1)!;
  if (
    assembled !== canonical.quote ||
    canonical.prefix !== first.prefix || canonical.suffix !== last.suffix ||
    !sameRect(canonical.rect, first.rect) ||
    canonical.segmentRects.length !== first.segmentRects.length ||
    canonical.segmentRects.some((rect, index) => !sameRect(rect, first.segmentRects[index]!))
  ) throw new InvalidReviewCommandError('Selection text or lead-page evidence does not match its complete span');
  const segmentCount = canonical.pages.reduce((count, page) => count + page.segmentRects.length, 0);
  if (segmentCount > maxSelectionSegments) {
    throw new InvalidReviewCommandError(
      `Selections can contain at most ${maxSelectionSegments} text segments. Shorten the selection and try again.`,
    );
  }
}

function assertReviewAnchorEvidence(anchor: ReviewAnchorEvidenceV1): void {
  if (!Number.isSafeInteger(anchor.pageIndex) || anchor.pageIndex < 0) {
    throw new InvalidReviewCommandError("Review anchor pageIndex must be non-negative");
  }
  assertRect(anchor.rect);
  switch (anchor.kind) {
    case "selection":
      if (
        typeof anchor.quote !== "string" || anchor.quote.length === 0 ||
        typeof anchor.prefix !== "string" || typeof anchor.suffix !== "string" ||
        !Array.isArray(anchor.segmentRects) || anchor.segmentRects.length === 0
      ) throw new InvalidReviewCommandError("Selection reconciliation evidence is incomplete");
      anchor.segmentRects.forEach(assertRect);
      assertSelectionAnchorEvidence(anchor);
      return;
    case "caret":
      if (typeof anchor.leftContext !== "string" || typeof anchor.rightContext !== "string") {
        throw new InvalidReviewCommandError("Caret reconciliation evidence is incomplete");
      }
      return;
    case "page":
      if (anchor.nearbyText !== undefined && typeof anchor.nearbyText !== "string") {
        throw new InvalidReviewCommandError("Page reconciliation evidence is incomplete");
      }
      return;
    default:
      throw new InvalidReviewCommandError("Review anchor kind is not supported");
  }
}

function assertAnchorMatchesReviewItem(item: ReviewItem, anchor: ReviewAnchorEvidenceV1): void {
  const expectedKind = item.kind === "insert"
    ? "caret"
    : item.kind === "pageNote"
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
        state.workflow.mode === "generated-output"
          ? canonicalizeReviewItem(command.item, authoring)
          : command.item,
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
      const reattached: ReviewItem = {
        ...existing,
        pageIndex: command.anchor.pageIndex,
        updatedAt: command.updatedAt,
        reconciliation: {
          ...reconciliation,
          ownerViewId: command.ownerViewId,
          revision: reconciliation.revision + 1,
          anchor: command.anchor,
          disposition: { kind: "resolved", generation: state.workflow.documentGeneration },
        },
      };
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
      const mutable = existing.kind === 'replace' || existing.kind === 'insert'
        ? ['proposedText']
        : existing.kind === 'highlight' || existing.kind === 'pageNote'
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
