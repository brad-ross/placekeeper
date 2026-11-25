import { externalWebUrl } from '../../../packages/core/src/external-web-url.js';
import { LiveReaderTools, type DocumentModelContext } from './live-reader-tools.js';
import { ExtensionContextCoordinator } from '../../web/src/host/extension-context-coordinator.js';
import type { DocumentContextSnapshot } from '../../web/src/host/document-context-snapshot.js';
import { prepareDocumentContext } from './document-context-attachment.js';
import type { DocumentAgentBridge, DocumentAgentContextInput } from '../../web/src/host/document-agent-bridge.js';
import { documentContextSourceKey, INACTIVE_DOCUMENT_CONTEXT, sameDocumentContextVersion, type DocumentContextMember, type DocumentContextPublicationStatus, type DocumentContextSource, type DocumentContextState } from '../../web/src/host/document-in-context.js';
import type { OpenAIModelContext, OpenAIResources } from '@openai/mcp-extensions/app';
import { HostResourceAdapter } from './host-resource-adapter.js';
import { createStandardModelContext } from './standard-model-context.js';
import type { App } from '@modelcontextprotocol/ext-apps';
import { createCodexHostRuntime } from '../../web/src/host/codex-runtime.js';
import { mountCodexProductionDocument } from '../../web/src/codex-entry.js';
import type { HostRuntimeInvalidation } from '../../web/src/host/runtime.js';
import { wireAnnotationRevision } from '../../../packages/core/src/document-runtime-protocol.js';
import { NativeOperationError, parseCodexAppResponse, type CodexAppRequest, type CodexAppResponse } from '../../../packages/core/src/codex-mcp-protocol.js';
import { EXTENSION_META_KEY, EXTENSION_TOOL, extensionPickerTimeouts, parseExtensionResult, type ExtensionRequest, type ExtensionResult, type ExtensionPresentation } from '../../../packages/core/src/extension-protocol.js';
import { PanelLiveness } from './panel-liveness.js';
import { NativeDiagnosticError, diagnosticFailure } from './lifecycle-diagnostics.js';
import { CapturedModelContext, ReaderBridgeClient } from './reader-bridge-client.js';
import { parseReaderBridgeResponse, READER_BRIDGE_TOOL } from './reader-bridge-protocol.js';
import { READ_DOCUMENT_TEXT_TOOL } from './reader-tool-definitions.js';

const documentPointerId = 'placekeeper-document-on-request';
/** Shown by the robot button when chat can read the PDF through the reader tools but cannot receive its bytes. */
export const DOCUMENT_ON_REQUEST_DETAIL = 'Claude can read this PDF on request.';
const liveToolsUnavailable = 'Live reader tools are unavailable on this host. Open the reader to search and navigate.';

async function encodeDocument(bytes: Uint8Array, current: () => boolean): Promise<string | undefined> {
    const { toBase64 } = bytes as Uint8Array & { toBase64?: () => string };
    if (typeof toBase64 === 'function') return toBase64.call(bytes);

    const chunks: string[] = [];
    // Keep the spread bounded and each chunk aligned to a base64 triple boundary.
    const chunkSize = 24 * 1024;
    const chunksPerTurn = 8;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))));
        if (chunks.length % chunksPerTurn === 0 && offset + chunkSize < bytes.length) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            if (!current()) return undefined;
        }
    }
    return chunks.join('');
}

