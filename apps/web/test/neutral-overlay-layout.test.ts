import { describe, expect, it } from 'vitest';

import { measureReviewOverlayGeometry } from '../src/review/use-review-overlay-geometry.js';
import {
  chooseContextActionAvailableRect,
  chooseContextActionPlacement,
} from '../src/review/ContextActionPalette.js';
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

  it('uses application space around a narrow reference tray before falling back to a sheet', () => {
    const applicationStage = rect(0, 0, 1_200, 760);
    const target = rect(300, 250, 120, 30);
    const main = choosePassageEditorPlacement({
      stage: applicationStage,
      target,
      editorWidth: 340,
      editorHeight: 232,
      rightBoundary: 650,
      placementScope: 'main',
    });
    const reference = choosePassageEditorPlacement({
      stage: applicationStage,
      target,
      editorWidth: 340,
      editorHeight: 232,
      rightBoundary: 650,
      placementScope: 'reference',
    });

    expect(main.kind).toBe('below');
    expect(reference.kind).toBe('side');
    expect(reference.style?.left).toBe('432px');
  });

  it('keeps reference popup coordinates inside every visual viewport edge', () => {
    const placement = choosePassageEditorPlacement({
      stage: rect(0, 0, 1_200, 900),
      target: rect(520, 360, 80, 30),
      editorWidth: 340,
      editorHeight: 232,
      placementScope: 'reference',
      applicationLeftBoundary: 212,
      applicationTopBoundary: 112,
      applicationRightBoundary: 788,
      applicationBottomBoundary: 688,
    });

    expect(Number.parseFloat(String(placement.style?.left))).toBeGreaterThanOrEqual(212);
    expect(Number.parseFloat(String(placement.style?.top))).toBeGreaterThanOrEqual(112);

    const sheet = choosePassageEditorPlacement({
      stage: rect(0, 0, 1_200, 900),
      target: rect(300, 300, 280, 30),
      editorWidth: 340,
      editorHeight: 232,
      placementScope: 'reference',
      applicationLeftBoundary: 212,
      applicationTopBoundary: 212,
      applicationRightBoundary: 588,
      applicationBottomBoundary: 488,
    });
    expect(sheet.kind).toBe('bottom-sheet');
    expect(sheet.style?.left).toBe('212px');
  });

  it('uses a sheet when Reference space can only fit an unusably small popup', () => {
    const narrowStage = rect(0, 0, 220, 600);
    const narrowTarget = rect(90, 300, 40, 20);
    const narrowMain = choosePassageEditorPlacement({
      stage: narrowStage,
      target: narrowTarget,
      editorWidth: 340,
      editorHeight: 232,
    });
    const narrowReference = choosePassageEditorPlacement({
      stage: narrowStage,
      target: narrowTarget,
      editorWidth: 340,
      editorHeight: 232,
      placementScope: 'reference',
    });
    expect(narrowMain.kind).not.toBe('bottom-sheet');
    expect(narrowReference.kind).toBe('bottom-sheet');

    const shortReference = choosePassageEditorPlacement({
      stage: rect(0, 0, 900, 170),
      target: rect(410, 75, 80, 20),
      editorWidth: 340,
      editorHeight: 232,
      placementScope: 'reference',
    });
    expect(shortReference.kind).toBe('bottom-sheet');
  });

  it('keeps short Reference content in a popup when the application has usable capacity', () => {
    const placement = choosePassageEditorPlacement({
      stage: rect(0, 50, 1_280, 850),
      target: rect(350.25, 510.25, 240.5, 29.25),
      editorWidth: 340,
      editorHeight: 92.797,
      placementScope: 'reference',
      applicationLeftBoundary: 12,
      applicationTopBoundary: 12,
      applicationRightBoundary: 1_268,
      applicationBottomBoundary: 888,
    });

    expect(placement.kind).toBe('side');
    expect(placement.style?.left).toBe('602.75px');
  });
});


describe('selection action placement', () => {
  it('uses the Reference viewport instead of the bottom-tray exclusion boundary', () => {
    const host = rect(0, 0, 1_200, 900);
    const viewport = rect(0, 0, 1_200, 900);
    const referenceViewport = rect(12, 610, 1_176, 278);

    expect(chooseContextActionAvailableRect({
      host,
      viewport,
      referenceViewport,
      surface: 'reference',
      overlayRight: 1_188,
      overlayBottom: 598,
    })).toEqual(rect(24, 622, 1_152, 254));
    expect(chooseContextActionAvailableRect({
      host,
      viewport,
      referenceViewport,
      surface: 'main',
      overlayRight: 1_188,
      overlayBottom: 598,
    })).toEqual(rect(12, 12, 1_176, 586));
  });

  it('intersects a Reference viewport with the visible window on narrow and short layouts', () => {
    expect(chooseContextActionAvailableRect({
      host: rect(100, 40, 600, 500),
      viewport: rect(140, 80, 420, 260),
      referenceViewport: rect(110, 60, 580, 440),
      surface: 'reference',
      overlayRight: 300,
      overlayBottom: 220,
    })).toEqual(rect(52, 52, 396, 236));
  });

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
