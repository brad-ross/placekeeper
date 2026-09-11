import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { setAnnotationName } from '../../../../packages/core/src/review-commands.js';
import type { ReviewState } from '../../../../packages/core/src/review-model.js';
import { createReviewStateSummary } from '../../../../packages/core/src/live-context.js';
import type { ProductionSessionApi } from '../host/session-contracts.js';
import type { GenerationRefreshStatus } from '../generation-status.js';
import { authoringAuthorityFor, authoringAuthorityMatches, type AuthoringAuthority } from '../review/authoring-session.js';
import { reviewExportPresentation, type ReviewExportResult } from '../review/DocumentActionsMenu.js';

interface ExportRequest {
  readonly authority: AuthoringAuthority;
  readonly confirmPossiblyStale?: true;
  readonly resolve: (result: ReviewExportResult) => void;
}

export function useAnnotationExport(api: ProductionSessionApi, state: ReviewState,
  stateRef: RefObject<ReviewState>, generationRef: RefObject<number>,
  setState: Dispatch<SetStateAction<ReviewState>>, refreshStatus: GenerationRefreshStatus) {
  const [request, setRequest] = useState<ExportRequest | null>(null);
  const activeRef = useRef<ExportRequest | null>(null);
  const busyRef = useRef(false);
  const refreshStatusRef = useRef(refreshStatus);
  refreshStatusRef.current = refreshStatus;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const isCurrent = (captured: ExportRequest) => activeRef.current === captured
    && authoringAuthorityMatches(captured.authority, authoringAuthorityFor(stateRef.current, generationRef.current));
  const finish = (captured: ExportRequest, result: ReviewExportResult) => {
    if (activeRef.current !== captured) return;
    activeRef.current = null;
    busyRef.current = false;
    setRequest(null);
    setPending(false);
    setError(undefined);
    captured.resolve(result);
  };
  useEffect(() => {
    const captured = activeRef.current;
    if (captured && !isCurrent(captured)) finish(captured, { kind: 'cancelled' });
  }, [state.sessionId, state.source.fileId, state.source.digest, state.workflow.documentGeneration]);
  useEffect(() => () => {
    activeRef.current?.resolve({ kind: 'cancelled' });
    activeRef.current = null;
  }, []);
  const open = (confirmPossiblyStale?: true): Promise<ReviewExportResult> => {
    if (activeRef.current) return Promise.resolve({ kind: 'cancelled' });
    return new Promise((resolve) => {
      const next: ExportRequest = {
        authority: authoringAuthorityFor(stateRef.current, generationRef.current),
        ...(confirmPossiblyStale ? { confirmPossiblyStale } : {}), resolve,
      };
      activeRef.current = next;
      setError(undefined);
      setRequest(next);
    });
  };
  const cancel = () => {
    if (activeRef.current && !busyRef.current) finish(activeRef.current, { kind: 'cancelled' });
  };
  const confirm = async (name: string) => {
    const captured = activeRef.current;
    if (!captured || busyRef.current) return;
    if (!isCurrent(captured)) { finish(captured, { kind: 'cancelled' }); return; }
    const eligibility = reviewExportPresentation({ refreshStatus: refreshStatusRef.current, summary: createReviewStateSummary(stateRef.current) });
    if (!eligibility.canExport || (eligibility.requiresStaleConfirmation && !captured.confirmPossiblyStale)) {
      setError(eligibility.message);
      return;
    }
    const method = api.exportReviewedCopy;
    if (!method) { setError('Reviewed export is unavailable.'); return; }
    busyRef.current = true;
    setPending(true);
    setError(undefined);
    try {
      const named = await api.command(setAnnotationName(stateRef.current, name));
      if (!isCurrent(captured)) return;
      if ('accepted' in named) {
        if (named.state.revision >= stateRef.current.revision) {
          stateRef.current = named.state;
          setState(named.state);
        }
        setError(named.message);
        return;
      }
      if (named.revision >= stateRef.current.revision) {
        stateRef.current = named;
        setState(named);
      }
      const currentEligibility = reviewExportPresentation({
        refreshStatus: refreshStatusRef.current, summary: createReviewStateSummary(stateRef.current),
      });
      if (!currentEligibility.canExport || (currentEligibility.requiresStaleConfirmation && !captured.confirmPossiblyStale)) {
        setError(currentEligibility.message);
        return;
      }
      const result = await method(captured.confirmPossiblyStale);
      if (isCurrent(captured)) finish(captured, result);
    } catch (cause) {
      if (isCurrent(captured)) setError(cause instanceof Error ? cause.message : 'Export failed. Your review is still available; try again.');
    } finally {
      if (isCurrent(captured)) { busyRef.current = false; setPending(false); }
    }
  };
  return { request, pending, error, open, cancel, confirm };
}
