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
  let loaded = initial;
  let disposed = false;
  const unsubscribe = runtime.subscribeInvalidations((event) => {
    if (
      disposed
      || event.sessionId !== initial.sessionId
      || event.previousGeneration < latestGeneration
      || event.generation <= latestGeneration
    ) return;
    latestGeneration = event.generation;
    publish({ loaded, refreshStatus: "reconciling" });
    void runtime.bootstrap().then((successor) => {
      if (
        disposed
        || successor.sessionId !== event.sessionId
        || successor.generation !== latestGeneration
        || successor.generation !== event.generation
        || successor.revision < event.revision
      ) return;
      loaded = successor;
      publish({ loaded, refreshStatus: "idle" });
    }).catch(() => {
      if (!disposed && latestGeneration === event.generation) {
        publish({ loaded, refreshStatus: "failed" });
      }
    });
  });
  return () => {
    disposed = true;
    unsubscribe();
  };
}
