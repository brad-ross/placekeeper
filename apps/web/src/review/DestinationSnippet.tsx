import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
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
const MIN_PREVIEW_ZOOM = 0.25;
const MAX_PREVIEW_ZOOM = 4;
const ZOOM_STEP = 0.25;

interface PreviewView {
  readonly zoom: number;
  /** Scroll position to apply after changing zoom. Null restores the reference. */
  readonly position: { readonly left: number; readonly top: number } | null;
}

const INITIAL_VIEW: PreviewView = { zoom: 1, position: null };

function centeredInset(containerWidth: number, contentWidth: number): number {
  return Math.max(0, (containerWidth - contentWidth) / 2);
}

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

interface PreviewPageImageProps {
  readonly description: PdfDestinationDescription | null;
  readonly render: DestinationSnippetRenderer | undefined;
  readonly pageIndex: number;
  readonly zoomedIn: boolean;
}

function PreviewPageImage({ image, description, render, pageIndex, zoomedIn }: PreviewPageImageProps & {
  readonly image: DestinationSnippetImageState;
}) {
  // Keep the original raster visible while the sharper version loads. One
  // bounded raster serves all zoom levels above the opening scale.
  const sharper = useDestinationSnippetImage(zoomedIn ? description : null, render, pageIndex, MAX_PREVIEW_ZOOM);
  const visible = zoomedIn && sharper.status === 'ready' ? sharper : image;
  return visible.status === 'ready'
    ? <img className="destination-snippet__image" src={visible.url} alt="" draggable={false} />
    : null;
}

function NeighborPageImage(props: PreviewPageImageProps) {
  const image = useDestinationSnippetImage(props.description, props.render, props.pageIndex);
  return <PreviewPageImage {...props} image={image} />;
}

