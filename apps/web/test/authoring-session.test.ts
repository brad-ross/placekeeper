import { describe, expect, it } from 'vitest';

import { createReviewState, type ReviewItem } from '../../../packages/core/src/review-model.js';
import {
  authoringAuthorityFor,
  authoringAnchorSnapshot,
  authoringPreviewAnnotation,
  authoringPreviewAnnotations,
  authoringSessionIsCurrent,
  canStartAuthoringSession,
  createAuthoringSession,
  pendingDraftForAuthoring,
  type AuthoringSessionSeed,
} from '../src/review/authoring-session.js';
import {
  pendingDestinationAttemptIsCurrent,
  pendingDestinationDisposition,
  pendingDestinationIsCurrent,
} from "../src/save/destination-attempt.js";

const state = createReviewState({
  sessionId: 'authoring-session',
  source: { fileId: 'paper', digest: 'a'.repeat(64), byteLength: 12 },
});

const workspace = {
  open: true,
  mode: 'annotations' as const,
  activeItemId: 'annotation-2',
  annotationScrollTop: 148,
};

const selection = {
  pageIndex: 2,
  quote: 'the original passage',
  prefix: 'before ',
  suffix: ' after',
  reliable: true as const,
  rect: { x: 10, y: 20, width: 30, height: 12 },
  segmentRects: [{ x: 10, y: 20, width: 30, height: 12 }],
};
const crossPageSelection = {
  ...selection,
  quote: 'the original passage\ncontinued passage',
  pages: [
    {
      pageIndex: selection.pageIndex,
      quote: selection.quote,
      prefix: selection.prefix,
      suffix: '',
      rect: selection.rect,
      segmentRects: selection.segmentRects,
    },
    {
      pageIndex: 3,
      quote: 'continued passage',
      prefix: '',
      suffix: ' after',
      rect: { x: 10, y: 20, width: 34, height: 12 },
      segmentRects: [{ x: 10, y: 20, width: 34, height: 12 }],
    },
  ],
  pageBoundaries: [{ afterPageIndex: 2, separator: '\n' }],
};

const caret = {
  pageIndex: 3,
  position: { x: 14, y: 22, width: 1, height: 12 },
  leftContext: 'left',
  rightContext: 'right',
  reliable: true as const,
};

const editedItem: ReviewItem = {
  id: 'annotation-2',
  kind: 'highlight',
  pageIndex: 4,
  createdAt: '2026-08-21T12:00:00.000Z',
  updatedAt: '2026-08-21T12:00:00.000Z',
  payload: {
    quote: 'persisted passage',
    prefix: '',
    suffix: '',
    rect: { x: 1, y: 2, width: 3, height: 4 },
    segmentRects: [{ x: 1, y: 2, width: 3, height: 4 }],
    reliable: true,
    comment: 'Existing comment',
  },
};

const seed = (
  source: AuthoringSessionSeed['source'],
  token = 1,
): AuthoringSessionSeed => ({
  token,
  authority: authoringAuthorityFor(state, 7),
  source,
  origin: { kind: 'selection', trigger: null },
  workspace,
});

