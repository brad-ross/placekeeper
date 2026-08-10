import {
  PdfActionType,
  PdfZoomMode,
  type PdfDestinationObject,
  type PdfLinkTarget,
} from '@embedpdf/models';
import { describe, expect, it } from 'vitest';

import { classifyPdfNavigationTarget } from '../src/pdf/pdf-navigation-target.js';

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
