import { flushSync } from 'react-dom';

export const FINISH_ZOOM_GESTURE = 'placekeeper:finish-zoom-gesture';

const pendingFrames = new WeakMap<HTMLElement, number>();
const animations = new WeakMap<HTMLElement, Animation>();

export function cancelZoomAnimation(viewport: HTMLElement): void {
  animations.get(viewport)?.cancel();
  animations.delete(viewport);
  const content = viewport.querySelector<HTMLElement>('[data-viewer-zoom-content]');
  if (content) content.style.willChange = '';
}

/** Keep a measured page point fixed even when custom viewport padding changes. */
export function anchoredZoom(
  viewport: HTMLElement | null,
  request: () => void,
  point?: { x: number; y: number },
  animate = false,
): void {
  if (!viewport) { request(); return; }
  viewport.dispatchEvent(new Event(FINISH_ZOOM_GESTURE));
  const pending = pendingFrames.get(viewport);
  if (pending !== undefined) cancelAnimationFrame(pending);
  const bounds = viewport.getBoundingClientRect();
  const workspace = viewport.closest('.pdf-workspace')?.getBoundingClientRect() ?? bounds;
  let bottom = Math.min(bounds.top + viewport.clientHeight, workspace.bottom);
  const root = viewport.closest('[data-production-review]') ?? viewport.closest('.production-review');
  for (const tray of root?.querySelectorAll<HTMLElement>(
    '[data-workspace-presentation="bottom"][data-workspace-open="true"], [data-workspace-presentation="bottom"][data-tools-workspace-open="true"]',
  ) ?? []) bottom = Math.min(bottom, tray.getBoundingClientRect().top);
  const focus = point ?? {
    x: (Math.max(bounds.left, workspace.left) + Math.min(bounds.left + viewport.clientWidth, workspace.right)) / 2,
    y: (bounds.top + bottom) / 2,
  };
  const pages = [...viewport.querySelectorAll<HTMLElement>('[data-page-index]')];
  const page = pages.reduce<HTMLElement | null>((nearest, candidate) => {
    const distance = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return Math.hypot(Math.max(rect.left - focus.x, 0, focus.x - rect.right),
        Math.max(rect.top - focus.y, 0, focus.y - rect.bottom));
    };
    return !nearest || distance(candidate) < distance(nearest) ? candidate : nearest;
  }, null);
  if (!page) { request(); return; }
  const before = page.getBoundingClientRect();
  if (!before.width || !before.height) { request(); return; }
  const index = page.dataset.pageIndex;
  const x = (focus.x - before.left) / before.width;
  const y = (focus.y - before.top) / before.height;
  const restore = () => {
    const current = viewport.querySelector<HTMLElement>(`[data-page-index="${index}"]`);
    if (!current || !viewport.isConnected) return;
    const rect = current.getBoundingClientRect();
    viewport.scrollLeft = Math.round(viewport.scrollLeft + rect.left + x * rect.width - focus.x);
    viewport.scrollTop = Math.round(viewport.scrollTop + rect.top + y * rect.height - focus.y);
  };
  flushSync(() => {
    cancelZoomAnimation(viewport);
    request();
  });
  restore();
  pendingFrames.set(viewport, requestAnimationFrame(() => {
    pendingFrames.delete(viewport);
    restore();
  }));
  if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const content = viewport.querySelector<HTMLElement>('[data-viewer-zoom-content]');
    const current = viewport.querySelector<HTMLElement>(`[data-page-index="${index}"]`);
    if (!content || !current || typeof content.animate !== 'function') return;
    const ratio = before.width / current.getBoundingClientRect().width;
    if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 0.001) return;
    const bounds = content.getBoundingClientRect();
    const origin = `${focus.x - bounds.left}px ${focus.y - bounds.top}px`;
    content.style.willChange = 'transform';
    const animation = content.animate([
      { transform: `scale(${ratio})`, transformOrigin: origin },
      { transform: 'scale(1)', transformOrigin: origin },
    ], { duration: 140, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    animations.set(viewport, animation);
    animation.onfinish = () => {
      if (animations.get(viewport) === animation) {
        animations.delete(viewport);
        // Notify geometry observers once the animated overflow has settled.
        content.style.willChange = '';
      }
    };
  }
}
