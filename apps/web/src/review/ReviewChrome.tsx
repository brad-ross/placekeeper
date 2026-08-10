import type { ViewerControls, ViewerControlsSnapshot } from '../pdf/viewer-controls.js';
import type { RefObject } from 'react';
import { ReviewIcon } from './ReviewIcon.js';

export interface ReviewChromeProps {
  readonly documentTitle: string;
  readonly savedLabel?: string;
  readonly controls?: ViewerControls;
  readonly viewerState: ViewerControlsSnapshot;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly annotationCount: number;
  readonly workspaceOpen: boolean;
  readonly finishOpen: boolean;
  readonly workspaceControlRef?: RefObject<HTMLButtonElement | null>;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onWorkspace: () => void;
  readonly onFinish: () => void;
}

export function ReviewChrome({
  documentTitle,
  savedLabel = 'Saved',
  controls,
  viewerState,
  canUndo,
  canRedo,
  annotationCount,
  workspaceOpen,
  finishOpen,
  workspaceControlRef,
  onUndo,
  onRedo,
  onWorkspace,
  onFinish,
}: ReviewChromeProps) {
  const pageUnavailableId = 'viewer-page-controls-readiness';
  const zoomUnavailableId = 'viewer-zoom-controls-readiness';
  const pageUnavailable = viewerState.pageReady ? undefined : pageUnavailableId;
  const zoomUnavailable = viewerState.zoomReady ? undefined : zoomUnavailableId;
  return (
    <header className="review-chrome" data-review-chrome>
      <div className="review-chrome__identity">
        <span className="review-chrome__file-badge" data-review-file-badge aria-hidden="true">
          <ReviewIcon name="file" size={14} />
        </span>
        <h1>{documentTitle}</h1>
        <span className="review-chrome__saved" data-review-saved-status>{savedLabel}</span>
      </div>
      <div className="review-chrome__viewer-controls" role="group" aria-label="PDF navigation and zoom">
        <button type="button" className="review-chrome__icon-control" aria-label="Previous page" aria-describedby={pageUnavailable} disabled={!viewerState.pageReady || viewerState.currentPage <= 1} onClick={() => controls?.previousPage()}><ReviewIcon name="chevron-left" /></button>
        <span className="review-chrome__stat" data-review-stat aria-label="Current page">{viewerState.pageReady ? `${viewerState.currentPage} / ${viewerState.totalPages}` : '— / —'}</span>
        <button type="button" className="review-chrome__icon-control" aria-label="Next page" aria-describedby={pageUnavailable} disabled={!viewerState.pageReady || viewerState.currentPage >= viewerState.totalPages} onClick={() => controls?.nextPage()}><ReviewIcon name="chevron-right" /></button>
        <button type="button" className="review-chrome__icon-control" aria-label="Zoom out" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onClick={() => controls?.zoomOut()}><ReviewIcon name="minus" /></button>
        <span className="review-chrome__stat" data-review-stat aria-label="Zoom level">{viewerState.zoomReady ? `${viewerState.zoomPercent}%` : '—%'}</span>
        <button type="button" className="review-chrome__icon-control" aria-label="Zoom in" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onClick={() => controls?.zoomIn()}><ReviewIcon name="plus" /></button>
      </div>
      <nav className="review-chrome__actions" aria-label="Review views">
        <button type="button" className="review-chrome__icon-control review-chrome__history-control" aria-label="Undo" disabled={!canUndo} onClick={onUndo}><ReviewIcon name="undo" /></button>
        <button type="button" className="review-chrome__icon-control review-chrome__history-control" aria-label="Redo" disabled={!canRedo} onClick={onRedo}><ReviewIcon name="redo" /></button>
        <button ref={workspaceControlRef} type="button" className="review-chrome__workspace" aria-label={`Workspace (${annotationCount} annotations)`} aria-expanded={workspaceOpen} aria-controls="review-workspace" onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); onWorkspace(); }}>
          <span>Workspace</span>
          <span className="review-chrome__count" data-review-count aria-hidden="true">{annotationCount}</span>
        </button>
        <button type="button" className="review-chrome__finish" aria-expanded={finishOpen} aria-controls="review-finish-drawer" onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); onFinish(); }}>Finish</button>
      </nav>
      {!viewerState.pageReady ? <p id={pageUnavailableId} className="sr-only">{viewerState.pageUnavailableReason}</p> : null}
      {!viewerState.zoomReady ? <p id={zoomUnavailableId} className="sr-only">{viewerState.zoomUnavailableReason}</p> : null}
    </header>
  );
}
