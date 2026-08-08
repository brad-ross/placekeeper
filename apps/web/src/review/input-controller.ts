import type { CaretAnchor, SelectionAnchor } from '../pdf/selection-anchor.js';

export type ProofreadGesture =
  | { kind: 'replace'; anchor: SelectionAnchor; text: string }
  | { kind: 'delete'; anchor: SelectionAnchor }
  | { kind: 'insert'; anchor: CaretAnchor; text: string };

export type ProofreadInputIntent =
  | { kind: 'replaceDraft'; anchor: SelectionAnchor; initialText: string }
  | { kind: 'insertDraft'; anchor: CaretAnchor; initialText: string }
  | { kind: 'delete'; anchor: SelectionAnchor };

export interface ProofreadInputContext {
  selection: SelectionAnchor | null;
  caret: CaretAnchor | null;
}

export interface BeforeInputLike {
  inputType?: string;
  data?: string | null;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
  preventDefault(): void;
}

export interface KeyDownLike {
  key?: string;
  isComposing?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
  preventDefault(): void;
}

export interface ProofreadInputController {
  setContext(context: ProofreadInputContext): void;
  compositionStart(target?: EventTarget | null): void;
  compositionEnd(committedText?: string, target?: EventTarget | null): void;
  clearDraft(): void;
  beforeInput(event: BeforeInputLike): void;
  keyDown(event: KeyDownLike): void;
}

const EDITABLE_HOST_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="spinbutton"]',
  '[role="dialog"]',
  '[data-review-editor]',
].join(',');

export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  if (typeof Element === 'undefined') return false;
  const element = target instanceof Element
    ? target
    : typeof Node !== 'undefined' && target instanceof Node
      ? target.parentElement
      : null;
  if (element === null) return false;
  return element.closest(EDITABLE_HOST_SELECTOR) !== null ||
    (typeof HTMLElement !== 'undefined' && element instanceof HTMLElement && element.isContentEditable);
}

export function createProofreadInputController(
  onIntent: (intent: ProofreadInputIntent) => void,
): ProofreadInputController {
  let context: ProofreadInputContext = { selection: null, caret: null };
  let composing = false;
  let composingInEditableTarget = false;
  let draftOpen = false;

  const beginTextDraft = (text: string) => {
    if (draftOpen || !text) return;
    if (context.selection !== null) {
      draftOpen = true;
      onIntent({ kind: 'replaceDraft', anchor: context.selection, initialText: text });
    } else if (context.caret !== null) {
      draftOpen = true;
      onIntent({ kind: 'insertDraft', anchor: context.caret, initialText: text });
    }
  };

  return {
    setContext(next) {
      context = next;
    },
    compositionStart(target) {
      composing = true;
      composingInEditableTarget = isEditableTarget(target);
    },
    compositionEnd(committedText, target) {
      const editable = composingInEditableTarget || isEditableTarget(target);
      composing = false;
      composingInEditableTarget = false;
      if (!editable && committedText) beginTextDraft(committedText);
    },
    clearDraft() {
      draftOpen = false;
    },
    beforeInput(event) {
      if (event.defaultPrevented || composing || event.isComposing || isEditableTarget(event.target)) return;
      const inputType = event.inputType ?? '';
      if (inputType === 'insertCompositionText') return;
      if (inputType.startsWith('delete')) {
        if (context.selection === null) return;
        event.preventDefault();
        onIntent({ kind: 'delete', anchor: context.selection });
        return;
      }
      if (!inputType.startsWith('insert') || !event.data) return;
      if (context.selection !== null || context.caret !== null) {
        event.preventDefault();
        beginTextDraft(event.data);
      }
    },
    keyDown(event) {
      if (
        !event.defaultPrevented &&
        !composing &&
        !event.isComposing &&
        !isEditableTarget(event.target) &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.key?.length === 1 &&
        (context.selection !== null || context.caret !== null)
      ) {
        event.preventDefault();
        beginTextDraft(event.key);
        return;
      }
      if (
        event.defaultPrevented ||
        composing ||
        event.isComposing ||
        isEditableTarget(event.target) ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        context.selection === null ||
        (event.key !== 'Delete' && event.key !== 'Backspace')
      ) return;
      event.preventDefault();
      onIntent({ kind: 'delete', anchor: context.selection });
    },
  };
}
