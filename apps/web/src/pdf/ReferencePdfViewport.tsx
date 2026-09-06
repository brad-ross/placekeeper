import type { DocumentState } from '@embedpdf/core';
import { AnnotationLayer } from '@embedpdf/plugin-annotation/react';
import { PagePointerProvider } from '@embedpdf/plugin-interaction-manager/react';
import { RenderLayer } from '@embedpdf/plugin-render/react';
import { Scroller } from '@embedpdf/plugin-scroll/react';
import { SelectionLayer } from '@embedpdf/plugin-selection/react';
import { Viewport } from '@embedpdf/plugin-viewport/react';
import { ZoomGestureWrapper } from '@embedpdf/plugin-zoom/react';
import { createPortal } from 'react-dom';

import type { PdfSearchResult } from './pdf-search-model.js';
import { positionOwnedRect } from './owned-overlay.js';
import {
  sourceAnnotationLinkRenderers,
  sourceAnnotationVisualRenderers,
} from './PdfLinkControl.js';
import {
  isReferenceScrollIntent,
  type ReferenceScrollPosition,
} from './reference-manual-scroll.js';
import type { ViewerInteractionEvent } from './viewer-interaction-events.js';
import { isContextPointerGesture } from './viewer-interaction-events.js';

const PDF_TEXT_SELECTION_STYLE = {
  background: 'var(--review-pdf-selection-bg)',
} as const;

export interface ReferencePdfViewportProps {
  readonly documentId: string;
  readonly documentState: DocumentState;
  readonly documentGeneration: number;
  readonly host: HTMLElement;
  readonly onInteraction?: (event: ViewerInteractionEvent) => void;
  readonly onScrollIntent?: (position: ReferenceScrollPosition) => void;
  readonly onViewportElement?: (element: HTMLDivElement | null) => void;
  readonly searchResultsByPage?: ReadonlyMap<number, readonly PdfSearchResult[]>;
}

/** One reusable inactive-document viewport; application tabs store snapshots, not viewer trees. */
export function ReferencePdfViewport({
  documentId,
  documentState,
  documentGeneration,
  host,
  onInteraction,
  onScrollIntent,
  onViewportElement,
  searchResultsByPage = new Map(),
}: ReferencePdfViewportProps) {
  const linkRenderers = sourceAnnotationLinkRenderers({
    sourceScope: 'reference',
    documentGeneration,
    pageCount: documentState.document?.pages.length ?? 0,
    ...(onInteraction === undefined ? {} : { onInteraction }),
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
                  if (isContextPointerGesture(event)) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
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
                <div
                  inert
                  aria-hidden="true"
                  data-source-annotation-layer
                  style={{ pointerEvents: 'none' }}
                >
                  <AnnotationLayer
                    documentId={documentId}
                    pageIndex={layout.pageIndex}
                    annotationRenderers={[...sourceAnnotationVisualRenderers()]}
                  />
                </div>
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
