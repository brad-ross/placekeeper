import type { PluginRegistry } from '@embedpdf/core';
import { PdfZoomMode, Rotation, transformPosition, transformSize } from '@embedpdf/models';
import { ScrollPlugin, type ScrollToPageOptions } from '@embedpdf/plugin-scroll';
import { ViewportPlugin } from '@embedpdf/plugin-viewport';
import { ZoomPlugin } from '@embedpdf/plugin-zoom';
import { describe, expect, it, vi } from 'vitest';

import type { PdfNavigationTarget } from '../src/pdf/pdf-navigation-target.js';
import { combinePageRotation } from '../src/pdf/owned-overlay.js';
import {
  pdfBottomOriginPointToNaturalAnchor,
  samePdfViewerLocation,
} from '../src/pdf/viewer-navigation.js';
import {
  createPdfTargetLocation,
  createViewerNavigation,
  fitViewerWidthZoom,
  focusViewerDestination,
} from '../src/pdf/viewer-navigation-adapter.js';
import type { ViewerRunway } from '../src/pdf/viewer-framing.js';

const page = { width: 600, height: 800 } as const;
const viewport = { width: 620, height: 820, gap: 10 } as const;

function target(mode: PdfZoomMode, params: readonly number[] = []): PdfNavigationTarget {
  return {
    documentGeneration: 4,
    pageIndex: 0,
    zoom: { mode, params },
    identity: JSON.stringify([4, 0, mode, ...params]),
  };
}

describe('viewer navigation math', () => {
  it('fits width within configured zoom limits and rejects unusable geometry', () => {
    expect(fitViewerWidthZoom({ viewportWidth: 620, pageWidth: 600, viewportGap: 10 })).toBe(1);
    expect(fitViewerWidthZoom({ viewportWidth: 20, pageWidth: 1_000, viewportGap: 0 })).toBe(0.2);
    expect(fitViewerWidthZoom({ viewportWidth: 10_000, pageWidth: 100, viewportGap: 0 })).toBe(60);
    expect(fitViewerWidthZoom({ viewportWidth: 20, pageWidth: 600, viewportGap: 10 })).toBeNull();
  });
  it('converts PDF bottom-origin destination coordinates to natural top-origin page anchors', () => {
    expect(pdfBottomOriginPointToNaturalAnchor({ x: 72, y: 640 }, page))
      .toEqual({ x: 72, y: 160 });
    expect(pdfBottomOriginPointToNaturalAnchor(
      { x: 172, y: 840 },
      page,
      { x: 100, y: 200 },
    )).toEqual({ x: 72, y: 160 });
  });

  it.each([
    ['XYZ', target(PdfZoomMode.XYZ, [20, 700, 2]), {
      pageIndex: 0, anchor: { x: 20, y: 100 }, alignment: { xPercent: 0, yPercent: 0 }, zoom: 2,
    }],
    ['FitPage', target(PdfZoomMode.FitPage), {
      pageIndex: 0, anchor: { x: 300, y: 400 }, alignment: { xPercent: 50, yPercent: 50 }, zoom: 1,
    }],
    ['FitBoundingBox', target(PdfZoomMode.FitBoundingBox), {
      pageIndex: 0, anchor: { x: 300, y: 400 }, alignment: { xPercent: 50, yPercent: 50 }, zoom: 1,
    }],
    ['FitHorizontal', target(PdfZoomMode.FitHorizontal, [700]), {
      pageIndex: 0, anchor: { x: 300, y: 100 }, alignment: { xPercent: 50, yPercent: 0 }, zoom: 1,
    }],
    ['FitBoundingBoxHorizontal', target(PdfZoomMode.FitBoundingBoxHorizontal, [700]), {
      pageIndex: 0, anchor: { x: 300, y: 100 }, alignment: { xPercent: 50, yPercent: 0 }, zoom: 1,
    }],
    ['FitVertical', target(PdfZoomMode.FitVertical, [20]), {
      pageIndex: 0, anchor: { x: 20, y: 400 }, alignment: { xPercent: 0, yPercent: 50 }, zoom: 1,
    }],
    ['FitBoundingBoxVertical', target(PdfZoomMode.FitBoundingBoxVertical, [20]), {
      pageIndex: 0, anchor: { x: 20, y: 400 }, alignment: { xPercent: 0, yPercent: 50 }, zoom: 1,
    }],
    ['FitRectangle', target(PdfZoomMode.FitRectangle, [100, 200, 500, 700]), {
      pageIndex: 0, anchor: { x: 300, y: 350 }, alignment: { xPercent: 50, yPercent: 50 }, zoom: 1.5,
    }],
  ] as const)('maps %s to an explicit semantic location', (_name, destination, expected) => {
    expect(createPdfTargetLocation(destination, { page, viewport, currentZoom: 1.25 }))
      .toEqual(expected);
  });

  it('uses the actual zoom for page-only destinations and compares snapshots with tolerance', () => {
    const location = createPdfTargetLocation(target(PdfZoomMode.Unknown), {
      page,
      viewport,
      currentZoom: 1.25,
    });
    expect(location).toEqual({
      pageIndex: 0,
      anchor: { x: 0, y: 0 },
      alignment: { xPercent: 0, yPercent: 0 },
      zoom: 1.25,
    });
    expect(samePdfViewerLocation(location!, {
      ...location!,
      anchor: { x: 0.005, y: 0.005 },
      zoom: 1.2505,
    })).toBe(true);
  });

  it('maps cropped and rotated destinations in natural page coordinates', () => {
    expect(createPdfTargetLocation(target(PdfZoomMode.XYZ, [172, 740, 1]), {
      page: { ...page, cropOrigin: { x: 100, y: 200 } },
      viewport,
      currentZoom: 1,
      rotation: Rotation.Degree90,
    })).toEqual({
      pageIndex: 0,
      anchor: { x: 72, y: 260 },
      alignment: { xPercent: 0, yPercent: 0 },
      zoom: 1,
    });
    expect(createPdfTargetLocation(target(PdfZoomMode.FitRectangle, [100, 200, 300, 600]), {
      page: { ...page, cropOrigin: { x: 100, y: 100 } },
      viewport,
      currentZoom: 1,
      rotation: Rotation.Degree90,
    })).toEqual({
      pageIndex: 0,
      anchor: { x: 100, y: 500 },
      alignment: { xPercent: 50, yPercent: 50 },
      zoom: 1.5,
    });
  });
});

