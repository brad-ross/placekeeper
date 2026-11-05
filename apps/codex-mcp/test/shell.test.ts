import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PENDING_META_KEY, RESPONSE_META_KEY } from '../src/transport-contract.js';
const host = vi.hoisted(() => ({ app: undefined as any, handler: undefined as any, options: [] as any[], mounts: [] as any[], unmount: vi.fn() }));
vi.mock('@modelcontextprotocol/ext-apps', () => ({ App: class { constructor() { host.app = this; } connect() { return Promise.resolve(); } callServerTool(input: any) { return host.handler(input.arguments.request); } } }));
vi.mock('../src/extension-shell.js', () => ({ ExtensionShell: class { ownsPanel = false; wake() {} } }));
vi.mock('../../web/src/host/codex-runtime.js', () => ({ createCodexHostRuntime: (options: any) => { host.options.push(options); return options; } }));
vi.mock('../../web/src/codex-entry.js', () => ({ mountCodexProductionReview: (...args: any[]) => { host.mounts.push(args); return host.unmount; } }));
const active = (suffix = 'old') => ({ status: 'active', runtimeId: `runtime_${suffix}`, attemptId: `attempt_${suffix}`, generation: 1, presentationCapability: 'p'.repeat(43), reconnectTicket: 'r'.repeat(43), continuationCapability: suffix === 'old' ? 'c'.repeat(43) : 'd'.repeat(43) });
const reply = (value: any) => ({ _meta: { [RESPONSE_META_KEY]: value } });
const elements = new Map<string, any>();
function element() { return { inert: false, hidden: false, textContent: '', dataset: {}, setAttribute: vi.fn(), before: vi.fn(), after: vi.fn(), remove: vi.fn() }; }
async function start(handler: (request: any) => Promise<any>) {
  host.handler = handler;
  await import('../src/shell.js');
  host.app.ontoolresult({ structuredContent: { protocolVersion: 1, status: 'pending', receiptId: 'receipt_123', attemptId: 'attempt_old', generation: 1 }, _meta: { [PENDING_META_KEY]: { protocolVersion: 1, runtimeId: 'runtime_old', attemptId: 'attempt_old', generation: 1, receiptId: 'receipt_123', pendingCapability: 'q'.repeat(43) } } });
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); host.options.length = 0; host.mounts.length = 0; host.unmount.mockClear(); elements.clear();
  for (const id of ['#root', '#status', '#detail', '#renewal']) elements.set(id, element());
  vi.stubGlobal('document', { hidden: false, querySelector: (id: string) => elements.get(id), createElement: element, addEventListener: vi.fn() });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
});
afterEach(async () => { await host.app?.onteardown(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('keeps the reader inert through interrupted continuation, retries one operation, and fences the old runtime', async () => {
  const requests: any[] = []; let resumed = false, resumes = 0;
  await start(async request => { requests.push(request); if (request.authority === 'pending') return reply(active());
    if (request.authority === 'continuation') { if (++resumes === 1) throw Error('lost response'); resumed = true; return reply(active('new')); }
    return reply(request.method === 'detach' || resumed ? { status: 'ok', payload: {} } : { status: 'denied', reason: 'revoked' }); });
  expect(elements.get('#root').inert).toBe(true);
  expect(host.mounts).toHaveLength(1);
  expect(host.unmount).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(host.mounts).toHaveLength(2);
  const resume = requests.filter(r => r.authority === 'continuation');
  expect(resume).toHaveLength(2); expect(resume[1]).toEqual(resume[0]);
  await expect(host.options[0].call('review', {})).rejects.toThrow();
  expect(requests.filter(r => r.method === 'review')).toHaveLength(0);
});
it('retires a late resume result after teardown without mounting it', async () => {
  let resolve!: (value: any) => void; const deferred = new Promise(done => { resolve = done; }); const requests: any[] = [];
  await start(async request => { requests.push(request); if (request.authority === 'pending') return reply(active()); if (request.authority === 'continuation') return deferred; return reply(request.method === 'detach' ? { status: 'ok', payload: {} } : { status: 'denied', reason: 'revoked' }); });
  await host.app.onteardown(); resolve(reply(active('new'))); await vi.advanceTimersByTimeAsync(0);
  expect(host.mounts).toHaveLength(1);
  expect(elements.get('#root').inert).toBe(true);
  expect(requests.some(r => r.method === 'detach' && r.runtimeId === 'runtime_new')).toBe(true);
});
it('pauses on mutation transport failure and verifies liveness without replaying the mutation', async () => {
  const requests: any[] = []; let fail = false;
  let resolve!: (value: any) => void; const recovery = new Promise(done => { resolve = done; });
  await start(async request => { requests.push(request); if (request.authority === 'pending') return reply(active()); if (request.method === 'review' && fail) throw Error('offline'); if (fail && request.method !== 'detach') return recovery; return reply({ status: 'ok', payload: {} }); });
  fail = true;
  await expect(host.options[0].call('review', { operation: 'save' })).rejects.toThrow();
  expect(elements.get('#root').inert).toBe(true);
  expect(host.unmount).not.toHaveBeenCalled();
  resolve(reply({ status: 'ok', payload: {} }));
  await vi.advanceTimersByTimeAsync(0);
  expect(elements.get('#root').inert).toBe(false);
  expect(requests.filter(r => r.method === 'review')).toHaveLength(1);
});
