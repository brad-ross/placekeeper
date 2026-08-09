import { describe, expect, it } from 'vitest';

import {
  FramingSessionAuthority,
  chooseAnnotationPresentation,
  intersectViewerRects,
  revealDelta,
  restoreViewportPosition,
  unionViewerRects,
} from '../src/pdf/viewer-framing.js';

describe('viewer framing', () => {
  it('uses existing margin and moves only by the remaining overlap', () => {
    expect(revealDelta({ start: 100, end: 600 }, { start: 0, end: 700 })).toBe(0);
    expect(revealDelta({ start: 100, end: 820 }, { start: 0, end: 700 })).toBe(120);
  });

  it('unions every segment for one canonical annotation', () => {
    expect(unionViewerRects([
      { left: 620, top: 100, right: 670, bottom: 112 },
      { left: 610, top: 116, right: 690, bottom: 128 },
    ])).toEqual({ left: 610, top: 100, right: 690, bottom: 128 });
  });

  it('clips general reading context to the pre-open visible page area', () => {
    expect(intersectViewerRects(
      { left: -300, top: 40, right: 900, bottom: 780 },
      { left: 0, top: 0, right: 700, bottom: 700 },
    )).toEqual({ left: 0, top: 40, right: 700, bottom: 700 });
    expect(intersectViewerRects(
      { left: -300, top: 40, right: -10, bottom: 780 },
      { left: 0, top: 0, right: 700, bottom: 700 },
    )).toBeNull();
  });

  it('caps impossible reveals while preserving reachability', () => {
    expect(revealDelta({ start: -300, end: 900 }, { start: 0, end: 700 })).toBe(200);
    expect(revealDelta({ start: 620, end: 760 }, { start: 0, end: 700 }, 10)).toBe(70);
  });

  it('selects presentation from prospective side width with hysteresis', () => {
    expect(chooseAnnotationPresentation({ stageWidth: 864, sideWidth: 384, previous: 'right' })).toBe('right');
    expect(chooseAnnotationPresentation({ stageWidth: 863, sideWidth: 384, previous: 'right' })).toBe('bottom');
    expect(chooseAnnotationPresentation({ stageWidth: 880, sideWidth: 384, previous: 'bottom' })).toBe('bottom');
    expect(chooseAnnotationPresentation({ stageWidth: 888, sideWidth: 384, previous: 'bottom' })).toBe('right');
  });

  it('restores untouched automatic movement component by component', () => {
    expect(restoreViewportPosition({
      baseline: { left: 40, top: 100 },
      current: { left: 160, top: 240 },
      automatic: { left: 120, top: 0 },
      userRevision: 0,
      maximum: { left: 400, top: 500 },
    })).toEqual({ left: 40, top: 240 });
    expect(restoreViewportPosition({
      baseline: { left: 40, top: 100 },
      current: { left: 260, top: 240 },
      automatic: { left: 120, top: 0 },
      userRevision: 1,
      maximum: { left: 200, top: 220 },
    })).toEqual({ left: 200, top: 220 });
    expect(restoreViewportPosition({
      baseline: { left: 40, top: 100 },
      current: { left: 160, top: 240 },
      automatic: { left: 120, top: 0 },
      userRevision: 1,
      userAxes: { left: false, top: true },
      maximum: { left: 400, top: 500 },
    })).toEqual({ left: 40, top: 240 });
  });

  it('invalidates stale automatic operations and document generations', () => {
    const authority = new FramingSessionAuthority();
    const first = authority.open('doc-a', 'right');
    expect(authority.isCurrent(first)).toBe(true);
    authority.markUserNavigation();
    expect(authority.snapshot()?.userRevision).toBe(1);
    expect(authority.isCurrent(first)).toBe(false);
    const second = authority.open('doc-a', 'bottom');
    expect(authority.isCurrent(first)).toBe(false);
    expect(authority.isCurrent(second)).toBe(true);
    authority.invalidateDocument('doc-b');
    expect(authority.isCurrent(second)).toBe(false);
  });
});
