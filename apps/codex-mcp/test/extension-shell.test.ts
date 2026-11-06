import { createHash } from 'node:crypto';
import type { App } from '@modelcontextprotocol/ext-apps';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExtensionShell } from '../src/extension-shell.js';
import { HostResourceAdapter } from '../src/host-resource-adapter.js';
import { EXTENSION_META_KEY } from '../../../packages/core/src/extension-protocol.js';
const host = vi.hoisted(() => ({ options: [] as any[], mounts: [] as any[], unmount: vi.fn(), onMount: undefined as (() => void) | undefined }));
vi.mock('../../web/src/host/codex-runtime.js', () => ({ createCodexHostRuntime: (options: any) => { host.options.push(options); return options; } }));
vi.mock('../../web/src/codex-entry.js', () => ({ mountCodexProductionReview: (...args: any[]) => { host.mounts.push(args); host.onMount?.(); return host.unmount; } }));
const grant = 'a'.repeat(43), nextGrant = 'b'.repeat(43);
const active = (g = grant) => ({ status: 'active', grant: g, presentation: { status: 'active', runtimeId: 'runtime_123', attemptId: 'attempt_123', generation: 1, presentationCapability: 'c'.repeat(43), reconnectTicket: 'd'.repeat(43) } });
const reply = (value: unknown) => ({ _meta: { [EXTENSION_META_KEY]: value } });
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; }
function descendants(node: any): any[] { return (node.append?.mock.calls ?? []).flatMap((args: any[]) => args.flatMap(child => [child, ...descendants(child)])); }
function fixture(handler: (request: any) => Promise<any> = async () => reply({ status: 'ok', payload: {} }), resources: () => any = () => undefined, modelContext: () => any = () => undefined) {
    const calls: any[] = [];
    const app = { getHostCapabilities: () => ({ downloadFile: {} }), downloadFile: vi.fn(async () => ({})), getHostContext: () => ({ displayMode: 'fullscreen' }), callServerTool: vi.fn(async (input: any, _options?: { timeout: number; maxTotalTimeout?: number }) => { calls.push(input.arguments.request); const request = input.arguments.request; return handler(request); }) };
    const element = () => ({ inert: false, hidden: false, textContent: '', dataset: {} as Record<string, string>, replaceChildren: vi.fn(), append: vi.fn() });
    const root = element(), status = element(), controls = element();
    return { app, shell: new ExtensionShell(app as unknown as App, root as unknown as HTMLElement, status as unknown as HTMLElement, controls as unknown as HTMLElement, resources, modelContext), root, status, controls, calls };
}
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('document', { defaultView: new EventTarget(), hidden: false, createElement: (tag: string) => ({ tagName: tag.toUpperCase(), focus: vi.fn(), showModal: vi.fn(), close: vi.fn(), value: '', append: vi.fn(), replaceChildren: vi.fn(), setAttribute: vi.fn(), remove: vi.fn() }), createTextNode: (value: string) => ({ textContent: value }) }); host.options.length = 0; host.mounts.length = 0; host.onMount = undefined; host.unmount.mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('omits manual close and releases ownership automatically when the host tears down', async () => {
    const released = deferred();
    const f = fixture(async request => request.action === 'revoke' ? released.promise : reply({ status: 'ok', payload: {} }));
    await f.shell.receive(active());
    expect(descendants(f.controls).map(node => node.textContent)).not.toContain('Close review');
    f.shell.visibilityChanged(true);
    f.shell.hostContextChanged({ displayMode: 'inline' });
    expect(f.calls.filter(c => c.action === 'revoke')).toHaveLength(0);

    const closing = f.shell.teardown();
    const secondTeardown = f.shell.teardown();
    expect(f.root.inert).toBe(true);
    expect(f.calls.filter(c => c.action === 'revoke')).toEqual([{ action: 'revoke', grant }]);
    released.resolve(reply({ status: 'closed' }));
    await Promise.all([closing, secondTeardown]);
});
it('keeps a cached page connected and releases its grant when the page is discarded', async () => {
    const f = fixture(async request => reply(request.action === 'revoke' ? { status: 'closed' } : { status: 'ok', payload: {} }));
    await f.shell.receive(active());
    document.defaultView!.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
    expect(f.calls.some(c => c.action === 'revoke')).toBe(false);
    document.defaultView!.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
    await f.shell.teardown();
    expect(f.calls.filter(c => c.action === 'revoke')).toEqual([{ action: 'revoke', grant }]);
});
it('exposes only bounded live-tool registration diagnostics on the reader root', async () => {
    (document as any).modelContext = { registerTool: () => { throw new TypeError('private document details'); }, unregisterTool: vi.fn() };
    const f = fixture(); await f.shell.receive(active());
    expect(JSON.parse(f.root.dataset.liveReaderToolsDiagnostic!)).toEqual({ apiPresent: true, registerTool: true, unregisterTool: true, attemptedName: 'inspect_review', successCount: 0, failureName: 'TypeError' });
    expect(f.root.dataset.liveReaderToolsDiagnostic).not.toContain('private');
    await f.shell.teardown();
});
it('revokes a late activation grant without mounting after teardown', async () => {
    const pending = deferred();
    const f = fixture(async (request) => request.action === 'activate' ? pending.promise : reply({ status: 'closed' }));
    const receiving = f.shell.receive({ status: 'provisional', grant });
    const activation = f.calls.find(c => c.action === 'activate');
    expect(activation?.operationId).toEqual(expect.any(String));
    document.defaultView!.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
    expect(f.calls.filter(c => c.action === 'revoke')).toEqual([{ action: 'revoke', grant, operationId: activation.operationId }]);
    pending.resolve(reply(active(nextGrant)));
    await receiving;
    expect(host.mounts).toHaveLength(0);
    expect(f.calls.filter(c => c.action === 'revoke').map(c => c.grant)).toEqual([grant, nextGrant]);
    expect(f.root.inert).toBe(true);
});
it('releases the imported grant on page discard while host subscription is pending', async () => {
    const started = deferred(), subscribed = deferred();
    const file = { name: 'host.pdf', resourceUri: 'opaque:host' };
    const resources = {
        read: async () => ({ contents: [{ uri: file.resourceUri, blob: btoa('%PDF-1.7\nfixture\n%%EOF') }] }),
        subscribe: () => { started.resolve(undefined); return subscribed.promise; },
        unsubscribe: vi.fn(async () => ({})),
        addUpdateHandler: () => () => undefined,
    };
    const f = fixture(async request => {
        if (request.action === 'revoke') return reply({ status: 'closed' });
        const transfer = 't'.repeat(43);
        if (request.operation === 'begin') return reply({ status: 'host-transfer', transfer, offset: 0 });
        if (request.operation === 'chunk') return reply({ status: 'host-transfer', transfer, offset: atob(request.dataBase64).length });
        if (request.operation === 'finish') return reply({ status: 'provisional', grant });
        throw Error('Unexpected request');
    }, () => resources);
    const receiving = f.shell.receive({ status: 'host-resource', file, ticket: 'p'.repeat(43) });
    await started.promise;
    try {
        document.defaultView!.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
        await f.shell.teardown();
        expect(f.calls.filter(c => c.action === 'revoke')).toEqual([{ action: 'revoke', grant }]);
        expect(f.calls.some(c => c.action === 'activate')).toBe(false);
    } finally {
        subscribed.resolve({});
        await receiving;
    }
    expect(host.mounts).toHaveLength(0);
    expect(resources.unsubscribe).toHaveBeenCalledOnce();
});
it('releases ownership on teardown without waiting for host unsubscribe', async () => {
    const pending = deferred();
    let imported = false;
    const resources = {
        read: async () => ({ contents: [{ uri: 'opaque:host', blob: btoa('%PDF-1.7\nfixture\n%%EOF') }] }),
        subscribe: async () => ({}), unsubscribe: vi.fn(() => pending.promise),
        addUpdateHandler: () => () => undefined,
    };
    const f = fixture(async request => {
        if (request.action === 'host-resource') {
            if (request.operation === 'begin') return reply({ status: 'host-transfer', transfer: 't'.repeat(43), offset: 0 });
            if (request.operation === 'chunk') return reply({ status: 'host-transfer', transfer: 't'.repeat(43), offset: atob(request.dataBase64).length + request.offset });
            if (request.operation === 'finish') {
                if (!imported) { imported = true; return reply({ status: 'provisional', grant }); }
                return reply({ status: 'host-ready', generation: 1 });
            }
            if (request.operation === 'save') return reply({ status: 'host-status', outcome: 'read-only' });
        }
        if (request.action === 'activate') return reply(active(nextGrant));
        if (request.action === 'revoke') return reply({ status: 'closed' });
        return reply({ status: 'ok', payload: {} });
    }, () => resources);
    await f.shell.receive({ status: 'host-resource', file: { name: 'host.pdf', resourceUri: 'opaque:host' }, ticket: 'p'.repeat(43) });
    let finished = false;
    const closing = f.shell.teardown().then(() => { finished = true; });
    try {
        await vi.advanceTimersByTimeAsync(0);
        expect(resources.unsubscribe).toHaveBeenCalledOnce();
        expect(f.calls.filter(c => c.action === 'revoke').map(c => c.grant)).toEqual([nextGrant]);
        expect(finished).toBe(true);
        await expect(host.options[0].call('command', {})).rejects.toThrow('stale-reply');
    } finally {
        pending.resolve({});
        await closing;
    }
});
it('revokes a late resume grant and fences callbacks after teardown', async () => {
    const pending = deferred();
    let resumeCalls = 0;
    const f = fixture(async (request) => request.action === 'resume' ? (++resumeCalls === 1 ? pending.promise : reply({ status: 'unavailable' })) : request.action === 'app' ? reply({ status: 'denied', reason: 'expired' }) : reply({ status: 'closed' }));
    await f.shell.receive(active());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.filter(c => c.action === 'resume')).toHaveLength(1);
    const oldReady = host.mounts[0][3];
    const resume = f.calls.find(c => c.action === 'resume');
    expect(resume?.operationId).toEqual(expect.any(String));
    document.defaultView!.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
    expect(f.calls.filter(c => c.action === 'revoke')).toEqual([{ action: 'revoke', grant, operationId: resume.operationId }]);
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
    expect(f.status.textContent).toBe(''); expect(f.status.hidden).toBe(true);
    await expect(host.options[0].call('review', {})).rejects.toThrow('stale-reply');
    await f.shell.teardown();
});

