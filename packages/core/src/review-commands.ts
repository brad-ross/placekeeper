import type {
  JsonValue,
  ReviewCommand,
  ReviewItem,
  ReviewItemKind,
  ReviewState,
} from './review-model.js';

export interface ReviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReviewSelectionAnchor {
  pageIndex: number;
  quote: string;
  prefix: string;
  suffix: string;
  rect: ReviewRect;
  segmentRects: readonly ReviewRect[];
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
  return {
    quote: anchor.quote,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
    rect: { ...anchor.rect },
    segmentRects: anchor.segmentRects.map((rect) => ({ ...rect })),
    reliable: anchor.reliable,
  };
}

function add(
  state: ReviewState,
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
  state: ReviewState,
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
  state: ReviewState,
  anchor: ReviewSelectionAnchor,
  factory: ReviewCommandFactory = defaultFactory,
): ReviewCommand {
  return add(state, 'delete', anchor.pageIndex, selectionPayload(anchor), factory);
}

export function addInsert(
  state: ReviewState,
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
  state: ReviewState,
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
  state: ReviewState,
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
  state: ReviewState,
  id: string,
  payload: Readonly<Record<string, JsonValue>>,
  factory: Pick<ReviewCommandFactory, 'now'> = defaultFactory,
): ReviewCommand {
  return { type: 'edit', expectedRevision: state.revision, id, payload, updatedAt: factory.now() };
}

export function removeReviewItem(state: ReviewState, id: string): ReviewCommand {
  return { type: 'remove', expectedRevision: state.revision, id };
}

export function undoReview(state: ReviewState): ReviewCommand {
  return { type: 'undo', expectedRevision: state.revision };
}

export function redoReview(state: ReviewState): ReviewCommand {
  return { type: 'redo', expectedRevision: state.revision };
}
