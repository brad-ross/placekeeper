import { MainDocumentPreviewBoundary, MainDocumentPreviewLimit } from './MainDocumentPreviewBoundary.js';
import type { ExistingAnnotation, SourceNativeAnnotation } from './existing-annotations.js';
import { ANNOTATION_CSS_VARIABLES } from '../../../../packages/core/src/annotation-appearance.js';
import type { PluginRegistry } from '@embedpdf/core';
import { EmbedPDF, type PluginBatchRegistrations } from '@embedpdf/core/react';
import type { PdfEngine } from '@embedpdf/models';
import { transformSize } from '@embedpdf/models';
import { AnnotationLayer } from '@embedpdf/plugin-annotation/react';
import { PagePointerProvider } from '@embedpdf/plugin-interaction-manager/react';
import { RenderLayer } from '@embedpdf/plugin-render/react';
import { Scroller } from '@embedpdf/plugin-scroll/react';
import { SelectionLayer } from '@embedpdf/plugin-selection/react';
import { Viewport } from '@embedpdf/plugin-viewport/react';
import { AnchoredZoomGestureWrapper as ZoomGestureWrapper } from './AnchoredZoomGestureWrapper.js';
import { useContext, useMemo, useRef } from 'react';
import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';
import type { PdfSearchResult } from './pdf-search-model.js';
import type { ReferenceScrollPosition } from './reference-manual-scroll.js';
import { ReviewIcon } from '../review/ReviewIcon.js';
import { combinePageRotation, positionOwnedRect } from './owned-overlay.js';
import { groupOwnedMarkGeometryByPage, hitTestOwnedMark } from './owned-mark-hit-test.js';
import {
  mergeAuthoringPreviewProjections,
} from '../review/annotation-projection.js';
import {
  sourceAnnotationLinkRenderers,
} from './PdfLinkControl.js';
import { ReferencePdfViewport } from './ReferencePdfViewport.js';
import {
  buildAnnotationRenderingState,
  PdfAnnotationLayers,
} from './PdfAnnotationLayers.js';
import type { ViewerRunway } from './viewer-framing.js';
import type { PdfAnnotationSurface } from './annotation-surface.js';
import {
  MAIN_PDF_DOCUMENT_ID,
  REFERENCE_PDF_DOCUMENT_ID,
} from './viewer-document-ids.js';
import {
  dispatchNeutralViewerPointerUp,
  isContextPointerGesture,
  isReverseSyncTexPointerGesture,
  isUnsafePageContextTarget,
  normalizePageClientPoint,
  recordViewerPointerButton,
  ReverseSyncTexPointerGesture,
  VIEWER_POINTER_BUTTON_NONE,
  type ViewerOwnedMarkInteraction,
  type ViewerPagePoint,
  type ViewerInteractionEvent,
} from './viewer-interaction-events.js';

export interface PageContextMenuRequest {
  readonly pageIndex: number;
  readonly x: number;
  readonly y: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly keyboard: boolean;
}

export interface PdfWorkspaceProps {
  engine: PdfEngine;
  plugins: PluginBatchRegistrations;
  documentLabel?: string;
  onInitialized?: (registry: PluginRegistry) => Promise<void>;
  ownedAnnotations?: readonly ReviewAnnotation[];
  sourceNativeAnnotations?: readonly SourceNativeAnnotation[];
  sourceAnnotations?: readonly ExistingAnnotation[];
  authoringPreview?: readonly ReviewAnnotation[] | null;
  keyboardPageNoteCursor?: ViewerPagePoint | null;
  keyboardPageNoteSurface?: PdfAnnotationSurface;
  onKeyboardPageNoteKey?: (key: string) => void;
  onPageContextMenu?: (
    request: PageContextMenuRequest,
    surface?: PdfAnnotationSurface,
  ) => boolean;
  fillContainer?: boolean;
  activeOwnedAnnotationId?: string;
  correspondingOwnedAnnotationId?: string;
  onOwnedMarkInteraction?: (interaction: ViewerOwnedMarkInteraction) => void;
  runway?: ViewerRunway;
  onWorkspaceElement?: (element: HTMLDivElement | null) => void;
  documentGeneration?: number;
  onViewerInteraction?: (event: ViewerInteractionEvent) => void;
  reverseSyncTexEnabled?: boolean;
  referenceViewportHost?: HTMLElement | null;
  onReferenceViewportElement?: (element: HTMLDivElement | null) => void;
  onReferenceScrollIntent?: (position: ReferenceScrollPosition) => void;
  referenceTabIdentity?: string | null;
  searchResults?: readonly PdfSearchResult[];
}

