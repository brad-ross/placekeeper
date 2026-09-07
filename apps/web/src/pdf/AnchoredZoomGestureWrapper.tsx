import { useLayoutEffect, useRef, type ComponentProps } from 'react';
import { useZoomCapability, ZoomGestureWrapper } from '@embedpdf/plugin-zoom/react';
import { anchoredZoom, cancelZoomAnimation, FINISH_ZOOM_GESTURE } from './anchored-zoom.js';

/** Preview gestures on the compositor; rebuild PDF layout only when they settle. */
export function AnchoredZoomGestureWrapper(props: ComponentProps<typeof ZoomGestureWrapper>) {
  const marker = useRef<HTMLSpanElement>(null);
  const { provides: zoomCapability } = useZoomCapability();
  useLayoutEffect(() => {
    const content = marker.current?.parentElement;
    const viewport = content?.closest<HTMLElement>('[data-viewer-framing-viewport]');
    if (!content || !viewport || !zoomCapability) return;
    const zoom = zoomCapability.forDocument(props.documentId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gesture: {
      initialZoom: number; scale: number; left: number; top: number;
      x: number; y: number; point: { x: number; y: number };
    } | null = null;
    const clearPreview = () => {
      content.style.transform = '';
      content.style.transformOrigin = '';
      content.style.willChange = '';
    };
    const commit = () => {
      clearTimeout(timer);
      timer = undefined;
      const current = gesture;
      if (!current) return;
      gesture = null;
      // Capture the page point from the visible preview, then remove the
      // transform inside the same synchronous commit as the final PDF scale.
      anchoredZoom(viewport, () => {
        clearPreview();
        zoom.requestZoom(current.initialZoom * current.scale);
      }, current.point);
    };
    const preview = (factor: number, point: { x: number; y: number }) => {
      if (!gesture) {
        cancelZoomAnimation(viewport);
        const bounds = content.getBoundingClientRect();
        gesture = { initialZoom: zoom.getState().currentZoomLevel, scale: 1,
          left: bounds.left, top: bounds.top, x: 0, y: 0, point };
        content.style.transformOrigin = '0 0';
        content.style.willChange = 'transform';
      }
      const next = Math.max(0.2, Math.min(60, gesture.initialZoom * gesture.scale * factor)) / gesture.initialZoom;
      const ratio = next / gesture.scale;
      gesture.x = point.x - gesture.left - (point.x - gesture.left - gesture.x) * ratio;
      gesture.y = point.y - gesture.top - (point.y - gesture.top - gesture.y) * ratio;
      gesture.scale = next;
      gesture.point = point;
      content.style.transform = `matrix(${next}, 0, 0, ${next}, ${gesture.x}, ${gesture.y})`;
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) { commit(); return; }
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      preview(Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.005), { x: event.clientX, y: event.clientY });
      clearTimeout(timer);
      timer = setTimeout(commit, 120);
    };
    let distance: number | null = null;
    const touch = (event: TouchEvent) => {
      if (event.touches.length !== 2) { distance = null; commit(); return; }
      event.preventDefault();
      clearTimeout(timer);
      const a = event.touches[0]!;
      const b = event.touches[1]!;
      const nextDistance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (distance !== null && distance > 0 && nextDistance > 0) {
        preview(nextDistance / distance, { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
      }
      distance = nextDistance;
    };
    // Finish before a new interaction reads geometry or requests another zoom.
    const pointer = (event: PointerEvent) => { if (event.pointerType !== 'touch') commit(); };
    const key = (event: KeyboardEvent) => { if (event.key !== 'Control' && event.key !== 'Meta') commit(); };
    viewport.addEventListener('wheel', wheel, { passive: false });
    viewport.addEventListener('touchstart', touch, { passive: false });
    viewport.addEventListener('touchmove', touch, { passive: false });
    viewport.addEventListener('touchend', touch);
    viewport.addEventListener('touchcancel', touch);
    viewport.addEventListener(FINISH_ZOOM_GESTURE, commit);
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', commit);
    window.addEventListener('resize', commit);
    return () => {
      clearTimeout(timer);
      cancelZoomAnimation(viewport);
      clearPreview();
      viewport.removeEventListener('wheel', wheel);
      viewport.removeEventListener('touchstart', touch);
      viewport.removeEventListener('touchmove', touch);
      viewport.removeEventListener('touchend', touch);
      viewport.removeEventListener('touchcancel', touch);
      viewport.removeEventListener(FINISH_ZOOM_GESTURE, commit);
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', commit);
      window.removeEventListener('resize', commit);
    };
  }, [zoomCapability, props.documentId]);
  return <ZoomGestureWrapper {...props} data-viewer-zoom-content enableWheel={false} enablePinch={false}>
    <span ref={marker} hidden />
    {props.children}
  </ZoomGestureWrapper>;
}
