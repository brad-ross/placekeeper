import {
  useLayoutEffect,
  useRef,
  useState,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import {
  addHighlight,
  addDelete,
  addInsert,
  addPageNote,
  addReplace,
  editReviewItem,
  redoReview,
  removeReviewItem,
  undoReview,
  type ReviewRect,
} from '../../../../packages/core/src/review-commands.js';
import type { ReviewCommand, ReviewItem, ReviewItemKind, ReviewState } from '../../../../packages/core/src/review-model.js';
import type { CaretAnchor, SelectionAnchor } from '../pdf/selection-anchor.js';
import { reliableSelection, type SelectionUpdate } from '../pdf/selection-state.js';
import { AnnotationList } from '../review/AnnotationList.js';
import { CommentComposer } from '../review/CommentComposer.js';
import {
  createProofreadInputController,
  isEditableTarget,
  type ProofreadInputIntent,
} from '../review/input-controller.js';
import { ReviewToolbar, reviewToolForKey } from '../review/ReviewToolbar.js';
import './review-layout.css';

type TextDraft =
  | { kind: 'replace'; anchor: SelectionAnchor; initialText: string }
  | { kind: 'insert'; anchor: CaretAnchor; initialText: string };

type Composer =
  | { kind: 'highlight'; itemId: string }
  | { kind: 'pageNote'; pageIndex: number; position: ReviewRect; nearbyText?: string }
  | { kind: 'edit'; item: ReviewItem };

export interface ReviewShellProps {
  state: ReviewState;
  currentTool: ReviewItemKind;
  listOpen?: boolean;
  selectionUpdate: SelectionUpdate;
  caretAnchor?: CaretAnchor | null;
  pageNoteAnchor?: { pageIndex: number; position: ReviewRect; nearbyText?: string } | null;
  onToolChange(tool: ReviewItemKind): void;
  onCommand(command: ReviewCommand): Promise<ReviewState | RejectedReviewCommand>;
  onNavigate?(item: ReviewItem): void;
  children?: ReactNode;
}

export interface RejectedReviewCommand {
  readonly accepted: false;
  readonly state: ReviewState;
  readonly message: string;
}

function mutableField(item: ReviewItem): 'proposedText' | 'comment' | undefined {
  if (item.kind === 'replace' || item.kind === 'insert') return 'proposedText';
  if (item.kind === 'highlight' || item.kind === 'pageNote') return 'comment';
  return undefined;
}

export function ReviewShell(props: ReviewShellProps) {
  const [internalListOpen, setInternalListOpen] = useState(false);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [activeItemId, setActiveItemId] = useState<string>();
  const [announcement, setAnnouncement] = useState(`Review revision ${props.state.revision}.`);
  const acknowledgedRef = useRef(props.state);
  const commandTailRef = useRef<Promise<ReviewState>>(Promise.resolve(props.state));
  const modalTriggerRef = useRef<HTMLElement>(null);
  const pageNoteTriggerRef = useRef<HTMLButtonElement>(null);
  const draftTriggerRef = useRef<HTMLElement>(null);
  const editTriggerRef = useRef<HTMLButtonElement>(null);
  const listOpen = props.listOpen ?? internalListOpen;
  const selectionAnchor = reliableSelection(props.selectionUpdate);

  if (props.state.revision >= acknowledgedRef.current.revision) acknowledgedRef.current = props.state;

  const submit = (build: (state: ReviewState) => ReviewCommand): Promise<ReviewState> => {
    const result = commandTailRef.current.then(async () => {
      const command = build(acknowledgedRef.current);
      const result = await props.onCommand(command);
      const next = 'accepted' in result ? result.state : result;
      acknowledgedRef.current = next;
      setAnnouncement('accepted' in result
        ? result.message
        : `Review revision ${next.revision} saved.`);
      return next;
    });
    commandTailRef.current = result.catch(() => acknowledgedRef.current);
    return result;
  };

  const handleInputIntent = (intent: ProofreadInputIntent) => {
    if (intent.kind === 'delete') {
      void submit((state) => addDelete(state, intent.anchor));
      return;
    }
    draftTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setTextDraft({
      kind: intent.kind === 'replaceDraft' ? 'replace' : 'insert',
      anchor: intent.anchor,
      initialText: intent.initialText,
    } as TextDraft);
  };

  const inputIntentRef = useRef(handleInputIntent);
  inputIntentRef.current = handleInputIntent;
  const inputControllerRef = useRef<ReturnType<typeof createProofreadInputController> | null>(null);
  if (inputControllerRef.current === null) {
    inputControllerRef.current = createProofreadInputController((intent) => inputIntentRef.current(intent));
  }
  const inputController = inputControllerRef.current;
  useLayoutEffect(() => {
    inputController.focusChanged(isEditableTarget(document.activeElement));
    inputController.setContext({
      caret: props.caretAnchor ?? null,
      selectionUpdate: props.selectionUpdate,
    });
  }, [inputController, props.caretAnchor, props.selectionUpdate]);

  const beforeInput = (event: FormEvent<HTMLDivElement>) => {
    const native = event.nativeEvent as InputEvent;
    inputController.beforeInput({
      inputType: native.inputType,
      data: native.data,
      isComposing: native.isComposing,
      defaultPrevented: event.defaultPrevented,
      target: event.target,
      preventDefault: () => event.preventDefault(),
    });
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const editable = isEditableTarget(event.target);
    if (event.defaultPrevented || editable || event.nativeEvent.isComposing) return;
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      const tool = reviewToolForKey(event.key);
      if (tool) {
        event.preventDefault();
        props.onToolChange(tool);
        if (tool === 'replace') startTextTool('replace');
        if (tool === 'delete') deleteSelection();
        if (tool === 'insert') startTextTool('insert');
        if (tool === 'highlight') startHighlight();
        if (tool === 'pageNote') startPageNote();
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      void submit((state) => event.shiftKey ? redoReview(state) : undoReview(state));
      return;
    }
    inputController.keyDown({
      key: event.key,
      isComposing: event.nativeEvent.isComposing,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      defaultPrevented: event.defaultPrevented,
      editable,
      target: event.target,
      preventDefault: () => event.preventDefault(),
    });
  };
  const compositionEnd = (event: CompositionEvent<HTMLDivElement>) => {
    inputController.compositionEnd(event.data, event.target);
  };

  const startHighlight = () => {
    const anchor = selectionAnchor;
    if (!anchor) {
      setAnnouncement('Select reliable text to add a highlight.');
      return;
    }
    modalTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let addedId: string | undefined;
    void submit((state) => {
      const command = addHighlight(state, anchor);
      if (command.type !== 'add') throw new Error('Highlight command must add an item');
      addedId = command.item.id;
      return command;
    }).then((next) => {
      if (addedId && next.items.some(({ id }) => id === addedId)) {
        setComposer({ kind: 'highlight', itemId: addedId });
      }
    });
  };

  const startTextTool = (kind: 'replace' | 'insert') => {
    const anchor = kind === 'replace' ? selectionAnchor : props.caretAnchor;
    if (!anchor) {
      setAnnouncement(kind === 'replace'
        ? 'Select reliable text to suggest a replacement.'
        : 'Choose a reliable text position to suggest an insertion.');
      return;
    }
    draftTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTextDraft({ kind, anchor, initialText: '' } as TextDraft);
  };

  const deleteSelection = () => {
    if (!selectionAnchor) {
      setAnnouncement('Select reliable text to suggest deletion.');
      return;
    }
    void submit((state) => addDelete(state, selectionAnchor));
  };

  const startPageNote = () => {
    if (!props.pageNoteAnchor) {
      setAnnouncement('Choose a safe page location to add a Page Note.');
      return;
    }
    modalTriggerRef.current = pageNoteTriggerRef.current
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setComposer({ kind: 'pageNote', ...props.pageNoteAnchor });
  };

  const closeTextDraft = () => {
    setTextDraft(null);
    inputController.clearDraft();
  };

  const canUndo = props.state.historyCursor > 0;
  const canRedo = props.state.historyCursor < props.state.history.length;

  return (
    <section
      className="review-shell"
      data-breakpoint="1024"
      onBeforeInputCapture={beforeInput}
      onKeyDownCapture={keyDown}
      onFocusCapture={(event) => inputController.focusChanged(isEditableTarget(event.target))}
      onCompositionStartCapture={(event) => inputController.compositionStart(event.target)}
      onCompositionEndCapture={compositionEnd}
    >
      <ReviewToolbar
        currentTool={props.currentTool}
        canUndo={canUndo}
        canRedo={canRedo}
        listOpen={listOpen}
        pageNoteTriggerRef={pageNoteTriggerRef}
        onToolChange={props.onToolChange}
        onHighlight={startHighlight}
        onPageNote={startPageNote}
        onReplace={() => startTextTool('replace')}
        onDelete={deleteSelection}
        onInsert={() => startTextTool('insert')}
        onUndo={() => void submit(undoReview)}
        onRedo={() => void submit(redoReview)}
        onListOpenChange={setInternalListOpen}
      />
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <div className="review-layout">
        <div className="review-document">{props.children}</div>
        <div className="review-list" data-list-open={listOpen ? 'true' : 'false'}>
          <AnnotationList
            items={props.state.items}
            {...(activeItemId === undefined ? {} : { activeId: activeItemId })}
            onNavigate={(item) => {
              setActiveItemId(item.id);
              props.onNavigate?.(item);
            }}
            onEdit={(item, trigger) => {
              editTriggerRef.current = trigger;
              setComposer({ kind: 'edit', item });
            }}
            onDelete={async (item) => {
              const next = await submit((state) => removeReviewItem(state, item.id));
              if (activeItemId === item.id) {
                const ordered = next.items;
                setActiveItemId(ordered[0]?.id);
              }
            }}
          />
        </div>
      </div>
      {textDraft ? (
        <CommentComposer
          title={textDraft.kind === 'replace' ? 'Replacement text' : 'Insertion text'}
          fieldLabel={textDraft.kind === 'replace' ? 'Replacement text' : 'Insertion text'}
          saveLabel="Apply"
          allowWhitespace
          initialValue={textDraft.initialText}
          triggerRef={draftTriggerRef}
          onDismiss={closeTextDraft}
          onSave={async (value) => {
            const frozen = textDraft;
            await submit((state) => frozen.kind === 'replace'
              ? addReplace(state, frozen.anchor, value)
              : addInsert(state, frozen.anchor, value));
            closeTextDraft();
          }}
        />
      ) : null}
      {composer?.kind === 'highlight' ? (
        <CommentComposer
          title="Highlight comment"
          optional
          triggerRef={modalTriggerRef}
          onDismiss={() => setComposer(null)}
          onSave={async (value) => {
            if (value) await submit((state) => editReviewItem(state, composer.itemId, { comment: value }));
            setComposer(null);
          }}
        />
      ) : null}
      {composer?.kind === 'pageNote' ? (
        <CommentComposer
          title="Page Note"
          triggerRef={modalTriggerRef}
          onDismiss={() => setComposer(null)}
          onSave={async (value) => {
            const frozen = composer;
            await submit((state) => addPageNote(
              state,
              frozen.pageIndex,
              frozen.position,
              value,
              undefined,
              frozen.nearbyText,
            ));
            setComposer(null);
          }}
        />
      ) : null}
      {composer?.kind === 'edit' && mutableField(composer.item) ? (
        <CommentComposer
          title={`Edit ${composer.item.kind}`}
          {...(composer.item.kind === 'replace' || composer.item.kind === 'insert'
            ? {
                allowWhitespace: true,
                fieldLabel: composer.item.kind === 'replace' ? 'Replacement text' : 'Insertion text',
                saveLabel: 'Apply',
              }
            : {})}
          initialValue={String(composer.item.payload[mutableField(composer.item)!] ?? '')}
          optional={composer.item.kind === 'highlight'}
          triggerRef={editTriggerRef}
          onDismiss={() => setComposer(null)}
          onSave={async (value) => {
            const field = mutableField(composer.item)!;
            await submit((state) => editReviewItem(state, composer.item.id, { [field]: value }));
            setComposer(null);
          }}
        />
      ) : null}
    </section>
  );
}
