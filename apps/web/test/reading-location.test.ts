import { Rotation } from '@embedpdf/models';
import { describe, expect, it } from 'vitest';

import {
  captureReadingLocation,
  readingCaptureIsCurrent,
  resolvedReadingLocation,
} from '../src/pdf/reading-location.js';

const fallback = {
  pageIndex: 1,
  anchor: { x: 42, y: 28 },
  alignment: { xPercent: 50, yPercent: 45 },
  zoom: 1.25,
};

describe('reading location continuity', () => {
  it('captures a bounded caret passage and restores its original screen alignment and zoom', async () => {
    const text = 'before the passage readers can recognize after';
    const captured = await captureReadingLocation({
      generation: 3,
      viewportIdentity: 7,
      fallback,
      page: {
        pageIndex: 1,
        size: { width: 200, height: 300 },
        rotation: Rotation.Degree0,
        extractedText: text,
        textRects: [{
          content: text,
          rect: { origin: { x: 0, y: 24 }, size: { width: 180, height: 8 } },
        }],
      },
    });

    expect(captured).toMatchObject({ generation: 3, viewportIdentity: 7, fallback });
    expect(captured.anchor?.kind).toBe('caret');
    expect((captured.anchor?.kind === 'caret'
      ? captured.anchor.leftContext.length + captured.anchor.rightContext.length
      : 0)).toBeLessThanOrEqual(128);

    expect(resolvedReadingLocation(captured!, {
      status: 'resolved', generation: 4, pageIndex: 4,
      rect: { x: 80, y: 120, width: 1, height: 8 },
    })).toEqual({
      pageIndex: 4,
      anchor: { x: 122, y: 124 },
      alignment: fallback.alignment,
      zoom: 1.25,
    });
  });

  it('uses the bounded fallback when text or geometry is unreliable', async () => {
    await expect(captureReadingLocation({
      generation: 3,
      viewportIdentity: 7,
      fallback,
      page: {
        pageIndex: 1,
        size: { width: 200, height: 300 },
        rotation: Rotation.Degree0,
        extractedText: '',
        textRects: [],
      },
    })).resolves.toMatchObject({ fallback, anchor: null });

    await expect(captureReadingLocation({
      generation: 3,
      viewportIdentity: 7,
      fallback,
      page: Promise.reject(new Error('page text unavailable')),
    })).resolves.toMatchObject({ fallback, anchor: null, generation: 3, viewportIdentity: 7 });

    expect(resolvedReadingLocation({
      generation: 3, viewportIdentity: 7, fallback, anchor: null,
      offset: { x: 0, y: 0 },
    }, { status: 'fallback', generation: 4, pageCount: 1 })).toEqual({
      ...fallback,
      pageIndex: 0,
    });
  });

  it('rejects a capture after either its generation or viewport moves', () => {
    const captured = {
      generation: 3,
      viewportIdentity: 7,
      fallback,
      anchor: null,
      offset: { x: 0, y: 0 },
    };
    expect(readingCaptureIsCurrent(captured, 3, 7)).toBe(true);
    expect(readingCaptureIsCurrent(captured, 4, 7)).toBe(false);
    expect(readingCaptureIsCurrent(captured, 3, 8)).toBe(false);
  });
});
