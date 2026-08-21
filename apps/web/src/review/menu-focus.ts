export function compositeFocusIndex(
  currentIndex: number,
  itemCount: number,
  key: string,
): number | null {
  if (itemCount < 1) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return itemCount - 1;
  if (key === 'ArrowDown') return (currentIndex + 1) % itemCount;
  if (key === 'ArrowUp') return (currentIndex - 1 + itemCount) % itemCount;
  return null;
}

export function horizontalTabFocusIndex(
  currentIndex: number,
  itemCount: number,
  key: string,
): number | null {
  if (itemCount < 1) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return itemCount - 1;
  if (key === 'ArrowRight') return (currentIndex + 1) % itemCount;
  if (key === 'ArrowLeft') return (currentIndex - 1 + itemCount) % itemCount;
  return null;
}

export function enabledMenuItems(surface: HTMLElement): readonly HTMLButtonElement[] {
  return [...surface.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
}
