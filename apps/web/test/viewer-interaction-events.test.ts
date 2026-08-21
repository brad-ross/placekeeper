import { Rotation, transformPosition } from '@embedpdf/models';
import { describe, expect, it, vi } from 'vitest';

import { combinePageRotation } from '../src/pdf/owned-overlay.js';
import {
  isReferenceScrollIntent,
  ReferenceManualScrollObserver,
  subscribeToReferenceManualScroll,
} from '../src/pdf/reference-manual-scroll.js';
import {
  MAIN_PDF_DOCUMENT_ID,
  REFERENCE_PDF_DOCUMENT_ID,
} from '../src/pdf/viewer-document-ids.js';
import {
  fixedViewerClientRect,
  normalizePageClientPoint,
  recordViewerPointerButton,
  ViewerPrimaryClickGesture,
  viewerPointerButton,
} from '../src/pdf/viewer-interaction-events.js';

describe('viewer page interaction coordinates', () => {
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
});

describe('Reference manual-scroll observations', () => {
  const scrollbarViewport = {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 620, bottom: 400 }),
    clientLeft: 0,
    clientTop: 0,
    clientWidth: 600,
    clientHeight: 380,
  };

  it.each([
    ['wheel', { kind: 'wheel' }],
    ['touch pan', { kind: 'pointer', phase: 'move', pointerType: 'touch', button: -1, buttons: 1, clientX: 200, clientY: 200 }],
    ['pointer scrollbar', { kind: 'pointer', phase: 'down', pointerType: 'mouse', button: 0, buttons: 1, clientX: 610, clientY: 200 }],
    ['keyboard', { kind: 'key', key: 'PageDown', altKey: false, ctrlKey: false, metaKey: false }],
  ] as const)('publishes one Reference observation after %s intent and Reference scrolling', (
    _name,
    input,
  ) => {
    const observer = new ReferenceManualScrollObserver();
    expect(isReferenceScrollIntent(input, scrollbarViewport)).toBe(true);
    observer.arm({ left: 0, top: 10 });
    expect(observer.observeScroll(REFERENCE_PDF_DOCUMENT_ID, { left: 0, top: 11 })).toBe(true);
    expect(observer.observeScroll(REFERENCE_PDF_DOCUMENT_ID, { left: 0, top: 12 })).toBe(false);
  });

  it('does not treat programmatic movement, Main scrolling, ordinary clicks, or shortcuts as Reference drift', () => {
    const observer = new ReferenceManualScrollObserver();

    expect(observer.observeScroll(REFERENCE_PDF_DOCUMENT_ID, { left: 0, top: 1 })).toBe(false);
    observer.arm({ left: 0, top: 0 });
    expect(observer.observeScroll(MAIN_PDF_DOCUMENT_ID, { left: 0, top: 1 })).toBe(false);
    expect(observer.observeScroll(REFERENCE_PDF_DOCUMENT_ID, { left: 0, top: 1 })).toBe(true);
    expect(isReferenceScrollIntent({
      kind: 'pointer', phase: 'down', pointerType: 'mouse', button: 0, buttons: 1, clientX: 200, clientY: 200,
    }, scrollbarViewport)).toBe(false);
    expect(isReferenceScrollIntent({
      kind: 'key', key: 'ArrowDown', altKey: false, ctrlKey: true, metaKey: false,
    }, scrollbarViewport)).toBe(false);
  });

  it('expires unmatched input intent before a later programmatic Reference scroll', () => {
    let expire: (() => void) | undefined;
    const observer = new ReferenceManualScrollObserver((callback) => { expire = callback; });

    observer.arm({ left: 0, top: 0 });
    expire?.();
    expect(observer.observeScroll(REFERENCE_PDF_DOCUMENT_ID, { left: 0, top: 1 })).toBe(false);

    observer.arm({ left: 0, top: 0 });
    expect(observer.observeScroll(REFERENCE_PDF_DOCUMENT_ID, { left: 0, top: 1 })).toBe(true);
  });

  it('does not publish when a paired Reference notification has no viewport movement', () => {
    const observer = new ReferenceManualScrollObserver();

    observer.arm({ left: 12, top: 34 });
    expect(observer.observeScroll(
      REFERENCE_PDF_DOCUMENT_ID,
      { left: 12, top: 34 },
    )).toBe(false);
    expect(observer.observeScroll(
      REFERENCE_PDF_DOCUMENT_ID,
      { left: 12, top: 35 },
    )).toBe(false);
  });

  it('keeps a scheduled observation paired with the input that created it', () => {
    const observer = new ReferenceManualScrollObserver();
    observer.arm({ left: 0, top: 10 });
    const firstObservation = observer.takeScrollObservation(REFERENCE_PDF_DOCUMENT_ID);

    observer.arm({ left: 0, top: 20 });

    expect(firstObservation?.({ left: 0, top: 11 })).toBe(true);
    expect(observer.observeScroll(
      REFERENCE_PDF_DOCUMENT_ID,
      { left: 0, top: 21 },
    )).toBe(true);
  });

  it('invalidates a scheduled observation when the Reference lifecycle clears', () => {
    const observer = new ReferenceManualScrollObserver();
    observer.arm({ left: 0, top: 10 });
    const scheduledObservation = observer.takeScrollObservation(REFERENCE_PDF_DOCUMENT_ID);

    observer.clear();

    expect(scheduledObservation?.({ left: 0, top: 11 })).toBe(false);
  });

  it('scopes the live subscription to Reference scrolls and disposes it with the Reference lifecycle', () => {
    let scroll: ((event: { documentId: string }) => void) | undefined;
    const unsubscribe = vi.fn();
    const publish = vi.fn();
    const observer = new ReferenceManualScrollObserver();
    let position = { left: 0, top: 0 };
    let scheduledObservation: (() => void) | undefined;
    const dispose = subscribeToReferenceManualScroll({
      onScroll: (listener) => {
        scroll = listener;
        return unsubscribe;
      },
    }, observer, () => position, publish, (observe) => { scheduledObservation = observe; });

    observer.arm(position);
    scroll?.({ documentId: MAIN_PDF_DOCUMENT_ID });
    expect(publish).not.toHaveBeenCalled();
    scroll?.({ documentId: REFERENCE_PDF_DOCUMENT_ID });
    expect(publish).not.toHaveBeenCalled();
    position = { left: 0, top: 1 };
    scheduledObservation?.();
    expect(publish).toHaveBeenCalledOnce();
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
