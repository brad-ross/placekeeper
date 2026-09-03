import type { CSSProperties } from 'react';

import { ReviewIcon } from './ReviewIcon.js';
import { reviewActions } from './review-actions.js';

type ContextActionKind = 'copy' | 'replace' | 'delete' | 'highlight';

const copyAction = {
  kind: 'copy',
  label: 'Copy',
  shortcut: 'Meta+C Control+C',
} as const;

interface ContextActionButtonProps {
  readonly kind: ContextActionKind;
  readonly iconOnly?: boolean;
  readonly onAction: (() => void) | undefined;
}

function ContextActionButton({ kind, iconOnly = false, onAction }: ContextActionButtonProps) {
  const action = kind === 'copy'
    ? copyAction
    : reviewActions.find((candidate) => candidate.kind === kind)!;
  return (
    <button
      type="button"
      className={`review-action-button${iconOnly ? ' review-action-button--icon' : ''}`}
      {...(iconOnly ? { 'aria-label': action.label } : {})}
      title={action.label}
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
  readonly width?: number;
  readonly height?: number;
  readonly suggestTop?: boolean;
}

export interface ContextActionPaletteProps {
  readonly placement: ContextPlacement;
  readonly hidden?: boolean;
  onCopy?(): void;
  onReplace?(): void;
  onDelete?(): void;
  onHighlight?(): void;
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
      aria-label="Selection review actions"
      className="review-context-palette"
      data-review-contextual-ui
      hidden={props.hidden}
      inert={props.hidden}
      style={style}
    >
      {props.onCopy ? <ContextActionButton kind="copy" iconOnly onAction={props.onCopy} /> : null}
      <ContextActionButton kind="replace" iconOnly onAction={props.onReplace} />
      <ContextActionButton kind="delete" iconOnly onAction={props.onDelete} />
      <ContextActionButton kind="highlight" iconOnly onAction={props.onHighlight} />
    </div>
  );
}

export interface InsertionCaretProps {
  readonly placement: ContextPlacement;
  readonly hidden?: boolean;
}

export function InsertionCaret({ placement, hidden }: InsertionCaretProps) {
  const style: CSSProperties = {
    left: placement.left,
    top: placement.top,
    ...(placement.width === undefined ? {} : { width: placement.width }),
    ...(placement.height === undefined ? {} : { height: placement.height }),
  };
  return (
    <span
      aria-hidden="true"
      className="review-insertion-caret"
      data-review-insertion-caret
      hidden={hidden}
      style={style}
    />
  );
}
