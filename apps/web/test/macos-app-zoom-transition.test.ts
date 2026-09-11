import { prepareMacosPresentationTransition } from "../src/macos-entry.js";
import type { MacosNativeMessage } from "../../../packages/core/src/macos-shell-protocol.js";
import { describe, expect, it, vi } from 'vitest';
import { parseMacosNativeMessage } from '../../../packages/core/src/macos-shell-protocol.js';
import { anchoredZoom, finishZoomForPresentation, resumeZoomAfterPresentation } from '../src/pdf/anchored-zoom.js';

const transition = { protocolVersion: 1, type: 'presentation-transition', runtimeId: 'runtime_12345678',
  attemptId: 'attempt_12345678', geometryIdentity: 'geometry_12345678' } as const;

describe('native app zoom presentation fence', () => {
  it('validates scoped transition messages without introducing a review command', () => {
    expect(parseMacosNativeMessage(transition)).toEqual(transition);
    for (const key of ['runtimeId', 'attemptId', 'geometryIdentity']) {
      expect(parseMacosNativeMessage({ ...transition, [key]: '' })).toBeUndefined();
    }
    expect(parseMacosNativeMessage({ ...transition, scale: 2 })).toBeUndefined();
  });

  it('synchronously finishes every mounted viewer before acknowledging presentation', () => {
    const calls: string[] = [];
    const viewers = [0, 1].map((index) => ({
      dataset: {},
      dispatchEvent: (event: Event) => { calls.push(`${index}:${event.type}`); return true; },
      querySelector: () => null,
    } as unknown as HTMLElement));
    const root = { querySelectorAll: vi.fn(() => viewers) } as unknown as Document;
    finishZoomForPresentation(root);
    expect(calls).toEqual(['0:placekeeper:finish-zoom-gesture', '1:placekeeper:finish-zoom-gesture']);
    expect(viewers.every((viewer) => viewer.dataset.zoomPresentationTransition === 'true')).toBe(true);
    resumeZoomAfterPresentation(root);
    expect(viewers.every((viewer) => viewer.dataset.zoomPresentationTransition === undefined)).toBe(true);
  });

  it('revokes an old-layout anchor callback before native scale can change geometry', () => {
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);
    vi.stubGlobal('requestAnimationFrame', () => 42);
    const rect = { left: 0, top: 0, bottom: 500, right: 400, width: 400, height: 500 };
    const page = { dataset: { pageIndex: '0' }, getBoundingClientRect: () => rect };
    const viewport = {
      dataset: {},
      dispatchEvent: () => true, getBoundingClientRect: () => rect, closest: () => null,
      querySelectorAll: () => [page], querySelector: (selector: string) => selector.includes('page-index') ? page : null,
      clientHeight: 500, clientWidth: 400, scrollLeft: 0, scrollTop: 0, isConnected: true,
    } as unknown as HTMLElement;
    try {
      anchoredZoom(viewport, () => {});
      finishZoomForPresentation({ querySelectorAll: () => [viewport] } as unknown as Document);
      expect(cancel).toHaveBeenCalledWith(42);
    } finally { vi.unstubAllGlobals(); }
  });

  it('rejects replaced attempts and stale geometry without touching a current gesture', () => {
    const query = vi.fn(() => []);
    const root = { querySelectorAll: query } as unknown as Document;
    const current = { runtimeId: transition.runtimeId, attemptId: transition.attemptId,
      geometry: { identity: transition.geometryIdentity } } as Extract<MacosNativeMessage, { type: 'bootstrap' }>;
    for (const key of ['runtimeId', 'attemptId', 'geometryIdentity'] as const) {
      expect(prepareMacosPresentationTransition({ ...transition, [key]: 'obsolete_12345678' }, current, root)).toBe(false);
    }
    expect(prepareMacosPresentationTransition(transition, undefined, root)).toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(prepareMacosPresentationTransition(transition, current, root)).toBe(true);
  });

  it('keeps gestures fenced when an old layout publishes after the transition began', () => {
    const viewport = { dataset: {}, dispatchEvent: () => true, querySelector: () => null } as unknown as HTMLElement;
    const root = { querySelectorAll: () => [viewport] } as unknown as Document;
    finishZoomForPresentation(root, 'geometry_old');
    resumeZoomAfterPresentation(root, 'geometry_old');
    expect(viewport.dataset.zoomPresentationTransition).toBe('geometry_old');
    resumeZoomAfterPresentation(root, 'geometry_new');
    expect(viewport.dataset.zoomPresentationTransition).toBeUndefined();
  });

  it('acknowledges immediately with no mounted viewer', () => {
    const root = { querySelectorAll: () => [] } as unknown as Document;
    expect(() => finishZoomForPresentation(root)).not.toThrow();
  });
});
