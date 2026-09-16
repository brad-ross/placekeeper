import type { HostRuntime, HostRuntimeBootstrap, HostRuntimeInvalidation } from "./runtime.js";
import type { GenerationRefreshStatus } from "../generation-status.js";

export interface RuntimeDocumentSourceSnapshot {
  readonly loaded: HostRuntimeBootstrap;
  readonly refreshStatus: GenerationRefreshStatus;
}

/** Joins trusted invalidations to fresh canonical bootstrap state with generation fences. */
export function subscribeRuntimeDocumentSource(
  runtime: HostRuntime,
  initial: HostRuntimeBootstrap,
  publish: (snapshot: RuntimeDocumentSourceSnapshot) => void,
): () => void {
  let latestGeneration = initial.generation;
  let latestRevision = initial.revision;
  let refreshToken = 0;
  let refreshController: AbortController | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let loaded = initial;
  let disposed = false;
  const scheduleRetry = (event: HostRuntimeInvalidation, token: number): void => {
    if (disposed || token !== refreshToken) return;
    publish({ loaded, refreshStatus: "failed" });
    retryTimer = setTimeout(() => refresh(event), 250);
  };
  const refresh = (event: HostRuntimeInvalidation): void => {
    if (disposed) return;
    if (
      event.sessionId !== initial.sessionId
      || event.generation < latestGeneration
      || (event.generation === latestGeneration && event.revision < latestRevision)
      || event.generation < loaded.generation
      || (event.generation === loaded.generation && event.revision < loaded.revision)
    ) return;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    latestGeneration = Math.max(latestGeneration, event.generation);
    if (event.generation === latestGeneration) latestRevision = Math.max(latestRevision, event.revision);
    const token = ++refreshToken;
    refreshController?.abort();
    const controller = new AbortController();
    refreshController = controller;
    publish({ loaded, refreshStatus: "reconciling" });
    void runtime.bootstrap(controller.signal).then((successor) => {
      if (disposed || token !== refreshToken) return;
      if (
        successor.sessionId !== event.sessionId
        || successor.generation < event.generation
        || (successor.generation === event.generation && successor.revision < event.revision)
        || successor.generation < loaded.generation
        || (successor.generation === loaded.generation && successor.revision < loaded.revision)
      ) {
        scheduleRetry(event, token);
        return;
      }
      loaded = successor;
      latestGeneration = successor.generation;
      latestRevision = successor.revision;
      publish({ loaded, refreshStatus: "idle" });
    }).catch(() => {
      scheduleRetry(event, token);
    });
  };
  const unsubscribe = runtime.subscribeInvalidations((event) => {
    refresh(event);
  });
  return () => {
    disposed = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    refreshController?.abort();
    unsubscribe();
  };
}
