import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import {
  VIEWER_ZOOM_MAX_PERCENT,
  VIEWER_ZOOM_MIN_PERCENT,
  type ViewerControls,
  type ViewerControlsSnapshot,
} from '../pdf/viewer-controls.js';
import { ReviewIcon } from './ReviewIcon.js';
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
  if (!/^\d+$/u.test(normalized)) return undefined;
  const pageNumber = Number(normalized);
  return Number.isSafeInteger(pageNumber) && pageNumber >= 1 && pageNumber <= totalPages
    ? pageNumber
    : undefined;
}

export function validZoomPercent(draft: string): number | undefined {
  const normalized = draft.trim();
  if (!/^\d+$/u.test(normalized)) return undefined;
  const zoomPercent = Number(normalized);
  return Number.isSafeInteger(zoomPercent)
    && zoomPercent >= VIEWER_ZOOM_MIN_PERCENT
    && zoomPercent <= VIEWER_ZOOM_MAX_PERCENT
    ? zoomPercent
    : undefined;
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
  const [documentMenuPending, setDocumentMenuPending] = useState(false);
  const [editingPage, setEditingPage] = useState(false);
  const [pageDraft, setPageDraft] = useState('');
  const [pageInvalid, setPageInvalid] = useState(false);
  const pageTriggerRef = useRef<HTMLButtonElement>(null);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const restorePageTriggerFocus = useRef(false);
  const pageStepIntent = useRef(false);
  const pageErrorId = useId();
  const [editingZoom, setEditingZoom] = useState(false);
  const [zoomDraft, setZoomDraft] = useState('');
  const [zoomInvalid, setZoomInvalid] = useState(false);
  const [fitWidthPending, setFitWidthPending] = useState(false);
  const fitWidthRequestRef = useRef(0);
  const zoomTriggerRef = useRef<HTMLButtonElement>(null);
  const zoomInputRef = useRef<HTMLInputElement>(null);
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
  const historyMenuId = `review-history-menu-${useId().replaceAll(':', '')}`;
  const saveOptionsWereOpen = useRef(saveOptionsOpen);
  const hasChromeActions = codexContext !== undefined;
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
  const pageUnavailable = viewerState.pageReady ? undefined : pageUnavailableId;
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
      setPageInvalid(false);
      setEditingZoom(false);
      setZoomInvalid(false);
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
    pageTriggerRef.current?.focus({ preventScroll: true });
  }, [editingPage]);

  useLayoutEffect(() => {
    if (editingZoom) {
      zoomInputRef.current?.focus({ preventScroll: true });
      zoomInputRef.current?.select();
      return;
    }
    if (!restoreZoomTriggerFocus.current) return;
    restoreZoomTriggerFocus.current = false;
    zoomTriggerRef.current?.focus({ preventScroll: true });
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
    runViewerAction(() => controls?.goToPage(pageNumber));
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

  const pageValue = (inMenu: boolean): ReactNode => viewerState.pageReady ? (
    <span className="review-chrome__page-control" data-review-stat>
      {editingPage ? <>
        <span className="review-chrome__page-editor" data-review-page-editor>
          <input
            ref={pageInputRef}
            className="review-chrome__page-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={viewerState.totalPages}
            step={1}
            aria-label="Page number"
            title="Enter a page number"
            aria-invalid={pageInvalid}
            aria-describedby={pageInvalid ? pageErrorId : undefined}
            aria-errormessage={pageInvalid ? pageErrorId : undefined}
            value={pageDraft}
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
                submitPageEditOnEnter(inMenu);
              }
              if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                closePageEdit(!inMenu);
                if (inMenu) {
                  requestTopBarMenu('navigation', false);
                  restoreTopBarTriggerFocus('navigation');
                }
              }
            }}
          />
          <span aria-hidden="true"> / {viewerState.totalPages}</span>
        </span>
        {pageInvalid ? <span id={pageErrorId} className="review-chrome__page-error" role="alert">
          Enter a whole page number from 1 to {viewerState.totalPages}
        </span> : null}
      </> : <button
        ref={pageTriggerRef}
        type="button"
        role={inMenu ? 'menuitem' : undefined}
        className="review-chrome__page-trigger review-chrome__stat"
        aria-label={`Current page ${viewerState.currentPage} of ${viewerState.totalPages}. Enter a page number`}
        title="Enter a page number"
        onClick={startPageEdit}
      >
        {viewerState.currentPage}<span aria-hidden="true"> / {viewerState.totalPages}</span>
      </button>}
    </span>
  ) : <span
    className="review-chrome__stat"
    data-review-stat
    role={inMenu ? 'menuitem' : undefined}
    aria-disabled={inMenu ? 'true' : undefined}
    aria-label="Current page unavailable"
  >— / —</span>;

  const zoomValue = (inMenu: boolean): ReactNode => viewerState.zoomReady ? (
    <span className="review-chrome__zoom-control" data-review-stat aria-label="Zoom level">
      {editingZoom ? <>
        <span className="review-chrome__zoom-editor" data-review-zoom-editor>
          <input
            ref={zoomInputRef}
            className="review-chrome__zoom-input"
            type="number"
            inputMode="numeric"
            min={VIEWER_ZOOM_MIN_PERCENT}
            max={VIEWER_ZOOM_MAX_PERCENT}
            step={1}
            aria-label="Zoom percentage"
            title="Enter a zoom percentage"
            aria-invalid={zoomInvalid}
            aria-describedby={zoomInvalid ? zoomErrorId : undefined}
            aria-errormessage={zoomInvalid ? zoomErrorId : undefined}
            value={zoomDraft}
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
                submitZoomEditOnEnter(inMenu);
              }
              if (action === 'cancel') {
                event.preventDefault();
                event.stopPropagation();
                closeZoomEdit(!inMenu);
                if (inMenu) {
                  requestTopBarMenu('zoom', false);
                  restoreTopBarTriggerFocus('zoom');
                }
              }
            }}
          />
          <span aria-hidden="true">%</span>
        </span>
        {zoomInvalid ? <span id={zoomErrorId} className="review-chrome__zoom-error" role="alert">
          Enter a whole zoom percentage from {VIEWER_ZOOM_MIN_PERCENT} to {VIEWER_ZOOM_MAX_PERCENT}
        </span> : null}
      </> : <button
        ref={zoomTriggerRef}
        type="button"
        role={inMenu ? 'menuitem' : undefined}
        className="review-chrome__zoom-trigger review-chrome__stat"
        aria-label={`Current zoom ${viewerState.zoomPercent} percent. Enter a zoom percentage`}
        title="Enter a zoom percentage"
        onClick={startZoomEdit}
      >
        {viewerState.zoomPercent}<span aria-hidden="true">%</span>
      </button>}
    </span>
  ) : <span
    className="review-chrome__stat"
    data-review-stat
    role={inMenu ? 'menuitem' : undefined}
    aria-disabled={inMenu ? 'true' : undefined}
    aria-label="Zoom unavailable"
  >—%</span>;

  const historyDirect = <span
    ref={(element) => { historyAnchorRef.current = element; }}
    tabIndex={-1}
    data-review-chrome-group="history"
    className="review-chrome__control-cluster review-chrome__edit-cluster"
    role="group"
    aria-label="Edit history"
  >
    <button type="button" className="review-chrome__icon-control review-chrome__history-control" aria-label="Undo" title="Undo" disabled={!canUndo} onClick={onUndo}><ReviewIcon name="undo" /></button>
    <button type="button" className="review-chrome__icon-control review-chrome__history-control" aria-label="Redo" title="Redo" disabled={!canRedo} onClick={onRedo}><ReviewIcon name="redo" /></button>
  </span>;

  const navigationDirect = <span
    ref={(element) => { navigationAnchorRef.current = element; }}
    tabIndex={-1}
    data-review-chrome-group="navigation"
    className="review-chrome__control-cluster review-chrome__navigation-cluster"
    role="group"
    aria-label="Document navigation"
  >
    <button type="button" className="review-chrome__icon-control review-chrome__main-history-control" data-main-history="back" aria-label="Back in document history" title="Back in document history" disabled={!canNavigateBack} onClick={onNavigateBack}><ReviewIcon name="arrow-left" /></button>
    <button type="button" className="review-chrome__icon-control review-chrome__main-history-control" data-main-history="forward" aria-label="Forward in document history" title="Forward in document history" disabled={!canNavigateForward} onClick={onNavigateForward}><ReviewIcon name="arrow-right" /></button>
    <button type="button" className="review-chrome__icon-control" data-review-page-step="previous" aria-label="Previous page" title="Previous page" aria-describedby={pageUnavailable} disabled={!viewerState.pageReady || viewerState.currentPage <= 1} onPointerDown={preparePageStep} onPointerUp={clearPageStepIntent} onPointerCancel={clearPageStepIntent} onClick={(event) => runPageStep(event.currentTarget, () => controls?.previousPage())}><ReviewIcon name="chevron-left" /></button>
    {pageValue(false)}
    <button type="button" className="review-chrome__icon-control" data-review-page-step="next" aria-label="Next page" title="Next page" aria-describedby={pageUnavailable} disabled={!viewerState.pageReady || viewerState.currentPage >= viewerState.totalPages} onPointerDown={preparePageStep} onPointerUp={clearPageStepIntent} onPointerCancel={clearPageStepIntent} onClick={(event) => runPageStep(event.currentTarget, () => controls?.nextPage())}><ReviewIcon name="chevron-right" /></button>
  </span>;

  const zoomDirect = <span
    ref={(element) => { zoomAnchorRef.current = element; }}
    tabIndex={-1}
    data-review-chrome-group="zoom"
    className="review-chrome__control-cluster review-chrome__zoom-cluster"
    role="group"
    aria-label="PDF zoom"
  >
    <button type="button" className="review-chrome__icon-control" data-review-zoom-action="out" aria-label="Zoom out" title="Zoom out" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onPointerDown={prepareZoomAction} onPointerUp={clearZoomActionIntent} onPointerCancel={clearZoomActionIntent} onClick={(event) => runZoomAction(event.currentTarget, () => controls?.zoomOut())}><ReviewIcon name="minus" /></button>
    <button type="button" className="review-chrome__icon-control" data-review-zoom-action="in" aria-label="Zoom in" title="Zoom in" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onPointerDown={prepareZoomAction} onPointerUp={clearZoomActionIntent} onPointerCancel={clearZoomActionIntent} onClick={(event) => runZoomAction(event.currentTarget, () => controls?.zoomIn())}><ReviewIcon name="plus" /></button>
    {zoomValue(false)}
    <button type="button" className="review-chrome__icon-control review-chrome__fit-width" data-review-zoom-action="fit-width" aria-label="Fit PDF to available width" title="Fit PDF to available width" aria-busy={fitWidthPending ? 'true' : 'false'} aria-describedby={zoomUnavailable ?? (!fitWidthReady ? fitWidthUnavailableId : undefined)} disabled={!viewerState.zoomReady || !fitWidthReady} onPointerDown={prepareZoomAction} onPointerUp={clearZoomActionIntent} onPointerCancel={clearZoomActionIntent} onClick={(event) => runFitWidth(event.currentTarget)}><ReviewIcon name="fit-width" /></button>
  </span>;

  const historyCompact = <>
    <button
      ref={(element) => { historyAnchorRef.current = element; }}
      type="button"
      className="review-chrome__icon-control review-chrome__group-trigger review-chrome__history-trigger"
      data-review-chrome-group="history"
      aria-label="Edit history"
      title="Edit history"
      aria-haspopup="menu"
      aria-expanded={activeTopBarMenu === 'history'}
      aria-controls={historyMenuId}
      onClick={() => requestTopBarMenu('history', activeTopBarMenu !== 'history')}
    >
      <ReviewIcon name="undo" size={14} />
      <ReviewIcon name="redo" size={14} />
    </button>
    <TopBarMenu open={activeTopBarMenu === 'history'} menuId={historyMenuId} label="Edit history" openerRef={historyAnchorRef} onDismiss={() => requestTopBarMenu('history', false)}>
      <div className="review-chrome__control-cluster" role="group" aria-label="Edit history actions">
        <button type="button" role="menuitem" className="review-chrome__icon-control review-chrome__history-control" aria-label="Undo" title="Undo" disabled={!canUndo} onClick={onUndo}><ReviewIcon name="undo" /></button>
        <button type="button" role="menuitem" className="review-chrome__icon-control review-chrome__history-control" aria-label="Redo" title="Redo" disabled={!canRedo} onClick={onRedo}><ReviewIcon name="redo" /></button>
      </div>
    </TopBarMenu>
  </>;

  const navigationCompact = <>
    <button
      ref={(element) => { navigationAnchorRef.current = element; }}
      type="button"
      className="review-chrome__group-trigger review-chrome__stat"
      data-review-chrome-group="navigation"
      data-review-stat
      aria-label={viewerState.pageReady ? `Document navigation, current page ${viewerState.currentPage} of ${viewerState.totalPages}` : 'Document navigation, page unavailable'}
      title="Document navigation"
      aria-haspopup="menu"
      aria-expanded={activeTopBarMenu === 'navigation'}
      aria-controls={navigationMenuId}
      onClick={() => requestTopBarMenu('navigation', activeTopBarMenu !== 'navigation')}
    >{viewerState.pageReady ? <>{viewerState.currentPage}<span aria-hidden="true"> / {viewerState.totalPages}</span></> : '— / —'}</button>
    <TopBarMenu open={activeTopBarMenu === 'navigation'} menuId={navigationMenuId} label="Document navigation" openerRef={navigationAnchorRef} onDismiss={() => requestTopBarMenu('navigation', false)}>
      <div className="review-chrome__control-cluster" role="group" aria-label="Document navigation controls">
        <button type="button" role="menuitem" className="review-chrome__icon-control review-chrome__main-history-control" data-main-history="back" aria-label="Back in document history" title="Back in document history" disabled={!canNavigateBack} onClick={onNavigateBack}><ReviewIcon name="arrow-left" /></button>
        <button type="button" role="menuitem" className="review-chrome__icon-control review-chrome__main-history-control" data-main-history="forward" aria-label="Forward in document history" title="Forward in document history" disabled={!canNavigateForward} onClick={onNavigateForward}><ReviewIcon name="arrow-right" /></button>
        <button type="button" role="menuitem" className="review-chrome__icon-control" data-review-page-step="previous" aria-label="Previous page" title="Previous page" aria-describedby={pageUnavailable} disabled={!viewerState.pageReady || viewerState.currentPage <= 1} onPointerDown={preparePageStep} onPointerUp={clearPageStepIntent} onPointerCancel={clearPageStepIntent} onClick={(event) => runPageStep(event.currentTarget, () => controls?.previousPage())}><ReviewIcon name="chevron-left" /></button>
        {pageValue(true)}
        <button type="button" role="menuitem" className="review-chrome__icon-control" data-review-page-step="next" aria-label="Next page" title="Next page" aria-describedby={pageUnavailable} disabled={!viewerState.pageReady || viewerState.currentPage >= viewerState.totalPages} onPointerDown={preparePageStep} onPointerUp={clearPageStepIntent} onPointerCancel={clearPageStepIntent} onClick={(event) => runPageStep(event.currentTarget, () => controls?.nextPage())}><ReviewIcon name="chevron-right" /></button>
      </div>
    </TopBarMenu>
  </>;

  const zoomCompact = <>
    <button
      ref={(element) => { zoomAnchorRef.current = element; }}
      type="button"
      className="review-chrome__group-trigger review-chrome__stat"
      data-review-chrome-group="zoom"
      data-review-stat
      aria-label={viewerState.zoomReady ? `PDF zoom, current zoom ${viewerState.zoomPercent} percent` : 'PDF zoom unavailable'}
      title="PDF zoom"
      aria-haspopup="menu"
      aria-expanded={activeTopBarMenu === 'zoom'}
      aria-controls={zoomMenuId}
      onClick={() => requestTopBarMenu('zoom', activeTopBarMenu !== 'zoom')}
    >{viewerState.zoomReady ? <>{viewerState.zoomPercent}<span aria-hidden="true">%</span></> : '—%'}</button>
    <TopBarMenu open={activeTopBarMenu === 'zoom'} menuId={zoomMenuId} label="PDF zoom" openerRef={zoomAnchorRef} onDismiss={() => requestTopBarMenu('zoom', false)}>
      <div className="review-chrome__control-cluster" role="group" aria-label="Zoom controls">
        <button type="button" role="menuitem" className="review-chrome__icon-control" data-review-zoom-action="out" aria-label="Zoom out" title="Zoom out" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onPointerDown={prepareZoomAction} onPointerUp={clearZoomActionIntent} onPointerCancel={clearZoomActionIntent} onClick={(event) => runZoomAction(event.currentTarget, () => controls?.zoomOut())}><ReviewIcon name="minus" /></button>
        <button type="button" role="menuitem" className="review-chrome__icon-control" data-review-zoom-action="in" aria-label="Zoom in" title="Zoom in" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onPointerDown={prepareZoomAction} onPointerUp={clearZoomActionIntent} onPointerCancel={clearZoomActionIntent} onClick={(event) => runZoomAction(event.currentTarget, () => controls?.zoomIn())}><ReviewIcon name="plus" /></button>
        {zoomValue(true)}
        <button type="button" role="menuitem" className="review-chrome__icon-control review-chrome__fit-width" data-review-zoom-action="fit-width" aria-label="Fit PDF to available width" title="Fit PDF to available width" aria-busy={fitWidthPending ? 'true' : 'false'} aria-describedby={zoomUnavailable ?? (!fitWidthReady ? fitWidthUnavailableId : undefined)} disabled={!viewerState.zoomReady || !fitWidthReady} onPointerDown={prepareZoomAction} onPointerUp={clearZoomActionIntent} onPointerCancel={clearZoomActionIntent} onClick={(event) => runFitWidth(event.currentTarget, true)}><ReviewIcon name="fit-width" /></button>
      </div>
    </TopBarMenu>
  </>;

  const controlsForPresentation = (candidate: ReviewChromePresentation): ReactNode => <>
    {candidate === 'expanded' ? historyDirect : historyCompact}
    {candidate === 'navigationCompact' ? navigationCompact : navigationDirect}
    {candidate === 'expanded' || candidate === 'historyCompact' ? zoomDirect : zoomCompact}
  </>;

  const sizingCluster = (candidate: ReviewChromePresentation): ReactNode => <div className="review-chrome__viewer-controls" style={{ display: 'inline-flex', gridColumn: 'auto', gridRow: 'auto', flexWrap: 'nowrap' }}>
    <span className="review-chrome__control-cluster">{candidate === 'expanded' ? <><button type="button" title="Undo" className="review-chrome__icon-control"><ReviewIcon name="undo" /></button><button type="button" title="Redo" className="review-chrome__icon-control"><ReviewIcon name="redo" /></button></> : <button type="button" title="Edit history" className="review-chrome__icon-control review-chrome__history-trigger"><ReviewIcon name="undo" size={14} /><ReviewIcon name="redo" size={14} /></button>}</span>
    <span className="review-chrome__control-cluster">{candidate === 'navigationCompact' ? <button type="button" title="Document navigation" className="review-chrome__stat">{viewerState.pageReady ? `${viewerState.currentPage} / ${viewerState.totalPages}` : '— / —'}</button> : <><button type="button" title="Back in document history" className="review-chrome__icon-control"><ReviewIcon name="arrow-left" /></button><button type="button" title="Forward in document history" className="review-chrome__icon-control"><ReviewIcon name="arrow-right" /></button><button type="button" title="Previous page" className="review-chrome__icon-control"><ReviewIcon name="chevron-left" /></button><span className="review-chrome__stat">{viewerState.pageReady ? `${viewerState.currentPage} / ${viewerState.totalPages}` : '— / —'}</span><button type="button" title="Next page" className="review-chrome__icon-control"><ReviewIcon name="chevron-right" /></button></>}</span>
    <span className="review-chrome__control-cluster">{candidate === 'expanded' || candidate === 'historyCompact' ? <><button type="button" title="Zoom out" className="review-chrome__icon-control"><ReviewIcon name="minus" /></button><button type="button" title="Zoom in" className="review-chrome__icon-control"><ReviewIcon name="plus" /></button><span className="review-chrome__stat">{viewerState.zoomReady ? `${viewerState.zoomPercent}%` : '—%'}</span><button type="button" title="Fit PDF to available width" className="review-chrome__icon-control"><ReviewIcon name="fit-width" /></button></> : <button type="button" title="PDF zoom" className="review-chrome__stat">{viewerState.zoomReady ? `${viewerState.zoomPercent}%` : '—%'}</button>}</span>
  </div>;

  const sizingIdentity = <div className="review-chrome__identity">
    {documentActions !== undefined ? <div className="document-actions"><button type="button" className="review-chrome__save-identity document-actions__trigger" title="Open document actions"><span className="review-chrome__save-dot" data-save-phase={savePhase} /><strong>{documentTitle}</strong>{savePendingDestination ? <span className="review-chrome__save-recovery">Protected Recovery</span> : null}</button></div> : saveOptionsAvailable ? <button type="button" className="review-chrome__save-identity" title="Open automatic save options"><span className="review-chrome__save-dot" data-save-phase={savePhase} /><strong>{documentTitle}</strong>{savePendingDestination ? <span className="review-chrome__save-recovery">Protected Recovery</span> : null}</button> : <div className="review-chrome__save-identity"><span className="review-chrome__save-dot" data-save-phase={savePhase} /><strong>{documentTitle}</strong></div>}
    {copyLink === undefined ? null : <div className="review-chrome__link"><button type="button" title="Copy document link" className="review-chrome__icon-control"><ReviewIcon name="link" /></button></div>}
  </div>;

  return <header
    ref={chromeRef}
    className="review-chrome"
    data-review-chrome
    data-review-chrome-presentation={presentation}
    data-review-chrome-actions={hasChromeActions ? 'present' : 'none'}
    data-top-bar-menu-open={activeTopBarMenu ?? undefined}
  >
    <div className="review-chrome__identity">
      {documentActions !== undefined ? <DocumentActionsMenu
        {...documentActions}
        documentTitle={documentTitle}
        savedLabel={savedLabel}
        savePhase={savePhase}
        open={activeTopBarMenu === 'document'}
        onOpenChange={(open) => requestTopBarMenu('document', open)}
        onPendingChange={(pending) => {
          setDocumentMenuPending(pending);
          if (pending) setActiveTopBarMenu('document');
        }}
      /> : saveOptionsAvailable ? <button ref={saveTriggerRef} type="button" className="review-chrome__save-identity" aria-label={saveControlLabel} aria-haspopup="dialog" aria-expanded={saveOptionsOpen} title={saveControlLabel} onClick={onSaveOptions}>
        <span className="review-chrome__save-dot" data-save-phase={savePhase} aria-hidden="true" />
        <strong>{documentTitle}</strong>
        {savePendingDestination ? <span className="review-chrome__save-recovery">Protected Recovery</span> : null}
        <span className="sr-only" data-review-saved-status>{saveStatusDisplay}</span>
      </button> : <div className="review-chrome__save-identity" aria-label={`${documentTitle}, ${saveStatusText}`}>
        <span className="review-chrome__save-dot" data-save-phase={savePhase} aria-hidden="true" />
        <strong>{documentTitle}</strong>
        <span className="sr-only" data-review-saved-status>{saveStatusDisplay}</span>
      </div>}
      {copyLink === undefined ? null : <div className="review-chrome__link" data-review-copy-link><CopyLinkControl {...copyLink} /></div>}
    </div>
    <div className="review-chrome__viewer-controls" role="group" aria-label="PDF editing, navigation, and zoom">
      {controlsForPresentation(presentation)}
    </div>
    <div className="review-chrome__actions">
      {codexContext === undefined ? null : <div className="review-chrome__context" data-review-context-status><CodexContextStatus status={codexContext} /></div>}
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
        data-review-chrome-actions={hasChromeActions ? 'present' : 'none'}
        style={{
          position: 'absolute',
          display: 'inline-grid',
          gridTemplateColumns: hasChromeActions ? 'max-content max-content max-content' : 'max-content max-content',
          gridTemplateRows: 'max-content',
          width: 'max-content',
          height: 'var(--review-chrome-height)',
        }}
      >
        {sizingIdentity}
        {sizingCluster(candidate)}
        <div className="review-chrome__actions">{codexContext === undefined ? null : <div className="review-chrome__context"><div className="codex-context-status"><ReviewIcon name="agent" size={16} /></div></div>}</div>
      </div>)}
    </div>
    {!viewerState.pageReady ? <p id={pageUnavailableId} className="sr-only">{viewerState.pageUnavailableReason}</p> : null}
    {!viewerState.zoomReady ? <p id={zoomUnavailableId} className="sr-only">{viewerState.zoomUnavailableReason}</p> : null}
    {viewerState.zoomReady && !fitWidthReady ? <p id={fitWidthUnavailableId} className="sr-only">Fit Width becomes available when PDF navigation is ready.</p> : null}
  </header>;
}
