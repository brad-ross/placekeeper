import type {
  JsonValue,
  PendingReviewDraftV1,
  ReviewItem,
  ReviewState,
} from '../../../../packages/core/src/review-model.js';
import {
  anchorEvidenceFromReviewItem,
  canonicalReviewSelectionEvidence,
  normalizeReviewSelectionAnchor,
  reviewSelectionPayload,
} from '../../../../packages/core/src/review-model.js';
import {
  projectReviewItem,
  projectReviewItemProjections,
} from '../../../../packages/core/src/annotation-projection.js';
import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';
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
  | 'tray-edit'
  | 'reader-edit';

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

export interface AuthoringSemantics {
  readonly title: string;
  readonly primaryLabel: 'Save' | 'Apply';
  readonly optional: boolean;
  readonly allowWhitespace: boolean;
}

export interface AuthoringSessionSeed {
  readonly token: number;
  readonly draftId?: string;
  readonly authority: AuthoringAuthority;
  readonly source: AuthoringSource;
  readonly origin: AuthoringOrigin;
  readonly workspace: AuthoringWorkspaceSnapshot;
}

export interface AuthoringSession {
  readonly token: number;
  readonly draftId: string;
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
  const canonical = normalizeReviewSelectionAnchor(anchor);
  return Object.freeze({
    pageIndex: canonical.pageIndex,
    quote: canonical.quote,
    prefix: canonical.prefix,
    suffix: canonical.suffix,
    rect: cloneRect(canonical.rect),
    segmentRects: Object.freeze(canonical.segmentRects.map(cloneRect)) as unknown as SelectionAnchor['segmentRects'],
    pages: Object.freeze(canonical.pages.map((page) => Object.freeze({
      ...page,
      rect: cloneRect(page.rect),
      segmentRects: Object.freeze(page.segmentRects.map(cloneRect)),
    }))),
    pageBoundaries: Object.freeze(canonical.pageBoundaries.map((boundary) => Object.freeze({ ...boundary }))),
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
  const itemLabel = source.item.kind === 'pdfAnnotation' ? 'Comment' : source.item.kind === 'replace'
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
    optional: source.item.kind === 'highlight' || source.item.kind === 'pdfAnnotation',
    allowWhitespace: source.item.kind === 'replace' || source.item.kind === 'insert',
  });
}

export function createAuthoringSession(seed: AuthoringSessionSeed): AuthoringSession {
  const source = cloneSource(seed.source);
  return Object.freeze({
    token: seed.token,
    draftId: seed.draftId ?? crypto.randomUUID(),
    authority: Object.freeze({ ...seed.authority }),
    source,
    origin: Object.freeze({ ...seed.origin }),
    workspace: Object.freeze({ ...seed.workspace }),
    semantics: semanticsFor(source),
  });
}

