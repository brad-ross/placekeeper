import { PdfZoomMode } from '@embedpdf/models';

import type { PdfNavigationTarget } from './pdf-navigation-target.js';
import {
  pdfBottomOriginPointToNaturalAnchor,
  type PdfNaturalPageSize,
  type PdfNaturalPoint,
} from './viewer-navigation.js';

export interface PdfDocumentOrderLocation {
  readonly pageIndex: number;
  readonly anchor: PdfNaturalPoint;
}

export interface PdfOutlineTargetOrderLocation extends PdfDocumentOrderLocation {
  readonly precision: 'exact' | 'page';
}

export interface PdfOutlineTargetOrderContext {
  readonly page: PdfNaturalPageSize & { readonly cropOrigin?: PdfNaturalPoint };
  readonly documentGeneration: number;
}

export interface PdfAnnotationOrderContext {
  readonly page: PdfNaturalPageSize;
}

/** Neutral page geometry captured from the active document by a viewer adapter. */
export interface PdfDocumentOrderPage {
  readonly size: PdfNaturalPageSize;
  readonly crop: {
    readonly left: number;
    readonly top: number;
    readonly bottom: number;
  };
}

function validDimension(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function numericParams(target: PdfNavigationTarget, count: number): readonly number[] | null {
  if (target.zoom.params.length !== count) return null;
  return target.zoom.params.every(Number.isFinite) ? target.zoom.params : null;
}

/**
 * Returns only authored document-order evidence. Unlike viewer navigation,
 * coordinate-free targets never manufacture a center anchor for ordering.
 */
export function createPdfOutlineTargetOrderLocation(
  target: PdfNavigationTarget,
  context: PdfOutlineTargetOrderContext,
): PdfOutlineTargetOrderLocation | null {
  if (target.documentGeneration !== context.documentGeneration) return null;
  const page = context.page;
  if (!validDimension(page.width) || !validDimension(page.height)) return null;
  const cropOrigin = page.cropOrigin ?? { x: 0, y: 0 };
  if (!Number.isFinite(cropOrigin.x) || !Number.isFinite(cropOrigin.y)) return null;
  const pageLevel = (): PdfOutlineTargetOrderLocation => ({
    pageIndex: target.pageIndex,
    anchor: { x: 0, y: 0 },
    precision: 'page',
  });
  const exact = (anchor: PdfNaturalPoint): PdfOutlineTargetOrderLocation | null => (
    Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
      ? { pageIndex: target.pageIndex, anchor, precision: 'exact' }
      : null
  );

  switch (target.zoom.mode) {
    case PdfZoomMode.Unknown:
    case PdfZoomMode.FitPage:
    case PdfZoomMode.FitBoundingBox:
    case PdfZoomMode.FitVertical:
    case PdfZoomMode.FitBoundingBoxVertical:
      return pageLevel();
    case PdfZoomMode.XYZ: {
      const params = numericParams(target, 3);
      if (!params || params[0] === undefined || params[1] === undefined) return null;
      return exact(pdfBottomOriginPointToNaturalAnchor(
        { x: params[0], y: params[1] },
        page,
        cropOrigin,
      ));
    }
    case PdfZoomMode.FitHorizontal:
    case PdfZoomMode.FitBoundingBoxHorizontal: {
      const params = numericParams(target, 1);
      if (!params || params[0] === undefined) return null;
      return exact(pdfBottomOriginPointToNaturalAnchor(
        { x: cropOrigin.x, y: params[0] },
        page,
        cropOrigin,
      ));
    }
    case PdfZoomMode.FitRectangle: {
      const params = numericParams(target, 4);
      if (!params || params[0] === undefined || params[3] === undefined) return null;
      return exact({
        x: params[0] - cropOrigin.x,
        y: page.height - (params[3] - cropOrigin.y),
      });
    }
    default:
      return null;
  }
}

/** Maps top-origin annotation evidence into crop-relative document order. */
export function createPdfAnnotationOrderLocation(
  input: { readonly pageIndex: number; readonly point: PdfNaturalPoint },
  context: PdfAnnotationOrderContext,
): PdfDocumentOrderLocation | null {
  const { page } = context;
  if (
    !Number.isSafeInteger(input.pageIndex)
    || input.pageIndex < 0
    || !validDimension(page.width)
    || !validDimension(page.height)
    || !Number.isFinite(input.point.x)
    || !Number.isFinite(input.point.y)
  ) return null;
  const anchor = input.point;
  if (
    anchor.x < 0
    || anchor.y < 0
    || anchor.x > page.width
    || anchor.y > page.height
  ) return null;
  return { pageIndex: input.pageIndex, anchor };
}
