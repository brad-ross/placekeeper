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
function fixture(handler: (request: any) => Promise<any> = async () => reply({ status: 'ok', payload: {} }), resources: () => any = () => undefined, modelContext: () => any = () => undefined, preferences?: (request: any) => Promise<any>, message: () => any = () => undefined) {
    const calls: any[] = [];
    const app = { getHostContext: () => ({ displayMode: 'fullscreen' }), callServerTool: vi.fn(async (input: any, _options?: { timeout: number; maxTotalTimeout?: number }) => { calls.push(input.arguments.request); const request = input.arguments.request; if (preferences && ['settings-read', 'settings-update', 'catalogue'].includes(request.action)) return preferences(request); if (request.action === 'settings-read') return reply({ status: 'settings', values: { backgroundContext: true, selectionSharing: true, mentions: false }, revision: 0 }); if (request.action === 'catalogue') return reply({ status: 'catalogue', included: false }); return handler(request); }) };
    const element = () => ({ inert: false, hidden: false, textContent: '', dataset: {} as Record<string, string>, replaceChildren: vi.fn(), append: vi.fn() });
    const root = element(), status = element(), controls = element();
    return { app, shell: new ExtensionShell(app as unknown as App, root as unknown as HTMLElement, status as unknown as HTMLElement, controls as unknown as HTMLElement, resources, modelContext, message), root, status, controls, calls };
}
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('document', { hidden: false, createElement: () => ({ append: vi.fn(), replaceChildren: vi.fn(), setAttribute: vi.fn() }), createTextNode: (value: string) => ({ textContent: value }) }); host.options.length = 0; host.mounts.length = 0; host.unmount.mockClear(); });
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

it('opens opaque host bytes in the canonical reader and refreshes its presentation on a resource notification', async () => {
    const bytes = btoa('%PDF-1.7\nhost shell fixture\n%%EOF');
    let update!: (event: any) => void, imported = false, generation = 1;
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
        return reply({ status: 'ok', payload: {} });
    }, () => resources);
    await f.shell.receive({ status: 'host-resource', file: { name: 'host.pdf', resourceUri: 'opaque:host' }, ticket: 'p'.repeat(43) });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.mounts).toHaveLength(1); expect(f.status.textContent).toContain('read-only'); expect(resources.subscribe).toHaveBeenCalledOnce();
    const old = host.options[0]; generation = 2; update({ params: { uri: 'opaque:host' } });
    await vi.waitFor(() => expect(host.mounts).toHaveLength(2));
    expect(f.calls.some(c => c.action === 'resume')).toBe(true);
    await expect(old.call('command', {})).rejects.toThrow('stale-reply');
    await f.shell.teardown(); expect(resources.unsubscribe).toHaveBeenCalledOnce(); expect(resources.write).not.toHaveBeenCalled();
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
