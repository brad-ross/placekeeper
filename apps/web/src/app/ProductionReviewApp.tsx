import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { PluginRegistry } from "@embedpdf/core";
import type { PdfDocumentObject, PdfEngine } from '@embedpdf/models';
import { ScrollPlugin } from "@embedpdf/plugin-scroll";
import { SelectionPlugin } from "@embedpdf/plugin-selection";

import type { ReviewCommand, ReviewState } from "../../../../packages/core/src/review-model.js";
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
} from "../pdf/viewer-interaction-events.js";
import { PageNotePlacementAuthority } from "../review/review-surface-state.js";
import {
  NavigationCoordinator,
} from "../review/navigation-coordinator.js";
import {
  createReferenceNavigationState,
  reduceReferenceNavigation,
  type ReferenceNavigationAction,
} from "../review/reference-navigation-state.js";
import type { PendingReferencePanel } from "../review/ReferenceWorkspace.js";
import { PdfSearchWorkspace } from '../review/PdfSearchWorkspace.js';
import { createTrailingTaskScheduler } from "../review/main-location-refresh.js";
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
}

export interface ProductionScope {
  readonly documentTitle: string;
  readonly sourceRootPath?: string;
  readonly launchSurface?: 'browser' | 'finder' | 'codex' | 'vscode';
  readonly codexContext?: LiveContextBindingStatus;
}

export type ProductionSaveStatus = SaveStatus;

export interface SaveCopyProposal {
  readonly filename: string;
  readonly folder: string;
}

export interface ProductionSessionApi {
  command(command: ReviewCommand): Promise<ReviewState | RejectedReviewCommand>;
  saveStatus(): Promise<ProductionSaveStatus>;
  saveProposal(): Promise<SaveCopyProposal>;
  chooseCopy(filename?: string, folderSelectionId?: string): Promise<ProductionSaveStatus>;
  chooseFolder(): Promise<{ readonly cancelled: boolean; readonly selectionId?: string; readonly folder?: string }>;
  chooseOriginal(): Promise<ProductionSaveStatus>;
  retrySave(): Promise<ProductionSaveStatus>;
  locateSave(): Promise<ProductionSaveStatus>;
  scope(): Promise<ProductionScope>;
}

export interface ProductionReviewAppProps {
  readonly session: ProductionSession;
  readonly initialState: ReviewState;
  readonly initialSaveStatus?: ProductionSaveStatus;
  readonly scope: ProductionScope;
  readonly api: ProductionSessionApi;
  readonly viewer?: ReactNode;
}

const UNAVAILABLE_CODEX_CONTEXT: LiveContextBindingStatus = {
  status: 'unavailable',
  reason: 'unavailable',
};

function updateCodexContext(
  current: LiveContextBindingStatus | undefined,
  next: LiveContextBindingStatus,
): LiveContextBindingStatus {
  return JSON.stringify(current) === JSON.stringify(next) ? current ?? next : next;
}

