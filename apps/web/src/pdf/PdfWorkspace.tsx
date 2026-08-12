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
import { ZoomGestureWrapper } from '@embedpdf/plugin-zoom/react';
import { useMemo, useRef } from 'react';
import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';
import { ReviewIcon } from '../review/ReviewIcon.js';
import { combinePageRotation, positionOwnedRect } from './owned-overlay.js';
import { groupOwnedMarkGeometryByPage, hitTestOwnedMark } from './owned-mark-hit-test.js';
import {
  sourceAnnotationLinkRenderers,
  sourceAnnotationVisualRenderers,
} from './PdfLinkControl.js';
import { ReferencePdfViewport } from './ReferencePdfViewport.js';
import type { ViewerRunway } from './viewer-framing.js';
import {
  MAIN_PDF_DOCUMENT_ID,
  REFERENCE_PDF_DOCUMENT_ID,
} from './viewer-document-ids.js';
import {
  dispatchNeutralViewerPointerUp,
  isUnsafePageContextTarget,
  normalizePageClientPoint,
  recordViewerPointerButton,
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
  keyboardPageNoteCursor?: ViewerPagePoint | null;
  onKeyboardPageNoteKey?: (key: string) => void;
  onPageContextMenu?: (request: PageContextMenuRequest) => boolean;
  fillContainer?: boolean;
  activeOwnedAnnotationId?: string;
  correspondingOwnedAnnotationId?: string;
  onOwnedMarkInteraction?: (interaction: ViewerOwnedMarkInteraction) => void;
  runway?: ViewerRunway;
  onWorkspaceElement?: (element: HTMLDivElement | null) => void;
  documentGeneration?: number;
  onViewerInteraction?: (event: ViewerInteractionEvent) => void;
  referenceViewportHost?: HTMLElement | null;
  onReferenceViewportElement?: (element: HTMLDivElement | null) => void;
}

const PDF_TEXT_SELECTION_STYLE = {
  background: 'var(--review-selection-bg)',
} as const;

function isContextPointerGesture(event: {
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly pointerType: string;
}): boolean {
  return event.button !== 0 || (event.pointerType === 'mouse' && event.ctrlKey);
}

