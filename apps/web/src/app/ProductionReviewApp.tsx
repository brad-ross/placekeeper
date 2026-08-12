import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { PluginRegistry } from "@embedpdf/core";
import type { PdfDocumentObject, PdfEngine } from '@embedpdf/models';
import { ScrollPlugin } from "@embedpdf/plugin-scroll";
import { SelectionPlugin } from "@embedpdf/plugin-selection";

import type { ReviewCommand, ReviewState } from "../../../../packages/core/src/review-model.js";
import type { CaretAnchor } from "../pdf/selection-anchor.js";
import type { ExistingAnnotation, ExistingAnnotationsDiscovery } from "../pdf/existing-annotations.js";
import {
  acceptSelectionUpdate,
  INITIAL_SELECTION_UPDATE,
  type SelectionUpdate,
} from "../pdf/selection-state.js";
import { CodexDelivery, type CheckedCodexResult, type PreparedCodexHandoff } from "../export/CodexDelivery.js";
import { HumanDelivery, type DeliveryArtifact } from "../export/HumanDelivery.js";
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
  BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN,
  RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN,
  createReferenceWorkspaceLayout,
  deriveReferenceWorkspaceLayout,
  reduceReferenceWorkspaceLayout,
  type ReferenceWorkspaceLayoutAction,
  type RightWorkspaceMode,
} from "../review/reference-workspace-layout.js";

function itemCoordinates(item: ReviewState["items"][number]): { x: number; y: number } | undefined {
  const value = item.payload[item.kind === "insert" || item.kind === "pageNote" ? "position" : "rect"];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const x = value.x;
  const y = value.y;
  return typeof x === "number" && typeof y === "number" ? { x, y } : undefined;
}

export interface ProductionSession {
  readonly sessionId: string;
  readonly credential: string;
}

export interface ProductionScope {
  readonly documentTitle: string;
  readonly sourceRootPath?: string;
}

export interface PreparedProductionHandoff extends PreparedCodexHandoff {
  readonly receiptId: string;
  readonly resultDirectory: string;
}

export interface ProductionSessionApi {
  command(command: ReviewCommand): Promise<ReviewState | RejectedReviewCommand>;
  saveReviewedCopy(): Promise<DeliveryArtifact>;
  replaceOriginal(): Promise<DeliveryArtifact>;
  prepareCodex(): Promise<PreparedProductionHandoff>;
  saveInstruction(receiptId: string): Promise<DeliveryArtifact>;
  checkCodex(input: {
    readonly receiptId: string;
    readonly dispositionText: string;
    readonly revisedPdfSelected: boolean;
  }): Promise<CheckedCodexResult>;
  finish(): Promise<void>;
  discard(): Promise<void>;
}

export interface ProductionReviewAppProps {
  readonly session: ProductionSession;
  readonly initialState: ReviewState;
  readonly scope: ProductionScope;
  readonly api: ProductionSessionApi;
  readonly viewer?: ReactNode;
}

