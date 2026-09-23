import {
  PdfErrorCode,
  type PdfDocumentObject,
  type PdfEngine,
  type Rect,
  type Size,
} from '@embedpdf/models';

import type { PdfDestinationDescription } from './destination-description.js';

/*
 * Link-menu destination snippet (R3, R6; KTD3, KTD11).
 *
 * The snippet is a region render of the destination page, not a second viewer.
 * Regions and extents are in page device space (top-left origin, crop-relative
 * PDF points), the same space as the destination description.
 */

/** Height / width of the rendered strip; the menu frame reserves this shape. */
export const DESTINATION_SNIPPET_ASPECT = 0.4;
/** CSS width the strip is rendered for; matches the menu's snippet frame. */
export const DESTINATION_SNIPPET_CSS_WIDTH = 280;
/** Share of the strip kept above the extent as leading context. */
const LEADING_CONTEXT = 0.3;
const MAX_DEVICE_PIXEL_RATIO = 2;

export interface DestinationSnippetImage {
  readonly blob: Blob;
  /** The page region the image shows. */
  readonly region: Rect;
}

export type DestinationSnippetRenderer = (
  description: PdfDestinationDescription,
  signal: AbortSignal,
) => Promise<DestinationSnippetImage | null>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

/** A page-width strip around the extent, or the top of the page without a spot. */
export function destinationSnippetRegion(
  description: Pick<PdfDestinationDescription, 'spot' | 'extent'>,
  page: Size,
  aspect: number = DESTINATION_SNIPPET_ASPECT,
): Rect {
  const width = page.width;
  const height = Math.min(page.height, width * aspect);
  const { spot, extent } = description;
  let top = 0;
  if (spot !== null) {
    const lines = extent ?? [];
    const extentTop = lines.length > 0
      ? Math.min(...lines.map(({ origin }) => origin.y))
      : spot.y;
    const extentBottom = lines.length > 0
      ? Math.max(...lines.map(({ origin, size }) => origin.y + size.height))
      : spot.y;
    top = extentTop - height * LEADING_CONTEXT;
    if (extentBottom > top + height) top = extentBottom - height;
    top = clamp(top, 0, page.height - height);
  }
  return { origin: { x: 0, y: top }, size: { width, height } };
}

/** Percent-of-region box for one extent line in the snippet overlay. */
export interface DestinationSnippetOverlayBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Projects the extent into the rendered region; whole-page destinations draw nothing. */
export function destinationSnippetOverlay(
  description: Pick<PdfDestinationDescription, 'spot' | 'extent'>,
  region: Rect,
): readonly DestinationSnippetOverlayBox[] {
  if (description.spot === null || description.extent === null) return [];
  const { origin: r, size: rs } = region;
  if (rs.width <= 0 || rs.height <= 0) return [];
  const boxes: DestinationSnippetOverlayBox[] = [];
  for (const { origin, size } of description.extent) {
    const left = Math.max(origin.x, r.x);
    const top = Math.max(origin.y, r.y);
    const right = Math.min(origin.x + size.width, r.x + rs.width);
    const bottom = Math.min(origin.y + size.height, r.y + rs.height);
    if (right <= left || bottom <= top) continue;
    boxes.push({
      left: ((left - r.x) / rs.width) * 100,
      top: ((top - r.y) / rs.height) * 100,
      width: ((right - left) / rs.width) * 100,
      height: ((bottom - top) / rs.height) * 100,
    });
  }
  return boxes;
}

/** Region-renders destination strips from the main document's engine. */
export function createEngineDestinationSnippetRenderer(options: {
  readonly engine: PdfEngine;
  readonly document: PdfDocumentObject;
  readonly documentGeneration: number;
  readonly cssWidth?: number;
  readonly devicePixelRatio?: number;
}): DestinationSnippetRenderer {
  const cssWidth = options.cssWidth ?? DESTINATION_SNIPPET_CSS_WIDTH;
  return async (description, signal) => {
    if (signal.aborted || description.documentGeneration !== options.documentGeneration) return null;
    const page = options.document.pages[description.pageIndex];
    if (page === undefined || page.size.width <= 0 || page.size.height <= 0) return null;
    const region = destinationSnippetRegion(description, page.size);
    const dpr = clamp(
      options.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1,
      1,
      MAX_DEVICE_PIXEL_RATIO,
    );
    const task = options.engine.renderPageRect(options.document, page, region, {
      scaleFactor: cssWidth / page.size.width,
      dpr,
    });
    const abort = () => task.abort({ code: PdfErrorCode.Cancelled, message: 'Destination snippet cancelled' });
    signal.addEventListener('abort', abort, { once: true });
    try {
      const blob = await task.toPromise();
      return signal.aborted ? null : { blob, region };
    } catch {
      return null;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  };
}

export type DestinationSnippetImageState =
  | { readonly status: 'idle' | 'loading' | 'failed' }
  | { readonly status: 'ready'; readonly url: string; readonly region: Rect };

export interface DestinationSnippetSession {
  /** Starts rendering a description, cancelling and revoking any previous one. */
  load(description: PdfDestinationDescription | null): void;
  /** Cancels any render and revokes the current object URL. */
  dispose(): void;
}

/** Owns one menu's snippet render and object URL lifetime. */
export function createDestinationSnippetSession(options: {
  readonly render: DestinationSnippetRenderer;
  readonly onChange: (state: DestinationSnippetImageState) => void;
  readonly createObjectURL?: (blob: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
}): DestinationSnippetSession {
  const createObjectURL = options.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectURL = options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  let controller: AbortController | null = null;
  let url: string | null = null;
  const release = () => {
    controller?.abort();
    controller = null;
    if (url !== null) revokeObjectURL(url);
    url = null;
  };
  return {
    load(description) {
      release();
      if (description === null) {
        options.onChange({ status: 'idle' });
        return;
      }
      const current = new AbortController();
      controller = current;
      options.onChange({ status: 'loading' });
      let rendered: Promise<DestinationSnippetImage | null>;
      try {
        rendered = options.render(description, current.signal);
      } catch {
        rendered = Promise.resolve(null);
      }
      void rendered.then((image) => image, () => null).then((image) => {
        if (current.signal.aborted || controller !== current) return;
        if (image === null) {
          options.onChange({ status: 'failed' });
          return;
        }
        url = createObjectURL(image.blob);
        options.onChange({ status: 'ready', url, region: image.region });
      });
    },
    dispose: release,
  };
}
