import type { CSSProperties } from 'react';

import { shortcutForReviewAction } from './review-actions.js';

export interface ContextPlacement {
  readonly left: number;
  readonly top: number;
  readonly suggestTop?: boolean;
}

export interface ContextActionPaletteProps {
  readonly kind: 'selection' | 'insert';
  readonly placement: ContextPlacement;
  readonly hidden?: boolean;
  onReplace?(): void;
  onDelete?(): void;
  onHighlight?(): void;
  onInsert?(): void;
}

export function ContextActionPalette(props: ContextActionPaletteProps) {
  const style: CSSProperties = {
    left: props.placement.left,
    top: props.placement.top,
    transform: props.placement.suggestTop ? 'translate(-50%, calc(-100% - .45rem))' : 'translate(-50%, .45rem)',
  };
  return (
    <div
      role="toolbar"
      aria-label={props.kind === 'selection' ? 'Selection review actions' : 'Insertion review action'}
      className="review-context-palette"
      data-review-contextual-ui
      hidden={props.hidden}
      inert={props.hidden}
      style={style}
    >
      {props.kind === 'selection' ? (
        <>
          <button type="button" aria-keyshortcuts={shortcutForReviewAction('replace')} onClick={props.onReplace}>Replace</button>
          <button type="button" aria-keyshortcuts={shortcutForReviewAction('delete')} onClick={props.onDelete}>Delete</button>
          <button type="button" aria-keyshortcuts={shortcutForReviewAction('highlight')} onClick={props.onHighlight}>Highlight</button>
        </>
      ) : (
        <button type="button" aria-keyshortcuts={shortcutForReviewAction('insert')} onClick={props.onInsert}>Insert</button>
      )}
    </div>
  );
}
