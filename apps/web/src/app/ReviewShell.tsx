import {
  useCallback,
  useLayoutEffect,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type CSSProperties,
} from 'react';

import {
  addHighlight,
  addDelete,
  addInsert,
  addPageNote,
  addReplace,
  editReviewItem,
  redoReview,
  removeReviewItem,
  undoReview,
  type ReviewRect,
} from '../../../../packages/core/src/review-commands.js';
import type { ReviewCommand, ReviewItem, ReviewState } from '../../../../packages/core/src/review-model.js';
import type { CaretAnchor } from '../pdf/selection-anchor.js';
import {
  existingAnnotationKey,
  type ExistingAnnotation,
  type ExistingAnnotationsDiscovery,
} from '../pdf/existing-annotations.js';
import { reliableSelection, type SelectionUpdate } from '../pdf/selection-state.js';
import type { ViewerControls, ViewerControlsSnapshot } from '../pdf/viewer-controls.js';
import { unavailableViewerControls } from '../pdf/viewer-controls.js';
import type { ViewerFramingControls, ViewerPosition } from '../pdf/viewer-framing.js';
import type { PdfViewerNavigation } from '../pdf/viewer-navigation-adapter.js';
import type {
  PdfTargetVisibility,
  PdfViewportQuery,
} from '../pdf/viewer-navigation.js';
import type { ViewerPdfLinkInvocation } from '../pdf/viewer-interaction-events.js';
import type { PdfOutlineDiscovery, PdfOutlineItem } from '../pdf/pdf-outline.js';
import { AnnotationList } from '../review/AnnotationList.js';
import {
  AnnotationMetadata,
  annotationAccessibleLabel,
  annotationKindLabel,
} from '../review/AnnotationMetadata.js';
import type { AnnotationOutlineLabels } from '../review/annotation-outline-context.js';
import { AnnotationPeek } from '../review/AnnotationPeek.js';
import { CommentComposer } from '../review/CommentComposer.js';
import {
  ContextActionPalette,
  InsertionCaret,
  type ContextPlacement,
} from '../review/ContextActionPalette.js';
import { PageActionMenu } from '../review/PageActionMenu.js';
import { LinkActionPopover, type LinkActionChoice, type LinkActionDismissReason } from '../review/LinkActionPopover.js';
import {
  ReferenceWorkspace,
  WORKSPACE_MODES,
  type PendingReferencePanel,
  type ReferenceReturnControlState,
  type ReferenceWorkspaceTab,
} from '../review/ReferenceWorkspace.js';
import { ReviewChrome } from '../review/ReviewChrome.js';
import { ReviewIcon } from '../review/ReviewIcon.js';
import { OutlineAnnotationsWorkspace } from '../review/OutlineAnnotationsWorkspace.js';
import { ReferenceResizeHandle } from '../review/ReferenceResizeHandle.js';
import { WorkspaceEdgeRail } from '../review/WorkspaceEdgeRail.js';
import {
  BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN,
  MIN_BOTTOM_REFERENCE_HEIGHT,
  MIN_RIGHT_REFERENCE_WIDTH,
  RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN,
  clampBottomReferenceHeight,
  clampRightReferenceWidth,
  createReferenceWorkspaceLayout,
  deriveReferenceWorkspaceLayout,
  reduceReferenceWorkspaceLayout,
  type ReferenceWorkspaceLayoutAction,
  type ReferenceWorkspaceLayoutState,
  type RightWorkspaceMode,
} from '../review/reference-workspace-layout.js';
import type { LiveContextBindingStatus } from '../../../../packages/core/src/live-context.js';
import type { CopyLinkControlProps } from '../review/CopyLinkControl.js';
import type { PdfDestinationCopyLink } from '../review/copy-link-model.js';
import {
  createProofreadInputController,
  isEditableTarget,
  type ProofreadInputIntent,
} from '../review/input-controller.js';
import { reviewActionForKey } from '../review/review-actions.js';
import {
  useWorkspaceFraming,
  type WorkspaceOpenRequest,
} from '../review/use-annotation-tray-framing.js';
import {
  INITIAL_REVIEW_SURFACE_STATE,
  reduceReviewSurface,
  type ReviewBaseSurface,
  type ReviewSurfaceAction,
} from '../review/review-surface-state.js';
import type {
  ReferenceNavigationState,
  WorkspaceMode,
} from '../review/reference-navigation-state.js';
import {
  authoringAuthorityFor,
  authoringAuthorityMatches,
  authoringAnchorSnapshot,
  authoringSourceContext,
  authoringSessionIsCurrent,
  canStartAuthoringSession,
  createAuthoringSession,
  type AuthoringAuthority,
  type AuthoringAnchorSnapshot,
  type AuthoringOriginKind,
  type AuthoringSession,
  type AuthoringSource,
} from '../review/authoring-session.js';
import './review-layout.css';

function ignoreReferenceViewportHost(_element: HTMLDivElement | null): void {}

export interface ReviewShellProps {
  state: ReviewState;
  documentTitle?: string;
  savedLabel?: string;
  savePhase?: 'clean' | 'saving' | 'not-saved';
  saveOptionsOpen?: boolean;
  onSaveOptions?(): void;
  listOpen?: boolean;
  selectionUpdate: SelectionUpdate;
  selectionPlacement?: ContextPlacement | null;
  caretAnchor?: CaretAnchor | null;
  caretPlacement?: ContextPlacement | null;
  pageMenu?: {
    readonly invocationId: string;
    readonly placement: ContextPlacement;
    readonly pageIndex: number;
    readonly position: ReviewRect;
    readonly nearbyText?: string;
  } | null;
  placedPageNote?: {
    readonly token: number;
    readonly pageIndex: number;
    readonly position: ReviewRect;
    readonly nearbyText?: string;
  } | null;
  keyboardPageNoteActive?: boolean;
  onRequestKeyboardPageNote?(): void;
  onCancelKeyboardPageNote?(): void;
  onPageMenuDismiss?(invocationId: string): void;
  onPageMenuConsumed?(invocationId: string): void;
  onPlacedPageNoteConsumed?(token: number): void;
  onPageNoteComposerComplete?(): void;
  onSelectionConsumed?(generation: number): void;
  onCommand(
    command: ReviewCommand,
    authority?: AuthoringAuthority,
  ): Promise<ReviewState | RejectedReviewCommand>;
  authoringSessionResolution?: {
    readonly token: number;
    readonly outcome: 'accepted' | 'source-replaced';
  };
  /** Production-owned, read-only visibility/Return state for the active frozen anchor. */
  authoringAnchorNavigation?: {
    readonly token: number;
    readonly visibility: PdfTargetVisibility;
    readonly pending: boolean;
    readonly onReturn: () => void;
    readonly onCancelReturn?: () => void;
  };
  onAuthoringAnchorChange?(anchor: AuthoringAnchorSnapshot | null): void;
  onAuthoringActiveChange?(active: boolean): void;
  /** U3/U4 may publish measured overlay geometry without affecting viewer framing. */
  onAuthoringViewportChange?(viewport: PdfViewportQuery | null): void;
  onNavigate?(item: ReviewItem): void;
  onNavigateExisting?(item: ExistingAnnotation): void;
  existingAnnotations?: ExistingAnnotationsDiscovery;
  onRetryExistingAnnotations?(): void;
  activeItemId?: string | null;
  correspondingItemId?: string;
  activationRequest?: { readonly id: string; readonly token: number };
  onItemCorrespondenceChange?(id: string | undefined): void;
  onActiveItemChange?(id: string | undefined): void;
  viewerControls?: ViewerControls;
  viewerState?: ViewerControlsSnapshot;
  viewerFraming?: ViewerFramingControls;
  viewerNavigation?: PdfViewerNavigation;
  codexContext?: LiveContextBindingStatus;
  copyLink?: CopyLinkControlProps;
  copyItemLink?: {
    readonly getLink: (item: ReviewItem) => string;
    readonly disabled?: (item: ReviewItem) => boolean;
    readonly writeText: (link: string) => Promise<void>;
  };
  /** The production shell may control workspace visibility and retained navigation state. */
  workspaceOpen?: boolean;
  navigationState?: ReferenceNavigationState;
  referenceTabs?: readonly ReferenceWorkspaceTab[];
  pendingReference?: PendingReferencePanel | null;
  referenceReturn?: ReferenceReturnControlState | null;
  outlineDiscovery?: PdfOutlineDiscovery;
  annotationOutlineLabels?: AnnotationOutlineLabels;
  currentOutlineItemId?: string | null;
  linkActionRequest?: ViewerPdfLinkInvocation | null;
  navigationAnnouncement?: string;
  canNavigateBack?: boolean;
  canNavigateForward?: boolean;
  onLinkActionChoose?(choice: LinkActionChoice, request: ViewerPdfLinkInvocation): void;
  onLinkActionDismiss?(request: ViewerPdfLinkInvocation, reason: LinkActionDismissReason): void;
  copyLinkForLinkAction?(request: ViewerPdfLinkInvocation): CopyLinkControlProps | undefined;
  onNavigateBack?(): void;
  onNavigateForward?(): void;
  onWorkspaceModeChange?(mode: WorkspaceMode): void;
  onWorkspaceDismiss?(): void;
  onReferenceTabActivate?(identity: string): void;
  onReferenceTabClose?(identity: string): void;
  onReferenceSendToMain?(identity: string): void;
  onReferenceRetry?(): void;
  onReferenceReturn?(identity: string): void;
  onOutlineActivate?(item: PdfOutlineItem): void;
  onOutlineReference?(item: PdfOutlineItem): void;
  copyLinkForOutlineItem?(item: PdfOutlineItem): PdfDestinationCopyLink | undefined;
  onReferenceViewportHost?(element: HTMLDivElement | null): void;
  onWorkspaceModeFocusTokenChange?(mode: WorkspaceMode, token: string): void;
  referenceLayoutState?: ReferenceWorkspaceLayoutState;
  onReferenceLayoutAction?(action: ReferenceWorkspaceLayoutAction): void;
  rightWorkspaceMode?: RightWorkspaceMode;
  search?: ReactNode;
  viewerNavigationIntentToken?: number;
  onCommitMainFramingPositionChange?(commit: (() => void) | null): void;
  children?: ReactNode;
}

