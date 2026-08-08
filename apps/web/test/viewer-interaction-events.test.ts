import { Rotation, transformPosition } from '@embedpdf/models';
import { describe, expect, it } from 'vitest';

import { combinePageRotation } from '../src/pdf/owned-overlay.js';
import {
  normalizePageClientPoint,
  recordViewerPointerButton,
  viewerPointerButton,
} from '../src/pdf/viewer-interaction-events.js';

describe('viewer page interaction coordinates', () => {
  it('normalizes client points with intrinsic and document rotation combined exactly once', () => {
    const pageSize = { width: 100, height: 200 };
    const rotation = combinePageRotation(Rotation.Degree90, Rotation.Degree180);
    const scale = 1.5;
    const naturalPoint = { x: 25, y: 40 };
    const displayedPoint = transformPosition(pageSize, naturalPoint, rotation, scale);

    expect(normalizePageClientPoint(
      { x: displayedPoint.x + 12, y: displayedPoint.y + 18 },
      { pageSize, rotation, scale, elementLeft: 12, elementTop: 18 },
    )).toEqual(naturalPoint);
  });

  it('carries the native button through EmbedPDF neutral pointer events', () => {
    const pageTarget = {};
    recordViewerPointerButton(pageTarget, 2);

    expect(viewerPointerButton({ currentTarget: pageTarget })).toBe(2);
    expect(viewerPointerButton({ currentTarget: null })).toBeUndefined();
  });
});
