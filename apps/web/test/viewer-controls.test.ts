import type { PluginRegistry } from '@embedpdf/core';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';
import { ZoomPlugin } from '@embedpdf/plugin-zoom';
import { describe, expect, it, vi } from 'vitest';

import { createViewerControls } from '../src/pdf/viewer-controls.js';

describe('viewer controls adapter', () => {
  it('reads public page and zoom capabilities and forwards actions for the active document', () => {
    let onPage: ((event: { documentId: string; pageNumber: number; totalPages: number }) => void) | undefined;
    let onZoom: ((event: { documentId: string; newZoom: number }) => void) | undefined;
    const unsubscribePage = vi.fn();
    const unsubscribeScroll = vi.fn();
    const unsubscribeZoom = vi.fn();
    const scroll = {
      getCurrentPage: () => 2,
      getTotalPages: () => 8,
      scrollToPreviousPage: vi.fn(),
      scrollToNextPage: vi.fn(),
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
    controls.zoomOut();
    controls.zoomIn();
    expect(scroll.scrollToPreviousPage).toHaveBeenCalledWith('smooth');
    expect(scroll.scrollToNextPage).toHaveBeenCalledWith('smooth');
    expect(zoom.zoomOut).toHaveBeenCalledOnce();
    expect(zoom.zoomIn).toHaveBeenCalledOnce();

    onPage?.({ documentId: 'doc', pageNumber: 3, totalPages: 8 });
    onZoom?.({ documentId: 'doc', newZoom: 1.5 });
    expect(controls.snapshot()).toMatchObject({ currentPage: 3, totalPages: 8, zoomPercent: 150 });

    controls.dispose();
    expect(unsubscribePage).toHaveBeenCalledOnce();
    expect(unsubscribeScroll).toHaveBeenCalledOnce();
    expect(unsubscribeZoom).toHaveBeenCalledOnce();
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
    controls.zoomOut();
    controls.zoomIn();

    expect(controls.snapshot()).toMatchObject({ ready: false, currentPage: 0, totalPages: 0 });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'readiness',
      ready: false,
      reason: expect.stringContaining('PDF is ready'),
    }));
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
});
