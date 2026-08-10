import type { PluginRegistry } from '@embedpdf/core';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';
import { ViewportPlugin } from '@embedpdf/plugin-viewport';
import { ZoomPlugin } from '@embedpdf/plugin-zoom';
import { describe, expect, it, vi } from 'vitest';

import {
  FramingSessionAuthority,
  chooseAnnotationPresentation,
  intersectViewerRects,
  revealDelta,
  restoreViewportPosition,
  unionViewerRects,
} from '../src/pdf/viewer-framing.js';
import { createViewerFramingControls } from '../src/pdf/viewer-framing-adapter.js';
import { workspaceRequestRequiresReframe } from '../src/review/use-annotation-tray-framing.js';

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

  it('preserves framing for reading-mode switches but reframes explicit mark requests', () => {
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
    })).toBe(true);
  });

  it('falls back to the native viewport when instant plugin framing is a no-op', () => {
    const pluginScroll = vi.fn();
    const viewportElement = {
      scrollLeft: 0,
      scrollTop: 0,
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
  });
});
