import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PluginRegistry } from "@embedpdf/core";
import { ScrollPlugin } from "@embedpdf/plugin-scroll";

import type { ReviewCommand, ReviewState } from "../../../../packages/core/src/review-model.js";
import type { CaretAnchor } from "../pdf/selection-anchor.js";
import type { ExistingAnnotation, ExistingAnnotationsDiscovery } from "../pdf/existing-annotations.js";
import {
  acceptSelectionUpdate,
  INITIAL_SELECTION_UPDATE,
  selectionReadinessMessage,
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
import type {
  ViewerClientPlacement,
  ViewerInteractionEvent,
  ViewerPageMenuInvocation,
} from "../pdf/viewer-interaction-events.js";
import { PageNotePlacementAuthority } from "../review/review-surface-state.js";

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
  const [toolError, setToolError] = useState<string | null>(null);
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
  const lastCaretDiagnostic = useRef<string | null>(null);
  const latestReceipt = useRef<string | null>(null);
  const viewerRegistry = useRef<PluginRegistry | null>(null);
  const viewerControlsRef = useRef<ViewerControls | undefined>(undefined);
  const [viewerFraming, setViewerFraming] = useState<ViewerFramingControls>();
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

  const onSelectionUpdate = (update: SelectionUpdate) => {
    setSelectionUpdate((current) => acceptSelectionUpdate(current, update));
    if (update.kind === "reliable") setToolError(null);
  };
  const readinessMessage = selectionReadinessMessage(selectionUpdate);
  const publishCorrespondence = () => setCorrespondingItemId(
    rowCorrespondenceRef.current ?? markFocusRef.current ?? markHoverRef.current,
  );
  useEffect(() => () => {
    viewerControlsRef.current?.dispose();
    placementAuthority.current.clear();
  }, []);
  const onViewerInteraction = (event: ViewerInteractionEvent) => {
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
  };
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
      onViewerInitialized={async (registry) => {
        viewerRegistry.current = registry;
        viewerControlsRef.current?.dispose();
        const controls = createViewerControls(registry);
        viewerControlsRef.current = controls;
        setViewerState(controls.snapshot());
        controls.subscribe(() => setViewerState(controls.snapshot()));
      }}
      onViewerFramingInitialized={(controls) => {
        setViewerFraming(controls);
      }}
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

  return (
    <main data-production-review>
      <ReviewShell
        state={state}
        documentTitle={props.scope.documentTitle}
        savedLabel={`Saved · revision ${state.revision}`}
        {...(viewerControlsRef.current === undefined ? {} : { viewerControls: viewerControlsRef.current })}
        {...(viewerFraming === undefined ? {} : { viewerFraming })}
        viewerState={viewerState}
        finishSlot={delivery}
        finishConfirmationActive={humanConfirmationActive || codexConfirmationActive}
        onFinishReview={() => props.api.finish()}
        onDiscardReview={() => props.api.discard()}
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
        onCommand={async (command) => {
          const result = await props.api.command(command);
          const next = "accepted" in result ? result.state : result;
          setState(next);
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
    </main>
  );
}