it('opens opaque host bytes in the canonical reader, routes reviewed export, and refreshes on a resource notification', async () => {
    const bytes = btoa('%PDF-1.7\nhost shell fixture\n%%EOF');
    let update!: (event: any) => void, imported = false, generation = 1, copyEstablished = false;
    const resources = { read: vi.fn(async () => ({ contents: [{ uri: 'opaque:host', blob: bytes, openaiMetadata: { writable: false, etag: 'v1' } }] })),
        subscribe: vi.fn(async () => ({})), unsubscribe: vi.fn(async () => ({})), addUpdateHandler: vi.fn((listener: any) => { update = listener; return vi.fn(); }), write: vi.fn() };
    const f = fixture(async request => {
        if (request.action === 'host-resource') {
            if (request.operation === 'begin') return reply({ status: 'host-transfer', transfer: 't'.repeat(43), offset: 0 });
            if (request.operation === 'chunk') return reply({ status: 'host-transfer', transfer: 't'.repeat(43), offset: atob(request.dataBase64).length + request.offset });
            if (request.operation === 'finish') { if (!imported) { imported = true; return reply({ status: 'provisional', grant }); } return reply({ status: 'host-ready', generation }); }
            if (request.operation === 'save') return reply({ status: 'host-status', outcome: 'read-only' });
        }
        if (request.action === 'activate' || request.action === 'resume') return reply({ ...active(nextGrant), presentation: { ...active(nextGrant).presentation, generation } });
        if (request.action === 'app' && request.request.method === 'chooseCopy') return reply({ status: 'ok', payload: { destination: copyEstablished ? { phase: 'active', kind: 'copy' } : { phase: 'host' }, sync: { phase: 'not-saved' } } });
        return reply({ status: 'ok', payload: {} });
    }, () => resources);
    await f.shell.receive({ status: 'host-resource', file: { name: 'host.pdf', resourceUri: 'opaque:host' }, ticket: 'p'.repeat(43) });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.mounts).toHaveLength(1); expect(f.status.textContent).toContain('read-only'); expect(resources.subscribe).toHaveBeenCalledOnce();
    await host.options[0].call('chooseCopy', {});
    expect(f.status.textContent).toContain('read-only');
    copyEstablished = true;
    await host.options[0].call('chooseCopy', {});
    expect(f.status.textContent).not.toContain('read-only');
    const fence = { expectedRevision: 2, documentGeneration: 1 };
    const exported = { kind: 'reviewed-copy' as const, path: 'host-reviewed.pdf', revision: 2, digest: 'a'.repeat(64), warning: 'Verify the downloaded file.' };
    const exportCopy = vi.spyOn(HostResourceAdapter.prototype, 'export').mockImplementation(async function(this: HostResourceAdapter) {
        await this.options.downloadFile!({ contents: [] });
        return exported;
    });
    try {
        await expect(host.options[0].call('exportReviewedCopy', {})).rejects.toThrow('Refresh the review before exporting.');
        expect(exportCopy).not.toHaveBeenCalled();
        await expect(host.options[0].call('exportReviewedCopy', { fence })).resolves.toEqual(exported);
        expect(exportCopy).toHaveBeenCalledWith(nextGrant, fence);
        expect(f.app.downloadFile).toHaveBeenCalledWith({ contents: [] }, undefined);
        expect(JSON.parse(f.root.dataset.hostExportDiagnostic!)).toMatchObject({ phase: 'host-accepted', downloadAdvertised: true });
        expect(f.status.textContent).toContain('host accepted the download');
        f.app.downloadFile.mockResolvedValueOnce({ isError: true });
        await host.options[0].call('exportReviewedCopy', { fence });
        expect(JSON.parse(f.root.dataset.hostExportDiagnostic!)).toMatchObject({ phase: 'host-declined' });
        expect(f.status.textContent).toContain('cancelled or declined');
        f.app.downloadFile.mockRejectedValueOnce(Error('private host details'));
        await expect(host.options[0].call('exportReviewedCopy', { fence })).rejects.toThrow();
        expect(JSON.parse(f.root.dataset.hostExportDiagnostic!)).toMatchObject({ phase: 'failed', previousPhase: 'host-requested' });
        expect(f.root.dataset.hostExportDiagnostic).not.toContain('private host details');
        expect(f.calls.some(c => c.action === 'app' && c.request.method === 'exportReviewedCopy')).toBe(false);
    } finally { exportCopy.mockRestore(); }
    f.app.getHostCapabilities = () => ({}) as any;
    await expect(host.options[0].call('exportReviewedCopy', { fence })).rejects.toThrow('Use Save options');
    const old = host.options[0]; generation = 2; update({ params: { uri: 'opaque:host' } });
    await vi.waitFor(() => expect(host.mounts).toHaveLength(2));
    expect(f.calls.some(c => c.action === 'resume')).toBe(true);
    expect(host.options[1].reviewedCopyExport).toBe(false);
    await expect(old.call('command', {})).rejects.toThrow('stale-reply');
    await f.shell.teardown(); expect(resources.unsubscribe).toHaveBeenCalledOnce(); expect(resources.write).not.toHaveBeenCalled();
});

