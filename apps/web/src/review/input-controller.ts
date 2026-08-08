import type { CaretAnchor, SelectionAnchor } from '../pdf/selection-anchor.js';
import {
  INITIAL_SELECTION_UPDATE,
  reliableSelection,
  type SelectionUpdate,
} from '../pdf/selection-state.js';

export type ProofreadGesture =
  | { kind: 'replace'; anchor: SelectionAnchor; text: string }
  | { kind: 'delete'; anchor: SelectionAnchor }
  | { kind: 'insert'; anchor: CaretAnchor; text: string };

export type ProofreadInputIntent =
  | { kind: 'replaceDraft'; anchor: SelectionAnchor; initialText: string }
  | { kind: 'insertDraft'; anchor: CaretAnchor; initialText: string }
  | { kind: 'delete'; anchor: SelectionAnchor };

export interface ProofreadInputContext {
  caret: CaretAnchor | null;
  selectionUpdate: SelectionUpdate;
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
  editable?: boolean;
  target?: EventTarget | null;
  preventDefault(): void;
}

export interface ProofreadInputController {
  setContext(context: ProofreadInputContext): void;
  focusChanged(editable: boolean): void;
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
  let context: ProofreadInputContext = {
    caret: null,
    selectionUpdate: INITIAL_SELECTION_UPDATE,
  };
  let selectionUpdate: SelectionUpdate = INITIAL_SELECTION_UPDATE;
  let composing = false;
  let composingInEditableTarget = false;
  let draftOpen = false;
  let pendingIntent:
    | { kind: 'replace'; generation: number; text: string }
    | { kind: 'delete'; generation: number }
    | null = null;

  const discardPending = () => {
    pendingIntent = null;
  };

  const beginTextDraft = (text: string) => {
    if (draftOpen || !text) return;
    const selection = reliableSelection(selectionUpdate);
    if (selection !== null) {
      draftOpen = true;
      onIntent({ kind: 'replaceDraft', anchor: selection, initialText: text });
    } else if (context.caret !== null) {
      draftOpen = true;
      onIntent({ kind: 'insertDraft', anchor: context.caret, initialText: text });
    }
  };

  const queuePendingText = (text: string) => {
    if (!text || selectionUpdate.kind !== 'pending') return;
    if (pendingIntent === null) {
      pendingIntent = { kind: 'replace', generation: selectionUpdate.generation, text };
      return;
    }
    if (pendingIntent.kind === 'replace' && pendingIntent.generation === selectionUpdate.generation) {
      pendingIntent.text += text;
    }
  };

  const queuePendingDelete = () => {
    if (selectionUpdate.kind !== 'pending' || pendingIntent !== null) return;
    pendingIntent = { kind: 'delete', generation: selectionUpdate.generation };
  };

  const releasePending = () => {
    if (
      selectionUpdate.kind !== 'reliable' ||
      pendingIntent === null ||
      pendingIntent.generation !== selectionUpdate.generation
    ) return;
    const intent = pendingIntent;
    pendingIntent = null;
    if (intent.kind === 'replace') {
      beginTextDraft(intent.text);
    } else {
      onIntent({ kind: 'delete', anchor: selectionUpdate.anchor });
    }
  };

  return {
    setContext(next) {
      context = next;
      const nextUpdate = next.selectionUpdate;
      if (pendingIntent !== null && pendingIntent.generation !== nextUpdate.generation) {
        discardPending();
      }
      selectionUpdate = nextUpdate;
      if (selectionUpdate.kind === 'reliable') {
        releasePending();
      } else if (selectionUpdate.kind !== 'pending') {
        discardPending();
      }
    },
    focusChanged(editable) {
      if (editable) discardPending();
    },
    compositionStart(target) {
      discardPending();
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
      if (event.defaultPrevented || composing || event.isComposing || isEditableTarget(event.target)) {
        discardPending();
        return;
      }
      const inputType = event.inputType ?? '';
      if (inputType === 'insertCompositionText') return;
      if (inputType.startsWith('delete')) {
        if (selectionUpdate.kind === 'pending') {
          event.preventDefault();
          queuePendingDelete();
          return;
        }
        const selection = reliableSelection(selectionUpdate);
        if (selection === null) return;
        event.preventDefault();
        onIntent({ kind: 'delete', anchor: selection });
        return;
      }
      if (!inputType.startsWith('insert') || !event.data) return;
      if (selectionUpdate.kind === 'pending') {
        event.preventDefault();
        queuePendingText(event.data);
        return;
      }
      if (reliableSelection(selectionUpdate) !== null || context.caret !== null) {
        event.preventDefault();
        beginTextDraft(event.data);
      }
    },
    keyDown(event) {
      if (
        event.defaultPrevented ||
        composing ||
        event.isComposing ||
        (event.editable ?? isEditableTarget(event.target)) ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        discardPending();
        return;
      }
      if (event.key?.length === 1 && selectionUpdate.kind === 'pending') {
        event.preventDefault();
        queuePendingText(event.key);
        return;
      }
      if (
        event.key?.length === 1 &&
        (reliableSelection(selectionUpdate) !== null || context.caret !== null)
      ) {
        event.preventDefault();
        beginTextDraft(event.key);
        return;
      }
      if (
        selectionUpdate.kind === 'pending' &&
        (event.key === 'Delete' || event.key === 'Backspace')
      ) {
        event.preventDefault();
        queuePendingDelete();
        return;
      }
      const selection = reliableSelection(selectionUpdate);
      if (selection === null || (event.key !== 'Delete' && event.key !== 'Backspace')) return;
      event.preventDefault();
      onIntent({ kind: 'delete', anchor: selection });
    },
  };
}
