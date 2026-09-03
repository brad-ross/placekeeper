import type { HostRuntime, HostRuntimeBootstrap } from "./runtime.js";
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
  let loaded = initial;
  let disposed = false;
  const unsubscribe = runtime.subscribeInvalidations((event) => {
    if (
      disposed
      || event.sessionId !== initial.sessionId
      || event.generation < latestGeneration
      || (event.generation === latestGeneration && event.revision < latestRevision)
    ) return;
    latestGeneration = event.generation;
    latestRevision = event.revision;
    const token = ++refreshToken;
    refreshController?.abort();
    const controller = new AbortController();
    refreshController = controller;
    publish({ loaded, refreshStatus: "reconciling" });
    void runtime.bootstrap(controller.signal).then((successor) => {
      if (
        disposed
        || token !== refreshToken
        || successor.sessionId !== event.sessionId
        || successor.generation !== latestGeneration
        || successor.generation !== event.generation
        || successor.revision < event.revision
      ) return;
      loaded = successor;
      latestRevision = successor.revision;
      publish({ loaded, refreshStatus: "idle" });
    }).catch(() => {
      if (!disposed && token === refreshToken) {
        publish({ loaded, refreshStatus: "failed" });
      }
    });
  });
  return () => {
    disposed = true;
    refreshController?.abort();
    unsubscribe();
  };
}
