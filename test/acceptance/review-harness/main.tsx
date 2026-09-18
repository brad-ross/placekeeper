import type { ReviewCommandInvocation } from '../../../apps/web/src/review/review-command-surface.js';
import type { RejectedReviewCommand } from '../../../apps/web/src/review/review-command-result.js';
import { createRoot } from 'react-dom/client';
import { ProductionReviewApp } from '../../../apps/web/src/app/ProductionReviewApp.js';
import type { ProductionSessionApi } from '../../../apps/web/src/host/session-contracts.js';
import { RuntimeProductionReviewApp } from '../../../apps/web/src/production-entry.js';
import type { HostRuntime, HostRuntimeBootstrap } from '../../../apps/web/src/host/runtime.js';
import { MemoryReviewLocationHistory } from '../../../apps/web/src/review/review-location-history.js';
import { createPortal } from 'react-dom';
import { useRef, useState, useSyncExternalStore } from 'react';
import { PdfZoomMode } from '@embedpdf/models';

import {
  ReviewShell,
} from '../../../apps/web/src/app/ReviewShell.js';
import { SaveDestinationDialog } from '../../../apps/web/src/save/SaveDestinationDialog.js';
import { CommentComposer } from '../../../apps/web/src/review/CommentComposer.js';
import { PdfSearchWorkspace } from '../../../apps/web/src/review/PdfSearchWorkspace.js';
import { initialPdfSearchState } from '../../../apps/web/src/pdf/pdf-search-model.js';
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
import type { PdfTargetVisibility } from '../../../apps/web/src/pdf/viewer-navigation.js';
import type { PdfViewerNavigation } from '../../../apps/web/src/pdf/viewer-navigation-adapter.js';
import {
  createReferenceNavigationState,
  reduceReferenceNavigation,
  type ReferenceNavigationState,
} from '../../../apps/web/src/review/reference-navigation-state.js';
import { createReviewState, type ReviewCommand, type ReviewState } from '../../../packages/core/src/review-model.js';
import { addPageNote, removeReviewItem } from '../../../packages/core/src/review-commands.js';
import { reduceReview } from '../../../packages/core/src/review-reducer.js';
import { resolveVisualScenario, VisualDocument } from './visual-scenarios.js';

const root = document.querySelector('#root');
if (!root) throw new Error('Review harness root is missing');
const rootElement = root;
rootElement.setAttribute('data-authoring-preview-updates', '0');
const visualScenario = resolveVisualScenario(window.location.search);
const previewParameters = new URLSearchParams(window.location.search);
const responsiveFullChrome = previewParameters.get('responsive') === 'full';
const saveEstablishing = previewParameters.has('establishing');
const reconciliationPreview = previewParameters.get('reconciliation');
const exportPreview = previewParameters.get('export');
const nativeCommandsPreview = previewParameters.has('native-commands');
const hostExportPreview = previewParameters.has('host-export');
const requestedRefreshPreview = previewParameters.get('refresh');
const refreshPreview = requestedRefreshPreview === 'reconciling' || requestedRefreshPreview === 'failed'
  ? requestedRefreshPreview
  : 'idle';
const composerPreview = previewParameters.get('composer');
const composerSavePreview = previewParameters.get('composer-save');
const requestedComposerReturn = previewParameters.get('return');
const composerReturnPreview = requestedComposerReturn === 'outside'
  || requestedComposerReturn === 'unavailable'
  || requestedComposerReturn === 'pending'
  ? requestedComposerReturn
  : 'visible';
const composerReturnVisibility: PdfTargetVisibility = composerReturnPreview === 'pending'
  ? 'outside'
  : composerReturnPreview;
const composerPreviewTitles: Readonly<Record<string, string>> = {
  replacement: 'Replacement',
  insertion: 'Insertion',
  highlight: 'Highlight Comment',
  'page-note': 'Page Note',
  'edit-highlight': 'Edit Highlight',
  'edit-page-note': 'Edit Page Note',
  'edit-replacement': 'Edit Replacement',
  'edit-insertion': 'Edit Insertion',
};
if (visualScenario) root.setAttribute('data-production-root', 'true');
if (composerPreview && composerPreviewTitles[composerPreview]) {
  document.title = `${composerPreviewTitles[composerPreview]} — Composer preview`;
}

