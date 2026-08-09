import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PluginRegistry } from '@embedpdf/core';
import { DocumentManagerPlugin } from '@embedpdf/plugin-document-manager';
import { InteractionManagerPlugin } from '@embedpdf/plugin-interaction-manager';
import { ScrollPlugin } from '@embedpdf/plugin-scroll';
import { SelectionPlugin } from '@embedpdf/plugin-selection';
import { transformRect, transformSize, type PdfPageObject, type Position } from '@embedpdf/models';

import {
  ExistingAnnotationDiscoveryAuthority,
  inventoryDocumentAnnotations,
  mergeExistingAnnotations,
  type ExistingAnnotation,
  type ExistingAnnotationsDiscovery,
} from '../pdf/existing-annotations.js';
import { createLocalPdfiumViewer, type ViewerAssetUrls } from '../pdf/embedpdf-viewer.js';
import { PdfWorkspace, type PageContextMenuRequest } from '../pdf/PdfWorkspace.js';
import { createViewerFramingControls } from '../pdf/viewer-framing-adapter.js';
import type { ViewerFramingControls, ViewerRunway } from '../pdf/viewer-framing.js';
import { combinePageRotation } from '../pdf/owned-overlay.js';
import {
  OwnedMarkPointerGesture,
  groupOwnedMarkGeometryByPage,
  hitTestOwnedMark,
} from '../pdf/owned-mark-hit-test.js';
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
import {
  VIEWER_POINTER_BUTTON_NONE,
  viewerPointerButton,
  type ViewerInteractionEvent,
  type ViewerPagePoint,
} from '../pdf/viewer-interaction-events.js';
import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';
import { ReviewIcon } from '../review/ReviewIcon.js';

type ViewerCaretResult = Awaited<ReturnType<typeof captureViewerCaret>>;

const FALLBACK_PAGE_NOTE_CURSOR_RADIUS_PX = 18;

export function clampPageNotePoint(
  point: Position,
  page: Pick<PdfPageObject, 'size' | 'boxes'>,
  inset = 0,
): Position {
  const cropOrigin = page.boxes?.crop ?? { left: 0, top: 0 };
  const clampAxis = (value: number, start: number, end: number) => {
    const safeInset = Math.min(Math.max(0, inset), Math.max(0, end - start) / 2);
    return Math.min(end - safeInset, Math.max(start + safeInset, value));
  };
  return {
    x: clampAxis(point.x, cropOrigin.left, cropOrigin.left + page.size.width),
    y: clampAxis(point.y, cropOrigin.top, cropOrigin.top + page.size.height),
  };
}

export async function publishViewerCaretRead(input: {
  readonly read: Promise<ViewerCaretResult>;
  readonly isCurrent: () => boolean;
  readonly placement: { readonly left: number; readonly top: number; readonly suggestTop: true };
  readonly emit: (event: ViewerInteractionEvent) => void;
}): Promise<void> {
  try {
    const result = await input.read;
    if (!input.isCurrent()) return;
    input.emit({
      type: 'caret',
      value: result.ok
        ? { anchor: result.anchor, placement: input.placement }
        : { anchor: null, placement: null, diagnostic: result.diagnostic },
    });
  } catch {
    if (!input.isCurrent()) return;
    input.emit({
      type: 'caret',
      value: { anchor: null, placement: null, diagnostic: 'caret-read-unavailable' },
    });
  }
}

