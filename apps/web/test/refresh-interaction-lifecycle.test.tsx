import { describe, expect, it } from 'vitest';

import { reduceReview } from '../../../packages/core/src/review-reducer.js';
import { createReviewState, type ReviewState } from '../../../packages/core/src/review-model.js';
import {
  beginReviewInteraction,
  createAuthoringSession,
  pendingDraftForAuthoring,
  type ReviewInteractionReceipt,
} from '../src/review/authoring-session.js';

const selection = {
  pageIndex: 0,
  quote: 'identified passage',
  prefix: 'the ',
  suffix: ' remains',
  rect: { x: 20, y: 30, width: 80, height: 12 },
  segmentRects: [{ x: 20, y: 30, width: 80, height: 12 }],
  reliable: true as const,
};

describe('automatic refresh interaction lifecycle', () => {
  it.each(['standard', 'generated-output'] as const)(
    'durably applies the latest %s draft before releasing its generation hold',
    async (workflowMode) => {
      let state: ReviewState = createReviewState({
        sessionId: `session-${workflowMode}`,
        source: { fileId: 'paper', digest: 'a'.repeat(64), byteLength: 10 },
        workflowMode,
        documentGeneration: 4,
      });
      let held = false;
      let acknowledged = false;
      const interaction = await beginReviewInteraction({
        async beginInteraction() {
          held = true;
          return { status: 'accepted', generation: 4, ownerViewId: 'attachment-main' };
        },
        async finalizeInteraction(input) {
          expect(held).toBe(true);
          state = reduceReview(state, {
            type: 'apply-draft',
            expectedRevision: state.revision,
            id: input.draftId,
            expectedDraftRevision: input.expectedDraftRevision,
            ownerViewId: 'attachment-main',
            updatedAt: '2026-09-15T13:00:02.000Z',
          });
          held = false;
          return {
            status: 'finalized', interactionToken: input.interactionToken,
            generation: 4, outcome: input.outcome, reviewRevision: state.revision,
          } satisfies ReviewInteractionReceipt;
        },
        async releaseInteraction() { held = false; return { status: 'released' }; },
        async acknowledgeInteraction() { acknowledged = true; return { status: 'released' }; },
      }, 4, `interaction-${workflowMode}`);
      const session = createAuthoringSession({
        token: 1,
        authority: { sourceIdentity: 'source', documentGeneration: 4 },
        source: { kind: 'highlight', anchor: selection, selectionGeneration: 2 },
        origin: { kind: 'selection', trigger: null },
        workspace: { open: false, mode: 'annotations', annotationScrollTop: 0 },
        interaction,
        draftId: workflowMode === 'standard'
          ? '00000000-0000-4000-8000-000000000301'
          : '00000000-0000-4000-8000-000000000302',
      });
      const draft = pendingDraftForAuthoring({
        session,
        ownerViewId: interaction.ownerViewId,
        text: 'latest acknowledged comment',
        revision: 0,
        createdAt: '2026-09-15T13:00:00.000Z',
        updatedAt: '2026-09-15T13:00:01.000Z',
      });
      state = reduceReview(state, {
        type: 'put-draft', expectedRevision: state.revision,
        expectedDraftRevision: -1, draft,
      });

      const receipt = await interaction.finalize('applied', draft.id, draft.revision);
      expect(held).toBe(false);
      expect(acknowledged).toBe(false);
      expect(state.pendingDrafts).toEqual([]);
      expect(state.items[0]).toMatchObject({
        id: draft.id,
        payload: { comment: 'latest acknowledged comment' },
        reconciliation: { ownerViewId: 'attachment-main' },
      });
      await interaction.acknowledge(receipt);
      expect(acknowledged).toBe(true);
    },
  );
});
