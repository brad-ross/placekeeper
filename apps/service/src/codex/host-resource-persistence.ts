import { createHash, randomBytes } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HOST_RESOURCE_CHUNK_BYTES, HOST_RESOURCE_MAX_BYTES, type HostResourceFile, type HostResourceIntent, type HostResourceRequest, type HostResourceResult, parseHostResourceResult } from '../../../../packages/core/src/host-resource-protocol.js';
import { BrowserSourceStore } from '../browser/browser-source-store.js';
import { writePrivateFile, readPrivateFile, readPrivateFileRange } from '../platform/private-storage.js';
import { publishFile, stagePublication, syncPublishedFile } from '../platform/file-publication.js';
import type { SessionBroker } from '../sessions/session-broker.js';
import type { PdfSaveCoordinator } from '../saving/pdf-save-coordinator.js';
import type { OpenReviewResult } from '../sessions/session-contracts.js';
const secret = () => randomBytes(32).toString('base64url');
type Begin = Extract<HostResourceRequest, {
    operation: 'begin';
}>;
type Transfer = {
    input: Begin;
    path: string;
    handle: string;
    offset: number;
    expires: number;
    current: () => boolean;
    controller: AbortController;
    file?: HostResourceFile;
    sessionId?: string;
};
type HostState = {
    schemaVersion: 1;
    writable: boolean;
    etag?: string | undefined;
    digest: string;
    pending?: HostResourceIntent | undefined;
    outcome?: 'conflict' | 'unknown' | 'saved';
    lastReceipt?: {
        id: string;
        etag: string;
    };
    exported?: HostResourceIntent;
    forked?: true;
};
/** Private recovery state belongs to the canonical review, never to browser storage. */
export class HostResourcePersistence {
    readonly #transfers = new Map<string, Transfer>();
    #store: Promise<BrowserSourceStore> | undefined;
    constructor(readonly broker: SessionBroker, readonly saving: Pick<PdfSaveCoordinator, 'materializeImportedSave'>) { }
    async #sources() { return this.#store ??= BrowserSourceStore.create(join(this.broker.recoveryRoot, '.host-transfers')); }
    #directory(id: string) { return join(this.broker.recoveryRoot, id); }
    #statePath(id: string) { return join(this.#directory(id), 'host-resource.json'); }
    async state(id: string): Promise<HostState | undefined> { try {
        const value: unknown = JSON.parse((await readPrivateFile(this.#statePath(id), 16384)).toString());
        if (typeof value !== 'object' || value === null)
            throw Error('Host recovery state invalid');
        const state = value as HostState;
        if (state.schemaVersion !== 1 || typeof state.writable !== 'boolean' || !/^[a-f0-9]{64}$/.test(state.digest) || state.etag !== undefined && (typeof state.etag !== 'string' || state.etag.length === 0 || state.etag.length > 4096) || state.pending !== undefined && (!parseHostResourceResult({ status: 'host-save', intent: state.pending }) || state.pending.purpose !== 'save') || state.exported !== undefined && (!parseHostResourceResult({ status: 'host-save', intent: state.exported }) || state.exported.purpose !== 'export') || state.outcome !== undefined && !['saved', 'conflict', 'unknown'].includes(state.outcome) || state.forked !== undefined && state.forked !== true)
            throw Error('Host recovery state invalid');
        return state;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return;
        throw error;
    } }
    async #persist(id: string, state: HostState) { const target = this.#statePath(id), temporary = await stagePublication(target, Buffer.from(JSON.stringify(state))); try {
        await syncPublishedFile(await publishFile(temporary, target));
    }
    finally {
        await rm(temporary, { force: true });
    } }
    async begin(input: Begin, context: {
        file?: HostResourceFile;
        sessionId?: string;
        current: () => boolean;
    }): Promise<HostResourceResult> {
        await this.sweep();
        if (this.#transfers.size >= 4 || !context.current())
            throw Error('Host transfer unavailable');
        if (context.sessionId && !await this.state(context.sessionId))
            throw Error('Host source unavailable');
        const sources = await this.#sources(), handle = randomBytes(24).toString('base64url'), path = join(sources.root, `${handle}.pdf`);
        await writePrivateFile(path, new Uint8Array());
        if (!context.current()) {
            await rm(path, { force: true });
            throw Error('Host authority retired');
        }
        const transfer = secret();
        this.#transfers.set(transfer, { input, path, handle, offset: 0, expires: Date.now() + 120000, controller: new AbortController(), ...context });
        return { status: 'host-transfer', transfer, offset: 0 };
    }
    async chunk(transfer: string, offset: number, dataBase64: string): Promise<HostResourceResult> {
        const t = this.#transfers.get(transfer);
        if (!t || !t.current() || t.expires <= Date.now())
            throw Error('Host transfer expired');
        const bytes = Buffer.from(dataBase64, 'base64');
        if (offset !== t.offset || bytes.length === 0 || bytes.length > HOST_RESOURCE_CHUNK_BYTES || offset + bytes.length > t.input.byteLength)
            throw Error('Host transfer out of bounds');
        const ranged = await open(t.path, 'r+');
        try {
            let written = 0;
            while (written < bytes.length) {
                const result = await ranged.write(bytes, written, bytes.length - written, offset + written);
                if (result.bytesWritten === 0)
                    throw Error('Host transfer made no progress');
                written += result.bytesWritten;
            }
            await ranged.sync();
        }
        finally {
            await ranged.close();
        }
        if (!t.current())
            throw Error('Host authority retired');
        t.offset += bytes.length;
        return { status: 'host-transfer', transfer, offset: t.offset };
    }
    async cancel(transfer: string) { const t = this.#transfers.get(transfer); this.#transfers.delete(transfer); if (t) {
        t.controller.abort();
        await rm(t.path, { force: true });
    } }
    async finish(transfer: string): Promise<{
        opened: OpenReviewResult;
    } | HostResourceResult> {
        const t = this.#transfers.get(transfer);
        if (!t || !t.current() || t.offset !== t.input.byteLength)
            throw Error('Host transfer incomplete');
        try {
            const bytes = await readPrivateFile(t.path, HOST_RESOURCE_MAX_BYTES);
            if (bytes.length !== t.input.byteLength || createHash('sha256').update(bytes).digest('hex') !== t.input.sha256 || bytes.subarray(0, 5).toString() !== '%PDF-')
                throw Error('Host PDF integrity failed');
            if (!t.current())
                throw Error('Host authority retired');
            const sources = await this.#sources();
            if (!t.current())
                throw Error('Host authority retired');
            const request = { protocolVersion: 2 as const, sourceHandle: t.handle, byteLength: bytes.length, sha256: t.input.sha256, ...(t.file ? { displayName: t.file.name, sourceIdentity: createHash('sha256').update(t.file.resourceUri).digest('hex') } : { sourceIdentity: createHash('sha256').update(t.sessionId!).digest('hex') }) };
            if (t.sessionId) {
                const previous = await this.state(t.sessionId);
                if (!t.current())
                    throw Error('Host authority retired');
                if (!previous)
                    throw Error('Host source unavailable');
                let classifiedNotSaved = false;
                let retiredIntentId: string | undefined;
                if (this.broker.saveStatus(t.sessionId)?.destination.phase !== 'host') {
                    retiredIntentId = previous.pending?.id;
                    delete previous.pending;
                    delete previous.outcome;
                }
                if (previous.pending) {
                    if (previous.pending.sha256 === t.input.sha256 && t.input.etag) {
                        const writable = previous.forked !== true && t.input.writable;
                        await this.#ack(t.sessionId, { ...previous, writable }, previous.pending, t.input.etag, () => { if (!t.current()) throw Error('Host authority retired'); });
                        await this.broker.configureImportedDestination(t.sessionId, writable, () => { if (!t.current()) throw Error('Host authority retired'); });
                        return { status: 'host-ready', generation: this.broker.state(t.sessionId)!.workflow.documentGeneration };
                    }
                    // An uncertain write is classified by rereading before any retry can be created.
                    if (previous.outcome === 'unknown' && previous.digest === t.input.sha256) {
                        retiredIntentId = previous.pending.id;
                        delete previous.pending;
                        delete previous.outcome;
                        classifiedNotSaved = true;
                    }
                    else if (previous.digest !== t.input.sha256) {
                        previous.outcome = 'conflict';
                        await this.#persist(t.sessionId, previous);
                        await this.broker.markImportedSaveState(t.sessionId, 'host-conflict', () => { if (!t.current()) throw Error('Host authority retired'); });
                        return { status: 'host-status', outcome: 'conflict' };
                    }
                }
                if (previous.digest !== t.input.sha256) {
                    const replaced = await this.broker.refreshImportedSource(t.sessionId, request, sources, () => { if (!t.current())
                        throw Error('Host authority retired'); });
                    if (replaced.status !== 'committed' && replaced.status !== 'same-digest')
                        throw Error('Host generation not accepted');
                }
                if (!t.current()) throw Error('Host authority retired');
                await this.#persist(t.sessionId, { ...previous, writable: previous.forked !== true && t.input.writable, ...(t.input.etag ? { etag: t.input.etag } : { etag: undefined }), digest: t.input.sha256 });
                if (retiredIntentId) await rm(join(this.#directory(t.sessionId), `host-save-${retiredIntentId}.pdf`), { force: true });
                await this.broker.configureImportedDestination(t.sessionId, previous.forked !== true && t.input.writable && !!t.input.etag, () => { if (!t.current()) throw Error('Host authority retired'); });
                if (classifiedNotSaved)
                    await this.broker.markImportedSaveState(t.sessionId, 'write-failed');
                return { status: 'host-ready', generation: this.broker.state(t.sessionId)!.workflow.documentGeneration };
            }
            const opened = await this.broker.openHostResourceSource(request, sources, t.controller.signal);
            if (opened.kind === 'opened') {
                try {
                    if (!t.current())
                        throw Error('Host authority retired');
                    await this.#persist(opened.launch.sessionId, { schemaVersion: 1, writable: t.input.writable, ...(t.input.etag ? { etag: t.input.etag } : {}), digest: t.input.sha256 });
                    await this.broker.configureImportedDestination(opened.launch.sessionId, t.input.writable && !!t.input.etag);
                    await this.broker.protectChromeReview(opened.launch.sessionId);
                    if (!t.current())
                        throw Error('Host authority retired');
                }
                catch (error) {
                    await this.broker.discard(opened.launch.sessionId);
                    throw error;
                }
            }
            return { opened };
        }
        finally {
            this.#transfers.delete(transfer);
            await rm(t.path, { force: true });
        }
    }
    async fork(id: string): Promise<OpenReviewResult> {
        const state = await this.state(id), activeBytes = await this.broker.documentBytes(id), scope = await this.broker.sessionScope(id);
        const recoveryPath = activeBytes ? undefined : await this.broker.importedRecoveryPath(id);
        const bytes = activeBytes ?? (recoveryPath ? await readPrivateFile(recoveryPath, HOST_RESOURCE_MAX_BYTES) : undefined);
        if (!state || !bytes)
            throw Error('Host source unavailable');
        const sources = await this.#sources(), handle = randomBytes(24).toString('base64url'), path = join(sources.root, `${handle}.pdf`);
        try {
            await writePrivateFile(path, bytes);
            const digest = createHash('sha256').update(bytes).digest('hex');
            const opened = await this.broker.openHostResourceSource({ protocolVersion: 1, sourceHandle: handle, displayName: scope?.sourceDisplayName ?? 'Independent review.pdf', byteLength: bytes.length, sha256: digest }, sources);
            if (opened.kind !== 'opened')
                throw Error('Independent host review unavailable');
            await this.#persist(opened.launch.sessionId, { schemaVersion: 1, writable: false, digest, forked: true });
            await this.broker.configureImportedDestination(opened.launch.sessionId, false);
            await this.broker.protectChromeReview(opened.launch.sessionId);
            return opened;
        }
        finally {
            await rm(path, { force: true });
        }
    }
    async status(id: string): Promise<HostResourceResult> {
        const state = await this.state(id);
        if (!state)
            throw Error('Host source unavailable');
        if (this.broker.saveStatus(id)?.destination.phase === 'active') return { status: 'host-status', outcome: 'local-copy' };
        if (this.broker.saveStatus(id)?.sync.phase === 'clean')
            return { status: 'host-status', outcome: 'saved' };
        if (!state.writable || !state.etag)
            return { status: 'host-status', outcome: 'read-only' };
        return { status: 'host-status', outcome: state.outcome === 'conflict' || state.outcome === 'unknown' ? state.outcome : 'protected' };
    }
    async save(id: string, assertAuthority: () => void = () => undefined): Promise<HostResourceResult> {
        const state = await this.state(id);
        if (!state)
            throw Error('Host source unavailable');
        if (this.broker.saveStatus(id)?.destination.phase !== 'host') return this.status(id);
        if (!state.writable || !state.etag) {
            await this.broker.markImportedSaveState(id, 'host-read-only', assertAuthority);
            return { status: 'host-status', outcome: 'read-only' };
        }
        if (state.outcome === 'conflict' || state.outcome === 'unknown')
            return { status: 'host-status', outcome: state.outcome };
        if (state.pending)
            return { status: 'host-save', intent: state.pending };
        if (this.broker.saveStatus(id)?.sync.phase === 'clean')
            return { status: 'host-status', outcome: 'saved' };
        assertAuthority();
        const materialized = await this.saving.materializeImportedSave(id), delivery = materialized.delivery;
        assertAuthority();
        if (materialized.bytes.length === 0 || materialized.bytes.length > HOST_RESOURCE_MAX_BYTES)
            throw Error('Host save too large');
        if (this.broker.saveStatus(id)?.destination.phase !== 'host') return this.status(id);
        const current = this.broker.nativeAdmissionScope(id);
        if (current?.documentGeneration !== delivery.documentGeneration || current.sourceDigest !== delivery.source.digest)
            throw Error('Host save generation changed');
        const intent: HostResourceIntent = { id: secret(), generation: delivery.documentGeneration, revision: delivery.revision, stateDigest: delivery.stateDigest!, sourceDigest: delivery.source.digest, sha256: materialized.sha256, byteLength: materialized.bytes.length, ifMatch: state.etag, purpose: 'save' };
        // Bytes and the exact intent are durable before the host receives write authority.
        await writePrivateFile(join(this.#directory(id), `host-save-${intent.id}.pdf`), materialized.bytes);
        assertAuthority();
        await this.#persist(id, { ...state, pending: intent, outcome: 'unknown' });
        await this.broker.configureImportedDestination(id, true, assertAuthority);
        if (this.broker.saveStatus(id)?.destination.phase !== 'host') return this.status(id);
        return { status: 'host-save', intent };
    }
    async export(id: string, expectedRevision: number, generation: number, assertAuthority: () => void = () => undefined): Promise<HostResourceResult> {
        const state = await this.state(id);
        if (!state)
            throw Error('Host source unavailable');
        assertAuthority();
        const materialized = await this.saving.materializeImportedSave(id, { expectedRevision, documentGeneration: generation }), delivery = materialized.delivery;
        assertAuthority();
        if (materialized.bytes.length === 0 || materialized.bytes.length > HOST_RESOURCE_MAX_BYTES)
            throw Error('Host export too large');
        if (!this.broker.isFrozenDeliveryCurrent(delivery))
            throw Error('Export generation changed');
        const intent: HostResourceIntent = { id: secret(), generation: delivery.documentGeneration, revision: delivery.revision, stateDigest: delivery.stateDigest!, sourceDigest: delivery.source.digest, sha256: materialized.sha256, byteLength: materialized.bytes.length, ifMatch: '', purpose: 'export' };
        await writePrivateFile(join(this.#directory(id), `host-save-${intent.id}.pdf`), materialized.bytes);
        assertAuthority();
        await this.#persist(id, { ...state, exported: intent });
        if (state.exported)
            await rm(join(this.#directory(id), `host-save-${state.exported.id}.pdf`), { force: true });
        return { status: 'host-save', intent };
    }
    async saveChunk(id: string, intentId: string, offset: number): Promise<HostResourceResult> {
        const state = await this.state(id), intent = state?.pending?.id === intentId ? state.pending : state?.exported;
        if (!intent || intent.id !== intentId || offset >= intent.byteLength || intent.purpose === 'save' && this.broker.saveStatus(id)?.destination.phase !== 'host')
            throw Error('Host intent unavailable');
        const { bytes, fileSize } = await readPrivateFileRange(join(this.#directory(id), `host-save-${intent.id}.pdf`), HOST_RESOURCE_MAX_BYTES, offset, HOST_RESOURCE_CHUNK_BYTES);
        return { status: 'host-chunk', dataBase64: bytes.toString('base64'), done: offset + bytes.length === fileSize };
    }
    async #ack(id: string, state: HostState, intent: HostResourceIntent, etag: string, assertAuthority: () => void = () => undefined) {
        const accepted = await this.broker.acknowledgeImportedSave({ sessionId: id, documentGeneration: intent.generation, sourceDigest: intent.sourceDigest, revision: intent.revision, stateDigest: intent.stateDigest, assertAuthority });
        if (!accepted)
            throw Error('Host save generation retired');
        await this.#persist(id, { ...state, etag, digest: intent.sha256, pending: undefined, outcome: 'saved', lastReceipt: { id: intent.id, etag } });
        await rm(join(this.#directory(id), `host-save-${intent.id}.pdf`), { force: true });
    }
    async receipt(id: string, intentId: string, outcome: 'saved' | 'conflict' | 'unknown', etag?: string, assertAuthority: () => void = () => undefined): Promise<HostResourceResult> {
        const state = await this.state(id), intent = state?.pending;
        assertAuthority();
        if (this.broker.saveStatus(id)?.destination.phase !== 'host') throw Error('Host save destination retired');
        if (state?.lastReceipt?.id === intentId && outcome === 'saved' && state.lastReceipt.etag === etag)
            return { status: 'host-status', outcome: 'saved' };
        if (!state || !intent || intent.id !== intentId)
            throw Error('Host intent unavailable');
        if (outcome === 'saved' && etag)
            await this.#ack(id, state, intent, etag, assertAuthority);
        else {
            await this.#persist(id, { ...state, outcome: outcome === 'saved' ? 'unknown' : outcome });
            await this.broker.markImportedSaveState(id, outcome === 'conflict' ? 'host-conflict' : 'host-write-unknown', assertAuthority);
        }
        return { status: 'host-status', outcome };
    }
    async sweep() { for (const [token, t] of this.#transfers)
        if (t.expires <= Date.now() || !t.current())
            await this.cancel(token); }
    async close() { for (const token of this.#transfers.keys())
        await this.cancel(token); }
}
