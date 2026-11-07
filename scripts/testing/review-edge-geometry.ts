/** Geometry of the compositor-owned edge paint inside the native scrollport. */
export function reviewEdgeGeometry(stage: Element) {
  const backing = stage.querySelector('.pdf-workspace__scrollbar-backing')!;
  const bounds = backing.getBoundingClientRect();
  const style = getComputedStyle(backing);
  const paint = getComputedStyle(backing, '::after');
  const number = (name: string, fallback: number) => Number.parseFloat(style.getPropertyValue(name)) || fallback;
  const fadeSize = number('--review-overlay-fade-size', 12);
  const rightStart = bounds.left + (stage.getAttribute('data-right-overlay') === 'true'
    ? number('--review-overlay-right-start', 0)
    : Number.parseFloat(paint.width) - number('--review-document-right-space', 40));
  const bottomEnd = bounds.top + Number.parseFloat(paint.height);
  const railHeight = Math.max(number('--review-collapsed-rail-size', 40),
    number('--review-overlay-inset', 12) + Math.max(32, number('--review-edge-rail-size', number('--review-control-default', 32))));
  const bottomStart = stage.getAttribute('data-bottom-overlay') === 'true'
    ? bounds.top + number('--review-overlay-bottom-start', 0)
    : bottomEnd - railHeight;
  const clearRight = stage.getAttribute('data-workspace-presentation') === 'right'
    ? rightStart - fadeSize : bounds.left + Number.parseFloat(paint.width);
  return { rightStart, bottomStart, bottomEnd, clearRight,
    fadeSize, display: paint.display, background: paint.backgroundImage };
}
