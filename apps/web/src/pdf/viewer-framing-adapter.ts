import type { PluginRegistry } from '@embedpdf/core';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';
import { ViewportPlugin } from '@embedpdf/plugin-viewport';
import { ZoomPlugin } from '@embedpdf/plugin-zoom';

import {
  unionViewerRects,
  type ViewerFramingControls,
  type ViewerFramingEvent,
  type ViewerFramingSnapshot,
  type ViewerFramingTarget,
  type ViewerRect,
  type ViewerRunway,
} from './viewer-framing.js';

export interface ViewerFramingAdapterOptions {
  readonly registry: PluginRegistry;
  readonly root: () => HTMLElement | null;
  readonly updateRunway: (runway: ViewerRunway) => void;
  readonly nextFrame?: () => Promise<void>;
}

function elementRect(element: Element | null): ViewerRect | undefined {
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function defaultNextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function createViewerFramingControls(
  options: ViewerFramingAdapterOptions,
): ViewerFramingControls {
  const core = options.registry.getStore().getState().core;
  const documentId = core.activeDocumentId;
  const viewportCapability = options.registry
    .getPlugin<ViewportPlugin>(ViewportPlugin.id)
    ?.provides();
  const scrollCapability = options.registry
    .getPlugin<ScrollPlugin>(ScrollPlugin.id)
    ?.provides();
  const zoomCapability = options.registry
    .getPlugin<ZoomPlugin>(ZoomPlugin.id)
    ?.provides();
  const viewport = documentId && viewportCapability
    ? viewportCapability.forDocument(documentId)
    : null;
  const scroll = documentId && scrollCapability
    ? scrollCapability.forDocument(documentId)
    : null;
  const zoom = documentId && zoomCapability
    ? zoomCapability.forDocument(documentId)
    : null;
  const listeners = new Set<(event: ViewerFramingEvent) => void>();
  const subscriptions: Array<() => void> = [];
  const nextFrame = options.nextFrame ?? defaultNextFrame;
  let disposed = false;

  const emit = (event: ViewerFramingEvent) => {
    if (disposed) return;
    for (const listener of listeners) listener(event);
  };

  if (zoom) {
    subscriptions.push(zoom.onZoomChange(() => emit({ type: 'zoom' })));
  }

  const snapshot = (target?: ViewerFramingTarget): ViewerFramingSnapshot => {
    const root = options.root();
    const metrics = viewport?.getMetrics();
    const currentPage = scroll?.getCurrentPage() ?? 0;
    const targetPage = target?.pageIndex ?? Math.max(0, currentPage - 1);
    const viewportElement = root?.querySelector<HTMLElement>('[data-viewer-framing-viewport]') ?? null;
    const pageElement = root?.querySelector<HTMLElement>(`[data-page-index="${targetPage}"]`) ?? null;
    const targetElements = target?.reviewId && root
      ? Array.from(root.querySelectorAll<HTMLElement>('[data-owned-mark][data-review-id]'))
        .filter((element) => element.dataset.reviewId === target.reviewId)
      : [];
    const targetRect = unionViewerRects(targetElements
      .map((element) => elementRect(element))
      .filter((rect): rect is ViewerRect => rect !== undefined));
    const viewportRect = elementRect(viewportElement);
    const pageRect = elementRect(pageElement);

    return {
      ready: !disposed
        && documentId !== null
        && viewport !== null
        && scroll !== null
        && zoom !== null
        && viewportElement !== null,
      ...(documentId === null ? {} : { documentId }),
      ...(viewportRect === undefined ? {} : { viewport: viewportRect }),
      ...(pageRect === undefined ? {} : { page: pageRect }),
      ...(targetRect === null ? {} : { target: targetRect }),
      scroll: {
        left: viewportElement?.scrollLeft ?? metrics?.scrollLeft ?? 0,
        top: viewportElement?.scrollTop ?? metrics?.scrollTop ?? 0,
      },
      maximum: {
        left: Math.max(
          0,
          (viewportElement?.scrollWidth ?? metrics?.scrollWidth ?? 0)
            - (viewportElement?.clientWidth ?? metrics?.clientWidth ?? 0),
        ),
        top: Math.max(
          0,
          (viewportElement?.scrollHeight ?? metrics?.scrollHeight ?? 0)
            - (viewportElement?.clientHeight ?? metrics?.clientHeight ?? 0),
        ),
      },
    };
  };

  return {
    snapshot,
    async setRunway(runway) {
      if (disposed) return snapshot();
      options.updateRunway({
        right: Math.max(0, runway.right),
        bottom: Math.max(0, runway.bottom),
      });
      await nextFrame();
      await nextFrame();
      return snapshot();
    },
    scrollTo(position, behavior = 'auto') {
      if (disposed) return;
      viewport?.scrollTo({ x: position.left, y: position.top, behavior });
      if (behavior !== 'auto') return;
      const viewportElement = options.root()
        ?.querySelector<HTMLElement>('[data-viewer-framing-viewport]') ?? null;
      if (viewportElement) {
        // The EmbedPDF viewport request can remain a no-op for an inactive
        // WebKit layout turn, and a same-position native write is required to
        // cancel an earlier smooth scroll before user-owned movement begins.
        // The DOM viewport is the same authority observed by the plugin.
        viewportElement.scrollLeft = position.left;
        viewportElement.scrollTop = position.top;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
      listeners.clear();
      options.updateRunway({ right: 0, bottom: 0 });
    },
  };
}
