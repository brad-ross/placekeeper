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
import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';
import type { CaretAnchor } from '../pdf/selection-anchor.js';
import {
  existingAnnotationKey,
  type ExistingAnnotation,
  type ExistingAnnotationsDiscovery,
} from '../pdf/existing-annotations.js';
import {
  reliableSelection,
  type PdfCopyOwner,
  type PdfCopySnapshots,
  type SelectionUpdate,
} from '../pdf/selection-state.js';
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
import { FullAnnotationReader } from '../review/FullAnnotationReader.js';
import {
  projectOwnedAnnotationReader,
  resolveAnnotationReader,
  type AnnotationReaderIdentity,
  type AnnotationReaderRecord,
} from '../review/annotation-reader.js';
import { AnnotationPeek } from '../review/AnnotationPeek.js';
import { reviewItemNavigationTarget } from '../review/annotation-outline-context.js';
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
import {
  OutlineExpansionProvider,
  OutlineExpansionToggleSlot,
} from '../review/OutlineExpansionController.js';
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
import {
  createReviewStateSummary,
  type LiveContextBindingStatus,
} from '../../../../packages/core/src/live-context.js';
import type { CopyLinkControlProps } from '../review/CopyLinkControl.js';
import type { PdfDestinationCopyLink } from '../review/copy-link-model.js';
import {
  createProofreadInputController,
  isEditableTarget,
  type ProofreadInputIntent,
} from '../review/input-controller.js';
import { reviewActionForKey } from '../review/review-actions.js';
import {
  createReviewCommandSurface,
  type ReviewCommandFocusContext,
  type ReviewCommandInvocation,
  type ReviewCommandSurfaceSnapshot,
} from '../review/review-command-surface.js';
import type { AccessibilityTransitionEffect } from './accessibility-transitions.js';
import {
  useWorkspaceFraming,
  type WorkspaceOpenRequest,
} from '../review/use-annotation-tray-framing.js';
import { useReviewOverlayGeometry } from '../review/use-review-overlay-geometry.js';
import { usePassageEditorPlacement } from '../review/use-passage-editor-placement.js';
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
  authoringPreviewAnnotations,
  authoringSessionIsCurrent,
  canStartAuthoringSession,
  createAuthoringSession,
  pendingDraftForAuthoring,
  type AuthoringAuthority,
  type AuthoringAnchorSnapshot,
  type AuthoringOriginKind,
  type AuthoringSession,
  type AuthoringSource,
} from '../review/authoring-session.js';
import {
  ReconciliationWorkspace,
} from '../review/ReconciliationWorkspace.js';
import {
  reviewExportPresentation,
  type ReviewExportResult,
} from '../review/DocumentActionsMenu.js';
import type { GenerationRefreshStatus, LocationRestoreStatus } from '../generation-status.js';
import { reviewItemIsResolvedForGeneration } from '../../../../packages/core/src/annotation-projection.js';
import './review-layout.css';
import './neutral-chrome.css';

function ignoreReferenceViewportHost(_element: HTMLDivElement | null): void {}

export interface ReviewShellSaveModel {
  savedLabel?: string;
  savePhase?: 'clean' | 'saving' | 'not-saved';
  exportOnly?: boolean;
  savePendingDestination?: boolean;
  saveOptionsOpen?: boolean;
  onSaveOptions?(): void;
  saveRecovery?: {
    readonly pending: boolean;
    readonly error?: string;
    readonly onRetry: () => void | Promise<void>;
    readonly onSaveCopy: () => void;
  };
  onExportReviewedCopy?(confirmPossiblyStale?: true): Promise<ReviewExportResult | void>;
}

export interface ReviewShellSelectionModel {
  onSelectionPageLimitExceeded?(): void;
  onCopySelection?(): void;
  selectionUpdate: SelectionUpdate;
  pdfCopyOwner?: PdfCopyOwner;
  pdfCopySnapshots?: PdfCopySnapshots;
  pdfCopyOwnerIndicatorVisible?: boolean;
  pdfCopyAnnouncement?: string;
  selectionPlacement?: ContextPlacement | null;
  caretAnchor?: CaretAnchor | null;
  caretPlacement?: ContextPlacement | null;
  onSelectionConsumed?(generation: number): void;
}

export interface ReviewShellAuthoringModel {
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
  onGoToSource?(menu: NonNullable<ReviewShellAuthoringModel['pageMenu']>): void;
  onPlacedPageNoteConsumed?(token: number): void;
  onPageNoteComposerComplete?(): void;
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
  onAuthoringPreviewChange?(preview: readonly ReviewAnnotation[] | null): void;
  /** Publishes measured overlay geometry without changing viewer framing. */
  onAuthoringViewportChange?(viewport: PdfViewportQuery | null): void;
}

export interface ReviewShellViewerModel {
  viewerControls?: ViewerControls;
  viewerState?: ViewerControlsSnapshot;
  viewerFraming?: ViewerFramingControls;
  viewerNavigation?: PdfViewerNavigation;
  viewerNavigationIntentToken?: number;
  onCommitMainFramingPositionChange?(commit: (() => void) | null): void;
}

export interface ReviewShellWorkspaceModel {
  listOpen?: boolean;
  /** The production shell may control workspace visibility and retained navigation state. */
  workspaceOpen?: boolean;
  navigationState?: ReferenceNavigationState;
  referenceTabs?: readonly ReferenceWorkspaceTab[];
  pendingReference?: PendingReferencePanel | null;
  referenceReturn?: ReferenceReturnControlState | null;
  outlineDiscovery?: PdfOutlineDiscovery;
  currentOutlineItemId?: string | null;
  linkActionRequest?: ViewerPdfLinkInvocation | null;
  navigationAnnouncement?: string;
  canNavigateBack?: boolean;
  canNavigateForward?: boolean;
  documentNavigationPending?: boolean;
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
}

export interface ReviewShellProps {
  save: ReviewShellSaveModel;
  selection: ReviewShellSelectionModel;
  authoring: ReviewShellAuthoringModel;
  viewer: ReviewShellViewerModel;
  workspace: ReviewShellWorkspaceModel;
  state: ReviewState;
  documentTitle?: string;
  generationRefreshStatus?: GenerationRefreshStatus;
  locationRestoreStatus?: LocationRestoreStatus;
  toolError?: string | null;
  commandNotice?: string | null;
  onNavigate?(item: ReviewItem): void;
  onNavigateExisting?(item: ExistingAnnotation): void;
  existingAnnotations?: ExistingAnnotationsDiscovery;
  onRetryExistingAnnotations?(): void;
  activeItemId?: string | null;
  correspondingItemId?: string;
  activationRequest?: { readonly id: string; readonly token: number };
  onItemCorrespondenceChange?(id: string | undefined): void;
  onActiveItemChange?(id: string | undefined): void;
  codexContext?: LiveContextBindingStatus;
  copyLink?: CopyLinkControlProps;
  copyItemLink?: {
    readonly getLink: (item: ReviewItem) => string;
    readonly disabled?: (item: ReviewItem) => boolean;
    readonly writeText: (link: string) => Promise<void>;
  };
  documentActionsRequestToken?: number;
  onDocumentActionsRequestHandled?: (token: number) => void;
  onCommandSurfaceChange?(snapshot: ReviewCommandSurfaceSnapshot): void;
  commandInvocation?: ReviewCommandInvocation;
  accessibilityTransition?: AccessibilityTransitionEffect;
  children?: ReactNode;
}

