import { WorkspaceModeAvailability, WorkspacePresentation } from '../review/WorkspaceModeStrip.js';
import {
  useCallback,
  useContext,
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

import type { ReviewShellAuthoringModel } from '../review/authoring-model.js';
export type { ReviewShellAuthoringModel } from '../review/authoring-model.js';

import { isVisibleFocusTarget } from '../review/focus-target.js';
import {
  referenceAnnotationScrollportSelector,
  referenceAnnotationTargetSelector,
  useAuthoringSession,
} from '../review/use-authoring-session.js';
import { useAnnotationReader } from '../review/use-annotation-reader.js';

import {
  mutableField,
  initialAuthoringValue,
  type AuthoringOrigin,
  type AuthoringReferenceRecovery,
} from "../review/authoring-session.js";
import { controlledWorkspaceSurfaceAction } from "../review/workspace-surface-policy.js";

import {
  addDelete,
  redoReview,
  removeReviewItem,
  undoReview,
  type ReviewRect,
} from '../../../../packages/core/src/review-commands.js';
import type { ReviewItem, ReviewState } from '../../../../packages/core/src/review-model.js';
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
  ViewerClientPlacement,
  ViewerPdfLinkInvocation,
} from '../pdf/viewer-interaction-events.js';
import type { PdfAnnotationSurface } from '../pdf/annotation-surface.js';
import type { PdfOutlineDiscovery, PdfOutlineItem } from '../pdf/pdf-outline.js';
import { AnnotationList } from '../review/AnnotationList.js';
import { FullAnnotationReader } from '../review/FullAnnotationReader.js';
import {
  projectOwnedAnnotationReader,
  type AnnotationReaderIdentity,
} from '../review/annotation-reader.js';
import { AnnotationPeek, AnnotationRecordPeek } from '../review/AnnotationPeek.js';
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
  reviewCommandForShortcut,
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
import { usePassageEditorPlacement, type PassageEditorPlacement } from '../review/use-passage-editor-placement.js';
import {
  INITIAL_REVIEW_SURFACE_STATE,
  reduceReviewSurface,
  type ReviewBaseSurface,
} from '../review/review-surface-state.js';
import type {
  ReferenceNavigationState,
  WorkspaceMode,
} from '../review/reference-navigation-state.js';
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
function ignoreReferenceInspectionDismiss(_token: number): void {}
function ignoreOpenAnnotationReference(_identity: AnnotationReaderIdentity): void {}

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


