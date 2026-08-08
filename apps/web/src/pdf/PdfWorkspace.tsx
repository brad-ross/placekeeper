import type { PluginRegistry } from '@embedpdf/core';
import { EmbedPDF, type PluginBatchRegistrations } from '@embedpdf/core/react';
import type { PdfEngine } from '@embedpdf/models';
import { AnnotationLayer } from '@embedpdf/plugin-annotation/react';
import { PagePointerProvider } from '@embedpdf/plugin-interaction-manager/react';
import { RenderLayer } from '@embedpdf/plugin-render/react';
import { Scroller } from '@embedpdf/plugin-scroll/react';
import { SelectionLayer } from '@embedpdf/plugin-selection/react';
import { Viewport } from '@embedpdf/plugin-viewport/react';
import { ZoomGestureWrapper } from '@embedpdf/plugin-zoom/react';
import { useMemo } from 'react';
import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';
import { positionOwnedRect } from './owned-overlay.js';

export interface PdfWorkspaceProps {
  engine: PdfEngine;
  plugins: PluginBatchRegistrations;
  documentLabel?: string;
  onInitialized?: (registry: PluginRegistry) => Promise<void>;
  ownedAnnotations?: readonly ReviewAnnotation[];
}

export function PdfWorkspace({
  engine,
  plugins,
  documentLabel = 'PDF document',
  onInitialized,
  ownedAnnotations = [],
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

  return (
    <div aria-label={documentLabel} role="region" style={{ height: '100%', minHeight: 480 }}>
      <EmbedPDF
        engine={engine}
        plugins={plugins}
        {...(onInitialized === undefined ? {} : { onInitialized })}
      >
        {({ activeDocumentId, activeDocument, pluginsReady }) => {
          if (!pluginsReady || !activeDocumentId || !activeDocument?.document) {
            return <p role="status">Loading local PDF…</p>;
          }
          const activePdf = activeDocument.document;

          return (
            <Viewport
              documentId={activeDocumentId}
              style={{ height: '70vh', minHeight: 480, overflow: 'auto', background: '#eceae6' }}
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
                      style={{
                        position: 'relative',
                        width: layout.rotatedWidth,
                        height: layout.rotatedHeight,
                        background: 'white',
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
                                  title={annotation.contents}
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
