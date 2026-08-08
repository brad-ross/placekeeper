import type { ViewerControls, ViewerControlsSnapshot } from '../pdf/viewer-controls.js';

export interface ReviewChromeProps {
  readonly documentTitle: string;
  readonly savedLabel?: string;
  readonly controls?: ViewerControls;
  readonly viewerState: ViewerControlsSnapshot;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly annotationCount: number;
  readonly annotationsOpen: boolean;
  readonly finishOpen: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onAnnotations: () => void;
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
  annotationsOpen,
  finishOpen,
  onUndo,
  onRedo,
  onAnnotations,
  onFinish,
}: ReviewChromeProps) {
  const pageUnavailableId = 'viewer-page-controls-readiness';
  const zoomUnavailableId = 'viewer-zoom-controls-readiness';
  const pageUnavailable = viewerState.pageReady ? undefined : pageUnavailableId;
  const zoomUnavailable = viewerState.zoomReady ? undefined : zoomUnavailableId;
  return (
    <header className="review-chrome" data-review-chrome>
      <div className="review-chrome__identity">
        <h1>{documentTitle}</h1>
        <span className="review-chrome__saved">{savedLabel}</span>
      </div>
      <div className="review-chrome__viewer-controls" role="group" aria-label="PDF navigation and zoom">
        <button type="button" aria-label="Previous page" aria-describedby={pageUnavailable} disabled={!viewerState.pageReady || viewerState.currentPage <= 1} onClick={() => controls?.previousPage()}>‹</button>
        <span aria-label="Current page">{viewerState.pageReady ? `${viewerState.currentPage} / ${viewerState.totalPages}` : '— / —'}</span>
        <button type="button" aria-label="Next page" aria-describedby={pageUnavailable} disabled={!viewerState.pageReady || viewerState.currentPage >= viewerState.totalPages} onClick={() => controls?.nextPage()}>›</button>
        <button type="button" aria-label="Zoom out" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onClick={() => controls?.zoomOut()}>−</button>
        <span aria-label="Zoom level">{viewerState.zoomReady ? `${viewerState.zoomPercent}%` : '—%'}</span>
        <button type="button" aria-label="Zoom in" aria-describedby={zoomUnavailable} disabled={!viewerState.zoomReady} onClick={() => controls?.zoomIn()}>+</button>
      </div>
      <nav className="review-chrome__actions" aria-label="Review views">
        <button type="button" aria-label="Undo" disabled={!canUndo} onClick={onUndo}>↶</button>
        <button type="button" aria-label="Redo" disabled={!canRedo} onClick={onRedo}>↷</button>
        <button type="button" aria-expanded={annotationsOpen} aria-controls="review-annotation-list" onClick={onAnnotations}>Annotations ({annotationCount})</button>
        <button type="button" className="review-chrome__finish" aria-expanded={finishOpen} aria-controls="review-finish-drawer" onClick={onFinish}>Finish</button>
      </nav>
      {!viewerState.pageReady ? <p id={pageUnavailableId} className="sr-only">{viewerState.pageUnavailableReason}</p> : null}
      {!viewerState.zoomReady ? <p id={zoomUnavailableId} className="sr-only">{viewerState.zoomUnavailableReason}</p> : null}
    </header>
  );
}
