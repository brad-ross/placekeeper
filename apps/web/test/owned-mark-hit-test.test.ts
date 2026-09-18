import { describe, expect, it } from 'vitest';

import type { ReviewAnnotation } from '../../../packages/core/src/pdf-writer.js';
import {
  OwnedMarkPointerGesture,
  ScopedOwnedMarkPointerGesture,
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
  it('activates one canonical item from distinct page projection identities', () => {
    const projections = [
      {
        ...annotation('logical-item:projection:1', [{ x: 10, y: 10, width: 30, height: 8 }]),
        reviewItemId: 'logical-item',
        pageIndex: 1,
      },
      {
        ...annotation('logical-item:projection:2', [{ x: 10, y: 20, width: 45, height: 8 }]),
        reviewItemId: 'logical-item',
        pageIndex: 2,
      },
    ] as readonly ReviewAnnotation[];

    const firstPage = groupOwnedMarkGeometry([projections[0]!]);
    const secondPage = groupOwnedMarkGeometry([projections[1]!]);

    expect(firstPage).toMatchObject([{ id: 'logical-item', pageIndex: 1 }]);
    expect(secondPage).toMatchObject([{ id: 'logical-item', pageIndex: 2 }]);
    expect(hitTestOwnedMark(firstPage, { x: 12, y: 12 })).toBe('logical-item');
    expect(hitTestOwnedMark(secondPage, { x: 12, y: 24 })).toBe('logical-item');
  });

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

    gesture.pointerDown(1, 0, { x: 20, y: 20 }, groups);
    expect(gesture.pointerUp(1, 0, { x: 21, y: 20 }, groups)).toBe('mark');

    gesture.pointerDown(2, 0, { x: 20, y: 20 }, groups);
    gesture.pointerMove(2, { x: 28, y: 20 });
    expect(gesture.pointerUp(2, 0, { x: 28, y: 20 }, groups)).toBeUndefined();

    gesture.pointerDown(3, 0, { x: 20, y: 20 }, groups);
    expect(gesture.pointerUp(3, 0, { x: 60, y: 20 }, groups)).toBeUndefined();

    gesture.pointerDown(4, 0, { x: 20, y: 20 }, groups);
    gesture.pointerCancel(4);
    expect(gesture.pointerUp(4, 0, { x: 20, y: 20 }, groups)).toBeUndefined();
  });

  it('never starts or completes activation for a secondary pointer button', () => {
    const groups = groupOwnedMarkGeometry([
      annotation('mark', [{ x: 10, y: 10, width: 30, height: 20 }]),
    ]);
    const gesture = new OwnedMarkPointerGesture(5);

    expect(gesture.pointerDown(1, 2, { x: 20, y: 20 }, groups)).toBeUndefined();
    expect(gesture.pointerUp(1, 2, { x: 20, y: 20 }, groups)).toBeUndefined();

    gesture.pointerDown(2, 0, { x: 20, y: 20 }, groups);
    expect(gesture.pointerUp(2, 2, { x: 20, y: 20 }, groups)).toBeUndefined();
  });

  it('cancels activation when Reference surface or page authority changes', () => {
    const groups = groupOwnedMarkGeometry([
      annotation('mark', [{ x: 10, y: 10, width: 30, height: 20 }]),
    ]);
    const gesture = new ScopedOwnedMarkPointerGesture();
    const first = { surfaceKey: '8:tab-a', pageIndex: 0 };

    gesture.pointerDown(first, 1, 0, { x: 20, y: 20 }, groups);
    expect(gesture.pointerUp(
      { surfaceKey: '8:tab-b', pageIndex: 0 },
      1, 0, { x: 20, y: 20 }, groups,
    )).toBeUndefined();

    gesture.pointerDown(first, 2, 0, { x: 20, y: 20 }, groups);
    expect(gesture.pointerUp(
      { surfaceKey: '8:tab-a', pageIndex: 1 },
      2, 0, { x: 20, y: 20 }, groups,
    )).toBeUndefined();

    gesture.pointerDown(first, 3, 0, { x: 20, y: 20 }, groups);
    gesture.cancel();
    expect(gesture.pointerUp(first, 3, 0, { x: 20, y: 20 }, groups)).toBeUndefined();

    gesture.pointerDown(first, 4, 0, { x: 20, y: 20 }, groups);
    expect(gesture.pointerUp(
      { surfaceKey: '9:tab-a', pageIndex: 0 },
      4, 0, { x: 20, y: 20 }, groups,
    )).toBeUndefined();

    gesture.pointerDown(first, 5, 0, { x: 20, y: 20 }, groups);
    expect(gesture.pointerUp(
      first, 6, 0, { x: 20, y: 20 }, groups,
    )).toBeUndefined();
    expect(gesture.pointerUp(first, 5, 0, { x: 20, y: 20 }, groups)).toBe('mark');
  });
});


describe('saved insertion caret hit area', () => {
  it.each([0.2, 1, 2, 6])('includes the visible caret at zoom %s without moving its anchor', (scale) => {
    const rect = { x: 100, y: 100, width: 2, height: 16 };
    const source = { ...annotation('insert', [rect]), kind: 'insert' as const };
    const groups = groupOwnedMarkGeometry([source]);
    expect(groups[0]?.rects).toEqual([rect]);
    const point = { x: 101 + 3 / scale, y: 116 + 3 / scale };
    expect(hitTestOwnedMark(groups, point, scale)).toBe('insert');
    const gesture = new OwnedMarkPointerGesture();
    expect(gesture.pointerDown(1, 0, point, groups, scale)).toBe('insert');
    expect(gesture.pointerUp(1, 0, point, groups, scale)).toBe('insert');
    expect(hitTestOwnedMark(groups, { x: 101, y: 116 + 9 / scale }, scale)).toBeUndefined();
  });
});
