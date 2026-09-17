import type { DocumentState } from '@embedpdf/core';
import { transformSize, type PdfEngine } from '@embedpdf/models';
import { AnnotationLayer } from '@embedpdf/plugin-annotation/react';
import { PagePointerProvider } from '@embedpdf/plugin-interaction-manager/react';
import { RenderLayer } from '@embedpdf/plugin-render/react';
import { Scroller } from '@embedpdf/plugin-scroll/react';
import { SelectionLayer } from '@embedpdf/plugin-selection/react';
import { Viewport } from '@embedpdf/plugin-viewport/react';
import { AnchoredZoomGestureWrapper as ZoomGestureWrapper } from './AnchoredZoomGestureWrapper.js';
import { createPortal } from 'react-dom';

import type { PdfSearchResult } from './pdf-search-model.js';
import { positionOwnedRect } from './owned-overlay.js';
import { combinePageRotation } from './owned-overlay.js';
import {
  sourceAnnotationLinkRenderers,
} from './PdfLinkControl.js';
import {
  isReferenceScrollIntent,
  type ReferenceScrollPosition,
} from './reference-manual-scroll.js';
import type { ViewerInteractionEvent } from './viewer-interaction-events.js';
import {
  isContextPointerGesture,
  isUnsafePageContextTarget,
  normalizePageClientPoint,
  recordViewerPointerButton,
  scopeViewerInteraction,
  VIEWER_POINTER_BUTTON_NONE,
} from './viewer-interaction-events.js';
import {
  referencePdfAnnotationSurface,
  type PdfAnnotationSurface,
} from './annotation-surface.js';
import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';
import type { OwnedMarkGeometry } from './owned-mark-hit-test.js';
import { hitTestOwnedMark } from './owned-mark-hit-test.js';
import type { ViewerPagePoint } from './viewer-interaction-events.js';
import type { AnnotationRenderingState } from './PdfAnnotationLayers.js';
import { PdfAnnotationLayers } from './PdfAnnotationLayers.js';
import type { PageContextMenuRequest } from './PdfWorkspace.js';

const PDF_TEXT_SELECTION_STYLE = {
  background: 'var(--review-pdf-selection-bg)',
} as const;

export interface ReferencePdfViewportProps {
  readonly documentId: string;
  readonly documentState: DocumentState;
  readonly documentGeneration: number;
  readonly tabIdentity: string | null;
  readonly engine: PdfEngine;
  readonly host: HTMLElement;
  readonly onInteraction?: (event: ViewerInteractionEvent) => void;
  readonly onScrollIntent?: (position: ReferenceScrollPosition) => void;
  readonly onViewportElement?: (element: HTMLDivElement | null) => void;
  readonly searchResultsByPage?: ReadonlyMap<number, readonly PdfSearchResult[]>;
  readonly annotationsByPage?: ReadonlyMap<number, readonly ReviewAnnotation[]>;
  readonly geometryByPage?: ReadonlyMap<number, readonly OwnedMarkGeometry[]>;
  readonly authoringPreviewIds?: ReadonlySet<string>;
  readonly sourceRendering?: AnnotationRenderingState;
  readonly activeOwnedAnnotationId?: string;
  readonly correspondingOwnedAnnotationId?: string;
  readonly keyboardPageNoteCursor?: ViewerPagePoint | null;
  readonly onKeyboardPageNoteKey?: (key: string) => void;
  readonly onPageContextMenu?: (
    request: PageContextMenuRequest,
    surface?: PdfAnnotationSurface,
  ) => boolean;
}