it.each([false, true])('reopens the selected host PDF after recovery bytes change (lost response=%s)', async lostResponse => {
    const file = { name: 'host.pdf', resourceUri: 'opaque:host' };
    const replacement = { status: 'host-resource', ticket: 'q'.repeat(43), file };
    const first = btoa('%PDF-1.7\ninitial PDF\n%%EOF');
    const changed = btoa('%PDF-1.7\nupdated PDF\n%%EOF');
    const read = vi.fn(async () => ({ contents: [{ uri: file.resourceUri, blob: changed }] }))
        .mockResolvedValueOnce({ contents: [{ uri: file.resourceUri, blob: first }] });
    const resources = { read, subscribe: vi.fn(async () => ({})), unsubscribe: vi.fn(async () => ({})), addUpdateHandler: vi.fn(() => vi.fn()) };
    const independentGrant = 'z'.repeat(43);
    let uploaded = 0, choices = 0;
    const f = fixture(async request => {
        if (request.action === 'choose') {
            choices++;
            return reply(lostResponse && choices > 1 ? replacement : { status: 'provisional', grant });
        }
        if (request.action === 'activate') return reply(active(nextGrant));
        if (request.action === 'host-resource') {
            if (request.operation === 'begin' && request.grant === grant) {
                if (lostResponse) throw Error('transport failed');
                return reply(replacement);
            }
            if (request.operation === 'begin') return reply({ status: 'host-transfer', transfer: 't'.repeat(43), offset: 0 });
            if (request.operation === 'chunk') return reply({ status: 'host-transfer', transfer: 't'.repeat(43), offset: atob(request.dataBase64).length });
            if (request.operation === 'finish') {
                return reply(++uploaded === 1
                    ? { status: 'busy', recoveryToken: 'r'.repeat(43), canResume: true, matchingCopy: true }
                    : uploaded === 2 ? { status: 'provisional', grant: independentGrant } : { status: 'host-ready', generation: 1 });
            }
        }
        return reply({ status: 'ok', payload: {} });
    }, () => resources);
    await f.shell.receive({ status: 'host-resource', file, ticket: 'p'.repeat(43) });
    expect(descendants(f.controls).map(node => node.textContent).join(' ')).toContain('a similar filename');
    const resume = descendants(f.controls).find(button => button.textContent === 'Continue');
    resume.onclick();
    if (lostResponse) {
        await vi.waitFor(() => expect(descendants(f.controls).map(node => node.textContent).join(' ')).toContain('protected work is retained'));
        expect(host.mounts).toHaveLength(0);
        resume.onclick();
    }
    await vi.waitFor(() => expect(host.mounts).toHaveLength(1));
    if (lostResponse) {
        const attemptedChoices = f.calls.filter(call => call.action === 'choose');
        expect(attemptedChoices).toHaveLength(2);
        expect(attemptedChoices[0].operationId).toBe(attemptedChoices[1].operationId);
    }
    expect(f.calls.filter(call => call.action === 'activate').map(call => call.grant)).toEqual([independentGrant]);
    expect(f.calls.some(call => call.operation === 'begin' && call.ticket === replacement.ticket)).toBe(true);
    expect(resources.unsubscribe).toHaveBeenCalledOnce();
    await f.shell.teardown();
});

it('disposes the host route when a busy resource is canceled before choosing a local PDF', async () => {
    const bytes = btoa('%PDF-1.7\nhost chooser fixture\n%%EOF');
    const resources = { read: vi.fn(async () => ({ contents: [{ uri: 'opaque:host', blob: bytes }] })), subscribe: vi.fn(async () => ({})), unsubscribe: vi.fn(async () => ({})), addUpdateHandler: vi.fn(() => vi.fn()), write: vi.fn() };
    const f = fixture(async request => {
        if (request.action === 'host-resource') {
            if (request.operation === 'begin') return reply({ status: 'host-transfer', transfer: 't'.repeat(43), offset: 0 });
            if (request.operation === 'chunk') return reply({ status: 'host-transfer', transfer: 't'.repeat(43), offset: atob(request.dataBase64).length });
            if (request.operation === 'finish') return reply({ status: 'busy', recoveryToken: 'r'.repeat(43), canResume: false });
        }
        if (request.action === 'open') return reply({ status: 'provisional', grant });
        if (request.action === 'activate') return reply(active(nextGrant));
        return reply({ status: 'ok', payload: {} });
    }, () => resources);
    await f.shell.receive({ status: 'host-resource', file: { name: 'host.pdf', resourceUri: 'opaque:host' }, ticket: 'p'.repeat(43) });
    const button = (text: string) => descendants(f.controls).find(button => button.textContent === text);
    button('Cancel').onclick(); await vi.advanceTimersByTimeAsync(0);
    button('New Document').onclick();
    await vi.waitFor(() => expect(host.mounts).toHaveLength(1));
    expect(resources.read).toHaveBeenCalledOnce(); expect(resources.unsubscribe).toHaveBeenCalledOnce();
    expect(f.calls.some(c => c.action === 'host-resource' && c.grant === grant)).toBe(false);
    await f.shell.teardown();
});
it.each(['provisional', 'busy'] as const)('uses the local source route after an expired host choice and a %s picker result', async pickerStatus => {
    const bytes = btoa('%PDF-1.7\nhost chooser fixture\n%%EOF');
    const resources = { read: vi.fn(async () => ({ contents: [{ uri: 'opaque:host', blob: bytes }] })), subscribe: vi.fn(async () => ({})), unsubscribe: vi.fn(async () => ({})), addUpdateHandler: vi.fn(() => vi.fn()) };
    let choices = 0;
    const f = fixture(async request => {
        if (request.action === 'host-resource') {
            if (request.operation === 'begin') return reply({ status: 'host-transfer', transfer: 't'.repeat(43), offset: 0 });
            if (request.operation === 'chunk') return reply({ status: 'host-transfer', transfer: 't'.repeat(43), offset: atob(request.dataBase64).length });
            if (request.operation === 'finish') return reply({ status: 'busy', recoveryToken: 'r'.repeat(43), canResume: true });
        }
        if (request.action === 'choose') return reply(++choices === 1 ? { status: 'unavailable' } : { status: 'provisional', grant });
        if (request.action === 'open') return reply(pickerStatus === 'busy' ? { status: 'busy', recoveryToken: 's'.repeat(43), canResume: false } : { status: 'provisional', grant });
        if (request.action === 'activate') return reply(active(nextGrant));
        return reply({ status: 'ok', payload: {} });
    }, () => resources);
    const button = (text: string) => descendants(f.controls).filter(button => button.textContent === text).at(-1);
    await f.shell.receive({ status: 'host-resource', file: { name: 'host.pdf', resourceUri: 'opaque:host' }, ticket: 'p'.repeat(43) });
    await vi.advanceTimersByTimeAsync(95_000);
    button('Open Copy').onclick(); await vi.advanceTimersByTimeAsync(0);
    button('Choose PDF again').onclick(); await vi.advanceTimersByTimeAsync(0);
    if (pickerStatus === 'busy') { button('Open Copy').onclick(); await vi.advanceTimersByTimeAsync(0); }
    expect(host.mounts).toHaveLength(1);
    expect(resources.read).toHaveBeenCalledOnce();
    expect(resources.unsubscribe).toHaveBeenCalledOnce();
    expect(f.calls.some(c => c.action === 'host-resource' && c.grant === grant)).toBe(false);
    await f.shell.teardown();
});

