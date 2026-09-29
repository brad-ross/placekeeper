import {
  PdfAnnotationBorderStyle,
  PdfAnnotationSubtype,
  type PdfLinkAnnoObject,
  type PdfAnnotationObject,
  type PdfLinkTarget,
  type Rect,
} from '@embedpdf/models';
import type { PluginRegistry } from '@embedpdf/core';
import type { AnnotationPlugin } from '@embedpdf/plugin-annotation';
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
  fixedPdfLinkSourceRects,
  fixedViewerClientRect,
  type ViewerInteractionEvent,
  type ViewerPdfLinkSourceScope,
} from './viewer-interaction-events.js';

export const PDF_LINK_RENDERER_ID = 'link';

/** Reads the annotations currently on one source page, consulted at activation time. */
export type PdfPageLinkAnnotations = (pageIndex: number) => readonly PdfAnnotationObject[];

export interface PdfLinkControlProps {
  readonly annotation: PdfLinkAnnoObject;
  readonly sourceScope: ViewerPdfLinkSourceScope;
  readonly documentGeneration: number;
  readonly pageCount: number;
  readonly pageLinkAnnotations?: PdfPageLinkAnnotations;
  readonly onInteraction?: (event: ViewerInteractionEvent) => void;
}

export interface PdfLinkAnnotationRendererOptions {
  readonly sourceScope: ViewerPdfLinkSourceScope;
  readonly documentGeneration: number;
  readonly pageCount: number;
  /** Same-page annotations used to merge split link areas that share one target. */
  readonly pageLinkAnnotations?: PdfPageLinkAnnotations;
  readonly onInteraction?: (event: ViewerInteractionEvent) => void;
}

/** Reads a document's tracked page annotations from the EmbedPDF annotation plugin. */
export function pageLinkAnnotationsFromRegistry(
  registry: PluginRegistry | null,
  documentId: string,
): PdfPageLinkAnnotations {
  return (pageIndex) => registry
    ?.getPlugin<AnnotationPlugin>('annotation' satisfies typeof AnnotationPlugin.id)
    ?.provides()
    .forDocument(documentId)
    .getAnnotations({ pageIndex })
    .map(({ object }) => object) ?? [];
}

/**
 * Whether two same-destination link areas are pieces of one link: next to each
 * other on a line, or one wrapping from the end of a line onto the next.
 */
function adjacentLinkAreas(a: Rect, b: Rect): boolean {
  const height = Math.max(a.size.height, b.size.height, 1);
  const aCenter = a.origin.y + a.size.height / 2;
  const bCenter = b.origin.y + b.size.height / 2;
  if (Math.abs(aCenter - bCenter) <= height / 2) {
    const gap = Math.max(b.origin.x - (a.origin.x + a.size.width), a.origin.x - (b.origin.x + b.size.width), 0);
    return gap <= height * 2;
  }
  const [upper, lower] = aCenter < bCenter ? [a, b] : [b, a];
  const lineGap = lower.origin.y - (upper.origin.y + upper.size.height);
  // A wrapped link continues at the start of the next line, left of where it broke.
  return lineGap <= height && lower.origin.x < upper.origin.x;
}

/**
 * Collects the link areas that form the clicked link: same-page areas with the
 * same destination that chain to the clicked area by adjacency, in reading
 * order. A second citation of the same work elsewhere on the page is separate.
 */
export function pdfLinkSourceRects(
  clicked: PdfLinkAnnoObject,
  targetIdentity: string,
  context: { readonly documentGeneration: number; readonly pageCount: number },
  pageLinkAnnotations?: PdfPageLinkAnnotations,
): readonly Rect[] {
  let pageAnnotations: readonly PdfAnnotationObject[] = [];
  try {
    pageAnnotations = pageLinkAnnotations?.(clicked.pageIndex) ?? [];
  } catch {
    // Sibling geometry only enriches naming; the clicked area alone stays valid.
  }
  const siblings = pageAnnotations.filter((annotation): annotation is PdfLinkAnnoObject => (
    annotation.type === PdfAnnotationSubtype.LINK
    && annotation.pageIndex === clicked.pageIndex
    && annotation.id !== clicked.id
    && (() => {
      const sibling = classifyPdfNavigationTarget(annotation.target, context);
      return sibling.ok && sibling.target.identity === targetIdentity;
    })()
  ));
  const chain: Rect[] = [clicked.rect];
  let remaining = siblings.map(({ rect }) => rect);
  for (let grew = true; grew;) {
    grew = false;
    const next: Rect[] = [];
    for (const rect of remaining) {
      if (chain.some((member) => adjacentLinkAreas(member, rect))) {
        chain.push(rect);
        grew = true;
      } else {
        next.push(rect);
      }
    }
    remaining = next;
  }
  return fixedPdfLinkSourceRects(chain);
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
  pageLinkAnnotations,
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
        sourceRects: pdfLinkSourceRects(
          annotation,
          current.target.identity,
          { documentGeneration, pageCount },
          pageLinkAnnotations,
        ),
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
  id: 'placekeeper-inert-source-annotation',
  matches: (annotation) => annotation.type !== PdfAnnotationSubtype.LINK,
  render: () => <span aria-hidden="true" />,
  useAppearanceStream: false,
});

/** Render built-in non-link appearances under aria-hidden while suppressing their locked interactions. */
export function sourceAnnotationVisualRenderers(hidden: ReadonlySet<string> = new Set()): readonly BoxedAnnotationRenderer[] {
  if (hidden.size === 0) return [hiddenLinkRenderer];
  return [hiddenLinkRenderer, createRenderer({
    id: 'placekeeper-deleted-source-annotation',
    matches: (annotation): annotation is PdfAnnotationObject => hidden.has(`${annotation.pageIndex}:${annotation.id}`),
    render: () => <span aria-hidden="true" />,
    useAppearanceStream: false,
  })];
}

/** Render only project-owned accessible links in the non-hidden interaction layer. */
export function sourceAnnotationLinkRenderers(
  options: PdfLinkAnnotationRendererOptions,
): readonly BoxedAnnotationRenderer[] {
  return [createPdfLinkAnnotationRenderer(options), linkOnlyFallbackRenderer];
}