describe('frozen authoring-session contract', () => {
  it('projects in-progress authoring into a protected generation-bound draft', () => {
    const session = createAuthoringSession({
      ...seed({ kind: 'replace', anchor: selection, initialValue: '', selectionGeneration: 11 }),
      draftId: '00000000-0000-4000-8000-000000000099',
    });
    expect(pendingDraftForAuthoring({
      session,
      ownerViewId: 'panel-a',
      text: 'protected replacement',
      revision: 0,
      createdAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:00:01.000Z',
    })).toMatchObject({
      id: '00000000-0000-4000-8000-000000000099',
      ownerViewId: 'panel-a',
      baseGeneration: 7,
      kind: 'replace',
      text: 'protected replacement',
      status: 'protected',
      disposition: { kind: 'resolved', generation: 7 },
      anchor: { kind: 'selection', quote: 'the original passage' },
    });
  });

  it.each([
    [
      'replacement',
      { kind: 'replace' as const, anchor: selection, initialValue: '', selectionGeneration: 11 },
      { title: 'Replacement', primaryLabel: 'Apply', optional: false },
    ],
    [
      'insertion',
      { kind: 'insert' as const, anchor: caret, initialValue: 'draft' },
      { title: 'Insertion', primaryLabel: 'Apply', optional: false },
    ],
    [
      'highlight comment',
      { kind: 'highlight' as const, anchor: selection, selectionGeneration: 12 },
      { title: 'Highlight Comment', primaryLabel: 'Save', optional: true },
    ],
    [
      'Page Note',
      {
        kind: 'pageNote' as const,
        pageIndex: 5,
        position: { x: 40, y: 50, width: 18, height: 18 },
        nearbyText: 'Nearby text',
      },
      { title: 'Page Note', primaryLabel: 'Save', optional: false },
    ],
    [
      'edit',
      { kind: 'edit' as const, item: editedItem },
      { title: 'Edit Highlight', primaryLabel: 'Apply', optional: true },
    ],
  ])('gives %s one source, authority, workspace snapshot, and action grammar', (_name, source, semantics) => {
    const session = createAuthoringSession(seed(source));

    expect(session).toMatchObject({
      token: 1,
      authority: { sourceIdentity: expect.any(String), documentGeneration: 7 },
      workspace,
      semantics,
      source,
    });
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.source)).toBe(true);
    expect(Object.isFrozen(session.workspace)).toBe(true);
  });

  it('clones nested source evidence so later selection or item mutation cannot retarget the draft', () => {
    const mutableSelection = {
      ...selection,
      rect: { ...selection.rect },
      segmentRects: selection.segmentRects.map((rect) => ({ ...rect })),
    };
    const session = createAuthoringSession(seed({
      kind: 'replace',
      anchor: mutableSelection,
      initialValue: 'original draft',
      selectionGeneration: 11,
    }));

    mutableSelection.quote = 'new selection';
    mutableSelection.rect.x = 999;
    mutableSelection.segmentRects[0]!.x = 999;

    expect(session.source).toMatchObject({
      kind: 'replace',
      anchor: {
        quote: 'the original passage',
        rect: { x: 10 },
        segmentRects: [{ x: 10 }],
      },
    });
  });

  it.each(['replace', 'highlight'] as const)('freezes every page of a cross-page %s draft', (kind) => {
    const mutable = structuredClone(crossPageSelection);
    const source = kind === 'replace'
      ? { kind, anchor: mutable, initialValue: '', selectionGeneration: 11 }
      : { kind, anchor: mutable, selectionGeneration: 11 };
    const session = createAuthoringSession(seed(source));

    mutable.quote = 'retargeted';
    mutable.pages[1]!.quote = 'retargeted';
    mutable.pages[1]!.segmentRects[0]!.x = 999;

    expect(session.source).toMatchObject({
      anchor: {
        quote: 'the original passage\ncontinued passage',
        pages: [
          { pageIndex: 2, quote: 'the original passage' },
          { pageIndex: 3, quote: 'continued passage', segmentRects: [{ x: 10 }] },
        ],
      },
    });
    if (session.source.kind !== 'replace' && session.source.kind !== 'highlight') {
      throw new Error('Expected selection authoring source');
    }
    expect(Object.isFrozen(session.source.anchor.pages)).toBe(true);
    expect(Object.isFrozen(session.source.anchor.pages?.[1])).toBe(true);
    const preview = authoringPreviewAnnotation(session, kind === 'replace' ? 'replacement' : 'comment');
    expect(preview?.custom).toMatchObject({
      placekeeper: {
        item: {
          payload: {
            pages: [
              { pageIndex: 2, quote: 'the original passage' },
              { pageIndex: 3, quote: 'continued passage' },
            ],
            pageBoundaries: [{ afterPageIndex: 2, separator: '\n' }],
          },
        },
      },
    });
    expect(authoringPreviewAnnotations(
      session,
      kind === 'replace' ? 'replacement' : 'comment',
    ).map(({ id, reviewItemId, pageIndex }) => ({ id, reviewItemId, pageIndex }))).toEqual([
      {
        id: 'authoring-preview:1:projection:1',
        reviewItemId: 'authoring-preview:1',
        pageIndex: 2,
      },
      {
        id: 'authoring-preview:1:projection:2',
        reviewItemId: 'authoring-preview:1',
        pageIndex: 3,
      },
    ]);
  });

  it('projects the frozen selection, caret, page, and persisted-item points for Return', () => {
    expect(authoringAnchorSnapshot(createAuthoringSession(seed({
      kind: 'replace', anchor: selection, initialValue: '', selectionGeneration: 11,
    })))).toMatchObject({ pageIndex: 2, point: { x: 10, y: 20 } });
    expect(authoringAnchorSnapshot(createAuthoringSession(seed({
      kind: 'insert', anchor: caret, initialValue: '',
    })))).toMatchObject({ pageIndex: 3, point: { x: 14, y: 22 } });
    expect(authoringAnchorSnapshot(createAuthoringSession(seed({
      kind: 'pageNote', pageIndex: 5, position: { x: 40, y: 50, width: 18, height: 18 },
    })))).toMatchObject({ pageIndex: 5, point: { x: 40, y: 50 } });
    expect(authoringAnchorSnapshot(createAuthoringSession(seed({
      kind: 'edit', item: editedItem,
    })))).toMatchObject({ pageIndex: 4, point: { x: 1, y: 2 } });
  });

  it('projects every new draft and edited content through the accepted PDF annotation model', () => {
    const replacement = createAuthoringSession(seed({
      kind: 'replace', anchor: selection, initialValue: '', selectionGeneration: 11,
    }));
    const insertion = createAuthoringSession(seed({
      kind: 'insert', anchor: caret, initialValue: '',
    }, 2));
    const highlight = createAuthoringSession(seed({
      kind: 'highlight', anchor: selection, selectionGeneration: 12,
    }, 3));
    const pageNote = createAuthoringSession(seed({
      kind: 'pageNote',
      pageIndex: 5,
      position: { x: 40, y: 50, width: 18, height: 18 },
      nearbyText: 'Nearby text',
    }, 4));
    const edited = createAuthoringSession(seed({ kind: 'edit', item: editedItem }, 2));

    expect(authoringPreviewAnnotation(replacement, 'the revised passage')).toMatchObject({
      id: 'authoring-preview:1',
      kind: 'replace',
      pageIndex: 2,
      rect: selection.rect,
      quadPoints: selection.segmentRects,
      contents: 'the revised passage',
    });
    expect(authoringPreviewAnnotation(insertion, 'inserted phrase')).toMatchObject({
      id: 'authoring-preview:2',
      kind: 'insert',
      pageIndex: 3,
      rect: caret.position,
      contents: 'inserted phrase',
    });
    expect(authoringPreviewAnnotation(highlight, 'New comment')).toMatchObject({
      id: 'authoring-preview:3',
      kind: 'highlight',
      pageIndex: 2,
      rect: selection.rect,
      quadPoints: selection.segmentRects,
      contents: 'New comment',
    });
    expect(authoringPreviewAnnotation(pageNote, 'Page-level note')).toMatchObject({
      id: 'authoring-preview:4',
      kind: 'pageNote',
      pageIndex: 5,
      rect: { x: 40, y: 50, width: 18, height: 18 },
      contents: 'Page-level note',
    });
    expect(authoringPreviewAnnotation(edited, 'Revised comment')).toMatchObject({
      id: editedItem.id,
      kind: 'highlight',
      pageIndex: editedItem.pageIndex,
      contents: 'Revised comment',
    });
  });

  it('keeps an over-limit selection previewable until command validation can explain the limit', () => {
    const longSelection = {
      ...selection,
      rect: { x: 10, y: 20, width: 30, height: 1_548 },
      segmentRects: Array.from({ length: 257 }, (_, index) => ({
        x: 10,
        y: 20 + index * 12,
        width: 30,
        height: 12,
      })),
    };
    const session = createAuthoringSession(seed({
      kind: 'highlight',
      anchor: longSelection,
      selectionGeneration: 13,
    }));

    expect(() => authoringPreviewAnnotation(session, 'New comment')).not.toThrow();
    expect(authoringPreviewAnnotation(session, 'New comment')?.quadPoints).toHaveLength(257);
  });

  it('keeps the first session authoritative when another entry point fires', () => {
    const first = createAuthoringSession(seed({
      kind: 'replace', anchor: selection, initialValue: 'draft', selectionGeneration: 11,
    }));
    expect(canStartAuthoringSession(first)).toBe(false);
    expect(canStartAuthoringSession(null)).toBe(true);
  });

  it('preserves a reader edit as a distinct restoration origin', () => {
    const session = createAuthoringSession({
      ...seed({ kind: 'edit', item: editedItem }),
      origin: { kind: 'reader-edit', trigger: null },
    });

    expect(session.origin.kind).toBe('reader-edit');
    expect(Object.isFrozen(session.origin)).toBe(true);
  });

  it('fails closed when either source identity or document generation changes', () => {
    const session = createAuthoringSession(seed({
      kind: 'insert', anchor: caret, initialValue: '',
    }));
    const current = authoringAuthorityFor(state, 7);

    expect(authoringSessionIsCurrent(session, current)).toBe(true);
    expect(authoringSessionIsCurrent(session, { ...current, documentGeneration: 8 })).toBe(false);
    expect(authoringSessionIsCurrent(session, { ...current, sourceIdentity: 'replacement-source' })).toBe(false);
  });
});

