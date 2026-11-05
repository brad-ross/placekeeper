import type { App } from '@modelcontextprotocol/ext-apps';
import type { OpenAIResources } from '@openai/mcp-extensions/app';
import { HOST_RESOURCE_CHUNK_BYTES, HOST_RESOURCE_MAX_BYTES, type HostResourceIntent } from '../../../packages/core/src/host-resource-protocol.js';
import type { ExtensionRequest, ExtensionResult } from '../../../packages/core/src/extension-protocol.js';
const encode = (bytes: Uint8Array) => { let binary = ''; for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(binary); };
const decode = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
export class HostResourceAdapter {
    #file: {
        name: string;
        resourceUri: string;
    } | undefined;
    #epoch = 0;
    #unsubscribe: (() => void) | undefined;
    #subscribed = false;
    readonly #reads = new Set<AbortController>();
    #tail: Promise<unknown> = Promise.resolve();
    constructor(readonly options: {
        resources: () => OpenAIResources | undefined;
        request: (r: ExtensionRequest) => Promise<ExtensionResult>;
        current: () => boolean;
        onUpdate: () => void;
        digest?: (b: Uint8Array<ArrayBuffer>) => Promise<string>;
        downloadFile?: App['downloadFile'];
    }) { }
    #current(epoch: number) { return epoch === this.#epoch && this.options.current(); }
    #assert(epoch: number) { if (!this.#current(epoch))
        throw Error('Host resource attempt retired'); }
    #digest(bytes: Uint8Array<ArrayBuffer>) { return this.options.digest?.(bytes) ?? crypto.subtle.digest('SHA-256', bytes).then(hash => Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')); }
    #serial<T>(work: () => Promise<T>): Promise<T> { const result = this.#tail.then(work, work); this.#tail = result.catch(() => undefined); return result; }
    async open(result: Extract<ExtensionResult, {
        status: 'host-resource';
    }>): Promise<ExtensionResult> {
        const epoch = this.#epoch, resources = this.options.resources();
        if (!resources)
            throw Error('This host cannot read the selected PDF. Open a local PDF through its file menu.');
        this.#file = result.file;
        this.#unsubscribe = resources.addUpdateHandler(event => { if (event.params.uri === this.#file?.resourceUri && this.options.current())
            this.options.onUpdate(); });
        const imported = await this.#serial(() => this.#read({ ticket: result.ticket }));
        this.#assert(epoch);
        try {
            await resources.subscribe({ uri: result.file.resourceUri });
            if (!this.#current(epoch)) {
                await resources.unsubscribe({ uri: result.file.resourceUri }).catch(() => undefined);
                throw Error('Host resource attempt retired');
            }
            this.#subscribed = true;
        }
        catch (error) {
            if (!this.#current(epoch))
                throw error;
        }
        this.#assert(epoch);
        return imported;
    }
    withSaveBarrier<T>(work: () => Promise<T>): Promise<T> {
        const epoch = this.#epoch;
        return this.#serial(async () => { this.#assert(epoch); return work(); });
    }
    refresh(grant: string) { return this.#serial(() => this.#read({ grant })); }
    async #read(authority: {
        ticket: string;
    } | {
        grant: string;
    }): Promise<ExtensionResult> {
        const epoch = this.#epoch, resources = this.options.resources(), file = this.#file;
        if (!resources || !file)
            throw Error('Host resource unavailable');
        let transfer: string | undefined;
        const controller = new AbortController();
        this.#reads.add(controller);
        try {
            const result = await resources.read({ uri: file.resourceUri, representation: 'blob' }, { signal: controller.signal });
            this.#assert(epoch);
            const content = result.contents.find(c => c.uri === file.resourceUri && 'blob' in c);
            if (!content || !('blob' in content) || content.blob.length === 0 || content.blob.length > Math.ceil(HOST_RESOURCE_MAX_BYTES / 3) * 4)
                throw Error('The host PDF is empty or exceeds the supported size.');
            const bytes = decode(content.blob);
            if (bytes.length === 0 || bytes.length > HOST_RESOURCE_MAX_BYTES || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-')
                throw Error('The host did not return a PDF.');
            const sha256 = await this.#digest(bytes);
            this.#assert(epoch);
            const metadata = content.openaiMetadata;
            const started = await this.options.request({ action: 'host-resource', operation: 'begin', ...authority, byteLength: bytes.length, sha256, writable: metadata?.writable === true, ...(metadata?.etag ? { etag: metadata.etag } : {}) });
            if (started.status !== 'host-transfer' || started.offset !== 0)
                throw Error('Host PDF admission unavailable');
            transfer = started.transfer;
            this.#assert(epoch);
            for (let offset = 0; offset < bytes.length; offset += HOST_RESOURCE_CHUNK_BYTES) {
                const chunk = bytes.subarray(offset, offset + HOST_RESOURCE_CHUNK_BYTES);
                const accepted = await this.options.request({ action: 'host-resource', operation: 'chunk', transfer, offset, dataBase64: encode(chunk) });
                this.#assert(epoch);
                if (accepted.status !== 'host-transfer' || accepted.transfer !== transfer || accepted.offset !== offset + chunk.length)
                    throw Error('Host transfer failed');
            }
            const finished = await this.options.request({ action: 'host-resource', operation: 'finish', transfer });
            if (!this.#current(epoch) && 'grant' in finished)
                await this.options.request({ action: 'revoke', grant: finished.grant }).catch(() => undefined);
            this.#assert(epoch);
            if ('grant' in authority && finished.status !== 'host-ready' && !(finished.status === 'host-status' && finished.outcome === 'conflict') || 'ticket' in authority && finished.status !== 'provisional' && finished.status !== 'busy')
                throw Error('The host returned an invalid source admission result.');
            return finished;
        }
        catch (error) {
            if (transfer)
                await this.options.request({ action: 'host-resource', operation: 'cancel', transfer }).catch(() => undefined);
            throw error;
        } finally { this.#reads.delete(controller); }
    }
    async #download(grant: string, intent: HostResourceIntent, epoch: number) {
        if (intent.byteLength <= 0 || intent.byteLength > HOST_RESOURCE_MAX_BYTES)
            throw Error('Host save exceeds supported size');
        const bytes = new Uint8Array(intent.byteLength);
        for (let offset = 0; offset < bytes.length;) {
            const result = await this.options.request({ action: 'host-resource', operation: 'save-chunk', grant, intentId: intent.id, offset });
            this.#assert(epoch);
            if (result.status !== 'host-chunk')
                throw Error('Host save unavailable');
            const chunk = decode(result.dataBase64), length = Math.min(HOST_RESOURCE_CHUNK_BYTES, bytes.length - offset);
            if (chunk.length !== length || result.done !== (offset + length === bytes.length))
                throw Error('Host save transfer incomplete');
            bytes.set(chunk, offset);
            offset += length;
        }
        if (await this.#digest(bytes) !== intent.sha256)
            throw Error('Host save integrity failed');
        this.#assert(epoch);
        return bytes;
    }
    save(grant: string): Promise<ExtensionResult> {
        return this.#serial(async () => {
            const epoch = this.#epoch, resources = this.options.resources(), file = this.#file;
            if (!resources || !file)
                throw Error('Host resource unavailable');
            const result = await this.options.request({ action: 'host-resource', operation: 'save', grant });
            this.#assert(epoch);
            if (result.status !== 'host-save')
                return result;
            const intent = result.intent;
            if (intent.purpose !== 'save')
                throw Error('Host save intent invalid');
            const bytes = await this.#download(grant, intent, epoch);
            // An absent ETag never authorizes an unconditional host write.
            if (!intent.ifMatch)
                throw Error('Host conditional save unavailable');
            let receipt;
            try {
                receipt = await resources.write(file.resourceUri, { blob: encode(bytes), ifMatch: intent.ifMatch });
            }
            catch {
                this.#assert(epoch);
                await this.options.request({ action: 'host-resource', operation: 'receipt', grant, intentId: intent.id, outcome: 'unknown' });
                const reconciled = await this.#read({ grant });
                if (reconciled.status === 'host-status' && reconciled.outcome === 'conflict')
                    return reconciled;
                return this.options.request({ action: 'host-resource', operation: 'status', grant });
            }
            this.#assert(epoch);
            if (receipt.outcome === 'too-large')
                return this.options.request({ action: 'host-resource', operation: 'receipt', grant, intentId: intent.id, outcome: 'unknown' });
            return this.options.request({ action: 'host-resource', operation: 'receipt', grant, intentId: intent.id, outcome: receipt.outcome, etag: receipt.etag });
        });
    }
    export(grant: string, fence: {
        expectedRevision: number;
        documentGeneration: number;
    }) {
        return this.#serial(async () => {
            const epoch = this.#epoch;
            const result = await this.options.request({ action: 'host-resource', operation: 'export', grant, expectedRevision: fence.expectedRevision, generation: fence.documentGeneration });
            this.#assert(epoch);
            if (result.status !== 'host-save' || result.intent.purpose !== 'export' || result.intent.generation !== fence.documentGeneration || result.intent.revision !== fence.expectedRevision)
                throw Error('Reviewed export unavailable');
            const bytes = await this.#download(grant, result.intent, epoch);
            const filename = (this.#file?.name ?? 'review.pdf').replace(/[\\/\u0000-\u001f]/g, '_').replace(/\.pdf$/i, '') + '-reviewed.pdf';
            if (!this.options.downloadFile) throw Error('This host does not support PDF downloads. Your review is still protected.');
            const resultDownload = await this.options.downloadFile({ contents: [{ type: 'resource', resource: {
                uri: `file:///${encodeURIComponent(filename)}`, mimeType: 'application/pdf', blob: encode(bytes),
            } }] }, { timeout: 300000 });
            this.#assert(epoch);
            if (resultDownload.isError) return { kind: 'cancelled' as const };
            return { kind: 'reviewed-copy' as const, path: filename, revision: result.intent.revision, digest: result.intent.sha256, warning: 'The host accepted the reviewed-copy download. Verify the saved file before closing your protected review.' };
        });
    }
    async dispose() { this.#epoch++; for (const read of this.#reads) read.abort(); this.#reads.clear(); this.#unsubscribe?.(); this.#unsubscribe = undefined; const file = this.#file; this.#file = undefined; if (file && this.#subscribed)
        await this.options.resources()?.unsubscribe({ uri: file.resourceUri }).catch(() => undefined); }
}