export function PdfWorkspace({
  engine,
  plugins,
  documentLabel = 'PDF document',
  onInitialized,
  ownedAnnotations = [],
  keyboardPageNoteCursor = null,
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
  referenceViewportHost = null,
  onReferenceViewportElement,
}: PdfWorkspaceProps) {
  const pressedPrimaryPointers = useRef(new Map<number, HTMLDivElement>());
  const contextPointers = useRef(new Set<number>());
  const contextResetTarget = useRef<HTMLDivElement | null>(null);
  const annotationsByPage = useMemo(() => {
    const result = new Map<number, ReviewAnnotation[]>();
    for (const annotation of ownedAnnotations) {
      const page = result.get(annotation.pageIndex);
      if (page === undefined) result.set(annotation.pageIndex, [annotation]);
      else page.push(annotation);
    }
    return result;
  }, [ownedAnnotations]);
  const geometryByPage = useMemo(
    () => groupOwnedMarkGeometryByPage(ownedAnnotations),
    [ownedAnnotations],
  );

  return (
    <div
      ref={onWorkspaceElement}
      aria-label={documentLabel}
      role="region"
      className="pdf-workspace"
      style={fillContainer ? undefined : { height: '70vh', minHeight: 480 }}
    >
      <EmbedPDF
        engine={engine}
        plugins={plugins}
        {...(onInitialized === undefined ? {} : { onInitialized })}
      >
        {({ documents, pluginsReady }) => {
          const mainDocument = documents[MAIN_PDF_DOCUMENT_ID];
          if (!pluginsReady || !mainDocument?.document) {
            return <div className="pdf-workspace__loading" role="status"><ReviewIcon name="loading" />Loading local PDF…</div>;
          }
          const activePdf = mainDocument.document;
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
                <Scroller
                  documentId={MAIN_PDF_DOCUMENT_ID}
                  renderPage={(layout) => (
                    <PagePointerProvider
                      documentId={MAIN_PDF_DOCUMENT_ID}
                      pageIndex={layout.pageIndex}
                      aria-label={`Page ${layout.pageNumber}`}
                      className="pdf-workspace__page"
                      data-page-index={layout.pageIndex}
                      tabIndex={-1}
                      onPointerDownCapture={(event) => {
                        const contextGesture = isContextPointerGesture(event);
                        recordViewerPointerButton(
                          event.currentTarget,
                          contextGesture ? VIEWER_POINTER_BUTTON_NONE : event.button,
                        );
                        event.currentTarget.focus({ preventScroll: true });
                        if (contextGesture) {
                          contextPointers.current.add(event.pointerId);
                          if (event.pointerType === 'mouse') contextResetTarget.current = event.currentTarget;
                          event.stopPropagation();
                          return;
                        }
                        contextPointers.current.delete(event.pointerId);
                        pressedPrimaryPointers.current.set(event.pointerId, event.currentTarget);
                      }}
                      onPointerMoveCapture={(event) => {
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
                      }}
                      onContextMenu={(event) => {
                        if (onPageContextMenu === undefined || isUnsafePageContextTarget(event.target)) return;
                        const page = activePdf.pages[layout.pageIndex];
                        if (!page) return;
                        const bounds = event.currentTarget.getBoundingClientRect();
                        const rotation = combinePageRotation(page.rotation, mainDocument.rotation);
                        const rotatedSize = transformSize(page.size, rotation, 1);
                        const point = normalizePageClientPoint(
                          { x: event.clientX, y: event.clientY },
                          {
                            pageSize: page.size,
                            rotation,
                            scale: bounds.width / rotatedSize.width,
                            elementLeft: bounds.left,
                            elementTop: bounds.top,
                          },
                        );
                        if (!point) return;
                        if (hitTestOwnedMark(
                          geometryByPage.get(layout.pageIndex) ?? [],
                          point,
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
                        data-owned-annotation-layer
                        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                      >
                        {(annotationsByPage.get(layout.pageIndex) ?? [])
                          .flatMap((annotation) => {
                            const page = activePdf.pages[layout.pageIndex];
                            if (!page) return [];
                            return (annotation.quadPoints ?? [annotation.rect]).map((rect, index) => {
                              const transformed = positionOwnedRect(
                                page,
                                layout,
                                mainDocument.rotation,
                                rect,
                              );
                              return (
                                <span
                                  key={`${annotation.id}:${index}`}
                                  data-owned-mark={annotation.kind}
                                  data-review-id={annotation.id}
                                  data-corresponding={correspondingOwnedAnnotationId === annotation.id ? 'true' : 'false'}
                                  data-active={activeOwnedAnnotationId === annotation.id ? 'true' : 'false'}
                                  style={{
                                    position: 'absolute',
                                    left: transformed.origin.x,
                                    top: transformed.origin.y,
                                    width: transformed.size.width,
                                    height: transformed.size.height,
                                  }}
                                />
                              );
                            });
                          })}
                      </div>
                      <div className="owned-mark-focus-layer" data-owned-focus-layer>
                        {(geometryByPage.get(layout.pageIndex) ?? []).map((group) => {
                          const annotation = (annotationsByPage.get(layout.pageIndex) ?? [])
                            .find(({ id }) => id === group.id);
                          const page = activePdf.pages[layout.pageIndex];
                          const rect = group.rects[0];
                          if (!annotation || !page || !rect) return null;
                          const transformed = positionOwnedRect(page, layout, mainDocument.rotation, rect);
                          return (
                            <button
                              key={group.id}
                              type="button"
                              className="owned-mark-focus-proxy"
                              data-owned-focus-id={group.id}
                              aria-label={`${annotation.kind} annotation on page ${annotation.pageIndex + 1}`}
                              onFocus={() => onOwnedMarkInteraction?.({ id: group.id, phase: 'focus' })}
                              onBlur={() => onOwnedMarkInteraction?.({ id: group.id, phase: 'blur' })}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') event.preventDefault();
                              }}
                              onKeyUp={(event) => {
                                if (event.key !== 'Enter' && event.key !== ' ') return;
                                event.preventDefault();
                                onOwnedMarkInteraction?.({ id: group.id, phase: 'activate' });
                              }}
                              style={{ left: transformed.origin.x, top: transformed.origin.y }}
                            />
                          );
                        })}
                      </div>
                      {keyboardPageNoteCursor?.pageIndex === layout.pageIndex ? (() => {
                        const page = activePdf.pages[layout.pageIndex];
                        if (!page) return null;
                        const transformed = positionOwnedRect(
                          page,
                          layout,
                          mainDocument.rotation,
                          {
                            x: keyboardPageNoteCursor.x,
                            y: keyboardPageNoteCursor.y,
                            width: 1,
                            height: 1,
                          },
                        );
                        return (
                          <button
                            type="button"
                            autoFocus
                            className="page-note-placement-cursor"
                            data-review-contextual-ui
                            aria-label="Page Note placement cursor. Use arrow keys to move, Enter to place, or Escape to cancel."
                            onKeyDown={(event) => {
                              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return;
                              event.preventDefault();
                              event.stopPropagation();
                              onKeyboardPageNoteKey?.(event.key);
                            }}
                            style={{ left: transformed.origin.x, top: transformed.origin.y }}
                          >
                            <ReviewIcon name="plus" />
                          </button>
                        );
                      })() : null}
                      <div
                        aria-hidden="true"
                        data-source-annotation-layer
                        style={{ pointerEvents: 'none' }}
                      >
                        <AnnotationLayer
                          documentId={MAIN_PDF_DOCUMENT_ID}
                          pageIndex={layout.pageIndex}
                          annotationRenderers={[...sourceAnnotationVisualRenderers()]}
                        />
                      </div>
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
                <div
                  aria-hidden="true"
                  data-viewer-runway
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: `calc(100% + ${runway.right}px)`,
                    height: `calc(100% + ${runway.bottom}px)`,
                    pointerEvents: 'none',
                    visibility: 'hidden',
                  }}
                />
              </ZoomGestureWrapper>
            </Viewport>
            {referenceViewportHost && referenceDocument ? (
              <ReferencePdfViewport
                documentId={REFERENCE_PDF_DOCUMENT_ID}
                documentState={referenceDocument}
                documentGeneration={documentGeneration}
                host={referenceViewportHost}
                {...(onViewerInteraction === undefined ? {} : { onInteraction: onViewerInteraction })}
                {...(onReferenceViewportElement === undefined ? {} : { onViewportElement: onReferenceViewportElement })}
              />
            ) : null}
            </>
          );
        }}
      </EmbedPDF>
    </div>
  );
}
