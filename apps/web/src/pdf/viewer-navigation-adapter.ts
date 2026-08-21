import type { PluginRegistry } from '@embedpdf/core';
import {
  PdfZoomMode,
  Rotation,
  restorePosition,
  transformPosition,
  transformSize,
  type PdfPageObject,
  type Position,
} from '@embedpdf/models';
import { ScrollPlugin, type ScrollScope } from '@embedpdf/plugin-scroll';
import { ViewportPlugin, type ViewportScope } from '@embedpdf/plugin-viewport';
import { ZoomPlugin, type ZoomChangeEvent, type ZoomScope } from '@embedpdf/plugin-zoom';

import type { PdfNavigationTarget } from './pdf-navigation-target.js';
import type { PdfDocumentOrderPage } from './document-order-location.js';
import { combinePageRotation } from './owned-overlay.js';
import {
  intersectViewerRects,
  type ViewerRunway,
  type WaitForSettledViewerGeometry,
} from './viewer-framing.js';
import {
  VIEWER_ZOOM_MAX_PERCENT,
  VIEWER_ZOOM_MIN_PERCENT,
} from './viewer-controls.js';
import {
  isPdfViewerLocation,
  pdfBottomOriginPointToNaturalAnchor,
  type PdfNaturalPageSize,
  type PdfNaturalPoint,
  type PdfTargetVisibility,
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

export type PdfTargetApplicationPolicy = 'author' | 'reference-fit-width';

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
  /** Reports whether a live semantic target occupies the usable viewport. */
  targetVisibility(target: PdfNavigationTarget): PdfTargetVisibility;
  /** Captures neutral page geometry without exposing viewer-library state. */
  captureDocumentOrderPages(): readonly PdfDocumentOrderPage[] | null;
  applyTarget(
    target: PdfNavigationTarget,
    policy?: PdfTargetApplicationPolicy,
  ): Promise<boolean>;
  /** Aborts in-flight movement and resolves after any required restoration. */
  cancelPendingNavigation(): Promise<void>;
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
  geometryIsCurrent?: () => boolean;
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

function validViewerZoom(value: number): boolean {
  return Number.isFinite(value)
    && value >= VIEWER_ZOOM_MIN_PERCENT / 100
    && value <= VIEWER_ZOOM_MAX_PERCENT / 100;
}

export function fitViewerWidthZoom(input: {
  readonly viewportWidth: number;
  readonly pageWidth: number;
  readonly viewportGap: number;
}): number | null {
  const availableWidth = input.viewportWidth - 2 * input.viewportGap;
  if (
    !validDimension(availableWidth)
    || !validDimension(input.pageWidth)
    || !Number.isFinite(input.viewportGap)
    || input.viewportGap < 0
  ) return null;
  return clamp(
    availableWidth / input.pageWidth,
    VIEWER_ZOOM_MIN_PERCENT / 100,
    VIEWER_ZOOM_MAX_PERCENT / 100,
  );
}

function numericParams(target: PdfNavigationTarget, count: number): readonly number[] | null {
  if (target.zoom.params.length !== count) return null;
  return target.zoom.params.every(Number.isFinite) ? target.zoom.params : null;
}

/** Maps a classified target into the same neutral location shape used for history and tab state. */
export function createPdfTargetLocation(
  target: PdfNavigationTarget,
  context: PdfTargetLocationContext,
  policy: PdfTargetApplicationPolicy = 'author',
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

  if (policy === 'reference-fit-width') {
    const authorLocation = createPdfTargetLocation(target, context);
    if (authorLocation === null) return null;
    const preservesVerticalAnchor = target.zoom.mode === PdfZoomMode.XYZ
      || target.zoom.mode === PdfZoomMode.FitHorizontal
      || target.zoom.mode === PdfZoomMode.FitBoundingBoxHorizontal
      || target.zoom.mode === PdfZoomMode.FitRectangle;
    return {
      ...authorLocation,
      anchor: {
        x: center.x,
        y: preservesVerticalAnchor ? authorLocation.anchor.y : 0,
      },
      alignment: {
        xPercent: 50,
        yPercent: preservesVerticalAnchor ? authorLocation.alignment.yPercent : 0,
      },
      zoom: fitWidth,
    };
  }

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
  const selector = pageSelector(pageIndex);
  const page = root.querySelector<HTMLElement>(selector);
  if (!page) return false;
  page.focus({ preventScroll: true });
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const activeElement = page.ownerDocument?.activeElement;
      if (activeElement !== page && activeElement !== page.ownerDocument?.body) return;
      root.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    }));
  }
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
  onMatchingZoom?: (event: Pick<
    ZoomChangeEvent,
    'oldZoom' | 'newZoom' | 'center' | 'desiredScrollLeft' | 'desiredScrollTop'
  >) => void,
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
      if (Math.abs(event.newZoom - requestedZoom) > tolerance) return;
      try {
        onMatchingZoom?.(event);
        finish(true);
      } catch {
        finish(false);
      }
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

  const cancelPendingOperation = (): Promise<void> | null => {
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
    const pendingRollback = rollbackBarrier;
    if (pendingRollback === null) return null;
    return pendingRollback.then(() => {
      if (rollbackBarrier === pendingRollback) rollbackBarrier = null;
    });
  };

  const cancelPendingNavigation = (): Promise<void> => (
    cancelPendingOperation() ?? Promise.resolve()
  );

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
    const pendingRollback = cancelPendingOperation();
    if (pendingRollback !== null) await pendingRollback;
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
    let geometryIsCurrent = true;
    try {
      geometryIsCurrent = operation.geometryIsCurrent?.() ?? true;
    } catch {
      geometryIsCurrent = false;
    }
    if (
      disposed
      || operation.signal.aborted
      || !geometryIsCurrent
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

  const effectiveViewportRect = (viewportElement: HTMLElement): EffectiveViewportRect => {
    const bounds = viewportElement.getBoundingClientRect();
    const left = bounds.left + viewportElement.clientLeft;
    const top = bounds.top + viewportElement.clientTop;
    const scrollportRight = Math.min(bounds.right, left + viewportElement.clientWidth);
    const scrollportBottom = Math.min(bounds.bottom, top + viewportElement.clientHeight);
    const runway = currentRunway();
    const right = Math.max(left, Math.min(scrollportRight, bounds.right - runway.right));
    const bottom = Math.max(top, Math.min(scrollportBottom, bounds.bottom - runway.bottom));
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  };

  const scrollAlignment = (location: PdfViewerLocation) => {
    const root = options.root();
    const viewportElement = root?.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
    if (!viewportElement) return location.alignment;
    const effectiveViewport = effectiveViewportRect(viewportElement);
    if (!validDimension(viewportElement.clientWidth) || !validDimension(viewportElement.clientHeight)) {
      return location.alignment;
    }
    return {
      xPercent: effectiveViewport.width / viewportElement.clientWidth * location.alignment.xPercent,
      yPercent: effectiveViewport.height / viewportElement.clientHeight * location.alignment.yPercent,
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
      ?? effectiveViewportRect(viewportElement);
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
    return { page, viewportElement, viewportRect, pageRect, rotation, scale };
  };

  const clientPointForLocation = (
    geometry: NonNullable<ReturnType<typeof pageGeometry>>,
    location: PdfViewerLocation,
  ): Position => {
    const transformed = transformPosition(
      geometry.page.size,
      location.anchor,
      geometry.rotation,
      geometry.scale,
    );
    return {
      x: geometry.pageRect.left + transformed.x,
      y: geometry.pageRect.top + transformed.y,
    };
  };

  const hasUsablePageTree = (viewer: ActiveViewer): boolean => {
    if (viewer.pages.length === 0) return false;
    const root = options.root();
    const viewport = root?.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
    const page = root?.querySelector<HTMLElement>('[data-page-index]');
    if (!viewport || !page) return false;
    const viewportRect = effectiveViewportRect(viewport);
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
    const viewportRect = effectiveViewportRect(viewportElement);
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
    const { viewportRect, pageRect, page } = geometry;
    if (
      location.anchor.x > page.size.width
      || location.anchor.y > page.size.height
      || Math.abs(viewer.zoom.getState().currentZoomLevel - location.zoom) > zoomTolerance
    ) return false;
    const actual = clientPointForLocation(geometry, location);
    const expected = {
      x: viewportRect.left + viewportRect.width * location.alignment.xPercent / 100,
      y: viewportRect.top + viewportRect.height * location.alignment.yPercent / 100,
    };
    const viewportElement = options.root()
      ?.querySelector<HTMLElement>('[data-viewer-framing-viewport]') ?? null;
    const metrics = viewportElement === null ? viewer.viewport.getMetrics() : {
      scrollLeft: viewportElement.scrollLeft,
      scrollTop: viewportElement.scrollTop,
      scrollWidth: viewportElement.scrollWidth,
      scrollHeight: viewportElement.scrollHeight,
      clientWidth: viewportElement.clientWidth,
      clientHeight: viewportElement.clientHeight,
    };
    // A fitted page can be smaller than the readable viewport while the
    // document stack or an interface runway still reports scroll range. When
    // the entire page is visible on an axis, that axis is already a stronger
    // postcondition than exact anchor alignment.
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
    const horizontalPageFullyVisible = pageRect.left >= viewportRect.left - coordinateTolerance
      && pageRect.right <= viewportRect.right + coordinateTolerance;
    const verticalPageFullyVisible = pageRect.top >= viewportRect.top - coordinateTolerance
      && pageRect.bottom <= viewportRect.bottom + coordinateTolerance;
    // With an overlay runway, EmbedPDF can center a page in its full layout
    // while the semantic destination anchor is already unobscured. Requiring
    // exact centering in that case turns a successful page jump into rollback.
    const horizontalAnchorVisible = actual.x >= viewportRect.left - coordinateTolerance
      && actual.x <= viewportRect.right + coordinateTolerance;
    const horizontalMatches = horizontalPageFullyVisible
      || (currentRunway().right > coordinateTolerance && horizontalAnchorVisible)
      || axisMatchesOrIsConstrained(
      actual.x,
      expected.x,
      metrics.scrollLeft,
      metrics.scrollWidth,
      metrics.clientWidth,
      pageRect.left >= viewportRect.left - coordinateTolerance,
      pageRect.right <= viewportRect.right + coordinateTolerance,
      true,
      );
    const verticalMatches = verticalPageFullyVisible || axisMatchesOrIsConstrained(
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
    return horizontalMatches && verticalMatches;
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
    if (
      !isPdfViewerLocation(location)
      || !validViewerZoom(location.zoom)
      || !operationIsCurrent(operation)
    ) return false;
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
      const rightRunwayActive = currentRunway().right > coordinateTolerance;
      if (rightRunwayActive && !locationMatchesView(viewer, location, true)) {
        if (!positionLocationInClientViewport(viewer, location, operation)) return false;
        if (!await waitForFrames(operation, 2, deadline)) return false;
      }
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

  function positionLocationInClientViewport(
    viewer: ActiveViewer,
    location: PdfViewerLocation,
    operation: NavigationOperation,
    requireTargetScale = true,
  ): boolean {
    if (!operationIsCurrent(operation)) return false;
    const geometry = pageGeometry(viewer, location.pageIndex);
    if (geometry === null) return false;
    if (
      requireTargetScale
      && Math.abs(geometry.scale - location.zoom) > zoomTolerance
    ) return false;
    const clientAnchor = clientPointForLocation(geometry, location);
    const horizontalCorrection = clientAnchor.x
      - geometry.viewportRect.left
      - geometry.viewportRect.width * location.alignment.xPercent / 100;
    const verticalCorrection = clientAnchor.y
      - geometry.viewportRect.top
      - geometry.viewportRect.height * location.alignment.yPercent / 100;
    if (
      Math.abs(horizontalCorrection) > coordinateTolerance
      || Math.abs(verticalCorrection) > coordinateTolerance
    ) {
      const correctedScroll = {
        left: geometry.viewportElement.scrollLeft + horizontalCorrection,
        top: geometry.viewportElement.scrollTop + verticalCorrection,
      };
      operation.mutated = true;
      viewer.viewport.scrollTo({
        x: correctedScroll.left,
        y: correctedScroll.top,
        behavior: 'instant',
      });
      geometry.viewportElement.scrollTo({
        ...correctedScroll,
        behavior: 'instant',
      });
    }
    return true;
  }

  const fitToWidth = async (
    waitForSettledGeometry?: WaitForSettledViewerGeometry,
  ): Promise<boolean> => {
    const viewer = activeViewer();
    if (!viewer) return false;
    const operation = await beginOperation(viewer);
    if (operation === null) return false;
    let fitLayoutObserver: ResizeObserver | null = null;
    try {
      const deadline = Date.now() + timeoutMs;
      if (waitForSettledGeometry) {
        const settlementPromise = waitForSettledGeometry(operation.signal);
        const settledInTime = await waitForPromise(
          settlementPromise,
          operation.signal,
          deadline - Date.now(),
        );
        if (!settledInTime) {
          if (activeOperation?.operation === operation) activeOperation.abort.abort();
          return false;
        }
        const settlement = await settlementPromise;
        if (settlement === null || !settlement.isCurrent()) return false;
        operation.geometryIsCurrent = settlement.isCurrent;
      }
      if (!operationIsCurrent(operation)) return false;

      const visible = mostVisibleMountedPageIndex(viewer);
      if (visible === null) return false;
      const geometry = pageGeometry(viewer, visible.pageIndex, visible);
      if (geometry === null) return false;
      const { page, viewportRect, rotation } = geometry;
      const rotatedPage = transformSize(page.size, rotation, 1);
      const requestedZoom = fitViewerWidthZoom({
        viewportWidth: viewportRect.width,
        pageWidth: rotatedPage.width,
        viewportGap: viewer.viewportGap,
      });
      if (requestedZoom === null || !operationIsCurrent(operation)) return false;

      const origin = operation.origin?.pageIndex === visible.pageIndex
        ? operation.origin
        : null;
      const originAnchor = origin?.anchor ?? {
        x: page.size.width / 2,
        y: page.size.height / 2,
      };
      const anchor = rotation === Rotation.Degree90 || rotation === Rotation.Degree270
        ? { x: originAnchor.x, y: page.size.height / 2 }
        : { x: page.size.width / 2, y: originAnchor.y };
      const location: PdfViewerLocation = {
        pageIndex: visible.pageIndex,
        anchor,
        alignment: {
          xPercent: 50,
          yPercent: origin?.alignment.yPercent ?? 50,
        },
        zoom: requestedZoom,
      };
      let observerPositionedPage = false;
      const positionFittedPage = (requireTargetScale = true): boolean => (
        positionLocationInClientViewport(viewer, location, operation, requireTargetScale)
      );
      const fitDeadline = Date.now() + timeoutMs;
      const pageElement = options.root()?.querySelector<HTMLElement>(pageSelector(visible.pageIndex));
      if (pageElement && typeof ResizeObserver !== 'undefined') {
        fitLayoutObserver = new ResizeObserver(() => {
          let currentZoom: number;
          try {
            currentZoom = viewer.zoom.getState().currentZoomLevel;
          } catch {
            return;
          }
          if (Math.abs(currentZoom - requestedZoom) > zoomTolerance) return;
          observerPositionedPage = positionFittedPage();
          if (observerPositionedPage) fitLayoutObserver?.disconnect();
        });
        fitLayoutObserver.observe(pageElement);
      }
      let zoomed = false;
      try {
        const currentZoom = viewer.zoom.getState().currentZoomLevel;
        zoomed = Math.abs(currentZoom - requestedZoom) <= zoomTolerance;
      } catch {
        zoomed = false;
      }
      if (!zoomed) {
        // Establish the tray-aware anchor before requesting the new scale.
        // Both mutations occur in one task, so the viewer never paints this
        // preparatory position as a separate state.
        positionFittedPage(false);
        const clientAnchor = clientPointForLocation(geometry, location);
        const currentAnchorPosition = {
          x: clientAnchor.x - geometry.viewportRect.left,
          y: clientAnchor.y - geometry.viewportRect.top,
        };
        const targetAnchorPosition = {
          x: geometry.viewportRect.width * location.alignment.xPercent / 100,
          y: geometry.viewportRect.height * location.alignment.yPercent / 100,
        };
        operation.mutated = true;
        zoomed = await waitForZoom(
          viewer.zoom,
          requestedZoom,
          zoomTolerance,
          operation.signal,
          fitDeadline - Date.now(),
          (event) => {
            const appliedRatio = event.newZoom / event.oldZoom;
            const zoomedAnchorPosition = {
              x: event.center.vx
                + appliedRatio * (currentAnchorPosition.x - event.center.vx),
              y: event.center.vy
                + appliedRatio * (currentAnchorPosition.y - event.center.vy),
            };
            viewer.viewport.scrollTo({
              x: Math.max(
                0,
                event.desiredScrollLeft
                  + zoomedAnchorPosition.x - targetAnchorPosition.x,
              ),
              y: Math.max(
                0,
                event.desiredScrollTop
                  + zoomedAnchorPosition.y - targetAnchorPosition.y,
              ),
              behavior: 'instant',
            });
          },
        );
      }
      if (!zoomed || !operationIsCurrent(operation)) {
        if (!operation.signal.aborted && operation.mutated) await rollbackOperation(operation);
        return false;
      }
      if (!await waitForFrames(operation, 2, fitDeadline)) {
        if (!operation.signal.aborted && operation.mutated) await rollbackOperation(operation);
        return false;
      }
      // ResizeObserver runs after zoom layout but before paint, so it applies
      // the tray-aware offsets without exposing EmbedPDF's full-width frame.
      // Keep this fallback for unchanged zooms and non-DOM test adapters.
      if (!observerPositionedPage) positionFittedPage();
      if (!await waitForFrames(operation, 2, Date.now() + timeoutMs)) {
        if (!operation.signal.aborted && operation.mutated) await rollbackOperation(operation);
        return false;
      }

      const settledGeometry = operationIsCurrent(operation)
        ? pageGeometry(viewer, visible.pageIndex)
        : null;
      const boundedFit = requestedZoom <= VIEWER_ZOOM_MIN_PERCENT / 100 + zoomTolerance
        || requestedZoom >= VIEWER_ZOOM_MAX_PERCENT / 100 - zoomTolerance;
      const widthTarget = visible.viewportRect.width - 2 * viewer.viewportGap;
      const widthMatches = settledGeometry !== null
        && (boundedFit || Math.abs(settledGeometry.pageRect.width - widthTarget) <= coordinateTolerance);
      const edgesFit = settledGeometry !== null
        && (boundedFit || (
          settledGeometry.pageRect.left
            >= settledGeometry.viewportRect.left + viewer.viewportGap - coordinateTolerance
          && settledGeometry.pageRect.right
            <= settledGeometry.viewportRect.right - viewer.viewportGap + coordinateTolerance
        ));
      let currentPageMatches = false;
      try {
        currentPageMatches = viewer.scroll.getCurrentPage() - 1 === visible.pageIndex;
      } catch {
        currentPageMatches = false;
      }
      const applied = zoomed
        && widthMatches
        && edgesFit
        && currentPageMatches
        && locationMatchesView(viewer, location, true);
      if (!applied && !operation.signal.aborted && operation.mutated) {
        await rollbackOperation(operation);
      }
      return applied;
    } catch {
      if (!operation.signal.aborted && operation.mutated) {
        await rollbackOperation(operation);
      }
      return false;
    } finally {
      fitLayoutObserver?.disconnect();
      if (activeOperation?.operation === operation) activeOperation = null;
    }
  };

  const resolveTarget = (
    viewer: ActiveViewer,
    target: PdfNavigationTarget,
    policy: PdfTargetApplicationPolicy = 'author',
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
    const viewport = policy === 'reference-fit-width'
      ? (() => {
          const element = options.root()
            ?.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
          if (!element) return null;
          const runway = currentRunway();
          const width = element.clientWidth - runway.right;
          const height = element.clientHeight - runway.bottom;
          return validDimension(width) && validDimension(height)
            ? { width, height }
            : null;
        })()
      : { width: metrics.clientWidth, height: metrics.clientHeight };
    if (viewport === null) return null;
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
        ...viewport,
        gap: viewer.viewportGap,
      },
      currentZoom,
      rotation,
    }, policy);
  };

  const targetVisibility = (target: PdfNavigationTarget): PdfTargetVisibility => {
    const viewer = activeViewer();
    if (viewer === null) return 'unavailable';
    const location = resolveTarget(viewer, target);
    if (location === null || !hasUsablePageTree(viewer)) return 'unavailable';
    const pageElement = options.root()
      ?.querySelector<HTMLElement>(pageSelector(location.pageIndex)) ?? null;
    if (pageElement === null) return 'outside';
    const geometry = pageGeometry(viewer, location.pageIndex);
    if (geometry === null) return 'unavailable';
    if (
      location.anchor.x > geometry.page.size.width
      || location.anchor.y > geometry.page.size.height
    ) return 'unavailable';
    const clientAnchor = clientPointForLocation(geometry, location);
    return clientAnchor.x >= geometry.viewportRect.left - coordinateTolerance
      && clientAnchor.x <= geometry.viewportRect.right + coordinateTolerance
      && clientAnchor.y >= geometry.viewportRect.top - coordinateTolerance
      && clientAnchor.y <= geometry.viewportRect.bottom + coordinateTolerance
      ? 'visible'
      : 'outside';
  };

  const waitForTargetLocation = async (
    viewer: ActiveViewer,
    target: PdfNavigationTarget,
    operation: NavigationOperation,
    policy: PdfTargetApplicationPolicy,
  ): Promise<PdfViewerLocation | null> => {
    const deadline = Date.now() + timeoutMs;
    while (operationIsCurrent(operation) && Date.now() < deadline) {
      const location = resolveTarget(viewer, target, policy);
      if (location !== null) return location;
      if (!await waitForPromise(nextFrame(), operation.signal, deadline - Date.now())) return null;
    }
    return null;
  };

  const applyTarget = async (
    target: PdfNavigationTarget,
    policy: PdfTargetApplicationPolicy = 'author',
  ): Promise<boolean> => {
    const viewer = activeViewer();
    if (!viewer) return false;
    const operation = await beginOperation(viewer);
    if (operation === null) return false;
    try {
      if (!operationIsCurrent(operation)) return false;
      // A newly opened inactive document can notify before its portaled viewport
      // has committed usable metrics. Let that bounded render settle rather than
      // treating the target as malformed.
      const initialLocation = await waitForTargetLocation(viewer, target, operation, policy);
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
      const settledLocation = resolveTarget(viewer, target, policy);
      let finalLocation = settledLocation;
      let applied = settledLocation
        ? await applyResolvedLocation(viewer, settledLocation, operation)
        : false;
      if (applied && settledLocation && policy === 'reference-fit-width') {
        const refreshedLocation = resolveTarget(viewer, target, policy);
        if (refreshedLocation === null) {
          applied = false;
        } else {
          finalLocation = refreshedLocation;
          if (Math.abs(refreshedLocation.zoom - settledLocation.zoom) > zoomTolerance) {
            applied = await applyResolvedLocation(viewer, refreshedLocation, operation);
          }
        }
      }
      if (applied && finalLocation && policy === 'reference-fit-width') {
        applied = positionLocationInClientViewport(viewer, finalLocation, operation)
          && await waitForFrames(operation, 2, Date.now() + timeoutMs)
          && locationMatchesView(viewer, finalLocation, true);
        if (applied) {
          const currentGeometry = pageGeometry(viewer, finalLocation.pageIndex);
          const expectedWidth = currentGeometry === null
            ? Number.NaN
            : currentGeometry.viewportRect.width - 2 * viewer.viewportGap;
          applied = currentGeometry !== null
            && Math.abs(currentGeometry.pageRect.width - expectedWidth) <= coordinateTolerance;
        }
      }
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
    captureDocumentOrderPages() {
      const viewer = activeViewer();
      return viewer?.pages.map((page) => ({
        size: page.size,
        crop: {
          left: page.boxes?.crop.left ?? 0,
          top: page.boxes?.crop.top ?? 0,
          bottom: page.boxes?.crop.bottom ?? 0,
        },
      })) ?? null;
    },
    resolveTarget(target) {
      const viewer = activeViewer();
      return viewer ? resolveTarget(viewer, target) : null;
    },
    targetVisibility,
    applyLocation,
    fitToWidth,
    fitToWidthReady() {
      const viewer = activeViewer();
      return viewer !== null && hasUsablePageTree(viewer);
    },
    applyTarget,
    cancelPendingNavigation,
    replaceDocument(nextDocumentGeneration) {
      void cancelPendingNavigation();
      documentGeneration = nextDocumentGeneration;
    },
    focusAtDestination(pageIndex) {
      return focusViewerDestination(options.root(), pageIndex);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      void cancelPendingNavigation();
      unsubscribeStore();
    },
  };
}