const PDF_TEXT_SELECTION_STYLE = {
  background: 'var(--review-pdf-selection-bg)',
} as const;

function groupByPageIndex<T extends { readonly pageIndex: number }>(
  items: readonly T[],
): Map<number, T[]> {
  const result = new Map<number, T[]>();
  for (const item of items) {
    const page = result.get(item.pageIndex);
    if (page === undefined) result.set(item.pageIndex, [item]);
    else page.push(item);
  }
  return result;
}

export function PdfWorkspace({
  engine,
  plugins,
  documentLabel = 'PDF document',
  onInitialized,
  ownedAnnotations = [],
  sourceNativeAnnotations = [],
  sourceAnnotations = [],
  authoringPreview = null,
  keyboardPageNoteCursor = null,
  keyboardPageNoteSurface,
  onKeyboardPageNoteKey,
  onPageContextMenu,
  fillContainer = false,
  activeOwnedAnnotationId,
  correspondingOwnedAnnotationId,
  onOwnedMarkInteraction,
  runway = { right: 0, bottom: 0 },
  onWorkspaceElement,
  documentGeneration = 0,
  onViewerInteraction,
  reverseSyncTexEnabled = false,
  referenceViewportHost = null,
  onReferenceViewportElement,
  onReferenceScrollIntent,
  referenceTabIdentity = null,
  searchResults = [],
}: PdfWorkspaceProps) {
  const previewLimit = useContext(MainDocumentPreviewLimit);
  const pressedPrimaryPointers = useRef(new Map<number, HTMLDivElement>());
  const contextPointers = useRef(new Set<number>());
  const reverseSyncTexPointers = useRef(new ReverseSyncTexPointerGesture());
  const contextResetTarget = useRef<HTMLDivElement | null>(null);
  const visibleAnnotations = useMemo(
    () => mergeAuthoringPreviewProjections(ownedAnnotations, authoringPreview),
    [authoringPreview, ownedAnnotations],
  );
  const sourceRendering = useMemo(
    () => buildAnnotationRenderingState(
      ownedAnnotations,
      sourceNativeAnnotations,
      sourceAnnotations,
    ),
    [ownedAnnotations, sourceAnnotations, sourceNativeAnnotations],
  );
  const authoringPreviewIds = useMemo(
    () => new Set(authoringPreview?.map(({ id }) => id) ?? []),
    [authoringPreview],
  );
  const annotationsByPage = useMemo(
    () => groupByPageIndex(visibleAnnotations),
    [visibleAnnotations],
  );
  const geometryByPage = useMemo(
    () => groupOwnedMarkGeometryByPage(ownedAnnotations),
    [ownedAnnotations],
  );
  const searchResultsByPage = useMemo(
    () => groupByPageIndex(searchResults),
    [searchResults],
  );

  return (
    <div
      ref={onWorkspaceElement}
      aria-label={documentLabel}
      role="region"
      className="pdf-workspace"
      data-pdf-copy-surface="main"
      data-annotation-surface="main"
      style={{ ...ANNOTATION_CSS_VARIABLES, ...(fillContainer ? {} : { height: '70vh', minHeight: 480 }) }}
    >
      <EmbedPDF
        engine={engine}
        plugins={plugins}
        {...(onInitialized === undefined ? {} : { onInitialized })}
      >
        {({ documents, pluginsReady }) => {
          const mainDocument = documents[MAIN_PDF_DOCUMENT_ID];
          if (mainDocument?.status === 'error') {
            return <div className="pdf-workspace__loading" role="alert">
              This PDF could not be loaded. If it is being rebuilt, wait for the build to finish and reopen it.
            </div>;
          }
          if (!pluginsReady || !mainDocument?.document) {
            return <div className="pdf-workspace__loading" role="status"><ReviewIcon name="loading" />Loading local PDF…</div>;
          }
          const activePdf = mainDocument.document;
          const pagePointFromClient = (
            pageIndex: number,
            element: HTMLDivElement,
            target: EventTarget,
            clientX: number,
            clientY: number,
          ): { readonly x: number; readonly y: number } | null => {
            if (isUnsafePageContextTarget(target)) return null;
            const page = activePdf.pages[pageIndex];
            if (!page) return null;
            const bounds = element.getBoundingClientRect();
            const rotation = combinePageRotation(page.rotation, mainDocument.rotation);
            const rotatedSize = transformSize(page.size, rotation, 1);
            return normalizePageClientPoint(
              { x: clientX, y: clientY },
              {
                pageSize: page.size,
                rotation,
                scale: bounds.width / rotatedSize.width,
                elementLeft: bounds.left,
                elementTop: bounds.top,
              },
            );
          };
          const linkRenderers = sourceAnnotationLinkRenderers({
            sourceScope: 'main',
            documentGeneration,
            pageCount: activePdf.pages.length,
            ...(onViewerInteraction === undefined ? {} : { onInteraction: onViewerInteraction }),
          });
          const referenceDocument = documents[REFERENCE_PDF_DOCUMENT_ID];

          return (
            <>
            <Viewport
              documentId={MAIN_PDF_DOCUMENT_ID}
              className="pdf-workspace__viewport"
              data-viewer-framing-viewport
            >
              <ZoomGestureWrapper
                documentId={MAIN_PDF_DOCUMENT_ID}
                data-viewer-framing-content
                style={{ minHeight: '100%', minWidth: '100%', position: 'relative' }}
              >
                <MainDocumentPreviewBoundary>
                <Scroller
                  documentId={MAIN_PDF_DOCUMENT_ID}
                  renderPage={(layout) => previewLimit !== null && (layout.pageNumber < previewLimit.firstPage || layout.pageNumber > previewLimit.lastPage) ? null : (
                    <PagePointerProvider
                      documentId={MAIN_PDF_DOCUMENT_ID}
                      pageIndex={layout.pageIndex}
                      aria-label={`Page ${layout.pageNumber}`}
                      className="pdf-workspace__page"
                      data-page-index={layout.pageIndex}
                      tabIndex={-1}
                      onPointerDownCapture={(event) => {
                        reverseSyncTexPointers.current.cancel(event.pointerId);
                        const reverseSyncTexGesture = reverseSyncTexEnabled &&
                          isReverseSyncTexPointerGesture(event);
                        const contextGesture = isContextPointerGesture(event);
                        recordViewerPointerButton(
                          event.currentTarget,
                          contextGesture || reverseSyncTexGesture ? VIEWER_POINTER_BUTTON_NONE : event.button,
                        );
                        event.currentTarget.focus({ preventScroll: true });
                        if (reverseSyncTexGesture) {
                          reverseSyncTexPointers.current.pointerDown(
                            event.pointerId,
                            event.clientX,
                            event.clientY,
                          );
                          event.preventDefault();
                          event.stopPropagation();
                          return;
                        }
                        if (contextGesture) {
                          contextPointers.current.add(event.pointerId);
                          if (event.pointerType === 'mouse') contextResetTarget.current = event.currentTarget;
                          event.preventDefault();
                          event.stopPropagation();
                          return;
                        }
                        contextPointers.current.delete(event.pointerId);
                        pressedPrimaryPointers.current.set(event.pointerId, event.currentTarget);
                      }}
                      onPointerMoveCapture={(event) => {
                        if (reverseSyncTexPointers.current.has(event.pointerId)) {
                          if (event.buttons === 0) {
                            reverseSyncTexPointers.current.cancel(event.pointerId);
                            return;
                          }
                          reverseSyncTexPointers.current.pointerMove(
                            event.pointerId,
                            event.clientX,
                            event.clientY,
                          );
                          event.preventDefault();
                          event.stopPropagation();
                          return;
                        }
                        if (
                          event.pointerType === 'mouse'
                          && (event.buttons & 1) !== 0
                          && contextResetTarget.current === event.currentTarget
                        ) {
                          contextResetTarget.current = null;
                        }
                        const resetsContextGesture = event.pointerType === 'mouse'
                          && event.buttons === 0
                          && contextResetTarget.current === event.currentTarget;
                        const lostReleaseTarget = event.pointerType === 'mouse' && event.buttons === 0
                          ? pressedPrimaryPointers.current.get(event.pointerId)
                          : undefined;
                        if (!resetsContextGesture && !lostReleaseTarget) return;
                        if (resetsContextGesture) contextResetTarget.current = null;
                        pressedPrimaryPointers.current.delete(event.pointerId);
                        event.stopPropagation();
                        const resetTarget = lostReleaseTarget ?? event.currentTarget;
                        recordViewerPointerButton(resetTarget, VIEWER_POINTER_BUTTON_NONE);
                        dispatchNeutralViewerPointerUp(resetTarget, event);
                      }}
                      onPointerUpCapture={(event) => {
                        pressedPrimaryPointers.current.delete(event.pointerId);
                        const reverseSyncTexGesture = reverseSyncTexPointers.current.pointerUp(
                          event.pointerId,
                          event.clientX,
                          event.clientY,
                        );
                        if (reverseSyncTexGesture !== undefined) {
                          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                            event.currentTarget.releasePointerCapture(event.pointerId);
                          }
                          recordViewerPointerButton(event.currentTarget, VIEWER_POINTER_BUTTON_NONE);
                          const point = reverseSyncTexGesture.activate ? pagePointFromClient(
                            layout.pageIndex,
                            event.currentTarget,
                            event.target,
                            event.clientX,
                            event.clientY,
                          ) : null;
                          if (point) {
                            onViewerInteraction?.({
                              type: 'reverse-synctex',
                              value: { pageIndex: layout.pageIndex, point },
                            });
                          }
                          event.preventDefault();
                          event.stopPropagation();
                          return;
                        }
                        const startedAsContext = contextPointers.current.delete(event.pointerId);
                        recordViewerPointerButton(
                          event.currentTarget,
                          startedAsContext || isContextPointerGesture(event)
                            ? VIEWER_POINTER_BUTTON_NONE
                            : event.button,
                        );
                      }}
                      onPointerCancelCapture={(event) => {
                        pressedPrimaryPointers.current.delete(event.pointerId);
                        contextPointers.current.delete(event.pointerId);
                        reverseSyncTexPointers.current.cancel(event.pointerId);
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                          event.currentTarget.releasePointerCapture(event.pointerId);
                        }
                      }}
                      onLostPointerCapture={(event) => {
                        reverseSyncTexPointers.current.cancel(event.pointerId);
                      }}
                      onContextMenu={(event) => {
                        if (onPageContextMenu === undefined) return;
                        const point = pagePointFromClient(
                          layout.pageIndex,
                          event.currentTarget,
                          event.target,
                          event.clientX,
                          event.clientY,
                        );
                        if (!point) return;
                        if (hitTestOwnedMark(
                          geometryByPage.get(layout.pageIndex) ?? [],
                          point,
                          mainDocument.scale,
                        )) return;
                        const accepted = onPageContextMenu({
                          pageIndex: layout.pageIndex,
                          ...point,
                          clientX: event.clientX,
                          clientY: event.clientY,
                          keyboard: false,
                        });
                        if (accepted) event.preventDefault();
                      }}
                      onKeyDown={(event) => {
                        if (onPageContextMenu === undefined) return;
                        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                        const page = activePdf.pages[layout.pageIndex];
                        if (!page) return;
                        const bounds = event.currentTarget.getBoundingClientRect();
                        const accepted = onPageContextMenu({
                          pageIndex: layout.pageIndex,
                          x: page.size.width / 2,
                          y: page.size.height / 2,
                          clientX: bounds.left + bounds.width / 2,
                          clientY: bounds.top + bounds.height / 2,
                          keyboard: true,
                        });
                        if (accepted) event.preventDefault();
                      }}
                      style={{
                        position: 'relative',
                        width: layout.rotatedWidth,
                        height: layout.rotatedHeight,
                        outline: 'none',
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                      }}
                    >
                      <RenderLayer
                        documentId={MAIN_PDF_DOCUMENT_ID}
                        pageIndex={layout.pageIndex}
                        style={{ pointerEvents: 'none' }}
                      />
                      <SelectionLayer
                        documentId={MAIN_PDF_DOCUMENT_ID}
                        pageIndex={layout.pageIndex}
                        textStyle={PDF_TEXT_SELECTION_STYLE}
                      />
                      <div
                        inert
                        aria-hidden="true"
                        data-pdf-search-highlight-layer
                        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                      >
                        {(searchResultsByPage.get(layout.pageIndex) ?? []).flatMap((searchResult) => (
                          searchResult.rects.map((rect, index) => {
                              const positioned = positionOwnedRect(
                                activePdf.pages[layout.pageIndex]!,
                                layout,
                                mainDocument.rotation,
                                {
                                  x: rect.origin.x,
                                  y: rect.origin.y,
                                  width: rect.size.width,
                                  height: rect.size.height,
                                },
                              );
                              return <span
                                key={`${searchResult.id}:${index}`}
                                data-pdf-search-highlight={searchResult.id}
                                data-pdf-search-match-kind={searchResult.kind === 'variant' ? 'related' : 'exact'}
                                style={{
                                  position: 'absolute',
                                  left: positioned.origin.x,
                                  top: positioned.origin.y,
                                  width: positioned.size.width,
                                  height: positioned.size.height,
                                }}
                              />;
                            })
                        ))}
                      </div>
                      <PdfAnnotationLayers
                        documentId={MAIN_PDF_DOCUMENT_ID}
                        engine={engine}
                        document={activePdf}
                        documentRotation={mainDocument.rotation}
                        layout={layout}
                        annotations={annotationsByPage.get(layout.pageIndex) ?? []}
                        geometry={geometryByPage.get(layout.pageIndex) ?? []}
                        authoringPreviewIds={authoringPreviewIds}
                        sourceRendering={sourceRendering}
                        {...(activeOwnedAnnotationId === undefined ? {} : { activeOwnedAnnotationId })}
                        {...(correspondingOwnedAnnotationId === undefined ? {} : { correspondingOwnedAnnotationId })}
                        keyboardPageNoteCursor={keyboardPageNoteSurface?.kind === 'reference'
                          ? null
                          : keyboardPageNoteCursor}
                        {...(onKeyboardPageNoteKey === undefined ? {} : { onKeyboardPageNoteKey })}
                        {...(onOwnedMarkInteraction === undefined ? {} : { onOwnedMarkInteraction })}
                        onSourceMarkInteraction={(annotationKey, pageIndex) => onViewerInteraction?.({
                          type: 'source-mark',
                          value: { annotationKey, phase: 'activate', pageIndex },
                        })}
                      />
                      <div data-source-link-layer>
                        <AnnotationLayer
                          documentId={MAIN_PDF_DOCUMENT_ID}
                          pageIndex={layout.pageIndex}
                          annotationRenderers={[...linkRenderers]}
                        />
                      </div>
                    </PagePointerProvider>
                  )}
                />
                </MainDocumentPreviewBoundary>
                <div
                  aria-hidden="true"
                  data-viewer-runway
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: `calc(100% + ${(previewLimit === null ? runway.right : 0)}px)`,
                    height: `calc(100% + ${(previewLimit === null ? runway.bottom : 0)}px)`,
                    pointerEvents: 'none',
                    visibility: 'hidden',
                  }}
                />
              </ZoomGestureWrapper>
            </Viewport>
            {referenceViewportHost && referenceDocument && referenceTabIdentity !== null ? (
              <ReferencePdfViewport
                documentId={REFERENCE_PDF_DOCUMENT_ID}
                documentState={referenceDocument}
                documentGeneration={documentGeneration}
                tabIdentity={referenceTabIdentity}
                host={referenceViewportHost}
                searchResultsByPage={searchResultsByPage}
                engine={engine}
                annotationsByPage={annotationsByPage}
                geometryByPage={geometryByPage}
                authoringPreviewIds={authoringPreviewIds}
                sourceRendering={sourceRendering}
                {...(activeOwnedAnnotationId === undefined ? {} : { activeOwnedAnnotationId })}
                {...(correspondingOwnedAnnotationId === undefined ? {} : { correspondingOwnedAnnotationId })}
                keyboardPageNoteCursor={keyboardPageNoteSurface?.kind === 'reference'
                  ? keyboardPageNoteCursor
                  : null}
                {...(onKeyboardPageNoteKey === undefined ? {} : { onKeyboardPageNoteKey })}
                {...(onPageContextMenu === undefined ? {} : { onPageContextMenu })}
                {...(onViewerInteraction === undefined ? {} : { onInteraction: onViewerInteraction })}
                {...(onReferenceViewportElement === undefined ? {} : { onViewportElement: onReferenceViewportElement })}
                {...(onReferenceScrollIntent === undefined ? {} : { onScrollIntent: onReferenceScrollIntent })}
              />
            ) : null}
            </>
          );
        }}
      </EmbedPDF>
    </div>
  );
}
