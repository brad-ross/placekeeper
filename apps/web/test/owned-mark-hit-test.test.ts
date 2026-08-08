import { describe, expect, it } from 'vitest';

import type { ReviewAnnotation } from '../../../packages/core/src/pdf-writer.js';
import {
  OwnedMarkPointerGesture,
  groupOwnedMarkGeometry,
  hitTestOwnedMark,
} from '../src/pdf/owned-mark-hit-test.js';

const timestamp = '2026-08-08T00:00:00.000Z';
function annotation(
  id: string,
  rects: readonly { x: number; y: number; width: number; height: number }[],
): ReviewAnnotation {
  return {
    id,
    kind: 'highlight',
    pageIndex: 0,
    rect: rects[0]!,
    quadPoints: rects,
    contents: id,
    author: 'test',
    createdAt: timestamp,
    modifiedAt: timestamp,
  };
}

describe('owned mark page-space hit testing', () => {
  it('groups multiline rectangles behind one canonical ID and keyboard target', () => {
    const groups = groupOwnedMarkGeometry([
      annotation('multi', [
        { x: 10, y: 10, width: 30, height: 8 },
        { x: 10, y: 20, width: 45, height: 8 },
      ]),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: 'multi', pageIndex: 0, paintOrder: 0 });
    expect(groups[0]?.rects).toHaveLength(2);
    expect(hitTestOwnedMark(groups, { x: 12, y: 24 })).toBe('multi');
  });

  it('resolves overlap by visible paint order and then canonical ID', () => {
    const rect = { x: 10, y: 10, width: 30, height: 20 };
    const groups = groupOwnedMarkGeometry([
      annotation('z-first', [rect]),
      annotation('b-top', [rect]),
      annotation('a-top', [rect]),
    ], () => 4);

    expect(hitTestOwnedMark(groups, { x: 20, y: 20 })).toBe('a-top');
    expect(hitTestOwnedMark(groupOwnedMarkGeometry([
      annotation('under', [rect]),
      annotation('over', [rect]),
    ]), { x: 20, y: 20 })).toBe('over');
  });

  it('activates only a release on the pressed mark and cancels drag, outside, and pointer-cancel', () => {
    const groups = groupOwnedMarkGeometry([
      annotation('mark', [{ x: 10, y: 10, width: 30, height: 20 }]),
    ]);
    const gesture = new OwnedMarkPointerGesture(5);

    gesture.pointerDown(1, { x: 20, y: 20 }, groups);
    expect(gesture.pointerUp(1, { x: 21, y: 20 }, groups)).toBe('mark');

    gesture.pointerDown(2, { x: 20, y: 20 }, groups);
    gesture.pointerMove(2, { x: 28, y: 20 });
    expect(gesture.pointerUp(2, { x: 28, y: 20 }, groups)).toBeUndefined();

    gesture.pointerDown(3, { x: 20, y: 20 }, groups);
    expect(gesture.pointerUp(3, { x: 60, y: 20 }, groups)).toBeUndefined();

    gesture.pointerDown(4, { x: 20, y: 20 }, groups);
    gesture.pointerCancel(4);
    expect(gesture.pointerUp(4, { x: 20, y: 20 }, groups)).toBeUndefined();
  });
});
