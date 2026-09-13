import { createContext, useContext, useLayoutEffect, useState, useRef, type ReactNode } from 'react';
import { useScrollCapability, type LayoutChangePayload } from '@embedpdf/plugin-scroll/react';
import { useZoom } from '@embedpdf/plugin-zoom/react';
import { MAIN_PDF_DOCUMENT_ID } from './viewer-document-ids.js';

/** A host may bound the main preview without truncating PDF metadata or reference destinations. */
export const MainDocumentPreviewLimit = createContext<{ firstPage: number; lastPage: number } | null>(null);

export function MainDocumentPreviewBoundary({ children }: { children: ReactNode }) {
  const { state: zoom, provides: zoomControls } = useZoom(MAIN_PDF_DOCUMENT_ID);
  const limit = useContext(MainDocumentPreviewLimit);
  const { provides } = useScrollCapability();
  const boundary = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<LayoutChangePayload | null>(null);
  useLayoutEffect(() => {
    if (limit === null || !provides) return;
    const scope = provides.forDocument(MAIN_PDF_DOCUMENT_ID);
    setLayout(scope.getLayout());
    const offLayout = scope.onLayoutChange(setLayout);
    let active = true;
    const offPage = scope.onPageChange(({ pageNumber }) => {
      const change = scope.getPageChangeState();
      if (!change.isChanging || (change.targetPage >= limit.firstPage && change.targetPage <= limit.lastPage)) return;
      // Run after the original page-change subscribers so the corrected page wins.
      queueMicrotask(() => {
        if (active) scope.scrollToPage({
          pageNumber: Math.max(limit.firstPage, Math.min(limit.lastPage, pageNumber)),
          behavior: 'instant',
        });
      });
    });
    return () => { active = false; offLayout(); offPage(); };
  }, [limit, provides]);
  useLayoutEffect(() => {
    if (!limit || !layout) return;
    const viewport = boundary.current?.closest<HTMLElement>('[data-viewer-framing-viewport]');
    const first = layout.virtualItems.find((item) => item.pageNumbers.includes(limit.firstPage));
    if (!viewport || !first) return;
    const reader = viewport.closest<HTMLElement>('[data-initial-view-ready]');
    let initialFrame = 0;
    // The engine first restores page 1 before the host positions its excerpt.
    // Keep that hidden initialization in range, then permanently yield to the
    // normal navigation/zoom operations once the first fitted view is ready.
    const initialize = () => {
      if (reader?.dataset.initialViewReady === 'true') return;
      cancelAnimationFrame(initialFrame);
      initialFrame = requestAnimationFrame(() => {
        initialFrame = requestAnimationFrame(() => {
          if (reader?.dataset.initialViewReady === 'true') return;
          const start = first.y * (zoomControls?.getState().currentZoomLevel ?? 1) - viewport.clientHeight / 2;
          if (viewport.scrollTop < start) viewport.scrollTop = start;
        });
      });
    };
    initialize();
    viewport.addEventListener('scroll', initialize);
    // Bound user input before it moves the viewport. A scroll-event correction
    // also catches the programmatic anchor writes used by Fit Width and can
    // invalidate that operation, rolling its zoom back.
    const minimum = () => first.y * (zoomControls?.getState().currentZoomLevel ?? 1);
    const stopAtStart = (delta: number, event: Event) => {
      if (delta >= 0 || viewport.scrollTop + delta >= minimum()) return;
      event.preventDefault();
      viewport.scrollTop = Math.min(viewport.scrollTop, minimum());
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      stopAtStart(event.deltaY * unit, event);
    };
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"], button, [role="tab"]')) return;
      const delta = event.key === 'Home' ? -Infinity
        : event.key === 'PageUp' || (event.key === ' ' && event.shiftKey) ? -viewport.clientHeight
        : event.key === 'ArrowUp' ? -40 : 0;
      stopAtStart(delta, event);
    };
    let nativeInputZoom: number | null = null;
    const clearNativeInput = () => { nativeInputZoom = null; };
    const pointerdown = (event: PointerEvent) => {
      // A native scrollbar drag is the one input whose requested offset is
      // unavailable before scrolling. Clamp it synchronously, before paint.
      if (event.target === viewport) nativeInputZoom = zoomControls?.getState().currentZoomLevel ?? 1;
    };
    const boundNativeInput = () => {
      if (nativeInputZoom === null) return;
      if (nativeInputZoom !== (zoomControls?.getState().currentZoomLevel ?? 1)) { clearNativeInput(); return; }
      if (viewport.scrollTop < minimum()) viewport.scrollTop = minimum();
    };
    let touchY: number | null = null;
    const touchstart = (event: TouchEvent) => {
      touchY = event.touches.length === 1 ? event.touches.item(0)?.clientY ?? null : null;
      nativeInputZoom = touchY === null ? null : zoomControls?.getState().currentZoomLevel ?? 1;
    };
    const touchmove = (event: TouchEvent) => {
      if (touchY === null || event.touches.length !== 1) return;
      const nextY = event.touches.item(0)?.clientY;
      if (nextY === undefined) return;
      stopAtStart(touchY - nextY, event);
      touchY = nextY;
    };
    viewport.ownerDocument.addEventListener('pointerdown', clearNativeInput, true);
    viewport.ownerDocument.addEventListener('keydown', clearNativeInput, true);
    viewport.addEventListener('pointerdown', pointerdown);
    viewport.addEventListener('scroll', boundNativeInput);
    viewport.addEventListener('wheel', wheel, { passive: false });
    viewport.addEventListener('keydown', keydown);
    viewport.addEventListener('touchstart', touchstart, { passive: true });
    viewport.addEventListener('touchmove', touchmove, { passive: false });
    return () => {
      cancelAnimationFrame(initialFrame);
      viewport.removeEventListener('scroll', initialize);
      viewport.ownerDocument.removeEventListener('pointerdown', clearNativeInput, true);
      viewport.ownerDocument.removeEventListener('keydown', clearNativeInput, true);
      viewport.removeEventListener('pointerdown', pointerdown);
      viewport.removeEventListener('scroll', boundNativeInput);
      viewport.removeEventListener('wheel', wheel);
      viewport.removeEventListener('keydown', keydown);
      viewport.removeEventListener('touchstart', touchstart);
      viewport.removeEventListener('touchmove', touchmove);
    };
  }, [limit, layout, zoomControls, provides]);
  if (limit === null) return children;
  const last = layout?.virtualItems.find((item) => item.pageNumbers.includes(limit.lastPage));
  // Clipping the real scroller also bounds native/programmatic scrolling, while the
  // engine retains the complete outline, page count, and independently scrolled references.
  return <div ref={boundary} data-main-preview-limit={`${limit.firstPage}-${limit.lastPage}`} style={{
    height: last ? (last.y + last.height) * zoom.currentZoomLevel : 0,
    width: layout ? layout.totalContentSize.width * zoom.currentZoomLevel : '100%',
    overflow: 'hidden', margin: '0 auto',
  }}>{children}</div>;
}
