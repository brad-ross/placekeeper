import { sourceAnnotationVisualRenderers } from './PdfLinkControl.js';
import { existingAnnotationKey } from './existing-annotations.js';
import { PdfAnnotationName, PdfAnnotationSubtype, type PdfAnnotationObject, type PdfDocumentObject, type PdfEngine } from '@embedpdf/models';
import { AnnotationLayer, createRenderer } from '@embedpdf/plugin-annotation/react';
import { useId, useMemo, type CSSProperties } from 'react';
import { ANNOTATION_PALETTE } from '../../../../packages/core/src/annotation-appearance.js';
import { OwnedTextMark } from './OwnedTextMark.js';
import { ReviewIcon } from '../review/ReviewIcon.js';
import type { SourceAnnotationStyle } from './source-annotation-style.js';

export interface SourceReaderMark {
  readonly style: SourceAnnotationStyle;
  readonly contents: string;
  readonly pageIndex: number;
  readonly ownedAnnotationId?: string;
  readonly annotationKey?: string;
}

/** DOM identity shared by native-source visuals that represent an owned review item. */
export function sourceReaderMarkIdentityAttributes(
  entry: Pick<SourceReaderMark, 'ownedAnnotationId'>,
): { readonly 'data-review-id'?: string } {
  return entry.ownedAnnotationId === undefined
    ? {}
    : { 'data-review-id': entry.ownedAnnotationId };
}

function markKind(annotation: PdfAnnotationObject) {
  switch (annotation.type) {
    case PdfAnnotationSubtype.HIGHLIGHT: return 'highlight';
    case PdfAnnotationSubtype.STRIKEOUT: return 'delete';
    case PdfAnnotationSubtype.UNDERLINE: return 'underline';
    case PdfAnnotationSubtype.SQUIGGLY: return 'squiggly';
    case PdfAnnotationSubtype.CARET: return 'insert';
    case PdfAnnotationSubtype.TEXT: return annotation.name === PdfAnnotationName.Insert ? 'insert' : 'pageNote';
    default: return undefined;
  }
}

export function sourceMarkVariables(annotation: PdfAnnotationObject, style: SourceAnnotationStyle): CSSProperties {
  const color = style.hasExplicitColor && 'strokeColor' in annotation ? annotation.strokeColor : undefined;
  const fillOpacity = style.opacity ?? ANNOTATION_PALETTE.noteOpacity;
  const fill = color ?? ANNOTATION_PALETTE.noteFill;
  return {
    ...(style.opacity === undefined ? {} : { opacity: style.opacity }),
    ...((color === undefined && style.opacity === undefined) ? {} : {
      '--pdf-note-fill': `color-mix(in srgb, ${fill} ${(style.opacity === undefined ? fillOpacity : 1) * 100}%, transparent)`,
      '--pdf-comment-fill': `color-mix(in srgb, ${fill} ${(style.opacity === undefined ? ANNOTATION_PALETTE.commentOpacity : 1) * 100}%, transparent)`,
    }),
    ...(color === undefined ? {} : {
      '--pdf-note-ink': color,
      '--pdf-edit-ink': color,
      '--pdf-correction-ink': color,
    }),
  } as CSSProperties;
}

function SourceSquiggle({ width, scale }: { width: number; scale: number }) {
  const id = useId();
  return <svg viewBox={`0 0 ${width} 4`} preserveAspectRatio="none"
    style={{ position: 'absolute', left: 0, bottom: 0, width: '100%', height: 4 * scale, color: 'var(--pdf-note-ink)' }}>
    <defs><pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse">
      <path d="M -2 2 Q -1 0 0 2 T 2 2 T 4 2 T 6 2" fill="none" stroke="currentColor" strokeWidth={ANNOTATION_PALETTE.underlineWidth} />
    </pattern></defs>
    <rect width="100%" height="4" fill={`url(#${id})`} />
  </svg>;
}

function createSourceAnnotationRenderer(
  marks: ReadonlyMap<string, SourceReaderMark>,
  engine: PdfEngine,
  document: PdfDocumentObject,
) {
  return createRenderer({
    id: 'placekeeper-source-reader-style',
    zIndex: 9,
    matches: (annotation): annotation is PdfAnnotationObject =>
      marks.has(existingAnnotationKey(annotation)) && !annotation.appearanceModes &&
      !annotation.rotation && !annotation.unrotatedRect && markKind(annotation) !== undefined,
    useAppearanceStream: false,
    render: ({ currentObject, scale }) => {
      const entry = marks.get(existingAnnotationKey(currentObject))!;
      const kind = markKind(currentObject)!;
      const page = document.pages[currentObject.pageIndex];
      if (!page) return <span />;
      const annotation = { ...currentObject, contents: entry.contents };
      const segments = 'segmentRects' in annotation && annotation.segmentRects.length > 0 ? annotation.segmentRects : [annotation.rect];
      return <>{segments.map((segment, index) => {
        const rect = { x: segment.origin.x, y: segment.origin.y, width: segment.size.width, height: segment.size.height };
        return <OwnedTextMark
          key={index} engine={engine} document={document} page={page} rect={rect}
          textAnchored={kind === 'highlight' || kind === 'delete'}
          data-source-reader-mark={kind} data-pdf-mark-style={kind}
          {...sourceReaderMarkIdentityAttributes(entry)}
          data-page-index={entry.pageIndex}
          data-has-attached-text={entry.contents.trim().length > 0 ? 'true' : 'false'}
          style={{ position: 'absolute',
            left: (rect.x - annotation.rect.origin.x) * scale,
            top: (rect.y - annotation.rect.origin.y) * scale,
            width: rect.width * scale, height: rect.height * scale,
            ...{ '--pdf-mark-scale': scale }, ...sourceMarkVariables(annotation, entry.style),
          }}
        >{kind === 'pageNote' ? <ReviewIcon name="note" size={14} /> : kind === 'squiggly' ? <SourceSquiggle width={rect.width} scale={scale} /> : null}</OwnedTextMark>;
      })}</>;
    },
  });
}

export function SourceAnnotationLayer({
  marks,
  hidden,
  engine,
  document,
  documentId,
  pageIndex,
}: {
  marks: ReadonlyMap<string, SourceReaderMark>;
  hidden: ReadonlySet<string>;
  engine: PdfEngine;
  document: PdfDocumentObject;
  documentId: string;
  pageIndex: number;
}) {
  const renderers = useMemo(() => [
    ...sourceAnnotationVisualRenderers(hidden),
    createSourceAnnotationRenderer(marks, engine, document),
  ], [hidden, marks, engine, document]);
  return <AnnotationLayer documentId={documentId} pageIndex={pageIndex} annotationRenderers={renderers} />;
}
