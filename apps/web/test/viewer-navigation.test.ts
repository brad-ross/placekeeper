import type { PluginRegistry } from '@embedpdf/core';
import { PdfZoomMode, Rotation, transformPosition, transformSize } from '@embedpdf/models';
import { ScrollPlugin, type ScrollToPageOptions } from '@embedpdf/plugin-scroll';
import { ViewportPlugin } from '@embedpdf/plugin-viewport';
import { ZoomPlugin, type ZoomChangeEvent } from '@embedpdf/plugin-zoom';
import { describe, expect, it, vi } from 'vitest';

import type { PdfNavigationTarget } from '../src/pdf/pdf-navigation-target.js';
import { combinePageRotation } from '../src/pdf/owned-overlay.js';
import {
  pdfBottomOriginPointToNaturalAnchor,
  samePdfViewerLocation,
} from '../src/pdf/viewer-navigation.js';
import {
  createPdfAnnotationOrderLocation,
  createPdfOutlineTargetOrderLocation,
} from '../src/pdf/document-order-location.js';
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

  it('keeps authored outline coordinates distinct from page-level navigation defaults', () => {
    expect(createPdfOutlineTargetOrderLocation(target(PdfZoomMode.XYZ, [172, 740, 1]), {
      page: { ...page, cropOrigin: { x: 100, y: 200 } },
      documentGeneration: 4,
    })).toEqual({
      pageIndex: 0,
      anchor: { x: 72, y: 260 },
      precision: 'exact',
    });
    expect(createPdfOutlineTargetOrderLocation(target(PdfZoomMode.FitPage), {
      page,
      documentGeneration: 4,
    })).toEqual({
      pageIndex: 0,
      anchor: { x: 0, y: 0 },
      precision: 'page',
    });
    expect(createPdfOutlineTargetOrderLocation(target(PdfZoomMode.FitVertical, [20]), {
      page,
      documentGeneration: 4,
    })).toEqual({
      pageIndex: 0,
      anchor: { x: 0, y: 0 },
      precision: 'page',
    });
    expect(createPdfOutlineTargetOrderLocation(target(PdfZoomMode.FitHorizontal, [700]), {
      page,
      documentGeneration: 4,
    })).toEqual({
      pageIndex: 0,
      anchor: { x: 0, y: 100 },
      precision: 'exact',
    });
  });

  it('validates crop-relative annotation points without reapplying crop boundaries', () => {
    expect(createPdfAnnotationOrderLocation({ pageIndex: 2, point: { x: 72, y: 60 } }, {
      page,
    })).toEqual({ pageIndex: 2, anchor: { x: 72, y: 60 } });
    expect(createPdfAnnotationOrderLocation({ pageIndex: 2, point: { x: Number.NaN, y: 260 } }, {
      page,
    })).toBeNull();
  });

  it.each([
    ['page-only', target(PdfZoomMode.Unknown), { x: 300, y: 0 }, { xPercent: 50, yPercent: 0 }],
    ['full-page', target(PdfZoomMode.FitPage), { x: 300, y: 0 }, { xPercent: 50, yPercent: 0 }],
    ['vertical-fit', target(PdfZoomMode.FitVertical, [20]), { x: 300, y: 0 }, { xPercent: 50, yPercent: 0 }],
    ['XYZ', target(PdfZoomMode.XYZ, [20, 700, 2]), { x: 300, y: 100 }, { xPercent: 50, yPercent: 0 }],
    ['horizontal-fit', target(PdfZoomMode.FitHorizontal, [700]), { x: 300, y: 100 }, { xPercent: 50, yPercent: 0 }],
    ['bounding-box-horizontal-fit', target(PdfZoomMode.FitBoundingBoxHorizontal, [700]), { x: 300, y: 100 }, { xPercent: 50, yPercent: 0 }],
    ['rectangle', target(PdfZoomMode.FitRectangle, [100, 200, 500, 700]), { x: 300, y: 350 }, { xPercent: 50, yPercent: 50 }],
  ] as const)('fits a reference %s target to width with the appropriate vertical anchor', (
    _name,
    destination,
    anchor,
    alignment,
  ) => {
    expect(createPdfTargetLocation(destination, {
      page,
      viewport: { width: 620, height: 300, gap: 10 },
      currentZoom: 1.25,
    }, 'reference-fit-width')).toEqual({
      pageIndex: 0,
      anchor,
      alignment,
      zoom: 1,
    });
  });

  it('fits a cropped, rotated reference page using its rotated full-page width and crop anchor', () => {
    expect(createPdfTargetLocation(target(PdfZoomMode.XYZ, [172, 740, 2]), {
      page: { ...page, cropOrigin: { x: 100, y: 200 } },
      viewport: { width: 820, height: 300, gap: 10 },
      currentZoom: 1.25,
      rotation: Rotation.Degree90,
    }, 'reference-fit-width')).toEqual({
      pageIndex: 0,
      anchor: { x: 300, y: 260 },
      alignment: { xPercent: 50, yPercent: 0 },
      zoom: 1,
    });
  });

  it('fails closed for unusable reference fit metrics', () => {
    expect(createPdfTargetLocation(target(PdfZoomMode.FitPage), {
      page,
      viewport: { width: 20, height: 300, gap: 10 },
      currentZoom: 1,
    }, 'reference-fit-width')).toBeNull();
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
  classicScrollbarWidth?: number;
  constrainedHorizontal?: boolean;
  artificialHorizontalRunway?: boolean;
  constrainedVertical?: 'start' | 'end';
  initiallyUnreadyPage?: boolean;
  farTargetInitiallyUnmounted?: boolean;
  initiallyUnready?: boolean;
  initialViewportWidth?: number;
  manualZoom?: boolean;
  metricWidth?: number;
  omitViewportElement?: boolean;
  omitZoomLayoutEvent?: boolean;
  resizeViewportAfterFirstZoom?: number;
  stickyScrollActivity?: boolean;
  staleViewportMetricsReads?: number;
  staleCurrentPageWithThirdVisible?: boolean;
  runway?: ViewerRunway;
  viewportGap?: number;
  viewportClientWidth?: number;
  initialPageTop?: number;
  pageRotation?: Rotation;
  documentRotation?: Rotation;
  cropOrigin?: { readonly x: number; readonly y: number };
  updateGeometry?: boolean;
  viewportWidth?: number;
  throwViewportScroll?: boolean;
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
    width: options.initiallyUnready
      ? 0
      : options.initialViewportWidth
        ?? options.viewportWidth
        ?? (options.constrainedHorizontal ? 620 : 600),
    height: options.initiallyUnready ? 0 : 400,
  };
  const pageRect: RectState = {
    left: options.constrainedHorizontal ? 10 : -100,
    top: options.initialPageTop ?? -200,
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
    get clientWidth() {
      return options.viewportClientWidth
        ?? viewportRect.width - (options.classicScrollbarWidth ?? 0);
    },
    get clientHeight() { return viewportRect.height; },
    get scrollLeft() { return viewportScrollLeft; },
    get scrollTop() { return viewportScrollTop; },
    scrollTo(position: ScrollToOptions) {
      if (options.throwViewportScroll) throw new Error('viewport command failed');
      const nextLeft = position.left ?? viewportScrollLeft;
      const nextTop = position.top ?? viewportScrollTop;
      const horizontalDelta = nextLeft - viewportScrollLeft;
      const verticalDelta = nextTop - viewportScrollTop;
      pageRect.left -= horizontalDelta;
      pageRect.top -= verticalDelta;
      thirdPageRect.left -= horizontalDelta;
      thirdPageRect.top -= verticalDelta;
      viewportScrollLeft = nextLeft;
      viewportScrollTop = nextTop;
      if (options.staleCurrentPageWithThirdVisible) currentPage = 3;
    },
    get scrollWidth() {
      return options.artificialHorizontalRunway
        ? 1_000
        : options.constrainedHorizontal ? pageRect.width : 2_000;
    },
    get scrollHeight() { return 2_000; },
    clientLeft: 0,
    clientTop: 0,
  } as unknown as HTMLElement;
  const root = {
    querySelector: (selector: string) => {
      if (selector === '[data-viewer-framing-viewport]') {
        return options.omitViewportElement ? null : viewportElement;
      }
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
  let viewportScrollLeft = 0;
  let viewportScrollTop = options.constrainedVertical === 'end' ? 1_600 : 0;
  let staleViewportMetricsReads = options.staleViewportMetricsReads ?? 0;
  let viewportResized = false;
  const storeListeners = new Set<() => void>();
  type HarnessZoomEvent = Pick<
    ZoomChangeEvent,
    'oldZoom' | 'newZoom' | 'center' | 'desiredScrollLeft' | 'desiredScrollTop'
  >;
  const zoomListeners = new Set<(event: HarnessZoomEvent) => void>();
  const layoutListeners = new Set<() => void>();
  const activityListeners = new Set<(activity: { isScrolling: boolean; isSmoothScrolling: boolean }) => void>();

  const emitZoom = (zoom: number) => {
    const oldZoom = currentZoom;
    const oldPageRect = { ...pageRect };
    const oldThirdPageRect = { ...thirdPageRect };
    currentZoom = zoom;
    if (options.updateGeometry !== false) {
      const ratio = zoom / oldZoom;
      const focus = {
        x: viewportRect.left + viewportRect.width / 2,
        y: viewportRect.top + viewportRect.height / 2,
      };
      pageRect.width = initialRotatedPage.width * zoom;
      pageRect.height = initialRotatedPage.height * zoom;
      thirdPageRect.width = initialRotatedPage.width * zoom;
      thirdPageRect.height = initialRotatedPage.height * zoom;
      pageRect.left = focus.x + ratio * (oldPageRect.left - focus.x);
      pageRect.top = focus.y + ratio * (oldPageRect.top - focus.y);
      thirdPageRect.left = focus.x + ratio * (oldThirdPageRect.left - focus.x);
      thirdPageRect.top = focus.y + ratio * (oldThirdPageRect.top - focus.y);
    }
    for (const listener of zoomListeners) listener({
      oldZoom,
      newZoom: zoom,
      center: { vx: viewportRect.width / 2, vy: viewportRect.height / 2 },
      desiredScrollLeft: viewportScrollLeft,
      desiredScrollTop: viewportScrollTop,
    });
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
        if (!viewportResized && options.resizeViewportAfterFirstZoom !== undefined) {
          viewportResized = true;
          viewportRect.width = options.resizeViewportAfterFirstZoom;
        }
      }
    },
    onZoomChange: (listener: (event: HarnessZoomEvent) => void) => {
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
            + viewportElement.clientWidth * ((request.alignX ?? 0) / 100)
            - transformedAnchor.x;
        targetRect.top = options.constrainedVertical === 'start'
          ? viewportRect.top
          : options.constrainedVertical === 'end'
            ? viewportRect.top + viewportRect.height - targetRect.height
            : viewportRect.top
              + viewportElement.clientHeight * ((request.alignY ?? 0) / 100)
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
    getMetrics: () => {
      const scrollHeight = staleViewportMetricsReads > 0 ? 2_400 : 2_000;
      staleViewportMetricsReads = Math.max(0, staleViewportMetricsReads - 1);
      return {
        width: options.metricWidth ?? viewportRect.width,
        height: viewportRect.height,
        clientWidth: options.metricWidth
          ?? options.viewportClientWidth
          ?? viewportRect.width - (options.classicScrollbarWidth ?? 0),
        clientHeight: viewportRect.height,
        scrollTop: viewportScrollTop,
        scrollLeft: viewportScrollLeft,
        scrollWidth: options.artificialHorizontalRunway
          ? 1_000
          : options.constrainedHorizontal ? pageRect.width : 2_000,
        scrollHeight,
        clientLeft: 0,
        clientTop: 0,
        relativePosition: { x: 0, y: 0 },
      };
    },
    scrollTo: (position: { x: number; y: number }) => {
      log.push('viewport-scroll');
      if (options.throwViewportScroll) throw new Error('viewport command failed');
      const horizontalDelta = position.x - viewportScrollLeft;
      const verticalDelta = position.y - viewportScrollTop;
      pageRect.left -= horizontalDelta;
      pageRect.top -= verticalDelta;
      thirdPageRect.left -= horizontalDelta;
      thirdPageRect.top -= verticalDelta;
      viewportScrollLeft = position.x;
      viewportScrollTop = position.y;
      if (options.staleCurrentPageWithThirdVisible) currentPage = 3;
    },
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
      index,
      size: page,
      rotation: options.pageRotation ?? Rotation.Degree0,
      objectNumber: index + 1,
      boxes: {
        crop: {
          left: options.cropOrigin?.x ?? 0,
          bottom: options.cropOrigin?.y ?? 0,
        },
      },
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
  it.each([
    ['XYZ', target(PdfZoomMode.XYZ, [300, 400, 2])],
    ['fit-page', target(PdfZoomMode.FitPage)],
    ['fit-horizontal', target(PdfZoomMode.FitHorizontal, [400])],
    ['fit-vertical', target(PdfZoomMode.FitVertical, [300])],
    ['fit-rectangle', target(PdfZoomMode.FitRectangle, [200, 300, 400, 500])],
  ] as const)('reports a mounted %s semantic anchor inside or outside the effective viewport', (
    _name,
    destination,
  ) => {
    const harness = navigationHarness();

    expect(harness.navigation.targetVisibility(destination)).toBe('visible');
    harness.pageRect.top = -801;
    expect(harness.navigation.targetVisibility(destination)).toBe('outside');
  });

  it('uses rotation, scrollbar client boxes, runway clipping, and edge tolerance for visibility', () => {
    const harness = navigationHarness({
      initialViewportWidth: 620,
      classicScrollbarWidth: 20,
      pageRotation: Rotation.Degree90,
      runway: { right: 200, bottom: 0 },
    });
    const destination = target(PdfZoomMode.XYZ, [300, 400, 1]);

    harness.pageRect.left = 121.5;
    harness.pageRect.top = -225;
    expect(harness.navigation.targetVisibility(destination)).toBe('visible');
    harness.pageRect.left = 121.6;
    expect(harness.navigation.targetVisibility(destination)).toBe('outside');
  });

  it('resolves cropped destination coordinates before testing the displayed semantic anchor', () => {
    const harness = navigationHarness({ cropOrigin: { x: 100, y: 200 } });
    const destination = target(PdfZoomMode.XYZ, [400, 600, 1]);

    expect(harness.navigation.targetVisibility(destination)).toBe('visible');
    harness.pageRect.top = -801;
    expect(harness.navigation.targetVisibility(destination)).toBe('outside');
  });

  it('reports unmounted live targets outside and invalid or unusable lifecycle states unavailable', () => {
    const unmounted = navigationHarness({ farTargetInitiallyUnmounted: true });
    const distantTarget = { ...target(PdfZoomMode.FitPage), pageIndex: 2 };
    expect(unmounted.navigation.targetVisibility(distantTarget)).toBe('outside');

    const unready = navigationHarness({ initiallyUnreadyPage: true });
    expect(unready.navigation.targetVisibility(target(PdfZoomMode.FitPage))).toBe('unavailable');
    expect(unmounted.navigation.targetVisibility({
      ...target(PdfZoomMode.XYZ, [0, 0]),
      zoom: { mode: PdfZoomMode.XYZ, params: [Number.NaN, 0, 1] },
    })).toBe('unavailable');
    expect(unmounted.navigation.targetVisibility({
      ...target(PdfZoomMode.FitPage),
      documentGeneration: 3,
    })).toBe('unavailable');

    unmounted.navigation.replaceDocument(5);
    expect(unmounted.navigation.targetVisibility(distantTarget)).toBe('unavailable');
    unmounted.navigation.dispose();
    expect(unmounted.navigation.targetVisibility({
      ...distantTarget,
      documentGeneration: 5,
    })).toBe('unavailable');
  });

  it('fits the most-visible page to the viewport minus two standard gaps', async () => {
    const harness = navigationHarness({ viewportGap: 10 });

    expect(await harness.navigation.fitToWidth()).toBe(true);
    expect(harness.log).toContain(`zoom:${580 / 600}`);
  });

  it('excludes a non-overlay vertical scrollbar gutter from fit width', async () => {
    const harness = navigationHarness({
      constrainedHorizontal: true,
      viewportClientWidth: 605,
      viewportGap: 10,
    });

    expect(await harness.navigation.fitToWidth()).toBe(true);
    expect(harness.log).toContain(`zoom:${585 / 600}`);
    expect(harness.pageRect.left).toBeCloseTo(10);
    expect(harness.pageRect.left + harness.pageRect.width).toBeCloseTo(595);
  });

  it('uses live scrollport boundary metrics when plugin metrics remain stale', async () => {
    const harness = navigationHarness({
      constrainedVertical: 'end',
      initialPageTop: -400,
      staleViewportMetricsReads: Number.POSITIVE_INFINITY,
      viewportGap: 10,
      viewportWidth: 400,
    });

    expect(await harness.navigation.fitToWidth()).toBe(true);
    expect(harness.log).toContain(`zoom:${380 / 600}`);
    expect(harness.navigation.captureLocation()?.zoom).toBeCloseTo(380 / 600);
  });

  it('subtracts right runway but not bottom runway from fit width', async () => {
    const right = navigationHarness({ viewportGap: 10, runway: { right: 200, bottom: 180 } });
    const bottom = navigationHarness({ viewportGap: 10, runway: { right: 0, bottom: 180 } });

    expect(await right.navigation.fitToWidth()).toBe(true);
    expect(right.log).toContain(`zoom:${380 / 600}`);
    expect(right.pageRect.left).toBeCloseTo(10);
    expect(right.pageRect.left + right.pageRect.width).toBeCloseTo(390);
    expect(await bottom.navigation.fitToWidth()).toBe(true);
    expect(bottom.log).toContain(`zoom:${580 / 600}`);
  });

  it('atomically positions the fitted page in a right-runway viewport', async () => {
    const harness = navigationHarness({
      viewportGap: 10,
      runway: { right: 200, bottom: 0 },
    });

    expect(await harness.navigation.fitToWidth()).toBe(true);
    expect(harness.log).not.toContain('scroll');
    expect(harness.pageRect.left).toBeCloseTo(10);
    expect(harness.pageRect.left + harness.pageRect.width).toBeCloseTo(390);
  });

  it('uses combined rotation and the most-visible mounted page for fit width', async () => {
    const harness = navigationHarness({
      viewportGap: 10,
      pageRotation: Rotation.Degree90,
      staleCurrentPageWithThirdVisible: true,
    });
    harness.pageRect.top = -900;

    expect(await harness.navigation.fitToWidth()).toBe(true);
    expect(harness.log).toContain(`zoom:${580 / 800}`);
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
    expect(harness.log).toContain(`zoom:${580 / 600}`);
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
    expect(harness.log).toContain(`zoom:${380 / 600}`);

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

  it('settles one rollback before a later direct viewer action runs', async () => {
    const harness = navigationHarness({ manualZoom: true, viewportGap: 10, timeoutMs: 250 });
    const fitting = harness.navigation.fitToWidth();
    await vi.waitFor(() => expect(harness.log).toContain(`zoom:${580 / 600}`));

    await harness.navigation.cancelPendingNavigation();
    harness.setCurrentZoom(1.25);

    expect(await fitting).toBe(false);
    expect(harness.log.filter((entry) => entry === 'zoom:1')).toHaveLength(1);
    expect(harness.navigation.captureLocation()?.zoom).toBe(1.25);
  });

  it('contains viewport positioning failures and restores the prior zoom', async () => {
    const options = {
      runway: { right: 200, bottom: 0 },
      throwViewportScroll: true,
      viewportGap: 10,
    } as const;
    const harness = navigationHarness(options);

    await expect(harness.navigation.fitToWidth()).resolves.toBe(false);
    expect(harness.navigation.captureLocation()?.zoom).toBe(1);
  });

  it.each([
    ['minimum', 120, 0.2],
    ['maximum', 36_000, 60],
  ] as const)('completes a %s-bound fit without rollback', async (_name, viewportWidth, zoom) => {
    const harness = navigationHarness({ viewportWidth });

    expect(await harness.navigation.fitToWidth()).toBe(true);
    expect(harness.log).toContain(`zoom:${zoom}`);
    expect(harness.navigation.captureLocation()?.pageIndex).toBe(0);
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

  it('captures neutral document-order page geometry through the adapter', () => {
    const harness = navigationHarness();

    expect(harness.navigation.captureDocumentOrderPages()).toEqual([{
      size: page,
      crop: { left: 0, top: 0, bottom: 0 },
    }]);
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

  it('fits a reference target from the committed DOM viewport when plugin metrics are stale', async () => {
    const harness = navigationHarness({ metricWidth: 820 });

    expect(await harness.navigation.applyTarget(
      target(PdfZoomMode.FitPage),
      'reference-fit-width',
    )).toBe(true);
    expect(harness.pageRect.width).toBe(600);
  });

  it('fits a reference target to the live client box when classic scrollbars reduce usable width', async () => {
    const harness = navigationHarness({
      initialViewportWidth: 620,
      classicScrollbarWidth: 20,
    });

    expect(await harness.navigation.applyTarget(
      target(PdfZoomMode.FitPage),
      'reference-fit-width',
    )).toBe(true);
    expect(harness.pageRect.width).toBe(600);
    expect(harness.pageRect.left).toBeCloseTo(0);
  });

  it('keeps ordinary navigation aligned to the live client box when a classic scrollbar is present', async () => {
    const harness = navigationHarness({
      initialViewportWidth: 620,
      classicScrollbarWidth: 20,
    });

    expect(await harness.navigation.applyLocation({
      pageIndex: 0,
      anchor: { x: 300, y: 400 },
      alignment: { xPercent: 50, yPercent: 50 },
      zoom: 1,
    })).toBe(true);
    expect(harness.log).toEqual(['scroll']);
  });

  it('accepts an unobscured destination anchor when a right runway covers only the page edge', async () => {
    const harness = navigationHarness({
      artificialHorizontalRunway: true,
      constrainedHorizontal: true,
      runway: { right: 200, bottom: 0 },
    });

    expect(await harness.navigation.applyTarget(target(PdfZoomMode.FitPage))).toBe(true);
    expect(harness.log).not.toContain('viewport-scroll');
  });

  it('reapplies a reference fit once when the committed width changes during navigation', async () => {
    const harness = navigationHarness({
      initialViewportWidth: 900,
      resizeViewportAfterFirstZoom: 600,
    });

    expect(await harness.navigation.applyTarget(
      target(PdfZoomMode.FitPage),
      'reference-fit-width',
    )).toBe(true);
    expect(harness.log).toEqual(['zoom:1.5', 'scroll', 'zoom:1', 'scroll']);
    expect(harness.pageRect.width).toBe(600);
  });

  it('fails boundedly without mutation when the committed reference viewport is absent', async () => {
    const harness = navigationHarness({ omitViewportElement: true, timeoutMs: 1 });

    expect(await harness.navigation.applyTarget(
      target(PdfZoomMode.FitPage),
      'reference-fit-width',
    )).toBe(false);
    expect(harness.log).toEqual([]);
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

  it('restores destination focus when WebKit replaces the page after navigation settles', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const body = {} as HTMLElement;
    const document = { activeElement: body, body } as unknown as Document;
    const firstPage = {
      ownerDocument: document,
      focus: vi.fn(() => { (document as { activeElement: unknown }).activeElement = firstPage; }),
    } as unknown as HTMLElement;
    const replacementPage = {
      ownerDocument: document,
      focus: vi.fn(() => { (document as { activeElement: unknown }).activeElement = replacementPage; }),
    } as unknown as HTMLElement;
    let mountedPage = firstPage;
    const root = {
      querySelector: () => mountedPage,
    } as unknown as HTMLElement;

    expect(focusViewerDestination(root, 2)).toBe(true);
    mountedPage = replacementPage;
    (document as { activeElement: unknown }).activeElement = body;
    frames.shift()?.(0);
    frames.shift()?.(16);

    expect(firstPage.focus).toHaveBeenCalledOnce();
    expect(replacementPage.focus).toHaveBeenCalledWith({ preventScroll: true });
    vi.unstubAllGlobals();
  });
});
