import {
  PdfAnnotationBorderStyle,
  PdfAnnotationSubtype,
  type PdfLinkAnnoObject,
  type PdfLinkTarget,
} from '@embedpdf/models';
import {
  createRenderer,
  type BoxedAnnotationRenderer,
} from '@embedpdf/plugin-annotation/react';
import type { CSSProperties, MouseEvent, PointerEvent } from 'react';

import { createPdfNavigationMetadata } from './pdf-navigation-metadata.js';
import { classifyPdfNavigationTarget } from './pdf-navigation-target.js';
import {
  PDF_LINK_ACTION_MENU_ID,
  PDF_LINK_INTERACTION_ATTRIBUTE,
  fixedViewerClientRect,
  type ViewerInteractionEvent,
  type ViewerPdfLinkSourceScope,
} from './viewer-interaction-events.js';

export const PDF_LINK_RENDERER_ID = 'link';

export interface PdfLinkControlProps {
  readonly annotation: PdfLinkAnnoObject;
  readonly sourceScope: ViewerPdfLinkSourceScope;
  readonly documentGeneration: number;
  readonly pageCount: number;
  readonly onInteraction?: (event: ViewerInteractionEvent) => void;
}

export interface PdfLinkAnnotationRendererOptions {
  readonly sourceScope: ViewerPdfLinkSourceScope;
  readonly documentGeneration: number;
  readonly pageCount: number;
  readonly onInteraction?: (event: ViewerInteractionEvent) => void;
}

function stopPointerFallthrough(event: PointerEvent<HTMLButtonElement>): void {
  event.stopPropagation();
}

function linkBorderStyle(annotation: PdfLinkAnnoObject): CSSProperties {
  const width = Math.max(0, annotation.strokeWidth ?? 1);
  if (width === 0) return {};
  const color = annotation.strokeColor ?? 'transparent';
  const style = annotation.strokeStyle === PdfAnnotationBorderStyle.DASHED
    ? 'dashed'
    : 'solid';
  return annotation.strokeStyle === PdfAnnotationBorderStyle.UNDERLINE
    ? { borderBottom: `${width}px ${style} ${color}` }
    : { border: `${width}px ${style} ${color}` };
}

function accessibleLinkName(label: string, pageContext: string): string {
  return label === pageContext ? `Open PDF link to ${label}` : `Open PDF link to ${label}, ${pageContext}`;
}

/** Native PDF-link control. It emits the raw public target only into the project-owned classifier. */
export function PdfLinkControl({
  annotation,
  sourceScope,
  documentGeneration,
  pageCount,
  onInteraction,
}: PdfLinkControlProps) {
  const classification = classifyPdfNavigationTarget(annotation.target, {
    documentGeneration,
    pageCount,
  });
  const metadata = classification.ok
    ? createPdfNavigationMetadata({
      contents: annotation.contents,
      subject: annotation.subject,
      pageIndex: classification.target.pageIndex,
    })
    : null;

  const activate = (
    rawTarget: PdfLinkTarget | undefined,
    event: MouseEvent<HTMLButtonElement> | {
      readonly currentTarget: HTMLButtonElement;
      preventDefault(): void;
      stopPropagation(): void;
    },
  ) => {
    event.preventDefault();
    event.stopPropagation();
    // Reclassify the raw activation-time target so no malformed value can cross
    // the neutral viewer-event boundary after a renderer update.
    const current = classifyPdfNavigationTarget(rawTarget, { documentGeneration, pageCount });
    if (!current.ok) {
      onInteraction?.({
        type: 'pdf-link-unavailable',
        value: { sourceScope, sourcePageIndex: annotation.pageIndex },
      });
      return;
    }
    const safeMetadata = createPdfNavigationMetadata({
      contents: annotation.contents,
      subject: annotation.subject,
      pageIndex: current.target.pageIndex,
    });
    onInteraction?.({
      type: 'pdf-link',
      value: {
        sourceScope,
        sourcePageIndex: annotation.pageIndex,
        target: current.target,
        metadata: safeMetadata,
        opener: event.currentTarget,
        clientRect: fixedViewerClientRect(event.currentTarget.getBoundingClientRect()),
      },
    });
  };

  return (
    <button
      type="button"
      {...{ [PDF_LINK_INTERACTION_ATTRIBUTE]: '' }}
      className="pdf-link-control"
      aria-label={metadata === null
        ? 'PDF link target unavailable'
        : accessibleLinkName(metadata.label, metadata.pageContext)}
      title={metadata === null ? 'PDF link target unavailable' : 'Open link actions'}
      aria-haspopup="menu"
      aria-controls={PDF_LINK_ACTION_MENU_ID}
      aria-expanded={false}
      onPointerDown={stopPointerFallthrough}
      onPointerUp={stopPointerFallthrough}
      onClick={(event) => activate(annotation.target, event)}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        padding: 0,
        border: 0,
        background: 'transparent',
        cursor: classification.ok ? 'pointer' : 'not-allowed',
        // EmbedPDF's annotation container disables pointer events by default;
        // the project-owned native control is the intentional hit target.
        pointerEvents: 'auto',
        ...linkBorderStyle(annotation),
      }}
    />
  );
}

export function createPdfLinkAnnotationRenderer(
  options: PdfLinkAnnotationRendererOptions,
): BoxedAnnotationRenderer {
  return createRenderer<PdfLinkAnnoObject>({
    id: PDF_LINK_RENDERER_ID,
    // Keep project-owned link hit targets above the render/selection layers.
    // Keyboard focus can reach a lower layer, but pointer hit testing cannot.
    zIndex: 10,
    matches: (annotation): annotation is PdfLinkAnnoObject => annotation.type === PdfAnnotationSubtype.LINK,
    render: ({ currentObject }) => (
      <PdfLinkControl annotation={currentObject} {...options} />
    ),
    interactionDefaults: {
      isDraggable: false,
      isResizable: false,
      isRotatable: false,
    },
    useAppearanceStream: false,
  });
}

const hiddenLinkRenderer = createRenderer<PdfLinkAnnoObject>({
  id: PDF_LINK_RENDERER_ID,
  matches: (annotation): annotation is PdfLinkAnnoObject => annotation.type === PdfAnnotationSubtype.LINK,
  render: () => <span aria-hidden="true" />,
  useAppearanceStream: false,
});

const linkOnlyFallbackRenderer = createRenderer({
  id: 'pdf-proofreader-inert-source-annotation',
  matches: (annotation) => annotation.type !== PdfAnnotationSubtype.LINK,
  render: () => <span aria-hidden="true" />,
  useAppearanceStream: false,
});

/** Render built-in non-link appearances under aria-hidden while suppressing their locked interactions. */
export function sourceAnnotationVisualRenderers(): readonly BoxedAnnotationRenderer[] {
  return [hiddenLinkRenderer];
}

/** Render only project-owned accessible links in the non-hidden interaction layer. */
export function sourceAnnotationLinkRenderers(
  options: PdfLinkAnnotationRendererOptions,
): readonly BoxedAnnotationRenderer[] {
  return [createPdfLinkAnnotationRenderer(options), linkOnlyFallbackRenderer];
}
