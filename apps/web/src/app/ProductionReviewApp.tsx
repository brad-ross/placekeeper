import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { PluginRegistry } from "@embedpdf/core";
import type { PdfDocumentObject, PdfEngine } from '@embedpdf/models';
import { SelectionPlugin } from "@embedpdf/plugin-selection";

import { initiallyPortableItemIds, saveStatusIsCleanCurrent } from "../save/portable-checkpoint.js";
import {
  referenceFocusRailSurface,
  referencePdfIsVisible,
  referenceReturnForActiveTab,
} from "../review/reference-presentation.js";
import {
  REVERSE_SYNCTEX_GENERIC_ERROR,
  forwardSyncTexRequestReady,
  forwardSyncTexCompletionIsCurrent,
  runHostForwardSyncTexRequest,
  ReverseSyncTexRequestCoordinator,
} from "../host/synctex-navigation.js";
import { firstUnresolvedReviewItemId, canonicalStateSupersedes } from "../review/canonical-state.js";
import {
  pendingDestinationDisposition,
  pendingDestinationIsCurrent,
  pendingDestinationAttemptIsCurrent,
  type PendingAuthoringCommand,
} from "../save/destination-attempt.js";
import {
  viewerAssetUrlsEqual,
  viewerResourcePoliciesEqual,
} from "../host/viewer-resource-equivalence.js";
import {
  visibleCodexContext,
  reviewStateRequestKey,
  updateProductionScope,
  updateCodexContext,
} from "../host/context-projection.js";
import type { ReviewItem, ReviewState } from "../../../../packages/core/src/review-model.js";
import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';
import type { SaveStatus } from "../../../../packages/core/src/save-status.js";
import {
  sanitizeReviewRuntimeDisplayString,
} from "../../../../packages/core/src/review-runtime-protocol.js";
import type { CaretAnchor } from "../pdf/selection-anchor.js";
import type { ExistingAnnotation, ExistingAnnotationsDiscovery } from "../pdf/existing-annotations.js";
import {
  acceptCopySelectionUpdate,
  acceptSelectionUpdate,
  applyPdfCopyCommand,
  INITIAL_SELECTION_UPDATE,
  nativeCopyHasPrecedence,
  resolvePdfCopyCommand,
  type CopySelectionUpdate,
  type PdfCopyOwner,
  type PdfCopySnapshots,
  type SelectionUpdate,
} from "../pdf/selection-state.js";
import { PDF_SELECTION_PAGE_LIMIT_MESSAGE } from '../pdf/selection-page-limit.js';
import {
  NativePdfSelectionBridge,
  nativeSelectionBelongsToPdfBridge,
} from '../pdf/NativePdfSelectionBridge.js';
import { isEditableTarget } from '../review/input-controller.js';
import type { LiveContextBindingStatus } from '../../../../packages/core/src/live-context.js';
import { App } from "./App.js";
import { ReferenceManualScrollObserver } from '../pdf/reference-manual-scroll.js';
import { ReviewShell } from "./ReviewShell.js";
import type {
  ProductionSession,
  ProductionScope,
  SaveCopyProposal,
  ProductionSessionApi,
  ReverseSyncTexRequest,
  HostForwardSyncTexRequest,
} from "../host/session-contracts.js";
import { projectReviewItems } from "../../../../packages/core/src/annotation-projection.js";
import {
  createViewerControls,
  unavailableViewerControls,
  type InitializedViewerControls,
  type ViewerControlsSnapshot,
} from "../pdf/viewer-controls.js";
import type { ViewerFramingControls } from "../pdf/viewer-framing.js";
import type { PdfViewerNavigation } from "../pdf/viewer-navigation-adapter.js";
import type {
  PdfTargetVisibility,
  PdfViewportQuery,
} from '../pdf/viewer-navigation.js';
import {
  pdfDocumentTitleForSource,
  resolvePdfMetadataTitle,
  type PdfMetadataPageTitle,
} from '../pdf/pdf-document-title.js';
import type { ReferenceDocumentController } from "../pdf/reference-document.js";
import type { PdfOutlineDiscovery } from "../pdf/pdf-outline.js";
import {
  createEnginePdfSearchPageReader,
  createPdfSearchController,
  type PdfSearchController,
} from '../pdf/pdf-search-controller.js';
import {
  initialPdfSearchState,
  type PdfSearchResult,
} from '../pdf/pdf-search-model.js';
import { pdfSearchResultTarget } from '../pdf/pdf-search-navigation.js';
import type {
  ViewerClientPlacement,
  ViewerInteractionEvent,
  ViewerPageMenuInvocation,
  ViewerPdfLinkInvocation,
} from "../pdf/viewer-interaction-events.js";
import { PageNotePlacementAuthority } from "../review/review-surface-state.js";
import {
  NavigationCoordinator,
  type ReferenceReturnPresentationState,
} from "../review/navigation-coordinator.js";
import {
  BrowserReviewLocationHistory,
  type ReviewLocationHistoryEnvironment,
  type ReviewLocationHistoryPort,
  type ReviewLocationHistorySnapshot,
} from '../review/review-location-history.js';
import { buildPlacekeeperCopyLink } from '../review/CopyLinkControl.js';
import {
  createReferenceNavigationState,
  reduceReferenceNavigation,
  type ReferenceNavigationAction,
} from "../review/reference-navigation-state.js";
import type { PendingReferencePanel } from "../review/ReferenceWorkspace.js";
import { PdfSearchWorkspace } from '../review/PdfSearchWorkspace.js';
import {
  createOutlineRowCopyLink,
  createPdfTargetCopyLink,
  createSearchResultRowCopyLink,
  type PdfTargetCopyLinkContext,
} from '../review/row-link-actions.js';
import {
  createTrailingTaskScheduler,
  waitForReviewNavigationReady,
} from "../review/main-location-refresh.js";
import {
  reviewItemNavigationTarget,
} from "../review/annotation-outline-context.js";
import {
  BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN,
  RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN,
  createReferenceWorkspaceLayout,
  deriveReferenceWorkspaceLayout,
  reduceReferenceWorkspaceLayout,
  type ReferenceWorkspaceLayoutAction,
  type RightWorkspaceMode,
} from "../review/reference-workspace-layout.js";
import { SaveDestinationDialog } from "../save/SaveDestinationDialog.js";
import {
  gateReviewCommand,
  pollSaveStatusUntilSettled,
} from "../save/save-state-controller.js";
import {
  authoringAuthorityFor,
  authoringAuthorityMatches,
  type AuthoringAnchorSnapshot,
} from '../review/authoring-session.js';
import type { ViewerAssetUrls, ViewerResourcePolicy } from '../pdf/embedpdf-viewer.js';
import type { GenerationRefreshStatus, LocationRestoreStatus } from '../generation-status.js';
import type {
  ReviewCommandInvocation,
  ReviewCommandSurfaceSnapshot,
} from '../review/review-command-surface.js';
import type { AccessibilityTransitionEffect } from './accessibility-transitions.js';
import { renderedPdfPageIsUsable } from './document-readiness.js';

interface AuthoringAnchorNavigationState {
  readonly token: number;
  readonly visibility: PdfTargetVisibility;
  readonly pending: boolean;
}

export interface ProductionReviewAppProps {
  readonly session: ProductionSession;
  readonly initialState: ReviewState;
  readonly initialSaveStatus?: SaveStatus;
  readonly scope: ProductionScope;
  readonly api: ProductionSessionApi;
  readonly viewerAssets?: ViewerAssetUrls;
  readonly resourcePolicy?: ViewerResourcePolicy;
  /** Host-owned semantic history. `null` explicitly disables address-bar history. */
  readonly locationHistory?: ReviewLocationHistoryPort | null;
  /** Host-issued capability-free canonical link base, independent of history. */
  readonly copyLinkBase?: string | null;
  readonly viewer?: ReactNode;
  readonly generationRefreshStatus?: GenerationRefreshStatus;
  readonly hostReattachRequestToken?: number;
  readonly hostExportRequestToken?: number;
  readonly onHostExportRequestHandled?: (token: number) => void;
  readonly hostForwardSyncTexRequest?: HostForwardSyncTexRequest;
  readonly hostReverseSyncTexRequestToken?: number;
  readonly onReverseSyncTex?: (input: ReverseSyncTexRequest) => Promise<unknown>;
  readonly initialPresentation?: { readonly pageIndex?: number; readonly zoom?: number };
  readonly onPresentationChange?: (presentation: { readonly pageIndex: number; readonly zoom: number }) => void;
  /** Host activation seam: emitted only after the main PDF generation is parsed. */
  readonly onDocumentReady?: (generation: number) => void;
  /** Host failure seam for the isolated PDF worker. */
  readonly onViewerError?: (error: Error) => void;
  /** Host-visible title seam, already resolved through metadata then filename fallback. */
  readonly onDocumentTitleChange?: (title: string, generation: number) => void;
  /** Safe semantic command projection for native menus and shortcuts. */
  readonly onCommandSurfaceChange?: (snapshot: ReviewCommandSurfaceSnapshot) => void;
  /** Native commands re-enter the same handlers used by web controls and shortcuts. */
  readonly commandInvocation?: ReviewCommandInvocation;
  readonly accessibilityTransition?: AccessibilityTransitionEffect;
}

const UNAVAILABLE_CODEX_CONTEXT: LiveContextBindingStatus = {
  status: 'unavailable',
  reason: 'unavailable',
};

const CODEX_SCOPE_POLL_MS = 1_500;
const CODEX_SCOPE_TIMEOUT_MS = 4_000;