export interface RejectedReviewCommand {
  readonly accepted: false;
  readonly state: ReviewState;
  readonly message: string;
  readonly reason?: 'rejected' | 'save-destination' | 'stale-authoring';
}

export function controlledWorkspaceSurfaceAction(input: {
  readonly open: boolean;
  readonly baseSurface: ReviewBaseSurface;
  readonly transientSurface: 'none' | 'selection-actions' | 'insert-action' | 'page-menu' | 'page-note-cursor';
  readonly mode: WorkspaceMode;
}): ReviewSurfaceAction | null {
  if (input.open) {
    return input.baseSurface !== 'workspace' || input.transientSurface !== 'none'
      ? { type: 'open-workspace', mode: input.mode }
      : null;
  }
  return input.baseSurface === 'workspace'
    ? { type: 'hide-workspace', focusReturnToken: BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN }
    : null;
}

export function workspaceIsVisible(requestedOpen: boolean, _baseSurface: ReviewBaseSurface): boolean {
  return requestedOpen;
}

interface PointerScrollGesture {
  readonly id: number;
  readonly scroll: ViewerPosition | null;
}

function mutableField(item: ReviewItem): 'proposedText' | 'comment' | undefined {
  if (item.kind === 'replace' || item.kind === 'insert') return 'proposedText';
  if (item.kind === 'highlight' || item.kind === 'pageNote') return 'comment';
  return undefined;
}

