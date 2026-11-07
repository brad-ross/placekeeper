import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Size } from '@embedpdf/models';

import type { PdfDestinationDescription } from '../pdf/destination-description.js';
import {
  createDestinationSnippetSession,
  destinationSnippetOverlay,
  type DestinationSnippetImageState,
  type DestinationSnippetRenderer,
} from '../pdf/destination-snippet.js';
import { DESTINATION_BAND_TOKEN } from '../pdf/ReferencePdfViewport.js';

const KEYBOARD_PAN_STEP = 40;
const PAGE_GAP = 12; // PDF points, scaled with the pages.

function layoutPreviewPages(pageSizes: readonly Size[]) {
  let top = 0;
  let width = 0;
  const pages = pageSizes.map((size, index) => {
    const page = { index, top, size };
    width = Math.max(width, size.width);
    top += size.height + PAGE_GAP;
    return page;
  });
  return { pages, width, height: top - PAGE_GAP };
}

function pageAtOffset(pages: ReturnType<typeof layoutPreviewPages>['pages'], top: number): number {
  let first = 0;
  let last = pages.length - 1;
  while (first < last) {
    const middle = Math.ceil((first + last) / 2);
    if (pages[middle]!.top <= top) first = middle;
    else last = middle - 1;
  }
  return first;
}

function PreviewPageImage({ image }: { readonly image: DestinationSnippetImageState }) {
  return image.status === 'ready'
    ? <img className="destination-snippet__image" src={image.url} alt="" draggable={false} />
    : null;
}

function NeighborPageImage({ description, render, pageIndex }: {
  readonly description: PdfDestinationDescription | null;
  readonly render: DestinationSnippetRenderer | undefined;
  readonly pageIndex: number;
}) {
  const image = useDestinationSnippetImage(description, render, pageIndex);
  return <PreviewPageImage image={image} />;
}

export interface DestinationSnippetFrameProps {
  readonly image: DestinationSnippetImageState;
  readonly description: PdfDestinationDescription | null;
  /** The destination description is still resolving. */
  readonly resolving: boolean;
  readonly render?: DestinationSnippetRenderer | undefined;
  readonly onReturnChange?: (action: (() => void) | null) => void;
}

/**
 * Fixed-height preview of the destination.
 * The extent highlight is a DOM overlay in the Destination Band tokens, never
 * burned into the bitmap. The frame's size never depends on the image.
 */
