import { createRoot } from 'react-dom/client';
import { useRef, useState, useSyncExternalStore } from 'react';
import { PdfZoomMode } from '@embedpdf/models';

import {
  ReviewShell,
  type RejectedReviewCommand,
} from '../../../apps/web/src/app/ReviewShell.js';
import { projectReviewItems } from '../../../apps/web/src/review/annotation-projection.js';
import { inventoryExistingAnnotations } from '../../../apps/web/src/pdf/existing-annotations.js';
import type { CaretAnchor, SelectionAnchor } from '../../../apps/web/src/pdf/selection-anchor.js';
import {
  VIEWER_ZOOM_MAX_PERCENT,
  VIEWER_ZOOM_MIN_PERCENT,
  type ViewerControls,
  type ViewerControlsSnapshot,
} from '../../../apps/web/src/pdf/viewer-controls.js';
import type { ViewerInteractionListener } from '../../../apps/web/src/pdf/viewer-interaction-events.js';
import type { PdfOutlineDiscovery } from '../../../apps/web/src/pdf/pdf-outline.js';
import type { PdfViewerNavigation } from '../../../apps/web/src/pdf/viewer-navigation-adapter.js';
import {
  createReferenceNavigationState,
  reduceReferenceNavigation,
  type ReferenceNavigationState,
} from '../../../apps/web/src/review/reference-navigation-state.js';
import { createReviewState, type ReviewCommand, type ReviewState } from '../../../packages/core/src/review-model.js';
import { reduceReview } from '../../../packages/core/src/review-reducer.js';
import { resolveVisualScenario, VisualDocument } from './visual-scenarios.js';

const root = document.querySelector('#root');
if (!root) throw new Error('Review harness root is missing');
const visualScenario = resolveVisualScenario(window.location.search);
if (visualScenario) root.setAttribute('data-production-root', 'true');

const selection: SelectionAnchor = {
  pageIndex: 0,
  quote: 'unique equilibrium',
  prefix: 'the ',
  suffix: ' exists',
  rect: { x: 72, y: 92, width: 120, height: 14 },
  segmentRects: [{ x: 72, y: 92, width: 120, height: 14 }],
  reliable: true,
};
const caret: CaretAnchor = {
  pageIndex: 0,
  position: { x: 192, y: 92, width: 2, height: 14 },
  leftContext: 'the unique equilibrium',
  rightContext: ' exists',
  reliable: true,
};

interface HarnessViewerControls extends ViewerControls {
  readonly pageCommands: string[];
  readonly directPageRequests: number[];
  readonly zoomCommands: string[];
  readonly directZoomRequests: number[];
  readonly fitWidthRequests: string[];
  pageRequestsSnapshot(): string;
  zoomRequestsSnapshot(): string;
  subscribePageRequests(listener: () => void): () => void;
  subscribeZoomRequests(listener: () => void): () => void;
  fitToWidth(): void;
  makePageControlsUnavailable(): void;
  makeZoomControlsUnavailable(): void;
}

