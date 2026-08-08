import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';

export interface OwnedMarkPoint {
  readonly x: number;
  readonly y: number;
}

export interface OwnedMarkGeometry {
  readonly id: string;
  readonly pageIndex: number;
  readonly rects: readonly {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[];
  readonly paintOrder: number;
}

export function groupOwnedMarkGeometry(
  annotations: readonly ReviewAnnotation[],
  paintOrderForIndex: (index: number) => number = (index) => index,
): OwnedMarkGeometry[] {
  const groups = new Map<string, OwnedMarkGeometry>();
  annotations.forEach((annotation, index) => {
    const rects = annotation.quadPoints?.length ? annotation.quadPoints : [annotation.rect];
    const current = groups.get(annotation.id);
    if (current) {
      groups.set(annotation.id, {
        ...current,
        rects: [...current.rects, ...rects],
        paintOrder: Math.max(current.paintOrder, paintOrderForIndex(index)),
      });
      return;
    }
    groups.set(annotation.id, {
      id: annotation.id,
      pageIndex: annotation.pageIndex,
      rects: rects.map((rect) => ({ ...rect })),
      paintOrder: paintOrderForIndex(index),
    });
  });
  return [...groups.values()];
}

function contains(rect: OwnedMarkGeometry['rects'][number], point: OwnedMarkPoint): boolean {
  return point.x >= rect.x && point.y >= rect.y &&
    point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}

export function hitTestOwnedMark(
  groups: readonly OwnedMarkGeometry[],
  point: OwnedMarkPoint,
): string | undefined {
  return groups
    .filter((group) => group.rects.some((rect) => contains(rect, point)))
    .toSorted((left, right) => right.paintOrder - left.paintOrder || left.id.localeCompare(right.id))[0]
    ?.id;
}

interface PendingGesture {
  readonly pointerId: number;
  readonly id: string;
  readonly start: OwnedMarkPoint;
  dragged: boolean;
}

/** Keeps mark activation orthogonal to the viewer's drag-selection behavior. */
export class OwnedMarkPointerGesture {
  #pending: PendingGesture | null = null;

  constructor(readonly movementThreshold = 5) {}

  pointerDown(
    pointerId: number,
    point: OwnedMarkPoint,
    groups: readonly OwnedMarkGeometry[],
  ): string | undefined {
    const id = hitTestOwnedMark(groups, point);
    this.#pending = id === undefined ? null : { pointerId, id, start: point, dragged: false };
    return id;
  }

  pointerMove(pointerId: number, point: OwnedMarkPoint): void {
    const pending = this.#pending;
    if (!pending || pending.pointerId !== pointerId) return;
    if (Math.hypot(point.x - pending.start.x, point.y - pending.start.y) > this.movementThreshold) {
      pending.dragged = true;
    }
  }

  pointerUp(
    pointerId: number,
    point: OwnedMarkPoint,
    groups: readonly OwnedMarkGeometry[],
  ): string | undefined {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending || pending.pointerId !== pointerId || pending.dragged) return undefined;
    return hitTestOwnedMark(groups, point) === pending.id ? pending.id : undefined;
  }

  pointerCancel(pointerId: number): void {
    if (this.#pending?.pointerId === pointerId) this.#pending = null;
  }
}
