import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserHostRuntime } from '../src/host/browser-runtime.js';
import { createRpcHostRuntime } from '../src/host/vscode-runtime.js';
import { createCodexHostRuntime } from '../src/host/codex-runtime.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('opens browser links synchronously with no opener and accepts a null handoff', async () => {
  const open = vi.fn(() => null);
  vi.stubGlobal('window', { open });
  const runtime = createBrowserHostRuntime({ sessionId: 'session' });
  const result = runtime.openExternalUrl!('https://example.com/a?q=1#part');
  expect(open).toHaveBeenCalledWith('https://example.com/a?q=1#part', '_blank', 'noopener,noreferrer');
  await result;
  await expect(runtime.openExternalUrl!('file:///tmp/a')).rejects.toThrow();
  expect(open).toHaveBeenCalledTimes(1);
  runtime.dispose();
  await expect(runtime.openExternalUrl!('https://example.com')).rejects.toThrow();
});
it('uses only the injected Chrome opener and propagates rejection', async () => {
  const openExternalUrl = vi.fn(async () => {});
  const runtime = createRpcHostRuntime({ runtimeId: 'runtime_identifier_1234', postMessage: vi.fn(), subscribe: () => () => {} }, { host: 'chrome', extensionOrigin: 'chrome-extension://id', openExternalUrl });
  await runtime.openExternalUrl!('https://EXAMPLE.COM/path#part');
  expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/path#part');
  await expect(runtime.openExternalUrl!('javascript:alert(1)')).rejects.toThrow();
  expect(openExternalUrl).toHaveBeenCalledTimes(1);
  openExternalUrl.mockRejectedValueOnce(new Error('denied'));
  await expect(runtime.openExternalUrl!('https://example.com')).rejects.toThrow('denied');
  runtime.dispose();
  await expect(runtime.openExternalUrl!('https://example.com')).rejects.toThrow();
});
it('keeps Codex opening out of service calls and rejects unavailable opening', async () => {
  const call = vi.fn(async () => ({}));
  const openExternalUrl = vi.fn(async () => {});
  const runtime = createCodexHostRuntime({ runtimeId: 'runtime_identifier_1234', call, openExternalUrl, subscribeInvalidations: () => () => {} });
  await runtime.openExternalUrl!('https://example.com/path#part');
  expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/path#part');
  expect(call).not.toHaveBeenCalled();
  await expect(runtime.openExternalUrl!('mailto:a@example.com')).rejects.toThrow();
  runtime.dispose();
  await expect(runtime.openExternalUrl!('https://example.com')).rejects.toThrow();
  const unavailable = createCodexHostRuntime({ runtimeId: 'runtime_identifier_1234', call, subscribeInvalidations: () => () => {} });
  await expect(unavailable.openExternalUrl!('https://example.com')).rejects.toThrow();
  unavailable.dispose();
});

import { createReviewState } from '../../../packages/core/src/review-model.js';
import { VersionedWebviewBridge } from '../../vscode/src/webview-bridge.js';
const panelId = 'panel_identifier_1234';
const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function vscodeFixture(reply = true) {
  let receive: (value: unknown) => void = () => {};
  const opened = vi.fn(async () => {});
  const identity = { panelId, sessionId, generation: 1, revision: 0 };
  const bridge = new VersionedWebviewBridge({ identity, dispose() {}, invoke: async () => ({}), bootstrap: async () => ({
    ...identity, state: createReviewState({ sessionId, source: { fileId: 'file', digest: 'a'.repeat(64), byteLength: 1 } }),
    scope: { documentTitle: 'Paper.pdf' }, saveStatus: {}, resources: { document: 'https://resource/document', pdfiumWasm: 'https://resource/engine' },
  }) }, value => receive(value), opened);
  const sent: unknown[] = [];
  const runtime = createRpcHostRuntime({ panelId, subscribe(listener) { receive = listener; return () => {}; }, postMessage(value) {
    sent.push(value);
    if (reply || (value as { kind: string }).kind !== 'external-link-request') void bridge.receive(value);
  } });
  await runtime.bootstrap();
  return { runtime, bridge, opened, sent };
}
it('round-trips a dedicated VS Code link message without service invocation', async () => {
  const f = await vscodeFixture();
  await f.runtime.openExternalUrl!('https://example.com/a#b');
  expect(f.opened).toHaveBeenCalledExactlyOnceWith('https://example.com/a#b');
  expect(f.sent.at(-1)).toMatchObject({ kind: 'external-link-request', panelId, sessionId, generation: 1, revision: 0, url: 'https://example.com/a#b' });
  f.opened.mockRejectedValueOnce(new Error('denied'));
  await expect(f.runtime.openExternalUrl!('https://example.com')).rejects.toThrow('could not open');
  f.runtime.dispose(); f.bridge.dispose();
});
it('fails an unsupported VS Code link lane and settles pending opening on disposal', async () => {
  vi.useFakeTimers();
  const f = await vscodeFixture(false);
  const timeout = expect(f.runtime.openExternalUrl!('https://example.com')).rejects.toThrow('did not accept');
  await vi.advanceTimersByTimeAsync(10_000); await timeout;
  const disposed = expect(f.runtime.openExternalUrl!('https://example.com')).rejects.toThrow('disposed');
  f.runtime.dispose(); await disposed; f.bridge.dispose();
  expect(f.opened).not.toHaveBeenCalled();
});
