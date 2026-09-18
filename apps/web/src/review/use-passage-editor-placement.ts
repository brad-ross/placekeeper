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
const MIN_REFERENCE_POPUP_WIDTH = 280;
const MIN_REFERENCE_POPUP_HEIGHT = 180;

export type PassageEditorPlacementKind = 'side' | 'above' | 'below' | 'bottom-sheet';

export interface PassageEditorPlacement {
  readonly kind: PassageEditorPlacementKind;
  readonly style?: CSSProperties;
  /** Visibility of the rendered passage as a whole, when its DOM marks are available. */
  readonly targetVisibility?: 'visible' | 'outside';
}

interface PassageEditorPlacementSnapshot {
  readonly anchorKey: string;
  readonly placementScope: 'main' | 'reference';
  readonly placement: PassageEditorPlacement;
}

export function passageEditorPlacementForRequest(input: {
  readonly snapshot: PassageEditorPlacementSnapshot | undefined;
  readonly anchorKey: string | null;
  readonly placementScope?: 'main' | 'reference';
}): PassageEditorPlacement | undefined {
  const placementScope = input.placementScope ?? 'main';
  return input.anchorKey !== null
    && input.snapshot?.anchorKey === input.anchorKey
    && input.snapshot.placementScope === placementScope
    ? input.snapshot.placement
    : undefined;
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
  readonly applicationLeftBoundary?: number;
  readonly applicationTopBoundary?: number;
  readonly applicationRightBoundary?: number;
  readonly applicationBottomBoundary?: number;
  readonly previous?: PassageEditorPlacementKind;
  readonly placementScope?: 'main' | 'reference';
}): PlacementChoice {
  const stageLeft = Math.max(input.stage.left + EDGE, input.applicationLeftBoundary ?? -Infinity);
  const stageTop = Math.max(input.stage.top + EDGE, input.applicationTopBoundary ?? -Infinity);
  const stageRight = Math.min(
    input.stage.right - EDGE,
    input.applicationRightBoundary ?? input.stage.right - EDGE,
    input.placementScope === 'reference'
      ? input.stage.right - EDGE
      : input.rightBoundary ?? input.stage.right - EDGE,
  );
  const stageBottom = Math.min(
    input.stage.bottom - EDGE,
    input.applicationBottomBoundary ?? input.stage.bottom - EDGE,
    input.placementScope === 'reference'
      ? input.stage.bottom - EDGE
      : input.bottomBoundary ?? input.stage.bottom - EDGE,
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
  const popupFitHeight = input.placementScope === 'reference'
    ? Math.max(editorHeight, MIN_REFERENCE_POPUP_HEIGHT)
    : editorHeight;
  const usablePopup = input.placementScope !== 'reference'
    || (editorWidth >= MIN_REFERENCE_POPUP_WIDTH
      && visibleRect.height >= MIN_REFERENCE_POPUP_HEIGHT);
  const spaceRight = stageRight - input.target.right - RELATION_GAP;
  const spaceLeft = input.target.left - RELATION_GAP - stageLeft;
  const spaceBelow = stageBottom - input.target.bottom - RELATION_GAP;
  const spaceAbove = input.target.top - RELATION_GAP - stageTop;
  const canSide = usablePopup && Math.max(spaceLeft, spaceRight) >= editorWidth;
  const canBelow = usablePopup && spaceBelow >= popupFitHeight;
  const canAbove = usablePopup && spaceAbove >= popupFitHeight;
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
        left: `${Math.max(EDGE, stageLeft - input.stage.left)}px`,
        right: `${Math.max(EDGE, input.stage.right - stageRight)}px`,
        bottom: `${Math.max(EDGE, input.stage.bottom - stageBottom)}px`,
        width: 'auto',
        ...(input.placementScope === 'reference' ? {
          maxHeight: `${visibleRect.height}px`,
        } : {}),
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
  readonly applicationLeftBoundary?: number;
  readonly applicationTopBoundary?: number;
  readonly applicationRightBoundary?: number;
  readonly applicationBottomBoundary?: number;
  readonly placementScope?: 'main' | 'reference';
}): PassageEditorPlacement {
  const localLeft = Math.max(
    EDGE,
    (input.applicationLeftBoundary ?? input.stage.left + EDGE) - input.stage.left,
  );
  const localTop = Math.max(
    EDGE,
    (input.applicationTopBoundary ?? input.stage.top + EDGE) - input.stage.top,
  );
  const localRight = Math.min(
    input.stage.width - EDGE,
    (input.applicationRightBoundary ?? input.stage.right - EDGE) - input.stage.left,
    (input.rightBoundary ?? input.stage.right - EDGE) - input.stage.left,
  );
  const localBottom = Math.min(
    input.stage.height - EDGE,
    (input.applicationBottomBoundary ?? input.stage.bottom - EDGE) - input.stage.top,
    (input.bottomBoundary ?? input.stage.bottom - EDGE) - input.stage.top,
  );
  const width = Math.min(input.editorWidth, DEFAULT_WIDTH, Math.max(0, localRight - localLeft));
  const height = Math.min(input.editorHeight, Math.max(0, localBottom - localTop));
  const availableHeight = Math.max(0, localBottom - localTop);
  if (input.placementScope === 'reference'
    && (width < MIN_REFERENCE_POPUP_WIDTH || availableHeight < MIN_REFERENCE_POPUP_HEIGHT)) {
    return {
      kind: 'bottom-sheet',
      style: {
        position: 'absolute',
        left: `${localLeft}px`,
        right: `${Math.max(EDGE, input.stage.width - localRight)}px`,
        bottom: `${Math.max(EDGE, input.stage.height - localBottom)}px`,
        width: 'auto',
        maxHeight: `${availableHeight}px`,
      },
    };
  }
  return {
    kind: 'side',
    style: {
      position: 'absolute',
      left: `${Math.max(localLeft, localRight - width)}px`,
      top: `${localTop}px`,
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
  readonly applicationLeftBoundary?: number;
  readonly applicationTopBoundary?: number;
  readonly applicationRightBoundary?: number;
  readonly applicationBottomBoundary?: number;
  readonly placementScope?: 'main' | 'reference';
}): PassageEditorPlacement {
  const localLeft = Math.max(
    EDGE,
    (input.applicationLeftBoundary ?? input.stage.left + EDGE) - input.stage.left,
  );
  const localTop = Math.max(
    EDGE,
    (input.applicationTopBoundary ?? input.stage.top + EDGE) - input.stage.top,
  );
  const localRight = Math.min(
    input.stage.width - EDGE,
    (input.applicationRightBoundary ?? input.stage.right - EDGE) - input.stage.left,
    (input.rightBoundary ?? input.stage.right - EDGE) - input.stage.left,
  );
  const localBottom = Math.min(
    input.stage.height - EDGE,
    (input.applicationBottomBoundary ?? input.stage.bottom - EDGE) - input.stage.top,
    (input.bottomBoundary ?? input.stage.bottom - EDGE) - input.stage.top,
  );
  const availableWidth = Math.max(0, localRight - localLeft);
  const availableHeight = Math.max(0, localBottom - localTop);
  if (input.previous.kind === 'bottom-sheet'
    || (input.placementScope === 'reference'
      && (availableWidth < MIN_REFERENCE_POPUP_WIDTH
        || availableHeight < MIN_REFERENCE_POPUP_HEIGHT))) {
    return {
      kind: 'bottom-sheet',
      style: {
        position: 'absolute',
        left: `${localLeft}px`,
        right: `${Math.max(EDGE, input.stage.width - localRight)}px`,
        bottom: `${Math.max(EDGE, input.stage.height - localBottom)}px`,
        width: 'auto',
        ...(input.placementScope === 'reference' ? { maxHeight: `${availableHeight}px` } : {}),
      },
    };
  }
  const previousLeft = Number.parseFloat(String(input.previous.style?.left ?? EDGE));
  const previousTop = Number.parseFloat(String(input.previous.style?.top ?? EDGE));
  const left = clamp(previousLeft, localLeft, localRight - input.editorWidth);
  const top = clamp(previousTop, localTop, localBottom - input.editorHeight);
  return {
    kind: input.previous.kind,
    style: {
      position: 'absolute',
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.min(input.editorWidth, Math.max(0, localRight - localLeft))}px`,
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
  readonly placementScope?: 'main' | 'reference';
  readonly scrollportSelector?: string;
}): PassageEditorPlacement | undefined {
  const [placementSnapshot, setPlacementSnapshot] = useState<
    PassageEditorPlacementSnapshot | undefined
  >(undefined);
  const lastVisiblePlacementRef = useRef<PassageEditorPlacement | undefined>(undefined);
  const measurementRequestRef = useRef<{
    readonly anchorKey: string;
    readonly placementScope: 'main' | 'reference';
  } | undefined>(undefined);
  const preferredKindRef = useRef<PassageEditorPlacementKind | undefined>(undefined);
  const commitPlacement = (
    anchorKey: string,
    placementScope: 'main' | 'reference',
    next: PassageEditorPlacement,
  ) => {
    setPlacementSnapshot((current) => (
      current?.anchorKey === anchorKey
      && current.placementScope === placementScope
      && samePlacement(current.placement, next)
        ? current
        : { anchorKey, placementScope, placement: next }
    ));
  };

  useLayoutEffect(() => {
    if (!input.active || input.anchorKey === null) {
      setPlacementSnapshot(undefined);
      lastVisiblePlacementRef.current = undefined;
      measurementRequestRef.current = undefined;
      preferredKindRef.current = undefined;
      return;
    }
    const stage = input.stageRef.current;
    if (stage === null) return;
    const surfaces = input.surfaceRefs
      .map((ref) => ref.current)
      .filter((surface): surface is HTMLElement => surface !== null);
    const placementScope = input.placementScope ?? 'main';
    const anchorKey = input.anchorKey;
    const measurementRequest = measurementRequestRef.current;
    if (measurementRequest === undefined
      || measurementRequest.anchorKey !== anchorKey
      || measurementRequest.placementScope !== placementScope) {
      measurementRequestRef.current = { anchorKey, placementScope };
      lastVisiblePlacementRef.current = undefined;
      preferredKindRef.current = undefined;
    }
    const scrollport = stage.querySelector<HTMLElement>(
      input.scrollportSelector ?? '[data-viewer-framing-viewport]',
    );
    const commit = () => {
      const stageBounds = stage.getBoundingClientRect();
      let rightBoundary: number | undefined;
      let bottomBoundary: number | undefined;
      let applicationLeftBoundary: number | undefined;
      let applicationTopBoundary: number | undefined;
      let applicationRightBoundary: number | undefined;
      let applicationBottomBoundary: number | undefined;
      for (const surface of placementScope === 'reference' ? [] : surfaces) {
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
        applicationLeftBoundary = visualViewport.offsetLeft + EDGE;
        applicationTopBoundary = visualViewport.offsetTop + EDGE;
        applicationRightBoundary = visualViewport.offsetLeft + visualViewport.width - EDGE;
        applicationBottomBoundary = visualViewport.offsetTop + visualViewport.height - EDGE;
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
        left: Math.max(stageBounds.left + EDGE, applicationLeftBoundary ?? -Infinity),
        top: Math.max(stageBounds.top + EDGE, applicationTopBoundary ?? -Infinity),
        right: Math.min(
          stageBounds.right - EDGE,
          applicationRightBoundary ?? stageBounds.right - EDGE,
          placementScope === 'reference'
            ? stageBounds.right - EDGE
            : rightBoundary ?? stageBounds.right - EDGE,
        ),
        bottom: Math.min(
          stageBounds.bottom - EDGE,
          applicationBottomBoundary ?? stageBounds.bottom - EDGE,
          placementScope === 'reference'
            ? stageBounds.bottom - EDGE
            : bottomBoundary ?? stageBounds.bottom - EDGE,
        ),
        width: 0,
        height: 0,
      };
      const scrollportBounds = scrollport?.getBoundingClientRect();
      const visibilityBounds = placementScope === 'reference' && scrollportBounds !== undefined
        ? {
            left: scrollportBounds.left,
            top: scrollportBounds.top,
            right: scrollportBounds.right,
            bottom: scrollportBounds.bottom,
            width: scrollportBounds.width,
            height: scrollportBounds.height,
          }
        : usable;
      const visibleTargets = targetRects.filter((rect) => intersects(rect, visibilityBounds));
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
            ...(applicationLeftBoundary === undefined ? {} : { applicationLeftBoundary }),
            ...(applicationTopBoundary === undefined ? {} : { applicationTopBoundary }),
            ...(applicationRightBoundary === undefined ? {} : { applicationRightBoundary }),
            ...(applicationBottomBoundary === undefined ? {} : { applicationBottomBoundary }),
            placementScope,
          });
          lastVisiblePlacementRef.current = safe;
          commitPlacement(anchorKey, placementScope, measuredPlacement(safe));
          return;
        }
        commitPlacement(
          anchorKey,
          placementScope,
          measuredPlacement(reclampPassageEditorPlacement({
            previous: lastVisiblePlacementRef.current,
            stage: stageBounds,
            editorWidth: DEFAULT_WIDTH,
            editorHeight: editorBounds?.height || DEFAULT_HEIGHT,
            ...(rightBoundary === undefined ? {} : { rightBoundary }),
            ...(bottomBoundary === undefined ? {} : { bottomBoundary }),
            ...(applicationLeftBoundary === undefined ? {} : { applicationLeftBoundary }),
            ...(applicationTopBoundary === undefined ? {} : { applicationTopBoundary }),
            ...(applicationRightBoundary === undefined ? {} : { applicationRightBoundary }),
            ...(applicationBottomBoundary === undefined ? {} : { applicationBottomBoundary }),
            placementScope,
          })),
        );
        return;
      }
      const choice = choosePassageEditorPlacement({
        stage: stageBounds,
        target,
        editorWidth: DEFAULT_WIDTH,
        editorHeight: editorBounds?.height || DEFAULT_HEIGHT,
        ...(rightBoundary === undefined ? {} : { rightBoundary }),
        ...(bottomBoundary === undefined ? {} : { bottomBoundary }),
        ...(applicationLeftBoundary === undefined ? {} : { applicationLeftBoundary }),
        ...(applicationTopBoundary === undefined ? {} : { applicationTopBoundary }),
        ...(applicationRightBoundary === undefined ? {} : { applicationRightBoundary }),
        ...(applicationBottomBoundary === undefined ? {} : { applicationBottomBoundary }),
        placementScope,
        ...(preferredKindRef.current === undefined ? {} : { previous: preferredKindRef.current }),
      });
      if (!choice.visible && lastVisiblePlacementRef.current !== undefined) {
        commitPlacement(
          anchorKey,
          placementScope,
          measuredPlacement(lastVisiblePlacementRef.current),
        );
        return;
      }
      const next: PassageEditorPlacement = {
        kind: choice.kind,
        ...(choice.style === undefined ? {} : { style: choice.style }),
        ...(targetVisibility === undefined ? {} : { targetVisibility }),
      };
      preferredKindRef.current = choice.kind;
      lastVisiblePlacementRef.current = next;
      commitPlacement(anchorKey, placementScope, next);
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
    // Resolve the initial placement in the layout phase so the deferred surface
    // never reaches a painted frame at its default grid position.
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
    input.placementScope,
    input.scrollportSelector,
    input.stageRef,
    input.surfaceRefs,
    input.targetSelector,
  ]);

  return input.active
    ? passageEditorPlacementForRequest({
        snapshot: placementSnapshot,
        anchorKey: input.anchorKey,
        placementScope: input.placementScope ?? 'main',
      })
    : undefined;
}
