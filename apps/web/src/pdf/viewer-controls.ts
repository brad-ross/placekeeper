import type { PluginRegistry } from '@embedpdf/core';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';
import { ZoomPlugin } from '@embedpdf/plugin-zoom';

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
  zoomOut(): void;
  zoomIn(): void;
  subscribe(listener: ViewerInteractionListener): () => void;
  dispose(): void;
}

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

export function createViewerControls(registry: PluginRegistry): ViewerControls {
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
    previousPage: () => scroll?.scrollToPreviousPage('smooth'),
    nextPage: () => scroll?.scrollToNextPage('smooth'),
    zoomOut: () => zoom?.zoomOut(),
    zoomIn: () => zoom?.zoomIn(),
    subscribe(listener) {
      listeners.add(listener);
      listener(state.ready
        ? { type: 'readiness', ready: true }
        : { type: 'readiness', ready: false, reason: state.unavailableReason ?? UNAVAILABLE });
      return () => listeners.delete(listener);
    },
    dispose() {
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
      listeners.clear();
    },
  };
}
