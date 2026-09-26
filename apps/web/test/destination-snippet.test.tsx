import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  PdfAnnotationSubtype,
  PdfZoomMode,
  type PdfDocumentObject,
  type PdfEngine,
  type PdfLinkAnnoObject,
  type Rect,
} from '@embedpdf/models';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { PdfDestinationDescription } from '../src/pdf/destination-description.js';
import {
  DESTINATION_SNIPPET_ASPECT,
  DESTINATION_SNIPPET_CSS_WIDTH,
  createDestinationSnippetSession,
  createEngineDestinationSnippetRenderer,
  destinationSnippetOverlay,
  destinationSnippetRegion,
  type DestinationSnippetImageState,
} from '../src/pdf/destination-snippet.js';
import { PdfLinkControl } from '../src/pdf/PdfLinkControl.js';
import { DESTINATION_BAND_TOKEN } from '../src/pdf/ReferencePdfViewport.js';
import { DestinationSnippetFrame } from '../src/review/DestinationSnippet.js';

const PAGE = { width: 600, height: 800 };

function rect(x: number, y: number, width: number, height: number): Rect {
  return { origin: { x, y }, size: { width, height } };
}

function description(
  overrides: Partial<PdfDestinationDescription> = {},
): PdfDestinationDescription {
  return {
    documentGeneration: 3,
    targetIdentity: 'target-14',
    pageIndex: 13,
    pageNumeral: '14',
    spot: { x: 72, y: 400 },
    extent: [rect(72, 400, 400, 12), rect(72, 414, 380, 12)],
    clickedText: 'Agarwal, Dahleh, et al. (2023)',
    heading: 'References',
    kindLabel: null,
    name: 'Agarwal, Dahleh, et al. (2023)',
    nameSource: 'clicked-text',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('destination snippet region (KTD3)', () => {
  it('renders an actual-size strip starting at the passage with context above it', () => {
    const region = destinationSnippetRegion(description(), PAGE);
    // Readable text: one CSS pixel per point, so the strip is the frame width
    // in points and begins just left of the extent rather than at the page edge.
    expect(region.size.width).toBe(DESTINATION_SNIPPET_CSS_WIDTH);
    expect(region.origin.x).toBe(64);
    expect(region.size.height).toBeCloseTo(DESTINATION_SNIPPET_CSS_WIDTH * DESTINATION_SNIPPET_ASPECT);
    expect(region.origin.y).toBeLessThan(400);
    expect(region.origin.y + region.size.height).toBeGreaterThanOrEqual(426);
  });

  it('keeps the actual-size strip inside the page when the passage sits near the right edge', () => {
    const region = destinationSnippetRegion(description({
      spot: { x: 500, y: 400 },
      extent: [rect(500, 400, 90, 12)],
    }), PAGE);
    expect(region.origin.x + region.size.width).toBe(PAGE.width);
  });

  it('clamps the strip inside the page near the bottom edge', () => {
    const region = destinationSnippetRegion(description({
      spot: { x: 72, y: 780 },
      extent: [rect(72, 780, 400, 12)],
    }), PAGE);
    expect(region.origin.y + region.size.height).toBeCloseTo(PAGE.height);
  });

  // Covers AE5 (R6): a whole-page destination shows the top of the page.
  it('uses the top of the page for a whole-page destination', () => {
    const region = destinationSnippetRegion(description({ spot: null, extent: null }), PAGE);
    expect(region.origin).toEqual({ x: 0, y: 0 });
    expect(region.size.width).toBe(PAGE.width);
  });

  it('keeps short landscape whole-page destinations whole', () => {
    const region = destinationSnippetRegion(description({ spot: null, extent: null }), { width: 800, height: 200 });
    expect(region).toEqual(rect(0, 0, 800, 200));
  });

  it('projects the extent into percentages of the rendered strip', () => {
    const region = rect(0, 300, 600, 240);
    expect(destinationSnippetOverlay(description(), region)).toEqual([
      { left: 12, top: (100 / 240) * 100, width: (400 / 600) * 100, height: 5 },
      { left: 12, top: (114 / 240) * 100, width: (380 / 600) * 100, height: 5 },
    ]);
  });

  it('draws no overlay without a spot, and clips rects outside the strip', () => {
    expect(destinationSnippetOverlay(description({ spot: null, extent: null }), rect(0, 0, 600, 240))).toEqual([]);
    expect(destinationSnippetOverlay(description({ extent: null }), rect(0, 300, 600, 240))).toEqual([]);
    expect(destinationSnippetOverlay(description({
      extent: [rect(72, 100, 400, 12), rect(72, 530, 400, 20)],
    }), rect(0, 300, 600, 240))).toEqual([
      { left: 12, top: (230 / 240) * 100, width: (400 / 600) * 100, height: (10 / 240) * 100 },
    ]);
  });
});

describe('engine destination snippet renderer', () => {
  function fakeEngine() {
    const blob = new Blob(['png'], { type: 'image/png' });
    const pending = deferred<Blob>();
    const abort = vi.fn();
    const renderPageRect = vi.fn(() => ({ toPromise: () => pending.promise, abort }));
    const engine = { renderPageRect } as unknown as PdfEngine;
    const page = { index: 13, size: PAGE, rotation: 0 };
    const document = { id: 'doc', pageCount: 20, pages: Object.assign([], { 13: page }) } as unknown as PdfDocumentObject;
    return { blob, pending, abort, renderPageRect, engine, document, page };
  }

  it('renders the destination strip at the snippet width through the engine region render', async () => {
    const fake = fakeEngine();
    const render = createEngineDestinationSnippetRenderer({
      engine: fake.engine,
      document: fake.document,
      documentGeneration: 3,
      cssWidth: 300,
      devicePixelRatio: 2,
    });
    const result = render(description(), new AbortController().signal);
    fake.pending.resolve(fake.blob);
    const image = await result;
    const expectedRegion = destinationSnippetRegion(description(), PAGE, DESTINATION_SNIPPET_ASPECT, 300);
    expect(fake.renderPageRect).toHaveBeenCalledWith(
      fake.document,
      fake.page,
      expectedRegion,
      expect.objectContaining({ scaleFactor: 1, dpr: 2 }),
    );
    expect(image).toEqual({ blob: fake.blob, region: expectedRegion });
  });

  it('aborts the engine task when the menu goes away', async () => {
    const fake = fakeEngine();
    const render = createEngineDestinationSnippetRenderer({
      engine: fake.engine, document: fake.document, documentGeneration: 3,
    });
    const controller = new AbortController();
    const result = render(description(), controller.signal);
    controller.abort();
    fake.pending.reject(new Error('cancelled'));
    await expect(result).resolves.toBeNull();
    expect(fake.abort).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for another document generation or a missing page', async () => {
    const fake = fakeEngine();
    const render = createEngineDestinationSnippetRenderer({
      engine: fake.engine, document: fake.document, documentGeneration: 4,
    });
    await expect(render(description(), new AbortController().signal)).resolves.toBeNull();
    const current = createEngineDestinationSnippetRenderer({
      engine: fake.engine, document: fake.document, documentGeneration: 3,
    });
    await expect(current(description({ pageIndex: 19 }), new AbortController().signal)).resolves.toBeNull();
    expect(fake.renderPageRect).not.toHaveBeenCalled();
  });
});

describe('destination snippet image session', () => {
  function session(render: Parameters<typeof createDestinationSnippetSession>[0]['render']) {
    const states: DestinationSnippetImageState[] = [];
    let next = 0;
    const createObjectURL = vi.fn(() => `blob:snippet-${++next}`);
    const revokeObjectURL = vi.fn();
    const controller = createDestinationSnippetSession({
      render,
      createObjectURL,
      revokeObjectURL,
      onChange: (state) => states.push(state),
    });
    return { controller, states, createObjectURL, revokeObjectURL };
  }

  it('shows loading, then the image, and revokes the object URL when the menu closes', async () => {
    const region = rect(0, 300, 600, 240);
    const blob = new Blob(['png']);
    const run = session(async () => ({ blob, region }));
    run.controller.load(description());
    expect(run.states.at(-1)).toEqual({ status: 'loading' });
    await vi.waitFor(() => expect(run.states.at(-1)).toEqual({ status: 'ready', url: 'blob:snippet-1', region }));
    expect(run.createObjectURL).toHaveBeenCalledWith(blob);
    run.controller.dispose();
    expect(run.revokeObjectURL).toHaveBeenCalledWith('blob:snippet-1');
  });

  it('aborts and ignores a render that settles after dismissal', async () => {
    const pending = deferred<{ blob: Blob; region: Rect } | null>();
    let signal: AbortSignal | undefined;
    const run = session((_description, abortSignal) => {
      signal = abortSignal;
      return pending.promise;
    });
    run.controller.load(description());
    run.controller.dispose();
    expect(signal?.aborted).toBe(true);
    pending.resolve({ blob: new Blob(['late']), region: rect(0, 0, 600, 240) });
    await pending.promise;
    await Promise.resolve();
    expect(run.createObjectURL).not.toHaveBeenCalled();
    expect(run.states.map(({ status }) => status)).toEqual(['loading']);
  });

  it('revokes the previous image when the request changes', async () => {
    const region = rect(0, 0, 600, 240);
    const run = session(async () => ({ blob: new Blob(['png']), region }));
    run.controller.load(description());
    await vi.waitFor(() => expect(run.states.at(-1)?.status).toBe('ready'));
    run.controller.load(description({ targetIdentity: 'other' }));
    expect(run.revokeObjectURL).toHaveBeenCalledWith('blob:snippet-1');
    await vi.waitFor(() => expect(run.states.at(-1)).toEqual({ status: 'ready', url: 'blob:snippet-2', region }));
  });

  it('reports a failed render without creating an object URL', async () => {
    const failing = session(async () => { throw new Error('render failed'); });
    failing.controller.load(description());
    await vi.waitFor(() => expect(failing.states.at(-1)).toEqual({ status: 'failed' }));
    const empty = session(async () => null);
    empty.controller.load(description());
    await vi.waitFor(() => expect(empty.states.at(-1)).toEqual({ status: 'failed' }));
    expect(failing.createObjectURL).not.toHaveBeenCalled();
    expect(empty.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('destination snippet frame (R3, R6; KTD11)', () => {
  const region = rect(0, 300, 600, 240);

  // Covers AE1.
  it('shows the rendered snippet with the extent overlay in the band token and the bare page numeral', () => {
    const html = renderToStaticMarkup(
      <DestinationSnippetFrame
        image={{ status: 'ready', url: 'blob:snippet-1', region }}
        description={description()}
        resolving={false}
      />,
    );
    expect(html).toContain('data-destination-snippet=""');
    expect(html).toContain('data-snippet-status="ready"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/<img[^>]*src="blob:snippet-1"/u);
    expect(html.match(/data-destination-snippet-extent=""/g)).toHaveLength(2);
    expect(html).toContain(`var(${DESTINATION_BAND_TOKEN})`);
    // The page numeral lives in the menu's action row, not on the preview.
    expect(html).not.toContain('destination-snippet__page');
    expect(html).not.toMatch(/tabindex|<button|<input/u);
  });

  // Covers AE5.
  it('shows the top of a whole-page destination with nothing highlighted', () => {
    const html = renderToStaticMarkup(
      <DestinationSnippetFrame
        image={{ status: 'ready', url: 'blob:snippet-1', region: rect(0, 0, 600, 240) }}
        description={description({ spot: null, extent: null })}
        resolving={false}
      />,
    );
    expect(html).toMatch(/<img[^>]*src="blob:snippet-1"/u);
    expect(html).not.toContain('data-destination-snippet-extent');
  });

  it('keeps the same fixed frame while pending and after the image arrives', () => {
    const frame = (markup: string) => markup.match(/<div[^>]*data-destination-snippet=""[^>]*>/u)?.[0]
      .replace(/data-snippet-status="\w+"/u, '');
    const pending = renderToStaticMarkup(
      <DestinationSnippetFrame image={{ status: 'idle' }} description={null} resolving />,
    );
    const ready = renderToStaticMarkup(
      <DestinationSnippetFrame
        image={{ status: 'ready', url: 'blob:snippet-1', region }}
        description={description()}
        resolving={false}
      />,
    );
    expect(pending).toContain('data-snippet-status="loading"');
    expect(pending).not.toContain('<img');
    expect(frame(pending)).toBe(frame(ready));

    const css = readFileSync(
      fileURLToPath(new URL('../src/app/neutral-context-status.css', import.meta.url)),
      'utf8',
    );
    const rule = css.match(/\.destination-snippet\s*\{[^}]*\}/u)?.[0] ?? '';
    expect(rule).toMatch(/\bheight:\s*var\(--destination-snippet-height/u);
    expect(rule).toMatch(/overflow:\s*hidden/u);
  });

  it('shows an empty frame when the render fails; the action row still shows the page', () => {
    const html = renderToStaticMarkup(
      <DestinationSnippetFrame
        image={{ status: 'failed' }}
        description={description()}
        resolving={false}
      />,
    );
    expect(html).toContain('data-snippet-status="unavailable"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('data-destination-snippet-extent');
  });
});

describe('link preview trigger (R5)', () => {
  it('opens link actions only on activation, never on hover', () => {
    const annotation = {
      id: 'link-1',
      pageIndex: 0,
      type: PdfAnnotationSubtype.LINK,
      rect: rect(10, 10, 80, 20),
      target: {
        type: 'destination',
        destination: { pageIndex: 1, zoom: { mode: PdfZoomMode.FitPage }, view: [] },
      },
    } as unknown as PdfLinkAnnoObject;
    const button = PdfLinkControl({
      annotation,
      sourceScope: 'main',
      documentGeneration: 1,
      pageCount: 3,
      onInteraction: vi.fn(),
    });
    const props = button.props as Record<string, unknown>;
    for (const hover of ['onMouseEnter', 'onMouseOver', 'onMouseMove', 'onPointerEnter', 'onPointerOver', 'onPointerMove']) {
      expect(props[hover]).toBeUndefined();
    }
    expect(typeof props.onClick).toBe('function');
  });
});