it('keeps a transport-paused host reader paused when explicit refresh cannot validate the source', async () => {
    const bytes = btoa('%PDF-1.7\nhost paused fixture\n%%EOF');
    const resources = { read: vi.fn(async () => ({ contents: [{ uri: 'opaque:host', blob: bytes }] })), subscribe: vi.fn(async () => ({})), unsubscribe: vi.fn(async () => ({})), addUpdateHandler: vi.fn(() => vi.fn()), write: vi.fn() };
    let imported = false, offline = false;
    let onUpdate!: (event: any) => void;
    resources.addUpdateHandler.mockImplementation(((listener: (event: any) => void) => { onUpdate = listener; return vi.fn(); }) as any);
    const f = fixture(async request => {
        if (request.action === 'host-resource') {
            if (request.operation === 'begin') return reply({ status: 'host-transfer', transfer: 't'.repeat(43), offset: 0 });
            if (request.operation === 'chunk') return reply({ status: 'host-transfer', transfer: 't'.repeat(43), offset: atob(request.dataBase64).length });
            if (request.operation === 'finish') { if (!imported) { imported = true; return reply({ status: 'provisional', grant }); } return reply({ status: 'host-ready', generation: 1 }); }
            if (request.operation === 'save') return reply({ status: 'host-status', outcome: 'read-only' });
        }
        if (request.action === 'activate') return reply(active(nextGrant));
        if (request.action === 'app' && offline) { if (request.request.method === 'command') throw Error('offline'); return new Promise(() => {}); }
        return reply({ status: 'ok', payload: {} });
    }, () => resources);
    await f.shell.receive({ status: 'host-resource', file: { name: 'host.pdf', resourceUri: 'opaque:host' }, ticket: 'p'.repeat(43) });
    await vi.advanceTimersByTimeAsync(0); offline = true;
    await expect(host.options[0].call('command', {})).rejects.toThrow();
    expect(descendants(f.controls).map(node => node.textContent)).not.toContain('Refresh PDF');
    resources.read.mockRejectedValueOnce(Error('resource unavailable'));
    onUpdate({ params: { uri: 'opaque:host' } });
    await vi.waitFor(() => expect(f.status.textContent).toContain('could not be refreshed'));
    const retry = descendants(f.controls).find(button => button.textContent === 'Retry refresh');
    const reads = resources.read.mock.calls.length;
    resources.read.mockRejectedValueOnce(Error('resource still unavailable'));
    retry.onclick(); await vi.advanceTimersByTimeAsync(0);
    expect(resources.read).toHaveBeenCalledTimes(reads + 1);
    expect(f.root.inert).toBe(true); expect(host.mounts).toHaveLength(1); expect(f.calls.some(c => c.action === 'resume')).toBe(false);
    await f.shell.teardown();
});

it('shows a compact open-reader view, applies host theme and safe areas, and expands through the host', async () => {
    const html = { dataset: {} as Record<string, string>, style: { colorScheme: '', setProperty: vi.fn() } };
    vi.stubGlobal('document', { defaultView: new EventTarget(), hidden: false, documentElement: html, createElement: (tag: string) => ({ tagName: tag.toUpperCase(), focus: vi.fn(), showModal: vi.fn(), close: vi.fn(), value: '', append: vi.fn(), replaceChildren: vi.fn(), setAttribute: vi.fn(), remove: vi.fn() }), createTextNode: (value: string) => ({ textContent: value }) });
    const f = fixture();
    f.app.getHostContext = () => ({ displayMode: 'inline', theme: 'dark', safeAreaInsets: { top: 12, bottom: 8, left: 0, right: 0 } });
    const expand = vi.fn(async () => ({ mode: 'fullscreen' })); Object.assign(f.app, { requestDisplayMode: expand });
    await f.shell.receive(active());
    expect(f.root.hidden).toBe(true); expect(f.status.textContent).toContain('Open the reader to edit');
    host.mounts[0][6]('Paper.pdf', 1); expect(f.status.textContent).toContain('Paper.pdf');
    expect(html.dataset.theme).toBe('dark'); expect(html.style.setProperty).toHaveBeenCalledWith('--placekeeper-safe-top', '12px');
    const button = descendants(f.controls).find(button => button.textContent === 'Open reader');
    button.onclick(); await vi.advanceTimersByTimeAsync(0);
    expect(expand).toHaveBeenCalledWith({ mode: 'fullscreen' }); expect(f.root.hidden).toBe(false);
    await f.shell.teardown();
});

it('marks publication intent before sharing, rejects stale generations and retains clear-all intent across reader updates', async () => {
    const marking = deferred(); let current: any = null;
    const api = { getCurrent: () => current, update: vi.fn(async (_params: any) => ({ updateId: 'published' })) };
    const f = fixture(async request => request.action === 'context-published' ? marking.promise : reply({ status: 'ok', payload: {} }), undefined, () => api);
    await f.shell.receive({ ...active(), contextPublished: false });
    const snapshot = { title: 'Paper', documentGeneration: 1, reviewRevision: 0, source: { fileId: 'secret', digest: 'd' }, page: 2, pageCount: 5, annotations: [], selection: null };
    host.mounts[0][5]({ ...snapshot, documentGeneration: 2 }); await vi.advanceTimersByTimeAsync(0); expect(api.update).not.toHaveBeenCalled();
    host.mounts[0][5](snapshot); await vi.advanceTimersByTimeAsync(0); expect(api.update).not.toHaveBeenCalled();
    marking.resolve(reply({ status: 'context-ready' })); await vi.advanceTimersByTimeAsync(0); expect(api.update).toHaveBeenCalledOnce();
    f.shell.hostContextChanged({ 'openai/modelContext': null }); await vi.advanceTimersByTimeAsync(0);
    host.mounts[0][5]({ ...snapshot, page: 3 }); await vi.advanceTimersByTimeAsync(0);
    expect(api.update.mock.calls.at(-1)?.[0]).toEqual({ content: [], structuredContent: {} });
    await f.shell.teardown();
});

it('does not publish when the grant publication-intent acknowledgement fails', async () => {
    const api = { getCurrent: () => null, update: vi.fn() };
    const f = fixture(async request => reply(request.action === 'context-published' ? { status: 'unavailable' } : { status: 'ok', payload: {} }), undefined, () => api);
    await f.shell.receive({ ...active(), contextPublished: false });
    host.mounts[0][5]({ title: 'Paper', documentGeneration: 1, reviewRevision: 0, source: { fileId: 'file', digest: 'd' }, page: 1, pageCount: 2, annotations: [], selection: null });
    await vi.advanceTimersByTimeAsync(0); expect(api.update).not.toHaveBeenCalled();
    await f.shell.teardown();
});
it('reports suspension and restores verified editing on visibility return', async () => {
    const f = fixture(); await f.shell.receive(active());
    f.shell.visibilityChanged(true); expect(f.status.textContent).toContain('suspended'); expect(f.root.inert).toBe(true);
    f.shell.visibilityChanged(false); expect(f.root.inert).toBe(false); await f.shell.teardown();
});

