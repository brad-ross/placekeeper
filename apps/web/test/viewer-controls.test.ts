import type { PluginRegistry } from '@embedpdf/core';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';
import { ZoomPlugin } from '@embedpdf/plugin-zoom';
import { describe, expect, it, vi } from 'vitest';

import { createViewerControls } from '../src/pdf/viewer-controls.js';

describe('viewer controls adapter', () => {
  it('reads public page and zoom capabilities and forwards actions for the active document', () => {
    let onPage: ((event: { documentId: string; pageNumber: number; totalPages: number }) => void) | undefined;
    let onLayoutReady: ((event: { documentId: string; pageNumber: number; totalPages: number }) => void) | undefined;
    let onZoom: ((event: { documentId: string; newZoom: number }) => void) | undefined;
    const unsubscribePage = vi.fn();
    const unsubscribeScroll = vi.fn();
    const unsubscribeZoom = vi.fn();
    const unsubscribeLayoutReady = vi.fn();
    const scroll = {
      getCurrentPage: () => 2,
      getTotalPages: () => 8,
      scrollToPreviousPage: vi.fn(),
      scrollToNextPage: vi.fn(),
      scrollToPage: vi.fn(),
      onScroll: vi.fn(() => unsubscribeScroll),
    };
    const zoom = {
      getState: () => ({ currentZoomLevel: 1.25 }),
      zoomOut: vi.fn(),
      zoomIn: vi.fn(),
    };
    const registry = {
      getStore: () => ({ getState: () => ({ core: { activeDocumentId: 'doc' } }) }),
      getPlugin: (id: string) => id === ScrollPlugin.id
        ? { provides: () => ({
            forDocument: () => scroll,
            onPageChange: (listener: typeof onPage) => {
              onPage = listener;
              return unsubscribePage;
            },
            onLayoutReady: (listener: typeof onLayoutReady) => {
              onLayoutReady = listener;
              return unsubscribeLayoutReady;
            },
          }) }
        : id === ZoomPlugin.id
          ? { provides: () => ({
              forDocument: () => zoom,
              onZoomChange: (listener: typeof onZoom) => {
                onZoom = listener;
                return unsubscribeZoom;
              },
            }) }
          : undefined,
    } as unknown as PluginRegistry;

    const controls = createViewerControls(registry);
    expect(controls.snapshot()).toMatchObject({ ready: true, currentPage: 2, totalPages: 8, zoomPercent: 125 });

    controls.previousPage();
    controls.nextPage();
    controls.goToPage(5);
    controls.zoomOut();
    controls.zoomIn();
    expect(scroll.scrollToPreviousPage).toHaveBeenCalledWith('smooth');
    expect(scroll.scrollToNextPage).toHaveBeenCalledWith('smooth');
    expect(scroll.scrollToPage).toHaveBeenCalledWith({ pageNumber: 5, behavior: 'smooth' });
    expect(controls.snapshot()).toMatchObject({ currentPage: 2, totalPages: 8 });
    expect(zoom.zoomOut).toHaveBeenCalledOnce();
    expect(zoom.zoomIn).toHaveBeenCalledOnce();

    onPage?.({ documentId: 'doc', pageNumber: 3, totalPages: 8 });
    onZoom?.({ documentId: 'doc', newZoom: 1.5 });
    expect(controls.snapshot()).toMatchObject({ currentPage: 3, totalPages: 8, zoomPercent: 150 });
    onLayoutReady?.({ documentId: 'doc', pageNumber: 1, totalPages: 8 });
    expect(controls.snapshot()).toMatchObject({ currentPage: 1, totalPages: 8 });

    controls.dispose();
    expect(unsubscribePage).toHaveBeenCalledOnce();
    expect(unsubscribeScroll).toHaveBeenCalledOnce();
    expect(unsubscribeLayoutReady).toHaveBeenCalledOnce();
    expect(unsubscribeZoom).toHaveBeenCalledOnce();
  });

  it('forwards only current valid one-based destinations and keeps page state event-derived', () => {
    let onPage: ((event: { documentId: string; pageNumber: number; totalPages: number }) => void) | undefined;
    const scroll = {
      getCurrentPage: () => 2,
      getTotalPages: () => 3,
      scrollToPreviousPage: vi.fn(),
      scrollToNextPage: vi.fn(),
      scrollToPage: vi.fn(),
      onScroll: vi.fn(() => () => undefined),
    };
    const registry = {
      getStore: () => ({ getState: () => ({ core: { activeDocumentId: 'doc' } }) }),
      getPlugin: (id: string) => id === ScrollPlugin.id
        ? { provides: () => ({
            forDocument: () => scroll,
            onPageChange: (listener: typeof onPage) => {
              onPage = listener;
              return () => undefined;
            },
          }) }
        : undefined,
    } as unknown as PluginRegistry;

    const controls = createViewerControls(registry);
    for (const destination of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 4]) {
      controls.goToPage(destination);
    }
    expect(scroll.scrollToPage).not.toHaveBeenCalled();

    controls.goToPage(3);
    expect(scroll.scrollToPage).toHaveBeenCalledOnce();
    expect(scroll.scrollToPage).toHaveBeenLastCalledWith({ pageNumber: 3, behavior: 'smooth' });
    expect(controls.snapshot()).toMatchObject({ currentPage: 2, totalPages: 3 });

    onPage?.({ documentId: 'doc', pageNumber: 2, totalPages: 5 });
    controls.goToPage(5);
    expect(scroll.scrollToPage).toHaveBeenCalledTimes(2);
    expect(scroll.scrollToPage).toHaveBeenLastCalledWith({ pageNumber: 5, behavior: 'smooth' });
    expect(controls.snapshot()).toMatchObject({ currentPage: 2, totalPages: 5 });

    onPage?.({ documentId: 'doc', pageNumber: 5, totalPages: 5 });
    expect(controls.snapshot()).toMatchObject({ currentPage: 5, totalPages: 5 });
  });

  it('forwards only supported whole zoom percentages and keeps zoom state event-derived', () => {
    let onZoom: ((event: { documentId: string; newZoom: number }) => void) | undefined;
    const zoom = {
      getState: () => ({ zoomLevel: 'fit-width', currentZoomLevel: 1.1 }),
      zoomOut: vi.fn(),
      zoomIn: vi.fn(),
      requestZoom: vi.fn(),
    };
    const registry = {
      getStore: () => ({ getState: () => ({ core: { activeDocumentId: 'doc' } }) }),
      getPlugin: (id: string) => id === ZoomPlugin.id
        ? { provides: () => ({
            forDocument: () => zoom,
            onZoomChange: (listener: typeof onZoom) => {
              onZoom = listener;
              return () => undefined;
            },
          }) }
        : undefined,
    } as unknown as PluginRegistry;

    const controls = createViewerControls(registry);
    expect(controls.snapshot()).toMatchObject({ zoomReady: true, zoomPercent: 110 });

    for (const invalidZoom of [
      0,
      19,
      20.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      6001,
    ]) {
      controls.zoomToPercent(invalidZoom);
    }
    expect(zoom.requestZoom).not.toHaveBeenCalled();

    controls.zoomToPercent(20);
    controls.zoomToPercent(125);
    controls.zoomToPercent(6000);
    expect(zoom.requestZoom.mock.calls).toEqual([[0.2], [1.25], [60]]);
    expect(controls.snapshot()).toMatchObject({ zoomPercent: 110 });

    expect(controls.freezeCurrentZoom()).toBe(true);
    expect(zoom.requestZoom).toHaveBeenLastCalledWith(1.1);

    onZoom?.({ documentId: 'doc', newZoom: 1.25 });
    expect(controls.snapshot()).toMatchObject({ zoomPercent: 125 });
  });

  it('stays inert and explains unavailability when the document or capabilities are missing', () => {
    const registry = {
      getStore: () => ({ getState: () => ({ core: { activeDocumentId: null } }) }),
      getPlugin: () => undefined,
    } as unknown as PluginRegistry;
    const controls = createViewerControls(registry);
    const listener = vi.fn();

    controls.subscribe(listener);
    controls.previousPage();
    controls.nextPage();
    controls.goToPage(1);
    controls.zoomOut();
    controls.zoomIn();
    controls.zoomToPercent(125);
    expect(controls.freezeCurrentZoom()).toBe(false);

    expect(controls.snapshot()).toMatchObject({ ready: false, currentPage: 0, totalPages: 0 });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'readiness',
      ready: false,
      reason: expect.stringContaining('PDF is ready'),
    }));
  });

  it('leaves an already numeric restored or user zoom untouched', () => {
    const zoom = {
      getState: () => ({ zoomLevel: 1.25, currentZoomLevel: 1.25 }),
      requestZoom: vi.fn(),
    };
    const registry = {
      getStore: () => ({ getState: () => ({ core: { activeDocumentId: 'doc' } }) }),
      getPlugin: (id: string) => id === ZoomPlugin.id
        ? { provides: () => ({
            forDocument: () => zoom,
            onZoomChange: () => () => undefined,
          }) }
        : undefined,
    } as unknown as PluginRegistry;

    expect(createViewerControls(registry).freezeCurrentZoom()).toBe(true);
    expect(zoom.requestZoom).not.toHaveBeenCalled();
  });

  it('keeps page controls available when only zoom is unavailable', () => {
    const scroll = {
      getCurrentPage: () => 4,
      getTotalPages: () => 9,
      scrollToPreviousPage: vi.fn(),
      scrollToNextPage: vi.fn(),
      onScroll: vi.fn(() => () => undefined),
    };
    const registry = {
      getStore: () => ({ getState: () => ({ core: { activeDocumentId: 'doc' } }) }),
      getPlugin: (id: string) => id === ScrollPlugin.id
        ? { provides: () => ({
            forDocument: () => scroll,
            onPageChange: () => () => undefined,
          }) }
        : undefined,
    } as unknown as PluginRegistry;

    const controls = createViewerControls(registry);
    expect(controls.snapshot()).toMatchObject({
      pageReady: true,
      zoomReady: false,
      currentPage: 4,
      totalPages: 9,
    });

    controls.previousPage();
    expect(scroll.scrollToPreviousPage).toHaveBeenCalledWith('smooth');
  });

  it('uses the loaded document page count while scroll layout is still initializing', () => {
    const scroll = {
      getCurrentPage: () => 1,
      getTotalPages: () => 0,
      scrollToPreviousPage: vi.fn(),
      scrollToNextPage: vi.fn(),
      onScroll: vi.fn(() => () => undefined),
    };
    const registry = {
      getStore: () => ({
        getState: () => ({
          core: {
            activeDocumentId: 'doc',
            documents: { doc: { document: { pages: [{ index: 0 }, { index: 1 }] } } },
          },
        }),
      }),
      getPlugin: (id: string) => id === ScrollPlugin.id
        ? { provides: () => ({
            forDocument: () => scroll,
            onPageChange: () => () => undefined,
          }) }
        : undefined,
    } as unknown as PluginRegistry;

    expect(createViewerControls(registry).snapshot()).toMatchObject({
      pageReady: true,
      currentPage: 1,
      totalPages: 2,
    });
  });
});
