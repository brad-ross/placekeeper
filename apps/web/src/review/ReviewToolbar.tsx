import type { KeyboardEvent, RefObject } from 'react';
import type { ReviewItemKind } from '../../../../packages/core/src/review-model.js';

export interface ReviewToolbarProps {
  active: boolean;
  currentTool: ReviewItemKind;
  canUndo: boolean;
  canRedo: boolean;
  listOpen: boolean;
  pageNoteTriggerRef?: RefObject<HTMLButtonElement | null>;
  onActiveChange(active: boolean): void;
  onToolChange(tool: ReviewItemKind): void;
  onHighlight(): void;
  onPageNote(): void;
  onReplace(): void;
  onDelete(): void;
  onInsert(): void;
  onUndo(): void;
  onRedo(): void;
  onListOpenChange(open: boolean): void;
}

export const reviewTools: ReadonlyArray<{ kind: ReviewItemKind; label: string; shortcut: string }> = [
  { kind: 'replace', label: 'Replace', shortcut: 'Alt+Shift+R' },
  { kind: 'delete', label: 'Delete', shortcut: 'Alt+Shift+D' },
  { kind: 'insert', label: 'Insert', shortcut: 'Alt+Shift+I' },
  { kind: 'highlight', label: 'Highlight', shortcut: 'Alt+Shift+H' },
  { kind: 'pageNote', label: 'Page Note', shortcut: 'Alt+Shift+N' },
];

export function reviewToolForKey(key: string): ReviewItemKind | undefined {
  return reviewTools.find(({ shortcut }) => shortcut.endsWith(key.toUpperCase()))?.kind;
}

export function ReviewToolbar(props: ReviewToolbarProps) {
  const invokeTool = (kind: ReviewItemKind) => {
    props.onToolChange(kind);
    if (kind === 'replace') props.onReplace();
    if (kind === 'delete') props.onDelete();
    if (kind === 'insert') props.onInsert();
    if (kind === 'highlight') props.onHighlight();
    if (kind === 'pageNote') props.onPageNote();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (!event.altKey || !event.shiftKey) return;
    const kind = reviewToolForKey(event.key);
    if (!kind) return;
    event.preventDefault();
    invokeTool(kind);
  };
  return (
    <div role="toolbar" aria-label="Review tools" onKeyDown={onKeyDown}>
      <button type="button" aria-pressed={props.active} onClick={() => props.onActiveChange(!props.active)}>
        Proofread mode
      </button>
      {reviewTools.map(({ kind, label, shortcut }) => (
        <button
          key={kind}
          ref={kind === 'pageNote' ? props.pageNoteTriggerRef : undefined}
          type="button"
          aria-pressed={props.currentTool === kind}
          aria-keyshortcuts={shortcut}
          onClick={() => invokeTool(kind)}
        >
          {label}
        </button>
      ))}
      <button type="button" disabled={!props.canUndo} aria-keyshortcuts="Control+Z Meta+Z" onClick={props.onUndo}>Undo</button>
      <button type="button" disabled={!props.canRedo} aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z" onClick={props.onRedo}>Redo</button>
      <button type="button" aria-expanded={props.listOpen} aria-controls="review-annotation-list" onClick={() => props.onListOpenChange(!props.listOpen)}>
        Annotations
      </button>
    </div>
  );
}