export interface RejectedReviewCommand {
  readonly accepted: false;
  readonly state: ReviewState;
  readonly message: string;
  readonly reason?: 'rejected' | 'save-destination' | 'stale-authoring' | 'generation-conflict';
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

interface PointerScrollGesture {
  readonly id: number;
  readonly scroll: ViewerPosition | null;
}

interface FullAnnotationReaderSession {
  readonly identity: AnnotationReaderIdentity;
  readonly authority: AuthoringAuthority;
  readonly annotationScrollTop: number;
  readonly origin: 'list' | 'peek';
  readonly previousActiveItemId?: string;
  readonly entryFocus?: 'back' | 'edit';
}

function annotationReaderIdentityMatches(
  left: AnnotationReaderIdentity,
  right: AnnotationReaderIdentity,
): boolean {
  if (left.origin !== right.origin) return false;
  if (left.origin === 'owned' && right.origin === 'owned') return left.itemId === right.itemId;
  return left.origin === 'source'
    && right.origin === 'source'
    && left.documentGeneration === right.documentGeneration
    && left.discoveryGeneration === right.discoveryGeneration
    && left.annotationKey === right.annotationKey;
}

function isVisibleFocusTarget(element: HTMLElement | null | undefined): element is HTMLElement {
  if (
    element === null
    || element === undefined
    || !element.isConnected
    || element.hidden
    || element.closest('[hidden], [inert], [aria-hidden="true"]') !== null
  ) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.visibility !== 'collapse';
}

function mutableField(item: ReviewItem): 'proposedText' | 'comment' | undefined {
  if (item.kind === 'replace' || item.kind === 'insert') return 'proposedText';
  if (item.kind === 'highlight' || item.kind === 'pageNote') return 'comment';
  return undefined;
}

function initialAuthoringValue(session: AuthoringSession): string {
  const source = session.source;
  if (source.kind === 'replace' || source.kind === 'insert') return source.initialValue;
  if (source.kind !== 'edit') return '';
  const field = mutableField(source.item);
  return field === undefined ? '' : String(source.item.payload[field] ?? '');
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

export function ReviewShell(props: ReviewShellProps) {
  const [horizontalScrollLocked, setHorizontalScrollLocked] = useState(false);
  const [localReferenceLayout, dispatchLocalReferenceLayout] = useReducer(
    reduceReferenceWorkspaceLayout,
    undefined,
    () => {
      let initial = createReferenceWorkspaceLayout({ width: 1440, height: 900 });
      if (props.workspace.workspaceOpen === true || props.workspace.listOpen === true) {
        const initialMode = props.workspace.listOpen === true
          ? 'annotations'
          : props.workspace.navigationState?.workspace.lastMode ?? 'outline';
        initial = reduceReferenceWorkspaceLayout(initial, initialMode === 'references'
          ? { type: 'show-references' }
          : { type: 'show-right-workspace' });
      }
      return initial;
    },
  );
  const [surface, dispatchSurface] = useReducer(
    reduceReviewSurface,
    props.workspace.workspaceOpen === true
      ? reduceReviewSurface(INITIAL_REVIEW_SURFACE_STATE, {
          type: 'open-workspace',
          mode: props.workspace.navigationState?.workspace.lastMode ?? 'outline',
        })
      : props.workspace.listOpen === true
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
  const saveOptionsWasOpenRef = useRef(props.save.saveOptionsOpen ?? false);
  const [authoringSurfaceElement, setAuthoringSurfaceElement] = useState<HTMLElement | null>(null);
  const [localActiveItemId, setLocalActiveItemId] = useState<string>();
  const [activeExistingAnnotationKey, setActiveExistingAnnotationKey] = useState<string>();
  const activeItemId = props.activeItemId === undefined
    ? localActiveItemId
    : props.activeItemId ?? undefined;
  const presentedActiveItemId = authoringSession === null
    ? activeItemId
    : authoringSession.workspace.activeItemId;
  const [consumedSelectionGeneration, setConsumedSelectionGeneration] = useState<number>();
  const [listActivation, setListActivation] = useState<{ readonly id: string; readonly token: number }>();
  const [annotationReaderSession, setAnnotationReaderSession] = useState<FullAnnotationReaderSession | null>(null);
  const [readerNavigationRevision, setReaderNavigationRevision] = useState(0);
  const [readerNavigationPending, setReaderNavigationPending] = useState(false);
  const [reconciliationDetailOpen, setReconciliationDetailOpen] = useState(false);
  const [reconciliationFocusRequest, setReconciliationFocusRequest] = useState(0);
  const pendingReaderResumeRef = useRef<FullAnnotationReaderSession | null>(null);
  const pendingMarkReaderRequestRef = useRef<{ readonly id: string; readonly token: number } | null>(null);
  const ownedReaderOverflowRef = useRef(new Map<string, boolean>());
  const annotationRestorationTokenRef = useRef(0);
  const annotationRestorationFramesRef = useRef(new Set<number>());
  const [peekItemId, setPeekItemId] = useState<string>();
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const handledSearchFocusRequestRef = useRef(0);
  const [commandFocusContext, setCommandFocusContext] = useState<ReviewCommandFocusContext>('review');
  const handledCommandInvocationRef = useRef(0);
  const peekHeldRef = useRef(false);
  const dismissedPeekIdRef = useRef<string | undefined>(undefined);
  const [announcement, setAnnouncement] = useState(`Review revision ${props.state.revision}.`);
  const [transitionAnnouncement, setTransitionAnnouncement] = useState('');
  const handledAccessibilityTransitionRef = useRef(0);
  const authoringOwnerViewIdRef = useRef(crypto.randomUUID());

  const cancelAnnotationRestoration = useCallback(() => {
    annotationRestorationTokenRef.current += 1;
    for (const frame of annotationRestorationFramesRef.current) cancelAnimationFrame(frame);
    annotationRestorationFramesRef.current.clear();
  }, []);

  useEffect(() => cancelAnnotationRestoration, [cancelAnnotationRestoration]);

  useEffect(() => {
    props.authoring.onAuthoringAnchorChange?.(
      authoringSession === null ? null : authoringAnchorSnapshot(authoringSession),
    );
  }, [authoringSession, props.authoring.onAuthoringAnchorChange]);
  useEffect(() => {
    props.authoring.onAuthoringPreviewChange?.(
      authoringSession === null
        ? null
        : authoringPreviewAnnotations(authoringSession, initialAuthoringValue(authoringSession)),
    );
    return () => props.authoring.onAuthoringPreviewChange?.(null);
  }, [authoringSession, props.authoring.onAuthoringPreviewChange]);
  useEffect(() => {
    const wasOpen = saveOptionsWasOpenRef.current;
    const isOpen = props.save.saveOptionsOpen ?? false;
    saveOptionsWasOpenRef.current = isOpen;
    if (!wasOpen || isOpen || authoringSessionRef.current === null) return;
    requestAnimationFrame(() => authoringEditorRef.current?.focus({ preventScroll: true }));
  }, [props.save.saveOptionsOpen]);
  useLayoutEffect(() => {
    if (authoringSurfaceElement === null) {
      props.authoring.onAuthoringViewportChange?.(null);
      return;
    }
    let frame = 0;
    const publish = () => {
      frame = 0;
      const rect = authoringSurfaceElement.getBoundingClientRect();
      props.authoring.onAuthoringViewportChange?.({
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
      props.authoring.onAuthoringViewportChange?.(null);
    };
  }, [authoringSurfaceElement, props.authoring.onAuthoringViewportChange]);
  const acknowledgedRef = useRef(props.state);
  const commandTailRef = useRef<Promise<ReviewState>>(Promise.resolve(props.state));
  const pageNoteTriggerRef = useRef<HTMLButtonElement>(null);
  const surfaceTriggersRef = useRef(new Map<ReviewBaseSurface, HTMLElement>());
  const rightWorkspaceRailRef = useRef<HTMLButtonElement>(null);
  const bottomWorkspaceRailRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const shell = shellRef.current;
    if (!horizontalScrollLocked || !shell) return;
    const lockHorizontalWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || (event.deltaX === 0 && !event.shiftKey)) return;
      const viewport = shell.querySelector<HTMLElement>('.review-document .pdf-workspace__viewport');
      if (!viewport || !(event.target instanceof Node) || !viewport.contains(event.target)) return;
      // WebKit can scroll the hidden horizontal axis during diagonal gestures.
      // Consume that gesture and apply only its vertical component.
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      if (!event.shiftKey) viewport.scrollTop += event.deltaY * unit;
    };
    shell.addEventListener('wheel', lockHorizontalWheel, { passive: false });
    return () => shell.removeEventListener('wheel', lockHorizontalWheel);
  }, [horizontalScrollLocked]);
  const pointerScrollRef = useRef<PointerScrollGesture | undefined>(undefined);
  const annotationRequestTokenRef = useRef(0);
  const [workspaceRequest, setWorkspaceRequest] = useState<WorkspaceOpenRequest>({
    kind: 'reading',
    token: 0,
  });
  const setActiveItem = (id: string | undefined) => {
    if (id !== undefined) setActiveExistingAnnotationKey(undefined);
    if (props.activeItemId === undefined) setLocalActiveItemId(id);
    props.onActiveItemChange?.(id);
  };
  const navigation = props.workspace.navigationState ?? surface.navigation;
  const currentAuthoringAuthority = authoringAuthorityFor(
    props.state,
    navigation.documentGeneration,
  );
  const currentAuthoringAuthorityRef = useRef(currentAuthoringAuthority);
  currentAuthoringAuthorityRef.current = currentAuthoringAuthority;
  const referenceTabs = props.workspace.referenceTabs ?? navigation.tabs.map((tab) => ({
    identity: tab.identity,
    label: `Page ${tab.originalTarget.pageIndex + 1}`,
    pageContext: `Page ${tab.originalTarget.pageIndex + 1}`,
    pageNumber: tab.originalTarget.pageIndex + 1,
  }));
  const referencesAvailable = referenceTabs.length > 0 || props.workspace.pendingReference != null;
  const outlineDiscovery = props.workspace.outlineDiscovery;
  const visibleOutlineDiscovery = useMemo<PdfOutlineDiscovery>(() => (
    outlineDiscovery?.documentGeneration === navigation.documentGeneration
      ? outlineDiscovery
      : { status: 'loading', documentGeneration: navigation.documentGeneration }
  ), [navigation.documentGeneration, outlineDiscovery]);
  const outlineAbsent = visibleOutlineDiscovery.status === 'loaded-empty';
  const existingAnnotations = props.existingAnnotations ?? { status: 'loading', generation: 0 };
  useEffect(() => {
    setActiveExistingAnnotationKey(undefined);
  }, [navigation.documentGeneration, existingAnnotations.generation]);
  const visibleOwnedItems = props.state.workflow.mode === 'generated-output'
    ? props.state.items.filter((item) => reviewItemIsResolvedForGeneration(
        item,
        props.state.workflow.documentGeneration,
      ))
    : props.state.items;
  const generatedStatusMessages = props.state.workflow.mode !== 'generated-output' ? [] : [
    props.generationRefreshStatus === 'reconciling'
      ? 'A rebuilt PDF is loading and Review Items are reconciling.'
      : props.generationRefreshStatus === 'failed'
        ? 'The rebuilt PDF could not be loaded safely. The last successful PDF remains reviewable.'
        : props.state.workflow.freshness === 'possibly-stale'
          ? 'The last successful PDF may be stale.'
          : '',
    props.locationRestoreStatus === 'restoring'
      ? 'Restoring the prior reading position.'
      : props.locationRestoreStatus === 'fallback'
        ? 'The prior reading position could not be restored; review remains available.'
        : '',
  ].filter(Boolean);
  const workspaceOpen = props.workspace.workspaceOpen ?? surface.baseSurface === 'workspace';
  const workspaceMode = navigation.workspace.lastMode;
  const visibleWorkspaceModes = WORKSPACE_MODES.filter((mode) => (
    (referencesAvailable || mode !== 'references')
    && (!outlineAbsent || mode !== 'outline')
  ));
  const visibleRightWorkspaceModes = visibleWorkspaceModes.filter(
    (mode): mode is RightWorkspaceMode => mode !== 'references',
  );
  const documentActionsPresentation = useMemo(() => (
    props.state.workflow.mode === 'generated-output' || props.save.exportOnly === true
      ? reviewExportPresentation({
          refreshStatus: props.generationRefreshStatus ?? 'idle',
          summary: createReviewStateSummary(props.state),
        })
      : undefined
  ), [props.save.exportOnly, props.generationRefreshStatus, props.state]);
  const requestedRightWorkspaceMode: RightWorkspaceMode = props.workspace.rightWorkspaceMode
    ?? (workspaceMode === 'references' ? 'outline' : workspaceMode);
  const rightWorkspaceMode: RightWorkspaceMode = visibleRightWorkspaceModes.includes(
    requestedRightWorkspaceMode,
  ) ? requestedRightWorkspaceMode : visibleRightWorkspaceModes[0] ?? 'search';
  const visibleWorkspaceMode: WorkspaceMode = visibleWorkspaceModes.includes(workspaceMode)
    ? workspaceMode
    : rightWorkspaceMode;
  const referenceLayout = props.workspace.referenceLayoutState ?? localReferenceLayout;
  const referenceLayoutControlled = props.workspace.referenceLayoutState !== undefined;
  const effectiveReferenceLayout = deriveReferenceWorkspaceLayout(
    referenceLayout,
    rightWorkspaceMode,
    visibleWorkspaceMode,
  );
  const dispatchReferenceLayout = (action: ReferenceWorkspaceLayoutAction) => {
    if (props.workspace.referenceLayoutState === undefined) dispatchLocalReferenceLayout(action);
    props.workspace.onReferenceLayoutAction?.(action);
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
  const annotationsVisible = toolsSurfaceOpen && effectiveWorkspaceMode === 'annotations';
  const outlineExpansionToggleVisible = toolsSurfaceOpen && effectiveWorkspaceMode === 'outline';
  const annotationReaderRecord = annotationReaderSession === null
    || !authoringAuthorityMatches(annotationReaderSession.authority, currentAuthoringAuthority)
    ? null
    : resolveAnnotationReader(annotationReaderSession.identity, {
        ownedItems: props.state.items,
        existingAnnotations,
        documentGeneration: navigation.documentGeneration,
      });
  const annotationReaderOwnedItemId = annotationReaderRecord?.identity.origin === 'owned'
    ? annotationReaderRecord.identity.itemId
    : undefined;
  const annotationReaderOpen = annotationReaderRecord !== null;
  const annotationReaderIdentity = annotationReaderRecord?.identity;
  const annotationSourceIdentity = annotationReaderIdentity ?? (
    !annotationsVisible && peekItemId !== undefined
      ? { origin: 'owned' as const, itemId: peekItemId }
      : undefined
  );
  const annotationReaderTarget = annotationSourceIdentity === undefined
    ? null
    : annotationSourceIdentity.origin === 'owned'
      ? (() => {
          const item = props.state.items.find(
            ({ id }) => id === annotationSourceIdentity.itemId,
          );
          return item === undefined ? null : reviewItemNavigationTarget(item);
        })()
      : existingAnnotations.status === 'ready'
        ? (() => {
            const annotation = existingAnnotations.items.find(
              (candidate) => existingAnnotationKey(candidate)
                === annotationSourceIdentity.annotationKey,
            );
            return annotation === undefined
              ? null
              : { pageIndex: annotation.pageIndex, point: { x: annotation.rect.x, y: annotation.rect.y } };
          })()
        : null;
  void readerNavigationRevision;
  const annotationReaderVisibility: PdfTargetVisibility = annotationReaderTarget === null
    || props.viewer.viewerNavigation === undefined
    ? 'unavailable'
    : props.viewer.viewerNavigation.pointVisibility(
        annotationReaderTarget.pageIndex,
        annotationReaderTarget.point,
      );
  const selectionAnchor = reliableSelection(props.selection.selectionUpdate);
  const selectionActionsAvailable = (
    selectionAnchor !== null || props.selection.selectionUpdate.kind === 'over-limit'
  ) && props.selection.selectionUpdate.generation !== consumedSelectionGeneration;
  const competingPdfSelections = props.selection.pdfCopySnapshots?.main?.kind !== undefined
    && props.selection.pdfCopySnapshots.main.kind !== 'cleared'
    && props.selection.pdfCopySnapshots.reference?.kind !== undefined
    && props.selection.pdfCopySnapshots.reference.kind !== 'cleared';
  const pdfCopyOwnerLabel = props.selection.pdfCopyOwner === 'main'
    ? 'Main PDF'
    : props.selection.pdfCopyOwner === 'reference' ? 'Reference PDF' : 'No PDF focused';
  const lastPlacedPageNoteToken = useRef<number | undefined>(undefined);
  const workspaceFraming = useWorkspaceFraming({
    workspaceOpen: anyWorkspaceOpen,
    ...(props.viewer.viewerFraming === undefined ? {} : { controls: props.viewer.viewerFraming }),
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
  const pendingOpeningFitRef = useRef(false);
  const priorWorkspaceLayoutRef = useRef({
    open: toolsSurfaceOpen,
    narrow: effectiveReferenceLayout.kind === 'narrow-unified',
    dock: referenceLayout.referenceDock,
  });
  useEffect(() => {
    const prior = priorWorkspaceLayoutRef.current;
    const opening = toolsSurfaceOpen && !prior.open
      && prior.narrow === (effectiveReferenceLayout.kind === 'narrow-unified')
      && prior.dock === referenceLayout.referenceDock;
    priorWorkspaceLayoutRef.current = {
      open: toolsSurfaceOpen,
      narrow: effectiveReferenceLayout.kind === 'narrow-unified',
      dock: referenceLayout.referenceDock,
    };
    if (!toolsSurfaceOpen || prior.narrow !== (effectiveReferenceLayout.kind === 'narrow-unified')
      || prior.dock !== referenceLayout.referenceDock) pendingOpeningFitRef.current = false;
    if (opening) pendingOpeningFitRef.current = true;
    const navigation = props.viewer.viewerNavigation;
    if (!pendingOpeningFitRef.current || navigation === undefined) return;
    let current = true;
    // Opening is a one-shot Fit Width request. Later resizing, docking, and
    // closing preserve the resulting scale until another explicit fit.
    workspaceFraming.markUserIntent(undefined, { captureSettledPosition: false });
    void navigation.fitToWidth(async (signal) => {
      const geometry = await workspaceFraming.waitForSettledGeometry(signal);
      if (!current || geometry === null) return null;
      return { revision: geometry.revision, isCurrent: () => current && geometry.isCurrent() };
    }).then((fitted) => {
      if (!current) return;
      pendingOpeningFitRef.current = false;
      if (!fitted) return;
      // A selected mark must be revealed at the final scale, after Fit Width
      // has finished positioning the page.
      setWorkspaceRequest((request) => request.kind === 'mark'
        ? { ...request, token: ++annotationRequestTokenRef.current }
        : request);
    });
    return () => { current = false; };
  }, [toolsSurfaceOpen, effectiveReferenceLayout.kind, referenceLayout.referenceDock,
    effectiveWorkspaceMode, props.viewer.viewerNavigation, workspaceFraming.markUserIntent, workspaceFraming.waitForSettledGeometry]);

  const overlaySurfaceRefs = useMemo(() => [
    workspaceFraming.referenceSurfaceRef,
    workspaceFraming.toolsSurfaceRef,
  ], [workspaceFraming.referenceSurfaceRef, workspaceFraming.toolsSurfaceRef]);
  const overlayLayoutGeneration = [
    effectiveReferenceLayout.kind,
    referenceSurfaceOpen,
    toolsSurfaceOpen,
    referenceLayout.referenceDock,
    referenceLayout.rightReferenceWidth,
    effectiveReferenceLayout.bottomHeight,
    workspaceFraming.presentation,
  ].join(':');
  const overlayFrame = useReviewOverlayGeometry({
    isFitToWidth: () => props.viewer.viewerNavigation?.isFitToWidth?.() ?? false,
    stageRef: workspaceFraming.stageRef,
    surfaceRefs: overlaySurfaceRefs,
    layoutGeneration: overlayLayoutGeneration,
  });
  const authoringTargetSelector = authoringSession === null
    ? undefined
    : `[data-owned-mark][data-review-id="${cssAttributeValue(
      authoringSession.source.kind === 'edit'
        ? authoringSession.source.item.id
        : `authoring-preview:${authoringSession.token}`,
    )}"]`;
  const authoringFallbackTarget = authoringSession === null
    ? null
    : authoringSession.source.kind === 'replace' || authoringSession.source.kind === 'highlight'
      ? props.selection.selectionPlacement ?? null
      : authoringSession.source.kind === 'insert'
        ? props.selection.caretPlacement ?? null
        : authoringSession.source.kind === 'pageNote'
          ? props.authoring.pageMenu?.placement ?? null
          : null;
  const authoringPlacement = usePassageEditorPlacement({
    active: authoringSession !== null,
    anchorKey: authoringSession === null ? null : String(authoringSession.token),
    stageRef: workspaceFraming.stageRef,
    surfaceRefs: overlaySurfaceRefs,
    editorElement: authoringSurfaceElement,
    ...(authoringTargetSelector === undefined ? {} : { targetSelector: authoringTargetSelector }),
    fallbackTarget: authoringFallbackTarget,
    layoutGeneration: overlayLayoutGeneration,
  });

  const restoreAnnotationList = useCallback((
    session: FullAnnotationReaderSession,
    options?: {
      readonly activeItemId?: string;
      readonly preferRowTarget?: boolean;
      readonly restoreRowFocus?: boolean;
    },
  ) => {
    const { identity } = session;
    const sourceDocumentChanged = !authoringAuthorityMatches(
      session.authority,
      currentAuthoringAuthority,
    );
    const sourceDiscoveryChanged = identity.origin === 'source' && (
      identity.documentGeneration !== navigation.documentGeneration
      || existingAnnotations.status !== 'ready'
      || identity.discoveryGeneration !== existingAnnotations.generation
    );
    const staleAuthority = sourceDocumentChanged || sourceDiscoveryChanged;
    pendingReaderResumeRef.current = null;
    cancelAnnotationRestoration();
    const restorationToken = annotationRestorationTokenRef.current;
    const scheduleRestoration = (callback: () => void) => {
      const frame = requestAnimationFrame(() => {
        annotationRestorationFramesRef.current.delete(frame);
        if (annotationRestorationTokenRef.current === restorationToken) callback();
      });
      annotationRestorationFramesRef.current.add(frame);
    };
    if (session.origin === 'peek') {
      setAnnotationReaderSession(null);
      if (staleAuthority || identity.origin !== 'owned') {
        setPeekItemId(undefined);
        setActiveItem(undefined);
      } else {
        setPeekItemId(identity.itemId);
        setActiveItem(options?.activeItemId ?? identity.itemId);
      }
      scheduleRestoration(() => scheduleRestoration(() => {
        shellRef.current
          ?.querySelector<HTMLElement>('[data-annotation-peek] [data-read-full-annotation="true"]')
          ?.focus({ preventScroll: true });
      }));
      return;
    }
    setAnnotationReaderSession(null);
    if (staleAuthority) {
      setActiveItem(undefined);
    } else {
      const requestedActiveItemId = options?.activeItemId ?? session.previousActiveItemId;
      const validActiveItemId = requestedActiveItemId !== undefined
        && props.state.items.some(({ id }) => id === requestedActiveItemId)
        ? requestedActiveItemId
        : undefined;
      setActiveItem(validActiveItemId);
    }
    scheduleRestoration(() => scheduleRestoration(() => {
      const shell = shellRef.current;
      if (shell === null) return;
      const viewport = shell.querySelector<HTMLElement>('[data-annotation-scroll-viewport]');
      if (!staleAuthority && viewport !== null) viewport.scrollTop = session.annotationScrollTop;

      const row = staleAuthority
        ? undefined
        : identity.origin === 'owned'
          ? [...shell.querySelectorAll<HTMLElement>('[data-review-item]')]
            .find((element) => element.dataset.reviewItem === identity.itemId)
          : [...shell.querySelectorAll<HTMLElement>('[data-existing-annotation-key]')]
            .find((element) => element.dataset.existingAnnotationKey === identity.annotationKey);
      const openingMore = row?.querySelector<HTMLElement>('[data-read-full-annotation="true"]');
      const rowTarget = row?.querySelector<HTMLElement>('.annotation-item__navigation');
      const workspaceFallback = shell.querySelector<HTMLElement>('#workspace-panel-annotations');
      const pdfFallback = shell.querySelector<HTMLElement>(
        '.pdf-workspace:not(.pdf-workspace--reference) [data-page-index], [role="application"]',
      );
      const restorableMore = !options?.preferRowTarget && isVisibleFocusTarget(openingMore)
        ? openingMore
        : null;
      const focusTarget = options?.restoreRowFocus === false
        ? workspaceFallback ?? pdfFallback
        : restorableMore ?? rowTarget ?? workspaceFallback ?? pdfFallback;
      focusTarget?.focus({ preventScroll: true });
      if (!staleAuthority && viewport !== null) {
        viewport.scrollTop = session.annotationScrollTop;
        scheduleRestoration(() => {
          viewport.scrollTop = session.annotationScrollTop;
          if (options?.preferRowTarget || document.activeElement !== rowTarget) return;
          const settledMore = row?.querySelector<HTMLElement>('[data-read-full-annotation="true"]');
          if (isVisibleFocusTarget(settledMore)) settledMore.focus({ preventScroll: true });
        });
      }
    }));
  }, [
    cancelAnnotationRestoration,
    currentAuthoringAuthority.documentGeneration,
    currentAuthoringAuthority.sourceIdentity,
    existingAnnotations,
    navigation.documentGeneration,
    props.state.items,
  ]);

  useLayoutEffect(() => {
    if (annotationReaderSession === null || !annotationReaderOpen) return;
    const viewport = shellRef.current
      ?.querySelector<HTMLElement>('[data-annotation-scroll-viewport]');
    if (viewport) viewport.scrollTop = 0;
  }, [annotationReaderOpen, annotationReaderSession]);

  useLayoutEffect(() => {
    if (annotationReaderTarget === null) return;
    const stage = workspaceFraming.stageRef.current;
    if (stage === null) return;
    let frame = 0;
    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setReaderNavigationRevision((revision) => revision + 1);
      });
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(stage);
    const schedulePdfScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.matches('[data-viewer-framing-viewport]')) schedule();
    };
    stage.addEventListener('scroll', schedulePdfScroll, true);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      stage.removeEventListener('scroll', schedulePdfScroll, true);
      window.removeEventListener('resize', schedule);
    };
  }, [annotationReaderTarget?.pageIndex, annotationReaderTarget?.point.x,
    annotationReaderTarget?.point.y, props.viewer.viewerNavigation, workspaceFraming.stageRef]);

  useEffect(() => {
    if (!readerNavigationPending || annotationReaderVisibility !== 'visible') return;
    setReaderNavigationPending(false);
  }, [annotationReaderVisibility, readerNavigationPending]);

  useEffect(() => {
    setReaderNavigationPending(false);
  }, [annotationReaderSession?.identity]);

  useLayoutEffect(() => {
    if (annotationReaderSession === null || !annotationReaderOpen) return;
    const action = annotationReaderSession.entryFocus ?? 'back';
    shellRef.current
      ?.querySelector<HTMLElement>(`[data-full-annotation-action="${action}"]`)
      ?.focus({ preventScroll: true });
  }, [annotationReaderOpen, annotationReaderSession]);

  const openOwnedAnnotationReader = (
    record: AnnotationReaderRecord,
    _trigger: HTMLButtonElement | null,
    origin: FullAnnotationReaderSession['origin'] = 'list',
  ) => {
    if (authoringSessionRef.current !== null || record.identity.origin !== 'owned') return;
    cancelAnnotationRestoration();
    pendingReaderResumeRef.current = null;
    const { identity } = record;
    const item = props.state.items.find(({ id }) => id === identity.itemId);
    if (item === undefined) return;
    const annotationScrollTop = shellRef.current
      ?.querySelector<HTMLElement>('[data-annotation-scroll-viewport]')
      ?.scrollTop ?? 0;
    const previousActiveItemId = activeItemId;
    setActiveItem(item.id);
    setAnnotationReaderSession({
      identity,
      authority: currentAuthoringAuthorityRef.current,
      annotationScrollTop,
      origin,
      ...(previousActiveItemId === undefined ? {} : { previousActiveItemId }),
    });
  };

  const openExistingAnnotationReader = (
    annotation: ExistingAnnotation,
    record: AnnotationReaderRecord,
    _trigger: HTMLButtonElement,
  ) => {
    if (authoringSessionRef.current !== null || record.identity.origin !== 'source') return;
    cancelAnnotationRestoration();
    pendingReaderResumeRef.current = null;
    const annotationScrollTop = shellRef.current
      ?.querySelector<HTMLElement>('[data-annotation-scroll-viewport]')
      ?.scrollTop ?? 0;
    const previousActiveItemId = activeItemId;
    setActiveItem(undefined);
    setActiveExistingAnnotationKey(existingAnnotationKey(annotation));
    setAnnotationReaderSession({
      identity: record.identity,
      authority: currentAuthoringAuthorityRef.current,
      annotationScrollTop,
      origin: 'list',
      ...(previousActiveItemId === undefined ? {} : { previousActiveItemId }),
    });
  };

  const closeAnnotationReader = (session: FullAnnotationReaderSession, restoreRowFocus = true) => {
    if (session.origin === 'list') {
      restoreAnnotationList(session, { restoreRowFocus });
      return;
    }
    cancelAnnotationRestoration();
    pendingReaderResumeRef.current = null;
    pendingMarkReaderRequestRef.current = null;
    setAnnotationReaderSession(null);
    if (restoreRowFocus) requestAnimationFrame(() => {
      shellRef.current
        ?.querySelector<HTMLElement>('[data-annotation-peek] [data-read-full-annotation="true"]')
        ?.focus({ preventScroll: true });
    });
  };

  const returnReaderToAnnotation = () => {
    if (
      annotationReaderRecord === null
      || annotationReaderTarget === null
      || readerNavigationPending
    ) return;
    const identity = annotationReaderRecord.identity;
    workspaceFraming.markUserIntent();
    setReaderNavigationPending(true);
    if (identity.origin === 'owned') {
      const item = props.state.items.find(
        ({ id }) => id === identity.itemId,
      );
      if (item === undefined) {
        setReaderNavigationPending(false);
        return;
      }
      setActiveItem(item.id);
      props.onNavigate?.(item);
    } else if (existingAnnotations.status === 'ready') {
      const annotation = existingAnnotations.items.find(
        (candidate) => existingAnnotationKey(candidate)
          === identity.annotationKey,
      );
      if (annotation === undefined) {
        setReaderNavigationPending(false);
        return;
      }
      props.onNavigateExisting?.(annotation);
    }
    window.setTimeout(() => {
      setReaderNavigationPending(false);
      setReaderNavigationRevision((revision) => revision + 1);
    }, 2000);
  };

  const annotationReaderSourceNavigation = annotationReaderRecord === null
    ? undefined
    : {
        visibility: annotationReaderVisibility,
        pending: readerNavigationPending,
        onReturn: returnReaderToAnnotation,
      };

  useEffect(() => {
    if (
      authoringSessionRef.current === null
      && annotationReaderSession !== null
      && annotationReaderRecord === null
    ) {
      restoreAnnotationList(annotationReaderSession);
    }
  }, [annotationReaderRecord, annotationReaderSession, authoringSession, restoreAnnotationList]);

  const settlePendingReaderResume = (
    record: AnnotationReaderRecord,
    overflowing: boolean,
  ) => {
    const pending = pendingReaderResumeRef.current;
    if (pending === null || !annotationReaderIdentityMatches(pending.identity, record.identity)) return;
    pendingReaderResumeRef.current = null;
    if (!overflowing) {
      restoreAnnotationList(pending, {
        ...(pending.identity.origin === 'owned' ? { activeItemId: pending.identity.itemId } : {}),
        preferRowTarget: true,
      });
      return;
    }
    cancelAnnotationRestoration();
    setAnnotationReaderSession({ ...pending, entryFocus: 'edit' });
  };

  const settleOwnedReaderOverflow = (
    record: AnnotationReaderRecord,
    overflowing: boolean,
  ) => {
    settlePendingReaderResume(record, overflowing);
    if (record.identity.origin === 'owned') {
      ownedReaderOverflowRef.current.set(record.identity.itemId, overflowing);
    }
    const pending = pendingMarkReaderRequestRef.current;
    if (
      pending === null
      || record.identity.origin !== 'owned'
      || record.identity.itemId !== pending.id
    ) return;
    pendingMarkReaderRequestRef.current = null;
    if (!overflowing) return;
    openOwnedAnnotationReader(
      record,
      null,
      anyWorkspaceOpen ? 'list' : 'peek',
    );
  };

  useLayoutEffect(() => {
    const action: ReferenceWorkspaceLayoutAction = {
      type: 'set-stage-size',
      width: workspaceFraming.stageSize.width,
      height: workspaceFraming.stageSize.height,
    };
    if (!referenceLayoutControlled) dispatchLocalReferenceLayout(action);
    props.workspace.onReferenceLayoutAction?.(action);
  }, [
    props.workspace.onReferenceLayoutAction,
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
    if (props.workspace.workspaceOpen === undefined) return;
    if (authoringSessionRef.current !== null) return;
    const action = controlledWorkspaceSurfaceAction({
      open: props.workspace.workspaceOpen,
      baseSurface: surface.baseSurface,
      transientSurface: surface.transientSurface,
      mode: workspaceMode,
    });
    if (action !== null) dispatchSurface(action);
  }, [props.workspace.workspaceOpen, surface.baseSurface, surface.transientSurface, workspaceMode]);

  useLayoutEffect(() => {
    if (
      searchFocusRequest <= handledSearchFocusRequestRef.current
      || !toolsSurfaceOpen
      || effectiveWorkspaceMode !== 'search'
    ) return;
    handledSearchFocusRequestRef.current = searchFocusRequest;
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
    if (props.selection.selectionUpdate.kind !== 'reliable') setConsumedSelectionGeneration(undefined);
  }, [props.selection.selectionUpdate.kind, props.selection.selectionUpdate.generation]);

  const dismissPageNoteAuthority = () => {
    if (props.authoring.keyboardPageNoteActive) props.authoring.onCancelKeyboardPageNote?.();
    if (props.authoring.pageMenu) props.authoring.onPageMenuDismiss?.(props.authoring.pageMenu.invocationId);
  };
  const dismissAnnotationPeek = () => {
    cancelAnnotationRestoration();
    peekHeldRef.current = false;
    dismissedPeekIdRef.current = peekItemId;
    pendingReaderResumeRef.current = null;
    pendingMarkReaderRequestRef.current = null;
    if (annotationReaderSession?.origin === 'peek') setAnnotationReaderSession(null);
    setActiveItem(undefined);
    setPeekItemId(undefined);
  };
  useEffect(() => {
    if (authoringSession !== null || annotationReaderSession?.origin !== 'peek') return;
    if (annotationReaderOwnedItemId === activeItemId) return;
    if (activeItemId === undefined) {
      dismissAnnotationPeek();
      return;
    }
    pendingReaderResumeRef.current = null;
    setAnnotationReaderSession(null);
  }, [activeItemId, annotationReaderOwnedItemId, annotationReaderSession, authoringSession]);

  useEffect(() => {
    if (annotationsVisible) {
      setPeekItemId(undefined);
      return;
    }
    if (!anyWorkspaceOpen && activeItemId !== undefined) {
      setPeekItemId(activeItemId);
      return;
    }
    const id = props.correspondingItemId;
    if (id && id === dismissedPeekIdRef.current) return;
    dismissedPeekIdRef.current = undefined;
    if (id) {
      setPeekItemId(id);
    } else if (!peekHeldRef.current) {
      setPeekItemId(undefined);
    }
  }, [annotationsVisible, anyWorkspaceOpen, props.correspondingItemId, activeItemId]);

  useEffect(() => {
    const request = props.activationRequest;
    if (!request || authoringSessionRef.current !== null) return;
    dismissedPeekIdRef.current = undefined;
    cancelAnnotationRestoration();
    pendingReaderResumeRef.current = null;
    setAnnotationReaderSession(null);
    setActiveItem(request.id);
    setListActivation(request);
    const item = props.state.items.find(({ id }) => id === request.id);
    const readerRecord = item === undefined ? null : projectOwnedAnnotationReader(item);
    const knownOverflow = ownedReaderOverflowRef.current.get(request.id);
    pendingMarkReaderRequestRef.current = !anyWorkspaceOpen || item === undefined || knownOverflow !== undefined
      ? null
      : { id: request.id, token: request.token };
    setWorkspaceRequest(item && anyWorkspaceOpen
      ? {
          kind: 'mark',
          reviewId: item.id,
          pageIndex: item.pageIndex,
          token: ++annotationRequestTokenRef.current,
        }
      : { kind: 'reading', token: ++annotationRequestTokenRef.current });
    dismissPageNoteAuthority();
    if (!anyWorkspaceOpen) {
      setPeekItemId(item?.id);
      return;
    }
    workspaceFraming.prepareMarkReveal();
    setPeekItemId(undefined);
    dispatchSurface({ type: 'open-workspace', mode: 'annotations' });
    dispatchReferenceLayout({ type: 'show-right-workspace' });
    dispatchReferenceLayout({ type: 'focus-surface', surface: 'right' });
    props.workspace.onWorkspaceModeChange?.('annotations');
    if (readerRecord !== null && knownOverflow === true) {
      openOwnedAnnotationReader(readerRecord, null, 'list');
    }
  }, [
    props.activationRequest?.id,
    props.activationRequest?.token,
    anyWorkspaceOpen,
    workspaceFraming.prepareMarkReveal,
  ]);

  const selectWorkspaceMode = (mode: WorkspaceMode) => {
    if (authoringSessionRef.current !== null) return;
    workspaceFraming.commitUserPosition(undefined, { stopAutomaticScroll: false });
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
    props.workspace.onWorkspaceModeChange?.(mode);
  };
  const focusAnnotationsFallback = () => {
    requestAnimationFrame(() => {
      const shell = shellRef.current;
      const target = shell?.querySelector<HTMLElement>('[data-workspace-focus-token="annotations:section"]')
        ?? shell?.querySelector<HTMLElement>('#workspace-panel-annotations');
      target?.focus({ preventScroll: true });
    });
  };
  const openAnnotationsFromDocumentActions = () => {
    if (authoringSessionRef.current !== null) {
      authoringEditorRef.current?.focus({ preventScroll: true });
      requestAnimationFrame(() => authoringEditorRef.current?.focus({ preventScroll: true }));
      return;
    }
    setWorkspaceRequest({ kind: 'reading', token: ++annotationRequestTokenRef.current });
    setReconciliationFocusRequest((token) => token + 1);
    dispatchSurface({ type: 'open-workspace', mode: 'annotations' });
    dispatchReferenceLayout({ type: 'show-right-workspace' });
    selectWorkspaceMode('annotations');
  };
  const openFindCommand = () => {
    setSearchFocusRequest((request) => request + 1);
    selectWorkspaceMode('search');
    dispatchReferenceLayout({ type: 'show-right-workspace' });
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
      const result = await props.authoring.onCommand(command, options?.authority);
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
    props.selection.onSelectionConsumed?.(generation);
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
    cancelAnnotationRestoration();
    pendingReaderResumeRef.current = null;
    inputControllerRef.current?.clearDraft();
    const session = createAuthoringSession({
      token: ++authoringSessionTokenRef.current,
      authority: currentAuthoringAuthorityRef.current,
      source,
      origin: { kind: originKind, trigger },
      workspace: snapshotAuthoringWorkspace(),
    });
    authoringSessionRef.current = session;
    props.authoring.onAuthoringActiveChange?.(true);
    setAuthoringSession(session);
    dispatchSurface({ type: 'open-nested' });
    if (props.state.workflow.mode === 'generated-output') {
      void protectAuthoringDraft(session, initialAuthoringValue(session));
    }
    return true;
  };

  const handleInputIntent = (intent: ProofreadInputIntent) => {
    if (authoringSessionRef.current !== null) {
      inputControllerRef.current?.clearDraft();
      return;
    }
    const selectionGeneration = props.selection.selectionUpdate.kind === 'reliable'
      ? props.selection.selectionUpdate.generation
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
    acceptedState?: ReviewState,
  ) => {
    const current = authoringSessionRef.current;
    if (current === null || current.token !== token) return;
    const readerOrigin = current.origin.kind === 'reader-edit'
      ? annotationReaderSession
      : null;
    authoringSessionRef.current = null;
    props.authoring.onAuthoringActiveChange?.(false);
    props.authoring.onAuthoringPreviewChange?.(null);
    setAuthoringSession(null);
    inputController.clearDraft();
    dispatchSurface({ type: 'close-nested' });
    if (current.source.kind === 'pageNote') props.authoring.onPageNoteComposerComplete?.();
    if (reason === 'source-replaced') {
      if (readerOrigin !== null) {
        if (!authoringAuthorityMatches(readerOrigin.authority, currentAuthoringAuthorityRef.current)) {
          setActiveItem(undefined);
        }
        restoreAnnotationList(readerOrigin, { preferRowTarget: true });
      }
      return;
    }
    if (readerOrigin !== null) {
      const nextReaderRecord = resolveAnnotationReader(readerOrigin.identity, {
        ownedItems: (acceptedState ?? props.state).items,
        existingAnnotations,
        documentGeneration: navigation.documentGeneration,
      });
      if (nextReaderRecord === null) {
        const readerItemId = readerOrigin.identity.origin === 'owned'
          ? readerOrigin.identity.itemId
          : undefined;
        const readerItemStillExists = readerItemId !== undefined
          && (acceptedState ?? props.state).items.some(({ id }) => id === readerItemId);
        restoreAnnotationList(readerOrigin, {
          ...(readerItemStillExists ? { activeItemId: readerItemId } : {}),
          preferRowTarget: true,
        });
        return;
      }
      if (reason === 'accepted') {
        pendingReaderResumeRef.current = readerOrigin;
        cancelAnnotationRestoration();
        setAnnotationReaderSession(null);
        if (readerOrigin.identity.origin === 'owned') {
          setActiveItem(readerOrigin.identity.itemId);
        }
        return;
      }
    }
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
      const restoredPeek = current.workspace.activeItemId === undefined ? null
        : [...shell.querySelectorAll<HTMLElement>('[data-annotation-peek]')]
          .find((element) => element.dataset.annotationPeek === current.workspace.activeItemId);
      const target = originTrigger?.isConnected === true
        ? originTrigger
        : current.origin.kind === 'tray-edit'
          ? (restoredPeek ?? restoredItem)?.querySelector<HTMLElement>('[data-row-action="edit"]')
          : current.origin.kind === 'reader-edit'
            ? restoredItem?.querySelector<HTMLElement>('.annotation-item__navigation')
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
      props.authoring.authoringAnchorNavigation?.token === session.token
      && props.authoring.authoringAnchorNavigation.pending
    ) await props.authoring.authoringAnchorNavigation.onCancelReturn?.();
    if (props.state.workflow.mode === 'generated-output') {
      await discardProtectedAuthoringDraft(session);
    }
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
      props.authoring.authoringAnchorNavigation?.token === current.token
      && props.authoring.authoringAnchorNavigation.pending
    ) props.authoring.authoringAnchorNavigation.onCancelReturn?.();
    setAnnouncement('This draft belonged to the previous document and was not applied.');
    closeAuthoringSession(current.token, 'source-replaced');
  }, [currentAuthoringAuthority.documentGeneration, currentAuthoringAuthority.sourceIdentity]);

  useLayoutEffect(() => {
    const current = authoringSessionRef.current;
    if (current === null || current.source.kind !== 'edit') return;
    const editedItemId = current.source.item.id;
    if (props.state.items.some(({ id }) => id === editedItemId)) return;
    setAnnouncement('This annotation is no longer available and the edit was not applied.');
    closeAuthoringSession(current.token, 'source-replaced');
  }, [props.state.items]);

  useEffect(() => {
    const resolution = props.authoring.authoringSessionResolution;
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
  }, [props.authoring.authoringSessionResolution?.token]);
  useLayoutEffect(() => {
    inputController.focusChanged(isEditableTarget(document.activeElement));
    inputController.setContext({
      caret: props.selection.caretAnchor ?? null,
      selectionUpdate: props.selection.selectionUpdate,
    });
  }, [inputController, props.selection.caretAnchor, props.selection.selectionUpdate]);

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
        (props.workspace.linkActionRequest && event.target.closest('[data-link-action-popover]') !== null)
        || event.target.closest('[data-row-actions-open="true"]') !== null
        || event.target.closest('[data-top-bar-menu], [data-document-actions-open="true"]') !== null
      )
    ) return;
    const editable = isEditableTarget(event.target);
    if (
      (event.metaKey || event.ctrlKey)
      && !(event.metaKey && event.ctrlKey)
      && !event.altKey
      && !event.shiftKey
      && event.key.toLowerCase() === 'f'
      && !event.nativeEvent.isComposing
      && surface.nestedLayer === 'none'
      && authoringSessionRef.current === null
    ) {
      if (commandSurface.invoke('find')) event.preventDefault();
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
      if (peekItemId !== undefined || annotationReaderSession?.origin === 'peek') {
        event.preventDefault();
        dismissAnnotationPeek();
        return;
      }
      if (surface.nestedLayer !== 'none') {
        event.preventDefault();
        void closeNested();
        return;
      }
      if (props.authoring.keyboardPageNoteActive) {
        event.preventDefault();
        props.authoring.onCancelKeyboardPageNote?.();
        dispatchSurface({ type: 'close-transient' });
        return;
      }
      if (props.authoring.pageMenu) {
        event.preventDefault();
        props.authoring.onPageMenuDismiss?.(props.authoring.pageMenu.invocationId);
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
          props.authoring.onRequestKeyboardPageNote?.();
          dispatchSurface({ type: 'open-transient', surface: 'page-note-cursor' });
        }
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      if (commandSurface.invoke(event.shiftKey ? 'redo' : 'undo')) event.preventDefault();
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
    if (props.selection.selectionUpdate.kind === 'over-limit') {
      props.selection.onSelectionPageLimitExceeded?.();
      return;
    }
    const anchor = selectionAnchor;
    const selectionGeneration = props.selection.selectionUpdate.kind === 'reliable'
      ? props.selection.selectionUpdate.generation
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
    if (props.selection.selectionUpdate.kind === 'over-limit') {
      props.selection.onSelectionPageLimitExceeded?.();
      return;
    }
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!selectionAnchor || props.selection.selectionUpdate.kind !== 'reliable') {
      setAnnouncement('Select reliable text to suggest a replacement.');
      return;
    }
    beginAuthoring({
      kind: 'replace',
      anchor: selectionAnchor,
      initialValue: '',
      selectionGeneration: props.selection.selectionUpdate.generation,
    }, 'selection', trigger);
  };

  const deleteSelection = () => {
    if (props.selection.selectionUpdate.kind === 'over-limit') {
      props.selection.onSelectionPageLimitExceeded?.();
      return;
    }
    const selectionGeneration = props.selection.selectionUpdate.kind === 'reliable'
      ? props.selection.selectionUpdate.generation
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
    const placed = props.authoring.placedPageNote;
    if (!placed || placed.token === lastPlacedPageNoteToken.current) return;
    lastPlacedPageNoteToken.current = placed.token;
    startPageNote(placed);
    props.authoring.onPlacedPageNoteConsumed?.(placed.token);
  }, [props.authoring.placedPageNote]);

  const submitAuthoring = async (
    session: AuthoringSession,
    build: (state: ReviewState) => ReviewCommand,
    onAccepted?: () => void,
  ) => {
    let accepted = false;
    const next = await submit(build, {
      authority: session.authority,
      onAccepted: () => {
        accepted = true;
        onAccepted?.();
      },
      onStale: () => closeAuthoringSession(session.token, 'source-replaced'),
    });
    if (accepted) closeAuthoringSession(session.token, 'accepted', next);
  };

  const protectAuthoringDraft = (
    session: AuthoringSession,
    value: string,
  ): Promise<ReviewState> => submit((state) => {
    const existing = state.pendingDrafts.find(({ id }) => id === session.draftId);
    const updatedAt = new Date().toISOString();
    return {
      type: 'put-draft',
      expectedRevision: state.revision,
      expectedDraftRevision: existing?.revision ?? -1,
      draft: pendingDraftForAuthoring({
        session,
        ownerViewId: authoringOwnerViewIdRef.current,
        text: value,
        revision: existing?.revision ?? 0,
        createdAt: existing?.createdAt ?? updatedAt,
        updatedAt,
      }),
    };
  }, {
    authority: session.authority,
    onStale: () => closeAuthoringSession(session.token, 'source-replaced'),
  });

  const discardProtectedAuthoringDraft = async (session: AuthoringSession): Promise<void> => {
    await commandTailRef.current;
    const existing = acknowledgedRef.current.pendingDrafts.find(({ id }) => id === session.draftId);
    if (existing === undefined) return;
    await submit((state) => {
      const current = state.pendingDrafts.find(({ id }) => id === session.draftId);
      if (current === undefined) throw new Error('The protected authoring draft is unavailable.');
      return {
        type: 'discard-reconciliation',
        expectedRevision: state.revision,
        target: 'draft',
        id: current.id,
        expectedTargetRevision: current.revision,
        ownerViewId: current.ownerViewId,
        reason: 'cancelled-by-author-before-apply',
        discardedAt: new Date().toISOString(),
      };
    }, { authority: session.authority });
  };

  const applyProtectedAuthoring = async (
    session: AuthoringSession,
    value: string,
    onAccepted?: () => void,
  ) => {
    await protectAuthoringDraft(session, value);
    await submitAuthoring(session, (state) => {
      const draft = state.pendingDrafts.find(({ id }) => id === session.draftId);
      if (draft === undefined) throw new Error('The protected authoring draft is unavailable.');
      return {
        type: 'apply-draft',
        expectedRevision: state.revision,
        id: draft.id,
        expectedDraftRevision: draft.revision,
        ownerViewId: draft.ownerViewId,
        updatedAt: new Date().toISOString(),
      };
    }, onAccepted);
  };

  const saveAuthoring = async (session: AuthoringSession, value: string) => {
    const source = session.source;
    if (props.state.workflow.mode === 'generated-output') {
      await applyProtectedAuthoring(
        session,
        value,
        source.kind === 'replace' || source.kind === 'highlight'
          ? () => consumeSelectionActions(source.selectionGeneration)
          : undefined,
      );
      return;
    }
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

  const deleteOwnedAnnotation = async (item: ReviewItem) => {
    const next = await submit((state) => removeReviewItem(state, item.id));
    ownedReaderOverflowRef.current.delete(item.id);
    if (activeItemId === item.id) setActiveItem(next.items[0]?.id);
  };

  const canUndo = props.state.historyCursor > 0;
  const canRedo = props.state.historyCursor < props.state.history.length;
  const fitWidthCommand = () => {
    workspaceFraming.markUserIntent(undefined, { captureSettledPosition: false });
    return props.viewer.viewerNavigation
      ?.fitToWidth(workspaceFraming.waitForSettledGeometry)
      .then(() => undefined) ?? Promise.resolve();
  };
  const commandSurface = createReviewCommandSurface({
    focusContext: commandFocusContext,
    canUndo: authoringSession === null && canUndo,
    canRedo: authoringSession === null && canRedo,
    canNavigateBack: !props.workspace.documentNavigationPending && (props.workspace.canNavigateBack ?? false),
    canNavigateForward: !props.workspace.documentNavigationPending && (props.workspace.canNavigateForward ?? false),
    canFind: surface.nestedLayer === 'none' && authoringSession === null,
    canOpenAnnotations: authoringSession === null,
    canOpenSaveOptions: props.save.onSaveOptions !== undefined,
    canFitWidth: props.viewer.viewerNavigation?.fitToWidthReady() ?? false,
    handlers: {
      undo: () => { void submit(undoReview); },
      redo: () => { void submit(redoReview); },
      'navigate-back': () => {
        workspaceFraming.markUserIntent(undefined, { captureSettledPosition: false });
        props.workspace.onNavigateBack?.();
      },
      'navigate-forward': () => {
        workspaceFraming.markUserIntent(undefined, { captureSettledPosition: false });
        props.workspace.onNavigateForward?.();
      },
      find: openFindCommand,
      'open-annotations': openAnnotationsFromDocumentActions,
      'save-options': () => props.save.onSaveOptions?.(),
      'fit-width': () => { void fitWidthCommand(); },
    },
  });
  const commandSurfaceKey = JSON.stringify(commandSurface.snapshot);
  useEffect(() => {
    props.onCommandSurfaceChange?.(commandSurface.snapshot);
  }, [commandSurfaceKey, props.onCommandSurfaceChange]);
  useEffect(() => {
    const invocation = props.commandInvocation;
    if (invocation === undefined || invocation.token <= handledCommandInvocationRef.current) return;
    handledCommandInvocationRef.current = invocation.token;
    commandSurface.invoke(invocation.id);
  }, [props.commandInvocation?.id, props.commandInvocation?.token, commandSurfaceKey]);
  useEffect(() => {
    const transition = props.accessibilityTransition;
    if (transition === undefined || transition.token <= handledAccessibilityTransitionRef.current) return;
    handledAccessibilityTransitionRef.current = transition.token;
    setTransitionAnnouncement(transition.announcement);
    const frame = requestAnimationFrame(() => {
      const shell = shellRef.current;
      if (shell === null) return;
      const active = shell.ownerDocument.activeElement instanceof HTMLElement
        ? shell.ownerDocument.activeElement : null;
      if (active !== null && active.closest('.review-chrome') !== null && isVisibleFocusTarget(active)) return;
      const target = transition.focus === 'first-recovery-action-if-needed'
        ? shell.querySelector<HTMLElement>(
          '[data-recovery-primary]:not(:disabled), [data-recovery-action]:not(:disabled)',
        )
        : transition.focus === 'retry-status'
          ? shell.querySelector<HTMLElement>('[data-retry-status]')
          : shell.querySelector<HTMLElement>(
            '.pdf-workspace:not(.pdf-workspace--reference) [data-page-index], [role="application"]',
          );
      if (target !== null && isVisibleFocusTarget(target)) target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.accessibilityTransition?.token]);
  const closeWorkspace = () => {
    workspaceFraming.commitUserPosition();
    cancelAnnotationRestoration();
    pendingReaderResumeRef.current = null;
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
    if (closingReferences) props.workspace.onWorkspaceDismiss?.();
    requestAnimationFrame(() => (bottomRail ? bottomWorkspaceRailRef : rightWorkspaceRailRef)
      .current?.focus({ preventScroll: true }));
  };
  const focusWorkspaceModeAfterLayout = (mode: WorkspaceMode) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const shell = shellRef.current;
      const rememberedToken = surface.navigation.workspace.modes[mode].logicalFocusToken;
      const remembered = rememberedToken === null ? null : [
        ...shell?.querySelectorAll<HTMLElement>('[data-workspace-focus-token]') ?? [],
      ].find((element) => element.dataset.workspaceFocusToken === rememberedToken);
      const target = mode === 'references'
        ? shell?.querySelector<HTMLElement>('[data-reference-tab][aria-selected="true"]')
          ?? shell?.querySelector<HTMLElement>('[data-reference-empty]')
        : remembered ?? shell?.querySelector<HTMLElement>(`#workspace-panel-${mode}`);
      target?.focus({ preventScroll: true });
    }));
  };
  const rememberWorkspaceModeFocus = (mode: WorkspaceMode, token: string) => {
    if (props.workspace.navigationState === undefined) {
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
    props.workspace.onWorkspaceModeFocusTokenChange?.(mode, token);
  };
  const markFramingUserIntent = workspaceFraming.markUserIntent;
  const commitMainFramingPosition = useCallback(() => {
    markFramingUserIntent(undefined, { captureSettledPosition: false });
  }, [markFramingUserIntent]);
  useLayoutEffect(() => {
    props.viewer.onCommitMainFramingPositionChange?.(commitMainFramingPosition);
    return () => props.viewer.onCommitMainFramingPositionChange?.(null);
  }, [commitMainFramingPosition, props.viewer.onCommitMainFramingPositionChange]);
  useLayoutEffect(() => {
    if ((props.viewer.viewerNavigationIntentToken ?? 0) > 0) {
      commitMainFramingPosition();
    }
  }, [commitMainFramingPosition, props.viewer.viewerNavigationIntentToken]);
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
  const activePdfLinkCopy = props.workspace.linkActionRequest === null
    || props.workspace.linkActionRequest === undefined
    || props.workspace.copyLinkForLinkAction === undefined
    ? undefined
    : props.workspace.copyLinkForLinkAction(props.workspace.linkActionRequest);
  const authoringComposer = authoringSession === null ? null : (() => {
    const source = authoringSession.source;
    const editField = source.kind === 'edit' ? mutableField(source.item) : undefined;
    if (source.kind === 'edit' && editField === undefined) return null;
    const initialValue = initialAuthoringValue(authoringSession);
    const fieldLabel = source.kind === 'replace'
      ? 'Replacement'
      : source.kind === 'insert'
        ? 'Insertion'
        : source.kind === 'edit' && source.item.kind === 'replace'
          ? 'Replacement'
          : source.kind === 'edit' && source.item.kind === 'insert'
            ? 'Insertion'
            : undefined;
    const authoringPageIndex = source.kind === 'edit'
      ? source.item.pageIndex
      : source.kind === 'pageNote'
        ? source.pageIndex
        : source.anchor.pageIndex;
    const anchorNavigation = props.authoring.authoringAnchorNavigation?.token === authoringSession.token
      ? {
        ...props.authoring.authoringAnchorNavigation,
        pageNumber: authoringPageIndex + 1,
        visibility: authoringPlacement?.targetVisibility ?? props.authoring.authoringAnchorNavigation.visibility,
      }
      : undefined;
    return <CommentComposer
      title={authoringSession.semantics.title}
      saveLabel={authoringSession.semantics.primaryLabel}
      optional={authoringSession.semantics.optional}
      allowWhitespace={authoringSession.semantics.allowWhitespace}
      {...(fieldLabel === undefined ? {} : { fieldLabel })}
      initialValue={initialValue}
      editorRef={authoringEditorRef}
      surfaceRef={setAuthoringSurfaceElement}
      {...(authoringPlacement === undefined ? {} : { placement: authoringPlacement })}
      anchorNavigation={anchorNavigation}
      onValueChange={(value) => {
        if (authoringSessionRef.current?.token !== authoringSession.token) return;
        if (props.state.workflow.mode === 'generated-output') {
          void protectAuthoringDraft(authoringSession, value);
        }
      }}
      onDismiss={() => dismissAuthoring(authoringSession)}
      onSave={(value) => saveAuthoring(authoringSession, value)}
    />;
  })();
  return (
    <section
      className="review-shell"
      onBeforeInputCapture={beforeInput}
      onKeyDownCapture={keyDown}
      onFocusCapture={(event) => {
        const editable = isEditableTarget(event.target);
        inputController.focusChanged(editable);
        setCommandFocusContext(
          event.target instanceof Element
          && event.target.closest('[role="dialog"], [aria-modal="true"]') !== null
            ? 'dialog'
            : editable ? 'editable' : 'review',
        );
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
          && (peekItemId !== undefined || annotationReaderSession?.origin === 'peek')
          && event.button === 0
          && event.target instanceof Element
          && event.target.closest('.annotation-peek, [data-owned-focus-id], [data-owned-mark], [data-page-index]') === null
        ) dismissAnnotationPeek();
        if (
          authoringSessionRef.current === null
          && (activeItemId !== undefined || activeExistingAnnotationKey !== undefined)
          && event.button === 0
          && event.target instanceof Element
          && event.target.closest('[data-review-item], [data-existing-annotation], [data-owned-focus-id], [data-page-index], .annotation-peek') === null
        ) {
          setActiveItem(undefined);
          setActiveExistingAnnotationKey(undefined);
        }
        if (props.workspace.linkActionRequest) return;
        if (event.target instanceof Element) {
          const markTrigger = event.target.closest<HTMLElement>('[data-owned-focus-id]');
          if (markTrigger) surfaceTriggersRef.current.set('workspace', markTrigger);
        }
        if (
          workspaceOpen
          && event.target instanceof Element
          && event.target.closest('.review-chrome__viewer-controls, .review-chrome__left-controls') !== null
        ) {
          markFramingUserIntent();
        }
      }}
    >
      <p className="review-transition-announcement" aria-live="polite" aria-atomic="true">
        {transitionAnnouncement}
      </p>
      <ReviewChrome
        showSaveStatusDot={!props.save.exportOnly}
        documentTitle={props.documentTitle ?? 'Local PDF'}
        {...(props.save.savedLabel === undefined ? {} : { savedLabel: props.save.savedLabel })}
        {...(props.save.savePhase === undefined ? {} : { savePhase: props.save.savePhase })}
        savePendingDestination={props.save.savePendingDestination ?? false}
        saveOptionsOpen={props.save.saveOptionsOpen ?? false}
        onSaveOptions={() => commandSurface.invoke('save-options')}
        saveOptionsAvailable={props.save.onSaveOptions !== undefined}
        {...(documentActionsPresentation === undefined ? {} : {
          documentActions: {
            presentation: documentActionsPresentation,
            ...(props.documentActionsRequestToken === undefined ? {} : {
              requestToken: props.documentActionsRequestToken,
            }),
            ...(props.onDocumentActionsRequestHandled === undefined ? {} : {
              onRequestHandled: props.onDocumentActionsRequestHandled,
            }),
            onExport: props.save.onExportReviewedCopy
              ?? (() => Promise.reject(new Error('Reviewed export is unavailable.'))),
            onOpenAnnotations: openAnnotationsFromDocumentActions,
          },
        })}
        {...(props.viewer.viewerControls === undefined ? {} : { controls: props.viewer.viewerControls })}
        viewerState={props.viewer.viewerState ?? unavailableViewerControls()}
        fitWidthReady={props.viewer.viewerNavigation?.fitToWidthReady() ?? false}
        fitWidthCurrent={overlayFrame.fitWidthCurrent}
        horizontalScrollAvailable={overlayFrame.horizontalScrollAvailable}
        horizontalScrollLocked={horizontalScrollLocked}
        onToggleHorizontalScrollLock={() => setHorizontalScrollLocked((locked) => !locked)}
        {...(props.viewer.viewerNavigation === undefined ? {} : {
          beforeViewerAction: async () => {
            await props.viewer.viewerNavigation?.cancelPendingNavigation();
            commitMainFramingPosition();
          },
        })}
        onFitWidth={fitWidthCommand}
        canUndo={authoringSession === null && canUndo}
        canRedo={authoringSession === null && canRedo}
        canNavigateBack={props.workspace.canNavigateBack ?? false}
        canNavigateForward={props.workspace.canNavigateForward ?? false}
        documentNavigationPending={props.workspace.documentNavigationPending ?? false}
        {...(props.codexContext === undefined ? {} : { codexContext: props.codexContext })}
        {...(props.copyLink === undefined ? {} : { copyLink: props.copyLink })}
        onUndo={() => { commandSurface.invoke('undo'); }}
        onRedo={() => { commandSurface.invoke('redo'); }}
        onNavigateBack={() => { commandSurface.invoke('navigate-back'); }}
        onNavigateForward={() => { commandSurface.invoke('navigate-forward'); }}
      />
      <div
        ref={workspaceFraming.stageRef}
        className="review-layout"
        data-review-stage
        data-horizontal-scroll-locked={horizontalScrollLocked ? 'true' : undefined}
        data-reference-layout={effectiveReferenceLayout.kind}
        data-workspace-presentation={workspaceFraming.presentation}
        data-annotation-presentation={workspaceFraming.presentation}
        data-right-surface-open={rightSurfaceOpen ? 'true' : 'false'}
        data-bottom-surface-open={effectiveReferenceLayout.kind === 'wide-split'
          && effectiveReferenceLayout.bottomReferencesOpen ? 'true' : 'false'}
        data-right-rail-present={effectiveReferenceLayout.kind === 'narrow-unified' ? 'false' : 'true'}
        data-bottom-rail-present={(
          effectiveReferenceLayout.kind === 'narrow-unified'
          || (referencesAvailable && effectiveReferenceLayout.referenceDock === 'bottom')
        ) ? 'true' : 'false'}
        data-right-overlay={overlayFrame.geometry.rightStart === null ? 'false' : 'true'}
        data-bottom-overlay={overlayFrame.geometry.bottomStart === null ? 'false' : 'true'}
        data-scroll-top-fade={overlayFrame.geometry.fadeTop ? 'true' : 'false'}
        data-scroll-right-fade={overlayFrame.geometry.fadeRight ? 'true' : 'false'}
        data-scroll-bottom-fade={overlayFrame.geometry.fadeBottom ? 'true' : 'false'}
        style={{
          ...overlayFrame.style,
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
        {props.save.saveRecovery || props.toolError || props.commandNotice || generatedStatusMessages.length > 0 ? <div
          className="review-toast-stack"
          data-review-toast-stack
        >
          {props.save.saveRecovery ? <aside className="review-toast review-toast--error review-save-notice" role="alert">
            <ReviewIcon name="alert" />
            <span>{props.save.saveRecovery.error ?? 'Couldn’t save your latest annotations.'}</span>
            <div className="review-save-notice__actions">
              <button type="button" title="Retry saving" disabled={props.save.saveRecovery.pending}
                onClick={() => void props.save.saveRecovery?.onRetry()}>Retry</button>
              <button type="button" title="Save a copy" disabled={props.save.saveRecovery.pending}
                onClick={props.save.saveRecovery.onSaveCopy}>Save a copy…</button>
            </div>
          </aside> : null}
          {props.toolError ? <p
            className="review-toast review-toast--error"
            role="alert"
            data-viewer-status
          ><ReviewIcon name="alert" />{props.toolError}</p> : null}
          {props.commandNotice ? <p className="review-toast review-toast--status"
            role="status" aria-live="polite" data-host-command-status
          ><ReviewIcon name="check" />{props.commandNotice}</p> : null}
          {generatedStatusMessages.length > 0 ? <p
            className="review-toast review-toast--status"
            data-generation-status={props.generationRefreshStatus ?? 'idle'}
            role={props.generationRefreshStatus === 'failed' ? 'alert' : 'status'}
          ><ReviewIcon name={props.generationRefreshStatus === 'failed' ? 'alert' : 'loading'} />{
            generatedStatusMessages.join(' ')
          }</p> : null}
        </div> : null}
        {competingPdfSelections || props.selection.pdfCopyOwnerIndicatorVisible ? <p
          className="pdf-copy-owner"
          role="status"
          aria-live="polite"
          data-pdf-copy-owner={props.selection.pdfCopyOwner ?? 'none'}
        >Copy source: {pdfCopyOwnerLabel}</p> : null}
        <div className="review-document">{props.children}</div>
        <div className="review-overlay-frame" aria-hidden="true">
          <span className="review-overlay-frame__right-backing" />
          <span className="review-overlay-frame__right-fade" />
          <span className="review-overlay-frame__bottom-backing" />
          <span className="review-overlay-frame__bottom-fade" />
          <span className="review-overlay-frame__top-fade" />
          <span className="review-overlay-frame__outer-right-fade" />
          <span className="review-overlay-frame__outer-bottom-fade" />
        </div>
        <div
          className="review-contextual-host"
          data-review-contextual-host
          data-selection-status={props.selection.selectionUpdate.kind}
        >
          {selectionActionsAvailable && props.selection.selectionPlacement ? (
            <ContextActionPalette
              placement={props.selection.selectionPlacement}
              hidden={surface.nestedLayer !== 'none'}
              {...(props.selection.onCopySelection === undefined ? {} : { onCopy: props.selection.onCopySelection })}
              onReplace={startReplacement}
              onDelete={deleteSelection}
              onHighlight={startHighlight}
            />
          ) : null}
          {!selectionAnchor && props.selection.caretAnchor && props.selection.caretPlacement ? (
            <InsertionCaret
              key={`${props.selection.caretAnchor.pageIndex}:${props.selection.caretAnchor.position.x}:${props.selection.caretAnchor.position.y}`}
              placement={props.selection.caretPlacement}
              hidden={surface.nestedLayer !== 'none'}
            />
          ) : null}
          {surface.baseSurface === 'reading' && surface.nestedLayer === 'none' && props.authoring.pageMenu ? (
            <PageActionMenu
              placement={props.authoring.pageMenu.placement}
              triggerRef={pageNoteTriggerRef}
              {...(props.authoring.onGoToSource === undefined ? {} : {
                onGoToSource: () => {
                  const menu = props.authoring.pageMenu;
                  if (!menu) return;
                  props.authoring.onPageMenuConsumed?.(menu.invocationId);
                  props.authoring.onGoToSource?.(menu);
                  dispatchSurface({ type: 'close-transient' });
                },
              })}
              onAddPageNote={() => {
                const menu = props.authoring.pageMenu;
                if (!menu) return;
                props.authoring.onPageMenuConsumed?.(menu.invocationId);
                startPageNote(menu);
              }}
              onDismiss={() => {
                const menu = props.authoring.pageMenu;
                if (!menu) return;
                props.authoring.onPageMenuDismiss?.(menu.invocationId);
                dispatchSurface({ type: 'close-transient' });
              }}
            />
          ) : null}
          {authoringSession === null
            && !annotationsVisible
            && annotationReaderSession?.origin === 'peek'
            && annotationReaderRecord !== null ? (
              <aside className="annotation-peek annotation-peek--reader">
                <FullAnnotationReader
                  record={annotationReaderRecord}
                  onBack={(restoreRowFocus) => closeAnnotationReader(annotationReaderSession, restoreRowFocus)}
                  {...(annotationReaderSourceNavigation === undefined
                    ? {}
                    : { sourceNavigation: annotationReaderSourceNavigation })}
                  {...(annotationReaderOwnedItemId === undefined ? {} : {
                    onEdit: (trigger: HTMLButtonElement) => {
                      const item = props.state.items.find(({ id }) => id === annotationReaderOwnedItemId);
                      if (item !== undefined) beginAuthoring({ kind: 'edit', item }, 'reader-edit', trigger);
                    },
                    onDelete: async () => {
                      const item = props.state.items.find(({ id }) => id === annotationReaderOwnedItemId);
                      if (item !== undefined) await deleteOwnedAnnotation(item);
                    },
                  })}
                />
              </aside>
            ) : null}
          {authoringSession === null
            && !annotationsVisible
            && annotationReaderSession?.origin !== 'peek'
            && peekItemId ? (() => {
            const item = props.state.items.find(({ id }) => id === peekItemId);
            if (item === undefined) return null;
            const copyLink = copyLinkForItem(item);
            return (
              <AnnotationPeek
                item={item}
                selected={!anyWorkspaceOpen && activeItemId === item.id}
                showSourceReturn={annotationReaderVisibility === 'outside'}
                {...(copyLink === undefined ? {} : { copyLink })}
                onHoldChange={(held) => {
                  peekHeldRef.current = held;
                  if (!held && (anyWorkspaceOpen || activeItemId === undefined) && props.correspondingItemId === undefined) {
                    setPeekItemId(undefined);
                  }
                }}
                onNavigate={() => {
                  workspaceFraming.markUserIntent();
                  setActiveItem(item.id);
                  props.onNavigate?.(item);
                }}
                onReadFull={(record, trigger) => openOwnedAnnotationReader(record, trigger, 'peek')}
                onReaderOverflowChange={settleOwnedReaderOverflow}
                onEdit={(trigger) => beginAuthoring({ kind: 'edit', item }, 'tray-edit', trigger)}
                onDelete={async () => {
                  await deleteOwnedAnnotation(item);
                  setPeekItemId(undefined);
                }}
              />
            );
          })() : null}
        </div>
        <div
          className="review-drawer-host"
          data-review-drawer-host
          inert={props.save.saveOptionsOpen ?? false}
          aria-hidden={props.save.saveOptionsOpen === true ? 'true' : undefined}
        >
          {authoringComposer}
          {authoringSession === null ? (effectiveReferenceLayout.kind === 'narrow-unified' ? (
            !referenceSurfaceOpen ? <WorkspaceEdgeRail
              buttonRef={bottomWorkspaceRailRef}
              surface="bottom"
              target="workspace"
              open={referenceSurfaceOpen}
              controls="review-workspace"
              onToggle={() => {
                workspaceFraming.commitUserPosition();
                dismissPageNoteAuthority();
                const opening = !effectiveReferenceLayout.open;
                dispatchReferenceLayout({ type: 'toggle-narrow-workspace' });
                if (opening) focusWorkspaceModeAfterLayout(effectiveWorkspaceMode);
              }}
            /> : null
          ) : (
            <>
              {!rightSurfaceOpen ? <WorkspaceEdgeRail
                buttonRef={rightWorkspaceRailRef}
                surface="right"
                target="workspace"
                open={rightSurfaceOpen}
                controls={effectiveReferenceLayout.referenceDock === 'right' && referencesAvailable
                  ? 'review-workspace review-tools-workspace'
                  : 'review-tools-workspace'}
                onToggle={() => {
                  workspaceFraming.commitUserPosition();
                  dismissPageNoteAuthority();
                  const opening = !rightSurfaceOpen;
                  dispatchReferenceLayout({ type: 'toggle-right-workspace' });
                  if (opening) focusWorkspaceModeAfterLayout(effectiveWorkspaceMode);
                }}
              /> : null}
              {referencesAvailable
                && effectiveReferenceLayout.referenceDock === 'bottom'
                && !effectiveReferenceLayout.bottomReferencesOpen ? <WorkspaceEdgeRail
                buttonRef={bottomWorkspaceRailRef}
                surface="bottom"
                target="References"
                open={effectiveReferenceLayout.bottomReferencesOpen}
                controls="review-workspace"
                onToggle={() => {
                  workspaceFraming.commitUserPosition();
                  dismissPageNoteAuthority();
                  const opening = !effectiveReferenceLayout.bottomReferencesOpen;
                  dispatchReferenceLayout({ type: 'toggle-references' });
                  if (opening) focusWorkspaceModeAfterLayout('references');
                }}
              /> : null}
            </>
          )) : null}
          <OutlineExpansionProvider discovery={visibleOutlineDiscovery}>
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
            {...(props.workspace.pendingReference === undefined ? {} : { pendingReference: props.workspace.pendingReference })}
            {...(props.workspace.referenceReturn === undefined ? {} : { referenceReturn: props.workspace.referenceReturn })}
            announcement={props.workspace.navigationAnnouncement ?? announcement}
            onModeChange={selectWorkspaceMode}
            onHide={() => {
              workspaceFraming.commitUserPosition();
              if (effectiveReferenceLayout.kind === 'narrow-unified') {
                dispatchReferenceLayout({ type: 'toggle-narrow-workspace' });
                requestAnimationFrame(() => bottomWorkspaceRailRef.current?.focus({ preventScroll: true }));
              } else if (effectiveReferenceLayout.referenceDock === 'bottom') {
                dispatchReferenceLayout({ type: 'hide-references' });
                requestAnimationFrame(() => bottomWorkspaceRailRef.current?.focus({ preventScroll: true }));
              } else {
                dispatchReferenceLayout({ type: 'hide-right-workspace' });
                requestAnimationFrame(() => rightWorkspaceRailRef.current?.focus({ preventScroll: true }));
              }
            }}
            hideLabel={effectiveReferenceLayout.kind === 'narrow-unified'
              ? 'Hide workspace'
              : 'Hide References'}
            onReferenceTabActivate={(identity) => {
              if (authoringSessionRef.current === null) props.workspace.onReferenceTabActivate?.(identity);
            }}
            onReferenceTabClose={(identity) => {
              if (authoringSessionRef.current !== null) return;
              props.workspace.onReferenceTabClose?.(identity);
              if (props.workspace.navigationState === undefined) {
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
              if (authoringSessionRef.current === null) props.workspace.onReferenceSendToMain?.(identity);
            }}
            onRetryReference={() => {
              if (authoringSessionRef.current === null) props.workspace.onReferenceRetry?.();
            }}
            {...(props.workspace.onReferenceReturn === undefined
              ? {}
              : { onReferenceReturn: (identity: string) => {
                  if (authoringSessionRef.current === null) props.workspace.onReferenceReturn?.(identity);
                } })}
            onReferenceViewportHost={props.workspace.onReferenceViewportHost ?? ignoreReferenceViewportHost}
            onModeFocusTokenChange={rememberWorkspaceModeFocus}
            headerAction={sharedWorkspace ? (
              <OutlineExpansionToggleSlot visible={outlineExpansionToggleVisible} />
            ) : null}
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
            currentOutlineItemId={props.workspace.currentOutlineItemId ?? null}
            headerAction={(
              <OutlineExpansionToggleSlot visible={outlineExpansionToggleVisible} />
            )}
            onModeChange={selectWorkspaceMode}
            onHide={() => {
              workspaceFraming.commitUserPosition();
              dispatchReferenceLayout({ type: 'hide-right-workspace' });
              requestAnimationFrame(() => rightWorkspaceRailRef.current?.focus({ preventScroll: true }));
            }}
            hideLabel="Hide workspace"
            onOutlineActivate={(item) => {
              if (authoringSessionRef.current === null) props.workspace.onOutlineActivate?.(item);
            }}
            onOutlineReference={(item) => {
              if (authoringSessionRef.current === null) props.workspace.onOutlineReference?.(item);
            }}
            {...(props.workspace.copyLinkForOutlineItem === undefined
              ? {}
              : { copyLinkForOutlineItem: props.workspace.copyLinkForOutlineItem })}
            onModeFocusTokenChange={rememberWorkspaceModeFocus}
            annotations={annotationReaderSession !== null && annotationReaderRecord !== null ? (
              <FullAnnotationReader
                record={annotationReaderRecord}
                onBack={(restoreRowFocus) => closeAnnotationReader(annotationReaderSession, restoreRowFocus)}
                {...(annotationReaderSourceNavigation === undefined
                  ? {}
                  : { sourceNavigation: annotationReaderSourceNavigation })}
                {...(annotationReaderOwnedItemId === undefined ? {} : {
                  onEdit: (trigger: HTMLButtonElement) => {
                    if (authoringSessionRef.current !== null) return;
                    const item = props.state.items.find(({ id }) => id === annotationReaderOwnedItemId);
                    if (item === undefined) {
                      restoreAnnotationList(annotationReaderSession, { preferRowTarget: true });
                      return;
                    }
                    beginAuthoring({ kind: 'edit', item }, 'reader-edit', trigger);
                  },
                  onDelete: async () => {
                    const item = props.state.items.find(({ id }) => id === annotationReaderOwnedItemId);
                    if (item !== undefined) await deleteOwnedAnnotation(item);
                  },
                })}
              />
            ) : <div id="review-annotation-list" aria-label="All annotations">
            {props.state.workflow.mode === 'generated-output' ? <ReconciliationWorkspace
              state={props.state}
              selectionUpdate={props.selection.selectionUpdate}
              {...(props.selection.caretAnchor === undefined ? {} : { caretAnchor: props.selection.caretAnchor })}
              refreshStatus={props.generationRefreshStatus ?? 'idle'}
              onCommand={(command) => props.authoring.onCommand(command)}
              onDetailOpenChange={setReconciliationDetailOpen}
              focusRequestToken={reconciliationFocusRequest}
              onFocusFallback={focusAnnotationsFallback}
            /> : null}
            {reconciliationDetailOpen ? null : <>
            <AnnotationList
              items={visibleOwnedItems}
              existingAnnotations={existingAnnotations}
              documentGeneration={navigation.documentGeneration}
              {...(presentedActiveItemId === undefined ? {} : { activeId: presentedActiveItemId })}
              {...(presentedActiveItemId !== undefined || activeExistingAnnotationKey === undefined
                ? {}
                : { activeExistingAnnotationKey })}
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
                cancelAnnotationRestoration();
                pendingReaderResumeRef.current = null;
                markFramingUserIntent();
                setActiveItem(item.id);
                props.onNavigate?.(item);
              }}
              onNavigateExisting={(annotation) => {
                if (authoringSessionRef.current !== null) return;
                cancelAnnotationRestoration();
                pendingReaderResumeRef.current = null;
                markFramingUserIntent();
                setActiveItem(undefined);
                setActiveExistingAnnotationKey(existingAnnotationKey(annotation));
                props.onNavigateExisting?.(annotation);
              }}
              onReadFull={openOwnedAnnotationReader}
              onReadFullExisting={openExistingAnnotationReader}
              onReaderOverflowChange={settleOwnedReaderOverflow}
              onReaderOverflowChangeExisting={settlePendingReaderResume}
              {...(props.onRetryExistingAnnotations === undefined
                ? {}
                : { onRetryExistingAnnotations: props.onRetryExistingAnnotations })}
              onEdit={(item, trigger) => {
                if (authoringSessionRef.current !== null) return;
                beginAuthoring({ kind: 'edit', item }, 'tray-edit', trigger);
              }}
              onDelete={async (item) => {
                if (authoringSessionRef.current !== null) return;
                await deleteOwnedAnnotation(item);
              }}
            />
            </>}
            </div>}
            search={props.workspace.search ?? (
              <div className="workspace-state" data-workspace-focus-token="search:unavailable" tabIndex={-1}>
                Search becomes available after the PDF loads.
              </div>
            )}
          />
          </OutlineExpansionProvider>
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
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {props.selection.pdfCopyAnnouncement ?? ''}
      </p>
      <div
        className="review-nested-host"
        data-review-nested-host
        hidden={props.save.saveOptionsOpen ?? false}
        inert={props.save.saveOptionsOpen ?? false}
      />
      <LinkActionPopover
        request={props.workspace.linkActionRequest ?? null}
        openInReferencesDisabled={authoringSession !== null}
        {...(activePdfLinkCopy === undefined ? {} : { copyLink: activePdfLinkCopy })}
        onChoose={(choice, request) => props.workspace.onLinkActionChoose?.(choice, request)}
        onDismiss={(request, reason) => props.workspace.onLinkActionDismiss?.(request, reason)}
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
            `.pdf-workspace:not(.pdf-workspace--reference) [data-page-index="${props.workspace.linkActionRequest?.sourcePageIndex ?? 0}"]`,
          ) ?? shell.querySelector<HTMLElement>('.pdf-workspace:not(.pdf-workspace--reference) [data-page-index]');
        }}
      />
    </section>
  );
}
