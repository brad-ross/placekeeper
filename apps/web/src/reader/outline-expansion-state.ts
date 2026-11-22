import type { PdfOutlineItem } from '../pdf/pdf-outline.js';

export interface OutlineExpansionState {
  readonly expandedItemIds: ReadonlySet<string>;
  readonly restoreItemIds: ReadonlySet<string> | null;
}

export function outlineBranchIds(items: readonly PdfOutlineItem[]): readonly string[] {
  const ids: string[] = [];
  const pending = [...items].reverse();
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (item.children.length === 0) continue;
    ids.push(item.id);
    for (let index = item.children.length - 1; index >= 0; index -= 1) {
      pending.push(item.children[index]!);
    }
  }
  return ids;
}

export function createOutlineExpansionState(
  expandedItemIds: Iterable<string>,
): OutlineExpansionState {
  return {
    expandedItemIds: new Set(expandedItemIds),
    restoreItemIds: null,
  };
}

export function setOutlineExpandedItemIds(
  current: OutlineExpansionState,
  expandedItemIds: ReadonlySet<string>,
): OutlineExpansionState {
  return {
    ...current,
    expandedItemIds: new Set(expandedItemIds),
  };
}

export function toggleOutlineExpansionState(
  current: OutlineExpansionState,
): OutlineExpansionState {
  if (current.restoreItemIds !== null) {
    return {
      expandedItemIds: new Set(current.restoreItemIds),
      restoreItemIds: null,
    };
  }
  if (current.expandedItemIds.size === 0) return current;
  return {
    expandedItemIds: new Set(),
    restoreItemIds: new Set(current.expandedItemIds),
  };
}
