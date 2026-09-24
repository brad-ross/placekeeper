import {
  PdfActionType,
  PdfAnnotationSubtype,
  PdfZoomMode,
  type PdfAnnotationObject,
  type PdfDestinationObject,
  type PdfLinkAnnoObject,
} from '@embedpdf/models';
import { describe, expect, it, vi } from 'vitest';

import {
  PDF_LINK_RENDERER_ID,
  PdfLinkControl,
  createPdfLinkAnnotationRenderer,
} from '../src/pdf/PdfLinkControl.js';
import { PDF_LINK_ACTION_MENU_ID } from '../src/pdf/viewer-interaction-events.js';

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
    expect(renderer.zIndex).toBeGreaterThan(2);
    const rendered = renderer.render(rendererProps(link({ type: 'destination', destination })));
    expect(rendered.type).toBe(PdfLinkControl);
    const button = PdfLinkControl(rendered.props);
    expect(button.type).toBe('button');
    expect(button.props['data-pdf-link-control']).toBe('');
    expect(button.props['aria-label']).toBe('Open PDF link to img Equation 4, Page 2');
    expect(button.props.title).toBe('Open link actions');
    expect(button.props['aria-haspopup']).toBe('menu');
    expect(button.props['aria-controls']).toBe(PDF_LINK_ACTION_MENU_ID);
    expect(button.props['aria-expanded']).toBe(false);
    expect(button.props.style.pointerEvents).toBe('auto');
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
        sourceRects: [{ origin: { x: 10, y: 10 }, size: { width: 80, height: 20 } }],
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
    expect(button.props.title).toBe('PDF link target unavailable');
    button.props.onClick({
      currentTarget: { getBoundingClientRect: vi.fn() },
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
    });

    expect(onInteraction).toHaveBeenCalledWith({
      type: 'pdf-link-unavailable',
      value: { sourceScope: 'reference', sourcePageIndex: 0 },
    });
    expect(onInteraction.mock.calls[0]![0].value).not.toHaveProperty('sourceRects');
    expect(onInteraction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'pdf-link' }));
  });
});

describe('PDF link source geometry', () => {
  const otherDestination: PdfDestinationObject = {
    pageIndex: 2,
    zoom: { mode: PdfZoomMode.XYZ, params: { x: 72, y: 300, zoom: 0 } },
    view: [72, 300, 0],
  };
  const rect = (x: number, y: number, width = 40, height = 10) => ({
    origin: { x, y }, size: { width, height },
  });
  function pageLink(
    id: string,
    at: ReturnType<typeof rect>,
    target: PdfLinkAnnoObject['target'],
    pageIndex = 0,
  ): PdfLinkAnnoObject {
    return {
      id, pageIndex, type: PdfAnnotationSubtype.LINK, rect: at, target,
    } as PdfLinkAnnoObject;
  }
  const opener = {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1 }),
  } as HTMLButtonElement;

  function activate(
    clicked: PdfLinkAnnoObject,
    pageLinkAnnotations?: (pageIndex: number) => readonly PdfAnnotationObject[],
  ) {
    const onInteraction = vi.fn();
    const renderer = createPdfLinkAnnotationRenderer({
      sourceScope: 'main',
      documentGeneration: 4,
      pageCount: 3,
      onInteraction,
      ...(pageLinkAnnotations === undefined ? {} : { pageLinkAnnotations }),
    });
    const rendered = renderer.render(rendererProps(clicked));
    PdfLinkControl(rendered.props).props.onClick({
      currentTarget: opener, preventDefault: vi.fn(), stopPropagation: vi.fn(),
    });
    return onInteraction.mock.calls[0]![0];
  }

  it('emits only its own rect when the page has no other same-target link', () => {
    const own = pageLink('a', rect(100, 50), { type: 'destination', destination });
    const other = pageLink('b', rect(10, 50), { type: 'destination', destination: otherDestination });

    expect(activate(own, () => [own, other]).value.sourceRects).toEqual([rect(100, 50)]);
  });

  it('merges every same-target link area on the page, in reading order, for each control', () => {
    // natbib splits "Agarwal, Dahleh, et al. (2023)" across a line break.
    const secondLine = pageLink('cite-2', rect(20, 62, 30), { type: 'destination', destination });
    const firstLine = pageLink('cite-1', rect(400, 50, 120), {
      type: 'destination', destination: { ...destination },
    });
    const unrelated = pageLink('eq-1', rect(10, 50, 20), { type: 'destination', destination: otherDestination });
    const offPage = pageLink('cite-3', rect(20, 5), { type: 'destination', destination }, 1);
    const page = () => [secondLine, unrelated, firstLine, offPage];
    const expected = [rect(400, 50, 120), rect(20, 62, 30)];

    expect(activate(firstLine, page).value.sourceRects).toEqual(expected);
    expect(activate(secondLine, page).value.sourceRects).toEqual(expected);
  });

  it('keeps a second citation of the same work on the page separate from the clicked one', () => {
    // natbib author and year pieces sit together; the same work is cited again lower down.
    const author = pageLink('cite-a', rect(100, 50, 90), { type: 'destination', destination });
    const year = pageLink('cite-y', rect(195, 50, 30), { type: 'destination', destination: { ...destination } });
    const laterSameLine = pageLink('cite-b', rect(420, 50, 90), { type: 'destination', destination: { ...destination } });
    const laterParagraph = pageLink('cite-c', rect(60, 200, 90), { type: 'destination', destination: { ...destination } });
    const page = () => [author, year, laterSameLine, laterParagraph];

    expect(activate(author, page).value.sourceRects).toEqual([rect(100, 50, 90), rect(195, 50, 30)]);
    expect(activate(laterSameLine, page).value.sourceRects).toEqual([rect(420, 50, 90)]);
    expect(activate(laterParagraph, page).value.sourceRects).toEqual([rect(60, 200, 90)]);
  });

  it('never merges links whose targets classify to different identities', () => {
    const own = pageLink('a', rect(10, 10), { type: 'destination', destination });
    const other = pageLink('b', rect(60, 10), { type: 'destination', destination: otherDestination });
    const external = pageLink('c', rect(110, 10), {
      type: 'action', action: { type: PdfActionType.URI, uri: 'https://example.invalid' },
    } as PdfLinkAnnoObject['target']);
    const missing = pageLink('d', rect(160, 10), undefined);

    expect(activate(own, () => [own, other, external, missing]).value.sourceRects).toEqual([rect(10, 10)]);
  });

  it('keeps its own rect when the page lookup omits it or throws', () => {
    const own = pageLink('a', rect(10, 10), { type: 'destination', destination });

    expect(activate(own, () => []).value.sourceRects).toEqual([rect(10, 10)]);
    expect(activate(own, () => { throw new Error('plugin unavailable'); }).value.sourceRects)
      .toEqual([rect(10, 10)]);
  });

  it('emits no source rects for an unclassifiable target even with same-page links', () => {
    const own = pageLink('a', rect(10, 10), undefined);
    const sibling = pageLink('b', rect(60, 10), undefined);
    const event = activate(own, () => [own, sibling]);

    expect(event).toEqual({
      type: 'pdf-link-unavailable',
      value: { sourceScope: 'main', sourcePageIndex: 0 },
    });
  });
});
