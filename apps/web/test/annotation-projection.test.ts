import { describe, expect, it } from 'vitest';

import {
  mergeAuthoringPreviewProjections,
  projectReviewItems,
} from '../src/review/annotation-projection.js';
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
  it('renames owned annotations while preserving native authors and both dates', () => {
    const owned = item('highlight', 'owned', 0, selection);
    const native = item('pdfAnnotation', 'native', 0, {
      position: selection.rect, comment: 'Native', subtype: 'text', author: 'Other reviewer',
    });
    const projected = projectReviewItems([owned, native], undefined, { annotationName: 'Brad Ross' });
    expect(projected.find(a => a.id === 'owned')).toMatchObject({ author: 'Brad Ross', createdAt: timestamp, modifiedAt: timestamp });
    expect(projected.find(a => a.id === 'native')).toMatchObject({ author: 'Other reviewer', createdAt: timestamp, modifiedAt: timestamp });
  });

  it('projects every canonical page while retaining one logical item identity', () => {
    const projected = projectReviewItems([
      item('highlight', 'cross-page', 1, {
        quote: 'first\nsecond\nthird',
        prefix: 'before ',
        suffix: ' after',
        rect: { x: 12, y: 80, width: 60, height: 12 },
        segmentRects: [{ x: 12, y: 80, width: 60, height: 12 }],
        pages: [
          {
            pageIndex: 1,
            quote: 'first',
            prefix: 'before ',
            suffix: '',
            rect: { x: 12, y: 80, width: 60, height: 12 },
            segmentRects: [{ x: 12, y: 80, width: 60, height: 12 }],
          },
          {
            pageIndex: 2,
            quote: 'second',
            prefix: '',
            suffix: '',
            rect: { x: 12, y: 18, width: 68, height: 12 },
            segmentRects: [{ x: 12, y: 18, width: 68, height: 12 }],
          },
          {
            pageIndex: 3,
            quote: 'third',
            prefix: '',
            suffix: ' after',
            rect: { x: 12, y: 14, width: 54, height: 12 },
            segmentRects: [{ x: 12, y: 14, width: 54, height: 12 }],
          },
        ],
        pageBoundaries: [
          { afterPageIndex: 1, separator: '\n' },
          { afterPageIndex: 2, separator: '\n' },
        ],
        reliable: true,
        comment: 'One comment',
      }),
    ]);

    expect(projected.map(({ id, pageIndex, reviewItemId, projectionIndex, projectionCount, rect }) => ({
      id,
      pageIndex,
      reviewItemId,
      projectionIndex,
      projectionCount,
      y: rect.y,
    }))).toEqual([
      {
        id: 'cross-page:projection:1',
        pageIndex: 1,
        reviewItemId: 'cross-page',
        projectionIndex: 0,
        projectionCount: 3,
        y: 80,
      },
      {
        id: 'cross-page:projection:2',
        pageIndex: 2,
        reviewItemId: 'cross-page',
        projectionIndex: 1,
        projectionCount: 3,
        y: 18,
      },
      {
        id: 'cross-page:projection:3',
        pageIndex: 3,
        reviewItemId: 'cross-page',
        projectionIndex: 2,
        projectionCount: 3,
        y: 14,
      },
    ]);

    const preview = projected.map((projection) => ({ ...projection, contents: 'Edited comment' }));
    expect(mergeAuthoringPreviewProjections(projected, preview)).toEqual(preview);
  });

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