interface RectState {
  left: number;
  top: number;
  width: number;
  height: number;
}

function domRect(rect: RectState): DOMRect {
  return {
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON: () => ({ ...rect }),
  } as DOMRect;
}

function navigationHarness(options: {
  activeDocumentId?: string;
  constrainedHorizontal?: boolean;
  artificialHorizontalRunway?: boolean;
  constrainedVertical?: 'start' | 'end';
  initiallyUnreadyPage?: boolean;
  farTargetInitiallyUnmounted?: boolean;
  initiallyUnready?: boolean;
  manualZoom?: boolean;
  omitZoomLayoutEvent?: boolean;
  stickyScrollActivity?: boolean;
  staleCurrentPageWithThirdVisible?: boolean;
  runway?: ViewerRunway;
  viewportGap?: number;
  pageRotation?: Rotation;
  documentRotation?: Rotation;
  updateGeometry?: boolean;
  timeoutMs?: number;
} = {}) {
  const combinedRotation = combinePageRotation(
    options.pageRotation ?? Rotation.Degree0,
    options.documentRotation ?? Rotation.Degree0,
  );
  const initialRotatedPage = transformSize(page, combinedRotation, 1);
  const log: string[] = [];
  const viewportRect: RectState = {
    left: 0,
    top: 0,
    width: options.initiallyUnready ? 0 : options.constrainedHorizontal ? 620 : 600,
    height: options.initiallyUnready ? 0 : 400,
  };
  const pageRect: RectState = {
    left: options.constrainedHorizontal ? 10 : -100,
    top: -200,
    width: 600,
    height: 800,
  };
  const focus = vi.fn();
  let pageMounted = options.initiallyUnreadyPage !== true;
  let farPageMounted = options.farTargetInitiallyUnmounted !== true;
  const pageElement = { getBoundingClientRect: () => domRect(pageRect), focus } as unknown as HTMLElement;
  const thirdPageRect: RectState = {
    left: 0,
    top: 0,
    width: initialRotatedPage.width,
    height: initialRotatedPage.height,
  };
  const thirdPageElement = {
    getBoundingClientRect: () => domRect(thirdPageRect),
    getAttribute: (name: string) => name === 'data-page-index' ? '2' : null,
    focus,
  } as unknown as HTMLElement;
  Object.assign(pageElement, {
    getAttribute: (name: string) => name === 'data-page-index'
      ? String(options.farTargetInitiallyUnmounted && currentPage === 3 ? 2 : 0)
      : null,
  });
  const viewportElement = {
    getBoundingClientRect: () => domRect(viewportRect),
  } as unknown as HTMLElement;
  const root = {
    querySelector: (selector: string) => {
      if (selector === '[data-viewer-framing-viewport]') return viewportElement;
      if (selector === '[data-page-index]') {
        return pageMounted || (options.farTargetInitiallyUnmounted && farPageMounted)
          ? pageElement
          : null;
      }
      if (selector === '[data-page-index="0"]') return pageMounted ? pageElement : null;
      if (selector === '[data-page-index="2"]') {
        if (options.staleCurrentPageWithThirdVisible) return thirdPageElement;
        return options.farTargetInitiallyUnmounted && farPageMounted ? pageElement : null;
      }
      return null;
    },
    querySelectorAll: (selector: string) => {
      if (selector !== '[data-page-index]') return [];
      return options.staleCurrentPageWithThirdVisible
        ? [pageElement, thirdPageElement]
        : [pageElement];
    },
  } as unknown as HTMLElement;

  let activeDocumentId: string | null = options.activeDocumentId ?? 'doc';
  let currentZoom = 1;
  let currentPage = 1;
  let scrolling = false;
  const storeListeners = new Set<() => void>();
  const zoomListeners = new Set<(event: { newZoom: number }) => void>();
  const layoutListeners = new Set<() => void>();
  const activityListeners = new Set<(activity: { isScrolling: boolean; isSmoothScrolling: boolean }) => void>();

  const emitZoom = (zoom: number) => {
    currentZoom = zoom;
    for (const listener of zoomListeners) listener({ newZoom: zoom });
    if (!options.omitZoomLayoutEvent) {
      for (const listener of layoutListeners) listener();
    }
  };
  const zoom = {
    getState: () => ({ currentZoomLevel: currentZoom }),
    requestZoom: (level: number | string) => {
      log.push(`zoom:${String(level)}`);
      if (typeof level === 'number') {
        if (options.manualZoom) currentZoom = level;
        else emitZoom(level);
      }
    },
    onZoomChange: (listener: (event: { newZoom: number }) => void) => {
      zoomListeners.add(listener);
      return () => zoomListeners.delete(listener);
    },
  };
  const scroll = {
    getCurrentPage: () => currentPage,
    scrollToPage: (request: ScrollToPageOptions) => {
      log.push('scroll');
      currentPage = request.pageNumber;
      if (request.pageNumber === 3) farPageMounted = true;
      const anchor = request.pageCoordinates ?? { x: 0, y: 0 };
      if (options.updateGeometry !== false) {
        const targetRect = options.staleCurrentPageWithThirdVisible && request.pageNumber === 3
          ? thirdPageRect
          : pageRect;
        const rotated = initialRotatedPage;
        targetRect.width = rotated.width * currentZoom;
        targetRect.height = rotated.height * currentZoom;
        const transformedAnchor = transformPosition(
          page,
          anchor,
          combinedRotation,
          currentZoom,
        );
        targetRect.left = options.constrainedHorizontal
          ? viewportRect.left + (viewportRect.width - targetRect.width) / 2
          : viewportRect.left
            + viewportRect.width * ((request.alignX ?? 0) / 100)
            - transformedAnchor.x;
        targetRect.top = options.constrainedVertical === 'start'
          ? viewportRect.top
          : options.constrainedVertical === 'end'
            ? viewportRect.top + viewportRect.height - targetRect.height
            : viewportRect.top
              + viewportRect.height * ((request.alignY ?? 0) / 100)
              - transformedAnchor.y;
      }
      scrolling = options.stickyScrollActivity === true;
      for (const listener of activityListeners) {
        listener({ isScrolling: scrolling, isSmoothScrolling: false });
      }
    },
    onLayoutChange: (listener: () => void) => {
      layoutListeners.add(listener);
      return () => layoutListeners.delete(listener);
    },
  };
  const viewportScope = {
    getMetrics: () => ({
      width: viewportRect.width,
      height: viewportRect.height,
      clientWidth: viewportRect.width,
      clientHeight: viewportRect.height,
      scrollTop: options.constrainedVertical === 'end' ? 1_600 : 0,
      scrollLeft: 0,
      scrollWidth: options.artificialHorizontalRunway
        ? 1_000
        : options.constrainedHorizontal ? pageRect.width : 2_000,
      scrollHeight: 2_000,
      clientLeft: 0,
      clientTop: 0,
      relativePosition: { x: 0, y: 0 },
    }),
    isScrolling: () => scrolling,
    isSmoothScrolling: () => false,
    onScrollActivity: (listener: (activity: { isScrolling: boolean; isSmoothScrolling: boolean }) => void) => {
      activityListeners.add(listener);
      return () => activityListeners.delete(listener);
    },
  };
  const document = {
    pages: (options.farTargetInitiallyUnmounted || options.staleCurrentPageWithThirdVisible
      ? [0, 1, 2]
      : [0]).map((index) => ({
      index, size: page, rotation: options.pageRotation ?? Rotation.Degree0, objectNumber: index + 1,
    })),
  };
  const coreState = () => ({
    activeDocumentId,
    documents: {
      doc: {
        scale: currentZoom,
        rotation: options.documentRotation ?? Rotation.Degree0,
        document,
      },
      'shell-doc': {
        scale: 1,
        rotation: Rotation.Degree0,
        document: { pages: [] },
      },
    },
  });
  const registry = {
    getStore: () => ({
      getState: () => ({ core: coreState() }),
      subscribe: (listener: () => void) => {
        storeListeners.add(listener);
        return () => storeListeners.delete(listener);
      },
    }),
    getPlugin: (id: string) => id === ScrollPlugin.id
      ? { provides: () => ({ forDocument: () => scroll }) }
      : id === ViewportPlugin.id
        ? { provides: () => ({ getViewportGap: () => options.viewportGap ?? 0, forDocument: () => viewportScope }) }
        : id === ZoomPlugin.id
          ? { provides: () => ({ forDocument: () => zoom }) }
          : null,
  } as unknown as PluginRegistry;
  const navigation = createViewerNavigation({
    registry,
    root: () => root,
    documentId: 'doc',
    documentGeneration: 4,
    runway: () => options.runway ?? { right: 0, bottom: 0 },
    timeoutMs: options.timeoutMs ?? 25,
    nextFrame: async () => {
      if (options.initiallyUnready && viewportRect.width === 0) {
        viewportRect.width = 600;
        viewportRect.height = 400;
      }
      if (options.initiallyUnreadyPage) pageMounted = true;
    },
  });

  return {
    navigation,
    log,
    pageRect,
    thirdPageRect,
    focus,
    completeZoom: emitZoom,
    setCurrentZoom(zoom: number) {
      currentZoom = zoom;
    },
    replaceActiveDocument(documentId: string) {
      activeDocumentId = documentId;
      for (const listener of storeListeners) listener();
    },
  };
}

