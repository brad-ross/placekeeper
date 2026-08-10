import {
  PdfActionType,
  PdfZoomMode,
  type PdfDestinationObject,
} from '@embedpdf/models';

export interface PdfNavigationTargetContext {
  readonly documentGeneration: number;
  readonly pageCount: number;
}

export interface PdfNavigationTarget {
  readonly documentGeneration: number;
  readonly pageIndex: number;
  readonly zoom: {
    readonly mode: PdfZoomMode;
    readonly params: readonly number[];
  };
  readonly identity: string;
}

export type PdfNavigationTargetRejection =
  | 'missing'
  | 'unsupported'
  | 'malformed'
  | 'out-of-range';

export type PdfNavigationTargetClassification =
  | { readonly ok: true; readonly target: PdfNavigationTarget }
  | { readonly ok: false; readonly reason: PdfNavigationTargetRejection };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Object.is(value, -0) ? 0 : value;
}

function finiteView(value: unknown): readonly number[] | null {
  if (!Array.isArray(value) || value.length > 4) return null;
  const normalized: number[] = [];
  for (const entry of value) {
    const number = finiteNumber(entry);
    if (number === null) return null;
    normalized.push(number);
  }
  return normalized;
}

function normalizedZoom(destination: Record<string, unknown>): PdfNavigationTarget['zoom'] | null {
  if (!isRecord(destination.zoom)) return null;
  const mode = destination.zoom.mode;
  if (typeof mode !== 'number' || !Number.isInteger(mode)) return null;
  const view = finiteView(destination.view);
  if (view === null) return null;

  switch (mode) {
    case PdfZoomMode.Unknown:
    case PdfZoomMode.FitPage:
    case PdfZoomMode.FitBoundingBox:
      return { mode, params: [] };
    case PdfZoomMode.XYZ: {
      if (!isRecord(destination.zoom.params)) return null;
      const x = finiteNumber(destination.zoom.params.x);
      const y = finiteNumber(destination.zoom.params.y);
      const zoom = finiteNumber(destination.zoom.params.zoom);
      if (x === null || y === null || zoom === null || zoom < 0) return null;
      return { mode, params: [x, y, zoom] };
    }
    case PdfZoomMode.FitHorizontal:
    case PdfZoomMode.FitVertical:
    case PdfZoomMode.FitBoundingBoxHorizontal:
    case PdfZoomMode.FitBoundingBoxVertical:
      return view.length === 1 ? { mode, params: [view[0]!] } : null;
    case PdfZoomMode.FitRectangle:
      return view.length === 4 ? { mode, params: view } : null;
    default:
      return null;
  }
}

function destinationFromTarget(
  value: unknown,
): { readonly destination: unknown } | { readonly rejection: PdfNavigationTargetRejection } {
  if (value === undefined || value === null) return { rejection: 'missing' };
  if (!isRecord(value)) return { rejection: 'malformed' };
  if (value.type === 'destination') return { destination: value.destination };
  if (value.type !== 'action' || !isRecord(value.action)) return { rejection: 'malformed' };
  if (value.action.type !== PdfActionType.Goto) return { rejection: 'unsupported' };
  return { destination: value.action.destination };
}

/**
 * Classifies only resolved, same-document destinations exposed by EmbedPDF.
 * It deliberately has no navigation side effect; callers decide whether to
 * focus an existing semantic target after an accepted result.
 */
export function classifyPdfNavigationTarget(
  value: unknown,
  context: PdfNavigationTargetContext,
): PdfNavigationTargetClassification {
  const resolved = destinationFromTarget(value);
  if ('rejection' in resolved) return { ok: false, reason: resolved.rejection };
  if (!isRecord(resolved.destination)) return { ok: false, reason: 'malformed' };

  if (
    !Number.isSafeInteger(context.documentGeneration) ||
    context.documentGeneration < 0 ||
    !Number.isSafeInteger(context.pageCount) ||
    context.pageCount < 0
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const pageIndex = resolved.destination.pageIndex;
  if (!Number.isSafeInteger(pageIndex)) return { ok: false, reason: 'malformed' };
  if ((pageIndex as number) < 0 || (pageIndex as number) >= context.pageCount) {
    return { ok: false, reason: 'out-of-range' };
  }

  const zoom = normalizedZoom(resolved.destination);
  if (zoom === null) return { ok: false, reason: 'malformed' };
  const normalizedPageIndex = pageIndex as number;
  const params = Object.freeze([...zoom.params]);
  const identity = JSON.stringify([
    context.documentGeneration,
    normalizedPageIndex,
    zoom.mode,
    ...params,
  ]);
  const target: PdfNavigationTarget = Object.freeze({
    documentGeneration: context.documentGeneration,
    pageIndex: normalizedPageIndex,
    zoom: Object.freeze({ mode: zoom.mode, params }),
    identity,
  });
  return { ok: true, target };
}

export function isResolvedPdfDestination(value: unknown): value is PdfDestinationObject {
  if (!isRecord(value) || !Number.isSafeInteger(value.pageIndex)) return false;
  return normalizedZoom(value) !== null;
}
