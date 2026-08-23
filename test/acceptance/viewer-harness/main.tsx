import { createRoot } from 'react-dom/client';
import type { PluginRegistry } from '@embedpdf/core';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';
import { SelectionPlugin } from '@embedpdf/plugin-selection';
import { ZoomPlugin } from '@embedpdf/plugin-zoom';

import { App } from '../../../apps/web/src/app/App.js';
import { inventoryExistingAnnotations } from '../../../apps/web/src/pdf/existing-annotations.js';
import type { SelectionUpdate } from '../../../apps/web/src/pdf/selection-state.js';
import type { ViewerInteractionEvent } from '../../../apps/web/src/pdf/viewer-interaction-events.js';

const htmlPayload = '<img src=x onerror="globalThis.__htmlPayloadExecuted=true">';
const root = document.querySelector('#root');
if (!root) throw new Error('Acceptance root is missing.');

let registry: PluginRegistry | null = null;
let lastSelectionUpdate: SelectionUpdate | null = null;
let lastCaretPageIndex: number | null = null;
let lastCaretLeftContext = '';
const viewerInteractionCounts = new Map<ViewerInteractionEvent['type'], number>();
const params = new URLSearchParams(globalThis.location.search);

globalThis.__htmlPayloadExecuted = false;
globalThis.viewerAcceptance = {
  ready: false,
  selectionGeometryReady(pageIndex = 0) {
    if (!registry) return false;
    const documentId = registry.getStore().getState().core.activeDocumentId;
    if (!documentId) return false;
    const selection = registry.getPlugin<SelectionPlugin>(SelectionPlugin.id)?.provides();
    return selection?.getState(documentId).geometry[pageIndex] !== undefined;
  },
  selectionRectCount() {
    if (!registry) return 0;
    const documentId = registry.getStore().getState().core.activeDocumentId;
    if (!documentId) return 0;
    const selection = registry.getPlugin<SelectionPlugin>(SelectionPlugin.id)?.provides();
    return selection?.getFormattedSelection(documentId).flatMap(({ segmentRects }) => segmentRects).length ?? 0;
  },
  zoomLevel() {
    if (!registry) return 0;
    const documentId = registry.getStore().getState().core.activeDocumentId;
    if (!documentId) return 0;
    return registry.getPlugin<ZoomPlugin>(ZoomPlugin.id)
      ?.provides()
      .forDocument(documentId)
      .getState()
      .currentZoomLevel ?? 0;
  },
  selectionAnchorStatus() {
    if (lastSelectionUpdate === null) return 'pending';
    return lastSelectionUpdate.kind === 'unreliable'
      ? lastSelectionUpdate.diagnostic
      : lastSelectionUpdate.kind;
  },
  goToPage(pageNumber: number) {
    const documentId = registry?.getStore().getState().core.activeDocumentId;
    const scroll = registry?.getPlugin<ScrollPlugin>(ScrollPlugin.id)?.provides();
    if (documentId && scroll) {
      scroll.scrollToPage({ pageNumber, behavior: 'instant' });
    }
  },
  reviewItemCount() {
    return document.querySelectorAll('[data-review-item]').length;
  },
  interactionCount(type: ViewerInteractionEvent['type']) {
    return viewerInteractionCounts.get(type) ?? 0;
  },
  caretAnchorPageIndex() {
    return lastCaretPageIndex;
  },
  caretAnchorLeftContext() {
    return lastCaretLeftContext;
  },
};

createRoot(root).render(
  <App
      assets={{
        pdfiumWasm: '/test/fixtures/pdfium/pdfium.wasm',
        documentUrl:
          params.get('fixture') === 'mixed'
            ? '/test/fixtures/pdfs/mixed-text-image.pdf'
            : params.get('fixture') === 'multi-text'
              ? '/test/fixtures/pdfs/multi-page-text.pdf'
              : '/test/fixtures/pdfs/text-native-with-annotations.pdf',
      }}
      documentTitle={`Metadata ${htmlPayload}`}
      toolError={`Tool error ${htmlPayload}`}
      {...(params.get('unreliable') === 'page'
        ? { pageSemanticReliable: false }
        : {})}
      {...(params.get('unreliable') === 'selection'
        ? { selectionSemanticReliable: false }
        : {})}
      existingAnnotations={inventoryExistingAnnotations([
        {
          id: 'source-highlight',
          subtype: 'Highlight',
          pageIndex: 0,
          rect: { x: 72, y: 92, width: 160, height: 16 },
          contents: htmlPayload,
          author: 'Source PDF',
          flags: ['print'],
          appearanceModes: ['normal'],
          supportedAppearance: true,
        },
        {
          id: 'source-stamp',
          subtype: 'Stamp',
          pageIndex: 0,
          rect: { x: 320, y: 120, width: 90, height: 16 },
          contents: 'Unsupported source stamp',
          flags: ['print'],
          appearanceModes: ['normal'],
          supportedAppearance: false,
        },
      ])}
      onViewerInitialized={async (initialized) => {
        registry = initialized;
        globalThis.viewerAcceptance.ready = true;
      }}
      onSelectionUpdate={(update) => {
        lastSelectionUpdate = update;
      }}
      onViewerInteraction={(event) => {
        viewerInteractionCounts.set(event.type, (viewerInteractionCounts.get(event.type) ?? 0) + 1);
        if (event.type === 'caret') {
          lastCaretPageIndex = event.value.anchor?.pageIndex ?? null;
          lastCaretLeftContext = event.value.anchor?.leftContext ?? '';
        }
      }}
  />,
);

declare global {
  var __htmlPayloadExecuted: boolean;
  var viewerAcceptance: {
    ready: boolean;
    selectionGeometryReady(pageIndex?: number): boolean;
    selectionRectCount(): number;
    zoomLevel(): number;
    selectionAnchorStatus(): string;
    goToPage(pageNumber: number): void;
    reviewItemCount(): number;
    interactionCount(type: ViewerInteractionEvent['type']): number;
    caretAnchorPageIndex(): number | null;
    caretAnchorLeftContext(): string;
  };
}
