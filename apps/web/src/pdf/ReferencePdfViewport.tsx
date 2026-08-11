import type { DocumentState } from '@embedpdf/core';
import { AnnotationLayer } from '@embedpdf/plugin-annotation/react';
import { PagePointerProvider } from '@embedpdf/plugin-interaction-manager/react';
import { RenderLayer } from '@embedpdf/plugin-render/react';
import { Scroller } from '@embedpdf/plugin-scroll/react';
import { Viewport } from '@embedpdf/plugin-viewport/react';
import { ZoomGestureWrapper } from '@embedpdf/plugin-zoom/react';
import { createPortal } from 'react-dom';

import {
  sourceAnnotationLinkRenderers,
  sourceAnnotationVisualRenderers,
} from './PdfLinkControl.js';
import type { ViewerInteractionEvent } from './viewer-interaction-events.js';

export interface ReferencePdfViewportProps {
  readonly documentId: string;
  readonly documentState: DocumentState;
  readonly documentGeneration: number;
  readonly host: HTMLElement;
  readonly onInteraction?: (event: ViewerInteractionEvent) => void;
  readonly onViewportElement?: (element: HTMLDivElement | null) => void;
}

/** One reusable inactive-document viewport; application tabs store snapshots, not viewer trees. */
export function ReferencePdfViewport({
  documentId,
  documentState,
  documentGeneration,
  host,
  onInteraction,
  onViewportElement,
}: ReferencePdfViewportProps) {
  const linkRenderers = sourceAnnotationLinkRenderers({
    sourceScope: 'reference',
    documentGeneration,
    pageCount: documentState.document?.pages.length ?? 0,
    ...(onInteraction === undefined ? {} : { onInteraction }),
  });

  return createPortal(
    <div
      ref={onViewportElement}
      className="pdf-workspace pdf-workspace--reference"
      data-reference-pdf-viewport
      aria-label="Reference PDF document"
      role="region"
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
