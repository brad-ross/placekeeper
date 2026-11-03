import assert from 'node:assert/strict';
import { it as test } from 'vitest';
import { acceptsRenderer } from '../src/review-bridge.js';
test('only exact current main frame, window and attempt can act', () => {
    const frame = {};
    const binding = { frame, windowId: 'window123', attemptId: 'attempt123', retired: false };
    assert.equal(acceptsRenderer(binding, frame, 'window123', 'attempt123'), true);
    assert.equal(acceptsRenderer(binding, {}, 'window123', 'attempt123'), false);
    assert.equal(acceptsRenderer(binding, frame, 'window123', 'oldattempt'), false);
    assert.equal(acceptsRenderer({ ...binding, retired: true }, frame, 'window123', 'attempt123'), false);
});
import { createElectronHostRuntime } from "../../web/src/host/electron-runtime.js";
import { ReviewBridge } from "../src/review-bridge.js";
import { createHash } from "node:crypto";
import { createReviewState, type PendingReviewDraftV1, type ReviewCommand } from '../../../packages/core/src/review-model.js';
import { reduceReview } from '../../../packages/core/src/review-reducer.js';
import { ReviewInteractions } from '../../service/src/sessions/review-interactions.js';
import { beginReviewInteraction, authoringAuthorityFor, authoringSessionIsCurrent } from '../../web/src/review/authoring-session.js';
import { releaseDeletedAuthoringInteraction } from '../../web/src/review/use-authoring-session.js';
const sourceBytes = Buffer.from("%PDF-1.7\n%%EOF");
const digest = createHash("sha256").update(sourceBytes).digest("hex");

