import { describe, expect, it } from 'vitest';

import {
  mainPdfAnnotationSurface,
  samePdfAnnotationSurface,
  type PdfAnnotationSurface,
} from '../src/pdf/annotation-surface.js';
import type { ViewerInteractionEvent } from '../src/pdf/viewer-interaction-events.js';

describe('PDF annotation surface identity', () => {
  it('matches only the same viewer kind, document generation, and reference tab', () => {
    const main = mainPdfAnnotationSurface(4);
    const reference: PdfAnnotationSurface = {
      kind: 'reference',
      documentGeneration: 4,
      tabIdentity: 'reference-a',
    };

    expect(samePdfAnnotationSurface(main, mainPdfAnnotationSurface(4))).toBe(true);
    expect(samePdfAnnotationSurface(main, mainPdfAnnotationSurface(5))).toBe(false);
    expect(samePdfAnnotationSurface(main, reference)).toBe(false);
    expect(samePdfAnnotationSurface(reference, { ...reference })).toBe(true);
    expect(samePdfAnnotationSurface(reference, { ...reference, tabIdentity: 'reference-b' })).toBe(false);
    expect(samePdfAnnotationSurface(reference, { ...reference, documentGeneration: 5 })).toBe(false);
  });

  it('carries optional viewer origin on mark evidence without changing main event callers', () => {
    const surface: PdfAnnotationSurface = {
      kind: 'reference',
      documentGeneration: 7,
      tabIdentity: 'reference-a',
    };
    const sourceMark: ViewerInteractionEvent = {
      type: 'source-mark',
      surface,
      value: { annotationKey: 'source:12:0', phase: 'activate', pageIndex: 11 },
    };
    const ownedMark: ViewerInteractionEvent = {
      type: 'owned-mark',
      surface,
      value: {
        id: 'annotation-1',
        phase: 'activate',
        pageIndex: 11,
        placement: { left: 20, top: 30, width: 40, height: 12 },
      },
    };
    const legacyMainEvent: ViewerInteractionEvent = { type: 'scroll' };

    expect(sourceMark.surface).toEqual(surface);
    expect(ownedMark.value).toMatchObject({ pageIndex: 11, placement: { left: 20, top: 30 } });
    expect(legacyMainEvent).toEqual({ type: 'scroll' });
  });
});
