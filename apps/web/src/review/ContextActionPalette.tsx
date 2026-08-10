import type { CSSProperties } from 'react';

import { ReviewIcon } from './ReviewIcon.js';
import { reviewActions } from './review-actions.js';

type ContextActionKind = 'replace' | 'delete' | 'highlight' | 'insert';

interface ContextActionButtonProps {
  readonly kind: ContextActionKind;
  readonly iconOnly?: boolean;
  readonly onAction: (() => void) | undefined;
}

function ContextActionButton({ kind, iconOnly = false, onAction }: ContextActionButtonProps) {
  const action = reviewActions.find((candidate) => candidate.kind === kind)!;
  return (
    <button
      type="button"
      className={`review-action-button${iconOnly ? ' review-action-button--icon' : ''}`}
      {...(iconOnly ? { 'aria-label': action.label, title: action.label } : {})}
      aria-keyshortcuts={action.shortcut}
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        onAction?.();
      }}
    >
      <ReviewIcon name={kind} />
      {iconOnly ? null : action.label}
    </button>
  );
}

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
          <ContextActionButton kind="replace" iconOnly onAction={props.onReplace} />
          <ContextActionButton kind="delete" iconOnly onAction={props.onDelete} />
          <ContextActionButton kind="highlight" iconOnly onAction={props.onHighlight} />
        </>
      ) : (
        <ContextActionButton kind="insert" onAction={props.onInsert} />
      )}
    </div>
  );
}