export interface ReviewShellViewerModel {
  viewerControls?: ViewerControls;
  viewerState?: ViewerControlsSnapshot;
  viewerFraming?: ViewerFramingControls;
  viewerNavigation?: PdfViewerNavigation;
  /** Reference navigation is used only for visibility and frozen-passage recovery. */
  referenceNavigation?: PdfViewerNavigation;
  viewerNavigationIntentToken?: number;
  /** Document generation awaiting its initial settled fit. */
  initialFitRequest?: number;
  onInitialFitComplete?(generation: number): void;
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

export interface ReviewShellReferenceInspection {
  readonly token: number;
  readonly identity: AnnotationReaderIdentity;
  readonly surface: Extract<PdfAnnotationSurface, { kind: 'reference' }>;
  readonly pageIndex: number;
  readonly placement?: ViewerClientPlacement;
  readonly referenceRecovery?: AuthoringReferenceRecovery;
  readonly selected?: boolean;
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
  /** A modal owned by the parent may be mounted outside this shell. */
  commandModalOpen?: boolean;
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
  onOpenAnnotationReference?(identity: AnnotationReaderIdentity): void;
  referenceInspection?: ReviewShellReferenceInspection | null;
  onReferenceInspectionDismiss?(token: number, restoreFocus?: boolean): void;
  onReferenceInspectionHoldChange?(token: number, held: boolean): void;
  children?: ReactNode;
}


interface PointerScrollGesture {
  readonly id: number;
  readonly scroll: ViewerPosition | null;
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

export function referenceInspectionFocusSelector(
  identity: AnnotationReaderIdentity,
  tabIdentity: string,
): string {
  const root = `[data-annotation-surface="reference"][data-reference-tab-identity="${cssAttributeValue(tabIdentity)}"]`;
  return identity.origin === 'owned'
    ? `${root} [data-owned-focus-id="${cssAttributeValue(identity.itemId)}"]`
    : `${root} [data-source-focus-id="${cssAttributeValue(identity.annotationKey)}"]`;
}

export function referenceInspectionShouldDismissForKey(
  key: string,
  isComposing: boolean,
): boolean {
  return key === 'Escape' && !isComposing;
}

export function referenceInspectionShouldDismissForClick(
  target: Pick<Element, 'closest'>,
): boolean {
  return target.closest('[data-annotation-surface="reference"]') !== null
    && target.closest([
      '[data-reference-annotation-inspection]',
      '[data-annotation-surface="reference"][data-owned-mark-hovered="true"]',
      '[data-owned-focus-id]',
      '[data-source-focus-id]',
      '[data-owned-mark]',
      '[data-source-reader-mark]',
      '[data-owned-native-geometry]',
    ].join(', ')) === null;
}

export function referenceInspectionAuthoringOrigin(
  inspection: ReviewShellReferenceInspection,
): Pick<AuthoringOrigin, 'surface' | 'referenceRecovery'> {
  return {
    surface: inspection.surface,
    ...(inspection.referenceRecovery === undefined
      ? {}
      : { referenceRecovery: inspection.referenceRecovery }),
  };
}

export function referenceAccessAvailable(input: {
  readonly referencesAvailable: boolean;
  readonly nestedLayerOpen: boolean;
  readonly authoringActive: boolean;
}): boolean {
  return input.referencesAvailable && (!input.nestedLayerOpen || input.authoringActive);
}

export function shouldShowRightWorkspaceRail(input: {
  readonly rightSurfaceOpen: boolean;
  readonly authoringActive: boolean;
  readonly referencesAvailable: boolean;
  readonly referenceDock: 'right' | 'bottom';
}): boolean {
  return !input.rightSurfaceOpen && (
    !input.authoringActive
    || (input.referencesAvailable && input.referenceDock === 'right')
  );
}

export function ReviewShell(props: ReviewShellProps) {
  const shellRef = useRef<HTMLElement>(null);
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
  const [localActiveItemId, setLocalActiveItemId] = useState<string>();
  const [activeExistingAnnotationKey, setActiveExistingAnnotationKey] = useState<string>();
  const activeItemId = props.activeItemId === undefined
    ? localActiveItemId
    : props.activeItemId ?? undefined;
  const [consumedSelectionGeneration, setConsumedSelectionGeneration] = useState<number>();
  const [listActivation, setListActivation] = useState<{ readonly id: string; readonly token: number }>();
  const [reconciliationDetailOpen, setReconciliationDetailOpen] = useState(false);
  const [reconciliationFocusRequest, setReconciliationFocusRequest] = useState(0);
  const availableModes = useContext(WorkspaceModeAvailability);
  const workspacePresentation = useContext(WorkspacePresentation);
  const annotationPeeksEnabled = availableModes === null || availableModes.includes('annotations');
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

  const {
    authoringSession,
    authoringSessionRef,
    authoringEditorRef,
    authoringSurfaceElement,
    setAuthoringSurfaceElement,
    currentAuthoringAuthority,
    currentAuthoringAuthorityRef,
    submit,
    beginAuthoring,
    dismissAuthoring,
    closeNested,
    protectAuthoringDraft,
    saveAuthoring,
    authoringInvalidReason,
    authoringPersistencePending,
  } = useAuthoringSession({
    state: props.state, authoring: props.authoring,
    documentGeneration: (props.workspace.navigationState ?? surface.navigation).documentGeneration,
    saveOptionsOpen: props.save.saveOptionsOpen, shellRef, setAnnouncement,
    setActiveItem: (id) => setActiveItem(id),
    consumeSelectionActions: (generation) => consumeSelectionActions(generation),
    snapshotAuthoringWorkspace: () => ({
      open: anyWorkspaceOpen, mode: effectiveWorkspaceMode,
      ...(activeItemId === undefined ? {} : { activeItemId }),
      annotationScrollTop: shellRef.current?.querySelector<HTMLElement>('[data-annotation-scroll-viewport]')?.scrollTop ?? 0,
    }),
    prepareAuthoring: () => {
      cancelAnnotationRestoration();
      cancelReaderResume();
    },
    clearInputDraft: () => inputControllerRef.current?.clearDraft(),
    openNested: () => dispatchSurface({ type: 'open-nested' }),
    closeNestedSurface: () => dispatchSurface({ type: 'close-nested' }),
    restoreReaderAfterAuthoring: (session, reason, state) => restoreReaderAfterAuthoring(session, reason, state),
  });
  const presentedActiveItemId = authoringSession === null
    ? activeItemId
    : authoringSession.workspace.activeItemId;
  const pageNoteTriggerRef = useRef<HTMLButtonElement>(null);
  const surfaceTriggersRef = useRef(new Map<ReviewBaseSurface, HTMLElement>());
  const rightWorkspaceRailRef = useRef<HTMLButtonElement>(null);
  const bottomWorkspaceRailRef = useRef<HTMLButtonElement>(null);
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
  const referenceTabs = props.workspace.referenceTabs ?? navigation.tabs.map((tab) => ({
    identity: tab.identity,
    label: tab.label ?? `Page ${tab.originalTarget.pageIndex + 1}`,
    pageContext: tab.pageContext ?? `Page ${tab.originalTarget.pageIndex + 1}`,
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
  const generatedStatusBusy = props.generationRefreshStatus !== 'failed'
    && (props.generationRefreshStatus === 'reconciling' || props.locationRestoreStatus === 'restoring');
  const generatedStatusMessages = props.state.workflow.mode !== 'generated-output' ? [] : [
    props.generationRefreshStatus === 'reconciling'
      ? 'A rebuilt PDF is loading and Review Items are reconciling.'
      : props.generationRefreshStatus === 'failed'
        ? 'The rebuilt PDF could not be loaded safely. The last successful PDF remains reviewable.'
        : props.state.workflow.freshness === 'possibly-stale'
          ? 'Source changed; waiting for an updated PDF.'
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
  const openingWasFitToWidthRef = useRef(false);
  const dispatchReferenceLayout = (action: ReferenceWorkspaceLayoutAction) => {
    const wasOpen = referenceLayout.regime === 'narrow'
      ? referenceLayout.narrowOpen : referenceLayout.rightWorkspaceOpen;
    if (!wasOpen) {
      const nextLayout = reduceReferenceWorkspaceLayout(referenceLayout, action);
      const willOpen = nextLayout.regime === 'narrow'
        ? nextLayout.narrowOpen : nextLayout.rightWorkspaceOpen;
      if (willOpen) {
        // Read the closed reading frame before the disclosure changes its width.
        openingWasFitToWidthRef.current = props.viewer.viewerNavigation?.isFitToWidth?.() ?? false;
      }
    }

    if (props.workspace.referenceLayoutState === undefined) dispatchLocalReferenceLayout(action);
    props.workspace.onReferenceLayoutAction?.(action);
  };
  const referenceSurfaceOpen = effectiveReferenceLayout.kind === 'narrow-unified'
    ? effectiveReferenceLayout.open
    : effectiveReferenceLayout.referenceDock === 'right'
      ? effectiveReferenceLayout.rightWorkspaceOpen
      : effectiveReferenceLayout.bottomReferencesOpen;
  const pageMenuSurface = props.authoring.pageMenu?.surface;
  const currentReferencePageMenu = pageMenuSurface?.kind === 'reference'
    && referenceSurfaceOpen
    && pageMenuSurface.documentGeneration === navigation.documentGeneration
    && pageMenuSurface.tabIdentity === navigation.activeTabIdentity;
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
  const {
    restoreReaderAfterAuthoring,
    annotationReaderSession,
    hideAnnotationReader,
    annotationReaderRecord,
    annotationReaderOwnedItemId,
    annotationReaderVisibility,
    annotationReaderSourceNavigation,
    referenceAnnotationReaderRecord,
    referenceAnnotationReaderSourceNavigation,
    cancelReaderResume,
    deferMarkReaderRequest,
    knownOwnedReaderOverflow,
    forgetOwnedReaderOverflow,
    cancelAnnotationRestoration,
    restoreAnnotationList,
    openOwnedAnnotationReader,
    openExistingAnnotationReader,
    closeAnnotationReader,
    settleOwnedReaderOverflow,
    settlePendingReaderResume,
  } = useAnnotationReader({
    state: props.state, items: props.state.items, existingAnnotations, documentGeneration: navigation.documentGeneration,
    currentAuthoringAuthority, currentAuthoringAuthorityRef, authoringSession, authoringSessionRef,
    shellRef, stageRef: workspaceFraming.stageRef, viewerNavigation: props.viewer.viewerNavigation,
    referenceNavigation: props.viewer.referenceNavigation,
    referenceInspection: props.referenceInspection ?? null,
    activeReferenceTabIdentity: navigation.activeTabIdentity,
    referenceSurfaceOpen,
    onReferenceInspectionDismiss: props.onReferenceInspectionDismiss
      ?? ignoreReferenceInspectionDismiss,
    onOpenAnnotationReference: props.onOpenAnnotationReference
      ?? ignoreOpenAnnotationReference,
    annotationsVisible, anyWorkspaceOpen, peekItemId, activeItemId,
    setPeekItemId, setActiveItem, setActiveExistingAnnotationKey,
    markUserIntent: workspaceFraming.markUserIntent,
    onNavigate: props.onNavigate, onNavigateExisting: props.onNavigateExisting,
  });
  const referenceInspectionOwnedItem = referenceAnnotationReaderRecord?.origin === 'owned'
    ? props.state.items.find(({ id }) => id === referenceAnnotationReaderRecord.identity.itemId)
    : undefined;

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
    if (opening) pendingOpeningFitRef.current = openingWasFitToWidthRef.current;
    if (toolsSurfaceOpen) openingWasFitToWidthRef.current = false;
    const navigation = props.viewer.viewerNavigation;
    if (!pendingOpeningFitRef.current || navigation === undefined) return;
    let current = true;
    // Only an already-fitted page follows the new width on opening.
    // Manual zooms, resizing, docking, and closing preserve the current scale.
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
  }, [availableModes, toolsSurfaceOpen, effectiveReferenceLayout.kind, referenceLayout.referenceDock,
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
    : (() => {
        const reviewId = authoringSession.source.kind === 'edit'
          ? authoringSession.source.item.id
          : `authoring-preview:${authoringSession.token}`;
        return authoringSession.origin.surface?.kind === 'reference'
          ? referenceAnnotationTargetSelector(
              authoringSession.origin.surface.tabIdentity,
              reviewId,
            )
          : `[data-annotation-surface="main"] [data-owned-mark][data-review-id="${cssAttributeValue(reviewId)}"]`;
      })();
  const authoringFallbackTarget = authoringSession === null
    ? null
    : authoringSession.source.kind === 'replace' || authoringSession.source.kind === 'highlight'
      ? props.selection.selectionPlacement ?? null
      : authoringSession.source.kind === 'insert'
        ? props.selection.caretPlacement ?? null
      : authoringSession.source.kind === 'pageNote'
          ? props.authoring.pageMenu?.placement ?? null
          : authoringSession.origin.surface?.kind === 'reference'
            && props.referenceInspection?.surface.tabIdentity
              === authoringSession.origin.surface.tabIdentity
            ? props.referenceInspection.placement ?? null
            : null;
  const authoringReferenceTabIdentity = authoringSession?.origin.surface?.kind === 'reference'
    ? authoringSession.origin.surface.tabIdentity
    : undefined;
  const authoringPlacement = usePassageEditorPlacement({
    active: authoringSession !== null,
    anchorKey: authoringSession === null ? null : String(authoringSession.token),
    stageRef: workspaceFraming.stageRef,
    surfaceRefs: overlaySurfaceRefs,
    editorElement: authoringSurfaceElement,
    ...(authoringTargetSelector === undefined ? {} : { targetSelector: authoringTargetSelector }),
    fallbackTarget: authoringFallbackTarget,
    layoutGeneration: overlayLayoutGeneration,
    ...(authoringReferenceTabIdentity === undefined ? {} : {
      placementScope: 'reference' as const,
      scrollportSelector: referenceAnnotationScrollportSelector(authoringReferenceTabIdentity),
    }),
  });
  const [referenceInspectionSurfaceElement, setReferenceInspectionSurfaceElement] =
    useState<HTMLElement | null>(null);
  const referenceInspectionTargetSelector = props.referenceInspection === null
    || props.referenceInspection === undefined
    ? undefined
    : props.referenceInspection.identity.origin === 'owned'
      ? referenceAnnotationTargetSelector(
          props.referenceInspection.surface.tabIdentity,
          props.referenceInspection.identity.itemId,
        )
      : `[data-annotation-surface="reference"][data-reference-tab-identity="${cssAttributeValue(
          props.referenceInspection.surface.tabIdentity,
        )}"] [data-source-focus-id="${cssAttributeValue(
          props.referenceInspection.identity.annotationKey,
        )}"]`;
  const referenceInspectionPlacement = usePassageEditorPlacement({
    active: props.referenceInspection !== null
      && props.referenceInspection !== undefined
      && referenceAnnotationReaderRecord !== null,
    anchorKey: props.referenceInspection === null || props.referenceInspection === undefined
      ? null
      : String(props.referenceInspection.token),
    stageRef: workspaceFraming.stageRef,
    surfaceRefs: overlaySurfaceRefs,
    editorElement: referenceInspectionSurfaceElement,
    ...(referenceInspectionTargetSelector === undefined
      ? {}
      : { targetSelector: referenceInspectionTargetSelector }),
    fallbackTarget: props.referenceInspection?.placement ?? null,
    layoutGeneration: overlayLayoutGeneration,
    placementScope: 'reference',
    ...(props.referenceInspection === null || props.referenceInspection === undefined
      ? {}
      : {
          scrollportSelector: referenceAnnotationScrollportSelector(
            props.referenceInspection.surface.tabIdentity,
          ),
        }),
  });
  const referenceInspectionReturnTargetRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const inspection = props.referenceInspection;
    if (inspection === null || inspection === undefined) {
      referenceInspectionReturnTargetRef.current = null;
      return;
    }
    referenceInspectionReturnTargetRef.current = shellRef.current?.querySelector<HTMLElement>(
      referenceInspectionFocusSelector(inspection.identity, inspection.surface.tabIdentity),
    ) ?? null;
  }, [props.referenceInspection?.token]);
  const dismissReferenceInspection = (restoreFocus: boolean) => {
    const inspection = props.referenceInspection;
    if (inspection === null || inspection === undefined) return;
    const original = referenceInspectionReturnTargetRef.current;
    props.onReferenceInspectionDismiss?.(inspection.token, restoreFocus);
    if (!restoreFocus) return;
    requestAnimationFrame(() => {
      const activeTab = shellRef.current?.querySelector<HTMLElement>(
        '[data-reference-tab][aria-selected="true"]',
      );
      const target = isVisibleFocusTarget(original) ? original : activeTab;
      target?.focus({ preventScroll: true });
    });
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
    cancelReaderResume();
    deferMarkReaderRequest(null);
    if (annotationReaderSession?.origin === 'peek') hideAnnotationReader();
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
    cancelReaderResume();
    hideAnnotationReader();
  }, [activeItemId, annotationReaderOwnedItemId, annotationReaderSession, authoringSession]);

  useEffect(() => {
    if (!annotationPeeksEnabled) {
      dismissAnnotationPeek();
      return;
    }
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
  }, [annotationPeeksEnabled, annotationsVisible, anyWorkspaceOpen, props.correspondingItemId, activeItemId]);

  useEffect(() => {
    const request = props.activationRequest;
    if (!request || authoringSessionRef.current !== null) return;
    dismissedPeekIdRef.current = undefined;
    cancelAnnotationRestoration();
    cancelReaderResume();
    hideAnnotationReader();
    setActiveItem(request.id);
    setListActivation(request);
    const item = props.state.items.find(({ id }) => id === request.id);
    const readerRecord = item === undefined ? null : projectOwnedAnnotationReader(item);
    const knownOverflow = knownOwnedReaderOverflow(request.id);
    deferMarkReaderRequest(!anyWorkspaceOpen || item === undefined || knownOverflow !== undefined
      ? null
      : { id: request.id, token: request.token });
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
    if (authoringSessionRef.current !== null && mode !== 'references') return;
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
  const consumeSelectionActions = (generation: number) => {
    setConsumedSelectionGeneration(generation);
    props.selection.onSelectionConsumed?.(generation);
  };
  const gestureAuthoringSurface = props.selection.selectionUpdate.surface ?? props.authoring.surface;
  const gestureAuthoringOrigin = {
    ...(gestureAuthoringSurface === undefined ? {} : { surface: gestureAuthoringSurface }),
    ...(gestureAuthoringSurface?.kind !== 'reference'
      || props.authoring.referenceRecovery === undefined
      ? {}
      : { referenceRecovery: props.authoring.referenceRecovery }),
  };
  const mainEditOrigin = {
    surface: {
      kind: 'main' as const,
      documentGeneration: navigation.documentGeneration,
    },
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
      }, 'typing', trigger, gestureAuthoringOrigin);
    } else {
      beginAuthoring({
        kind: 'insert',
        anchor: intent.anchor,
        initialValue: intent.initialText,
      }, 'typing', trigger, gestureAuthoringOrigin);
    }
  };

  const inputIntentRef = useRef(handleInputIntent);
  inputIntentRef.current = handleInputIntent;
  const inputControllerRef = useRef<ReturnType<typeof createProofreadInputController> | null>(null);
  if (inputControllerRef.current === null) {
    inputControllerRef.current = createProofreadInputController((intent) => inputIntentRef.current(intent));
  }
  const inputController = inputControllerRef.current;
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
      props.referenceInspection !== null
      && props.referenceInspection !== undefined
      && event.target instanceof Element
      && event.target.closest('[data-reference-annotation-inspection]') !== null
      && referenceInspectionShouldDismissForKey(event.key, event.nativeEvent.isComposing)
    ) {
      event.preventDefault();
      event.stopPropagation();
      dismissReferenceInspection(true);
      return;
    }
    if (
      event.target instanceof Element
      && (
        (props.workspace.linkActionRequest && event.target.closest('[data-link-action-popover]') !== null)
        || event.target.closest('[data-row-actions-open="true"]') !== null
        || event.target.closest('[data-top-bar-menu], [data-document-actions-open="true"]') !== null
      )
    ) return;
    const editable = isEditableTarget(event.target);
    const shortcut = reviewCommandForShortcut({ ...event, isComposing: event.nativeEvent.isComposing });
    if (shortcut !== undefined && !event.defaultPrevented && !editable
      && surface.nestedLayer === 'none' && authoringSessionRef.current === null) {
      if (commandSurface.invoke(shortcut)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
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
      if (surface.nestedLayer !== 'none') {
        event.preventDefault();
        void closeNested();
        return;
      }
      if (peekItemId !== undefined || annotationReaderSession?.origin === 'peek') {
        event.preventDefault();
        dismissAnnotationPeek();
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
    beginAuthoring(
      { kind: 'highlight', anchor, selectionGeneration },
      'selection',
      trigger,
      gestureAuthoringOrigin,
    );
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
    }, 'selection', trigger, gestureAuthoringOrigin);
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

  const startPageNote = (anchor?: {
    pageIndex: number;
    position: ReviewRect;
    nearbyText?: string;
    surface?: PdfAnnotationSurface;
    referenceRecovery?: ReviewShellAuthoringModel['referenceRecovery'];
  } | null) => {
    if (authoringSessionRef.current !== null) return;
    if (!anchor) {
      setAnnouncement('Choose a safe page location to add a Page Note.');
      return;
    }
    const trigger = pageNoteTriggerRef.current
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const { surface: originSurface, referenceRecovery, ...source } = anchor;
    const pageNoteSurface = originSurface ?? props.authoring.surface;
    const pageNoteRecovery = pageNoteSurface?.kind === 'reference'
      ? referenceRecovery ?? props.authoring.referenceRecovery
      : undefined;
    beginAuthoring({ kind: 'pageNote', ...source }, 'page', trigger, {
      ...(pageNoteSurface === undefined ? {} : { surface: pageNoteSurface }),
      ...(pageNoteRecovery === undefined ? {} : { referenceRecovery: pageNoteRecovery }),
    });
  };

  useEffect(() => {
    const placed = props.authoring.placedPageNote;
    if (!placed || placed.token === lastPlacedPageNoteToken.current) return;
    lastPlacedPageNoteToken.current = placed.token;
    startPageNote(placed);
    props.authoring.onPlacedPageNoteConsumed?.(placed.token);
  }, [props.authoring.placedPageNote]);

  const deleteOwnedAnnotation = async (item: ReviewItem) => {
    const next = await submit((state) => removeReviewItem(state, item.id));
    forgetOwnedReaderOverflow(item.id);
    if (activeItemId === item.id) setActiveItem(next.items[0]?.id);
  };

  const canUndo = props.state.historyCursor > 0;
  const canRedo = props.state.historyCursor < props.state.history.length;
  const fitWidthCommand = useCallback(() => {
    workspaceFraming.markUserIntent(undefined, { captureSettledPosition: false });
    return props.viewer.viewerNavigation
      ?.fitToWidth(workspaceFraming.waitForSettledGeometry)
      .then(() => undefined) ?? Promise.resolve();
  }, [props.viewer.viewerNavigation, workspaceFraming.markUserIntent, workspaceFraming.waitForSettledGeometry]);
  useEffect(() => {
    const request = props.viewer.initialFitRequest;
    if (request === undefined) return;
    let current = true;
    void fitWidthCommand().then(() => {
      if (current) props.viewer.onInitialFitComplete?.(request);
    });
    return () => { current = false; };
  }, [props.viewer.initialFitRequest, props.viewer.onInitialFitComplete, fitWidthCommand]);
  useEffect(() => {
    // Demo selectors control the layout from outside the shell. Capture the
    // current fit before that layout changes, just as a workspace disclosure does.
    if (!workspacePresentation?.open || !props.viewer.viewerNavigation?.isFitToWidth?.()) return;
    const frame = requestAnimationFrame(() => { void fitWidthCommand(); });
    return () => cancelAnimationFrame(frame);
  }, [workspacePresentation?.mode, workspacePresentation?.open, workspacePresentation?.referenceDock, fitWidthCommand]);
  const beforeViewerAction = async () => {
    await props.viewer.viewerNavigation?.cancelPendingNavigation();
    commitMainFramingPosition();
  };
  const zoomCommand = async (direction: 'zoomIn' | 'zoomOut') => {
    await beforeViewerAction();
    props.viewer.viewerControls?.[direction]();
  };
  const commandSurface = createReviewCommandSurface({
    focusContext: props.commandModalOpen ? 'dialog' : commandFocusContext,
    canUndo: authoringSession === null && canUndo,
    canRedo: authoringSession === null && canRedo,
    canNavigateBack: !props.workspace.documentNavigationPending && (props.workspace.canNavigateBack ?? false),
    canNavigateForward: !props.workspace.documentNavigationPending && (props.workspace.canNavigateForward ?? false),
    canFind: surface.nestedLayer === 'none' && authoringSession === null,
    canOpenAnnotations: authoringSession === null && surface.nestedLayer === 'none',
    canOpenOutline: !outlineAbsent && authoringSession === null && surface.nestedLayer === 'none',
    canOpenReferences: referenceAccessAvailable({
      referencesAvailable,
      nestedLayerOpen: surface.nestedLayer !== 'none',
      authoringActive: authoringSession !== null,
    }),
    canToggleHorizontalScrollLock: authoringSession === null && surface.nestedLayer === 'none'
      && (overlayFrame.horizontalScrollAvailable || horizontalScrollLocked),
    horizontalScrollLocked,
    canOpenSaveOptions: props.save.onSaveOptions !== undefined,
    canFitWidth: authoringSession === null && surface.nestedLayer === 'none'
      && (props.viewer.viewerNavigation?.fitToWidthReady() ?? false),
    canZoom: props.viewer.viewerControls !== undefined && (props.viewer.viewerState?.zoomReady ?? false),
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
      'open-outline': () => {
        selectWorkspaceMode('outline');
        dispatchReferenceLayout({ type: 'show-right-workspace' });
        focusWorkspaceModeAfterLayout('outline');
      },
      'open-references': () => {
        selectWorkspaceMode('references');
        dispatchReferenceLayout({ type: 'show-references' });
        focusWorkspaceModeAfterLayout('references');
      },
      'toggle-horizontal-scroll-lock': () => setHorizontalScrollLocked((locked) => !locked),
      'save-options': () => props.save.onSaveOptions?.(),
      'fit-width': () => { void fitWidthCommand(); },
      'zoom-in': () => { void zoomCommand('zoomIn'); },
      'zoom-out': () => { void zoomCommand('zoomOut'); },
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
    cancelReaderResume();
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
  const workspaceFocusRequest = useRef(0);
  const focusWorkspaceModeAfterLayout = (mode: WorkspaceMode) => {
    const request = ++workspaceFocusRequest.current;
    const initialFocus = document.activeElement;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (request !== workspaceFocusRequest.current) return;
      const shell = shellRef.current;
      const active = document.activeElement;
      // Opening the tray must not overwrite a newer focus choice made while it lays out.
      if (active !== initialFocus && active instanceof HTMLElement
        && active !== document.body && isVisibleFocusTarget(active)) return;
      const rememberedToken = surface.navigation.workspace.modes[mode].logicalFocusToken;
      const remembered = rememberedToken === null ? null : [
        ...shell?.querySelectorAll<HTMLElement>('[data-workspace-focus-token]') ?? [],
      ].find((element) => element.dataset.workspaceFocusToken === rememberedToken);
      const target = mode === 'references'
        ? shell?.querySelector<HTMLElement>('[data-reference-tab][aria-selected="true"]')
          ?? shell?.querySelector<HTMLElement>('[data-reference-empty]')
        : remembered ?? shell?.querySelector<HTMLElement>(`#workspace-panel-${mode}`);
      if (target && isVisibleFocusTarget(target)) target.focus({ preventScroll: true });
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
  const [passageExposedToken, setPassageExposedToken] = useState<number | null>(null);
  const exposedPassagePlacement = useRef<PassageEditorPlacement | undefined>(undefined);
  useEffect(() => {
    if (authoringSession === null || authoringPlacement?.kind !== 'bottom-sheet') {
      setPassageExposedToken(null);
    }
  }, [authoringPlacement?.kind, authoringSession?.token]);
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
        visibility: authoringPlacement?.kind === 'bottom-sheet'
          ? 'outside' as const
          : authoringPlacement?.targetVisibility
            ?? props.authoring.authoringAnchorNavigation.visibility,
      }
      : undefined;
    const referenceContext = authoringSession.origin.referenceRecovery;
    const canExposeReferencePassage = referenceContext !== undefined
      && (authoringPlacement?.kind === 'bottom-sheet' || passageExposedToken === authoringSession.token)
      && anchorNavigation !== undefined;
    return <CommentComposer
      title={authoringSession.semantics.title}
      saveLabel={authoringSession.semantics.primaryLabel}
      optional={authoringSession.semantics.optional}
      allowWhitespace={authoringSession.semantics.allowWhitespace}
      saveDisabled={authoringInvalidReason !== null || authoringPersistencePending}
      persistencePending={authoringPersistencePending}
      {...(fieldLabel === undefined ? {} : { fieldLabel })}
      initialValue={initialValue}
      editorRef={authoringEditorRef}
      surfaceRef={setAuthoringSurfaceElement}
      {...((passageExposedToken === authoringSession.token ? exposedPassagePlacement.current : authoringPlacement) === undefined
        ? {}
        : { placement: (passageExposedToken === authoringSession.token ? exposedPassagePlacement.current : authoringPlacement)! })}
      anchorNavigation={anchorNavigation}
      {...(!canExposeReferencePassage ? {} : {
        passageExposure: {
          exposed: passageExposedToken === authoringSession.token,
          onExpose: () => {
            exposedPassagePlacement.current = authoringPlacement;
            setPassageExposedToken(authoringSession.token);
          },
          onResume: () => setPassageExposedToken(null),
        },
      })}
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
          && props.referenceInspection !== null
          && props.referenceInspection !== undefined
          && event.button === 0
          && event.target instanceof Element
          && referenceInspectionShouldDismissForClick(event.target)
        ) dismissReferenceInspection(false);
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
          beforeViewerAction,
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
            data-generation-busy={generatedStatusBusy}
            role={props.generationRefreshStatus === 'failed' ? 'alert' : 'status'}
          ><ReviewIcon name={generatedStatusBusy ? 'loading'
            : props.generationRefreshStatus === 'failed' || props.locationRestoreStatus === 'fallback' ? 'alert' : 'info'} />{
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
          {authoringSession === null
            && props.referenceInspection !== null
            && props.referenceInspection !== undefined
            && referenceAnnotationReaderRecord !== null ? (
              <AnnotationRecordPeek
                record={referenceAnnotationReaderRecord}
                {...(referenceInspectionOwnedItem === undefined
                  ? {}
                  : { item: referenceInspectionOwnedItem })}
                selected={props.referenceInspection.selected ?? true}
                className="annotation-peek--reference-inspection"
                surfaceRef={setReferenceInspectionSurfaceElement}
                {...(referenceInspectionPlacement === undefined
                  ? {}
                  : { style: referenceInspectionPlacement.style })}
                inspectionToken={props.referenceInspection.token}
                referenceTabIdentity={props.referenceInspection.surface.tabIdentity}
                {...(referenceInspectionPlacement === undefined
                  ? {}
                  : { placementKind: referenceInspectionPlacement.kind })}
                onHoldChange={(held) => props.onReferenceInspectionHoldChange?.(
                  props.referenceInspection!.token,
                  held,
                )}
                {...(props.onOpenAnnotationReference === undefined ? {} : {
                  onOpenReference: () => props.onOpenAnnotationReference?.(
                    props.referenceInspection!.identity,
                  ),
                })}
                {...(referenceAnnotationReaderSourceNavigation?.visibility !== 'outside'
                  ? {}
                  : {
                      showSourceReturn: true,
                      onNavigate: referenceAnnotationReaderSourceNavigation.onReturn,
                    })}
                {...(referenceAnnotationReaderRecord.origin !== 'owned'
                  || !referenceAnnotationReaderRecord.mutable
                  ? {}
                  : (() => {
                      const item = referenceInspectionOwnedItem;
                      if (item === undefined) return {};
                      const copyLink = copyLinkForItem(item);
                      return {
                        ...(copyLink === undefined ? {} : { copyLink }),
                        onEdit: (trigger: HTMLButtonElement) => {
                          if (annotationReaderSession !== null) {
                            closeAnnotationReader(annotationReaderSession, false);
                          }
                          beginAuthoring(
                            { kind: 'edit', item },
                            'reader-edit',
                            trigger,
                            referenceInspectionAuthoringOrigin(props.referenceInspection!),
                          );
                        },
                        onDelete: async () => {
                          await deleteOwnedAnnotation(item);
                          dismissReferenceInspection(false);
                        },
                      };
                    })())}
              />
            ) : null}
          {selectionActionsAvailable && props.selection.selectionPlacement ? (
            <ContextActionPalette
              placement={props.selection.selectionPlacement}
              hidden={!annotationPeeksEnabled || surface.nestedLayer !== 'none'}
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
              hidden={!annotationPeeksEnabled || surface.nestedLayer !== 'none'}
            />
          ) : null}
          {(surface.baseSurface === 'reading' || currentReferencePageMenu)
            && surface.nestedLayer === 'none'
            && props.authoring.pageMenu ? (
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
            && annotationPeeksEnabled && annotationReaderSession?.origin === 'peek'
            && annotationReaderRecord !== null ? (
              <aside className="annotation-peek annotation-peek--reader">
                <FullAnnotationReader
                  record={annotationReaderRecord}
                  {...(props.onOpenAnnotationReference === undefined ? {} : {
                    onOpenReference: () => props.onOpenAnnotationReference?.(
                      annotationReaderRecord.identity,
                    ),
                  })}
                  onBack={(restoreRowFocus) => {
                  props.onItemCorrespondenceChange?.(undefined);
                  closeAnnotationReader(annotationReaderSession, restoreRowFocus);
                }}
                  {...(annotationReaderSourceNavigation === undefined
                    ? {}
                    : { sourceNavigation: annotationReaderSourceNavigation })}
                  {...(annotationReaderOwnedItemId === undefined ? {} : {
                    onEdit: (trigger: HTMLButtonElement) => {
                      const item = props.state.items.find(({ id }) => id === annotationReaderOwnedItemId);
                      if (item !== undefined) beginAuthoring(
                        { kind: 'edit', item }, 'reader-edit', trigger, mainEditOrigin,
                      );
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
            && annotationPeeksEnabled && annotationReaderSession?.origin !== 'peek'
            && peekItemId ? (() => {
            const item = props.state.items.find(({ id }) => id === peekItemId);
            if (item === undefined) return null;
            const copyLink = copyLinkForItem(item);
            return (
              <AnnotationPeek
                item={item}
                {...(props.onOpenAnnotationReference === undefined ? {} : {
                  onOpenReference: () => props.onOpenAnnotationReference?.({
                    origin: 'owned', itemId: item.id,
                  }),
                })}
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
                onEdit={(trigger) => beginAuthoring(
                  { kind: 'edit', item }, 'tray-edit', trigger, mainEditOrigin,
                )}
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
          {effectiveReferenceLayout.kind === 'narrow-unified' ? (
            !referenceSurfaceOpen ? <WorkspaceEdgeRail
              buttonRef={bottomWorkspaceRailRef}
              surface="bottom"
              target={authoringSession === null ? 'workspace' : 'References'}
              open={referenceSurfaceOpen}
              controls="review-workspace"
              onToggle={() => {
                workspaceFraming.commitUserPosition();
                dismissPageNoteAuthority();
                const opening = !effectiveReferenceLayout.open;
                dispatchReferenceLayout({ type: 'toggle-narrow-workspace' });
                if (opening) {
                  const mode = authoringSessionRef.current === null
                    ? effectiveWorkspaceMode
                    : 'references';
                  selectWorkspaceMode(mode);
                  focusWorkspaceModeAfterLayout(mode);
                }
              }}
            /> : null
          ) : (
            <>
              {shouldShowRightWorkspaceRail({
                rightSurfaceOpen,
                authoringActive: authoringSession !== null,
                referencesAvailable,
                referenceDock: effectiveReferenceLayout.referenceDock,
              }) ? <WorkspaceEdgeRail
                buttonRef={rightWorkspaceRailRef}
                surface="right"
                target={authoringSession === null ? 'workspace' : 'References'}
                open={rightSurfaceOpen}
                controls={effectiveReferenceLayout.referenceDock === 'right' && referencesAvailable
                  ? 'review-workspace review-tools-workspace'
                  : 'review-tools-workspace'}
                onToggle={() => {
                  workspaceFraming.commitUserPosition();
                  dismissPageNoteAuthority();
                  const opening = !rightSurfaceOpen;
                  dispatchReferenceLayout(authoringSessionRef.current === null
                    ? { type: 'toggle-right-workspace' }
                    : { type: 'show-references' });
                  if (opening) {
                    const mode = authoringSessionRef.current === null
                      ? effectiveWorkspaceMode
                      : 'references';
                    selectWorkspaceMode(mode);
                    focusWorkspaceModeAfterLayout(mode);
                  }
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
          )}
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
              dispatchReferenceLayout({ type: 'move-references-right' });
              selectWorkspaceMode('references');
              focusWorkspaceModeAfterLayout('references');
            }}
            onMoveReferencesBottom={() => {
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
              props.workspace.onReferenceTabActivate?.(identity);
            }}
            onReferenceTabClose={(identity) => {
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
              props.workspace.onReferenceRetry?.();
            }}
            {...(props.workspace.onReferenceReturn === undefined
              ? {}
              : { onReferenceReturn: (identity: string) => {
                  props.workspace.onReferenceReturn?.(identity);
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
                {...(props.onOpenAnnotationReference === undefined ? {} : {
                  onOpenReference: () => props.onOpenAnnotationReference?.(
                    annotationReaderRecord.identity,
                  ),
                })}
                onBack={(restoreRowFocus) => {
                  props.onItemCorrespondenceChange?.(undefined);
                  closeAnnotationReader(annotationReaderSession, restoreRowFocus);
                }}
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
                    beginAuthoring(
                      { kind: 'edit', item }, 'reader-edit', trigger, mainEditOrigin,
                    );
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
              {...(props.onOpenAnnotationReference === undefined ? {} : {
                onOpenReference: (item: ReviewItem) => props.onOpenAnnotationReference?.({
                  origin: 'owned', itemId: item.id,
                }),
                onOpenExistingReference: (annotation: ExistingAnnotation) => {
                  if (existingAnnotations.status !== 'ready') return;
                  props.onOpenAnnotationReference?.({
                    origin: 'source',
                    annotationKey: existingAnnotationKey(annotation),
                    documentGeneration: navigation.documentGeneration,
                    discoveryGeneration: existingAnnotations.generation,
                  });
                },
              })}
              onNavigate={(item) => {
                if (authoringSessionRef.current !== null) return;
                cancelAnnotationRestoration();
                cancelReaderResume();
                markFramingUserIntent();
                setActiveItem(item.id);
                props.onNavigate?.(item);
              }}
              onNavigateExisting={(annotation) => {
                if (authoringSessionRef.current !== null) return;
                cancelAnnotationRestoration();
                cancelReaderResume();
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
                beginAuthoring({ kind: 'edit', item }, 'tray-edit', trigger, mainEditOrigin);
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
          {referenceSurfaceOpen
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
        openInReferencesDisabled={false}
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
