import { describe, expect, it, vi } from 'vitest';
import { VersionedWebviewBridge } from '../src/webview-bridge.js';
import { REVIEW_RUNTIME_PROTOCOL, REVIEW_RUNTIME_VERSION } from '../../../packages/core/src/review-runtime-protocol.js';

const identity = { panelId: 'panel_1234567890123456', sessionId: 'session_1234567890123456', generation: 2, revision: 3 };
const request = { protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION, kind: 'external-link-request', ...identity, requestId: 'request_1234567890123456', url: 'https://example.com/a?q=b#c' };
function harness(open = vi.fn(async (_url: string) => {})) {
  const post = vi.fn();
  const invoke = vi.fn();
  const bridge = new VersionedWebviewBridge({ identity, bootstrap: vi.fn(), invoke, dispose: vi.fn() }, post, open);
  return { bridge, post, invoke, open };
}
describe('trusted VS Code external links', () => {
  it('opens a web URL once without service RPC and acknowledges its identity', async () => {
    const h = harness();
    await h.bridge.receive(request);
    await h.bridge.receive(request);
    expect(h.open).toHaveBeenCalledExactlyOnceWith(request.url);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.post).toHaveBeenCalledWith({ protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION, kind: 'external-link-response', ...identity, requestId: request.requestId, ok: true });
  });
  it.each([{ panelId: 'wrong' }, { generation: 1 }, { revision: 1 }, { sessionId: 'wrong' }, { version: 1 }])('ignores stale or foreign requests %j', async change => {
    const h = harness(); await h.bridge.receive({ ...request, ...change }); expect(h.open).not.toHaveBeenCalled();
  });
  it.each(['file:///tmp/a', 'javascript:alert(1)', 'https:example.com'])('rejects unsafe URLs with a correlated error', async url => {
    const h = harness(); await h.bridge.receive({ ...request, url });
    expect(h.open).not.toHaveBeenCalled();
    expect(h.post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'external-link-response', requestId: request.requestId, ok: false }));
  });
  it('canonicalizes the accepted URL at the trusted boundary', async () => {
    const h = harness(); await h.bridge.receive({ ...request, url: 'HTTPS://EXAMPLE.COM' });
    expect(h.open).toHaveBeenCalledExactlyOnceWith('https://example.com/');
  });
  it('reports an unavailable opener', async () => {
    const post = vi.fn();
    const bridge = new VersionedWebviewBridge({ identity, bootstrap: vi.fn(), invoke: vi.fn(), dispose: vi.fn() }, post);
    await bridge.receive(request);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
  it('suppresses a cancelled request acknowledgment', async () => {
    let finish!: () => void;
    const h = harness(vi.fn(() => new Promise<void>(resolve => { finish = resolve; })));
    const pending = h.bridge.receive(request);
    await h.bridge.receive({ protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION,
      kind: 'cancel', panelId: identity.panelId, requestId: request.requestId });
    finish(); await pending;
    expect(h.post).not.toHaveBeenCalled();
  });
  it('reports opener denial', async () => {
    const h = harness(vi.fn(async () => { throw new Error('denied'); })); await h.bridge.receive(request);
    expect(h.post).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
  it('suppresses replies after disposal and refuses later requests', async () => {
    let finish!: () => void;
    const h = harness(vi.fn(() => new Promise<void>(resolve => { finish = resolve; })));
    const pending = h.bridge.receive(request); h.bridge.dispose(); finish(); await pending;
    await h.bridge.receive({ ...request, requestId: 'request_9876543210123456' });
    expect(h.open).toHaveBeenCalledTimes(1); expect(h.post).not.toHaveBeenCalled();
  });
});
