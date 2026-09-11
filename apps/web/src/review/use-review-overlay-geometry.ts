import {
  useLayoutEffect,
  useState,
  useRef,
  type CSSProperties,
  type RefObject,
} from 'react';

import { LatestFrameRequest } from '../pdf/viewer-framing.js';
import { isZoomAnimationActive } from '../pdf/anchored-zoom.js';

export const REVIEW_OVERLAY_INSET = 12;
export const REVIEW_OVERLAY_FADE_SIZE = 12;
export const REVIEW_COLLAPSED_RAIL_SIZE = 40;

interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface ScrollportLike {
  readonly offsetWidth: number;
  readonly offsetHeight: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

export interface ReviewOverlayGeometry {
  readonly rightStart: number | null;
  readonly bottomStart: number | null;
  readonly outsideInset: number;
  readonly scrollbarWidth: number;
  readonly scrollbarHeight: number;
  readonly fadeTop: boolean;
  readonly fadeRight: boolean;
  readonly fadeBottom: boolean;
}

export function measureReviewOverlayGeometry(input: {
  readonly stage: RectLike;
  readonly surfaces: readonly {
    readonly open: boolean;
    readonly presentation: 'right' | 'bottom';
    readonly bounds: RectLike;
  }[];
  readonly scrollport?: ScrollportLike | null;
}): ReviewOverlayGeometry {
  const scrollbarWidth = input.scrollport === null || input.scrollport === undefined
    ? 0
    : Math.max(0, input.scrollport.offsetWidth - input.scrollport.clientWidth);
  const scrollbarHeight = input.scrollport === null || input.scrollport === undefined
    ? 0
    : Math.max(0, input.scrollport.offsetHeight - input.scrollport.clientHeight);
  const outsideInset = Math.max(REVIEW_OVERLAY_INSET, scrollbarWidth, scrollbarHeight);
  let rightStart: number | null = null;
  let bottomStart: number | null = null;

  for (const surface of input.surfaces) {
    if (!surface.open || surface.bounds.width <= 0 || surface.bounds.height <= 0) continue;
    if (surface.presentation === 'right') {
      const start = Math.max(0, surface.bounds.left - input.stage.left - REVIEW_OVERLAY_INSET);
      rightStart = rightStart === null ? start : Math.min(rightStart, start);
    } else {
      const start = Math.max(0, surface.bounds.top - input.stage.top - REVIEW_OVERLAY_INSET);
      bottomStart = bottomStart === null ? start : Math.min(bottomStart, start);
    }
  }

  const horizontalMaximum = input.scrollport === null || input.scrollport === undefined
    ? 0
    : Math.max(0, input.scrollport.scrollWidth - input.scrollport.clientWidth);
  const verticalMaximum = input.scrollport === null || input.scrollport === undefined
    ? 0
    : Math.max(0, input.scrollport.scrollHeight - input.scrollport.clientHeight);
  return {
    rightStart,
    bottomStart,
    outsideInset,
    scrollbarWidth,
    scrollbarHeight,
    fadeTop: (input.scrollport?.scrollTop ?? 0) > 1,
    fadeRight: horizontalMaximum > 1
      && (input.scrollport?.scrollLeft ?? 0) < horizontalMaximum - 1,
    fadeBottom: verticalMaximum > 1
      && (input.scrollport?.scrollTop ?? 0) < verticalMaximum - 1,
  };
}

const EMPTY_GEOMETRY: ReviewOverlayGeometry = {
  rightStart: null,
  bottomStart: null,
  outsideInset: REVIEW_OVERLAY_INSET,
  scrollbarWidth: 0,
  scrollbarHeight: 0,
  fadeTop: false,
  fadeRight: false,
  fadeBottom: false,
};

function sameGeometry(left: ReviewOverlayGeometry, right: ReviewOverlayGeometry): boolean {
  return Object.keys(left).every((key) => (
    left[key as keyof ReviewOverlayGeometry] === right[key as keyof ReviewOverlayGeometry]
  ));
}

export function useReviewOverlayGeometry(input: {
  readonly stageRef: RefObject<HTMLElement | null>;
  readonly surfaceRefs: readonly RefObject<HTMLElement | null>[];
  readonly layoutGeneration: string | number;
  readonly isFitToWidth?: () => boolean;
}): {
  readonly geometry: ReviewOverlayGeometry;
  readonly fitWidthCurrent: boolean;
  readonly horizontalScrollAvailable: boolean;
  readonly style: CSSProperties;
} {
  const fitQuery = useRef(input.isFitToWidth);
  fitQuery.current = input.isFitToWidth;
  const [zoomActions, setZoomActions] = useState({ fitWidthCurrent: false, horizontalScrollAvailable: false });
  const [geometry, setGeometry] = useState<ReviewOverlayGeometry>(EMPTY_GEOMETRY);

  useLayoutEffect(() => {
    const stage = input.stageRef.current;
    if (stage === null) return;
    const currentSurfaces = () => input.surfaceRefs
      .map((ref) => ref.current)
      .filter((surface): surface is HTMLElement => surface !== null);
    const currentScrollport = () => (
      stage.querySelector<HTMLElement>('[data-viewer-framing-viewport]')
    );
    let observedScrollport: HTMLElement | null = null;
    const scheduler = new LatestFrameRequest<number>({
      schedule: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => cancelAnimationFrame(handle),
      commit: () => {
        const scrollport = currentScrollport();
        if (scrollport !== observedScrollport) {
          if (observedScrollport !== null) resizeObserver?.unobserve(observedScrollport);
          if (scrollport !== null) resizeObserver?.observe(scrollport);
          observedScrollport = scrollport;
        }
        const stageBounds = stage.getBoundingClientRect();
        const next = measureReviewOverlayGeometry({
          stage: stageBounds,
          surfaces: currentSurfaces().map((surface) => ({
            open: surface.dataset.workspaceOpen === 'true'
              || surface.dataset.toolsWorkspaceOpen === 'true',
            presentation: surface.dataset.workspacePresentation === 'bottom'
              ? 'bottom'
              : 'right',
            bounds: surface.getBoundingClientRect(),
          })),
          scrollport,
        });
        // The zoom transform can temporarily overflow an otherwise fitted page.
        // Animation completion/cancellation schedules a settled measurement.
        if (scrollport === null || !isZoomAnimationActive(scrollport)) {
          const fitWidthCurrent = fitQuery.current?.() ?? false;
          const horizontalScrollAvailable = scrollport !== null && scrollport.scrollWidth - scrollport.clientWidth > 1;
          setZoomActions((current) => current.fitWidthCurrent === fitWidthCurrent
            && current.horizontalScrollAvailable === horizontalScrollAvailable
            ? current : { fitWidthCurrent, horizontalScrollAvailable });
        }
        setGeometry((current) => sameGeometry(current, next) ? current : next);
        // Transforms move a sliding tray without resizing it or mutating its
        // style attribute. Keep the backing and fade attached to the moving
        // edge until the CSS transition finishes, even without another input.
        if (currentSurfaces().some((surface) => surface.getAnimations?.().some(
          (animation) => animation.playState === 'running' || animation.pending,
        ))) schedule();
      },
    });
    let revision = 0;
    const schedule = () => scheduler.publish(++revision);
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(schedule);
    resizeObserver?.observe(stage);
    for (const surface of currentSurfaces()) resizeObserver?.observe(surface);

    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(schedule);
    mutationObserver?.observe(stage, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'aria-hidden',
        'class',
        'data-tools-workspace-open',
        'data-workspace-open',
        'data-workspace-presentation',
        'hidden',
        'style',
      ],
    });
    stage.addEventListener('scroll', schedule, { capture: true, passive: true });
    stage.addEventListener('transitionrun', schedule);
    stage.addEventListener('transitionend', schedule);
    stage.addEventListener('transitioncancel', schedule);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      scheduler.cancel();
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      stage.removeEventListener('scroll', schedule, { capture: true });
      stage.removeEventListener('transitionrun', schedule);
      stage.removeEventListener('transitionend', schedule);
      stage.removeEventListener('transitioncancel', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [input.layoutGeneration, input.stageRef, input.surfaceRefs]);

  return {
    ...zoomActions,
    geometry,
    style: {
      '--review-collapsed-rail-size': `${REVIEW_COLLAPSED_RAIL_SIZE}px`,
      '--review-overlay-inset': `${geometry.outsideInset}px`,
      '--review-main-scrollbar-width': `${geometry.scrollbarWidth}px`,
      '--review-main-scrollbar-height': `${geometry.scrollbarHeight}px`,
      '--review-overlay-fade-size': `${REVIEW_OVERLAY_FADE_SIZE}px`,
      ...(geometry.rightStart === null
        ? {}
        : { '--review-overlay-right-start': `${geometry.rightStart}px` }),
      ...(geometry.bottomStart === null
        ? {}
        : { '--review-overlay-bottom-start': `${geometry.bottomStart}px` }),
    } as CSSProperties,
  };
}
