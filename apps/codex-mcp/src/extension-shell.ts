import type { OpenAIResources } from '@openai/mcp-extensions/app';
import { HostResourceAdapter } from './host-resource-adapter.js';
import type { App } from '@modelcontextprotocol/ext-apps';
import { createCodexHostRuntime } from '../../web/src/host/codex-runtime.js';
import { mountCodexProductionReview } from '../../web/src/codex-entry.js';
import type { HostRuntimeInvalidation } from '../../web/src/host/runtime.js';
import { NativeOperationError, parseCodexAppResponse, type CodexAppRequest, type CodexAppResponse } from '../../../packages/core/src/codex-mcp-protocol.js';
import { EXTENSION_META_KEY, EXTENSION_TOOL, parseExtensionResult, type ExtensionRequest, type ExtensionResult, type ExtensionPresentation } from '../../../packages/core/src/extension-protocol.js';
import { PanelLiveness } from './panel-liveness.js';
import { NativeDiagnosticError, diagnosticFailure } from './lifecycle-diagnostics.js';
/** Memory-only app grants. A new host invocation never inherits an old panel's authority. */
export class ExtensionShell {
    #host: HostResourceAdapter | undefined;
    #hostNotice = '';
    #hostEpoch = 0;
    #hostRefreshPending = false;
    #hostUpdateRevision = 0;
    #hostSave: Promise<void> | undefined;
    #saveRequested = false;
    #grant: string | undefined;
    #active: ExtensionPresentation | undefined;
    #unmount: (() => void) | undefined;
    #liveness: PanelLiveness | undefined;
    #epoch = 0;
    #received = false;
    #closed = false;
    #connectionEpoch = 0;
    readonly #verified = new Set<string>();
    #connected = false;
    #resume: Promise<void> | undefined;
    #resumeOperation: string | undefined;
    #watermark: number | undefined;
    readonly #listeners = new Set<(event: HostRuntimeInvalidation) => void>();
    constructor(readonly app: App, readonly root: HTMLElement, readonly status: HTMLElement, readonly controls: HTMLElement, readonly resources: () => OpenAIResources | undefined = () => undefined) { }
    get ownsPanel() { return this.#received; }
    async receive(raw: unknown): Promise<boolean> {
        const result = parseExtensionResult(raw);
        if (!result)
            return false;
        if (this.#received || this.#closed)
            return true;
        this.#received = true;
        try {
            await this.#apply(result);
        }
        catch {
            this.#ended();
        }
        return true;
    }
    async #request(request: ExtensionRequest): Promise<ExtensionResult | CodexAppResponse> {
        let result;
        try {
            result = await this.app.callServerTool({ name: EXTENSION_TOOL, arguments: { request } }, { timeout: request.action === 'open' ? 315000 : 8000 });
        }
        catch {
            throw new NativeDiagnosticError('transport');
        }
        const value = result._meta?.[EXTENSION_META_KEY];
        const parsed = request.action === 'app' ? parseCodexAppResponse(value) : parseExtensionResult(value);
        if (!parsed)
            throw new NativeDiagnosticError('transport');
        return parsed;
    }
    #show(text: string) { if (this.#closed)
        return; this.status.textContent = text; this.status.hidden = !text; }
    #button(label: string, action: () => Promise<void>) { const button = document.createElement('button'); button.textContent = label; button.onclick = () => { if (this.#closed)
        return; button.disabled = true; void action().catch(() => this.#show('Placekeeper could not complete that action. Your protected work is retained.')).finally(() => { button.disabled = false; }); }; this.controls.append(button); }
    async #apply(result: ExtensionResult) {
        if (this.#closed) {
            if ('grant' in result)
                await this.#request({ action: 'revoke', grant: result.grant }).catch(() => undefined);
            return;
        }
        if (result.status === 'provisional') {
            this.#grant = result.grant;
            this.#resumeOperation = crypto.randomUUID();
            if (this.#host) { const refreshed = await this.#host.refresh(result.grant); if (refreshed.status === 'host-status' && refreshed.outcome === 'conflict') this.#hostNotice = 'The host PDF changed before saving. Your review is protected; export a reviewed copy before reopening the newer PDF.'; }
            let activated: ExtensionResult | CodexAppResponse | undefined;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (this.#closed)
                    return;
                try {
                    activated = await this.#request({ action: 'activate', grant: result.grant, operationId: this.#resumeOperation });
                    break;
                }
                catch (error) {
                    if (this.#closed)
                        return;
                    if (attempt === 2) {
                        this.#ended();
                        return;
                    }
                    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1) + Math.random() * 250));
                }
            }
            if (!activated || activated.status !== 'active' || !('presentation' in activated)) {
                this.#ended();
                return;
            }
            this.#resumeOperation = undefined;
            await this.#apply(activated);
            return;
        }
        if (result.status === 'active') {
            this.#grant = result.grant;
            this.#active = result.presentation;
            this.controls.replaceChildren();
            this.#mount();
            if (this.#host) { this.#button('Refresh PDF', () => this.#continue()); this.#button('Save now', () => this.#saveHost()); void this.#saveHost(); if (this.#hostRefreshPending) queueMicrotask(() => { void this.#continue().catch(() => undefined); }); }
            return;
        }
        if (result.status === 'cancelled') {
            if (!this.#active)
                this.#chooser();
            return;
        }
        if (result.status === 'chooser') {
            if (!this.#active)
                this.#chooser();
            return;
        }
        if (result.status === 'busy') {
            this.#show(result.canResume ? 'Protected review work is available. Choose how to open it.' : 'This PDF already has a review. Open an independent review without taking over the existing one.');
            this.controls.replaceChildren();
            for (const choice of result.canResume ? ['resume', 'fork'] as const : ['fork'] as const) {
                const operationId = crypto.randomUUID();
                this.#button(choice === 'resume' ? 'Resume protected review' : 'Open independent review', async () => { const next = await this.#request({ action: 'choose', recoveryToken: result.recoveryToken, choice, operationId }); const parsed = parseExtensionResult(next); if (parsed)
                    await this.#apply(parsed); });
            }
            this.#button('Cancel', async () => { this.#chooser(); });
            return;
        }
        if (result.status === 'host-resource') {
            this.#show('Reading host PDF…');
            const hostEpoch = ++this.#hostEpoch;
            this.#host = new HostResourceAdapter({ resources: this.resources, request: async request => { const response = await this.#request(request); const parsed = parseExtensionResult(response); if (!parsed) throw Error('Host resource unavailable'); return parsed; }, current: () => !this.#closed && hostEpoch === this.#hostEpoch, onUpdate: () => { this.#hostRefreshPending = true; this.#hostUpdateRevision++; if (this.#active) void this.#continue().catch(() => this.#show('The host PDF could not be refreshed. Finish any current edit, then refresh; your protected review is retained.')); } });
            await this.#apply(await this.#host.open(result));
            return;
        }
        this.#ended();
    }
    #resetHost() { const host = this.#host; this.#host = undefined; this.#hostEpoch++; this.#hostNotice = ''; this.#hostRefreshPending = false; this.#hostUpdateRevision = 0; this.#saveRequested = false; this.#hostSave = undefined; void host?.dispose().catch(() => undefined); }
    #chooser() { this.#resetHost(); this.#show('Open a PDF to begin reviewing.'); this.controls.replaceChildren(); this.#button('Choose PDF', async () => { const result = await this.#request({ action: 'open' }); const parsed = parseExtensionResult(result); if (parsed?.status === 'chooser') {
        this.#show('Use the PDF’s file menu to open it in Placekeeper on this host.');
        return;
    } if (parsed)
        await this.#apply(parsed); }); }
    #mount() {
        const active = this.#active;
        if (!active || this.#closed)
            return;
        const epoch = ++this.#epoch;
        this.#connected = true;
        this.#verified.clear();
        this.root.inert = false;
        this.#unmount?.();
        this.#listeners.clear();
        this.#watermark = undefined;
        const runtime = createCodexHostRuntime({ runtimeId: active.runtimeId, call: (method, payload) => this.#payload(method, payload, epoch), subscribeInvalidations: listener => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); } });
        this.#show('Opening PDF…');
        this.#unmount = mountCodexProductionReview(this.root, runtime, () => { if (epoch === this.#epoch)
            this.#show('The PDF could not be loaded. Reopen it through the file menu; protected work is retained.'); }, () => { if (epoch === this.#epoch && this.#connected)
            this.#show(this.#hostNotice); });
        this.#liveness?.stop();
        this.#liveness = new PanelLiveness({ renew: async () => { await this.#probe('renew'); }, poll: async () => { await this.#probe('watermark'); }, pollInterval: () => document.hidden ? 5000 : 1000, onState: state => { if (epoch !== this.#epoch || this.#closed)
                return; if (state === 'reconnecting')
                this.#pause(); }, onTerminal: () => { if (epoch === this.#epoch)
                this.#ended(); } });
        this.#liveness.start();
    }
    #pause() {
        if (this.#closed)
            return;
        if (this.#connected) {
            this.#verified.clear();
            this.#connectionEpoch++;
        }
        this.#connected = false;
        this.root.inert = true;
        this.#show('Reconnecting to Placekeeper… Editing is paused.');
    }
    async #probe(method: 'renew' | 'watermark') {
        const epoch = this.#epoch, connectionEpoch = this.#connectionEpoch;
        try {
            const value = await this.#payload(method, {}, epoch) as {
                watermark?: number;
                sessionId?: string;
                documentGeneration: number;
                reviewRevision: number;
            };
            if (epoch !== this.#epoch || this.#closed)
                return;
            if (!this.#connected && connectionEpoch === this.#connectionEpoch) {
                this.#verified.add(method);
                if (this.#verified.size === 2) {
                    this.#connected = true;
                    this.root.inert = false;
                    this.#show(this.#hostNotice);
                }
            }
            if (method === 'watermark' && value.sessionId) {
                if (this.#watermark !== undefined && value.watermark !== this.#watermark)
                    for (const listener of this.#listeners)
                        listener({ sessionId: value.sessionId, generation: value.documentGeneration, revision: value.reviewRevision, reason: 'freshness' });
                this.#watermark = value.watermark;
            }
        }
        catch (error) {
            if (epoch !== this.#epoch || this.#closed)
                return;
            if (error instanceof Error && error.message === 'extension-expired') {
                await this.#continue();
                return;
            }
            throw error;
        }
    }
    async #payload(method: Extract<CodexAppRequest, {
        authority: 'presentation';
    }>['method'], payload: unknown, epoch: number): Promise<unknown> {
        const active = this.#active;
        if (!active || this.#closed || epoch !== this.#epoch)
            throw new NativeDiagnosticError('stale-reply');
        if (method === 'exportReviewedCopy' && this.#host && this.#grant) {
            const value = payload as { fence?: { expectedRevision: number; documentGeneration: number } };
            if (!value.fence) throw Error('Refresh the review before exporting.');
            return this.#host.export(this.#grant, value.fence);
        }
        const probe = method === 'renew' || method === 'watermark';
        if (!probe && !this.#connected)
            throw new NativeDiagnosticError('transport');
        let response: ExtensionResult | CodexAppResponse;
        try {
            response = await this.#request({ action: 'app', request: { protocolVersion: 1, runtimeId: active.runtimeId, attemptId: active.attemptId, generation: active.generation, capability: active.presentationCapability, authority: 'presentation', requestId: crypto.randomUUID(), method, payload } as CodexAppRequest });
        }
        catch (error) {
            if (epoch === this.#epoch && !this.#closed && diagnosticFailure(error) === 'transport') {
                this.#pause();
                if (!probe)
                    this.#liveness?.wake();
            }
            throw error;
        }
        if (this.#closed || epoch !== this.#epoch)
            throw new NativeDiagnosticError('stale-reply');
        if (response.status === 'denied') {
            if (response.reason === 'expired' || response.reason === 'stale-generation') {
                this.#pause();
                if (!probe)
                    this.#liveness?.wake();
                throw Error('extension-expired');
            }
            this.#ended();
            throw new NativeDiagnosticError('service-denied-unavailable');
        }
        if (response.status === 'operation-error')
            throw new NativeOperationError();
        if (response.status !== 'ok')
            throw new NativeDiagnosticError('unexpected-status');
        if (this.#host && (method === 'command' || method === 'finalizeInteraction')) void this.#saveHost();
        if (this.#hostRefreshPending && ['finalizeInteraction', 'releaseInteraction', 'acknowledgeInteraction'].includes(method)) void this.#continue().catch(() => undefined);
        return response.payload;
    }
    async #saveHost() {
        this.#saveRequested = true;
        if (this.#hostSave) return this.#hostSave;
        const hostEpoch = this.#hostEpoch;
        const running = (async () => {
            while (this.#saveRequested && this.#host && this.#grant && !this.#closed) {
                this.#saveRequested = false;
                const result = await this.#host.save(this.#grant);
                if (hostEpoch !== this.#hostEpoch || this.#closed) return;
                if (result.status === 'host-status') {
                    if (result.outcome === 'saved') { this.#hostNotice = ''; this.#show(''); }
                    else if (result.outcome === 'read-only') { this.#hostNotice = 'This host PDF is read-only. Your review is protected; use Export reviewed PDF to keep a copy.'; this.#show(this.#hostNotice); }
                    else if (result.outcome === 'conflict') { this.#hostNotice = 'The host PDF changed before saving. Your review is protected. Export a reviewed copy before reopening the newer PDF.'; this.#show(this.#hostNotice); }
                    else if (result.outcome === 'protected') { this.#hostNotice = 'The host save was not completed. Your review is protected; choose Save now or export a reviewed copy.'; this.#show(this.#hostNotice); }
                    else if (result.outcome === 'unknown') { this.#hostNotice = 'The host save could not be confirmed. Your review is protected; refresh to check the current PDF.'; this.#show(this.#hostNotice); }
                }
            }
        })().catch(() => { if (hostEpoch === this.#hostEpoch) this.#show('Host save could not be completed. Your review is protected; refresh or export a reviewed copy.'); }).finally(() => { if (this.#hostSave === running) this.#hostSave = undefined; });
        this.#hostSave = running; return running;
    }
    async #continue() {
        if (this.#closed)
            return;
        if (this.#resume)
            return this.#resume;
        if (!this.#grant)
            throw new NativeDiagnosticError('service-denied-unavailable');
        if (!this.#host || !this.#connected) {
            this.root.inert = true;
            this.#connected = false;
            this.#show('Reconnecting to Placekeeper… Editing is paused.');
        }
        this.#resumeOperation ??= crypto.randomUUID();
        const grant = this.#grant, operationId = this.#resumeOperation;
        let completed = false;
        this.#resume = (async () => {
            if (this.#host) {
                do {
                    const revision = this.#hostUpdateRevision;
                    const refreshed = await this.#host.refresh(grant);
                    this.#hostRefreshPending = revision !== this.#hostUpdateRevision;
                    if (refreshed.status === 'host-status' && refreshed.outcome === 'conflict') this.#hostNotice = 'The host PDF changed before saving. Your review is protected; export a reviewed copy before reopening the newer PDF.';
                } while (this.#hostRefreshPending && !this.#closed);
            }
            this.root.inert = true;
            this.#connected = false;
            const result = await this.#request({ action: 'resume', grant, operationId }); if (result.status !== 'active' || !('presentation' in result)) {
            this.#ended();
            throw new NativeDiagnosticError('service-denied-unavailable');
        } this.#resumeOperation = undefined; await this.#apply(result); completed = true; })().finally(() => { this.#resume = undefined; if (completed && this.#hostRefreshPending && !this.#closed) queueMicrotask(() => { void this.#continue().catch(() => undefined); }); });
        return this.#resume;
    }
    #ended() { if (this.#closed)
        return; this.#connected = false; this.#liveness?.stop(); void this.#host?.dispose().catch(() => undefined); this.root.inert = true; this.#show('This connection ended. Reopen the PDF through its file menu; accepted annotations and protected drafts are retained.'); this.#closed = true; this.#epoch++; }
    wake() { this.#liveness?.wake(); }
    disconnected() { if (this.ownsPanel)
        this.#ended(); }
    async teardown() { this.#closed = true; this.#connected = false; this.root.inert = true; const grant = this.#grant; this.#epoch++; this.#grant = undefined; this.#active = undefined; this.#liveness?.stop(); this.#unmount?.(); this.#listeners.clear(); await this.#host?.dispose(); if (grant)
        await this.#request({ action: 'revoke', grant }).catch(() => undefined); }
}