export function ProductionReviewApp(props: ProductionReviewAppProps) {
  const [state, setState] = useState(props.initialState);
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
  const [mainNavigation, setMainNavigation] = useState<PdfViewerNavigation | null>(null);
  const referenceNavigationRef = useRef<PdfViewerNavigation | null>(null);
  const referenceControllerRef = useRef<ReferenceDocumentController | null>(null);
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
  const [referenceViewportHost, setReferenceViewportHost] = useState<HTMLDivElement | null>(null);
  const markHoverRef = useRef<string | undefined>(undefined);
  const markFocusRef = useRef<string | undefined>(undefined);
  const rowCorrespondenceRef = useRef<string | undefined>(undefined);
  const activationTokenRef = useRef(0);
  const [viewerState, setViewerState] = useState<ViewerControlsSnapshot>(unavailableViewerControls);
  const viewerAssets = useMemo(() => ({
    pdfiumWasm: `/s/${props.session.sessionId}/assets/pdfium.wasm`,
    documentUrl: `/s/${props.session.sessionId}/document/${state.source.fileId}`,
    requestHeaders: { authorization: `Bearer ${props.session.credential}` },
  }), [props.session.credential, props.session.sessionId, state.source.fileId]);
  const ownedAnnotations = useMemo(
    () => projectReviewItems(state.items),
    [state.items],
  );
  useEffect(() => {
    if (props.scope.launchSurface !== 'codex') return;
    let stopped = false;
    let timer: number | undefined;
    const refreshCodexContext = async () => {
      try {
        const next = await props.api.scope();
        if (!stopped) {
          const nextContext = next.launchSurface === 'codex'
            ? next.codexContext ?? UNAVAILABLE_CODEX_CONTEXT
            : UNAVAILABLE_CODEX_CONTEXT;
          setCodexContext((current) => updateCodexContext(current, nextContext));
        }
      } catch {
        if (!stopped) {
          setCodexContext((current) => updateCodexContext(current, UNAVAILABLE_CODEX_CONTEXT));
        }
      } finally {
        if (!stopped) {
          timer = window.setTimeout(() => { void refreshCodexContext(); }, 1_500);
        }
      }
    };
    timer = window.setTimeout(() => { void refreshCodexContext(); }, 1_500);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [props.api, props.scope.launchSurface]);
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
            const surface = referenceLayoutStateRef.current.regime === 'narrow'
              || referenceLayoutStateRef.current.referenceDock === 'bottom' ? 'bottom' : 'right';
            productionRootRef.current
              ?.querySelector<HTMLButtonElement>(`[data-workspace-edge-rail="${surface}"]`)
              ?.focus({ preventScroll: true });
          });
          return true;
        },
        referenceRailFocusToken: () => referenceLayoutStateRef.current.regime === 'narrow'
          || referenceLayoutStateRef.current.referenceDock === 'bottom'
          ? BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN
          : RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN,
      },
      setPendingReference,
      setLinkActionRequest,
      setAnnouncement: setNavigationAnnouncement,
      focusReferenceTab: (identity) => {
        const layoutGeneration = layoutGenerationRef.current;
        const documentGeneration = documentGenerationRef.current;
        requestAnimationFrame(() => {
          if (layoutGeneration !== layoutGenerationRef.current
            || documentGeneration !== documentGenerationRef.current) return;
          const target = [...(productionRootRef.current?.querySelectorAll<HTMLElement>(
            '[data-reference-tab]',
          ) ?? [])].find((element) => element.dataset.referenceTab === identity);
          target?.focus({ preventScroll: true });
        });
        return true;
      },
      getOutlineDiscovery: () => outlineDiscoveryRef.current,
      setCurrentOutlineItemId,
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
  const initialSourceIdentityRef = useRef(
    `${props.initialState.source.fileId}:${props.initialState.source.digest}`,
  );
  useEffect(() => {
    const next = `${props.initialState.source.fileId}:${props.initialState.source.digest}`;
    if (next === initialSourceIdentityRef.current) return;
    initialSourceIdentityRef.current = next;
    setState(props.initialState);
  }, [props.initialState]);
  useEffect(() => {
    if (sourceIdentity === sourceIdentityRef.current) return;
    mainLocationRefresh.cancel();
    sourceIdentityRef.current = sourceIdentity;
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
  }, []);
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
  const searchWorkspace = (
    <PdfSearchWorkspace
      state={searchState}
      onQueryChange={submitSearchQuery}
      onResultActivate={activateSearchResult}
      onResultOpenReference={openSearchResultReference}
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
        outlineDiscovery={outlineDiscovery}
        annotationOutlineLabels={annotationOutlineLabels}
        currentOutlineItemId={currentOutlineItemId}
        linkActionRequest={linkActionRequest}
        navigationAnnouncement={navigationAnnouncement}
        canNavigateBack={navigationState.pendingMainNavigation === null
          && navigationState.mainHistory.index > 0}
        canNavigateForward={navigationState.pendingMainNavigation === null
          && navigationState.mainHistory.index >= 0
          && navigationState.mainHistory.index < navigationState.mainHistory.entries.length - 1}
        {...(props.scope.launchSurface === 'codex'
          ? { codexContext: codexContext ?? UNAVAILABLE_CODEX_CONTEXT }
          : {})}
        onLinkActionChoose={(choice, request) => {
          void navigationCoordinator.chooseLink(choice, request);
        }}
        onLinkActionDismiss={(request) => navigationCoordinator.dismissLink(request)}
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
          const registry = viewerRegistry.current;
          const core = registry?.getStore().getState().core;
          const documentId = core?.activeDocumentId;
          const scroll = registry?.getPlugin<ScrollPlugin>(ScrollPlugin.id)?.provides();
          if (documentId && scroll) {
            const coordinates = reviewItemPoint(item) ?? undefined;
            scroll.forDocument(documentId).scrollToPage({
              pageNumber: item.pageIndex + 1,
              ...(coordinates === undefined ? {} : {
                pageCoordinates: {
                  x: coordinates.x,
                  y: coordinates.y,
                },
              }),
              behavior: "smooth",
              alignX: 50,
              alignY: 35,
            });
          }
        }}
        onNavigateExisting={(annotation: ExistingAnnotation) => {
          const registry = viewerRegistry.current;
          const documentId = registry?.getStore().getState().core.activeDocumentId;
          const scroll = registry?.getPlugin<ScrollPlugin>(ScrollPlugin.id)?.provides();
          if (documentId && scroll) {
            scroll.forDocument(documentId).scrollToPage({
              pageNumber: annotation.pageIndex + 1,
              behavior: 'smooth',
              alignX: 50,
              alignY: 35,
            });
          }
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