export interface AppProps {
  assets: ViewerAssetUrls;
  existingAnnotations?: readonly ExistingAnnotation[];
  pageSemanticReliable?: boolean;
  selectionSemanticReliable?: boolean;
  onViewerInitialized?: (registry: PluginRegistry) => Promise<void>;
  onViewerFramingInitialized?: (controls: ViewerFramingControls) => void;
  onSelectionUpdate?: (update: SelectionUpdate) => void;
  documentTitle?: string;
  toolError?: string | null;
  /** Production composes the viewer inside the canonical reading-first ReviewShell. */
  embeddedInReviewShell?: boolean;
  ownedAnnotations?: readonly ReviewAnnotation[];
  onViewerInteraction?: (event: ViewerInteractionEvent) => void;
  keyboardPageNoteActive?: boolean;
  activeOwnedAnnotationId?: string;
  correspondingOwnedAnnotationId?: string;
  onExistingAnnotationsDiscovery?: (result: ExistingAnnotationsDiscovery) => void;
  inventoryRetryGeneration?: number;
}

export function App({
  assets,
  existingAnnotations = [],
  pageSemanticReliable,
  selectionSemanticReliable,
  onViewerInitialized,
  onViewerFramingInitialized,
  onSelectionUpdate,
  documentTitle = 'Local PDF',
  toolError = null,
  embeddedInReviewShell = false,
  ownedAnnotations = [],
  onViewerInteraction,
  keyboardPageNoteActive = false,
  activeOwnedAnnotationId,
  correspondingOwnedAnnotationId,
  onExistingAnnotationsDiscovery,
  inventoryRetryGeneration = 0,
}: AppProps) {
  const [sourceAnnotations, setSourceAnnotations] = useState<readonly ExistingAnnotation[]>([]);
  const [inventoryState, setInventoryState] = useState<ExistingAnnotationsDiscovery>({
    status: 'loading',
    generation: 0,
  });
  const [detectedPageReliable, setDetectedPageReliable] = useState(true);
  const [detectedSelectionReliable, setDetectedSelectionReliable] = useState(true);
  const subscriptions = useRef<Array<() => void>>([]);
  const pageReadGeneration = useRef(0);
  const selectionReads = useRef(new SelectionReadAuthority());
  const registryRef = useRef<PluginRegistry | null>(null);
  const framingControlsRef = useRef<ViewerFramingControls | null>(null);
  const workspaceElementRef = useRef<HTMLDivElement | null>(null);
  const [viewerRunway, setViewerRunway] = useState<ViewerRunway>({ right: 0, bottom: 0 });
  const activeDocumentIdRef = useRef<string | null>(null);
  const viewportGenerationRef = useRef(0);
  const caretReadGeneration = useRef(0);
  const menuInvocation = useRef(0);
  const keyboardActiveRef = useRef(keyboardPageNoteActive);
  const keyboardCursorRef = useRef<ViewerPagePoint | null>(null);
  const [keyboardCursor, setKeyboardCursor] = useState<ViewerPagePoint | null>(null);
  const inventoryAuthority = useRef(new ExistingAnnotationDiscoveryAuthority());
  const currentInventoryDocument = useRef<{
    readonly id: string;
    readonly document: Parameters<typeof inventoryDocumentAnnotations>[1];
  } | null>(null);
  const explicitAnnotationsRef = useRef(existingAnnotations);
  explicitAnnotationsRef.current = existingAnnotations;
  const ownedGeometryByPage = useMemo(
    () => groupOwnedMarkGeometryByPage(ownedAnnotations),
    [ownedAnnotations],
  );
  const ownedGeometryByPageRef = useRef(ownedGeometryByPage);
  ownedGeometryByPageRef.current = ownedGeometryByPage;
  const ownedPointerGesture = useRef(new OwnedMarkPointerGesture());
  const hoveredOwnedId = useRef<string | undefined>(undefined);
  const viewer = useMemo(() => createLocalPdfiumViewer(assets), [assets]);
  const emit = useCallback((event: ViewerInteractionEvent) => onViewerInteraction?.(event), [onViewerInteraction]);
  const publishInventory = useCallback((result: ExistingAnnotationsDiscovery) => {
    setInventoryState(result);
    if (result.status === 'ready') setSourceAnnotations(result.items);
    if (result.status === 'empty') setSourceAnnotations([]);
    onExistingAnnotationsDiscovery?.(result);
  }, [onExistingAnnotationsDiscovery]);
  const discoverExistingAnnotations = useCallback((
    documentId: string,
    document: Parameters<typeof inventoryDocumentAnnotations>[1],
  ) => {
    currentInventoryDocument.current = { id: documentId, document };
    const token = inventoryAuthority.current.begin(documentId);
    publishInventory({ status: 'loading', generation: token.generation });
    void inventoryDocumentAnnotations(viewer.engine, document).then(
      (discovered) => {
        const result = inventoryAuthority.current.ready(
          token,
          discovered,
          explicitAnnotationsRef.current,
        );
        if (result) publishInventory(result);
      },
      (error: unknown) => {
        const result = inventoryAuthority.current.error(token, error);
        if (result) publishInventory(result);
      },
    );
  }, [publishInventory, viewer.engine]);

  useEffect(() => {
    const current = currentInventoryDocument.current;
    if (inventoryRetryGeneration > 0 && current) {
      discoverExistingAnnotations(current.id, current.document);
    }
  }, [discoverExistingAnnotations, inventoryRetryGeneration]);

  const clearSubscriptions = useCallback(() => {
    for (const unsubscribe of subscriptions.current.splice(0)) unsubscribe();
  }, []);
  useEffect(() => () => {
    clearSubscriptions();
    framingControlsRef.current?.dispose();
    framingControlsRef.current = null;
    selectionReads.current.invalidate();
    caretReadGeneration.current += 1;
  }, [clearSubscriptions, viewer]);
  const updateViewerRunway = useCallback((runway: ViewerRunway) => {
    setViewerRunway((current) => current.right === runway.right && current.bottom === runway.bottom
      ? current
      : runway);
  }, []);
  const setWorkspaceElement = useCallback((element: HTMLDivElement | null) => {
    workspaceElementRef.current = element;
  }, []);

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
    const cropOrigin = page.boxes?.crop ?? { left: 0, top: 0 };
    publishKeyboardCursor({
      documentId,
      pageIndex,
      viewportGeneration: viewportGenerationRef.current,
      x: cropOrigin.left + page.size.width / 2,
      y: cropOrigin.top + page.size.height / 2,
    });
  }, [publishKeyboardCursor]);

  useEffect(() => {
    keyboardActiveRef.current = keyboardPageNoteActive;
    if (keyboardPageNoteActive) initializeKeyboardCursor();
    else if (keyboardCursorRef.current !== null) publishKeyboardCursor(null);
  }, [initializeKeyboardCursor, keyboardPageNoteActive, publishKeyboardCursor]);

  const initializeViewer = useCallback(async (registry: PluginRegistry) => {
    caretReadGeneration.current += 1;
    registryRef.current = registry;
    clearSubscriptions();
    onSelectionUpdate?.(selectionReads.current.invalidate());
    const installViewerFraming = () => {
      framingControlsRef.current?.dispose();
      const framingControls = createViewerFramingControls({
        registry,
        root: () => workspaceElementRef.current,
        updateRunway: updateViewerRunway,
      });
      framingControlsRef.current = framingControls;
      onViewerFramingInitialized?.(framingControls);
    };
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

    const pageReaders = new Map<string, {
      document: Parameters<typeof createEngineAnchorPageReader>[1];
      reader: ReturnType<typeof createEngineAnchorPageReader>;
    }>();
    const pageReaderFor = (
      documentId: string,
      document: Parameters<typeof createEngineAnchorPageReader>[1],
    ) => {
      const current = pageReaders.get(documentId);
      if (current?.document === document) return current.reader;
      const reader = createEngineAnchorPageReader(registry.getEngine(), document);
      pageReaders.set(documentId, { document, reader });
      return reader;
    };

    const readPage = async (documentId: string, pageIndex: number) => {
      const generation = ++pageReadGeneration.current;
      const document = registry.getStore().getState().core.documents[documentId]?.document;
      if (!document) return;
      const page = await pageReaderFor(documentId, document).read(pageIndex);
      if (generation === pageReadGeneration.current) {
        setDetectedPageReliable(assessPageTextReliability(page).reliable);
        setDetectedSelectionReliable(true);
      }
    };
    const loadDocument = async (documentId: string) => {
      caretReadGeneration.current += 1;
      activeDocumentIdRef.current = documentId;
      const document = registry.getStore().getState().core.documents[documentId]?.document;
      if (!document) return;
      installViewerFraming();
      currentInventoryDocument.current = { id: documentId, document };
      if (interaction) {
        for (const page of document.pages) {
          const pointerId = page.index + 1;
          const toCanonicalPoint = (position: { x: number; y: number }) => ({
            x: position.x + (page.boxes?.crop.left ?? 0),
            y: position.y + (page.boxes?.crop.top ?? 0),
          });
          const pageGeometry = () => ownedGeometryByPageRef.current.get(page.index) ?? [];
          const setHoveredOwned = (id: string | undefined) => {
            if (hoveredOwnedId.current === id) return;
            if (hoveredOwnedId.current) {
              emit({ type: 'owned-mark', value: { id: hoveredOwnedId.current, phase: 'leave' } });
            }
            hoveredOwnedId.current = id;
            if (id) emit({ type: 'owned-mark', value: { id, phase: 'enter' } });
          };
          subscriptions.current.push(interaction.registerAlways({
            scope: { type: 'page', documentId, pageIndex: page.index },
            handlers: {
              onPointerDown: (position, event) => {
                ownedPointerGesture.current.pointerDown(
                  pointerId,
                  viewerPointerButton(event) ?? -1,
                  toCanonicalPoint(position),
                  pageGeometry(),
                );
              },
              onPointerMove: (position) => {
                const point = toCanonicalPoint(position);
                ownedPointerGesture.current.pointerMove(pointerId, point);
                setHoveredOwned(hitTestOwnedMark(pageGeometry(), point));
              },
              onPointerLeave: () => {
                ownedPointerGesture.current.pointerCancel(pointerId);
                setHoveredOwned(undefined);
              },
              onPointerCancel: () => {
                ownedPointerGesture.current.pointerCancel(pointerId);
                setHoveredOwned(undefined);
              },
              onPointerUp: (position, event) => {
                const button = viewerPointerButton(event) ?? VIEWER_POINTER_BUTTON_NONE;
                const ownedId = ownedPointerGesture.current.pointerUp(
                  pointerId,
                  button,
                  toCanonicalPoint(position),
                  pageGeometry(),
                );
                if (button !== 0) return;
                if (ownedId) {
                  emit({ type: 'owned-mark', value: { id: ownedId, phase: 'activate' } });
                  return;
                }
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
                void publishViewerCaretRead({
                  read: captureViewerCaret({
                    pageIndex: page.index,
                    point: position,
                    pages: pageReaderFor(documentId, document),
                  }),
                  isCurrent: () => generation === caretReadGeneration.current,
                  placement: { left: event.clientX, top: event.clientY, suggestTop: true },
                  emit,
                });
              },
            },
          }));
        }
      }
      await readPage(documentId, 0);
    };

    const documentManager = registry
      .getPlugin<DocumentManagerPlugin>(DocumentManagerPlugin.id)
      ?.provides();
    if (documentManager) {
      subscriptions.current.push(
        documentManager.onDocumentOpened(({ document }) => {
          if (document) {
            void loadDocument(document.id).then(() => {
              const current = currentInventoryDocument.current;
              if (current?.id === document.id) discoverExistingAnnotations(current.id, current.document);
            });
          }
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
          pages: pageReaderFor(documentId, document),
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
          const rotation = combinePageRotation(page.rotation, active.rotation);
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
    if (activeDocumentId) {
      const activeDocument = registry.getStore().getState().core.documents[activeDocumentId]?.document;
      if (activeDocument) currentInventoryDocument.current = { id: activeDocumentId, document: activeDocument };
      await loadDocument(activeDocumentId);
    }
    await onViewerInitialized?.(registry);
    const inventoryDocument = currentInventoryDocument.current;
    if (inventoryDocument) discoverExistingAnnotations(inventoryDocument.id, inventoryDocument.document);
  }, [clearSubscriptions, discoverExistingAnnotations, emit, initializeKeyboardCursor, onSelectionUpdate, onViewerFramingInitialized, onViewerInitialized, publishKeyboardCursor, updateViewerRunway]);

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

  const clampKeyboardCursor = useCallback((cursor: ViewerPagePoint): ViewerPagePoint => {
    const registry = registryRef.current;
    const active = registry?.getStore().getState().core.documents[cursor.documentId];
    const page = active?.document?.pages[cursor.pageIndex];
    if (!page) return cursor;
    const pageElement = globalThis.document?.querySelector<HTMLElement>(
      `[data-page-index="${cursor.pageIndex}"]`,
    );
    const cursorElement = globalThis.document?.querySelector<HTMLElement>('.page-note-placement-cursor');
    const pageBounds = pageElement?.getBoundingClientRect();
    const cursorBounds = cursorElement?.getBoundingClientRect();
    const rotation = combinePageRotation(page.rotation, active.rotation);
    const rotatedSize = transformSize(page.size, rotation, 1);
    const scale = pageBounds && pageBounds.width > 0
      ? pageBounds.width / rotatedSize.width
      : 0;
    const cursorRadius = cursorBounds && cursorBounds.width > 0 && cursorBounds.height > 0
      ? Math.max(cursorBounds.width, cursorBounds.height) / 2
      : FALLBACK_PAGE_NOTE_CURSOR_RADIUS_PX;
    const inset = scale > 0 ? cursorRadius / scale : 0;
    return { ...cursor, ...clampPageNotePoint(cursor, page, inset) };
  }, []);

  const keyboardCursorKey = useCallback((key: string) => {
    const cursor = keyboardCursorRef.current;
    if (!cursor) return;
    if (key === 'Escape') {
      publishKeyboardCursor(null);
      return;
    }
    if (key === 'Enter') {
      emit({ type: 'page-note-commit', value: clampKeyboardCursor(cursor) });
      publishKeyboardCursor(null);
      return;
    }
    const delta = 4;
    publishKeyboardCursor(clampKeyboardCursor({
      ...cursor,
      x: cursor.x + (key === 'ArrowLeft' ? -delta : key === 'ArrowRight' ? delta : 0),
      y: cursor.y + (key === 'ArrowUp' ? -delta : key === 'ArrowDown' ? delta : 0),
    }));
  }, [clampKeyboardCursor, emit, publishKeyboardCursor]);
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
      fillContainer={embeddedInReviewShell}
      {...(activeOwnedAnnotationId === undefined ? {} : { activeOwnedAnnotationId })}
      {...(correspondingOwnedAnnotationId === undefined ? {} : { correspondingOwnedAnnotationId })}
      onOwnedMarkInteraction={(value) => emit({ type: 'owned-mark', value })}
      runway={viewerRunway}
      onWorkspaceElement={setWorkspaceElement}
    />
  );
  const workspaceWithStatus = (
    <div data-viewer-shell>
      {workspace}
      {toolError ? (
        <p
          className="pdf-workspace__status"
          role="alert"
          data-viewer-status
        >
          <ReviewIcon name="alert" />{toolError}
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
        {inventoryState.status === 'loading' ? <p role="status">Existing annotations are loading…</p> : null}
        {inventoryState.status === 'error' ? <p role="alert">Existing annotations unavailable.</p> : null}
        {inventoryState.status === 'empty' ? <p>None</p> : null}
        <ol>
          {mergeExistingAnnotations(sourceAnnotations, existingAnnotations).map((annotation, index) => (
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
