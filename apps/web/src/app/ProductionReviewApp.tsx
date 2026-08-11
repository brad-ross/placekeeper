import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { PluginRegistry } from "@embedpdf/core";
import { ScrollPlugin } from "@embedpdf/plugin-scroll";
import { SelectionPlugin } from "@embedpdf/plugin-selection";

import type { ReviewCommand, ReviewState } from "../../../../packages/core/src/review-model.js";
import type { SaveStatus } from "../../../../packages/core/src/save-status.js";
import type { CaretAnchor } from "../pdf/selection-anchor.js";
import type { ExistingAnnotation, ExistingAnnotationsDiscovery } from "../pdf/existing-annotations.js";
import {
  acceptSelectionUpdate,
  INITIAL_SELECTION_UPDATE,
  selectionReadinessMessage,
  type SelectionUpdate,
} from "../pdf/selection-state.js";
import { CodexDelivery, type CheckedCodexResult, type PreparedCodexHandoff } from "../export/CodexDelivery.js";
import type { DeliveryArtifact } from "../export/delivery-availability.js";
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
import { SaveDestinationDialog } from "../save/SaveDestinationDialog.js";
import { SaveDestinationMenu } from "../save/SaveDestinationMenu.js";
import {
  gateReviewCommand,
  pollSaveStatusUntilSettled,
} from "../save/save-state-controller.js";

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
  prepareCodex(): Promise<PreparedProductionHandoff>;
  saveInstruction(receiptId: string): Promise<DeliveryArtifact>;
  checkCodex(input: {
    readonly receiptId: string;
    readonly dispositionText: string;
    readonly revisedPdfSelected: boolean;
  }): Promise<CheckedCodexResult>;
}

export interface ProductionReviewAppProps {
  readonly session: ProductionSession;
  readonly initialState: ReviewState;
  readonly initialSaveStatus?: ProductionSaveStatus;
  readonly scope: ProductionScope;
  readonly api: ProductionSessionApi;
  readonly viewer?: ReactNode;
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
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
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
  const [toolError, setToolError] = useState<string | null>(null);
  const [confirmedScope, setConfirmedScope] = useState<string | null>(null);
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
  const lastCaretDiagnostic = useRef<string | null>(null);
  const latestReceipt = useRef<string | null>(null);
  const viewerRegistry = useRef<PluginRegistry | null>(null);
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
    setSaveMenuOpen(false);
    setDestinationError(undefined);
    setCopyProposal(undefined);
    setDestinationDialog({ reason, ...(pending === undefined ? {} : { pending }) });
  };
  const chooseOriginal = async () => {
    setDestinationError(undefined);
    try {
      setSaveStatus(await props.api.chooseOriginal());
      setSaveMenuOpen(false);
    } catch {
      setSaveMenuOpen(false);
      setCopyProposal(undefined);
      setDestinationDialog({ reason: "menu" });
      setDestinationError("The original cannot be modified safely. Save to a copy instead.");
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
      layout: {
        revealReferences: () => {
          const layout = referenceLayoutStateRef.current;
          if (layout.regime !== 'narrow' || !layout.narrowOpen) {
            dispatchLayout({ type: 'show-references' });
          }
          dispatchLayout({ type: 'focus-surface', surface: 'references' });
        },
        hideReferences: () => dispatchLayout({ type: 'hide-references' }),
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
    if (update.kind === "reliable") setToolError(null);
  }, []);
  const readinessMessage = selectionReadinessMessage(selectionUpdate);
  const publishCorrespondence = () => setCorrespondingItemId(
    rowCorrespondenceRef.current ?? markFocusRef.current ?? markHoverRef.current,
  );
  useEffect(() => () => {
    navigationCoordinator.dispose();
    mainLocationRefresh.cancel();
    viewerControlsRef.current?.dispose();
    placementAuthority.current.clear();
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
      if (event.value.diagnostic && lastCaretDiagnostic.current !== event.value.diagnostic) {
        lastCaretDiagnostic.current = event.value.diagnostic;
        setToolError("This selection cannot be anchored reliably. Adjust the selection or use Page Note.");
      }
      if (event.value.anchor) {
        lastCaretDiagnostic.current = null;
        setToolError(null);
      }
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
  const onViewerFramingInitialized = useCallback((controls: ViewerFramingControls) => {
    setViewerFraming(controls);
  }, []);
  const viewer = props.viewer ?? (
    <App
      embeddedInReviewShell
      assets={viewerAssets}
      documentTitle={props.scope.documentTitle}
      toolError={readinessMessage ?? toolError}
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
      onViewerFramingInitialized={onViewerFramingInitialized}
    />
  );

  const codexDelivery = (
    <div className="review-delivery-content">
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
        savedLabel="Saved"
        {...(saveStatus.destination.phase === "active" && saveStatus.destination.kind === "copy"
          ? { destinationTitle: saveStatus.destination.targetPath.split(/[\\/]/u).at(-1)! }
          : {})}
        savePhase={saveStatus.sync.phase}
        onSaveOptions={() => setSaveMenuOpen((open) => !open)}
        {...(viewerControlsRef.current === undefined ? {} : { viewerControls: viewerControlsRef.current })}
        {...(viewerFraming === undefined ? {} : { viewerFraming })}
        viewerState={viewerState}
        workspaceOpen={anyTrayOpen}
        referenceLayoutState={referenceLayoutState}
        rightWorkspaceMode={rightWorkspaceMode}
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
        codexSlot={codexDelivery}
        codexConfirmationActive={codexConfirmationActive}
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
          if ("accepted" in result) setToolError(result.message);
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
      <SaveDestinationMenu
        open={saveMenuOpen}
        documentTitle={props.scope.documentTitle}
        status={saveStatus}
        {...(destinationError === undefined ? {} : { error: destinationError })}
        onClose={() => setSaveMenuOpen(false)}
        onCopy={() => openCopyDialog("menu")}
        onOriginal={() => { void chooseOriginal(); }}
        onRetry={() => {
          setDestinationError(undefined);
          void props.api.retrySave()
            .then((next) => {
              setSaveStatus(next);
              setSaveMenuOpen(false);
            })
            .catch(() => setDestinationError("Saving could not be retried safely."));
        }}
        onLocate={() => {
          setDestinationError(undefined);
          void props.api.locateSave()
            .then((next) => {
              setSaveStatus(next);
              setSaveMenuOpen(false);
            })
            .catch(() => setDestinationError("The selected PDF did not match the saved file."));
        }}
      />
      <SaveDestinationDialog
        open={destinationDialog !== null}
        {...(copyProposal === undefined ? {} : { proposal: copyProposal })}
        establishing={destinationEstablishing}
        {...(saveStatus.rewriteEligibility === undefined
          ? {}
          : { rewriteEligibility: saveStatus.rewriteEligibility })}
        {...(destinationError === undefined ? {} : { error: destinationError })}
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
