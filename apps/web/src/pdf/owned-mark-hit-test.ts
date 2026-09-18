import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';
import { reviewItemIdForAnnotation } from '../review/annotation-projection.js';

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
  readonly insertion?: boolean;
}

export function groupOwnedMarkGeometry(
  annotations: readonly ReviewAnnotation[],
  paintOrderForIndex: (index: number) => number = (index) => index,
): OwnedMarkGeometry[] {
  const groups = new Map<string, OwnedMarkGeometry>();
  annotations.forEach((annotation, index) => {
    const reviewItemId = reviewItemIdForAnnotation(annotation);
    const rects = annotation.quadPoints?.length ? annotation.quadPoints : [annotation.rect];
    const current = groups.get(reviewItemId);
    if (current) {
      groups.set(reviewItemId, {
        ...current,
        rects: [...current.rects, ...rects],
        paintOrder: Math.max(current.paintOrder, paintOrderForIndex(index)),
      });
      return;
    }
    groups.set(reviewItemId, {
      id: reviewItemId,
      pageIndex: annotation.pageIndex,
      rects: rects.map((rect) => ({ ...rect })),
      paintOrder: paintOrderForIndex(index),
      ...(annotation.kind === 'insert' ? { insertion: true } : {}),
    });
  });
  return [...groups.values()];
}

export function groupOwnedMarkGeometryByPage(
  annotations: readonly ReviewAnnotation[],
): ReadonlyMap<number, readonly OwnedMarkGeometry[]> {
  const annotationsByPage = new Map<number, ReviewAnnotation[]>();
  for (const annotation of annotations) {
    const page = annotationsByPage.get(annotation.pageIndex);
    if (page) page.push(annotation);
    else annotationsByPage.set(annotation.pageIndex, [annotation]);
  }
  return new Map(
    [...annotationsByPage].map(([pageIndex, pageAnnotations]) => [
      pageIndex,
      groupOwnedMarkGeometry(pageAnnotations),
    ]),
  );
}

function contains(rect: OwnedMarkGeometry['rects'][number], point: OwnedMarkPoint): boolean {
  return point.x >= rect.x && point.y >= rect.y &&
    point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}

export function hitTestOwnedMark(
  groups: readonly OwnedMarkGeometry[],
  point: OwnedMarkPoint,
  scale = 1,
): string | undefined {
  let best: OwnedMarkGeometry | undefined;
  for (const group of groups) {
    if (!group.rects.some((rect) => {
      if (!group.insertion) return contains(rect, point);
      // The visible caret extends below and beside the original narrow anchor.
      // Keep its hit area usable at every zoom without changing saved geometry.
      const padding = 7 / (Number.isFinite(scale) && scale > 0 ? scale : 1);
      return contains({
        x: rect.x - padding,
        y: rect.y,
        width: rect.width + padding * 2,
        height: rect.height + padding,
      }, point);
    })) continue;
    if (
      best === undefined ||
      group.paintOrder > best.paintOrder ||
      (group.paintOrder === best.paintOrder && group.id.localeCompare(best.id) < 0)
    ) best = group;
  }
  return best?.id;
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
    button: number | undefined,
    point: OwnedMarkPoint,
    groups: readonly OwnedMarkGeometry[],
    scale = 1,
  ): string | undefined {
    if (button !== 0) {
      this.#pending = null;
      return undefined;
    }
    const id = hitTestOwnedMark(groups, point, scale);
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
    button: number | undefined,
    point: OwnedMarkPoint,
    groups: readonly OwnedMarkGeometry[],
    scale = 1,
  ): string | undefined {
    const pending = this.#pending;
    this.#pending = null;
    if (button !== 0 || !pending || pending.pointerId !== pointerId || pending.dragged) {
      return undefined;
    }
    return hitTestOwnedMark(groups, point, scale) === pending.id ? pending.id : undefined;
  }

  pointerCancel(pointerId: number): void {
    if (this.#pending?.pointerId === pointerId) this.#pending = null;
  }
}

export interface OwnedMarkGestureScope {
  readonly surfaceKey: string;
  readonly pageIndex: number;
}

function sameOwnedMarkGestureScope(
  first: OwnedMarkGestureScope,
  second: OwnedMarkGestureScope,
): boolean {
  return first.surfaceKey === second.surfaceKey && first.pageIndex === second.pageIndex;
}

/** Binds an owned-mark gesture to its document/tab/page authority. */
export class ScopedOwnedMarkPointerGesture {
  readonly #gesture: OwnedMarkPointerGesture;
  #pending: { readonly pointerId: number; readonly scope: OwnedMarkGestureScope } | null = null;

  constructor(movementThreshold = 5) {
    this.#gesture = new OwnedMarkPointerGesture(movementThreshold);
  }

  pointerDown(
    scope: OwnedMarkGestureScope,
    pointerId: number,
    button: number | undefined,
    point: OwnedMarkPoint,
    groups: readonly OwnedMarkGeometry[],
    scale = 1,
  ): string | undefined {
    const id = this.#gesture.pointerDown(pointerId, button, point, groups, scale);
    this.#pending = id === undefined ? null : { pointerId, scope };
    return id;
  }

  pointerMove(scope: OwnedMarkGestureScope, pointerId: number, point: OwnedMarkPoint): void {
    const pending = this.#pending;
    if (pending === null || pending.pointerId !== pointerId) return;
    if (!sameOwnedMarkGestureScope(pending.scope, scope)) {
      this.cancel();
      return;
    }
    this.#gesture.pointerMove(pointerId, point);
  }

  pointerUp(
    scope: OwnedMarkGestureScope,
    pointerId: number,
    button: number | undefined,
    point: OwnedMarkPoint,
    groups: readonly OwnedMarkGeometry[],
    scale = 1,
  ): string | undefined {
    const pending = this.#pending;
    if (pending !== null && pending.pointerId !== pointerId) return undefined;
    this.#pending = null;
    if (pending === null || !sameOwnedMarkGestureScope(pending.scope, scope)) {
      if (pending !== null) this.#gesture.pointerCancel(pending.pointerId);
      return undefined;
    }
    return this.#gesture.pointerUp(pointerId, button, point, groups, scale);
  }

  pointerCancel(pointerId: number): void {
    if (this.#pending?.pointerId !== pointerId) return;
    this.#pending = null;
    this.#gesture.pointerCancel(pointerId);
  }

  cancel(): void {
    const pending = this.#pending;
    this.#pending = null;
    if (pending !== null) this.#gesture.pointerCancel(pending.pointerId);
  }
}