export function ProductionReviewApp(props: ProductionReviewAppProps) {
  const [localState, setState] = useState(props.initialState);
  // A runtime successor arrives as one state/assets render. Prefer that canonical
  // generation immediately so the viewer URL and semantic authority never split.
  const state = canonicalStateSupersedes(localState, props.initialState)
    ? props.initialState
    : localState;
  // A restart successor begins as an ordinary browser view, then its next
  // task prompt promotes this same authenticated page to the Codex surface.
  const [scope, setScope] = useState(props.scope);
  useEffect(() => setScope(props.scope), [props.scope]);
  const exportOnly = scope.persistenceMode === 'export-only';
  const [metadataPageTitle, setMetadataPageTitle] = useState<PdfMetadataPageTitle | null>(null);
  const portableItemIdsRef = useRef(initiallyPortableItemIds(
    props.initialState,
    props.initialSaveStatus,
  ));
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(
    props.initialSaveStatus ?? {
      destination: { phase: "none", generation: 0 },
      sync: {
        phase: props.initialState.items.length === 0 ? "clean" : "not-saved",
        desiredRevision: props.initialState.revision,
        savedRevision: props.initialState.items.length === 0 ? props.initialState.revision : -1,
      },
    },
  );
  const [destinationDialog, setDestinationDialog] = useState<{
    readonly reason: "first-annotation" | "menu";
    readonly pending?: PendingAuthoringCommand;
  } | null>(null);
  const [copyProposal, setCopyProposal] = useState<SaveCopyProposal>();
  const [folderSelectionId, setFolderSelectionId] = useState<string>();
  const [destinationEstablishing, setDestinationEstablishing] = useState(false);
  const [destinationError, setDestinationError] = useState<string>();
  const destinationAttemptRef = useRef(0);
  const authoringResolutionTokenRef = useRef(0);
  const [authoringSessionResolution, setAuthoringSessionResolution] = useState<{
    readonly token: number;
    readonly outcome: 'accepted' | 'source-replaced';
  }>();
  const authoringAnchorRef = useRef<AuthoringAnchorSnapshot | null>(null);
  const authoringActiveRef = useRef(false);
  const authoringViewportRef = useRef<PdfViewportQuery | null>(null);
  const [authoringAnchorNavigation, setAuthoringAnchorNavigation] = useState<
    AuthoringAnchorNavigationState | null
  >(null);
  const [authoringPreview, setAuthoringPreview] = useState<readonly ReviewAnnotation[] | null>(null);
  const [selectionUpdate, setSelectionUpdate] = useState<SelectionUpdate>(INITIAL_SELECTION_UPDATE);
  const selectionUpdateRef = useRef(selectionUpdate);
  selectionUpdateRef.current = selectionUpdate;
  const [mainCopySelection, setMainCopySelection] = useState<CopySelectionUpdate | null>(null);
  const [referenceCopySelection, setReferenceCopySelection] = useState<CopySelectionUpdate | null>(null);
  const [pdfCopyOwner, setPdfCopyOwner] = useState<PdfCopyOwner>(null);
  const paletteCopyOwnerRef = useRef<PdfCopyOwner>(null);
  const [pdfCopyOwnerIndicatorVisible, setPdfCopyOwnerIndicatorVisible] = useState(false);
  const [pdfCopyAnnouncement, setPdfCopyAnnouncement] = useState('');
  const [pdfCopyError, setPdfCopyError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const [locationRestoreStatus, setLocationRestoreStatus] = useState<LocationRestoreStatus>('idle');
  const [codexContext, setCodexContext] = useState(scope.codexContext);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [selectionPlacement, setSelectionPlacement] = useState<ViewerClientPlacement | null>(null);
  const [caret, setCaret] = useState<CaretAnchor | null>(null);
  const [caretPlacement, setCaretPlacement] = useState<ViewerClientPlacement | null>(null);
  const [pageMenu, setPageMenu] = useState<ViewerPageMenuInvocation | null>(null);
  const [keyboardPageNoteActive, setKeyboardPageNoteActive] = useState(false);
  const [existingAnnotations, setExistingAnnotations] = useState<ExistingAnnotationsDiscovery>({
    status: 'loading', generation: 0,
  });
  const [inventoryRetryGeneration, setInventoryRetryGeneration] = useState(0);
  const [correspondingItemId, setCorrespondingItemId] = useState<string>();
  const [activeItemId, setActiveItemId] = useState<string>();
  const [activationRequest, setActivationRequest] = useState<{ id: string; token: number }>();
  const [placedPageNote, setPlacedPageNote] = useState<{
    readonly token: number;
    readonly pageIndex: number;
    readonly position: { x: number; y: number; width: number; height: number };
  } | null>(null);
  const placementAuthority = useRef(new PageNotePlacementAuthority());
  const placedToken = useRef(0);
  const viewerRegistry = useRef<PluginRegistry | null>(null);
  const searchControllerRef = useRef<PdfSearchController | null>(null);
  const searchDocumentRef = useRef<PdfDocumentObject | null>(null);
  const pendingSearchQueryRef = useRef('');
  const submittedSearchQueryRef = useRef('');
  const searchSubmitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRequestedRef = useRef(false);
  const [searchState, setSearchState] = useState(() => initialPdfSearchState());
  const [searchNavigationIntentToken, setSearchNavigationIntentToken] = useState(0);
  const commitMainFramingPositionRef = useRef<() => void>(() => undefined);
  const viewerControlsRef = useRef<InitializedViewerControls | undefined>(undefined);
  const viewerControlsGenerationRef = useRef<number | null>(null);
  const [viewerFraming, setViewerFraming] = useState<ViewerFramingControls>();
  const productionRootRef = useRef<HTMLElement | null>(null);
  const mainNavigationRef = useRef<PdfViewerNavigation | null>(null);
  const [mainNavigationReadyGeneration, setMainNavigationReadyGeneration] = useState<number | null>(null);
  const [mainDocumentReadyGeneration, setMainDocumentReadyGeneration] = useState<number | null>(null);
  const notifiedDocumentReadyGenerationRef = useRef<number | null>(null);
  const [mainNavigation, setMainNavigation] = useState<PdfViewerNavigation | null>(null);
  const latestForwardSyncTexTokenRef = useRef(0);
  const handledForwardSyncTexTokenRef = useRef(0);
  const handledReverseSyncTexTokenRef = useRef(0);
  const referenceNavigationRef = useRef<PdfViewerNavigation | null>(null);
  const referenceControllerRef = useRef<ReferenceDocumentController | null>(null);
  const referenceManualScrollObserverRef = useRef(new ReferenceManualScrollObserver());
  const [referenceReturnState, renderReferenceReturnState] = useState<
    ReferenceReturnPresentationState | null
  >(null);
  const referenceReturnStateRef = useRef(referenceReturnState);
  referenceReturnStateRef.current = referenceReturnState;
  const setReferenceReturnState = useCallback((next: ReferenceReturnPresentationState | null) => {
    referenceReturnStateRef.current = next;
    renderReferenceReturnState(next);
  }, []);
  const referenceNavigationWaiters = useRef<Array<{
    readonly documentGeneration: number;
    readonly resolve: (navigation: PdfViewerNavigation | null) => void;
    timeout: ReturnType<typeof setTimeout> | null;
  }>>([]);
  const documentGenerationRef = useRef(props.initialState.workflow.documentGeneration);
  const navigationStateRef = useRef(createReferenceNavigationState(documentGenerationRef.current));
  const [navigationState, setNavigationState] = useState(navigationStateRef.current);
  const [referenceLayoutState, dispatchReferenceLayout] = useReducer(
    reduceReferenceWorkspaceLayout,
    undefined,
    () => createReferenceWorkspaceLayout({ width: 1440, height: 900 }),
  );
  const referenceLayoutStateRef = useRef(referenceLayoutState);
  referenceLayoutStateRef.current = referenceLayoutState;
  const layoutGenerationRef = useRef(0);
  const [rightWorkspaceMode, setRightWorkspaceMode] = useState<RightWorkspaceMode>('outline');
  const [pendingReference, setPendingReference] = useState<PendingReferencePanel | null>(null);
  const [linkActionRequest, setLinkActionRequest] = useState<
    Extract<ViewerInteractionEvent, { readonly type: 'pdf-link' }>['value'] | null
  >(null);
  const [navigationAnnouncement, setNavigationAnnouncement] = useState('');
  const outlineDiscoveryRef = useRef<PdfOutlineDiscovery>({
    status: 'loading',
    documentGeneration: documentGenerationRef.current,
  });
  const [outlineDiscovery, setOutlineDiscovery] = useState<PdfOutlineDiscovery>(
    outlineDiscoveryRef.current,
  );
  const [currentOutlineItemId, setCurrentOutlineItemId] = useState<string | null>(null);
  const locationHistory = useMemo(() => {
    if (props.locationHistory !== undefined) return props.locationHistory ?? undefined;
    if (props.session.appLinkBase === undefined || typeof window === 'undefined') return undefined;
    const environment: ReviewLocationHistoryEnvironment = {
      location: window.location,
      history: window.history,
      addEventListener: (type, listener) => window.addEventListener(type, listener),
      removeEventListener: (type, listener) => window.removeEventListener(type, listener),
    };
    return new BrowserReviewLocationHistory(environment);
  }, [props.locationHistory, props.session.appLinkBase]);
  const locationHistoryRef = useRef(locationHistory);
  locationHistoryRef.current = locationHistory;
  const copyLinkBase = useMemo(() => {
    if (props.copyLinkBase !== undefined) return props.copyLinkBase ?? undefined;
    if (props.session.appLinkBase === undefined) return undefined;
    if (scope.launchSurface !== 'codex' || typeof window === 'undefined') {
      return props.session.appLinkBase;
    }
    return `${window.location.origin}${window.location.pathname}`;
  }, [props.copyLinkBase, props.session.appLinkBase, scope.launchSurface]);
  const [locationHistorySnapshot, setLocationHistorySnapshot] = useState<ReviewLocationHistorySnapshot>({
    canBack: false,
    canForward: false,
  });
  const [referenceViewportHost, setReferenceViewportHost] = useState<HTMLDivElement | null>(null);
  const markHoverRef = useRef<string | undefined>(undefined);
  const markFocusRef = useRef<string | undefined>(undefined);
  const rowCorrespondenceRef = useRef<string | undefined>(undefined);
  const activationTokenRef = useRef(0);
  useEffect(() => {
    if (props.hostReattachRequestToken === undefined || props.hostReattachRequestToken <= 0) return;
    const id = firstUnresolvedReviewItemId(stateRef.current.items);
    setCommandNotice(null);
    if (id === undefined) {
      setCommandNotice('No annotations need reattachment.');
      const timer = window.setTimeout(() => setCommandNotice(null), 6_000);
      return () => window.clearTimeout(timer);
    }
    setActiveItemId(id);
    setActivationRequest({ id, token: ++activationTokenRef.current });
  }, [props.hostReattachRequestToken]);
  const [viewerState, setViewerState] = useState<ViewerControlsSnapshot>(unavailableViewerControls);
  const reverseSyncTexCoordinatorRef = useRef(new ReverseSyncTexRequestCoordinator());
  const requestReverseSyncTex = useCallback((request: ReverseSyncTexRequest): Promise<unknown> => {
    const reverseSyncTex = props.onReverseSyncTex;
    if (reverseSyncTex === undefined) return Promise.resolve({ status: 'failed' });
    return reverseSyncTexCoordinatorRef.current.run(reverseSyncTex, request, setCommandError);
  }, [props.onReverseSyncTex]);
  const initialPresentationAppliedRef = useRef(false);
  latestForwardSyncTexTokenRef.current = Math.max(
    latestForwardSyncTexTokenRef.current,
    props.hostForwardSyncTexRequest?.token ?? 0,
  );
  useEffect(() => {
    const request = props.hostForwardSyncTexRequest;
    if (request === undefined || mainNavigation === null ||
      request.token <= handledForwardSyncTexTokenRef.current) return;
    if (request.documentGeneration < state.workflow.documentGeneration) {
      handledForwardSyncTexTokenRef.current = request.token;
      return;
    }
    if (!forwardSyncTexRequestReady({
      requestGeneration: request.documentGeneration,
      documentGeneration: state.workflow.documentGeneration,
      navigationReadyGeneration: mainNavigationReadyGeneration,
      documentReadyGeneration: mainDocumentReadyGeneration,
      locationRestoreStatus,
    })) return;
    handledForwardSyncTexTokenRef.current = request.token;
    void runHostForwardSyncTexRequest(
      mainNavigation,
      request,
      () => forwardSyncTexCompletionIsCurrent({
        requestToken: request.token,
        latestRequestToken: latestForwardSyncTexTokenRef.current,
        requestGeneration: request.documentGeneration,
        documentGeneration: stateRef.current.workflow.documentGeneration,
        navigationMatches: mainNavigationRef.current === mainNavigation,
      }),
      (applied) => setCommandError(
        applied ? null : 'Forward SyncTeX could not reveal this PDF location.',
      ),
    );
  }, [
    locationRestoreStatus,
    mainDocumentReadyGeneration,
    mainNavigation,
    mainNavigationReadyGeneration,
    props.hostForwardSyncTexRequest,
    state.workflow.documentGeneration,
  ]);
  useEffect(() => {
    const token = props.hostReverseSyncTexRequestToken;
    if (token === undefined || token <= 0 || mainNavigation === null ||
      token <= handledReverseSyncTexTokenRef.current || props.onReverseSyncTex === undefined) return;
    handledReverseSyncTexTokenRef.current = token;
    const location = mainNavigation.captureLocation();
    if (location === null) {
      setCommandError(REVERSE_SYNCTEX_GENERIC_ERROR);
      return;
    }
    void requestReverseSyncTex({ pageIndex: location.pageIndex, point: location.anchor });
  }, [mainNavigation, props.hostReverseSyncTexRequestToken, props.onReverseSyncTex, requestReverseSyncTex]);
  const providedViewerAssetsRef = useRef(props.viewerAssets);
  if (!viewerAssetUrlsEqual(providedViewerAssetsRef.current, props.viewerAssets)) {
    providedViewerAssetsRef.current = props.viewerAssets;
  }
  const resourcePolicyRef = useRef(props.resourcePolicy);
  if (!viewerResourcePoliciesEqual(resourcePolicyRef.current, props.resourcePolicy)) {
    resourcePolicyRef.current = props.resourcePolicy;
  }
  const viewerAssets = useMemo(() => providedViewerAssetsRef.current ?? ({
    pdfiumWasm: props.session.appLinkBase === undefined
      ? `/s/${props.session.sessionId}/assets/pdfium.wasm`
      : '/assets/pdfium.wasm',
    workerUrl: props.session.appLinkBase === undefined
      ? `/s/${props.session.sessionId}/assets/pdfium-worker.js`
      : '/assets/pdfium-worker.js',
    documentUrl: `/s/${props.session.sessionId}/document/${state.source.fileId}?generation=${state.workflow.documentGeneration}`,
    ...(props.session.credential === undefined
      ? {}
      : { requestHeaders: { authorization: `Bearer ${props.session.credential}` } }),
  }), [
    providedViewerAssetsRef.current,
    props.session.appLinkBase,
    props.session.credential,
    props.session.sessionId,
    state.source.fileId,
    state.workflow.documentGeneration,
  ]);
  useEffect(() => props.api.presence?.(), [props.api]);
  const ownedAnnotations = useMemo(
    () => projectReviewItems(
      state.items,
      state.workflow.documentGeneration,
      { includePortableMetadata: false },
    ),
    [state.items, state.workflow.documentGeneration],
  );
  useEffect(() => {
    if (scope.launchSurface !== 'codex' && scope.reconnectPending !== true) return;
    let stopped = false;
    let timer: number | undefined;
    let timeout: number | undefined;
    let controller: AbortController | undefined;
    const refreshCodexContext = async () => {
      const requestedStateKey = reviewStateRequestKey(stateRef.current);
      controller = new AbortController();
      try {
        const next = await Promise.race([
          props.api.scope(controller.signal),
          new Promise<never>((_resolve, reject) => {
            timeout = window.setTimeout(() => {
              controller?.abort();
              reject(new Error("Codex scope refresh timed out"));
            }, CODEX_SCOPE_TIMEOUT_MS);
          }),
        ]);
        if (!stopped && requestedStateKey === reviewStateRequestKey(stateRef.current)) {
          setScope((current) => updateProductionScope(current, next));
          const nextContext = next.launchSurface === 'codex'
            ? next.codexContext ?? UNAVAILABLE_CODEX_CONTEXT
            : UNAVAILABLE_CODEX_CONTEXT;
          const safeContext = visibleCodexContext(nextContext, stateRef.current) ?? UNAVAILABLE_CODEX_CONTEXT;
          setCodexContext((current) => updateCodexContext(current, safeContext));
        }
      } catch {
        if (!stopped && requestedStateKey === reviewStateRequestKey(stateRef.current)) {
          setCodexContext((current) => updateCodexContext(current, UNAVAILABLE_CODEX_CONTEXT));
        }
      } finally {
        if (timeout !== undefined) window.clearTimeout(timeout);
        timeout = undefined;
        controller = undefined;
        if (!stopped) {
          timer = window.setTimeout(() => { void refreshCodexContext(); }, CODEX_SCOPE_POLL_MS);
        }
      }
    };
    timer = window.setTimeout(() => { void refreshCodexContext(); }, CODEX_SCOPE_POLL_MS);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (timeout !== undefined) window.clearTimeout(timeout);
      controller?.abort();
    };
  }, [props.api, scope.launchSurface, scope.reconnectPending]);
  useEffect(() => {
    if (codexContext?.status !== "current") return;
    const expectedDigest = codexContext.identity.stateDigest;
    const delay = Math.max(0, Date.parse(codexContext.leaseExpiresAt) - Date.now());
    const timer = window.setTimeout(() => {
      setCodexContext((current) => current?.status === "current" &&
        current.identity.stateDigest === expectedDigest
        ? {
            status: "refreshing",
            placekeeperSessionId: current.identity.placekeeperSessionId,
            documentGeneration: current.identity.documentGeneration,
            lastVerified: current.identity,
          }
        : current);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [codexContext]);
  const searchResults = useMemo(
    () => searchState.groups.flatMap((group) => group.results),
    [searchState.groups],
  );
  useEffect(() => {
    if (saveStatus.sync.phase !== "saving") return;
    const controller = new AbortController();
    void pollSaveStatusUntilSettled(
      props.api.saveStatus,
      setSaveStatus,
      controller.signal,
    );
    return () => controller.abort();
  }, [props.api, saveStatus.sync.phase, saveStatus.sync.desiredRevision, saveStatus.sync.savedRevision]);
  useEffect(() => {
    if (destinationDialog === null) return;
    let cancelled = false;
    setDestinationError(undefined);
    setFolderSelectionId(undefined);
    void props.api.saveProposal()
      .then((proposal) => {
        if (!cancelled) setCopyProposal((current) =>
          current?.sourceDisposition === 'remote-temporary' && current.folder !== undefined
            ? current
            : proposal);
      })
      .catch(() => {
        if (!cancelled) setDestinationError("Save options could not be prepared safely.");
      });
    return () => { cancelled = true; };
  }, [destinationDialog, props.api]);

  const publishAuthoringResolution = (outcome: 'accepted' | 'source-replaced') => {
    const disposition = pendingDestinationDisposition(outcome);
    if (!disposition.notifyAuthoringShell) return;
    setAuthoringSessionResolution({
      token: ++authoringResolutionTokenRef.current,
      outcome,
    });
  };
  const openCopyDialog = (
    reason: "first-annotation" | "menu",
    pending?: PendingAuthoringCommand,
  ) => {
    destinationAttemptRef.current += 1;
    setDestinationError(undefined);
    setCopyProposal(undefined);
    setDestinationDialog({ reason, ...(pending === undefined ? {} : { pending }) });
  };
  const retrySave = async () => {
    if (destinationEstablishing) return;
    setDestinationEstablishing(true);
    setDestinationError(undefined);
    try {
      setSaveStatus(await props.api.retrySave());
      setDestinationDialog(null);
    } catch {
      setDestinationError('Saving could not be retried safely.');
    } finally {
      setDestinationEstablishing(false);
    }
  };
  const dispatchNavigation = (action: ReferenceNavigationAction) => {
    const next = reduceReferenceNavigation(navigationStateRef.current, action);
    navigationStateRef.current = next;
    setNavigationState(next);
  };
  const dispatchLayout = useCallback((action: ReferenceWorkspaceLayoutAction) => {
    if (action.type !== 'set-stage-size' && action.type !== 'resize-right-references'
      && action.type !== 'resize-bottom-references' && action.type !== 'focus-surface') {
      layoutGenerationRef.current += 1;
    }
    dispatchReferenceLayout(action);
  }, []);
  const coordinatorRef = useRef<NavigationCoordinator | null>(null);
  if (coordinatorRef.current === null) {
    coordinatorRef.current = new NavigationCoordinator({
      getState: () => navigationStateRef.current,
      dispatch: dispatchNavigation,
      getMainNavigation: () => mainNavigationRef.current,
      getReferenceNavigation: () => referenceNavigationRef.current,
      waitForReferenceNavigation: () => {
        const current = referenceNavigationRef.current;
        if (current) return Promise.resolve(current);
        const generation = documentGenerationRef.current;
        return new Promise((resolve) => {
          const waiter: (typeof referenceNavigationWaiters.current)[number] = {
            documentGeneration: generation,
            resolve,
            timeout: null,
          };
          referenceNavigationWaiters.current.push(waiter);
          waiter.timeout = setTimeout(() => {
            const index = referenceNavigationWaiters.current.indexOf(waiter);
            if (index < 0) return;
            referenceNavigationWaiters.current.splice(index, 1);
            resolve(null);
          }, 1_600);
        });
      },
      getReferenceController: () => referenceControllerRef.current,
      commitMainFramingPosition: () => commitMainFramingPositionRef.current(),
      layout: {
        revealReferences: () => {
          const layout = referenceLayoutStateRef.current;
          if (layout.regime !== 'narrow' || !layout.narrowOpen) {
            dispatchLayout({ type: 'show-references' });
          }
          dispatchLayout({ type: 'focus-surface', surface: 'references' });
        },
        hideReferences: () => dispatchLayout({ type: 'hide-references' }),
        hideReferencesAfterSend: () => dispatchLayout({
          type: 'hide-references-after-send',
          activeMode: navigationStateRef.current.workspace.lastMode,
        }),
        settle: async () => {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const animations = [
            ...productionRootRef.current?.querySelectorAll<HTMLElement>(
              '[data-review-workspace], [data-tools-workspace]',
            ) ?? [],
          ].flatMap((surface) => surface.getAnimations())
            .filter((animation) => animation.playState === 'running');
          if (animations.length > 0) {
            await Promise.allSettled(animations.map((animation) => animation.finished));
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
        },
        focusReferenceRail: () => {
          const layoutGeneration = layoutGenerationRef.current;
          const documentGeneration = documentGenerationRef.current;
          requestAnimationFrame(() => {
            if (layoutGeneration !== layoutGenerationRef.current
              || documentGeneration !== documentGenerationRef.current) return;
            const layout = referenceLayoutStateRef.current;
            const surface = referenceFocusRailSurface(
              layout,
              navigationStateRef.current.tabs.length > 0,
            );
            productionRootRef.current
              ?.querySelector<HTMLButtonElement>(`[data-workspace-edge-rail="${surface}"]`)
              ?.focus({ preventScroll: true });
          });
          return true;
        },
        referenceRailFocusToken: () => referenceFocusRailSurface(
          referenceLayoutStateRef.current,
          navigationStateRef.current.tabs.length > 1,
        ) === 'bottom' ? BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN : RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN,
      },
      setPendingReference,
      getReferenceReturnState: () => referenceReturnStateRef.current,
      setReferenceReturnState,
      resetReferenceManualScrollIntent: () => referenceManualScrollObserverRef.current.clear(),
      setLinkActionRequest,
      setAnnouncement: setNavigationAnnouncement,
      focusReferenceTab: (identity) => {
        const layoutGeneration = layoutGenerationRef.current;
        const documentGeneration = documentGenerationRef.current;
        requestAnimationFrame(() => {
          if (layoutGeneration !== layoutGenerationRef.current
            || documentGeneration !== documentGenerationRef.current) return;
          const activeElement = productionRootRef.current?.ownerDocument.activeElement;
          if (activeElement instanceof HTMLElement && activeElement.dataset.workspaceMode) return;
          const target = [...(productionRootRef.current?.querySelectorAll<HTMLElement>(
            '[data-reference-tab]',
          ) ?? [])].find((element) => element.dataset.referenceTab === identity);
          target?.focus({ preventScroll: true });
        });
        return true;
      },
      getOutlineDiscovery: () => outlineDiscoveryRef.current,
      setCurrentOutlineItemId,
      getPageCount: () => searchDocumentRef.current?.pages.length ?? 0,
      // Native loading shells mount before their host history is available.
      // Keep the coordinator on the same history port the toolbar observes.
      get locationHistory() { return locationHistoryRef.current; },
      resolvePortableItem: (itemId: string) => {
        if (!portableItemIdsRef.current.has(itemId)) return null;
        const item = stateRef.current.items.find(({ id }) => id === itemId);
        return item === undefined ? null : reviewItemNavigationTarget(item);
      },
    });
  }
  const navigationCoordinator = coordinatorRef.current;
  const mainLocationRefresh = useMemo(
    () => createTrailingTaskScheduler(() => navigationCoordinator.refreshMainLocation()),
    [navigationCoordinator],
  );
  const readAuthoringAnchorVisibility = useCallback((): {
    readonly token: number;
    readonly visibility: PdfTargetVisibility;
  } | null => {
    const anchor = authoringAnchorRef.current;
    if (anchor === null) return null;
    const navigation = mainNavigationRef.current;
    const currentAuthority = authoringAuthorityFor(
      stateRef.current,
      documentGenerationRef.current,
    );
    const current = anchor.point !== null
      && authoringAuthorityMatches(anchor.authority, currentAuthority);
    return {
      token: anchor.token,
      visibility: !current || navigation === null || anchor.point === null
        ? 'unavailable'
        : navigation.pointVisibility(
          anchor.pageIndex,
          anchor.point,
        ),
    };
  }, []);
  const refreshAuthoringAnchorNavigation = useCallback(() => {
    const next = readAuthoringAnchorVisibility();
    setAuthoringAnchorNavigation((current) => {
      if (next === null) return null;
      const pending = current?.token === next.token ? current.pending : false;
      return current?.token === next.token
        && current.visibility === next.visibility
        && current.pending === pending
        ? current
        : { ...next, pending };
    });
  }, [readAuthoringAnchorVisibility]);
  const authoringAnchorRefresh = useMemo(
    () => createTrailingTaskScheduler(refreshAuthoringAnchorNavigation, 16),
    [refreshAuthoringAnchorNavigation],
  );
  const onAuthoringAnchorChange = useCallback((anchor: AuthoringAnchorSnapshot | null) => {
    authoringAnchorRef.current = anchor;
    refreshAuthoringAnchorNavigation();
  }, [refreshAuthoringAnchorNavigation]);
  const onAuthoringViewportChange = useCallback((viewport: PdfViewportQuery | null) => {
    authoringViewportRef.current = viewport;
    authoringAnchorRefresh.schedule();
  }, [authoringAnchorRefresh]);
  const returnToAuthoringAnchor = useCallback(async (token: number) => {
    const anchor = authoringAnchorRef.current;
    if (anchor === null || anchor.token !== token || anchor.point === null) {
      refreshAuthoringAnchorNavigation();
      return;
    }
    const currentAuthority = authoringAuthorityFor(
      stateRef.current,
      documentGenerationRef.current,
    );
    if (!authoringAuthorityMatches(anchor.authority, currentAuthority)) {
      refreshAuthoringAnchorNavigation();
      return;
    }
    setAuthoringAnchorNavigation((current) => current?.token === token
      ? { ...current, pending: true }
      : current);
    await navigationCoordinator.navigateMainAnnotation({
      pageIndex: anchor.pageIndex,
      point: anchor.point,
      viewport: authoringViewportRef.current ?? {},
    });
    if (authoringAnchorRef.current?.token !== token) return;
    const next = readAuthoringAnchorVisibility();
    setAuthoringAnchorNavigation(next === null ? null : { ...next, pending: false });
  }, [navigationCoordinator, readAuthoringAnchorVisibility, refreshAuthoringAnchorNavigation]);
  const cancelAuthoringAnchorReturn = useCallback((token: number) => {
    if (authoringAnchorRef.current?.token !== token) return;
    navigationCoordinator.cancelPendingNavigation();
    setAuthoringAnchorNavigation((current) => current?.token === token
      ? { ...current, pending: false }
      : current);
  }, [navigationCoordinator]);

  const onSelectionUpdate = useCallback((update: SelectionUpdate) => {
    setSelectionUpdate((current) => acceptSelectionUpdate(current, update));
  }, []);
  useEffect(() => {
    setReferenceCopySelection(null);
    setPdfCopyOwner((owner) => owner === 'reference' ? null : owner);
  }, [navigationState.activeTabIdentity]);
  const onCopySelectionUpdate = useCallback((update: CopySelectionUpdate) => {
    if (update.surface.documentGeneration !== documentGenerationRef.current) return;
    if (update.surface.kind === 'reference') {
      if (update.surface.tabIdentity !== navigationStateRef.current.activeTabIdentity) return;
      if (!referencePdfIsVisible(referenceLayoutStateRef.current, navigationStateRef.current)) return;
      setReferenceCopySelection((current) => acceptCopySelectionUpdate(current, update));
    } else {
      setMainCopySelection((current) => acceptCopySelectionUpdate(current, update));
      if (update.kind === 'cleared') setPdfCopyOwnerIndicatorVisible(false);
    }
    if (update.kind === 'pending' || update.kind === 'ready') setPdfCopyError(null);
  }, []);
  const publishCorrespondence = () => setCorrespondingItemId(
    rowCorrespondenceRef.current ?? markFocusRef.current ?? markHoverRef.current,
  );
  useEffect(() => () => {
    navigationCoordinator.dispose();
    mainLocationRefresh.cancel();
    authoringAnchorRefresh.cancel();
    viewerControlsRef.current?.dispose();
    placementAuthority.current.clear();
    if (searchSubmitTimerRef.current !== null) clearTimeout(searchSubmitTimerRef.current);
    searchControllerRef.current?.dispose();
  }, [authoringAnchorRefresh, mainLocationRefresh, navigationCoordinator]);
  useEffect(() => {
    refreshAuthoringAnchorNavigation();
  }, [
    mainNavigationReadyGeneration,
    refreshAuthoringAnchorNavigation,
    viewerState,
  ]);
  const sourceIdentity = `${state.source.fileId}:${state.source.digest}`;
  const sourceIdentityRef = useRef(sourceIdentity);
  const pendingPresentationLocationRef = useRef<ReturnType<PdfViewerNavigation['captureLocation']>>(null);
  if (sourceIdentity !== sourceIdentityRef.current && pendingPresentationLocationRef.current === null) {
    pendingPresentationLocationRef.current = mainNavigationRef.current?.captureLocation() ?? null;
  }
  const restoredLocationGenerationRef = useRef<number | null>(null);
  const restoringLocationGenerationRef = useRef<number | null>(null);
  const initialStateKeyRef = useRef(
    `${props.initialState.workflow.documentGeneration}:${props.initialState.revision}:${props.initialState.workflow.freshness}:${props.initialState.source.fileId}:${props.initialState.source.digest}`,
  );
  const resolvedPageTitle = pdfDocumentTitleForSource(
    metadataPageTitle,
    sourceIdentity,
    scope.documentTitle,
  );
  const pageTitle = scope.launchSurface === 'chrome'
    ? sanitizeReviewRuntimeDisplayString(resolvedPageTitle) ?? scope.documentTitle
    : resolvedPageTitle;
  useEffect(() => {
    document.title = pageTitle;
    props.onDocumentTitleChange?.(pageTitle, documentGenerationRef.current);
  }, [pageTitle, props.onDocumentTitleChange]);
  useEffect(() => {
    const next = `${props.initialState.workflow.documentGeneration}:${props.initialState.revision}:${props.initialState.workflow.freshness}:${props.initialState.source.fileId}:${props.initialState.source.digest}`;
    if (next === initialStateKeyRef.current) return;
    initialStateKeyRef.current = next;
    portableItemIdsRef.current = initiallyPortableItemIds(
      props.initialState,
      props.initialSaveStatus,
    );
    setState(props.initialState);
    if (props.initialSaveStatus !== undefined) setSaveStatus(props.initialSaveStatus);
  }, [props.initialState]);
  useEffect(() => {
    if (sourceIdentity === sourceIdentityRef.current) return;
    mainLocationRefresh.cancel();
    sourceIdentityRef.current = sourceIdentity;
    portableItemIdsRef.current = new Set();
    restoredLocationGenerationRef.current = null;
    restoringLocationGenerationRef.current = null;
    const nextGeneration = state.workflow.documentGeneration;
    if (nextGeneration <= documentGenerationRef.current) return;
    documentGenerationRef.current = nextGeneration;
    setLocationRestoreStatus('restoring');
    for (const waiter of referenceNavigationWaiters.current.splice(0)) {
      if (waiter.timeout !== null) clearTimeout(waiter.timeout);
      waiter.resolve(null);
    }
    outlineDiscoveryRef.current = { status: 'loading', documentGeneration: nextGeneration };
    setOutlineDiscovery(outlineDiscoveryRef.current);
    setExistingAnnotations({ status: 'loading', generation: 0 });
    setMainNavigationReadyGeneration(null);
    setMainDocumentReadyGeneration(null);
    viewerControlsGenerationRef.current = null;
    navigationCoordinator.replaceDocument(nextGeneration, { preservePresentation: true });
    searchControllerRef.current?.dispose();
    searchControllerRef.current = null;
    searchDocumentRef.current = null;
    if (searchSubmitTimerRef.current !== null) clearTimeout(searchSubmitTimerRef.current);
    searchSubmitTimerRef.current = null;
    pendingSearchQueryRef.current = '';
    submittedSearchQueryRef.current = '';
    searchRequestedRef.current = false;
    setSearchState(initialPdfSearchState());
    setSelectionUpdate((current) => ({ kind: 'cleared', generation: current.generation + 1 }));
    setMainCopySelection(null);
    setReferenceCopySelection(null);
    setPdfCopyOwner(null);
    setPdfCopyOwnerIndicatorVisible(false);
    setPdfCopyError(null);
    setCaret(null);
    setSelectionPlacement(null);
    setCaretPlacement(null);
    setActiveItemId(undefined);
    setCorrespondingItemId(undefined);
  }, [mainLocationRefresh, navigationCoordinator, sourceIdentity, state.workflow.documentGeneration]);
  useEffect(() => {
    const pending = destinationDialog?.pending;
    if (
      pending === undefined
      || pendingDestinationIsCurrent(pending, state, documentGenerationRef.current)
    ) return;
    destinationAttemptRef.current += 1;
    setDestinationEstablishing(false);
    const disposition = pendingDestinationDisposition('source-replaced');
    if (disposition.notifyAuthoringShell) publishAuthoringResolution('source-replaced');
    if (disposition.closeDialog) setDestinationDialog(null);
    setDestinationError(undefined);
  }, [destinationDialog, sourceIdentity]);
  useEffect(() => {
    if (locationHistory === undefined) return;
    return locationHistory.subscribe(setLocationHistorySnapshot);
  }, [locationHistory]);
  useEffect(() => {
    if (referenceReturnStateRef.current?.available !== true) return;
    const frame = requestAnimationFrame(() => {
      void navigationCoordinator.refreshReferenceReturnAvailability();
    });
    return () => cancelAnimationFrame(frame);
  }, [navigationCoordinator, referenceLayoutState]);
  useEffect(() => {
    if (
      mainNavigationReadyGeneration !== documentGenerationRef.current
      || mainDocumentReadyGeneration !== documentGenerationRef.current
      || restoredLocationGenerationRef.current === documentGenerationRef.current
      || restoringLocationGenerationRef.current === documentGenerationRef.current
    ) return;
    const generation = documentGenerationRef.current;
    restoringLocationGenerationRef.current = generation;
    let cancelled = false;
    const restoreWhenSettled = async () => {
      const ready = await waitForReviewNavigationReady({
        isCurrent: () => !cancelled && generation === documentGenerationRef.current,
        isReady: () => (
          viewerControlsGenerationRef.current === generation
          && (mainNavigationRef.current?.fitToWidthReady() ?? false)
        ),
      });
      if (!ready) {
        if (restoringLocationGenerationRef.current === generation) {
          restoringLocationGenerationRef.current = null;
        }
        if (!cancelled && generation === documentGenerationRef.current) {
          setLocationRestoreStatus('fallback');
        }
        return;
      }
      navigationCoordinator.startLocationHistory();
      const presentation = pendingPresentationLocationRef.current;
      const restored = locationHistory === undefined
        ? presentation === null
          ? true
          : await navigationCoordinator.restorePresentationLocation(presentation, generation)
        : await navigationCoordinator.restoreCurrentLocation();
      if (restored && !cancelled && generation === documentGenerationRef.current
        && viewerControlsRef.current?.usesAutomaticFitWidth()) {
        // The plugin preset sees the full viewport; the shared fit clears the
        // workspace rail and fade while retaining restored numeric zoom.
        await mainNavigationRef.current?.fitToWidth();
      }
      if (!cancelled && generation === documentGenerationRef.current) {
        if (restored) viewerControlsRef.current?.freezeCurrentZoom();
        restoredLocationGenerationRef.current = generation;
        pendingPresentationLocationRef.current = null;
        setLocationRestoreStatus(restored ? 'idle' : 'fallback');
      }
      if (restoringLocationGenerationRef.current === generation) {
        restoringLocationGenerationRef.current = null;
      }
    };
    void restoreWhenSettled();
    return () => { cancelled = true; };
  }, [
    locationHistory,
    mainDocumentReadyGeneration,
    mainNavigationReadyGeneration,
    navigationCoordinator,
  ]);
  useEffect(() => {
    if (!saveStatusIsCleanCurrent(state, saveStatus)) {
      if (restoredLocationGenerationRef.current === documentGenerationRef.current) {
        navigationCoordinator.downgradeCurrentItemLocation();
      }
      return;
    }
    portableItemIdsRef.current = new Set(state.items.map((item) => item.id));
  }, [navigationCoordinator, saveStatus, state]);
  const onViewerInteraction = useCallback((event: ViewerInteractionEvent) => {
    if (event.type === 'reverse-synctex') {
      requestReverseSyncTex(event.value);
      return;
    }
    if (event.type === 'pdf-link') {
      navigationCoordinator.requestLink(event.value);
      return;
    }
    if (event.type === 'pdf-link-unavailable') {
      navigationCoordinator.unavailableLink(event.value);
      return;
    }
    if (event.type === 'scroll') {
      mainLocationRefresh.schedule();
      authoringAnchorRefresh.schedule();
      return;
    }
    if (event.type === "selection-placement") {
      setSelectionPlacement(event.value?.placement ?? null);
      return;
    }
    if (event.type === "caret") {
      setCaret(event.value.anchor);
      setCaretPlacement(event.value.placement);
      return;
    }
    if (event.type === "page-menu") {
      placementAuthority.current.clearKeyboardCursor();
      setKeyboardPageNoteActive(false);
      setPageMenu(event.value);
      if (event.value) placementAuthority.current.setContextPoint(event.value.invocationId, event.value.point);
      return;
    }
    if (event.type === "page-note-cursor") {
      if (event.value) placementAuthority.current.setKeyboardCursor(event.value);
      else placementAuthority.current.clearKeyboardCursor();
      return;
    }
    if (event.type === "page-note-commit") {
      const point = placementAuthority.current.consumeKeyboardCursor(event.value);
      if (!point) return;
      setKeyboardPageNoteActive(false);
      setPlacedPageNote({
        token: ++placedToken.current,
        pageIndex: point.pageIndex,
        position: { x: point.x, y: point.y, width: 18, height: 18 },
      });
      return;
    }
    if (event.type === 'owned-mark-clear') {
      if (authoringActiveRef.current) return;
      setActiveItemId(undefined);
      return;
    }
    if (event.type === 'owned-mark') {
      const { id, phase } = event.value;
      if (phase === 'enter') markHoverRef.current = id;
      if (phase === 'leave' && markHoverRef.current === id) markHoverRef.current = undefined;
      if (phase === 'focus') markFocusRef.current = id;
      if (phase === 'blur' && markFocusRef.current === id) markFocusRef.current = undefined;
      if (phase === 'activate') {
        if (authoringActiveRef.current) return;
        setActiveItemId(id);
        setActivationRequest({ id, token: ++activationTokenRef.current });
      }
      publishCorrespondence();
    }
  }, [authoringAnchorRefresh, mainLocationRefresh, navigationCoordinator, requestReverseSyncTex]);
  const onReferenceDocumentControls = useCallback((controls: ReferenceDocumentController | null) => {
    referenceControllerRef.current = controls;
    if (controls === null) navigationCoordinator.referenceNavigationUnavailable();
  }, [navigationCoordinator]);
  const onViewerNavigationInitialized = useCallback((
    scope: 'main' | 'reference',
    navigation: PdfViewerNavigation | null,
  ) => {
    if (scope === 'main') {
      mainNavigationRef.current = navigation;
      setMainNavigation(navigation);
      navigation?.replaceDocument(documentGenerationRef.current);
      setMainNavigationReadyGeneration(navigation === null ? null : documentGenerationRef.current);
      navigationCoordinator.refreshMainLocation();
      refreshAuthoringAnchorNavigation();
      return;
    }
    referenceNavigationRef.current = navigation;
    if (navigation === null) navigationCoordinator.referenceNavigationUnavailable();
    navigation?.replaceDocument(documentGenerationRef.current);
    if (navigation) {
      const generation = documentGenerationRef.current;
      const current = referenceNavigationWaiters.current.splice(0);
      for (const waiter of current) {
        if (waiter.timeout !== null) clearTimeout(waiter.timeout);
        waiter.resolve(waiter.documentGeneration === generation ? navigation : null);
      }
    }
  }, [navigationCoordinator, refreshAuthoringAnchorNavigation]);
  const onExistingAnnotationsDiscovery = useCallback((result: ExistingAnnotationsDiscovery) => {
    setExistingAnnotations(result);
  }, []);
  const onOutlineDiscovery = useCallback((discovery: PdfOutlineDiscovery) => {
    if (discovery.documentGeneration !== documentGenerationRef.current) return;
    outlineDiscoveryRef.current = discovery;
    setOutlineDiscovery(discovery);
    navigationCoordinator.refreshCurrentOutline();
  }, [navigationCoordinator]);
  const onViewerInitialized = useCallback(async (registry: PluginRegistry) => {
    viewerRegistry.current = registry;
    viewerControlsRef.current?.dispose();
    const controls = createViewerControls(registry, () => productionRootRef.current?.querySelector<HTMLElement>(
      '.pdf-workspace:not(.pdf-workspace--reference) [data-viewer-framing-viewport]',
    ) ?? null);
    viewerControlsRef.current = controls;
    viewerControlsGenerationRef.current = documentGenerationRef.current;
    setViewerState(controls.snapshot());
    if (!initialPresentationAppliedRef.current) {
      initialPresentationAppliedRef.current = true;
      if (props.initialPresentation?.pageIndex !== undefined) {
        controls.goToPage(props.initialPresentation.pageIndex + 1);
      }
      if (props.initialPresentation?.zoom !== undefined) {
        controls.zoomToPercent(props.initialPresentation.zoom * 100);
      }
    }
    controls.subscribe(() => {
      setViewerState(controls.snapshot());
      mainLocationRefresh.schedule();
    });
  }, [mainLocationRefresh, props.initialPresentation]);
  useEffect(() => {
    if (!viewerState.ready || props.onPresentationChange === undefined) return;
    props.onPresentationChange({
      pageIndex: viewerState.currentPage,
      zoom: viewerState.zoomPercent / 100,
    });
  }, [props.onPresentationChange, viewerState]);
  const onMainDocumentReady = useCallback((engine: PdfEngine, document: PdfDocumentObject) => {
    if (searchDocumentRef.current === document && searchControllerRef.current) return;
    const documentGeneration = documentGenerationRef.current;
    const documentSourceIdentity = sourceIdentity;
    setMainDocumentReadyGeneration(documentGeneration);
    searchControllerRef.current?.dispose();
    searchDocumentRef.current = document;
    void resolvePdfMetadataTitle(engine, document).then((title) => {
      if (
        documentGenerationRef.current === documentGeneration &&
        searchDocumentRef.current === document
      ) {
        setMetadataPageTitle(title === undefined
          ? null
          : { sourceIdentity: documentSourceIdentity, title });
      }
    });
    const search = createPdfSearchController({
      documentGeneration,
      reader: createEnginePdfSearchPageReader(engine, document),
    });
    searchControllerRef.current = search;
    setSearchState(search.getState());
    search.subscribe((next) => {
      const pendingQuery = pendingSearchQueryRef.current;
      if (pendingQuery === submittedSearchQueryRef.current) {
        setSearchState(next);
        return;
      }
      setSearchState({
        ...next,
        query: pendingQuery,
        status: pendingQuery.trim().length > 0 ? 'indexing' : 'idle',
        groups: [],
        selectedResultId: null,
        alternatives: [],
        message: '',
      });
    });
    const pendingQuery = pendingSearchQueryRef.current;
    if (pendingQuery.trim().length > 0) {
      submittedSearchQueryRef.current = pendingQuery;
      void search.search(pendingQuery);
    }
    else if (searchRequestedRef.current) void search.prepare();
  }, [sourceIdentity]);
  useEffect(() => {
    const generation = state.workflow.documentGeneration;
    if (props.onDocumentReady === undefined
      || notifiedDocumentReadyGenerationRef.current === generation
      || mainDocumentReadyGeneration !== generation) return;
    if (scope.launchSurface !== 'macos') {
      notifiedDocumentReadyGenerationRef.current = generation;
      props.onDocumentReady(generation);
      return;
    }
    if (mainNavigationReadyGeneration !== generation) return;
    const root = productionRootRef.current;
    const navigation = mainNavigationRef.current;
    if (root === null || navigation === null) return;
    let cancelled = false;
    let confirming = false;
    const frames = new Set<number>();
    const usableRenderedPage = () => {
      const viewport = root.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
      if (viewport === null) return false;
      const viewportRect = viewport.getBoundingClientRect();
      for (const image of viewport.querySelectorAll<HTMLImageElement>('[data-page-index] img')) {
        const style = getComputedStyle(image);
        if (renderedPdfPageIsUsable({
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          pageRect: image.getBoundingClientRect(),
          viewportRect,
          display: style.display,
          visibility: style.visibility,
        })) return true;
      }
      return false;
    };
    const scheduleFrame = (callback: () => void) => {
      const frame = requestAnimationFrame(() => {
        frames.delete(frame);
        callback();
      });
      frames.add(frame);
    };
    const probe = () => {
      if (cancelled || confirming || !usableRenderedPage() || navigation.captureLocation() === null) return;
      confirming = true;
      scheduleFrame(() => scheduleFrame(() => {
        confirming = false;
        if (cancelled || generation !== documentGenerationRef.current
          || mainNavigationRef.current !== navigation || !usableRenderedPage()
          || navigation.captureLocation() === null) return;
        notifiedDocumentReadyGenerationRef.current = generation;
        props.onDocumentReady?.(generation);
      }));
    };
    const observer = new MutationObserver(probe);
    observer.observe(root, { subtree: true, childList: true, attributes: true });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(probe);
    resize?.observe(root);
    root.addEventListener('load', probe, true);
    queueMicrotask(probe);
    return () => {
      cancelled = true;
      observer.disconnect();
      resize?.disconnect();
      root.removeEventListener('load', probe, true);
      for (const frame of frames) cancelAnimationFrame(frame);
    };
  }, [
    mainDocumentReadyGeneration,
    mainNavigationReadyGeneration,
    props.onDocumentReady,
    scope.launchSurface,
    state.workflow.documentGeneration,
  ]);
  const onViewerFramingInitialized = useCallback((controls: ViewerFramingControls) => {
    setViewerFraming(controls);
  }, []);
  const viewer = props.viewer ?? (
    <App
      embeddedInReviewShell
      assets={viewerAssets}
      {...(resourcePolicyRef.current === undefined ? {} : { resourcePolicy: resourcePolicyRef.current })}
      documentTitle={scope.documentTitle}
      onSelectionUpdate={onSelectionUpdate}
      onCopySelectionUpdate={onCopySelectionUpdate}
      ownedAnnotations={ownedAnnotations}
      authoringPreview={authoringPreview}
      keyboardPageNoteActive={keyboardPageNoteActive}
      onViewerInteraction={onViewerInteraction}
      reverseSyncTexEnabled={props.onReverseSyncTex !== undefined}
      {...(activeItemId === undefined ? {} : { activeOwnedAnnotationId: activeItemId })}
      {...(correspondingItemId === undefined ? {} : { correspondingOwnedAnnotationId: correspondingItemId })}
      onExistingAnnotationsDiscovery={onExistingAnnotationsDiscovery}
      inventoryRetryGeneration={inventoryRetryGeneration}
      documentGeneration={state.workflow.documentGeneration}
      referenceViewportHost={referenceViewportHost}
      activeReferenceTabIdentity={navigationState.activeTabIdentity}
      onReferenceDocumentControls={onReferenceDocumentControls}
      onReferenceManualScroll={() => navigationCoordinator.observeReferenceManualScroll()}
      referenceManualScrollObserver={referenceManualScrollObserverRef.current}
      onViewerNavigationInitialized={onViewerNavigationInitialized}
      onOutlineDiscovery={onOutlineDiscovery}
      onViewerInitialized={onViewerInitialized}
      onMainDocumentReady={onMainDocumentReady}
      {...(props.onViewerError === undefined ? {} : { onViewerError: props.onViewerError })}
      onViewerFramingInitialized={onViewerFramingInitialized}
      searchResults={searchResults}
    />
  );

  const activateSearchResult = (result: PdfSearchResult) => {
    const target = pdfSearchResultTarget(result, navigationState.documentGeneration);
    if (target === null) return;
    searchControllerRef.current?.selectResult(result.id);
    void navigationCoordinator.navigateMainTarget(target, 'search');
  };
  const openSearchResultReference = (result: PdfSearchResult) => {
    const target = pdfSearchResultTarget(result, navigationState.documentGeneration);
    if (target === null) return;
    const selectedResult = searchResults.find(({ id }) => id === searchState.selectedResultId);
    const selectedTarget = selectedResult
      ? pdfSearchResultTarget(selectedResult, navigationState.documentGeneration)
      : null;
    setSearchNavigationIntentToken((token) => token + 1);
    setTimeout(() => {
      void navigationCoordinator.openReference(target, {
        label: result.matchedForm || `Search result on page ${result.pageIndex + 1}`,
        pageContext: `Page ${result.pageIndex + 1}`,
      }, selectedTarget);
    }, 0);
  };
  const submitSearchQuery = (query: string, immediate = false) => {
    pendingSearchQueryRef.current = query;
    const search = searchControllerRef.current;
    setSearchState((current) => ({
      ...current,
      query,
      status: query.trim().length > 0 ? 'indexing' : 'idle',
      groups: [],
      selectedResultId: null,
      alternatives: [],
      message: '',
    }));
    if (!search) return;
    if (searchSubmitTimerRef.current !== null) clearTimeout(searchSubmitTimerRef.current);
    const run = () => {
      searchSubmitTimerRef.current = null;
      submittedSearchQueryRef.current = query;
      void search.search(query);
    };
    if (immediate) run();
    else searchSubmitTimerRef.current = setTimeout(run, 180);
  };
  const writePlacekeeperLink = async (link: string) => {
    if (navigator.clipboard?.writeText === undefined) {
      throw new Error('Clipboard API unavailable');
    }
    await navigator.clipboard.writeText(link);
  };
  const pdfTargetCopyLinkContext: PdfTargetCopyLinkContext | undefined =
    props.session.appLinkBase === undefined ? undefined : {
      appLinkBase: props.session.appLinkBase,
      document: {
        documentGeneration: documentGenerationRef.current,
        pageCount: viewerState.totalPages,
      },
      currentDocumentGeneration: () => documentGenerationRef.current,
      writeText: writePlacekeeperLink,
    };
  const copyLinkForSearchResult = pdfTargetCopyLinkContext === undefined
    ? undefined
    : (result: PdfSearchResult) => createSearchResultRowCopyLink(result, pdfTargetCopyLinkContext);
  const copyLinkForOutlineItem = pdfTargetCopyLinkContext === undefined
    ? undefined
    : (item: Parameters<typeof createOutlineRowCopyLink>[0]) => (
      createOutlineRowCopyLink(item, pdfTargetCopyLinkContext)
    );
  const copyLinkForLinkAction = pdfTargetCopyLinkContext === undefined
    ? undefined
    : (request: ViewerPdfLinkInvocation) => {
      const copyLink = createPdfTargetCopyLink(request.target, pdfTargetCopyLinkContext);
      if (copyLink === undefined) return undefined;
      const page = request.target.pageIndex + 1;
      return {
        ...copyLink,
        ariaLabel: copyLink.precision === 'exact'
          ? `Copy link to exact destination on page ${page}`
          : `Copy link to target page ${page}`,
        title: copyLink.precision === 'exact'
          ? 'Copy exact destination link'
          : 'Copy target page link',
      };
    };
  const searchWorkspace = (
    <PdfSearchWorkspace
      state={searchState}
      onQueryChange={submitSearchQuery}
      onResultActivate={activateSearchResult}
      onResultOpenReference={openSearchResultReference}
      {...(copyLinkForSearchResult === undefined ? {} : { copyLinkForResult: copyLinkForSearchResult })}
      onAlternativeActivate={(alternative) => submitSearchQuery(alternative.query, true)}
    />
  );

  const effectiveReferenceLayout = deriveReferenceWorkspaceLayout(
    referenceLayoutState,
    rightWorkspaceMode,
    navigationState.workspace.lastMode,
  );
  const referencePdfVisible = referencePdfIsVisible(referenceLayoutState, navigationState);
  useEffect(() => {
    if (referencePdfVisible) return;
    setReferenceCopySelection(null);
    setPdfCopyOwner((owner) => owner === 'reference' ? null : owner);
  }, [referencePdfVisible]);
  const pdfCopySnapshots: PdfCopySnapshots = useMemo(() => ({
    main: mainCopySelection,
    reference: referenceCopySelection,
  }), [mainCopySelection, referenceCopySelection]);
  const copyMainSelectionFromPalette = useCallback(() => {
    paletteCopyOwnerRef.current = 'main';
    let copied = false;
    try {
      // Embedded browsers may deny the async Clipboard API while still allowing
      // the user-initiated copy event path used by the platform shortcut.
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    } finally {
      paletteCopyOwnerRef.current = null;
    }
    setPdfCopyOwner('main');
    if (!copied) {
      setPdfCopyAnnouncement('');
      setPdfCopyError('Placekeeper could not copy the selected text. Try Command-C instead.');
    }
  }, []);
  useEffect(() => {
    if (mainCopySelection !== null && mainCopySelection.kind !== 'cleared'
      && referenceCopySelection !== null && referenceCopySelection.kind !== 'cleared') {
      setPdfCopyOwnerIndicatorVisible(true);
    }
  }, [mainCopySelection, referenceCopySelection]);
  useEffect(() => {
    const handleCopy = (event: ClipboardEvent) => {
      const nativeSelection = window.getSelection();
      const activeOwner = paletteCopyOwnerRef.current ?? pdfCopyOwner;
      const command = resolvePdfCopyCommand({
        nativeCopyHasPrecedence: nativeCopyHasPrecedence({
          editableTarget: isEditableTarget(event.target),
          domSelectionCollapsed: nativeSelection?.isCollapsed ?? true,
          domSelectionText: nativeSelection?.toString() ?? '',
          domSelectionOwnedByPdf: nativeSelectionBelongsToPdfBridge(nativeSelection),
        }),
        owner: activeOwner,
        snapshots: pdfCopySnapshots,
      });
      applyPdfCopyCommand(command, event, {
        onPending: () => setPdfCopyAnnouncement(
          'Selected text is still being read. Retry Copy when it is ready.',
        ),
        onError: (kind) => {
          setPdfCopyError(kind === 'over-limit'
            ? PDF_SELECTION_PAGE_LIMIT_MESSAGE
            : 'Selected PDF text is unavailable. Reselect the text and try Copy again.');
        },
      });
      if (command.kind === 'copy') {
        setPdfCopyError(null);
        setPdfCopyAnnouncement(
          `Copied selected text from ${activeOwner === 'main' ? 'Main PDF' : 'Reference PDF'}.`,
        );
      }
    };
    window.addEventListener('copy', handleCopy);
    return () => window.removeEventListener('copy', handleCopy);
  }, [pdfCopyOwner, pdfCopySnapshots]);
  const activeReferenceReturn = referenceReturnForActiveTab(
    navigationState,
    referenceReturnState,
  );
  const anyTrayOpen = effectiveReferenceLayout.kind === 'narrow-unified'
    ? effectiveReferenceLayout.open
    : effectiveReferenceLayout.rightWorkspaceOpen || effectiveReferenceLayout.bottomReferencesOpen;
  const onCommitMainFramingPositionChange = useCallback((commit: (() => void) | null) => {
    commitMainFramingPositionRef.current = commit ?? (() => undefined);
  }, []);
  return (
    <main
      data-production-review
      data-launch-surface={scope.launchSurface ?? 'browser'}
      ref={productionRootRef}
      onPointerDownCapture={(event) => {
        const surface = event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-pdf-copy-surface]')?.dataset.pdfCopySurface
          : undefined;
        setPdfCopyOwner(surface === 'main' || surface === 'reference' ? surface : null);
      }}
      onFocusCapture={(event) => {
        const surface = event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-pdf-copy-surface]')?.dataset.pdfCopySurface
          : undefined;
        setPdfCopyOwner(surface === 'main' || surface === 'reference' ? surface : null);
      }}
    >
      <NativePdfSelectionBridge owner={pdfCopyOwner} snapshots={pdfCopySnapshots} />
      <ReviewShell
        state={state}
        documentTitle={scope.documentTitle}
        generationRefreshStatus={props.generationRefreshStatus ?? 'idle'}
        locationRestoreStatus={locationRestoreStatus}
        toolError={pdfCopyError ?? commandError}
        commandNotice={commandNotice}
        {...(props.onCommandSurfaceChange === undefined
          ? {}
          : { onCommandSurfaceChange: props.onCommandSurfaceChange })}
        {...(props.commandInvocation === undefined
          ? {}
          : { commandInvocation: props.commandInvocation })}
        {...(props.accessibilityTransition === undefined
          ? {}
          : { accessibilityTransition: props.accessibilityTransition })}
        {...(props.hostExportRequestToken === undefined ? {} : {
          documentActionsRequestToken: props.hostExportRequestToken,
        })}
        {...(props.onHostExportRequestHandled === undefined ? {} : {
          onDocumentActionsRequestHandled: props.onHostExportRequestHandled,
        })}
        {...(scope.launchSurface === 'codex'
          ? { codexContext: visibleCodexContext(codexContext, state) ?? UNAVAILABLE_CODEX_CONTEXT }
          : {})}
        {...(copyLinkBase === undefined || locationHistory === undefined ? {} : {
          ...(scope.launchSurface === 'chrome' ? {} : {
            copyLink: {
              disabled: navigationState.pendingMainNavigation !== null
                || navigationState.pendingSendToMain !== null,
              getLink: () => {
                mainLocationRefresh.flush();
                return buildPlacekeeperCopyLink(
                  copyLinkBase,
                  navigationCoordinator.currentLinkLocation(),
                );
              },
              writeText: writePlacekeeperLink,
            },
          }),
          copyItemLink: {
            getLink: (item: ReviewItem) => buildPlacekeeperCopyLink(
              copyLinkBase,
              {
                kind: 'item',
                page: item.pageIndex + 1,
                itemId: item.id,
              },
            ),
            disabled: (item: ReviewItem) => !portableItemIdsRef.current.has(item.id)
              || !saveStatusIsCleanCurrent(state, saveStatus),
            writeText: writePlacekeeperLink,
          },
        })}
        existingAnnotations={existingAnnotations}
        activeItemId={activeItemId ?? null}
        {...(correspondingItemId === undefined ? {} : { correspondingItemId })}
        {...(activationRequest === undefined ? {} : { activationRequest })}
        onRetryExistingAnnotations={() => setInventoryRetryGeneration((generation) => generation + 1)}
        onItemCorrespondenceChange={(id) => {
          rowCorrespondenceRef.current = id;
          publishCorrespondence();
        }}
        onActiveItemChange={setActiveItemId}
        onNavigate={(item) => {
          const target = reviewItemNavigationTarget(item);
          if (target === null) return;
          const portable = portableItemIdsRef.current.has(item.id)
            && saveStatusIsCleanCurrent(state, saveStatus);
          void navigationCoordinator.navigateMainAnnotation({
            ...target,
            ...(portable
              ? { portableItemId: item.id }
              : { linkFallbackNotice: 'The shareable link uses this page until the item is saved.' }),
          });
        }}
        onNavigateExisting={(annotation: ExistingAnnotation) => {
          void navigationCoordinator.navigateMainAnnotation({
            pageIndex: annotation.pageIndex,
            point: { x: annotation.rect.x, y: annotation.rect.y },
            linkFallbackNotice: 'External PDF annotations use page links.',
          });
        }}
        save={{
          savedLabel: exportOnly
            ? 'Export to keep your annotations'
            : state.workflow.mode === 'generated-output' ? 'Protected review state' : 'Saved',
          savePhase: exportOnly
            ? 'not-saved'
            : state.workflow.mode === 'generated-output' ? 'clean' : saveStatus.sync.phase,
          exportOnly,
          ...(!exportOnly && state.workflow.mode !== 'generated-output'
            && saveStatus.sync.phase === 'not-saved' && saveStatus.destination.phase === 'active'
            ? {
              saveRecovery: {
                pending: destinationEstablishing,
                ...(destinationError === undefined ? {} : { error: destinationError }),
                onRetry: retrySave,
                onSaveCopy: () => openCopyDialog('menu'),
              }
            }
            : {}),
          savePendingDestination: state.workflow.mode !== 'generated-output'
            && scope.sourceDisposition === 'remote-temporary'
            && saveStatus.destination.phase === 'none'
            && saveStatus.sync.phase === 'not-saved',
          saveOptionsOpen: state.workflow.mode === 'generated-output' || exportOnly
            ? false
            : destinationDialog !== null,
          ...(state.workflow.mode === 'generated-output' || exportOnly
            ? {}
            : { onSaveOptions: () => openCopyDialog("menu") }),
          onExportReviewedCopy: (confirmPossiblyStale) => {
            const method = props.api.exportReviewedCopy;
            if (method === undefined) return Promise.reject(new Error('Reviewed export is unavailable.'));
            return method(confirmPossiblyStale);
          },
        }}
        selection={{
          onSelectionPageLimitExceeded: () => setCommandError(PDF_SELECTION_PAGE_LIMIT_MESSAGE),
          onCopySelection: copyMainSelectionFromPalette,
          pdfCopyOwner,
          pdfCopySnapshots,
          pdfCopyOwnerIndicatorVisible,
          pdfCopyAnnouncement,
          selectionUpdate,
          selectionPlacement,
          caretAnchor: caret,
          caretPlacement,
          onSelectionConsumed: (generation) => {
            const currentSelection = selectionUpdateRef.current;
            if (currentSelection.kind !== "reliable" || currentSelection.generation !== generation) return;
            const registry = viewerRegistry.current;
            const documentId = registry?.getStore().getState().core.activeDocumentId;
            if (!documentId) return;
            registry.getPlugin<SelectionPlugin>(SelectionPlugin.id)?.provides()?.clear(documentId);
          },
        }}
        authoring={{
          pageMenu: pageMenu === null ? null : {
            invocationId: pageMenu.invocationId,
            placement: pageMenu.placement,
            pageIndex: pageMenu.point.pageIndex,
            position: { x: pageMenu.point.x, y: pageMenu.point.y, width: 18, height: 18 },
          },
          ...(props.onReverseSyncTex === undefined ? {} : {
            onGoToSource: (menu: {
              readonly pageIndex: number;
              readonly position: { readonly x: number; readonly y: number };
            }) => {
              requestReverseSyncTex({
                pageIndex: menu.pageIndex,
                point: { x: menu.position.x, y: menu.position.y },
              });
            },
          }),
          placedPageNote,
          keyboardPageNoteActive,
          onRequestKeyboardPageNote: () => {
            if (pageMenu) placementAuthority.current.dismissContext(pageMenu.invocationId);
            setPageMenu(null);
            placementAuthority.current.clearKeyboardCursor();
            setKeyboardPageNoteActive(true);
          },
          onCancelKeyboardPageNote: () => {
            placementAuthority.current.clearKeyboardCursor();
            setKeyboardPageNoteActive(false);
          },
          onPageMenuDismiss: (invocationId) => {
            placementAuthority.current.dismissContext(invocationId);
            setPageMenu((current) => current?.invocationId === invocationId ? null : current);
          },
          onPageMenuConsumed: (invocationId) => {
            const point = placementAuthority.current.consumeContextPoint(invocationId);
            if (!point) return;
            setPageMenu(null);
          },
          onPlacedPageNoteConsumed: (token) => {
            setPlacedPageNote((current) => current?.token === token ? null : current);
          },
          ...(authoringSessionResolution === undefined
            ? {}
            : { authoringSessionResolution }),
          onAuthoringAnchorChange,
          onAuthoringActiveChange: (active) => { authoringActiveRef.current = active; },
          onAuthoringPreviewChange: setAuthoringPreview,
          onAuthoringViewportChange,
          ...(authoringAnchorNavigation === null ? {} : {
            authoringAnchorNavigation: {
              ...authoringAnchorNavigation,
              onReturn: () => {
                void returnToAuthoringAnchor(authoringAnchorNavigation.token);
              },
              onCancelReturn: () => cancelAuthoringAnchorReturn(authoringAnchorNavigation.token),
            },
          }),
          onPageNoteComposerComplete: () => {
            placementAuthority.current.clear();
            setPageMenu(null);
            setKeyboardPageNoteActive(false);
          },
          onCommand: async (command, authority) => {
            const currentState = stateRef.current;
            const currentAuthority = authoringAuthorityFor(
              currentState,
              documentGenerationRef.current,
            );
            if (
              authority !== undefined
              && !authoringAuthorityMatches(authority, currentAuthority)
            ) {
              return {
                accepted: false,
                state: currentState,
                message: 'This draft belonged to the previous document and was not applied.',
                reason: 'stale-authoring',
              };
            }
            const gated = gateReviewCommand(
              currentState,
              saveStatus,
              command,
              exportOnly
                ? 'ephemeral'
                : scope.sourceDisposition === 'remote-temporary' ? 'remote-temporary' : 'local',
            );
            if (gated.kind === "choose-destination") {
              openCopyDialog("first-annotation", {
                command,
                authority: authority ?? currentAuthority,
              });
              return {
                accepted: false,
                state: currentState,
                message: "Choose where annotations should be saved.",
                reason: 'save-destination',
              };
            }
            const result = await props.api.command(command);
            if (
              authority !== undefined
              && !authoringAuthorityMatches(
                authority,
                authoringAuthorityFor(stateRef.current, documentGenerationRef.current),
              )
            ) {
              return {
                accepted: false,
                state: stateRef.current,
                message: 'This draft belonged to the previous document and was not applied.',
                reason: 'stale-authoring',
              };
            }
            const next = "accepted" in result ? result.state : result;
            setState(next);
            if (!("accepted" in result)) {
              const nextSaveStatus = await props.api.saveStatus();
              setSaveStatus(nextSaveStatus);
              if (gated.kind === 'submit-and-choose-destination') {
                openCopyDialog("first-annotation");
              }
            }
            setCommandError("accepted" in result ? result.message : null);
            return result;
          },
        }}
        viewer={{
          ...(viewerControlsRef.current === undefined ? {} : { viewerControls: viewerControlsRef.current }),
          ...(viewerFraming === undefined ? {} : { viewerFraming }),
          ...(mainNavigation === null ? {} : { viewerNavigation: mainNavigation }),
          viewerState,
          viewerNavigationIntentToken: searchNavigationIntentToken,
          onCommitMainFramingPositionChange,
        }}
        workspace={{
          workspaceOpen: anyTrayOpen,
          referenceLayoutState,
          rightWorkspaceMode,
          search: searchWorkspace,
          onReferenceLayoutAction: dispatchLayout,
          navigationState,
          referenceTabs: navigationState.tabs.map((tab) => ({
            identity: tab.identity,
            label: tab.label ?? `Page ${tab.originalTarget.pageIndex + 1}`,
            pageContext: tab.pageContext ?? `Page ${tab.originalTarget.pageIndex + 1}`,
            pageNumber: tab.originalTarget.pageIndex + 1,
          })),
          pendingReference,
          referenceReturn: activeReferenceReturn,
          outlineDiscovery,
          currentOutlineItemId,
          linkActionRequest,
          navigationAnnouncement,
          canNavigateBack: locationHistory === undefined
            ? navigationState.mainHistory.index > 0
            : locationHistorySnapshot.canBack,
          canNavigateForward: locationHistory === undefined
            ? navigationState.mainHistory.index >= 0
            && navigationState.mainHistory.index < navigationState.mainHistory.entries.length - 1
            : locationHistorySnapshot.canForward,
          documentNavigationPending: navigationState.pendingMainNavigation !== null,
          onLinkActionChoose: (choice, request) => {
            if (authoringActiveRef.current && choice === 'references') return;
            void navigationCoordinator.chooseLink(choice, request, {
              preserveWorkspace: authoringActiveRef.current,
            });
          },
          onLinkActionDismiss: (request) => navigationCoordinator.dismissLink(request),
          ...(copyLinkForLinkAction === undefined ? {} : { copyLinkForLinkAction }),
          onNavigateBack: () => {
            void navigationCoordinator.historyBack(
              authoringActiveRef.current ? authoringViewportRef.current ?? undefined : undefined,
            );
          },
          onNavigateForward: () => {
            void navigationCoordinator.historyForward(
              authoringActiveRef.current ? authoringViewportRef.current ?? undefined : undefined,
            );
          },
          onWorkspaceModeChange: (mode) => {
            if (mode === 'references') {
              void navigationCoordinator.openReferencesWorkspace();
              return;
            }
            if (mode === 'search') {
              searchRequestedRef.current = true;
              void searchControllerRef.current?.prepare();
            }
            setRightWorkspaceMode(mode);
            dispatchNavigation({ type: 'select-workspace-mode', mode });
            if (referenceLayoutState.regime !== 'narrow' || !referenceLayoutState.narrowOpen) {
              dispatchLayout({ type: 'show-right-workspace' });
            }
            dispatchLayout({ type: 'focus-surface', surface: 'right' });
          },
          onWorkspaceDismiss: () => {
            dispatchLayout({ type: 'hide-references' });
            dispatchNavigation({
              type: 'hide-workspace',
              focusReturnToken: referenceLayoutState.regime === 'narrow'
                || referenceLayoutState.referenceDock === 'bottom'
                ? BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN
                : RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN,
            });
          },
          onReferenceTabActivate: (identity) => {
            void navigationCoordinator.switchReference(identity);
          },
          onReferenceTabClose: (identity) => {
            void navigationCoordinator.closeReference(identity);
          },
          onReferenceSendToMain: (identity) => {
            void navigationCoordinator.sendToMain(identity);
          },
          onReferenceRetry: () => { void navigationCoordinator.retryReference(); },
          onReferenceReturn: (identity) => {
            void navigationCoordinator.returnToReference(identity);
          },
          onOutlineActivate: (item) => {
            if (item.target === null) navigationCoordinator.unavailableDestination();
            else void navigationCoordinator.navigateMainTarget(item.target, 'outline');
          },
          onOutlineReference: (item) => {
            if (item.target === null) return;
            void navigationCoordinator.openReference(item.target, {
              label: item.label,
              pageContext: item.pageContext ?? `Page ${item.target.pageIndex + 1}`,
            });
          },
          ...(copyLinkForOutlineItem === undefined ? {} : { copyLinkForOutlineItem }),
          onReferenceViewportHost: setReferenceViewportHost,
          onWorkspaceModeFocusTokenChange: (mode, token) => {
            const current = navigationStateRef.current.workspace.modes[mode];
            dispatchNavigation({
              type: 'remember-workspace-view',
              mode,
              logicalScrollToken: current.logicalScrollToken,
              logicalFocusToken: token,
            });
            dispatchLayout({
              type: 'focus-surface',
              surface: mode === 'references' ? 'references' : 'right',
            });
          },
        }}
      >
        {viewer}
      </ReviewShell>
      {exportOnly ? null : <SaveDestinationDialog
        open={destinationDialog !== null}
        sourceDisposition={scope.sourceDisposition === 'remote-temporary' ? 'remote-temporary' : 'local'}
        protectedRecovery={
          scope.sourceDisposition === 'remote-temporary'
          && saveStatus.destination.phase === 'none'
          && saveStatus.sync.phase === 'not-saved'
        }
        {...(copyProposal === undefined ? {} : { proposal: copyProposal })}
        establishing={destinationEstablishing}
        {...(saveStatus.rewriteEligibility === undefined
          ? {}
          : { rewriteEligibility: saveStatus.rewriteEligibility })}
        {...(destinationError === undefined ? {} : { error: destinationError })}
        {...(saveStatus.sync.phase === "not-saved" && saveStatus.destination.phase === "active"
          ? {
              recoveryTarget: saveStatus.destination.targetPath.split(/[\\/]/u).at(-1)!,
              ...(saveStatus.sync.failure === undefined
                ? {}
                : { recoveryFailure: saveStatus.sync.failure }),
            }
          : {})}
        onRetry={retrySave}
        onLocate={async () => {
          if (destinationEstablishing) return;
          setDestinationEstablishing(true);
          setDestinationError(undefined);
          try {
            setSaveStatus(await props.api.locateSave());
            setDestinationDialog(null);
          } catch {
            setDestinationError("The selected PDF did not match the saved file.");
          } finally {
            setDestinationEstablishing(false);
          }
        }}
        onChooseLocation={async () => {
          try {
            const selected = await props.api.chooseFolder();
            if (!selected.cancelled && selected.selectionId && selected.folder) {
              setFolderSelectionId(selected.selectionId);
              setCopyProposal((current) => scope.sourceDisposition === 'remote-temporary'
                ? { sourceDisposition: 'remote-temporary', folder: selected.folder! }
                : {
                    sourceDisposition: 'local',
                    filename: current?.sourceDisposition === 'local'
                      ? current.filename
                      : "annotated.pdf",
                    folder: selected.folder!,
                  });
            }
          } catch {
            setDestinationError("A new location could not be authorized.");
          }
        }}
        onCancel={() => {
          if (destinationEstablishing) return;
          destinationAttemptRef.current += 1;
          const disposition = pendingDestinationDisposition('cancelled');
          if (disposition.closeDialog) setDestinationDialog(null);
          setDestinationError(undefined);
        }}
        onConfirm={async (choice, filename) => {
          const dialog = destinationDialog;
          if (dialog === null || destinationEstablishing) return;
          if (
            dialog.pending !== undefined
            && !pendingDestinationIsCurrent(
              dialog.pending,
              stateRef.current,
              documentGenerationRef.current,
            )
          ) {
            const disposition = pendingDestinationDisposition('source-replaced');
            if (disposition.notifyAuthoringShell) publishAuthoringResolution('source-replaced');
            if (disposition.closeDialog) setDestinationDialog(null);
            setDestinationError(undefined);
            return;
          }
          const attempt = destinationAttemptRef.current;
          setDestinationEstablishing(true);
          setDestinationError(undefined);
          try {
            const established = choice === "copy"
              ? await props.api.chooseCopy(filename, folderSelectionId)
              : await props.api.chooseOriginal();
            if (!pendingDestinationAttemptIsCurrent(
              attempt,
              destinationAttemptRef.current,
              dialog.pending,
              stateRef.current,
              documentGenerationRef.current,
            )) {
              if (dialog.pending !== undefined && !pendingDestinationIsCurrent(
                dialog.pending,
                stateRef.current,
                documentGenerationRef.current,
              )) {
                const disposition = pendingDestinationDisposition('source-replaced');
                if (disposition.notifyAuthoringShell) publishAuthoringResolution('source-replaced');
                if (disposition.closeDialog) setDestinationDialog(null);
              }
              return;
            }
            setSaveStatus(established);
            if (dialog.pending !== undefined) {
              const result = await props.api.command(dialog.pending.command);
              if (!pendingDestinationAttemptIsCurrent(
                attempt,
                destinationAttemptRef.current,
                dialog.pending,
                stateRef.current,
                documentGenerationRef.current,
              )) {
                if (!pendingDestinationIsCurrent(
                  dialog.pending,
                  stateRef.current,
                  documentGenerationRef.current,
                )) {
                  const disposition = pendingDestinationDisposition('source-replaced');
                  if (disposition.notifyAuthoringShell) publishAuthoringResolution('source-replaced');
                  if (disposition.closeDialog) setDestinationDialog(null);
                }
                return;
              }
              const next = "accepted" in result ? result.state : result;
              setState(next);
              if ("accepted" in result) {
                const disposition = pendingDestinationDisposition('rejected');
                if (!disposition.preserveDraft) {
                  throw new Error('Rejected annotation unexpectedly discarded its draft.');
                }
                setCommandError(result.message);
                setDestinationError(undefined);
                if (disposition.closeDialog) setDestinationDialog(null);
                return;
              }
              setCommandError(null);
              const disposition = pendingDestinationDisposition('accepted');
              if (disposition.notifyAuthoringShell) publishAuthoringResolution('accepted');
              setSaveStatus(await props.api.saveStatus());
              if (destinationAttemptRef.current !== attempt) return;
            }
            if (pendingDestinationDisposition('accepted').closeDialog) {
              setDestinationDialog(null);
            }
          } catch (error) {
            setDestinationError(
              error instanceof Error
                ? error.message
                : "That destination could not be established safely.",
            );
          } finally {
            setDestinationEstablishing(false);
          }
        }}
      />}
    </main>
  );
}
