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
  chooseAnnotationPresentation,
  intersectViewerRects,
  restoreViewportPosition,
  revealDelta,
  type AnnotationPresentation,
  type ViewerFramingControls,
  type ViewerPosition,
} from '../pdf/viewer-framing.js';

const WORKSPACE_SIDE_MAX_PX = 24 * 16;
const WORKSPACE_SIDE_EDGE_GAP_PX = 3 * 16;
const ANNOTATION_MARK_GUTTER_PX = 10;

function waitForWorkspaceLayout(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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
}

export interface WorkspaceFraming {
  readonly workspaceRef: RefObject<HTMLElement | null>;
  readonly stageRef: RefObject<HTMLDivElement | null>;
  readonly presentation: AnnotationPresentation;
  readonly sideWidth: number;
  markUserIntent(axes?: { left?: boolean; top?: boolean }): void;
  currentScroll(): ViewerPosition | null;
}

export function useWorkspaceFraming(input: {
  readonly workspaceOpen: boolean;
  readonly controls?: ViewerFramingControls;
  readonly request: WorkspaceOpenRequest;
}): WorkspaceFraming {
  const workspaceRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const authorityRef = useRef(new FramingSessionAuthority());
  const sessionRef = useRef<ActiveFramingSession | null>(null);
  const [presentation, setPresentation] = useState<AnnotationPresentation>('right');
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
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

  const currentScroll = useCallback((): ViewerPosition | null => {
    const snapshot = input.controls?.snapshot();
    return snapshot?.ready ? snapshot.scroll : null;
  }, [input.controls]);

  const markUserIntent = useCallback((
    axes: { left?: boolean; top?: boolean } = { left: true, top: true },
  ) => {
    const session = sessionRef.current;
    if (!session) return;
    const addsLeft = axes.left === true && !session.userAxes.left;
    const addsTop = axes.top === true && !session.userAxes.top;
    if (!addsLeft && !addsTop) return;
    if (addsLeft) session.userAxes.left = true;
    if (addsTop) session.userAxes.top = true;
    authorityRef.current.markUserNavigation();

    // Taking ownership must also stop an in-flight native smooth scroll.
    const current = input.controls?.snapshot();
    if (current?.ready) input.controls?.scrollTo(current.scroll, 'auto');
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

    const closeSession = async () => {
      const session = sessionRef.current;
      if (!session) {
        await controls.setRunway({ right: 0, bottom: 0 });
        return;
      }
      const current = controls.snapshot(target);
      const restored = restoreViewportPosition({
        baseline: session.baseline,
        current: current.scroll,
        automatic: session.automatic,
        userRevision: authorityRef.current.snapshot()?.userRevision ?? 0,
        userAxes: session.userAxes,
        maximum: current.maximum,
      });
      const withoutRunway = await controls.setRunway({ right: 0, bottom: 0 });
      if (!authorityRef.current.isCurrent(operation)) return;
      controls.scrollTo({
        left: Math.min(restored.left, withoutRunway.maximum.left),
        top: Math.min(restored.top, withoutRunway.maximum.top),
      }, 'auto');
      authorityRef.current.close(operation);
      sessionRef.current = null;
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
        controls.scrollTo(restored, 'auto');
        session.baseline = restored;
        session.automatic = { left: 0, top: 0 };
        session.presentation = presentation;
        session.requestToken = input.request.token;
      } else {
        // Switching workspace modes can issue a fresh reading request while the
        // tray remains open. Preserve the established reading frame; only an
        // explicit mark request needs a new target reveal.
        session.requestToken = input.request.token;
      }

      const workspaceBounds = workspaceRef.current?.getBoundingClientRect();
      const exclusionWidth = workspaceBounds?.width ?? sideWidth;
      const exclusionHeight = workspaceBounds?.height ?? 0;
      const runway = presentation === 'right'
        ? { right: exclusionWidth, bottom: 0 }
        : { right: 0, bottom: exclusionHeight };
      await controls.setRunway(runway);
      if (!authorityRef.current.isCurrent(operation) || !input.workspaceOpen) return;
      // WebKit can commit the runway element before exposing its updated
      // scroll extent. Measure only after one guarded layout frame so reveal
      // coordinates are not clamped against the preceding maximum.
      await waitForWorkspaceLayout();
      if (!authorityRef.current.isCurrent(operation) || !input.workspaceOpen) return;

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
      if (presentation === 'right' && !session.userAxes.left) {
        leftDelta = revealDelta(
          { start: revealTarget.left, end: revealTarget.right },
          {
            start: measured.viewport.left,
            end: Math.min(measured.viewport.right, stage.right - exclusionWidth),
          },
          input.request.kind === 'mark' ? ANNOTATION_MARK_GUTTER_PX : 0,
        );
      } else if (input.request.kind === 'mark' && !session.userAxes.top) {
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
        left: Math.min(Math.max(0, measured.scroll.left + leftDelta), measured.maximum.left),
        top: Math.min(Math.max(0, measured.scroll.top + topDelta), measured.maximum.top),
      };
      if (!session.userAxes.left) session.automatic.left = destination.left - session.baseline.left;
      if (!session.userAxes.top) session.automatic.top = destination.top - session.baseline.top;
      if (destination.left !== measured.scroll.left || destination.top !== measured.scroll.top) {
        const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        controls.scrollTo(destination, reducedMotion ? 'auto' : 'smooth');
      }
    };

    void (input.workspaceOpen ? openSession() : closeSession());
    return () => authorityRef.current.supersede(operation);
  }, [input.controls, input.workspaceOpen, input.request, presentation, sideWidth, stageSize.height]);

  return {
    workspaceRef,
    stageRef,
    presentation,
    sideWidth,
    markUserIntent,
    currentScroll,
  };
}
