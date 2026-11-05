import { LiveReaderTools, type DocumentModelContext } from './live-reader-tools.js';
import { ExtensionContextCoordinator, type ExtensionContextPreferences } from '../../web/src/host/extension-context-coordinator.js';
import type { ReviewContextSnapshot } from '../../web/src/host/review-context-snapshot.js';
import { prepareReviewDraft, publishReviewDraft } from './review-drafts.js';
import type { ReviewAgentBridge, ReviewAgentDraft } from '../../web/src/host/review-agent-bridge.js';
import type { ExtensionPreferenceValues, SnapshotLabel } from '../../../packages/core/src/extension-preferences.js';
import type { OpenAIMessage, OpenAIModelContext, OpenAIResources } from '@openai/mcp-extensions/app';
import { HostResourceAdapter } from './host-resource-adapter.js';
import type { App } from '@modelcontextprotocol/ext-apps';
import { createCodexHostRuntime } from '../../web/src/host/codex-runtime.js';
import { mountCodexProductionReview } from '../../web/src/codex-entry.js';
import type { HostRuntimeInvalidation } from '../../web/src/host/runtime.js';
import { NativeOperationError, parseCodexAppResponse, type CodexAppRequest, type CodexAppResponse } from '../../../packages/core/src/codex-mcp-protocol.js';
import { EXTENSION_META_KEY, EXTENSION_TOOL, extensionPickerTimeouts, parseExtensionResult, type ExtensionRequest, type ExtensionResult, type ExtensionPresentation } from '../../../packages/core/src/extension-protocol.js';
import { PanelLiveness } from './panel-liveness.js';
import { NativeDiagnosticError, diagnosticFailure } from './lifecycle-diagnostics.js';
/** Memory-only app grants. A new host invocation never inherits an old panel's authority. */
export class ExtensionShell {
    #context: ExtensionContextCoordinator | undefined;
    #readerTools: LiveReaderTools | undefined;
    readonly #readerVisibilityListeners = new Set<() => void>();
    #contextView: HTMLElement | undefined;
    #contextEnable: HTMLElement | undefined;
    #openReader: HTMLElement | undefined;
    #snapshot: ReviewContextSnapshot | undefined;
    #title: string | undefined;
    #displayMode: string | undefined;
    #message = '';
    #preferences: ExtensionPreferenceValues = { backgroundContext: false, selectionSharing: false, mentions: false };
    #settingsRevision = -1;
    #settingsNotice = '';
    #settingsView: HTMLElement | undefined;
    #catalogue: { included: boolean; snapshot?: SnapshotLabel } = { included: false };
    #catalogueView: HTMLElement | undefined;
    #catalogueRequest = 0;
    #draftView: HTMLElement | undefined;
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
    #resumeRefreshed: string | undefined;
    #choiceEpoch = 0;
    #watermark: number | undefined;
    readonly #listeners = new Set<(event: HostRuntimeInvalidation) => void>();
    constructor(readonly app: App, readonly root: HTMLElement, readonly status: HTMLElement, readonly controls: HTMLElement, readonly resources: () => OpenAIResources | undefined = () => undefined, readonly modelContext: () => OpenAIModelContext | undefined = () => undefined, readonly message: () => OpenAIMessage | undefined = () => undefined) { }
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
            const picker = extensionPickerTimeouts(request);
            result = await this.app.callServerTool({ name: EXTENSION_TOOL, arguments: { request } }, { timeout: picker?.sdkMs ?? 8000, ...(picker ? { maxTotalTimeout: picker.sdkMs } : {}) });
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
    #show(text: string) {
        if (this.#closed) return;
        this.#message = text;
        const compact = this.#active && this.#displayMode !== 'fullscreen';
        const summary = compact ? `${this.#snapshot?.title ?? this.#title ?? 'Placekeeper PDF'}${this.#snapshot ? ` · Page ${this.#snapshot.page} of ${this.#snapshot.pageCount}` : ''}. Open the reader to edit.` : '';
        this.status.textContent = [summary, this.#readerTools && !this.#readerTools.supported ? 'Live reader tools are unavailable on this host. Open the reader to search and navigate.' : '', text || (document.hidden && this.#active ? 'Reader suspended while the app is hidden. Protected work is retained.' : '')].filter(Boolean).join(' ');
        this.status.hidden = !this.status.textContent;
    }
    #contextStatus() {
        if (!this.#contextView) return;
        const status = this.#context?.status ?? 'unsupported';
        this.#contextView.textContent = status === 'available' ? 'Context available to chat. This does not confirm that a model has read it.'
            : status === 'publishing' ? 'Updating context for chat…'
            : status === 'paused' ? 'Background context is paused for this app.'
            : status === 'unsupported' ? 'This host does not support background context.' : 'Context could not be confirmed as available to chat.';
        if (this.#contextEnable) this.#contextEnable.hidden = status !== 'paused' || !this.#preferences.backgroundContext;
    }
    setContextPreferences(preferences: ExtensionContextPreferences) { this.#preferences = { ...this.#preferences, ...preferences }; this.#context?.setPreferences(preferences); }
    hostContextChanged(context: NonNullable<ReturnType<App['getHostContext']>>, reconcileContext = true) {
        if (context.displayMode !== undefined) this.#displayMode = context.displayMode;
        if (this.#received) {
            const html = document.documentElement;
            if (html) {
                html.dataset.placekeeperExtension = 'true';
                if (context.theme) { html.dataset.theme = context.theme; html.style.colorScheme = context.theme; }
                for (const [name, value] of Object.entries(context.styles?.variables ?? {})) { if (value !== undefined) html.style.setProperty(name, value); }
                if (context.safeAreaInsets) for (const edge of ['top', 'right', 'bottom', 'left'] as const) html.style.setProperty(`--placekeeper-safe-${edge}`, `${context.safeAreaInsets[edge]}px`);
            }
            this.root.hidden = this.#displayMode !== 'fullscreen';
            if (this.#openReader) this.#openReader.hidden = !this.root.hidden;
            this.#show(this.#message);
        }
        for (const listener of this.#readerVisibilityListeners) listener();
        if (reconcileContext && Object.hasOwn(context, 'openai/modelContext')) this.#context?.reconcile(this.modelContext()?.getCurrent());
    }
    #setupContext(freshInvocation: boolean) {
        if (this.#context) return;
        const api = this.modelContext();
        this.#context = new ExtensionContextCoordinator(api ? {
            getCurrent: () => api.getCurrent(),
            update: async (params, options) => {
                const grant = this.#grant, settingsRevision = this.#settingsRevision;
                if (!grant || this.#closed) throw Error('Context connection unavailable');
                const marked = await this.#request({ action: 'context-published', grant });
                if (marked.status !== 'context-ready' || this.#closed || grant !== this.#grant || settingsRevision !== this.#settingsRevision) throw Error('Context connection unavailable');
                return api.update(params, options);
            },
        } : undefined, () => this.#contextStatus(), { freshInvocation });
        this.#context.setPreferences(this.#preferences);
    }
    #button(label: string, action: () => Promise<void>) { const button = document.createElement('button'); button.textContent = label; button.onclick = () => { if (this.#closed || button.disabled)
        return; button.disabled = true; void action().catch(() => this.#show('Placekeeper could not complete that action. Your protected work is retained.')).finally(() => { button.disabled = false; }); }; this.controls.append(button); return button; }
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
            this.#choiceEpoch++;
            this.#grant = result.grant;
            this.#active = result.presentation;
            await this.#refreshSettings().catch(() => { this.#settingsNotice = 'Sharing preferences are unavailable. Sharing stays disabled until they can be loaded.'; this.#preferences = { backgroundContext: false, selectionSharing: false, mentions: false }; this.#context?.setPreferences(this.#preferences); });
            if (this.#closed || this.#grant !== result.grant) return;
            this.#setupContext(result.contextPublished === false);
            this.controls.replaceChildren();
            this.#contextView = document.createElement('p'); this.controls.append(this.#contextView);
            const enable = document.createElement('button'); enable.textContent = 'Enable background context'; enable.onclick = () => this.#context?.enableBackground(); this.#contextEnable = enable; this.controls.append(enable);
            this.#contextStatus();
            const sharing = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'Sharing settings'; sharing.append(summary); this.controls.append(sharing);
            this.#settingsView = document.createElement('fieldset'); sharing.append(this.#settingsView); this.#renderSettings();
            this.#catalogueView = document.createElement('div'); sharing.append(this.#catalogueView);
            this.#draftView = document.createElement('div'); this.controls.append(this.#draftView);
            this.#renderCatalogue();
            void this.#catalogueAction('status').catch(() => this.#show('Mention snapshot status is unavailable. Try refreshing its status.'));
            this.#openReader = this.#button('Open reader', async () => {
                try { const result = await this.app.requestDisplayMode({ mode: 'fullscreen' }); this.hostContextChanged({ displayMode: result.mode }); }
                catch { this.#show('This host could not expand the reader. Open Placekeeper in the conversation panel to edit.'); }
            });
            this.hostContextChanged(this.app.getHostContext?.() ?? {}, false);
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
            const epoch = ++this.#choiceEpoch;
            let pending = false;
            const buttons: HTMLButtonElement[] = [];
            const current = () => !this.#closed && epoch === this.#choiceEpoch;
            const begin = () => { if (!current() || pending) return false; pending = true; for (const button of buttons) button.disabled = true; return true; };
            for (const choice of result.canResume ? ['resume', 'fork'] as const : ['fork'] as const) {
                const operationId = crypto.randomUUID();
                buttons.push(this.#button(choice === 'resume' ? 'Resume protected review' : 'Open independent review', async () => {
                    if (!begin()) return;
                    try {
                        const parsed = parseExtensionResult(await this.#request({ action: 'choose', recoveryToken: result.recoveryToken, choice, operationId }));
                        if (parsed && current()) await this.#apply(parsed);
                        else if (parsed) await this.#discardObsolete(parsed);
                    } catch (error) { if (current()) throw error; }
                    finally { pending = false; if (current()) for (const button of buttons) button.disabled = false; }
                }));
            }
            buttons.push(this.#button('Cancel', async () => { if (!begin()) return; this.#choiceEpoch++; if (this.#active && this.#grant) await this.#apply({ status: 'active', grant: this.#grant, presentation: this.#active }); else this.#chooser(); }));
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
    async #refreshSettings(set?: Partial<ExtensionPreferenceValues>) {
        const result = await this.#request(set ? { action: 'settings-update', set } : { action: 'settings-read' });
        if (this.#closed) return;
        if (result.status !== 'settings') throw Error('Settings unavailable');
        if (result.revision < this.#settingsRevision) return;
        if (result.revision === this.#settingsRevision && !set && !this.#settingsNotice) return;
        this.#settingsNotice = '';
        this.#settingsRevision = result.revision;
        this.#preferences = result.values;
        this.#context?.setPreferences(result.values);
        if (!result.values.mentions) this.#catalogue = { included: false };
        this.#renderSettings(); this.#renderCatalogue(); this.#contextStatus();
    }
    #renderSettings() {
        if (!this.#settingsView) return;
        this.#settingsView.replaceChildren();
        const legend = document.createElement('legend'); legend.textContent = 'Global sharing preferences'; this.#settingsView.append(legend);
        if (this.#settingsNotice) { const notice = document.createElement('p'); notice.textContent = this.#settingsNotice; this.#settingsView.append(notice); const retry = document.createElement('button'); retry.textContent = 'Retry sharing preferences'; retry.onclick = () => { void this.#refreshSettings().catch(() => this.#show('Sharing preferences are still unavailable.')); }; this.#settingsView.append(retry); }
        for (const [key, text] of Object.entries({ backgroundContext: 'Share background review context', selectionSharing: 'Share current selection in background context', mentions: 'Allow explicitly included review snapshots in other chats' }) as [keyof ExtensionPreferenceValues, string][]) {
            const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = this.#preferences[key];
            input.onchange = () => { input.disabled = true; void this.#refreshSettings({ [key]: input.checked }).catch(() => { this.#show('Sharing preferences could not be saved.'); this.#renderSettings(); }); };
            label.append(input, document.createTextNode(text)); this.#settingsView.append(label);
        }
    }
    async #catalogueAction(operation: 'status' | 'capture' | 'remove') {
        const grant = this.#grant, request = ++this.#catalogueRequest; if (!grant || this.#closed) return;
        const result = await this.#request({ action: 'catalogue', grant, operation });
        if (this.#closed || grant !== this.#grant || request !== this.#catalogueRequest) return;
        if (result.status !== 'catalogue') throw Error('Mention snapshot unavailable');
        this.#catalogue = this.#preferences.mentions ? result : { included: false }; this.#renderCatalogue();
    }
    #renderCatalogue() {
        if (!this.#catalogueView) return;
        this.#catalogueView.replaceChildren();
        const text = document.createElement('p'); text.textContent = !this.#preferences.mentions ? 'This review is excluded from mentions. Enable the global preference to include a snapshot.' : this.#catalogue.included ? `This review has an included snapshot${this.#catalogue.snapshot ? ` from ${this.#catalogue.snapshot.capturedAt}, revision ${this.#catalogue.snapshot.revision}` : ''}. Other chats can access this snapshot. Changes require an explicit update.` : 'This review is excluded from mentions. Include a snapshot to make it available to other chats.';
        this.#catalogueView.append(text);
        if (!this.#preferences.mentions) return;
        const refresh = document.createElement('button'); refresh.textContent = 'Refresh snapshot status'; refresh.onclick = () => { void this.#catalogueAction('status').catch(() => this.#show('Mention snapshot status is unavailable.')); }; this.#catalogueView.append(refresh);
        const add = (label: string, operation: 'capture' | 'remove') => { const button = document.createElement('button'); button.textContent = label; button.onclick = () => { button.disabled = true; void this.#catalogueAction(operation).catch(() => { button.disabled = false; this.#show('The mention snapshot could not be updated.'); }); }; this.#catalogueView!.append(button); };
        add(this.#catalogue.included ? 'Update included snapshot' : 'Include this review snapshot', 'capture');
        if (this.#catalogue.included) add('Remove this review from mentions', 'remove');
    }
    #draftBridge(tools: LiveReaderTools, epoch: number): ReviewAgentBridge {
        return { attach: actions => tools.attach(actions), draft: input => this.#prepareDraft(input, epoch) };
    }
    async #prepareDraft(input: ReviewAgentDraft, epoch: number) {
        const draft = prepareReviewDraft(input), grant = this.#grant;
        if (!grant || epoch !== this.#epoch || this.#closed || !this.#connected) return;
        // Capture before waiting. Never attach captured evidence under a replacement grant.
        const attach = () => { if (grant !== this.#grant || epoch !== this.#epoch || this.#closed) return; this.#context?.setAttachment(draft); };
        const prepared = await publishReviewDraft(draft, this.message(), attach);
        if (grant !== this.#grant || epoch !== this.#epoch || this.#closed || !this.#draftView) return;
        this.#draftView.replaceChildren();
        const notice = document.createElement('p'); notice.textContent = prepared ? 'An editable draft is ready in chat. Review it before sending.' : 'Copy this draft into chat. You can also attach this captured evidence explicitly.'; this.#draftView.append(notice);
        if (!prepared) {
            const text = document.createElement('textarea'); text.value = draft.text; text.setAttribute('aria-label', 'Review discussion draft'); this.#draftView.append(text);
            const button = document.createElement('button'); button.textContent = 'Attach captured evidence'; button.onclick = attach; this.#draftView.append(button);
        }
    }
    #resetHost() { const host = this.#host; this.#host = undefined; this.#hostEpoch++; this.#hostNotice = ''; this.#hostRefreshPending = false; this.#hostUpdateRevision = 0; this.#saveRequested = false; this.#hostSave = undefined; void host?.dispose().catch(() => undefined); }
    async #discardObsolete(result: ExtensionResult) {
        if ('grant' in result && (this.#closed || result.grant !== this.#grant))
            await this.#request({ action: 'revoke', grant: result.grant }).catch(() => undefined);
    }
    #chooser() {
        const epoch = ++this.#choiceEpoch;
        this.#resetHost(); this.#show('Open a PDF to begin reviewing.'); this.controls.replaceChildren();
        const current = () => !this.#closed && epoch === this.#choiceEpoch;
        this.#button('Choose PDF', async () => {
            if (!current()) return;
            try {
                const parsed = parseExtensionResult(await this.#request({ action: 'open' }));
                if (!current()) { if (parsed) await this.#discardObsolete(parsed); return; }
                if (parsed?.status === 'chooser') {
                    this.#show('Use the PDF’s file menu to open it in Placekeeper on this host.');
                    return;
                }
                if (parsed) await this.#apply(parsed);
            } catch (error) { if (current()) throw error; }
        });
    }
    #mount() {
        const active = this.#active;
        if (!active || this.#closed)
            return;
        const epoch = ++this.#epoch;
        this.#connected = true;
        this.#verified.clear();
        this.root.inert = document.hidden;
        this.#readerTools?.dispose();
        this.#unmount?.();
        this.#readerTools = new LiveReaderTools((document as Document & { modelContext?: DocumentModelContext }).modelContext, {
            available: () => epoch === this.#epoch && this.#connected && !this.#closed && !document.hidden && !this.root.hidden && !this.root.inert,
            ensureVisible: async () => {
                if (epoch !== this.#epoch || !this.#connected || this.#closed) return false;
                if (this.#displayMode !== 'fullscreen' || document.hidden || this.root.hidden) {
                    try { const result = await this.app.requestDisplayMode({ mode: 'fullscreen' }); if (epoch !== this.#epoch) return false; this.hostContextChanged({ displayMode: result.mode }); }
                    catch { return false; }
                }
                const visible = () => epoch === this.#epoch && this.#connected && !this.#closed && !document.hidden && !this.root.hidden && !this.root.inert;
                if (visible()) return true;
                return new Promise<boolean>(resolve => {
                    const finish = (value: boolean) => { clearTimeout(timer); this.#readerVisibilityListeners.delete(check); resolve(value); };
                    const check = () => { if (visible()) finish(true); else if (epoch !== this.#epoch || !this.#connected || this.#closed) finish(false); };
                    const timer = setTimeout(() => finish(false), 1500);
                    this.#readerVisibilityListeners.add(check);
                    check();
                });
            },
        });
        this.root.dataset.liveReaderToolsDiagnostic = JSON.stringify(this.#readerTools.diagnostic);
        if (!this.#readerTools.supported) this.#show('Live reader tools are unavailable on this host. Open the reader to search and navigate.');
        this.#listeners.clear();
        this.#watermark = undefined;
        const runtime = createCodexHostRuntime({ runtimeId: active.runtimeId, call: (method, payload) => this.#payload(method, payload, epoch), subscribeInvalidations: listener => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); } });
        this.#show('Opening PDF…');
        this.#unmount = mountCodexProductionReview(this.root, runtime, () => { if (epoch === this.#epoch)
            this.#show('The PDF could not be loaded. Reopen it through the file menu; protected work is retained.'); }, () => { if (epoch === this.#epoch && this.#connected)
            this.#show(this.#hostNotice); }, this.#draftBridge(this.#readerTools, epoch), snapshot => { if (epoch !== this.#epoch || this.#closed || !this.#connected || snapshot.documentGeneration !== this.#active?.generation) return; this.#snapshot = snapshot; this.#context?.publish(snapshot); this.#show(this.#message); }, (title, generation) => { if (epoch !== this.#epoch || this.#closed || generation !== this.#active?.generation) return; this.#title = title; this.#show(this.#message); });
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
                    this.root.inert = document.hidden;
                    this.#show(this.#hostNotice);
                    this.#context?.retry();
                }
            }
            if (method === 'watermark') await this.#refreshSettings().catch(() => undefined);
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
        let completed = false;
        this.#resume = (async () => {
            while (true) {
                this.#resumeOperation ??= crypto.randomUUID();
                const grant = this.#grant!, operationId = this.#resumeOperation;
                if (this.#host && this.#resumeRefreshed !== operationId) {
                    do {
                        const revision = this.#hostUpdateRevision;
                        const refreshed = await this.#host.refresh(grant);
                        this.#hostRefreshPending = revision !== this.#hostUpdateRevision;
                        if (refreshed.status === 'host-status' && refreshed.outcome === 'conflict') this.#hostNotice = 'The host PDF changed before saving. Your review is protected; export a reviewed copy before reopening the newer PDF.';
                    } while (this.#hostRefreshPending && !this.#closed);
                    this.#resumeRefreshed = operationId;
                }
                this.root.inert = true;
                this.#connected = false;
                let result;
                try { result = await this.#request({ action: 'resume', grant, operationId }); }
                catch (error) { if (this.#host) this.#hostRefreshPending = true; throw error; }
                if (result.status !== 'active' || !('presentation' in result)) {
                    this.#ended();
                    throw new NativeDiagnosticError('service-denied-unavailable');
                }
                this.#resumeOperation = undefined; this.#resumeRefreshed = undefined;
                // A lost response may have rotated the grant. Replay its receipt first, then
                // validate the host again under the returned authority before mounting.
                if (this.#host && this.#hostRefreshPending && !this.#closed) {
                    this.#grant = result.grant;
                    continue;
                }
                await this.#apply(result); completed = true; return;
            }
        })().finally(() => { this.#resume = undefined; if (completed && this.#hostRefreshPending && !this.#closed) queueMicrotask(() => { void this.#continue().catch(() => undefined); }); });
        return this.#resume;
    }
    #ended() { if (this.#closed)
        return; this.#connected = false; this.#readerTools?.dispose(); this.#context?.dispose(); this.#liveness?.stop(); void this.#host?.dispose().catch(() => undefined); this.root.inert = true; this.#show('This connection ended. Reopen the PDF through its file menu; accepted annotations and protected drafts are retained.'); this.#closed = true; this.#epoch++; }
    visibilityChanged(hidden: boolean) {
        if (!this.#active || this.#closed) return;
        this.root.inert = hidden || !this.#connected;
        for (const listener of this.#readerVisibilityListeners) listener();
        if (hidden) this.#show('Reader suspended while the app is hidden. Protected work is retained.');
        else { this.#show(this.#connected ? this.#hostNotice : 'Reconnecting to Placekeeper… Editing is paused.'); this.wake(); }
    }
    wake() { void this.#refreshSettings().catch(() => undefined); if (this.#connected && !document.hidden) this.#context?.retry(); this.#liveness?.wake(); }
    disconnected() { if (this.ownsPanel)
        this.#ended(); }
    async teardown() { this.#readerTools?.dispose(); this.#context?.dispose(); this.#closed = true; this.#connected = false; this.root.inert = true; const grant = this.#grant; this.#epoch++; this.#grant = undefined; this.#active = undefined; this.#liveness?.stop(); this.#unmount?.(); this.#listeners.clear(); await this.#host?.dispose(); if (grant)
        await this.#request({ action: 'revoke', grant }).catch(() => undefined); }
}