function ComposerPreview({ name }: { readonly name: string }) {
  const deferredSave = useRef<(() => void) | null>(null);
  const onSave = composerSavePreview === 'deferred'
    ? () => new Promise<void>((resolve) => { deferredSave.current = resolve; })
    : async () => undefined;
  if (composerSavePreview === 'deferred') {
    Reflect.set(globalThis, 'resolveDeferredComposerSave', () => deferredSave.current?.());
  }
  const common = {
    onSave,
    onDismiss: () => undefined,
    anchorNavigation: {
      visibility: composerReturnVisibility,
      pending: composerReturnPreview === 'pending',
      onReturn: () => undefined,
    },
  };
  switch (name) {
    case 'replacement':
      return <CommentComposer title="Replacement" fieldLabel="Replacement" saveLabel="Apply" allowWhitespace {...common} />;
    case 'insertion':
      return <CommentComposer title="Insertion" fieldLabel="Insertion" saveLabel="Apply" allowWhitespace {...common} />;
    case 'highlight':
      return <CommentComposer title="Highlight Comment" optional {...common} />;
    case 'page-note':
      return <CommentComposer title="Page Note" {...common} />;
    case 'edit-highlight':
      return <CommentComposer title="Edit Highlight" saveLabel="Apply" initialValue="Check the identification claim." optional {...common} />;
    case 'edit-page-note':
      return <CommentComposer title="Edit Page Note" saveLabel="Apply" initialValue="Add a cross-reference to the appendix." {...common} />;
    case 'edit-replacement':
      return <CommentComposer title="Edit Replacement" fieldLabel="Replacement" saveLabel="Apply" allowWhitespace initialValue="admits a locally unique equilibrium" {...common} />;
    case 'edit-insertion':
      return <CommentComposer title="Edit Insertion" fieldLabel="Insertion" saveLabel="Apply" allowWhitespace initialValue="under the maintained assumptions" {...common} />;
    default:
      return null;
  }
}

function SearchPreview() {
  const [query, setQuery] = useState('');
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  const excerpts = [
    'A more precise signal reduces uncertainty about the value of each alternative.',
    'The signal distribution varies across consumers.',
    'We estimate the signal parameters jointly.',
  ];
  const results = query.trim() ? excerpts.map((excerpt, index) => ({
    id: `canonical-search-${index}`, pageIndex: [3, 5, 9][index]!, charIndex: 0,
    charCount: 6, navigationPoint: { x: 72, y: 120 }, rects: [], excerpt,
    excerptMatch: { start: excerpt.indexOf('signal'), length: 6 }, kind: 'exact' as const, matchedForm: 'signal',
  })) : [];
  return <PdfSearchWorkspace
    state={{ ...initialPdfSearchState(28), query, selectedResultId,
      status: results.length ? 'results' : 'idle',
      groups: results.length ? [{ id: 'exact', label: 'Exact matches', results }] : [],
    }}
    onQueryChange={setQuery} onAlternativeActivate={(alternative) => setQuery(alternative.query)}
    onResultActivate={(result) => setSelectedResultId(result.id)} onResultOpenReference={() => undefined}
    copyLinkForResult={(result) => ({ getLink: () => `placekeeper:///tmp/Paper.pdf#v=1&page=${result.pageIndex + 1}`, writeText: async () => undefined })}
  />;
}

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

