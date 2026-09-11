import type { PdfViewerNavigation } from '../pdf/viewer-navigation-adapter.js';
import type { ReverseSyncTexRequest } from './session-contracts.js';
import type { LocationRestoreStatus } from '../generation-status.js';
export function forwardSyncTexRequestReady(input: {
  readonly requestGeneration: number;
  readonly documentGeneration: number;
  readonly navigationReadyGeneration: number | null;
  readonly documentReadyGeneration: number | null;
  readonly locationRestoreStatus: LocationRestoreStatus;
}): boolean {
  return input.requestGeneration === input.documentGeneration &&
    input.navigationReadyGeneration === input.documentGeneration &&
    input.documentReadyGeneration === input.documentGeneration &&
    input.locationRestoreStatus !== 'restoring';
}

export function forwardSyncTexCompletionIsCurrent(input: {
  readonly requestToken: number;
  readonly latestRequestToken: number;
  readonly requestGeneration: number;
  readonly documentGeneration: number;
  readonly navigationMatches: boolean;
}): boolean {
  return input.requestToken === input.latestRequestToken &&
    input.requestGeneration === input.documentGeneration &&
    input.navigationMatches;
}

export async function applyHostForwardSyncTex(
  navigation: Pick<PdfViewerNavigation, 'captureLocation' | 'applyLocation' | 'focusAtDestination'>,
  request: {
    readonly pageIndex: number;
    readonly point: { readonly x: number; readonly y: number };
  },
): Promise<boolean> {
  if (!Number.isSafeInteger(request.pageIndex) || request.pageIndex < 0 ||
    !Number.isFinite(request.point.x) || request.point.x < 0 ||
    !Number.isFinite(request.point.y) || request.point.y < 0) return false;
  const current = navigation.captureLocation();
  if (current === null) return false;
  const applied = await navigation.applyLocation({
    ...current,
    pageIndex: request.pageIndex,
    anchor: request.point,
    alignment: { xPercent: 50, yPercent: 50 },
  });
  if (applied) navigation.focusAtDestination(request.pageIndex);
  return applied;
}

export async function runHostForwardSyncTexRequest(
  navigation: Pick<PdfViewerNavigation, 'captureLocation' | 'applyLocation' | 'focusAtDestination'>,
  request: { readonly pageIndex: number; readonly point: { readonly x: number; readonly y: number } },
  isCurrent: () => boolean,
  publishResult: (applied: boolean) => void,
): Promise<void> {
  let applied = false;
  try {
    applied = await applyHostForwardSyncTex(navigation, request);
  } catch {
    // A rejected viewer navigation is the same user-visible failure as a false result.
  }
  if (isCurrent()) publishResult(applied);
}

function reverseSyncTexSucceeded(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    (value as { readonly status?: unknown }).status === 'ok';
}

export const REVERSE_SYNCTEX_GENERIC_ERROR = 'Reverse SyncTeX could not find a LaTeX source location.';

export function reverseSyncTexError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return REVERSE_SYNCTEX_GENERIC_ERROR;
  const result = value as { readonly status?: unknown; readonly reason?: unknown };
  if (result.status === 'ok') return null;
  if (result.reason === 'workspace-untrusted') {
    return 'Trust this workspace before using Reverse SyncTeX.';
  }
  switch (result.status) {
    case 'missing':
      return 'SyncTeX data is missing. Rebuild the PDF with SyncTeX enabled.';
    case 'pending':
      return 'SyncTeX data for this PDF is still being prepared. Try again shortly.';
    case 'stale':
      return 'SyncTeX data is stale. Rebuild the PDF before going to source.';
    case 'ambiguous':
      return 'SyncTeX found more than one LaTeX source location for this PDF point.';
    case 'out-of-root':
      return 'The SyncTeX source location is outside the approved workspace.';
    case 'unavailable-tool':
      return 'The SyncTeX tool is unavailable. Install or configure SyncTeX and retry.';
    case 'timeout':
      return 'The SyncTeX query timed out. Try again.';
    case 'oversized':
      return 'The SyncTeX result was too large to use safely.';
    case 'malformed':
      return 'The SyncTeX data was malformed. Rebuild the PDF and retry.';
    default:
      return REVERSE_SYNCTEX_GENERIC_ERROR;
  }
}

export class ReverseSyncTexRequestCoordinator {
  #latestRequest = 0;

  async run(
    reverseSyncTex: (input: ReverseSyncTexRequest) => Promise<unknown>,
    request: ReverseSyncTexRequest,
    publishError: (message: string | null) => void,
  ): Promise<unknown> {
    const requestId = ++this.#latestRequest;
    publishError(null);
    try {
      const value = await reverseSyncTex(request);
      if (requestId === this.#latestRequest) publishError(reverseSyncTexError(value));
      return value;
    } catch {
      if (requestId === this.#latestRequest) publishError(REVERSE_SYNCTEX_GENERIC_ERROR);
      return { status: 'failed' };
    }
  }
}

export async function reverseSyncTexAtCurrentLocation(
  navigation: Pick<PdfViewerNavigation, 'captureLocation'>,
  reverseSyncTex: (input: ReverseSyncTexRequest) => Promise<unknown>,
): Promise<boolean> {
  const location = navigation.captureLocation();
  if (location === null) return false;
  return reverseSyncTexSucceeded(await reverseSyncTex({
    pageIndex: location.pageIndex,
    point: location.anchor,
  }));
}
