import type { ReviewStateView } from '../../../../packages/core/src/review-model.js';
import type { SaveStatus } from '../../../../packages/core/src/save-status.js';

export function initiallyPortableItemIds(
  state: ReviewStateView,
  saveStatus: SaveStatus | undefined,
): Set<string> {
  return saveStatusIsCleanCurrent(state, saveStatus)
    ? new Set(state.items.map(({ id }) => id))
    : new Set();
}

export function saveStatusIsCleanCurrent(
  state: ReviewStateView,
  saveStatus: SaveStatus | undefined,
): boolean {
  return saveStatus?.sync.phase === 'clean'
    && saveStatus.sync.savedRevision === state.revision
    && saveStatus.sync.desiredRevision === state.revision;
}