function createReconciliationPreviewState(variant = 'default'): ReviewState {
  const state = createReviewState({
    sessionId: '00000000-0000-4000-8000-000000000201',
    source: {
      fileId: '00000000-0000-4000-8000-000000000202',
      digest: 'c'.repeat(64),
      byteLength: 120,
    },
    workflowMode: 'generated-output',
    documentGeneration: 2,
  });
  if (variant === 'ready') return state;
  if (variant === 'stale') {
    return {
      ...state,
      workflow: { ...state.workflow, freshness: 'possibly-stale' },
    };
  }
  const anchor = {
    kind: 'selection' as const,
    pageIndex: 0,
    quote: 'the previous identification argument',
    prefix: 'Review ',
    suffix: ' carefully.',
    rect: { x: 72, y: 92, width: 180, height: 14 },
    segmentRects: [{ x: 72, y: 92, width: 180, height: 14 }],
  };
  if (variant === 'pending-draft') {
    return {
      ...state,
      pendingDrafts: [{
        id: '00000000-0000-4000-8000-000000000207',
        ownerViewId: 'harness-view',
        baseGeneration: 2,
        revision: 0,
        kind: 'highlight',
        pageIndex: 0,
        text: 'Keep this pending annotation for review.',
        anchor,
        disposition: { kind: 'missing', reason: 'The previous passage is not present in this PDF.' },
        status: 'frozen',
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
      }],
    };
  }
  if (variant === 'page-notes') {
    const pageAnchor = {
      kind: 'page' as const,
      pageIndex: 2,
      rect: { x: 420, y: 620, width: 24, height: 24 },
    };
    return {
      ...state,
      items: [{
        id: '00000000-0000-4000-8000-000000000205',
        kind: 'pageNote',
        pageIndex: 2,
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
        payload: { ...pageAnchor, position: pageAnchor.rect, comment: 'Check the full-page comparison.' },
        reconciliation: {
          schemaVersion: 1,
          ownerViewId: 'harness-view',
          baseGeneration: 1,
          revision: 1,
          anchor: pageAnchor,
          disposition: { kind: 'missing', reason: 'The prior page context is unavailable.' },
          previousAnchors: [],
        },
      }, {
        id: '00000000-0000-4000-8000-000000000206',
        kind: 'pageNote',
        pageIndex: 3,
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
        payload: { ...pageAnchor, pageIndex: 3, position: pageAnchor.rect, comment: 'Verify the appendix transition.' },
        reconciliation: {
          schemaVersion: 1,
          ownerViewId: 'harness-view',
          baseGeneration: 1,
          revision: 1,
          anchor: { ...pageAnchor, pageIndex: 3, nearbyText: 'The appendix extends the comparison.' },
          disposition: { kind: 'missing', reason: 'The prior page context is unavailable.' },
          previousAnchors: [],
        },
      }],
    };
  }
  const unresolvedState: ReviewState = {
    ...state,
    items: [{
      id: '00000000-0000-4000-8000-000000000203',
      kind: 'highlight',
      pageIndex: 0,
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      payload: { ...anchor, reliable: true, comment: 'Check the identifying variation.' },
      reconciliation: {
        schemaVersion: 1,
        ownerViewId: 'harness-view',
        baseGeneration: 1,
        revision: 1,
        anchor,
        disposition: { kind: 'ambiguous', reason: 'Two passages match this previous annotation.' },
        previousAnchors: [],
      },
    }, {
      id: '00000000-0000-4000-8000-000000000204',
      kind: 'delete',
      pageIndex: 1,
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      payload: {
        ...anchor,
        pageIndex: 1,
        quote: 'obsolete robustness sentence',
        reliable: true,
      },
      reconciliation: {
        schemaVersion: 1,
        ownerViewId: 'harness-view',
        baseGeneration: 1,
        revision: 1,
        anchor: { ...anchor, pageIndex: 1, quote: 'obsolete robustness sentence' },
        disposition: { kind: 'missing', reason: 'The previous passage is not present in this PDF.' },
        previousAnchors: [],
      },
    }],
  };
  if (variant !== 'mixed') return unresolvedState;
  return {
    ...unresolvedState,
    items: [...unresolvedState.items, {
      id: '00000000-0000-4000-8000-000000000208',
      kind: 'pageNote',
      pageIndex: 2,
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      payload: {
        position: { x: 420, y: 620, width: 24, height: 24 },
        comment: 'Keep the resolved robustness note visible in the current generation.',
      },
      reconciliation: {
        schemaVersion: 1,
        ownerViewId: 'harness-view',
        baseGeneration: 1,
        revision: 2,
        anchor: {
          kind: 'page',
          pageIndex: 2,
          rect: { x: 420, y: 620, width: 24, height: 24 },
          nearbyText: 'The robustness appendix reports the same sign and magnitude.',
        },
        disposition: { kind: 'resolved', generation: 2 },
        previousAnchors: [],
      },
    }],
  };
}

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
    resolvePageLocation: () => null,
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
    targetVisibility: () => 'unavailable',
    locationVisibility: () => 'unavailable',
    pointVisibility: () => 'unavailable',
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
  const [state, setState] = useState(() => reconciliationPreview !== null
    ? createReconciliationPreviewState(reconciliationPreview)
    : (visualScenario?.state ?? createReviewState({
      sessionId: 'acceptance',
      source: { fileId: 'source', digest: 'a'.repeat(64), byteLength: 100 },
    })));
  const [anchorKind, setAnchorKind] = useState<'selection' | 'caret' | 'none'>(
    visualScenario ? (visualScenario.name === 'contextual' ? 'selection' : 'none') : 'selection',
  );
  const [selectionGeneration, setSelectionGeneration] = useState(0);
  const [visualReferenceNavigation, setVisualReferenceNavigation] = useState(
    visualScenario?.referenceNavigation,
  );
  const [visualReferenceReturn, setVisualReferenceReturn] = useState(
    visualScenario?.referenceReturn ?? null,
  );
  const [visualReferenceViewportHost, setVisualReferenceViewportHost] = useState<HTMLDivElement | null>(null);
  const [harnessReferenceNavigation, setHarnessReferenceNavigation] = useState(
    () => createReferenceNavigationState(reconciliationPreview === null ? 0 : 2),
  );
  const anchorKindRef = useRef(anchorKind);
  anchorKindRef.current = anchorKind;
  const selectionGenerationRef = useRef(selectionGeneration);
  selectionGenerationRef.current = selectionGeneration;
  const [rejectNextCommand, setRejectNextCommand] = useState(false);
  const [holdNextCommand, setHoldNextCommand] = useState(false);
  const commandReleaseRef = useRef<(() => void) | null>(null);
  const [navigated, setNavigated] = useState('none');
  const [existingAnnotationGeneration, setExistingAnnotationGeneration] = useState(1);
  const [pageMenuOpen, setPageMenuOpen] = useState(visualScenario?.pageMenuOpen ?? false);
  const [keyboardPageNoteActive, setKeyboardPageNoteActive] = useState(false);
  const [placedPageNote, setPlacedPageNote] = useState<{ token: number; pageIndex: number; position: { x: number; y: number; width: number; height: number }; nearbyText: string } | null>(null);
  const [correspondingItemId, setCorrespondingItemId] = useState<string | undefined>(visualScenario?.correspondingItemId);
  const [activeItemId, setActiveItemId] = useState<string>();
  const [activationRequest, setActivationRequest] = useState<{ id: string; token: number }>();
  const authoringActiveRef = useRef(false);
  const [nativeInvocation, setNativeInvocation] = useState<ReviewCommandInvocation>({ id: 'zoom-out', token: 0 });
  const [saveDestinationOpen, setSaveDestinationOpen] = useState(false);
  const [exportCount, setExportCount] = useState(0);
  const hostExportSequenceRef = useRef(hostExportPreview ? 1 : 0);
  const [hostExportRequestToken, setHostExportRequestToken] = useState<number | undefined>(
    hostExportPreview ? 1 : undefined,
  );
  const [shellMount, setShellMount] = useState(0);
  const failNextExportRef = useRef(exportPreview === 'fail-once');
  const finishExportRef = useRef<(() => void) | null>(null);
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
      key={shellMount}
      {...(nativeCommandsPreview ? {
        commandModalOpen: saveDestinationOpen,
        commandInvocation: nativeInvocation,
        onCommandSurfaceChange: (snapshot) => {
          rootElement.setAttribute('data-native-command-snapshot', JSON.stringify(snapshot));
        },
      } : {})}
      state={state}
      {...(hostExportRequestToken === undefined ? {} : {
        documentActionsRequestToken: hostExportRequestToken,
        onDocumentActionsRequestHandled: (token: number) => {
          setHostExportRequestToken((current) => current === token ? undefined : current);
        },
      })}
      {...(responsiveFullChrome ? {
        copyLink: {
          getLink: () => 'placekeeper:///tmp/Responsive%20Review.pdf#v=1&page=3',
          writeText: async () => undefined,
        },
        codexContext: { status: 'unbound' as const }
      } : {})}
      {...(visualScenario ? {
        ...(['reading', 'tray', 'outline'].includes(visualScenario.name) ? {
          copyLink: {
            getLink: () => 'placekeeper:///tmp/Visual%20Review.pdf#v=1&page=18',
            writeText: async () => undefined,
          }
        } : {}),
        ...(visualScenario.name === 'tray' ? {
          copyItemLink: {
            getLink: (item) => `placekeeper:///tmp/Visual%20Review.pdf#v=1&page=${item.pageIndex + 1}&item=${item.id}`,
            writeText: async () => undefined,
          }
        } : {})
      } : {})}
      {...(visualScenario ? {
        documentTitle: visualScenario.documentTitle,
        existingAnnotations: visualScenario.existingAnnotations
      } : {})}
      generationRefreshStatus={refreshPreview}
      onNavigate={(item) => setNavigated(item.id)}
      {...(correspondingItemId === undefined ? {} : { correspondingItemId })}
      {...(activationRequest === undefined ? {} : { activationRequest })}
      onItemCorrespondenceChange={setCorrespondingItemId}
      onActiveItemChange={setActiveItemId}
      existingAnnotations={visualScenario?.existingAnnotations ?? {
        status: 'ready',
        generation: existingAnnotationGeneration,
        items: inventoryExistingAnnotations([{
          id: 'source-highlight',
          subtype: 'Highlight',
          pageIndex: 0,
          rect: { x: 72, y: 92, width: 120, height: 14 },
          contents: 'Source comment with enough authored detail to overflow the compact annotation row and prove that opening the imported full annotation reader preserves the main PDF location while showing its complete read-only contents. '.repeat(5),
        }]),
      }}
      onNavigateExisting={(item) => setNavigated(`source:${item.id}`)}
      save={{
        ...(responsiveFullChrome ? {
          savePendingDestination: true
        } : {}),
        saveOptionsOpen: saveDestinationOpen,
        onSaveOptions: () => setSaveDestinationOpen(true),
        ...(visualScenario ? {
          savedLabel: "Saved",
          ...(visualScenario.name === 'save-failure' ? {
            savePhase: 'not-saved' as const,
            saveRecovery: {
              pending: saveEstablishing,
              onRetry: async () => undefined,
              onSaveCopy: () => setSaveDestinationOpen(true),
            }
          } : {})
        } : {}),
        onExportReviewedCopy: async () => {
          setExportCount((count) => count + 1);
          if (exportPreview === 'delayed') {
            await new Promise<void>((resolve) => { finishExportRef.current = resolve; });
          }
          if (failNextExportRef.current) {
            failNextExportRef.current = false;
            throw new Error('Harness export failure');
          }
          return { kind: 'reviewed-copy' };
        },
      }}
      selection={{
        selectionUpdate: anchorKind === 'selection'
          ? { kind: 'reliable', generation: selectionGeneration, anchor: selection }
          : { kind: 'cleared', generation: selectionGeneration },
        caretAnchor: anchorKind === 'caret' ? caret : null,
        selectionPlacement: anchorKind === 'selection' ? { left: 240, top: 120, suggestTop: false } : null,
        caretPlacement: anchorKind === 'caret' ? { left: 240, top: 120, suggestTop: true } : null,
        onSelectionConsumed: (generation) => {
          if (anchorKindRef.current === 'selection' && selectionGenerationRef.current === generation) {
            setAnchorKind('none');
          }
        },
      }}
      authoring={{
        pageMenu: pageMenuOpen ? {
          invocationId: 'harness-menu',
          placement: { left: 300, top: 220 },
          pageIndex: 0,
          position: { x: 300, y: 220, width: 18, height: 18 },
          nearbyText: 'nearby paragraph',
        } : null,
        placedPageNote,
        keyboardPageNoteActive,
        onRequestKeyboardPageNote: () => setKeyboardPageNoteActive(true),
        onCancelKeyboardPageNote: () => setKeyboardPageNoteActive(false),
        onPageMenuDismiss: () => setPageMenuOpen(false),
        onPageMenuConsumed: () => setPageMenuOpen(false),
        onPlacedPageNoteConsumed: () => setPlacedPageNote(null),
        onCommand: accept,
        onAuthoringActiveChange: (active) => { authoringActiveRef.current = active; },
        onAuthoringPreviewChange: (preview) => {
          rootElement.setAttribute(
            'data-authoring-preview-updates',
            String(Number(rootElement.getAttribute('data-authoring-preview-updates') ?? '0') + 1),
          );
          rootElement.querySelectorAll('[data-harness-authoring-preview]').forEach((element) => {
            element.remove();
          });
          const layer = rootElement.querySelector('[data-owned-annotation-layer]');
          const projectedPreview = previewParameters.get('placement') === 'targets'
            ? preview ?? []
            : [];
          for (const annotation of projectedPreview) {
            const rects = annotation.quadPoints ?? [annotation.rect];
            rects.forEach((_rect, index) => {
              const mark = document.createElement('span');
              mark.dataset.harnessAuthoringPreview = '';
              mark.dataset.ownedMark = annotation.kind;
              mark.dataset.reviewId = annotation.reviewItemId ?? annotation.id;
              mark.dataset.previewPage = String(annotation.pageIndex);
              mark.dataset.previewSegment = String(index);
              layer?.append(mark);
            });
          }
        },
      }}
      viewer={{
        ...(visualScenario ? {
          viewerState: visualScenario.viewerState
        } : {}),
        ...(visualScenario ? {} : {
          viewerControls,
          viewerState
        }),
        viewerNavigation: viewerNavigationRef.current,
      }}
      workspace={{
        ...(visualScenario ? {
          ...(visualScenario.name === 'outline' ? {
            copyLinkForOutlineItem: (item) => (
              item.target === null ? undefined : ({
                precision: 'exact' as const,
                getLink: () => `placekeeper:///tmp/Visual%20Review.pdf#v=2&page=${item.target!.pageIndex + 1}&mode=fit-page`,
                writeText: async () => undefined,
              })
            )
          } : {})
        } : {}),
        ...(visualScenario ? {
          ...(previewParameters.get('search') === 'canonical' ? {
            search: <SearchPreview />
          } : {}),
          listOpen: visualScenario.listOpen,
          outlineDiscovery: visualScenario.outlineDiscovery,
          currentOutlineItemId: visualScenario.currentOutlineItemId,
          referenceTabs: visualScenario.referenceTabs,
          onReferenceViewportHost: setVisualReferenceViewportHost,
          referenceReturn: visualReferenceReturn,
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
            onReferenceReturn: () => {
              setVisualReferenceReturn((current) => (
                current === null ? current : { ...current, pending: true }
              ));
              setTimeout(() => {
                setVisualReferenceReturn((current) => (
                  current === null ? current : { ...current, pending: false }
                ));
              }, 50);
            }
          })
        } : {}),
        ...(visualScenario ? {} : {
          navigationState: harnessReferenceNavigation,
          onWorkspaceModeChange: (mode) => setHarnessReferenceNavigation((current) => (
            reduceReferenceNavigation(current, { type: 'select-workspace-mode', mode })
          )),
        }),
        ...(visualScenario ? {} : {
          outlineDiscovery
        }),
      }}
    >
      {visualScenario ? (
        <VisualDocument items={state.items} onCorrespondenceChange={setCorrespondingItemId} />
      ) : <div data-annotation-surface="main">
        <button type="button" onClick={() => {
          setSelectionGeneration((generation) => generation + 1);
          setAnchorKind('selection');
        }}>Use selection</button>
        <button type="button" onClick={() => setAnchorKind('caret')}>Use caret</button>
        <button type="button" onClick={() => setAnchorKind('none')}>Clear anchors</button>
        <button type="button" onClick={() => setRejectNextCommand(true)}>Reject next command</button>
        <button type="button" onClick={() => setHoldNextCommand(true)}>Hold next command</button>
        <button type="button" onClick={() => commandReleaseRef.current?.()}>Release command</button>
        <button type="button" onClick={() => setState((current) => {
          let seeded = current;
          for (let index = 0; index < 16; index += 1) {
            seeded = reduceReview(seeded, addPageNote(
              seeded,
              index % 4,
              { x: 80 + index, y: 120 + (index * 18), width: 18, height: 18 },
              `Seeded note ${index + 1}`,
            ));
          }
          return seeded;
        })}>Seed annotations</button>
        <button type="button" onClick={() => setState((current) => reduceReview(current, addPageNote(
          current,
          2,
          { x: 112, y: 228, width: 18, height: 18 },
          'This long annotation explains the identification concern in enough detail to exceed the compact annotation card. It keeps going so the full annotation reader can present every authored sentence without repeating selected or nearby PDF text, and it gives the workflow harness a stable overflow case for focus and scroll restoration. The fixture deliberately continues well beyond the compact card limit so browser font metrics and workspace width cannot collapse this overflow scenario into exactly three lines.',
        )))}>Seed long annotation</button>
        <button type="button" onClick={() => setState((current) => ({
          ...current,
          source: { ...current.source, digest: 'b'.repeat(64) },
        }))}>Replace source authority</button>
        <button
          type="button"
          onClick={() => setExistingAnnotationGeneration((generation) => generation + 1)}
        >Refresh existing annotations</button>
        <button type="button" onClick={() => setState((current) => {
          const targetItemId = activeItemId
            ?? (navigated !== 'none' && !navigated.startsWith('source:') ? navigated : undefined);
          if (targetItemId === undefined || !current.items.some(({ id }) => id === targetItemId)) {
            return current;
          }
          return reduceReview(current, removeReviewItem(current, targetItemId));
        })}>Remove active annotation</button>
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
            children: [{
              id: 'harness-outline-nested',
              label: 'Harness subsection',
              pageContext: 'Page 2',
              target: null,
              children: [{
                id: 'harness-outline-leaf',
                label: 'Harness detail',
                pageContext: 'Page 3',
                target: null,
                children: [],
              }],
            }],
          }, {
            id: 'supplemental-outline',
            label: 'Supplemental section',
            pageContext: 'Page 4',
            target: null,
            children: [{
              id: 'supplemental-outline-leaf',
              label: 'Supplemental detail',
              pageContext: 'Page 5',
              target: null,
              children: [],
            }],
          }],
        })}>Set outline tree</button>
        <button type="button" onClick={() => setOutlineDiscovery({
          status: 'loaded-empty',
          documentGeneration: 0,
        })}>Set outline empty</button>
        <button type="button" onClick={() => {
          const documentGeneration = harnessReferenceNavigation.documentGeneration + 1;
          setHarnessReferenceNavigation((current) => reduceReferenceNavigation(current, {
            type: 'replace-document',
            documentGeneration,
          }));
          setOutlineDiscovery({ status: 'loading', documentGeneration });
        }}>Begin outline replacement</button>
        <button type="button" onClick={() => {
          const { documentGeneration } = harnessReferenceNavigation;
          setOutlineDiscovery({
            status: 'loaded-tree',
            documentGeneration,
            items: [{
              id: 'replacement-outline',
              label: 'Replacement section',
              pageContext: 'Page 1',
              target: null,
              children: [{
                id: 'replacement-outline-leaf',
                label: 'Replacement detail',
                pageContext: 'Page 2',
                target: null,
                children: [],
              }],
            }],
          });
        }}>Load replacement outline tree</button>
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
                  if (authoringActiveRef.current) return;
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
          data-export-count={exportCount}
          data-pending-drafts={state.pendingDrafts.length}
        >
          Revision {state.revision}
        </output>
        {exportPreview === 'delayed' ? <button type="button" onClick={() => {
          finishExportRef.current?.();
          finishExportRef.current = null;
        }}>Finish harness export</button> : null}
        {hostExportPreview ? <div data-host-export-harness>
          <button
            type="button"
            onClick={() => setHostExportRequestToken(++hostExportSequenceRef.current)}
          >Request host export</button>
          <button type="button" onClick={() => setShellMount((value) => value + 1)}>
            Remount review shell
          </button>
        </div> : null}
      </div>}
    </ReviewShell>
  );

  if (!visualScenario) return <>
    {shell}
    {nativeCommandsPreview ? <div>
      <button onClick={() => setSaveDestinationOpen(true)}>Open sibling save dialog</button>
      {(['zoom-in', 'zoom-out', 'fit-width'] as const).map((id) => <button key={id}
        onClick={() => setNativeInvocation((previous) => ({ id, token: previous.token + 1 }))}>
        Native {id}
      </button>)}
    </div> : null}
    <SaveDestinationDialog
      open={saveDestinationOpen}
      proposal={{ sourceDisposition: 'local', filename: 'acceptance-annotated.pdf', folder: '/tmp' }}
      onConfirm={async () => setSaveDestinationOpen(false)}
      onCancel={() => setSaveDestinationOpen(false)}
      onChooseLocation={async () => undefined}
    />
  </>;
  const visualSaveDestinationOpen = visualScenario.name === 'save-destination'
    || visualScenario.name === 'save-recovery' || saveDestinationOpen;
  return (
    <main data-production-review data-visual-scene={visualScenario.name}>
      {shell}
      {visualReferenceViewportHost !== null && visualReferenceNavigation?.activeTabIdentity
        ? createPortal(
          <div
            data-visual-reference-document
            style={{ height: '100%', overflow: 'auto', padding: '28px', background: 'var(--review-surface-subtle)' }}
          >
            <article
              aria-label="Rendered reference PDF page"
              style={{ boxSizing: 'border-box', width: 'min(520px, 100%)', minHeight: 620, margin: '0 auto', padding: '52px 56px', background: 'var(--review-surface-panel)', border: '1px solid var(--review-border-subtle)', boxShadow: 'var(--review-shadow-page)', color: 'var(--review-ink-primary)', fontFamily: 'Georgia, Times New Roman, serif' }}
            >
              <p style={{ margin: 0, font: '600 10px/1.4 ui-sans-serif, system-ui', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--review-ink-muted)' }}>Reference · Appendix</p>
              <h2 style={{ margin: '18px 0 16px', fontSize: 22 }}>Lemma A.3</h2>
              <p style={{ fontSize: 14, lineHeight: 1.7 }}>The local equilibrium is unique whenever the response map is a contraction on the maintained neighborhood.</p>
              <p style={{ fontSize: 14, lineHeight: 1.7 }}>The proof applies the implicit function theorem after conditioning on the market-level innovation.</p>
            </article>
          </div>,
          visualReferenceViewportHost,
        ) : null}
      {visualSaveDestinationOpen ? (
        <SaveDestinationDialog
          open
          establishing={saveEstablishing}
          proposal={{
            sourceDisposition: 'local',
            filename: 'Identification Strategy — annotated.pdf',
            folder: '/Users/reviewer/Documents/Working Papers',
          }}
          {...(visualScenario.name === 'save-recovery' ? {
            recoveryTarget: 'Identification Strategy — annotated.pdf',
            onRetry: async () => undefined,
            onLocate: async () => undefined,
          } : {})}
          onConfirm={async () => undefined}
          onCancel={() => undefined}
          onChooseLocation={async () => undefined}
        />
      ) : null}
      {composerPreview ? (
        <div
          className="composer-preview-host review-drawer-host"
          data-composer-preview-host
          inert={visualSaveDestinationOpen}
          aria-hidden={visualSaveDestinationOpen ? 'true' : undefined}
        >
          <ComposerPreview name={composerPreview} />
        </div>
      ) : null}
    </main>
  );
}

