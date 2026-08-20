import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { PluginRegistry } from "@embedpdf/core";
import type { PdfDocumentObject, PdfEngine } from '@embedpdf/models';
import { SelectionPlugin } from "@embedpdf/plugin-selection";

import type { ReviewCommand, ReviewItem, ReviewState } from "../../../../packages/core/src/review-model.js";
import type { SaveStatus } from "../../../../packages/core/src/save-status.js";
import type { CaretAnchor } from "../pdf/selection-anchor.js";
import type { ExistingAnnotation, ExistingAnnotationsDiscovery } from "../pdf/existing-annotations.js";
import {
  acceptSelectionUpdate,
  INITIAL_SELECTION_UPDATE,
  type SelectionUpdate,
} from "../pdf/selection-state.js";
import type { LiveContextBindingStatus } from '../../../../packages/core/src/live-context.js';
import { App } from "./App.js";
import { ReferenceManualScrollObserver } from '../pdf/reference-manual-scroll.js';
import { ReviewShell, type RejectedReviewCommand } from "./ReviewShell.js";
import { projectReviewItems } from "../../../../packages/core/src/annotation-projection.js";
import {
  createViewerControls,
  unavailableViewerControls,
  type ViewerControls,
  type ViewerControlsSnapshot,
} from "../pdf/viewer-controls.js";
import type { ViewerFramingControls } from "../pdf/viewer-framing.js";
import type { PdfViewerNavigation } from "../pdf/viewer-navigation-adapter.js";
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
  type ReviewLocationHistorySnapshot,
} from '../review/review-location-history.js';
import { buildPlacekeeperCopyLink } from '../review/CopyLinkControl.js';
import {
  createReferenceNavigationState,
  reduceReferenceNavigation,
  type ReferenceNavigationAction,
  type ReferenceNavigationState,
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
  canDeriveAnnotationOutlineLabels,
  deriveAnnotationOutlineLabels,
  reviewItemPoint,
} from "../review/annotation-outline-context.js";
import {
  BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN,
  RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN,
  createReferenceWorkspaceLayout,
  deriveReferenceWorkspaceLayout,
  reduceReferenceWorkspaceLayout,
  type ReferenceWorkspaceLayoutAction,
  type ReferenceWorkspaceLayoutState,
  type RightWorkspaceMode,
} from "../review/reference-workspace-layout.js";
import { SaveDestinationDialog } from "../save/SaveDestinationDialog.js";
import {
  gateReviewCommand,
  pollSaveStatusUntilSettled,
} from "../save/save-state-controller.js";

export interface ProductionSession {
  readonly sessionId: string;
  readonly credential: string;
  /** Present for top-level readable views; embedded bootstrap sessions omit it. */
  readonly appLinkBase?: string;
}

export interface ProductionScope {
  readonly documentTitle: string;
  readonly sourceRootPath?: string;
  readonly launchSurface?: 'browser' | 'finder' | 'codex' | 'vscode';
  readonly codexContext?: LiveContextBindingStatus;
}

function referenceFocusRailSurface(
  layout: ReferenceWorkspaceLayoutState,
  hasRemainingReferences: boolean,
): 'bottom' | 'right' {
  if (layout.regime === 'narrow') return 'bottom';
  return hasRemainingReferences && layout.referenceDock === 'bottom' ? 'bottom' : 'right';
}

export type ProductionSaveStatus = SaveStatus;

export interface SaveCopyProposal {
  readonly filename: string;
  readonly folder: string;
}

export interface ProductionSessionApi {
  presence?(): () => void;
  command(command: ReviewCommand): Promise<ReviewState | RejectedReviewCommand>;
  saveStatus(): Promise<ProductionSaveStatus>;
  saveProposal(): Promise<SaveCopyProposal>;
  chooseCopy(filename?: string, folderSelectionId?: string): Promise<ProductionSaveStatus>;
  chooseFolder(): Promise<{ readonly cancelled: boolean; readonly selectionId?: string; readonly folder?: string }>;
  chooseOriginal(): Promise<ProductionSaveStatus>;
  retrySave(): Promise<ProductionSaveStatus>;
  locateSave(): Promise<ProductionSaveStatus>;
  scope(signal?: AbortSignal): Promise<ProductionScope>;
}

