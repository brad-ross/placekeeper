import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import {
  VIEWER_ZOOM_MAX_PERCENT,
  VIEWER_ZOOM_MIN_PERCENT,
  type ViewerControls,
  type ViewerControlsSnapshot,
} from '../pdf/viewer-controls.js';
import { ReviewIcon } from './ReviewIcon.js';
import { ReviewTooltipButton } from './ReviewTooltipButton.js';
import type { LiveContextBindingStatus } from '../../../../packages/core/src/live-context.js';
import { CodexContextStatus } from './CodexContextStatus.js';
import { CopyLinkControl, type CopyLinkControlProps } from './CopyLinkControl.js';
import {
  DocumentActionsMenu,
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

export interface ReviewChromeProps {
  readonly documentTitle: string;
  readonly savedLabel?: string;
  readonly showSaveStatusDot?: boolean;
  readonly savePhase?: 'clean' | 'saving' | 'not-saved';
  readonly savePendingDestination?: boolean;
  readonly saveOptionsOpen?: boolean;
  readonly documentActions?: Omit<
    DocumentActionsMenuProps,
    | 'documentTitle'
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
  savedLabel = 'Saved',
  savePhase = 'clean',
  savePendingDestination = false,
  saveOptionsOpen = false,
  documentActions,
  controls,
  viewerState,
  fitWidthReady = false,
  onFitWidth = () => undefined,
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
  const [presentation, setPresentation] = useState<ReviewChromePresentation>('navigationCompact');
  const [activeTopBarMenu, setActiveTopBarMenu] = useState<TopBarMenuId | null>(null);
  const topBarMenuKeyboardOpenRef = useRef(true);
  const [documentMenuPending, setDocumentMenuPending] = useState(false);
  const [editingPage, setEditingPage] = useState(false);
  const [pageDraft, setPageDraft] = useState('');
  const [pageInvalid, setPageInvalid] = useState(false);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const pagePointerActivationRef = useRef(false);
  const restorePageTriggerFocus = useRef(false);
  const pageStepIntent = useRef(false);
  const pageErrorId = useId();
  const [editingZoom, setEditingZoom] = useState(false);
  const [zoomDraft, setZoomDraft] = useState('');
  const [zoomInvalid, setZoomInvalid] = useState(false);
  const [fitWidthPending, setFitWidthPending] = useState(false);
  const fitWidthRequestRef = useRef(0);
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
  const pendingTransitionFocusRef = useRef<TopBarMenuId | null>(null);
  const deferredTopBarFocusVersionRef = useRef(0);
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
  const saveControlLabel = `${documentTitle}, ${saveStatusText}. Open automatic save options`;
  const pageUnavailableId = 'viewer-page-controls-readiness';
  const zoomUnavailableId = 'viewer-zoom-controls-readiness';
  const fitWidthUnavailableId = 'viewer-fit-width-readiness';
  const zoomUnavailable = viewerState.zoomReady ? undefined : zoomUnavailableId;
  const runViewerActionAsync = async (action: () => void | Promise<void>) => {
    await beforeViewerAction?.();
    await action();
  };
  const runViewerAction = (action: () => void) => {
    void runViewerActionAsync(action);
  };
  const requestTopBarMenu = (requestedMenu: TopBarMenuId, requestedOpen: boolean) => {
    if (requestedOpen) deferredTopBarFocusVersionRef.current += 1;
    setActiveTopBarMenu((activeMenu) => resolveTopBarMenuRequest({
      activeMenu,
      requestedMenu,
      requestedOpen,
      documentMenuPending,
    }));
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
    requestAnimationFrame(() => {
      if (button.isConnected) return;
      const remaining = document
        .getElementById(navigationMenuId)
        ?.querySelector<HTMLButtonElement>('[data-review-page-step]');
      (remaining ?? navigationAnchorRef.current)?.focus({ preventScroll: true });
    });
  };
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
  const zoomToDraftPercent = () => {
    const resolved = resolveZoomDraft(zoomDraft, viewerState.zoomPercent);
    if (!resolved.valid) return false;
    const requestedZoom = resolved.request;
    if (requestedZoom !== undefined) {
      runViewerAction(() => controls?.zoomToPercent(requestedZoom));
    }
    return true;
  };
  const submitZoomEditOnEnter = (closeMenu = false) => {
    if (!zoomToDraftPercent()) {
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
  const runFitWidth = (button: HTMLButtonElement, closeMenu = false) => {
    clearZoomActionIntent();
    button.focus({ preventScroll: true });
    if (editingZoom) closeZoomEdit(false);
    const request = ++fitWidthRequestRef.current;
    setFitWidthPending(true);
    if (closeMenu) {
      requestTopBarMenu('zoom', false);
      restoreTopBarTriggerFocus('zoom');
    }
    void runViewerActionAsync(onFitWidth).finally(() => {
      if (fitWidthRequestRef.current === request) setFitWidthPending(false);
    });
  };

  const pageValue = (): ReactNode => viewerState.pageReady ? (
    <span className="review-chrome__page-control" data-review-stat>
      <span className="review-chrome__page-editor" data-review-page-editor={editingPage ? 'true' : 'false'}>
        <input
          ref={pageInputRef}
          className="review-chrome__page-input"
          type="text"
          inputMode="numeric"
          aria-label={`Current page ${viewerState.currentPage} of ${viewerState.totalPages}. Enter a page number`}
          title="Current page"
          aria-invalid={pageInvalid}
          aria-describedby={pageInvalid ? pageErrorId : undefined}
          aria-errormessage={pageInvalid ? pageErrorId : undefined}
          value={editingPage ? pageDraft : String(viewerState.currentPage)}
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
            setPageDraft(event.currentTarget.value);
            setPageInvalid(false);
          }}
          onBlur={(event) => {
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
          type="text"
          inputMode="numeric"
          aria-label={`Current zoom ${viewerState.zoomPercent} percent. Enter a zoom percentage`}
          title="Zoom percentage"
          aria-invalid={zoomInvalid}
          aria-describedby={zoomInvalid ? zoomErrorId : undefined}
          aria-errormessage={zoomInvalid ? zoomErrorId : undefined}
          value={editingZoom ? zoomDraft : String(viewerState.zoomPercent)}
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
            setZoomDraft(event.currentTarget.value);
            setZoomInvalid(false);
          }}
          onBlur={(event) => {
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

  const historyControls = canUndo || canRedo ? <span
    ref={(element) => { historyAnchorRef.current = element; }}
    tabIndex={-1}
    data-review-chrome-group="history"
    className="review-chrome__control-cluster review-chrome__edit-cluster"
    role="group"
    aria-label="Edit history"
  >
    {canUndo ? <ReviewTooltipButton label="Undo" type="button" className="review-chrome__icon-control review-chrome__history-control" onClick={onUndo}><ReviewIcon name="undo" /></ReviewTooltipButton> : null}
    {canRedo ? <ReviewTooltipButton label="Redo" type="button" className="review-chrome__icon-control review-chrome__history-control" onClick={onRedo}><ReviewIcon name="redo" /></ReviewTooltipButton> : null}
  </span> : null;

  const mainHistoryControl = (direction: 'back' | 'forward') => {
    const backward = direction === 'back';
    return <ReviewTooltipButton
      label={backward ? 'Back in document history' : 'Forward in document history'}
      type="button"
      className="review-chrome__icon-control review-chrome__main-history-control"
      data-main-history={direction}
      aria-busy={documentNavigationPending ? 'true' : undefined}
      disabled={documentNavigationPending}
      onClick={backward ? onNavigateBack : onNavigateForward}
    ><ReviewIcon name={backward ? 'arrow-left' : 'arrow-right'} /></ReviewTooltipButton>;
  };
  const primaryHistoryDirection = canNavigateBack
    ? 'back'
    : canNavigateForward
      ? 'forward'
      : null;
  const secondaryHistoryDirection = canNavigateBack && canNavigateForward ? 'forward' : null;

  const navigationControls = <span
    data-review-chrome-group="navigation"
    className="review-chrome__control-cluster review-chrome__navigation-cluster"
    role="group"
    aria-label="Document navigation"
  >
    {primaryHistoryDirection === null ? null : mainHistoryControl(primaryHistoryDirection)}
    {secondaryHistoryDirection === null ? null : mainHistoryControl(secondaryHistoryDirection)}
    <span className="review-chrome__page-position" data-review-page-position>
      {pageValue()}
      <ReviewTooltipButton
        label={viewerState.pageReady ? `Page ${viewerState.currentPage} of ${viewerState.totalPages}. Open page navigation` : 'Page navigation unavailable'}
        tooltip="Page navigation"
        ref={(element) => { navigationAnchorRef.current = element; }}
        type="button"
        className="review-chrome__page-disclosure review-chrome__stat"
        aria-label={viewerState.pageReady ? `Page ${viewerState.currentPage} of ${viewerState.totalPages}. Open page navigation` : 'Page navigation unavailable'}
        aria-haspopup="menu"
        aria-expanded={activeTopBarMenu === 'navigation'}
        aria-controls={navigationMenuId}
        disabled={!viewerState.pageReady || viewerState.totalPages <= 1}
        onClick={(event) => {
          topBarMenuKeyboardOpenRef.current = event.detail === 0;
          requestTopBarMenu('navigation', activeTopBarMenu !== 'navigation');
        }}
      ><span aria-hidden="true">/ {viewerState.pageReady ? viewerState.totalPages : '—'}</span></ReviewTooltipButton>
    </span>
    <TopBarMenu open={activeTopBarMenu === 'navigation'} menuId={navigationMenuId} label="Page navigation" openerRef={navigationAnchorRef} focusOnOpen={topBarMenuKeyboardOpenRef.current} onDismiss={() => requestTopBarMenu('navigation', false)}>
      <div className="review-chrome__control-cluster review-chrome__page-menu" role="group" aria-label="Page navigation controls">
        {viewerState.pageReady && viewerState.currentPage > 1 ? <ReviewTooltipButton label="Previous page" type="button" role="menuitem" className="review-chrome__icon-control" data-review-page-step="previous" onPointerDown={preparePageStep} onPointerUp={clearPageStepIntent} onPointerCancel={clearPageStepIntent} onClick={(event) => runPageStep(event.currentTarget, () => controls?.previousPage())}><ReviewIcon name="chevron-up" /></ReviewTooltipButton> : null}
        {viewerState.pageReady && viewerState.currentPage < viewerState.totalPages ? <ReviewTooltipButton label="Next page" type="button" role="menuitem" className="review-chrome__icon-control" data-review-page-step="next" onPointerDown={preparePageStep} onPointerUp={clearPageStepIntent} onPointerCancel={clearPageStepIntent} onClick={(event) => runPageStep(event.currentTarget, () => controls?.nextPage())}><ReviewIcon name="chevron-down" /></ReviewTooltipButton> : null}
      </div>
    </TopBarMenu>
  </span>;

  const zoomControls = <span
    data-review-chrome-group="zoom"
    className="review-chrome__control-cluster review-chrome__zoom-cluster"
    role="group"
    aria-label="PDF zoom"
  >
    <span className="review-chrome__zoom-value">{zoomValue()}<span aria-hidden="true" className="review-chrome__zoom-suffix">%</span></span>
    <ReviewTooltipButton
      label="Open zoom controls"
      tooltip="Zoom controls"
      ref={(element) => { zoomAnchorRef.current = element; }}
      type="button"
      className="review-chrome__icon-control review-chrome__zoom-disclosure"
      aria-label="Open zoom controls"
      aria-haspopup="menu"
      aria-expanded={activeTopBarMenu === 'zoom'}
      aria-controls={zoomMenuId}
      disabled={!viewerState.zoomReady}
      onClick={(event) => {
        topBarMenuKeyboardOpenRef.current = event.detail === 0;
        requestTopBarMenu('zoom', activeTopBarMenu !== 'zoom');
      }}
    ><ReviewIcon name="chevron-down" size={16} /></ReviewTooltipButton>
    <TopBarMenu open={activeTopBarMenu === 'zoom'} menuId={zoomMenuId} label="PDF zoom" openerRef={zoomAnchorRef} focusOnOpen={topBarMenuKeyboardOpenRef.current} onDismiss={() => requestTopBarMenu('zoom', false)}>
      <div className="review-chrome__control-cluster" role="group" aria-label="Zoom controls">
        <ReviewTooltipButton label="Zoom out" type="button" role="menuitem" className="review-chrome__icon-control" data-review-zoom-action="out" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onPointerDown={prepareZoomAction} onPointerUp={clearZoomActionIntent} onPointerCancel={clearZoomActionIntent} onClick={(event) => runZoomAction(event.currentTarget, () => controls?.zoomOut())}><ReviewIcon name="minus" /></ReviewTooltipButton>
        <ReviewTooltipButton label="Zoom in" type="button" role="menuitem" className="review-chrome__icon-control" data-review-zoom-action="in" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onPointerDown={prepareZoomAction} onPointerUp={clearZoomActionIntent} onPointerCancel={clearZoomActionIntent} onClick={(event) => runZoomAction(event.currentTarget, () => controls?.zoomIn())}><ReviewIcon name="plus" /></ReviewTooltipButton>
        <ReviewTooltipButton label="Fit width" type="button" role="menuitem" className="review-chrome__icon-control review-chrome__fit-width" data-review-zoom-action="fit-width" aria-busy={fitWidthPending ? 'true' : 'false'} aria-describedby={zoomUnavailable ?? (!fitWidthReady ? fitWidthUnavailableId : undefined)} disabled={!viewerState.zoomReady || !fitWidthReady} onPointerDown={prepareZoomAction} onPointerUp={clearZoomActionIntent} onPointerCancel={clearZoomActionIntent} onClick={(event) => runFitWidth(event.currentTarget)}><ReviewIcon name="fit-width" /></ReviewTooltipButton>
      </div>
    </TopBarMenu>
  </span>;

  const controlsForPresentation = (_candidate: ReviewChromePresentation): ReactNode => <>
    {historyControls}
    {navigationControls}
    {zoomControls}
    {copyLink === undefined ? null : <div className="review-chrome__link" data-review-copy-link><CopyLinkControl {...copyLink} /></div>}
  </>;

  const sizingCluster = (_candidate: ReviewChromePresentation): ReactNode => <div className="review-chrome__viewer-controls" style={{ display: 'inline-flex', gridColumn: 'auto', gridRow: 'auto', flexWrap: 'nowrap' }}>
    {canUndo || canRedo ? <span className="review-chrome__control-cluster">{canUndo ? <button type="button" title="Undo" className="review-chrome__icon-control"><ReviewIcon name="undo" /></button> : null}{canRedo ? <button type="button" title="Redo" className="review-chrome__icon-control"><ReviewIcon name="redo" /></button> : null}</span> : null}
    <span className="review-chrome__control-cluster">{canNavigateBack ? <button type="button" title="Back in document history" className="review-chrome__icon-control"><ReviewIcon name="arrow-left" /></button> : null}{canNavigateForward ? <button type="button" title="Forward in document history" className="review-chrome__icon-control"><ReviewIcon name="arrow-right" /></button> : null}<span className="review-chrome__stat">{viewerState.pageReady ? `${viewerState.currentPage} / ${viewerState.totalPages}` : '— / —'}</span></span>
    <span className="review-chrome__control-cluster"><span className="review-chrome__stat">{viewerState.zoomReady ? `${viewerState.zoomPercent}%` : '—%'}</span><button type="button" title="Zoom controls" className="review-chrome__icon-control"><ReviewIcon name="chevron-down" size={16} /></button></span>
    {copyLink === undefined ? null : <div className="review-chrome__link"><button type="button" title="Copy link to current location" className="review-chrome__icon-control"><ReviewIcon name="link" /></button></div>}
  </div>;

  const sizingIdentity = <div className="review-chrome__identity">
    {documentActions !== undefined ? <div className="document-actions"><button type="button" className="review-chrome__save-identity document-actions__trigger" title="Open document actions"><ReviewIcon name="file" size={16} /><span className="review-chrome__filename">{documentTitle}</span>{!showSaveStatusDot || savePhase === 'clean' ? null : <span className="review-chrome__save-dot" data-save-phase={savePhase} />}</button></div> : saveOptionsAvailable ? <button type="button" className="review-chrome__save-identity" title="Open automatic save options"><ReviewIcon name="file" size={16} /><span className="review-chrome__filename">{documentTitle}</span>{!showSaveStatusDot || savePhase === 'clean' ? null : <span className="review-chrome__save-dot" data-save-phase={savePhase} />}</button> : <div className="review-chrome__save-identity"><ReviewIcon name="file" size={16} /><span className="review-chrome__filename">{documentTitle}</span>{!showSaveStatusDot || savePhase === 'clean' ? null : <span className="review-chrome__save-dot" data-save-phase={savePhase} />}</div>}
    {codexContext === undefined ? null : <div className="review-chrome__context"><div className="codex-context-status"><ReviewIcon name="agent" size={16} /></div></div>}
  </div>;

  return <header
    ref={chromeRef}
    className="review-chrome"
    data-review-chrome
    data-review-chrome-presentation={presentation}
    data-top-bar-menu-open={activeTopBarMenu ?? undefined}
  >
    <div className="review-chrome__identity">
      {documentActions !== undefined ? <DocumentActionsMenu
        {...documentActions}
        documentTitle={documentTitle}
        savedLabel={savedLabel}
        savePhase={savePhase}
        showSaveStatusDot={showSaveStatusDot}
        open={activeTopBarMenu === 'document'}
        onOpenChange={(open) => requestTopBarMenu('document', open)}
        onPendingChange={(pending) => {
          setDocumentMenuPending(pending);
          if (pending) setActiveTopBarMenu('document');
        }}
      /> : saveOptionsAvailable ? <ReviewTooltipButton ref={saveTriggerRef} label={saveControlLabel} tooltip={`${documentTitle} — Save options`} type="button" className="review-chrome__save-identity" aria-haspopup="dialog" aria-expanded={saveOptionsOpen} onClick={onSaveOptions}>
        <ReviewIcon name="file" size={16} />
        <span className="review-chrome__filename">{documentTitle}</span>
        {!showSaveStatusDot || savePhase === 'clean' ? null : <span className="review-chrome__save-dot" data-save-phase={savePhase} aria-hidden="true" />}
        <span className="sr-only" data-review-saved-status>{saveStatusDisplay}</span>
      </ReviewTooltipButton> : <div className="review-chrome__save-identity" aria-label={`${documentTitle}, ${saveStatusText}`} title={documentTitle} tabIndex={0}>
        <ReviewIcon name="file" size={16} />
        <span className="review-chrome__filename">{documentTitle}</span>
        {!showSaveStatusDot || savePhase === 'clean' ? null : <span className="review-chrome__save-dot" data-save-phase={savePhase} aria-hidden="true" />}
        <span className="sr-only" data-review-saved-status>{saveStatusDisplay}</span>
      </div>}
      {codexContext === undefined ? null : <div className="review-chrome__context" data-review-context-status><CodexContextStatus status={codexContext} /></div>}
    </div>
    <div className="review-chrome__viewer-controls" role="group" aria-label="PDF editing, navigation, and zoom">
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