/** Memory-only app grants. A new host invocation never inherits an old panel's authority. */
export class ExtensionShell {
    #context: ExtensionContextCoordinator | undefined;
    #documentSource: DocumentContextSource | undefined;
    #documentChoice: string | undefined;
    #documentMember: DocumentContextMember | undefined;
    #documentAttempt = 0;
    #documentState: DocumentContextState = INACTIVE_DOCUMENT_CONTEXT;
    readonly #documentListeners = new Set<() => void>();
    #readingPage: number | undefined;
    #readerTools: LiveReaderTools | undefined;
    #readerBridge: ReaderBridgeClient | undefined;
    #pointerVersion: NonNullable<DocumentContextState['version']> | undefined;
    readonly #readerVisibilityListeners = new Set<() => void>();
    #openReader: HTMLElement | undefined;
    #snapshot: DocumentContextSnapshot | undefined;
    #title: string | undefined;
    #displayMode: string | undefined;
    #message = '';
    /** A declined expand request; shown only while the reader is still hidden, never as #message. */
    #expandDeclined = false;
    #host: HostResourceAdapter | undefined;
    #hostNotice = '';
    #exportNotice = '';
    #exportPhase: 'preparing' | 'host-requested' | 'host-accepted' | 'host-declined' | 'failed' | undefined;
    #hostEpoch = 0;
    #hostRefreshPending = false;
    #hostUpdateRevision = 0;
    #hostSave: Promise<void> | undefined;
    #saveRequested = false;
    #hostRetry: { kind: 'save' | 'refresh'; button: HTMLButtonElement } | undefined;
    #grant: string | undefined;
    #active: ExtensionPresentation | undefined;
    #unmount: (() => void) | undefined;
    #loading: HTMLElement | undefined;
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
    #recoveryDialog: HTMLDialogElement | undefined;
    #teardown: Promise<boolean> | undefined;
    readonly #pageHidden = (event: PageTransitionEvent) => {
        if (!event.persisted) void this.teardown();
    };
    #watermark: number | undefined;
    readonly #listeners = new Set<(event: HostRuntimeInvalidation) => void>();
    constructor(readonly app: App, readonly root: HTMLElement, readonly status: HTMLElement, readonly controls: HTMLElement, readonly resources: () => OpenAIResources | undefined = () => undefined, readonly modelContext: () => OpenAIModelContext | undefined = () => undefined) { }
    #standardContext: OpenAIModelContext | undefined;
    /** OpenAI's model context when present, else the standard `ui/update-model-context` adapter once the host advertises it. */
    #modelContext(): OpenAIModelContext | undefined {
        const openai = this.modelContext();
        if (openai) return openai;
        this.#standardContext ??= createStandardModelContext(this.app);
        return this.#standardContext;
    }
    get ownsPanel() { return this.#received; }
    async receive(raw: unknown): Promise<boolean> {
        const result = parseExtensionResult(raw);
        if (!result)
            return false;
        if (this.#received || this.#closed)
            return true;
        this.#received = true;
        this.hostContextChanged(this.app.getHostContext?.() ?? {}, false);
        document.defaultView?.addEventListener('pagehide', this.#pageHidden);
        try {
            await this.#apply(result);
        }
        catch {
            this.#ended();
        }
        return true;
    }
    #request(request: Exclude<ExtensionRequest, { action: 'app' }>): Promise<ExtensionResult>;
    #request(request: ExtensionRequest): Promise<ExtensionResult | CodexAppResponse>;
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
    /** OpenAI hosts advertise their extension APIs after connect; other MCP Apps hosts have no file menu or conversation panel. */
    #forHost(openai: string, neutral: string) { return this.resources() || this.modelContext() ? openai : neutral; }
    #show(text: string) {
        if (this.#closed) return;
        this.#message = text;
        const compact = this.#active && this.#displayMode !== 'fullscreen';
        // A declined expand request only adjusts the compact line; it is never shown over a visible reader.
        const hint = compact && this.#expandDeclined ? this.#forHost('This host could not expand the reader. Open Placekeeper in the conversation panel to edit.', 'Use the expand control to open the reader.') : '';
        const summary = compact ? `${this.#snapshot?.title ?? this.#title ?? 'Placekeeper PDF'}${this.#snapshot ? ` · Page ${this.#snapshot.page} of ${this.#snapshot.pageCount}` : ''}.${hint ? '' : ' Open the reader to edit.'}` : '';
        this.status.textContent = [summary, text, hint, this.#exportNotice].filter(Boolean).join(' ');
        this.controls.dataset.displayMode = compact ? 'inline' : 'fullscreen';
        this.status.hidden = !this.status.textContent || (this.#loading !== undefined && !compact);
    }
    #beginLoading() {
        this.#clearLoading();
        this.root.dataset.extensionLoading = 'true';
        const loading = document.createElement('div');
        loading.className = 'extension-loading document-loading';
        loading.setAttribute('role', 'status');
        loading.setAttribute('aria-label', 'Opening document');
        const content = document.createElement('div');
        content.className = 'document-loading__content';
        const indicator = document.createElement('span');
        indicator.className = 'document-loading__indicator';
        indicator.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = 'Opening document…';
        content.append(indicator, label);
        loading.append(content);
        this.#loading = loading;
        this.controls.append(loading);
    }
    #clearLoading() {
        this.#loading?.remove();
        this.#loading = undefined;
        delete this.root.dataset.extensionLoading;
    }
    #exportProgress(phase: 'preparing' | 'host-requested' | 'host-accepted' | 'host-declined' | 'failed') {
        if (this.#closed) return;
        const previousPhase = this.#exportPhase;
        this.#exportPhase = phase;
        this.root.dataset.hostExportDiagnostic = JSON.stringify({ phase, previousPhase, downloadAdvertised: this.app.getHostCapabilities?.()?.downloadFile !== undefined });
        this.#exportNotice = phase === 'host-accepted' ? 'The host accepted the download. Check the saved PDF before closing this document.'
            : phase === 'host-declined' ? 'The download was cancelled or declined by the host. Your work is still available.'
            : phase === 'failed' ? 'Export did not complete. Your work is still available.' : '';
        this.#show(this.#message);
    }
    hostContextChanged(context: NonNullable<ReturnType<App['getHostContext']>>, reconcileContext = true) {
        if (context.displayMode !== undefined) this.#displayMode = context.displayMode;
        if (this.#displayMode === 'fullscreen') this.#expandDeclined = false;
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
        const openai = this.modelContext();
        const api = openai ?? this.#modelContext();
        this.#context = new ExtensionContextCoordinator(api, undefined, {
            // Without host readback or host-side removal, a remount has no prior state to resume or honor.
            freshInvocation: freshInvocation || !openai,
            onDocumentStatus: (member, status) => this.#documentPublished(member, status),
            onContextCleared: () => this.#cancelDocumentChoice(),
            beforeUpdate: async () => {
                const grant = this.#grant;
                if (!grant || this.#closed) throw Error('Context connection unavailable');
                const marked = await this.#request({ action: 'context-published', grant });
                if (marked.status !== 'context-ready' || this.#closed || grant !== this.#grant) throw Error('Context connection unavailable');
            },
        });
    }
    #button(label: string, action: () => Promise<void>, container = this.controls) { const button = document.createElement('button'); button.textContent = label; button.onclick = () => { if (this.#closed || button.disabled)
        return; button.disabled = true; void action().catch(() => this.#show('Placekeeper could not complete that action. Your protected work is retained.')).finally(() => { button.disabled = false; }); }; container.append(button); return button; }
    async #apply(result: ExtensionResult) {
        if (this.#closed) {
            if ('grant' in result)
                await this.#request({ action: 'revoke', grant: result.grant }).catch(() => undefined);
            return;
        }
        if (result.status === 'provisional') {
            if (this.#active && this.#grant !== result.grant) this.#pause();
            const epoch = this.#choiceEpoch;
            this.#grant = result.grant;
            const current = () => !this.#closed && epoch === this.#choiceEpoch && this.#grant === result.grant;
            if (result.hostFile) {
                await this.#resetHost();
                this.#host = this.#createHostAdapter();
                try { const opened = await this.#host.open({ ...result, hostFile: result.hostFile }); if (current()) await this.#apply(opened); else await this.#discardObsolete(opened); }
                catch {
                    if (!current()) return;
                    await this.#request({action:'revoke',grant:result.grant}).catch(()=>undefined);
                    this.#grant=undefined;await this.#resetHost();
                    this.#chooser(this.#forHost('The saved host file is unavailable. Reopen the PDF through its file menu; your protected work is retained.', 'The saved host file is unavailable. Ask to open the PDF in Placekeeper again; your protected work is retained.'));
                }
                return;
            }
            this.#resumeOperation = crypto.randomUUID();
            if (this.#host) {
                const refreshed = await this.#host.refresh(result.grant);
                if (!current()) return;
                if (refreshed.status === 'host-resource') {
                    if (this.#closed || this.#grant !== result.grant) return;
                    await this.#restartHost(refreshed);
                    return;
                }
                if (refreshed.status === 'host-status' && refreshed.outcome === 'conflict') this.#hostNotice = 'The host PDF changed before saving. Your work is protected; use Save options to keep your work in a separate copy.';
            }
            let activated: ExtensionResult | CodexAppResponse | undefined;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (!current()) return;
                try {
                    activated = await this.#request({ action: 'activate', grant: result.grant, operationId: this.#resumeOperation });
                    break;
                }
                catch (error) {
                    if (!current()) return;
                    if (attempt === 2) {
                        this.#ended();
                        return;
                    }
                    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1) + Math.random() * 250));
                }
            }
            if (!current()) { if (activated) { const obsolete = parseExtensionResult(activated); if (obsolete) await this.#discardObsolete(obsolete); } return; }
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
            this.#setupContext(result.contextPublished === false);
            this.#closeRecovery();
            this.controls.replaceChildren();
            this.#hostRetry = undefined;
            this.controls.className = 'extension-controls';
            this.controls.dataset.mode = 'review';
            this.status.dataset.extensionMode = 'review';
            this.#expandDeclined = false;
            this.#openReader = this.#button('Open reader', async () => {
                const mode = await this.#requestFullscreen().catch(() => undefined);
                if (mode !== 'fullscreen' && this.#displayMode !== 'fullscreen') { this.#expandDeclined = true; this.#show(this.#message); }
            });
            this.hostContextChanged(this.app.getHostContext?.() ?? {}, false);
            this.#mount();
            if (this.#host) {
                void this.#saveHost();
                if (this.#hostRefreshPending) queueMicrotask(() => { void this.#refreshHost(); });
            }
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
            this.#offerRecovery(result);
            return;
        }
        if (result.status === 'host-resource') {
            this.#exportNotice = ''; this.#exportPhase = undefined; delete this.root.dataset.hostExportDiagnostic;
            this.#show('Reading host PDF…');
            this.#host = this.#createHostAdapter();
            await this.#apply(await this.#host.open(result));
            return;
        }
        this.#ended();
    }
    #createHostAdapter() {
            const hostEpoch = ++this.#hostEpoch;
            return new HostResourceAdapter({ downloadFile: async (params, options) => {
                if (hostEpoch === this.#hostEpoch) this.#exportProgress('host-requested');
                const downloaded = await this.app.downloadFile(params, options);
                if (hostEpoch === this.#hostEpoch) this.#exportProgress(downloaded.isError ? 'host-declined' : 'host-accepted');
                return downloaded;
            }, resources: this.resources, request: async request => { const response = await this.#request(request); const parsed = parseExtensionResult(response); if (!parsed) throw Error('Host resource unavailable'); return parsed; }, current: () => !this.#closed && hostEpoch === this.#hostEpoch, onProvisional: grant => {
                if (!this.#closed && hostEpoch === this.#hostEpoch) {
                    if (this.#active && this.#grant !== grant) this.#pause();
                    this.#grant = grant;
                }
            }, onUpdate: () => { this.#hostRefreshPending = true; this.#hostUpdateRevision++; if (this.#active) void this.#refreshHost(); } });
    }
    /**
     * Requests fullscreen and applies the answer. The host may announce fullscreen through host context before (or after)
     * the request resolves with an older mode, so a fullscreen context is never overridden by the request's answer.
     */
    async #requestFullscreen(current: () => boolean = () => true) {
        const result = await this.app.requestDisplayMode({ mode: 'fullscreen' });
        if (!current()) return result.mode;
        const mode = result.mode === 'fullscreen' || this.app.getHostContext?.()?.displayMode === 'fullscreen' ? 'fullscreen' : result.mode;
        this.hostContextChanged({ displayMode: mode });
        return mode;
    }
    #closeRecovery() {
        this.#recoveryDialog?.close();
        this.#recoveryDialog?.remove();
        this.#recoveryDialog = undefined;
    }
    #offerRecovery(offer: Extract<ExtensionResult, { status: 'busy' }>) {
        this.#clearLoading();
        this.#closeRecovery();
        this.#show('');
        this.hostContextChanged(this.app.getHostContext?.() ?? {}, false);
        const epoch = ++this.#choiceEpoch;
        const current = () => !this.#closed && epoch === this.#choiceEpoch;
        const dialog = document.createElement('dialog');
        this.#recoveryDialog = dialog;
        // Same surface and order as the app's compact dialogs: title, one-line reason, then one action row.
        dialog.className = 'extension-recovery terminal-recovery';
        dialog.setAttribute('aria-labelledby', 'extension-recovery-title');
        const header = document.createElement('header');
        header.className = 'terminal-recovery__header';
        const body = document.createElement('div');
        body.className = 'terminal-recovery__body';
        const title = document.createElement('h1');
        title.id = 'extension-recovery-title';
        // Like the desktop recovery page, start on the title so no action looks preselected; Tab reaches the actions.
        title.tabIndex = -1;
        title.autofocus = true;
        const available = offer.canRecover || offer.canResume;
        title.textContent = 'Reopen Document';
        const description = document.createElement('p');
        description.id = 'extension-recovery-description';
        // One line says why the dialog appeared; the button labels carry the choices.
        description.textContent = offer.matchingCopy
            ? 'A saved copy has matching PDF contents and a similar filename.'
            : available ? 'You had this document open earlier.'
            : 'This document is still open elsewhere. Return to the previous reader or check again after its connection ends.';
        const feedback = document.createElement('p');
        feedback.className = 'extension-recovery__feedback terminal-recovery__status';
        feedback.setAttribute('role', 'status');
        const footer = document.createElement('div');
        footer.className = 'terminal-recovery__footer';
        const footerActions = document.createElement('div');
        footerActions.className = 'terminal-recovery__footer-actions';
        header.append(title);
        body.append(description, feedback);
        dialog.setAttribute('aria-describedby', description.id);
        footer.append(footerActions);
        dialog.append(header, body, footer);
        const buttons: HTMLButtonElement[] = [];
        let pending = false;
        const run = async (request: Extract<ExtensionRequest, { action: 'choose' | 'recheck' }>, progress: string) => {
            if (!current() || pending) return;
            pending = true;
            const focused = buttons.find(button => button === document.activeElement);
            feedback.textContent = progress;
            for (const button of buttons) button.disabled = true;
            try {
                const result = await this.#request(request);
                if (!current()) {
                    await this.#discardObsolete(result);
                    return;
                }
                if (result.status === 'unavailable') {
                    this.#chooser(this.#forHost('This document choice is no longer available. Choose the PDF again or reopen it from its file menu. Protected work is retained.', 'This document choice is no longer available. Choose the PDF again or ask to open it in Placekeeper again. Protected work is retained.'), 'Choose PDF again', true, true);
                } else if (result.status === 'host-resource') {
                    await this.#restartHost(result);
                } else {
                    await this.#apply(result);
                }
            } catch {
                if (current()) feedback.textContent = request.action === 'recheck'
                    ? 'Placekeeper could not check the previous connection. Try again.'
                    : 'Placekeeper could not open this document. Try again. Your protected work is retained.';
            } finally {
                pending = false;
                if (current()) {
                    for (const button of buttons) button.disabled = false;
                    focused?.focus();
                }
            }
        };
        const action = (label: string, parent: HTMLElement, onClick: () => void) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.onclick = onClick;
            buttons.push(button);
            parent.append(button);
            return button;
        };
        const cancel = () => {
            if (!current() || pending) return;
            this.#closeRecovery();
            if (this.#active && this.#grant) void this.#apply({ status: 'active', grant: this.#grant, presentation: this.#active });
            else this.#chooser(undefined, undefined, false, true);
        };
        // One action row: Cancel, alternatives, primary last.
        action('Cancel', footerActions, cancel);
        const choice = (kind: 'recover' | 'resume' | 'fork', label: string) => {
            const request = { action: 'choose', recoveryToken: offer.recoveryToken, choice: kind, operationId: crypto.randomUUID() } as const;
            action(label, footerActions, () => { void run(request, 'Opening document…'); }).className = kind === 'fork' ? 'terminal-recovery__secondary' : 'terminal-recovery__primary';
        };
        choice('fork', 'Open Copy');
        if (offer.canRecover) choice('recover', 'Continue');
        else if (offer.canResume) choice('resume', 'Continue');
        else action('Check again', footerActions, () => {
            void run({ action: 'recheck', recoveryToken: offer.recoveryToken }, 'Checking the previous connection…');
        }).className = 'terminal-recovery__primary';
        dialog.oncancel = event => { event.preventDefault(); cancel(); };
        this.controls.append(dialog);
        dialog.showModal();
    }
    #contextBridge(tools: LiveReaderTools, epoch: number): DocumentAgentBridge {
        const grant = this.#grant;
        const mounted = () => epoch === this.#epoch && grant === this.#grant && !this.#closed;
        return {
            attach: actions => tools.attach(actions),
            addContext: input => this.#addContext(input, epoch),
            documentContext: {
                setSource: source => {
                    if (mounted() && (source === undefined || source.generation === this.#active?.generation)) {
                        this.#setDocumentSource(source);
                    }
                },
                getState: () => mounted() ? this.#documentState : INACTIVE_DOCUMENT_CONTEXT,
                subscribe: listener => {
                    this.#documentListeners.add(listener);
                    return () => this.#documentListeners.delete(listener);
                },
                activate: () => {
                    const source = this.#documentSource;
                    if (!mounted() || !source || !this.#documentState.canActivate) return;
                    this.#documentChoice = source.sourceKey;
                    this.#syncDocument();
                },
            },
        };
    }
    #setDocumentSource(source: DocumentContextSource | undefined) {
        const previous = this.#documentSource;
        this.#documentSource = source;
        if (source === previous || sameDocumentContextVersion(source, previous)) return;
        if (source && this.#documentChoice !== source.sourceKey) this.#documentChoice = undefined;
        this.#clearDocument();
        this.#syncDocument();
    }
    #clearDocument() {
        this.#documentAttempt++;
        this.#documentMember = undefined;
        this.#context?.clearDocument();
        if (this.#pointerVersion) {
            this.#pointerVersion = undefined;
            this.#context?.removeAttachment(documentPointerId);
        }
    }
    /** Publishes a text note (title, pages, how to read on request), never the PDF bytes. */
    async #preparePointer(source: DocumentContextSource, version: NonNullable<DocumentContextState['version']>) {
        const grant = this.#grant, epoch = this.#epoch, connection = this.#connectionEpoch;
        const attempt = ++this.#documentAttempt;
        const current = () => grant !== undefined && grant === this.#grant && epoch === this.#epoch
            && connection === this.#connectionEpoch && this.#connected && !this.#closed && !this.#hostRefreshPending
            && attempt === this.#documentAttempt && sameDocumentContextVersion(version, this.#documentSource);
        const context = this.#context;
        if (!current() || !context) return;
        const snapshot = this.#snapshot?.documentGeneration === version.generation ? this.#snapshot : undefined;
        const title = source.title.slice(0, 160);
        const text = [
            `Title: ${title}`,
            ...(snapshot ? [`Pages: ${snapshot.pageCount}`] : []),
            'This PDF is open in the Placekeeper reader. Its contents are not attached here.',
            `Read its full text on request with the ${READ_DOCUMENT_TEXT_TOOL} tool (optional startPage and endPage), and search it with search_document.`,
        ].join('\n');
        this.#pointerVersion = version;
        try {
            await context.includeAttachment({ id: documentPointerId, title: `Placekeeper PDF: ${title}`, text });
            if (current()) this.#setDocumentState({ version, status: 'available', detail: DOCUMENT_ON_REQUEST_DETAIL, canActivate: false });
        } catch {
            if (!current()) return;
            if (sameDocumentContextVersion(this.#pointerVersion, version)) this.#pointerVersion = undefined;
            this.#setDocumentState({ version, status: 'unavailable', reason: 'The document note could not be added to chat context.', canActivate: true });
        }
    }
    #setDocumentState(state: DocumentContextState) {
        this.#documentState = state;
        for (const listener of this.#documentListeners) listener();
    }
    #syncDocument() {
        const source = this.#documentSource;
        const version = source
            ? { sourceKey: source.sourceKey, generation: source.generation, digest: source.digest }
            : this.#documentState.version;
        const identity = version === undefined ? {} : { version };
        // Without PDF resources, a host whose chat can call the relayed reader tools gets a short pointer instead.
        const pointer = !this.app.getHostCapabilities?.()?.updateModelContext?.resource && this.#readerBridge?.state === 'active';
        if (!this.#modelContext() || (!pointer && !this.app.getHostCapabilities?.()?.updateModelContext?.resource)) {
            this.#setDocumentState({ ...identity, status: 'unsupported', reason: 'This host cannot receive a PDF in chat context.', canActivate: false });
        } else if (!this.#connected || this.#closed) {
            this.#setDocumentState({ ...identity, status: 'unavailable', reason: 'The reader connection is unavailable.', canActivate: false });
        } else if (this.#documentChoice !== undefined && this.#documentChoice === version?.sourceKey) {
            if (pointer && this.#documentState.status === 'available' && sameDocumentContextVersion(this.#pointerVersion, version)) return;
            this.#setDocumentState({ ...identity, status: 'publishing', canActivate: false });
            if (source && version && !this.#hostRefreshPending) void (pointer ? this.#preparePointer(source, version) : this.#prepareDocument(source, version));
        } else {
            this.#setDocumentState({ ...identity, status: 'idle', canActivate: source !== undefined && !this.#hostRefreshPending });
        }
    }
    async #prepareDocument(source: DocumentContextSource, version: NonNullable<DocumentContextState['version']>) {
        const grant = this.#grant, epoch = this.#epoch, connection = this.#connectionEpoch;
        const attempt = ++this.#documentAttempt;
        const current = () => grant !== undefined && grant === this.#grant && epoch === this.#epoch
            && connection === this.#connectionEpoch && this.#connected && !this.#closed && !this.#hostRefreshPending
            && attempt === this.#documentAttempt && sameDocumentContextVersion(version, this.#documentSource);
        try {
            if (!current()) return;
            const bytes = await source.readBytes();
            if (!current()) return;
            if (!bytes?.length) throw Error('Verified PDF bytes unavailable');
            const blob = await encodeDocument(bytes, current);
            if (!current() || blob === undefined) return;
            const member: DocumentContextMember = {
                ...version, title: source.title, blob,
                beforeSubmit: async () => {
                    if (!current()) throw Error('Document changed');
                    const proof = await this.#payload('watermark', {}, epoch) as { sessionId?: string; documentGeneration?: number };
                    if (!current() || !proof.sessionId || !version.sourceKey.startsWith(documentContextSourceKey(proof.sessionId, ''))
                        || proof.documentGeneration !== version.generation) throw Error('Document presentation changed');
                },
            };
            this.#documentMember = member;
            this.#context?.setDocument(member);
        } catch {
            if (current()) this.#setDocumentState({ version, status: 'unavailable', reason: 'Could not prepare the verified PDF.', canActivate: true });
        }
    }
    #cancelDocumentChoice() {
        if (this.#documentChoice === undefined) return;
        this.#documentChoice = undefined;
        this.#clearDocument();
        this.#syncDocument();
    }
    #documentPublished(member: DocumentContextMember, status: DocumentContextPublicationStatus) {
        if (status === 'removed') {
            if (member.sourceKey === this.#documentChoice) this.#cancelDocumentChoice();
            return;
        }
        if (this.#documentMember !== member || !this.#connected || this.#closed || !sameDocumentContextVersion(member, this.#documentSource)) return;
        const version = this.#documentState.version!;
        if (status === 'unavailable') {
            this.#documentMember = undefined;
            this.#setDocumentState({ version, status, reason: 'The PDF could not be added to chat context.', canActivate: true });
        } else {
            this.#setDocumentState({ version, status, canActivate: false });
        }
    }
    async #addContext(input: DocumentAgentContextInput, epoch: number) {
        const grant = this.#grant;
        const current = () => grant && grant === this.#grant && epoch === this.#epoch && !this.#closed && this.#connected && input.snapshot.documentGeneration === this.#active?.generation;
        if (!current() || !this.#context || !this.#modelContext()) throw Error('Context sharing is unavailable. Reconnect and try again.');
        const attachment = await prepareDocumentContext(input);
        if (!current()) throw Error('The document changed. Select the evidence again.');
        await this.#context.includeAttachment(attachment);
    }
    #resetHost() { const host = this.#host; this.#host = undefined; this.#hostEpoch++; this.#hostNotice = ''; this.#hostRefreshPending = false; this.#hostUpdateRevision = 0; this.#saveRequested = false; this.#hostSave = undefined; return host?.dispose().catch(() => undefined); }
    async #restartHost(result: Extract<ExtensionResult, { status: 'host-resource' }>) {
        if (this.#active) this.#pause();
        this.#grant = undefined;
        this.#resumeOperation = undefined;
        await this.#resetHost();
        await this.#apply(result);
    }
    async #discardObsolete(result: ExtensionResult) {
        if ('grant' in result && (this.#closed || result.grant !== this.#grant))
            await this.#request({ action: 'revoke', grant: result.grant }).catch(() => undefined);
    }
    #chooser(notice = '', label = 'New Document', cancellable = false, restoreFocus = false) {
        this.#clearLoading();
        const epoch = ++this.#choiceEpoch;
        this.controls.className = 'extension-controls'; this.controls.dataset.mode = 'chooser'; this.status.dataset.extensionMode = 'chooser';
        if (!this.#active) this.#resetHost();
        this.#closeRecovery();
        this.#show(notice); this.controls.replaceChildren();
        const heading = document.createElement('h3');
        heading.textContent = 'Recent Documents';
        const list = document.createElement('div');
        list.className = 'extension-recent-list';
        const footer = document.createElement('div');
        footer.className = 'extension-chooser-footer';
        this.controls.append(heading, list, footer);
        const current = () => !this.#closed && epoch === this.#choiceEpoch;
        let opening = false;
        const buttons: HTMLButtonElement[] = [];
        const addOpenButton = (text: string, request: Extract<ExtensionRequest, { action: 'open' | 'recent-open' }>, container: HTMLElement, recentChoice?: 'resume' | 'fork', feedback?: HTMLElement) => {
            let retryChoice: Extract<ExtensionRequest, { action: 'choose' }> | undefined;
            const button = this.#button(text, async () => {
                if (!current() || opening) return;
                opening = true; for (const control of buttons) control.disabled = true;
                try {
                    if (feedback) feedback.textContent = '';
                    let parsed = parseExtensionResult(await this.#request(retryChoice ?? request));
                    if (!current()) { if (parsed) await this.#discardObsolete(parsed); return; }
                    if (request.action === 'recent-open' && recentChoice && parsed?.status === 'busy') {
                        if (recentChoice === 'resume' && !parsed.canResume && !parsed.canRecover) {
                            if (feedback) feedback.textContent = 'Still open elsewhere. Try Resume again shortly.';
                            return;
                        }
                        retryChoice = { action: 'choose', recoveryToken: parsed.recoveryToken, choice: recentChoice === 'fork' ? 'fork' : parsed.canRecover ? 'recover' : 'resume', operationId: crypto.randomUUID() };
                        parsed = parseExtensionResult(await this.#request(retryChoice));
                    }
                    retryChoice = undefined;
                    if (!current()) { if (parsed) await this.#discardObsolete(parsed); return; }
                    if (parsed?.status === 'chooser') { this.#show(this.#forHost('Use the PDF’s file menu to open it in Placekeeper on this host.', 'Ask to open the PDF in Placekeeper again.')); return; }
                    if (parsed?.status === 'unavailable' && request.action === 'recent-open') { if (feedback) feedback.textContent = 'Could not open this document. Try again.'; return; }
                    // A local picker selection changes the source route; cancellation retains it.
                    if (request.action === 'open' && (parsed?.status === 'provisional' || parsed?.status === 'busy')) this.#resetHost();
                    if (parsed?.status === 'provisional' || parsed?.status === 'host-resource') this.#choiceEpoch++;
                    if (parsed) await this.#apply(parsed);
                } catch (error) { if (current()) { if (feedback) feedback.textContent = 'Could not open this document. Try again.'; else throw error; } }
                finally { opening = false; if (current()) for (const control of buttons) control.disabled = false; }
            }, container);
            button.disabled = opening; buttons.push(button);
            return button;
        };
        const choose = addOpenButton(label, { action: 'open' }, footer);
        choose.className = 'extension-choose-pdf';
        if (restoreFocus) choose.focus();
        void this.#showRecent(current, addOpenButton, list);
        if (cancellable) this.#button('Cancel', async () => {
            if (!current()) return;
            if (this.#active && this.#grant) await this.#apply({ status: 'active', grant: this.#grant, presentation: this.#active });
            else this.#chooser();
        }, footer);
    }
    async #showRecent(current: () => boolean, addOpenButton: (label: string, request: Extract<ExtensionRequest, { action: 'open' | 'recent-open' }>, container: HTMLElement, recentChoice?: 'resume' | 'fork', feedback?: HTMLElement) => HTMLButtonElement, list: HTMLElement) {
        try {
            const result = await this.#request({ action: 'recent-list' });
            if (!current() || result.status !== 'recent-reviews') return;
            if (result.items.length === 0) {
                const empty = document.createElement('p');
                empty.textContent = 'No recent documents yet.';
                list.append(empty);
                return;
            }
            for (const item of result.items) {
                const row = document.createElement('div');
                row.className = 'extension-recent-card';
                const details = document.createElement('span');
                details.className = 'extension-recent-card__details';
                const title = document.createElement('span');
                title.className = 'extension-recent-card__title';
                title.textContent = item.title;
                const date = document.createElement('span');
                date.className = 'extension-recent-card__date';
                date.textContent = new Date(item.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
                details.append(title, date);
                const actions = document.createElement('div');
                actions.className = 'extension-recent-card__actions';
                const feedback = document.createElement('p');
                feedback.className = 'extension-recent-card__feedback';
                feedback.setAttribute('role', 'status');
                const resume = addOpenButton('Resume', { action: 'recent-open', id: item.id }, actions, 'resume', feedback);
                resume.setAttribute('aria-label', `Resume ${item.title}`);
                const copy = addOpenButton('Open Copy', { action: 'recent-open', id: item.id }, actions, 'fork', feedback);
                copy.setAttribute('aria-label', `Open copy of ${item.title}`);
                row.append(details, actions, feedback);
                list.append(row);
            }
        } catch { if (current()) this.#show('Recent documents are unavailable. You can still choose a PDF.'); }
    }
    #rememberPage(snapshot: DocumentContextSnapshot) {
        if(!this.#grant||!this.#connected||this.#readingPage===snapshot.page)return;
        const grant=this.#grant;this.#readingPage=snapshot.page;
        void this.#request({action:'reading-position',grant,page:snapshot.page}).then(result=>{
            if(result.status!=='position-saved'&&this.#grant===grant)this.#readingPage=undefined;
        },()=>{if(this.#grant===grant)this.#readingPage=undefined;});
    }
    #mount() {
        const active = this.#active;
        if (!active || this.#closed)
            return;
        const epoch = ++this.#epoch;
        this.#connected = true;
        this.#documentSource = undefined;
        this.#clearDocument();
        this.#syncDocument();
        this.#verified.clear();
        this.root.inert = document.hidden;
        this.#readerTools?.dispose();
        this.#readerBridge?.stop();
        this.#readerBridge = undefined;
        this.#unmount?.();
        const native = (document as Document & { modelContext?: DocumentModelContext }).modelContext;
        // Plain MCP Apps hosts (Claude Desktop) lack WebMCP; their chat reaches these tools through the server relay.
        const captured = native || this.resources() || this.modelContext() ? undefined : new CapturedModelContext();
        const readerTools = this.#readerTools = new LiveReaderTools(native ?? captured, {
            connected: () => epoch === this.#epoch && this.#connected && !this.#closed,
            available: () => epoch === this.#epoch && this.#connected && !this.#closed && !document.hidden && !this.root.hidden && !this.root.inert,
            ensureVisible: async () => {
                if (epoch !== this.#epoch || !this.#connected || this.#closed) return false;
                if (this.#displayMode !== 'fullscreen' || document.hidden || this.root.hidden) {
                    try { await this.#requestFullscreen(() => epoch === this.#epoch); if (epoch !== this.#epoch) return false; }
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
        if (captured && readerTools.supported) this.#startReaderBridge(captured, readerTools, epoch);
        else if (!readerTools.supported) this.#show(liveToolsUnavailable);
        this.#listeners.clear();
        this.#watermark = undefined;
        const runtime = createCodexHostRuntime({ runtimeId: active.runtimeId, contextOwner: 'app', ...(this.#host ? { annotatedCopyExport: this.app.getHostCapabilities?.()?.downloadFile !== undefined } : {}), call: (method, payload) => this.#payload(method, payload, epoch), openExternalUrl: async value => {
            const url = externalWebUrl(value);
            if (epoch !== this.#epoch || this.#closed || !this.#connected || url === null || this.app.getHostCapabilities?.()?.openLinks === undefined) throw new Error('Host link opening is unavailable.');
            const result = await this.app.openLink({ url });
            if (result.isError === true) throw new Error('The host could not open this web link.');
        }, subscribeInvalidations: listener => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); } });
        this.#beginLoading();
        this.#show('');
        this.#unmount = mountCodexProductionDocument(this.root, runtime, () => { if (epoch === this.#epoch) {
            this.#clearLoading();
            this.#show(this.#forHost('The PDF could not be loaded. Reopen it through the file menu; protected work is retained.', 'The PDF could not be loaded. Ask to open it in Placekeeper again; protected work is retained.')); } }, () => { if (epoch === this.#epoch) {
            this.#clearLoading();
            this.#show(this.#connected ? this.#hostNotice : this.#message); } }, this.#contextBridge(this.#readerTools, epoch), snapshot => { if (epoch !== this.#epoch || this.#closed || !this.#connected || snapshot.documentGeneration !== this.#active?.generation) return; this.#snapshot = snapshot; this.#rememberPage(snapshot); this.#context?.publish(snapshot); this.#show(this.#message); }, (title, generation) => { if (epoch !== this.#epoch || this.#closed || generation !== this.#active?.generation) return; this.#title = title; this.#show(this.#message); });
        this.#liveness?.stop();
        this.#liveness = new PanelLiveness({ renew: async () => { await this.#probe('renew'); }, poll: async () => { await this.#probe('watermark'); }, pollInterval: () => document.hidden ? 5000 : 1000, onState: state => { if (epoch !== this.#epoch || this.#closed)
                return; if (state === 'reconnecting')
                this.#pause(); }, onTerminal: () => { if (epoch === this.#epoch)
                this.#ended(); } });
        this.#liveness.start();
    }
    #startReaderBridge(captured: CapturedModelContext, tools: LiveReaderTools, epoch: number) {
        const bridge = new ReaderBridgeClient({
            call: async (request, timeout) => {
                const result = await this.app.callServerTool({ name: READER_BRIDGE_TOOL, arguments: { request } }, { timeout });
                return result.isError ? undefined : parseReaderBridgeResponse(result.structuredContent);
            },
            execute: async (tool, input) => {
                if (epoch !== this.#epoch || this.#closed) throw Error('Reader changed');
                if (tool === READ_DOCUMENT_TEXT_TOOL) return tools.readDocumentText(input);
                const pending = captured.execute(tool, input);
                if (!pending) throw Error('Reader tool unavailable');
                return pending;
            },
            onState: state => {
                if (epoch !== this.#epoch || this.#closed || this.#readerBridge !== bridge) return;
                this.root.dataset.readerBridge = state;
                if (state === 'unsupported') this.#show(liveToolsUnavailable);
                else if (state === 'active' && this.#message === liveToolsUnavailable) this.#show('');
                this.#syncDocument();
            },
        });
        this.#readerBridge = bridge;
        this.root.dataset.readerBridge = bridge.state;
        bridge.start();
    }
    #pause() {
        if (this.#closed)
            return;
        if (this.#connected) {
            this.#verified.clear();
            this.#connectionEpoch++;
            this.#connected = false;
            this.#clearDocument();
            this.#syncDocument();
        }
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
                    this.#syncDocument();
                }
            }
            if (method === 'watermark' && value.sessionId) {
                if (this.#watermark !== undefined && value.watermark !== this.#watermark)
                    for (const listener of this.#listeners)
                        // Either revision spelling; see LEGACY_ANNOTATION_REVISION_KEY.
                        listener({ sessionId: value.sessionId, generation: value.documentGeneration, revision: wireAnnotationRevision(value)!, reason: 'freshness' });
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
        if (method === 'chooseCopy' && this.#host) return this.#host.withSaveBarrier(() => this.#dispatchPayload(method, payload, epoch));
        return this.#dispatchPayload(method, payload, epoch);
    }
    async #dispatchPayload(method: Extract<CodexAppRequest, {
        authority: 'presentation';
    }>['method'], payload: unknown, epoch: number): Promise<unknown> {
        const active = this.#active;
        if (!active || this.#closed || epoch !== this.#epoch)
            throw new NativeDiagnosticError('stale-reply');
        if (method === 'exportReviewedCopy' && this.#host && this.#grant) {
            if (this.app.getHostCapabilities?.()?.downloadFile === undefined) throw Error('PDF download is unavailable. Use Save options to save an annotated copy.');
            const value = payload as { fence?: { expectedRevision: number; documentGeneration: number } };
            if (!value.fence) throw Error('Refresh the document before exporting.');
            const hostEpoch = this.#hostEpoch;
            this.#exportProgress('preparing');
            try { return await this.#host.export(this.#grant, value.fence); }
            catch (error) { if (hostEpoch === this.#hostEpoch) this.#exportProgress('failed'); throw error; }
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
        if (method === 'chooseCopy' && (response.payload as { destination?: { phase?: string; kind?: string } })?.destination?.phase === 'active' && (response.payload as { destination?: { kind?: string } }).destination?.kind === 'copy') { this.#hostNotice = ''; this.#exportNotice = ''; this.#show(''); }
        if (this.#host && (method === 'command' || method === 'finalizeInteraction')) void this.#saveHost();
        if (this.#hostRefreshPending && ['finalizeInteraction', 'releaseInteraction', 'acknowledgeInteraction'].includes(method)) void this.#continue().catch(() => undefined);
        return response.payload;
    }
    #offerHostRetry(kind: 'save' | 'refresh') {
        if (this.#hostRetry?.kind === kind) return;
        this.#hostRetry?.button.remove();
        const button = kind === 'save'
            ? this.#button('Retry host save', () => this.#saveHost())
            : this.#button('Retry refresh', () => this.#refreshHost());
        this.#hostRetry = { kind, button };
    }
    async #refreshHost() {
        const epoch = this.#hostEpoch;
        if (this.#hostRefreshPending) {
            this.#clearDocument();
            this.#syncDocument();
        }
        try { await this.#continue(); }
        catch {
            if (this.#closed || this.#hostEpoch !== epoch) return;
            if (this.#documentState.status === 'publishing') {
                this.#setDocumentState({ ...this.#documentState, status: 'unavailable', reason: 'The host PDF could not be refreshed.' });
            }
            this.#show('The host PDF could not be refreshed. Finish any current edit, then retry; your protected work is retained.');
            this.#offerHostRetry('refresh');
        }
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
                    if (result.outcome === 'local-copy' || result.outcome === 'saved') {
                        if (this.#hostRetry?.kind === 'save') {
                            this.#hostRetry.button.remove();
                            this.#hostRetry = undefined;
                        }
                        this.#hostNotice = '';
                        this.#show('');
                    }
                    else if (result.outcome === 'read-only') { this.#hostNotice = 'This host PDF is read-only. Your work is protected; use Save options to autosave to a copy.'; this.#show(this.#hostNotice); }
                    else if (result.outcome === 'conflict') { this.#hostNotice = 'The host PDF changed before saving. Your work is protected. Use Save options to keep your work in a separate copy.'; this.#show(this.#hostNotice); }
                    else if (result.outcome === 'protected') { this.#hostNotice = 'The host save was not completed. Your work is protected; retry the save or use Save options to save a copy.'; this.#show(this.#hostNotice); this.#offerHostRetry('save'); }
                    else if (result.outcome === 'unknown') { this.#hostNotice = 'The host save could not be confirmed. Your work is protected; refresh to check the current PDF.'; this.#show(this.#hostNotice); this.#offerHostRetry('refresh'); }
                }
            }
        })().catch(() => {
            if (this.#closed || hostEpoch !== this.#hostEpoch) return;
            this.#show('Host save could not be completed. Your work is protected; retry the save or use Save options to save a copy.');
            this.#offerHostRetry('save');
        }).finally(() => { if (this.#hostSave === running) this.#hostSave = undefined; });
        this.#hostSave = running; return running;
    }
    async #continue() {
        if (this.#closed)
            return;
        if (this.#resume)
            return this.#resume;
        if (!this.#grant)
            throw new NativeDiagnosticError('service-denied-unavailable');
        if (!this.#host || !this.#connected) this.#pause();
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
                        if (refreshed.status === 'host-status' && refreshed.outcome === 'conflict') this.#hostNotice = 'The host PDF changed before saving. Your work is protected; use Save options to keep your work in a separate copy.';
                    } while (this.#hostRefreshPending && !this.#closed);
                    this.#resumeRefreshed = operationId;
                }
                this.#pause();
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
        return; this.#clearLoading(); this.#connected = false; this.#endDocumentContext(); this.#readerTools?.dispose(); this.#readerBridge?.stop(); this.#closeRecovery(); this.#context?.dispose(); this.#liveness?.stop(); void this.#host?.dispose().catch(() => undefined); this.root.inert = true; this.#show(this.#forHost('This connection ended. Reopen the PDF through its file menu; accepted annotations and protected drafts are retained.', 'This connection ended. Ask to open the PDF in Placekeeper again; accepted annotations and protected drafts are retained.')); this.#closed = true; this.#epoch++; }
    #endDocumentContext() {
        this.#documentChoice = undefined;
        this.#documentSource = undefined;
        this.#clearDocument();
        this.#syncDocument();
        this.#documentListeners.clear();
    }
    visibilityChanged(hidden: boolean) {
        if (!this.#active || this.#closed) return;
        this.root.inert = hidden || !this.#connected;
        for (const listener of this.#readerVisibilityListeners) listener();
        if (hidden) this.#show('Reader suspended while the app is hidden. Protected work is retained.');
        else { this.#show(this.#connected ? this.#hostNotice : 'Reconnecting to Placekeeper… Editing is paused.'); this.wake(); }
    }
    wake() { if (this.#connected && !document.hidden) this.#context?.retry(); this.#liveness?.wake(); }
    disconnected() { if (this.ownsPanel)
        this.#ended(); }
    teardown() {
        return this.#teardown ??= this.#release();
    }
    async #release() {
        document.defaultView?.removeEventListener('pagehide', this.#pageHidden);
        this.#clearLoading();
        this.#closed = true;
        this.#connected = false;
        const contextShutdown = this.#context?.shutdown();
        this.#endDocumentContext();
        this.root.inert = true;
        const grant = this.#grant, host = this.#host, operationId = this.#resumeOperation;
        this.#epoch++;
        this.#grant = undefined;
        this.#active = undefined;
        this.#host = undefined;
        // Release ownership while the host still accepts requests. An in-flight
        // activation or resume may have rotated the grant before its reply arrives.
        const revoked = grant
            ? this.#request({ action: 'revoke', grant, ...(operationId === undefined ? {} : { operationId }) })
                .then(result => result.status === 'closed', () => false)
            : Promise.resolve(true);
        try {
            this.#liveness?.stop();
            this.#readerTools?.dispose();
            this.#readerBridge?.stop();
            this.#closeRecovery();
            this.#unmount?.();
            this.#listeners.clear();
        } finally {
            void host?.dispose().catch(() => undefined);
            await Promise.all([revoked, contextShutdown]);
        }
        return revoked;
    }
}
