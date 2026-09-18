import { describe, expect, it, vi } from 'vitest';

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
  beginReviewInteraction,
  attachmentOrderedInteractionTransport,
  type AuthoringSessionSeed,
} from '../src/review/authoring-session.js';
import { resolveReattachmentDiscardIntent } from '../src/review/ReconciliationWorkspace.js';
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
  it('carries one frozen authoring draft identity through begin and reconnect', async () => {
    const begins: Array<{ readonly draftId?: string }> = [];
    const transport = {
      async beginInteraction(input: { interactionToken: string; order: number; generation: number; draftId?: string }) {
        begins.push(input);
        return { status: 'accepted', generation: input.generation, ownerViewId: 'attachment-a' };
      },
      async finalizeInteraction() { throw new Error('unused'); },
      async releaseInteraction() { return { status: 'released' }; },
      async acknowledgeInteraction() { throw new Error('unused'); },
    };
    const interaction = await beginReviewInteraction(transport, 7, 'authoring', 1, 'draft-frozen');
    await interaction.reacquire();
    await interaction.release();

    expect(begins).toEqual([
      expect.objectContaining({ draftId: 'draft-frozen' }),
      expect.objectContaining({ draftId: 'draft-frozen' }),
    ]);
  });

  it('shares monotonic attachment ordering across editor surfaces and remounts', async () => {
    const calls: Array<{ method: string; order: number }> = [];
    const transport = {
      async beginInteraction(input: { interactionToken: string; order: number; generation: number }) {
        calls.push({ method: 'begin', order: input.order });
        return { status: 'accepted', generation: input.generation, ownerViewId: 'attachment-a' };
      },
      async finalizeInteraction(input: { interactionToken: string; order: number; outcome: 'applied' | 'discarded'; draftId: string; expectedDraftRevision: number }) {
        calls.push({ method: 'finalize', order: input.order });
        return { status: 'finalized', interactionToken: input.interactionToken, generation: 7,
          outcome: input.outcome, reviewRevision: 1 };
      },
      async releaseInteraction(input: { interactionToken: string; order: number }) {
        calls.push({ method: 'release', order: input.order });
        return { status: 'released' };
      },
      async acknowledgeInteraction(input: { interactionToken: string; order: number }) {
        calls.push({ method: 'acknowledge', order: input.order });
        return { status: 'released' };
      },
    };
    const identity = {};
    const authoring = await beginReviewInteraction(attachmentOrderedInteractionTransport(identity, transport), 7, 'authoring');
    const receipt = await authoring.finalize('applied', 'draft-a', 0);
    await authoring.acknowledge(receipt);
    const reattachment = await beginReviewInteraction(attachmentOrderedInteractionTransport(identity, transport), 7, 'reattach');
    await reattachment.release();

    expect(calls).toEqual([
      { method: 'begin', order: 1 },
      { method: 'finalize', order: 2 },
      { method: 'acknowledge', order: 3 },
      { method: 'begin', order: 4 },
      { method: 'release', order: 5 },
    ]);
  });

  it('allocates attachment order when overlapping lifecycle requests are sent', async () => {
    const calls: Array<{ method: string; token: string; order: number }> = [];
    const transport = {
      async beginInteraction(input: { interactionToken: string; order: number; generation: number }) {
        calls.push({ method: 'begin', token: input.interactionToken, order: input.order });
        return { status: 'accepted', generation: input.generation, ownerViewId: 'attachment-a' };
      },
      async finalizeInteraction(input: { interactionToken: string; order: number }) {
        calls.push({ method: 'finalize', token: input.interactionToken, order: input.order });
        return { status: 'finalized', interactionToken: input.interactionToken, generation: 7,
          outcome: 'applied', reviewRevision: 1 };
      },
      async releaseInteraction(input: { interactionToken: string; order: number }) {
        calls.push({ method: 'release', token: input.interactionToken, order: input.order });
        return { status: 'released' };
      },
      async acknowledgeInteraction(input: { interactionToken: string; order: number }) {
        calls.push({ method: 'acknowledge', token: input.interactionToken, order: input.order });
        return { status: 'released' };
      },
    };
    const ordered = attachmentOrderedInteractionTransport({}, transport);
    const first = await beginReviewInteraction(ordered, 7, 'first');
    const second = await beginReviewInteraction(ordered, 7, 'second');
    await first.release();
    await second.release();

    expect(calls).toEqual([
      { method: 'begin', token: 'first', order: 1 },
      { method: 'begin', token: 'second', order: 2 },
      { method: 'release', token: 'first', order: 3 },
      { method: 'release', token: 'second', order: 4 },
    ]);
  });

  it('drops an explicitly rejected begin allocation before the token is reused', async () => {
    const orders: number[] = [];
    let attempts = 0;
    const ordered = attachmentOrderedInteractionTransport({}, {
      async beginInteraction(input) {
        orders.push(input.order);
        attempts += 1;
        return attempts === 1
          ? { status: 'stale', generation: 8 }
          : { status: 'accepted', generation: input.generation, ownerViewId: 'attachment-a' };
      },
      async finalizeInteraction() { throw new Error('unused'); },
      async releaseInteraction() { return { status: 'released' }; },
      async acknowledgeInteraction() { return { status: 'released' }; },
    });

    await expect(beginReviewInteraction(ordered, 7, 'reused')).rejects.toThrow('Current generation: 8');
    const accepted = await beginReviewInteraction(ordered, 7, 'reused');
    await accepted.release();
    expect(orders).toEqual([1, 2]);
  });

  it('releases a possibly accepted begin before admitting its caller retry', async () => {
    const calls: Array<{ method: string; token: string; order: number }> = [];
    let loseFirstBegin = true;
    const ordered = attachmentOrderedInteractionTransport({}, {
      async beginInteraction(input) {
        calls.push({ method: 'begin', token: input.interactionToken, order: input.order });
        if (loseFirstBegin) {
          loseFirstBegin = false;
          throw new Error('connection reset after admission');
        }
        return { status: 'accepted', generation: input.generation, ownerViewId: 'attachment-a' };
      },
      async finalizeInteraction() { throw new Error('unused'); },
      async releaseInteraction(input) {
        calls.push({ method: 'release', token: input.interactionToken, order: input.order });
        return { status: 'released' };
      },
      async acknowledgeInteraction() { return { status: 'released' }; },
    });

    await expect(beginReviewInteraction(ordered, 7, 'lost-admission')).rejects.toThrow('after admission');
    const accepted = await beginReviewInteraction(ordered, 7, 'fresh-admission');
    await accepted.release();
    expect(calls).toEqual([
      { method: 'begin', token: 'lost-admission', order: 1 },
      { method: 'release', token: 'lost-admission', order: 2 },
      { method: 'begin', token: 'fresh-admission', order: 3 },
      { method: 'release', token: 'fresh-admission', order: 4 },
    ]);
  });

  it('drops a failed begin allocation before the caller retries or abandons its token', async () => {
    const orders: number[] = [];
    let attempts = 0;
    const ordered = attachmentOrderedInteractionTransport({}, {
      async beginInteraction(input) {
        orders.push(input.order);
        attempts += 1;
        if (attempts === 1) throw new Error('connection reset before admission');
        return { status: 'accepted', generation: input.generation, ownerViewId: 'attachment-a' };
      },
      async finalizeInteraction() { throw new Error('unused'); },
      async releaseInteraction() { return { status: 'released' }; },
      async acknowledgeInteraction() { return { status: 'released' }; },
    });

    await expect(beginReviewInteraction(ordered, 7, 'reused-after-error')).rejects.toThrow('connection reset');
    const accepted = await beginReviewInteraction(ordered, 7, 'reused-after-error');
    await accepted.release();
    expect(orders).toEqual([1, 3]);
  });

  it('drains an abandoned release after the connection recovers without waiting for user traffic', async () => {
    vi.useFakeTimers();
    try {
      const requests: Array<{ interactionToken: string; order: number }> = [];
      let connectionHealthy = false;
      const ordered = attachmentOrderedInteractionTransport({}, {
        async beginInteraction() { throw new Error('unused'); },
        async finalizeInteraction() { throw new Error('unused'); },
        async releaseInteraction(input) {
          requests.push(input);
          if (!connectionHealthy) throw new Error('connection unavailable');
          return { status: 'released' };
        },
        async acknowledgeInteraction() { throw new Error('unused'); },
      });

      await expect(ordered.releaseInteraction({ interactionToken: 'abandoned-release', order: 99 }))
        .rejects.toThrow('connection unavailable');
      expect(requests).toEqual([
        { interactionToken: 'abandoned-release', order: 1 },
        { interactionToken: 'abandoned-release', order: 1 },
      ]);

      connectionHealthy = true;
      await vi.advanceTimersByTimeAsync(25);
      expect(requests).toEqual([
        { interactionToken: 'abandoned-release', order: 1 },
        { interactionToken: 'abandoned-release', order: 1 },
        { interactionToken: 'abandoned-release', order: 1 },
      ]);
      await expect(ordered.releaseInteraction({ interactionToken: 'abandoned-release', order: 100 }))
        .resolves.toEqual({ status: 'released' });
      expect(requests).toHaveLength(3);
      ordered.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels abandoned release retries and ordering state when the last adapter lease is disposed', async () => {
    vi.useFakeTimers();
    try {
      const identity = {};
      let releaseAttempts = 0;
      const transport = {
        async beginInteraction(input: { interactionToken: string; order: number; generation: number }) {
          return { status: 'accepted', generation: input.generation, ownerViewId: 'attachment-a' };
        },
        async finalizeInteraction() { throw new Error('unused'); },
        async releaseInteraction() {
          releaseAttempts += 1;
          throw new Error('connection unavailable');
        },
        async acknowledgeInteraction() { throw new Error('unused'); },
      };
      const abandoned = attachmentOrderedInteractionTransport(identity, transport);
      await expect(abandoned.releaseInteraction({ interactionToken: 'cancelled-release', order: 9 }))
        .rejects.toThrow('connection unavailable');
      abandoned.dispose();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(releaseAttempts).toBe(2);

      const successorCalls: Array<{ method: string; order: number }> = [];
      const successor = attachmentOrderedInteractionTransport(identity, {
        async beginInteraction(input) {
          successorCalls.push({ method: 'begin', order: input.order });
          return { status: 'accepted', generation: input.generation, ownerViewId: 'attachment-b' };
        },
        async finalizeInteraction() { throw new Error('unused'); },
        async releaseInteraction(input) {
          successorCalls.push({ method: 'release', order: input.order });
          return { status: 'released' };
        },
        async acknowledgeInteraction() { throw new Error('unused'); },
      });
      const interaction = await beginReviewInteraction(successor, 8, 'successor');
      await interaction.release();
      expect(successorCalls).toEqual([
        { method: 'begin', order: 1 },
        { method: 'release', order: 2 },
      ]);
      successor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps shared attachment ordering alive until every adapter lease is disposed', async () => {
    const identity = {};
    const orders: number[] = [];
    const transport = {
      async beginInteraction(input: { interactionToken: string; order: number; generation: number }) {
        orders.push(input.order);
        return { status: 'accepted', generation: input.generation, ownerViewId: 'attachment-a' };
      },
      async finalizeInteraction() { throw new Error('unused'); },
      async releaseInteraction(input: { interactionToken: string; order: number }) {
        orders.push(input.order);
        return { status: 'released' };
      },
      async acknowledgeInteraction() { throw new Error('unused'); },
    };
    const first = attachmentOrderedInteractionTransport(identity, transport);
    const survivor = attachmentOrderedInteractionTransport(identity, transport);
    first.dispose();

    const interaction = await beginReviewInteraction(survivor, 7, 'survivor');
    await interaction.release();
    expect(orders).toEqual([1, 2]);
    survivor.dispose();
  });

  it('reacquires with the exact begin request and recovers a matching finalized receipt', async () => {
    const beginRequests: Array<{ interactionToken: string; order: number; generation: number }> = [];
    let beginAttempts = 0;
    const interaction = await beginReviewInteraction({
      async beginInteraction(input) {
        beginRequests.push(input);
        beginAttempts += 1;
        if (beginAttempts === 1) {
          return { status: 'accepted', generation: input.generation, ownerViewId: 'attachment-a' };
        }
        return {
          status: 'finalized',
          interactionToken: input.interactionToken,
          generation: input.generation,
          outcome: 'applied',
          reviewRevision: 4,
        };
      },
      async finalizeInteraction() { throw new Error('unused'); },
      async releaseInteraction() { throw new Error('unused'); },
      async acknowledgeInteraction() { throw new Error('unused'); },
    }, 7, 'reacquired-interaction', 5);

    await expect(interaction.reacquire()).resolves.toEqual({
      status: 'finalized',
      interactionToken: 'reacquired-interaction',
      generation: 7,
      outcome: 'applied',
      reviewRevision: 4,
    });
    expect(beginRequests).toEqual([
      { interactionToken: 'reacquired-interaction', order: 5, generation: 7 },
      { interactionToken: 'reacquired-interaction', order: 5, generation: 7 },
    ]);
  });

  it('accepts a current reacquired hold and rejects a stale one', async () => {
    let beginAttempts = 0;
    const interaction = await beginReviewInteraction({
      async beginInteraction(input) {
        beginAttempts += 1;
        if (beginAttempts < 3) {
          return { status: 'accepted', generation: input.generation, ownerViewId: 'attachment-a' };
        }
        return { status: 'stale', generation: input.generation + 1 };
      },
      async finalizeInteraction() { throw new Error('unused'); },
      async releaseInteraction() { throw new Error('unused'); },
      async acknowledgeInteraction() { throw new Error('unused'); },
    }, 7, 'reacquired-hold', 3);

    await expect(interaction.reacquire()).resolves.toBeUndefined();
    await expect(interaction.reacquire()).rejects.toThrow('Current generation: 8');
  });

  it('does not release an existing hold when its exact begin replay loses the connection', async () => {
    let beginAttempts = 0;
    let releaseAttempts = 0;
    const ordered = attachmentOrderedInteractionTransport({}, {
      async beginInteraction(input) {
        beginAttempts += 1;
        if (beginAttempts > 1) throw new Error('connection lost during replay');
        return { status: 'accepted', generation: input.generation, ownerViewId: 'attachment-a' };
      },
      async finalizeInteraction() { throw new Error('unused'); },
      async releaseInteraction() {
        releaseAttempts += 1;
        return { status: 'released' };
      },
      async acknowledgeInteraction() { throw new Error('unused'); },
    });
    const interaction = await beginReviewInteraction(ordered, 7, 'replayed-hold', 2);

    await expect(interaction.reacquire()).rejects.toThrow('connection lost during replay');
    expect(releaseAttempts).toBe(0);
    ordered.dispose();
  });

  it('keeps the exact finalization identity across failure and acknowledges only after receipt consumption', async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    let finalizeAttempts = 0;
    const interaction = await beginReviewInteraction({
      beginInteraction: async (input) => {
        calls.push({ method: 'begin', input });
        return { status: 'accepted', generation: 7, ownerViewId: 'attachment-a' };
      },
      finalizeInteraction: async (input) => {
        calls.push({ method: 'finalize', input });
        finalizeAttempts += 1;
        if (finalizeAttempts === 1) throw new Error('connection reset after send');
        return {
          status: 'finalized',
          sessionId: 'authoring-session',
          attachmentId: 'attachment-a',
          interactionToken: input.interactionToken,
          generation: 7,
          outcome: input.outcome,
          reviewRevision: 3,
        };
      },
      releaseInteraction: async (input) => {
        calls.push({ method: 'release', input });
        return { status: 'released' };
      },
      acknowledgeInteraction: async (input) => {
        calls.push({ method: 'acknowledge', input });
        return { status: 'released' };
      },
    }, 7, 'interaction-authoring-1', 4);

    expect(interaction.ownerViewId).toBe('attachment-a');
    await expect(interaction.finalize('applied', 'draft-authoring-1', 2)).rejects.toThrow('connection reset');
    const receipt = await interaction.finalize('applied', 'draft-authoring-1', 2);
    expect(calls.filter(({ method }) => method === 'finalize').map(({ input }) => input)).toEqual([
      { interactionToken: 'interaction-authoring-1', order: 5, outcome: 'applied', draftId: 'draft-authoring-1', expectedDraftRevision: 2 },
      { interactionToken: 'interaction-authoring-1', order: 5, outcome: 'applied', draftId: 'draft-authoring-1', expectedDraftRevision: 2 },
    ]);
    expect(calls.some(({ method }) => method === 'acknowledge')).toBe(false);
    await interaction.acknowledge(receipt);
    expect(calls.at(-1)).toEqual({
      method: 'acknowledge',
      input: { interactionToken: 'interaction-authoring-1', order: 6 },
    });
  });

  it('settles a failed applied finalization before Delete can enter discard', async () => {
    const methods: string[] = [];
    let finalizeAttempts = 0;
    const interaction = await beginReviewInteraction({
      async beginInteraction(input) {
        methods.push('begin');
        return { status: 'accepted', generation: input.generation, ownerViewId: 'attachment-a' };
      },
      async finalizeInteraction(input) {
        methods.push('finalize');
        finalizeAttempts += 1;
        if (finalizeAttempts === 1) throw new Error('response lost after apply');
        return {
          status: 'finalized', interactionToken: input.interactionToken,
          generation: 7, outcome: input.outcome, reviewRevision: 4,
        };
      },
      async releaseInteraction() {
        methods.push('release');
        return { status: 'released' };
      },
      async acknowledgeInteraction() {
        methods.push('acknowledge');
        return { status: 'released' };
      },
    }, 7, 'reattach-delete-after-failed-finalize');
    const terminal = {
      interaction,
      draftId: 'draft-after-failed-finalize',
      expectedDraftRevision: 2,
    };

    await expect(interaction.finalize(
      'applied', terminal.draftId, terminal.expectedDraftRevision,
    )).rejects.toThrow('response lost after apply');
    let discardOpened = false;
    await resolveReattachmentDiscardIntent(terminal, async (pending) => {
      const receipt = await pending.interaction.finalize(
        'applied', pending.draftId, pending.expectedDraftRevision,
      );
      await pending.interaction.acknowledge(receipt);
    }, () => { discardOpened = true; });

    expect(methods).toEqual(['begin', 'finalize', 'finalize', 'acknowledge']);
    expect(discardOpened).toBe(false);
  });

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
      authority: { sessionId: state.sessionId, sourceIdentity: expect.any(String), documentGeneration: 7 },
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
            pageBoundaries: [{ afterPageIndex: 2, separator: '\n' }],
          },
        },
      },
    });
    expect((preview?.custom as { placekeeper?: { item?: { payload?: unknown } } })
      ?.placekeeper?.item?.payload).not.toHaveProperty('pages');
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
