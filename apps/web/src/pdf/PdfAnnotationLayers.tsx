import type { PdfDocumentObject, PdfEngine, PdfPageObject, Rotation } from '@embedpdf/models';
import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';
import { ReviewIcon } from '../review/ReviewIcon.js';
import { reviewItemIdForAnnotation } from '../review/annotation-projection.js';
import type { ExistingAnnotation, SourceNativeAnnotation } from './existing-annotations.js';
import { existingAnnotationKey } from './existing-annotations.js';
import { OwnedTextMark } from './OwnedTextMark.js';
import { ownedMarkStyle, positionOwnedRect } from './owned-overlay.js';
import type { OwnedMarkGeometry } from './owned-mark-hit-test.js';
import { SourceAnnotationLayer, type SourceReaderMark } from './SourceAnnotationMark.js';
import type {
  ViewerOwnedMarkInteraction,
  ViewerPagePoint,
  ViewerSourceMarkInteraction,
} from './viewer-interaction-events.js';

export interface AnnotationRenderingState {
  readonly hiddenSourceKeys: ReadonlySet<string>;
  readonly sourceMarks: ReadonlyMap<string, SourceReaderMark>;
  readonly residualSourceFocusMarks: readonly Pick<ExistingAnnotation,
    'id' | 'pageIndex' | 'rect' | 'contents'>[];
}

/** Keep source ownership frozen to the inventory that was captured for this document. */
export function buildAnnotationRenderingState(
  ownedAnnotations: readonly ReviewAnnotation[],
  sourceNativeAnnotations: readonly SourceNativeAnnotation[],
  sourceAnnotations: readonly ExistingAnnotation[],
): AnnotationRenderingState {
  const ownedById = new Map(ownedAnnotations.map((annotation) => [annotation.id, annotation]));
  const nativeKeys = new Set(sourceNativeAnnotations.map(({ pageIndex, sourceId }) => (
    existingAnnotationKey({ pageIndex, id: sourceId })
  )));
  const hiddenSourceKeys = new Set<string>();
  const sourceMarks = new Map<string, SourceReaderMark>();

  for (const source of sourceNativeAnnotations) {
    const key = existingAnnotationKey({ pageIndex: source.pageIndex, id: source.sourceId });
    const annotation = ownedById.get(source.id);
    if (!annotation) {
      hiddenSourceKeys.add(key);
      continue;
    }
    if (source.readerStyle) {
      sourceMarks.set(key, {
        style: source.readerStyle,
        contents: annotation.contents,
        pageIndex: source.pageIndex,
        ownedAnnotationId: reviewItemIdForAnnotation(annotation),
      });
    }
  }

  for (const source of sourceAnnotations) {
    const key = existingAnnotationKey(source);
    if (nativeKeys.has(key) || !source.readerStyle) continue;
    sourceMarks.set(key, {
      style: source.readerStyle,
      contents: source.contents,
      pageIndex: source.pageIndex,
      annotationKey: key,
    });
  }
  return {
    hiddenSourceKeys,
    sourceMarks,
    residualSourceFocusMarks: sourceAnnotations
      .filter((source) => {
        const key = existingAnnotationKey(source);
        return !nativeKeys.has(key) && !hiddenSourceKeys.has(key);
      })
      .map(({ id, pageIndex, rect, contents }) => ({
        id,
        pageIndex,
        rect,
        contents,
      })),
  };
}

interface PageLayout {
  readonly pageIndex: number;
  readonly pageNumber: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotatedWidth: number;
  readonly rotatedHeight: number;
  readonly elevated: boolean;
}

export interface PdfAnnotationLayersProps {
  readonly documentId: string;
  readonly engine: PdfEngine;
  readonly document: PdfDocumentObject;
  readonly documentRotation: Rotation;
  readonly layout: PageLayout;
  readonly annotations: readonly ReviewAnnotation[];
  readonly geometry: readonly OwnedMarkGeometry[];
  readonly authoringPreviewIds: ReadonlySet<string>;
  readonly sourceRendering: AnnotationRenderingState;
  readonly activeOwnedAnnotationId?: string;
  readonly correspondingOwnedAnnotationId?: string;
  readonly keyboardPageNoteCursor?: ViewerPagePoint | null;
  readonly onKeyboardPageNoteKey?: (key: string) => void;
  readonly onOwnedMarkInteraction?: (interaction: ViewerOwnedMarkInteraction) => void;
  readonly onSourceMarkInteraction?: (interaction: ViewerSourceMarkInteraction) => void;
}

