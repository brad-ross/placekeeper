import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HostRuntime, HostRuntimeBootstrap } from './host/runtime.js';
import { RuntimeProductionReviewApp, RuntimeFailureBoundary } from './production-entry.js';
import './app/review-layout.css';

function CodexProductionReview({ runtime, onError, onReady }: { runtime: HostRuntime; onError: (error: Error) => void; onReady: (generation: number) => void }) {
  const [initial, setInitial] = useState<HostRuntimeBootstrap>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void runtime.bootstrap(controller.signal).then(value => {
      if (!controller.signal.aborted) setInitial(value);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setFailed(true); onError(error instanceof Error ? error : new Error('The native PDF could not be loaded.'));
    });
    return () => controller.abort();
  }, [runtime, attempt, onError]);
  if (initial !== undefined) return <RuntimeProductionReviewApp runtime={runtime} initial={initial} onRuntimeError={onError} onDocumentReady={onReady} />;
  if (failed) return <div role="alert">The PDF resources could not be verified. <button onClick={() => setAttempt(value => value + 1)}>Retry</button></div>;
  return <div role="status">Loading PDF…</div>;
}

/** The admitted MCP shell owns lifetime; this is the same reader mounted by other hosts. */
export function mountCodexProductionReview(element: HTMLElement, runtime: HostRuntime, onError: (error: Error) => void, onReady: (generation: number) => void): () => void {
  element.dataset.productionRoot = 'true';
  const root = createRoot(element);
  root.render(<RuntimeFailureBoundary onError={onError}><CodexProductionReview runtime={runtime} onError={onError} onReady={onReady} /></RuntimeFailureBoundary>);
  return () => { root.unmount(); runtime.dispose(); delete element.dataset.productionRoot; };
}
