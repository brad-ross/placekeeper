import type { KeyboardEvent } from 'react';

const enabledButtonSelector = 'button:not(:disabled)';

export function focusDeliveryConfirmation(dialog: HTMLElement | null): void {
  if (!dialog) return;
  const firstControl = dialog.querySelector<HTMLButtonElement>(enabledButtonSelector);
  (firstControl ?? dialog).focus();
}

export function handleDeliveryConfirmationKey(
  event: KeyboardEvent<HTMLElement>,
  close: () => void,
  dismissible = true,
): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (dismissible) close();
    return;
  }
  if (event.key !== 'Tab') return;
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(enabledButtonSelector),
  );
  if (controls.length === 0) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
