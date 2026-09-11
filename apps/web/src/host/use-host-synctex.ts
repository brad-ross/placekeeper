import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { ReviewState } from '../../../../packages/core/src/review-model.js';
import type { PdfViewerNavigation } from '../pdf/viewer-navigation-adapter.js';
import type { LocationRestoreStatus } from '../generation-status.js';
import type { HostForwardSyncTexRequest, ReverseSyncTexRequest } from './session-contracts.js';
import {
  REVERSE_SYNCTEX_GENERIC_ERROR,
  forwardSyncTexRequestReady,
  forwardSyncTexCompletionIsCurrent,
  runHostForwardSyncTexRequest,
  ReverseSyncTexRequestCoordinator,
} from "./synctex-navigation.js";

export function useHostSyncTex(props: {
  hostForwardSyncTexRequest: HostForwardSyncTexRequest | undefined;
  hostReverseSyncTexRequestToken: number | undefined;
  onReverseSyncTex: ((input: ReverseSyncTexRequest) => Promise<unknown>) | undefined;
}, state: ReviewState, stateRef: RefObject<ReviewState>, mainNavigation: PdfViewerNavigation | null,
  mainNavigationRef: RefObject<PdfViewerNavigation | null>, mainNavigationReadyGeneration: number | null,
  mainDocumentReadyGeneration: number | null, locationRestoreStatus: LocationRestoreStatus,
  setCommandError: (error: string | null) => void) {
  const latestForwardSyncTexTokenRef = useRef(0);
  const handledForwardSyncTexTokenRef = useRef(0);
  const handledReverseSyncTexTokenRef = useRef(0);
  const reverseSyncTexCoordinatorRef = useRef(new ReverseSyncTexRequestCoordinator());
  const requestReverseSyncTex = useCallback((request: ReverseSyncTexRequest): Promise<unknown> => {
    const reverseSyncTex = props.onReverseSyncTex;
    if (reverseSyncTex === undefined) return Promise.resolve({ status: 'failed' });
    return reverseSyncTexCoordinatorRef.current.run(reverseSyncTex, request, setCommandError);
  }, [props.onReverseSyncTex]);
  latestForwardSyncTexTokenRef.current = Math.max(
    latestForwardSyncTexTokenRef.current,
    props.hostForwardSyncTexRequest?.token ?? 0,
  );
  useEffect(() => {
    const request = props.hostForwardSyncTexRequest;
    if (request === undefined || mainNavigation === null ||
      request.token <= handledForwardSyncTexTokenRef.current) return;
    if (request.documentGeneration < state.workflow.documentGeneration) {
      handledForwardSyncTexTokenRef.current = request.token;
      return;
    }
    if (!forwardSyncTexRequestReady({
      requestGeneration: request.documentGeneration,
      documentGeneration: state.workflow.documentGeneration,
      navigationReadyGeneration: mainNavigationReadyGeneration,
      documentReadyGeneration: mainDocumentReadyGeneration,
      locationRestoreStatus,
    })) return;
    handledForwardSyncTexTokenRef.current = request.token;
    void runHostForwardSyncTexRequest(
      mainNavigation,
      request,
      () => forwardSyncTexCompletionIsCurrent({
        requestToken: request.token,
        latestRequestToken: latestForwardSyncTexTokenRef.current,
        requestGeneration: request.documentGeneration,
        documentGeneration: stateRef.current.workflow.documentGeneration,
        navigationMatches: mainNavigationRef.current === mainNavigation,
      }),
      (applied) => setCommandError(
        applied ? null : 'Forward SyncTeX could not reveal this PDF location.',
      ),
    );
  }, [
    locationRestoreStatus,
    mainDocumentReadyGeneration,
    mainNavigation,
    mainNavigationReadyGeneration,
    props.hostForwardSyncTexRequest,
    state.workflow.documentGeneration,
  ]);
  useEffect(() => {
    const token = props.hostReverseSyncTexRequestToken;
    if (token === undefined || token <= 0 || mainNavigation === null ||
      token <= handledReverseSyncTexTokenRef.current || props.onReverseSyncTex === undefined) return;
    handledReverseSyncTexTokenRef.current = token;
    const location = mainNavigation.captureLocation();
    if (location === null) {
      setCommandError(REVERSE_SYNCTEX_GENERIC_ERROR);
      return;
    }
    void requestReverseSyncTex({ pageIndex: location.pageIndex, point: location.anchor });
  }, [mainNavigation, props.hostReverseSyncTexRequestToken, props.onReverseSyncTex, requestReverseSyncTex]);
  return requestReverseSyncTex;
}
