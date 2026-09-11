import type { ReviewState } from '../../../../packages/core/src/review-model.js';
import type { SaveStatus } from '../../../../packages/core/src/save-status.js';

export function initiallyPortableItemIds(
  state: ReviewState,
  saveStatus: SaveStatus | undefined,
): Set<string> {
  return saveStatusIsCleanCurrent(state, saveStatus)
    ? new Set(state.items.map(({ id }) => id))
    : new Set();
}

export function saveStatusIsCleanCurrent(
  state: ReviewState,
  saveStatus: SaveStatus | undefined,
): boolean {
  return saveStatus?.sync.phase === 'clean'
    && saveStatus.sync.savedRevision === state.revision
    && saveStatus.sync.desiredRevision === state.revision;
}