/** Nonpainting geometry for native owned annotations whose visible appearance is rendered by EmbedPDF. */
export function OwnedNativeAnnotationGeometryTargets({
  annotations,
  page,
  layout,
  documentRotation,
}: {
  readonly annotations: readonly ReviewAnnotation[];
  readonly page: PdfPageObject;
  readonly layout: PageLayout;
  readonly documentRotation: Rotation;
}) {
  return <>{annotations.flatMap((annotation) => {
    if (annotation.kind !== 'pdfAnnotation' || annotation.pageIndex !== layout.pageIndex) return [];
    return (annotation.quadPoints ?? [annotation.rect]).map((rect, index) => {
      const transformed = positionOwnedRect(page, layout, documentRotation, rect);
      return <span
        key={`${annotation.id}:${index}`}
        data-owned-native-geometry="true"
        data-review-id={reviewItemIdForAnnotation(annotation)}
        data-page-index={layout.pageIndex}
        style={{
          position: 'absolute',
          left: transformed.origin.x,
          top: transformed.origin.y,
          width: transformed.size.width,
          height: transformed.size.height,
          pointerEvents: 'none',
        }}
      />;
    });
  })}</>;
}

/** Canonical annotation projection used by Main and the active Reference document. */
export function PdfAnnotationLayers({
  documentId,
  engine,
  document,
  documentRotation,
  layout,
  annotations,
  geometry,
  authoringPreviewIds,
  sourceRendering,
  activeOwnedAnnotationId,
  correspondingOwnedAnnotationId,
  keyboardPageNoteCursor,
  onKeyboardPageNoteKey,
  onOwnedMarkInteraction,
  onSourceMarkInteraction,
}: PdfAnnotationLayersProps) {
  const page = document.pages[layout.pageIndex];
  if (!page) return null;
  return <>
    <div
      inert
      aria-hidden="true"
      data-owned-annotation-layer
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
    >
      <OwnedNativeAnnotationGeometryTargets
        annotations={annotations}
        page={page}
        layout={layout}
        documentRotation={documentRotation}
      />
      {annotations.flatMap((annotation) => {
        if (annotation.kind === 'pdfAnnotation') return [];
        return (annotation.quadPoints ?? [annotation.rect]).map((rect, index) => (
          <OwnedTextMark
            engine={engine}
            document={document}
            page={page}
            rect={rect}
            textAnchored={['highlight', 'delete', 'replace'].includes(annotation.kind)}
            key={`${annotation.id}:${index}`}
            data-owned-mark={annotation.kind}
            data-pdf-mark-style={annotation.kind}
            data-page-index={layout.pageIndex}
            data-has-attached-text={annotation.contents.trim().length > 0 ? 'true' : 'false'}
            data-review-id={reviewItemIdForAnnotation(annotation)}
            data-authoring-preview={authoringPreviewIds.has(annotation.id) ? 'true' : undefined}
            data-corresponding={correspondingOwnedAnnotationId === reviewItemIdForAnnotation(annotation) ? 'true' : 'false'}
            data-active={activeOwnedAnnotationId === reviewItemIdForAnnotation(annotation) ? 'true' : 'false'}
            style={ownedMarkStyle(page, layout, documentRotation, rect)}
          >
            {annotation.kind === 'pageNote' ? <ReviewIcon name="note" size={14} /> : null}
          </OwnedTextMark>
        ));
      })}
    </div>
    <div className="owned-mark-focus-layer" data-owned-focus-layer>
      {geometry.map((group) => {
        const annotation = annotations.find(
          (candidate) => reviewItemIdForAnnotation(candidate) === group.id,
        );
        const rect = group.rects[0];
        if (!annotation || !rect) return null;
        const transformed = positionOwnedRect(page, layout, documentRotation, rect);
        return <button
          key={group.id}
          type="button"
          className="owned-mark-focus-proxy"
          data-owned-focus-id={group.id}
          data-page-index={layout.pageIndex}
          aria-label={`${annotation.kind} annotation on page ${annotation.pageIndex + 1}`}
          title={`Go to ${annotation.kind} annotation on page ${annotation.pageIndex + 1}`}
          onFocus={() => onOwnedMarkInteraction?.({
            id: group.id, phase: 'focus', pageIndex: layout.pageIndex,
          })}
          onBlur={() => onOwnedMarkInteraction?.({
            id: group.id, phase: 'blur', pageIndex: layout.pageIndex,
          })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') event.preventDefault();
          }}
          onKeyUp={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onOwnedMarkInteraction?.({
              id: group.id,
              phase: 'activate',
              pageIndex: layout.pageIndex,
              placement: {
                left: event.currentTarget.getBoundingClientRect().left,
                top: event.currentTarget.getBoundingClientRect().top,
              },
            });
          }}
          style={{ left: transformed.origin.x, top: transformed.origin.y }}
        />;
      })}
      {sourceRendering.residualSourceFocusMarks
        .filter((mark) => mark.pageIndex === layout.pageIndex)
        .map((mark) => {
          const transformed = positionOwnedRect(page, layout, documentRotation, mark.rect);
          const annotationKey = existingAnnotationKey(mark);
          return <button
            key={annotationKey}
            type="button"
            className="owned-mark-focus-proxy"
            data-source-focus-id={annotationKey}
            data-page-index={layout.pageIndex}
            data-review-contextual-ui
            aria-label={`Source annotation on page ${layout.pageNumber}`}
            title={mark.contents.trim().length > 0
              ? `Open source annotation on page ${layout.pageNumber}`
              : `Source annotation details on page ${layout.pageNumber}`}
            onPointerEnter={(event) => onSourceMarkInteraction?.({
              annotationKey,
              phase: 'enter',
              pageIndex: layout.pageIndex,
              placement: {
                left: event.currentTarget.getBoundingClientRect().left,
                top: event.currentTarget.getBoundingClientRect().top,
              },
            })}
            onPointerLeave={() => onSourceMarkInteraction?.({
              annotationKey, phase: 'leave', pageIndex: layout.pageIndex,
            })}
            onFocus={(event) => onSourceMarkInteraction?.({
              annotationKey,
              phase: 'focus',
              pageIndex: layout.pageIndex,
              placement: {
                left: event.currentTarget.getBoundingClientRect().left,
                top: event.currentTarget.getBoundingClientRect().top,
              },
            })}
            onBlur={() => onSourceMarkInteraction?.({
              annotationKey, phase: 'blur', pageIndex: layout.pageIndex,
            })}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSourceMarkInteraction?.({
                annotationKey,
                phase: 'activate',
                pageIndex: layout.pageIndex,
                placement: {
                  left: event.currentTarget.getBoundingClientRect().left,
                  top: event.currentTarget.getBoundingClientRect().top,
                },
              });
            }}
            style={{
              left: transformed.origin.x + transformed.size.width / 2,
              top: transformed.origin.y + transformed.size.height / 2,
              pointerEvents: 'auto',
            }}
          />;
        })}
    </div>
    {keyboardPageNoteCursor?.pageIndex === layout.pageIndex ? (() => {
      const transformed = positionOwnedRect(page, layout, documentRotation, {
        x: keyboardPageNoteCursor.x,
        y: keyboardPageNoteCursor.y,
        width: 1,
        height: 1,
      });
      return <button
        type="button"
        autoFocus
        className="page-note-placement-cursor"
        data-review-contextual-ui
        data-page-index={layout.pageIndex}
        aria-label="Page Note placement cursor. Use arrow keys to move, Enter to place, or Escape to cancel."
        title="Place Page Note"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          onKeyboardPageNoteKey?.(event.key);
        }}
        style={{ left: transformed.origin.x, top: transformed.origin.y }}
      ><ReviewIcon name="plus" /></button>;
    })() : null}
    <div
      aria-hidden="true"
      data-source-annotation-layer
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
    >
      <SourceAnnotationLayer
        documentId={documentId}
        document={document}
        engine={engine}
        pageIndex={layout.pageIndex}
        marks={sourceRendering.sourceMarks}
        hidden={sourceRendering.hiddenSourceKeys}
      />
    </div>
  </>;
}