export function ProductionReviewApp(props: ProductionReviewAppProps) {
  const [state, setState] = useState(props.initialState);
  const [selectionUpdate, setSelectionUpdate] = useState<SelectionUpdate>(INITIAL_SELECTION_UPDATE);
  const selectionUpdateRef = useRef(selectionUpdate);
  selectionUpdateRef.current = selectionUpdate;
  const [commandError, setCommandError] = useState<string | null>(null);
  const [confirmedScope, setConfirmedScope] = useState<string | null>(null);
  const [humanConfirmationActive, setHumanConfirmationActive] = useState(false);
  const [codexConfirmationActive, setCodexConfirmationActive] = useState(false);
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
  const latestReceipt = useRef<string | null>(null);
  const viewerRegistry = useRef<PluginRegistry | null>(null);
  const searchControllerRef = useRef<PdfSearchController | null>(null);
  const searchDocumentRef = useRef<PdfDocumentObject | null>(null);
  const pendingSearchQueryRef = useRef('');
  const submittedSearchQueryRef = useRef('');
  const searchSubmitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRequestedRef = useRef(false);
  const [searchState, setSearchState] = useState(() => initialPdfSearchState());
  const [searchNavigationIntentToken, setSearchNavigationIntentToken] = useState(0);
  const viewerControlsRef = useRef<ViewerControls | undefined>(undefined);
  const [viewerFraming, setViewerFraming] = useState<ViewerFramingControls>();
  const productionRootRef = useRef<HTMLElement | null>(null);
  const mainNavigationRef = useRef<PdfViewerNavigation | null>(null);
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
  const sourceRoot = props.scope.sourceRootPath ?? "No source root selected";
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
      navigation?.replaceDocument(documentGenerationRef.current);
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
      onExistingAnnotationsDiscovery={setExistingAnnotations}
      inventoryRetryGeneration={inventoryRetryGeneration}
      documentGeneration={navigationState.documentGeneration}
      referenceViewportHost={referenceViewportHost}
      onReferenceDocumentControls={onReferenceDocumentControls}
      onViewerNavigationInitialized={onViewerNavigationInitialized}
      onOutlineDiscovery={onOutlineDiscovery}
      onViewerInitialized={onViewerInitialized}
      onMainDocumentReady={onMainDocumentReady}
      onViewerFramingInitialized={onViewerFramingInitialized}
      activeSearchResult={searchState.groups
        .flatMap((group) => group.results)
        .find(({ id }) => id === searchState.selectedResultId) ?? null}
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
    const selectedResult = searchState.groups
      .flatMap((group) => group.results)
      .find(({ id }) => id === searchState.selectedResultId);
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

  const delivery = (
    <div className="review-delivery-content">
      <HumanDelivery
        state={state}
        showLifecycleActions={false}
        onConfirmationActiveChange={setHumanConfirmationActive}
        onSave={() => props.api.saveReviewedCopy()}
        onReplaceOriginal={() => props.api.replaceOriginal()}
        onFinish={() => props.api.finish()}
        onDiscard={() => props.api.discard()}
      />
      <CodexDelivery
        state={state}
        onConfirmationActiveChange={setCodexConfirmationActive}
        sourceRoot={sourceRoot}
        provider="Codex desktop"
        revisedPdfDestination="A fresh result directory inside the approved source root"
        retention="Artifacts remain local until you delete them"
        confirmedScopeSignature={confirmedScope}
        onConfirmScope={setConfirmedScope}
        onPrepare={async () => {
          const prepared = await props.api.prepareCodex();
          latestReceipt.current = prepared.receiptId;
          return prepared;
        }}
        onSaveInstruction={async () => {
          if (latestReceipt.current === null) throw new Error("Prepare a handoff first");
          await props.api.saveInstruction(latestReceipt.current);
        }}
        onCheckResult={async ({ disposition, revisedPdf }) => {
          if (latestReceipt.current === null) throw new Error("Prepare a handoff first");
          return props.api.checkCodex({
            receiptId: latestReceipt.current,
            dispositionText: await disposition.text(),
            revisedPdfSelected: revisedPdf !== undefined,
          });
        }}
      />
    </div>
  );
  const effectiveReferenceLayout = deriveReferenceWorkspaceLayout(
    referenceLayoutState,
    rightWorkspaceMode,
    navigationState.workspace.lastMode,
  );
  const anyTrayOpen = effectiveReferenceLayout.kind === 'narrow-unified'
    ? effectiveReferenceLayout.open
    : effectiveReferenceLayout.rightWorkspaceOpen || effectiveReferenceLayout.bottomReferencesOpen;

  return (
    <main data-production-review ref={productionRootRef}>
      <ReviewShell
        state={state}
        documentTitle={props.scope.documentTitle}
        savedLabel={`Saved · revision ${state.revision}`}
        {...(viewerControlsRef.current === undefined ? {} : { viewerControls: viewerControlsRef.current })}
        {...(viewerFraming === undefined ? {} : { viewerFraming })}
        viewerState={viewerState}
        workspaceOpen={anyTrayOpen}
        referenceLayoutState={referenceLayoutState}
        rightWorkspaceMode={rightWorkspaceMode}
        search={searchWorkspace}
        viewerNavigationIntentToken={searchNavigationIntentToken}
        onReferenceLayoutAction={dispatchLayout}
        navigationState={navigationState}
        referenceTabs={navigationState.tabs.map((tab) => ({
          identity: tab.identity,
          label: tab.label ?? `Page ${tab.originalTarget.pageIndex + 1}`,
          pageContext: tab.pageContext ?? `Page ${tab.originalTarget.pageIndex + 1}`,
        }))}
        pendingReference={pendingReference}
        outlineDiscovery={outlineDiscovery}
        currentOutlineItemId={currentOutlineItemId}
        linkActionRequest={linkActionRequest}
        navigationAnnouncement={navigationAnnouncement}
        canNavigateBack={navigationState.pendingMainNavigation === null
          && navigationState.mainHistory.index > 0}
        canNavigateForward={navigationState.pendingMainNavigation === null
          && navigationState.mainHistory.index >= 0
          && navigationState.mainHistory.index < navigationState.mainHistory.entries.length - 1}
        finishSlot={delivery}
        finishConfirmationActive={humanConfirmationActive || codexConfirmationActive}
        onFinishReview={() => props.api.finish()}
        onDiscardReview={() => props.api.discard()}
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
          const result = await props.api.command(command);
          const next = "accepted" in result ? result.state : result;
          setState(next);
          setCommandError("accepted" in result ? result.message : null);
          return result;
        }}
        onNavigate={(item) => {
          const registry = viewerRegistry.current;
          const core = registry?.getStore().getState().core;
          const documentId = core?.activeDocumentId;
          const scroll = registry?.getPlugin<ScrollPlugin>(ScrollPlugin.id)?.provides();
          if (documentId && scroll) {
            const page = core?.documents[documentId]?.document?.pages[item.pageIndex];
            const coordinates = itemCoordinates(item);
            scroll.forDocument(documentId).scrollToPage({
              pageNumber: item.pageIndex + 1,
              ...(coordinates === undefined ? {} : {
                pageCoordinates: {
                  x: coordinates.x - (page?.boxes?.crop.left ?? 0),
                  y: coordinates.y - (page?.boxes?.crop.top ?? 0),
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
    </main>
  );
}
