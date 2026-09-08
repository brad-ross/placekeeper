import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

import {
  LatestFrameRequest,
  ViewerGeometrySettlementAuthority,
  ViewerPositionAuthority,
  chooseAnnotationPresentation,
  revealDelta,
  type AnnotationPresentation,
  type ViewerFramingControls,
  type ViewerPosition,
  type ViewerRunway,
  type WaitForSettledViewerGeometry,
} from '../pdf/viewer-framing.js';

import {
  REVIEW_OVERLAY_INSET,
  REVIEW_OVERLAY_FADE_SIZE,
} from './use-review-overlay-geometry.js';

const WORKSPACE_SIDE_MAX_PX = 24 * 16;
const WORKSPACE_SIDE_EDGE_GAP_PX = 3 * 16;
const ANNOTATION_MARK_GUTTER_PX = 10;

function waitForWorkspaceLayout(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const frame = requestAnimationFrame(() => {
      signal.removeEventListener('abort', abort);
      resolve(true);
    });
    const abort = () => {
      cancelAnimationFrame(frame);
      resolve(false);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function workspaceSurfaceIsOpen(surface: HTMLElement): boolean {
  return surface.dataset.workspaceOpen === 'true'
    || surface.dataset.toolsWorkspaceOpen === 'true';
}

function committedWorkspaceRunway(
  stage: Pick<DOMRect, 'width' | 'height'>,
  surfaces: readonly HTMLElement[],
  rightDockOpen: boolean,
): ViewerRunway {
  // Offset geometry describes the resting tray edge and remains stable while
  // its entrance transform animates. The runway also clears the opaque outer
  // backing and its fade. A right dock already reduces the real viewport,
  // so it must not also subtract a runway from that reduced width.
  const runway: ViewerRunway = {
    right: 0,
    bottom: 0,
  };
  for (const surface of surfaces) {
    if (!workspaceSurfaceIsOpen(surface)) continue;
    if (surface.dataset.workspacePresentation === 'bottom') {
      const clearBoundary = Math.max(0, surface.offsetTop - REVIEW_OVERLAY_INSET - REVIEW_OVERLAY_FADE_SIZE);
      runway.bottom = Math.max(runway.bottom, Math.min(stage.height, stage.height - clearBoundary));
    } else if (!rightDockOpen) {
      const clearBoundary = Math.max(0, surface.offsetLeft - REVIEW_OVERLAY_INSET - REVIEW_OVERLAY_FADE_SIZE);
      runway.right = Math.max(runway.right, Math.min(stage.width, stage.width - clearBoundary));
    }
  }
  return runway;
}

export type WorkspaceOpenRequest =
  | { readonly kind: 'reading'; readonly token: number }
  | { readonly kind: 'mark'; readonly reviewId: string; readonly pageIndex: number; readonly token: number };

export function workspaceRequestRequiresReframe(input: {
  readonly presentationChanged: boolean;
  readonly requestChanged: boolean;
  readonly requestKind: WorkspaceOpenRequest['kind'];
}): boolean {
  return input.requestChanged && input.requestKind === 'mark';
}

export interface WorkspaceFraming {
  readonly referenceSurfaceRef: RefObject<HTMLElement | null>;
  readonly toolsSurfaceRef: RefObject<HTMLElement | null>;
  readonly stageRef: RefObject<HTMLDivElement | null>;
  readonly stageSize: { readonly width: number; readonly height: number };
  readonly presentation: AnnotationPresentation;
  readonly sideWidth: number;
  requestSettledReframe(): void;
  prepareMarkReveal(): void;
  waitForSettledGeometry: WaitForSettledViewerGeometry;
  markUserIntent(
    axes?: { left?: boolean; top?: boolean },
    options?: { stopAutomaticScroll?: boolean; captureSettledPosition?: boolean },
  ): void;
  commitUserPosition(
    axes?: { left?: boolean; top?: boolean },
    options?: { stopAutomaticScroll?: boolean },
  ): void;
  currentScroll(): ViewerPosition | null;
}

export function useWorkspaceFraming(input: {
  readonly workspaceOpen: boolean;
  readonly controls?: ViewerFramingControls;
  readonly request: WorkspaceOpenRequest;
  readonly documentGeneration?: number;
  readonly layoutGeneration?: string | number;
}): WorkspaceFraming {
  const referenceSurfaceRef = useRef<HTMLElement>(null);
  const toolsSurfaceRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const geometrySettlementRef = useRef(new ViewerGeometrySettlementAuthority());
  const controlsRef = useRef(input.controls);
  controlsRef.current = input.controls;
  const layoutOperationRef = useRef(0);
  const committedControlsRef = useRef<ViewerFramingControls | null>(null);
  const committedRunwayRef = useRef<ViewerRunway>({ right: 0, bottom: 0 });
  const runwaySettlementRef = useRef<{
    operation: number;
    promise: Promise<void>;
  }>({ operation: 0, promise: Promise.resolve() });
  const positionAuthorityRef = useRef(new ViewerPositionAuthority(input.documentGeneration));
  const lastObservedScrollRef = useRef<ViewerPosition | null>(null);
  const automaticScrollTargetRef = useRef<ViewerPosition | null>(null);
  const userRevisionRef = useRef(0);
  const revealedMarkTokenRef = useRef<number | null>(null);
  const [presentation, setPresentation] = useState<AnnotationPresentation>('right');
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [geometryRevision, setGeometryRevision] = useState(0);
  const requestGeometryFrameRef = useRef<() => void>(() => undefined);
  const sideWidth = Math.min(
    WORKSPACE_SIDE_MAX_PX,
    Math.max(0, stageSize.width - WORKSPACE_SIDE_EDGE_GAP_PX),
  );

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      const bounds = stage.getBoundingClientRect();
      const width = Math.max(0, bounds.width);
      const height = Math.max(0, bounds.height);
      const prospectiveSideWidth = Math.min(
        WORKSPACE_SIDE_MAX_PX,
        Math.max(0, width - WORKSPACE_SIDE_EDGE_GAP_PX),
      );
      setStageSize((current) => current.width === width && current.height === height
        ? current
        : { width, height });
      if (width > 0) {
        setPresentation((previous) => chooseAnnotationPresentation({
          stageWidth: width,
          sideWidth: prospectiveSideWidth,
          previous,
        }));
      }
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const elements = [stageRef.current, referenceSurfaceRef.current, toolsSurfaceRef.current]
      .filter((element): element is HTMLElement => element !== null);
    let sample = 0;
    let scheduler: LatestFrameRequest<number>;
    scheduler = new LatestFrameRequest<number>({
      schedule: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => cancelAnimationFrame(handle),
      commit: () => {
        geometrySettlementRef.current.markChanged();
        setGeometryRevision((revision) => revision + 1);
      },
    });
    const publish = () => scheduler.publish(++sample);
    requestGeometryFrameRef.current = publish;

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(publish);
    for (const element of elements) resizeObserver?.observe(element);

    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(publish);
    for (const surface of [referenceSurfaceRef.current, toolsSurfaceRef.current]) {
      if (!surface) continue;
      mutationObserver?.observe(surface, {
        attributes: true,
        attributeFilter: [
          'aria-hidden',
          'class',
          'data-tools-workspace-open',
          'data-workspace-open',
          'data-workspace-presentation',
          'inert',
          'style',
        ],
      });
    }

    const onTransitionRun = (event: TransitionEvent) => {
      if (!(event.currentTarget instanceof HTMLElement) || event.target !== event.currentTarget) return;
      geometrySettlementRef.current.beginTransition(event.currentTarget, event.propertyName);
      publish();
    };
    const onTransitionSettled = (event: TransitionEvent) => {
      if (!(event.currentTarget instanceof HTMLElement) || event.target !== event.currentTarget) return;
      geometrySettlementRef.current.settleTransition(event.currentTarget, event.propertyName);
      publish();
    };
    for (const surface of [referenceSurfaceRef.current, toolsSurfaceRef.current]) {
      surface?.addEventListener('transitionrun', onTransitionRun);
      surface?.addEventListener('transitionend', onTransitionSettled);
      surface?.addEventListener('transitioncancel', onTransitionSettled);
    }
    publish();

    return () => {
      requestGeometryFrameRef.current = () => undefined;
      scheduler.cancel();
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      for (const surface of [referenceSurfaceRef.current, toolsSurfaceRef.current]) {
        surface?.removeEventListener('transitionrun', onTransitionRun);
        surface?.removeEventListener('transitionend', onTransitionSettled);
        surface?.removeEventListener('transitioncancel', onTransitionSettled);
      }
    };
  }, []);

  const requestSettledReframe = useCallback(() => requestGeometryFrameRef.current(), []);
  const waitForSettledGeometry = useCallback<WaitForSettledViewerGeometry>(async (signal) => {
    while (!signal.aborted) {
      requestGeometryFrameRef.current();
      const geometry = await geometrySettlementRef.current.waitForSettled(
        signal,
        () => waitForWorkspaceLayout(signal),
        // CSS transitions can already be pending before transitionrun is
        // delivered. Inspect them before declaring two frames quiet.
        () => [
          referenceSurfaceRef.current,
          toolsSurfaceRef.current,
          stageRef.current?.querySelector<HTMLElement>('[data-viewer-framing-viewport]'),
        ].some((surface) => (
          surface?.getAnimations().some((animation) => (
            animation.pending || animation.playState === 'running'
          )) ?? false
        )),
      );
      if (geometry === null) return null;
      const runwaySettlement = runwaySettlementRef.current;
      await runwaySettlement.promise;
      if (signal.aborted) return null;
      if (
        runwaySettlement === runwaySettlementRef.current
        && runwaySettlement.operation === layoutOperationRef.current
        && geometry.isCurrent()
      ) {
        return {
          revision: geometry.revision,
          isCurrent: () => (
            geometry.isCurrent()
            && runwaySettlement === runwaySettlementRef.current
            && runwaySettlement.operation === layoutOperationRef.current
          ),
        };
      }
    }
    return null;
  }, []);

  const currentScroll = useCallback((): ViewerPosition | null => {
    const snapshot = input.controls?.snapshot();
    return snapshot?.ready ? snapshot.scroll : null;
  }, [input.controls]);

  const clearRememberedPosition = useCallback(() => {
    positionAuthorityRef.current.supersedeWithExplicitNavigation();
  }, []);

  const scrollAutomatically = useCallback((
    controls: ViewerFramingControls,
    position: ViewerPosition,
    behavior: ScrollBehavior = 'auto',
  ) => {
    automaticScrollTargetRef.current = { ...position };
    controls.scrollTo(position, behavior);
  }, []);

  const scheduleSettledUserPositionCapture = useCallback(() => {
    const capture = positionAuthorityRef.current.renewUserCapture();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const controls = controlsRef.current;
      if (!controls) return;
      const settled = controls.snapshot();
      if (!settled.ready) return;
      positionAuthorityRef.current.settleUserPosition(capture, settled.scroll);
    }));
  }, []);

  const prepareMarkReveal = useCallback(() => {
    clearRememberedPosition();
    const snapshot = controlsRef.current?.snapshot();
    if (!snapshot?.ready) return;
    // Cancel an older smooth reveal before the mark activation establishes a
    // new explicit navigation target. The current position remains untouched.
    scrollAutomatically(controlsRef.current!, snapshot.scroll, 'auto');
  }, [clearRememberedPosition, scrollAutomatically]);

  const markUserIntent = useCallback((
    axes: { left?: boolean; top?: boolean } = { left: true, top: true },
    options: { stopAutomaticScroll?: boolean; captureSettledPosition?: boolean } = {},
  ) => {
    const ownsLeft = axes.left === true;
    const ownsTop = axes.top === true;
    if (!ownsLeft && !ownsTop) return;
    automaticScrollTargetRef.current = null;
    userRevisionRef.current += 1;
    const current = input.controls?.snapshot();
    // Native wheel/pointer movement owns the viewer. A same-position instant
    // write only cancels an older automatic smooth reveal when requested.
    if (current?.ready && options.stopAutomaticScroll !== false) {
      scrollAutomatically(input.controls!, current.scroll, 'auto');
    }
    if (options.captureSettledPosition === false) {
      clearRememberedPosition();
      return;
    }
    if (!input.controls) return;
    positionAuthorityRef.current.beginUserIntent({ left: ownsLeft, top: ownsTop });
    if (current?.ready) positionAuthorityRef.current.observeUserPosition(current.scroll);
    scheduleSettledUserPositionCapture();
  }, [clearRememberedPosition, input.controls, scheduleSettledUserPositionCapture, scrollAutomatically]);

  const commitUserPosition = useCallback((
    axes: { left?: boolean; top?: boolean } = { left: true, top: true },
    options: { stopAutomaticScroll?: boolean } = {},
  ) => {
    const ownsLeft = axes.left === true;
    const ownsTop = axes.top === true;
    if (!ownsLeft && !ownsTop) return;
    const current = input.controls?.snapshot();
    if (!current?.ready) return;
    userRevisionRef.current += 1;
    // A click-time position commit supersedes every passive restoration that
    // sampled the viewer before this interaction. Revision checks alone are
    // insufficient when a replacement effect starts after the revision but
    // still carries an older transition baseline.
    layoutOperationRef.current += 1;
    if (options.stopAutomaticScroll !== false) {
      scrollAutomatically(input.controls!, current.scroll, 'auto');
    }
    positionAuthorityRef.current.commitCurrentPosition(
      current.scroll,
      current.maximum,
      { left: ownsLeft, top: ownsTop },
    );
  }, [input.controls, scrollAutomatically]);

  useLayoutEffect(() => {
    if (!input.controls) return;
    const controls = input.controls;
    return controls.subscribe((event) => {
      if (event.type === 'zoom') {
        // Zoom owns the reading position but does not change a tray's committed
        // runway. Republishing workspace geometry here invalidates the settled
        // token used by Fit Width in the middle of its own zoom operation.
        userRevisionRef.current += 1;
        return;
      }
      const current = controls.snapshot();
      if (!current.ready) return;
      const automaticTarget = automaticScrollTargetRef.current;
      if (automaticTarget !== null) {
        lastObservedScrollRef.current = current.scroll;
        if (
          Math.abs(current.scroll.left - automaticTarget.left) < 1
          && Math.abs(current.scroll.top - automaticTarget.top) < 1
        ) automaticScrollTargetRef.current = null;
        return;
      }
      const previous = lastObservedScrollRef.current;
      lastObservedScrollRef.current = current.scroll;
      if (previous !== null && !positionAuthorityRef.current.hasPendingUserIntent()) {
        const left = Math.abs(current.scroll.left - previous.left) >= 1;
        const top = Math.abs(current.scroll.top - previous.top) >= 1;
        if (left || top) positionAuthorityRef.current.beginUserIntent({ left, top });
      }
      positionAuthorityRef.current.observeUserPosition(current.scroll);
      // Wheel inertia and smooth keyboard scrolling can span many frames.
      // Every native scroll restarts the quiet-frame capture so the durable
      // position is the final user offset rather than an intermediate sample.
      scheduleSettledUserPositionCapture();
    });
  }, [input.controls, scheduleSettledUserPositionCapture]);

  useLayoutEffect(() => {
    const controls = input.controls;
    if (!controls) return;
    if (committedControlsRef.current !== controls) {
      committedControlsRef.current = controls;
      const replacement = controls.snapshot();
      positionAuthorityRef.current.replaceControls(
        replacement.ready ? replacement.scroll : undefined,
      );
      lastObservedScrollRef.current = replacement.ready ? replacement.scroll : null;
      automaticScrollTargetRef.current = null;
    }
    const documentChanged = positionAuthorityRef.current.replaceDocument(input.documentGeneration);
    if (documentChanged) committedRunwayRef.current = { right: -1, bottom: -1 };
    const settlement = new AbortController();
    const operation = ++layoutOperationRef.current;
    const operationIsCurrent = () => (
      !settlement.signal.aborted && layoutOperationRef.current === operation
    );
    const target = input.request.kind === 'mark'
      ? { pageIndex: input.request.pageIndex, reviewId: input.request.reviewId }
      : undefined;
    const first = controls.snapshot(target);
    const startingUserRevision = userRevisionRef.current;
    const shouldRevealMark = input.request.kind === 'mark'
      && input.workspaceOpen
      && revealedMarkTokenRef.current !== input.request.token;
    const updateRunway = async () => {
      const stageBounds = stageRef.current?.getBoundingClientRect();
      const surfaces = [referenceSurfaceRef.current, toolsSurfaceRef.current]
        .filter((surface): surface is HTMLElement => surface !== null);
      const runway = stageBounds
        ? committedWorkspaceRunway(
          stageBounds, surfaces,
          stageRef.current?.dataset.rightSurfaceOpen === 'true',
        )
        : { right: 0, bottom: 0 };
      const precedingRunway = committedRunwayRef.current;
      const runwayChanged = runway.right !== precedingRunway.right
        || runway.bottom !== precedingRunway.bottom;
      const pendingMatchesRunway = positionAuthorityRef.current.hasTransition(runway);
      if (runwayChanged && !pendingMatchesRunway) {
        positionAuthorityRef.current.beginTransition(runway, first.scroll);
      }
      if (!runwayChanged && !shouldRevealMark && !pendingMatchesRunway) return;
      if (runwayChanged) {
        // Record the requested runway before the asynchronous DOM settlement.
        // A resize can supersede this effect after updateRunway has already
        // mutated the viewer. Keeping the ref behind the DOM would make every
        // replacement effect start another passive transition from a stale
        // position and could later restore that position over fresh reading.
        committedRunwayRef.current = runway;
        await controls.setRunway(runway);
        if (!operationIsCurrent()) return;
      }
      if (!operationIsCurrent()) return;
      if (!await waitForWorkspaceLayout(settlement.signal)) return;
      if (!operationIsCurrent()) return;
      const measured = controls.snapshot(target);
      if (!first.ready || !measured.ready) return;
      const userInterrupted = userRevisionRef.current !== startingUserRevision;
      const preserved = positionAuthorityRef.current.preservedPosition(
        runway,
        first.scroll,
        measured.maximum,
      );
      // Tray visibility, docking, and resizing only alter reachable scroll
      // extent. Restore the exact pre-layout offset after native scroll
      // anchoring; passive layout never recenters or refits the PDF.
      if (!shouldRevealMark || userInterrupted) {
        if (shouldRevealMark && userInterrupted && input.request.kind === 'mark') {
          revealedMarkTokenRef.current = input.request.token;
        }
        if (userInterrupted) {
          positionAuthorityRef.current.finishTransition();
          return;
        }
        if (preserved.left !== measured.scroll.left || preserved.top !== measured.scroll.top) {
          scrollAutomatically(controls, preserved, 'auto');
        }
        positionAuthorityRef.current.finishTransition();
        return;
      }

      const stage = stageRef.current?.getBoundingClientRect();
      const revealTarget = measured.target;
      if (!stage || !measured.viewport || !revealTarget) return;
      const destination = {
        left: Math.min(Math.max(0, measured.scroll.left + revealDelta(
          { start: revealTarget.left, end: revealTarget.right },
          {
            start: measured.viewport.left,
            end: Math.min(measured.viewport.right, stage.right - runway.right),
          },
          ANNOTATION_MARK_GUTTER_PX,
        )), measured.maximum.left),
        top: Math.min(Math.max(0, measured.scroll.top + revealDelta(
          { start: revealTarget.top, end: revealTarget.bottom },
          {
            start: measured.viewport.top,
            end: Math.min(measured.viewport.bottom, stage.bottom - runway.bottom),
          },
          ANNOTATION_MARK_GUTTER_PX,
        )), measured.maximum.top),
      };
      if (destination.left !== measured.scroll.left || destination.top !== measured.scroll.top) {
        const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        scrollAutomatically(controls, destination, reducedMotion ? 'auto' : 'smooth');
      }
      if (input.request.kind === 'mark') revealedMarkTokenRef.current = input.request.token;
      positionAuthorityRef.current.finishTransition();
    };

    const runwaySettlement = updateRunway().then(() => undefined);
    runwaySettlementRef.current = { operation, promise: runwaySettlement };
    return () => {
      settlement.abort();
    };
  }, [
    input.controls,
    input.documentGeneration,
    input.layoutGeneration,
    input.workspaceOpen,
    input.request,
    geometryRevision,
    presentation,
    sideWidth,
    stageSize.height,
    clearRememberedPosition,
    scrollAutomatically,
  ]);

  return {
    referenceSurfaceRef,
    toolsSurfaceRef,
    stageRef,
    stageSize,
    presentation,
    sideWidth,
    requestSettledReframe,
    prepareMarkReveal,
    waitForSettledGeometry,
    markUserIntent,
    commitUserPosition,
    currentScroll,
  };
}