/** One reusable inactive-document viewport; application tabs store snapshots, not viewer trees. */
export function ReferencePdfViewport({
  documentId,
  documentState,
  documentGeneration,
  tabIdentity,
  engine,
  host,
  onInteraction,
  onScrollIntent,
  onViewportElement,
  searchResultsByPage = new Map(),
  annotationsByPage = new Map(),
  geometryByPage = new Map(),
  authoringPreviewIds = new Set(),
  sourceRendering = {
    hiddenSourceKeys: new Set(),
    sourceMarks: new Map(),
    residualSourceFocusMarks: [],
  },
  activeOwnedAnnotationId,
  correspondingOwnedAnnotationId,
  keyboardPageNoteCursor = null,
  onKeyboardPageNoteKey,
  onPageContextMenu,
}: ReferencePdfViewportProps) {
  const surface = referencePdfAnnotationSurface(documentGeneration, tabIdentity);
  const emit = (event: ViewerInteractionEvent) => {
    if (surface !== null) onInteraction?.(scopeViewerInteraction(event, surface));
  };
  const linkRenderers = surface === null ? [] : sourceAnnotationLinkRenderers({
    sourceScope: 'reference',
    documentGeneration,
    pageCount: documentState.document?.pages.length ?? 0,
    ...(onInteraction === undefined ? {} : { onInteraction: emit }),
  });
  const publishScrollIntent = (root: HTMLDivElement) => {
    const viewport = root.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
    if (viewport) onScrollIntent?.({ left: viewport.scrollLeft, top: viewport.scrollTop });
  };

  return createPortal(
    <div
      ref={onViewportElement}
      className="pdf-workspace pdf-workspace--reference"
      data-reference-pdf-viewport
      data-pdf-copy-surface="reference"
      data-annotation-surface="reference"
      data-reference-tab-identity={tabIdentity ?? undefined}
      aria-label="Reference PDF document"
      role="region"
      onWheelCapture={(event) => {
        if (isReferenceScrollIntent({
          kind: 'wheel',
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
        })) publishScrollIntent(event.currentTarget);
      }}
      onKeyDownCapture={(event) => {
        if (isReferenceScrollIntent({
          kind: 'key',
          key: event.key,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
        })) publishScrollIntent(event.currentTarget);
      }}
      onPointerDownCapture={(event) => {
        const viewport = event.currentTarget.querySelector<HTMLElement>(
          '[data-viewer-framing-viewport]',
        );
        if (isReferenceScrollIntent({
          kind: 'pointer',
          phase: 'down',
          pointerType: event.pointerType,
          button: event.button,
          buttons: event.buttons,
          clientX: event.clientX,
          clientY: event.clientY,
        }, viewport)) publishScrollIntent(event.currentTarget);
      }}
      onPointerMoveCapture={(event) => {
        const input = {
          kind: 'pointer',
          phase: 'move',
          pointerType: event.pointerType,
          button: event.button,
          buttons: event.buttons,
          clientX: event.clientX,
          clientY: event.clientY,
        } as const;
        if (input.buttons === 0) return;
        const viewport = input.pointerType === 'mouse'
          ? event.currentTarget.querySelector<HTMLElement>('[data-viewer-framing-viewport]')
          : null;
        if (isReferenceScrollIntent(input, viewport)) publishScrollIntent(event.currentTarget);
      }}
    >
      <Viewport
        documentId={documentId}
        className="pdf-workspace__viewport"
        data-viewer-framing-viewport
      >
        <ZoomGestureWrapper
          documentId={documentId}
          style={{ minHeight: '100%', minWidth: '100%', position: 'relative' }}
        >
          <Scroller
            documentId={documentId}
            renderPage={(layout) => (
              <PagePointerProvider
                documentId={documentId}
                pageIndex={layout.pageIndex}
                aria-label={`Reference page ${layout.pageNumber}`}
                className="pdf-workspace__page"
                data-page-index={layout.pageIndex}
                tabIndex={-1}
                onPointerDownCapture={(event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  const contextGesture = isContextPointerGesture(event);
                  recordViewerPointerButton(
                    event.currentTarget,
                    contextGesture ? VIEWER_POINTER_BUTTON_NONE : event.button,
                  );
                  if (contextGesture) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
                onPointerUpCapture={(event) => {
                  recordViewerPointerButton(
                    event.currentTarget,
                    isContextPointerGesture(event) ? VIEWER_POINTER_BUTTON_NONE : event.button,
                  );
                }}
                onContextMenu={(event) => {
                  if (onPageContextMenu === undefined || surface === null) return;
                  if (isUnsafePageContextTarget(event.target)) return;
                  const page = documentState.document?.pages[layout.pageIndex];
                  if (!page) return;
                  const bounds = event.currentTarget.getBoundingClientRect();
                  const rotation = combinePageRotation(page.rotation, documentState.rotation);
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
                  if (!point || hitTestOwnedMark(
                    geometryByPage.get(layout.pageIndex) ?? [],
                    point,
                    documentState.scale,
                  )) return;
                  const accepted = onPageContextMenu({
                    pageIndex: layout.pageIndex,
                    ...point,
                    clientX: event.clientX,
                    clientY: event.clientY,
                    keyboard: false,
                  }, surface);
                  if (accepted) event.preventDefault();
                }}
                onKeyDown={(event) => {
                  if (onPageContextMenu === undefined || surface === null) return;
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                  const page = documentState.document?.pages[layout.pageIndex];
                  if (!page) return;
                  const bounds = event.currentTarget.getBoundingClientRect();
                  const accepted = onPageContextMenu({
                    pageIndex: layout.pageIndex,
                    x: page.size.width / 2,
                    y: page.size.height / 2,
                    clientX: bounds.left + bounds.width / 2,
                    clientY: bounds.top + bounds.height / 2,
                    keyboard: true,
                  }, surface);
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
                  documentId={documentId}
                  pageIndex={layout.pageIndex}
                  style={{ pointerEvents: 'none' }}
                />
                <SelectionLayer
                  documentId={documentId}
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
                      const page = documentState.document?.pages[layout.pageIndex];
                      if (!page) return null;
                      const positioned = positionOwnedRect(
                        page,
                        layout,
                        documentState.rotation,
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
                  documentId={documentId}
                  engine={engine}
                  document={documentState.document!}
                  documentRotation={documentState.rotation}
                  layout={layout}
                  annotations={annotationsByPage.get(layout.pageIndex) ?? []}
                  geometry={surface === null
                    ? []
                    : geometryByPage.get(layout.pageIndex) ?? []}
                  authoringPreviewIds={authoringPreviewIds}
                  sourceRendering={surface === null
                    ? { ...sourceRendering, residualSourceFocusMarks: [] }
                    : sourceRendering}
                  {...(activeOwnedAnnotationId === undefined ? {} : { activeOwnedAnnotationId })}
                  {...(correspondingOwnedAnnotationId === undefined ? {} : { correspondingOwnedAnnotationId })}
                  keyboardPageNoteCursor={surface === null ? null : keyboardPageNoteCursor}
                  {...(surface === null || onKeyboardPageNoteKey === undefined
                    ? {}
                    : { onKeyboardPageNoteKey })}
                  {...(surface === null ? {} : {
                    onOwnedMarkInteraction: (value) => emit({ type: 'owned-mark', value }),
                    onSourceMarkInteraction: (annotationKey, pageIndex) => emit({
                      type: 'source-mark',
                      value: { annotationKey, phase: 'activate', pageIndex },
                    }),
                  })}
                />
                <div data-source-link-layer>
                  <AnnotationLayer
                    documentId={documentId}
                    pageIndex={layout.pageIndex}
                    annotationRenderers={[...linkRenderers]}
                  />
                </div>
              </PagePointerProvider>
            )}
          />
        </ZoomGestureWrapper>
      </Viewport>
    </div>,
    host,
  );
}