function createHarnessViewerControls(): HarnessViewerControls {
  const listeners = new Set<ViewerInteractionListener>();
  const pageRequestListeners = new Set<() => void>();
  const zoomRequestListeners = new Set<() => void>();
  const pageCommands: string[] = [];
  const directPageRequests: number[] = [];
  const zoomCommands: string[] = [];
  const directZoomRequests: number[] = [];
  const fitWidthRequests: string[] = [];
  let state: ViewerControlsSnapshot = {
    ready: true,
    pageReady: true,
    zoomReady: true,
    currentPage: 3,
    totalPages: 12,
    zoomPercent: 110,
  };

  const publishPage = (currentPage: number) => {
    queueMicrotask(() => {
      if (!state.pageReady) return;
      state = { ...state, currentPage };
      for (const listener of listeners) {
        listener({ type: 'page', currentPage, totalPages: state.totalPages });
      }
    });
  };
  const publishZoom = (zoomPercent: number) => {
    queueMicrotask(() => {
      if (!state.zoomReady) return;
      state = { ...state, zoomPercent };
      for (const listener of listeners) listener({ type: 'zoom', zoomPercent });
    });
  };

  return {
    pageCommands,
    directPageRequests,
    zoomCommands,
    directZoomRequests,
    fitWidthRequests,
    pageRequestsSnapshot: () => directPageRequests.join(','),
    zoomRequestsSnapshot: () => [
      `direct:${directZoomRequests.join('|')}`,
      `commands:${zoomCommands.join('|')}`,
      `fit:${fitWidthRequests.join('|')}`,
    ].join(';'),
    subscribePageRequests(listener) {
      pageRequestListeners.add(listener);
      return () => {
        pageRequestListeners.delete(listener);
      };
    },
    subscribeZoomRequests(listener) {
      zoomRequestListeners.add(listener);
      return () => {
        zoomRequestListeners.delete(listener);
      };
    },
    snapshot: () => state,
    previousPage() {
      if (!state.pageReady || state.currentPage <= 1) return;
      const destination = state.currentPage - 1;
      pageCommands.push(`previous:${destination}`);
      publishPage(destination);
    },
    nextPage() {
      if (!state.pageReady || state.currentPage >= state.totalPages) return;
      const destination = state.currentPage + 1;
      pageCommands.push(`next:${destination}`);
      publishPage(destination);
    },
    goToPage(pageNumber) {
      directPageRequests.push(pageNumber);
      for (const listener of pageRequestListeners) listener();
      if (
        !state.pageReady
        || !Number.isSafeInteger(pageNumber)
        || pageNumber < 1
        || pageNumber > state.totalPages
      ) return;
      pageCommands.push(`go:${pageNumber}`);
      publishPage(pageNumber);
    },
    zoomOut() {
      if (!state.zoomReady) return;
      const destination = state.zoomPercent - 10;
      zoomCommands.push(`out:${destination}`);
      for (const listener of zoomRequestListeners) listener();
      publishZoom(destination);
    },
    zoomIn() {
      if (!state.zoomReady) return;
      const destination = state.zoomPercent + 10;
      zoomCommands.push(`in:${destination}`);
      for (const listener of zoomRequestListeners) listener();
      publishZoom(destination);
    },
    zoomToPercent(zoomPercent) {
      directZoomRequests.push(zoomPercent);
      for (const listener of zoomRequestListeners) listener();
      if (
        !state.zoomReady
        || !Number.isSafeInteger(zoomPercent)
        || zoomPercent < VIEWER_ZOOM_MIN_PERCENT
        || zoomPercent > VIEWER_ZOOM_MAX_PERCENT
      ) return;
      zoomCommands.push(`go:${zoomPercent}`);
      publishZoom(zoomPercent);
    },
    fitToWidth() {
      if (!state.zoomReady) return;
      fitWidthRequests.push('fit');
      zoomCommands.push('fit:88');
      for (const listener of zoomRequestListeners) listener();
      publishZoom(88);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({ type: 'readiness', ready: state.ready });
      return () => {
        listeners.delete(listener);
      };
    },
    makePageControlsUnavailable() {
      const unavailableReason = 'Some viewer controls are unavailable in this harness state.';
      state = {
        ...state,
        ready: false,
        pageReady: false,
        currentPage: 0,
        totalPages: 0,
        pageUnavailableReason: 'Page controls are unavailable in this harness state.',
        unavailableReason,
      };
      for (const listener of listeners) {
        listener({ type: 'readiness', ready: false, reason: unavailableReason });
      }
    },
    makeZoomControlsUnavailable() {
      const unavailableReason = 'Some viewer controls are unavailable in this harness state.';
      state = {
        ...state,
        ready: false,
        zoomReady: false,
        zoomPercent: 0,
        zoomUnavailableReason: 'Zoom controls are unavailable in this harness state.',
        unavailableReason,
      };
      for (const listener of listeners) {
        listener({ type: 'readiness', ready: false, reason: unavailableReason });
      }
    },
    dispose() {
      listeners.clear();
      pageRequestListeners.clear();
      zoomRequestListeners.clear();
    },
  };
}

function createHarnessViewerNavigation(
  controls: HarnessViewerControls,
): PdfViewerNavigation {
  return {
    captureLocation: () => null,
    applyLocation: async () => false,
    fitToWidth: async (waitForSettledGeometry) => {
      if (waitForSettledGeometry) {
        await waitForSettledGeometry(new AbortController().signal);
      }
      controls.fitToWidth();
      return true;
    },
    fitToWidthReady: () => true,
    resolveTarget: () => null,
    captureDocumentOrderPages: () => [],
    applyTarget: async () => false,
    cancelPendingNavigation: async () => undefined,
    replaceDocument: () => undefined,
    focusAtDestination: () => false,
    dispose: () => undefined,
  };
}

