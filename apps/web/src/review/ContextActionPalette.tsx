import type { CSSProperties } from 'react';
import type { Rotation } from '@embedpdf/models';

import { ReviewIcon } from './ReviewIcon.js';
import { ReviewTooltipButton } from './ReviewTooltipButton.js';
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
    <ReviewTooltipButton
      type="button"
      className={`review-action-button${iconOnly ? ' review-action-button--icon' : ''}`}
      label={action.label}
      aria-keyshortcuts={action.shortcut}
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        onAction?.();
      }}
    >
      <ReviewIcon name={kind} />
      {iconOnly ? null : action.label}
    </ReviewTooltipButton>
  );
}

export interface ContextPlacement {
  readonly left: number;
  readonly top: number;
  readonly width?: number;
  readonly height?: number;
  readonly suggestTop?: boolean;
  readonly rotation?: Rotation;
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
      <ContextActionButton kind="replace" iconOnly onAction={props.onReplace} />
      <ContextActionButton kind="delete" iconOnly onAction={props.onDelete} />
      <ContextActionButton kind="highlight" iconOnly onAction={props.onHighlight} />
      {props.onCopy ? <ContextActionButton kind="copy" iconOnly onAction={props.onCopy} /> : null}
    </div>
  );
}

export interface InsertionCaretProps {
  readonly placement: ContextPlacement;
  readonly hidden?: boolean;
}

export function InsertionCaret({ placement, hidden }: InsertionCaretProps) {
  const rotation = placement.rotation ?? 0;
  const width = rotation % 2 === 0 ? placement.width : placement.height;
  const height = rotation % 2 === 0 ? placement.height : placement.width;
  const style: CSSProperties = {
    left: placement.left,
    top: placement.top,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    transform: `translate(-50%, -50%) rotate(${rotation * 90}deg)`,
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
