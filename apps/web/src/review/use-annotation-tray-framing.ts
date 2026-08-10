import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

import {
  FramingSessionAuthority,
  LatestFrameRequest,
  chooseAnnotationPresentation,
  frameUserOwnedPosition,
  intersectViewerRects,
  occupiedRunway,
  restoreViewportPosition,
  revealDelta,
  type AnnotationPresentation,
  type ViewerFramingControls,
  type ViewerPosition,
} from '../pdf/viewer-framing.js';

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

export type WorkspaceOpenRequest =
  | { readonly kind: 'reading'; readonly token: number }
  | { readonly kind: 'mark'; readonly reviewId: string; readonly pageIndex: number; readonly token: number };

export function workspaceRequestRequiresReframe(input: {
  readonly presentationChanged: boolean;
  readonly requestChanged: boolean;
  readonly requestKind: WorkspaceOpenRequest['kind'];
}): boolean {
  return input.presentationChanged || (input.requestChanged && input.requestKind === 'mark');
}

interface ActiveFramingSession {
  readonly documentId: string;
  baseline: ViewerPosition;
  automatic: ViewerPosition;
  userAxes: { left: boolean; top: boolean };
  presentation: AnnotationPresentation;
  requestToken: number;
  closing?: ViewerPosition;
}

export interface WorkspaceFraming {
  readonly referenceSurfaceRef: RefObject<HTMLElement | null>;
  readonly toolsSurfaceRef: RefObject<HTMLElement | null>;
  readonly stageRef: RefObject<HTMLDivElement | null>;
  readonly stageSize: { readonly width: number; readonly height: number };
  readonly presentation: AnnotationPresentation;
  readonly sideWidth: number;
  requestSettledReframe(): void;
  markUserIntent(
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
  const authorityRef = useRef(new FramingSessionAuthority());
  const sessionRef = useRef<ActiveFramingSession | null>(null);
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
    const transitioning = new Set<HTMLElement>();
    let sample = 0;
    let scheduler: LatestFrameRequest<number>;
    scheduler = new LatestFrameRequest<number>({
      schedule: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => cancelAnimationFrame(handle),
      commit: () => {
        setGeometryRevision((revision) => revision + 1);
        if (transitioning.size > 0) scheduler.publish(++sample);
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
      transitioning.add(event.currentTarget);
      publish();
    };
    const onTransitionSettled = (event: TransitionEvent) => {
      if (!(event.currentTarget instanceof HTMLElement) || event.target !== event.currentTarget) return;
      transitioning.delete(event.currentTarget);
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
      transitioning.clear();
    };
  }, []);

  const requestSettledReframe = useCallback(() => requestGeometryFrameRef.current(), []);

  const currentScroll = useCallback((): ViewerPosition | null => {
    const snapshot = input.controls?.snapshot();
    return snapshot?.ready ? snapshot.scroll : null;
  }, [input.controls]);

  const markUserIntent = useCallback((
    axes: { left?: boolean; top?: boolean } = { left: true, top: true },
    options: { stopAutomaticScroll?: boolean } = {},
  ) => {
    const session = sessionRef.current;
    if (!session) return;
    const ownsLeft = axes.left === true;
    const ownsTop = axes.top === true;
    if (!ownsLeft && !ownsTop) return;
    const current = input.controls?.snapshot();
    if (current?.ready) {
      session.baseline = {
        left: ownsLeft ? current.scroll.left : session.baseline.left,
        top: ownsTop ? current.scroll.top : session.baseline.top,
      };
    }
    if (ownsLeft) {
      session.userAxes.left = true;
    }
    if (ownsTop) {
      session.userAxes.top = true;
    }
    authorityRef.current.markUserNavigation();

    // Programmatic ownership changes stop any in-flight smooth scroll. Native
    // wheel gestures cancel through browser behavior; forcing a same-position
    // write during wheel capture suppresses WebKit's default movement.
    if (current?.ready && options.stopAutomaticScroll !== false) {
      input.controls?.scrollTo(current.scroll, 'auto');
    }
  }, [input.controls]);

  useEffect(() => {
    if (!input.workspaceOpen || !input.controls) return;
    return input.controls.subscribe((event) => {
      if (event.type === 'zoom') markUserIntent();
    });
  }, [input.controls, input.workspaceOpen, markUserIntent]);

  useLayoutEffect(() => {
    const controls = input.controls;
    if (!controls) return;
    const settlement = new AbortController();
    const target = input.request.kind === 'mark'
      ? { pageIndex: input.request.pageIndex, reviewId: input.request.reviewId }
      : undefined;
    const first = controls.snapshot(target);
    const operationDocumentId = first.documentId ?? sessionRef.current?.documentId;
    if (!operationDocumentId) {
      if (!input.workspaceOpen) void controls.setRunway({ right: 0, bottom: 0 });
      return;
    }
    const operation = authorityRef.current.open(operationDocumentId, presentation);
    const operationIsCurrent = () => authorityRef.current.isCurrent(operation)
      && controls.snapshot().documentId === operationDocumentId;

    const closeSession = async () => {
      const session = sessionRef.current;
      if (!session) {
        await controls.setRunway({ right: 0, bottom: 0 });
        return;
      }
      const current = controls.snapshot(target);
      const restored = session.closing ?? restoreViewportPosition({
        baseline: session.baseline,
        current: current.scroll,
        automatic: session.automatic,
        userRevision: authorityRef.current.snapshot()?.userRevision ?? 0,
        userAxes: session.userAxes,
        maximum: current.maximum,
      });
      // A close can restart as surface/layout observers settle. Retain the
      // first chosen target so a later pass cannot mistake native anchoring
      // during runway removal for a new reviewer-owned position.
      session.closing = restored;
      await controls.setRunway({ right: 0, bottom: 0 });
      // WebKit can report the preceding maximum until the runway removal has
      // completed a layout turn. Clamp only against settled viewer metrics.
      if (!await waitForWorkspaceLayout(settlement.signal)) return;
      if (!operationIsCurrent()) return;
      const withoutRunway = controls.snapshot(target);
      const closedPosition = {
        left: Math.min(restored.left, withoutRunway.maximum.left),
        top: Math.min(restored.top, withoutRunway.maximum.top),
      };
      controls.scrollTo(closedPosition, 'auto');
      session.baseline = closedPosition;
      session.automatic = { left: 0, top: 0 };
      authorityRef.current.close(operation);
      // Keep the document-scoped baseline and per-axis user ownership through
      // a close/reopen cycle. Clearing it here made a fast reopen depend on
      // whether the asynchronous runway close settled first (Chromium and
      // WebKit could consequently choose different reading anchors).
    };

    const openSession = async () => {
      if (!first.ready || !first.documentId) return;
      let session = sessionRef.current;
      if (!session || session.documentId !== first.documentId) {
        session = {
          documentId: first.documentId,
          baseline: first.scroll,
          automatic: { left: 0, top: 0 },
          userAxes: { left: false, top: false },
          presentation,
          requestToken: input.request.token,
        };
        sessionRef.current = session;
      } else if (workspaceRequestRequiresReframe({
        presentationChanged: session.presentation !== presentation,
        requestChanged: session.requestToken !== input.request.token,
        requestKind: input.request.kind,
      })) {
        const restored = restoreViewportPosition({
          baseline: session.baseline,
          current: first.scroll,
          automatic: session.automatic,
          userRevision: authorityRef.current.snapshot()?.userRevision ?? 0,
          userAxes: session.userAxes,
          maximum: first.maximum,
        });
        const framed = frameUserOwnedPosition({
          baseline: session.baseline,
          restored,
          maximum: first.maximum,
          userAxes: session.userAxes,
        });
        controls.scrollTo(framed.position, 'auto');
        session.baseline = framed.baseline;
        session.automatic = { left: 0, top: 0 };
        session.presentation = presentation;
        session.requestToken = input.request.token;
      } else {
        // Switching workspace modes can issue a fresh reading request while the
        // tray remains open. Preserve the established reading frame; only an
        // explicit mark request needs a new target reveal.
        session.requestToken = input.request.token;
      }
      delete session.closing;

      const stageBounds = stageRef.current?.getBoundingClientRect();
      if (!stageBounds) return;
      const surfaces = [referenceSurfaceRef.current, toolsSurfaceRef.current]
        .filter((surface): surface is HTMLElement => surface !== null)
        .map((surface) => ({
          presentation: surface.dataset.workspacePresentation === 'bottom'
            ? 'bottom' as const
            : 'right' as const,
          bounds: surface.getBoundingClientRect(),
        }));
      const runway = occupiedRunway({ stage: stageBounds, surfaces });
      const exclusionWidth = runway.right;
      const exclusionHeight = runway.bottom;
      await controls.setRunway(runway);
      if (!operationIsCurrent() || !input.workspaceOpen) return;
      // WebKit can commit the runway element before exposing its updated
      // scroll extent. Measure only after one guarded layout frame so reveal
      // coordinates are not clamped against the preceding maximum.
      if (!await waitForWorkspaceLayout(settlement.signal)) return;
      if (!operationIsCurrent() || !input.workspaceOpen) return;

      const measured = controls.snapshot(target);
      const stage = stageRef.current?.getBoundingClientRect();
      if (!measured.ready || !measured.viewport || !stage) return;
      const revealTarget = input.request.kind === 'mark'
        ? measured.target
        : first.page && first.viewport
          ? intersectViewerRects(first.page, first.viewport)
          : null;
      if (!revealTarget) return;

      let leftDelta = 0;
      let topDelta = 0;
      if (runway.right === 0 && !session.userAxes.left && session.automatic.left !== 0) {
        leftDelta = session.baseline.left - measured.scroll.left;
      } else if (runway.right > 0 && !session.userAxes.left) {
        leftDelta = revealDelta(
          { start: revealTarget.left, end: revealTarget.right },
          {
            start: measured.viewport.left,
            end: Math.min(measured.viewport.right, stage.right - exclusionWidth),
          },
          input.request.kind === 'mark' ? ANNOTATION_MARK_GUTTER_PX : 0,
        );
      }
      if (runway.bottom === 0 && !session.userAxes.top && session.automatic.top !== 0) {
        topDelta = session.baseline.top - measured.scroll.top;
      } else if (runway.bottom > 0 && input.request.kind === 'mark' && !session.userAxes.top) {
        topDelta = revealDelta(
          { start: revealTarget.top, end: revealTarget.bottom },
          {
            start: measured.viewport.top,
            end: Math.min(measured.viewport.bottom, stage.bottom - exclusionHeight),
          },
          ANNOTATION_MARK_GUTTER_PX,
        );
      }

      const destination = {
        // WebKit may apply native scroll anchoring while the runway grows.
        // Once the reviewer owns an axis, keep the pre-runway position instead
        // of accepting that browser-generated shift as user movement.
        left: Math.min(
          Math.max(0, session.userAxes.left
            ? session.baseline.left
            : measured.scroll.left + leftDelta),
          measured.maximum.left,
        ),
        top: Math.min(
          Math.max(0, session.userAxes.top
            ? session.baseline.top
            : measured.scroll.top + topDelta),
          measured.maximum.top,
        ),
      };
      if (!session.userAxes.left) session.automatic.left = destination.left - session.baseline.left;
      if (!session.userAxes.top) session.automatic.top = destination.top - session.baseline.top;
      if (destination.left !== measured.scroll.left || destination.top !== measured.scroll.top) {
        const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        controls.scrollTo(destination, reducedMotion ? 'auto' : 'smooth');
      }
    };

    void (input.workspaceOpen ? openSession() : closeSession());
    return () => {
      settlement.abort();
      authorityRef.current.supersede(operation);
    };
  }, [
    input.controls,
    input.documentGeneration,
    input.layoutGeneration,
    input.workspaceOpen,
    input.request,
    // Geometry samples matter while a tray is open. Once closing begins they
    // must not supersede the one operation restoring the reading anchor.
    input.workspaceOpen ? geometryRevision : 0,
    presentation,
    sideWidth,
    stageSize.height,
  ]);

  return {
    referenceSurfaceRef,
    toolsSurfaceRef,
    stageRef,
    stageSize,
    presentation,
    sideWidth,
    requestSettledReframe,
    markUserIntent,
    currentScroll,
  };
}
