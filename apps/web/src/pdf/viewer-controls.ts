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
/** Fit Width stops here so wide windows keep body text at a comfortable reading size. */
export const VIEWER_READING_FIT_MAX_PERCENT = 150;

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
    /** Return false only when navigation is not ready and native scrolling should handle the jump. */
    readonly jumpToPage?: (pageNumber: number) => Promise<boolean> | false;
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
    for (const listener of listeners) listener(event);
  };
  if (documentId && scrollCapability && scroll) {
    const updatePage = (currentPage: number, reportedTotalPages: number) => {
      const loadedPageCount = registry.getStore().getState().core.documents?.[documentId]
        ?.document?.pages.length ?? documentPageCount;
      const totalPages = Math.max(reportedTotalPages, loadedPageCount);
      state = { ...state, currentPage, totalPages };
      emit({ type: 'page', currentPage, totalPages });
    };
    subscriptions.push(
      scrollCapability.onPageChange((event) => {
        if (event.documentId !== documentId) return;
        updatePage(event.pageNumber, event.totalPages);
      }),
      scroll.onScroll(() => emit({ type: 'scroll' })),
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
        emit({ type: 'zoom', zoomPercent });
      }),
    );
  }

  return {
    snapshot: () => state,
    previousPage: () => {
      const currentPage = pendingPage ?? state.currentPage;
      if (currentPage <= 1) return;
      if (!requestPageJump(currentPage - 1)) scroll?.scrollToPreviousPage('smooth');
    },
    nextPage: () => {
      const currentPage = pendingPage ?? state.currentPage;
      if (currentPage >= state.totalPages) return;
      if (!requestPageJump(currentPage + 1)) scroll?.scrollToNextPage('smooth');
    },
    goToPage: (pageNumber) => {
      if (!scroll || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > state.totalPages) return;
      if (!requestPageJump(pageNumber)) scroll.scrollToPage({ pageNumber, behavior: 'smooth' });
    },
    zoomOut: () => anchoredZoom(viewport?.() ?? null, () => zoom?.zoomOut(), undefined, true),
    zoomIn: () => anchoredZoom(viewport?.() ?? null, () => zoom?.zoomIn(), undefined, true),
    zoomToPercent: (zoomPercent) => {
      if (
        !zoom
        || !Number.isSafeInteger(zoomPercent)
        || zoomPercent < VIEWER_ZOOM_MIN_PERCENT
        || zoomPercent > VIEWER_ZOOM_MAX_PERCENT
      ) return;
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
      jumpGeneration += 1;
      pendingPage = null;
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
      listeners.clear();
    },
  };
}