export interface DestinationSnippetFrameProps {
  readonly image: DestinationSnippetImageState;
  readonly description: PdfDestinationDescription | null;
  /** The destination description is still resolving. */
  readonly resolving: boolean;
  readonly render?: DestinationSnippetRenderer | undefined;
  readonly view?: PreviewView;
  readonly viewportRef?: RefObject<HTMLDivElement | null>;
  readonly onPanChange?: (away: boolean) => void;
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
  view = INITIAL_VIEW,
  viewportRef: suppliedViewportRef,
  onPanChange,
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
  const localViewportRef = useRef<HTMLDivElement>(null);
  const viewportRef = suppliedViewportRef ?? localViewportRef;
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !ready || !layout || !target) {
      onPanChange?.(false);
      return;
    }
    const { origin, size } = ready.initialRegion;
    const getScale = () => viewport.clientWidth * view.zoom / size.width;
    const originOffset = () => {
      const scale = getScale();
      return {
        left: Math.min(
          (centeredInset(layout.width, target.size.width) + origin.x) * scale,
          viewport.scrollWidth - viewport.clientWidth,
        ),
        top: Math.min((target.top + origin.y) * scale, viewport.scrollHeight - viewport.clientHeight),
      };
    };
    let away: boolean | undefined;
    const update = () => {
      const scale = getScale();
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
      onPanChange?.(displaced);
    };
    const snapBack = () => {
      viewport.scrollTo({ ...originOffset(), behavior: 'instant' });
      update();
    };
    viewport.scrollTo({ ...(view.position ?? originOffset()), behavior: 'instant' });
    update();
    viewport.addEventListener('scroll', update);
    const observer = new ResizeObserver(() => {
      if (away || view.zoom !== 1) update();
      else snapBack();
    });
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', update);
    };
  }, [layout, onPanChange, ready, target, view, viewportRef]);
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
          data-snippet-stack=""
          style={{
            aspectRatio: `${layout.width} / ${layout.height}`,
            width: `${100 * layout.width * view.zoom / ready.initialRegion.size.width}%`,
          }}
        >
          {[target, ...layout.pages.slice(range.first, range.last + 1).filter((page) => page !== target)].map((page) => (
            <div
              key={page.index}
              className="destination-snippet__canvas"
              data-snippet-page-index={page.index}
              style={{
                left: `${100 * centeredInset(layout.width, page.size.width) / layout.width}%`,
                top: `${100 * page.top / layout.height}%`,
                width: `${100 * page.size.width / layout.width}%`,
                aspectRatio: `${page.size.width} / ${page.size.height}`,
              }}
            >
              {page !== target ? (
                <NeighborPageImage description={description} render={render} pageIndex={page.index} zoomedIn={view.zoom > 1} />
              ) : (
                <>
                  <PreviewPageImage image={ready} description={description} render={render} pageIndex={page.index} zoomedIn={view.zoom > 1} />
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
  rasterZoom?: number,
): DestinationSnippetImageState {
  const [image, setImage] = useState<DestinationSnippetImageState>({ status: 'idle' });
  useEffect(() => {
    if (description === null || render === undefined) {
      setImage({ status: 'idle' });
      return undefined;
    }
    const session = createDestinationSnippetSession({ render, onChange: setImage });
    session.load(description, pageIndex, rasterZoom);
    // Dismissal, a new request, or a new description aborts the render and
    // revokes the object URL (KTD3).
    return () => session.dispose();
  }, [description, pageIndex, rasterZoom, render]);
  return image;
}

export function useDestinationSnippet({ description, resolving, render }: {
  readonly description: PdfDestinationDescription | null;
  readonly resolving: boolean;
  readonly render?: DestinationSnippetRenderer;
}) {
  const image = useDestinationSnippetImage(description, render);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewState, setViewState] = useState<{ image: DestinationSnippetImageState; view: PreviewView } | null>(null);
  const [away, setAway] = useState(false);
  useEffect(() => {
    setViewState(null);
    setAway(false);
  }, [description, render]);
  const view = viewState?.image === image ? viewState.view : INITIAL_VIEW;
  const changeZoom = (nextZoom: (zoom: number) => number, point?: { x: number; y: number }) => {
    const viewport = viewportRef.current;
    const stack = viewport?.querySelector('[data-snippet-stack]');
    if (!viewport || !stack) return;
    const viewportWidth = viewport.clientWidth;
    const unzoomedWidth = stack.getBoundingClientRect().width / view.zoom;
    const offset = { left: viewport.scrollLeft, top: viewport.scrollTop };
    const bounds = viewport.getBoundingClientRect();
    const x = point ? point.x - bounds.left - viewport.clientLeft : viewportWidth / 2;
    const y = point ? point.y - bounds.top - viewport.clientTop : viewport.clientHeight / 2;
    setViewState((current) => {
      const prior = current?.image === image ? current.view : INITIAL_VIEW;
      const zoom = Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, nextZoom(prior.zoom)));
      if (zoom === prior.zoom) return current;
      const ratio = zoom / prior.zoom;
      // A burst of gesture events can arrive before React commits the first
      // resize. Carry forward its pending scroll position in that case.
      const scroll = prior === view ? offset : prior.position ?? offset;
      const previousInset = centeredInset(viewportWidth, unzoomedWidth * prior.zoom);
      const nextInset = centeredInset(viewportWidth, unzoomedWidth * zoom);
      return {
        image,
        view: {
          zoom,
          position: {
            left: Math.max(0, (scroll.left + x - previousInset) * ratio + nextInset - x),
            top: Math.max(0, (scroll.top + y) * ratio - y),
          },
        },
      };
    });
  };
  const zoomAt = useEffectEvent((factor: number, point: { x: number; y: number }) => {
    changeZoom((zoom) => zoom * factor, point);
  });
  const ready = image.status === 'ready';
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !ready) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      zoomAt(Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.005), { x: event.clientX, y: event.clientY });
    };
    let distance = 0;
    const pinch = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        distance = 0;
        return;
      }
      event.preventDefault();
      const first = event.touches[0]!;
      const second = event.touches[1]!;
      const next = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
      if (distance > 0 && next > 0) {
        zoomAt(next / distance, { x: (first.clientX + second.clientX) / 2, y: (first.clientY + second.clientY) / 2 });
      }
      distance = next;
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    viewport.addEventListener('touchstart', pinch, { passive: false });
    viewport.addEventListener('touchmove', pinch, { passive: false });
    viewport.addEventListener('touchend', pinch);
    viewport.addEventListener('touchcancel', pinch);
    return () => {
      viewport.removeEventListener('wheel', wheel);
      viewport.removeEventListener('touchstart', pinch);
      viewport.removeEventListener('touchmove', pinch);
      viewport.removeEventListener('touchend', pinch);
      viewport.removeEventListener('touchcancel', pinch);
    };
  }, [ready]);
  const reset = () => setViewState({ image, view: { ...INITIAL_VIEW } });

  return {
    frameProps: {
      image,
      description,
      render,
      view,
      viewportRef,
      onPanChange: setAway,
      // The render starts in an effect; treat the first paint as loading.
      resolving: resolving || (image.status === 'idle' && description !== null && render !== undefined),
    },
    returnToReference: ready && (away || view.zoom !== 1) ? reset : null,
    zoomControls: ready ? {
      canZoomOut: view.zoom > MIN_PREVIEW_ZOOM,
      canZoomIn: view.zoom < MAX_PREVIEW_ZOOM,
      zoomOut: () => changeZoom((zoom) => zoom - ZOOM_STEP),
      zoomIn: () => changeZoom((zoom) => zoom + ZOOM_STEP),
    } : null,
  };
}