export function DestinationSnippetFrame({
  image,
  description,
  resolving,
  render,
  onReturnChange,
}: DestinationSnippetFrameProps) {
  const status = image.status === 'ready'
    ? 'ready'
    : resolving || image.status === 'loading' ? 'loading' : 'unavailable';
  const ready = image.status === 'ready' ? image : null;
  const overlay = ready === null || description === null
    ? []
    : destinationSnippetOverlay(description, ready.region);
  const layout = useMemo(() => ready && layoutPreviewPages(ready.pageSizes), [ready]);
  const target = layout?.pages[description?.pageIndex ?? -1];
  const [range, setRange] = useState({ first: 0, last: -1 });
  const viewportRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !ready || !layout || !target) return;
    const { origin, size } = ready.initialRegion;
    const originOffset = () => {
      const scale = viewport.clientWidth / size.width;
      return {
        left: Math.min(origin.x * scale, viewport.scrollWidth - viewport.clientWidth),
        top: Math.min((target.top + origin.y) * scale, viewport.scrollHeight - viewport.clientHeight),
      };
    };
    let away = false;
    const update = () => {
      const scale = viewport.clientWidth / size.width;
      if (scale <= 0) return;
      // Keep one viewport of pages ready in either direction.
      const first = pageAtOffset(layout.pages, (viewport.scrollTop - viewport.clientHeight) / scale);
      const last = pageAtOffset(layout.pages, (viewport.scrollTop + 2 * viewport.clientHeight) / scale);
      setRange((current) => current.first === first && current.last === last ? current : { first, last });
      const { left, top } = originOffset();
      // Browsers can round a fractional scroll offset to a CSS pixel.
      const displaced = Math.abs(viewport.scrollLeft - left) > 1 || Math.abs(viewport.scrollTop - top) > 1;
      if (displaced === away) return;
      away = displaced;
      onReturnChange?.(displaced ? snapBack : null);
    };
    const snapBack = () => {
      viewport.scrollTo({ ...originOffset(), behavior: 'instant' });
      update();
    };
    snapBack();
    viewport.addEventListener('scroll', update);
    const observer = new ResizeObserver(() => {
      if (away) update();
      else snapBack();
    });
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', update);
      if (away) onReturnChange?.(null);
    };
  }, [layout, onReturnChange, ready, target]);
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  return (
    <div
      ref={viewportRef}
      className="destination-snippet"
      data-destination-snippet=""
      data-snippet-status={status}
      {...(status === 'ready' ? { tabIndex: 0, role: 'region', 'aria-label': 'Reference preview' } : { 'aria-hidden': true })}
      onPointerDown={(event) => {
        if (status !== 'ready' || event.pointerType !== 'mouse' || event.button !== 0) return;
        event.preventDefault();
        const viewport = event.currentTarget;
        viewport.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: viewport.scrollLeft,
          top: viewport.scrollTop,
        };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start?.pointerId !== event.pointerId) return;
        event.currentTarget.scrollTo({
          left: start.left + start.x - event.clientX,
          top: start.top + start.y - event.clientY,
          behavior: 'instant',
        });
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const viewport = event.currentTarget;
        const offsets: Partial<Record<string, ScrollToOptions>> = {
          ArrowLeft: { left: -KEYBOARD_PAN_STEP },
          ArrowRight: { left: KEYBOARD_PAN_STEP },
          ArrowUp: { top: -KEYBOARD_PAN_STEP },
          ArrowDown: { top: KEYBOARD_PAN_STEP },
          PageUp: { top: -viewport.clientHeight },
          PageDown: { top: viewport.clientHeight },
          Home: { top: -viewport.scrollHeight },
          End: { top: viewport.scrollHeight },
          ' ': { top: event.shiftKey ? -viewport.clientHeight : viewport.clientHeight },
        };
        const offset = offsets[event.key];
        if (offset === undefined) return;
        // Native smooth keyboard scrolling can keep moving after a snap-back.
        event.preventDefault();
        viewport.scrollBy({ ...offset, behavior: 'instant' });
      }}
    >
      {ready && layout && target ? (
        <div
          className="destination-snippet__stack"
          style={{
            aspectRatio: `${layout.width} / ${layout.height}`,
            width: `${100 * layout.width / ready.initialRegion.size.width}%`,
          }}
        >
          {[target, ...layout.pages.slice(range.first, range.last + 1).filter((page) => page !== target)].map((page) => (
            <div
              key={page.index}
              className="destination-snippet__canvas"
              data-snippet-page-index={page.index}
              style={{
                top: `${100 * page.top / layout.height}%`,
                width: `${100 * page.size.width / layout.width}%`,
                aspectRatio: `${page.size.width} / ${page.size.height}`,
              }}
            >
              {page !== target ? <NeighborPageImage description={description} render={render} pageIndex={page.index} /> : (
                <>
                  <PreviewPageImage image={ready} />
                  {overlay.map((box, index) => (
                    <span
                      key={index}
                      className="destination-snippet__extent"
                      data-destination-snippet-extent=""
                      style={{
                        left: `${box.left}%`,
                        top: `${box.top}%`,
                        width: `${box.width}%`,
                        height: `${box.height}%`,
                        background: `var(${DESTINATION_BAND_TOKEN})`,
                      } satisfies CSSProperties}
                    />
                  ))}
                </>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function useDestinationSnippetImage(
  description: PdfDestinationDescription | null,
  render: DestinationSnippetRenderer | undefined,
  pageIndex?: number,
): DestinationSnippetImageState {
  const [image, setImage] = useState<DestinationSnippetImageState>({ status: 'idle' });
  useEffect(() => {
    if (description === null || render === undefined) {
      setImage({ status: 'idle' });
      return undefined;
    }
    const session = createDestinationSnippetSession({ render, onChange: setImage });
    session.load(description, pageIndex);
    // Dismissal, a new request, or a new description aborts the render and
    // revokes the object URL (KTD3).
    return () => session.dispose();
  }, [description, pageIndex, render]);
  return image;
}

export function useDestinationSnippet({ description, resolving, render }: {
  readonly description: PdfDestinationDescription | null;
  readonly resolving: boolean;
  readonly render?: DestinationSnippetRenderer;
}) {
  const image = useDestinationSnippetImage(description, render);
  const [returnToReference, setReturnToReference] = useState<(() => void) | null>(null);
  const onReturnChange = useCallback((action: (() => void) | null) => {
    setReturnToReference(() => action);
  }, []);

  return {
    frameProps: {
      image,
      description,
      render,
      onReturnChange,
      // The render starts in an effect; treat the first paint as loading.
      resolving: resolving || (image.status === 'idle' && description !== null && render !== undefined),
    },
    returnToReference,
  };
}
