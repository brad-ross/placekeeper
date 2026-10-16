import type {
  JsonValue,
  ReviewCommand,
  ReviewItem,
  ReviewItemKind,
  ReviewSelectionAnchorV1,
  ReviewState,
} from './review-model.js';
import { reviewSelectionPayload } from './review-model.js';

export interface ReviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReviewSelectionAnchor extends ReviewSelectionAnchorV1 {
  reliable: true;
}

export interface ReviewCaretAnchor {
  pageIndex: number;
  position: ReviewRect;
  leftContext: string;
  rightContext: string;
  reliable: true;
}

export interface ReviewCommandFactory {
  createId(): string;
  now(): string;
}

const defaultFactory: ReviewCommandFactory = {
  createId: () => globalThis.crypto.randomUUID(),
  now: () => new Date().toISOString(),
};

function selectionPayload(anchor: ReviewSelectionAnchor): Record<string, JsonValue> {
  return { ...reviewSelectionPayload(anchor) };
}

function add(
  state: Pick<ReviewState, "revision">,
  kind: ReviewItemKind,
  pageIndex: number,
  payload: Record<string, JsonValue>,
  factory: ReviewCommandFactory,
): ReviewCommand {
  const timestamp = factory.now();
  const item: ReviewItem = {
    id: factory.createId(),
    kind,
    pageIndex,
    createdAt: timestamp,
    updatedAt: timestamp,
    payload,
  };
  return { type: 'add', expectedRevision: state.revision, item };
}

export function addReplace(
  state: Pick<ReviewState, "revision">,
  anchor: ReviewSelectionAnchor,
  proposedText: string,
  factory: ReviewCommandFactory = defaultFactory,
): ReviewCommand {
  return add(state, 'replace', anchor.pageIndex, {
    ...selectionPayload(anchor),
    proposedText,
  }, factory);
}

export function addDelete(
  state: Pick<ReviewState, "revision">,
  anchor: ReviewSelectionAnchor,
  factory: ReviewCommandFactory = defaultFactory,
): ReviewCommand {
  return add(state, 'delete', anchor.pageIndex, selectionPayload(anchor), factory);
}

export function addInsert(
  state: Pick<ReviewState, "revision">,
  anchor: ReviewCaretAnchor,
  proposedText: string,
  factory: ReviewCommandFactory = defaultFactory,
): ReviewCommand {
  return add(state, 'insert', anchor.pageIndex, {
    position: { ...anchor.position },
    leftContext: anchor.leftContext,
    rightContext: anchor.rightContext,
    reliable: anchor.reliable,
    proposedText,
  }, factory);
}

export function addHighlight(
  state: Pick<ReviewState, "revision">,
  anchor: ReviewSelectionAnchor,
  comment?: string,
  factory: ReviewCommandFactory = defaultFactory,
): ReviewCommand {
  return add(state, 'highlight', anchor.pageIndex, {
    ...selectionPayload(anchor),
    ...(comment === undefined || comment === '' ? {} : { comment }),
  }, factory);
}

export function addPageNote(
  state: Pick<ReviewState, "revision">,
  pageIndex: number,
  position: ReviewRect,
  comment: string,
  factory: ReviewCommandFactory = defaultFactory,
  nearbyText?: string,
): ReviewCommand {
  return add(state, 'pageNote', pageIndex, {
    position: { ...position },
    comment,
    ...(nearbyText === undefined || nearbyText === '' ? {} : { nearbyText }),
  }, factory);
}

export function editReviewItem(
  state: Pick<ReviewState, "revision">,
  id: string,
  payload: Readonly<Record<string, JsonValue>>,
  factory: Pick<ReviewCommandFactory, 'now'> = defaultFactory,
): ReviewCommand {
  return { type: 'edit', expectedRevision: state.revision, id, payload, updatedAt: factory.now() };
}

export function removeReviewItem(state: Pick<ReviewState, "revision">, id: string): ReviewCommand {
  return { type: 'remove', expectedRevision: state.revision, id };
}

export function undoReview(state: Pick<ReviewState, "revision">): ReviewCommand {
  return { type: 'undo', expectedRevision: state.revision };
}

export function redoReview(state: Pick<ReviewState, "revision">): ReviewCommand {
  return { type: 'redo', expectedRevision: state.revision };
}

export function setAnnotationName(state: Pick<ReviewState, "revision">, annotationName: string): Extract<ReviewCommand, { type: 'set-annotation-name' }> {
  return { type: 'set-annotation-name', expectedRevision: state.revision, annotationName };
}
