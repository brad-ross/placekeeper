import type {
  JsonValue,
  ReviewItem,
  ReviewState,
} from '../../../../packages/core/src/review-model.js';
import type { ReviewRect } from '../../../../packages/core/src/review-commands.js';
import type { CaretAnchor, SelectionAnchor } from '../pdf/selection-anchor.js';
import type { PdfNaturalPoint } from '../pdf/viewer-navigation.js';
import type { WorkspaceMode } from './reference-navigation-state.js';

export interface AuthoringAuthority {
  readonly sourceIdentity: string;
  readonly documentGeneration: number;
}

export interface AuthoringWorkspaceSnapshot {
  readonly open: boolean;
  readonly mode: WorkspaceMode;
  readonly activeItemId?: string;
  readonly annotationScrollTop: number;
}

export type AuthoringOriginKind =
  | 'typing'
  | 'selection'
  | 'caret'
  | 'page'
  | 'keyboard'
  | 'tray-edit';

export interface AuthoringOrigin {
  readonly kind: AuthoringOriginKind;
  readonly trigger: HTMLElement | null;
}

export type AuthoringSource =
  | {
      readonly kind: 'replace';
      readonly anchor: SelectionAnchor;
      readonly initialValue: string;
      readonly selectionGeneration: number;
    }
  | {
      readonly kind: 'insert';
      readonly anchor: CaretAnchor;
      readonly initialValue: string;
    }
  | {
      readonly kind: 'highlight';
      readonly anchor: SelectionAnchor;
      readonly selectionGeneration: number;
    }
  | {
      readonly kind: 'pageNote';
      readonly pageIndex: number;
      readonly position: ReviewRect;
      readonly nearbyText?: string;
    }
  | {
      readonly kind: 'edit';
      readonly item: ReviewItem;
    };

/** Truthful prose or anchor identity shown beside the live PDF while authoring. */
export type AuthoringSourceContext =
  | {
      readonly kind: 'selection';
      readonly pageNumber: number;
      readonly prefix: string;
      readonly quote: string;
      readonly suffix: string;
    }
  | {
      readonly kind: 'caret';
      readonly pageNumber: number;
      readonly leftContext: string;
      readonly rightContext: string;
    }
  | {
      readonly kind: 'page';
      readonly pageNumber: number;
      readonly nearbyText: string;
    }
  | {
      readonly kind: 'anchor';
      readonly pageNumber: number;
      readonly anchorLabel: string;
    };

export interface AuthoringSemantics {
  readonly title: string;
  readonly primaryLabel: 'Save' | 'Apply';
  readonly optional: boolean;
  readonly allowWhitespace: boolean;
}

export interface AuthoringSessionSeed {
  readonly token: number;
  readonly authority: AuthoringAuthority;
  readonly source: AuthoringSource;
  readonly origin: AuthoringOrigin;
  readonly workspace: AuthoringWorkspaceSnapshot;
}

export interface AuthoringSession {
  readonly token: number;
  readonly authority: AuthoringAuthority;
  readonly source: AuthoringSource;
  readonly origin: AuthoringOrigin;
  readonly workspace: AuthoringWorkspaceSnapshot;
  readonly semantics: AuthoringSemantics;
}

export interface AuthoringAnchorSnapshot {
  readonly token: number;
  readonly authority: AuthoringAuthority;
  readonly pageIndex: number;
  readonly point: PdfNaturalPoint | null;
}

export function reviewSourceIdentity(
  state: Pick<ReviewState, 'sessionId' | 'source'>,
): string {
  return JSON.stringify([state.sessionId, state.source.fileId, state.source.digest]);
}

export function authoringAuthorityFor(
  state: Pick<ReviewState, 'sessionId' | 'source'>,
  documentGeneration: number,
): AuthoringAuthority {
  return Object.freeze({
    sourceIdentity: reviewSourceIdentity(state),
    documentGeneration,
  });
}

export function authoringAuthorityMatches(
  captured: AuthoringAuthority,
  current: AuthoringAuthority,
): boolean {
  return captured.sourceIdentity === current.sourceIdentity
    && captured.documentGeneration === current.documentGeneration;
}