export function ReviewShell(props: ReviewShellProps) {
  const [localReferenceLayout, dispatchLocalReferenceLayout] = useReducer(
    reduceReferenceWorkspaceLayout,
    undefined,
    () => {
      let initial = createReferenceWorkspaceLayout({ width: 1440, height: 900 });
      if (props.workspaceOpen === true || props.listOpen === true) {
        const initialMode = props.listOpen === true
          ? 'annotations'
          : props.navigationState?.workspace.lastMode ?? 'outline';
        initial = reduceReferenceWorkspaceLayout(initial, initialMode === 'references'
          ? { type: 'show-references' }
          : { type: 'show-right-workspace' });
      }
      return initial;
    },
  );
  const [surface, dispatchSurface] = useReducer(
    reduceReviewSurface,
    props.workspaceOpen === true
      ? reduceReviewSurface(INITIAL_REVIEW_SURFACE_STATE, {
          type: 'open-workspace',
          mode: props.navigationState?.workspace.lastMode ?? 'outline',
        })
      : props.listOpen === true
      ? reduceReviewSurface(INITIAL_REVIEW_SURFACE_STATE, {
          type: 'open-workspace',
          mode: 'annotations',
        })
      : INITIAL_REVIEW_SURFACE_STATE,
  );
  const [authoringSession, setAuthoringSession] = useState<AuthoringSession | null>(null);
  const authoringSessionRef = useRef<AuthoringSession | null>(null);
  const authoringSessionTokenRef = useRef(0);
  const authoringEditorRef = useRef<HTMLTextAreaElement>(null);
  const saveOptionsWasOpenRef = useRef(props.saveOptionsOpen ?? false);
  const [authoringSurfaceElement, setAuthoringSurfaceElement] = useState<HTMLElement | null>(null);
  const [authoringReading, setAuthoringReading] = useState(false);
  const [localActiveItemId, setLocalActiveItemId] = useState<string>();
  const activeItemId = props.activeItemId === undefined
    ? localActiveItemId
    : props.activeItemId ?? undefined;
  const presentedActiveItemId = authoringSession === null
    ? activeItemId
    : authoringSession.workspace.activeItemId;
  const [consumedSelectionGeneration, setConsumedSelectionGeneration] = useState<number>();
  const [listActivation, setListActivation] = useState<{ readonly id: string; readonly token: number }>();
  const [peekItemId, setPeekItemId] = useState<string>();
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const peekHeldRef = useRef(false);
  const peekTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [announcement, setAnnouncement] = useState(`Review revision ${props.state.revision}.`);

  useEffect(() => {
    props.onAuthoringAnchorChange?.(
      authoringSession === null ? null : authoringAnchorSnapshot(authoringSession),
    );
  }, [authoringSession, props.onAuthoringAnchorChange]);
  useEffect(() => {
    const wasOpen = saveOptionsWasOpenRef.current;
    const isOpen = props.saveOptionsOpen ?? false;
    saveOptionsWasOpenRef.current = isOpen;
    if (!wasOpen || isOpen || authoringSessionRef.current === null) return;
    requestAnimationFrame(() => authoringEditorRef.current?.focus({ preventScroll: true }));
  }, [props.saveOptionsOpen]);
  useLayoutEffect(() => {
    if (authoringSurfaceElement === null) {
      props.onAuthoringViewportChange?.(null);
      return;
    }
    let frame = 0;
    const publish = () => {
      frame = 0;
      const rect = authoringSurfaceElement.getBoundingClientRect();
      props.onAuthoringViewportChange?.({
        occlusion: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        },
      });
    };
    const schedulePublish = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(publish);
    };
    publish();
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(schedulePublish);
    observer?.observe(authoringSurfaceElement);
    window.addEventListener('resize', schedulePublish);
    window.addEventListener('scroll', schedulePublish, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', schedulePublish);
      window.removeEventListener('scroll', schedulePublish, true);
      props.onAuthoringViewportChange?.(null);
    };
  }, [authoringSurfaceElement, props.onAuthoringViewportChange]);
  const acknowledgedRef = useRef(props.state);
  const commandTailRef = useRef<Promise<ReviewState>>(Promise.resolve(props.state));
  const pageNoteTriggerRef = useRef<HTMLButtonElement>(null);
  const surfaceTriggersRef = useRef(new Map<ReviewBaseSurface, HTMLElement>());
  const rightWorkspaceRailRef = useRef<HTMLButtonElement>(null);
  const bottomWorkspaceRailRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const pointerScrollRef = useRef<PointerScrollGesture | undefined>(undefined);
  const annotationRequestTokenRef = useRef(0);
  const [workspaceRequest, setWorkspaceRequest] = useState<WorkspaceOpenRequest>({
    kind: 'reading',
    token: 0,
  });
  const setActiveItem = (id: string | undefined) => {
    if (props.activeItemId === undefined) setLocalActiveItemId(id);
    props.onActiveItemChange?.(id);
  };
  const navigation = props.navigationState ?? surface.navigation;
  const currentAuthoringAuthority = authoringAuthorityFor(
    props.state,
    navigation.documentGeneration,
  );
  const currentAuthoringAuthorityRef = useRef(currentAuthoringAuthority);
  currentAuthoringAuthorityRef.current = currentAuthoringAuthority;
  const referenceTabs = props.referenceTabs ?? navigation.tabs.map((tab) => ({
    identity: tab.identity,
    label: `Page ${tab.originalTarget.pageIndex + 1}`,
    pageContext: `Page ${tab.originalTarget.pageIndex + 1}`,
  }));
  const referencesAvailable = referenceTabs.length > 0 || props.pendingReference != null;
  const outlineDiscovery = props.outlineDiscovery;
  const visibleOutlineDiscovery = useMemo<PdfOutlineDiscovery>(() => (
    outlineDiscovery?.documentGeneration === navigation.documentGeneration
      ? outlineDiscovery
      : { status: 'loading', documentGeneration: navigation.documentGeneration }
  ), [navigation.documentGeneration, outlineDiscovery]);
  const outlineAbsent = visibleOutlineDiscovery.status === 'loaded-empty';
  const showAnnotationOutlineLabels = visibleOutlineDiscovery.status === 'loaded-tree';
  const existingAnnotations = props.existingAnnotations ?? { status: 'loading', generation: 0 };
  const annotationsAvailable = props.state.items.length > 0
    || (existingAnnotations.status === 'ready' && existingAnnotations.items.length > 0);
  const workspaceRequestedOpen = props.workspaceOpen ?? surface.baseSurface === 'workspace';
  const workspaceOpen = workspaceIsVisible(workspaceRequestedOpen, surface.baseSurface);
  const workspaceMode = navigation.workspace.lastMode;
  const visibleWorkspaceModes = WORKSPACE_MODES.filter((mode) => (
    (referencesAvailable || mode !== 'references')
    && (!outlineAbsent || mode !== 'outline')
    && (annotationsAvailable || mode !== 'annotations')
  ));
  const visibleRightWorkspaceModes = visibleWorkspaceModes.filter(
    (mode): mode is RightWorkspaceMode => mode !== 'references',
  );
  const requestedRightWorkspaceMode: RightWorkspaceMode = props.rightWorkspaceMode
    ?? (workspaceMode === 'references' ? 'outline' : workspaceMode);
  const rightWorkspaceMode: RightWorkspaceMode = visibleRightWorkspaceModes.includes(
    requestedRightWorkspaceMode,
  ) ? requestedRightWorkspaceMode : visibleRightWorkspaceModes[0] ?? 'search';
  const visibleWorkspaceMode: WorkspaceMode = visibleWorkspaceModes.includes(workspaceMode)
    ? workspaceMode
    : rightWorkspaceMode;
  const referenceLayout = props.referenceLayoutState ?? localReferenceLayout;
  const referenceLayoutControlled = props.referenceLayoutState !== undefined;
  const effectiveReferenceLayout = deriveReferenceWorkspaceLayout(
    referenceLayout,
    rightWorkspaceMode,
    visibleWorkspaceMode,
  );
  const dispatchReferenceLayout = (action: ReferenceWorkspaceLayoutAction) => {
    if (props.referenceLayoutState === undefined) dispatchLocalReferenceLayout(action);
    props.onReferenceLayoutAction?.(action);
  };
  const referenceSurfaceOpen = effectiveReferenceLayout.kind === 'narrow-unified'
    ? effectiveReferenceLayout.open
    : effectiveReferenceLayout.referenceDock === 'right'
      ? effectiveReferenceLayout.rightWorkspaceOpen
      : effectiveReferenceLayout.bottomReferencesOpen;
  const rightSurfaceOpen = effectiveReferenceLayout.kind !== 'narrow-unified'
    && effectiveReferenceLayout.rightWorkspaceOpen;
  const sharedWorkspace = effectiveReferenceLayout.kind === 'narrow-unified'
    || effectiveReferenceLayout.referenceDock === 'right';
  const toolsSurfaceOpen = effectiveReferenceLayout.kind === 'narrow-unified'
    ? effectiveReferenceLayout.open
    : effectiveReferenceLayout.referenceDock === 'bottom'
      ? rightSurfaceOpen
      : referenceSurfaceOpen;
  const requestedEffectiveWorkspaceMode = effectiveReferenceLayout.kind === 'narrow-unified'
    ? effectiveReferenceLayout.activeMode
    : effectiveReferenceLayout.referenceDock === 'bottom' ? rightWorkspaceMode : visibleWorkspaceMode;
  const effectiveWorkspaceMode: WorkspaceMode = visibleWorkspaceModes.includes(
    requestedEffectiveWorkspaceMode,
  ) ? requestedEffectiveWorkspaceMode : rightWorkspaceMode;
  const anyWorkspaceOpen = workspaceOpen || referenceSurfaceOpen || toolsSurfaceOpen;
  const annotationsVisible = anyWorkspaceOpen && effectiveWorkspaceMode === 'annotations';
  const selectionAnchor = reliableSelection(props.selectionUpdate);
  const selectionActionsAvailable = selectionAnchor !== null
    && props.selectionUpdate.generation !== consumedSelectionGeneration;
  const lastPlacedPageNoteToken = useRef<number | undefined>(undefined);
  const workspaceFraming = useWorkspaceFraming({
    workspaceOpen: anyWorkspaceOpen,
    ...(props.viewerFraming === undefined ? {} : { controls: props.viewerFraming }),
    request: workspaceRequest,
    documentGeneration: navigation.documentGeneration,
    layoutGeneration: [
      effectiveReferenceLayout.kind,
      referenceSurfaceOpen,
      toolsSurfaceOpen,
      referenceLayout.referenceDock,
      referenceLayout.rightReferenceWidth,
      referenceLayout.bottomReferenceHeight,
    ].join(':'),
  });

  useLayoutEffect(() => {
    const action: ReferenceWorkspaceLayoutAction = {
      type: 'set-stage-size',
      width: workspaceFraming.stageSize.width,
      height: workspaceFraming.stageSize.height,
    };
    if (!referenceLayoutControlled) dispatchLocalReferenceLayout(action);
    props.onReferenceLayoutAction?.(action);
  }, [
    props.onReferenceLayoutAction,
    referenceLayoutControlled,
    workspaceFraming.stageSize.height,
    workspaceFraming.stageSize.width,
  ]);

  useLayoutEffect(() => {
    dispatchReferenceLayout({
      type: 'set-regime',
      regime: workspaceFraming.presentation === 'right' ? 'wide' : 'narrow',
    });
  }, [workspaceFraming.presentation]);

  useLayoutEffect(() => {
    if (props.workspaceOpen === undefined) return;
    if (authoringSessionRef.current !== null) return;
    const action = controlledWorkspaceSurfaceAction({
      open: props.workspaceOpen,
      baseSurface: surface.baseSurface,
      transientSurface: surface.transientSurface,
      mode: workspaceMode,
    });
    if (action !== null) dispatchSurface(action);
  }, [props.workspaceOpen, surface.baseSurface, surface.transientSurface, workspaceMode]);

  useLayoutEffect(() => {
    if (searchFocusRequest === 0 || !toolsSurfaceOpen || effectiveWorkspaceMode !== 'search') return;
    let cancelled = false;
    let frame = 0;
    let attempts = 0;
    const focusQuery = () => {
      if (cancelled) return;
      const query = shellRef.current
        ?.querySelector<HTMLInputElement>('[data-workspace-focus-token="search:query"]');
      if (
        query
        && query.closest('[inert]') === null
        && getComputedStyle(query).visibility !== 'hidden'
      ) {
        query.focus({ preventScroll: true });
        if (document.activeElement === query) return;
      }
      attempts += 1;
      if (attempts < 30) frame = requestAnimationFrame(focusQuery);
    };
    frame = requestAnimationFrame(focusQuery);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [effectiveWorkspaceMode, searchFocusRequest, toolsSurfaceOpen]);

  useEffect(() => {
    if (props.selectionUpdate.kind !== 'reliable') setConsumedSelectionGeneration(undefined);
  }, [props.selectionUpdate.kind, props.selectionUpdate.generation]);

  const dismissPageNoteAuthority = () => {
    if (props.keyboardPageNoteActive) props.onCancelKeyboardPageNote?.();
    if (props.pageMenu) props.onPageMenuDismiss?.(props.pageMenu.invocationId);
  };
  const clearPeekTimer = () => {
    if (peekTimerRef.current !== undefined) clearTimeout(peekTimerRef.current);
    peekTimerRef.current = undefined;
  };
  useEffect(() => {
    clearPeekTimer();
    if (anyWorkspaceOpen) {
      setPeekItemId(undefined);
      return;
    }
    const id = props.correspondingItemId;
    if (id) {
      peekTimerRef.current = setTimeout(() => setPeekItemId(id), 320);
    } else if (!peekHeldRef.current) {
      peekTimerRef.current = setTimeout(() => setPeekItemId(undefined), 180);
    }
    return clearPeekTimer;
  }, [anyWorkspaceOpen, props.correspondingItemId]);

  useEffect(() => {
    const request = props.activationRequest;
    if (!request || authoringSessionRef.current !== null) return;
    setActiveItem(request.id);
    setListActivation(request);
    setPeekItemId(undefined);
    const item = props.state.items.find(({ id }) => id === request.id);
    setWorkspaceRequest(item
      ? {
          kind: 'mark',
          reviewId: item.id,
          pageIndex: item.pageIndex,
          token: ++annotationRequestTokenRef.current,
        }
      : { kind: 'reading', token: ++annotationRequestTokenRef.current });
    dismissPageNoteAuthority();
    dispatchSurface({ type: 'open-workspace', mode: 'annotations' });
    dispatchReferenceLayout({ type: 'show-right-workspace' });
    dispatchReferenceLayout({ type: 'focus-surface', surface: 'right' });
    props.onWorkspaceModeChange?.('annotations');
  }, [props.activationRequest?.id, props.activationRequest?.token]);

  const selectWorkspaceMode = (mode: WorkspaceMode) => {
    if (authoringSessionRef.current !== null) return;
    if (mode === 'annotations' && (!workspaceOpen || workspaceMode !== 'annotations')) {
      setWorkspaceRequest({ kind: 'reading', token: ++annotationRequestTokenRef.current });
    }
    dispatchSurface({
      type: 'reference-navigation',
      action: { type: 'select-workspace-mode', mode },
    });
    dispatchReferenceLayout({
      type: 'focus-surface',
      surface: mode === 'references' ? 'references' : 'right',
    });
    props.onWorkspaceModeChange?.(mode);
  };
  const acknowledgedAuthority = authoringAuthorityFor(
    acknowledgedRef.current,
    navigation.documentGeneration,
  );
  if (!authoringAuthorityMatches(acknowledgedAuthority, currentAuthoringAuthority)) {
    acknowledgedRef.current = props.state;
    commandTailRef.current = Promise.resolve(props.state);
  } else if (props.state.revision >= acknowledgedRef.current.revision) {
    acknowledgedRef.current = props.state;
  }

  const submit = (
    build: (state: ReviewState) => ReviewCommand,
    options?: {
      readonly authority?: AuthoringAuthority;
      readonly onAccepted?: () => void;
      readonly onStale?: () => void;
    },
  ): Promise<ReviewState> => {
    const result = commandTailRef.current.then(async () => {
      if (
        options?.authority !== undefined
        && !authoringAuthorityMatches(options.authority, currentAuthoringAuthorityRef.current)
      ) {
        setAnnouncement('This draft belonged to the previous document and was not applied.');
        options.onStale?.();
        return acknowledgedRef.current;
      }
      const command = build(acknowledgedRef.current);
      const result = await props.onCommand(command, options?.authority);
      if (
        options?.authority !== undefined
        && !authoringAuthorityMatches(options.authority, currentAuthoringAuthorityRef.current)
      ) {
        setAnnouncement('This draft belonged to the previous document and was not applied.');
        options.onStale?.();
        return acknowledgedRef.current;
      }
      const accepted = !('accepted' in result);
      const next = accepted ? result : result.state;
      acknowledgedRef.current = next;
      setAnnouncement(accepted ? `Review revision ${next.revision} saved.` : result.message);
      if (accepted) options?.onAccepted?.();
      return next;
    });
    commandTailRef.current = result.catch(() => acknowledgedRef.current);
    return result;
  };
  const consumeSelectionActions = (generation: number) => {
    setConsumedSelectionGeneration(generation);
    props.onSelectionConsumed?.(generation);
  };

  const snapshotAuthoringWorkspace = () => ({
    open: anyWorkspaceOpen,
    mode: effectiveWorkspaceMode,
    ...(activeItemId === undefined ? {} : { activeItemId }),
    annotationScrollTop: shellRef.current
      ?.querySelector<HTMLElement>('[data-annotation-scroll-viewport]')
      ?.scrollTop ?? 0,
  });

  const beginAuthoring = (
    source: AuthoringSource,
    originKind: AuthoringOriginKind,
    trigger: HTMLElement | null,
  ): boolean => {
    if (!canStartAuthoringSession(authoringSessionRef.current)) return false;
    inputControllerRef.current?.clearDraft();
    const session = createAuthoringSession({
      token: ++authoringSessionTokenRef.current,
      authority: currentAuthoringAuthorityRef.current,
      source,
      origin: { kind: originKind, trigger },
      workspace: snapshotAuthoringWorkspace(),
    });
    authoringSessionRef.current = session;
    props.onAuthoringActiveChange?.(true);
    setAuthoringReading(false);
    setAuthoringSession(session);
    dispatchSurface({ type: 'open-nested' });
    return true;
  };

  const handleInputIntent = (intent: ProofreadInputIntent) => {
    if (authoringSessionRef.current !== null) {
      inputControllerRef.current?.clearDraft();
      return;
    }
    const selectionGeneration = props.selectionUpdate.kind === 'reliable'
      ? props.selectionUpdate.generation
      : undefined;
    if (intent.kind === 'delete') {
      void submit(
        (state) => addDelete(state, intent.anchor),
        selectionGeneration === undefined
          ? undefined
          : { onAccepted: () => consumeSelectionActions(selectionGeneration) },
      );
      return;
    }
    const trigger = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (intent.kind === 'replaceDraft') {
      if (selectionGeneration === undefined) {
        setAnnouncement('Select reliable text to suggest a replacement.');
        return;
      }
      beginAuthoring({
        kind: 'replace',
        anchor: intent.anchor,
        initialValue: intent.initialText,
        selectionGeneration,
      }, 'typing', trigger);
    } else {
      beginAuthoring({
        kind: 'insert',
        anchor: intent.anchor,
        initialValue: intent.initialText,
      }, 'typing', trigger);
    }
  };

  const inputIntentRef = useRef(handleInputIntent);
  inputIntentRef.current = handleInputIntent;
  const inputControllerRef = useRef<ReturnType<typeof createProofreadInputController> | null>(null);
  if (inputControllerRef.current === null) {
    inputControllerRef.current = createProofreadInputController((intent) => inputIntentRef.current(intent));
  }
  const inputController = inputControllerRef.current;
  const closeAuthoringSession = (
    token: number,
    reason: 'accepted' | 'cancelled' | 'source-replaced',
  ) => {
    const current = authoringSessionRef.current;
    if (current === null || current.token !== token) return;
    authoringSessionRef.current = null;
    props.onAuthoringActiveChange?.(false);
    setAuthoringSession(null);
    setAuthoringReading(false);
    inputController.clearDraft();
    dispatchSurface({ type: 'close-nested' });
    if (current.source.kind === 'pageNote') props.onPageNoteComposerComplete?.();
    if (reason === 'source-replaced') return;
    setActiveItem(current.workspace.activeItemId);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const shell = shellRef.current;
      if (shell === null) return;
      const viewport = shell.querySelector<HTMLElement>('[data-annotation-scroll-viewport]');
      if (viewport !== null) viewport.scrollTop = current.workspace.annotationScrollTop;
      const originTrigger = current.origin.trigger;
      const restoredItem = current.workspace.activeItemId === undefined
        ? null
        : [...shell.querySelectorAll<HTMLElement>('[data-review-item]')]
          .find((element) => element.dataset.reviewItem === current.workspace.activeItemId);
      const target = originTrigger?.isConnected === true
        ? originTrigger
        : current.origin.kind === 'tray-edit'
          ? restoredItem?.querySelector<HTMLElement>('[data-annotation-action="edit"]')
          : null;
      const workspaceFallback = current.workspace.open
        ? shell.querySelector<HTMLElement>(`#workspace-panel-${current.workspace.mode}`)
        : null;
      (target
        ?? workspaceFallback
        ?? shell.querySelector<HTMLElement>(
          '.pdf-workspace:not(.pdf-workspace--reference) [data-page-index], [role="application"]',
        ))?.focus({ preventScroll: true });
    }));
  };
  const dismissAuthoring = async (session: AuthoringSession) => {
    if (
      props.authoringAnchorNavigation?.token === session.token
      && props.authoringAnchorNavigation.pending
    ) await props.authoringAnchorNavigation.onCancelReturn?.();
    closeAuthoringSession(session.token, 'cancelled');
  };
  const closeNested = async () => {
    const current = authoringSessionRef.current;
    if (current !== null) await dismissAuthoring(current);
  };

  useLayoutEffect(() => {
    const current = authoringSessionRef.current;
    if (
      current === null
      || authoringSessionIsCurrent(current, currentAuthoringAuthority)
    ) return;
    if (
      props.authoringAnchorNavigation?.token === current.token
      && props.authoringAnchorNavigation.pending
    ) props.authoringAnchorNavigation.onCancelReturn?.();
    setAnnouncement('This draft belonged to the previous document and was not applied.');
    closeAuthoringSession(current.token, 'source-replaced');
  }, [currentAuthoringAuthority.documentGeneration, currentAuthoringAuthority.sourceIdentity]);

  useEffect(() => {
    const resolution = props.authoringSessionResolution;
    const current = authoringSessionRef.current;
    if (resolution === undefined || current === null) return;
    if (resolution.outcome === 'accepted') {
      if (current.source.kind === 'replace' || current.source.kind === 'highlight') {
        consumeSelectionActions(current.source.selectionGeneration);
      }
      closeAuthoringSession(current.token, 'accepted');
      return;
    }
    setAnnouncement('This draft belonged to the previous document and was not applied.');
    closeAuthoringSession(current.token, 'source-replaced');
  }, [props.authoringSessionResolution?.token]);
  useLayoutEffect(() => {
    inputController.focusChanged(isEditableTarget(document.activeElement));
    inputController.setContext({
      caret: props.caretAnchor ?? null,
      selectionUpdate: props.selectionUpdate,
    });
  }, [inputController, props.caretAnchor, props.selectionUpdate]);

  const beforeInput = (event: FormEvent<HTMLDivElement>) => {
    if (
      authoringSessionRef.current !== null
      && !isEditableTarget(event.target)
    ) {
      inputController.clearDraft();
      event.preventDefault();
      return;
    }
    const native = event.nativeEvent as InputEvent;
    inputController.beforeInput({
      inputType: native.inputType,
      data: native.data,
      isComposing: native.isComposing,
      defaultPrevented: event.defaultPrevented,
      target: event.target,
      preventDefault: () => event.preventDefault(),
    });
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.target instanceof Element
      && (
        (props.linkActionRequest && event.target.closest('[data-link-action-popover]') !== null)
        || event.target.closest('[data-row-actions-open="true"]') !== null
      )
    ) return;
    const editable = isEditableTarget(event.target);
    if (
      (event.metaKey || event.ctrlKey)
      && !event.altKey
      && !event.shiftKey
      && event.key.toLowerCase() === 'f'
      && !event.nativeEvent.isComposing
      && surface.nestedLayer === 'none'
      && authoringSessionRef.current === null
    ) {
      event.preventDefault();
      setSearchFocusRequest((request) => request + 1);
      selectWorkspaceMode('search');
      dispatchReferenceLayout({ type: 'show-right-workspace' });
      return;
    }
    if (workspaceOpen && !editable && !isWorkspaceOrChrome(event.target)) {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        markFramingUserIntent({ left: true });
      }
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        markFramingUserIntent({ top: true });
      }
    }
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      if (
        event.target instanceof Element
        && event.target.closest('[data-review-page-editor], [data-review-zoom-editor]') !== null
      ) {
        return;
      }
      if (peekItemId !== undefined) {
        event.preventDefault();
        clearPeekTimer();
        peekHeldRef.current = false;
        setPeekItemId(undefined);
        return;
      }
      if (surface.nestedLayer !== 'none') {
        event.preventDefault();
        void closeNested();
        return;
      }
      if (props.keyboardPageNoteActive) {
        event.preventDefault();
        props.onCancelKeyboardPageNote?.();
        dispatchSurface({ type: 'close-transient' });
        return;
      }
      if (props.pageMenu) {
        event.preventDefault();
        props.onPageMenuDismiss?.(props.pageMenu.invocationId);
        dispatchSurface({ type: 'close-transient' });
        return;
      }
      if (anyWorkspaceOpen || surface.baseSurface !== 'reading') {
        event.preventDefault();
        closeWorkspace();
        return;
      }
    }
    if (authoringSessionRef.current !== null && !editable) {
      inputController.clearDraft();
      if (
        event.key === 'Backspace'
        || event.key === 'Delete'
        || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z')
        || (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey)
      ) event.preventDefault();
      return;
    }
    if (event.defaultPrevented || editable || event.nativeEvent.isComposing) return;
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      const tool = reviewActionForKey(event.key);
      if (tool) {
        event.preventDefault();
        if (authoringSessionRef.current !== null) return;
        if (tool === 'replace') startReplacement();
        if (tool === 'delete') deleteSelection();
        if (tool === 'highlight') startHighlight();
        if (tool === 'pageNote') {
          props.onRequestKeyboardPageNote?.();
          dispatchSurface({ type: 'open-transient', surface: 'page-note-cursor' });
        }
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      void submit((state) => event.shiftKey ? redoReview(state) : undoReview(state));
      return;
    }
    inputController.keyDown({
      key: event.key,
      isComposing: event.nativeEvent.isComposing,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      defaultPrevented: event.defaultPrevented,
      editable,
      target: event.target,
      preventDefault: () => event.preventDefault(),
    });
  };
  const compositionEnd = (event: CompositionEvent<HTMLDivElement>) => {
    if (authoringSessionRef.current !== null && !isEditableTarget(event.target)) {
      inputController.clearDraft();
      return;
    }
    inputController.compositionEnd(event.data, event.target);
  };

  const startHighlight = () => {
    if (authoringSessionRef.current !== null) return;
    const anchor = selectionAnchor;
    const selectionGeneration = props.selectionUpdate.kind === 'reliable'
      ? props.selectionUpdate.generation
      : undefined;
    if (!anchor || selectionGeneration === undefined) {
      setAnnouncement('Select reliable text to add a highlight.');
      return;
    }
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    beginAuthoring({ kind: 'highlight', anchor, selectionGeneration }, 'selection', trigger);
  };

  const startReplacement = () => {
    if (authoringSessionRef.current !== null) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!selectionAnchor || props.selectionUpdate.kind !== 'reliable') {
      setAnnouncement('Select reliable text to suggest a replacement.');
      return;
    }
    beginAuthoring({
      kind: 'replace',
      anchor: selectionAnchor,
      initialValue: '',
      selectionGeneration: props.selectionUpdate.generation,
    }, 'selection', trigger);
  };

  const deleteSelection = () => {
    const selectionGeneration = props.selectionUpdate.kind === 'reliable'
      ? props.selectionUpdate.generation
      : undefined;
    if (!selectionAnchor || selectionGeneration === undefined) {
      setAnnouncement('Select reliable text to suggest deletion.');
      return;
    }
    void submit(
      (state) => addDelete(state, selectionAnchor),
      { onAccepted: () => consumeSelectionActions(selectionGeneration) },
    );
  };

  const startPageNote = (anchor?: { pageIndex: number; position: ReviewRect; nearbyText?: string } | null) => {
    if (authoringSessionRef.current !== null) return;
    if (!anchor) {
      setAnnouncement('Choose a safe page location to add a Page Note.');
      return;
    }
    const trigger = pageNoteTriggerRef.current
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    beginAuthoring({ kind: 'pageNote', ...anchor }, 'page', trigger);
  };

  useEffect(() => {
    const placed = props.placedPageNote;
    if (!placed || placed.token === lastPlacedPageNoteToken.current) return;
    lastPlacedPageNoteToken.current = placed.token;
    startPageNote(placed);
    props.onPlacedPageNoteConsumed?.(placed.token);
  }, [props.placedPageNote]);

  const submitAuthoring = async (
    session: AuthoringSession,
    build: (state: ReviewState) => ReviewCommand,
    onAccepted?: () => void,
  ) => {
    let accepted = false;
    await submit(build, {
      authority: session.authority,
      onAccepted: () => {
        accepted = true;
        onAccepted?.();
      },
      onStale: () => closeAuthoringSession(session.token, 'source-replaced'),
    });
    if (accepted) closeAuthoringSession(session.token, 'accepted');
  };

  const saveAuthoring = async (session: AuthoringSession, value: string) => {
    const source = session.source;
    if (source.kind === 'replace') {
      await submitAuthoring(
        session,
        (state) => addReplace(state, source.anchor, value),
        () => consumeSelectionActions(source.selectionGeneration),
      );
      return;
    }
    if (source.kind === 'insert') {
      await submitAuthoring(session, (state) => addInsert(state, source.anchor, value));
      return;
    }
    if (source.kind === 'highlight') {
      await submitAuthoring(
        session,
        (state) => addHighlight(state, source.anchor, value),
        () => consumeSelectionActions(source.selectionGeneration),
      );
      return;
    }
    if (source.kind === 'pageNote') {
      await submitAuthoring(session, (state) => addPageNote(
        state,
        source.pageIndex,
        source.position,
        value,
        undefined,
        source.nearbyText,
      ));
      return;
    }
    const field = mutableField(source.item);
    if (field === undefined) return;
    await submitAuthoring(
      session,
      (state) => editReviewItem(state, source.item.id, { [field]: value }),
    );
  };

  const canUndo = props.state.historyCursor > 0;
  const canRedo = props.state.historyCursor < props.state.history.length;
  const closeWorkspace = () => {
    dismissPageNoteAuthority();
    const closingReferences = effectiveWorkspaceMode === 'references';
    const bottomRail = effectiveReferenceLayout.kind === 'narrow-unified'
      || (closingReferences && effectiveReferenceLayout.referenceDock === 'bottom');
    const focusReturnToken = bottomRail
      ? BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN
      : RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN;
    dispatchSurface({ type: 'hide-workspace', focusReturnToken });
    dispatchReferenceLayout(effectiveReferenceLayout.kind === 'narrow-unified'
      ? { type: 'toggle-narrow-workspace' }
      : closingReferences
        ? { type: 'hide-references' }
        : { type: 'hide-right-workspace' });
    if (closingReferences) props.onWorkspaceDismiss?.();
    requestAnimationFrame(() => (bottomRail ? bottomWorkspaceRailRef : rightWorkspaceRailRef)
      .current?.focus({ preventScroll: true }));
  };
  const focusWorkspaceModeAfterLayout = (mode: WorkspaceMode) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const shell = shellRef.current;
      const target = mode === 'references'
        ? shell?.querySelector<HTMLElement>('[data-reference-tab][aria-selected="true"]')
          ?? shell?.querySelector<HTMLElement>('[data-reference-empty]')
        : mode === 'search'
          ? shell?.querySelector<HTMLElement>('[data-workspace-focus-token="search:query"]')
        : shell?.querySelector<HTMLElement>(`#workspace-panel-${mode}`);
      target?.focus({ preventScroll: true });
    }));
  };
  const rememberWorkspaceModeFocus = (mode: WorkspaceMode, token: string) => {
    if (props.navigationState === undefined) {
      dispatchSurface({
        type: 'reference-navigation',
        action: {
          type: 'remember-workspace-view',
          mode,
          logicalScrollToken: surface.navigation.workspace.modes[mode].logicalScrollToken,
          logicalFocusToken: token,
        },
      });
    }
    props.onWorkspaceModeFocusTokenChange?.(mode, token);
  };
  const markFramingUserIntent = workspaceFraming.markUserIntent;
  const commitMainFramingPosition = useCallback(() => {
    markFramingUserIntent(undefined, { captureSettledPosition: false });
  }, [markFramingUserIntent]);
  useLayoutEffect(() => {
    props.onCommitMainFramingPositionChange?.(commitMainFramingPosition);
    return () => props.onCommitMainFramingPositionChange?.(null);
  }, [commitMainFramingPosition, props.onCommitMainFramingPositionChange]);
  useLayoutEffect(() => {
    if ((props.viewerNavigationIntentToken ?? 0) > 0) {
      commitMainFramingPosition();
    }
  }, [commitMainFramingPosition, props.viewerNavigationIntentToken]);
  const focusDocumentForAuthoring = () => {
    setAuthoringReading(true);
    requestAnimationFrame(() => shellRef.current
      ?.querySelector<HTMLElement>(
        '.pdf-workspace:not(.pdf-workspace--reference) [data-page-index], [role="application"]',
      )
      ?.focus({ preventScroll: true }));
  };
  const focusAuthoringEditor = () => {
    setAuthoringReading(false);
    requestAnimationFrame(() => authoringEditorRef.current?.focus({ preventScroll: true }));
  };
  const isWorkspaceOrChrome = (target: EventTarget | null) => (
    (target instanceof Node && (
      workspaceFraming.referenceSurfaceRef.current?.contains(target) === true
      || workspaceFraming.toolsSurfaceRef.current?.contains(target) === true
    ))
    || (target instanceof Element && target.closest(
      '[data-review-chrome], [data-review-nested-host], [data-comment-composer], [data-link-action-popover]',
    ) !== null)
  );
  const copyLinkForItem = (item: ReviewItem): CopyLinkControlProps | undefined => {
    if (props.copyItemLink === undefined) return undefined;
    const link = props.copyItemLink.getLink(item);
    return {
      getLink: () => link,
      writeText: props.copyItemLink.writeText,
      disabled: props.copyItemLink.disabled?.(item) ?? false,
    };
  };
  const activePdfLinkCopy = props.linkActionRequest === null
    || props.linkActionRequest === undefined
    || props.copyLinkForLinkAction === undefined
    ? undefined
    : props.copyLinkForLinkAction(props.linkActionRequest);
  const authoringComposer = authoringSession === null ? null : (() => {
    const source = authoringSession.source;
    const editField = source.kind === 'edit' ? mutableField(source.item) : undefined;
    if (source.kind === 'edit' && editField === undefined) return null;
    const initialValue = source.kind === 'replace' || source.kind === 'insert'
      ? source.initialValue
      : source.kind === 'edit'
        ? String(source.item.payload[editField!] ?? '')
        : '';
    const fieldLabel = source.kind === 'replace'
      ? 'Replacement'
      : source.kind === 'insert'
        ? 'Insertion'
        : source.kind === 'edit' && source.item.kind === 'replace'
          ? 'Replacement'
          : source.kind === 'edit' && source.item.kind === 'insert'
            ? 'Insertion'
            : undefined;
    const anchorNavigation = props.authoringAnchorNavigation?.token === authoringSession.token
      ? props.authoringAnchorNavigation
      : undefined;
    return <CommentComposer
      title={authoringSession.semantics.title}
      sourceContext={authoringSourceContext(source)}
      saveLabel={authoringSession.semantics.primaryLabel}
      optional={authoringSession.semantics.optional}
      allowWhitespace={authoringSession.semantics.allowWhitespace}
      {...(fieldLabel === undefined ? {} : { fieldLabel })}
      initialValue={initialValue}
      editorRef={authoringEditorRef}
      surfaceRef={setAuthoringSurfaceElement}
      onReadDocument={focusDocumentForAuthoring}
      anchorNavigation={anchorNavigation}
      onDismiss={() => dismissAuthoring(authoringSession)}
      {...(source.kind !== 'highlight'
        ? {}
        : { onSkip: () => saveAuthoring(authoringSession, '') })}
      onSave={(value) => saveAuthoring(authoringSession, value)}
    />;
  })();
  return (
    <section
      className="review-shell"
      onBeforeInputCapture={beforeInput}
      onKeyDownCapture={keyDown}
      onFocusCapture={(event) => {
        inputController.focusChanged(isEditableTarget(event.target));
        if (authoringSessionRef.current === null || !(event.target instanceof Element)) return;
        if (event.target.closest('[data-comment-composer]') !== null) setAuthoringReading(false);
        else if (event.target.closest('.pdf-workspace:not(.pdf-workspace--reference)') !== null) {
          setAuthoringReading(true);
        }
      }}
      onCompositionStartCapture={(event) => inputController.compositionStart(event.target)}
      onCompositionEndCapture={compositionEnd}
      ref={shellRef}
      onWheelCapture={(event) => {
        if (!workspaceOpen || isWorkspaceOrChrome(event.target)) return;
        markFramingUserIntent({
          left: event.deltaX !== 0 || (event.shiftKey && event.deltaY !== 0),
          top: event.deltaY !== 0 && !event.shiftKey,
        }, { stopAutomaticScroll: false });
      }}
      onPointerDownCapture={(event) => {
        if (!workspaceOpen || isWorkspaceOrChrome(event.target)) {
          pointerScrollRef.current = undefined;
          return;
        }
        if (!event.isPrimary || event.button !== 0) return;
        pointerScrollRef.current = {
          id: event.pointerId,
          scroll: workspaceFraming.currentScroll(),
        };
      }}
      onPointerUpCapture={(event) => {
        const start = pointerScrollRef.current;
        if (!workspaceOpen || !start || start.id !== event.pointerId) return;
        pointerScrollRef.current = undefined;
        const current = workspaceFraming.currentScroll();
        if (!start.scroll || !current) return;
        markFramingUserIntent({
          left: Math.abs(current.left - start.scroll.left) > 1,
          top: Math.abs(current.top - start.scroll.top) > 1,
        });
      }}
      onPointerCancelCapture={(event) => {
        if (pointerScrollRef.current?.id === event.pointerId) pointerScrollRef.current = undefined;
      }}
      onClickCapture={(event) => {
        if (
          authoringSessionRef.current === null
          && activeItemId !== undefined
          && event.button === 0
          && event.target instanceof Element
          && event.target.closest('[data-review-item], [data-owned-focus-id], [data-page-index]') === null
        ) setActiveItem(undefined);
        if (props.linkActionRequest) return;
        if (event.target instanceof Element) {
          const markTrigger = event.target.closest<HTMLElement>('[data-owned-focus-id]');
          if (markTrigger) surfaceTriggersRef.current.set('workspace', markTrigger);
        }
        if (
          workspaceOpen
          && event.target instanceof Element
          && event.target.closest('.review-chrome__viewer-controls') !== null
        ) {
          markFramingUserIntent();
        }
      }}
    >
      <ReviewChrome
        documentTitle={props.documentTitle ?? 'Local PDF'}
        {...(props.savedLabel === undefined ? {} : { savedLabel: props.savedLabel })}
        {...(props.savePhase === undefined ? {} : { savePhase: props.savePhase })}
        saveOptionsOpen={props.saveOptionsOpen ?? false}
        onSaveOptions={() => props.onSaveOptions?.()}
        {...(props.viewerControls === undefined ? {} : { controls: props.viewerControls })}
        viewerState={props.viewerState ?? unavailableViewerControls()}
        fitWidthReady={props.viewerNavigation?.fitToWidthReady() ?? false}
        {...(props.viewerNavigation === undefined ? {} : {
          beforeViewerAction: async () => {
            await props.viewerNavigation?.cancelPendingNavigation();
          },
        })}
        onFitWidth={() => props.viewerNavigation
          ?.fitToWidth(workspaceFraming.waitForSettledGeometry)
          .then(() => undefined)}
        canUndo={authoringSession === null && canUndo}
        canRedo={authoringSession === null && canRedo}
        canNavigateBack={props.canNavigateBack ?? false}
        canNavigateForward={props.canNavigateForward ?? false}
        {...(props.codexContext === undefined ? {} : { codexContext: props.codexContext })}
        {...(props.copyLink === undefined ? {} : { copyLink: props.copyLink })}
        onUndo={() => {
          if (authoringSessionRef.current === null) void submit(undoReview);
        }}
        onRedo={() => {
          if (authoringSessionRef.current === null) void submit(redoReview);
        }}
        onNavigateBack={() => props.onNavigateBack?.()}
        onNavigateForward={() => props.onNavigateForward?.()}
      />
      <div
        ref={workspaceFraming.stageRef}
        className="review-layout"
        data-review-stage
        data-reference-layout={effectiveReferenceLayout.kind}
        data-workspace-presentation={workspaceFraming.presentation}
        data-annotation-presentation={workspaceFraming.presentation}
        style={{
          '--workspace-side-width': `${workspaceFraming.sideWidth}px`,
          '--reference-right-width': `${effectiveReferenceLayout.kind === 'narrow-unified'
            ? referenceLayout.rightReferenceWidth : effectiveReferenceLayout.rightWidth}px`,
          '--reference-bottom-height': `${effectiveReferenceLayout.bottomHeight}px`,
          '--tools-right-width': `${effectiveReferenceLayout.kind === 'narrow-unified'
            ? referenceLayout.rightReferenceWidth : effectiveReferenceLayout.rightWidth}px`,
          '--tools-bottom-offset': `${effectiveReferenceLayout.kind === 'wide-split'
            ? effectiveReferenceLayout.bottomHeight : 0}px`,
          '--tools-bottom-height': `${effectiveReferenceLayout.kind === 'narrow-unified'
            ? effectiveReferenceLayout.bottomHeight : referenceLayout.bottomReferenceHeight}px`,
        } as CSSProperties}
      >
        <div className="review-document">{props.children}</div>
        <div className="review-contextual-host" data-review-contextual-host>
          {selectionActionsAvailable && props.selectionPlacement ? (
            <ContextActionPalette
              placement={props.selectionPlacement}
              hidden={surface.nestedLayer !== 'none'}
              onReplace={startReplacement}
              onDelete={deleteSelection}
              onHighlight={startHighlight}
            />
          ) : null}
          {surface.baseSurface === 'reading' && !selectionAnchor && props.caretAnchor && props.caretPlacement ? (
            <InsertionCaret
              key={`${props.caretAnchor.pageIndex}:${props.caretAnchor.position.x}:${props.caretAnchor.position.y}`}
              placement={props.caretPlacement}
              hidden={surface.nestedLayer !== 'none'}
            />
          ) : null}
          {surface.baseSurface === 'reading' && surface.nestedLayer === 'none' && props.pageMenu ? (
            <PageActionMenu
              placement={props.pageMenu.placement}
              triggerRef={pageNoteTriggerRef}
              onAddPageNote={() => {
                const menu = props.pageMenu;
                if (!menu) return;
                props.onPageMenuConsumed?.(menu.invocationId);
                startPageNote(menu);
              }}
              onDismiss={() => {
                const menu = props.pageMenu;
                if (!menu) return;
                props.onPageMenuDismiss?.(menu.invocationId);
                dispatchSurface({ type: 'close-transient' });
              }}
            />
          ) : null}
          {authoringSession === null && !workspaceOpen && peekItemId ? (() => {
            const item = props.state.items.find(({ id }) => id === peekItemId);
            if (item === undefined) return null;
            const copyLink = copyLinkForItem(item);
            return (
              <AnnotationPeek
                item={item}
                {...(copyLink === undefined ? {} : { copyLink })}
                onHoldChange={(held) => {
                  peekHeldRef.current = held;
                  clearPeekTimer();
                  if (!held && props.correspondingItemId === undefined) {
                    peekTimerRef.current = setTimeout(() => setPeekItemId(undefined), 180);
                  }
                }}
              />
            );
          })() : null}
          {authoringSession !== null && authoringReading ? (
            <button
              className="comment-composer__return-editor review-button review-button--secondary"
              type="button"
              title="Return to Editor"
              onClick={focusAuthoringEditor}
            >
              <ReviewIcon name="edit" />
              <span>Return to Editor</span>
            </button>
          ) : null}
        </div>
        <div
          className="review-drawer-host"
          data-review-drawer-host
          inert={props.saveOptionsOpen ?? false}
          aria-hidden={props.saveOptionsOpen === true ? 'true' : undefined}
        >
          {authoringComposer}
          {authoringSession === null ? (effectiveReferenceLayout.kind === 'narrow-unified' ? (
            <WorkspaceEdgeRail
              buttonRef={bottomWorkspaceRailRef}
              surface="bottom"
              open={referenceSurfaceOpen}
              controls="review-workspace"
              onToggle={() => {
                dismissPageNoteAuthority();
                const opening = !effectiveReferenceLayout.open;
                dispatchReferenceLayout({ type: 'toggle-narrow-workspace' });
                if (opening) focusWorkspaceModeAfterLayout(effectiveWorkspaceMode);
              }}
            />
          ) : (
            <>
              <WorkspaceEdgeRail
                buttonRef={rightWorkspaceRailRef}
                surface="right"
                open={rightSurfaceOpen}
                controls={effectiveReferenceLayout.referenceDock === 'right' && referencesAvailable
                  ? 'review-workspace review-tools-workspace'
                  : 'review-tools-workspace'}
                onToggle={() => {
                  dismissPageNoteAuthority();
                  const opening = !rightSurfaceOpen;
                  dispatchReferenceLayout({ type: 'toggle-right-workspace' });
                  if (opening) focusWorkspaceModeAfterLayout(effectiveWorkspaceMode);
                }}
              />
              {referencesAvailable && effectiveReferenceLayout.referenceDock === 'bottom' ? <WorkspaceEdgeRail
                buttonRef={bottomWorkspaceRailRef}
                surface="bottom"
                open={effectiveReferenceLayout.bottomReferencesOpen}
                controls="review-workspace"
                onToggle={() => {
                  dismissPageNoteAuthority();
                  const opening = !effectiveReferenceLayout.bottomReferencesOpen;
                  dispatchReferenceLayout({ type: 'toggle-references' });
                  if (opening) focusWorkspaceModeAfterLayout('references');
                }}
              /> : null}
            </>
          )) : null}
          <ReferenceWorkspace
            workspaceRef={workspaceFraming.referenceSurfaceRef}
            open={referenceSurfaceOpen}
            authoringTakeover={authoringSession !== null}
            mode={effectiveReferenceLayout.kind !== 'narrow-unified'
              && effectiveReferenceLayout.referenceDock === 'bottom'
              ? 'references' : effectiveWorkspaceMode}
            presentation={effectiveReferenceLayout.kind === 'narrow-unified'
              || effectiveReferenceLayout.referenceDock === 'bottom'
              ? 'bottom' : 'right'}
            modes={effectiveReferenceLayout.kind === 'narrow-unified'
              || effectiveReferenceLayout.referenceDock === 'right'
              ? visibleWorkspaceModes
              : referencesAvailable ? ['references'] : []}
            headerVariant={effectiveReferenceLayout.kind !== 'narrow-unified'
              && effectiveReferenceLayout.referenceDock === 'bottom' ? 'references' : 'tabs'}
            onMoveReferencesRight={() => {
              if (authoringSessionRef.current !== null) return;
              dispatchReferenceLayout({ type: 'move-references-right' });
              selectWorkspaceMode('references');
              focusWorkspaceModeAfterLayout('references');
            }}
            onMoveReferencesBottom={() => {
              if (authoringSessionRef.current !== null) return;
              dispatchReferenceLayout({ type: 'move-references-bottom' });
              selectWorkspaceMode('references');
              focusWorkspaceModeAfterLayout('references');
            }}
            tabs={referenceTabs}
            activeTabIdentity={navigation.activeTabIdentity}
            {...(props.pendingReference === undefined ? {} : { pendingReference: props.pendingReference })}
            {...(props.referenceReturn === undefined ? {} : { referenceReturn: props.referenceReturn })}
            announcement={props.navigationAnnouncement ?? announcement}
            onModeChange={selectWorkspaceMode}
            onReferenceTabActivate={(identity) => {
              if (authoringSessionRef.current === null) props.onReferenceTabActivate?.(identity);
            }}
            onReferenceTabClose={(identity) => {
              if (authoringSessionRef.current !== null) return;
              props.onReferenceTabClose?.(identity);
              if (props.navigationState === undefined) {
                dispatchSurface({
                  type: 'reference-navigation',
                  action: {
                    type: 'close-reference',
                    targetIdentity: identity,
                    focusReturnToken: effectiveReferenceLayout.kind === 'narrow-unified'
                      || effectiveReferenceLayout.referenceDock === 'bottom'
                      ? BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN
                      : RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN,
                  },
                });
              }
            }}
            onSendToMain={(identity) => {
              if (authoringSessionRef.current === null) props.onReferenceSendToMain?.(identity);
            }}
            onRetryReference={() => {
              if (authoringSessionRef.current === null) props.onReferenceRetry?.();
            }}
            {...(props.onReferenceReturn === undefined
              ? {}
              : { onReferenceReturn: (identity: string) => {
                  if (authoringSessionRef.current === null) props.onReferenceReturn?.(identity);
                } })}
            onReferenceViewportHost={props.onReferenceViewportHost ?? ignoreReferenceViewportHost}
            onModeFocusTokenChange={rememberWorkspaceModeFocus}
          />
          <OutlineAnnotationsWorkspace
            workspaceRef={workspaceFraming.toolsSurfaceRef}
            open={toolsSurfaceOpen}
            authoringTakeover={authoringSession !== null}
            mode={effectiveWorkspaceMode}
            modes={visibleRightWorkspaceModes}
            presentation={effectiveReferenceLayout.kind === 'narrow-unified' ? 'bottom' : 'right'}
            headerVariant={sharedWorkspace ? 'shared' : 'tools'}
            outline={visibleOutlineDiscovery}
            currentOutlineItemId={props.currentOutlineItemId ?? null}
            onModeChange={selectWorkspaceMode}
            onOutlineActivate={(item) => {
              if (authoringSessionRef.current === null) props.onOutlineActivate?.(item);
            }}
            onOutlineReference={(item) => {
              if (authoringSessionRef.current === null) props.onOutlineReference?.(item);
            }}
            {...(props.copyLinkForOutlineItem === undefined
              ? {}
              : { copyLinkForOutlineItem: props.copyLinkForOutlineItem })}
            onModeFocusTokenChange={rememberWorkspaceModeFocus}
            annotations={<div id="review-annotation-list" aria-label="All annotations">
            <AnnotationList
              items={props.state.items}
              {...(!showAnnotationOutlineLabels || props.annotationOutlineLabels === undefined
                ? {}
                : { sectionLabels: props.annotationOutlineLabels.owned })}
              {...(presentedActiveItemId === undefined ? {} : { activeId: presentedActiveItemId })}
              {...(!annotationsVisible || props.correspondingItemId === undefined
                ? {}
                : { correspondingId: props.correspondingItemId })}
              {...(!annotationsVisible || listActivation === undefined ? {} : { activationRequest: listActivation })}
              {...(props.onItemCorrespondenceChange === undefined
                ? {}
                : { onCorrespondenceChange: props.onItemCorrespondenceChange })}
              {...(props.copyItemLink === undefined ? {} : { copyLinkForItem })}
              onNavigate={(item) => {
                if (authoringSessionRef.current !== null) return;
                markFramingUserIntent();
                setActiveItem(item.id);
                props.onNavigate?.(item);
              }}
              onEdit={(item, trigger) => {
                if (authoringSessionRef.current !== null) return;
                beginAuthoring({ kind: 'edit', item }, 'tray-edit', trigger);
              }}
              onDelete={async (item) => {
                if (authoringSessionRef.current !== null) return;
                const next = await submit((state) => removeReviewItem(state, item.id));
                if (activeItemId === item.id) {
                  const ordered = next.items;
                  setActiveItem(ordered[0]?.id);
                }
              }}
            />
            {existingAnnotations.status === 'empty' ? null : (
              <section className="existing-annotations" data-existing-annotations-state={existingAnnotations.status} aria-label="External Annotations (read only)">
              <header className="existing-annotations__header">
                <h2>External Annotations (read only)</h2>
              </header>
              {existingAnnotations.status === 'loading' ? (
                <p className="annotation-status" data-annotation-status="loading" role="status">
                  <ReviewIcon name="loading" className="review-icon annotation-status__icon" />
                  <span>Existing annotations are loading…</span>
                </p>
              ) : null}
              {existingAnnotations.status === 'error' ? (
                <div className="annotation-status annotation-status--error" data-annotation-status="error" role="alert">
                  <ReviewIcon name="alert" className="review-icon annotation-status__icon" />
                  <p><strong>Existing annotations unavailable.</strong><span>{existingAnnotations.message}</span></p>
                  <button type="button" title="Retry loading existing annotations" onClick={props.onRetryExistingAnnotations}>Retry</button>
                </div>
              ) : null}
              {existingAnnotations.status === 'ready' ? (
                <ol className="existing-annotations__list">
                  {existingAnnotations.items.map((annotation) => {
                    const sectionLabel = showAnnotationOutlineLabels
                      ? props.annotationOutlineLabels?.source.get(existingAnnotationKey(annotation))
                      : undefined;
                    return <li
                      key={existingAnnotationKey(annotation)}
                      data-existing-annotation={annotation.id}
                      data-annotation-origin="source"
                      data-annotation-kind={annotation.subtype}
                      data-annotation-state="readonly"
                      data-readonly="true"
                    >
                      <button className="existing-annotation__content" type="button" aria-label={annotationAccessibleLabel({
                        kind: annotation.subtype,
                        pageNumber: annotation.pageIndex + 1,
                        ...(sectionLabel === undefined ? {} : { sectionLabel }),
                        ...(annotation.contents ? { excerpt: annotation.contents } : {}),
                      })} title={`Go to ${annotationKindLabel(annotation.subtype)} annotation on page ${annotation.pageIndex + 1}`} onClick={() => {
                        if (authoringSessionRef.current !== null) return;
                        markFramingUserIntent();
                        props.onNavigateExisting?.(annotation);
                      }}>
                        <AnnotationMetadata
                          kind={annotation.subtype}
                          pageNumber={annotation.pageIndex + 1}
                          {...(sectionLabel === undefined ? {} : { sectionLabel })}
                        />
                        {annotation.contents ? <span className="annotation-item__excerpt">{annotation.contents}</span> : null}
                      </button>
                    </li>;
                  })}
                </ol>
              ) : null}
              </section>
            )}
            </div>}
            search={props.search ?? (
              <div className="workspace-state" data-workspace-focus-token="search:unavailable" tabIndex={-1}>
                Search becomes available after the PDF loads.
              </div>
            )}
          />
          {authoringSession === null
            && referenceSurfaceOpen
            && effectiveReferenceLayout.referenceResizable ? (
            <ReferenceResizeHandle
              dock={effectiveReferenceLayout.kind !== 'narrow-unified'
                ? effectiveReferenceLayout.referenceDock : 'bottom'}
              controls="workspace-panel-references"
              value={effectiveReferenceLayout.kind !== 'narrow-unified'
                && effectiveReferenceLayout.referenceDock === 'right'
                ? referenceLayout.rightReferenceWidth : referenceLayout.bottomReferenceHeight}
              min={effectiveReferenceLayout.kind !== 'narrow-unified'
                && effectiveReferenceLayout.referenceDock === 'right'
                ? MIN_RIGHT_REFERENCE_WIDTH : MIN_BOTTOM_REFERENCE_HEIGHT}
              max={effectiveReferenceLayout.kind !== 'narrow-unified'
                && effectiveReferenceLayout.referenceDock === 'right'
                ? clampRightReferenceWidth(Number.MAX_SAFE_INTEGER, referenceLayout.stageWidth)
                : clampBottomReferenceHeight(Number.MAX_SAFE_INTEGER, referenceLayout.stageHeight)}
              onChange={(size) => dispatchReferenceLayout(effectiveReferenceLayout.kind !== 'narrow-unified'
                && effectiveReferenceLayout.referenceDock === 'right'
                ? { type: 'resize-right-references', size }
                : { type: 'resize-bottom-references', size })}
              onCommit={workspaceFraming.requestSettledReframe}
            />
          ) : null}
        </div>
      </div>
      <div
        className="review-nested-host"
        data-review-nested-host
        hidden={props.saveOptionsOpen ?? false}
        inert={props.saveOptionsOpen ?? false}
      />
      <LinkActionPopover
        request={props.linkActionRequest ?? null}
        openInReferencesDisabled={authoringSession !== null}
        {...(activePdfLinkCopy === undefined ? {} : { copyLink: activePdfLinkCopy })}
        onChoose={(choice, request) => props.onLinkActionChoose?.(choice, request)}
        onDismiss={(request, reason) => props.onLinkActionDismiss?.(request, reason)}
        sourceFocusFallback={(source) => {
          const shell = shellRef.current;
          if (!shell) return null;
          if (source === 'reference') {
            const activeTab = navigation.activeTabIdentity;
            const activeTabElement = activeTab
              ? [...shell.querySelectorAll<HTMLElement>('[data-reference-tab]')]
                .find((element) => element.dataset.referenceTab === activeTab)
              : null;
            return activeTabElement
              ?? shell.querySelector<HTMLElement>('[data-reference-pdf-viewport] [data-page-index]');
          }
          return shell.querySelector<HTMLElement>(
            `.pdf-workspace:not(.pdf-workspace--reference) [data-page-index="${props.linkActionRequest?.sourcePageIndex ?? 0}"]`,
          ) ?? shell.querySelector<HTMLElement>('.pdf-workspace:not(.pdf-workspace--reference) [data-page-index]');
        }}
      />
    </section>
  );
}