describe('pending Save Destination authoring handoff', () => {
  it('distinguishes cancel, rejection, acceptance, and source replacement', () => {
    expect(pendingDestinationDisposition('cancelled')).toEqual({
      closeDialog: true,
      notifyAuthoringShell: false,
      preserveDraft: true,
    });
    expect(pendingDestinationDisposition('rejected')).toEqual({
      closeDialog: true,
      notifyAuthoringShell: false,
      preserveDraft: true,
    });
    expect(pendingDestinationDisposition('accepted')).toEqual({
      closeDialog: true,
      notifyAuthoringShell: true,
      preserveDraft: false,
    });
    expect(pendingDestinationDisposition('source-replaced')).toEqual({
      closeDialog: true,
      notifyAuthoringShell: true,
      preserveDraft: false,
    });
  });

  it('will not resume a pending command against another source or generation', () => {
    const authority = authoringAuthorityFor(state, 7);
    const pending = { authority };

    expect(pendingDestinationIsCurrent(pending, state, 7)).toBe(true);
    expect(pendingDestinationIsCurrent(pending, state, 8)).toBe(false);
    expect(pendingDestinationIsCurrent(pending, {
      ...state,
      source: { ...state.source, digest: 'b'.repeat(64) },
    }, 7)).toBe(false);
  });

  it('will not publish an established destination after attempt or source replacement', () => {
    const pending = { authority: authoringAuthorityFor(state, 7) };

    expect(pendingDestinationAttemptIsCurrent(4, 4, pending, state, 7)).toBe(true);
    expect(pendingDestinationAttemptIsCurrent(4, 5, pending, state, 7)).toBe(false);
    expect(pendingDestinationAttemptIsCurrent(4, 4, pending, {
      ...state,
      source: { ...state.source, digest: 'b'.repeat(64) },
    }, 7)).toBe(false);
  });
});
