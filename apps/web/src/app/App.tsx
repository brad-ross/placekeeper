import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PluginRegistry } from '@embedpdf/core';
import { DocumentManagerPlugin } from '@embedpdf/plugin-document-manager';
import { InteractionManagerPlugin } from '@embedpdf/plugin-interaction-manager';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';
import { SelectionPlugin } from '@embedpdf/plugin-selection';
import { transformRect, transformSize } from '@embedpdf/models';

import {
  inventoryDocumentAnnotations,
  type ExistingAnnotation,
} from '../pdf/existing-annotations.js';
import { createLocalPdfiumViewer, type ViewerAssetUrls } from '../pdf/embedpdf-viewer.js';
import { PdfWorkspace, type PageContextMenuRequest } from '../pdf/PdfWorkspace.js';
import {
  SelectionReadAuthority,
  terminalSelectionUpdate,
  type SelectionUpdate,
} from '../pdf/selection-state.js';
import {
  assessPageTextReliability,
  PAGE_TEXT_UNAVAILABLE_MESSAGE,
  SELECTION_UNAVAILABLE_MESSAGE,
} from '../pdf/text-reliability.js';
import {
  captureViewerCaret,
  captureViewerSelection,
  createEngineAnchorPageReader,
} from '../pdf/viewer-selection-adapter.js';
import type { ViewerInteractionEvent, ViewerPagePoint } from '../pdf/viewer-interaction-events.js';
import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';

export interface AppProps {
  assets: ViewerAssetUrls;
  existingAnnotations?: readonly ExistingAnnotation[];
  pageSemanticReliable?: boolean;
  selectionSemanticReliable?: boolean;
  onViewerInitialized?: (registry: PluginRegistry) => Promise<void>;
  onSelectionUpdate?: (update: SelectionUpdate) => void;
  documentTitle?: string;
  toolError?: string | null;
  /** Production composes the viewer inside the canonical ReviewShell toolbar. */
  embeddedInReviewShell?: boolean;
  ownedAnnotations?: readonly ReviewAnnotation[];
  onViewerInteraction?: (event: ViewerInteractionEvent) => void;
  keyboardPageNoteActive?: boolean;
}

