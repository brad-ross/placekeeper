import { Rotation, transformPosition } from '@embedpdf/models';
import { describe, expect, it } from 'vitest';

import { combinePageRotation } from '../src/pdf/owned-overlay.js';
import {
  fixedPdfLinkSourceRects,
  fixedViewerClientRect,
  isContextPointerGesture,
  isReverseSyncTexPointerGesture,
  normalizePageClientPoint,
  recordViewerPointerButton,
  ReverseSyncTexPointerGesture,
  ViewerPrimaryClickGesture,
  viewerPointerButton,
} from '../src/pdf/viewer-interaction-events.js';
import type { ViewerInteractionEvent } from '../src/pdf/viewer-interaction-events.js';

describe('viewer page interaction coordinates', () => {
  it('keeps reference null-clears and mark activations explicitly surface-scoped', () => {
    const surface = { kind: 'reference', documentGeneration: 4, tabIdentity: 'tab:appendix' } as const;
    const events: ViewerInteractionEvent[] = [
      { type: 'selection-placement', value: null, surface },
      { type: 'caret', value: { anchor: null, placement: null }, surface },
      { type: 'page-menu', value: null, surface },
      { type: 'owned-mark-clear', surface },
      { type: 'source-mark', value: { annotationKey: '2:pdf-9', phase: 'activate', pageIndex: 2 }, surface },
    ];

    expect(events.every((event) => event.surface === surface)).toBe(true);
  });

  it('recognizes secondary-click and mouse Control-click without consuming middle-click', () => {
    expect(isContextPointerGesture({ button: 2, ctrlKey: false, pointerType: 'mouse' })).toBe(true);
    expect(isContextPointerGesture({ button: 0, ctrlKey: true, pointerType: 'mouse' })).toBe(true);
    expect(isContextPointerGesture({ button: 1, ctrlKey: false, pointerType: 'mouse' })).toBe(false);
    expect(isContextPointerGesture({ button: 0, ctrlKey: true, pointerType: 'touch' })).toBe(false);
  });

  it('recognizes the platform reverse-SyncTeX modifier without stealing macOS context-click', () => {
    expect(isReverseSyncTexPointerGesture({ button: 0, metaKey: true, ctrlKey: false }, 'MacIntel')).toBe(true);
    expect(isReverseSyncTexPointerGesture({ button: 0, metaKey: false, ctrlKey: true }, 'MacIntel')).toBe(false);
    expect(isReverseSyncTexPointerGesture({ button: 0, metaKey: false, ctrlKey: true }, 'Win32')).toBe(true);
    expect(isReverseSyncTexPointerGesture({ button: 0, metaKey: false, ctrlKey: false }, 'Win32')).toBe(false);
    expect(isReverseSyncTexPointerGesture({ button: 2, metaKey: true, ctrlKey: false }, 'MacIntel')).toBe(false);
  });

  it('captures reverse SyncTeX clicks while rejecting drags and clearing cancelled pointers', () => {
    const gesture = new ReverseSyncTexPointerGesture();
    gesture.pointerDown(1, 100, 100);
    expect(gesture.pointerUp(1, 103, 102)).toEqual({ activate: true });

    gesture.pointerDown(2, 100, 100);
    gesture.pointerMove(2, 110, 100);
    expect(gesture.pointerUp(2, 101, 100)).toEqual({ activate: false });

    gesture.pointerDown(3, 100, 100);
    gesture.cancel(3);
    expect(gesture.pointerUp(3, 100, 100)).toBeUndefined();
    gesture.pointerDown(3, 200, 200);
    expect(gesture.pointerUp(3, 200, 200)).toEqual({ activate: true });
  });

  it('normalizes client points with intrinsic and document rotation combined exactly once', () => {
    const pageSize = { width: 100, height: 200 };
    const rotation = combinePageRotation(Rotation.Degree90, Rotation.Degree180);
    const scale = 1.5;
    const naturalPoint = { x: 25, y: 40 };
    const displayedPoint = transformPosition(pageSize, naturalPoint, rotation, scale);

    expect(normalizePageClientPoint(
      { x: displayedPoint.x + 12, y: displayedPoint.y + 18 },
      { pageSize, rotation, scale, elementLeft: 12, elementTop: 18 },
    )).toEqual(naturalPoint);
  });

  it('carries the native button through EmbedPDF neutral pointer events', () => {
    const pageTarget = {};
    recordViewerPointerButton(pageTarget, 2);

    expect(viewerPointerButton({ currentTarget: pageTarget })).toBe(2);
    expect(viewerPointerButton({ currentTarget: null })).toBeUndefined();
  });

  it('anchors a jittery primary click at its press point', () => {
    const gesture = new ViewerPrimaryClickGesture();
    gesture.pointerDown(7, 0, { x: 73, y: 99 }, { x: 497, y: 167 });
    gesture.pointerMove(7, 501, 167);

    expect(gesture.pointerUp(7, 0, 501, 167)).toEqual({
      pagePoint: { x: 73, y: 99 },
      clientPoint: { x: 497, y: 167 },
      hadSelectionAtPress: false,
    });
  });

  it('preserves whether a click-like gesture began with text selected', () => {
    const gesture = new ViewerPrimaryClickGesture();
    gesture.pointerDown(7, 0, { x: 73, y: 99 }, { x: 497, y: 167 }, true);

    expect(gesture.pointerUp(7, 0, 497, 167)?.hadSelectionAtPress).toBe(true);
  });

  it('does not turn a real drag into a click when it returns near the press point', () => {
    const gesture = new ViewerPrimaryClickGesture();
    gesture.pointerDown(7, 0, { x: 73, y: 99 }, { x: 497, y: 167 });
    gesture.pointerMove(7, 503, 167);

    expect(gesture.pointerUp(7, 0, 498, 167)).toBeUndefined();
  });

  it('copies a stable client rect instead of retaining a live DOMRect', () => {
    const rect = {
      left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40,
    };
    const fixed = fixedViewerClientRect(rect);
    rect.left = 999;

    expect(fixed).toEqual({
      left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40,
    });
    expect(Object.isFrozen(fixed)).toBe(true);
  });

  describe('PDF link source rects', () => {
    const rect = (x: number, y: number, width = 20, height = 10) => ({
      origin: { x, y }, size: { width, height },
    });

    it('copies and freezes page-space rects so live annotation objects are not retained', () => {
      const live = rect(10, 20);
      const fixed = fixedPdfLinkSourceRects([live]);
      live.origin.x = 999;

      expect(fixed).toEqual([rect(10, 20)]);
      expect(Object.isFrozen(fixed)).toBe(true);
      expect(Object.isFrozen(fixed[0])).toBe(true);
      expect(Object.isFrozen(fixed[0]!.origin)).toBe(true);
      expect(Object.isFrozen(fixed[0]!.size)).toBe(true);
    });

    it('orders rects top-to-bottom by line, then left-to-right within a line', () => {
      const secondLineLeft = rect(10, 40);
      const firstLineRight = rect(200, 11, 30, 8);
      const firstLineLeft = rect(50, 10);
      const secondLineRight = rect(120, 42);

      expect(fixedPdfLinkSourceRects([
        secondLineRight, firstLineRight, secondLineLeft, firstLineLeft,
      ])).toEqual([firstLineLeft, firstLineRight, secondLineLeft, secondLineRight]);
    });

    it('drops non-finite or empty geometry instead of emitting it', () => {
      expect(fixedPdfLinkSourceRects([
        rect(Number.NaN, 10),
        rect(10, 10, 0, 10),
        rect(10, 10, 10, -1),
        rect(5, 5),
      ])).toEqual([rect(5, 5)]);
    });
  });
});
