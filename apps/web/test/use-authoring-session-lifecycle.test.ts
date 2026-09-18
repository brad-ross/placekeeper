import { describe, expect, it, vi } from 'vitest';

import { createReviewState } from '../../../packages/core/src/review-model.js';
import {
  attachmentOrderedInteractionTransport,
  authoringAuthorityFor,
  beginReviewInteraction,
  type ReviewInteractionHandle,
  type ReviewInteractionReceipt,
} from '../src/review/authoring-session.js';
import { ReviewInteractions } from '../../service/src/sessions/review-interactions.js';
import {
  AuthoringAcknowledgementQueue,
  canonicalStateForFinalizedInteraction,
  consumeFinalizedInteractionState,
  finalizeReacquiredInteraction,
  releaseDeletedAuthoringInteraction,
} from '../src/review/use-authoring-session.js';

function receipt(interactionToken: string): ReviewInteractionReceipt {
  return {
    status: 'finalized',
    interactionToken,
    generation: 4,
    outcome: 'applied',
    reviewRevision: 8,
  };
}

function interaction(
  interactionToken: string,
  overrides: Partial<ReviewInteractionHandle> = {},
): ReviewInteractionHandle {
  return {
    interactionToken,
    generation: 4,
    ownerViewId: 'attachment-stable',
    reacquire: vi.fn(async () => undefined),
    finalize: vi.fn(async () => receipt(interactionToken)),
    acknowledge: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    ...overrides,
  };
}

function reviewState(documentGeneration: number, sessionId = 'canonical-session') {
  return createReviewState({
    sessionId,
    source: { fileId: `paper-${documentGeneration}`, digest: String(documentGeneration).repeat(64), byteLength: 12 },
    documentGeneration,
  });
}

