import type { PluginRegistry } from '@embedpdf/core';
import {
  PdfZoomMode,
  Rotation,
  restorePosition,
  transformPosition,
  transformSize,
  type PdfPageObject,
} from '@embedpdf/models';
import { ScrollPlugin, type ScrollScope } from '@embedpdf/plugin-scroll';
import { ViewportPlugin, type ViewportScope } from '@embedpdf/plugin-viewport';
import { ZoomPlugin, type ZoomScope } from '@embedpdf/plugin-zoom';

import type { PdfNavigationTarget } from './pdf-navigation-target.js';
import { combinePageRotation } from './owned-overlay.js';
import { intersectViewerRects, type ViewerRunway } from './viewer-framing.js';
import {
  isPdfViewerLocation,
  pdfBottomOriginPointToNaturalAnchor,
  type PdfNaturalPageSize,
  type PdfNaturalPoint,
  type PdfViewerLocation,
  type ViewerNavigationControls,
} from './viewer-navigation.js';

export interface PdfTargetLocationContext {
  readonly page: PdfNaturalPageSize & { readonly cropOrigin?: PdfNaturalPoint };
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly gap?: number;
  };
  readonly currentZoom: number;
  readonly rotation?: Rotation;
}

export interface ViewerNavigationAdapterOptions {
  readonly registry: PluginRegistry;
  readonly root: () => HTMLElement | null;
  /** Stable EmbedPDF document scope; it need not be the globally active document. */
  readonly documentId: string;
  readonly documentGeneration: number;
  /** Live right/bottom area covered by trays in this viewer's DOM viewport. */
  readonly runway?: () => ViewerRunway;
  readonly timeoutMs?: number;
  readonly coordinateTolerancePixels?: number;
  readonly zoomTolerance?: number;
  readonly nextFrame?: () => Promise<void>;
}

export interface PdfViewerNavigation extends ViewerNavigationControls {
  /** Resolves a semantic target without moving the viewer. */
  resolveTarget(target: PdfNavigationTarget): PdfViewerLocation | null;
  applyTarget(target: PdfNavigationTarget): Promise<boolean>;
  /** Aborts any in-flight movement without disposing the document scope. */
  cancelPendingNavigation(): void;
}

interface ActiveViewer {
  readonly documentId: string;
  readonly documentGeneration: number;
  readonly document: object;
  readonly pages: readonly PdfPageObject[];
  readonly documentRotation: Rotation;
  readonly scroll: ScrollScope;
  readonly viewport: ViewportScope;
  readonly zoom: ZoomScope;
  readonly viewportGap: number;
}

interface NavigationOperation {
  readonly generation: number;
  readonly documentGeneration: number;
  readonly documentId: string;
  readonly document: object;
  readonly signal: AbortSignal;
  readonly origin: PdfViewerLocation | null;
  mutated: boolean;
}

interface EffectiveViewportRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_COORDINATE_TOLERANCE_PIXELS = 1.5;
const DEFAULT_ZOOM_TOLERANCE = 0.002;

function defaultNextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function validDimension(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function numericParams(target: PdfNavigationTarget, count: number): readonly number[] | null {
  if (target.zoom.params.length !== count) return null;
  return target.zoom.params.every(Number.isFinite) ? target.zoom.params : null;
}

/** Maps a classified target into the same neutral location shape used for history and tab state. */
export function createPdfTargetLocation(
  target: PdfNavigationTarget,
  context: PdfTargetLocationContext,
): PdfViewerLocation | null {
  const { page, viewport, currentZoom } = context;
  const gap = viewport.gap ?? 0;
  if (
    !validDimension(page.width)
    || !validDimension(page.height)
    || !validDimension(viewport.width)
    || !validDimension(viewport.height)
    || !Number.isFinite(gap)
    || gap < 0
    || !validDimension(currentZoom)
  ) return null;

  const rotation = context.rotation ?? Rotation.Degree0;
  const rotatedPage = transformSize(page, rotation, 1);
  const availableWidth = viewport.width - 2 * gap;
  const availableHeight = viewport.height - 2 * gap;
  if (!validDimension(availableWidth) || !validDimension(availableHeight)) return null;
  const fitWidth = availableWidth / rotatedPage.width;
  const fitHeight = availableHeight / rotatedPage.height;
  const center = { x: page.width / 2, y: page.height / 2 };
  const cropOrigin = page.cropOrigin ?? { x: 0, y: 0 };

  switch (target.zoom.mode) {
    case PdfZoomMode.Unknown:
      return {
        pageIndex: target.pageIndex,
        anchor: { x: 0, y: 0 },
        alignment: { xPercent: 0, yPercent: 0 },
        zoom: currentZoom,
      };
    case PdfZoomMode.XYZ: {
      const params = numericParams(target, 3);
      if (!params) return null;
      const [x, pdfY, requestedZoom] = params;
      if (x === undefined || pdfY === undefined || requestedZoom === undefined || requestedZoom < 0) {
        return null;
      }
      return {
        pageIndex: target.pageIndex,
        anchor: pdfBottomOriginPointToNaturalAnchor({ x, y: pdfY }, page, cropOrigin),
        alignment: { xPercent: 0, yPercent: 0 },
        zoom: requestedZoom === 0 ? currentZoom : requestedZoom,
      };
    }
    case PdfZoomMode.FitPage:
    case PdfZoomMode.FitBoundingBox:
      return {
        pageIndex: target.pageIndex,
        anchor: center,
        alignment: { xPercent: 50, yPercent: 50 },
        zoom: Math.min(fitWidth, fitHeight),
      };
    case PdfZoomMode.FitHorizontal:
    case PdfZoomMode.FitBoundingBoxHorizontal: {
      const params = numericParams(target, 1);
      if (!params || params[0] === undefined) return null;
      return {
        pageIndex: target.pageIndex,
        anchor: pdfBottomOriginPointToNaturalAnchor(
          { x: center.x + cropOrigin.x, y: params[0] },
          page,
          cropOrigin,
        ),
        alignment: { xPercent: 50, yPercent: 0 },
        zoom: fitWidth,
      };
    }
    case PdfZoomMode.FitVertical:
    case PdfZoomMode.FitBoundingBoxVertical: {
      const params = numericParams(target, 1);
      if (!params || params[0] === undefined) return null;
      return {
        pageIndex: target.pageIndex,
        anchor: { x: params[0] - cropOrigin.x, y: center.y },
        alignment: { xPercent: 0, yPercent: 50 },
        zoom: fitHeight,
      };
    }
    case PdfZoomMode.FitRectangle: {
      const params = numericParams(target, 4);
      if (!params) return null;
      const [left, bottom, right, top] = params;
      if (left === undefined || bottom === undefined || right === undefined || top === undefined) {
        return null;
      }
      const naturalLeft = left - cropOrigin.x;
      const naturalRight = right - cropOrigin.x;
      const naturalTop = page.height - (top - cropOrigin.y);
      const naturalBottom = page.height - (bottom - cropOrigin.y);
      const width = naturalRight - naturalLeft;
      const height = naturalBottom - naturalTop;
      if (!validDimension(width) || !validDimension(height)) return null;
      const rotatedRect = transformSize({ width, height }, rotation, 1);
      return {
        pageIndex: target.pageIndex,
        anchor: { x: naturalLeft + width / 2, y: naturalTop + height / 2 },
        alignment: { xPercent: 50, yPercent: 50 },
        zoom: Math.min(
          availableWidth / rotatedRect.width,
          availableHeight / rotatedRect.height,
        ),
      };
    }
    default:
      return null;
  }
}

function pageSelector(pageIndex: number): string {
  return `[data-page-index="${pageIndex}"]`;
}

export function focusViewerDestination(root: HTMLElement | null, pageIndex: number): boolean {
  if (!root || !Number.isSafeInteger(pageIndex) || pageIndex < 0) return false;
  const page = root.querySelector<HTMLElement>(pageSelector(pageIndex));
  if (!page) return false;
  page.focus({ preventScroll: true });
  return true;
}

function waitForPromise(
  promise: Promise<unknown>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<boolean> {
  if (signal.aborted || timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(() => finish(true), () => finish(false));
  });
}

function waitForZoom(
  zoom: ZoomScope,
  requestedZoom: number,
  tolerance: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<boolean> {
  if (signal.aborted || timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribeZoom: () => void = () => undefined;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      unsubscribeZoom();
      resolve(result);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    unsubscribeZoom = zoom.onZoomChange((event) => {
      if (Math.abs(event.newZoom - requestedZoom) <= tolerance) finish(true);
    });
    try {
      zoom.requestZoom(requestedZoom);
    } catch {
      finish(false);
    }
  });
}

export function createViewerNavigation(
  options: ViewerNavigationAdapterOptions,
): PdfViewerNavigation {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const coordinateTolerance = options.coordinateTolerancePixels
    ?? DEFAULT_COORDINATE_TOLERANCE_PIXELS;
  const zoomTolerance = options.zoomTolerance ?? DEFAULT_ZOOM_TOLERANCE;
  const nextFrame = options.nextFrame ?? defaultNextFrame;
  let documentGeneration = options.documentGeneration;
  let operationGeneration = 0;
  let activeOperation: { operation: NavigationOperation; abort: AbortController } | null = null;
  let rollbackBarrier: Promise<void> | null = null;
  let disposed = false;

  const cancelPendingNavigation = () => {
    const cancelled = activeOperation;
    cancelled?.abort.abort();
    activeOperation = null;
    operationGeneration += 1;
    if (cancelled?.operation.mutated && cancelled.operation.origin !== null) {
      rollbackBarrier = (rollbackBarrier ?? Promise.resolve()).then(
        () => rollbackOperation(cancelled.operation),
        () => rollbackOperation(cancelled.operation),
      );
    }
  };

  const activeViewer = (): ActiveViewer | null => {
    if (disposed) return null;
    const core = options.registry.getStore().getState().core;
    const documentId = options.documentId;
    const documentState = core.documents[documentId];
    const document = documentState?.document;
    if (!documentId || !document || !Number.isSafeInteger(documentGeneration) || documentGeneration < 0) {
      return null;
    }
    const scrollCapability = options.registry.getPlugin<ScrollPlugin>(ScrollPlugin.id)?.provides();
    const viewportCapability = options.registry
      .getPlugin<ViewportPlugin>(ViewportPlugin.id)
      ?.provides();
    const zoomCapability = options.registry.getPlugin<ZoomPlugin>(ZoomPlugin.id)?.provides();
    if (!scrollCapability || !viewportCapability || !zoomCapability) return null;
    try {
      return {
        documentId,
        documentGeneration,
        document,
        pages: document.pages,
        documentRotation: documentState.rotation,
        scroll: scrollCapability.forDocument(documentId),
        viewport: viewportCapability.forDocument(documentId),
        zoom: zoomCapability.forDocument(documentId),
        viewportGap: viewportCapability.getViewportGap(),
      };
    } catch {
      return null;
    }
  };

  const beginOperation = async (viewer: ActiveViewer): Promise<NavigationOperation | null> => {
    cancelPendingNavigation();
    const precedingRollback = rollbackBarrier;
    if (precedingRollback !== null) {
      await precedingRollback;
      if (rollbackBarrier === precedingRollback) rollbackBarrier = null;
    }
    if (!viewerStillOwnsDocument(viewer)) return null;
    const abort = new AbortController();
    const operation = {
      generation: operationGeneration,
      documentGeneration: viewer.documentGeneration,
      documentId: viewer.documentId,
      document: viewer.document,
      signal: abort.signal,
      origin: captureLocation(),
      mutated: false,
    };
    activeOperation = { operation, abort };
    return operation;
  };

  const operationIsCurrent = (operation: NavigationOperation): boolean => {
    if (
      disposed
      || operation.signal.aborted
      || operation.generation !== operationGeneration
      || operation.documentGeneration !== documentGeneration
      || activeOperation?.operation !== operation
    ) return false;
    const core = options.registry.getStore().getState().core;
    return core.documents[operation.documentId]?.document === operation.document;
  };

  const viewerStillOwnsDocument = (viewer: ActiveViewer): boolean => {
    if (disposed || viewer.documentGeneration !== documentGeneration) return false;
    const core = options.registry.getStore().getState().core;
    return core.documents[viewer.documentId]?.document === viewer.document;
  };

  const currentRunway = (): ViewerRunway => {
    try {
      const runway = options.runway?.() ?? { right: 0, bottom: 0 };
      return {
        right: Number.isFinite(runway.right) ? Math.max(0, runway.right) : 0,
        bottom: Number.isFinite(runway.bottom) ? Math.max(0, runway.bottom) : 0,
      };
    } catch {
      return { right: 0, bottom: 0 };
    }
  };

  const effectiveViewportRect = (viewportRect: DOMRect): EffectiveViewportRect => {
    const runway = currentRunway();
    const right = Math.max(viewportRect.left, viewportRect.right - runway.right);
    const bottom = Math.max(viewportRect.top, viewportRect.bottom - runway.bottom);
    const width = right - viewportRect.left;
    const height = bottom - viewportRect.top;
    return {
      left: viewportRect.left,
      top: viewportRect.top,
      right,
      bottom,
      width,
      height,
    };
  };

  const scrollAlignment = (location: PdfViewerLocation) => {
    const root = options.root();
    const viewportElement = root?.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
    if (!viewportElement) return location.alignment;
    const fullViewport = viewportElement.getBoundingClientRect();
    const effectiveViewport = effectiveViewportRect(fullViewport);
    if (!validDimension(fullViewport.width) || !validDimension(fullViewport.height)) {
      return location.alignment;
    }
    return {
      xPercent: effectiveViewport.width / fullViewport.width * location.alignment.xPercent,
      yPercent: effectiveViewport.height / fullViewport.height * location.alignment.yPercent,
    };
  };

  const pageGeometry = (
    viewer: ActiveViewer,
    pageIndex: number,
    measured?: { readonly viewportRect: EffectiveViewportRect; readonly pageRect: DOMRect },
  ) => {
    const page = viewer.pages[pageIndex];
    const root = options.root();
    const viewportElement = root?.querySelector<HTMLElement>('[data-viewer-framing-viewport]') ?? null;
    const pageElement = root?.querySelector<HTMLElement>(pageSelector(pageIndex)) ?? null;
    if (!page || !viewportElement || !pageElement) return null;
    const viewportRect = measured?.viewportRect
      ?? effectiveViewportRect(viewportElement.getBoundingClientRect());
    const pageRect = measured?.pageRect ?? pageElement.getBoundingClientRect();
    const rotation = combinePageRotation(page.rotation, viewer.documentRotation);
    const rotatedPage = transformSize(page.size, rotation, 1);
    const scale = pageRect.width / rotatedPage.width;
    if (
      !validDimension(viewportRect.width)
      || !validDimension(viewportRect.height)
      || !validDimension(pageRect.width)
      || !validDimension(pageRect.height)
      || !validDimension(scale)
    ) return null;
    return { page, viewportRect, pageRect, rotation, scale };
  };

  const hasUsablePageTree = (viewer: ActiveViewer): boolean => {
    if (viewer.pages.length === 0) return false;
    const root = options.root();
    const viewport = root?.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
    const page = root?.querySelector<HTMLElement>('[data-page-index]');
    if (!viewport || !page) return false;
    const viewportRect = effectiveViewportRect(viewport.getBoundingClientRect());
    const pageRect = page.getBoundingClientRect();
    return validDimension(viewportRect.width)
      && validDimension(viewportRect.height)
      && validDimension(pageRect.width)
      && validDimension(pageRect.height);
  };

  const mostVisibleMountedPageIndex = (viewer: ActiveViewer): {
    readonly pageIndex: number;
    readonly viewportRect: EffectiveViewportRect;
    readonly pageRect: DOMRect;
  } | null => {
    const root = options.root();
    const viewportElement = root?.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
    if (!root || !viewportElement) return null;
    const viewportRect = effectiveViewportRect(viewportElement.getBoundingClientRect());
    let best: { readonly pageIndex: number; readonly pageRect: DOMRect } | null = null;
    let bestVisibleArea = 0;
    for (const pageElement of root.querySelectorAll<HTMLElement>('[data-page-index]')) {
      const pageIndex = Number(pageElement.getAttribute('data-page-index'));
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= viewer.pages.length) continue;
      const pageRect = pageElement.getBoundingClientRect();
      const intersection = intersectViewerRects(viewportRect, pageRect);
      const visibleArea = intersection === null
        ? 0
        : (intersection.right - intersection.left) * (intersection.bottom - intersection.top);
      if (visibleArea > bestVisibleArea) {
        bestVisibleArea = visibleArea;
        best = { pageIndex, pageRect };
      }
    }
    if (best === null) return null;
    return { ...best, viewportRect };
  };

  const captureLocation = (): PdfViewerLocation | null => {
    const viewer = activeViewer();
    if (!viewer) return null;
    let pageIndex: number;
    try {
      pageIndex = viewer.scroll.getCurrentPage() - 1;
    } catch {
      return null;
    }
    const visiblePage = mostVisibleMountedPageIndex(viewer);
    if (visiblePage !== null) pageIndex = visiblePage.pageIndex;
    const geometry = pageGeometry(viewer, pageIndex, visiblePage ?? undefined);
    if (!geometry) return null;
    const { viewportRect, pageRect, page, rotation, scale } = geometry;
    const left = Math.max(viewportRect.left, pageRect.left);
    const top = Math.max(viewportRect.top, pageRect.top);
    const right = Math.min(viewportRect.right, pageRect.right);
    const bottom = Math.min(viewportRect.bottom, pageRect.bottom);
    if (right <= left || bottom <= top) return null;
    const clientPoint = { x: (left + right) / 2, y: (top + bottom) / 2 };
    const anchor = restorePosition(
      page.size,
      { x: clientPoint.x - pageRect.left, y: clientPoint.y - pageRect.top },
      rotation,
      scale,
    );
    let zoom: number;
    try {
      zoom = viewer.zoom.getState().currentZoomLevel;
    } catch {
      return null;
    }
    const location: PdfViewerLocation = {
      pageIndex,
      anchor: {
        x: clamp(anchor.x, 0, page.size.width),
        y: clamp(anchor.y, 0, page.size.height),
      },
      alignment: {
        xPercent: clamp((clientPoint.x - viewportRect.left) / viewportRect.width * 100, 0, 100),
        yPercent: clamp((clientPoint.y - viewportRect.top) / viewportRect.height * 100, 0, 100),
      },
      zoom,
    };
    return isPdfViewerLocation(location) ? location : null;
  };

  async function rollbackOperation(operation: NavigationOperation): Promise<void> {
    const origin = operation.origin;
    const viewer = activeViewer();
    if (
      origin === null
      || viewer === null
      || viewer.documentId !== operation.documentId
      || viewer.document !== operation.document
      || !viewerStillOwnsDocument(viewer)
    ) return;
    const deadline = Date.now() + timeoutMs;
    try {
      if (Math.abs(viewer.zoom.getState().currentZoomLevel - origin.zoom) > zoomTolerance) {
        viewer.zoom.requestZoom(origin.zoom);
        while (
          viewerStillOwnsDocument(viewer)
          && Date.now() < deadline
          && Math.abs(viewer.zoom.getState().currentZoomLevel - origin.zoom) > zoomTolerance
        ) {
          if (!await waitForPromise(nextFrame(), new AbortController().signal, deadline - Date.now())) {
            return;
          }
        }
      }
      if (!viewerStillOwnsDocument(viewer) || Date.now() >= deadline) return;
      const alignment = scrollAlignment(origin);
      viewer.scroll.scrollToPage({
        pageNumber: origin.pageIndex + 1,
        pageCoordinates: origin.anchor,
        behavior: 'instant',
        alignX: alignment.xPercent,
        alignY: alignment.yPercent,
      });
      await nextFrame();
      await nextFrame();
    } catch {
      // Best-effort restoration: a replacement/disposal owns the newer state.
    }
  }

  const locationMatchesView = (
    viewer: ActiveViewer,
    location: PdfViewerLocation,
    acceptScrollBoundary = false,
  ): boolean => {
    const geometry = pageGeometry(viewer, location.pageIndex);
    if (!geometry) return false;
    const { viewportRect, pageRect, page, rotation, scale } = geometry;
    if (
      location.anchor.x > page.size.width
      || location.anchor.y > page.size.height
      || Math.abs(viewer.zoom.getState().currentZoomLevel - location.zoom) > zoomTolerance
    ) return false;
    const transformed = transformPosition(page.size, location.anchor, rotation, scale);
    const actual = {
      x: pageRect.left + transformed.x,
      y: pageRect.top + transformed.y,
    };
    const expected = {
      x: viewportRect.left + viewportRect.width * location.alignment.xPercent / 100,
      y: viewportRect.top + viewportRect.height * location.alignment.yPercent / 100,
    };
    const metrics = viewer.viewport.getMetrics();
    // A fitted page can be narrower than its viewport, leaving no horizontal
    // range in which to honor an XYZ x-coordinate. In that case the centered
    // page position is the only valid settled postcondition.
    const axisMatchesOrIsConstrained = (
      actualCoordinate: number,
      expectedCoordinate: number,
      scrollOffset: number,
      scrollExtent: number,
      clientExtent: number,
      atStartBoundary: boolean,
      atEndBoundary: boolean,
      acceptNoRange: boolean,
    ) => {
      if (Math.abs(actualCoordinate - expectedCoordinate) <= coordinateTolerance) return true;
      const maximumScroll = Math.max(0, scrollExtent - clientExtent);
      if (acceptNoRange && maximumScroll <= coordinateTolerance) return true;
      if (!acceptScrollBoundary) return false;
      if (
        atStartBoundary
        && scrollOffset <= coordinateTolerance
        && actualCoordinate < expectedCoordinate
      ) return true;
      return atEndBoundary
        && scrollOffset >= maximumScroll - coordinateTolerance
        && actualCoordinate > expectedCoordinate;
    };
    return axisMatchesOrIsConstrained(
      actual.x,
      expected.x,
      metrics.scrollLeft,
      metrics.scrollWidth,
      metrics.clientWidth,
      pageRect.left >= viewportRect.left - coordinateTolerance,
      pageRect.right <= viewportRect.right + coordinateTolerance,
      true,
    ) && axisMatchesOrIsConstrained(
      actual.y,
      expected.y,
      metrics.scrollTop,
      metrics.scrollHeight,
      metrics.clientHeight,
      location.pageIndex === 0
        && pageRect.top >= viewportRect.top - coordinateTolerance,
      location.pageIndex === viewer.pages.length - 1
        && pageRect.bottom <= viewportRect.bottom + coordinateTolerance,
      false,
    );
  };

  const waitForFrames = async (operation: NavigationOperation, count: number, deadline: number) => {
    for (let index = 0; index < count; index += 1) {
      if (!operationIsCurrent(operation)) return false;
      if (!await waitForPromise(nextFrame(), operation.signal, deadline - Date.now())) return false;
    }
    return operationIsCurrent(operation);
  };

  const scrollAndWait = async (
    viewer: ActiveViewer,
    location: PdfViewerLocation,
    operation: NavigationOperation,
    deadline: number,
  ): Promise<boolean> => {
    let resolveIdle: (value: boolean) => void = () => undefined;
    const idle = new Promise<boolean>((resolve) => { resolveIdle = resolve; });
    const unsubscribe = viewer.viewport.onScrollActivity((activity) => {
      if (!activity.isScrolling && !activity.isSmoothScrolling) resolveIdle(true);
    });
    try {
      // A newly portaled inactive viewer can expose metrics before it has any
      // mounted page tree (notably in WebKit). Wait for one page in that case,
      // while still allowing distant virtualized targets to mount after scroll.
      while (
        operationIsCurrent(operation)
        && Date.now() < deadline
        && !hasUsablePageTree(viewer)
      ) {
        if (!await waitForPromise(nextFrame(), operation.signal, deadline - Date.now())) return false;
      }
      if (!hasUsablePageTree(viewer)) return false;
      let currentPageIndex = -1;
      try {
        currentPageIndex = viewer.scroll.getCurrentPage() - 1;
      } catch {
        return false;
      }
      // Newly portaled viewers render the current/adjacent page buffer as part
      // of initialization. Let that buffer settle before its first scroll;
      // farther destinations must scroll first to expand virtualization.
      if (Math.abs(location.pageIndex - currentPageIndex) <= 1) {
        while (
          operationIsCurrent(operation)
          && Date.now() < deadline
          && pageGeometry(viewer, location.pageIndex) === null
        ) {
          if (!await waitForPromise(nextFrame(), operation.signal, deadline - Date.now())) return false;
        }
        if (pageGeometry(viewer, location.pageIndex) === null) return false;
      }
      const scrollToLocation = () => {
        const alignment = scrollAlignment(location);
        viewer.scroll.scrollToPage({
          pageNumber: location.pageIndex + 1,
          pageCoordinates: location.anchor,
          behavior: 'instant',
          alignX: alignment.xPercent,
          alignY: alignment.yPercent,
        });
      };
      const targetWasMounted = pageGeometry(viewer, location.pageIndex) !== null;
      operation.mutated = true;
      scrollToLocation();
      // Distant virtualized pages are commonly absent until the scroll request
      // expands the mounted page window. Wait only after issuing that request.
      while (
        operationIsCurrent(operation)
        && Date.now() < deadline
        && pageGeometry(viewer, location.pageIndex) === null
      ) {
        if (!await waitForPromise(nextFrame(), operation.signal, deadline - Date.now())) return false;
      }
      if (pageGeometry(viewer, location.pageIndex) === null) return false;
      // Some engines accept the first far-page request before the new page
      // geometry exists but do not retain its coordinates. Reapply once after
      // virtualization mounts that page; already-mounted targets scroll once.
      if (!targetWasMounted) scrollToLocation();
      if (!await waitForFrames(operation, 2, deadline)) return false;
      // An instant scroll can have reached its semantic postcondition while
      // the viewer still reports transient scroll activity. Do not turn that
      // already-settled destination into a bounded-timeout failure.
      if (locationMatchesView(viewer, location, true)) return true;
      if (!viewer.viewport.isScrolling() && !viewer.viewport.isSmoothScrolling()) {
        resolveIdle(true);
      }
      if (!await waitForPromise(idle, operation.signal, deadline - Date.now())) return false;
    } catch {
      return false;
    } finally {
      unsubscribe();
    }
    return waitForFrames(operation, 2, deadline);
  };

  const applyResolvedLocation = async (
    viewer: ActiveViewer,
    location: PdfViewerLocation,
    operation: NavigationOperation,
  ): Promise<boolean> => {
    if (!isPdfViewerLocation(location) || !operationIsCurrent(operation)) return false;
    const page = viewer.pages[location.pageIndex];
    if (
      !page
      || location.anchor.x > page.size.width
      || location.anchor.y > page.size.height
    ) return false;
    try {
      if (locationMatchesView(viewer, location)) return operationIsCurrent(operation);
    } catch {
      return false;
    }

    const deadline = Date.now() + timeoutMs;
    let currentZoom: number;
    try {
      currentZoom = viewer.zoom.getState().currentZoomLevel;
    } catch {
      return false;
    }
    const zoomed = Math.abs(currentZoom - location.zoom) <= zoomTolerance
      ? true
      : await (async () => {
        operation.mutated = true;
        return waitForZoom(
          viewer.zoom,
          location.zoom,
          zoomTolerance,
          operation.signal,
          deadline - Date.now(),
        );
      })();
    if (!zoomed || !operationIsCurrent(operation)) return false;
    if (!await waitForFrames(operation, 2, deadline)) return false;
    if (!await scrollAndWait(viewer, location, operation, deadline)) return false;
    if (!operationIsCurrent(operation)) return false;
    try {
      return locationMatchesView(viewer, location, true);
    } catch {
      return false;
    }
  };

  const applyLocation = async (location: PdfViewerLocation): Promise<boolean> => {
    const viewer = activeViewer();
    if (!viewer) return false;
    const operation = await beginOperation(viewer);
    if (operation === null) return false;
    try {
      const applied = await applyResolvedLocation(viewer, location, operation);
      if (!applied && !operation.signal.aborted && operation.mutated) {
        await rollbackOperation(operation);
      }
      return applied;
    } finally {
      if (activeOperation?.operation === operation) activeOperation = null;
    }
  };

  const resolveTarget = (
    viewer: ActiveViewer,
    target: PdfNavigationTarget,
  ): PdfViewerLocation | null => {
    if (target.documentGeneration !== viewer.documentGeneration) return null;
    const page = viewer.pages[target.pageIndex];
    if (!page) return null;
    let metrics;
    let currentZoom;
    try {
      metrics = viewer.viewport.getMetrics();
      currentZoom = viewer.zoom.getState().currentZoomLevel;
    } catch {
      return null;
    }
    const rotation = combinePageRotation(page.rotation, viewer.documentRotation);
    return createPdfTargetLocation(target, {
      page: {
        ...page.size,
        cropOrigin: {
          x: page.boxes?.crop.left ?? 0,
          y: page.boxes?.crop.bottom ?? 0,
        },
      },
      viewport: {
        width: metrics.clientWidth,
        height: metrics.clientHeight,
        gap: viewer.viewportGap,
      },
      currentZoom,
      rotation,
    });
  };

  const waitForTargetLocation = async (
    viewer: ActiveViewer,
    target: PdfNavigationTarget,
    operation: NavigationOperation,
  ): Promise<PdfViewerLocation | null> => {
    const deadline = Date.now() + timeoutMs;
    while (operationIsCurrent(operation) && Date.now() < deadline) {
      const location = resolveTarget(viewer, target);
      if (location !== null) return location;
      if (!await waitForPromise(nextFrame(), operation.signal, deadline - Date.now())) return null;
    }
    return null;
  };

  const applyTarget = async (target: PdfNavigationTarget): Promise<boolean> => {
    const viewer = activeViewer();
    if (!viewer) return false;
    const operation = await beginOperation(viewer);
    if (operation === null) return false;
    try {
      if (!operationIsCurrent(operation)) return false;
      // A newly opened inactive document can notify before its portaled viewport
      // has committed usable metrics. Let that bounded render settle rather than
      // treating the target as malformed.
      const initialLocation = await waitForTargetLocation(viewer, target, operation);
      if (initialLocation === null) return false;
      let currentPageIndex = -1;
      try {
        currentPageIndex = viewer.scroll.getCurrentPage() - 1;
      } catch {
        return false;
      }
      const waitForAdjacentTarget = Math.abs(target.pageIndex - currentPageIndex) <= 1;
      const readinessDeadline = Date.now() + timeoutMs;
      while (operationIsCurrent(operation) && Date.now() < readinessDeadline) {
        const hasPageTree = hasUsablePageTree(viewer);
        const targetReady = pageGeometry(viewer, target.pageIndex) !== null;
        if (hasPageTree && (!waitForAdjacentTarget || targetReady)) break;
        if (!await waitForPromise(
          nextFrame(),
          operation.signal,
          readinessDeadline - Date.now(),
        )) return false;
      }
      if (
        !hasUsablePageTree(viewer)
        || (waitForAdjacentTarget && pageGeometry(viewer, target.pageIndex) === null)
      ) return false;
      // Viewport metrics can change while the portaled page tree settles. Resolve
      // again so fitted zoom/alignment use the committed viewport dimensions.
      const settledLocation = resolveTarget(viewer, target);
      const applied = settledLocation
        ? await applyResolvedLocation(viewer, settledLocation, operation)
        : false;
      if (!applied && !operation.signal.aborted && operation.mutated) {
        await rollbackOperation(operation);
      }
      return applied;
    } finally {
      if (activeOperation?.operation === operation) activeOperation = null;
    }
  };

  const unsubscribeStore = options.registry.getStore().subscribe((_action, state) => {
    const operation = activeOperation;
    if (!operation) return;
    const currentDocument = state.core.documents[operation.operation.documentId]?.document;
    if (currentDocument !== operation.operation.document) operation.abort.abort();
  });

  return {
    captureLocation,
    resolveTarget(target) {
      const viewer = activeViewer();
      return viewer ? resolveTarget(viewer, target) : null;
    },
    applyLocation,
    applyTarget,
    cancelPendingNavigation,
    replaceDocument(nextDocumentGeneration) {
      cancelPendingNavigation();
      documentGeneration = nextDocumentGeneration;
    },
    focusAtDestination(pageIndex) {
      return focusViewerDestination(options.root(), pageIndex);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelPendingNavigation();
      unsubscribeStore();
    },
  };
}
