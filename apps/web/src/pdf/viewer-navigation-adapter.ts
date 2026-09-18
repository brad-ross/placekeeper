import { flushSync } from 'react-dom';

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
  type PdfViewportOcclusion,
  type PdfViewportQuery,
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
  /** Visible reading frame when the native scrollport extends beside a dock. */
  readonly readingViewport?: () => HTMLElement | null;
  /** Stable EmbedPDF document scope; it need not be the globally active document. */
  readonly documentId: string;
  readonly documentGeneration: number;
  /** Live right/bottom area covered by trays in this viewer's DOM viewport. */
  readonly runway?: () => ViewerRunway;
  /** Optional layout-owned margin for explicit width fitting. */
  readonly fitWidthMargins?: () => { left: number; right: number } | undefined;
  readonly timeoutMs?: number;
  readonly coordinateTolerancePixels?: number;
  readonly zoomTolerance?: number;
  readonly nextFrame?: () => Promise<void>;
}

export interface PdfViewerNavigation extends ViewerNavigationControls {
  /** Resolves the visual top of a page while retaining zoom and horizontal framing. */
  resolvePageLocation(pageIndex: number): PdfViewerLocation | null;
  /** Resolves a semantic target without moving the viewer. */
  resolveTarget(target: PdfNavigationTarget): PdfViewerLocation | null;
  /** Reports whether a live semantic target occupies the usable viewport. */
  targetVisibility(target: PdfNavigationTarget): PdfTargetVisibility;
  /** Reports whether a neutral location occupies an optionally unobscured viewport. */
  locationVisibility(
    location: PdfViewerLocation,
    viewport?: PdfViewportQuery,
  ): PdfTargetVisibility;
  /** Reports whether a natural page point occupies an optionally unobscured viewport. */
  pointVisibility(
    pageIndex: number,
    point: PdfNaturalPoint,
    viewport?: PdfViewportQuery,
  ): PdfTargetVisibility;
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

interface NativeHorizontalBoundary {
  readonly scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

interface LocationPositioning {
  readonly horizontalBoundary?: NativeHorizontalBoundary;
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

function validOcclusion(value: PdfViewportOcclusion): boolean {
  return Number.isFinite(value.left)
    && Number.isFinite(value.top)
    && Number.isFinite(value.right)
    && Number.isFinite(value.bottom)
    && value.right > value.left
    && value.bottom > value.top;
}

/** Returns the largest rectangular part of `viewport` not covered by `occlusion`. */
function subtractViewportOcclusion(
  viewport: EffectiveViewportRect,
  occlusion: PdfViewportOcclusion | null | undefined,
  preserveHorizontalRange = false,
): EffectiveViewportRect | null {
  if (occlusion === null || occlusion === undefined) return viewport;
  if (!validOcclusion(occlusion)) return null;
  const covered = intersectViewerRects(viewport, occlusion);
  if (covered === null) return viewport;
  const candidates = [
    { left: viewport.left, top: viewport.top, right: covered.left, bottom: viewport.bottom },
    { left: covered.right, top: viewport.top, right: viewport.right, bottom: viewport.bottom },
    { left: viewport.left, top: viewport.top, right: viewport.right, bottom: covered.top },
    { left: viewport.left, top: covered.bottom, right: viewport.right, bottom: viewport.bottom },
  ].map((rect) => ({
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
  })).filter((rect) => validDimension(rect.width) && validDimension(rect.height));
  // A fitted page cannot pan into a strip beside a floating composer. Prefer
  // space above or below it, where vertical scrolling can reveal the passage.
  const fullWidthCandidates = preserveHorizontalRange
    ? candidates.filter((rect) => rect.width === viewport.width)
    : [];
  const reachableCandidates = fullWidthCandidates.length > 0 ? fullWidthCandidates : candidates;
  return reachableCandidates.reduce<EffectiveViewportRect | null>((largest, candidate) => {
    if (largest === null) return candidate;
    return candidate.width * candidate.height > largest.width * largest.height
      ? candidate
      : largest;
  }, null);
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

  const operationOwnsViewer = (operation: NavigationOperation): boolean => {
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

  const operationIsCurrent = (operation: NavigationOperation): boolean => {
    let geometryIsCurrent = true;
    try {
      geometryIsCurrent = operation.geometryIsCurrent?.() ?? true;
    } catch {
      geometryIsCurrent = false;
    }
    return geometryIsCurrent && operationOwnsViewer(operation);
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
    const readingBounds = options.readingViewport?.()?.getBoundingClientRect();
    const right = Math.max(left, Math.min(
      scrollportRight, bounds.right - runway.right, readingBounds?.right ?? bounds.right,
    ));
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

  const unobscuredViewportRect = (
    viewportElement: HTMLElement,
    viewport?: PdfViewportQuery,
  ): EffectiveViewportRect | null => subtractViewportOcclusion(
    effectiveViewportRect(viewportElement),
    viewport?.occlusion,
    viewportElement.scrollWidth <= viewportElement.clientWidth + coordinateTolerance,
  );

  const scrollAlignment = (
    viewer: ActiveViewer,
    location: PdfViewerLocation,
    viewport?: PdfViewportQuery,
  ) => {
    const root = options.root();
    const viewportElement = root?.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
    if (!viewportElement) return location.alignment;
    const effectiveViewport = unobscuredViewportRect(viewportElement, viewport);
    if (effectiveViewport === null) return null;
    if (!validDimension(viewportElement.clientWidth) || !validDimension(viewportElement.clientHeight)) {
      return location.alignment;
    }
    const bounds = viewportElement.getBoundingClientRect();
    const scrollportLeft = bounds.left + viewportElement.clientLeft;
    const scrollportTop = bounds.top + viewportElement.clientTop;
    let layoutOffsetX = 0;
    let layoutOffsetY = 0;
    // The plugin scrolls on the next frame using its uniform viewport gap.
    // Measure the host's actual content origin from a mounted page first, so
    // even an unmounted destination lands correctly on that initial scroll.
    const mounted = mostVisibleMountedPageIndex(viewer);
    const geometry = mounted === null ? null : pageGeometry(viewer, mounted.pageIndex, mounted);
    if (mounted && geometry && Math.abs(geometry.scale - location.zoom) <= zoomTolerance) {
      const virtualRect = viewer.scroll.getRectPositionForPage?.(
        mounted.pageIndex,
        { origin: { x: 0, y: 0 }, size: geometry.page.size },
        location.zoom,
        geometry.rotation,
      );
      if (virtualRect) {
        layoutOffsetX = geometry.pageRect.left - scrollportLeft + viewportElement.scrollLeft
          - virtualRect.origin.x - viewer.viewportGap;
        layoutOffsetY = geometry.pageRect.top - scrollportTop + viewportElement.scrollTop
          - virtualRect.origin.y - viewer.viewportGap;
      }
    }
    return {
      xPercent: (
        effectiveViewport.left - scrollportLeft
        + effectiveViewport.width * location.alignment.xPercent / 100
        - layoutOffsetX
      ) / viewportElement.clientWidth * 100,
      yPercent: (
        effectiveViewport.top - scrollportTop
        + effectiveViewport.height * location.alignment.yPercent / 100
        - layoutOffsetY
      ) / viewportElement.clientHeight * 100,
    };
  };

  const pageGeometry = (
    viewer: ActiveViewer,
    pageIndex: number,
    measured?: { readonly viewportRect: EffectiveViewportRect; readonly pageRect: DOMRect },
    viewport?: PdfViewportQuery,
  ) => {
    const page = viewer.pages[pageIndex];
    const root = options.root();
    const viewportElement = root?.querySelector<HTMLElement>('[data-viewer-framing-viewport]') ?? null;
    const pageElement = root?.querySelector<HTMLElement>(pageSelector(pageIndex)) ?? null;
    if (!page || !viewportElement || !pageElement) return null;
    const viewportRect = measured?.viewportRect
      ?? unobscuredViewportRect(viewportElement, viewport);
    const pageRect = measured?.pageRect ?? pageElement.getBoundingClientRect();
    const rotation = combinePageRotation(page.rotation, viewer.documentRotation);
    const rotatedPage = transformSize(page.size, rotation, 1);
    const scale = pageRect.width / rotatedPage.width;
    if (
      viewportRect === null
      || !validDimension(viewportRect.width)
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
      const alignment = scrollAlignment(viewer, origin);
      if (alignment === null) return;
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

  const locationAxesMatch = (
    viewer: ActiveViewer,
    location: PdfViewerLocation,
    acceptScrollBoundary = false,
    viewport?: PdfViewportQuery,
    horizontalBoundary?: NativeHorizontalBoundary,
  ): { horizontal: boolean; vertical: boolean } => {
    const geometry = pageGeometry(viewer, location.pageIndex, undefined, viewport);
    if (!geometry) return { horizontal: false, vertical: false };
    const { viewportRect, pageRect, page } = geometry;
    if (
      location.anchor.x > page.size.width
      || location.anchor.y > page.size.height
      || Math.abs(viewer.zoom.getState().currentZoomLevel - location.zoom) > zoomTolerance
    ) return { horizontal: false, vertical: false };
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
    const reachedNativeHorizontalBoundary = acceptScrollBoundary
      && horizontalBoundary !== undefined
      && metrics.scrollWidth === horizontalBoundary.scrollWidth
      && metrics.clientWidth === horizontalBoundary.clientWidth
      && Math.abs(metrics.scrollLeft - horizontalBoundary.scrollLeft) <= coordinateTolerance
      && actual.x > expected.x;
    const horizontalMatches = horizontalPageFullyVisible
      || (horizontalAnchorVisible && reachedNativeHorizontalBoundary)
      || (currentRunway().right > coordinateTolerance && horizontalAnchorVisible)
      // The browser may clamp before the page edge fits the reading frame
      // (which excludes the workspace). A visible anchor at the actual scroll
      // limit is reached even when exact horizontal alignment is impossible.
      || (horizontalAnchorVisible && axisMatchesOrIsConstrained(
      actual.x,
      expected.x,
      metrics.scrollLeft,
      metrics.scrollWidth,
      metrics.clientWidth,
      true,
      true,
      true,
      ));
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
    const anchorIsUnobscured = actual.x >= viewportRect.left - coordinateTolerance
      && actual.x <= viewportRect.right + coordinateTolerance
      && actual.y >= viewportRect.top - coordinateTolerance
      && actual.y <= viewportRect.bottom + coordinateTolerance;
    const unobscured = viewport?.occlusion === undefined || anchorIsUnobscured;
    return { horizontal: horizontalMatches && unobscured, vertical: verticalMatches && unobscured };
  };

  const locationMatchesView = (
    viewer: ActiveViewer,
    location: PdfViewerLocation,
    acceptScrollBoundary = false,
    viewport?: PdfViewportQuery,
    horizontalBoundary?: NativeHorizontalBoundary,
  ): boolean => {
    const matches = locationAxesMatch(viewer, location, acceptScrollBoundary, viewport, horizontalBoundary);
    return matches.horizontal && matches.vertical;
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
    viewport?: PdfViewportQuery,
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
        const alignment = scrollAlignment(viewer, location, viewport);
        if (alignment === null) return false;
        flushSync(() => viewer.scroll.scrollToPage({
          pageNumber: location.pageIndex + 1,
          pageCoordinates: location.anchor,
          behavior: 'instant',
          alignX: alignment.xPercent,
          alignY: alignment.yPercent,
        }));
        // Reconcile the plugin's gap with committed CSS geometry before a
        // frame can expose the intermediate page position.
        if (pageGeometry(viewer, location.pageIndex) !== null) {
          const matches = locationAxesMatch(viewer, location, true, viewport);
          if (!matches.horizontal || !matches.vertical) {
            return positionLocationInClientViewport(
              viewer, location, operation, true, viewport, matches.horizontal,
            ) !== null;
          }
        }
        return true;
      };
      const targetWasMounted = pageGeometry(viewer, location.pageIndex) !== null;
      operation.mutated = true;
      if (!scrollToLocation()) return false;
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
      if (!targetWasMounted && !scrollToLocation()) return false;
      if (!await waitForFrames(operation, 2, deadline)) return false;
      // An instant scroll can have reached its semantic postcondition while
      // the viewer still reports transient scroll activity. Do not turn that
      // already-settled destination into a bounded-timeout failure.
      if (locationMatchesView(viewer, location, true, viewport)) return true;
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

  function frameFittingLocation(
    viewer: ActiveViewer,
    location: PdfViewerLocation,
    viewport?: PdfViewportQuery,
  ): PdfViewerLocation {
    const element = options.root()?.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
    const bounds = element ? unobscuredViewportRect(element, viewport) : null;
    const page = viewer.pages[location.pageIndex];
    if (!bounds || !page) return location;
    const rotation = combinePageRotation(page.rotation, viewer.documentRotation);
    const width = transformSize(page.size, rotation, location.zoom).width;
    if (width > bounds.width + coordinateTolerance) return location;
    const margins = options.fitWidthMargins?.() ?? { left: viewer.viewportGap, right: viewer.viewportGap };
    const hasRoom = width <= bounds.width - margins.left - margins.right + coordinateTolerance;
    const left = hasRoom ? margins.left : 0;
    const right = bounds.width - (hasRoom ? margins.right : 0);
    const anchor = transformPosition(page.size, location.anchor, rotation, location.zoom);
    const requestedLeft = bounds.width * location.alignment.xPercent / 100 - anchor.x;
    if (requestedLeft >= left - coordinateTolerance
      && requestedLeft + width <= right + coordinateTolerance) return location;
    // Resolve fitting-page alignment before scrolling, so the anchor jump and
    // horizontal framing are one movement rather than two painted positions.
    return {
      ...location,
      alignment: {
        ...location.alignment,
        xPercent: (left + (right - left - width) / 2 + anchor.x) / bounds.width * 100,
      },
    };
  }

  const applyResolvedLocation = async (
    viewer: ActiveViewer,
    location: PdfViewerLocation,
    operation: NavigationOperation,
    viewport?: PdfViewportQuery,
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
    location = frameFittingLocation(viewer, location, viewport);
    try {
      if (locationMatchesView(viewer, location, false, viewport)) {
        return operationIsCurrent(operation);
      }
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
    location = frameFittingLocation(viewer, location, viewport);
    if (!await scrollAndWait(viewer, location, operation, deadline, viewport)) return false;
    if (!operationIsCurrent(operation)) return false;
    try {
      // The plugin computes offsets from its configured gap. The host's CSS
      // padding and mounted page layout can differ, even without a workspace.
      // Reconcile against actual geometry before declaring the jump a failure.
      const matches = locationAxesMatch(viewer, location, true, viewport);
      if (matches.horizontal && matches.vertical) return true;
      const positioned = positionLocationInClientViewport(
        viewer, location, operation, true, viewport, matches.horizontal,
      );
      if (positioned === null) return false;
      if (!await waitForFrames(operation, 2, deadline)) return false;
      return locationMatchesView(viewer, location, true, viewport, positioned.horizontalBoundary);
    } catch {
      return false;
    }
  };

  // Every explicit jump shares this rule. Leave valid saved framing and
  // zoomed-in panning alone; only repair clipping when the entire page fits.
  async function revealFittingPage(
    viewer: ActiveViewer,
    pageIndex: number,
    operation: NavigationOperation,
    viewport?: PdfViewportQuery,
  ): Promise<boolean> {
    if (!operationIsCurrent(operation)) return false;
    try {
      const geometry = pageGeometry(viewer, pageIndex, undefined, viewport);
      if (geometry === null) return false;
      const { pageRect, viewportRect, viewportElement } = geometry;
      if (pageRect.width > viewportRect.width + coordinateTolerance) return true;
      const margins = options.fitWidthMargins?.() ?? { left: viewer.viewportGap, right: viewer.viewportGap };
      const hasRoomForMargins = pageRect.width <= viewportRect.width - margins.left - margins.right + coordinateTolerance;
      const readingLeft = viewportRect.left + (hasRoomForMargins ? margins.left : 0);
      const readingRight = viewportRect.right - (hasRoomForMargins ? margins.right : 0);
      if (pageRect.left >= readingLeft - coordinateTolerance
        && pageRect.right <= readingRight + coordinateTolerance) return true;
      const left = viewportElement.scrollLeft + pageRect.left - readingLeft
        - (readingRight - readingLeft - pageRect.width) / 2;
      const top = viewportElement.scrollTop;
      operation.mutated = true;
      viewer.viewport.scrollTo({ x: left, y: top, behavior: 'instant' });
      viewportElement.scrollTo({ left, top, behavior: 'instant' });
      if (!await waitForFrames(operation, 2, Date.now() + timeoutMs)) return false;
      const settled = pageGeometry(viewer, pageIndex, undefined, viewport);
      return settled !== null
        && settled.pageRect.left >= settled.viewportRect.left - coordinateTolerance
        && settled.pageRect.right <= settled.viewportRect.right + coordinateTolerance;
    } catch {
      return false;
    }
  }

  const applyLocation = async (
    location: PdfViewerLocation,
    viewport?: PdfViewportQuery,
  ): Promise<boolean> => {
    const viewer = activeViewer();
    if (!viewer) return false;
    const operation = await beginOperation(viewer);
    if (operation === null) return false;
    try {
      let applied = await applyResolvedLocation(viewer, location, operation, viewport);
      if (applied) applied = await revealFittingPage(viewer, location.pageIndex, operation, viewport);
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
    viewport?: PdfViewportQuery,
    preserveHorizontalPosition = false,
  ): LocationPositioning | null {
    if (!operationIsCurrent(operation)) return null;
    const geometry = pageGeometry(viewer, location.pageIndex, undefined, viewport);
    if (geometry === null) return null;
    if (
      requireTargetScale
      && Math.abs(geometry.scale - location.zoom) > zoomTolerance
    ) return null;
    const clientAnchor = clientPointForLocation(geometry, location);
    const horizontalCorrection = preserveHorizontalPosition ? 0 : clientAnchor.x
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
      // Stable scrollbar gutters can overstate scrollWidth - clientWidth.
      // An instant native scroll provides the actual limit; retain it only
      // for this position attempt and verify the anchor remains visible.
      if (geometry.viewportElement.scrollLeft < correctedScroll.left - coordinateTolerance) {
        return { horizontalBoundary: {
          scrollLeft: geometry.viewportElement.scrollLeft,
          scrollWidth: geometry.viewportElement.scrollWidth,
          clientWidth: geometry.viewportElement.clientWidth,
        } };
      }
    }
    return {};
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
      const fitMargins = options.fitWidthMargins?.() ?? { left: viewer.viewportGap, right: viewer.viewportGap };
      const fitGap = (fitMargins.left + fitMargins.right) / 2;
      const requestedZoom = fitViewerWidthZoom({
        viewportWidth: viewportRect.width,
        pageWidth: rotatedPage.width,
        viewportGap: fitGap,
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
          xPercent: 50 + 50 * (fitMargins.left - fitMargins.right) / viewportRect.width,
          yPercent: origin?.alignment.yPercent ?? 50,
        },
        zoom: requestedZoom,
      };
      let observerPositionedPage = false;
      const positionFittedPage = (requireTargetScale = true): boolean => (
        positionLocationInClientViewport(viewer, location, operation, requireTargetScale) !== null
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
        const zoomRequest = flushSync(() => waitForZoom(
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
        ));
        // Commit the scale and its native scroll anchor before either can
        // paint alone, including when fitting enlarges a zoomed-out page.
        observerPositionedPage = positionFittedPage();
        zoomed = await zoomRequest;
      }
      if (!zoomed || !operationOwnsViewer(operation)) {
        if (!operation.signal.aborted && operation.mutated) await rollbackOperation(operation);
        return false;
      }
      // The settlement token guards the geometry used to choose this scale.
      // The viewer's own zoom/layout events can invalidate that token after
      // the scale commits, so validate the result against live geometry below.
      // Operation, document, and cancellation ownership remain mandatory.
      delete operation.geometryIsCurrent;
      if (!await waitForFrames(operation, 2, fitDeadline)) {
        if (!operation.signal.aborted && operation.mutated) await rollbackOperation(operation);
        return false;
      }
      // ResizeObserver runs after zoom layout but before paint, so it applies
      // the tray-aware offsets without exposing EmbedPDF's full-width frame.
      // Keep this fallback for unchanged zooms and non-DOM test adapters.
      if (!observerPositionedPage) positionFittedPage();
      // The zoom deadline ends when the viewer emits the requested scale, but
      // WebKit can commit the corresponding DOM geometry afterward. Give that
      // post-zoom phase one normal timeout, still capped by the frame limit below.
      const postZoomGeometryDeadline = Date.now() + timeoutMs;
      if (!await waitForFrames(operation, 2, postZoomGeometryDeadline)) {
        if (!operation.signal.aborted && operation.mutated) await rollbackOperation(operation);
        return false;
      }

      let applied = false;
      // WebKit can publish the zoom event before the page element reaches its
      // final size. Sample a bounded number of frames; each sample validates
      // the original target against live geometry and never reissues the zoom.
      for (let attempt = 0; attempt < 8 && operationOwnsViewer(operation); attempt += 1) {
        // Native scroll anchoring can adjust the vertical offset after the resize
        // observer runs. Align against each live page sample before validation.
        positionFittedPage();
        const settledGeometry = pageGeometry(viewer, visible.pageIndex);
        const liveFitMargins = options.fitWidthMargins?.()
          ?? { left: viewer.viewportGap, right: viewer.viewportGap };
        const liveFitGap = (liveFitMargins.left + liveFitMargins.right) / 2;
        const liveRequestedZoom = settledGeometry === null ? null : fitViewerWidthZoom({
          viewportWidth: settledGeometry.viewportRect.width,
          pageWidth: rotatedPage.width,
          viewportGap: liveFitGap,
        });
        const targetMatchesLiveGeometry = liveRequestedZoom !== null
          && Math.abs(liveRequestedZoom - requestedZoom) <= zoomTolerance;
        const boundedFit = liveRequestedZoom !== null && (
          liveRequestedZoom <= VIEWER_ZOOM_MIN_PERCENT / 100 + zoomTolerance
          || liveRequestedZoom >= VIEWER_ZOOM_MAX_PERCENT / 100 - zoomTolerance
        );
        const widthTarget = settledGeometry === null
          ? 0
          : settledGeometry.viewportRect.width - 2 * liveFitGap;
        const widthMatches = settledGeometry !== null
          && (boundedFit || Math.abs(settledGeometry.pageRect.width - widthTarget) <= coordinateTolerance);
        const edgesFit = settledGeometry !== null
          && (boundedFit || (
            settledGeometry.pageRect.left
              >= settledGeometry.viewportRect.left + liveFitMargins.left - coordinateTolerance
            && settledGeometry.pageRect.right
              <= settledGeometry.viewportRect.right - liveFitMargins.right + coordinateTolerance
          ));
        // The native current-page indicator includes content behind trays and
        // can change after zooming in a tall viewport. Validate the fitted
        // page's geometry and anchor directly instead of rolling that fit back.
        const locationMatches = locationMatchesView(viewer, location, true);
        applied = zoomed
          && targetMatchesLiveGeometry
          && widthMatches
          && edgesFit
          && locationMatches;
        if (applied || attempt === 7) break;
        if (!await waitForFrames(operation, 1, postZoomGeometryDeadline)) break;
      }
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

  const pointVisibility = (
    pageIndex: number,
    point: PdfNaturalPoint,
    viewport?: PdfViewportQuery,
  ): PdfTargetVisibility => {
    const viewer = activeViewer();
    if (viewer === null) return 'unavailable';
    if (
      !Number.isSafeInteger(pageIndex)
      || pageIndex < 0
      || !Number.isFinite(point.x)
      || !Number.isFinite(point.y)
      || point.x < 0
      || point.y < 0
      || !hasUsablePageTree(viewer)
    ) return 'unavailable';
    const page = viewer.pages[pageIndex];
    if (page === undefined || point.x > page.size.width || point.y > page.size.height) {
      return 'unavailable';
    }
    const pageElement = options.root()
      ?.querySelector<HTMLElement>(pageSelector(pageIndex)) ?? null;
    if (pageElement === null) return 'outside';
    const geometry = pageGeometry(viewer, pageIndex, undefined, viewport);
    if (geometry === null) return 'unavailable';
    const clientAnchor = clientPointForLocation(geometry, {
      pageIndex,
      anchor: point,
      alignment: { xPercent: 50, yPercent: 50 },
      zoom: geometry.scale,
    });
    return clientAnchor.x >= geometry.viewportRect.left - coordinateTolerance
      && clientAnchor.x <= geometry.viewportRect.right + coordinateTolerance
      && clientAnchor.y >= geometry.viewportRect.top - coordinateTolerance
      && clientAnchor.y <= geometry.viewportRect.bottom + coordinateTolerance
      ? 'visible'
      : 'outside';
  };

  const locationVisibility = (
    location: PdfViewerLocation,
    viewport?: PdfViewportQuery,
  ): PdfTargetVisibility => isPdfViewerLocation(location)
    ? pointVisibility(location.pageIndex, location.anchor, viewport)
    : 'unavailable';

  const targetVisibility = (target: PdfNavigationTarget): PdfTargetVisibility => {
    const viewer = activeViewer();
    if (viewer === null) return 'unavailable';
    const location = resolveTarget(viewer, target);
    return location === null ? 'unavailable' : locationVisibility(location);
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
        const positioned = positionLocationInClientViewport(viewer, finalLocation, operation);
        applied = positioned !== null
          && await waitForFrames(operation, 2, Date.now() + timeoutMs)
          && locationMatchesView(viewer, finalLocation, true, undefined, positioned.horizontalBoundary);
        if (applied) {
          const currentGeometry = pageGeometry(viewer, finalLocation.pageIndex);
          const expectedWidth = currentGeometry === null
            ? Number.NaN
            : currentGeometry.viewportRect.width - 2 * viewer.viewportGap;
          applied = currentGeometry !== null
            && Math.abs(currentGeometry.pageRect.width - expectedWidth) <= coordinateTolerance;
        }
      }
      if (applied && finalLocation && policy === 'author') {
        applied = await revealFittingPage(viewer, finalLocation.pageIndex, operation);
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
    clampLocation(location) {
      const viewer = activeViewer();
      if (!viewer || !isPdfViewerLocation(location) || viewer.pages.length === 0) return null;
      const pageIndex = clamp(location.pageIndex, 0, viewer.pages.length - 1);
      const page = viewer.pages[pageIndex];
      if (!page) return null;
      return {
        ...location,
        pageIndex,
        anchor: {
          x: clamp(location.anchor.x, 0, page.size.width),
          y: clamp(location.anchor.y, 0, page.size.height),
        },
      };
    },
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
    resolvePageLocation(pageIndex) {
      const viewer = activeViewer();
      const current = captureLocation();
      if (!viewer || !current || !Number.isSafeInteger(pageIndex) || pageIndex < 0) return null;
      const page = viewer.pages[pageIndex];
      const origin = viewer.pages[current.pageIndex];
      if (!page || !origin) return null;
      const rotation = combinePageRotation(page.rotation, viewer.documentRotation);
      const originRotation = combinePageRotation(origin.rotation, viewer.documentRotation);
      const visualAnchor = transformPosition(origin.size, current.anchor, originRotation, 1);
      const rotatedSize = transformSize(page.size, rotation, 1);
      const anchor = restorePosition(rotatedSize, {
        x: clamp(visualAnchor.x, 0, rotatedSize.width), y: 0,
      }, rotation, 1);
      return {
        pageIndex,
        anchor,
        alignment: { xPercent: current.alignment.xPercent, yPercent: 0 },
        zoom: current.zoom,
      };
    },
    resolveTarget(target) {
      const viewer = activeViewer();
      return viewer ? resolveTarget(viewer, target) : null;
    },
    targetVisibility,
    locationVisibility,
    pointVisibility,
    applyLocation,
    fitToWidth,
    isFitToWidth() {
      const viewer = activeViewer();
      if (!viewer) return false;
      const visible = mostVisibleMountedPageIndex(viewer);
      if (!visible) return false;
      const geometry = pageGeometry(viewer, visible.pageIndex, visible);
      if (!geometry) return false;
      const pageWidth = transformSize(geometry.page.size, geometry.rotation, 1).width;
      const margins = options.fitWidthMargins?.() ?? { left: viewer.viewportGap, right: viewer.viewportGap };
      const zoom = fitViewerWidthZoom({
        viewportWidth: geometry.viewportRect.width,
        pageWidth,
        viewportGap: (margins.left + margins.right) / 2,
      });
      return zoom !== null && Math.abs(viewer.zoom.getState().currentZoomLevel - zoom) * pageWidth <= 1;
    },
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
