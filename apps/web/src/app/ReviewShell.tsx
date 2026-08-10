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
import type { ViewerPdfLinkInvocation } from '../pdf/viewer-interaction-events.js';
import type { PdfOutlineDiscovery, PdfOutlineItem } from '../pdf/pdf-outline.js';
import { AnnotationList } from '../review/AnnotationList.js';
import { AnnotationPeek } from '../review/AnnotationPeek.js';
import { CommentComposer } from '../review/CommentComposer.js';
import { ContextActionPalette, type ContextPlacement } from '../review/ContextActionPalette.js';
import { PageActionMenu } from '../review/PageActionMenu.js';
import { LinkActionPopover, type LinkActionChoice, type LinkActionDismissReason } from '../review/LinkActionPopover.js';
import {
  ReferenceWorkspace,
  type PendingReferencePanel,
  type ReferenceWorkspaceTab,
} from '../review/ReferenceWorkspace.js';
import { ReviewChrome } from '../review/ReviewChrome.js';
import { ReviewIcon } from '../review/ReviewIcon.js';
import { OutlineAnnotationsWorkspace } from '../review/OutlineAnnotationsWorkspace.js';
import { ReferenceResizeHandle } from '../review/ReferenceResizeHandle.js';
import { WorkspaceEdgeRail } from '../review/WorkspaceEdgeRail.js';
import {
  BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN,
  MIN_BOTTOM_REFERENCE_HEIGHT,
  MIN_RIGHT_REFERENCE_WIDTH,
  RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN,
  clampBottomReferenceHeight,
  clampRightReferenceWidth,
  createReferenceWorkspaceLayout,
  deriveReferenceWorkspaceLayout,
  reduceReferenceWorkspaceLayout,
  type ReferenceWorkspaceLayoutAction,
  type ReferenceWorkspaceLayoutState,
  type RightWorkspaceMode,
} from '../review/reference-workspace-layout.js';
import { FinishReviewDrawer } from './FinishReviewDrawer.js';
import {
  createProofreadInputController,
  isEditableTarget,
  type ProofreadInputIntent,
} from '../review/input-controller.js';
import { reviewActionForKey } from '../review/review-actions.js';
import {
  useWorkspaceFraming,
  type WorkspaceOpenRequest,
} from '../review/use-annotation-tray-framing.js';
import {
  INITIAL_REVIEW_SURFACE_STATE,
  reduceReviewSurface,
  type ReviewBaseSurface,
  type ReviewSurfaceAction,
} from '../review/review-surface-state.js';
import type {
  ReferenceNavigationState,
  WorkspaceMode,
} from '../review/reference-navigation-state.js';
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

function ignoreReferenceViewportHost(_element: HTMLDivElement | null): void {}

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
  onSelectionConsumed?(generation: number): void;
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
  /** The production shell may control workspace visibility and retained navigation state. */
  workspaceOpen?: boolean;
  navigationState?: ReferenceNavigationState;
  referenceTabs?: readonly ReferenceWorkspaceTab[];
  pendingReference?: PendingReferencePanel | null;
  outlineDiscovery?: PdfOutlineDiscovery;
  currentOutlineItemId?: string | null;
  linkActionRequest?: ViewerPdfLinkInvocation | null;
  navigationAnnouncement?: string;
  canNavigateBack?: boolean;
  canNavigateForward?: boolean;
  onLinkActionChoose?(choice: LinkActionChoice, request: ViewerPdfLinkInvocation): void;
  onLinkActionDismiss?(request: ViewerPdfLinkInvocation, reason: LinkActionDismissReason): void;
  onNavigateBack?(): void;
  onNavigateForward?(): void;
  onWorkspaceModeChange?(mode: WorkspaceMode): void;
  onWorkspaceDismiss?(): void;
  onReferenceTabActivate?(identity: string): void;
  onReferenceTabClose?(identity: string): void;
  onReferenceSendToMain?(identity: string): void;
  onReferenceRetry?(): void;
  onOutlineActivate?(item: PdfOutlineItem): void;
  onReferenceViewportHost?(element: HTMLDivElement | null): void;
  onWorkspaceModeFocusTokenChange?(mode: WorkspaceMode, token: string): void;
  referenceLayoutState?: ReferenceWorkspaceLayoutState;
  onReferenceLayoutAction?(action: ReferenceWorkspaceLayoutAction): void;
  rightWorkspaceMode?: RightWorkspaceMode;
  children?: ReactNode;
}

