import type { PluginRegistry } from '@embedpdf/core';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';
import { ZoomMode, ZoomPlugin } from '@embedpdf/plugin-zoom';

import { anchoredZoom } from './anchored-zoom.js';

import type { ViewerInteractionEvent, ViewerInteractionListener } from './viewer-interaction-events.js';

export interface ViewerControlsSnapshot {
  readonly ready: boolean;
  readonly pageReady: boolean;
  readonly zoomReady: boolean;
  readonly currentPage: number;
  readonly totalPages: number;
  readonly zoomPercent: number;
  readonly unavailableReason?: string;
  readonly pageUnavailableReason?: string;
  readonly zoomUnavailableReason?: string;
}

export interface ViewerControls {
  snapshot(): ViewerControlsSnapshot;
  previousPage(): void;
  nextPage(): void;
  goToPage(pageNumber: number): void;
  zoomOut(): void;
  zoomIn(): void;
  zoomToPercent(zoomPercent: number): void;
  subscribe(listener: ViewerInteractionListener): () => void;
  dispose(): void;
}

export interface InitializedViewerControls extends ViewerControls {
  /** True only while the untouched initial Fit Width preset still owns zoom. */
  usesAutomaticFitWidth(): boolean;
  /** Converts an automatic zoom preset to its current numeric scale without changing numeric user/restored zoom. */
  freezeCurrentZoom(): boolean;
}

export const VIEWER_ZOOM_MIN_PERCENT = 20;
export const VIEWER_ZOOM_MAX_PERCENT = 6000;

const UNAVAILABLE = 'Viewer controls become available when the PDF is ready.';
const PAGE_UNAVAILABLE = 'Page controls become available when PDF navigation is ready.';
const ZOOM_UNAVAILABLE = 'Zoom controls become available when PDF zoom is ready.';

export function unavailableViewerControls(): ViewerControlsSnapshot {
  return {
    ready: false,
    pageReady: false,
    zoomReady: false,
    currentPage: 0,
    totalPages: 0,
    zoomPercent: 0,
    unavailableReason: UNAVAILABLE,
    pageUnavailableReason: PAGE_UNAVAILABLE,
    zoomUnavailableReason: ZOOM_UNAVAILABLE,
  };
}