test('ordinary Electron refresh cannot reacquire or roll back a protected editor while its command is accepted', async () => {
    const initial = projection();
    let state = createReviewState({ sessionId: initial.sessionId, source: initial.state.source, documentGeneration: 2 });
    const interactions = new ReviewInteractions({ currentGeneration: () => state.workflow.documentGeneration });
    const attachment = interactions.register(state.sessionId, 'electron-test');
    const canonical = () => ({ ...projection(state.revision),
        activeAuthoringDraftIds: interactions.activeAuthoringClaims(state.sessionId)
            .filter(claim => claim.generation === state.workflow.documentGeneration).map(claim => claim.draftId),
        generation: state.workflow.documentGeneration, state,
        document: { ...initial.document, generation: state.workflow.documentGeneration } });
    const bridge = new ReviewBridge(async message => {
        if (message.type === 'refresh') return { ...message, type: 'refreshed', projection: canonical() };
        if (message.type !== 'invoke') throw new Error('Unexpected helper operation');
        if (message.generation !== state.workflow.documentGeneration || message.revision !== state.revision) throw new Error('Stale native revision');
        let payload: unknown;
        if (message.method === 'command') {
            state = reduceReview(state, message.payload as ReviewCommand);
            payload = state;
        } else if (message.method === 'beginInteraction') {
            payload = await interactions.begin({ ...attachment,
                ...(message.payload as { interactionToken: string; order: number; generation: number; draftId?: string }) });
        } else if (message.method === 'releaseInteraction') {
            payload = await interactions.release({ ...attachment, ...(message.payload as { interactionToken: string; order: number }) });
        } else payload = canonical().saveStatus;
        return { ...message, type: 'result', method: message.method, payload };
    }, generation => `placekeeper-resource://document/attempt123/${generation}`);
    bridge.projection = canonical(); bridge.active = true;
    const identity = { windowId: bridge.windowId, attemptId: bridge.attemptId };
    let delayedBootstrap = false;
    const captured = Promise.withResolvers<void>(), deliver = Promise.withResolvers<void>();
    const runtime = createElectronHostRuntime({ identity: async () => identity,
        request: async (_id, value) => {
            const response = await bridge.request(value);
            if (delayedBootstrap && (value as { method: string }).method === 'bootstrap') {
                delayedBootstrap = false; captured.resolve(); await deliver.promise;
            }
            return response;
        }, requestClose: async () => {}, readyToSettle: async () => {}, documentReady: async () => {}, visible: async () => {},
        commandSurface: async () => {}, presentation: async () => {}, toolbarHeight: async () => {}, closeSettled: async () => {}, writeClipboard: async () => {},
        createLink: async () => 'placekeeper:///paper.pdf#page=1', focusFailed: async () => {}, subscribeShell: () => () => {}, subscribe: () => () => {},
    }, identity);
    try {
        await runtime.bootstrap();
        const lifecycle = { beginInteraction: runtime.beginInteraction!, finalizeInteraction: runtime.finalizeInteraction!,
            releaseInteraction: runtime.releaseInteraction!, acknowledgeInteraction: runtime.acknowledgeInteraction! };
        const draftId = 'bdb2a067-72f2-4fb2-85d0-2cc67bf50274';
        const editor = await beginReviewInteraction(lifecycle, 2, 'editor_interaction', 1, draftId);
        const authority = authoringAuthorityFor(state, 2);
        let editorOpen = true, reconnects = 0;
        runtime.subscribeInteractionReconnect?.(async () => {
            reconnects++;
            try { await editor.reacquire(); }
            catch { await releaseDeletedAuthoringInteraction(editor, () => { editorOpen = false; }); }
        });
        delayedBootstrap = true;
        const refresh = runtime.bootstrap();
        void refresh.catch(() => undefined);
        await captured.promise;
        const draft: PendingReviewDraftV1 = { id: draftId, ownerViewId: attachment.attachmentId,
            baseGeneration: 2, revision: 0, kind: 'pageNote', pageIndex: 0, text: 'Exact text typed after source refresh.',
            anchor: { kind: 'page', pageIndex: 0, rect: { x: 72, y: 72, width: 18, height: 18 } },
            disposition: { kind: 'resolved', generation: 2 }, status: 'protected',
            createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z' };
        await runtime.command({ type: 'put-draft', expectedRevision: 0, expectedDraftRevision: -1, draft });
        await bridge.settle();
        deliver.resolve();
        const refreshFailure = await refresh.then(() => undefined, error => error as Error);
        assert.equal(editorOpen, true);
        assert.equal(refreshFailure?.name, 'AbortError');
        assert.equal(interactions.held(state.sessionId), true);
        assert.equal(state.pendingDrafts[0]?.text, draft.text);
        await runtime.bootstrap();
        assert.equal(reconnects, 0);
        await runtime.saveStatus();
        assert.equal(authoringSessionIsCurrent({ authority }, authoringAuthorityFor(state, 2)), true);
        state = { ...state, workflow: { ...state.workflow, documentGeneration: 3 } };
        await runtime.bootstrap();
        assert.equal(authoringSessionIsCurrent({ authority }, authoringAuthorityFor(state, 3)), false);
        await assert.rejects(beginReviewInteraction(lifecycle, 2, 'stale_interaction', 2));
    } finally { deliver.resolve(); runtime.dispose(); bridge.retired = true; }
});
function projection(revision = 0) {
    const sessionId = "779e1d9d-58c1-4b12-8dc2-3449dad132c1";
    return {
        sessionId,
        generation: 1,
        revision,
        state: {
            schemaVersion: 2,
            sessionId,
            source: {
                fileId: "c0e41526-1320-4dec-b802-3c17617c0320",
                digest,
                byteLength: sourceBytes.byteLength,
            },
            revision,
            lifecycle: "active",
            items: [],
            workflow: {
                schemaVersion: 1,
                mode: "standard",
                documentRole: "source-pdf",
                documentGeneration: 1,
                freshness: "current",
                historyBoundary: 0,
            },
            pendingDrafts: [],
            discardAudit: [],
            history: [],
            historyCursor: 0,
        },
        scope: {
            documentTitle: "Paper.pdf",
            sourceDisposition: "local",
            sourceDisplayName: "Paper.pdf",
            launchSurface: "macos",
            sourceRootPath: "/must/not/cross",
        },
        saveStatus: {
            destination: { phase: "none", generation: 0 },
            sync: { phase: "clean", desiredRevision: revision, savedRevision: revision },
        },
        canonicalLinkBase: "placekeeper:///Papers/Paper.pdf",
        protected: false,
        location: { kind: "page", page: 1 },
        document: { sha256: digest, byteLength: sourceBytes.byteLength, generation: 1 },
    };
}
test('real RPC renderer client bootstraps through bridge and rejects bounded transport failures', async () => {
    const p = { ...projection(), activeAuthoringDraftIds: [] };
    const bridge = new ReviewBridge(async (message) => (message.type === 'invoke' ? { ...message, type: 'result', method: message.method, payload: p.saveStatus } : { ...message, type: 'refreshed', projection: p }), generation => `placekeeper-resource://document/attempt123/${generation}`);
    bridge.projection = p;
    const identity = { windowId: bridge.windowId, attemptId: bridge.attemptId };
    const runtime = createElectronHostRuntime({ identity: async () => identity, request: (_id, value) => bridge.request(value), requestClose: async () => {}, readyToSettle: async () => {}, documentReady: async () => { }, visible: async () => { }, commandSurface: async () => {}, presentation: async () => {}, toolbarHeight: async () => {}, closeSettled: async () => {}, writeClipboard: async () => {}, createLink: async () => 'placekeeper:///paper.pdf#page=1', focusFailed: async () => {}, subscribeShell: () => () => {}, subscribe: () => () => { } }, identity);
    const bootstrap = await runtime.bootstrap();
    assert.equal(bootstrap.sessionId, p.sessionId);
    assert.equal(bootstrap.scope.launchSurface, 'electron');
    assert.equal('sourceRootPath' in bootstrap.scope, false);
    await assert.rejects(runtime.saveStatus());
    bridge.active = true;
    assert.deepEqual(await runtime.saveStatus(), p.saveStatus);
    const refreshed = await runtime.bootstrap();
    assert.equal(refreshed.revision, p.revision);
    runtime.dispose();
});
import { documentResponse } from '../src/resource-protocol.js';
test('document stream verifies length and digest before adoption and rejects stale generations', async () => {
    const p = { ...projection(), activeAuthoringDraftIds: [] };
    let adopted = false;
    const bridge = new ReviewBridge(async (message) => {
        if (message.type === 'read-resource')
            return { ...message, type: 'resource-bytes', sequence: 0, data: sourceBytes.toString('base64'), done: true };
        if (message.type === 'adopt-resource') {
            adopted = true;
            return { ...message, type: 'resource-adopted', generation: 1 };
        }
        throw new Error('Unexpected action');
    }, () => 'unused');
    bridge.projection = p;
    bridge.resourceId = 'resource123';
    assert.equal(documentResponse(bridge, 2).status, 404);
    assert.deepEqual(Buffer.from(await documentResponse(bridge, 1).arrayBuffer()), sourceBytes);
    assert.equal(adopted, true);
    assert.equal(bridge.validatedGeneration, 1);
    assert.equal(bridge.active, false);
    adopted = false;
    bridge.projection = { ...p, document: { ...p.document, sha256: '0'.repeat(64) } };
    await assert.rejects(documentResponse(bridge, 1).arrayBuffer());
    assert.equal(adopted, false);
});
test('recovery admission requires a native choice and keeps the current offer fence', async () => {
    const p = { ...projection(), activeAuthoringDraftIds: [] };
    const offer = { id: 'offer12345678', expiresAt: new Date(Date.now() + 10000).toISOString() };
    const bridge = new ReviewBridge(async message => {
        if (message.type === 'admit') return { ...message, type: 'recovery-offered', choices: ['resume', 'discard', 'fork'], offer };
        assert.equal(message.type, 'recover');
        if (message.type !== 'recover') throw new Error('Unexpected operation');
        assert.deepEqual(message.offer, offer); assert.equal(message.decision, 'resume');
        return { ...message, type: 'admitted', provisionalId: 'provisional123', resourceId: 'resource123', generation: 1, byteLength: sourceBytes.length, digest, displayName: 'Paper.pdf', projection: p };
    }, () => 'unused');
    await bridge.admit('/paper.pdf', async () => 'resume');
    assert.equal(bridge.projection, p);
    assert.equal(bridge.resourceId, 'resource123');
});
test('native destination dialog captures the invoking generation and revision before waiting', async () => {
    const p = { ...projection(), activeAuthoringDraftIds: [] };
    const bridge = new ReviewBridge(async message => {
        assert.equal(message.type, 'destination-selection');
        if (message.type !== 'destination-selection') throw new Error('Unexpected operation');
        assert.equal(message.generation, 1); assert.equal(message.revision, 0); assert.equal(message.selectedPath, '/chosen');
        return { ...message, type: 'result', method: message.method, payload: { canceled: true } };
    }, () => 'unused');
    bridge.projection = p; bridge.active = true;
    let resolveDialog!: (path: string) => void;
    bridge.chooseDestination = () => new Promise(resolve => { resolveDialog = resolve; });
    const pending = bridge.request({ protocol: 'placekeeper.review-runtime', version: 4, kind: 'request', runtimeId: bridge.windowId, requestId: 'request1234567890', method: 'chooseFolder', payload: {}, sessionId: p.sessionId, generation: 1, revision: 0 });
    let settled = false; const closing = bridge.settle().then(() => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    bridge.projection = { ...p, revision: 1 };
    resolveDialog('/chosen');
    // The mocked payload can be rejected by the public result sanitizer; either
    // way close waits for this request rather than retiring it during the dialog.
    await pending.catch(() => undefined); await closing.catch(() => undefined);
    assert.equal(bridge.pendingRequests.size, 0);
});
test('focused task attachment keeps resources and emits exact launch identity on fresh activation', async () => {
    const p = { ...projection(), activeAuthoringDraftIds: [] };
    const launchId = 'a'.repeat(43);
    const operations: unknown[] = [];
    const bridge = new ReviewBridge(async message => {
        operations.push(message);
        return { ...message, type: message.type === 'activate' ? 'active' : 'refreshed', projection: p };
    }, () => 'unused');
    bridge.projection = p; bridge.active = true;
    bridge.resourceId = 'retained-resource'; bridge.validatedGeneration = 1; bridge.paintedGeneration = 1;
    await bridge.attachLaunch(launchId);
    await bridge.activate();
    assert.equal(bridge.resourceId, 'retained-resource');
    assert.equal(bridge.pendingLaunchId, undefined);
    assert.equal((operations[1] as { launchId: string }).launchId, launchId);
});

test('discarded interaction publishes its canonical revision after the receipt without a save event', async () => {
    const initial = { ...projection(), activeAuthoringDraftIds: ['draft_cancel_1234'] };
    const next = { ...projection(1), activeAuthoringDraftIds: [] };
    const delivery: string[] = [];
    const events: unknown[] = [];
    const bridge = new ReviewBridge(async message => {
        if (message.type === 'refresh') return { ...message, type: 'refreshed', projection: next };
        assert.equal(message.type, 'invoke');
        if (message.type !== 'invoke') throw new Error('Unexpected operation');
        assert.equal(message.method, 'finalizeInteraction');
        return { ...message, type: 'result', method: message.method, payload: {
            status: 'finalized', interactionToken: 'interaction_cancel_1234', generation: 1,
            outcome: 'discarded', reviewRevision: 1,
        } };
    }, () => 'unused');
    bridge.projection = initial; bridge.active = true;
    bridge.onInvalidation = event => { delivery.push('invalidation'); events.push(event); };
    const receipt = await bridge.request({ protocol: 'placekeeper.review-runtime', version: 4,
        kind: 'request', runtimeId: bridge.windowId, requestId: 'cancel_request_1234',
        sessionId: initial.sessionId, generation: 1, revision: 0, method: 'finalizeInteraction',
        payload: { interactionToken: 'interaction_cancel_1234', order: 2, outcome: 'discarded',
            draftId: 'draft_cancel_1234', expectedDraftRevision: 0 } });
    delivery.push('receipt');
    assert.equal((receipt as { payload: { reviewRevision: number } }).payload.reviewRevision, 1);
    assert.deepEqual(delivery, ['receipt']);
    await bridge.settle();
    assert.deepEqual(delivery, ['receipt', 'invalidation']);
    assert.equal(bridge.projection, next);
    assert.deepEqual(events, [{ protocol: 'placekeeper.review-runtime', version: 4, kind: 'event',
        runtimeId: bridge.windowId, event: 'session-invalidated',
        payload: { sessionId: initial.sessionId, generation: 1, revision: 1, reason: 'revision' } }]);
});

test('interaction release publishes same-revision authoring changes and ignores retired refreshes', async () => {
    const initial = { ...projection(), activeAuthoringDraftIds: ['draft_cancel_1234'] };
    const next = { ...initial, activeAuthoringDraftIds: [] };
    const events: unknown[] = [];
    let refreshes = 0;
    const bridge = new ReviewBridge(async message => {
        if (message.type === 'refresh') { refreshes++; return { ...message, type: 'refreshed', projection: next }; }
        if (message.type !== 'invoke') throw new Error('Unexpected operation');
        return { ...message, type: 'result', method: message.method, payload: { status: 'released' } };
    }, () => 'unused');
    bridge.projection = initial; bridge.active = true; bridge.onInvalidation = event => events.push(event);
    const request = { protocol: 'placekeeper.review-runtime', version: 4, kind: 'request',
        runtimeId: bridge.windowId, requestId: 'release_request_1234', sessionId: initial.sessionId,
        generation: 1, revision: 0, method: 'releaseInteraction', payload: { interactionToken: 'interaction_cancel_1234', order: 3 } };
    await bridge.request(request); await bridge.settle();
    assert.equal((events[0] as { payload: { reason: string } }).payload.reason, 'freshness');
    await bridge.request({ ...request, requestId: 'release_request_5678' });
    bridge.retired = true;
    await bridge.settle();
    assert.equal(refreshes, 1); assert.equal(events.length, 1);
});
