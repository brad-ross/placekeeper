import { useEffect, type RefObject } from 'react';

const SCROLL_VIEWPORTS = [
  '.pdf-workspace__viewport',
  '.review-workspace__panel:not(.review-workspace__panel--search, .review-workspace__panel--references)',
  '[data-workspace-scroll-viewport]',
  '.full-annotation-reader__body',
].join(', ');

/** Hide only the thumb after scrolling settles; the gutter never changes size. */
export function useTransientScrollbars(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
    const reveal = (event: Event) => {
      const viewport = event.target;
      if (!(viewport instanceof HTMLElement) || !viewport.matches(SCROLL_VIEWPORTS)) return;
      const previous = timers.get(viewport);
      if (previous !== undefined) clearTimeout(previous);
      if (viewport.dataset.scrollbarActive !== 'true') viewport.dataset.scrollbarActive = 'true';
      timers.set(viewport, setTimeout(() => {
        timers.delete(viewport);
        delete viewport.dataset.scrollbarActive;
      }, 450));
    };
    // Capture also covers reference PDFs and search panels mounted after the shell.
    root.addEventListener('scroll', reveal, { capture: true, passive: true });
    return () => {
      root.removeEventListener('scroll', reveal, true);
      for (const [viewport, timer] of timers) {
        clearTimeout(timer);
        delete viewport.dataset.scrollbarActive;
      }
    };
  }, [rootRef]);
}