export function createViewerControls(
  registry: PluginRegistry,
  options: {
    readonly viewport?: () => HTMLElement | null;
    /** Current page in the unobscured reading viewport, or null before geometry is ready. */
    readonly currentReadingPage?: () => number | null;
    /** Return false only when navigation is not ready and native scrolling should handle the jump. */
    readonly jumpToPage?: (pageNumber: number) => Promise<boolean> | false;
    readonly onManualZoom?: () => void;
  } = {},
): InitializedViewerControls {
  const { viewport, jumpToPage } = options;
  const core = registry.getStore().getState().core;
  const documentId = core.activeDocumentId;
  const scrollCapability = registry.getPlugin<ScrollPlugin>(ScrollPlugin.id)?.provides();
  const zoomCapability = registry.getPlugin<ZoomPlugin>(ZoomPlugin.id)?.provides();
  const scroll = documentId && scrollCapability ? scrollCapability.forDocument(documentId) : null;
  const zoom = documentId && zoomCapability ? zoomCapability.forDocument(documentId) : null;
  const documentPageCount = documentId
    ? core.documents?.[documentId]?.document?.pages.length ?? 0
    : 0;
  const listeners = new Set<ViewerInteractionListener>();
  const subscriptions: Array<() => void> = [];
  const pageReady = scroll !== null;
  const zoomReady = zoom !== null;
  let state: ViewerControlsSnapshot = {
    ready: pageReady && zoomReady,
    pageReady,
    zoomReady,
    currentPage: scroll?.getCurrentPage() ?? 0,
    totalPages: scroll ? Math.max(scroll.getTotalPages(), documentPageCount) : 0,
    zoomPercent: zoom ? Math.round(zoom.getState().currentZoomLevel * 100) : 0,
    ...(pageReady ? {} : { pageUnavailableReason: PAGE_UNAVAILABLE }),
    ...(zoomReady ? {} : { zoomUnavailableReason: ZOOM_UNAVAILABLE }),
    ...(!pageReady || !zoomReady ? { unavailableReason: UNAVAILABLE } : {}),
  };

  const currentPage = (fallback = state.currentPage, totalPages = state.totalPages): number => {
    const readingPage = options.currentReadingPage?.();
    return typeof readingPage === 'number'
      && Number.isSafeInteger(readingPage) && readingPage >= 1 && readingPage <= totalPages
      ? readingPage : fallback;
  };

  let disposed = false;
  // A scroll subscriber can expose live geometry before the deferred refresh.
  // Keep that baseline separate from the cached fallback used without geometry.
  let lastExposedPage = state.currentPage;
  let pendingPage: number | null = null;
  let jumpGeneration = 0;
  const requestPageJump = (pageNumber: number): boolean => {
    const result = jumpToPage?.(pageNumber);
    if (!result) return false;
    const generation = ++jumpGeneration;
    pendingPage = pageNumber;
    const settled = () => {
      if (generation === jumpGeneration) pendingPage = null;
    };
    void result.then(settled, settled);
    return true;
  };

  const emit = (event: ViewerInteractionEvent) => {
    if (disposed) return;
    if (event.type === 'page') lastExposedPage = event.currentPage;
    for (const listener of listeners) listener(event);
  };
  let pageRefreshFrame: number | null = null;
  const schedulePageRefresh = () => {
    if (disposed || !options.currentReadingPage || pageRefreshFrame !== null || typeof requestAnimationFrame !== 'function') return;
    pageRefreshFrame = requestAnimationFrame(() => {
      pageRefreshFrame = null;
      if (disposed) return;
      observePageMounts();
      const page = currentPage();
      if (page === lastExposedPage) return;
      state = { ...state, currentPage: page };
      emit({ type: 'page', currentPage: page, totalPages: state.totalPages });
    });
  };
  // Native page events can precede the virtualized destination's DOM mount.
  // Observe mounting as well as scrolling, then read geometry after layout.
  let observedViewport: HTMLElement | null = null;
  const pageMountObserver = options.currentReadingPage && typeof MutationObserver !== 'undefined'
    ? new MutationObserver(schedulePageRefresh) : null;
  const observePageMounts = () => {
    if (disposed) return;
    const element = viewport?.() ?? null;
    if (!pageMountObserver || element === observedViewport) return;
    if (observedViewport) pageMountObserver.disconnect();
    observedViewport = element;
    if (element) pageMountObserver.observe(element, { childList: true, subtree: true });
  };
  observePageMounts();
  if (documentId && scrollCapability && scroll) {
    const updatePage = (reportedPage: number, reportedTotalPages: number) => {
      const loadedPageCount = registry.getStore().getState().core.documents?.[documentId]
        ?.document?.pages.length ?? documentPageCount;
      const totalPages = Math.max(reportedTotalPages, loadedPageCount);
      const page = currentPage(reportedPage, totalPages);
      state = { ...state, currentPage: page, totalPages };
      emit({ type: 'page', currentPage: page, totalPages });
      schedulePageRefresh();
    };
    subscriptions.push(
      scrollCapability.onPageChange((event) => {
        if (event.documentId !== documentId) return;
        updatePage(event.pageNumber, event.totalPages);
      }),
      scroll.onScroll(() => {
        emit({ type: 'scroll' });
        schedulePageRefresh();
      }),
    );
    if (scrollCapability.onLayoutReady) {
      subscriptions.push(scrollCapability.onLayoutReady((event) => {
        if (event.documentId !== documentId) return;
        updatePage(event.pageNumber, event.totalPages);
      }));
    }
  }
  if (documentId && zoomCapability && zoom) {
    subscriptions.push(
      zoomCapability.onZoomChange((event) => {
        if (event.documentId !== documentId) return;
        const zoomPercent = Math.round(event.newZoom * 100);
        state = { ...state, zoomPercent };
        emit({ type: 'zoom', zoomPercent, oldZoom: event.oldZoom, newZoom: event.newZoom });
      }),
    );
  }

  return {
    snapshot: () => {
      lastExposedPage = currentPage();
      return { ...state, currentPage: lastExposedPage };
    },
    previousPage: () => {
      const page = pendingPage ?? currentPage();
      if (page <= 1) return;
      if (!requestPageJump(page - 1)) scroll?.scrollToPreviousPage('smooth');
    },
    nextPage: () => {
      const page = pendingPage ?? currentPage();
      if (page >= state.totalPages) return;
      if (!requestPageJump(page + 1)) scroll?.scrollToNextPage('smooth');
    },
    goToPage: (pageNumber) => {
      if (!scroll || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > state.totalPages) return;
      if (!requestPageJump(pageNumber)) scroll.scrollToPage({ pageNumber, behavior: 'smooth' });
    },
    zoomOut: () => { if (zoom) options.onManualZoom?.(); anchoredZoom(viewport?.() ?? null, () => zoom?.zoomOut(), undefined, true); },
    zoomIn: () => { if (zoom) options.onManualZoom?.(); anchoredZoom(viewport?.() ?? null, () => zoom?.zoomIn(), undefined, true); },
    zoomToPercent: (zoomPercent) => {
      if (
        !zoom
        || !Number.isSafeInteger(zoomPercent)
        || zoomPercent < VIEWER_ZOOM_MIN_PERCENT
        || zoomPercent > VIEWER_ZOOM_MAX_PERCENT
      ) return;
      options.onManualZoom?.();
      anchoredZoom(viewport?.() ?? null, () => zoom.requestZoom(zoomPercent / 100), undefined, true);
    },
    usesAutomaticFitWidth: () => {
      try {
        return zoom?.getState().zoomLevel === ZoomMode.FitWidth;
      } catch {
        return false;
      }
    },
    freezeCurrentZoom: () => {
      if (!zoom) return false;
      try {
        const zoomState = zoom.getState();
        if (typeof zoomState.zoomLevel === 'number') return true;
        const currentZoom = zoomState.currentZoomLevel;
        if (!Number.isFinite(currentZoom) || currentZoom <= 0) return false;
        zoom.requestZoom(currentZoom);
        return true;
      } catch {
        return false;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state.ready
        ? { type: 'readiness', ready: true }
        : { type: 'readiness', ready: false, reason: state.unavailableReason ?? UNAVAILABLE });
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      jumpGeneration += 1;
      pendingPage = null;
      pageMountObserver?.disconnect();
      if (pageRefreshFrame !== null) cancelAnimationFrame(pageRefreshFrame);
      pageRefreshFrame = null;
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
      listeners.clear();
    },
  };
}
