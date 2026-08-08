import {
  useLayoutEffect,
  useEffect,
  useReducer,
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
import type { ReviewCommand, ReviewItem, ReviewState } from '../../../../packages/core/src/review-model.js';
import type { CaretAnchor, SelectionAnchor } from '../pdf/selection-anchor.js';
import { reliableSelection, type SelectionUpdate } from '../pdf/selection-state.js';
import type { ViewerControls, ViewerControlsSnapshot } from '../pdf/viewer-controls.js';
import { unavailableViewerControls } from '../pdf/viewer-controls.js';
import { AnnotationList } from '../review/AnnotationList.js';
import { CommentComposer } from '../review/CommentComposer.js';
import { ContextActionPalette, type ContextPlacement } from '../review/ContextActionPalette.js';
import { PageActionMenu } from '../review/PageActionMenu.js';
import { ReviewChrome } from '../review/ReviewChrome.js';
import {
  createProofreadInputController,
  isEditableTarget,
  type ProofreadInputIntent,
} from '../review/input-controller.js';
import { reviewActionForKey } from '../review/review-actions.js';
import {
  INITIAL_REVIEW_SURFACE_STATE,
  reduceReviewSurface,
  type ReviewBaseSurface,
} from '../review/review-surface-state.js';
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
  documentTitle?: string;
  savedLabel?: string;
  listOpen?: boolean;
  selectionUpdate: SelectionUpdate;
  selectionPlacement?: ContextPlacement | null;
  caretAnchor?: CaretAnchor | null;
  caretPlacement?: ContextPlacement | null;
  pageMenu?: {
    readonly invocationId: string;
    readonly placement: ContextPlacement;
    readonly pageIndex: number;
    readonly position: ReviewRect;
    readonly nearbyText?: string;
  } | null;
  placedPageNote?: {
    readonly token: number;
    readonly pageIndex: number;
    readonly position: ReviewRect;
    readonly nearbyText?: string;
  } | null;
  keyboardPageNoteActive?: boolean;
  onRequestKeyboardPageNote?(): void;
  onCancelKeyboardPageNote?(): void;
  onPageMenuDismiss?(invocationId: string): void;
  onPageMenuConsumed?(invocationId: string): void;
  onPlacedPageNoteConsumed?(token: number): void;
  onPageNoteComposerComplete?(): void;
  onCommand(command: ReviewCommand): Promise<ReviewState | RejectedReviewCommand>;
  onNavigate?(item: ReviewItem): void;
  viewerControls?: ViewerControls;
  viewerState?: ViewerControlsSnapshot;
  finishSlot?: ReactNode;
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
  const [surface, dispatchSurface] = useReducer(
    reduceReviewSurface,
    props.listOpen === true
      ? { baseSurface: 'annotations', nestedLayer: 'none', transientSurface: 'none' }
      : INITIAL_REVIEW_SURFACE_STATE,
  );
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
  const surfaceTriggersRef = useRef(new Map<ReviewBaseSurface, HTMLElement>());
  const listOpen = surface.baseSurface === 'annotations';
  const selectionAnchor = reliableSelection(props.selectionUpdate);
  const lastPlacedPageNoteToken = useRef<number | undefined>(undefined);

  const rememberSurfaceTrigger = (surfaceName: ReviewBaseSurface) => {
    if (document.activeElement instanceof HTMLElement) {
      surfaceTriggersRef.current.set(surfaceName, document.activeElement);
    }
  };
  const openBase = (surfaceName: ReviewBaseSurface) => {
    rememberSurfaceTrigger(surfaceName);
    dispatchSurface({
      type: 'open-base',
      surface: surface.baseSurface === surfaceName ? 'reading' : surfaceName,
    });
  };
  const restoreSurfaceTrigger = (surfaceName: ReviewBaseSurface) => {
    const trigger = surfaceTriggersRef.current.get(surfaceName);
    queueMicrotask(() => trigger?.focus());
  };

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
    dispatchSurface({ type: 'open-nested' });
  };

  const inputIntentRef = useRef(handleInputIntent);
  inputIntentRef.current = handleInputIntent;
  const inputControllerRef = useRef<ReturnType<typeof createProofreadInputController> | null>(null);
  if (inputControllerRef.current === null) {
    inputControllerRef.current = createProofreadInputController((intent) => inputIntentRef.current(intent));
  }
  const inputController = inputControllerRef.current;
  const closeNested = () => {
    const trigger = textDraft ? draftTriggerRef.current
      : composer?.kind === 'edit' ? editTriggerRef.current
      : modalTriggerRef.current;
    if (textDraft) {
      setTextDraft(null);
      inputController.clearDraft();
    }
    if (composer) setComposer(null);
    dispatchSurface({ type: 'close-nested' });
    queueMicrotask(() => trigger?.focus());
  };
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
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      if (surface.nestedLayer !== 'none') {
        event.preventDefault();
        closeNested();
        return;
      }
      if (props.keyboardPageNoteActive) {
        event.preventDefault();
        props.onCancelKeyboardPageNote?.();
        dispatchSurface({ type: 'close-transient' });
        return;
      }
      if (props.pageMenu) {
        event.preventDefault();
        props.onPageMenuDismiss?.(props.pageMenu.invocationId);
        dispatchSurface({ type: 'close-transient' });
        return;
      }
      if (surface.baseSurface !== 'reading') {
        event.preventDefault();
        const closing = surface.baseSurface;
        dispatchSurface({ type: 'escape' });
        restoreSurfaceTrigger(closing);
        return;
      }
    }
    if (event.defaultPrevented || editable || event.nativeEvent.isComposing) return;
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      const tool = reviewActionForKey(event.key);
      if (tool) {
        event.preventDefault();
        if (tool === 'replace') startTextTool('replace');
        if (tool === 'delete') deleteSelection();
        if (tool === 'insert') startTextTool('insert');
        if (tool === 'highlight') startHighlight();
        if (tool === 'pageNote') {
          props.onRequestKeyboardPageNote?.();
          dispatchSurface({ type: 'open-transient', surface: 'page-note-cursor' });
        }
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
        dispatchSurface({ type: 'open-nested' });
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
    dispatchSurface({ type: 'open-nested' });
  };

  const deleteSelection = () => {
    if (!selectionAnchor) {
      setAnnouncement('Select reliable text to suggest deletion.');
      return;
    }
    void submit((state) => addDelete(state, selectionAnchor));
  };

  const startPageNote = (anchor?: { pageIndex: number; position: ReviewRect; nearbyText?: string } | null) => {
    if (!anchor) {
      setAnnouncement('Choose a safe page location to add a Page Note.');
      return;
    }
    modalTriggerRef.current = pageNoteTriggerRef.current
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setComposer({ kind: 'pageNote', ...anchor });
    dispatchSurface({ type: 'open-nested' });
  };

  useEffect(() => {
    const placed = props.placedPageNote;
    if (!placed || placed.token === lastPlacedPageNoteToken.current) return;
    lastPlacedPageNoteToken.current = placed.token;
    startPageNote(placed);
    props.onPlacedPageNoteConsumed?.(placed.token);
  }, [props.placedPageNote]);

  const closeTextDraft = () => {
    setTextDraft(null);
    inputController.clearDraft();
    dispatchSurface({ type: 'close-nested' });
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
      <ReviewChrome
        documentTitle={props.documentTitle ?? 'Local PDF'}
        {...(props.savedLabel === undefined ? {} : { savedLabel: props.savedLabel })}
        {...(props.viewerControls === undefined ? {} : { controls: props.viewerControls })}
        viewerState={props.viewerState ?? unavailableViewerControls()}
        canUndo={canUndo}
        canRedo={canRedo}
        annotationCount={props.state.items.length}
        annotationsOpen={listOpen}
        finishOpen={surface.baseSurface === 'finish'}
        onUndo={() => void submit(undoReview)}
        onRedo={() => void submit(redoReview)}
        onAnnotations={() => openBase('annotations')}
        onFinish={() => openBase('finish')}
      />
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <div className="review-layout" data-review-stage>
        <div className="review-document">{props.children}</div>
        <div className="review-contextual-host" data-review-contextual-host>
          {surface.baseSurface === 'reading' && selectionAnchor && props.selectionPlacement ? (
            <ContextActionPalette
              kind="selection"
              placement={props.selectionPlacement}
              hidden={surface.nestedLayer !== 'none'}
              onReplace={() => startTextTool('replace')}
              onDelete={deleteSelection}
              onHighlight={startHighlight}
            />
          ) : null}
          {surface.baseSurface === 'reading' && !selectionAnchor && props.caretAnchor && props.caretPlacement ? (
            <ContextActionPalette
              kind="insert"
              placement={props.caretPlacement}
              hidden={surface.nestedLayer !== 'none'}
              onInsert={() => startTextTool('insert')}
            />
          ) : null}
          {surface.nestedLayer === 'none' && props.pageMenu ? (
            <PageActionMenu
              placement={props.pageMenu.placement}
              triggerRef={pageNoteTriggerRef}
              onAddPageNote={() => {
                const menu = props.pageMenu;
                if (!menu) return;
                props.onPageMenuConsumed?.(menu.invocationId);
                startPageNote(menu);
              }}
              onDismiss={() => {
                const menu = props.pageMenu;
                if (!menu) return;
                props.onPageMenuDismiss?.(menu.invocationId);
                dispatchSurface({ type: 'close-transient' });
              }}
            />
          ) : null}
          <div
            className="review-list"
            data-list-open={listOpen ? 'true' : 'false'}
            aria-hidden={!listOpen}
            inert={!listOpen}
          >
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
                dispatchSurface({ type: 'open-nested' });
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
        <div className="review-drawer-host" data-review-drawer-host>
          <aside
            id="review-finish-drawer"
            className="review-finish-drawer"
            data-review-finish-slot
            data-surface-open={surface.baseSurface === 'finish' ? 'true' : 'false'}
            aria-label="Finish review"
            aria-hidden={surface.baseSurface !== 'finish'}
            inert={surface.baseSurface !== 'finish'}
          >
            {props.finishSlot}
          </aside>
        </div>
      </div>
      <div className="review-nested-host" data-review-nested-host>
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
            onDismiss={() => {
              setComposer(null);
              dispatchSurface({ type: 'close-nested' });
            }}
            onSave={async (value) => {
              if (value) await submit((state) => editReviewItem(state, composer.itemId, { comment: value }));
              setComposer(null);
              dispatchSurface({ type: 'close-nested' });
            }}
          />
        ) : null}
        {composer?.kind === 'pageNote' ? (
          <CommentComposer
            title="Page Note"
            triggerRef={modalTriggerRef}
            onDismiss={() => {
              setComposer(null);
              dispatchSurface({ type: 'close-nested' });
              props.onPageNoteComposerComplete?.();
            }}
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
              dispatchSurface({ type: 'close-nested' });
              props.onPageNoteComposerComplete?.();
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
            onDismiss={() => {
              setComposer(null);
              dispatchSurface({ type: 'close-nested' });
            }}
            onSave={async (value) => {
              const field = mutableField(composer.item)!;
              await submit((state) => editReviewItem(state, composer.item.id, { [field]: value }));
              setComposer(null);
              dispatchSurface({ type: 'close-nested' });
            }}
          />
        ) : null}
      </div>
    </section>
  );
}
