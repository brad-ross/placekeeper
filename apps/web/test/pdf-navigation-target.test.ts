import {
  PdfActionType,
  PdfZoomMode,
  type PdfDestinationObject,
  type PdfLinkTarget,
} from '@embedpdf/models';
import { describe, expect, it } from 'vitest';

import {
  classifyPdfNavigationTarget,
  pdfNavigationTargetFromPlacekeeperLocation,
  placekeeperLocationFromPdfNavigationTarget,
} from '../src/pdf/pdf-navigation-target.js';

const context = { documentGeneration: 7, pageCount: 4 } as const;

function xyz(pageIndex: number, x: number, y: number, zoom = 0): PdfDestinationObject {
  return {
    pageIndex,
    zoom: { mode: PdfZoomMode.XYZ, params: { x, y, zoom } },
    view: [x, y, zoom],
  };
}

function direct(destination: PdfDestinationObject): PdfLinkTarget {
  return { type: 'destination', destination };
}

describe('PDF navigation target classification and identity', () => {
  it('deduplicates repeated direct, named-alias, and same-document Goto targets', () => {
    const destination = xyz(1, 72, 640);
    const repeated = classifyPdfNavigationTarget(direct({ ...destination }), context);
    const alias = classifyPdfNavigationTarget(direct(destination), context);
    const goto = classifyPdfNavigationTarget(
      { type: 'action', action: { type: PdfActionType.Goto, destination } },
      context,
    );

    expect(repeated).toMatchObject({ ok: true, target: { documentGeneration: 7, pageIndex: 1 } });
    expect(alias).toMatchObject({ ok: true });
    expect(goto).toMatchObject({ ok: true });
    if (!repeated.ok || !alias.ok || !goto.ok) throw new Error('valid targets were rejected');
    expect(new Set([repeated.target.identity, alias.target.identity, goto.target.identity]).size).toBe(1);
  });

  it('keeps distinct coordinates on the same page as distinct semantic targets', () => {
    const upper = classifyPdfNavigationTarget(direct(xyz(2, 72, 640)), context);
    const lower = classifyPdfNavigationTarget(direct(xyz(2, 72, 320)), context);

    expect(upper).toMatchObject({ ok: true });
    expect(lower).toMatchObject({ ok: true });
    if (!upper.ok || !lower.ok) throw new Error('valid targets were rejected');
    expect(upper.target.identity).not.toBe(lower.target.identity);
  });

  it('normalizes page-only and supported fit destinations without inventing coordinates', () => {
    const pageOnly = classifyPdfNavigationTarget(
      direct({ pageIndex: 0, zoom: { mode: PdfZoomMode.Unknown }, view: [] }),
      context,
    );
    const fitHorizontal = classifyPdfNavigationTarget(
      direct({ pageIndex: 3, zoom: { mode: PdfZoomMode.FitHorizontal }, view: [612] }),
      context,
    );

    expect(pageOnly).toMatchObject({
      ok: true,
      target: { pageIndex: 0, zoom: { mode: PdfZoomMode.Unknown, params: [] } },
    });
    expect(fitHorizontal).toMatchObject({
      ok: true,
      target: { pageIndex: 3, zoom: { mode: PdfZoomMode.FitHorizontal, params: [612] } },
    });
  });

  it.each([
    ['missing target', undefined, 'missing'],
    [
      'URI',
      { type: 'action', action: { type: PdfActionType.URI, uri: 'https://example.invalid' } },
      'unsupported',
    ],
    [
      'RemoteGoto',
      { type: 'action', action: { type: PdfActionType.RemoteGoto, destination: xyz(0, 0, 0) } },
      'unsupported',
    ],
    [
      'Launch',
      { type: 'action', action: { type: PdfActionType.LaunchAppOrOpenFile, path: '/tmp/payload' } },
      'unsupported',
    ],
    ['unsupported action', { type: 'action', action: { type: PdfActionType.Unsupported } }, 'unsupported'],
    ['malformed shape', { type: 'destination', destination: { pageIndex: 0 } }, 'malformed'],
    ['non-finite coordinate', direct(xyz(0, Number.NaN, 0)), 'malformed'],
    ['negative page', direct(xyz(-1, 0, 0)), 'out-of-range'],
    ['past final page', direct(xyz(4, 0, 0)), 'out-of-range'],
  ] as const)('rejects %s without producing an identity', (_name, target, reason) => {
    expect(classifyPdfNavigationTarget(target, context)).toEqual({ ok: false, reason });
  });
});