describe('authoring interaction lifecycle ownership', () => {
  it('keeps finalized authoring open until the canonical state reaches its receipt revision', () => {
    const finalized = receipt('canonical-state-gate');
    const state = { ...reviewState(finalized.generation), revision: finalized.reviewRevision - 1 };
    const authority = authoringAuthorityFor(state, finalized.generation);

    expect(canonicalStateForFinalizedInteraction(
      state,
      finalized.generation,
      finalized,
      authority,
    )).toBeUndefined();
    const canonical = { ...state, revision: finalized.reviewRevision };
    expect(canonicalStateForFinalizedInteraction(
      canonical,
      finalized.generation,
      finalized,
      authority,
    )).toBe(canonical);
  });

  it.each(['applied', 'discarded'] as const)(
    'settles a finalized %s receipt from authoritative same-session successor state',
    (outcome) => {
      const finalized = { ...receipt(`successor-${outcome}`), outcome };
      const source = reviewState(finalized.generation);
      const successor = reviewState(finalized.generation + 1);

      expect(canonicalStateForFinalizedInteraction(
        successor,
        finalized.generation + 1,
        finalized,
        authoringAuthorityFor(source, finalized.generation),
      )).toBe(successor);
    },
  );

  it('never binds a receipt to an unrelated successor that arrived before settlement', () => {
    const finalized = receipt('unrelated-successor-gate');
    const source = reviewState(finalized.generation);
    const unrelated = reviewState(finalized.generation + 1, 'another-session');

    expect(canonicalStateForFinalizedInteraction(
      unrelated,
      finalized.generation + 1,
      finalized,
      authoringAuthorityFor(source, finalized.generation),
    )).toBeUndefined();
  });

  it.each(['applied', 'discarded'] as const)(
    'settles a %s receipt when unrelated state won the race before receipt delivery',
    (outcome) => {
      const finalized = { ...receipt(`pre-receipt-replacement-${outcome}`), outcome };
      const source = reviewState(finalized.generation);
      const unrelated = reviewState(finalized.generation + 1, 'replacement-session');
      const announce = vi.fn();
      const close = vi.fn();

      expect(consumeFinalizedInteractionState({
        state: unrelated,
        documentGeneration: finalized.generation + 1,
        receipt: finalized,
        authority: authoringAuthorityFor(source, finalized.generation),
        outcome,
        announce,
        close,
      })).toBe(true);
      expect(announce).toHaveBeenCalledWith(outcome === 'applied'
        ? 'The annotation was saved before the document changed.'
        : 'The cancellation was saved before the document changed.');
      expect(close).toHaveBeenCalledWith('source-replaced');
    },
  );

  it('never consumes replaced source state at the receipt generation', () => {
    const finalized = receipt('replaced-source-gate');
    const source = { ...reviewState(finalized.generation), revision: finalized.reviewRevision };
    const replaced = createReviewState({
      sessionId: source.sessionId,
      source: { fileId: 'replacement', digest: 'f'.repeat(64), byteLength: 18 },
      documentGeneration: finalized.generation,
    });

    expect(canonicalStateForFinalizedInteraction(
      { ...replaced, revision: finalized.reviewRevision },
      finalized.generation,
      finalized,
      authoringAuthorityFor(source, finalized.generation),
    )).toBeUndefined();
  });

  it('releases a concurrently deleted edit before allowing its editor to close', async () => {
    let finishRelease: (() => void) | undefined;
    const release = vi.fn(() => new Promise<void>((resolve) => { finishRelease = resolve; }));
    const settle = vi.fn();

    const pending = releaseDeletedAuthoringInteraction(interaction('deleted-edit', { release }), settle);
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    expect(settle).not.toHaveBeenCalled();

    finishRelease?.();
    await pending;
    expect(settle).toHaveBeenCalledOnce();
  });

  it('closes only after a failed release has been handed to durable ordered cleanup', async () => {
    const settle = vi.fn();
    await releaseDeletedAuthoringInteraction(interaction('queued-release', {
      release: vi.fn(async () => { throw new Error('connection lost after queueing release'); }),
    }), settle);
    expect(settle).toHaveBeenCalledOnce();
  });

  it('retains failed exact receipts without blocking acknowledgements for newer tokens', async () => {
    const queue = new AuthoringAcknowledgementQueue();
    const olderReceipt = receipt('older-token');
    const newerReceipt = receipt('newer-token');
    let olderAttempts = 0;
    const older = interaction('older-token', {
      acknowledge: vi.fn(async (actual) => {
        expect(actual).toBe(olderReceipt);
        olderAttempts += 1;
        if (olderAttempts === 1) throw new Error('temporary disconnect');
      }),
    });
    const newer = interaction('newer-token', {
      acknowledge: vi.fn(async (actual) => { expect(actual).toBe(newerReceipt); }),
    });

    queue.enqueue(older, olderReceipt);
    queue.enqueue(newer, newerReceipt);
    await queue.drain();

    expect(queue.has('older-token')).toBe(true);
    expect(queue.has('newer-token')).toBe(false);
    expect(newer.acknowledge).toHaveBeenCalledOnce();

    await queue.drain();
    expect(queue.has('older-token')).toBe(false);
    expect(older.acknowledge).toHaveBeenCalledTimes(2);
    queue.dispose();
  });

  it('reacquires the exact open interaction before first finalization', async () => {
    const active = interaction('resumed-token');
    await expect(finalizeReacquiredInteraction(
      active,
      'discarded',
      '00000000-0000-4000-8000-000000000444',
      3,
    )).resolves.toMatchObject({ interactionToken: 'resumed-token' });
    expect(active.reacquire).toHaveBeenCalledOnce();
    expect(active.finalize).toHaveBeenCalledWith(
      'discarded',
      '00000000-0000-4000-8000-000000000444',
      3,
    );
  });

  it('uses the exact recovered receipt after reconnect without replaying finalization', async () => {
    const recovered = receipt('recovered-token');
    const active = interaction('recovered-token', {
      reacquire: vi.fn(async () => recovered),
    });

    await expect(finalizeReacquiredInteraction(
      active,
      'applied',
      '00000000-0000-4000-8000-000000000445',
      2,
    )).resolves.toBe(recovered);
    expect(active.finalize).not.toHaveBeenCalled();
  });

  it('reacquires the same open editor on a real replacement attachment before finalizing', async () => {
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const broker = new ReviewInteractions({ currentGeneration: () => 4 });
    let attachment = broker.register(sessionId, 'browser-view');
    const authenticated = (input: { interactionToken: string; order: number }) => ({
      ...input,
      sessionId,
      attachmentId: attachment.attachmentId,
      incarnationId: attachment.incarnationId,
      capability: attachment.capability,
    });
    const transport = attachmentOrderedInteractionTransport({}, {
      beginInteraction: (input) => broker.begin({ ...authenticated(input), generation: input.generation }),
      finalizeInteraction: (input) => broker.finalize({
        ...authenticated(input),
        outcome: input.outcome,
        reviewRevision: 9,
      }),
      releaseInteraction: (input) => broker.release(authenticated(input)),
      acknowledgeInteraction: (input) => broker.acknowledge(authenticated(input)),
    });
    const active = await beginReviewInteraction(transport, 4, 'open-editor-token');
    expect(broker.held(sessionId)).toBe(true);

    attachment = broker.register(sessionId, 'browser-view');
    expect(broker.held(sessionId)).toBe(false);
    await expect(active.reacquire()).resolves.toBeUndefined();
    expect(broker.held(sessionId)).toBe(true);

    const finalized = await active.finalize(
      'applied',
      '00000000-0000-4000-8000-000000000446',
      0,
    );
    expect(finalized).toMatchObject({
      status: 'finalized',
      attachmentId: attachment.attachmentId,
      interactionToken: 'open-editor-token',
      generation: 4,
    });
    expect(broker.held(sessionId)).toBe(false);
    await active.acknowledge(finalized);
  });
});
