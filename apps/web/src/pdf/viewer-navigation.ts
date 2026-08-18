import type { WaitForSettledViewerGeometry } from './viewer-framing.js';

export interface PdfNaturalPoint {
  readonly x: number;
  readonly y: number;
}

export interface PdfNaturalPageSize {
  readonly width: number;
  readonly height: number;
}

export interface PdfViewportAlignment {
  /** Horizontal viewport alignment, from left (0) to right (100). */
  readonly xPercent: number;
  /** Vertical viewport alignment, from top (0) to bottom (100). */
  readonly yPercent: number;
}

/**
 * A restorable PDF location with no viewer-library or raw-scroll-offset state.
 * The anchor is expressed in natural, unrotated, top-origin page coordinates.
 */
export interface PdfViewerLocation {
  readonly pageIndex: number;
  readonly anchor: PdfNaturalPoint;
  readonly alignment: PdfViewportAlignment;
  /** Actual numeric scale, rather than a viewer-specific preset. */
  readonly zoom: number;
}

export interface PdfViewerLocationTolerances {
  readonly anchor?: number;
  readonly alignment?: number;
  readonly zoom?: number;
}

/** Read-only semantic visibility of a destination in the viewer's usable viewport. */
export type PdfTargetVisibility = 'visible' | 'outside' | 'unavailable';

export interface ViewerNavigationControls {
  captureLocation(): PdfViewerLocation | null;
  applyLocation(location: PdfViewerLocation): Promise<boolean>;
  fitToWidth(waitForSettledGeometry?: WaitForSettledViewerGeometry): Promise<boolean>;
  fitToWidthReady(): boolean;
  replaceDocument(documentGeneration: number): void;
  focusAtDestination(pageIndex: number): boolean;
  dispose(): void;
}

const DEFAULT_ANCHOR_TOLERANCE = 0.01;
const DEFAULT_ALIGNMENT_TOLERANCE = 0.01;
const DEFAULT_ZOOM_TOLERANCE = 0.001;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isPdfViewerLocation(value: unknown): value is PdfViewerLocation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PdfViewerLocation>;
  if (!Number.isSafeInteger(candidate.pageIndex) || (candidate.pageIndex ?? -1) < 0) return false;
  if (typeof candidate.anchor !== 'object' || candidate.anchor === null) return false;
  if (typeof candidate.alignment !== 'object' || candidate.alignment === null) return false;
  return finite(candidate.anchor.x)
    && finite(candidate.anchor.y)
    && candidate.anchor.x >= 0
    && candidate.anchor.y >= 0
    && finite(candidate.alignment.xPercent)
    && finite(candidate.alignment.yPercent)
    && candidate.alignment.xPercent >= 0
    && candidate.alignment.xPercent <= 100
    && candidate.alignment.yPercent >= 0
    && candidate.alignment.yPercent <= 100
    && finite(candidate.zoom)
    && candidate.zoom > 0;
}

export function samePdfViewerLocation(
  first: PdfViewerLocation | null,
  second: PdfViewerLocation | null,
  tolerances: PdfViewerLocationTolerances = {},
): boolean {
  if (first === null || second === null) return first === second;
  const anchorTolerance = tolerances.anchor ?? DEFAULT_ANCHOR_TOLERANCE;
  const alignmentTolerance = tolerances.alignment ?? DEFAULT_ALIGNMENT_TOLERANCE;
  const zoomTolerance = tolerances.zoom ?? DEFAULT_ZOOM_TOLERANCE;
  return first.pageIndex === second.pageIndex
    && Math.abs(first.anchor.x - second.anchor.x) <= anchorTolerance
    && Math.abs(first.anchor.y - second.anchor.y) <= anchorTolerance
    && Math.abs(first.alignment.xPercent - second.alignment.xPercent) <= alignmentTolerance
    && Math.abs(first.alignment.yPercent - second.alignment.yPercent) <= alignmentTolerance
    && Math.abs(first.zoom - second.zoom) <= zoomTolerance;
}

/** Converts a PDF destination point into the viewer's natural top-origin page space. */
export function pdfBottomOriginPointToNaturalAnchor(
  point: PdfNaturalPoint,
  page: PdfNaturalPageSize,
  cropOrigin: PdfNaturalPoint = { x: 0, y: 0 },
): PdfNaturalPoint {
  return {
    x: point.x - cropOrigin.x,
    y: page.height - (point.y - cropOrigin.y),
  };
}