describe('durable PDF navigation targets', () => {
  it.each([
    [PdfZoomMode.XYZ, [72, 640, 1.5], 'xyz'],
    [PdfZoomMode.FitPage, [], 'fit-page'],
    [PdfZoomMode.FitBoundingBox, [], 'fit-bounding-box'],
    [PdfZoomMode.FitHorizontal, [640], 'fit-horizontal'],
    [PdfZoomMode.FitVertical, [72], 'fit-vertical'],
    [PdfZoomMode.FitBoundingBoxHorizontal, [640], 'fit-bounding-box-horizontal'],
    [PdfZoomMode.FitBoundingBoxVertical, [72], 'fit-bounding-box-vertical'],
    [PdfZoomMode.FitRectangle, [10, 20, 300, 700], 'fit-rectangle'],
  ] as const)('maps and rehydrates %s without retaining live identity', (mode, params, durableMode) => {
    const classified = classifyPdfNavigationTarget(direct({
      pageIndex: 2,
      zoom: mode === PdfZoomMode.XYZ
        ? { mode, params: { x: params[0]!, y: params[1]!, zoom: params[2]! } }
        : { mode },
      view: [...params],
    }), context);
    if (!classified.ok) throw new Error(`valid ${String(mode)} target was rejected`);

    const location = placekeeperLocationFromPdfNavigationTarget(classified.target, context);
    expect(location).toEqual({
      kind: 'destination',
      page: 3,
      mode: durableMode,
      params: [...params],
    });

    const rehydrated = pdfNavigationTargetFromPlacekeeperLocation(location!, {
      documentGeneration: 11,
      pageCount: 4,
    });
    expect(rehydrated).toEqual({
      documentGeneration: 11,
      pageIndex: 2,
      zoom: { mode, params: [...params] },
      identity: JSON.stringify([11, 2, mode, ...params]),
    });
    expect(rehydrated?.identity).not.toBe(classified.target.identity);
  });

  it('normalizes page-only author metadata to v1 and can rehydrate its full available precision', () => {
    const classified = classifyPdfNavigationTarget(
      direct({ pageIndex: 3, zoom: { mode: PdfZoomMode.Unknown }, view: [] }),
      context,
    );
    if (!classified.ok) throw new Error('valid page target was rejected');

    const location = placekeeperLocationFromPdfNavigationTarget(classified.target, context);
    expect(location).toEqual({ kind: 'page', page: 4 });
    expect(pdfNavigationTargetFromPlacekeeperLocation(location!, {
      documentGeneration: 13,
      pageCount: 4,
    })).toEqual({
      documentGeneration: 13,
      pageIndex: 3,
      zoom: { mode: PdfZoomMode.Unknown, params: [] },
      identity: JSON.stringify([13, 3, PdfZoomMode.Unknown]),
    });
  });

  it('canonicalizes equivalent classified sources to the same generation-free location', () => {
    const destination = xyz(1, 72, 640, 2);
    const outline = classifyPdfNavigationTarget(direct(destination), context);
    const link = classifyPdfNavigationTarget(
      { type: 'action', action: { type: PdfActionType.Goto, destination } },
      context,
    );
    if (!outline.ok || !link.ok) throw new Error('equivalent targets were rejected');

    expect(placekeeperLocationFromPdfNavigationTarget(outline.target, context))
      .toEqual(placekeeperLocationFromPdfNavigationTarget(link.target, context));
  });

  it('fails closed for stale, out-of-range, malformed, and non-location values', () => {
    const valid = classifyPdfNavigationTarget(direct(xyz(1, 72, 640, 2)), context);
    if (!valid.ok) throw new Error('valid target was rejected');

    expect(placekeeperLocationFromPdfNavigationTarget(valid.target, {
      ...context,
      documentGeneration: 8,
    })).toBeNull();
    expect(placekeeperLocationFromPdfNavigationTarget({ ...valid.target, pageIndex: 4 }, context))
      .toBeNull();
    expect(placekeeperLocationFromPdfNavigationTarget({
      ...valid.target,
      zoom: { mode: PdfZoomMode.FitRectangle, params: [0, 0, 1] },
    }, context)).toBeNull();
    expect(pdfNavigationTargetFromPlacekeeperLocation({
      kind: 'destination',
      page: 5,
      mode: 'fit-page',
      params: [],
    }, context)).toBeNull();
    expect(pdfNavigationTargetFromPlacekeeperLocation({
      kind: 'destination',
      page: 1,
      mode: 'xyz',
      params: [0, 0, -1],
    }, context)).toBeNull();
    expect(pdfNavigationTargetFromPlacekeeperLocation({
      kind: 'item',
      page: 1,
      itemId: '4c74f42b-353e-4297-97cd-d8f94296a39d',
    }, context)).toBeNull();
  });
});