export interface RejectedReviewCommand {
  readonly accepted: false;
  readonly state: ReviewState;
  readonly message: string;
}

export function controlledWorkspaceSurfaceAction(input: {
  readonly open: boolean;
  readonly baseSurface: ReviewBaseSurface;
  readonly transientSurface: 'none' | 'selection-actions' | 'insert-action' | 'page-menu' | 'page-note-cursor';
  readonly mode: WorkspaceMode;
}): ReviewSurfaceAction | null {
  if (input.baseSurface === 'finish') return null;
  if (input.open) {
    return input.baseSurface !== 'workspace' || input.transientSurface !== 'none'
      ? { type: 'open-workspace', mode: input.mode }
      : null;
  }
  return input.baseSurface === 'workspace'
    ? { type: 'hide-workspace', focusReturnToken: BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN }
    : null;
}

export function workspaceIsVisible(requestedOpen: boolean, baseSurface: ReviewBaseSurface): boolean {
  return requestedOpen && baseSurface !== 'finish';
}

interface PointerScrollGesture {
  readonly id: number;
  readonly scroll: ViewerPosition | null;
}

function mutableField(item: ReviewItem): 'proposedText' | 'comment' | undefined {
  if (item.kind === 'replace' || item.kind === 'insert') return 'proposedText';
  if (item.kind === 'highlight' || item.kind === 'pageNote') return 'comment';
  return undefined;
}

