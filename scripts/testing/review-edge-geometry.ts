/** Geometry of the compositor-owned edge paint inside the native scrollport. */
export function reviewEdgeGeometry(stage: Element) {
  const backing = stage.querySelector('.pdf-workspace__scrollbar-backing')!;
  const bounds = backing.getBoundingClientRect();
  const style = getComputedStyle(backing);
  const paint = getComputedStyle(backing, '::after');
  const number = (name: string, fallback: number) => Number.parseFloat(style.getPropertyValue(name)) || fallback;
  const fadeSize = number('--review-overlay-fade-size', 12);
  const rightEnd = bounds.left + number('--scrollbar-backing-width', 0);
  const rightOverlay = stage.getAttribute('data-right-overlay') === 'true';
  const rightStart = rightOverlay ? bounds.left + number('--review-overlay-right-start', 0) : rightEnd;
  const bottomEnd = bounds.top + number('--scrollbar-backing-height', 0);
  const bottomStart = stage.getAttribute('data-bottom-overlay') === 'true'
    ? bounds.top + number('--review-overlay-bottom-start', 0)
    : bottomEnd;
  const clearRight = rightOverlay ? rightStart - fadeSize : rightEnd;
  return { rightStart, bottomStart, bottomEnd, clearRight,
    fadeSize, display: paint.display, background: paint.backgroundImage };
}
