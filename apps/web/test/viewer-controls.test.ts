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

  it('reports the unobscured reading page and uses it for adjacent jumps', async () => {
    let readingPage: number | null = 2;
    const scroll = {
      getCurrentPage: () => 3, getTotalPages: () => 4,
      onScroll: () => () => undefined,
    };
    const registry = {
      getStore: () => ({ getState: () => ({ core: { activeDocumentId: 'doc' } }) }),
      getPlugin: (id: string) => id === ScrollPlugin.id ? { provides: () => ({
        forDocument: () => scroll, onPageChange: () => () => undefined,
      }) } : undefined,
    } as unknown as PluginRegistry;
    const jump = vi.fn(() => Promise.resolve(true));
    const controls = createViewerControls(registry, {
      currentReadingPage: () => readingPage, jumpToPage: jump,
    });
    expect(controls.snapshot().currentPage).toBe(2);
    controls.nextPage();
    expect(jump).toHaveBeenLastCalledWith(3);
    await Promise.resolve();
    readingPage = 1;
    expect(controls.snapshot().currentPage).toBe(1);
    controls.previousPage();
    expect(jump).toHaveBeenCalledTimes(1);
    readingPage = null;
    expect(controls.snapshot().currentPage).toBe(3);
    readingPage = 5;
    expect(controls.snapshot().currentPage).toBe(3);
    controls.dispose();
  });

  it('validates the reading page against the page count reported by the new layout', () => {
    let onLayout: ((event: { documentId: string; pageNumber: number; totalPages: number }) => void) | undefined;
    const registry = {
      getStore: () => ({ getState: () => ({ core: { activeDocumentId: 'doc' } }) }),
      getPlugin: (id: string) => id === ScrollPlugin.id ? { provides: () => ({
        forDocument: () => ({ getCurrentPage: () => 1, getTotalPages: () => 4, onScroll: () => () => undefined }),
        onPageChange: () => () => undefined,
        onLayoutReady: (listener: typeof onLayout) => { onLayout = listener; return () => undefined; },
      }) } : undefined,
    } as unknown as PluginRegistry;
    const controls = createViewerControls(registry, { currentReadingPage: () => 3 });
    const listener = vi.fn();
    controls.subscribe(listener);
    onLayout?.({ documentId: 'doc', pageNumber: 1, totalPages: 2 });
    expect(listener).toHaveBeenLastCalledWith({ type: 'page', currentPage: 1, totalPages: 2 });
    expect(controls.snapshot().currentPage).toBe(1);
    controls.dispose();
  });

  it('refreshes page reporting after a virtualized destination mounts and cancels disposed work', () => {
    let readingPage = 1;
    let mountedViewport: HTMLElement | null = null;
    let onPage: ((event: { documentId: string; pageNumber: number; totalPages: number }) => void) | undefined;
    let onMount: (() => void) | undefined;
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: () => void) { onMount = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const paint = () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(0));
    };
    try {
      const scroll = { getCurrentPage: () => 1, getTotalPages: () => 20, onScroll: () => () => undefined };
      const registry = {
        getStore: () => ({ getState: () => ({ core: { activeDocumentId: 'doc' } }) }),
        getPlugin: (id: string) => id === ScrollPlugin.id ? { provides: () => ({
          forDocument: () => scroll,
          onPageChange: (listener: typeof onPage) => { onPage = listener; return () => undefined; },
        }) } : undefined,
      } as unknown as PluginRegistry;
      const controls = createViewerControls(registry, {
        currentReadingPage: () => readingPage, viewport: () => mountedViewport,
      });
      const listener = vi.fn();
      controls.subscribe(listener);
      onPage?.({ documentId: 'doc', pageNumber: 18, totalPages: 20 });
      mountedViewport = {} as HTMLElement;
      paint();
      expect(observe).toHaveBeenCalledWith(mountedViewport, { childList: true, subtree: true }); // The destination has not mounted yet.
      expect(controls.snapshot().currentPage).toBe(1);
      readingPage = 18;
      onMount?.();
      onMount?.();
      expect(frames.size).toBe(1);
      paint();
      expect(listener).toHaveBeenLastCalledWith({ type: 'page', currentPage: 18, totalPages: 20 });
      expect(controls.snapshot().currentPage).toBe(18);
      const notifications = listener.mock.calls.length;
      onMount?.();
      paint();
      expect(listener).toHaveBeenCalledTimes(notifications);
      readingPage = 19;
      onMount?.();
      controls.dispose();
      expect(disconnect).toHaveBeenCalledOnce();
      expect(frames.size).toBe(0);
      paint();
      expect(listener).toHaveBeenCalledTimes(notifications);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['dispose during publication', 'geometry returns to cached page'] as const)(
    'handles %s before the deferred page refresh', (scenario) => {
      let readingPage = 1;
      let onScroll: (() => void) | undefined;
      const frames = new Map<number, FrameRequestCallback>();
      let frameId = 0;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.set(++frameId, callback);
        return frameId;
      });
      vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
      try {
        const scroll = {
          getCurrentPage: () => 1, getTotalPages: () => 20,
          onScroll: (listener: () => void) => { onScroll = listener; return () => undefined; },
        };
        const registry = {
          getStore: () => ({ getState: () => ({ core: { activeDocumentId: 'doc' } }) }),
          getPlugin: (id: string) => id === ScrollPlugin.id ? { provides: () => ({
            forDocument: () => scroll, onPageChange: () => () => undefined,
          }) } : undefined,
        } as unknown as PluginRegistry;
        const controls = createViewerControls(registry, { currentReadingPage: () => readingPage });
        const pageEvents = vi.fn();
        controls.subscribe(event => {
          if (event.type === 'page') pageEvents(event.currentPage);
          if (event.type !== 'scroll') return;
          if (scenario === 'dispose during publication') controls.dispose();
          else expect(controls.snapshot().currentPage).toBe(2);
        });
        readingPage = 2;
        onScroll?.();
        if (scenario === 'dispose during publication') {
          expect(frames.size).toBe(0);
        } else {
          expect(frames.size).toBe(1);
          readingPage = 1;
          const pending = [...frames.values()];
          frames.clear();
          pending.forEach(callback => callback(0));
          expect(pageEvents).toHaveBeenCalledExactlyOnceWith(1);
          controls.dispose();
        }
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it('routes page buttons and entry through the shared jump handler when available', async () => {
    const scroll = {
      getCurrentPage: () => 2, getTotalPages: () => 3,
      scrollToPreviousPage: vi.fn(), scrollToNextPage: vi.fn(), scrollToPage: vi.fn(),
      onScroll: () => () => undefined,
    };
    const registry = {
      getStore: () => ({ getState: () => ({ core: { activeDocumentId: 'doc' } }) }),
      getPlugin: (id: string) => id === ScrollPlugin.id ? { provides: () => ({
        forDocument: () => scroll, onPageChange: () => () => undefined,
      }) } : undefined,
    } as unknown as PluginRegistry;
    const jump = vi.fn<() => Promise<boolean> | false>(() => Promise.resolve(true));
    const controls = createViewerControls(registry, { jumpToPage: jump });
    controls.previousPage();
    await Promise.resolve();
    controls.nextPage();
    await Promise.resolve();
    controls.goToPage(1);
    await Promise.resolve();
    controls.goToPage(0);
    controls.goToPage(4);
    expect(jump.mock.calls).toEqual([[1], [3], [1]]);
    expect(scroll.scrollToPage).not.toHaveBeenCalled();
    expect(scroll.scrollToPreviousPage).not.toHaveBeenCalled();
    expect(scroll.scrollToNextPage).not.toHaveBeenCalled();
    const settle: Array<(applied: boolean) => void> = [];
    jump.mockImplementation(() => new Promise<boolean>((resolve) => settle.push(resolve)));
    jump.mockClear();
    controls.goToPage(1);
    controls.nextPage();
    controls.nextPage();
    expect(jump.mock.calls).toEqual([[1], [2], [3]]);
    settle[0]!(false);
    await Promise.resolve();
    controls.nextPage();
    expect(jump).toHaveBeenCalledTimes(3);
    settle[2]!(true);
    await Promise.resolve();
    jump.mockReturnValue(false);
    controls.goToPage(3);
    expect(scroll.scrollToPage).toHaveBeenCalledWith({ pageNumber: 3, behavior: 'smooth' });
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
    let onZoom: ((event: { documentId: string; oldZoom: number; newZoom: number }) => void) | undefined;
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

    const onManualZoom = vi.fn();
    const controls = createViewerControls(registry, { onManualZoom });
    const listener = vi.fn();
    controls.subscribe(listener);
    listener.mockClear();
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
    expect(onManualZoom).not.toHaveBeenCalled();

    controls.zoomToPercent(20);
    controls.zoomToPercent(125);
    controls.zoomToPercent(6000);
    expect(zoom.requestZoom.mock.calls).toEqual([[0.2], [1.25], [60]]);
    expect(controls.snapshot()).toMatchObject({ zoomPercent: 110 });
    expect(listener).not.toHaveBeenCalled();
    controls.zoomToPercent(110);
    expect(onManualZoom).toHaveBeenCalledTimes(4);

    expect(controls.usesAutomaticFitWidth()).toBe(true);
    expect(controls.freezeCurrentZoom()).toBe(true);
    expect(zoom.requestZoom).toHaveBeenLastCalledWith(1.1);

    onZoom?.({ documentId: 'doc', oldZoom: 1.1, newZoom: 1.25 });
    expect(controls.snapshot()).toMatchObject({ zoomPercent: 125 });
    expect(listener).toHaveBeenLastCalledWith({ type: 'zoom', zoomPercent: 125, oldZoom: 1.1, newZoom: 1.25 });
    onZoom?.({ documentId: 'doc', oldZoom: 1.25, newZoom: 1.25001 });
    expect(listener).toHaveBeenLastCalledWith({ type: 'zoom', zoomPercent: 125, oldZoom: 1.25, newZoom: 1.25001 });
    listener.mockClear();
    onZoom?.({ documentId: 'reference', oldZoom: 1, newZoom: 2 });
    expect(listener).not.toHaveBeenCalled();
    onZoom?.({ documentId: 'doc', oldZoom: 1.25001, newZoom: 1.25001 });
    expect(listener).toHaveBeenLastCalledWith({ type: 'zoom', zoomPercent: 125, oldZoom: 1.25001, newZoom: 1.25001 });
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
    expect(controls.usesAutomaticFitWidth()).toBe(false);
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

    const controls = createViewerControls(registry);
    expect(controls.usesAutomaticFitWidth()).toBe(false);
    expect(controls.freezeCurrentZoom()).toBe(true);
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
