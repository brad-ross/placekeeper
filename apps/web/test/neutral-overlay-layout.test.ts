import { describe, expect, it } from 'vitest';

import { measureReviewOverlayGeometry } from '../src/review/use-review-overlay-geometry.js';
import { chooseContextActionPlacement } from '../src/review/ContextActionPalette.js';
import { choosePassageEditorPlacement } from '../src/review/use-passage-editor-placement.js';

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

describe('neutral overlay geometry', () => {
  it('backs the twelve-pixel tray gutters from actual right and bottom bounds', () => {
    const geometry = measureReviewOverlayGeometry({
      stage: rect(100, 50, 1_000, 700),
      surfaces: [
        { open: true, presentation: 'right', bounds: rect(784, 50, 304, 394) },
        { open: true, presentation: 'bottom', bounds: rect(112, 456, 976, 282) },
      ],
    });

    expect(geometry.rightStart).toBe(672);
    expect(geometry.bottomStart).toBe(394);
  });

  it('keeps classic scrollbars inside the common outside inset and fades only before extents', () => {
    const geometry = measureReviewOverlayGeometry({
      stage: rect(0, 0, 800, 600),
      surfaces: [],
      scrollport: {
        offsetWidth: 800,
        clientWidth: 783,
        offsetHeight: 600,
        clientHeight: 585,
        scrollWidth: 1_200,
        scrollHeight: 900,
        scrollLeft: 50,
        scrollTop: 315,
      },
    });

    expect(geometry).toMatchObject({
      outsideInset: 17,
      scrollbarWidth: 17,
      scrollbarHeight: 15,
      fadeTop: true,
      fadeRight: true,
      fadeBottom: false,
    });
  });
});

describe('passage editor placement', () => {
  it('prefers available side space and keeps that choice while it remains valid', () => {
    const initial = choosePassageEditorPlacement({
      stage: rect(0, 0, 1_100, 760),
      target: rect(360, 250, 120, 30),
      editorWidth: 326,
      editorHeight: 232,
      rightBoundary: 784,
    });
    expect(initial.kind).toBe('side');

    const retained = choosePassageEditorPlacement({
      stage: rect(0, 0, 1_100, 760),
      target: rect(372, 265, 120, 30),
      editorWidth: 326,
      editorHeight: 232,
      rightBoundary: 784,
      previous: initial.kind,
    });
    expect(retained.kind).toBe('side');
  });

  it('uses below then above without covering the target, independent of viewport width', () => {
    expect(choosePassageEditorPlacement({
      stage: rect(0, 0, 760, 760),
      target: rect(260, 170, 220, 30),
      editorWidth: 326,
      editorHeight: 232,
      rightBoundary: 650,
    }).kind).toBe('below');

    expect(choosePassageEditorPlacement({
      stage: rect(0, 0, 760, 760),
      target: rect(260, 650, 220, 30),
      editorWidth: 326,
      editorHeight: 232,
      rightBoundary: 650,
    }).kind).toBe('above');

    expect(choosePassageEditorPlacement({
      stage: rect(0, 0, 600, 760),
      target: rect(160, 240, 220, 30),
      editorWidth: 326,
      editorHeight: 232,
    }).kind).toBe('below');

    expect(choosePassageEditorPlacement({
      stage: rect(0, 0, 360, 280),
      target: rect(40, 120, 280, 30),
      editorWidth: 326,
      editorHeight: 232,
    }).kind).toBe('bottom-sheet');
  });
});


describe('selection action placement', () => {
  it('places actions above the whole selected passage rather than over the following line', () => {
    expect(chooseContextActionPlacement({
      selection: rect(300, 160, 120, 24), available: rect(12, 52, 900, 600),
      width: 160, height: 40,
    })).toEqual({ left: 280, top: 113 });
  });

  it('flips below a selection near the top without overlapping its last line', () => {
    const placement = chooseContextActionPlacement({
      selection: rect(300, 60, 160, 60), available: rect(12, 52, 900, 400),
      width: 160, height: 40,
    });
    expect(placement.top).toBe(127);
  });

  it('uses the selection top when avoiding a bottom tray after zoom', () => {
    const placement = chooseContextActionPlacement({
      selection: rect(300, 170, 160, 70), available: rect(12, 52, 900, 220),
      width: 160, height: 50,
    });
    expect(placement.top + 50).toBeLessThan(170);
  });
});
