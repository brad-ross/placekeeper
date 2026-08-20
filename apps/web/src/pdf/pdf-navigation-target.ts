import {
  PdfActionType,
  PdfZoomMode,
} from '@embedpdf/models';

import type {
  PlacekeeperLinkLocation,
  PlacekeeperPdfDestinationMode,
} from '../../../../packages/core/src/placekeeper-link.js';

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

function validContext(context: PdfNavigationTargetContext): boolean {
  return Number.isSafeInteger(context.documentGeneration)
    && context.documentGeneration >= 0
    && Number.isSafeInteger(context.pageCount)
    && context.pageCount >= 0;
}

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

function expectedParameterCount(mode: PdfZoomMode): number | null {
  switch (mode) {
    case PdfZoomMode.Unknown:
    case PdfZoomMode.FitPage:
    case PdfZoomMode.FitBoundingBox:
      return 0;
    case PdfZoomMode.FitHorizontal:
    case PdfZoomMode.FitVertical:
    case PdfZoomMode.FitBoundingBoxHorizontal:
    case PdfZoomMode.FitBoundingBoxVertical:
      return 1;
    case PdfZoomMode.XYZ:
      return 3;
    case PdfZoomMode.FitRectangle:
      return 4;
    default:
      return null;
  }
}

function normalizeTargetZoom(
  mode: PdfZoomMode,
  params: readonly number[],
): PdfNavigationTarget['zoom'] | null {
  const expectedCount = expectedParameterCount(mode);
  if (
    expectedCount === null
    || !Array.isArray(params)
    || params.length !== expectedCount
    || params.some((value) => !Number.isFinite(value) || Object.is(value, -0))
    || (mode === PdfZoomMode.XYZ && params[2]! < 0)
  ) return null;
  return { mode, params: Object.freeze([...params]) };
}

function targetIdentity(input: {
  readonly documentGeneration: number;
  readonly pageIndex: number;
  readonly zoom: PdfNavigationTarget['zoom'];
}): string {
  return JSON.stringify([
    input.documentGeneration,
    input.pageIndex,
    input.zoom.mode,
    ...input.zoom.params,
  ]);
}

function durableMode(mode: PdfZoomMode): PlacekeeperPdfDestinationMode | null {
  switch (mode) {
    case PdfZoomMode.XYZ: return 'xyz';
    case PdfZoomMode.FitPage: return 'fit-page';
    case PdfZoomMode.FitBoundingBox: return 'fit-bounding-box';
    case PdfZoomMode.FitHorizontal: return 'fit-horizontal';
    case PdfZoomMode.FitVertical: return 'fit-vertical';
    case PdfZoomMode.FitBoundingBoxHorizontal: return 'fit-bounding-box-horizontal';
    case PdfZoomMode.FitBoundingBoxVertical: return 'fit-bounding-box-vertical';
    case PdfZoomMode.FitRectangle: return 'fit-rectangle';
    default: return null;
  }
}

function liveMode(mode: PlacekeeperPdfDestinationMode): PdfZoomMode | null {
  switch (mode) {
    case 'xyz': return PdfZoomMode.XYZ;
    case 'fit-page': return PdfZoomMode.FitPage;
    case 'fit-bounding-box': return PdfZoomMode.FitBoundingBox;
    case 'fit-horizontal': return PdfZoomMode.FitHorizontal;
    case 'fit-vertical': return PdfZoomMode.FitVertical;
    case 'fit-bounding-box-horizontal': return PdfZoomMode.FitBoundingBoxHorizontal;
    case 'fit-bounding-box-vertical': return PdfZoomMode.FitBoundingBoxVertical;
    case 'fit-rectangle': return PdfZoomMode.FitRectangle;
    default: return null;
  }
}

function createPdfNavigationTarget(input: {
  readonly documentGeneration: number;
  readonly pageIndex: number;
  readonly zoom: PdfNavigationTarget['zoom'];
}): PdfNavigationTarget {
  const identity = targetIdentity(input);
  return Object.freeze({
    documentGeneration: input.documentGeneration,
    pageIndex: input.pageIndex,
    zoom: Object.freeze(input.zoom),
    identity,
  });
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

  if (!validContext(context)) {
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
  const target = createPdfNavigationTarget({
    documentGeneration: context.documentGeneration,
    pageIndex: normalizedPageIndex,
    zoom: Object.freeze({ mode: zoom.mode, params }),
  });
  return { ok: true, target };
}

/**
 * Projects a classified live target into the generation-free Placekeeper
 * location grammar. Unknown author views are page-only at their full available
 * precision; every other supported mode remains an exact destination.
 */
export function placekeeperLocationFromPdfNavigationTarget(
  target: PdfNavigationTarget,
  context: PdfNavigationTargetContext,
): PlacekeeperLinkLocation | null {
  if (
    !validContext(context)
    || target.documentGeneration !== context.documentGeneration
    || !Number.isSafeInteger(target.pageIndex)
    || target.pageIndex < 0
    || target.pageIndex >= context.pageCount
  ) return null;
  const zoom = normalizeTargetZoom(target.zoom.mode, target.zoom.params);
  if (zoom === null || target.identity !== targetIdentity({ ...target, zoom })) return null;
  const page = target.pageIndex + 1;
  if (zoom.mode === PdfZoomMode.Unknown) return Object.freeze({ kind: 'page', page });
  const mode = durableMode(zoom.mode);
  if (mode === null) return null;
  return Object.freeze({
    kind: 'destination',
    page,
    mode,
    params: zoom.params,
  });
}

/** Rehydrates a durable page or exact destination for the active document. */
export function pdfNavigationTargetFromPlacekeeperLocation(
  location: PlacekeeperLinkLocation,
  context: PdfNavigationTargetContext,
): PdfNavigationTarget | null {
  if (
    !validContext(context)
    || !Number.isSafeInteger(location.page)
    || location.page < 1
    || location.page > context.pageCount
    || location.kind === 'item'
  ) return null;
  const pageIndex = location.page - 1;
  const mode = location.kind === 'page' ? PdfZoomMode.Unknown : liveMode(location.mode);
  if (mode === null) return null;
  const zoom = normalizeTargetZoom(mode, location.kind === 'page' ? [] : location.params);
  if (zoom === null) return null;
  return createPdfNavigationTarget({
    documentGeneration: context.documentGeneration,
    pageIndex,
    zoom,
  });
}
