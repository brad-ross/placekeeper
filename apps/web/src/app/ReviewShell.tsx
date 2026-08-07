import {
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
import { AnnotationList } from '../review/AnnotationList.js';
import { CommentComposer } from '../review/CommentComposer.js';
import {
  createProofreadInputController,
  type ProofreadInputIntent,
} from '../review/input-controller.js';
import { ReviewToolbar } from '../review/ReviewToolbar.js';
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
  proofreadActive: boolean;
  currentTool: ReviewItemKind;
  listOpen?: boolean;
  selectionAnchor?: SelectionAnchor | null;
  caretAnchor?: CaretAnchor | null;
  pageNoteAnchor?: { pageIndex: number; position: ReviewRect; nearbyText?: string } | null;
  onProofreadActiveChange(active: boolean): void;
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
  inputController.setContext({
    active: props.proofreadActive,
    selection: props.selectionAnchor ?? null,
    caret: props.caretAnchor ?? null,
  });

  const beforeInput = (event: FormEvent<HTMLDivElement>) => {
    const native = event.nativeEvent as InputEvent;
    inputController.beforeInput({
      inputType: native.inputType,
      data: native.data,
      isComposing: native.isComposing,
      target: event.target,
      preventDefault: () => event.preventDefault(),
    });
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      const tool = ({ r: 'replace', d: 'delete', i: 'insert', h: 'highlight', n: 'pageNote' } as Readonly<Record<string, ReviewItemKind>>)[event.key.toLowerCase()];
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
      target: event.target,
      preventDefault: () => event.preventDefault(),
    });
  };
  const compositionEnd = (event: CompositionEvent<HTMLDivElement>) => {
    inputController.compositionEnd(event.data);
  };

  const startHighlight = () => {
    const anchor = props.selectionAnchor;
    if (!props.proofreadActive || !anchor) {
      setAnnouncement('Select reliable text in Proofread mode to add a highlight.');
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
    const anchor = kind === 'replace' ? props.selectionAnchor : props.caretAnchor;
    if (!props.proofreadActive || !anchor) {
      setAnnouncement(kind === 'replace'
        ? 'Select reliable text in Proofread mode to suggest a replacement.'
        : 'Choose a reliable text position in Proofread mode to suggest an insertion.');
      return;
    }
    draftTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTextDraft({ kind, anchor, initialText: '' } as TextDraft);
  };

  const deleteSelection = () => {
    if (!props.proofreadActive || !props.selectionAnchor) {
      setAnnouncement('Select reliable text in Proofread mode to suggest deletion.');
      return;
    }
    void submit((state) => addDelete(state, props.selectionAnchor!));
  };

  const startPageNote = () => {
    if (!props.proofreadActive || !props.pageNoteAnchor) {
      setAnnouncement('Choose a safe page location in Proofread mode to add a Page Note.');
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

  const canUndo = (props.state.historyCursor ?? 0) > 0;
  const canRedo = (props.state.historyCursor ?? 0) < (props.state.history?.length ?? 0);

  return (
    <section
      className="review-shell"
      data-breakpoint="1024"
      onBeforeInputCapture={beforeInput}
      onKeyDownCapture={keyDown}
      onCompositionStartCapture={() => inputController.compositionStart()}
      onCompositionEndCapture={compositionEnd}
    >
      <ReviewToolbar
        active={props.proofreadActive}
        currentTool={props.currentTool}
        canUndo={canUndo}
        canRedo={canRedo}
        listOpen={listOpen}
        pageNoteTriggerRef={pageNoteTriggerRef}
        onActiveChange={props.onProofreadActiveChange}
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
