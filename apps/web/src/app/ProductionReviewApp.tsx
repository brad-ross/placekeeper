import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PluginRegistry } from "@embedpdf/core";
import { ScrollPlugin } from "@embedpdf/plugin-scroll";

import type { ReviewCommand, ReviewItemKind, ReviewState } from "../../../../packages/core/src/review-model.js";
import type { CaretAnchor, SelectionAnchor } from "../pdf/selection-anchor.js";
import {
  acceptSelectionUpdate,
  INITIAL_SELECTION_UPDATE,
  reliableSelection,
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

function caretFromSelection(anchor: SelectionAnchor | null): CaretAnchor | null {
  if (anchor === null) return null;
  const boundary = anchor.segmentRects.at(-1);
  if (boundary === undefined) return null;
  return {
    pageIndex: anchor.pageIndex,
    position: {
      x: boundary.x + boundary.width,
      y: boundary.y,
      width: 2,
      height: boundary.height,
    },
    leftContext: `${anchor.prefix}${anchor.quote}`,
    rightContext: anchor.suffix,
    reliable: true,
  };
}

export function ProductionReviewApp(props: ProductionReviewAppProps) {
  const [state, setState] = useState(props.initialState);
  const [tool, setTool] = useState<ReviewItemKind>("replace");
  const [selectionUpdate, setSelectionUpdate] = useState<SelectionUpdate>(INITIAL_SELECTION_UPDATE);
  const [toolError, setToolError] = useState<string | null>(null);
  const [confirmedScope, setConfirmedScope] = useState<string | null>(null);
  const [pagePoint, setPagePoint] = useState<{
    readonly pageIndex: number;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const latestReceipt = useRef<string | null>(null);
  const viewerRegistry = useRef<PluginRegistry | null>(null);
  const viewerControlsRef = useRef<ViewerControls | undefined>(undefined);
  const [viewerState, setViewerState] = useState<ViewerControlsSnapshot>(unavailableViewerControls);
  const selection = reliableSelection(selectionUpdate);
  const caret = useMemo(() => caretFromSelection(selection), [selection]);
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
  useEffect(() => () => viewerControlsRef.current?.dispose(), []);
  const viewer = props.viewer ?? (
    <App
      embeddedInReviewShell
      assets={viewerAssets}
      documentTitle={props.scope.documentTitle}
      toolError={readinessMessage ?? toolError}
      onSelectionUpdate={onSelectionUpdate}
      ownedAnnotations={ownedAnnotations}
      onPagePoint={setPagePoint}
      onViewerInitialized={async (registry) => {
        viewerRegistry.current = registry;
        viewerControlsRef.current?.dispose();
        const controls = createViewerControls(registry);
        viewerControlsRef.current = controls;
        setViewerState(controls.snapshot());
        controls.subscribe(() => setViewerState(controls.snapshot()));
      }}
    />
  );

  const delivery = (
    <div className="review-delivery-content">
      <HumanDelivery
        state={state}
        onSave={() => props.api.saveReviewedCopy()}
        onReplaceOriginal={() => props.api.replaceOriginal()}
        onFinish={() => props.api.finish()}
        onDiscard={() => props.api.discard()}
      />
      <CodexDelivery
        state={state}
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
        currentTool={tool}
        {...(viewerControlsRef.current === undefined ? {} : { viewerControls: viewerControlsRef.current })}
        viewerState={viewerState}
        finishSlot={delivery}
        selectionUpdate={selectionUpdate}
        caretAnchor={caret}
        pageNoteAnchor={pagePoint === null ? null : {
          pageIndex: pagePoint.pageIndex,
          position: { x: pagePoint.x, y: pagePoint.y, width: 18, height: 18 },
        }}
        onToolChange={setTool}
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
      >
        {viewer}
      </ReviewShell>
    </main>
  );
}