export function App({
  assets,
  existingAnnotations = [],
  pageSemanticReliable,
  selectionSemanticReliable,
  onViewerInitialized,
  onSelectionUpdate,
  documentTitle = 'Local PDF',
  toolError = null,
  embeddedInReviewShell = false,
  ownedAnnotations = [],
  onViewerInteraction,
  keyboardPageNoteActive = false,
}: AppProps) {
  const [sourceAnnotations, setSourceAnnotations] = useState<readonly ExistingAnnotation[]>([]);
  const [detectedPageReliable, setDetectedPageReliable] = useState(true);
  const [detectedSelectionReliable, setDetectedSelectionReliable] = useState(true);
  const subscriptions = useRef<Array<() => void>>([]);
  const pageReadGeneration = useRef(0);
  const selectionReads = useRef(new SelectionReadAuthority());
  const registryRef = useRef<PluginRegistry | null>(null);
  const activeDocumentIdRef = useRef<string | null>(null);
  const viewportGenerationRef = useRef(0);
  const caretReadGeneration = useRef(0);
  const menuInvocation = useRef(0);
  const keyboardActiveRef = useRef(keyboardPageNoteActive);
  const keyboardCursorRef = useRef<ViewerPagePoint | null>(null);
  const [keyboardCursor, setKeyboardCursor] = useState<ViewerPagePoint | null>(null);
  const viewer = useMemo(() => createLocalPdfiumViewer(assets), [assets]);
  const emit = useCallback((event: ViewerInteractionEvent) => onViewerInteraction?.(event), [onViewerInteraction]);

  const clearSubscriptions = useCallback(() => {
    for (const unsubscribe of subscriptions.current.splice(0)) unsubscribe();
  }, []);
  useEffect(() => () => {
    clearSubscriptions();
    selectionReads.current.invalidate();
  }, [clearSubscriptions]);

  const publishKeyboardCursor = useCallback((point: ViewerPagePoint | null) => {
    keyboardCursorRef.current = point;
    setKeyboardCursor(point);
    emit({ type: 'page-note-cursor', value: point });
  }, [emit]);

  const initializeKeyboardCursor = useCallback(() => {
    const registry = registryRef.current;
    const documentId = activeDocumentIdRef.current;
    if (!registry || !documentId || !keyboardActiveRef.current) return;
    const core = registry.getStore().getState().core;
    const document = core.documents[documentId]?.document;
    const scroll = registry.getPlugin<ScrollPlugin>(ScrollPlugin.id)?.provides()?.forDocument(documentId);
    const pageIndex = Math.max(0, (scroll?.getCurrentPage() ?? 1) - 1);
    const page = document?.pages[pageIndex];
    if (!page) return;
    publishKeyboardCursor({
      documentId,
      pageIndex,
      viewportGeneration: viewportGenerationRef.current,
      x: page.size.width / 2 + (page.boxes?.crop.left ?? 0),
      y: page.size.height / 2 + (page.boxes?.crop.top ?? 0),
    });
  }, [publishKeyboardCursor]);

  useEffect(() => {
    keyboardActiveRef.current = keyboardPageNoteActive;
    if (keyboardPageNoteActive) initializeKeyboardCursor();
    else if (keyboardCursorRef.current !== null) publishKeyboardCursor(null);
  }, [initializeKeyboardCursor, keyboardPageNoteActive, publishKeyboardCursor]);

  const initializeViewer = useCallback(async (registry: PluginRegistry) => {
    registryRef.current = registry;
    clearSubscriptions();
    onSelectionUpdate?.(selectionReads.current.invalidate());
    const interaction = registry
      .getPlugin<InteractionManagerPlugin>(InteractionManagerPlugin.id)
      ?.provides();
    const selectionPlugin = registry.getPlugin<SelectionPlugin>(SelectionPlugin.id);
    const selection = selectionPlugin?.provides();
    if (interaction && selection) {
      selection.enableForMode(interaction.getDefaultMode(), {
        enableSelection: true,
        showSelectionRects: true,
        enableMarquee: false,
      });
    }

    const readPage = async (documentId: string, pageIndex: number) => {
      const generation = ++pageReadGeneration.current;
      const document = registry.getStore().getState().core.documents[documentId]?.document;
      if (!document) return;
      const reader = createEngineAnchorPageReader(registry.getEngine(), document);
      const page = await reader.read(pageIndex);
      if (generation === pageReadGeneration.current) {
        setDetectedPageReliable(assessPageTextReliability(page).reliable);
        setDetectedSelectionReliable(true);
      }
    };
    const loadDocument = async (documentId: string) => {
      activeDocumentIdRef.current = documentId;
      const document = registry.getStore().getState().core.documents[documentId]?.document;
      if (!document) return;
      if (interaction) {
        for (const page of document.pages) {
          subscriptions.current.push(interaction.registerAlways({
            scope: { type: 'page', documentId, pageIndex: page.index },
            handlers: {
              onPointerUp: (position, event) => {
                const canonicalPoint: ViewerPagePoint = {
                  documentId,
                  pageIndex: page.index,
                  viewportGeneration: viewportGenerationRef.current,
                  x: position.x + (page.boxes?.crop.left ?? 0),
                  y: position.y + (page.boxes?.crop.top ?? 0),
                };
                if (keyboardActiveRef.current) {
                  publishKeyboardCursor(canonicalPoint);
                  emit({ type: 'page-note-commit', value: canonicalPoint });
                  publishKeyboardCursor(null);
                  return;
                }
                if (selection?.getState(documentId).selection !== null) return;
                const generation = ++caretReadGeneration.current;
                void captureViewerCaret({
                  pageIndex: page.index,
                  point: position,
                  pages: createEngineAnchorPageReader(registry.getEngine(), document),
                }).then((result) => {
                  if (generation !== caretReadGeneration.current) return;
                  emit({
                    type: 'caret',
                    value: result.ok
                      ? {
                          anchor: result.anchor,
                          placement: { left: event.clientX, top: event.clientY, suggestTop: true },
                        }
                      : { anchor: null, placement: null, diagnostic: result.diagnostic },
                  });
                });
              },
            },
          }));
        }
      }
      await Promise.all([
        readPage(documentId, 0),
        inventoryDocumentAnnotations(registry.getEngine(), document).then(
          setSourceAnnotations,
        ),
      ]);
    };

    const documentManager = registry
      .getPlugin<DocumentManagerPlugin>(DocumentManagerPlugin.id)
      ?.provides();
    if (documentManager) {
      subscriptions.current.push(
        documentManager.onDocumentOpened(({ document }) => {
          if (document) void loadDocument(document.id);
        }),
      );
    }

    const scroll = registry.getPlugin<ScrollPlugin>(ScrollPlugin.id)?.provides();
    if (scroll) {
      subscriptions.current.push(
        scroll.onPageChange(({ documentId, pageNumber }) => {
          viewportGenerationRef.current += 1;
          initializeKeyboardCursor();
          void readPage(documentId, pageNumber - 1);
        }),
        scroll.onScroll(() => {
          viewportGenerationRef.current += 1;
          initializeKeyboardCursor();
        }),
        scroll.onLayoutChange(() => {
          viewportGenerationRef.current += 1;
          initializeKeyboardCursor();
        }),
      );
    }

    if (selection) {
      const beginSelectionRead = (documentId: string) => {
        const { generation, started } = selectionReads.current.begin(documentId);
        if (!started) return;
        onSelectionUpdate?.({ kind: 'pending', generation });
      };
      const captureSelection = async (documentId: string, generation: number) => {
        const document = registry.getStore().getState().core.documents[documentId]?.document;
        if (!document) {
          onSelectionUpdate?.(selectionReads.current.invalidate());
          return;
        }
        const captureGate = globalThis.__pdfProofreaderSelectionCaptureTestGate;
        if (captureGate !== undefined) await captureGate.wait(generation);
        if (!selectionReads.current.isCurrent(generation)) return;
        const result = await captureViewerSelection({
          documentId,
          selection,
          pages: createEngineAnchorPageReader(registry.getEngine(), document),
        });
        if (selectionReads.current.isCurrent(generation)) {
          setDetectedSelectionReliable(result.ok);
          onSelectionUpdate?.(terminalSelectionUpdate(generation, result));
        }
      };
      subscriptions.current.push(
        selection.onSelectionChange(({ documentId, selection: selectedRange }) => {
          if (selectedRange === null) {
            setDetectedSelectionReliable(true);
            onSelectionUpdate?.(selectionReads.current.invalidate());
            emit({ type: 'selection-placement', value: null });
          } else {
            emit({ type: 'caret', value: { anchor: null, placement: null } });
            beginSelectionRead(documentId);
          }
        }),
        selection.onEndSelection(({ documentId }) => {
          const generation = selectionReads.current.finish(documentId);
          if (generation === null) return;
          void captureSelection(documentId, generation);
        }),
      );
      const activeId = registry.getStore().getState().core.activeDocumentId;
      if (selectionPlugin && activeId) {
        subscriptions.current.push(selectionPlugin.onMenuPlacement(activeId, (placement) => {
          if (!placement?.isVisible) {
            emit({ type: 'selection-placement', value: null });
            return;
          }
          const active = registry.getStore().getState().core.documents[activeId];
          const page = active?.document?.pages[placement.pageIndex];
          const element = document.querySelector<HTMLElement>(`[data-page-index="${placement.pageIndex}"]`);
          if (!page || !element) return;
          const bounds = element.getBoundingClientRect();
          const rotation = active.rotation;
          const rotatedSize = transformSize(page.size, rotation, 1);
          const scale = bounds.width / rotatedSize.width;
          const transformed = transformRect(page.size, placement.rect, rotation, scale);
          emit({
            type: 'selection-placement',
            value: {
              pageIndex: placement.pageIndex,
              rect: {
                x: placement.rect.origin.x + (page.boxes?.crop.left ?? 0),
                y: placement.rect.origin.y + (page.boxes?.crop.top ?? 0),
                width: placement.rect.size.width,
                height: placement.rect.size.height,
              },
              placement: {
                left: bounds.left + transformed.origin.x + transformed.size.width / 2,
                top: bounds.top + (placement.suggestTop
                  ? transformed.origin.y
                  : transformed.origin.y + transformed.size.height),
                suggestTop: placement.suggestTop,
              },
            },
          });
        }));
      }
    }

    const activeDocumentId = registry.getStore().getState().core.activeDocumentId;
    if (activeDocumentId) await loadDocument(activeDocumentId);
    await onViewerInitialized?.(registry);
  }, [clearSubscriptions, emit, initializeKeyboardCursor, onSelectionUpdate, onViewerInitialized, publishKeyboardCursor]);

  const effectivePageReliability = pageSemanticReliable ?? detectedPageReliable;
  const effectiveSelectionReliability =
    selectionSemanticReliable ?? detectedSelectionReliable;
  const pageMessage = !effectivePageReliability ? PAGE_TEXT_UNAVAILABLE_MESSAGE : null;
  const selectionMessage = effectivePageReliability && !effectiveSelectionReliability
    ? SELECTION_UNAVAILABLE_MESSAGE
    : null;
  const pageContextMenu = useCallback((request: PageContextMenuRequest): boolean => {
    const registry = registryRef.current;
    const documentId = activeDocumentIdRef.current;
    if (!registry || !documentId) return false;
    const selection = registry.getPlugin<SelectionPlugin>(SelectionPlugin.id)?.provides();
    if (selection?.getState(documentId).selection !== null) return false;
    emit({
      type: 'page-menu',
      value: {
        invocationId: `page-menu-${++menuInvocation.current}`,
        point: {
          documentId,
          pageIndex: request.pageIndex,
          viewportGeneration: viewportGenerationRef.current,
          x: request.x,
          y: request.y,
        },
        placement: { left: request.clientX, top: request.clientY },
      },
    });
    return true;
  }, [emit]);

  const keyboardCursorKey = useCallback((key: string) => {
    const cursor = keyboardCursorRef.current;
    if (!cursor) return;
    if (key === 'Escape') {
      publishKeyboardCursor(null);
      return;
    }
    if (key === 'Enter') {
      emit({ type: 'page-note-commit', value: cursor });
      publishKeyboardCursor(null);
      return;
    }
    const delta = 4;
    publishKeyboardCursor({
      ...cursor,
      x: cursor.x + (key === 'ArrowLeft' ? -delta : key === 'ArrowRight' ? delta : 0),
      y: cursor.y + (key === 'ArrowUp' ? -delta : key === 'ArrowDown' ? delta : 0),
    });
  }, [emit, publishKeyboardCursor]);
  const workspace = (
    <PdfWorkspace
      engine={viewer.engine}
      plugins={viewer.plugins}
      documentLabel={documentTitle}
      onInitialized={initializeViewer}
      ownedAnnotations={ownedAnnotations}
      keyboardPageNoteCursor={keyboardCursor}
      onKeyboardPageNoteKey={keyboardCursorKey}
      onPageContextMenu={pageContextMenu}
    />
  );
  const workspaceWithStatus = (
    <div data-viewer-shell>
      {workspace}
      {toolError ? (
        <p
          role="alert"
          data-viewer-status
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            zIndex: 2,
            margin: 0,
            padding: '4px 8px',
            borderRadius: 4,
            background: 'rgba(255, 255, 255, .92)',
            pointerEvents: 'none',
          }}
        >
          {toolError}
        </p>
      ) : null}
    </div>
  );

  if (embeddedInReviewShell) return workspaceWithStatus;

  const content = (
    <main>
      <h1>Local PDF Proofreader</h1>
      <p data-document-title>{documentTitle}</p>
      <section aria-label="PDF review workspace">
        <div role="toolbar" aria-label="Review tools">
          <button type="button">Page Note</button>
        </div>
        {pageMessage ? <p data-recovery-kind="page">{pageMessage}</p> : null}
        {selectionMessage ? <p data-recovery-kind="selection">{selectionMessage}</p> : null}
        <div data-semantic-tools-enabled={effectivePageReliability && effectiveSelectionReliability ? 'true' : 'false'}>
          {workspaceWithStatus}
        </div>
      </section>
      <aside aria-label="Existing annotations">
        <h2>Existing annotations</h2>
        {existingAnnotations.length + sourceAnnotations.length === 0 ? <p>None</p> : null}
        <ol>
          {[...sourceAnnotations, ...existingAnnotations].map((annotation, index) => (
            <li key={`${annotation.pageIndex}:${annotation.id}:${index}`}>
              <span>{annotation.subtype}</span>{' '}
              <span>{`Page ${annotation.pageIndex + 1}`}</span>{' '}
              <span>{annotation.contents}</span>
            </li>
          ))}
        </ol>
      </aside>
    </main>
  );
  return content;
}

declare global {
  /** Deterministic acceptance-only gate installed before the production app starts. */
  var __pdfProofreaderSelectionCaptureTestGate:
    | { wait(generation: number): Promise<void> }
    | undefined;
}
