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

export function enabledMenuItems(surface: HTMLElement): readonly HTMLElement[] {
  const candidates = surface.querySelectorAll<HTMLElement>([
    '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
    '[role="menuitemcheckbox"]:not(:disabled):not([aria-disabled="true"])',
    'input:not(:disabled):not([aria-disabled="true"])',
    'select:not(:disabled):not([aria-disabled="true"])',
    'textarea:not(:disabled):not([aria-disabled="true"])',
    '[contenteditable="true"]:not([aria-disabled="true"])',
  ].join(','));
  return [...candidates];
}

function isEditableMenuTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  const element = target as HTMLElement;
  return element.tagName === 'INPUT'
    || element.tagName === 'TEXTAREA'
    || element.tagName === 'SELECT'
    || element.isContentEditable === true;
}

export function menuRovingFocusIndex(input: {
  readonly items: readonly HTMLElement[];
  readonly activeElement: Element | null;
  readonly eventTarget: EventTarget | null;
  readonly key: string;
}): number | null {
  if (isEditableMenuTarget(input.eventTarget)) return null;
  const currentIndex = input.items.indexOf(input.activeElement as HTMLElement);
  if (currentIndex < 0) return null;
  return compositeFocusIndex(currentIndex, input.items.length, input.key);
}
