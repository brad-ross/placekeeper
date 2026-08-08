import { describe, expect, it } from 'vitest';

import {
  INITIAL_REVIEW_SURFACE_STATE,
  PageNotePlacementAuthority,
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

    expect(annotations).toEqual({ baseSurface: 'annotations', nestedLayer: 'none', transientSurface: 'none' });
    expect(nested).toEqual({ baseSurface: 'annotations', nestedLayer: 'composer', transientSurface: 'none' });
    expect(finish).toEqual({ baseSurface: 'finish', nestedLayer: 'composer', transientSurface: 'none' });
  });

  it('unwinds Escape from nested layer to base surface to reading', () => {
    const open = { baseSurface: 'finish', nestedLayer: 'composer', transientSurface: 'none' } as const;
    const withoutNested = reduceReviewSurface(open, { type: 'escape' });
    const reading = reduceReviewSurface(withoutNested, { type: 'escape' });

    expect(withoutNested).toEqual({ baseSurface: 'finish', nestedLayer: 'none', transientSurface: 'none' });
    expect(reading).toEqual(INITIAL_REVIEW_SURFACE_STATE);
    expect(reduceReviewSurface(reading, { type: 'escape' })).toBe(reading);
  });

  it('keeps contextual surfaces exclusive and lets Escape unwind the topmost one', () => {
    const selection = reduceReviewSurface(INITIAL_REVIEW_SURFACE_STATE, {
      type: 'open-transient',
      surface: 'selection-actions',
    });
    const menu = reduceReviewSurface(selection, { type: 'open-transient', surface: 'page-menu' });

    expect(selection.transientSurface).toBe('selection-actions');
    expect(menu.transientSurface).toBe('page-menu');
    expect(reduceReviewSurface(menu, { type: 'escape' })).toEqual(INITIAL_REVIEW_SURFACE_STATE);
  });

  it('consumes context placement once and invalidates it with its invocation', () => {
    const authority = new PageNotePlacementAuthority();
    const point = { documentId: 'doc', pageIndex: 2, viewportGeneration: 4, x: 30, y: 40 };
    authority.setContextPoint('menu-1', point);

    expect(authority.consumeContextPoint('menu-2')).toBeNull();
    expect(authority.consumeContextPoint('menu-1')).toEqual(point);
    expect(authority.consumeContextPoint('menu-1')).toBeNull();
  });

  it('binds keyboard placement to document/page/viewport generation and consumes it once', () => {
    const authority = new PageNotePlacementAuthority();
    const point = { documentId: 'doc', pageIndex: 1, viewportGeneration: 8, x: 50, y: 60 };
    authority.setKeyboardCursor(point);

    expect(authority.consumeKeyboardCursor({ documentId: 'doc', pageIndex: 1, viewportGeneration: 7 })).toBeNull();
    expect(authority.consumeKeyboardCursor({ documentId: 'doc', pageIndex: 1, viewportGeneration: 8 })).toEqual(point);
    expect(authority.consumeKeyboardCursor({ documentId: 'doc', pageIndex: 1, viewportGeneration: 8 })).toBeNull();
  });
});
