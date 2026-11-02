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
const sourceBytes = Buffer.from("%PDF-1.7\n%%EOF");
const digest = createHash("sha256").update(sourceBytes).digest("hex");
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
    const runtime = createElectronHostRuntime({ identity: async () => identity, request: (_id, value) => bridge.request(value), documentReady: async () => { }, visible: async () => { }, subscribe: () => () => { } }, identity);
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
