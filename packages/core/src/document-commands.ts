import type {
  JsonValue,
  DocumentCommand,
  Annotation,
  AnnotationKind,
  DocumentSelectionAnchorV1,
  DocumentState,
} from './document-model.js';
import { documentSelectionPayload } from './document-model.js';

export interface DocumentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentSelectionAnchor extends DocumentSelectionAnchorV1 {
  reliable: true;
}

export interface DocumentCaretAnchor {
  pageIndex: number;
  position: DocumentRect;
  leftContext: string;
  rightContext: string;
  reliable: true;
}

export interface DocumentCommandFactory {
  createId(): string;
  now(): string;
}

const defaultFactory: DocumentCommandFactory = {
  createId: () => globalThis.crypto.randomUUID(),
  now: () => new Date().toISOString(),
};

function selectionPayload(anchor: DocumentSelectionAnchor): Record<string, JsonValue> {
  return { ...documentSelectionPayload(anchor) };
}

function add(
  state: Pick<DocumentState, "revision">,
  kind: AnnotationKind,
  pageIndex: number,
  payload: Record<string, JsonValue>,
  factory: DocumentCommandFactory,
): DocumentCommand {
  const timestamp = factory.now();
  const item: Annotation = {
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
  state: Pick<DocumentState, "revision">,
  anchor: DocumentSelectionAnchor,
  proposedText: string,
  factory: DocumentCommandFactory = defaultFactory,
): DocumentCommand {
  return add(state, 'replace', anchor.pageIndex, {
    ...selectionPayload(anchor),
    proposedText,
  }, factory);
}

export function addDelete(
  state: Pick<DocumentState, "revision">,
  anchor: DocumentSelectionAnchor,
  factory: DocumentCommandFactory = defaultFactory,
): DocumentCommand {
  return add(state, 'delete', anchor.pageIndex, selectionPayload(anchor), factory);
}

export function addInsert(
  state: Pick<DocumentState, "revision">,
  anchor: DocumentCaretAnchor,
  proposedText: string,
  factory: DocumentCommandFactory = defaultFactory,
): DocumentCommand {
  return add(state, 'insert', anchor.pageIndex, {
    position: { ...anchor.position },
    leftContext: anchor.leftContext,
    rightContext: anchor.rightContext,
    reliable: anchor.reliable,
    proposedText,
  }, factory);
}

export function addHighlight(
  state: Pick<DocumentState, "revision">,
  anchor: DocumentSelectionAnchor,
  comment?: string,
  factory: DocumentCommandFactory = defaultFactory,
): DocumentCommand {
  return add(state, 'highlight', anchor.pageIndex, {
    ...selectionPayload(anchor),
    ...(comment === undefined || comment === '' ? {} : { comment }),
  }, factory);
}

export function addPageNote(
  state: Pick<DocumentState, "revision">,
  pageIndex: number,
  position: DocumentRect,
  comment: string,
  factory: DocumentCommandFactory = defaultFactory,
  nearbyText?: string,
): DocumentCommand {
  return add(state, 'pageNote', pageIndex, {
    position: { ...position },
    comment,
    ...(nearbyText === undefined || nearbyText === '' ? {} : { nearbyText }),
  }, factory);
}

export function editAnnotation(
  state: Pick<DocumentState, "revision">,
  id: string,
  payload: Readonly<Record<string, JsonValue>>,
  factory: Pick<DocumentCommandFactory, 'now'> = defaultFactory,
): DocumentCommand {
  return { type: 'edit', expectedRevision: state.revision, id, payload, updatedAt: factory.now() };
}

export function removeAnnotation(state: Pick<DocumentState, "revision">, id: string): DocumentCommand {
  return { type: 'remove', expectedRevision: state.revision, id };
}

export function undoDocument(state: Pick<DocumentState, "revision">): DocumentCommand {
  return { type: 'undo', expectedRevision: state.revision };
}

export function redoDocument(state: Pick<DocumentState, "revision">): DocumentCommand {
  return { type: 'redo', expectedRevision: state.revision };
}

export function setAnnotationName(state: Pick<DocumentState, "revision">, annotationName: string): Extract<DocumentCommand, { type: 'set-annotation-name' }> {
  return { type: 'set-annotation-name', expectedRevision: state.revision, annotationName };
}
