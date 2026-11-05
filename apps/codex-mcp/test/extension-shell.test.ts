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
function fixture(handler: (request: any) => Promise<any> = async () => reply({ status: 'ok', payload: {} }), resources: () => any = () => undefined, modelContext: () => any = () => undefined, preferences?: (request: any) => Promise<any>, message: () => any = () => undefined) {
    const calls: any[] = [];
    const app = { getHostCapabilities: () => ({ downloadFile: {} }), downloadFile: vi.fn(async () => ({})), getHostContext: () => ({ displayMode: 'fullscreen' }), callServerTool: vi.fn(async (input: any, _options?: { timeout: number; maxTotalTimeout?: number }) => { calls.push(input.arguments.request); const request = input.arguments.request; if (preferences && ['settings-read', 'settings-update', 'catalogue'].includes(request.action)) return preferences(request); if (request.action === 'settings-read') return reply({ status: 'settings', values: { backgroundContext: true, selectionSharing: true, mentions: false }, revision: 0 }); if (request.action === 'catalogue') return reply({ status: 'catalogue', included: false }); return handler(request); }) };
    const element = () => ({ inert: false, hidden: false, textContent: '', dataset: {} as Record<string, string>, replaceChildren: vi.fn(), append: vi.fn() });
    const root = element(), status = element(), controls = element();
    return { app, shell: new ExtensionShell(app as unknown as App, root as unknown as HTMLElement, status as unknown as HTMLElement, controls as unknown as HTMLElement, resources, modelContext, message), root, status, controls, calls };
}
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('document', { hidden: false, createElement: () => ({ append: vi.fn(), replaceChildren: vi.fn(), setAttribute: vi.fn() }), createTextNode: (value: string) => ({ textContent: value }) }); host.options.length = 0; host.mounts.length = 0; host.onMount = undefined; host.unmount.mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
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
    expect(f.status.textContent).toContain('Live reader tools are unavailable');
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
    expect(f.status.textContent).toContain('a similar filename');
    const resume = f.controls.append.mock.calls.map(([button]) => button).find(button => button.textContent === 'Resume protected review');
    resume.onclick();
    if (lostResponse) {
        await vi.waitFor(() => expect(f.status.textContent).toContain('protected work is retained'));
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
    const button = (text: string) => f.controls.append.mock.calls.map(([button]) => button).find(button => button.textContent === text);
    button('Cancel').onclick(); await vi.advanceTimersByTimeAsync(0);
    button('Choose PDF').onclick();
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
    const button = (text: string) => f.controls.append.mock.calls.map(([button]) => button).filter(button => button.textContent === text).at(-1);
    await f.shell.receive({ status: 'host-resource', file: { name: 'host.pdf', resourceUri: 'opaque:host' }, ticket: 'p'.repeat(43) });
    await vi.advanceTimersByTimeAsync(95_000);
    button('Open independent review').onclick(); await vi.advanceTimersByTimeAsync(0);
    button('Choose PDF again').onclick(); await vi.advanceTimersByTimeAsync(0);
    if (pickerStatus === 'busy') { button('Open independent review').onclick(); await vi.advanceTimersByTimeAsync(0); }
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
    resources.read.mockRejectedValueOnce(Error('resource unavailable'));
    const refresh = f.controls.append.mock.calls.map(([button]) => button).find(button => button.textContent === 'Refresh PDF'); refresh.onclick();
    await vi.waitFor(() => expect(f.status.textContent).toContain('could not complete'));
    expect(f.root.inert).toBe(true); expect(host.mounts).toHaveLength(1); expect(f.calls.some(c => c.action === 'resume')).toBe(false);
    await f.shell.teardown();
});

