import type { App } from '@modelcontextprotocol/ext-apps';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExtensionShell } from '../src/extension-shell.js';
import { EXTENSION_META_KEY } from '../../../packages/core/src/extension-protocol.js';
const host = vi.hoisted(() => ({ options: [] as any[], mounts: [] as any[], unmount: vi.fn() }));
vi.mock('../../web/src/host/codex-runtime.js', () => ({ createCodexHostRuntime: (options: any) => { host.options.push(options); return options; } }));
vi.mock('../../web/src/codex-entry.js', () => ({ mountCodexProductionReview: (...args: any[]) => { host.mounts.push(args); return host.unmount; } }));
const grant = 'a'.repeat(43), nextGrant = 'b'.repeat(43);
const active = (g = grant) => ({ status: 'active', grant: g, presentation: { status: 'active', runtimeId: 'runtime_123', attemptId: 'attempt_123', generation: 1, presentationCapability: 'c'.repeat(43), reconnectTicket: 'd'.repeat(43) } });
const reply = (value: unknown) => ({ _meta: { [EXTENSION_META_KEY]: value } });
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(handler: (request: any) => Promise<any> = async () => reply({ status: 'ok', payload: {} })) {
    const calls: any[] = [];
    const app = { callServerTool: vi.fn(async (input: any) => { calls.push(input.arguments.request); return handler(input.arguments.request); }) };
    const element = () => ({ inert: false, hidden: false, textContent: '', replaceChildren: vi.fn(), append: vi.fn() });
    const root = element(), status = element(), controls = element();
    return { shell: new ExtensionShell(app as unknown as App, root as unknown as HTMLElement, status as unknown as HTMLElement, controls as unknown as HTMLElement), root, status, calls };
}
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('document', { hidden: false, createElement: () => ({}) }); host.options.length = 0; host.mounts.length = 0; host.unmount.mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('revokes a late activation grant without mounting after teardown', async () => {
    const pending = deferred();
    const f = fixture(async (request) => request.action === 'activate' ? pending.promise : reply({ status: 'closed' }));
    const receiving = f.shell.receive({ status: 'provisional', grant });
    await f.shell.teardown();
    pending.resolve(reply(active(nextGrant)));
    await receiving;
    expect(host.mounts).toHaveLength(0);
    expect(f.calls.filter(c => c.action === 'revoke').map(c => c.grant)).toEqual([grant, nextGrant]);
    expect(f.root.inert).toBe(true);
});
it('revokes a late resume grant and fences callbacks after teardown', async () => {
    const pending = deferred();
    let resumeCalls = 0;
    const f = fixture(async (request) => request.action === 'resume' ? (++resumeCalls === 1 ? pending.promise : reply({ status: 'unavailable' })) : request.action === 'app' ? reply({ status: 'denied', reason: 'expired' }) : reply({ status: 'closed' }));
    await f.shell.receive(active());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.filter(c => c.action === 'resume')).toHaveLength(1);
    const oldReady = host.mounts[0][3];
    await f.shell.teardown();
    pending.resolve(reply(active(nextGrant)));
    await vi.advanceTimersByTimeAsync(0);
    oldReady();
    expect(host.mounts).toHaveLength(1);
    expect(f.calls.filter(c => c.action === 'revoke').map(c => c.grant)).toEqual([grant, nextGrant]);
    expect(f.root.inert).toBe(true);
});
it('pauses a mounted reader on user transport failure and never replays the mutation', async () => {
    let fail = false;
    const recovery = deferred();
    const f = fixture(async (request) => { if (request.action === 'app' && fail) {
        if (request.request.method === 'review')
            throw Error('offline');
        return recovery.promise;
    } return reply({ status: 'ok', payload: {} }); });
    await f.shell.receive(active());
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    await expect(host.options[0].call('review', { operation: 'save' })).rejects.toThrow();
    expect(f.root.inert).toBe(true);
    expect(host.unmount).not.toHaveBeenCalled();
    recovery.resolve(reply({ status: 'ok', payload: {} }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.root.inert).toBe(false);
    expect(f.calls.filter(c => c.action === 'app' && c.request.method === 'review')).toHaveLength(1);
    await f.shell.teardown();
});
it('retries continuation with one operation identity and fences the old mounted callbacks', async () => {
    let resumed = false, attempts = 0;
    const f = fixture(async (request) => {
        if (request.action === 'resume') {
            if (++attempts === 1)
                throw Error('offline');
            resumed = true;
            return reply(active(nextGrant));
        }
        if (request.action === 'app')
            return reply(resumed ? { status: 'ok', payload: {} } : { status: 'denied', reason: 'expired' });
        return reply({ status: 'closed' });
    });
    await f.shell.receive(active());
    await vi.advanceTimersByTimeAsync(0);
    const oldReady = host.mounts[0][3], oldFailure = host.mounts[0][2];
    expect(f.root.inert).toBe(true);
    expect(host.mounts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.mounts).toHaveLength(2);
    const resumes = f.calls.filter(c => c.action === 'resume');
    expect(resumes).toHaveLength(2);
    expect(resumes[1]).toEqual(resumes[0]);
    host.mounts[1][3]();
    oldFailure();
    oldReady();
    expect(f.status.textContent).toBe('');
    await expect(host.options[0].call('review', {})).rejects.toThrow('stale-reply');
    await f.shell.teardown();
});
