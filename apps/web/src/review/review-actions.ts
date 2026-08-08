import type { ReviewItemKind } from '../../../../packages/core/src/review-model.js';

export interface ReviewActionMetadata {
  readonly kind: ReviewItemKind;
  readonly label: string;
  readonly shortcut: string;
}

export const reviewActions: readonly ReviewActionMetadata[] = Object.freeze([
  { kind: 'replace', label: 'Replace', shortcut: 'Alt+Shift+R' },
  { kind: 'delete', label: 'Delete', shortcut: 'Alt+Shift+D' },
  { kind: 'insert', label: 'Insert', shortcut: 'Alt+Shift+I' },
  { kind: 'highlight', label: 'Highlight', shortcut: 'Alt+Shift+H' },
  { kind: 'pageNote', label: 'Page Note', shortcut: 'Alt+Shift+N' },
]);

export function reviewActionForKey(key: string): ReviewItemKind | undefined {
  return reviewActions.find(({ shortcut }) => shortcut.endsWith(key.toUpperCase()))?.kind;
}

export function shortcutForReviewAction(kind: ReviewItemKind): string {
  return reviewActions.find((action) => action.kind === kind)!.shortcut;
}
