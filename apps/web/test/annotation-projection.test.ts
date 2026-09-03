import { describe, expect, it } from 'vitest';

import { projectReviewItems } from '../src/review/annotation-projection.js';
import type { ReviewItem } from '../../../packages/core/src/review-model.js';

const timestamp = '2026-08-07T12:00:00.000Z';
function item(kind: ReviewItem['kind'], id: string, pageIndex: number, payload: ReviewItem['payload']): ReviewItem {
  return { id, kind, pageIndex, payload, createdAt: timestamp, updatedAt: timestamp };
}
const selection = {
  quote: 'claim', prefix: 'the ', suffix: ' holds',
  rect: { x: 40, y: 50, width: 60, height: 12 },
  segmentRects: [{ x: 40, y: 50, width: 60, height: 12 }],
  reliable: true,
};

describe('canonical annotation projection', () => {
  it('projects every v1 semantic kind exhaustively and orders marks by document position', () => {
    const projected = projectReviewItems([
      item('pageNote', '00000000-0000-4000-8000-000000000005', 1, {
        position: { x: 10, y: 10, width: 18, height: 18 }, comment: 'Page note',
      }),
      item('insert', '00000000-0000-4000-8000-000000000003', 0, {
        position: { x: 30, y: 40, width: 2, height: 12 }, leftContext: 'left', rightContext: 'right', reliable: true, proposedText: 'inserted',
      }),
      item('replace', '00000000-0000-4000-8000-000000000001', 0, { ...selection, proposedText: 'replacement' }),
      item('highlight', '00000000-0000-4000-8000-000000000004', 0, { ...selection, rect: { ...selection.rect, y: 70 }, comment: 'Comment' }),
      item('delete', '00000000-0000-4000-8000-000000000002', 0, { ...selection, rect: { ...selection.rect, y: 60 } }),
    ]);

    expect(projected.map(({ kind }) => kind)).toEqual(['insert', 'replace', 'delete', 'highlight', 'pageNote']);
    expect(Object.fromEntries(projected.map(({ kind, contents }) => [kind, contents]))).toEqual({
      insert: 'inserted', replace: 'replacement', delete: '', highlight: 'Comment', pageNote: 'Page note',
    });
    expect(projected.every(({ id }) => id.startsWith('00000000-'))).toBe(true);
    expect(projected.filter(({ kind }) => kind !== 'pageNote').every(({ textAnchorReliable }) => textAnchorReliable)).toBe(true);
  });

  it('projects only geometry resolved to the active generation', () => {
    const resolved = item('highlight', 'resolved', 0, { ...selection, comment: 'Current' });
    const unresolved = item('highlight', 'unresolved', 0, { ...selection, comment: 'Old' });
    const canonical = (value: ReviewItem, disposition: NonNullable<ReviewItem['reconciliation']>['disposition']): ReviewItem => ({
      ...value,
      reconciliation: {
        schemaVersion: 1,
        ownerViewId: 'view-1',
        baseGeneration: 6,
        revision: 2,
        anchor: {
          kind: 'selection',
          pageIndex: 0,
          quote: selection.quote,
          prefix: selection.prefix,
          suffix: selection.suffix,
          rect: selection.rect,
          segmentRects: selection.segmentRects,
        },
        disposition,
        previousAnchors: [],
      },
    });

    expect(projectReviewItems([
      canonical(resolved, { kind: 'resolved', generation: 7 }),
      canonical(unresolved, { kind: 'ambiguous', reason: 'two matches' }),
    ], 7).map(({ id }) => id)).toEqual(['resolved']);
  });
});