it('publishes fresh initial null context automatically while respecting a later null removal', async () => {
    const api = { getCurrent: () => null, update: vi.fn(async (_params: any) => ({ updateId: 'initial-context' })) };
    const f = fixture(async request => reply(request.action === 'context-published' ? { status: 'context-ready' } : { status: 'ok', payload: {} }), undefined, () => api);
    f.app.getHostContext = () => ({ displayMode: 'fullscreen', 'openai/modelContext': null });
    await f.shell.receive({ ...active(), contextPublished: false });
    const snapshot = { title: 'Paper', documentGeneration: 1, reviewRevision: 0, source: { fileId: 'file', digest: 'd' }, page: 1, pageCount: 2, annotations: [], selection: null };
    expect(host.options[0].contextOwner).toBe('app');
    host.mounts[0][5](snapshot); await vi.advanceTimersByTimeAsync(0);
    expect(api.update).toHaveBeenCalledOnce();
    expect(api.update.mock.calls[0]?.[0].content[0].resource.uri).toBe('placekeeper-context:///background');
    f.shell.hostContextChanged({ 'openai/modelContext': null }); await vi.advanceTimersByTimeAsync(0);
    host.mounts[0][5]({ ...snapshot, page: 2 }); await vi.advanceTimersByTimeAsync(0);
    expect(api.update).toHaveBeenCalledTimes(2); expect(api.update.mock.calls[1]?.[0].content).toEqual([]);
    await f.shell.teardown();
});
it('waits for actual host visibility after expansion before completing live navigation', async () => {
    const tools = new Map<string, any>();
    (document as any).modelContext = { registerTool: (tool: any) => tools.set(tool.name, tool), unregisterTool: (name: string) => tools.delete(name) };
    const f = fixture();
    (f.app as any).requestDisplayMode = vi.fn(async () => ({ mode: 'fullscreen' }));
    await f.shell.receive(active()); await vi.advanceTimersByTimeAsync(0);
    const snapshot = { documentGeneration: 1, reviewRevision: 2, title: 'Paper', source: { fileId: 'file', digest: 'digest' }, page: 1, pageCount: 3, selection: null, annotations: [] };
    const navigate = vi.fn(async () => true);
    host.mounts[0][4].attach({ snapshot: () => snapshot, navigate, search: vi.fn() });
    (document as any).hidden = true; f.shell.visibilityChanged(true);
    const pending = tools.get('navigate_page').execute({ page: 2, documentGeneration: 1, source: { fileId: 'file', digest: 'digest' } });
    await vi.advanceTimersByTimeAsync(0); expect(navigate).not.toHaveBeenCalled();
    (document as any).hidden = false; f.shell.visibilityChanged(false);
    expect(JSON.parse(await pending).status).toBe('navigated'); expect(navigate).toHaveBeenCalledTimes(1);
    await f.shell.teardown(); expect(tools.size).toBe(0);
});
it('reports live navigation unavailable if host expansion never reveals the reader', async () => {
    const tools = new Map<string, any>();
    (document as any).modelContext = { registerTool: (tool: any) => tools.set(tool.name, tool), unregisterTool: (name: string) => tools.delete(name) };
    const f = fixture(); (f.app as any).requestDisplayMode = vi.fn(async () => ({ mode: 'fullscreen' }));
    await f.shell.receive(active()); await vi.advanceTimersByTimeAsync(0);
    const navigate = vi.fn(); host.mounts[0][4].attach({ snapshot: vi.fn(), navigate, search: vi.fn() });
    (document as any).hidden = true; f.shell.visibilityChanged(true);
    const pending = tools.get('navigate_page').execute({ page: 2, documentGeneration: 1, source: { fileId: 'file', digest: 'digest' } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(JSON.parse(await pending).status).toBe('unavailable'); expect(navigate).not.toHaveBeenCalled();
    await f.shell.teardown();
});

it('automatically shares the current review and selection despite stale saved preferences', async () => {
    const update = vi.fn(async (_params: any) => ({ updateId: 'first' }));
    const f = fixture(async request => {
        if (request.action === 'settings-read') return reply({ status: 'settings', revision: 3, values: { backgroundContext: false, selectionSharing: false, mentions: false } });
        return reply(request.action === 'context-published' ? { status: 'context-ready' } : { status: 'ok', payload: {} });
    }, undefined, () => ({ getCurrent: () => null, update }));
    await f.shell.receive({ ...active(), contextPublished: false });
    host.mounts[0][5]({ documentGeneration: 1, reviewRevision: 2, title: 'PDF', source: { digest: 'd', fileId: 'f' }, page: 1, pageCount: 2, selection: { text: 'selected passage', pages: [1] }, annotations: [] });
    f.shell.wake(); await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledOnce();
    expect(JSON.parse(update.mock.calls[0]![0].content[0].resource.text.split('\n').at(-1))).toMatchObject({ title: 'PDF', selection: { text: 'selected passage', pages: [1] } });
    expect(f.calls.some(c => /^(settings-|catalogue|mention-)/.test(c.action))).toBe(false);
    expect(descendants(f.controls).some(node => node.className === 'extension-menu')).toBe(false);
    await f.shell.teardown();
});
it('attaches a captured note through model context without using the prompt composer', async () => {
 const send=vi.fn();const update=vi.fn(async (_params:any)=>({updateId:'attached'}));
 const f=fixture(async r=>reply(r.action==='context-published'?{status:'context-ready'}:{status:'ok',payload:{}}),undefined,()=>({getCurrent:()=>null,update}));Object.assign(f.app,{sendMessage:send});await f.shell.receive(active());
 const snapshot={documentGeneration:1,reviewRevision:2,title:'Original',source:{digest:'original',fileId:'f'},page:1,pageCount:2,selection:{text:'captured',pages:[1]},annotations:[]};
 const preparing=host.mounts[0][4].addContext({kind:'selection',snapshot,note:'My question'});snapshot.selection.text='changed';snapshot.source.digest='changed';
 await vi.advanceTimersByTimeAsync(0);await preparing;
 expect(send).not.toHaveBeenCalled();expect(JSON.stringify(update.mock.calls)).toContain('captured');expect(JSON.stringify(update.mock.calls)).toContain('My question');expect(JSON.stringify(update.mock.calls)).not.toContain('changed');await f.shell.teardown();
});
it.each([false, true])('replays a lost host resume receipt before refreshing rotated authority (host update: %s)', async updateDuringReplay => {
    const bytes = btoa('%PDF-1.7\nresume fixture\n%%EOF');
    let update!: (event: any) => void;
    const resources = { read: vi.fn(async () => ({ contents: [{ uri: 'opaque:host', blob: bytes }] })), subscribe: vi.fn(async () => ({})), unsubscribe: vi.fn(async () => ({})), addUpdateHandler: vi.fn(listener => { update = listener; return vi.fn(); }) };
    const rotated = 'e'.repeat(43), finalGrant = 'f'.repeat(43);
    let imported = false, expired = false, rotatedAway = false, delivered = false, attempts = 0;
    const f = fixture(async request => {
        if (request.action === 'host-resource') {
            if (request.operation === 'begin') {
                if (rotatedAway && request.grant === nextGrant) return reply({ status: 'unavailable' });
                return reply({ status: 'host-transfer', transfer: 't'.repeat(43), offset: 0 });
            }
            if (request.operation === 'chunk') return reply({ status: 'host-transfer', transfer: 't'.repeat(43), offset: request.offset + atob(request.dataBase64).length });
            if (request.operation === 'finish') { if (!imported) { imported = true; return reply({ status: 'provisional', grant }); } return reply({ status: 'host-ready', generation: 1 }); }
            if (request.operation === 'save') return reply({ status: 'host-status', outcome: 'read-only' });
        }
        if (request.action === 'activate') return reply(active(nextGrant));
        if (request.action === 'resume') {
            attempts++;
            if (attempts === 1) {
                rotatedAway = true;
                if (updateDuringReplay) update({ params: { uri: 'opaque:host' } });
                throw Error('successful response dropped');
            }
            delivered = true;
            return reply(active(request.grant === rotated ? finalGrant : rotated));
        }
        if (request.action === 'app') return reply(expired && !delivered ? { status: 'denied', reason: 'expired' } : { status: 'ok', payload: {} });
        return reply({ status: 'closed' });
    }, () => resources);
    await f.shell.receive({ status: 'host-resource', file: { name: 'host.pdf', resourceUri: 'opaque:host' }, ticket: 'p'.repeat(43) });
    await vi.advanceTimersByTimeAsync(0);
    expired = true; f.shell.wake();
    await vi.waitFor(() => expect(attempts).toBe(1));
    expect(f.root.inert).toBe(true);
    await vi.waitFor(() => expect(host.mounts).toHaveLength(2), { timeout: 3000 });
    const resumes = f.calls.filter(c => c.action === 'resume');
    expect(resumes).toHaveLength(3);
    expect(resumes[1]).toEqual(resumes[0]);
    const refreshGrants = f.calls.filter(c => c.action === 'host-resource' && c.operation === 'begin' && c.grant).map(c => c.grant);
    expect(refreshGrants.filter(g => g === nextGrant)).toHaveLength(1);
    expect(refreshGrants).toContain(rotated);
    expect(resumes[2].grant).toBe(rotated);
    expect(host.mounts).toHaveLength(2);
    expect(f.root.inert).toBe(false);
    await f.shell.teardown();
});

it.each(['Open Copy', 'Cancel'])('keeps %s fenced while a recovery resume is pending', async competing => {
    const pending = deferred();
    const f = fixture(async request => request.action === 'choose' ? pending.promise : reply({ status: 'closed' }));
    await f.shell.receive({ status: 'busy', recoveryToken: 'r'.repeat(43), canResume: true });
    const dialog = descendants(f.controls).find(node => node.tagName === 'DIALOG');
    expect(dialog?.showModal).toHaveBeenCalledOnce();
    const buttons = descendants(dialog).filter(node => node.tagName === 'BUTTON');
    const resume = buttons.find(button => button.textContent === 'Continue');
    resume.onclick();
    expect(buttons.every(button => button.disabled)).toBe(true);
    buttons.find(button => button.textContent === competing).onclick();
    expect(f.calls.filter(c => c.action === 'choose')).toHaveLength(1);
    pending.resolve(reply(active(nextGrant))); await vi.advanceTimersByTimeAsync(0);
    expect(host.mounts).toHaveLength(1);
    expect(f.status.textContent).not.toContain('connection ended');
    expect(f.controls.append.mock.calls.some(([button]) => button.textContent === 'New Document')).toBe(false);
    await f.shell.teardown();
});

it('offers fresh source selection after an expired recovery choice without ending the panel', async () => {
    const f = fixture(async request => reply(request.action === 'choose' ? { status: 'unavailable' } : request.action === 'open' ? { status: 'busy', recoveryToken: 's'.repeat(43), canResume: true } : { status: 'closed' }));
    await f.shell.receive({ status: 'busy', recoveryToken: 'r'.repeat(43), canResume: true });
    const oldButtons = descendants(f.controls);
    await vi.advanceTimersByTimeAsync(95_000);
    oldButtons.find(button => button.textContent === 'Open Copy').onclick();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.status.textContent).toContain('Choose the PDF again');
    expect(f.status.textContent).not.toContain('connection ended');
    expect(host.mounts).toHaveLength(0);
    oldButtons.find(button => button.textContent === 'Continue').onclick();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.filter(c => c.action === 'choose')).toHaveLength(1);
    descendants(f.controls).find(button => button.textContent === 'Choose PDF again').onclick();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.filter(c => c.action === 'open')).toEqual([{ action: 'open' }]);
    expect(descendants(f.controls).map(node => node.textContent).join(' ')).toContain('Reopen Document');
    expect(f.calls.filter(c => c.action === 'choose')).toHaveLength(1);
    await f.shell.teardown();
});