function activateVisualReference(
  state: ReferenceNavigationState,
  identity: string,
): ReferenceNavigationState {
  const tab = state.tabs.find((candidate) => candidate.identity === identity);
  if (!tab) return state;
  return reduceReferenceNavigation(state, {
    type: 'open-reference',
    target: tab.originalTarget,
    settledLocation: tab.settledLocation,
    ...(tab.label === undefined ? {} : { label: tab.label }),
    ...(tab.pageContext === undefined ? {} : { pageContext: tab.pageContext }),
  });
}

function Harness() {
  const [state, setState] = useState(() => visualScenario?.state ?? createReviewState({
    sessionId: 'acceptance',
    source: { fileId: 'source', digest: 'a'.repeat(64), byteLength: 100 },
  }));
  const [anchorKind, setAnchorKind] = useState<'selection' | 'caret' | 'none'>(
    visualScenario ? (visualScenario.name === 'contextual' ? 'selection' : 'none') : 'selection',
  );
  const [selectionGeneration, setSelectionGeneration] = useState(0);
  const [visualReferenceNavigation, setVisualReferenceNavigation] = useState(
    visualScenario?.referenceNavigation,
  );
  const [harnessReferenceNavigation, setHarnessReferenceNavigation] = useState(
    () => createReferenceNavigationState(0),
  );
  const anchorKindRef = useRef(anchorKind);
  anchorKindRef.current = anchorKind;
  const selectionGenerationRef = useRef(selectionGeneration);
  selectionGenerationRef.current = selectionGeneration;
  const [rejectNextCommand, setRejectNextCommand] = useState(false);
  const [holdNextCommand, setHoldNextCommand] = useState(false);
  const commandReleaseRef = useRef<(() => void) | null>(null);
  const [navigated, setNavigated] = useState('none');
  const [pageMenuOpen, setPageMenuOpen] = useState(visualScenario?.pageMenuOpen ?? false);
  const [keyboardPageNoteActive, setKeyboardPageNoteActive] = useState(false);
  const [placedPageNote, setPlacedPageNote] = useState<{ token: number; pageIndex: number; position: { x: number; y: number; width: number; height: number }; nearbyText: string } | null>(null);
  const [correspondingItemId, setCorrespondingItemId] = useState<string | undefined>(visualScenario?.correspondingItemId);
  const [activeItemId, setActiveItemId] = useState<string>();
  const [activationRequest, setActivationRequest] = useState<{ id: string; token: number }>();
  const [outlineDiscovery, setOutlineDiscovery] = useState<PdfOutlineDiscovery>({
    status: 'loading',
    documentGeneration: 0,
  });
  const viewerControlsRef = useRef<HarnessViewerControls | undefined>(undefined);
  if (viewerControlsRef.current === undefined) {
    viewerControlsRef.current = createHarnessViewerControls();
  }
  const viewerControls = viewerControlsRef.current;
  const viewerNavigationRef = useRef<PdfViewerNavigation | undefined>(undefined);
  if (viewerNavigationRef.current === undefined) {
    viewerNavigationRef.current = createHarnessViewerNavigation(viewerControls);
  }
  const viewerState = useSyncExternalStore(viewerControls.subscribe, viewerControls.snapshot);
  const directPageRequests = useSyncExternalStore(
    viewerControls.subscribePageRequests,
    viewerControls.pageRequestsSnapshot,
  );
  const zoomRequests = useSyncExternalStore(
    viewerControls.subscribeZoomRequests,
    viewerControls.zoomRequestsSnapshot,
  );

  const accept = async (command: ReviewCommand): Promise<ReviewState | RejectedReviewCommand> => {
    await Promise.resolve();
    if (holdNextCommand) {
      setHoldNextCommand(false);
      await new Promise<void>((resolve) => { commandReleaseRef.current = resolve; });
      commandReleaseRef.current = null;
    }
    if (rejectNextCommand) {
      setRejectNextCommand(false);
      return { accepted: false, state, message: 'Review changed elsewhere. Try again.' };
    }
    const next = reduceReview(state, command);
    setState(next);
    return next;
  };

  const shell = (
    <ReviewShell
      state={state}
      {...(visualScenario ? {
        documentTitle: visualScenario.documentTitle,
        savedLabel: "Saved",
        listOpen: visualScenario.listOpen,
        viewerState: visualScenario.viewerState,
        existingAnnotations: visualScenario.existingAnnotations,
        annotationOutlineLabels: visualScenario.annotationOutlineLabels,
        outlineDiscovery: visualScenario.outlineDiscovery,
        currentOutlineItemId: visualScenario.currentOutlineItemId,
        referenceTabs: visualScenario.referenceTabs,
        ...(visualReferenceNavigation === undefined ? {} : {
          navigationState: visualReferenceNavigation,
          onWorkspaceModeChange: (mode) => setVisualReferenceNavigation((current) => (
            current === undefined
              ? current
              : reduceReferenceNavigation(current, { type: 'select-workspace-mode', mode })
          )),
          onReferenceTabActivate: (identity) => setVisualReferenceNavigation((current) => (
            current === undefined ? current : activateVisualReference(current, identity)
          )),
        }),
      } : {})}
      {...(visualScenario ? {} : {
        navigationState: harnessReferenceNavigation,
        onWorkspaceModeChange: (mode) => setHarnessReferenceNavigation((current) => (
          reduceReferenceNavigation(current, { type: 'select-workspace-mode', mode })
        )),
      })}
      {...(visualScenario ? {} : { viewerControls, viewerState, outlineDiscovery })}
      viewerNavigation={viewerNavigationRef.current}
      selectionUpdate={anchorKind === 'selection'
        ? { kind: 'reliable', generation: selectionGeneration, anchor: selection }
        : { kind: 'cleared', generation: selectionGeneration }}
      caretAnchor={anchorKind === 'caret' ? caret : null}
      selectionPlacement={anchorKind === 'selection' ? { left: 240, top: 120, suggestTop: false } : null}
      caretPlacement={anchorKind === 'caret' ? { left: 240, top: 120, suggestTop: true } : null}
      pageMenu={pageMenuOpen ? {
        invocationId: 'harness-menu',
        placement: { left: 300, top: 220 },
        pageIndex: 0,
        position: { x: 300, y: 220, width: 18, height: 18 },
        nearbyText: 'nearby paragraph',
      } : null}
      placedPageNote={placedPageNote}
      keyboardPageNoteActive={keyboardPageNoteActive}
      onRequestKeyboardPageNote={() => setKeyboardPageNoteActive(true)}
      onCancelKeyboardPageNote={() => setKeyboardPageNoteActive(false)}
      onPageMenuDismiss={() => setPageMenuOpen(false)}
      onPageMenuConsumed={() => setPageMenuOpen(false)}
      onPlacedPageNoteConsumed={() => setPlacedPageNote(null)}
      onSelectionConsumed={(generation) => {
        if (anchorKindRef.current === 'selection' && selectionGenerationRef.current === generation) {
          setAnchorKind('none');
        }
      }}
      onCommand={accept}
      onNavigate={(item) => setNavigated(item.id)}
      {...(correspondingItemId === undefined ? {} : { correspondingItemId })}
      {...(activationRequest === undefined ? {} : { activationRequest })}
      onItemCorrespondenceChange={setCorrespondingItemId}
      onActiveItemChange={setActiveItemId}
      existingAnnotations={visualScenario?.existingAnnotations ?? {
        status: 'ready',
        generation: 1,
        items: inventoryExistingAnnotations([{
          id: 'source-highlight',
          subtype: 'Highlight',
          pageIndex: 0,
          rect: { x: 72, y: 92, width: 120, height: 14 },
          contents: 'Source comment',
        }]),
      }}
      onNavigateExisting={(item) => setNavigated(`source:${item.id}`)}
    >
      {visualScenario ? (
        <VisualDocument items={state.items} onCorrespondenceChange={setCorrespondingItemId} />
      ) : <div>
        <button type="button" onClick={() => {
          setSelectionGeneration((generation) => generation + 1);
          setAnchorKind('selection');
        }}>Use selection</button>
        <button type="button" onClick={() => setAnchorKind('caret')}>Use caret</button>
        <button type="button" onClick={() => setAnchorKind('none')}>Clear anchors</button>
        <button type="button" onClick={() => setRejectNextCommand(true)}>Reject next command</button>
        <button type="button" onClick={() => setHoldNextCommand(true)}>Hold next command</button>
        <button type="button" onClick={() => commandReleaseRef.current?.()}>Release command</button>
        <button type="button" onClick={() => setPageMenuOpen(true)}>Open page actions</button>
        <button type="button" onClick={() => setOutlineDiscovery({
          status: 'loaded-tree',
          documentGeneration: 0,
          items: [{
            id: 'harness-outline',
            label: 'Harness section',
            pageContext: 'Page 1',
            target: {
              documentGeneration: 0,
              pageIndex: 0,
              zoom: { mode: PdfZoomMode.FitPage, params: [] },
              identity: 'harness-outline-target',
            },
            children: [],
          }],
        })}>Set outline tree</button>
        <button type="button" onClick={() => setOutlineDiscovery({
          status: 'loaded-empty',
          documentGeneration: 0,
        })}>Set outline empty</button>
        <button type="button" onClick={() => setHarnessReferenceNavigation((current) => (
          reduceReferenceNavigation(current, {
            type: 'open-reference',
            target: {
              documentGeneration: 0,
              pageIndex: 0,
              zoom: { mode: PdfZoomMode.XYZ, params: [72, 120, 1] },
              identity: 'harness-reference',
            },
            settledLocation: {
              pageIndex: 0,
              anchor: { x: 72, y: 120 },
              alignment: { xPercent: 50, yPercent: 20 },
              zoom: 1,
            },
            label: 'Harness reference',
            pageContext: 'Page 1',
          })
        ))}>Open harness reference</button>
        <button type="button" onClick={() => viewerControls.makePageControlsUnavailable()}>
          Make page controls unavailable
        </button>
        <button type="button" onClick={() => viewerControls.makeZoomControlsUnavailable()}>
          Make zoom controls unavailable
        </button>
        {keyboardPageNoteActive ? (
          <button type="button" onClick={() => {
            setKeyboardPageNoteActive(false);
            setPlacedPageNote({
              token: Date.now(),
              pageIndex: 0,
              position: { x: 300, y: 220, width: 18, height: 18 },
              nearbyText: 'nearby paragraph',
            });
          }}>Place Page Note</button>
        ) : null}
        <div role="application" aria-label="PDF review canvas" tabIndex={0}>PDF page</div>
        <label>
          Native input
          <input aria-label="Native input" defaultValue="native input" />
        </label>
        <label>
          Native textarea
          <textarea aria-label="Native textarea" defaultValue="native textarea" />
        </label>
        <div contentEditable suppressContentEditableWarning role="textbox" aria-label="Contenteditable editor">
          contenteditable text
        </div>
        <div data-review-editor>
          <div contentEditable suppressContentEditableWarning role="textbox" aria-label="Review editor">
            review editor text
          </div>
        </div>
        <div aria-label="Owned annotation overlays" data-owned-annotation-layer>
          {projectReviewItems(state.items).map((annotation) => (
            <span key={annotation.id}>
              <span
                data-owned-mark={annotation.kind}
                data-active={activeItemId === annotation.id ? 'true' : 'false'}
                data-corresponding={correspondingItemId === annotation.id ? 'true' : 'false'}
              >{annotation.contents}</span>
              <button
                type="button"
                data-owned-focus-id={annotation.id}
                aria-label={`${annotation.kind} annotation on page ${annotation.pageIndex + 1}`}
                onPointerEnter={() => setCorrespondingItemId(annotation.id)}
                onPointerLeave={() => setCorrespondingItemId(undefined)}
                onFocus={() => setCorrespondingItemId(annotation.id)}
                onBlur={() => setCorrespondingItemId(undefined)}
                onClick={() => {
                  setActiveItemId(annotation.id);
                  setActivationRequest({ id: annotation.id, token: Date.now() });
                }}
              >Inspect mark</button>
            </span>
          ))}
        </div>
        <output
          data-revision={state.revision}
          data-kinds={state.items.map(({ kind }) => kind).join(',')}
          data-navigated={navigated}
          data-anchor-kind={anchorKind}
          data-viewer-page-commands={viewerControls.pageCommands.join(',')}
          data-viewer-page-requests={directPageRequests}
          data-viewer-zoom-requests={zoomRequests}
        >
          Revision {state.revision}
        </output>
      </div>}
    </ReviewShell>
  );

  return visualScenario
    ? <main data-production-review data-visual-scene={visualScenario.name}>{shell}</main>
    : shell;
}

createRoot(root).render(<Harness />);
