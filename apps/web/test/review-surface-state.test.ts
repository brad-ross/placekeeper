import { describe, expect, it } from 'vitest';

import {
  INITIAL_REVIEW_SURFACE_STATE,
  reduceReviewSurface,
} from '../src/review/review-surface-state.js';

describe('review presentation state', () => {
  it('keeps one exclusive base surface and an orthogonal nested layer', () => {
    const annotations = reduceReviewSurface(INITIAL_REVIEW_SURFACE_STATE, {
      type: 'open-base',
      surface: 'annotations',
    });
    const nested = reduceReviewSurface(annotations, { type: 'open-nested' });
    const finish = reduceReviewSurface(nested, { type: 'open-base', surface: 'finish' });

    expect(annotations).toEqual({ baseSurface: 'annotations', nestedLayer: 'none' });
    expect(nested).toEqual({ baseSurface: 'annotations', nestedLayer: 'composer' });
    expect(finish).toEqual({ baseSurface: 'finish', nestedLayer: 'composer' });
  });

  it('unwinds Escape from nested layer to base surface to reading', () => {
    const open = { baseSurface: 'finish', nestedLayer: 'composer' } as const;
    const withoutNested = reduceReviewSurface(open, { type: 'escape' });
    const reading = reduceReviewSurface(withoutNested, { type: 'escape' });

    expect(withoutNested).toEqual({ baseSurface: 'finish', nestedLayer: 'none' });
    expect(reading).toEqual(INITIAL_REVIEW_SURFACE_STATE);
    expect(reduceReviewSurface(reading, { type: 'escape' })).toBe(reading);
  });
});
