import { describe, expect, it, vi } from 'vitest';

import { createProofreadInputController } from '../src/review/input-controller.js';

const selection = {
  pageIndex: 0,
  quote: 'clearly',
  prefix: 'is ',
  suffix: ' true',
  rect: { x: 10, y: 20, width: 40, height: 12 },
  segmentRects: [{ x: 10, y: 20, width: 40, height: 12 }],
  reliable: true as const,
};
const caret = {
  pageIndex: 0,
  position: { x: 50, y: 20, width: 2, height: 12 },
  leftContext: 'is clearly',
  rightContext: ' true',
  reliable: true as const,
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    inputType: 'insertText',
    data: 'replacement',
    isComposing: false,
    defaultPrevented: false,
    key: '',
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe('proofread input controller', () => {
  it('opens one frozen draft for typing and maps selected deletion directly to Delete', () => {
    const gestures: unknown[] = [];
    const controller = createProofreadInputController((gesture) => gestures.push(gesture));
    controller.setContext({ selection, caret: null });
    const replace = event();
    controller.beforeInput(replace);
    controller.beforeInput(event({ data: 'ignored duplicate event' }));
    controller.clearDraft();
    controller.setContext({ selection: null, caret });
    const insert = event({ data: 'perhaps ' });
    controller.beforeInput(insert);
    controller.setContext({ selection, caret: null });
    const backspace = event({ key: 'Backspace' });
    controller.keyDown(backspace);
    const remove = event({ key: 'Delete' });
    controller.keyDown(remove);

    expect(gestures).toEqual([
      { kind: 'replaceDraft', anchor: selection, initialText: 'replacement' },
      { kind: 'insertDraft', anchor: caret, initialText: 'perhaps ' },
      { kind: 'delete', anchor: selection },
      { kind: 'delete', anchor: selection },
    ]);
    expect(replace.preventDefault).toHaveBeenCalledOnce();
    expect(insert.preventDefault).toHaveBeenCalledOnce();
    expect(backspace.preventDefault).toHaveBeenCalledOnce();
    expect(remove.preventDefault).toHaveBeenCalledOnce();
  });

  it('emits no interim IME intent and opens exactly one draft for the committed text', () => {
    const onIntent = vi.fn();
    const controller = createProofreadInputController(onIntent);
    controller.setContext({ selection, caret: null });

    controller.compositionStart();
    controller.beforeInput(event({ inputType: 'insertCompositionText', data: '結', isComposing: true }));
    controller.compositionEnd('結論');
    controller.beforeInput(event({ inputType: 'insertText', data: '結論' }));

    expect(onIntent).toHaveBeenCalledOnce();
    expect(onIntent).toHaveBeenCalledWith({
      kind: 'replaceDraft',
      anchor: selection,
      initialText: '結論',
    });
  });

  it('does nothing without a reliable anchor, during composition, for handled events, or with modifiers', () => {
    const onGesture = vi.fn();
    const controller = createProofreadInputController(onGesture);
    controller.setContext({ selection: null, caret: null });
    controller.beforeInput(event());
    controller.setContext({ selection, caret: null });
    controller.compositionStart();
    controller.beforeInput(event({ isComposing: false }));
    controller.compositionEnd();
    controller.beforeInput(event({ defaultPrevented: true }));
    controller.keyDown(event({ key: 'x', ctrlKey: true }));
    controller.keyDown(event({ key: 'Delete', metaKey: true }));

    expect(onGesture).not.toHaveBeenCalled();
  });
});
