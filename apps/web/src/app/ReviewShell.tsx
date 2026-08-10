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
  type CSSProperties,
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
import type { ExistingAnnotation, ExistingAnnotationsDiscovery } from '../pdf/existing-annotations.js';
import { reliableSelection, type SelectionUpdate } from '../pdf/selection-state.js';
import type { ViewerControls, ViewerControlsSnapshot } from '../pdf/viewer-controls.js';
import { unavailableViewerControls } from '../pdf/viewer-controls.js';
import type { ViewerFramingControls, ViewerPosition } from '../pdf/viewer-framing.js';
import { dispatchNeutralViewerPointerUp } from '../pdf/viewer-interaction-events.js';
import { AnnotationList } from '../review/AnnotationList.js';
import { AnnotationPeek } from '../review/AnnotationPeek.js';
import { CommentComposer } from '../review/CommentComposer.js';
import { ContextActionPalette, type ContextPlacement } from '../review/ContextActionPalette.js';
import { PageActionMenu } from '../review/PageActionMenu.js';
import { ReviewChrome } from '../review/ReviewChrome.js';
import { ReviewIcon } from '../review/ReviewIcon.js';
import { FinishReviewDrawer } from './FinishReviewDrawer.js';
import {
  createProofreadInputController,
  isEditableTarget,
  type ProofreadInputIntent,
} from '../review/input-controller.js';
import { reviewActionForKey } from '../review/review-actions.js';
import {
  useAnnotationTrayFraming,
  type AnnotationOpenRequest,
} from '../review/use-annotation-tray-framing.js';
import {
  INITIAL_REVIEW_SURFACE_STATE,
  reduceReviewSurface,
  type ReviewBaseSurface,
} from '../review/review-surface-state.js';
import './review-layout.css';

type TextDraft =
  | {
      kind: 'replace';
      anchor: SelectionAnchor;
      initialText: string;
      selectionGeneration: number;
    }
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
  onNavigateExisting?(item: ExistingAnnotation): void;
  existingAnnotations?: ExistingAnnotationsDiscovery;
  onRetryExistingAnnotations?(): void;
  correspondingItemId?: string;
  activationRequest?: { readonly id: string; readonly token: number };
  onItemCorrespondenceChange?(id: string | undefined): void;
  onActiveItemChange?(id: string | undefined): void;
  viewerControls?: ViewerControls;
  viewerState?: ViewerControlsSnapshot;
  viewerFraming?: ViewerFramingControls;
  finishSlot?: ReactNode;
  finishConfirmationActive?: boolean;
  onFinishReview?(): void | Promise<void>;
  onDiscardReview?(): void | Promise<void>;
  children?: ReactNode;
}

export interface RejectedReviewCommand {
  readonly accepted: false;
  readonly state: ReviewState;
  readonly message: string;
}

const OUTSIDE_TAP_SLOP_PX = 6;