export function authoringSessionIsCurrent(
  session: Pick<AuthoringSession, 'authority'>,
  current: AuthoringAuthority,
): boolean {
  return authoringAuthorityMatches(session.authority, current);
}

function cloneRect(rect: ReviewRect): ReviewRect {
  return Object.freeze({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
}

function cloneSelectionAnchor(anchor: SelectionAnchor): SelectionAnchor {
  return Object.freeze({
    pageIndex: anchor.pageIndex,
    quote: anchor.quote,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
    rect: cloneRect(anchor.rect),
    segmentRects: Object.freeze(anchor.segmentRects.map(cloneRect)) as unknown as SelectionAnchor['segmentRects'],
    reliable: true,
  });
}

function cloneCaretAnchor(anchor: CaretAnchor): CaretAnchor {
  return Object.freeze({
    pageIndex: anchor.pageIndex,
    position: cloneRect(anchor.position),
    leftContext: anchor.leftContext,
    rightContext: anchor.rightContext,
    reliable: true,
  });
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneJson)) as unknown as JsonValue;
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]),
    ));
  }
  return value;
}

function cloneReviewItem(item: ReviewItem): ReviewItem {
  return Object.freeze({
    ...item,
    payload: Object.freeze(Object.fromEntries(
      Object.entries(item.payload).map(([key, value]) => [key, cloneJson(value)]),
    )),
  });
}

function cloneSource(source: AuthoringSource): AuthoringSource {
  switch (source.kind) {
    case 'replace':
      return Object.freeze({
        ...source,
        anchor: cloneSelectionAnchor(source.anchor),
      });
    case 'insert':
      return Object.freeze({
        ...source,
        anchor: cloneCaretAnchor(source.anchor),
      });
    case 'highlight':
      return Object.freeze({
        ...source,
        anchor: cloneSelectionAnchor(source.anchor),
      });
    case 'pageNote':
      return Object.freeze({
        ...source,
        position: cloneRect(source.position),
      });
    case 'edit':
      return Object.freeze({
        ...source,
        item: cloneReviewItem(source.item),
      });
  }
}

function semanticsFor(source: AuthoringSource): AuthoringSemantics {
  if (source.kind === 'replace') {
    return Object.freeze({
      title: 'Replacement',
      primaryLabel: 'Apply',
      optional: false,
      allowWhitespace: true,
    });
  }
  if (source.kind === 'insert') {
    return Object.freeze({
      title: 'Insertion',
      primaryLabel: 'Apply',
      optional: false,
      allowWhitespace: true,
    });
  }
  if (source.kind === 'highlight') {
    return Object.freeze({
      title: 'Highlight Comment',
      primaryLabel: 'Save',
      optional: true,
      allowWhitespace: false,
    });
  }
  if (source.kind === 'pageNote') {
    return Object.freeze({
      title: 'Page Note',
      primaryLabel: 'Save',
      optional: false,
      allowWhitespace: false,
    });
  }
  const itemLabel = source.item.kind === 'replace'
    ? 'Replacement'
    : source.item.kind === 'insert'
      ? 'Insertion'
      : source.item.kind === 'pageNote'
        ? 'Page Note'
        : source.item.kind === 'highlight'
          ? 'Highlight'
          : 'Deletion';
  return Object.freeze({
    title: `Edit ${itemLabel}`,
    primaryLabel: 'Apply',
    optional: source.item.kind === 'highlight',
    allowWhitespace: source.item.kind === 'replace' || source.item.kind === 'insert',
  });
}

export function createAuthoringSession(seed: AuthoringSessionSeed): AuthoringSession {
  const source = cloneSource(seed.source);
  return Object.freeze({
    token: seed.token,
    authority: Object.freeze({ ...seed.authority }),
    source,
    origin: Object.freeze({ ...seed.origin }),
    workspace: Object.freeze({ ...seed.workspace }),
    semantics: semanticsFor(source),
  });
}

