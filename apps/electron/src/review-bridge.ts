import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ElectronReviewHelperMessage, ElectronReviewHelperResponse, ElectronRuntimeProjection } from '../../../packages/core/src/electron-helper-protocol.js';
import { REVIEW_RUNTIME_PROTOCOL, REVIEW_RUNTIME_VERSION, isReviewRuntimeMethodForHost, sanitizeNativeReviewRuntimeRequest, sanitizeNativeReviewRuntimeResponse, type ReviewRuntimeMethod } from '../../../packages/core/src/review-runtime-protocol.js';
export function acceptsRenderer(binding: {
    frame: unknown;
    windowId: string;
    attemptId: string;
    retired: boolean;
}, frame: unknown, windowId: unknown, attemptId: unknown): boolean {
    return !binding.retired && binding.frame === frame && binding.windowId === windowId && binding.attemptId === attemptId;
}
type Operation = ElectronReviewHelperMessage extends infer M ? M extends ElectronReviewHelperMessage ? Omit<M, 'protocolVersion' | 'windowId' | 'attemptId' | 'requestId'> : never : never;
const MUTATING_METHODS = new Set<ReviewRuntimeMethod>([
    'command', 'beginInteraction', 'finalizeInteraction', 'releaseInteraction', 'acknowledgeInteraction',
    'chooseCopy', 'chooseFolder', 'chooseOriginal', 'retrySave', 'locateSave', 'exportReviewedCopy',
]);
export class ReviewBridge {
    readonly windowId = randomUUID();
    readonly attemptId = randomUUID();
    readonly helperId = randomUUID();
    retired = false;
    projection?: ElectronRuntimeProjection;
    resourceId?: string;
    validatedGeneration?: number;
    paintedGeneration?: number;
    readyGeneration?: number;
    active = false;
    pendingLaunchId?: string;
    private launchSequence = 0;
    constructor(readonly exchange: (message: ElectronReviewHelperMessage, signal?: AbortSignal) => Promise<ElectronReviewHelperResponse>, readonly documentUrl: (generation: number) => string) { }
    async send(operation: Operation, signal?: AbortSignal) {
        if (this.retired)
            throw new Error('Retired review');
        const result = await this.exchange({ ...operation, protocolVersion: 1, windowId: this.windowId, attemptId: this.attemptId, requestId: randomUUID() } as ElectronReviewHelperMessage, signal);
        if (this.retired)
            throw new Error('Retired review');
        if (result.type === 'failure')
            throw new Error(`Review ${result.code}`);
        if ('projection' in result)
            this.projection = result.projection;
        return result;
    }
    async admit(sourcePath: string, decide?: (offer: Extract<ElectronReviewHelperResponse, { type: 'recovery-offered' }>) => Promise<'resume' | 'discard' | 'fork'>, launchId?: string) {
        let result = await this.send(launchId ? { type: 'admit-launch', launchId } : { type: 'admit', sourcePath });
        if (result.type === 'recovery-offered' && decide) result = await this.send({ type: 'recover', decision: await decide(result), offer: result.offer, idempotencyKey: randomUUID() });
        if (result.type !== 'admitted')
            throw new Error('Recovery requires a native decision before review');
        this.resourceId = result.resourceId;
        if (launchId) this.pendingLaunchId = launchId;
    }
    async attachLaunch(launchId: string) {
        const sequence = ++this.launchSequence;
        const result = await this.send({ type: 'admit-launch', launchId });
        if (sequence !== this.launchSequence || result.type !== 'refreshed') throw new Error('Task launch was superseded');
        this.pendingLaunchId = launchId;
    }
    async activate() {
        if ((this.active && this.pendingLaunchId === undefined) || this.projection === undefined || this.validatedGeneration !== this.projection.generation || this.paintedGeneration !== this.projection.generation)
            return;
        const launchId = this.pendingLaunchId;
        await this.send({ type: 'activate', documentValidated: true, ...(launchId ? { launchId } : {}) });
        if (this.pendingLaunchId === launchId) delete this.pendingLaunchId;
        this.active = true;
    }
    chooseDestination?: (method: 'chooseFolder' | 'locateSave') => Promise<string | null>;
    onInvalidation?: (event: unknown) => void;
    onRefreshError?: (error: unknown) => void;
    private refreshTail = Promise.resolve();
    async settle(): Promise<void> { await Promise.all([...this.pendingRequests.values()]); await this.refreshTail; }
    private scheduleRefresh(): void {
        this.refreshTail = this.refreshTail.then(async () => {
            // Let IPC deliver the accepted operation receipt before invalidating its view.
            await new Promise<void>(resolve => setImmediate(resolve));
            if (this.retired) return;
            const previous = this.projection;
            await this.send({ type: 'refresh' });
            const next = this.projection;
            if (!previous || !next || isDeepStrictEqual(previous, next)) return;
            this.onInvalidation?.({
                protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION, kind: 'event',
                runtimeId: this.windowId, event: 'session-invalidated',
                payload: { sessionId: next.sessionId, generation: next.generation, revision: next.revision,
                    reason: next.generation !== previous.generation ? 'generation' : next.revision !== previous.revision ? 'revision' : 'freshness',
                    ...(next.generation === previous.generation ? {} : { previousGeneration: previous.generation }) },
            });
        }).catch(error => { if (!this.retired) this.onRefreshError?.(error); });
    }
    readonly pendingRequests = new Map<string, Promise<unknown>>();
    request(value: unknown): Promise<unknown> {
        const key = typeof value === 'object' && value !== null
            ? (value as Record<string, unknown>).requestId : undefined;
        if (typeof key !== 'string' || key.length > 128) return Promise.reject(new Error('Invalid request identity'));
        const existing = this.pendingRequests.get(key);
        if (existing) return existing;
        if (this.pendingRequests.size >= 64) return Promise.reject(new Error('Review request budget exceeded'));
        const pending = this.performRequest(value).finally(() => this.pendingRequests.delete(key));
        this.pendingRequests.set(key, pending);
        return pending;
    }
    private async performRequest(value: unknown): Promise<unknown> {
        if (typeof value !== 'object' || value === null)
            throw new Error('Invalid request');
        const v = value as Record<string, unknown>;
        if (v.protocol !== REVIEW_RUNTIME_PROTOCOL || v.version !== REVIEW_RUNTIME_VERSION || v.kind !== 'request' || v.runtimeId !== this.windowId || typeof v.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(v.requestId) || typeof v.method !== 'string' || !isReviewRuntimeMethodForHost('electron', v.method))
            throw new Error('Invalid request');
        const method = v.method as ReviewRuntimeMethod;
        const allowed = new Set(['protocol', 'version', 'kind', 'runtimeId', 'requestId', 'method', 'payload', 'sessionId', 'generation', 'revision']);
        if (Object.keys(v).some(key => !allowed.has(key)) || JSON.stringify(value).length > 4 * 1024 * 1024)
            throw new Error('Invalid request fields');
        const payload = sanitizeNativeReviewRuntimeRequest('electron', method, v.payload);
        if (payload === undefined)
            throw new Error('Invalid payload');
        let result: unknown;
        if (method === 'bootstrap') {
            await this.send({ type: 'refresh' });
            const p = this.projection!;
            result = { ...p, resources: { document: this.documentUrl(p.generation), pdfiumWasm: 'placekeeper-app://bundle/assets/pdfium.wasm', worker: 'placekeeper-app://bundle/assets/pdfium-worker.js' } };
        }
        else {
            if (!this.active)
                throw new Error('Review is not visibly active');
            if (method === 'presence') {
                await this.send({ type: 'keepalive' });
                result = {};
            }
            else if (method === 'detach') {
                result = {};
            }
            else {
                if (v.sessionId !== this.projection?.sessionId || !Number.isSafeInteger(v.generation) || !Number.isSafeInteger(v.revision))
                    throw new Error('Stale identity');
                const response = (method === 'chooseFolder' || method === 'locateSave') && this.chooseDestination
                    ? await this.send({ type: 'destination-selection', generation: v.generation as number, revision: v.revision as number, method, selectedPath: await this.chooseDestination(method), idempotencyKey: v.requestId })
                    : await this.send({ type: 'invoke', generation: v.generation as number, revision: v.revision as number, method, payload, idempotencyKey: v.requestId });
                if (response.type !== 'result')
                    throw new Error('Unexpected review result');
                result = response.payload;
            }
        }
        const clean = sanitizeNativeReviewRuntimeResponse('electron', method, result);
        if (clean === undefined)
            throw new Error('Invalid response');
        if (MUTATING_METHODS.has(method)) this.scheduleRefresh();
        return { protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION, kind: 'response', runtimeId: this.windowId, requestId: v.requestId, sessionId: this.projection!.sessionId, generation: method === 'bootstrap' ? this.projection!.generation : v.generation, revision: method === 'bootstrap' ? this.projection!.revision : v.revision, method, ok: true, payload: method === 'bootstrap' ? { ...(clean as object), capabilities: { interactionLifecycleVersion: 1 } } : clean };
    }
}