it('fences retained recovery callbacks after cancel', async () => {
    const f = fixture(async () => reply({ status: 'cancelled' }));
    await f.shell.receive({ status: 'busy', recoveryToken: 'r'.repeat(43), canResume: true });
    const buttons = descendants(f.controls);
    buttons.find(button => button.textContent === 'Cancel').onclick(); await vi.advanceTimersByTimeAsync(0);
    buttons.find(button => button.textContent === 'Continue').onclick(); await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.filter(c => c.action === 'choose')).toHaveLength(0);
    expect(host.mounts).toHaveLength(0);
    await f.shell.teardown();
});

it('fences an expired-choice picker and revokes its late grant after cancel', async () => {
    const pending = deferred();
    const f = fixture(async request => request.action === 'open' ? pending.promise : reply(request.action === 'choose' ? { status: 'unavailable' } : { status: 'closed' }));
    await f.shell.receive({ status: 'busy', recoveryToken: 'r'.repeat(43), canResume: true });
    descendants(f.controls).find(button => button.textContent === 'Open Copy').onclick();
    await vi.advanceTimersByTimeAsync(0);
    const buttons = descendants(f.controls);
    const choose = buttons.find(button => button.textContent === 'Choose PDF again');
    choose.onclick();
    buttons.filter(button => button.textContent === 'Cancel').at(-1).onclick();
    await vi.advanceTimersByTimeAsync(0);
    pending.resolve(reply(active(nextGrant))); await vi.advanceTimersByTimeAsync(0);
    choose.onclick(); await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.filter(c => c.action === 'open')).toHaveLength(1);
    expect(f.calls.filter(c => c.action === 'revoke').map(c => c.grant)).toEqual([nextGrant]);
    expect(host.mounts).toHaveLength(0);
    await f.shell.teardown();
});

it.each(['chooseFolder', 'locateSave'])('preserves the canonical SDK budget for nested %s', async method => {
    const f = fixture();
    await f.shell.receive(active()); await vi.advanceTimersByTimeAsync(0);
    await host.options[0].call(method, {});
    const call = f.app.callServerTool.mock.calls.find(([input]) => input.arguments.request.action === 'app' && input.arguments.request.request.method === method);
    expect(call?.[1]).toEqual({ timeout: 315_000, maxTotalTimeout: 315_000 });
    await f.shell.teardown();
});

it('revokes a late recovery choice grant after teardown', async () => {
    const pending = deferred();
    const f = fixture(async request => request.action === 'choose' ? pending.promise : reply({ status: 'closed' }));
    await f.shell.receive({ status: 'busy', recoveryToken: 'r'.repeat(43), canResume: true });
    descendants(f.controls).find(button => button.textContent === 'Continue').onclick();
    await f.shell.teardown(); pending.resolve(reply(active(nextGrant))); await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.filter(c => c.action === 'revoke').map(c => c.grant)).toEqual([nextGrant]);
    expect(host.mounts).toHaveLength(0);
});

it('restores the recovery button group after a failed choice and retries its operation identity', async () => {
    let attempts = 0;
    const f = fixture(async request => { if (request.action === 'choose') { if (++attempts === 1) throw Error('offline'); return reply(active(nextGrant)); } return reply({ status: 'closed' }); });
    await f.shell.receive({ status: 'busy', recoveryToken: 'r'.repeat(43), canResume: true });
    const buttons = descendants(f.controls).filter(node => node.tagName === 'BUTTON'), resume = buttons.find(button => button.textContent === 'Continue');
    resume.onclick(); await vi.advanceTimersByTimeAsync(0);
    expect(buttons.every(button => button.disabled === false)).toBe(true);
    resume.onclick(); await vi.advanceTimersByTimeAsync(0);
    const choices = f.calls.filter(c => c.action === 'choose'); expect(choices[1]).toEqual(choices[0]);
    expect(host.mounts).toHaveLength(1); await f.shell.teardown();
});

it('revokes a late chooser result after teardown and fences the retained picker callback', async () => {
    const pending = deferred();
    const f = fixture(async request => request.action === 'open' ? pending.promise : reply({ status: 'closed' }));
    await f.shell.receive({ status: 'chooser' });
    const choose = descendants(f.controls).find(button => button.textContent === 'New Document');
    choose.onclick(); await f.shell.teardown();
    pending.resolve(reply(active(nextGrant))); await vi.advanceTimersByTimeAsync(0);
    choose.onclick(); await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.filter(c => c.action === 'open')).toHaveLength(1);
    expect(f.calls.filter(c => c.action === 'revoke').map(c => c.grant)).toEqual([nextGrant]);
    expect(host.mounts).toHaveLength(0);
});

