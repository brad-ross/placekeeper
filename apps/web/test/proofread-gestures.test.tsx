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

  it('buffers one full printable sequence for the matching pending generation', () => {
    const onIntent = vi.fn();
    const controller = createProofreadInputController(onIntent);
    controller.setContext({
      selection: null,
      caret: null,
      selectionUpdate: { kind: 'pending', generation: 3 },
    });
    const keys = [...'revised'].map((key) => event({ key }));
    for (const key of keys) controller.keyDown(key);

    controller.setContext({
      selection,
      caret: null,
      selectionUpdate: { kind: 'reliable', generation: 3, anchor: selection },
    });

    expect(onIntent).toHaveBeenCalledOnce();
    expect(onIntent).toHaveBeenCalledWith({
      kind: 'replaceDraft',
      anchor: selection,
      initialText: 'revised',
    });
    for (const key of keys) expect(key.preventDefault).toHaveBeenCalledOnce();
  });

  it('buffers only one pending Delete or Backspace intent', () => {
    const onIntent = vi.fn();
    const controller = createProofreadInputController(onIntent);
    controller.setContext({
      selection: null,
      caret: null,
      selectionUpdate: { kind: 'pending', generation: 5 },
    });
    controller.keyDown(event({ key: 'Delete' }));
    controller.keyDown(event({ key: 'Backspace' }));
    controller.setContext({
      selection,
      caret: null,
      selectionUpdate: { kind: 'reliable', generation: 5, anchor: selection },
    });

    expect(onIntent).toHaveBeenCalledOnce();
    expect(onIntent).toHaveBeenCalledWith({ kind: 'delete', anchor: selection });
  });

  it.each([
    ['printable text', (controller: ReturnType<typeof createProofreadInputController>) => {
      controller.keyDown(event({ key: 'x' }));
    }],
    ['Delete', (controller: ReturnType<typeof createProofreadInputController>) => {
      controller.keyDown(event({ key: 'Delete' }));
    }],
  ])('discards pending %s when focus enters a recognized editable host', (_name, queue) => {
    const onIntent = vi.fn();
    const controller = createProofreadInputController(onIntent);
    controller.setContext({
      selection: null,
      caret: null,
      selectionUpdate: { kind: 'pending', generation: 9 },
    });
    queue(controller);
    controller.focusChanged(true);
    controller.setContext({
      selection,
      caret: null,
      selectionUpdate: { kind: 'reliable', generation: 9, anchor: selection },
    });

    expect(onIntent).not.toHaveBeenCalled();
  });

  it('discards pending input on clear, unreliable, supersession, composition, handled, and modifier paths', () => {
    const discardCases = [
      (controller: ReturnType<typeof createProofreadInputController>) => controller.setContext({
        selection: null,
        caret: null,
        selectionUpdate: { kind: 'cleared', generation: 7 },
      }),
      (controller: ReturnType<typeof createProofreadInputController>) => controller.setContext({
        selection: null,
        caret: null,
        selectionUpdate: {
          kind: 'unreliable',
          generation: 6,
          userMessage: 'Reselect.',
          diagnostic: 'selection-text-geometry-mismatch',
        },
      }),
      (controller: ReturnType<typeof createProofreadInputController>) => controller.setContext({
        selection: null,
        caret: null,
        selectionUpdate: { kind: 'pending', generation: 7 },
      }),
      (controller: ReturnType<typeof createProofreadInputController>) => controller.compositionStart(),
      (controller: ReturnType<typeof createProofreadInputController>) => controller.keyDown(event({ key: 'x', defaultPrevented: true })),
      (controller: ReturnType<typeof createProofreadInputController>) => controller.keyDown(event({ key: 'x', metaKey: true })),
    ];

    for (const discard of discardCases) {
      const onIntent = vi.fn();
      const controller = createProofreadInputController(onIntent);
      controller.setContext({
        selection: null,
        caret: null,
        selectionUpdate: { kind: 'pending', generation: 6 },
      });
      controller.keyDown(event({ key: 'x' }));
      discard(controller);
      controller.setContext({
        selection,
        caret: null,
        selectionUpdate: { kind: 'reliable', generation: 6, anchor: selection },
      });
      expect(onIntent).not.toHaveBeenCalled();
    }
  });
});
