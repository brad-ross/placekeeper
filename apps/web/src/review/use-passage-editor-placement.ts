import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';

import { LatestFrameRequest, unionViewerRects } from '../pdf/viewer-framing.js';
import type { ViewerClientPlacement } from '../pdf/viewer-interaction-events.js';

const EDGE = 12;
const RELATION_GAP = 12;
const DEFAULT_WIDTH = 340;
const DEFAULT_HEIGHT = 232;

export type PassageEditorPlacementKind = 'side' | 'above' | 'below' | 'bottom-sheet';

export interface PassageEditorPlacement {
  readonly kind: PassageEditorPlacementKind;
  readonly style?: CSSProperties;
  /** Visibility of the rendered passage as a whole, when its DOM marks are available. */
  readonly targetVisibility?: 'visible' | 'outside';
}

interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface PlacementChoice extends PassageEditorPlacement {
  readonly visible: boolean;
}

function samePlacement(
  current: PassageEditorPlacement | undefined,
  next: PassageEditorPlacement | undefined,
): boolean {
  if (current === next) return true;
  if (current === undefined || next === undefined || current.kind !== next.kind) return false;
  if (current.targetVisibility !== next.targetVisibility) return false;
  const currentStyle = current.style;
  const nextStyle = next.style;
  if (currentStyle === nextStyle) return true;
  if (currentStyle === undefined || nextStyle === undefined) return false;
  const keys = new Set([...Object.keys(currentStyle), ...Object.keys(nextStyle)]);
  return [...keys].every((key) => (
    currentStyle[key as keyof CSSProperties] === nextStyle[key as keyof CSSProperties]
  ));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function intersects(first: RectLike, second: RectLike): boolean {
  return first.right > second.left
    && first.left < second.right
    && first.bottom > second.top
    && first.top < second.bottom;
}

export function choosePassageEditorPlacement(input: {
  readonly stage: RectLike;
  readonly target: RectLike;
  readonly editorWidth: number;
  readonly editorHeight: number;
  readonly rightBoundary?: number;
  readonly bottomBoundary?: number;
  readonly previous?: PassageEditorPlacementKind;
}): PlacementChoice {
  const stageLeft = input.stage.left + EDGE;
  const stageTop = input.stage.top + EDGE;
  const stageRight = Math.min(
    input.stage.right - EDGE,
    input.rightBoundary ?? input.stage.right - EDGE,
  );
  const stageBottom = Math.min(
    input.stage.bottom - EDGE,
    input.bottomBoundary ?? input.stage.bottom - EDGE,
  );
  const visibleRect = {
    left: stageLeft,
    top: stageTop,
    right: stageRight,
    bottom: stageBottom,
    width: Math.max(0, stageRight - stageLeft),
    height: Math.max(0, stageBottom - stageTop),
  };
  const visible = intersects(input.target, visibleRect);
  const width = Math.min(DEFAULT_WIDTH, Math.max(0, visibleRect.width));
  const editorWidth = Math.min(Math.max(0, input.editorWidth), width);
  const editorHeight = Math.min(Math.max(0, input.editorHeight), visibleRect.height);
  const spaceRight = stageRight - input.target.right - RELATION_GAP;
  const spaceLeft = input.target.left - RELATION_GAP - stageLeft;
  const spaceBelow = stageBottom - input.target.bottom - RELATION_GAP;
  const spaceAbove = input.target.top - RELATION_GAP - stageTop;
  const canSide = Math.max(spaceLeft, spaceRight) >= editorWidth;
  const canBelow = spaceBelow >= editorHeight;
  const canAbove = spaceAbove >= editorHeight;
  let kind: PassageEditorPlacementKind;
  if (input.previous === 'side' && canSide) kind = 'side';
  else if (input.previous === 'below' && canBelow) kind = 'below';
  else if (input.previous === 'above' && canAbove) kind = 'above';
  else if (canSide) kind = 'side';
  else if (canBelow) kind = 'below';
  else if (canAbove) kind = 'above';
  else kind = 'bottom-sheet';

  if (kind === 'bottom-sheet') {
    return {
      kind,
      visible,
      style: {
        position: 'absolute',
        left: `${EDGE}px`,
        right: `${Math.max(EDGE, input.stage.right - stageRight)}px`,
        bottom: `${Math.max(EDGE, input.stage.bottom - stageBottom)}px`,
        width: 'auto',
      },
    };
  }

  const localTarget = {
    left: input.target.left - input.stage.left,
    top: input.target.top - input.stage.top,
    right: input.target.right - input.stage.left,
    bottom: input.target.bottom - input.stage.top,
  };
  const localStageLeft = stageLeft - input.stage.left;
  const localStageTop = stageTop - input.stage.top;
  const localStageRight = stageRight - input.stage.left;
  const localStageBottom = stageBottom - input.stage.top;
  const left = kind === 'side'
    ? spaceRight >= editorWidth
      ? localTarget.right + RELATION_GAP
      : localTarget.left - RELATION_GAP - editorWidth
    : clamp(
      localTarget.left + (input.target.width - editorWidth) / 2,
      localStageLeft,
      localStageRight - editorWidth,
    );
  const top = kind === 'side'
    ? clamp(
      localTarget.top + (input.target.height - editorHeight) / 2,
      localStageTop,
      localStageBottom - editorHeight,
    )
    : kind === 'below'
      ? localTarget.bottom + RELATION_GAP
      : localTarget.top - RELATION_GAP - editorHeight;
  return {
    kind,
    visible,
    style: {
      position: 'absolute',
      left: `${left}px`,
      top: `${top}px`,
      width: `${editorWidth}px`,
      maxHeight: `${Math.max(0, localStageBottom - top)}px`,
    },
  };
}

function safePassageEditorPlacement(input: {
  readonly stage: RectLike;
  readonly editorWidth: number;
  readonly editorHeight: number;
  readonly rightBoundary?: number;
  readonly bottomBoundary?: number;
}): PassageEditorPlacement {
  const localRight = Math.min(
    input.stage.width - EDGE,
    (input.rightBoundary ?? input.stage.right - EDGE) - input.stage.left,
  );
  const localBottom = Math.min(
    input.stage.height - EDGE,
    (input.bottomBoundary ?? input.stage.bottom - EDGE) - input.stage.top,
  );
  const width = Math.min(input.editorWidth, DEFAULT_WIDTH, Math.max(0, localRight - EDGE));
  const height = Math.min(input.editorHeight, Math.max(0, localBottom - EDGE));
  return {
    kind: 'side',
    style: {
      position: 'absolute',
      left: `${Math.max(EDGE, localRight - width)}px`,
      top: `${EDGE}px`,
      width: `${width}px`,
      maxHeight: `${height}px`,
    },
  };
}

function reclampPassageEditorPlacement(input: {
  readonly previous: PassageEditorPlacement;
  readonly stage: RectLike;
  readonly editorWidth: number;
  readonly editorHeight: number;
  readonly rightBoundary?: number;
  readonly bottomBoundary?: number;
}): PassageEditorPlacement {
  const localRight = Math.min(
    input.stage.width - EDGE,
    (input.rightBoundary ?? input.stage.right - EDGE) - input.stage.left,
  );
  const localBottom = Math.min(
    input.stage.height - EDGE,
    (input.bottomBoundary ?? input.stage.bottom - EDGE) - input.stage.top,
  );
  if (input.previous.kind === 'bottom-sheet') {
    return {
      kind: 'bottom-sheet',
      style: {
        position: 'absolute',
        left: `${EDGE}px`,
        right: `${Math.max(EDGE, input.stage.width - localRight)}px`,
        bottom: `${Math.max(EDGE, input.stage.height - localBottom)}px`,
        width: 'auto',
      },
    };
  }
  const previousLeft = Number.parseFloat(String(input.previous.style?.left ?? EDGE));
  const previousTop = Number.parseFloat(String(input.previous.style?.top ?? EDGE));
  const left = clamp(previousLeft, EDGE, localRight - input.editorWidth);
  const top = clamp(previousTop, EDGE, localBottom - input.editorHeight);
  return {
    kind: input.previous.kind,
    style: {
      position: 'absolute',
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.min(input.editorWidth, Math.max(0, localRight - EDGE))}px`,
      maxHeight: `${Math.max(0, localBottom - top)}px`,
    },
  };
}

function placementRect(placement: ViewerClientPlacement): RectLike {
  const width = Math.max(1, placement.width ?? 1);
  const height = Math.max(1, placement.height ?? 1);
  return {
    left: placement.left - width / 2,
    top: placement.top - height / 2,
    right: placement.left + width / 2,
    bottom: placement.top + height / 2,
    width,
    height,
  };
}

export function usePassageEditorPlacement(input: {
  readonly active: boolean;
  readonly anchorKey: string | null;
  readonly stageRef: RefObject<HTMLElement | null>;
  readonly surfaceRefs: readonly RefObject<HTMLElement | null>[];
  readonly editorElement: HTMLElement | null;
  readonly targetSelector?: string;
  readonly fallbackTarget?: ViewerClientPlacement | null;
  readonly layoutGeneration: string | number;
}): PassageEditorPlacement | undefined {
  const [placement, setPlacement] = useState<PassageEditorPlacement | undefined>(undefined);
  const lastVisiblePlacementRef = useRef<PassageEditorPlacement | undefined>(undefined);
  const preferredKindRef = useRef<{
    readonly anchorKey: string;
    readonly kind: PassageEditorPlacementKind;
  } | undefined>(undefined);
  const commitPlacement = (next: PassageEditorPlacement | undefined) => {
    setPlacement((current) => samePlacement(current, next) ? current : next);
  };

  useLayoutEffect(() => {
    if (!input.active || input.anchorKey === null) {
      commitPlacement(undefined);
      lastVisiblePlacementRef.current = undefined;
      preferredKindRef.current = undefined;
      return;
    }
    const stage = input.stageRef.current;
    if (stage === null) return;
    const surfaces = input.surfaceRefs
      .map((ref) => ref.current)
      .filter((surface): surface is HTMLElement => surface !== null);
    const scrollport = stage.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
    const commit = () => {
      const stageBounds = stage.getBoundingClientRect();
      let rightBoundary: number | undefined;
      let bottomBoundary: number | undefined;
      for (const surface of surfaces) {
        const open = surface.dataset.workspaceOpen === 'true'
          || surface.dataset.toolsWorkspaceOpen === 'true';
        if (!open) continue;
        const bounds = surface.getBoundingClientRect();
        if (surface.dataset.workspacePresentation === 'bottom') {
          bottomBoundary = Math.min(bottomBoundary ?? stageBounds.bottom, bounds.top - EDGE);
        } else {
          rightBoundary = Math.min(rightBoundary ?? stageBounds.right, bounds.left - EDGE);
        }
      }
      const visualViewport = globalThis.visualViewport;
      if (visualViewport !== null) {
        const viewportRight = visualViewport.offsetLeft + visualViewport.width - EDGE;
        const viewportBottom = visualViewport.offsetTop + visualViewport.height - EDGE;
        rightBoundary = Math.min(rightBoundary ?? stageBounds.right - EDGE, viewportRight);
        bottomBoundary = Math.min(bottomBoundary ?? stageBounds.bottom - EDGE, viewportBottom);
      }
      const editorBounds = input.editorElement?.getBoundingClientRect();
      const targetElements = input.targetSelector === undefined
        ? []
        : [...stage.querySelectorAll<HTMLElement>(input.targetSelector)];
      const targetRects = targetElements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
          width: bounds.width,
          height: bounds.height,
        };
      });
      const usable = {
        left: stageBounds.left + EDGE,
        top: stageBounds.top + EDGE,
        right: rightBoundary ?? stageBounds.right - EDGE,
        bottom: bottomBoundary ?? stageBounds.bottom - EDGE,
        width: 0,
        height: 0,
      };
      const visibleTargets = targetRects.filter((rect) => intersects(rect, usable));
      const targetVisibility = targetRects.length === 0
        ? undefined
        : visibleTargets.length > 0 ? 'visible' as const : 'outside' as const;
      const measuredPlacement = (next: PassageEditorPlacement): PassageEditorPlacement => ({
        ...next,
        ...(targetVisibility === undefined ? {} : { targetVisibility }),
      });
      const fallback = input.fallbackTarget === null || input.fallbackTarget === undefined
        ? null
        : placementRect(input.fallbackTarget);
      const activeTarget = visibleTargets.length <= 1
        ? visibleTargets[0] ?? null
        : fallback === null
          ? visibleTargets[0]!
          : visibleTargets.reduce((nearest, candidate) => {
              const distance = (rect: RectLike) => (
                (rect.left + rect.right - fallback.left - fallback.right) ** 2
                + (rect.top + rect.bottom - fallback.top - fallback.bottom) ** 2
              );
              return distance(candidate) < distance(nearest) ? candidate : nearest;
            });
      const targetUnion = activeTarget === null && targetRects.length > 0
        ? unionViewerRects(targetRects)
        : null;
      const target = activeTarget
        ?? (targetUnion === null ? fallback : {
            ...targetUnion,
            width: targetUnion.right - targetUnion.left,
            height: targetUnion.bottom - targetUnion.top,
          });
      if (target === null || !intersects(target, usable)) {
        if (lastVisiblePlacementRef.current === undefined) {
          const safe = safePassageEditorPlacement({
            stage: stageBounds,
            // A rendered width can already include a preceding responsive
            // clamp. Reusing it as the preferred width makes the editor
            // permanently narrow after the stage grows again.
            editorWidth: DEFAULT_WIDTH,
            editorHeight: editorBounds?.height || DEFAULT_HEIGHT,
            ...(rightBoundary === undefined ? {} : { rightBoundary }),
            ...(bottomBoundary === undefined ? {} : { bottomBoundary }),
          });
          lastVisiblePlacementRef.current = safe;
          commitPlacement(measuredPlacement(safe));
          return;
        }
        commitPlacement(measuredPlacement(reclampPassageEditorPlacement({
          previous: lastVisiblePlacementRef.current,
          stage: stageBounds,
          editorWidth: DEFAULT_WIDTH,
          editorHeight: editorBounds?.height || DEFAULT_HEIGHT,
          ...(rightBoundary === undefined ? {} : { rightBoundary }),
          ...(bottomBoundary === undefined ? {} : { bottomBoundary }),
        })));
        return;
      }
      const choice = choosePassageEditorPlacement({
        stage: stageBounds,
        target,
        editorWidth: DEFAULT_WIDTH,
        editorHeight: editorBounds?.height || DEFAULT_HEIGHT,
        ...(rightBoundary === undefined ? {} : { rightBoundary }),
        ...(bottomBoundary === undefined ? {} : { bottomBoundary }),
        ...(preferredKindRef.current?.anchorKey === input.anchorKey
          ? { previous: preferredKindRef.current.kind }
          : {}),
      });
      if (!choice.visible && lastVisiblePlacementRef.current !== undefined) {
        commitPlacement(measuredPlacement(lastVisiblePlacementRef.current));
        return;
      }
      const next: PassageEditorPlacement = {
        kind: choice.kind,
        ...(choice.style === undefined ? {} : { style: choice.style }),
        ...(targetVisibility === undefined ? {} : { targetVisibility }),
      };
      preferredKindRef.current = { anchorKey: input.anchorKey!, kind: choice.kind };
      lastVisiblePlacementRef.current = next;
      commitPlacement(next);
    };
    const scheduler = new LatestFrameRequest<number>({
      schedule: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => cancelAnimationFrame(handle),
      commit,
    });
    let revision = 0;
    const schedule = () => scheduler.publish(++revision);
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(schedule);
    resizeObserver?.observe(stage);
    if (scrollport !== null) resizeObserver?.observe(scrollport);
    if (input.editorElement !== null) resizeObserver?.observe(input.editorElement);
    for (const surface of surfaces) resizeObserver?.observe(surface);
    scrollport?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    globalThis.visualViewport?.addEventListener('resize', schedule);
    globalThis.visualViewport?.addEventListener('scroll', schedule);
    // The editor first mounts without a measured element. Place it during the
    // layout phase so that default grid positioning cannot reach a painted
    // frame; subsequent geometry changes remain coalesced by animation frame.
    commit();
    return () => {
      scheduler.cancel();
      resizeObserver?.disconnect();
      scrollport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      globalThis.visualViewport?.removeEventListener('resize', schedule);
      globalThis.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [
    input.active,
    input.anchorKey,
    input.editorElement,
    input.fallbackTarget,
    input.layoutGeneration,
    input.stageRef,
    input.surfaceRefs,
    input.targetSelector,
  ]);

  return placement;
}
