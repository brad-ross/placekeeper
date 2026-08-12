import type { KeyboardEvent } from 'react';

const DIALOG_FOCUSABLE = [
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Keep keyboard focus inside a custom modal surface. */
export function trapDialogFocus(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Tab') return;

  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)]
    .filter((element) => element.getAttribute('aria-hidden') !== 'true');
  const first = focusable.at(0);
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }

  const active = event.currentTarget.ownerDocument.activeElement;
  if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}