it('own-save notification does not retire a changed-name export before host download finishes', async () => {
 const bytes=Buffer.from('%PDF-1.7\nsource\n%%EOF'), saved=Buffer.from('%PDF-1.7\nchanged-author\n%%EOF');
 const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
 let update:(event:any)=>void=()=>{}, imported=false, dirty=false, acknowledged=false;
 const download=deferred(), writeStarted=deferred(), downloadStarted=deferred(), remounted=deferred();
 const resources={read:vi.fn(async()=>({contents:[{uri:'opaque:host',blob:(acknowledged?saved:bytes).toString('base64'),openaiMetadata:{writable:true,etag:acknowledged?'v2':'v1'}}]})),subscribe:vi.fn(async()=>({})),unsubscribe:vi.fn(async()=>({})),addUpdateHandler:vi.fn((fn:any)=>{update=fn;return vi.fn();}),write:vi.fn(async()=>{writeStarted.resolve(undefined);update({params:{uri:'opaque:host'}});return {outcome:'saved',etag:'v2'};})};
 const f=fixture(async r=>{
  if(r.action==='host-resource'){
   if(r.operation==='begin')return reply({status:'host-transfer',transfer:'t'.repeat(43),offset:0});
   if(r.operation==='chunk')return reply({status:'host-transfer',transfer:'t'.repeat(43),offset:atob(r.dataBase64).length+r.offset});
   if(r.operation==='finish'){if(!imported){imported=true;return reply({status:'provisional',grant});}return reply({status:'host-ready',generation:1});}
   if(r.operation==='save'&&!dirty)return reply({status:'host-status',outcome:'saved'});
   if(r.operation==='save'||r.operation==='export')return reply({status:'host-save',intent:{id:'i'.repeat(43),purpose:r.operation,generation:1,revision:1,stateDigest:'a'.repeat(64),sourceDigest:sha(bytes),sha256:sha(saved),byteLength:saved.length,ifMatch:r.operation==='save'?'v1':''}});
   if(r.operation==='save-chunk')return reply({status:'host-chunk',dataBase64:saved.toString('base64'),done:true});
   if(r.operation==='receipt'){acknowledged=true;dirty=false;return reply({status:'host-status',outcome:'saved'});}
  }
  if(r.action==='activate'||r.action==='resume')return reply(active(nextGrant));
  if(r.action==='app'&&r.request.method==='command'){dirty=true;return reply({status:'ok',payload:{revision:1,workflow:{documentGeneration:1}}});}
  return reply({status:'ok',payload:{}});
 },()=>resources);
 f.app.downloadFile.mockImplementation(()=>{downloadStarted.resolve(undefined);return download.promise;});
 await f.shell.receive({status:'host-resource',file:{name:'host.pdf',resourceUri:'opaque:host'},ticket:'p'.repeat(43)});
 await vi.advanceTimersByTimeAsync(0);
 const port=host.options[0];
 const named=await port.call('command',{type:'set-annotation-name',expectedRevision:0,annotationName:'New Author'});
 const exported=port.call('exportReviewedCopy',{fence:{expectedRevision:named.revision,documentGeneration:named.workflow.documentGeneration}});
 await vi.advanceTimersByTimeAsync(0);
 await writeStarted.promise;
 await downloadStarted.promise;
 expect(resources.write).toHaveBeenCalledOnce();
 expect(f.app.downloadFile).toHaveBeenCalledOnce();
 expect(host.mounts).toHaveLength(1);
 expect(f.calls.filter(c=>c.action==='resume')).toHaveLength(0);
 host.onMount=()=>{if(host.mounts.length===2)remounted.resolve(undefined);};
 download.resolve({});
 await expect(exported).resolves.toMatchObject({kind:'reviewed-copy',revision:1});
 await remounted.promise;
 expect(host.mounts).toHaveLength(2);
 expect(f.status.textContent).toContain('host accepted the download');
 expect(JSON.parse(f.root.dataset.hostExportDiagnostic!)).toMatchObject({ phase: 'host-accepted' });
 expect(resources.write).toHaveBeenCalledOnce();
 await f.shell.teardown();
});


it('waits for the in-flight host write before choosing a local copy, then saves only the copy',async()=>{
 const pdf=Buffer.from('%PDF-1.7\ncopy-switch fixture\n%%EOF'),sha=createHash('sha256').update(pdf).digest('hex');
 const pendingWrite=deferred(), writeStarted=deferred(), localSaveChecked=deferred(), localRetried=deferred();let imported=false,dirty=false,local=false;
 const resources={read:vi.fn(async()=>({contents:[{uri:'opaque:host',blob:pdf.toString('base64'),openaiMetadata:{writable:true,etag:'v1'}}]})),subscribe:vi.fn(async()=>({})),unsubscribe:vi.fn(async()=>({})),addUpdateHandler:vi.fn(()=>vi.fn()),write:vi.fn(()=>{writeStarted.resolve(undefined);return pendingWrite.promise;})};
 const f=fixture(async r=>{
  if(r.action==='activate'||r.action==='resume')return reply(active());
  if(r.action==='host-resource'){
   if(r.operation==='begin')return reply({status:'host-transfer',transfer:'t'.repeat(43),offset:0});
   if(r.operation==='chunk')return reply({status:'host-transfer',transfer:'t'.repeat(43),offset:pdf.length});
   if(r.operation==='finish'){if(imported)return reply({status:'host-ready',generation:1});imported=true;return reply({status:'provisional',grant});}
   if(r.operation==='save'&&local)localSaveChecked.resolve(undefined);
   if(r.operation==='save')return reply(local?{status:'host-status',outcome:'local-copy'}:dirty?{status:'host-save',intent:{id:'i'.repeat(43),generation:1,revision:1,stateDigest:'a'.repeat(64),sourceDigest:sha,sha256:sha,byteLength:pdf.length,ifMatch:'v1',purpose:'save'}}:{status:'host-status',outcome:'saved'});
   if(r.operation==='save-chunk')return reply({status:'host-chunk',dataBase64:pdf.toString('base64'),done:true});
   if(r.operation==='receipt'){dirty=false;return reply({status:'host-status',outcome:'saved'});}
  }
  if(r.action==='app'){
   if(r.request.method==='saveStatus')return reply({status:'ok',payload:{destination:{phase:local?'active':'host'},sync:{phase:'clean'}}});
   if(r.request.method==='chooseCopy'){local=true;return reply({status:'ok',payload:{destination:{phase:'active'},sync:{phase:'clean'}}});}
   if(r.request.method==='command')dirty=true;
   if(r.request.method==='retrySave')localRetried.resolve(undefined);
  }
  return reply({status:'ok',payload:{}});
 },()=>resources);
 await f.shell.receive({status:'host-resource',file:{name:'host.pdf',resourceUri:'opaque:host'},ticket:'p'.repeat(43)});
 await vi.advanceTimersByTimeAsync(0);
 const port=host.options[0];await port.call('command',{});
 await writeStarted.promise;
 expect(resources.write).toHaveBeenCalledOnce();
 const selecting=port.call('chooseCopy',{filename:'copy.pdf',folderSelectionId:'opaque-selection'});
 await vi.advanceTimersByTimeAsync(0);
 expect(local).toBe(false);
 pendingWrite.resolve({outcome:'saved',etag:'v2'});await selecting;
 expect(local).toBe(true);
 await port.call('command',{});await localSaveChecked.promise;
 expect(resources.write).toHaveBeenCalledOnce();
 expect(descendants(f.controls).map(node => node.textContent)).not.toContain('Save now');
 await port.call('retrySave', {});await localRetried.promise;
 expect(f.calls.some(r=>r.action==='app'&&r.request.method==='retrySave')).toBe(true);
 expect(resources.write).toHaveBeenCalledOnce();
 await f.shell.teardown();
});