it('shows a compact open-reader view, applies host theme and safe areas, and expands through the host', async () => {
    const html = { dataset: {} as Record<string, string>, style: { colorScheme: '', setProperty: vi.fn() } };
    vi.stubGlobal('document', { hidden: false, documentElement: html, createElement: () => ({ append: vi.fn(), replaceChildren: vi.fn(), setAttribute: vi.fn() }), createTextNode: (value: string) => ({ textContent: value }) });
    const f = fixture();
    f.app.getHostContext = () => ({ displayMode: 'inline', theme: 'dark', safeAreaInsets: { top: 12, bottom: 8, left: 0, right: 0 } });
    const expand = vi.fn(async () => ({ mode: 'fullscreen' })); Object.assign(f.app, { requestDisplayMode: expand });
    await f.shell.receive(active());
    expect(f.root.hidden).toBe(true); expect(f.status.textContent).toContain('Open the reader to edit');
    host.mounts[0][6]('Paper.pdf', 1); expect(f.status.textContent).toContain('Paper.pdf');
    expect(html.dataset.theme).toBe('dark'); expect(html.style.setProperty).toHaveBeenCalledWith('--placekeeper-safe-top', '12px');
    const button = f.controls.append.mock.calls.map(([button]) => button).find(button => button.textContent === 'Open reader');
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
    expect(f.controls.append.mock.calls.map(([element]) => element.textContent).join(' ')).toContain('could not be confirmed');
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
    expect(f.controls.append.mock.calls.flat().some(element => element.textContent === 'Background context is paused for this app.')).toBe(true);
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

it('loads global preferences before mounting and keeps disabled selection out of first context', async () => {
    const settings = deferred(); const update = vi.fn(async () => ({ updateId: 'first' }));
    const f = fixture(async request => reply(request.action === 'context-published' ? { status: 'context-ready' } : { status: 'ok', payload: {} }), undefined, () => ({ getCurrent: () => undefined, update }), async request => request.action === 'settings-read' ? settings.promise : reply({ status: 'catalogue', included: false }));
    const receiving = f.shell.receive({ ...active(), contextPublished: false });
    expect(host.mounts).toHaveLength(0); expect(update).not.toHaveBeenCalled();
    settings.resolve(reply({ status: 'settings', revision: 3, values: { backgroundContext: true, selectionSharing: false, mentions: false } })); await receiving;
    host.mounts[0][5]({ documentGeneration: 1, reviewRevision: 2, title: 'PDF', source: { digest: 'd', fileId: 'f' }, page: 1, pageCount: 2, selection: { text: 'private selection', pages: [1] }, annotations: [] }); await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledOnce(); expect(JSON.stringify(update.mock.calls)).not.toContain('private selection'); await f.shell.teardown();
});
it('ignores stale preference replies and corrects publication waiting on its intent acknowledgement', async () => {
    const marked = deferred(), stale = deferred(); let reads = 0;
    const update = vi.fn(async (_params: any) => ({ updateId: 'published' }));
    const settings = (revision: number, backgroundContext: boolean) => reply({ status: 'settings', revision, values: { backgroundContext, selectionSharing: false, mentions: false } });
    const f = fixture(async request => request.action === 'context-published' ? marked.promise : reply({ status: 'ok', payload: {} }), undefined, () => ({ getCurrent: () => undefined, update }), async request => request.action === 'catalogue' ? reply({ status: 'catalogue', included: false }) : ++reads === 1 ? settings(1, true) : reads === 2 ? stale.promise : settings(3, false));
    await f.shell.receive({ ...active(), contextPublished: false });
    host.mounts[0][5]({ documentGeneration: 1, reviewRevision: 2, title: 'PDF', source: { digest: 'd', fileId: 'f' }, page: 1, pageCount: 2, selection: null, annotations: [] });
    await Promise.resolve(); await Promise.resolve(); f.shell.wake(); f.shell.wake(); await Promise.resolve(); await Promise.resolve();
    stale.resolve(settings(2, true)); marked.resolve(reply({ status: 'context-ready' })); await vi.advanceTimersByTimeAsync(0);
    expect(update.mock.calls.every(([params]) => params.content.length === 0)).toBe(true); await f.shell.teardown();
});
it('prepares captured editable drafts from the mounted bridge without submitting a turn', async () => {
    const pending = deferred(); const send = vi.fn((_params: any) => pending.promise);
    const f = fixture(undefined, undefined, undefined, undefined, () => ({ send })); await f.shell.receive(active());
    const snapshot = { documentGeneration: 1, reviewRevision: 2, title: 'Original', source: { digest: 'original', fileId: 'f' }, page: 1, pageCount: 2, selection: { text: 'captured', pages: [1] }, annotations: [] };
    const preparing = host.mounts[0][4].draft({ kind: 'selection', snapshot }); snapshot.selection.text = 'changed'; snapshot.source.digest = 'changed';
    expect(send.mock.calls[0]![0]).toMatchObject({ _meta: { 'openai/message': { target: 'active', send: false } } }); expect(JSON.stringify(send.mock.calls)).toContain('captured'); expect(JSON.stringify(send.mock.calls)).not.toContain('changed');
    pending.resolve({}); await preparing; await f.shell.teardown();
});
it('keeps reading usable when initial preference and catalogue services are unavailable', async () => {
 const update = vi.fn();
 const f = fixture(undefined, undefined, () => ({ getCurrent: () => undefined, update }), async () => reply({ status: 'unavailable' }));
 await f.shell.receive({ ...active(), contextPublished: false }); expect(host.mounts).toHaveLength(1); expect(f.root.inert).toBe(false);
 host.mounts[0][5]({ documentGeneration: 1, reviewRevision: 2, title: 'PDF', source: { digest: 'd', fileId: 'f' }, page: 1, pageCount: 2, selection: { text: 'private', pages: [1] }, annotations: [] }); await vi.advanceTimersByTimeAsync(0);
 expect(update).not.toHaveBeenCalled(); await f.shell.teardown();
});
it('does not rebuild preference controls for equal-revision background refreshes', async () => {
 const f = fixture(); await f.shell.receive(active());
 const sharing = f.controls.append.mock.calls.map(([node]) => node).find(node => node.append?.mock.calls.some(([child]: any[]) => child.textContent === 'Sharing settings'));
 const fieldset = sharing.append.mock.calls.map(([node]: any[]) => node).find((node: any) => node.replaceChildren?.mock.calls.length);
 const before = fieldset.replaceChildren.mock.calls.length; f.shell.wake(); await vi.advanceTimersByTimeAsync(0);
 expect(fieldset.replaceChildren).toHaveBeenCalledTimes(before); await f.shell.teardown();
});
it('requires explicit global opt-in and explicit include, update and remove choices for mention snapshots', async () => {
 let mentions = false, included = false, revision = 0;
 const f = fixture(undefined, undefined, undefined, async request => {
  if (request.action === 'settings-update') { mentions = request.set.mentions; revision++; }
  if (request.action.startsWith('settings-')) return reply({ status: 'settings', revision, values: { backgroundContext: false, selectionSharing: false, mentions } });
  if (request.operation === 'capture') included = true; if (request.operation === 'remove') included = false;
  return reply({ status: 'catalogue', included, ...(included ? { snapshot: { generation: 1, revision: 2, capturedAt: '2026-11-04' } } : {}) });
 });
 await f.shell.receive(active()); await Promise.resolve();
 const nodes = (node: any): any[] => [node, ...(node.append?.mock.calls.flatMap((call: any[]) => call.flatMap(nodes)) ?? [])];
 expect(f.calls.filter(c => c.action === 'catalogue' && c.operation === 'capture')).toHaveLength(0);
 const input = nodes(f.controls).filter(n => n.type === 'checkbox').at(-1); input.checked = true; input.onchange(); await vi.advanceTimersByTimeAsync(0);
 expect(f.calls.some(c => c.action === 'settings-update' && c.set.mentions === true)).toBe(true);
 const click = async (label: string) => { nodes(f.controls).filter(n => n.textContent === label).at(-1).onclick(); await vi.advanceTimersByTimeAsync(0); };
 await click('Include this review snapshot'); await click('Update included snapshot'); await click('Remove this review from mentions');
 expect(f.calls.filter(c => c.action === 'catalogue').map(c => c.operation)).toEqual(['status', 'capture', 'capture', 'remove']); await f.shell.teardown();
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

it.each(['Open independent review', 'Cancel'])('keeps %s fenced while a recovery resume is pending', async competing => {
    const pending = deferred();
    const f = fixture(async request => request.action === 'choose' ? pending.promise : reply({ status: 'closed' }));
    await f.shell.receive({ status: 'busy', recoveryToken: 'r'.repeat(43), canResume: true });
    const buttons = f.controls.append.mock.calls.map(([button]) => button);
    const resume = buttons.find(button => button.textContent === 'Resume protected review');
    resume.onclick();
    expect(buttons.every(button => button.disabled)).toBe(true);
    buttons.find(button => button.textContent === competing).onclick();
    expect(f.calls.filter(c => c.action === 'choose')).toHaveLength(1);
    pending.resolve(reply(active(nextGrant))); await vi.advanceTimersByTimeAsync(0);
    expect(host.mounts).toHaveLength(1);
    expect(f.status.textContent).not.toContain('connection ended');
    expect(f.controls.append.mock.calls.some(([button]) => button.textContent === 'Choose PDF')).toBe(false);
    await f.shell.teardown();
});

it('offers fresh source selection after an expired recovery choice without ending the panel', async () => {
    const f = fixture(async request => reply(request.action === 'choose' ? { status: 'unavailable' } : request.action === 'open' ? { status: 'busy', recoveryToken: 's'.repeat(43), canResume: true } : { status: 'closed' }));
    await f.shell.receive({ status: 'busy', recoveryToken: 'r'.repeat(43), canResume: true });
    const oldButtons = f.controls.append.mock.calls.map(([button]) => button);
    await vi.advanceTimersByTimeAsync(95_000);
    oldButtons.find(button => button.textContent === 'Open independent review').onclick();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.status.textContent).toContain('Choose the PDF again');
    expect(f.status.textContent).not.toContain('connection ended');
    expect(host.mounts).toHaveLength(0);
    oldButtons.find(button => button.textContent === 'Resume protected review').onclick();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.filter(c => c.action === 'choose')).toHaveLength(1);
    f.controls.append.mock.calls.map(([button]) => button).find(button => button.textContent === 'Choose PDF again').onclick();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.filter(c => c.action === 'open')).toEqual([{ action: 'open' }]);
    expect(f.status.textContent).toContain('Protected review work is available');
    expect(f.calls.filter(c => c.action === 'choose')).toHaveLength(1);
    await f.shell.teardown();
});

it('fences retained recovery callbacks after cancel', async () => {
    const f = fixture(async () => reply({ status: 'cancelled' }));
    await f.shell.receive({ status: 'busy', recoveryToken: 'r'.repeat(43), canResume: true });
    const buttons = f.controls.append.mock.calls.map(([button]) => button);
    buttons.find(button => button.textContent === 'Cancel').onclick(); await vi.advanceTimersByTimeAsync(0);
    buttons.find(button => button.textContent === 'Resume protected review').onclick(); await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.filter(c => c.action === 'choose')).toHaveLength(0);
    expect(host.mounts).toHaveLength(0);
    await f.shell.teardown();
});

