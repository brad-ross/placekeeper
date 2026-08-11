import { useId, useLayoutEffect, useRef, useState } from 'react';

import {
  VIEWER_ZOOM_MAX_PERCENT,
  VIEWER_ZOOM_MIN_PERCENT,
  type ViewerControls,
  type ViewerControlsSnapshot,
} from '../pdf/viewer-controls.js';
import { ReviewIcon } from './ReviewIcon.js';

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

export interface ReviewChromeProps {
  readonly documentTitle: string;
  readonly savedLabel?: string;
  readonly controls?: ViewerControls;
  readonly viewerState: ViewerControlsSnapshot;
  readonly fitWidthReady?: boolean;
  readonly onFitWidth?: () => void;
  readonly beforeViewerAction?: () => Promise<void>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly canNavigateBack?: boolean;
  readonly canNavigateForward?: boolean;
  readonly finishOpen: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onNavigateBack?: () => void;
  readonly onNavigateForward?: () => void;
  readonly onFinish: () => void;
}

export function ReviewChrome({
  documentTitle,
  savedLabel = 'Saved',
  controls,
  viewerState,
  fitWidthReady = false,
  onFitWidth = () => undefined,
  beforeViewerAction,
  canUndo,
  canRedo,
  canNavigateBack = false,
  canNavigateForward = false,
  finishOpen,
  onUndo,
  onRedo,
  onNavigateBack = () => undefined,
  onNavigateForward = () => undefined,
  onFinish,
}: ReviewChromeProps) {
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
  const zoomTriggerRef = useRef<HTMLButtonElement>(null);
  const zoomInputRef = useRef<HTMLInputElement>(null);
  const restoreZoomTriggerFocus = useRef(false);
  const zoomActionIntent = useRef(false);
  const zoomErrorId = useId();
  const pageUnavailableId = 'viewer-page-controls-readiness';
  const zoomUnavailableId = 'viewer-zoom-controls-readiness';
  const fitWidthUnavailableId = 'viewer-fit-width-readiness';
  const pageUnavailable = viewerState.pageReady ? undefined : pageUnavailableId;
  const zoomUnavailable = viewerState.zoomReady ? undefined : zoomUnavailableId;
  const runViewerAction = (action: () => void) => {
    if (!beforeViewerAction) {
      action();
      return;
    }
    void beforeViewerAction().then(action);
  };

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
  const submitPageEditOnEnter = () => {
    if (!goToDraftPage()) {
      setPageInvalid(true);
      return;
    }
    closePageEdit(true);
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
  const submitZoomEditOnEnter = () => {
    if (!zoomToDraftPercent()) {
      setZoomInvalid(true);
      return;
    }
    closeZoomEdit(true);
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

  return (
    <header className="review-chrome" data-review-chrome>
      <div className="review-chrome__identity">
        <span className="review-chrome__file-badge" data-review-file-badge aria-hidden="true">
          <ReviewIcon name="file" size={14} />
        </span>
        <h1>{documentTitle}</h1>
        <span className="review-chrome__saved" data-review-saved-status>{savedLabel}</span>
      </div>
      <div className="review-chrome__viewer-controls" role="group" aria-label="PDF navigation, zoom, and history">
        <button type="button" className="review-chrome__icon-control" data-review-page-step="previous" aria-label="Previous page" aria-describedby={pageUnavailable} disabled={!viewerState.pageReady || viewerState.currentPage <= 1} onPointerDown={preparePageStep} onPointerUp={clearPageStepIntent} onPointerCancel={clearPageStepIntent} onClick={(event) => runPageStep(event.currentTarget, () => controls?.previousPage())}><ReviewIcon name="chevron-left" /></button>
        {viewerState.pageReady ? (
          <span className="review-chrome__page-control" data-review-stat>
            {editingPage ? (
              <>
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
                      } else {
                        submitPageEditOnBlur();
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        submitPageEditOnEnter();
                      }
                      if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        event.stopPropagation();
                        closePageEdit(true);
                      }
                    }}
                  />
                  <span aria-hidden="true"> / {viewerState.totalPages}</span>
                </span>
                {pageInvalid ? (
                  <span id={pageErrorId} className="review-chrome__page-error" role="alert">
                    Enter a whole page number from 1 to {viewerState.totalPages}
                  </span>
                ) : null}
              </>
            ) : (
              <button
                ref={pageTriggerRef}
                type="button"
                className="review-chrome__page-trigger review-chrome__stat"
                aria-label={`Current page ${viewerState.currentPage} of ${viewerState.totalPages}. Enter a page number`}
                onClick={startPageEdit}
              >
                {viewerState.currentPage}<span aria-hidden="true"> / {viewerState.totalPages}</span>
              </button>
            )}
          </span>
        ) : (
          <span className="review-chrome__stat" data-review-stat aria-label="Current page">— / —</span>
        )}
        <button type="button" className="review-chrome__icon-control" data-review-page-step="next" aria-label="Next page" aria-describedby={pageUnavailable} disabled={!viewerState.pageReady || viewerState.currentPage >= viewerState.totalPages} onPointerDown={preparePageStep} onPointerUp={clearPageStepIntent} onPointerCancel={clearPageStepIntent} onClick={(event) => runPageStep(event.currentTarget, () => controls?.nextPage())}><ReviewIcon name="chevron-right" /></button>
        <button type="button" className="review-chrome__icon-control" data-review-zoom-action="out" aria-label="Zoom out" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onPointerDown={prepareZoomAction} onPointerUp={clearZoomActionIntent} onPointerCancel={clearZoomActionIntent} onClick={(event) => runZoomAction(event.currentTarget, () => controls?.zoomOut())}><ReviewIcon name="minus" /></button>
        {viewerState.zoomReady ? (
          <span className="review-chrome__zoom-control" data-review-stat aria-label="Zoom level">
            {editingZoom ? (
              <>
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
                      } else {
                        submitZoomEditOnBlur();
                      }
                    }}
                    onKeyDown={(event) => {
                      const action = zoomEditorKeyAction(
                        event.key,
                        event.nativeEvent.isComposing,
                      );
                      if (action === 'submit') {
                        event.preventDefault();
                        submitZoomEditOnEnter();
                      }
                      if (action === 'cancel') {
                        event.preventDefault();
                        event.stopPropagation();
                        closeZoomEdit(true);
                      }
                    }}
                  />
                  <span aria-hidden="true">%</span>
                </span>
                {zoomInvalid ? (
                  <span id={zoomErrorId} className="review-chrome__zoom-error" role="alert">
                    Enter a whole zoom percentage from {VIEWER_ZOOM_MIN_PERCENT} to {VIEWER_ZOOM_MAX_PERCENT}
                  </span>
                ) : null}
              </>
            ) : (
              <button
                ref={zoomTriggerRef}
                type="button"
                className="review-chrome__zoom-trigger review-chrome__stat"
                aria-label={`Current zoom ${viewerState.zoomPercent} percent. Enter a zoom percentage`}
                onClick={startZoomEdit}
              >
                {viewerState.zoomPercent}<span aria-hidden="true">%</span>
              </button>
            )}
          </span>
        ) : (
          <span className="review-chrome__stat" data-review-stat aria-label="Zoom level">—%</span>
        )}
        <button type="button" className="review-chrome__icon-control" data-review-zoom-action="in" aria-label="Zoom in" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onPointerDown={prepareZoomAction} onPointerUp={clearZoomActionIntent} onPointerCancel={clearZoomActionIntent} onClick={(event) => runZoomAction(event.currentTarget, () => controls?.zoomIn())}><ReviewIcon name="plus" /></button>
        <button type="button" className="review-chrome__icon-control review-chrome__fit-width" data-review-zoom-action="fit-width" aria-label="Fit PDF to available width" aria-describedby={zoomUnavailable ?? (!fitWidthReady ? fitWidthUnavailableId : undefined)} disabled={!viewerState.zoomReady || !fitWidthReady} onPointerDown={prepareZoomAction} onPointerUp={clearZoomActionIntent} onPointerCancel={clearZoomActionIntent} onClick={(event) => runZoomAction(event.currentTarget, onFitWidth)}><ReviewIcon name="fit-width" /></button>
        <span className="review-chrome__history-cluster" role="group" aria-label="Document and edit history">
          <button type="button" className="review-chrome__icon-control review-chrome__main-history-control" data-main-history="back" aria-label="Back in document history" disabled={!canNavigateBack} onClick={onNavigateBack}><ReviewIcon name="arrow-left" /></button>
          <button type="button" className="review-chrome__icon-control review-chrome__main-history-control" data-main-history="forward" aria-label="Forward in document history" disabled={!canNavigateForward} onClick={onNavigateForward}><ReviewIcon name="arrow-right" /></button>
          <button type="button" className="review-chrome__icon-control review-chrome__history-control" aria-label="Undo" disabled={!canUndo} onClick={onUndo}><ReviewIcon name="undo" /></button>
          <button type="button" className="review-chrome__icon-control review-chrome__history-control" aria-label="Redo" disabled={!canRedo} onClick={onRedo}><ReviewIcon name="redo" /></button>
        </span>
      </div>
      <nav className="review-chrome__actions" aria-label="Review views">
        <button type="button" className="review-chrome__finish" aria-expanded={finishOpen} aria-controls="review-finish-drawer" onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); onFinish(); }}>Finish</button>
      </nav>
      {!viewerState.pageReady ? <p id={pageUnavailableId} className="sr-only">{viewerState.pageUnavailableReason}</p> : null}
      {!viewerState.zoomReady ? <p id={zoomUnavailableId} className="sr-only">{viewerState.zoomUnavailableReason}</p> : null}
      {viewerState.zoomReady && !fitWidthReady ? <p id={fitWidthUnavailableId} className="sr-only">Fit Width becomes available when PDF navigation is ready.</p> : null}
    </header>
  );
}