it('rechecks a live review and waits for a separate user choice before resuming', async () => {
    const liveToken = 'l'.repeat(43), recoveredToken = 'r'.repeat(43);
    const f = fixture(async request => {
        if (request.action === 'recheck') return reply({ status: 'busy', recoveryToken: recoveredToken, canResume: false, canRecover: true });
        if (request.action === 'choose') return reply(active());
        return reply({ status: 'closed' });
    });
    await f.shell.receive({ status: 'busy', recoveryToken: liveToken, canResume: false });
    const nodes = () => descendants(f.controls);
    expect(nodes().some(node => node.textContent === 'Continue')).toBe(false);
    nodes().find(node => node.textContent === 'Check again').onclick();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toEqual([{ action: 'recheck', recoveryToken: liveToken }]);
    expect(host.mounts).toHaveLength(0);
    nodes().find(node => node.textContent === 'Continue').onclick();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.find(c => c.action === 'choose')).toMatchObject({ choice: 'recover', recoveryToken: recoveredToken });
    expect(host.mounts).toHaveLength(1);
    await f.shell.teardown();
});
it('offers explicit disconnected recovery without silently choosing it', async () => {
 const f=fixture(async r=>reply(r.action==='choose'?{status:'provisional',grant}:r.action==='activate'?active():{status:'ok',payload:{}}));
 await f.shell.receive({status:'busy',recoveryToken:'r'.repeat(43),canResume:false,canRecover:true});
 expect(f.calls.some(r=>r.action==='choose')).toBe(false);
 const recover=descendants(f.controls).find(b=>b.textContent==='Continue');
 expect(recover).toBeDefined();recover.onclick();await vi.advanceTimersByTimeAsync(0);
 expect(f.calls.find(r=>r.action==='choose')).toMatchObject({choice:'recover'});
 expect(host.mounts).toHaveLength(1);await f.shell.teardown();
});
it('lists recent reviews in the conversation chooser and opens only the selected opaque ID', async () => {
 const id='z'.repeat(32);
 const f=fixture(async r=>reply(r.action==='recent-list'?{status:'recent-reviews',items:[{id,title:'Recent.pdf',updatedAt:'2026-11-05T12:00:00.000Z',page:3}]}:r.action==='recent-open'?{status:'busy',recoveryToken:'r'.repeat(43),canResume:true}:{status:'closed'}));
 await f.shell.receive({status:'chooser'});await vi.advanceTimersByTimeAsync(0);
 expect(f.calls.some(r=>r.action==='recent-open')).toBe(false);
 const resume=descendants(f.controls).find(b=>b.textContent==='Resume');
 expect(resume).toBeDefined();resume.onclick();await vi.advanceTimersByTimeAsync(0);
 expect(f.calls.find(r=>r.action==='recent-open')).toEqual({action:'recent-open',id});
 expect(f.calls.find(r=>r.action==='choose')).toMatchObject({choice:'resume'});
 await f.shell.teardown();
});

it('offers recent reviews without a cross-chat snapshot picker in the empty chooser', async () => {
    const f = fixture(async request => reply(request.action === 'recent-list' ? { status: 'recent-reviews', items: [] } : { status: 'closed' }));
    await f.shell.receive({ status: 'chooser' }); await vi.advanceTimersByTimeAsync(0);
    expect(descendants(f.controls).map(node => node.textContent)).toContain('Recent Documents');
    expect(descendants(f.controls).some(node => node.className === 'snapshot-context-picker')).toBe(false);
    expect(f.calls).toEqual([{ action: 'recent-list' }]);
    await f.shell.teardown();
});

it.each(['picker', 'recent'] as const)('serializes %s opening against the other chooser actions through activation', async first => {
 const opening=deferred(), activation=deferred(), id='z'.repeat(32);
 const f=fixture(async r=>r.action==='recent-list'?reply({status:'recent-reviews',items:[{id,title:'Recent.pdf',updatedAt:'2026-11-05T12:00:00.000Z'}]}):r.action==='open'||r.action==='recent-open'?opening.promise:r.action==='activate'?activation.promise:reply({status:'closed'}));
 await f.shell.receive({status:'chooser'});await vi.advanceTimersByTimeAsync(0);
 const buttons=descendants(f.controls);
 const picker=buttons.find(b=>b.textContent==='New Document'), recent=buttons.find(b=>b.textContent==='Resume');
 const chosen=first==='picker'?picker:recent, other=first==='picker'?recent:picker;
 chosen.onclick();other.onclick();await vi.advanceTimersByTimeAsync(0);
 expect(f.calls.filter(r=>r.action==='open'||r.action==='recent-open')).toHaveLength(1);
 opening.resolve(reply({status:'provisional',grant}));await vi.advanceTimersByTimeAsync(0);
 other.onclick();await vi.advanceTimersByTimeAsync(0);
 expect(f.calls.filter(r=>r.action==='open'||r.action==='recent-open')).toHaveLength(1);
 activation.resolve(reply(active(nextGrant)));await vi.advanceTimersByTimeAsync(0);
 expect(host.mounts).toHaveLength(1);await f.shell.teardown();
});

it.each(['resume', 'fork'] as const)('runs recent %s directly and retries a lost choice response with the same operation', async choice => {
 const id='z'.repeat(32); let attempts=0;
 const f=fixture(async r => {
  if(r.action==='recent-list') return reply({status:'recent-reviews',items:[{id,title:'Recent.pdf',updatedAt:'2026-11-05T12:00:00Z'}]});
  if(r.action==='recent-open') return reply({status:'busy',recoveryToken:'r'.repeat(43),canResume:true});
  if(r.action==='choose') { if(++attempts===1) throw Error('lost response'); return reply({status:'cancelled'}); }
  return reply({status:'closed'});
 });
 await f.shell.receive({status:'chooser'});await vi.advanceTimersByTimeAsync(0);
 const button=descendants(f.controls).find(b=>b.textContent===(choice==='resume'?'Resume':'Open Copy'));
 button.onclick();await vi.advanceTimersByTimeAsync(0);
 expect(descendants(f.controls).some(b=>b.tagName==='DIALOG')).toBe(false);
 button.onclick();await vi.advanceTimersByTimeAsync(0);
 const calls=f.calls.filter(r=>r.action==='choose');
 expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);expect(calls[0]).toMatchObject({choice});
 expect(f.calls.filter(r=>r.action==='recent-open')).toHaveLength(1);
 await f.shell.teardown();
});
it('leaves a still-owned recent document in its card without taking over or opening a dialog', async () => {
 const f=fixture(async r=>reply(r.action==='recent-list'?{status:'recent-reviews',items:[{id:'z'.repeat(32),title:'Recent.pdf',updatedAt:'2026-11-05T12:00:00Z'}]}:r.action==='recent-open'?{status:'busy',recoveryToken:'r'.repeat(43),canResume:false}:{status:'closed'}));
 await f.shell.receive({status:'chooser'});await vi.advanceTimersByTimeAsync(0);
 descendants(f.controls).find(b=>b.textContent==='Resume').onclick();await vi.advanceTimersByTimeAsync(0);
 expect(f.calls.some(r=>r.action==='choose')).toBe(false);
 expect(descendants(f.controls).some(b=>b.tagName==='DIALOG')).toBe(false);
 expect(descendants(f.controls).map(b=>b.textContent).join(' ')).toContain('Still open elsewhere');
 await f.shell.teardown();
});

it('applies host layout when the chooser arrives after initial host context', async () => {
    const html = { dataset: {} as Record<string, string>, style: { setProperty: vi.fn() } };
    (document as any).documentElement = html;
    const f = fixture(async () => reply({ status: 'recent-reviews', items: [] }));
    f.shell.hostContextChanged(f.app.getHostContext() as any);
    await f.shell.receive({ status: 'chooser' });
    expect(html.dataset.placekeeperExtension).toBe('true');
    expect(f.controls.dataset.mode).toBe('chooser');
    await f.shell.teardown();
});