function HostReattachmentPreview() {
  const [token, setToken] = useState(0);
  const state = useRef(createReconciliationPreviewState('ready')).current;
  const unavailable = async (): Promise<never> => { throw new Error('Unused host fixture operation'); };
  const api = useRef<ProductionSessionApi>({
    command: unavailable, saveStatus: unavailable, saveProposal: unavailable,
    chooseCopy: unavailable, chooseFolder: unavailable, chooseOriginal: unavailable,
    retrySave: unavailable, locateSave: unavailable,
    scope: async () => ({ documentTitle: 'Paper.pdf', launchSurface: 'vscode' }),
  }).current;
  return <>
    <button type="button" style={{ position: 'fixed', bottom: 10, left: 10, zIndex: 1000 }}
      onClick={() => setToken((value) => value + 1)}>Request host reattachment</button>
    <ProductionReviewApp session={{ sessionId: state.sessionId }} initialState={state}
      scope={{ documentTitle: 'Paper.pdf', launchSurface: 'vscode' }} api={api}
      hostReattachRequestToken={token} locationHistory={null}
      viewer={<div aria-label="Host fixture document" />} />
  </>;
}

function DeferredHostHistoryPreview() {
  const fixture = useRef<{
    runtime: HostRuntime;
    release: () => void;
  } | null>(null);
  if (fixture.current === null) {
    const initialState = createReviewState({
      sessionId: '00000000-0000-4000-8000-000000000301',
      source: { fileId: '00000000-0000-4000-8000-000000000302', digest: 'a'.repeat(64), byteLength: 12 },
    });
    const state = { ...initialState, workflow: {
      ...initialState.workflow,
      documentGeneration: previewParameters.has('host-resumed') ? 1 : 0,
    } };
    const scope = { documentTitle: 'reference-navigation.pdf', launchSurface: 'macos' as const };
    const saveStatus = {
      destination: { phase: 'none' as const, generation: 0 as const },
      sync: { phase: 'clean' as const, desiredRevision: 0, savedRevision: 0 },
    };
    const bootstrap: HostRuntimeBootstrap = {
      sessionId: state.sessionId, generation: state.workflow.documentGeneration, revision: state.revision,
      session: { sessionId: state.sessionId }, state, scope, saveStatus,
      viewerAssets: {
        documentUrl: '/test/fixtures/pdfs/reference-navigation.pdf',
        pdfiumWasm: '/dist/web/pdfium.wasm', workerUrl: '/dist/web/pdfium-worker.js',
      },
      resourcePolicy: { host: 'browser', origin: window.location.origin },
      locationHistory: new MemoryReviewLocationHistory(),
    };
    let release!: () => void;
    const ready = new Promise<HostRuntimeBootstrap>((resolve) => { release = () => resolve(bootstrap); });
    const unavailable = async (): Promise<never> => { throw new Error('Unused host history fixture operation'); };
    fixture.current = {
      release,
      runtime: {
        host: 'macos', bootstrap: () => ready, subscribeInvalidations: () => () => undefined,
        scope: async () => scope, saveStatus: async () => saveStatus,
        command: unavailable, saveProposal: unavailable, chooseCopy: unavailable,
        chooseFolder: unavailable, chooseOriginal: unavailable, retrySave: unavailable,
        locateSave: unavailable, exportReviewedCopy: unavailable, forwardSyncTex: unavailable,
        reverseSyncTex: unavailable, dispose: () => undefined,
      },
    };
  }
  const activeFixture = fixture.current;
  if (activeFixture === null) throw new Error('Host history fixture is missing');
  return <>
    <button type="button" style={{ position: 'fixed', bottom: 10, left: 10, zIndex: 1000 }}
      onClick={activeFixture.release}>Finish host bootstrap</button>
    <RuntimeProductionReviewApp runtime={activeFixture.runtime} loadingDocumentTitle="Loading history fixture" />
  </>;
}

createRoot(root).render(previewParameters.has('host-history') ? <DeferredHostHistoryPreview />
  : previewParameters.has('host-reattach') ? <HostReattachmentPreview /> : <Harness />);
