import { useId, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';

import {
  VIEWER_ZOOM_MAX_PERCENT,
  VIEWER_ZOOM_MIN_PERCENT,
  type ViewerControls,
  type ViewerControlsSnapshot,
} from '../pdf/viewer-controls.js';
import type { PdfFitMode, PdfFitState } from '../pdf/viewer-navigation.js';
import { ReviewIcon } from './ReviewIcon.js';
import { ReviewTooltipButton } from './ReviewTooltipButton.js';
import type { LiveContextBindingStatus } from '../../../../packages/core/src/live-context.js';
import { CodexContextStatus } from './CodexContextStatus.js';
import { CopyLinkControl, type CopyLinkControlProps } from './CopyLinkControl.js';
import {
  DocumentActionsMenu,
  documentIdentityLabel,
  type DocumentActionsMenuProps,
} from './DocumentActionsMenu.js';
import { TopBarMenu } from './TopBarMenu.js';
import {
  REVIEW_CHROME_PRESENTATIONS,
  chooseReviewChromePresentation,
  type ReviewChromePresentation,
  type ReviewChromePresentationWidths,
} from './review-chrome-layout.js';

export function validPageNumber(draft: string, totalPages: number): number | undefined {
  const normalized = draft.trim();
  if (!/^[+-]?\d+$/u.test(normalized)) return undefined;
  const pageNumber = Number(normalized);
  if (!Number.isSafeInteger(pageNumber)) return undefined;
  return Math.min(Math.max(pageNumber, 1), totalPages);
}

export function validZoomPercent(draft: string): number | undefined {
  const normalized = draft.trim();
  if (!/^[+-]?\d+$/u.test(normalized)) return undefined;
  const zoomPercent = Number(normalized);
  if (!Number.isSafeInteger(zoomPercent)) return undefined;
  return Math.min(
    Math.max(zoomPercent, VIEWER_ZOOM_MIN_PERCENT),
    VIEWER_ZOOM_MAX_PERCENT,
  );
}

export type ResolvedZoomDraft =
  | { readonly valid: false }
  | { readonly valid: true; readonly request?: number };

export function resolveZoomDraft(draft: string, publishedZoomPercent: number): ResolvedZoomDraft {
  const zoomPercent = validZoomPercent(draft);
  if (zoomPercent === undefined) return { valid: false };
  return zoomPercent === publishedZoomPercent
    ? { valid: true }
    : { valid: true, request: zoomPercent };
}

export function zoomEditorKeyAction(
  key: string,
  isComposing: boolean,
): 'submit' | 'cancel' | undefined {
  if (isComposing) return undefined;
  if (key === 'Enter') return 'submit';
  if (key === 'Escape') return 'cancel';
  return undefined;
}

export type TopBarMenuId = 'document' | 'navigation' | 'zoom' | 'history';

const FIT_MODES: readonly PdfFitMode[] = ['page', 'width', 'text'];
const FIT_LABELS: Record<PdfFitMode, string> = { page: 'Fit page', width: 'Fit width', text: 'Fit text' };
const FIT_ICONS = { page: 'fit-page', width: 'fit-width', text: 'fit-text' } as const;

export function resolveTopBarMenuRequest(input: {
  readonly activeMenu: TopBarMenuId | null;
  readonly requestedMenu: TopBarMenuId;
  readonly requestedOpen: boolean;
  readonly documentMenuPending: boolean;
}): TopBarMenuId | null {
  if (input.documentMenuPending) return 'document';
  if (input.requestedOpen) return input.requestedMenu;
  return input.activeMenu === input.requestedMenu ? null : input.activeMenu;
}

/** Fits the page input to its digits (about 0.6em each) plus its 6px left padding. */
export function pageInputWidth(value: string): string {
  return `calc(${Math.max(1, value.length) * 0.62}em + 6px)`;
}

/** Fits the zoom input to its digits; its 6px lead sits on the zoom value. */
export function zoomInputWidth(value: string): string {
  return `${Math.max(1, value.length) * 0.62}em`;
}

export interface ReviewChromeProps {
  readonly documentTitle: string;
  /** The PDF's own title when it has one; shown in place of the filename. */
  readonly displayTitle?: string;
  readonly savedLabel?: string;
  readonly showSaveStatusDot?: boolean;
  readonly savePhase?: 'clean' | 'saving' | 'not-saved';
  readonly savePendingDestination?: boolean;
  readonly saveOptionsOpen?: boolean;
  readonly documentActions?: Omit<
    DocumentActionsMenuProps,
    | 'documentTitle'
    | 'displayTitle'
    | 'savedLabel'
    | 'savePhase'
    | 'open'
    | 'onOpenChange'
    | 'onPendingChange'
  >;
  readonly controls?: ViewerControls;
  readonly viewerState: ViewerControlsSnapshot;
  readonly fitWidthReady?: boolean;
  readonly onFitWidth?: () => void | Promise<void>;
  readonly fitState?: PdfFitState;
  readonly onFitMode?: (mode: PdfFitMode) => void | Promise<void>;
  readonly onManualZoom?: () => void;
  readonly horizontalScrollLocked?: boolean;
  readonly horizontalScrollAvailable?: boolean;
  readonly fitWidthCurrent?: boolean;
  readonly onToggleHorizontalScrollLock?: () => void;
  readonly beforeViewerAction?: () => Promise<void>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly canNavigateBack?: boolean;
  readonly canNavigateForward?: boolean;
  readonly documentNavigationPending?: boolean;
  readonly codexContext?: LiveContextBindingStatus;
  readonly copyLink?: CopyLinkControlProps;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onNavigateBack?: () => void;
  readonly onNavigateForward?: () => void;
  readonly onSaveOptions?: () => void;
  readonly saveOptionsAvailable?: boolean;
}

export function ReviewChrome({
  showSaveStatusDot = true,
  documentTitle,
  displayTitle = documentTitle,
  savedLabel = 'Saved',
  savePhase = 'clean',
  savePendingDestination = false,
  saveOptionsOpen = false,
  documentActions,
  controls,
  viewerState,
  fitWidthReady = false,
  onFitWidth = () => undefined,
  fitState,
  onFitMode,
  onManualZoom,
  horizontalScrollLocked = false,
  horizontalScrollAvailable = false,
  fitWidthCurrent = false,
  onToggleHorizontalScrollLock,
  beforeViewerAction,
  canUndo,
  canRedo,
  canNavigateBack = false,
  canNavigateForward = false,
  documentNavigationPending = false,
  codexContext,
  copyLink,
  onUndo,
  onRedo,
  onNavigateBack = () => undefined,
  onNavigateForward = () => undefined,
  onSaveOptions = () => undefined,
  saveOptionsAvailable = true,
}: ReviewChromeProps) {
  const [compactTouch, setCompactTouch] = useState(false);
  const compactTouchFocusRef = useRef<TopBarMenuId | null>(null);
  const [presentation, setPresentation] = useState<ReviewChromePresentation>('navigationCompact');
  const [activeTopBarMenu, setActiveTopBarMenu] = useState<TopBarMenuId | null>(null);
  const topBarMenuKeyboardOpenRef = useRef(true);
  const [topBarMenuHoverOpen, setTopBarMenuHoverOpen] = useState(false);
  const [documentMenuPending, setDocumentMenuPending] = useState(false);
  const [editingPage, setEditingPage] = useState(false);
  const [pageDraft, setPageDraft] = useState('');
  const [pageInvalid, setPageInvalid] = useState(false);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const pagePointerActivationRef = useRef(false);
  const restorePageTriggerFocus = useRef(false);
  const pageStepIntent = useRef(false);
  const focusedPageStep = useRef<HTMLButtonElement | null>(null);
  const focusedHistoryAction = useRef<{ button: HTMLButtonElement; menuId: string } | null>(null);
  const pageErrorId = useId();
  const [editingZoom, setEditingZoom] = useState(false);
  const [zoomDraft, setZoomDraft] = useState('');
  const [zoomInvalid, setZoomInvalid] = useState(false);
  const [fitRequestPending, setFitRequestPending] = useState(false);
  const fitRequestRef = useRef(0);
  const [fitOptionsOpen, setFitOptionsOpen] = useState(false);
  const fitButtonRef = useRef<HTMLButtonElement | null>(null);
  const fitOptionsRef = useRef<HTMLDivElement | null>(null);
  const fitOptionsKeyboardOpenRef = useRef(false);
  const fitOptionsDismissTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fitChoiceFocusRef = useRef<'first' | 'last' | null>(null);
  const fitOptionsId = `review-fit-options-${useId().replaceAll(':', '')}`;
  const zoomInputRef = useRef<HTMLInputElement>(null);
  const zoomPointerActivationRef = useRef(false);
  const restoreZoomTriggerFocus = useRef(false);
  const zoomActionIntent = useRef(false);
  const zoomErrorId = useId();
  const saveTriggerRef = useRef<HTMLButtonElement>(null);
  const chromeRef = useRef<HTMLElement>(null);
  const sizingRackRef = useRef<HTMLDivElement>(null);
  const measuredPresentationRef = useRef<ReviewChromePresentation | null>(null);
  const presentationRef = useRef<ReviewChromePresentation>(presentation);
  const activeTopBarMenuRef = useRef<TopBarMenuId | null>(null);
  const documentMenuPendingRef = useRef(false);
  const historyAnchorRef = useRef<HTMLElement | null>(null);
  const navigationAnchorRef = useRef<HTMLElement | null>(null);
  const zoomAnchorRef = useRef<HTMLElement | null>(null);
  const navigationHoverRef = useRef<HTMLElement | null>(null);
  const zoomHoverRef = useRef<HTMLElement | null>(null);
  const pendingTransitionFocusRef = useRef<TopBarMenuId | null>(null);
  const deferredTopBarFocusVersionRef = useRef(0);
  const historyMenuId = `review-history-menu-${useId().replaceAll(':', '')}`;
  const navigationMenuId = `review-navigation-menu-${useId().replaceAll(':', '')}`;
  const zoomMenuId = `review-zoom-menu-${useId().replaceAll(':', '')}`;
  const saveOptionsWereOpen = useRef(saveOptionsOpen);
  const saveStatusText = savePendingDestination
    ? 'protected recovery, choose where to save'
    : savePhase === 'not-saved'
    ? 'not saved'
    : savePhase === 'saving'
      ? 'saving changes'
      : savedLabel;
  const saveStatusDisplay = savePendingDestination
    ? 'Protected Recovery'
    : savePhase === 'not-saved'
    ? 'Not saved'
    : savePhase === 'saving'
      ? 'Saving changes'
      : savedLabel;
  const identityLabel = documentIdentityLabel(displayTitle, documentTitle);
  const saveControlLabel = `${identityLabel}, ${saveStatusText}. Open automatic save options`;
  const pageUnavailableId = 'viewer-page-controls-readiness';
  const zoomUnavailableId = 'viewer-zoom-controls-readiness';
  const fitWidthUnavailableId = 'viewer-fit-width-readiness';
  const zoomUnavailable = viewerState.zoomReady ? undefined : zoomUnavailableId;
  const selectedFit = fitState?.selectedMode ?? 'width';
  const nextFit = FIT_MODES[(FIT_MODES.indexOf(selectedFit) + 1) % FIT_MODES.length]!;
  const fitActive = fitState?.active ?? fitWidthCurrent;
  const fitAction = fitActive ? nextFit : selectedFit;
  const fitPending = fitState?.pending || fitRequestPending;
  const fitStatus = fitPending ? 'Fitting…'
    : !fitActive ? 'Custom zoom'
    : fitState?.fallback ? 'Fit width, no reliable text bounds'
    : FIT_LABELS[fitState?.effectiveMode ?? 'width'];
  const fitLabel = onFitMode ? `Fit mode: ${fitStatus}. ${fitActive ? 'Next' : 'Apply'}: ${FIT_LABELS[fitAction]}` : 'Fit width';
  const runViewerActionAsync = async (action: () => void | Promise<void>) => {
    await beforeViewerAction?.();
    await action();
  };
  const runViewerAction = (action: () => void) => {
    void runViewerActionAsync(action);
  };
  const requestTopBarMenu = (requestedMenu: TopBarMenuId, requestedOpen: boolean) => {
    if (requestedMenu !== 'zoom' || !requestedOpen) setFitOptionsOpen(false);
    if (requestedOpen) deferredTopBarFocusVersionRef.current += 1;
    setActiveTopBarMenu((activeMenu) => resolveTopBarMenuRequest({
      activeMenu,
      requestedMenu,
      requestedOpen,
      documentMenuPending,
    }));
  };
  const openHoverMenu = (menu: 'navigation' | 'zoom', pointerType: string) => {
    if (pointerType !== 'mouse' || !matchMedia('(hover: hover) and (pointer: fine)').matches || (menu === 'navigation'
      ? !viewerState.pageReady || viewerState.totalPages <= 1
      : !viewerState.zoomReady)) return;
    if (activeTopBarMenu === menu) return;
    setTopBarMenuHoverOpen(true);
    topBarMenuKeyboardOpenRef.current = false;
    requestTopBarMenu(menu, true);
  };
  const activateMenu = (menu: 'navigation' | 'zoom' | 'history', event: MouseEvent<HTMLButtonElement>) => {
    const keyboard = event.detail === 0;
    const pointerType = 'pointerType' in event.nativeEvent ? event.nativeEvent.pointerType : undefined;
    const hover = matchMedia('(hover: hover) and (pointer: fine)').matches
      && !keyboard && pointerType !== 'touch' && (topBarMenuHoverOpen || pointerType === 'mouse');
    topBarMenuKeyboardOpenRef.current = keyboard;
    setTopBarMenuHoverOpen(hover);
    requestTopBarMenu(menu, hover || (keyboard && topBarMenuHoverOpen) || activeTopBarMenu !== menu);
  };
  const restoreTopBarTriggerFocus = (group: 'navigation' | 'zoom') => {
    const version = ++deferredTopBarFocusVersionRef.current;
    requestAnimationFrame(() => {
      if (version !== deferredTopBarFocusVersionRef.current) return;
      if (activeTopBarMenuRef.current !== null) return;
      const target = group === 'navigation' ? navigationAnchorRef.current : zoomAnchorRef.current;
      target?.focus({ preventScroll: true });
    });
  };
  activeTopBarMenuRef.current = activeTopBarMenu;
  documentMenuPendingRef.current = documentMenuPending;
  presentationRef.current = presentation;

  useLayoutEffect(() => {
    const media = matchMedia('(max-width: 480px) and (pointer: coarse)');
    const update = () => {
      const focusedGroup = document.activeElement instanceof HTMLElement
        ? document.activeElement.closest<HTMLElement>('[data-review-chrome-group]')?.dataset.reviewChromeGroup
        : undefined;
      const documentPending = documentMenuPendingRef.current && activeTopBarMenuRef.current === 'document';
      compactTouchFocusRef.current = documentPending ? null : activeTopBarMenuRef.current
        ?? (focusedGroup as TopBarMenuId | undefined) ?? null;
      if (!documentPending) setActiveTopBarMenu(null);
      setCompactTouch(media.matches);
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useLayoutEffect(() => {
    const group = compactTouchFocusRef.current;
    compactTouchFocusRef.current = null;
    if (group === null) return;
    let target: HTMLElement | null | undefined;
    switch (group) {
      case 'history':
        target = compactTouch ? historyAnchorRef.current
          : chromeRef.current?.querySelector<HTMLElement>('.review-chrome__history-control:not(:disabled)') ?? navigationAnchorRef.current;
        break;
      case 'navigation':
        target = navigationAnchorRef.current;
        break;
      case 'zoom':
        target = zoomAnchorRef.current;
        break;
      default:
        target = chromeRef.current?.querySelector<HTMLElement>('[data-document-actions-trigger]') ?? saveTriggerRef.current;
    }
    target?.focus({ preventScroll: true });
  }, [compactTouch]);

  useLayoutEffect(() => {
    const chrome = chromeRef.current;
    const sizingRack = sizingRackRef.current;
    if (!chrome || !sizingRack || typeof ResizeObserver === 'undefined') return;

    let frame = 0;
    let disposed = false;
    const measure = () => {
      frame = 0;
      if (disposed) return;
      const measuredWidths = Object.fromEntries(REVIEW_CHROME_PRESENTATIONS.map((candidate) => {
        const element = sizingRack.querySelector<HTMLElement>(
          `[data-review-chrome-candidate="${candidate}"]`,
        );
        return [candidate, element?.getBoundingClientRect().width ?? 0];
      })) as ReviewChromePresentationWidths;
      const availableWidth = chrome.getBoundingClientRect().width;
      const nextPresentation = chooseReviewChromePresentation({
        availableWidth,
        widths: measuredWidths,
        previous: measuredPresentationRef.current,
      });
      const measurementsValid = availableWidth > 0
        && REVIEW_CHROME_PRESENTATIONS.every((candidate) => measuredWidths[candidate] > 0);
      if (measurementsValid) measuredPresentationRef.current = nextPresentation;
      if (nextPresentation === presentationRef.current) return;
      deferredTopBarFocusVersionRef.current += 1;

      const activeElement = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      const focusedGroup = activeElement
        ?.closest<HTMLElement>('[data-review-chrome-group]')
        ?.dataset.reviewChromeGroup as TopBarMenuId | undefined;
      pendingTransitionFocusRef.current = activeTopBarMenuRef.current ?? focusedGroup ?? null;
      setEditingPage(false);
      setEditingZoom(false);
      if (!(documentMenuPendingRef.current && activeTopBarMenuRef.current === 'document')) {
        setActiveTopBarMenu(null);
      }
      setPresentation(nextPresentation);
      presentationRef.current = nextPresentation;
    };
    const scheduleMeasure = () => {
      if (disposed || frame !== 0) return;
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(chrome);
    for (const candidate of sizingRack.querySelectorAll<HTMLElement>('[data-review-chrome-candidate]')) {
      observer.observe(candidate);
    }
    measure();
    void document.fonts?.ready.then(scheduleMeasure);
    return () => {
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const focusGroup = pendingTransitionFocusRef.current;
    if (focusGroup === null) return;
    pendingTransitionFocusRef.current = null;
    const anchors: Record<TopBarMenuId, HTMLElement | null> = {
      document: chromeRef.current?.querySelector<HTMLElement>('[data-document-actions-trigger]') ?? null,
      history: historyAnchorRef.current,
      navigation: navigationAnchorRef.current,
      zoom: zoomAnchorRef.current,
    };
    const target = anchors[focusGroup];
    target?.focus({ preventScroll: true });
  }, [presentation]);

  useLayoutEffect(() => {
    if (saveOptionsWereOpen.current && !saveOptionsOpen) {
      saveTriggerRef.current?.focus({ preventScroll: true });
    }
    saveOptionsWereOpen.current = saveOptionsOpen;
  }, [saveOptionsOpen]);

  useLayoutEffect(() => {
    if (editingPage) {
      pageInputRef.current?.focus({ preventScroll: true });
      pageInputRef.current?.select();
      return;
    }
    if (!restorePageTriggerFocus.current) return;
    restorePageTriggerFocus.current = false;
    pageInputRef.current?.focus({ preventScroll: true });
  }, [editingPage]);

  useLayoutEffect(() => {
    if (editingZoom) {
      zoomInputRef.current?.focus({ preventScroll: true });
      zoomInputRef.current?.select();
      return;
    }
    if (!restoreZoomTriggerFocus.current) return;
    restoreZoomTriggerFocus.current = false;
    zoomInputRef.current?.focus({ preventScroll: true });
  }, [editingZoom]);

  const startPageEdit = () => {
    setPageDraft(String(viewerState.currentPage));
    setPageInvalid(false);
    setEditingPage(true);
  };
  const closePageEdit = (restoreFocus: boolean) => {
    restorePageTriggerFocus.current = restoreFocus;
    setPageInvalid(false);
    setEditingPage(false);
  };
  const goToDraftPage = () => {
    const pageNumber = validPageNumber(pageDraft, viewerState.totalPages);
    if (pageNumber === undefined) return false;
    if (pageNumber !== viewerState.currentPage) {
      runViewerAction(() => controls?.goToPage(pageNumber));
    }
    return true;
  };
  const submitPageEditOnEnter = (closeMenu = false) => {
    if (!goToDraftPage()) {
      setPageInvalid(true);
      return;
    }
    closePageEdit(!closeMenu);
    if (closeMenu) {
      requestTopBarMenu('navigation', false);
      restoreTopBarTriggerFocus('navigation');
    }
  };
  const submitPageEditOnBlur = () => {
    goToDraftPage();
    closePageEdit(false);
  };
  const preparePageStep = () => {
    pageStepIntent.current = true;
  };
  const clearPageStepIntent = () => {
    pageStepIntent.current = false;
  };
  const runPageStep = (button: HTMLButtonElement, step: () => void) => {
    clearPageStepIntent();
    button.focus({ preventScroll: true });
    if (editingPage) closePageEdit(false);
    runViewerAction(step);
    focusedPageStep.current = button;
  };
  useLayoutEffect(() => {
    const button = focusedPageStep.current;
    if (activeTopBarMenu !== 'navigation') {
      focusedPageStep.current = null;
      return;
    }
    if (button === null || (button.isConnected && !button.disabled)) return;
    focusedPageStep.current = null;
    // Page navigation settles asynchronously; the old step can be greyed out at
    // the first or last page well after the click's next frame. Move focus to
    // the step that still works.
    if (document.activeElement !== document.body && document.activeElement !== button) return;
    const remaining = document.getElementById(navigationMenuId)
      ?.querySelector<HTMLButtonElement>('[data-review-page-step]:not(:disabled)');
    (remaining ?? navigationAnchorRef.current)?.focus({ preventScroll: true });
  });

  const startZoomEdit = () => {
    setZoomDraft(String(viewerState.zoomPercent));
    setZoomInvalid(false);
    setEditingZoom(true);
  };
  const closeZoomEdit = (restoreFocus: boolean) => {
    restoreZoomTriggerFocus.current = restoreFocus;
    setZoomInvalid(false);
    setEditingZoom(false);
  };
  const zoomToDraftPercent = (explicitSubmission = false) => {
    const resolved = resolveZoomDraft(zoomDraft, viewerState.zoomPercent);
    if (!resolved.valid) return false;
    const requestedZoom = resolved.request;
    if (requestedZoom !== undefined) {
      runViewerAction(() => controls?.zoomToPercent(requestedZoom));
    } else if (explicitSubmission && onManualZoom) {
      runViewerAction(onManualZoom);
    }
    return true;
  };
  const submitZoomEditOnEnter = (closeMenu = false) => {
    if (!zoomToDraftPercent(true)) {
      setZoomInvalid(true);
      return;
    }
    closeZoomEdit(!closeMenu);
    if (closeMenu) {
      requestTopBarMenu('zoom', false);
      restoreTopBarTriggerFocus('zoom');
    }
  };
  const submitZoomEditOnBlur = () => {
    zoomToDraftPercent();
    closeZoomEdit(false);
  };
  const prepareZoomAction = () => {
    zoomActionIntent.current = true;
  };
  const clearZoomActionIntent = () => {
    zoomActionIntent.current = false;
  };
  const runZoomAction = (button: HTMLButtonElement, action: () => void) => {
    clearZoomActionIntent();
    button.focus({ preventScroll: true });
    if (editingZoom) closeZoomEdit(false);
    runViewerAction(action);
  };
  const focusFitChoice = (position: 'first' | 'last') => {
    const choices = fitOptionsRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    (position === 'last' ? choices?.item(choices.length - 1) : choices?.item(0))?.focus({ preventScroll: true });
  };
  const cancelFitOptionsDismiss = () => clearTimeout(fitOptionsDismissTimerRef.current);
  const leaveFitOptions = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse' || fitOptionsKeyboardOpenRef.current) return;
    const next = event.relatedTarget;
    if (next instanceof Node && (fitButtonRef.current?.contains(next) || fitOptionsRef.current?.contains(next))) return;
    cancelFitOptionsDismiss();
    // Allow crossing the small gap between the button and its choices.
    fitOptionsDismissTimerRef.current = setTimeout(() => setFitOptionsOpen(false), 140);
  };
  useLayoutEffect(() => {
    if (!fitOptionsOpen) fitOptionsKeyboardOpenRef.current = false;
    return cancelFitOptionsDismiss;
  }, [fitOptionsOpen]);
  useLayoutEffect(() => {
    const focus = fitChoiceFocusRef.current;
    if (!fitOptionsOpen || focus === null) return;
    fitChoiceFocusRef.current = null;
    focusFitChoice(focus);
  }, [fitOptionsOpen]);

  const runFit = (button: HTMLButtonElement, mode: PdfFitMode) => {
    clearZoomActionIntent();
    button.focus({ preventScroll: true });
    if (editingZoom) closeZoomEdit(false);
    const request = ++fitRequestRef.current;
    setFitRequestPending(true);
    void runViewerActionAsync(() => onFitMode ? onFitMode(mode) : onFitWidth()).finally(() => {
      if (fitRequestRef.current === request) setFitRequestPending(false);
    });
  };

  const pageValue = (): ReactNode => viewerState.pageReady ? (
    <span className="review-chrome__page-control" data-review-stat>
      <span className="review-chrome__page-editor" data-review-page-editor={editingPage ? 'true' : 'false'}>
        <input
          ref={pageInputRef}
          className="review-chrome__page-input"
          title="Page number"
          type="text"
          inputMode="numeric"
          aria-label={`Current page ${viewerState.currentPage} of ${viewerState.totalPages}. Enter a page number`}
          aria-invalid={pageInvalid}
          aria-describedby={pageInvalid ? pageErrorId : undefined}
          aria-errormessage={pageInvalid ? pageErrorId : undefined}
          value={editingPage ? pageDraft : String(viewerState.currentPage)}
          style={{ width: pageInputWidth(editingPage ? pageDraft : String(viewerState.currentPage)) }}
          onPointerDown={() => { pagePointerActivationRef.current = !editingPage; }}
          onPointerUp={(event) => {
            if (!pagePointerActivationRef.current) return;
            event.currentTarget.select();
          }}
          onPointerCancel={() => { pagePointerActivationRef.current = false; }}
          onClick={(event) => {
            if (!pagePointerActivationRef.current) return;
            pagePointerActivationRef.current = false;
            event.currentTarget.select();
          }}
          onFocus={() => { if (!editingPage) startPageEdit(); }}
          onChange={(event) => {
            setEditingPage(true);
            setPageDraft(event.currentTarget.value);
            setPageInvalid(false);
          }}
          onBlur={(event) => {
            if (!editingPage) return;
            const pageStep = event.relatedTarget instanceof Element
              ? event.relatedTarget.closest('[data-review-page-step]')
              : null;
            if (pageStepIntent.current || pageStep) {
              clearPageStepIntent();
              closePageEdit(false);
            } else submitPageEditOnBlur();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submitPageEditOnEnter(false);
            }
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              closePageEdit(true);
            }
          }}
        />
        {pageInvalid ? <span id={pageErrorId} className="review-chrome__page-error" role="alert">
          Enter a whole page number from 1 to {viewerState.totalPages}
        </span> : null}
      </span>
    </span>
  ) : <span
    className="review-chrome__stat"
    data-review-stat
    aria-label="Current page unavailable"
  >—</span>;

  const zoomValue = (): ReactNode => viewerState.zoomReady ? (
    <span className="review-chrome__zoom-control" data-review-stat aria-label="Zoom level">
      <span className="review-chrome__zoom-editor" data-review-zoom-editor={editingZoom ? 'true' : 'false'}>
        <input
          ref={zoomInputRef}
          className="review-chrome__zoom-input"
          title="Zoom percentage"
          type="text"
          inputMode="numeric"
          aria-label={`Current zoom ${viewerState.zoomPercent} percent. Enter a zoom percentage`}
          aria-invalid={zoomInvalid}
          aria-describedby={zoomInvalid ? zoomErrorId : undefined}
          aria-errormessage={zoomInvalid ? zoomErrorId : undefined}
          value={editingZoom ? zoomDraft : String(viewerState.zoomPercent)}
          style={{ width: zoomInputWidth(editingZoom ? zoomDraft : String(viewerState.zoomPercent)) }}
          onPointerDown={() => { zoomPointerActivationRef.current = !editingZoom; }}
          onPointerUp={(event) => {
            if (!zoomPointerActivationRef.current) return;
            event.currentTarget.select();
          }}
          onPointerCancel={() => { zoomPointerActivationRef.current = false; }}
          onClick={(event) => {
            if (!zoomPointerActivationRef.current) return;
            zoomPointerActivationRef.current = false;
            event.currentTarget.select();
          }}
          onFocus={() => { if (!editingZoom) startZoomEdit(); }}
          onChange={(event) => {
            setEditingZoom(true);
            setZoomDraft(event.currentTarget.value);
            setZoomInvalid(false);
          }}
          onBlur={(event) => {
            if (!editingZoom) return;
            const zoomAction = event.relatedTarget instanceof Element
              ? event.relatedTarget.closest('[data-review-zoom-action]')
              : null;
            if (zoomActionIntent.current || zoomAction) {
              clearZoomActionIntent();
              closeZoomEdit(false);
            } else submitZoomEditOnBlur();
          }}
          onKeyDown={(event) => {
            const action = zoomEditorKeyAction(event.key, event.nativeEvent.isComposing);
            if (action === 'submit') {
              event.preventDefault();
              submitZoomEditOnEnter(false);
            }
            if (action === 'cancel') {
              event.preventDefault();
              event.stopPropagation();
              closeZoomEdit(true);
            }
          }}
        />
        {zoomInvalid ? <span id={zoomErrorId} className="review-chrome__zoom-error" role="alert">
          Enter a whole zoom percentage from {VIEWER_ZOOM_MIN_PERCENT} to {VIEWER_ZOOM_MAX_PERCENT}
        </span> : null}
      </span>
    </span>
  ) : <span
    className="review-chrome__stat"
    data-review-stat
    aria-label="Zoom unavailable"
  >—</span>;

  const runMenuHistoryAction = (button: HTMLButtonElement, action: () => void) => {
    button.focus({ preventScroll: true });
    const menuId = button.closest<HTMLElement>('[role="menu"]')?.id;
    if (menuId) focusedHistoryAction.current = { button, menuId };
    action();
  };
  useLayoutEffect(() => {
    const activated = focusedHistoryAction.current;
    if (activated === null) return;
    const menu = document.getElementById(activated.menuId);
    if (menu === null) {
      focusedHistoryAction.current = null;
      return;
    }
    const { button } = activated;
    if (button.isConnected && !button.disabled) return;
    focusedHistoryAction.current = null;
    if (document.activeElement !== document.body && document.activeElement !== button) return;
    // A history action can exhaust its direction after the command settles.
    // Keep keyboard navigation in the menu when that action becomes disabled.
    const remaining = menu.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)');
    (remaining ?? menu).focus({ preventScroll: true });
  });

  // Edit history keeps both slots so the toolbar never shifts; unavailable
  // actions are greyed out rather than removed.
  const historyControls = <span
    ref={(element) => { if (!compactTouch) historyAnchorRef.current = element; }}
    tabIndex={compactTouch ? undefined : -1}
    data-review-chrome-group="history"
    className="review-chrome__control-cluster review-chrome__edit-cluster"
    role="group"
    aria-label="Edit history"
  >
    {compactTouch ? <>
      <ReviewTooltipButton label="Open edit history" tooltip={false} type="button"
        ref={(element) => { historyAnchorRef.current = element; }}
        className="review-chrome__icon-control review-chrome__history-trigger"
        aria-haspopup="menu" aria-expanded={activeTopBarMenu === 'history'} aria-controls={historyMenuId}
        onClick={(event) => activateMenu('history', event)}
      ><ReviewIcon name="undo" /></ReviewTooltipButton>
      <TopBarMenu open={activeTopBarMenu === 'history'} menuId={historyMenuId} label="Edit history"
        openerRef={historyAnchorRef} onDismiss={() => requestTopBarMenu('history', false)}>
        <ReviewTooltipButton label="Undo" type="button" role="menuitem" disabled={!canUndo} onClick={(event) => runMenuHistoryAction(event.currentTarget, onUndo)}><ReviewIcon name="undo" /><span>Undo</span></ReviewTooltipButton>
        <ReviewTooltipButton label="Redo" type="button" role="menuitem" disabled={!canRedo} onClick={(event) => runMenuHistoryAction(event.currentTarget, onRedo)}><ReviewIcon name="redo" /><span>Redo</span></ReviewTooltipButton>
      </TopBarMenu>
    </> : <>
      <ReviewTooltipButton label="Undo" type="button" className="review-chrome__icon-control review-chrome__history-control" disabled={!canUndo} onClick={onUndo}><ReviewIcon name="undo" /></ReviewTooltipButton>
      <ReviewTooltipButton label="Redo" type="button" className="review-chrome__icon-control review-chrome__history-control" disabled={!canRedo} onClick={onRedo}><ReviewIcon name="redo" /></ReviewTooltipButton>
    </>}
  </span>;

  const mainHistoryControl = (direction: 'back' | 'forward', inMenu = false) => {
    const backward = direction === 'back';
    const available = backward ? canNavigateBack : canNavigateForward;
    return <ReviewTooltipButton
      label={backward ? 'Back in document history' : 'Forward in document history'}
      type="button"
      role={inMenu ? 'menuitem' : undefined}
      className={inMenu ? 'review-chrome__main-history-control' : 'review-chrome__icon-control review-chrome__main-history-control'}
      data-main-history={direction}
      aria-busy={documentNavigationPending ? 'true' : undefined}
      disabled={documentNavigationPending || !available}
      onClick={(event) => {
        const action = backward ? onNavigateBack : onNavigateForward;
        if (inMenu) runMenuHistoryAction(event.currentTarget, action);
        else action();
      }}
    ><ReviewIcon name={backward ? 'arrow-left' : 'arrow-right'} />{inMenu ? <span>{backward ? 'Back in document history' : 'Forward in document history'}</span> : null}</ReviewTooltipButton>;
  };

  const pageNavigationAvailable = viewerState.pageReady && viewerState.totalPages > 1;
  const navigationMenuAvailable = pageNavigationAvailable
    || (compactTouch && (canNavigateBack || canNavigateForward));
  const navigationMenuLabel = viewerState.pageReady
    ? `Page ${viewerState.currentPage} of ${viewerState.totalPages}. Open page navigation`
    : navigationMenuAvailable ? 'Open document navigation' : 'Page navigation unavailable';

  const navigationControls = <span
    data-review-chrome-group="navigation"
    className="review-chrome__control-cluster review-chrome__navigation-cluster"
    role="group"
    aria-label="Document navigation"
  >
    <span className="review-chrome__page-position" data-review-page-position
      ref={navigationHoverRef}
      onPointerEnter={(event) => openHoverMenu('navigation', event.pointerType)}
    >
      {pageValue()}
      <ReviewTooltipButton
        label={navigationMenuLabel}
        tooltip={false}
        ref={(element) => { navigationAnchorRef.current = element; }}
        type="button"
        className="review-chrome__page-disclosure review-chrome__stat"
        aria-label={navigationMenuLabel}
        aria-haspopup="menu"
        aria-expanded={activeTopBarMenu === 'navigation'}
        aria-controls={navigationMenuId}
        disabled={!navigationMenuAvailable}
        onClick={(event) => activateMenu('navigation', event)}
      ><span aria-hidden="true">/ {viewerState.pageReady ? viewerState.totalPages : '—'}</span></ReviewTooltipButton>
    </span>
      {copyLink === undefined ? null : <div className="review-chrome__link" data-review-copy-link><CopyLinkControl {...copyLink} /></div>}
    {/* Back and Forward keep fixed slots, greyed out when unavailable. */}
    {compactTouch ? null : <>{mainHistoryControl('back')}{mainHistoryControl('forward')}</>}
    <TopBarMenu hoverOpen={topBarMenuHoverOpen} hoverRegionRef={navigationHoverRef} open={activeTopBarMenu === 'navigation'} menuId={navigationMenuId} label="Page navigation" openerRef={navigationAnchorRef} focusOnOpen={topBarMenuKeyboardOpenRef.current} onDismiss={() => requestTopBarMenu('navigation', false)}>
      {compactTouch ? <>{mainHistoryControl('back', true)}{mainHistoryControl('forward', true)}</> : null}
      <div className="review-chrome__control-cluster review-chrome__page-menu" role="group" aria-label="Page navigation controls">
        <ReviewTooltipButton label="Previous page" type="button" role="menuitem" className="review-chrome__icon-control" data-review-page-step="previous" disabled={!viewerState.pageReady || viewerState.currentPage <= 1} onPointerDown={preparePageStep} onPointerUp={clearPageStepIntent} onPointerCancel={clearPageStepIntent} onClick={(event) => runPageStep(event.currentTarget, () => controls?.previousPage())}><ReviewIcon name="chevron-up" /></ReviewTooltipButton>
        <ReviewTooltipButton label="Next page" type="button" role="menuitem" className="review-chrome__icon-control" data-review-page-step="next" disabled={!viewerState.pageReady || viewerState.currentPage >= viewerState.totalPages} onPointerDown={preparePageStep} onPointerUp={clearPageStepIntent} onPointerCancel={clearPageStepIntent} onClick={(event) => runPageStep(event.currentTarget, () => controls?.nextPage())}><ReviewIcon name="chevron-down" /></ReviewTooltipButton>
      </div>
    </TopBarMenu>
  </span>;

  const zoomControls = <span
    ref={zoomHoverRef}
    onPointerEnter={(event) => openHoverMenu('zoom', event.pointerType)}
    data-review-chrome-group="zoom"
    className="review-chrome__control-cluster review-chrome__zoom-cluster"
    role="group"
    aria-label="PDF zoom"
  >
    {/* Like the page group's "/ 33", the fixed "%" suffix opens the menu. */}
    <span className="review-chrome__zoom-value">{zoomValue()}</span>
    <ReviewTooltipButton
      label="Open zoom controls"
      tooltip={false}
      ref={(element) => { zoomAnchorRef.current = element; }}
      type="button"
      className="review-chrome__zoom-disclosure"
      aria-label="Open zoom controls"
      aria-haspopup="menu"
      aria-expanded={activeTopBarMenu === 'zoom'}
      aria-controls={zoomMenuId}
      disabled={!viewerState.zoomReady}
      onClick={(event) => activateMenu('zoom', event)}
    ><span aria-hidden="true" className="review-chrome__zoom-suffix">%</span></ReviewTooltipButton>
    <TopBarMenu hoverOpen={topBarMenuHoverOpen} hoverRegionRef={zoomHoverRef} open={activeTopBarMenu === 'zoom'} menuId={zoomMenuId} label="PDF zoom" openerRef={zoomAnchorRef} focusOnOpen={topBarMenuKeyboardOpenRef.current} onDismiss={() => requestTopBarMenu('zoom', false)}>
      <div className="review-chrome__control-cluster" role="group" aria-label="Zoom controls">
        {horizontalScrollAvailable ? <ReviewTooltipButton
          label="Horizontal lock"
          tooltip={horizontalScrollLocked ? 'Unlock horizontal scrolling' : 'Lock horizontal scrolling'}
          type="button"
          role="menuitemcheckbox"
          aria-checked={horizontalScrollLocked}
          className="review-chrome__icon-control"
          data-review-horizontal-lock
          disabled={!viewerState.zoomReady || onToggleHorizontalScrollLock === undefined}
          onClick={onToggleHorizontalScrollLock}
        ><ReviewIcon name={horizontalScrollLocked ? 'lock' : 'unlock'} /></ReviewTooltipButton> : null}
        <ReviewTooltipButton
          ref={fitButtonRef}
          label={fitLabel}
          tooltip={onFitMode ? false : 'Fit width'}
          type="button"
          role="menuitem"
          className="review-chrome__icon-control review-chrome__fit-width"
          data-review-zoom-action="fit-width"
          data-fit-width-current={fitWidthCurrent ? 'true' : undefined}
          data-fit-active={fitActive ? 'true' : 'false'}
          data-fit-mode={selectedFit}
          aria-haspopup={onFitMode ? 'menu' : undefined}
          aria-expanded={onFitMode ? fitOptionsOpen : undefined}
          aria-controls={onFitMode ? fitOptionsId : undefined}
          aria-busy={fitPending ? 'true' : 'false'}
          aria-describedby={zoomUnavailable ?? (!fitWidthReady ? fitWidthUnavailableId : undefined)}
          disabled={!viewerState.zoomReady || !fitWidthReady}
          onPointerEnter={(event) => {
            if (!onFitMode || event.pointerType !== 'mouse') return;
            cancelFitOptionsDismiss();
            setFitOptionsOpen(true);
          }}
          onPointerLeave={leaveFitOptions}
          onKeyDown={(event) => {
            if (!onFitMode || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            fitOptionsKeyboardOpenRef.current = true;
            cancelFitOptionsDismiss();
            const focus = event.key === 'ArrowUp' ? 'last' : 'first';
            if (fitOptionsOpen) {
              focusFitChoice(focus);
            } else {
              fitChoiceFocusRef.current = focus;
              setFitOptionsOpen(true);
            }
          }}
          onPointerDown={prepareZoomAction}
          onPointerUp={clearZoomActionIntent}
          onPointerCancel={clearZoomActionIntent}
          onClick={(event) => runFit(event.currentTarget, fitAction)}
        ><ReviewIcon name={FIT_ICONS[fitActive ? fitState?.effectiveMode ?? selectedFit : selectedFit]} /></ReviewTooltipButton>
        <ReviewTooltipButton label="Zoom out" type="button" role="menuitem" className="review-chrome__icon-control" data-review-zoom-action="out" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onPointerDown={prepareZoomAction} onPointerUp={clearZoomActionIntent} onPointerCancel={clearZoomActionIntent} onClick={(event) => runZoomAction(event.currentTarget, () => controls?.zoomOut())}><ReviewIcon name="minus" /></ReviewTooltipButton>
        <ReviewTooltipButton label="Zoom in" type="button" role="menuitem" className="review-chrome__icon-control" data-review-zoom-action="in" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onPointerDown={prepareZoomAction} onPointerUp={clearZoomActionIntent} onPointerCancel={clearZoomActionIntent} onClick={(event) => runZoomAction(event.currentTarget, () => controls?.zoomIn())}><ReviewIcon name="plus" /></ReviewTooltipButton>
      </div>
      {onFitMode && fitOptionsOpen ? <div
        ref={fitOptionsRef}
        id={fitOptionsId}
        className="review-chrome__fit-options"
        role="menu"
        aria-label="PDF fit modes"
        onPointerEnter={cancelFitOptionsDismiss}
        onPointerLeave={leaveFitOptions}
        onKeyDown={() => {
          fitOptionsKeyboardOpenRef.current = true;
          cancelFitOptionsDismiss();
        }}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && !event.currentTarget.contains(next) && !fitButtonRef.current?.contains(next)) {
            setFitOptionsOpen(false);
          }
        }}
      >
        {FIT_MODES.map((mode) => <button
          key={mode}
          type="button"
          title={FIT_LABELS[mode]}
          role="menuitemradio"
          aria-checked={fitActive && (fitState?.effectiveMode ?? 'width') === mode}
          className="review-chrome__fit-option"
          disabled={!viewerState.zoomReady || !fitWidthReady}
          onPointerDown={prepareZoomAction}
          onPointerUp={clearZoomActionIntent}
          onPointerCancel={clearZoomActionIntent}
          onClick={(event) => {
            runFit(fitButtonRef.current ?? event.currentTarget, mode);
            setFitOptionsOpen(false);
          }}
        ><ReviewIcon name={FIT_ICONS[mode]} /><span>{FIT_LABELS[mode]}</span></button>)}
      </div> : null}
    </TopBarMenu>
  </span>;

  const controlsForPresentation = (_candidate: ReviewChromePresentation): ReactNode => <>
    {historyControls}
    {zoomControls}
  </>;

  const sizingCluster = (_candidate: ReviewChromePresentation): ReactNode => <div className="review-chrome__viewer-controls" style={{ display: 'inline-flex', gridColumn: 'auto', gridRow: 'auto', flexWrap: 'nowrap' }}>
    <span className="review-chrome__control-cluster review-chrome__edit-cluster"><button type="button" title={compactTouch ? 'Open edit history' : 'Undo'} className="review-chrome__icon-control"><ReviewIcon name="undo" /></button>{compactTouch ? null : <button type="button" title="Redo" className="review-chrome__icon-control"><ReviewIcon name="redo" /></button>}</span>
    <span className="review-chrome__control-cluster review-chrome__navigation-cluster">{compactTouch ? null : <><button type="button" title="Back in document history" data-main-history="back" className="review-chrome__icon-control"><ReviewIcon name="arrow-left" /></button><button type="button" title="Forward in document history" data-main-history="forward" className="review-chrome__icon-control"><ReviewIcon name="arrow-right" /></button></>}<span className="review-chrome__stat">{viewerState.pageReady ? `${viewerState.currentPage} / ${viewerState.totalPages}` : '— / —'}</span></span>
    <span className="review-chrome__control-cluster"><span className="review-chrome__stat">{viewerState.zoomReady ? `${viewerState.zoomPercent}%` : '—%'}</span></span>
    {copyLink === undefined ? null : <div className="review-chrome__link"><button type="button" title="Copy link to current location" className="review-chrome__icon-control"><ReviewIcon name="link" /></button></div>}
  </div>;

  const sizingIdentity = <div className="review-chrome__identity">
    {documentActions !== undefined ? <div className="document-actions"><button type="button" className="review-chrome__save-identity document-actions__trigger" title="Open document actions"><ReviewIcon name="file" size={16} /><span className="review-chrome__filename">{displayTitle}</span>{!showSaveStatusDot || savePhase === 'clean' ? null : <span className="review-chrome__save-dot" data-save-phase={savePhase} />}</button></div> : saveOptionsAvailable ? <button type="button" className="review-chrome__save-identity" title="Open automatic save options"><ReviewIcon name="file" size={16} /><span className="review-chrome__filename">{displayTitle}</span>{!showSaveStatusDot || savePhase === 'clean' ? null : <span className="review-chrome__save-dot" data-save-phase={savePhase} />}</button> : <div className="review-chrome__save-identity"><ReviewIcon name="file" size={16} /><span className="review-chrome__filename">{displayTitle}</span>{!showSaveStatusDot || savePhase === 'clean' ? null : <span className="review-chrome__save-dot" data-save-phase={savePhase} />}</div>}
    {codexContext === undefined ? null : <div className="review-chrome__context"><div className="codex-context-status"><ReviewIcon name="agent" size={16} /></div></div>}
  </div>;

  return <header
    ref={chromeRef}
    className="review-chrome"
    data-review-chrome
    data-review-chrome-presentation={presentation}
    data-review-chrome-touch-compact={compactTouch ? 'true' : undefined}
    data-top-bar-menu-open={activeTopBarMenu ?? undefined}
  >
    <div className="review-chrome__identity">
      {documentActions !== undefined ? <DocumentActionsMenu
        {...documentActions}
        documentTitle={documentTitle}
        displayTitle={displayTitle}
        savedLabel={savedLabel}
        savePhase={savePhase}
        showSaveStatusDot={showSaveStatusDot}
        open={activeTopBarMenu === 'document'}
        onOpenChange={(open) => requestTopBarMenu('document', open)}
        onPendingChange={(pending) => {
          setDocumentMenuPending(pending);
          if (pending) setActiveTopBarMenu('document');
        }}
      /> : saveOptionsAvailable ? <ReviewTooltipButton ref={saveTriggerRef} label={saveControlLabel} tooltip={documentTitle} type="button" className="review-chrome__save-identity" aria-haspopup="dialog" aria-expanded={saveOptionsOpen} onClick={onSaveOptions}>
        <ReviewIcon name="file" size={16} />
        <span className="review-chrome__filename">{displayTitle}</span>
        {!showSaveStatusDot || savePhase === 'clean' ? null : <span className="review-chrome__save-dot" data-save-phase={savePhase} aria-hidden="true" />}
        <span className="sr-only" data-review-saved-status>{saveStatusDisplay}</span>
      </ReviewTooltipButton> : <div className="review-chrome__save-identity" aria-label={`${identityLabel}, ${saveStatusText}`} title={documentTitle} tabIndex={0}>
        <ReviewIcon name="file" size={16} />
        <span className="review-chrome__filename">{displayTitle}</span>
        {!showSaveStatusDot || savePhase === 'clean' ? null : <span className="review-chrome__save-dot" data-save-phase={savePhase} aria-hidden="true" />}
        <span className="sr-only" data-review-saved-status>{saveStatusDisplay}</span>
      </div>}
      {codexContext === undefined ? null : <div className="review-chrome__context" data-review-context-status><CodexContextStatus status={codexContext} /></div>}
    </div>
    <div className="review-chrome__left-controls" role="group" aria-label="PDF navigation and links">
      {navigationControls}
    </div>
    <div className="review-chrome__viewer-controls" role="group" aria-label="PDF editing and zoom">
      {controlsForPresentation(presentation)}
    </div>
    <div
      ref={sizingRackRef}
      data-review-chrome-sizing-rack
      aria-hidden="true"
      inert
      style={{ position: 'absolute', width: 'max-content', height: 0, overflow: 'hidden', visibility: 'hidden', pointerEvents: 'none' }}
    >
      {REVIEW_CHROME_PRESENTATIONS.map((candidate) => <div
        key={candidate}
        className="review-chrome review-chrome__sizing-candidate"
        data-review-chrome-candidate={candidate}
        style={{
          position: 'absolute',
          display: 'inline-grid',
          gridTemplateColumns: 'max-content max-content',
          gridTemplateRows: 'max-content',
          width: 'max-content',
          height: 'var(--review-chrome-height)',
        }}
      >
        {sizingIdentity}
        {sizingCluster(candidate)}
      </div>)}
    </div>
    {!viewerState.pageReady ? <p id={pageUnavailableId} className="sr-only">{viewerState.pageUnavailableReason}</p> : null}
    {!viewerState.zoomReady ? <p id={zoomUnavailableId} className="sr-only">{viewerState.zoomUnavailableReason}</p> : null}
    {viewerState.zoomReady && !fitWidthReady ? <p id={fitWidthUnavailableId} className="sr-only">Fit Width becomes available when PDF navigation is ready.</p> : null}
  </header>;
}