export interface ProductionReviewAppProps {
  readonly session: ProductionSession;
  readonly initialState: ReviewState;
  readonly initialSaveStatus?: ProductionSaveStatus;
  readonly scope: ProductionScope;
  readonly api: ProductionSessionApi;
  readonly viewer?: ReactNode;
}

export function referenceReturnForActiveTab(
  scope: Pick<ReferenceNavigationState, 'activeTabIdentity' | 'documentGeneration'>,
  presentation: ReferenceReturnPresentationState | null,
): ReferenceReturnPresentationState | null {
  return presentation !== null
    && presentation.available
    && presentation.tabIdentity === scope.activeTabIdentity
    && presentation.documentGeneration === scope.documentGeneration
    ? presentation
    : null;
}

export function initiallyPortableItemIds(
  state: ReviewState,
  saveStatus: ProductionSaveStatus | undefined,
): Set<string> {
  return saveStatusIsCleanCurrent(state, saveStatus)
    ? new Set(state.items.map(({ id }) => id))
    : new Set();
}

function saveStatusIsCleanCurrent(
  state: ReviewState,
  saveStatus: ProductionSaveStatus | undefined,
): boolean {
  return saveStatus?.sync.phase === 'clean'
    && saveStatus.sync.savedRevision === state.revision
    && saveStatus.sync.desiredRevision === state.revision;
}

const UNAVAILABLE_CODEX_CONTEXT: LiveContextBindingStatus = {
  status: 'unavailable',
  reason: 'unavailable',
};

const CODEX_SCOPE_POLL_MS = 1_500;
const CODEX_SCOPE_TIMEOUT_MS = 4_000;

function contextMatchesReviewState(
  status: Extract<LiveContextBindingStatus, { readonly status: "current" }>,
  state: ReviewState,
): boolean {
  return status.identity.placekeeperSessionId === state.sessionId &&
    status.identity.reviewRevision === state.revision &&
    status.identity.source.fileId === state.source.fileId &&
    status.identity.source.digest === state.source.digest;
}

export function visibleCodexContext(
  status: LiveContextBindingStatus | undefined,
  state: ReviewState,
): LiveContextBindingStatus | undefined {
  if (status?.status !== "current" || contextMatchesReviewState(status, state)) return status;
  return {
    status: "refreshing",
    placekeeperSessionId: state.sessionId,
    documentGeneration: status.identity.documentGeneration,
    lastVerified: status.identity,
  };
}

function reviewStateRequestKey(state: ReviewState): string {
  return JSON.stringify([
    state.sessionId,
    state.source.fileId,
    state.source.digest,
    state.revision,
    state.items,
  ]);
}

function updateCodexContext(
  current: LiveContextBindingStatus | undefined,
  next: LiveContextBindingStatus,
): LiveContextBindingStatus {
  return JSON.stringify(current) === JSON.stringify(next) ? current ?? next : next;
}

