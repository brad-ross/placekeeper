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
  active: boolean;
  selection: SelectionAnchor | null;
  caret: CaretAnchor | null;
}

export interface BeforeInputLike {
  inputType?: string;
  data?: string | null;
  isComposing?: boolean;
  target?: EventTarget | null;
  preventDefault(): void;
}

export interface KeyDownLike {
  key?: string;
  isComposing?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  target?: EventTarget | null;
  preventDefault(): void;
}

export interface ProofreadInputController {
  setContext(context: ProofreadInputContext): void;
  compositionStart(): void;
  compositionEnd(committedText?: string): void;
  clearDraft(): void;
  beforeInput(event: BeforeInputLike): void;
  keyDown(event: KeyDownLike): void;
}

export function createProofreadInputController(
  onIntent: (intent: ProofreadInputIntent) => void,
): ProofreadInputController {
  let context: ProofreadInputContext = { active: false, selection: null, caret: null };
  let composing = false;
  let draftOpen = false;

  const editableTarget = (event: { target?: EventTarget | null }) => {
    const target = event.target;
    return typeof HTMLElement !== 'undefined' && target instanceof HTMLElement &&
      (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement);
  };

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
    compositionStart() {
      composing = true;
    },
    compositionEnd(committedText) {
      composing = false;
      if (committedText) beginTextDraft(committedText);
    },
    clearDraft() {
      draftOpen = false;
    },
    beforeInput(event) {
      if (!context.active || composing || event.isComposing || editableTarget(event)) return;
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
        context.active &&
        !composing &&
        !event.isComposing &&
        !editableTarget(event) &&
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
        !context.active ||
        composing ||
        event.isComposing ||
        editableTarget(event) ||
        context.selection === null ||
        (event.key !== 'Delete' && event.key !== 'Backspace')
      ) return;
      event.preventDefault();
      onIntent({ kind: 'delete', anchor: context.selection });
    },
  };
}