export function ReviewShell(props: ReviewShellProps) {
  const [localReferenceLayout, dispatchLocalReferenceLayout] = useReducer(
    reduceReferenceWorkspaceLayout,
    undefined,
    () => {
      let initial = createReferenceWorkspaceLayout({ width: 1440, height: 900 });
      if (props.workspaceOpen === true || props.listOpen === true) {
        const initialMode = props.listOpen === true
          ? 'annotations'
          : props.navigationState?.workspace.lastMode ?? 'outline';
        initial = reduceReferenceWorkspaceLayout(initial, initialMode === 'references'
          ? { type: 'show-references' }
          : { type: 'show-right-workspace' });
      }
      return initial;
    },
  );
  const [surface, dispatchSurface] = useReducer(
    reduceReviewSurface,
    props.workspaceOpen === true
      ? reduceReviewSurface(INITIAL_REVIEW_SURFACE_STATE, {
          type: 'open-workspace',
          mode: props.navigationState?.workspace.lastMode ?? 'outline',
        })
      : props.listOpen === true
      ? reduceReviewSurface(INITIAL_REVIEW_SURFACE_STATE, {
          type: 'open-workspace',
          mode: 'annotations',
        })
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
  const rightWorkspaceRailRef = useRef<HTMLButtonElement>(null);
  const bottomWorkspaceRailRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const pointerScrollRef = useRef<PointerScrollGesture | undefined>(undefined);
  const annotationRequestTokenRef = useRef(0);
  const [workspaceRequest, setWorkspaceRequest] = useState<WorkspaceOpenRequest>({
    kind: 'reading',
    token: 0,
  });
  const navigation = props.navigationState ?? surface.navigation;
  const workspaceRequestedOpen = props.workspaceOpen ?? surface.baseSurface === 'workspace';
  const workspaceOpen = workspaceIsVisible(workspaceRequestedOpen, surface.baseSurface);
  const workspaceMode = navigation.workspace.lastMode;
  const rightWorkspaceMode: RightWorkspaceMode = props.rightWorkspaceMode
    ?? (workspaceMode === 'references' ? 'outline' : workspaceMode);
  const referenceLayout = props.referenceLayoutState ?? localReferenceLayout;
  const referenceLayoutControlled = props.referenceLayoutState !== undefined;
  const effectiveReferenceLayout = deriveReferenceWorkspaceLayout(
    referenceLayout,
    rightWorkspaceMode,
    workspaceMode,
  );
  const dispatchReferenceLayout = (action: ReferenceWorkspaceLayoutAction) => {
    if (props.referenceLayoutState === undefined) dispatchLocalReferenceLayout(action);
    props.onReferenceLayoutAction?.(action);
  };
  const finishOpen = surface.baseSurface === 'finish';
  const referenceSurfaceOpen = !finishOpen && (effectiveReferenceLayout.kind === 'narrow-unified'
    ? effectiveReferenceLayout.open
    : effectiveReferenceLayout.referenceDock === 'right'
      ? effectiveReferenceLayout.rightWorkspaceOpen
      : effectiveReferenceLayout.bottomReferencesOpen);
  const rightSurfaceOpen = !finishOpen && effectiveReferenceLayout.kind !== 'narrow-unified'
    && effectiveReferenceLayout.rightWorkspaceOpen;
  const sharedWorkspace = effectiveReferenceLayout.kind === 'narrow-unified'
    || effectiveReferenceLayout.referenceDock === 'right';
  const toolsSurfaceOpen = !finishOpen && (effectiveReferenceLayout.kind === 'narrow-unified'
    ? effectiveReferenceLayout.open
    : effectiveReferenceLayout.referenceDock === 'bottom'
      ? rightSurfaceOpen
      : referenceSurfaceOpen);
  const effectiveWorkspaceMode = effectiveReferenceLayout.kind === 'narrow-unified'
    ? effectiveReferenceLayout.activeMode
    : effectiveReferenceLayout.referenceDock === 'bottom' ? rightWorkspaceMode : workspaceMode;
  const anyWorkspaceOpen = workspaceOpen || referenceSurfaceOpen || toolsSurfaceOpen;
  const annotationsVisible = anyWorkspaceOpen && effectiveWorkspaceMode === 'annotations';
  const selectionAnchor = reliableSelection(props.selectionUpdate);
  const selectionActionsAvailable = selectionAnchor !== null
    && props.selectionUpdate.generation !== consumedSelectionGeneration;
  const lastPlacedPageNoteToken = useRef<number | undefined>(undefined);
  const existingAnnotations = props.existingAnnotations ?? { status: 'loading', generation: 0 };
  const referenceTabs = props.referenceTabs ?? navigation.tabs.map((tab) => ({
    identity: tab.identity,
    label: `Page ${tab.originalTarget.pageIndex + 1}`,
    pageContext: `Page ${tab.originalTarget.pageIndex + 1}`,
  }));
  const outlineDiscovery = props.outlineDiscovery ?? {
    status: 'loading' as const,
    documentGeneration: navigation.documentGeneration,
  };
  const workspaceFraming = useWorkspaceFraming({
    workspaceOpen: anyWorkspaceOpen,
    ...(props.viewerFraming === undefined ? {} : { controls: props.viewerFraming }),
    request: workspaceRequest,
    documentGeneration: navigation.documentGeneration,
    layoutGeneration: [
      effectiveReferenceLayout.kind,
      referenceSurfaceOpen,
      toolsSurfaceOpen,
      referenceLayout.referenceDock,
      referenceLayout.rightReferenceWidth,
      referenceLayout.bottomReferenceHeight,
    ].join(':'),
  });

  useLayoutEffect(() => {
    const stage = workspaceFraming.stageRef.current;
    if (!stage) return;
    const publish = () => {
      const bounds = stage.getBoundingClientRect();
      const action: ReferenceWorkspaceLayoutAction = {
        type: 'set-stage-size',
        width: Math.max(0, bounds.width),
        height: Math.max(0, bounds.height),
      };
      if (!referenceLayoutControlled) dispatchLocalReferenceLayout(action);
      props.onReferenceLayoutAction?.(action);
    };
    publish();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(publish);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [props.onReferenceLayoutAction, referenceLayoutControlled, workspaceFraming.stageRef]);

  useLayoutEffect(() => {
    dispatchReferenceLayout({
      type: 'set-regime',
      regime: workspaceFraming.presentation === 'right' ? 'wide' : 'narrow',
    });
  }, [workspaceFraming.presentation]);

  useLayoutEffect(() => {
    if (props.workspaceOpen === undefined) return;
    const action = controlledWorkspaceSurfaceAction({
      open: props.workspaceOpen,
      baseSurface: surface.baseSurface,
      transientSurface: surface.transientSurface,
      mode: workspaceMode,
    });
    if (action !== null) dispatchSurface(action);
  }, [props.workspaceOpen, surface.baseSurface, surface.transientSurface, workspaceMode]);

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
    if (surface.baseSurface === 'workspace' && surfaceName === 'finish') {
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
    if (anyWorkspaceOpen) {
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
  }, [anyWorkspaceOpen, props.correspondingItemId]);

  useEffect(() => {
    const request = props.activationRequest;
    if (!request) return;
    setActiveItemId(request.id);
    setListActivation(request);
    props.onActiveItemChange?.(request.id);
    setPeekItemId(undefined);
    const item = props.state.items.find(({ id }) => id === request.id);
    setWorkspaceRequest(item
      ? {
          kind: 'mark',
          reviewId: item.id,
          pageIndex: item.pageIndex,
          token: ++annotationRequestTokenRef.current,
        }
      : { kind: 'reading', token: ++annotationRequestTokenRef.current });
    dismissPageNoteAuthority();
    dispatchSurface({ type: 'open-workspace', mode: 'annotations' });
    dispatchReferenceLayout({ type: 'show-right-workspace' });
    dispatchReferenceLayout({ type: 'focus-surface', surface: 'right' });
    props.onWorkspaceModeChange?.('annotations');
  }, [props.activationRequest?.id, props.activationRequest?.token]);

  const rememberSurfaceTrigger = (surfaceName: ReviewBaseSurface) => {
    if (document.activeElement instanceof HTMLElement) {
      surfaceTriggersRef.current.set(surfaceName, document.activeElement);
    }
  };
  const openBase = (surfaceName: ReviewBaseSurface) => {
    rememberSurfaceTrigger(surfaceName);
    transitionBaseSurface(surface.baseSurface === surfaceName ? 'reading' : surfaceName);
  };
  const selectWorkspaceMode = (mode: WorkspaceMode) => {
    if (mode === 'annotations' && (!workspaceOpen || workspaceMode !== 'annotations')) {
      setWorkspaceRequest({ kind: 'reading', token: ++annotationRequestTokenRef.current });
    }
    dispatchSurface({
      type: 'reference-navigation',
      action: { type: 'select-workspace-mode', mode },
    });
    dispatchReferenceLayout({
      type: 'focus-surface',
      surface: mode === 'references' ? 'references' : 'right',
    });
    props.onWorkspaceModeChange?.(mode);
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
    props.onSelectionConsumed?.(generation);
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
    if (
      props.linkActionRequest
      && event.target instanceof Element
      && event.target.closest('[data-link-action-popover]') !== null
    ) return;
    const editable = isEditableTarget(event.target);
    if (workspaceOpen && !editable && !isWorkspaceOrChrome(event.target)) {
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
      if (anyWorkspaceOpen || surface.baseSurface !== 'reading') {
        event.preventDefault();
        if (anyWorkspaceOpen) closeWorkspace();
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
  const closeWorkspace = () => {
    dismissPageNoteAuthority();
    const closingReferences = effectiveWorkspaceMode === 'references';
    const bottomRail = effectiveReferenceLayout.kind === 'narrow-unified'
      || (closingReferences && effectiveReferenceLayout.referenceDock === 'bottom');
    const focusReturnToken = bottomRail
      ? BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN
      : RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN;
    dispatchSurface({ type: 'hide-workspace', focusReturnToken });
    dispatchReferenceLayout(effectiveReferenceLayout.kind === 'narrow-unified'
      ? { type: 'toggle-narrow-workspace' }
      : closingReferences
        ? { type: 'hide-references' }
        : { type: 'hide-right-workspace' });
    if (closingReferences) props.onWorkspaceDismiss?.();
    requestAnimationFrame(() => (bottomRail ? bottomWorkspaceRailRef : rightWorkspaceRailRef)
      .current?.focus({ preventScroll: true }));
  };
  const focusWorkspaceModeAfterLayout = (mode: WorkspaceMode) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const shell = shellRef.current;
      const target = mode === 'references'
        ? shell?.querySelector<HTMLElement>('[data-reference-tab][aria-selected="true"]')
          ?? shell?.querySelector<HTMLElement>('[data-reference-empty]')
        : shell?.querySelector<HTMLElement>(`#workspace-panel-${mode}`);
      target?.focus({ preventScroll: true });
    }));
  };
  const markFramingUserIntent = workspaceFraming.markUserIntent;
  const isWorkspaceOrChrome = (target: EventTarget | null) => (
    (target instanceof Node && (
      workspaceFraming.referenceSurfaceRef.current?.contains(target) === true
      || workspaceFraming.toolsSurfaceRef.current?.contains(target) === true
    ))
    || (target instanceof Element && target.closest(
      '[data-review-chrome], [data-review-nested-host], [data-link-action-popover]',
    ) !== null)
  );
  return (
    <section
      className="review-shell"
      onBeforeInputCapture={beforeInput}
      onKeyDownCapture={keyDown}
      onFocusCapture={(event) => inputController.focusChanged(isEditableTarget(event.target))}
      onCompositionStartCapture={(event) => inputController.compositionStart(event.target)}
      onCompositionEndCapture={compositionEnd}
      ref={shellRef}
      onWheelCapture={(event) => {
        if (!workspaceOpen || isWorkspaceOrChrome(event.target)) return;
        markFramingUserIntent({
          left: event.deltaX !== 0 || (event.shiftKey && event.deltaY !== 0),
          top: event.deltaY !== 0 && !event.shiftKey,
        });
      }}
      onPointerDownCapture={(event) => {
        if (!workspaceOpen || isWorkspaceOrChrome(event.target)) {
          pointerScrollRef.current = undefined;
          return;
        }
        if (!event.isPrimary || event.button !== 0) return;
        pointerScrollRef.current = {
          id: event.pointerId,
          scroll: workspaceFraming.currentScroll(),
        };
      }}
      onPointerUpCapture={(event) => {
        const start = pointerScrollRef.current;
        if (!workspaceOpen || !start || start.id !== event.pointerId) return;
        pointerScrollRef.current = undefined;
        const current = workspaceFraming.currentScroll();
        if (!start.scroll || !current) return;
        markFramingUserIntent({
          left: Math.abs(current.left - start.scroll.left) > 1,
          top: Math.abs(current.top - start.scroll.top) > 1,
        });
      }}
      onPointerCancelCapture={(event) => {
        if (pointerScrollRef.current?.id === event.pointerId) pointerScrollRef.current = undefined;
      }}
      onClickCapture={(event) => {
        if (props.linkActionRequest) return;
        if (event.target instanceof Element) {
          const markTrigger = event.target.closest<HTMLElement>('[data-owned-focus-id]');
          if (markTrigger) surfaceTriggersRef.current.set('workspace', markTrigger);
        }
        if (
          workspaceOpen
          && event.target instanceof Element
          && event.target.closest('.review-chrome__viewer-controls') !== null
        ) {
          markFramingUserIntent();
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
        canNavigateBack={props.canNavigateBack ?? false}
        canNavigateForward={props.canNavigateForward ?? false}
        finishOpen={finishOpen}
        onUndo={() => void submit(undoReview)}
        onRedo={() => void submit(redoReview)}
        onNavigateBack={() => props.onNavigateBack?.()}
        onNavigateForward={() => props.onNavigateForward?.()}
        onFinish={() => openBase('finish')}
      />
      <div
        ref={workspaceFraming.stageRef}
        className="review-layout"
        data-review-stage
        data-reference-layout={effectiveReferenceLayout.kind}
        data-workspace-presentation={workspaceFraming.presentation}
        data-annotation-presentation={workspaceFraming.presentation}
        style={{
          '--workspace-side-width': `${workspaceFraming.sideWidth}px`,
          '--reference-right-width': `${effectiveReferenceLayout.kind === 'narrow-unified'
            ? referenceLayout.rightReferenceWidth : effectiveReferenceLayout.rightWidth}px`,
          '--reference-bottom-height': `${effectiveReferenceLayout.kind === 'narrow-unified'
            ? effectiveReferenceLayout.bottomHeight : referenceLayout.bottomReferenceHeight}px`,
          '--tools-right-width': `${effectiveReferenceLayout.kind === 'narrow-unified'
            ? referenceLayout.rightReferenceWidth : effectiveReferenceLayout.rightWidth}px`,
          '--tools-bottom-offset': `${effectiveReferenceLayout.kind === 'wide-split'
            ? effectiveReferenceLayout.bottomHeight : 0}px`,
          '--tools-bottom-height': `${effectiveReferenceLayout.kind === 'narrow-unified'
            ? effectiveReferenceLayout.bottomHeight : referenceLayout.bottomReferenceHeight}px`,
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
          {!workspaceOpen && peekItemId ? (() => {
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
          {finishOpen ? null : effectiveReferenceLayout.kind === 'narrow-unified' ? (
            <WorkspaceEdgeRail
              buttonRef={bottomWorkspaceRailRef}
              surface="bottom"
              open={referenceSurfaceOpen}
              controls="review-workspace"
              onToggle={() => {
                dismissPageNoteAuthority();
                const opening = !effectiveReferenceLayout.open;
                dispatchReferenceLayout({ type: 'toggle-narrow-workspace' });
                if (opening) focusWorkspaceModeAfterLayout(effectiveWorkspaceMode);
              }}
            />
          ) : (
            <>
              <WorkspaceEdgeRail
                buttonRef={rightWorkspaceRailRef}
                surface="right"
                open={rightSurfaceOpen}
                controls="review-tools-workspace"
                onToggle={() => {
                  dismissPageNoteAuthority();
                  const opening = !rightSurfaceOpen;
                  dispatchReferenceLayout({ type: 'toggle-right-workspace' });
                  if (opening) focusWorkspaceModeAfterLayout(effectiveWorkspaceMode);
                }}
              />
              <WorkspaceEdgeRail
                buttonRef={bottomWorkspaceRailRef}
                surface="bottom"
                open={effectiveReferenceLayout.bottomReferencesOpen}
                controls="review-workspace"
                onToggle={() => {
                  dismissPageNoteAuthority();
                  const opening = !effectiveReferenceLayout.bottomReferencesOpen;
                  dispatchReferenceLayout({ type: 'toggle-references' });
                  if (opening) focusWorkspaceModeAfterLayout('references');
                }}
              />
            </>
          )}
          <ReferenceWorkspace
            workspaceRef={workspaceFraming.referenceSurfaceRef}
            open={referenceSurfaceOpen}
            mode={effectiveReferenceLayout.kind === 'narrow-unified'
              ? effectiveReferenceLayout.activeMode
              : effectiveReferenceLayout.referenceDock === 'bottom' ? 'references' : workspaceMode}
            presentation={effectiveReferenceLayout.kind === 'narrow-unified'
              || effectiveReferenceLayout.referenceDock === 'bottom'
              ? 'bottom' : 'right'}
            modes={effectiveReferenceLayout.kind === 'narrow-unified'
              || effectiveReferenceLayout.referenceDock === 'right'
              ? ['outline', 'annotations', 'references'] : ['references']}
            headerVariant={effectiveReferenceLayout.kind !== 'narrow-unified'
              && effectiveReferenceLayout.referenceDock === 'bottom' ? 'references' : 'tabs'}
            onMoveReferencesRight={() => {
              dispatchReferenceLayout({ type: 'move-references-right' });
              selectWorkspaceMode('references');
              focusWorkspaceModeAfterLayout('references');
            }}
            onMoveReferencesBottom={() => {
              dispatchReferenceLayout({ type: 'move-references-bottom' });
              selectWorkspaceMode('references');
              focusWorkspaceModeAfterLayout('references');
            }}
            tabs={referenceTabs}
            activeTabIdentity={navigation.activeTabIdentity}
            outline={outlineDiscovery}
            {...(props.pendingReference === undefined ? {} : { pendingReference: props.pendingReference })}
            {...(props.currentOutlineItemId === undefined
              ? {}
              : { currentOutlineItemId: props.currentOutlineItemId })}
            announcement={props.navigationAnnouncement ?? announcement}
            onModeChange={selectWorkspaceMode}
            onReferenceTabActivate={(identity) => props.onReferenceTabActivate?.(identity)}
            onReferenceTabClose={(identity) => {
              props.onReferenceTabClose?.(identity);
              if (props.navigationState === undefined) {
                dispatchSurface({
                  type: 'reference-navigation',
                  action: {
                    type: 'close-reference',
                    targetIdentity: identity,
                    focusReturnToken: effectiveReferenceLayout.kind === 'narrow-unified'
                      || effectiveReferenceLayout.referenceDock === 'bottom'
                      ? BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN
                      : RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN,
                  },
                });
              }
            }}
            onSendToMain={(identity) => props.onReferenceSendToMain?.(identity)}
            onRetryReference={() => props.onReferenceRetry?.()}
            onOutlineActivate={(item) => props.onOutlineActivate?.(item)}
            onDismiss={closeWorkspace}
            onReferenceViewportHost={props.onReferenceViewportHost ?? ignoreReferenceViewportHost}
            onModeFocusTokenChange={(mode, token) => {
              if (props.navigationState === undefined) {
                dispatchSurface({
                  type: 'reference-navigation',
                  action: {
                    type: 'remember-workspace-view',
                    mode,
                    logicalScrollToken: surface.navigation.workspace.modes[mode].logicalScrollToken,
                    logicalFocusToken: token,
                  },
                });
              }
              props.onWorkspaceModeFocusTokenChange?.(mode, token);
            }}
            annotations={null}
          />
          <OutlineAnnotationsWorkspace
            workspaceRef={workspaceFraming.toolsSurfaceRef}
            open={toolsSurfaceOpen}
            mode={effectiveWorkspaceMode}
            presentation={effectiveReferenceLayout.kind === 'narrow-unified' ? 'bottom' : 'right'}
            headerVariant={sharedWorkspace ? 'shared' : 'tools'}
            outline={outlineDiscovery}
            currentOutlineItemId={props.currentOutlineItemId ?? null}
            onModeChange={selectWorkspaceMode}
            onOutlineActivate={(item) => props.onOutlineActivate?.(item)}
            onModeFocusTokenChange={(mode, token) => {
              if (props.navigationState === undefined) {
                dispatchSurface({
                  type: 'reference-navigation',
                  action: {
                    type: 'remember-workspace-view',
                    mode,
                    logicalScrollToken: surface.navigation.workspace.modes[mode].logicalScrollToken,
                    logicalFocusToken: token,
                  },
                });
              }
              props.onWorkspaceModeFocusTokenChange?.(mode, token);
            }}
            annotations={<div id="review-annotation-list" aria-label="All annotations">
            <AnnotationList
              items={props.state.items}
              {...(activeItemId === undefined ? {} : { activeId: activeItemId })}
              {...(!annotationsVisible || props.correspondingItemId === undefined
                ? {}
                : { correspondingId: props.correspondingItemId })}
              {...(!annotationsVisible || listActivation === undefined ? {} : { activationRequest: listActivation })}
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
            </div>}
          />
          {referenceSurfaceOpen && effectiveReferenceLayout.referenceResizable ? (
            <ReferenceResizeHandle
              dock={effectiveReferenceLayout.kind !== 'narrow-unified'
                ? effectiveReferenceLayout.referenceDock : 'bottom'}
              controls="workspace-panel-references"
              value={effectiveReferenceLayout.kind !== 'narrow-unified'
                && effectiveReferenceLayout.referenceDock === 'right'
                ? referenceLayout.rightReferenceWidth : referenceLayout.bottomReferenceHeight}
              min={effectiveReferenceLayout.kind !== 'narrow-unified'
                && effectiveReferenceLayout.referenceDock === 'right'
                ? MIN_RIGHT_REFERENCE_WIDTH : MIN_BOTTOM_REFERENCE_HEIGHT}
              max={effectiveReferenceLayout.kind !== 'narrow-unified'
                && effectiveReferenceLayout.referenceDock === 'right'
                ? clampRightReferenceWidth(Number.MAX_SAFE_INTEGER, referenceLayout.stageWidth)
                : clampBottomReferenceHeight(Number.MAX_SAFE_INTEGER, referenceLayout.stageHeight)}
              onChange={(size) => dispatchReferenceLayout(effectiveReferenceLayout.kind !== 'narrow-unified'
                && effectiveReferenceLayout.referenceDock === 'right'
                ? { type: 'resize-right-references', size }
                : { type: 'resize-bottom-references', size })}
              onCommit={workspaceFraming.requestSettledReframe}
            />
          ) : null}
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
      <LinkActionPopover
        request={props.linkActionRequest ?? null}
        onChoose={(choice, request) => props.onLinkActionChoose?.(choice, request)}
        onDismiss={(request, reason) => props.onLinkActionDismiss?.(request, reason)}
        sourceFocusFallback={(source) => {
          const shell = shellRef.current;
          if (!shell) return null;
          if (source === 'reference') {
            const activeTab = navigation.activeTabIdentity;
            const activeTabElement = activeTab
              ? [...shell.querySelectorAll<HTMLElement>('[data-reference-tab]')]
                .find((element) => element.dataset.referenceTab === activeTab)
              : null;
            return activeTabElement
              ?? shell.querySelector<HTMLElement>('[data-reference-pdf-viewport] [data-page-index]');
          }
          return shell.querySelector<HTMLElement>(
            `.pdf-workspace:not(.pdf-workspace--reference) [data-page-index="${props.linkActionRequest?.sourcePageIndex ?? 0}"]`,
          ) ?? shell.querySelector<HTMLElement>('.pdf-workspace:not(.pdf-workspace--reference) [data-page-index]');
        }}
      />
    </section>
  );
}
