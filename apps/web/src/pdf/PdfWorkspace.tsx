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
import { useMemo } from 'react';
import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';
import { combinePageRotation, positionOwnedRect } from './owned-overlay.js';
import { groupOwnedMarkGeometryByPage, hitTestOwnedMark } from './owned-mark-hit-test.js';
import {
  isUnsafePageContextTarget,
  normalizePageClientPoint,
  recordViewerPointerButton,
  type ViewerOwnedMarkInteraction,
  type ViewerPagePoint,
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
}: PdfWorkspaceProps) {
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
        {({ activeDocumentId, activeDocument, pluginsReady }) => {
          if (!pluginsReady || !activeDocumentId || !activeDocument?.document) {
            return <div className="pdf-workspace__loading" role="status">Loading local PDF…</div>;
          }
          const activePdf = activeDocument.document;

          return (
            <Viewport
              documentId={activeDocumentId}
              style={{ height: '100%', overflow: 'auto', background: '#eceae6' }}
            >
              <ZoomGestureWrapper documentId={activeDocumentId} style={{ minHeight: '100%' }}>
                <Scroller
                  documentId={activeDocumentId}
                  renderPage={(layout) => (
                    <PagePointerProvider
                      documentId={activeDocumentId}
                      pageIndex={layout.pageIndex}
                      aria-label={`Page ${layout.pageNumber}`}
                      data-page-index={layout.pageIndex}
                      tabIndex={-1}
                      onPointerDownCapture={(event) => {
                        recordViewerPointerButton(event.currentTarget, event.button);
                        event.currentTarget.focus({ preventScroll: true });
                      }}
                      onPointerUpCapture={(event) => {
                        recordViewerPointerButton(event.currentTarget, event.button);
                      }}
                      onContextMenu={(event) => {
                        if (onPageContextMenu === undefined || isUnsafePageContextTarget(event.target)) return;
                        const page = activePdf.pages[layout.pageIndex];
                        if (!page) return;
                        const bounds = event.currentTarget.getBoundingClientRect();
                        const rotation = combinePageRotation(page.rotation, activeDocument.rotation);
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
                        const canonicalPoint = {
                          x: point.x + (page.boxes?.crop.left ?? 0),
                          y: point.y + (page.boxes?.crop.top ?? 0),
                        };
                        if (hitTestOwnedMark(
                          geometryByPage.get(layout.pageIndex) ?? [],
                          canonicalPoint,
                        )) return;
                        const accepted = onPageContextMenu({
                          pageIndex: layout.pageIndex,
                          ...canonicalPoint,
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
                          x: page.size.width / 2 + (page.boxes?.crop.left ?? 0),
                          y: page.size.height / 2 + (page.boxes?.crop.top ?? 0),
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
                        background: 'white',
                        outline: 'none',
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                      }}
                    >
                      <RenderLayer
                        documentId={activeDocumentId}
                        pageIndex={layout.pageIndex}
                        style={{ pointerEvents: 'none' }}
                      />
                      <SelectionLayer documentId={activeDocumentId} pageIndex={layout.pageIndex} />
                      <div
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
                                activeDocument.rotation,
                                rect,
                              );
                              const fill = annotation.kind === 'highlight'
                                ? 'rgba(255, 213, 79, .42)'
                                : annotation.kind === 'insert' || annotation.kind === 'pageNote'
                                  ? 'rgba(21, 101, 192, .22)'
                                  : 'rgba(211, 47, 47, .2)';
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
                                    background: fill,
                                    borderBottom: annotation.kind === 'replace' || annotation.kind === 'delete'
                                      ? '2px solid #d32f2f'
                                      : undefined,
                                    boxSizing: 'border-box',
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
                          const transformed = positionOwnedRect(page, layout, activeDocument.rotation, rect);
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
                          activeDocument.rotation,
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
                            <span aria-hidden="true">+</span>
                          </button>
                        );
                      })() : null}
                      <div
                        aria-hidden="true"
                        data-source-annotation-layer
                        style={{ pointerEvents: 'none' }}
                      >
                        <AnnotationLayer
                          documentId={activeDocumentId}
                          pageIndex={layout.pageIndex}
                        />
                      </div>
                    </PagePointerProvider>
                  )}
                />
              </ZoomGestureWrapper>
            </Viewport>
          );
        }}
      </EmbedPDF>
    </div>
  );
}
