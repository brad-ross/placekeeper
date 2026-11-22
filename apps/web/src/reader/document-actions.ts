import type { AnnotationKind } from '../../../../packages/core/src/document-model.js';

export interface DocumentActionMetadata {
  readonly kind: AnnotationKind;
  readonly label: string;
  readonly shortcut: string;
}

export const documentActions: readonly DocumentActionMetadata[] = Object.freeze([
  { kind: 'replace', label: 'Replace', shortcut: 'Alt+Shift+R' },
  { kind: 'delete', label: 'Delete', shortcut: 'Alt+Shift+D' },
  { kind: 'insert', label: 'Insert', shortcut: 'Alt+Shift+I' },
  { kind: 'highlight', label: 'Highlight', shortcut: 'Alt+Shift+H' },
  { kind: 'pageNote', label: 'Page Note', shortcut: 'Alt+Shift+N' },
]);

export function documentActionForKey(key: string): AnnotationKind | undefined {
  const action = documentActions.find(({ shortcut }) => shortcut.endsWith(key.toUpperCase()));
  return action?.kind === 'insert' ? undefined : action?.kind;
}

export function shortcutForDocumentAction(kind: AnnotationKind): string {
  return documentActions.find((action) => action.kind === kind)!.shortcut;
}