it('fences an expired-choice picker and revokes its late grant after cancel', async () => {
    const pending = deferred();
    const f = fixture(async request => request.action === 'open' ? pending.promise : reply(request.action === 'choose' ? { status: 'unavailable' } : { status: 'closed' }));
    await f.shell.receive({ status: 'busy', recoveryToken: 'r'.repeat(43), canResume: true });
    f.controls.append.mock.calls.map(([button]) => button).find(button => button.textContent === 'Open independent review').onclick();
    await vi.advanceTimersByTimeAsync(0);
    const buttons = f.controls.append.mock.calls.map(([button]) => button);
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
    f.controls.append.mock.calls.map(([button]) => button).find(button => button.textContent === 'Resume protected review').onclick();
    await f.shell.teardown(); pending.resolve(reply(active(nextGrant))); await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.filter(c => c.action === 'revoke').map(c => c.grant)).toEqual([nextGrant]);
    expect(host.mounts).toHaveLength(0);
});

it('restores the recovery button group after a failed choice and retries its operation identity', async () => {
    let attempts = 0;
    const f = fixture(async request => { if (request.action === 'choose') { if (++attempts === 1) throw Error('offline'); return reply(active(nextGrant)); } return reply({ status: 'closed' }); });
    await f.shell.receive({ status: 'busy', recoveryToken: 'r'.repeat(43), canResume: true });
    const buttons = f.controls.append.mock.calls.map(([button]) => button), resume = buttons.find(button => button.textContent === 'Resume protected review');
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
    const choose = f.controls.append.mock.calls.map(([button]) => button).find(button => button.textContent === 'Choose PDF');
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
 f.controls.append.mock.calls.map(([button])=>button).find(button=>button.textContent==='Save now').onclick();await localRetried.promise;
 expect(f.calls.some(r=>r.action==='app'&&r.request.method==='retrySave')).toBe(true);
 expect(resources.write).toHaveBeenCalledOnce();
 await f.shell.teardown();
});