function payloadPoint(item: ReviewItem): PdfNaturalPoint | null {
  const value = item.payload[item.kind === 'insert' || item.kind === 'pageNote'
    ? 'position'
    : 'rect'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const x = value.x;
  const y = value.y;
  return typeof x === 'number'
    && Number.isFinite(x)
    && x >= 0
    && typeof y === 'number'
    && Number.isFinite(y)
    && y >= 0
    ? Object.freeze({ x, y })
    : null;
}

/** Extracts the immutable page point used only for visibility and Return. */
export function authoringAnchorSnapshot(
  session: AuthoringSession,
): AuthoringAnchorSnapshot {
  const source = session.source;
  const pageIndex = source.kind === 'edit'
    ? source.item.pageIndex
    : source.kind === 'pageNote'
      ? source.pageIndex
      : source.anchor.pageIndex;
  const point = source.kind === 'replace' || source.kind === 'highlight'
    ? { x: source.anchor.rect.x, y: source.anchor.rect.y }
    : source.kind === 'insert'
      ? { x: source.anchor.position.x, y: source.anchor.position.y }
      : source.kind === 'pageNote'
        ? { x: source.position.x, y: source.position.y }
        : payloadPoint(source.item);
  return Object.freeze({
    token: session.token,
    authority: session.authority,
    pageIndex,
    point: point === null ? null : Object.freeze(point),
  });
}

export function canStartAuthoringSession(current: AuthoringSession | null): current is null {
  return current === null;
}

function payloadText(item: ReviewItem, field: string): string | null {
  const value = item.payload[field];
  return typeof value === 'string' ? value : null;
}

function editAnchorLabel(item: ReviewItem): string {
  if (item.kind === 'replace') return 'Replacement anchor';
  if (item.kind === 'insert') return 'Insertion point';
  if (item.kind === 'highlight') return 'Highlight anchor';
  if (item.kind === 'pageNote') return 'Page Note anchor';
  return 'Deletion anchor';
}

/**
 * Projects only frozen, authored source evidence. Missing persisted prose falls
 * back to page/anchor identity; this adapter never attempts to reconstruct it.
 */
export function authoringSourceContext(source: AuthoringSource): AuthoringSourceContext {
  if (source.kind === 'replace' || source.kind === 'highlight') {
    return {
      kind: 'selection',
      pageNumber: source.anchor.pageIndex + 1,
      prefix: source.anchor.prefix,
      quote: source.anchor.quote,
      suffix: source.anchor.suffix,
    };
  }
  if (source.kind === 'insert') {
    return {
      kind: 'caret',
      pageNumber: source.anchor.pageIndex + 1,
      leftContext: source.anchor.leftContext,
      rightContext: source.anchor.rightContext,
    };
  }
  if (source.kind === 'pageNote') {
    return source.nearbyText !== undefined && source.nearbyText.trim().length > 0
      ? { kind: 'page', pageNumber: source.pageIndex + 1, nearbyText: source.nearbyText }
      : { kind: 'anchor', pageNumber: source.pageIndex + 1, anchorLabel: 'Page Note anchor' };
  }

  const item = source.item;
  const pageNumber = item.pageIndex + 1;
  if (item.kind === 'replace' || item.kind === 'highlight' || item.kind === 'delete') {
    const quote = payloadText(item, 'quote');
    const prefix = payloadText(item, 'prefix');
    const suffix = payloadText(item, 'suffix');
    return quote !== null && quote.trim().length > 0 && prefix !== null && suffix !== null
      ? { kind: 'selection', pageNumber, prefix, quote, suffix }
      : { kind: 'anchor', pageNumber, anchorLabel: editAnchorLabel(item) };
  }
  if (item.kind === 'insert') {
    const leftContext = payloadText(item, 'leftContext');
    const rightContext = payloadText(item, 'rightContext');
    return leftContext !== null && rightContext !== null
      ? { kind: 'caret', pageNumber, leftContext, rightContext }
      : { kind: 'anchor', pageNumber, anchorLabel: editAnchorLabel(item) };
  }
  const nearbyText = payloadText(item, 'nearbyText');
  return nearbyText !== null && nearbyText.trim().length > 0
    ? { kind: 'page', pageNumber, nearbyText }
    : { kind: 'anchor', pageNumber, anchorLabel: editAnchorLabel(item) };
}
