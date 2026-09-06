import type { PluginRegistry } from '@embedpdf/core';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';
import { ViewportPlugin } from '@embedpdf/plugin-viewport';
import { ZoomPlugin } from '@embedpdf/plugin-zoom';
import { describe, expect, it, vi } from 'vitest';

import {
  FramingSessionAuthority,
  LatestFrameRequest,
  ViewerGeometrySettlementAuthority,
  ViewerPositionAuthority,
  chooseAnnotationPresentation,
  frameUserOwnedPosition,
  occupiedRunway,
  intersectViewerRects,
  revealDelta,
  restoreViewportPosition,
  unionViewerRects,
} from '../src/pdf/viewer-framing.js';
import { createViewerFramingControls } from '../src/pdf/viewer-framing-adapter.js';
import { workspaceRequestRequiresReframe } from '../src/review/use-annotation-tray-framing.js';

describe('viewer framing', () => {
  it('composes stage-clamped committed right and bottom surface bounds', () => {
    expect(occupiedRunway({
      stage: { left: 100, top: 50, right: 1100, bottom: 850 },
      surfaces: [
        {
          presentation: 'right',
          bounds: { left: 780, top: 50, right: 1160, bottom: 620 },
        },
        {
          presentation: 'bottom',
          bounds: { left: 40, top: 610, right: 1160, bottom: 920 },
        },
      ],
    })).toEqual({ right: 320, bottom: 240 });

    expect(occupiedRunway({
      stage: { left: 100, top: 50, right: 1100, bottom: 850 },
      surfaces: [
        {
          presentation: 'bottom',
          bounds: { left: 40, top: 610, right: 1160, bottom: 920 },
        },
      ],
    })).toEqual({ right: 0, bottom: 240 });
  });

  it('commits only the latest rapid sample once per animation frame', () => {
    const callbacks: Array<() => void> = [];
    const cancelled: number[] = [];
    const commits: string[] = [];
    const request = new LatestFrameRequest<string>({
      schedule: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      cancel: (handle) => cancelled.push(handle),
      commit: (value) => commits.push(value),
    });

    request.publish('right:320');
    request.publish('right:340');
    request.publish('right:360');
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!();
    expect(commits).toEqual(['right:360']);

    request.publish('bottom:240');
    request.cancel();
    callbacks.shift()!();
    expect(commits).toEqual(['right:360']);
    expect(cancelled).toEqual([1]);
  });

  it('publishes a settled geometry revision that becomes stale after layout changes', async () => {
    const authority = new ViewerGeometrySettlementAuthority();
    authority.markChanged();
    const settlement = await authority.waitForSettled(
      new AbortController().signal,
      async () => true,
    );

    expect(settlement?.revision).toBe(1);
    expect(settlement?.isCurrent()).toBe(true);
    authority.markChanged();
    expect(settlement?.isCurrent()).toBe(false);
  });

  it('does not settle geometry until an active transition ends', async () => {
    const authority = new ViewerGeometrySettlementAuthority();
    const owner = {};
    let frames = 0;
    authority.beginTransition(owner);

    const settlement = await authority.waitForSettled(
      new AbortController().signal,
      async () => {
        frames += 1;
        if (frames === 2) authority.settleTransition(owner);
        return true;
      },
    );

    expect(frames).toBe(3);
    expect(settlement?.isCurrent()).toBe(true);
  });

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

  it('keeps the pre-open user position through responsive presentation clamps', () => {
    expect(frameUserOwnedPosition({
      baseline: { left: 239, top: 80 },
      restored: { left: 0, top: 20 },
      maximum: { left: 0, top: 400 },
      userAxes: { left: true, top: false },
    })).toEqual({
      position: { left: 0, top: 20 },
      baseline: { left: 239, top: 20 },
    });
    expect(frameUserOwnedPosition({
      baseline: { left: 239, top: 20 },
      restored: { left: 0, top: 20 },
      maximum: { left: 613, top: 400 },
      userAxes: { left: true, top: false },
    })).toEqual({
      position: { left: 239, top: 20 },
      baseline: { left: 239, top: 20 },
    });
  });

  it('lets explicit navigation supersede a remembered manual pan before later tray reflow', () => {
    const authority = new ViewerPositionAuthority(1);
    const openRunway = { right: 336, bottom: 0 };
    const closedRunway = { right: 0, bottom: 0 };

    const capture = authority.beginUserIntent({ left: true, top: false });
    authority.observeUserPosition({ left: 40, top: 80 });
    expect(authority.settleUserPosition(capture, { left: 40, top: 80 })).toBe(true);

    authority.beginTransition(closedRunway, { left: 40, top: 80 });
    expect(authority.preservedPosition(
      closedRunway,
      { left: 0, top: 80 },
      { left: 0, top: 500 },
    )).toEqual({ left: 0, top: 80 });
    authority.finishTransition();

    authority.beginTransition(openRunway, { left: 0, top: 80 });
    expect(authority.preservedPosition(
      openRunway,
      { left: 0, top: 80 },
      { left: 336, top: 500 },
    )).toEqual({ left: 40, top: 80 });
    authority.finishTransition();

    authority.supersedeWithExplicitNavigation();
    authority.beginTransition(closedRunway, { left: 220, top: 310 });
    expect(authority.preservedPosition(
      closedRunway,
      { left: 0, top: 0 },
      { left: 500, top: 700 },
    )).toEqual({ left: 220, top: 310 });
  });

  it('keeps scroll capture pending until the last quiet-frame token', () => {
    const authority = new ViewerPositionAuthority(1);
    const initial = authority.beginUserIntent({ left: true, top: false });
    authority.observeUserPosition({ left: 20, top: 0 });
    const trailing = authority.renewUserCapture();
    authority.observeUserPosition({ left: 64, top: 0 });

    expect(authority.settleUserPosition(initial, { left: 20, top: 0 })).toBe(false);
    expect(authority.settleUserPosition(trailing, { left: 64, top: 0 })).toBe(true);
    authority.beginTransition({ right: 0, bottom: 0 }, { left: 0, top: 0 });
    expect(authority.preservedPosition(
      { right: 0, bottom: 0 },
      { left: 0, top: 0 },
      { left: 200, top: 200 },
    )).toEqual({ left: 64, top: 0 });
  });

  it('settles pending user axes at a same-document controls handoff', () => {
    const authority = new ViewerPositionAuthority(1);
    const staleCapture = authority.beginUserIntent({ left: true, top: false });
    authority.beginTransition({ right: 336, bottom: 0 }, { left: 0, top: 0 });
    authority.replaceControls({ left: 40, top: 120 });

    expect(authority.settleUserPosition(staleCapture, { left: 0, top: 0 })).toBe(false);
    expect(authority.hasTransition({ right: 336, bottom: 0 })).toBe(false);
    authority.beginTransition({ right: 0, bottom: 0 }, { left: 0, top: 120 });
    expect(authority.preservedPosition(
      { right: 0, bottom: 0 },
      { left: 0, top: 120 },
      { left: 200, top: 500 },
    )).toEqual({ left: 40, top: 120 });
  });

  it('keeps an unclamped desired position when a layout toggle commits its clamped value', () => {
    const authority = new ViewerPositionAuthority(1);
    const capture = authority.beginUserIntent({ left: true, top: false });
    authority.settleUserPosition(capture, { left: 40, top: 0 });

    authority.commitCurrentPosition(
      { left: 0, top: 0 },
      { left: 0, top: 500 },
      { left: true, top: true },
    );
    authority.beginTransition({ right: 336, bottom: 0 }, { left: 0, top: 0 });
    expect(authority.preservedPosition(
      { right: 336, bottom: 0 },
      { left: 0, top: 0 },
      { left: 336, top: 500 },
    )).toEqual({ left: 40, top: 0 });
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

  it('preserves framing for passive layout changes but reframes explicit mark requests', () => {
    expect(workspaceRequestRequiresReframe({
      presentationChanged: false,
      requestChanged: true,
      requestKind: 'reading',
    })).toBe(false);
    expect(workspaceRequestRequiresReframe({
      presentationChanged: false,
      requestChanged: true,
      requestKind: 'mark',
    })).toBe(true);
    expect(workspaceRequestRequiresReframe({
      presentationChanged: true,
      requestChanged: false,
      requestKind: 'reading',
    })).toBe(false);
  });

  it('falls back to the native viewport when instant plugin framing is a no-op', () => {
    const pluginScroll = vi.fn();
    const setScrollLeft = vi.fn();
    const setScrollTop = vi.fn();
    let scrollLeft = 0;
    let scrollTop = 0;
    const viewportElement = {
      get scrollLeft() { return scrollLeft; },
      set scrollLeft(value: number) { scrollLeft = value; setScrollLeft(value); },
      get scrollTop() { return scrollTop; },
      set scrollTop(value: number) { scrollTop = value; setScrollTop(value); },
      scrollWidth: 800,
      scrollHeight: 900,
      clientWidth: 500,
      clientHeight: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 500, bottom: 600 }),
    } as unknown as HTMLElement;
    const registry = {
      getStore: () => ({ getState: () => ({ core: { activeDocumentId: 'doc' } }) }),
      getPlugin: (id: string) => id === ViewportPlugin.id
        ? { provides: () => ({
          forDocument: () => ({
            getMetrics: () => ({
              scrollLeft: 0,
              scrollTop: 0,
              scrollWidth: 800,
              scrollHeight: 900,
              clientWidth: 500,
              clientHeight: 600,
            }),
            scrollTo: pluginScroll,
          }),
        }) }
        : id === ScrollPlugin.id
          ? { provides: () => ({ forDocument: () => ({ getCurrentPage: () => 1 }) }) }
          : id === ZoomPlugin.id
            ? { provides: () => ({
              forDocument: () => ({ onZoomChange: () => () => undefined }),
            }) }
            : null,
    } as unknown as PluginRegistry;
    const controls = createViewerFramingControls({
      registry,
      root: () => ({
        querySelector: (selector: string) => selector === '[data-viewer-framing-viewport]'
          ? viewportElement
          : null,
      }) as unknown as HTMLElement,
      updateRunway: vi.fn(),
    });

    controls.scrollTo({ left: 233, top: 18 }, 'auto');

    expect(pluginScroll).toHaveBeenCalledWith({ x: 233, y: 18, behavior: 'auto' });
    expect({ left: viewportElement.scrollLeft, top: viewportElement.scrollTop })
      .toEqual({ left: 233, top: 18 });

    setScrollLeft.mockClear();
    setScrollTop.mockClear();
    controls.scrollTo({ left: 233, top: 18 }, 'auto');

    expect(setScrollLeft).toHaveBeenCalledWith(233);
    expect(setScrollTop).toHaveBeenCalledWith(18);
  });

  it('returns an unavailable snapshot without reading a disposed viewer registry', async () => {
    let registryDisposed = false;
    const disposedRead = () => {
      if (registryDisposed) throw new TypeError("Cannot read properties of undefined (reading 'documents')");
      return {
        scrollLeft: 0,
        scrollTop: 0,
        scrollWidth: 800,
        scrollHeight: 900,
        clientWidth: 500,
        clientHeight: 600,
      };
    };
    const registry = {
      getStore: () => ({ getState: () => ({ core: { activeDocumentId: 'doc' } }) }),
      getPlugin: (id: string) => id === ViewportPlugin.id
        ? { provides: () => ({
          forDocument: () => ({ getMetrics: disposedRead, scrollTo: vi.fn() }),
        }) }
        : id === ScrollPlugin.id
          ? { provides: () => ({ forDocument: () => ({
            getCurrentPage: () => {
              if (registryDisposed) throw new TypeError('Disposed scroll registry');
              return 1;
            },
          }) }) }
          : id === ZoomPlugin.id
            ? { provides: () => ({
              forDocument: () => ({ onZoomChange: () => () => undefined }),
            }) }
            : null,
    } as unknown as PluginRegistry;
    const controls = createViewerFramingControls({
      registry,
      root: () => null,
      updateRunway: vi.fn(),
    });

    controls.dispose();
    registryDisposed = true;

    expect(controls.snapshot()).toEqual({
      ready: false,
      scroll: { left: 0, top: 0 },
      maximum: { left: 0, top: 0 },
    });
    await expect(controls.setRunway({ right: 0, bottom: 0 })).resolves.toEqual({
      ready: false,
      scroll: { left: 0, top: 0 },
      maximum: { left: 0, top: 0 },
    });
  });
});
