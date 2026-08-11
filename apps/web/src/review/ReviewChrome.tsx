import { useId, useLayoutEffect, useRef, useState } from 'react';

import type { ViewerControls, ViewerControlsSnapshot } from '../pdf/viewer-controls.js';
import { ReviewIcon } from './ReviewIcon.js';

export function validPageNumber(draft: string, totalPages: number): number | undefined {
  const normalized = draft.trim();
  if (!/^\d+$/u.test(normalized)) return undefined;
  const pageNumber = Number(normalized);
  return Number.isSafeInteger(pageNumber) && pageNumber >= 1 && pageNumber <= totalPages
    ? pageNumber
    : undefined;
}

export interface ReviewChromeProps {
  readonly documentTitle: string;
  readonly savedLabel?: string;
  readonly destinationTitle?: string;
  readonly savePhase?: 'clean' | 'saving' | 'not-saved';
  readonly controls?: ViewerControls;
  readonly viewerState: ViewerControlsSnapshot;
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
  readonly onSaveOptions?: () => void;
}

export function ReviewChrome({
  documentTitle,
  savedLabel = 'Saved',
  destinationTitle,
  savePhase = 'clean',
  controls,
  viewerState,
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
  onSaveOptions = () => undefined,
}: ReviewChromeProps) {
  const [editingPage, setEditingPage] = useState(false);
  const [pageDraft, setPageDraft] = useState('');
  const [pageInvalid, setPageInvalid] = useState(false);
  const pageTriggerRef = useRef<HTMLButtonElement>(null);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const restorePageTriggerFocus = useRef(false);
  const pageStepIntent = useRef(false);
  const pageErrorId = useId();
  const pageUnavailableId = 'viewer-page-controls-readiness';
  const zoomUnavailableId = 'viewer-zoom-controls-readiness';
  const pageUnavailable = viewerState.pageReady ? undefined : pageUnavailableId;
  const zoomUnavailable = viewerState.zoomReady ? undefined : zoomUnavailableId;

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
    controls?.goToPage(pageNumber);
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
    step();
  };

  return (
    <header className="review-chrome" data-review-chrome>
      <div className="review-chrome__identity">
        <button
          type="button"
          className="review-chrome__save-identity"
          aria-label={`Save options for ${documentTitle}${destinationTitle ? `, saving to ${destinationTitle}` : ''}${savePhase === 'not-saved' ? ', not saved' : savePhase === 'saving' ? ', saving' : ''}`}
          onClick={onSaveOptions}
        >
          <ReviewIcon name="download" size={17} />
          <span className="review-chrome__identity-copy">
            <strong title={documentTitle}>{documentTitle}</strong>
            {destinationTitle ? <small title={destinationTitle}>{destinationTitle}</small> : null}
          </span>
          {savePhase === 'saving' ? <span className="review-chrome__saved" data-review-saved-status>Saving…</span> : null}
          {savePhase === 'not-saved' ? <span className="review-chrome__not-saved" data-review-saved-status>Not saved</span> : null}
          {savePhase === 'clean' ? <span className="sr-only" data-review-saved-status>{savedLabel}</span> : null}
        </button>
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
        <button type="button" className="review-chrome__icon-control" aria-label="Zoom out" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onClick={() => controls?.zoomOut()}><ReviewIcon name="minus" /></button>
        <span className="review-chrome__stat" data-review-stat aria-label="Zoom level">{viewerState.zoomReady ? `${viewerState.zoomPercent}%` : '—%'}</span>
        <button type="button" className="review-chrome__icon-control" aria-label="Zoom in" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onClick={() => controls?.zoomIn()}><ReviewIcon name="plus" /></button>
        <span className="review-chrome__history-cluster" role="group" aria-label="Document and edit history">
          <button type="button" className="review-chrome__icon-control review-chrome__main-history-control" data-main-history="back" aria-label="Back in document history" disabled={!canNavigateBack} onClick={onNavigateBack}><ReviewIcon name="arrow-left" /></button>
          <button type="button" className="review-chrome__icon-control review-chrome__main-history-control" data-main-history="forward" aria-label="Forward in document history" disabled={!canNavigateForward} onClick={onNavigateForward}><ReviewIcon name="arrow-right" /></button>
          <button type="button" className="review-chrome__icon-control review-chrome__history-control" aria-label="Undo" disabled={!canUndo} onClick={onUndo}><ReviewIcon name="undo" /></button>
          <button type="button" className="review-chrome__icon-control review-chrome__history-control" aria-label="Redo" disabled={!canRedo} onClick={onRedo}><ReviewIcon name="redo" /></button>
        </span>
      </div>
      <nav className="review-chrome__actions" aria-label="Actions">
        <button type="button" className="review-chrome__finish" aria-expanded={finishOpen} aria-controls="review-finish-drawer" onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); onFinish(); }}>Codex</button>
      </nav>
      {!viewerState.pageReady ? <p id={pageUnavailableId} className="sr-only">{viewerState.pageUnavailableReason}</p> : null}
      {!viewerState.zoomReady ? <p id={zoomUnavailableId} className="sr-only">{viewerState.zoomUnavailableReason}</p> : null}
    </header>
  );
}
