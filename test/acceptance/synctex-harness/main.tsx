import { createRoot } from 'react-dom/client';
import { useRef } from 'react';
import { RuntimeProductionReviewApp } from '../../../apps/web/src/production-entry.js';
import type { HostRuntime, HostRuntimeBootstrap, HostRuntimeCommand } from '../../../apps/web/src/host/runtime.js';
import { MemoryReviewLocationHistory } from '../../../apps/web/src/review/review-location-history.js';
import '../../../apps/web/src/app/review-layout.css';
import { useHostSyncTex } from '../../../apps/web/src/host/use-host-synctex.js';
import { createReviewState } from '../../../packages/core/src/review-model.js';
import type { HostForwardSyncTexRequest } from '../../../apps/web/src/host/session-contracts.js';
import type { PdfViewerNavigation } from '../../../apps/web/src/pdf/viewer-navigation-adapter.js';

const root = createRoot(document.getElementById('root')!);
const state = createReviewState({ sessionId: '00000000-0000-4000-8000-000000000301',
  source: { fileId: '00000000-0000-4000-8000-000000000302', digest: 'a'.repeat(64), byteLength: 12 } });
const observations = { calls: 0, cancellations: 0, focuses: [] as number[], acknowledgements: [] as string[], errors: [] as (string | null)[] };
const pending: Array<(result: boolean) => void> = [];
const navigation = {
  captureLocation: () => ({ pageIndex: 0, anchor: { x: 0, y: 0 }, alignment: { xPercent: 50, yPercent: 50 }, zoom: 1 }),
  applyLocation: () => { observations.calls++; return new Promise<boolean>(resolve => pending.push(resolve)); },
  focusAtDestination: (pageIndex: number) => { observations.focuses.push(pageIndex); },
  cancelPendingNavigation: async () => { observations.cancellations++; },
} as unknown as PdfViewerNavigation;
function Fixture({ request }: { request?: HostForwardSyncTexRequest }) {
  const stateRef = useRef(state), navigationRef = useRef(navigation);
  useHostSyncTex({ hostForwardSyncTexRequest: request, onHostForwardSyncTexHandled: (value, outcome) => {
    observations.acknowledgements.push(`${value.token}:${outcome}`);
  }, hostReverseSyncTexRequestToken: undefined, onReverseSyncTex: undefined }, state, stateRef,
  navigation, navigationRef, 1, 1, 'idle', error => { observations.errors.push(error); });
  return <p>Hook mounted</p>;
}
const render = (token?: number) => root.render(<Fixture {...(token === undefined ? {} : { request: {
  token, documentGeneration: 1, pageIndex: token, point: { x: 10, y: 20 }, nativeSequence: token,
} })} />);
Object.assign(window, { synctexFixture: { observations, render, unmount: () => root.unmount(),
  settle: (index: number, result: boolean) => pending[index]!(result) } });
if (new URLSearchParams(location.search).has('runtime')) {
  const scope = { documentTitle: 'multi-page-text.pdf', launchSurface: 'vscode' as const };
  const saveStatus = { destination: { phase: 'none' as const, generation: 0 as const },
    sync: { phase: 'clean' as const, desiredRevision: 0, savedRevision: 0 } };
  const bootstrap: HostRuntimeBootstrap = { sessionId: state.sessionId, generation: 1, revision: state.revision,
    session: { sessionId: state.sessionId }, state, scope, saveStatus,
    viewerAssets: { documentUrl: '/test/fixtures/pdfs/multi-page-text.pdf',
      pdfiumWasm: '/dist/web/pdfium.wasm', workerUrl: '/dist/web/pdfium-worker.js' },
    resourcePolicy: { host: 'browser', origin: location.origin }, locationHistory: new MemoryReviewLocationHistory() };
  let listener: ((command: HostRuntimeCommand) => void) | undefined;
  let reverseCalls = 0;
  const unavailable = async (): Promise<never> => { throw new Error('Unused navigation fixture operation'); };
  const runtime: HostRuntime = { host: 'vscode', bootstrap: async () => bootstrap,
    subscribeInvalidations: () => () => undefined,
    subscribeHostCommands: next => { listener = next; return () => { listener = undefined; }; },
    scope: async () => scope, saveStatus: async () => saveStatus,
    command: unavailable, saveProposal: unavailable, chooseCopy: unavailable, chooseFolder: unavailable,
    chooseOriginal: unavailable, retrySave: unavailable, locateSave: unavailable, exportReviewedCopy: unavailable,
    forwardSyncTex: unavailable, reverseSyncTex: async () => { reverseCalls++; return { status: 'ok' }; }, dispose: () => undefined };
  Object.assign(window, { runtimeFixture: { send: (command: HostRuntimeCommand) => listener!(command), reverseCalls: () => reverseCalls } });
  root.render(<RuntimeProductionReviewApp runtime={runtime} />);
} else render();