describe('viewer navigation adapter', () => {
  it('fits the most-visible page to the viewport minus two standard gaps', async () => {
    const harness = navigationHarness({ viewportGap: 10 });

    expect(await harness.navigation.fitToWidth()).toBe(true);
    expect(harness.log[0]).toBe(`zoom:${580 / 600}`);
    expect(harness.log.at(-1)).toBe('scroll');
  });

  it('subtracts right runway but not bottom runway from fit width', async () => {
    const right = navigationHarness({ viewportGap: 10, runway: { right: 200, bottom: 180 } });
    const bottom = navigationHarness({ viewportGap: 10, runway: { right: 0, bottom: 180 } });

    expect(await right.navigation.fitToWidth()).toBe(true);
    expect(right.log[0]).toBe(`zoom:${380 / 600}`);
    expect(right.pageRect.left).toBeCloseTo(10);
    expect(right.pageRect.left + right.pageRect.width).toBeCloseTo(390);
    expect(await bottom.navigation.fitToWidth()).toBe(true);
    expect(bottom.log[0]).toBe(`zoom:${580 / 600}`);
  });

  it('uses combined rotation and the most-visible mounted page for fit width', async () => {
    const harness = navigationHarness({
      viewportGap: 10,
      pageRotation: Rotation.Degree90,
      staleCurrentPageWithThirdVisible: true,
    });
    harness.pageRect.top = -900;

    expect(await harness.navigation.fitToWidth()).toBe(true);
    expect(harness.log[0]).toBe(`zoom:${580 / 800}`);
    expect(harness.thirdPageRect.left).toBeCloseTo(10);
    expect(harness.thirdPageRect.left + harness.thirdPageRect.width).toBeCloseTo(590);
    expect(harness.navigation.captureLocation()?.pageIndex).toBe(2);
  });

  it('combines document and page rotation before resolving fitted width', async () => {
    const harness = navigationHarness({
      viewportGap: 10,
      pageRotation: Rotation.Degree90,
      documentRotation: Rotation.Degree90,
    });

    expect(await harness.navigation.fitToWidth()).toBe(true);
    expect(harness.log[0]).toBe(`zoom:${580 / 600}`);
  });

  it('waits for settled workspace geometry and rejects a stale geometry revision', async () => {
    let runway: ViewerRunway = { right: 0, bottom: 0 };
    let current = true;
    const harness = navigationHarness({
      viewportGap: 10,
      get runway() { return runway; },
    });
    const waitForSettledGeometry = vi.fn(async () => {
      runway = { right: 200, bottom: 0 };
      return { revision: 4, isCurrent: () => current };
    });

    expect(await harness.navigation.fitToWidth(waitForSettledGeometry)).toBe(true);
    expect(waitForSettledGeometry).toHaveBeenCalledOnce();
    expect(harness.log[0]).toBe(`zoom:${380 / 600}`);

    current = false;
    harness.log.length = 0;
    expect(await harness.navigation.fitToWidth(waitForSettledGeometry)).toBe(false);
    expect(harness.log).toEqual([]);
  });

  it('rolls back if settled workspace geometry changes while fit zoom is pending', async () => {
    let current = true;
    const harness = navigationHarness({ manualZoom: true, viewportGap: 10, timeoutMs: 250 });
    const fitting = harness.navigation.fitToWidth(async () => ({
      revision: 3,
      isCurrent: () => current,
    }));
    await vi.waitFor(() => expect(harness.log).toContain(`zoom:${580 / 600}`));
    current = false;
    harness.completeZoom(580 / 600);

    expect(await fitting).toBe(false);
    expect(harness.log).toContain('zoom:1');
  });

  it('does not abort a newer navigation when a pending geometry settlement is superseded', async () => {
    const harness = navigationHarness({ timeoutMs: 250 });
    const fitting = harness.navigation.fitToWidth((signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(null), { once: true });
    }));
    await Promise.resolve();
    const newer = harness.navigation.applyLocation({
      pageIndex: 0,
      anchor: { x: 300, y: 400 },
      alignment: { xPercent: 50, yPercent: 50 },
      zoom: 1,
    });

    expect(await fitting).toBe(false);
    expect(await newer).toBe(true);
  });

  it('reports fit readiness and does no work without usable page geometry', async () => {
    const ready = navigationHarness();
    const unavailable = navigationHarness({ initiallyUnreadyPage: true, timeoutMs: 1 });

    expect(ready.navigation.fitToWidthReady()).toBe(true);
    expect(await ready.navigation.fitToWidth()).toBe(true);
    unavailable.navigation.dispose();
    expect(unavailable.navigation.fitToWidthReady()).toBe(false);
    expect(await unavailable.navigation.fitToWidth()).toBe(false);
  });

  it('captures the most-visible mounted page when the scroll plugin current-page state is stale', () => {
    const harness = navigationHarness({ staleCurrentPageWithThirdVisible: true });
    harness.pageRect.top = -900;

    expect(harness.navigation.captureLocation()?.pageIndex).toBe(2);
  });

  it('does not rank a larger page hidden behind the bottom runway as visible', () => {
    const harness = navigationHarness({
      staleCurrentPageWithThirdVisible: true,
      runway: { right: 0, bottom: 180 },
    });
    Object.assign(harness.pageRect, { left: 0, top: 220, width: 600, height: 180 });
    Object.assign(harness.thirdPageRect, { left: 0, top: 0, width: 600, height: 100 });

    expect(harness.navigation.captureLocation()?.pageIndex).toBe(2);
  });

  it('does not rank a larger page hidden behind the right runway as visible', () => {
    const harness = navigationHarness({
      staleCurrentPageWithThirdVisible: true,
      runway: { right: 250, bottom: 0 },
    });
    Object.assign(harness.pageRect, { left: 350, top: 0, width: 250, height: 400 });
    Object.assign(harness.thirdPageRect, { left: 0, top: 0, width: 200, height: 400 });

    expect(harness.navigation.captureLocation()?.pageIndex).toBe(2);
  });

  it('captures and reapplies anchors and alignment against the runway-clipped viewport', async () => {
    const harness = navigationHarness({ runway: { right: 200, bottom: 100 } });
    const captured = harness.navigation.captureLocation();

    expect(captured).toEqual({
      pageIndex: 0,
      anchor: { x: 300, y: 350 },
      alignment: { xPercent: 50, yPercent: 50 },
      zoom: 1,
    });
    harness.pageRect.left = -320;
    harness.pageRect.top = -500;

    expect(await harness.navigation.applyLocation(captured!)).toBe(true);
    expect(samePdfViewerLocation(harness.navigation.captureLocation(), captured)).toBe(true);
  });

  it('accepts a fully visible fitted page when a tray runway creates artificial horizontal scroll range', async () => {
    const harness = navigationHarness({
      constrainedHorizontal: true,
      artificialHorizontalRunway: true,
      runway: { right: 100, bottom: 0 },
    });

    expect(await harness.navigation.applyLocation({
      pageIndex: 0,
      anchor: { x: 300, y: 400 },
      alignment: { xPercent: 50, yPercent: 50 },
      zoom: 0.5,
    })).toBe(true);
  });

  it('accepts a fully visible fitted page when document stacking leaves vertical scroll range', async () => {
    const harness = navigationHarness({
      constrainedHorizontal: true,
      constrainedVertical: 'start',
    });

    expect(await harness.navigation.applyLocation({
      pageIndex: 0,
      anchor: { x: 300, y: 400 },
      alignment: { xPercent: 50, yPercent: 50 },
      zoom: 0.4,
    })).toBe(true);
  });

  it('keeps target zoom resolution based on the viewer metrics when a runway is active', () => {
    const harness = navigationHarness({ runway: { right: 200, bottom: 100 } });

    expect(harness.navigation.resolveTarget(target(PdfZoomMode.FitPage))?.zoom).toBe(0.5);
  });

  it('captures and reapplies a semantic location, zooming before final page-coordinate alignment', async () => {
    const harness = navigationHarness();
    const captured = harness.navigation.captureLocation();

    expect(captured).toEqual({
      pageIndex: 0,
      anchor: { x: 350, y: 400 },
      alignment: { xPercent: 250 / 600 * 100, yPercent: 50 },
      zoom: 1,
    });
    harness.pageRect.left = -320;
    harness.pageRect.top = -500;
    harness.pageRect.width = 900;
    harness.pageRect.height = 1_200;
    harness.setCurrentZoom(1.5);

    expect(await harness.navigation.applyLocation(captured!)).toBe(true);
    expect(harness.log).toEqual(['zoom:1', 'scroll']);
    expect(harness.navigation.captureLocation()).toEqual(captured);
  });

  it('does no work when the explicit semantic snapshot is already settled', async () => {
    const harness = navigationHarness();
    const captured = harness.navigation.captureLocation();

    expect(await harness.navigation.applyLocation(captured!)).toBe(true);
    expect(harness.log).toEqual([]);
  });

  it('captures and applies a fixed reference document while another document is globally active', async () => {
    const harness = navigationHarness({ activeDocumentId: 'shell-doc' });
    const captured = harness.navigation.captureLocation();
    expect(captured).not.toBeNull();
    harness.pageRect.left = -300;
    harness.pageRect.top = -500;

    expect(await harness.navigation.applyLocation(captured!)).toBe(true);
    expect(harness.log.at(-1)).toBe('scroll');
  });

  it('waits for a newly portaled inactive-document viewport before applying its target', async () => {
    const harness = navigationHarness({ activeDocumentId: 'shell-doc', initiallyUnready: true });

    expect(await harness.navigation.applyTarget(target(PdfZoomMode.XYZ, [72, 640, 0]))).toBe(true);
    expect(harness.log).toEqual(['scroll']);
    expect(harness.navigation.captureLocation()).not.toBeNull();
  });

  it('waits when inactive-document metrics precede the portaled target page', async () => {
    const harness = navigationHarness({
      activeDocumentId: 'shell-doc',
      initiallyUnreadyPage: true,
    });

    expect(await harness.navigation.applyTarget(target(PdfZoomMode.XYZ, [72, 640, 0]))).toBe(true);
    expect(harness.log).toEqual(['scroll']);
    expect(harness.navigation.captureLocation()).not.toBeNull();
  });

  it('scrolls before waiting for a distant virtualized target page to mount', async () => {
    const harness = navigationHarness({ farTargetInitiallyUnmounted: true });
    const distantTarget = { ...target(PdfZoomMode.XYZ, [72, 640, 0]), pageIndex: 2 };

    expect(await harness.navigation.applyTarget(distantTarget)).toBe(true);
    expect(harness.log).toEqual(['scroll', 'scroll']);
    expect(harness.navigation.captureLocation()?.pageIndex).toBe(2);
  });

  it('accepts settled instant navigation on an axis with no available scroll range', async () => {
    const harness = navigationHarness({
      constrainedHorizontal: true,
      stickyScrollActivity: true,
      timeoutMs: 5,
    });

    expect(await harness.navigation.applyTarget(target(PdfZoomMode.XYZ, [72, 640, 0]))).toBe(true);
    expect(harness.log).toEqual(['scroll']);
  });

  it.each([
    ['start', 0],
    ['end', 800],
  ] as const)('accepts a semantic alignment constrained at the vertical %s boundary', async (
    constrainedVertical,
    anchorY,
  ) => {
    const harness = navigationHarness({ constrainedVertical, stickyScrollActivity: true, timeoutMs: 5 });

    expect(await harness.navigation.applyLocation({
      pageIndex: 0,
      anchor: { x: 300, y: anchorY },
      alignment: { xPercent: 50, yPercent: 50 },
      zoom: 1,
    })).toBe(true);
    expect(harness.log).toEqual(['scroll']);
  });

  it('relocates at unchanged zoom without waiting for a zoom event', async () => {
    const harness = navigationHarness({ manualZoom: true });
    expect(await harness.navigation.applyLocation({
      pageIndex: 0,
      anchor: { x: 10, y: 20 },
      alignment: { xPercent: 0, yPercent: 0 },
      zoom: 1,
    })).toBe(true);
    expect(harness.log).toEqual(['scroll']);
  });

  it('continues after zoom state settles without a redundant scroll-layout event', async () => {
    const harness = navigationHarness({ omitZoomLayoutEvent: true, timeoutMs: 5 });

    expect(await harness.navigation.applyLocation({
      pageIndex: 0,
      anchor: { x: 10, y: 20 },
      alignment: { xPercent: 0, yPercent: 0 },
      zoom: 1.5,
    })).toBe(true);
    expect(harness.log).toEqual(['zoom:1.5', 'scroll']);
  });

  it('cancels stale operations on supersession and document replacement', async () => {
    const harness = navigationHarness({ manualZoom: true, timeoutMs: 250 });
    const first = harness.navigation.applyLocation({
      pageIndex: 0,
      anchor: { x: 20, y: 30 },
      alignment: { xPercent: 0, yPercent: 0 },
      zoom: 1.5,
    });
    await Promise.resolve();
    const second = harness.navigation.applyLocation({
      pageIndex: 0,
      anchor: { x: 40, y: 50 },
      alignment: { xPercent: 0, yPercent: 0 },
      zoom: 2,
    });
    await vi.waitFor(() => expect(harness.log).toContain('zoom:2'));
    harness.completeZoom(2);

    expect(await first).toBe(false);
    expect(await second).toBe(true);

    const replaced = harness.navigation.applyLocation({
      pageIndex: 0,
      anchor: { x: 60, y: 70 },
      alignment: { xPercent: 0, yPercent: 0 },
      zoom: 2.5,
    });
    await Promise.resolve();
    harness.navigation.replaceDocument(5);
    expect(await replaced).toBe(false);

    const cancelled = harness.navigation.applyLocation({
      pageIndex: 0,
      anchor: { x: 60, y: 70 },
      alignment: { xPercent: 0, yPercent: 0 },
      zoom: 3,
    });
    await Promise.resolve();
    harness.navigation.cancelPendingNavigation();
    expect(await cancelled).toBe(false);
  });

  it('restores a semantic origin before a superseding jump starts', async () => {
    const harness = navigationHarness({ manualZoom: true, timeoutMs: 250 });
    const origin = harness.navigation.captureLocation();
    const first = harness.navigation.applyLocation({
      pageIndex: 0,
      anchor: { x: 20, y: 30 },
      alignment: { xPercent: 0, yPercent: 0 },
      zoom: 1.5,
    });
    await Promise.resolve();

    const second = harness.navigation.applyLocation({
      pageIndex: 0,
      anchor: { x: 40, y: 50 },
      alignment: { xPercent: 0, yPercent: 0 },
      zoom: 2,
    });
    await vi.waitFor(() => expect(harness.log).toContain('zoom:2'));
    harness.completeZoom(2);

    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(harness.log.slice(0, 3)).toEqual(['zoom:1.5', 'zoom:1', 'scroll']);
    expect(origin?.zoom).toBe(1);
  });

  it('returns false on bounded timeout, malformed input, or failed postconditions', async () => {
    const timeout = navigationHarness({ manualZoom: true, timeoutMs: 5 });
    expect(await timeout.navigation.applyLocation({
      pageIndex: 0,
      anchor: { x: 10, y: 10 },
      alignment: { xPercent: 0, yPercent: 0 },
      zoom: 1.5,
    })).toBe(false);

    const malformed = { pageIndex: -1, anchor: { x: 0, y: 0 }, alignment: { xPercent: 0, yPercent: 0 }, zoom: 1 };
    expect(await timeout.navigation.applyLocation(malformed)).toBe(false);

    const failed = navigationHarness({ updateGeometry: false });
    expect(await failed.navigation.applyLocation({
      pageIndex: 0,
      anchor: { x: 10, y: 10 },
      alignment: { xPercent: 0, yPercent: 0 },
      zoom: 1.5,
    })).toBe(false);
  });

  it('rejects a stale target generation and focuses a valid destination without scrolling', async () => {
    const harness = navigationHarness();
    const staleTarget = { ...target(PdfZoomMode.FitPage), documentGeneration: 3 };

    expect(await harness.navigation.applyTarget(staleTarget)).toBe(false);
    expect(harness.navigation.focusAtDestination(0)).toBe(true);
    expect(harness.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(focusViewerDestination(null, 0)).toBe(false);
  });
});
