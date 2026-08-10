import {
  PdfActionType,
  PdfAnnotationSubtype,
  PdfZoomMode,
  type PdfDestinationObject,
  type PdfLinkAnnoObject,
} from '@embedpdf/models';
import { describe, expect, it, vi } from 'vitest';

import {
  PDF_LINK_RENDERER_ID,
  PdfLinkControl,
  createPdfLinkAnnotationRenderer,
} from '../src/pdf/PdfLinkControl.js';

const destination: PdfDestinationObject = {
  pageIndex: 1,
  zoom: { mode: PdfZoomMode.XYZ, params: { x: 72, y: 640, zoom: 0 } },
  view: [72, 640, 0],
};

function link(target: PdfLinkAnnoObject['target']): PdfLinkAnnoObject {
  return {
    id: 'link-1',
    pageIndex: 0,
    type: PdfAnnotationSubtype.LINK,
    rect: { origin: { x: 10, y: 10 }, size: { width: 80, height: 20 } },
    target,
    contents: '\u202e<img> Equation 4',
  } as PdfLinkAnnoObject;
}

function rendererProps(currentObject: PdfLinkAnnoObject) {
  return {
    annotation: { object: currentObject, committed: true },
    currentObject,
    isSelected: false,
    isEditing: false,
    scale: 1,
    pageIndex: 0,
    documentId: 'main',
    appearanceActive: false,
  } as never;
}

describe('installed EmbedPDF link renderer replacement', () => {
  it('uses exact id link and activation emits without navigateTarget or scrolling', () => {
    const onInteraction = vi.fn();
    const navigateTarget = vi.fn();
    const scroll = vi.fn();
    const renderer = createPdfLinkAnnotationRenderer({
      sourceScope: 'main', documentGeneration: 4, pageCount: 3, onInteraction,
    });

    expect(PDF_LINK_RENDERER_ID).toBe('link');
    expect(renderer.id).toBe('link');
    const rendered = renderer.render(rendererProps(link({ type: 'destination', destination })));
    expect(rendered.type).toBe(PdfLinkControl);
    const button = PdfLinkControl(rendered.props);
    expect(button.type).toBe('button');
    expect(button.props['data-pdf-link-control']).toBe('');
    expect(button.props['aria-label']).toBe('Open PDF link to img Equation 4, Page 2');
    const opener = {
      getBoundingClientRect: () => ({
        left: 10, top: 20, right: 90, bottom: 40, width: 80, height: 20,
      }),
    } as HTMLButtonElement;
    button.props.onClick({ currentTarget: opener, preventDefault: vi.fn(), stopPropagation: vi.fn() });

    expect(onInteraction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pdf-link',
      value: expect.objectContaining({
        sourceScope: 'main',
        sourcePageIndex: 0,
        target: expect.objectContaining({ pageIndex: 1 }),
        metadata: expect.objectContaining({
          label: 'img Equation 4', pageContext: 'Page 2',
        }),
        opener,
        clientRect: { left: 10, top: 20, right: 90, bottom: 40, width: 80, height: 20 },
      }),
    }));
    expect(navigateTarget).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['external', { type: 'action', action: { type: PdfActionType.URI, uri: 'https://example.invalid' } }],
  ] as const)('rejects %s targets before chooser or navigation', (_name, target) => {
    const onInteraction = vi.fn();
    const renderer = createPdfLinkAnnotationRenderer({
      sourceScope: 'reference', documentGeneration: 4, pageCount: 3, onInteraction,
    });
    const rendered = renderer.render(rendererProps(link(target)));
    const button = PdfLinkControl(rendered.props);
    button.props.onClick({
      currentTarget: { getBoundingClientRect: vi.fn() },
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
    });

    expect(onInteraction).toHaveBeenCalledWith({
      type: 'pdf-link-unavailable',
      value: { sourceScope: 'reference', sourcePageIndex: 0 },
    });
    expect(onInteraction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'pdf-link' }));
  });
});
