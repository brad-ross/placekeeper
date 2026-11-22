export function isVisibleFocusTarget(element: HTMLElement | null | undefined): element is HTMLElement {
  if (
    element === null
    || element === undefined
    || !element.isConnected
    || element.hidden
    || element.closest('[hidden], [inert], [aria-hidden="true"]') !== null
  ) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.visibility !== 'collapse';
}

