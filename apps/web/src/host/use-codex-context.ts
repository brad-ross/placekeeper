import { useEffect, useState, type Dispatch, type SetStateAction, type RefObject } from 'react';
import type { ReviewState } from '../../../../packages/core/src/review-model.js';
import type { LiveContextBindingStatus } from '../../../../packages/core/src/live-context.js';
import type { ProductionScope, ProductionSessionApi } from './session-contracts.js';
import { visibleCodexContext, reviewStateRequestKey, updateProductionScope, updateCodexContext } from './context-projection.js';
export const UNAVAILABLE_CODEX_CONTEXT: LiveContextBindingStatus = {
  status: 'unavailable',
  reason: 'unavailable',
};

const CODEX_SCOPE_POLL_MS = 1_500;
const CODEX_SCOPE_TIMEOUT_MS = 4_000;

export function useCodexContext(props: { api: ProductionSessionApi }, scope: ProductionScope,
  setScope: Dispatch<SetStateAction<ProductionScope>>, stateRef: RefObject<ReviewState>) {
  const [codexContext, setCodexContext] = useState(scope.codexContext);
  useEffect(() => {
    if (scope.launchSurface !== 'codex' && scope.reconnectPending !== true) return;
    let stopped = false;
    let timer: number | undefined;
    let timeout: number | undefined;
    let controller: AbortController | undefined;
    const refreshCodexContext = async () => {
      const requestedStateKey = reviewStateRequestKey(stateRef.current);
      controller = new AbortController();
      try {
        const next = await Promise.race([
          props.api.scope(controller.signal),
          new Promise<never>((_resolve, reject) => {
            timeout = window.setTimeout(() => {
              controller?.abort();
              reject(new Error("Codex scope refresh timed out"));
            }, CODEX_SCOPE_TIMEOUT_MS);
          }),
        ]);
        if (!stopped && requestedStateKey === reviewStateRequestKey(stateRef.current)) {
          setScope((current) => updateProductionScope(current, next));
          const nextContext = next.launchSurface === 'codex'
            ? next.codexContext ?? UNAVAILABLE_CODEX_CONTEXT
            : UNAVAILABLE_CODEX_CONTEXT;
          const safeContext = visibleCodexContext(nextContext, stateRef.current) ?? UNAVAILABLE_CODEX_CONTEXT;
          setCodexContext((current) => updateCodexContext(current, safeContext));
        }
      } catch {
        if (!stopped && requestedStateKey === reviewStateRequestKey(stateRef.current)) {
          setCodexContext((current) => updateCodexContext(current, UNAVAILABLE_CODEX_CONTEXT));
        }
      } finally {
        if (timeout !== undefined) window.clearTimeout(timeout);
        timeout = undefined;
        controller = undefined;
        if (!stopped) {
          timer = window.setTimeout(() => { void refreshCodexContext(); }, CODEX_SCOPE_POLL_MS);
        }
      }
    };
    timer = window.setTimeout(() => { void refreshCodexContext(); }, CODEX_SCOPE_POLL_MS);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (timeout !== undefined) window.clearTimeout(timeout);
      controller?.abort();
    };
  }, [props.api, scope.launchSurface, scope.reconnectPending]);
  useEffect(() => {
    if (codexContext?.status !== "current") return;
    const expectedDigest = codexContext.identity.stateDigest;
    const delay = Math.max(0, Date.parse(codexContext.leaseExpiresAt) - Date.now());
    const timer = window.setTimeout(() => {
      setCodexContext((current) => current?.status === "current" &&
        current.identity.stateDigest === expectedDigest
        ? {
            status: "refreshing",
            placekeeperSessionId: current.identity.placekeeperSessionId,
            documentGeneration: current.identity.documentGeneration,
            lastVerified: current.identity,
          }
        : current);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [codexContext]);
  return codexContext;
}