export function pendingDraftForAuthoring(input: {
  readonly session: AuthoringSession;
  readonly ownerViewId: string;
  readonly text: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}): PendingReviewDraftV1 {
  const { session } = input;
  const source = session.source;
  const anchor = source.kind === 'replace' || source.kind === 'highlight'
    ? {
        kind: 'selection' as const,
        ...canonicalReviewSelectionEvidence(source.anchor),
      }
    : source.kind === 'insert'
      ? {
          kind: 'caret' as const,
          pageIndex: source.anchor.pageIndex,
          leftContext: source.anchor.leftContext,
          rightContext: source.anchor.rightContext,
          rect: source.anchor.position,
        }
      : source.kind === 'pageNote'
        ? {
            kind: 'page' as const,
            pageIndex: source.pageIndex,
            ...(source.nearbyText === undefined ? {} : { nearbyText: source.nearbyText }),
            rect: source.position,
          }
        : anchorEvidenceFromReviewItem(source.item);
  return Object.freeze({
    id: session.draftId,
    ownerViewId: input.ownerViewId,
    baseGeneration: session.authority.documentGeneration,
    revision: input.revision,
    kind: source.kind === 'edit' ? source.item.kind : source.kind,
    ...(source.kind === 'edit' ? { targetItemId: source.item.id } : {}),
    pageIndex: anchor.pageIndex,
    text: input.text,
    anchor,
    disposition: { kind: 'resolved' as const, generation: session.authority.documentGeneration },
    status: 'protected',
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
}

function payloadPoint(item: ReviewItem): PdfNaturalPoint | null {
  const value = item.payload[item.kind === 'insert' || item.kind === 'pageNote' || item.kind === 'pdfAnnotation'
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

function selectionPayload(
  source: Extract<AuthoringSource, { readonly kind: 'replace' | 'highlight' }>,
): Record<string, JsonValue> {
  return { ...reviewSelectionPayload(source.anchor, { canonical: true }) };
}

function editableField(item: ReviewItem): 'proposedText' | 'comment' | null {
  if (item.kind === 'replace' || item.kind === 'insert') return 'proposedText';
  if (item.kind === 'highlight' || item.kind === 'pageNote' || item.kind === 'pdfAnnotation') return 'comment';
  return null;
}

function authoringPreviewItem(
  session: AuthoringSession,
  value: string,
): ReviewItem | null {
  const source = session.source;
  if (source.kind === 'edit') {
    const field = editableField(source.item);
    if (field === null) return null;
    return {
      ...source.item,
      payload: { ...source.item.payload, [field]: value },
    };
  }

  const timestamp = '1970-01-01T00:00:00.000Z';
  const base = {
    id: `authoring-preview:${session.token}`,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
  const item: ReviewItem = source.kind === 'replace'
    ? {
        ...base,
        kind: 'replace',
        pageIndex: source.anchor.pageIndex,
        payload: { ...selectionPayload(source), proposedText: value },
      }
    : source.kind === 'insert'
      ? {
          ...base,
          kind: 'insert',
          pageIndex: source.anchor.pageIndex,
          payload: {
            position: { ...source.anchor.position },
            leftContext: source.anchor.leftContext,
            rightContext: source.anchor.rightContext,
            reliable: true,
            proposedText: value,
          },
        }
      : source.kind === 'highlight'
        ? {
            ...base,
            kind: 'highlight',
            pageIndex: source.anchor.pageIndex,
            payload: {
              ...selectionPayload(source),
              ...(value === '' ? {} : { comment: value }),
            },
          }
        : {
            ...base,
            kind: 'pageNote',
            pageIndex: source.pageIndex,
            payload: {
              position: { ...source.position },
              comment: value,
              ...(source.nearbyText === undefined || source.nearbyText === ''
                ? {}
                : { nearbyText: source.nearbyText }),
            },
          };
  return item;
}

/** Lead-page compatibility projection for callers that still consume one preview. */
export function authoringPreviewAnnotation(
  session: AuthoringSession,
  value: string,
): ReviewAnnotation | null {
  const item = authoringPreviewItem(session, value);
  return item === null ? null : projectReviewItem(item);
}

/** Page-local visual previews backed by one immutable authoring session and draft. */
export function authoringPreviewAnnotations(
  session: AuthoringSession,
  value: string,
): readonly ReviewAnnotation[] {
  const item = authoringPreviewItem(session, value);
  return item === null
    ? []
    : projectReviewItemProjections(item, undefined, { includePortableMetadata: false });
}

export function mutableField(item: ReviewItem): 'proposedText' | 'comment' | undefined {
  if (item.kind === 'replace' || item.kind === 'insert') return 'proposedText';
  if (item.kind === 'highlight' || item.kind === 'pageNote' || item.kind === 'pdfAnnotation') return 'comment';
  return undefined;
}

export function initialAuthoringValue(session: AuthoringSession): string {
  const source = session.source;
  if (source.kind === 'replace' || source.kind === 'insert') return source.initialValue;
  if (source.kind !== 'edit') return '';
  const field = mutableField(source.item);
  return field === undefined ? '' : String(source.item.payload[field] ?? '');
}
