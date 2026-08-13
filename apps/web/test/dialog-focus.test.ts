import type { KeyboardEvent } from 'react';

import { describe, expect, it, vi } from 'vitest';

import { trapDialogFocus } from '../src/app/dialog-focus.js';

function focusEvent(activeIndex: number, shiftKey = false) {
  const elements = Array.from({ length: 3 }, () => ({
    focus: vi.fn(),
    getAttribute: vi.fn(() => null),
  }));
  const preventDefault = vi.fn();
  const currentTarget = {
    contains: (element: unknown) => elements.includes(element as (typeof elements)[number]),
    ownerDocument: { activeElement: elements[activeIndex] },
    querySelectorAll: () => elements,
  };
  const event = {
    currentTarget,
    key: 'Tab',
    preventDefault,
    shiftKey,
  } as unknown as KeyboardEvent<HTMLElement>;
  return { elements, event, preventDefault };
}

describe('trapDialogFocus', () => {
  it('wraps forward focus from the final control to the first', () => {
    const { elements, event, preventDefault } = focusEvent(2);

    trapDialogFocus(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(elements[0]?.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('wraps reverse focus from the first control to the last', () => {
    const { elements, event, preventDefault } = focusEvent(0, true);

    trapDialogFocus(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(elements[2]?.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('leaves native tab order alone between controls', () => {
    const { elements, event, preventDefault } = focusEvent(1);

    trapDialogFocus(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(elements.every(({ focus }) => focus.mock.calls.length === 0)).toBe(true);
  });
});
