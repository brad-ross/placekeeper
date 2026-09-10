import type { ReviewState } from '../../../../packages/core/src/review-model.js';
import type { LiveContextBindingStatus } from '../../../../packages/core/src/live-context.js';
import type { ProductionScope } from './session-contracts.js';
function contextMatchesReviewState(
  status: Extract<LiveContextBindingStatus, { readonly status: "current" }>,
  state: ReviewState,
): boolean {
  return status.identity.placekeeperSessionId === state.sessionId &&
    status.identity.reviewRevision === state.revision &&
    status.identity.source.fileId === state.source.fileId &&
    status.identity.source.digest === state.source.digest;
}

export function visibleCodexContext(
  status: LiveContextBindingStatus | undefined,
  state: ReviewState,
): LiveContextBindingStatus | undefined {
  if (status?.status !== "current" || contextMatchesReviewState(status, state)) return status;
  return {
    status: "refreshing",
    placekeeperSessionId: state.sessionId,
    documentGeneration: status.identity.documentGeneration,
    lastVerified: status.identity,
  };
}

export function reviewStateRequestKey(state: ReviewState): string {
  return JSON.stringify([
    state.sessionId,
    state.source.fileId,
    state.source.digest,
    state.revision,
    state.items,
  ]);
}

// Scope responses are parsed JSON records. Compare all fields, including nested
// observation identities and lease timestamps, without depending on key order.
// An unknown/new response field conservatively triggers a publication as well.
function jsonValuesEqual(current: unknown, next: unknown): boolean {
  if (current === next) return true;
  if (Array.isArray(current) !== Array.isArray(next)) return false;
  if (typeof current !== 'object' || current === null
    || typeof next !== 'object' || next === null) return false;
  const currentRecord = current as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const keys = Object.keys(currentRecord);
  return keys.length === Object.keys(nextRecord).length
    && keys.every((key) => Object.hasOwn(nextRecord, key)
      && jsonValuesEqual(currentRecord[key], nextRecord[key]));
}

export function updateProductionScope(
  current: ProductionScope,
  next: ProductionScope,
): ProductionScope {
  return jsonValuesEqual(current, next) ? current : next;
}

export function updateCodexContext(
  current: LiveContextBindingStatus | undefined,
  next: LiveContextBindingStatus,
): LiveContextBindingStatus {
  return jsonValuesEqual(current, next) ? current ?? next : next;
}