export function ProductionReviewApp(props: ProductionReviewAppProps) {
  const [state, setState] = useState(props.initialState);
  const portableItemIdsRef = useRef(initiallyPortableItemIds(
    props.initialState,
    props.initialSaveStatus,
  ));
  const [saveStatus, setSaveStatus] = useState<ProductionSaveStatus>(
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
    readonly pending?: ReviewCommand;
  } | null>(null);
  const [copyProposal, setCopyProposal] = useState<SaveCopyProposal>();
  const [folderSelectionId, setFolderSelectionId] = useState<string>();
  const [destinationEstablishing, setDestinationEstablishing] = useState(false);
  const [destinationError, setDestinationError] = useState<string>();
  const destinationAttemptRef = useRef(0);
  const [cancelPendingCommandToken, setCancelPendingCommandToken] = useState(0);
  const [selectionUpdate, setSelectionUpdate] = useState<SelectionUpdate>(INITIAL_SELECTION_UPDATE);
  const selectionUpdateRef = useRef(selectionUpdate);
  selectionUpdateRef.current = selectionUpdate;
  const [commandError, setCommandError] = useState<string | null>(null);
  const [codexContext, setCodexContext] = useState(props.scope.codexContext);
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
  const [existingAnnotationsSourceIdentity, setExistingAnnotationsSourceIdentity] = useState(
    `${props.initialState.source.fileId}:${props.initialState.source.digest}`,
  );
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
  const viewerControlsRef = useRef<ViewerControls | undefined>(undefined);
  const [viewerFraming, setViewerFraming] = useState<ViewerFramingControls>();
  const productionRootRef = useRef<HTMLElement | null>(null);
  const mainNavigationRef = useRef<PdfViewerNavigation | null>(null);
  const [mainNavigationReadyGeneration, setMainNavigationReadyGeneration] = useState<number | null>(null);
  const [mainDocumentReadyGeneration, setMainDocumentReadyGeneration] = useState<number | null>(null);
  const [mainNavigation, setMainNavigation] = useState<PdfViewerNavigation | null>(null);
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
  const documentGenerationRef = useRef(0);
  const navigationStateRef = useRef(createReferenceNavigationState(0));
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
    documentGeneration: 0,
  });
  const [outlineDiscovery, setOutlineDiscovery] = useState<PdfOutlineDiscovery>(
    outlineDiscoveryRef.current,
  );
  const [currentOutlineItemId, setCurrentOutlineItemId] = useState<string | null>(null);
  const locationHistory = useMemo(() => {
    if (props.session.appLinkBase === undefined || typeof window === 'undefined') return undefined;
    const environment: ReviewLocationHistoryEnvironment = {
      location: window.location,
      history: window.history,
      addEventListener: (type, listener) => window.addEventListener(type, listener),
      removeEventListener: (type, listener) => window.removeEventListener(type, listener),
    };
    return new BrowserReviewLocationHistory(environment);
  }, [props.session.appLinkBase]);
  const [locationHistorySnapshot, setLocationHistorySnapshot] = useState<ReviewLocationHistorySnapshot>({
    canBack: false,
    canForward: false,
  });
  const [referenceViewportHost, setReferenceViewportHost] = useState<HTMLDivElement | null>(null);
  const markHoverRef = useRef<string | undefined>(undefined);
  const markFocusRef = useRef<string | undefined>(undefined);
  const rowCorrespondenceRef = useRef<string | undefined>(undefined);
  const activationTokenRef = useRef(0);
  const [viewerState, setViewerState] = useState<ViewerControlsSnapshot>(unavailableViewerControls);
  const viewerAssets = useMemo(() => ({
    pdfiumWasm: props.session.appLinkBase === undefined
      ? `/s/${props.session.sessionId}/assets/pdfium.wasm`
      : '/assets/pdfium.wasm',
    documentUrl: `/s/${props.session.sessionId}/document/${state.source.fileId}`,
    requestHeaders: { authorization: `Bearer ${props.session.credential}` },
  }), [
    props.session.appLinkBase,
    props.session.credential,
    props.session.sessionId,
    state.source.fileId,
  ]);
  useEffect(() => props.api.presence?.(), [props.api]);
  const ownedAnnotations = useMemo(
    () => projectReviewItems(state.items),
    [state.items],
  );
  useEffect(() => {
    if (props.scope.launchSurface !== 'codex') return;
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
  }, [props.api, props.scope.launchSurface]);
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
        if (!cancelled) setCopyProposal(proposal);
      })
      .catch(() => {
        if (!cancelled) setDestinationError("Save options could not be prepared safely.");
      });
    return () => { cancelled = true; };
  }, [destinationDialog, props.api]);

  const openCopyDialog = (reason: "first-annotation" | "menu", pending?: ReviewCommand) => {
    destinationAttemptRef.current += 1;
    setDestinationError(undefined);
    setCopyProposal(undefined);
    setDestinationDialog({ reason, ...(pending === undefined ? {} : { pending }) });
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
      ...(locationHistory === undefined ? {} : {
        locationHistory,
        resolvePortableItem: (itemId: string) => {
          if (!portableItemIdsRef.current.has(itemId)) return null;
          const item = stateRef.current.items.find(({ id }) => id === itemId);
          return item === undefined
            ? null
            : { pageIndex: item.pageIndex, point: reviewItemPoint(item) };
        },
      }),
    });
  }
  const navigationCoordinator = coordinatorRef.current;
  const mainLocationRefresh = useMemo(
    () => createTrailingTaskScheduler(() => navigationCoordinator.refreshMainLocation()),
    [navigationCoordinator],
  );

  const onSelectionUpdate = useCallback((update: SelectionUpdate) => {
    setSelectionUpdate((current) => acceptSelectionUpdate(current, update));
  }, []);
  const publishCorrespondence = () => setCorrespondingItemId(
    rowCorrespondenceRef.current ?? markFocusRef.current ?? markHoverRef.current,
  );
  useEffect(() => () => {
    navigationCoordinator.dispose();
    mainLocationRefresh.cancel();
    viewerControlsRef.current?.dispose();
    placementAuthority.current.clear();
    if (searchSubmitTimerRef.current !== null) clearTimeout(searchSubmitTimerRef.current);
    searchControllerRef.current?.dispose();
  }, [mainLocationRefresh, navigationCoordinator]);
  const sourceIdentity = `${state.source.fileId}:${state.source.digest}`;
  const sourceIdentityRef = useRef(sourceIdentity);
  const restoredLocationGenerationRef = useRef<number | null>(null);
  const restoringLocationGenerationRef = useRef<number | null>(null);
  const initialSourceIdentityRef = useRef(
    `${props.initialState.source.fileId}:${props.initialState.source.digest}`,
  );
  useEffect(() => {
    const next = `${props.initialState.source.fileId}:${props.initialState.source.digest}`;
    if (next === initialSourceIdentityRef.current) return;
    initialSourceIdentityRef.current = next;
    portableItemIdsRef.current = initiallyPortableItemIds(
      props.initialState,
      props.initialSaveStatus,
    );
    setState(props.initialState);
  }, [props.initialState]);
  useEffect(() => {
    if (sourceIdentity === sourceIdentityRef.current) return;
    mainLocationRefresh.cancel();
    sourceIdentityRef.current = sourceIdentity;
    portableItemIdsRef.current = new Set();
    restoredLocationGenerationRef.current = null;
    restoringLocationGenerationRef.current = null;
    const nextGeneration = documentGenerationRef.current + 1;
    documentGenerationRef.current = nextGeneration;
    for (const waiter of referenceNavigationWaiters.current.splice(0)) {
      if (waiter.timeout !== null) clearTimeout(waiter.timeout);
      waiter.resolve(null);
    }
    outlineDiscoveryRef.current = { status: 'loading', documentGeneration: nextGeneration };
    setOutlineDiscovery(outlineDiscoveryRef.current);
    setExistingAnnotations({ status: 'loading', generation: 0 });
    setExistingAnnotationsSourceIdentity(sourceIdentity);
    setMainNavigationReadyGeneration(null);
    setMainDocumentReadyGeneration(null);
    navigationCoordinator.replaceDocument(nextGeneration);
    searchControllerRef.current?.dispose();
    searchControllerRef.current = null;
    searchDocumentRef.current = null;
    if (searchSubmitTimerRef.current !== null) clearTimeout(searchSubmitTimerRef.current);
    searchSubmitTimerRef.current = null;
    pendingSearchQueryRef.current = '';
    submittedSearchQueryRef.current = '';
    searchRequestedRef.current = false;
    setSearchState(initialPdfSearchState());
    dispatchLayout({ type: 'replace-document' });
    setRightWorkspaceMode('outline');
  }, [mainLocationRefresh, navigationCoordinator, sourceIdentity]);
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
      locationHistory === undefined
      || mainNavigationReadyGeneration !== documentGenerationRef.current
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
        isReady: () => mainNavigationRef.current?.fitToWidthReady() ?? false,
      });
      if (!ready) {
        if (restoringLocationGenerationRef.current === generation) {
          restoringLocationGenerationRef.current = null;
        }
        return;
      }
      navigationCoordinator.startLocationHistory();
      await navigationCoordinator.restoreCurrentLocation();
      if (!cancelled && generation === documentGenerationRef.current) {
        restoredLocationGenerationRef.current = generation;
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
    if (event.type === 'owned-mark') {
      const { id, phase } = event.value;
      if (phase === 'enter') markHoverRef.current = id;
      if (phase === 'leave' && markHoverRef.current === id) markHoverRef.current = undefined;
      if (phase === 'focus') markFocusRef.current = id;
      if (phase === 'blur' && markFocusRef.current === id) markFocusRef.current = undefined;
      if (phase === 'activate') {
        setActiveItemId(id);
        setActivationRequest({ id, token: ++activationTokenRef.current });
      }
      publishCorrespondence();
    }
  }, [mainLocationRefresh, navigationCoordinator]);
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
  }, [navigationCoordinator]);
  const onExistingAnnotationsDiscovery = useCallback((result: ExistingAnnotationsDiscovery) => {
    setExistingAnnotations(result);
    setExistingAnnotationsSourceIdentity(sourceIdentity);
  }, [sourceIdentity]);
  const onOutlineDiscovery = useCallback((discovery: PdfOutlineDiscovery) => {
    if (discovery.documentGeneration !== documentGenerationRef.current) return;
    outlineDiscoveryRef.current = discovery;
    setOutlineDiscovery(discovery);
    navigationCoordinator.refreshCurrentOutline();
  }, [navigationCoordinator]);
  const onViewerInitialized = useCallback(async (registry: PluginRegistry) => {
    viewerRegistry.current = registry;
    viewerControlsRef.current?.dispose();
    const controls = createViewerControls(registry);
    viewerControlsRef.current = controls;
    setViewerState(controls.snapshot());
    controls.subscribe(() => {
      setViewerState(controls.snapshot());
      mainLocationRefresh.schedule();
    });
  }, [mainLocationRefresh]);
  const onMainDocumentReady = useCallback((engine: PdfEngine, document: PdfDocumentObject) => {
    if (searchDocumentRef.current === document && searchControllerRef.current) return;
    setMainDocumentReadyGeneration(documentGenerationRef.current);
    searchControllerRef.current?.dispose();
    searchDocumentRef.current = document;
    const search = createPdfSearchController({
      documentGeneration: documentGenerationRef.current,
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
  }, []);
  const onViewerFramingInitialized = useCallback((controls: ViewerFramingControls) => {
    setViewerFraming(controls);
  }, []);
  const viewer = props.viewer ?? (
    <App
      embeddedInReviewShell
      assets={viewerAssets}
      documentTitle={props.scope.documentTitle}
      toolError={commandError}
      onSelectionUpdate={onSelectionUpdate}
      ownedAnnotations={ownedAnnotations}
      keyboardPageNoteActive={keyboardPageNoteActive}
      onViewerInteraction={onViewerInteraction}
      {...(activeItemId === undefined ? {} : { activeOwnedAnnotationId: activeItemId })}
      {...(correspondingItemId === undefined ? {} : { correspondingOwnedAnnotationId: correspondingItemId })}
      onExistingAnnotationsDiscovery={onExistingAnnotationsDiscovery}
      inventoryRetryGeneration={inventoryRetryGeneration}
      documentGeneration={navigationState.documentGeneration}
      referenceViewportHost={referenceViewportHost}
      onReferenceDocumentControls={onReferenceDocumentControls}
      onReferenceManualScroll={() => navigationCoordinator.observeReferenceManualScroll()}
      referenceManualScrollObserver={referenceManualScrollObserverRef.current}
      onViewerNavigationInitialized={onViewerNavigationInitialized}
      onOutlineDiscovery={onOutlineDiscovery}
      onViewerInitialized={onViewerInitialized}
      onMainDocumentReady={onMainDocumentReady}
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

  const annotationOutlineLabels = useMemo(() => {
    const pages = mainNavigationRef.current?.captureDocumentOrderPages() ?? [];
    const source = existingAnnotationsSourceIdentity === sourceIdentity
      && existingAnnotations.status === 'ready'
      ? existingAnnotations.items
      : [];
    const derivationContext = {
      sourceIdentity,
      activeSourceIdentity: sourceIdentityRef.current,
      navigationGeneration: mainNavigationReadyGeneration,
      outlineGeneration: outlineDiscovery.documentGeneration,
    };
    if (!canDeriveAnnotationOutlineLabels(derivationContext)) {
      return { owned: new Map<string, string>(), source: new Map<string, string>() };
    }
    return deriveAnnotationOutlineLabels({
      documentGeneration: derivationContext.navigationGeneration,
      outline: outlineDiscovery,
      pages,
      owned: state.items,
      source,
    });
  }, [
    existingAnnotations,
    existingAnnotationsSourceIdentity,
    mainNavigationReadyGeneration,
    outlineDiscovery,
    sourceIdentity,
    state.items,
  ]);

  const effectiveReferenceLayout = deriveReferenceWorkspaceLayout(
    referenceLayoutState,
    rightWorkspaceMode,
    navigationState.workspace.lastMode,
  );
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
    <main data-production-review ref={productionRootRef}>
      <ReviewShell
        state={state}
        documentTitle={props.scope.documentTitle}
        savedLabel="Saved"
        savePhase={saveStatus.sync.phase}
        saveOptionsOpen={destinationDialog !== null}
        onSaveOptions={() => openCopyDialog("menu")}
        {...(viewerControlsRef.current === undefined ? {} : { viewerControls: viewerControlsRef.current })}
        {...(viewerFraming === undefined ? {} : { viewerFraming })}
        {...(mainNavigation === null ? {} : { viewerNavigation: mainNavigation })}
        viewerState={viewerState}
        workspaceOpen={anyTrayOpen}
        referenceLayoutState={referenceLayoutState}
        rightWorkspaceMode={rightWorkspaceMode}
        search={searchWorkspace}
        viewerNavigationIntentToken={searchNavigationIntentToken}
        onCommitMainFramingPositionChange={onCommitMainFramingPositionChange}
        onReferenceLayoutAction={dispatchLayout}
        navigationState={navigationState}
        referenceTabs={navigationState.tabs.map((tab) => ({
          identity: tab.identity,
          label: tab.label ?? `Page ${tab.originalTarget.pageIndex + 1}`,
          pageContext: tab.pageContext ?? `Page ${tab.originalTarget.pageIndex + 1}`,
        }))}
        pendingReference={pendingReference}
        referenceReturn={activeReferenceReturn}
        outlineDiscovery={outlineDiscovery}
        annotationOutlineLabels={annotationOutlineLabels}
        currentOutlineItemId={currentOutlineItemId}
        linkActionRequest={linkActionRequest}
        navigationAnnouncement={navigationAnnouncement}
        canNavigateBack={navigationState.pendingMainNavigation === null
          && (locationHistory === undefined
            ? navigationState.mainHistory.index > 0
            : locationHistorySnapshot.canBack)}
        canNavigateForward={navigationState.pendingMainNavigation === null
          && (locationHistory === undefined
            ? navigationState.mainHistory.index >= 0
              && navigationState.mainHistory.index < navigationState.mainHistory.entries.length - 1
            : locationHistorySnapshot.canForward)}
        {...(props.scope.launchSurface === 'codex'
          ? { codexContext: visibleCodexContext(codexContext, state) ?? UNAVAILABLE_CODEX_CONTEXT }
          : {})}
        {...(props.session.appLinkBase === undefined || locationHistory === undefined ? {} : {
          copyLink: {
            disabled: navigationState.pendingMainNavigation !== null
              || navigationState.pendingSendToMain !== null,
            getLink: () => {
              mainLocationRefresh.flush();
              return buildPlacekeeperCopyLink(
                props.session.appLinkBase!,
                navigationCoordinator.currentLinkLocation(),
              );
            },
            writeText: writePlacekeeperLink,
          },
          copyItemLink: {
            getLink: (item: ReviewItem) => portableItemIdsRef.current.has(item.id)
              && saveStatusIsCleanCurrent(state, saveStatus)
              ? buildPlacekeeperCopyLink(props.session.appLinkBase!, {
                  kind: 'item',
                  page: item.pageIndex + 1,
                  itemId: item.id,
                })
              : undefined,
            writeText: writePlacekeeperLink,
          },
        })}
        onLinkActionChoose={(choice, request) => {
          void navigationCoordinator.chooseLink(choice, request);
        }}
        onLinkActionDismiss={(request) => navigationCoordinator.dismissLink(request)}
        {...(copyLinkForLinkAction === undefined ? {} : { copyLinkForLinkAction })}
        onNavigateBack={() => { void navigationCoordinator.historyBack(); }}
        onNavigateForward={() => { void navigationCoordinator.historyForward(); }}
        onWorkspaceModeChange={(mode) => {
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
        }}
        onWorkspaceDismiss={() => {
          dispatchLayout({ type: 'hide-references' });
          dispatchNavigation({
            type: 'hide-workspace',
            focusReturnToken: referenceLayoutState.regime === 'narrow'
              || referenceLayoutState.referenceDock === 'bottom'
              ? BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN
              : RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN,
          });
        }}
        onReferenceTabActivate={(identity) => {
          void navigationCoordinator.switchReference(identity);
        }}
        onReferenceTabClose={(identity) => {
          void navigationCoordinator.closeReference(identity);
        }}
        onReferenceSendToMain={(identity) => {
          void navigationCoordinator.sendToMain(identity);
        }}
        onReferenceRetry={() => { void navigationCoordinator.retryReference(); }}
        onReferenceReturn={(identity) => {
          void navigationCoordinator.returnToReference(identity);
        }}
        onOutlineActivate={(item) => {
          if (item.target === null) navigationCoordinator.unavailableDestination();
          else void navigationCoordinator.navigateMainTarget(item.target, 'outline');
        }}
        onOutlineReference={(item) => {
          if (item.target === null) return;
          void navigationCoordinator.openReference(item.target, {
            label: item.label,
            pageContext: item.pageContext ?? `Page ${item.target.pageIndex + 1}`,
          });
        }}
        {...(copyLinkForOutlineItem === undefined ? {} : { copyLinkForOutlineItem })}
        onReferenceViewportHost={setReferenceViewportHost}
        onWorkspaceModeFocusTokenChange={(mode, token) => {
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
        }}
        selectionUpdate={selectionUpdate}
        selectionPlacement={selectionPlacement}
        caretAnchor={caret}
        caretPlacement={caretPlacement}
        pageMenu={pageMenu === null ? null : {
          invocationId: pageMenu.invocationId,
          placement: pageMenu.placement,
          pageIndex: pageMenu.point.pageIndex,
          position: { x: pageMenu.point.x, y: pageMenu.point.y, width: 18, height: 18 },
        }}
        placedPageNote={placedPageNote}
        keyboardPageNoteActive={keyboardPageNoteActive}
        existingAnnotations={existingAnnotations}
        {...(correspondingItemId === undefined ? {} : { correspondingItemId })}
        {...(activationRequest === undefined ? {} : { activationRequest })}
        onRetryExistingAnnotations={() => setInventoryRetryGeneration((generation) => generation + 1)}
        onItemCorrespondenceChange={(id) => {
          rowCorrespondenceRef.current = id;
          publishCorrespondence();
        }}
        onActiveItemChange={setActiveItemId}
        onRequestKeyboardPageNote={() => {
          if (pageMenu) placementAuthority.current.dismissContext(pageMenu.invocationId);
          setPageMenu(null);
          placementAuthority.current.clearKeyboardCursor();
          setKeyboardPageNoteActive(true);
        }}
        onCancelKeyboardPageNote={() => {
          placementAuthority.current.clearKeyboardCursor();
          setKeyboardPageNoteActive(false);
        }}
        onPageMenuDismiss={(invocationId) => {
          placementAuthority.current.dismissContext(invocationId);
          setPageMenu((current) => current?.invocationId === invocationId ? null : current);
        }}
        onPageMenuConsumed={(invocationId) => {
          const point = placementAuthority.current.consumeContextPoint(invocationId);
          if (!point) return;
          setPageMenu(null);
        }}
        onPlacedPageNoteConsumed={(token) => {
          setPlacedPageNote((current) => current?.token === token ? null : current);
        }}
        cancelPendingCommandToken={cancelPendingCommandToken}
        onPageNoteComposerComplete={() => {
          placementAuthority.current.clear();
          setPageMenu(null);
          setKeyboardPageNoteActive(false);
        }}
        onSelectionConsumed={(generation) => {
          const currentSelection = selectionUpdateRef.current;
          if (currentSelection.kind !== "reliable" || currentSelection.generation !== generation) return;
          const registry = viewerRegistry.current;
          const documentId = registry?.getStore().getState().core.activeDocumentId;
          if (!documentId) return;
          registry.getPlugin<SelectionPlugin>(SelectionPlugin.id)?.provides()?.clear(documentId);
        }}
        onCommand={async (command) => {
          const gated = gateReviewCommand(state, saveStatus, command);
          if (gated.kind === "choose-destination") {
            openCopyDialog("first-annotation", command);
            return {
              accepted: false,
              state,
              message: "Choose where annotations should be saved.",
            };
          }
          const result = await props.api.command(command);
          const next = "accepted" in result ? result.state : result;
          setState(next);
          if (!("accepted" in result)) {
            setSaveStatus(await props.api.saveStatus());
          }
          setCommandError("accepted" in result ? result.message : null);
          return result;
        }}
        onNavigate={(item) => {
          const portable = portableItemIdsRef.current.has(item.id)
            && saveStatusIsCleanCurrent(state, saveStatus);
          void navigationCoordinator.navigateMainAnnotation({
            pageIndex: item.pageIndex,
            point: reviewItemPoint(item),
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
      >
        {viewer}
      </ReviewShell>
      <SaveDestinationDialog
        open={destinationDialog !== null}
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
        onRetry={async () => {
          if (destinationEstablishing) return;
          setDestinationEstablishing(true);
          setDestinationError(undefined);
          try {
            setSaveStatus(await props.api.retrySave());
            setDestinationDialog(null);
          } catch {
            setDestinationError("Saving could not be retried safely.");
          } finally {
            setDestinationEstablishing(false);
          }
        }}
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
              setCopyProposal((current) => ({
                filename: current?.filename ?? "annotated.pdf",
                folder: selected.folder!,
              }));
            }
          } catch {
            setDestinationError("A new location could not be authorized.");
          }
        }}
        onCancel={() => {
          if (destinationEstablishing) return;
          destinationAttemptRef.current += 1;
          if (destinationDialog?.reason === "first-annotation") {
            setCancelPendingCommandToken((token) => token + 1);
          }
          setDestinationDialog(null);
          setDestinationError(undefined);
        }}
        onConfirm={async (choice, filename) => {
          const dialog = destinationDialog;
          if (dialog === null || destinationEstablishing) return;
          const attempt = destinationAttemptRef.current;
          setDestinationEstablishing(true);
          setDestinationError(undefined);
          try {
            const established = choice === "copy"
              ? await props.api.chooseCopy(filename, folderSelectionId)
              : await props.api.chooseOriginal();
            if (destinationAttemptRef.current !== attempt) return;
            setSaveStatus(established);
            if (dialog.pending !== undefined) {
              const result = await props.api.command(dialog.pending);
              if (destinationAttemptRef.current !== attempt) return;
              const next = "accepted" in result ? result.state : result;
              setState(next);
              if ("accepted" in result) throw new Error(result.message);
              setCancelPendingCommandToken((token) => token + 1);
              setSaveStatus(await props.api.saveStatus());
              if (destinationAttemptRef.current !== attempt) return;
            }
            setDestinationDialog(null);
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
      />
    </main>
  );
}