type OutsidePointerGesture =
  | {
      readonly phase: 'tracking';
      readonly id: number;
      readonly x: number;
      readonly y: number;
      readonly target: EventTarget;
      readonly scroll: ViewerPosition | null;
      movedBeyondSlop: boolean;
    }
  | { readonly phase: 'settled'; readonly dismiss: boolean };

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
  const [consumedSelectionGeneration, setConsumedSelectionGeneration] = useState<number>();
  const [listActivation, setListActivation] = useState<{ readonly id: string; readonly token: number }>();
  const [peekItemId, setPeekItemId] = useState<string>();
  const peekHeldRef = useRef(false);
  const peekTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [announcement, setAnnouncement] = useState(`Review revision ${props.state.revision}.`);
  const acknowledgedRef = useRef(props.state);
  const commandTailRef = useRef<Promise<ReviewState>>(Promise.resolve(props.state));
  const modalTriggerRef = useRef<HTMLElement>(null);
  const pageNoteTriggerRef = useRef<HTMLButtonElement>(null);
  const draftTriggerRef = useRef<HTMLElement>(null);
  const editTriggerRef = useRef<HTMLButtonElement>(null);
  const surfaceTriggersRef = useRef(new Map<ReviewBaseSurface, HTMLElement>());
  const outsidePointerRef = useRef<OutsidePointerGesture | undefined>(undefined);
  const annotationRequestTokenRef = useRef(0);
  const [annotationRequest, setAnnotationRequest] = useState<AnnotationOpenRequest>({
    kind: 'reading',
    token: 0,
  });
  const listOpen = surface.baseSurface === 'annotations';
  const selectionAnchor = reliableSelection(props.selectionUpdate);
  const selectionActionsAvailable = selectionAnchor !== null
    && props.selectionUpdate.generation !== consumedSelectionGeneration;
  const lastPlacedPageNoteToken = useRef<number | undefined>(undefined);
  const existingAnnotations = props.existingAnnotations ?? { status: 'loading', generation: 0 };
  const trayFraming = useAnnotationTrayFraming({
    listOpen,
    ...(props.viewerFraming === undefined ? {} : { controls: props.viewerFraming }),
    request: annotationRequest,
  });

  useEffect(() => {
    if (props.selectionUpdate.kind !== 'reliable') setConsumedSelectionGeneration(undefined);
  }, [props.selectionUpdate.kind, props.selectionUpdate.generation]);

  const dismissPageNoteAuthority = () => {
    if (props.keyboardPageNoteActive) props.onCancelKeyboardPageNote?.();
    if (props.pageMenu) props.onPageMenuDismiss?.(props.pageMenu.invocationId);
  };
  const clearActiveAnnotation = () => {
    if (activeItemId === undefined) return;
    setActiveItemId(undefined);
    props.onActiveItemChange?.(undefined);
  };
  const transitionBaseSurface = (surfaceName: ReviewBaseSurface) => {
    dismissPageNoteAuthority();
    if (surface.baseSurface === 'annotations' && surfaceName !== 'annotations') {
      clearActiveAnnotation();
    }
    dispatchSurface({ type: 'open-base', surface: surfaceName });
  };

  const clearPeekTimer = () => {
    if (peekTimerRef.current !== undefined) clearTimeout(peekTimerRef.current);
    peekTimerRef.current = undefined;
  };
  useEffect(() => {
    clearPeekTimer();
    if (listOpen) {
      setPeekItemId(undefined);
      return;
    }
    const id = props.correspondingItemId;
    if (id) {
      peekTimerRef.current = setTimeout(() => setPeekItemId(id), 320);
    } else if (!peekHeldRef.current) {
      peekTimerRef.current = setTimeout(() => setPeekItemId(undefined), 180);
    }
    return clearPeekTimer;
  }, [listOpen, props.correspondingItemId]);

  useEffect(() => {
    const request = props.activationRequest;
    if (!request) return;
    setActiveItemId(request.id);
    setListActivation(request);
    props.onActiveItemChange?.(request.id);
    setPeekItemId(undefined);
    const item = props.state.items.find(({ id }) => id === request.id);
    setAnnotationRequest(item
      ? {
          kind: 'mark',
          reviewId: item.id,
          pageIndex: item.pageIndex,
          token: ++annotationRequestTokenRef.current,
        }
      : { kind: 'reading', token: ++annotationRequestTokenRef.current });
    transitionBaseSurface('annotations');
  }, [props.activationRequest?.id, props.activationRequest?.token]);

  const rememberSurfaceTrigger = (surfaceName: ReviewBaseSurface) => {
    if (document.activeElement instanceof HTMLElement) {
      surfaceTriggersRef.current.set(surfaceName, document.activeElement);
    }
  };
  const openBase = (surfaceName: ReviewBaseSurface) => {
    rememberSurfaceTrigger(surfaceName);
    if (surfaceName === 'annotations' && surface.baseSurface !== 'annotations') {
      setAnnotationRequest({ kind: 'reading', token: ++annotationRequestTokenRef.current });
    }
    transitionBaseSurface(surface.baseSurface === surfaceName ? 'reading' : surfaceName);
  };
  const restoreSurfaceTrigger = (surfaceName: ReviewBaseSurface) => {
    const trigger = surfaceTriggersRef.current.get(surfaceName);
    requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
  };

  if (props.state.revision >= acknowledgedRef.current.revision) acknowledgedRef.current = props.state;

  const submit = (
    build: (state: ReviewState) => ReviewCommand,
    options?: { readonly onAccepted?: () => void },
  ): Promise<ReviewState> => {
    const result = commandTailRef.current.then(async () => {
      const command = build(acknowledgedRef.current);
      const result = await props.onCommand(command);
      const accepted = !('accepted' in result);
      const next = accepted ? result : result.state;
      acknowledgedRef.current = next;
      setAnnouncement(accepted ? `Review revision ${next.revision} saved.` : result.message);
      if (accepted) options?.onAccepted?.();
      return next;
    });
    commandTailRef.current = result.catch(() => acknowledgedRef.current);
    return result;
  };
  const consumeSelectionActions = (generation: number) => {
    setConsumedSelectionGeneration(generation);
  };

  const handleInputIntent = (intent: ProofreadInputIntent) => {
    const selectionGeneration = props.selectionUpdate.kind === 'reliable'
      ? props.selectionUpdate.generation
      : undefined;
    if (intent.kind === 'delete') {
      void submit(
        (state) => addDelete(state, intent.anchor),
        selectionGeneration === undefined
          ? undefined
          : { onAccepted: () => consumeSelectionActions(selectionGeneration) },
      );
      return;
    }
    draftTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (intent.kind === 'replaceDraft') {
      if (selectionGeneration === undefined) {
        setAnnouncement('Select reliable text to suggest a replacement.');
        return;
      }
      setTextDraft({
        kind: 'replace',
        anchor: intent.anchor,
        initialText: intent.initialText,
        selectionGeneration,
      });
    } else {
      setTextDraft({ kind: 'insert', anchor: intent.anchor, initialText: intent.initialText });
    }
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
    requestAnimationFrame(() => trigger?.focus());
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
    if (listOpen && !editable && !isAnnotationDrawerOrChrome(event.target)) {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        markFramingUserIntent({ left: true });
      }
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        markFramingUserIntent({ top: true });
      }
    }
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      if (peekItemId !== undefined) {
        event.preventDefault();
        clearPeekTimer();
        peekHeldRef.current = false;
        setPeekItemId(undefined);
        return;
      }
      if (surface.nestedLayer !== 'none') {
        event.preventDefault();
        closeNested();
        return;
      }
      if (
        surface.baseSurface === 'finish' &&
        (event.currentTarget.querySelector('[role="alertdialog"]') !== null ||
          (event.target instanceof Element && event.target.closest('[role="alertdialog"]')) ||
          props.finishConfirmationActive)
      ) {
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
        if (surface.baseSurface === 'annotations') closeAnnotations();
        else closeFinish();
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
    const selectionGeneration = props.selectionUpdate.kind === 'reliable'
      ? props.selectionUpdate.generation
      : undefined;
    if (!anchor || selectionGeneration === undefined) {
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
        consumeSelectionActions(selectionGeneration);
        setComposer({ kind: 'highlight', itemId: addedId });
        dispatchSurface({ type: 'open-nested' });
      }
    });
  };

  const startTextTool = (kind: 'replace' | 'insert') => {
    if (kind === 'replace') {
      if (!selectionAnchor || props.selectionUpdate.kind !== 'reliable') {
        setAnnouncement('Select reliable text to suggest a replacement.');
        return;
      }
      draftTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setTextDraft({
        kind,
        anchor: selectionAnchor,
        initialText: '',
        selectionGeneration: props.selectionUpdate.generation,
      });
    } else {
      if (!props.caretAnchor) {
        setAnnouncement('Choose a reliable text position to suggest an insertion.');
        return;
      }
      draftTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setTextDraft({ kind, anchor: props.caretAnchor, initialText: '' });
    }
    dispatchSurface({ type: 'open-nested' });
  };

  const deleteSelection = () => {
    const selectionGeneration = props.selectionUpdate.kind === 'reliable'
      ? props.selectionUpdate.generation
      : undefined;
    if (!selectionAnchor || selectionGeneration === undefined) {
      setAnnouncement('Select reliable text to suggest deletion.');
      return;
    }
    void submit(
      (state) => addDelete(state, selectionAnchor),
      { onAccepted: () => consumeSelectionActions(selectionGeneration) },
    );
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
  const closeFinish = () => {
    transitionBaseSurface('reading');
    restoreSurfaceTrigger('finish');
  };
  const closeAnnotations = () => {
    transitionBaseSurface('reading');
    restoreSurfaceTrigger('annotations');
  };
  const markFramingUserIntent = trayFraming.markUserIntent;
  const isAnnotationDrawerOrChrome = (target: EventTarget | null) => (
    (target instanceof Node && trayFraming.drawerRef.current?.contains(target) === true)
    || (target instanceof Element && target.closest('[data-review-chrome], [data-review-nested-host]') !== null)
  );

  return (
    <section
      className="review-shell"
      onBeforeInputCapture={beforeInput}
      onKeyDownCapture={keyDown}
      onFocusCapture={(event) => inputController.focusChanged(isEditableTarget(event.target))}
      onCompositionStartCapture={(event) => inputController.compositionStart(event.target)}
      onCompositionEndCapture={compositionEnd}
      onWheelCapture={(event) => {
        if (!listOpen || isAnnotationDrawerOrChrome(event.target)) return;
        markFramingUserIntent({
          left: event.deltaX !== 0 || (event.shiftKey && event.deltaY !== 0),
          top: event.deltaY !== 0 && !event.shiftKey,
        });
      }}
      onPointerDownCapture={(event) => {
        const tracksOutsideDismiss = listOpen
          && event.isPrimary
          && event.button === 0
          && !isAnnotationDrawerOrChrome(event.target);
        outsidePointerRef.current = tracksOutsideDismiss
          ? {
              phase: 'tracking',
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              target: event.target,
              scroll: trayFraming.currentScroll(),
              movedBeyondSlop: false,
            }
          : undefined;
      }}
      onPointerMoveCapture={(event) => {
        const start = outsidePointerRef.current;
        if (start?.phase !== 'tracking' || start.id !== event.pointerId) return;
        const deltaX = event.clientX - start.x;
        const deltaY = event.clientY - start.y;
        if (Math.hypot(deltaX, deltaY) <= OUTSIDE_TAP_SLOP_PX) return;
        start.movedBeyondSlop = true;
      }}
      onPointerUpCapture={(event) => {
        const start = outsidePointerRef.current;
        if (
          !listOpen
          || start?.phase !== 'tracking'
          || start?.id !== event.pointerId
        ) {
          outsidePointerRef.current = undefined;
          return;
        }
        const currentScroll = trayFraming.currentScroll();
        const scrollAxes = start.scroll && currentScroll ? {
          left: Math.abs(currentScroll.left - start.scroll.left) > 1,
          top: Math.abs(currentScroll.top - start.scroll.top) > 1,
        } : { left: false, top: false };
        const scrollChanged = scrollAxes.left || scrollAxes.top;
        const dismiss = !start.movedBeyondSlop
          && !scrollChanged
          && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= OUTSIDE_TAP_SLOP_PX;
        if (!dismiss) {
          if (scrollChanged) markFramingUserIntent(scrollAxes);
          outsidePointerRef.current = { phase: 'settled', dismiss: false };
          return;
        }
        outsidePointerRef.current = undefined;
        dispatchNeutralViewerPointerUp(start.target, event);
        start.target.dispatchEvent(new PointerEvent('pointercancel', {
          bubbles: true,
          composed: true,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          isPrimary: event.isPrimary,
          clientX: event.clientX,
          clientY: event.clientY,
        }));
        outsidePointerRef.current = { phase: 'settled', dismiss: true };
        event.stopPropagation();
        closeAnnotations();
      }}
      onPointerCancelCapture={() => { outsidePointerRef.current = undefined; }}
      onClickCapture={(event) => {
        if (event.target instanceof Element) {
          const markTrigger = event.target.closest<HTMLElement>('[data-owned-focus-id]');
          if (markTrigger) surfaceTriggersRef.current.set('annotations', markTrigger);
        }
        if (
          listOpen
          && event.target instanceof Element
          && event.target.closest('.review-chrome__viewer-controls') !== null
        ) {
          markFramingUserIntent();
        }
        const keyboardMarkActivation = event.detail === 0
          && event.target instanceof Element
          && event.target.closest('[data-owned-focus-id]') !== null;
        if (keyboardMarkActivation) return;
        const pointerGesture = outsidePointerRef.current;
        if (event.detail > 0 && pointerGesture?.phase === 'settled') {
          outsidePointerRef.current = undefined;
          if (pointerGesture.dismiss) event.stopPropagation();
          return;
        }
        if (listOpen && !isAnnotationDrawerOrChrome(event.target)) {
          event.stopPropagation();
          closeAnnotations();
        }
      }}
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
      <div
        ref={trayFraming.stageRef}
        className="review-layout"
        data-review-stage
        data-annotation-presentation={trayFraming.presentation}
        style={{
          '--annotation-side-width': `${trayFraming.sideWidth}px`,
        } as CSSProperties}
      >
        <div className="review-document">{props.children}</div>
        <div className="review-contextual-host" data-review-contextual-host>
          {surface.baseSurface !== 'finish' && selectionActionsAvailable && props.selectionPlacement ? (
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
          {surface.baseSurface === 'reading' && surface.nestedLayer === 'none' && props.pageMenu ? (
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
          {!listOpen && peekItemId ? (() => {
            const item = props.state.items.find(({ id }) => id === peekItemId);
            return item ? (
              <AnnotationPeek
                item={item}
                onHoldChange={(held) => {
                  peekHeldRef.current = held;
                  clearPeekTimer();
                  if (!held && props.correspondingItemId === undefined) {
                    peekTimerRef.current = setTimeout(() => setPeekItemId(undefined), 180);
                  }
                }}
              />
            ) : null;
          })() : null}
        </div>
        <div className="review-drawer-host" data-review-drawer-host>
          <aside
            ref={trayFraming.drawerRef}
            id="review-annotation-list"
            className="review-list"
            data-annotation-drawer
            data-annotation-presentation={trayFraming.presentation}
            data-list-open={listOpen ? 'true' : 'false'}
            aria-label="All annotations"
            aria-hidden={!listOpen}
            inert={!listOpen}
          >
            <AnnotationList
              items={props.state.items}
              {...(activeItemId === undefined ? {} : { activeId: activeItemId })}
              {...(!listOpen || props.correspondingItemId === undefined
                ? {}
                : { correspondingId: props.correspondingItemId })}
              {...(!listOpen || listActivation === undefined ? {} : { activationRequest: listActivation })}
              {...(props.onItemCorrespondenceChange === undefined
                ? {}
                : { onCorrespondenceChange: props.onItemCorrespondenceChange })}
              onNavigate={(item) => {
                markFramingUserIntent();
                setActiveItemId(item.id);
                props.onActiveItemChange?.(item.id);
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
                  props.onActiveItemChange?.(ordered[0]?.id);
                }
              }}
            />
            <section className="existing-annotations" data-existing-annotations-state={existingAnnotations.status} aria-label="Existing PDF annotations">
              <header className="existing-annotations__header">
                <div>
                  <p className="existing-annotations__eyebrow">Source PDF</p>
                  <h2>Existing PDF annotations</h2>
                </div>
                <span className="existing-annotations__readonly">Read only</span>
              </header>
              {existingAnnotations.status === 'loading' ? (
                <p className="annotation-status" data-annotation-status="loading" role="status">
                  <ReviewIcon name="loading" className="review-icon annotation-status__icon" />
                  <span>Existing annotations are loading…</span>
                </p>
              ) : null}
              {existingAnnotations.status === 'empty' ? <p className="annotation-empty" data-annotation-status="empty">No existing annotations.</p> : null}
              {existingAnnotations.status === 'error' ? (
                <div className="annotation-status annotation-status--error" data-annotation-status="error" role="alert">
                  <ReviewIcon name="alert" className="review-icon annotation-status__icon" />
                  <p><strong>Existing annotations unavailable.</strong><span>{existingAnnotations.message}</span></p>
                  <button type="button" onClick={props.onRetryExistingAnnotations}>Retry</button>
                </div>
              ) : null}
              {existingAnnotations.status === 'ready' ? (
                <ol className="existing-annotations__list">
                  {existingAnnotations.items.map((annotation) => (
                    <li
                      key={`${annotation.pageIndex}:${annotation.id}`}
                      data-existing-annotation={annotation.id}
                      data-annotation-origin="source"
                      data-annotation-kind={annotation.subtype}
                      data-annotation-state="readonly"
                      data-readonly="true"
                    >
                      <button className="existing-annotation__content" type="button" aria-label={`${annotation.subtype} · Page ${annotation.pageIndex + 1}${annotation.contents ? ` · ${annotation.contents}` : ''}`} onClick={() => { markFramingUserIntent(); props.onNavigateExisting?.(annotation); }}>
                        <span className="annotation-item__meta"><strong>{annotation.subtype}</strong><span className="annotation-item__page">Page {annotation.pageIndex + 1}</span></span>
                        {annotation.contents ? <span className="annotation-item__excerpt">{annotation.contents}</span> : null}
                      </button>
                    </li>
                  ))}
                </ol>
              ) : null}
            </section>
          </aside>
          <FinishReviewDrawer
            state={props.state}
            open={surface.baseSurface === 'finish'}
            onClose={closeFinish}
            onFinish={props.onFinishReview ?? (() => undefined)}
            onDiscard={props.onDiscardReview ?? (() => undefined)}
          >
            {props.finishSlot}
          </FinishReviewDrawer>
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
              await submit(
                (state) => frozen.kind === 'replace'
                  ? addReplace(state, frozen.anchor, value)
                  : addInsert(state, frozen.anchor, value),
                frozen.kind === 'replace'
                  ? { onAccepted: () => consumeSelectionActions(frozen.selectionGeneration) }
                  : undefined,
              );
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
