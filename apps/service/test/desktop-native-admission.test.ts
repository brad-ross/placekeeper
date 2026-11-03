import { it, expect, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDesktopIsolatedRoot } from '../../../test/support/desktop-isolated-root.js';
import { startServiceDaemon } from '../src/host/service-daemon.js';
import { requestControl } from '../src/host/launch-control.js';
import { validElectronReviewHelperResponse } from '../../../packages/core/src/electron-helper-protocol.js';
import { ChromeTransferStore } from '../src/browser/chrome-handoff.js';
import { lifecycleDiagnostic } from '../src/desktop/lifecycle-control-command.js';
import { decodePlacekeeperLink } from '../../../packages/core/src/placekeeper-link.js';

it('admits and activates a real native document through the private daemon, then creates its link without disclosing paths', async () => {
    const root = await createDesktopIsolatedRoot();
    const stages: unknown[] = [];
    let daemon: Awaited<ReturnType<typeof startServiceDaemon>> | undefined;
    try {
        const source = join(root, 'Review with spaces.pdf');
        await copyFile(resolve('test/fixtures/pdfs/text-native.pdf'), source);
        const bytes = await readFile(source);
        const assets = join(root, 'web'); await mkdir(assets); await writeFile(join(assets, 'app.js'), 'export function start(){}');
        const socket = join(root, 'control.sock');
        daemon = await startServiceDaemon({ appSupportRoot: root, recoveryRoot: join(root, 'recovery'), socketPath: socket,
            webAssetsRoot: assets, isolatedTestRoot: root, httpPort: 0 });
        // Observe actual methods without replacing their work. If the helper
        // returns an opaque failure, CI still identifies the failing boundary.
        const canonicalize = ChromeTransferStore.prototype.canonicalizeLocal;
        vi.spyOn(ChromeTransferStore.prototype, 'canonicalizeLocal').mockImplementation(async function(this: ChromeTransferStore, url) {
            stages.push('canonicalize-local');
            try { const result = await canonicalize.call(this, url); stages.push('canonicalize-local-complete'); return result; }
            catch (error) { stages.push(lifecycleDiagnostic('canonicalize-local', error)); throw error; }
        });
        const openReview = daemon.host.broker.openReview.bind(daemon.host.broker);
        vi.spyOn(daemon.host.broker, 'openReview').mockImplementation(async request => {
            stages.push('open-review');
            try { const result = await openReview(request); stages.push('open-review-complete'); return result; }
            catch (error) { stages.push(lifecycleDiagnostic('open-review', error)); throw error; }
        });
        const canonicalLink = daemon.host.broker.canonicalLinkBase.bind(daemon.host.broker);
        vi.spyOn(daemon.host.broker, 'canonicalLinkBase').mockImplementation(sessionId => {
            stages.push('canonical-link');
            try { const result = canonicalLink(sessionId); stages.push('canonical-link-complete'); return result; }
            catch (error) { stages.push(lifecycleDiagnostic('canonical-link', error)); throw error; }
        });
        const appInstanceId = randomUUID(); const helperId = randomUUID();
        const envelope = { protocolVersion: 1 as const, windowId: randomUUID(), attemptId: randomUUID() };
        expect(await requestControl(socket, { kind: 'electron-app-control', message: { protocolVersion: 1, type: 'register-app', appInstanceId,
            processId: process.pid, startIdentity: randomUUID(), buildIdentity: 'native_admission_test' } })).toMatchObject({ kind: 'electron-app-control', response: { type: 'ack' } });
        expect(await requestControl(socket, { kind: 'electron-app-control', message: { protocolVersion: 1, type: 'activity', appInstanceId,
            activeWindows: 1, bootstrappingWindows: 1 } })).toMatchObject({ response: { type: 'ack' } });
        const admitted = await requestControl(socket, { kind: 'electron-runtime', appInstanceId, helperId,
            message: { ...envelope, requestId: randomUUID(), type: 'admit', sourcePath: source } });
        if (admitted.kind !== 'electron-runtime' || admitted.response.type !== 'admitted') throw new Error(`Native admission failed: ${JSON.stringify({ response: admitted, stages })}`);
        expect(validElectronReviewHelperResponse(admitted.response)).toBe(true);
        expect(JSON.stringify(admitted.response.projection)).not.toContain(root);
        expect(JSON.stringify(admitted.response.projection)).not.toContain(await realpath(root));
        const { resourceId, generation } = admitted.response;
        const read = await requestControl(socket, { kind: 'electron-runtime', appInstanceId, helperId,
            message: { ...envelope, requestId: randomUUID(), type: 'read-resource', resourceId, generation, role: 'document', offset: 0, length: bytes.length } });
        if (read.kind !== 'electron-runtime' || read.response.type !== 'resource-bytes') throw new Error('Native document resource unavailable');
        expect(Buffer.from(read.response.data, 'base64')).toEqual(bytes);
        expect(await requestControl(socket, { kind: 'electron-runtime', appInstanceId, helperId,
            message: { ...envelope, requestId: randomUUID(), type: 'adopt-resource', resourceId, generation, byteLength: bytes.length,
                digest: createHash('sha256').update(bytes).digest('hex') } })).toMatchObject({ response: { type: 'resource-adopted' } });
        expect(await requestControl(socket, { kind: 'electron-runtime', appInstanceId, helperId,
            message: { ...envelope, requestId: randomUUID(), type: 'activate', documentValidated: true } })).toMatchObject({ response: { type: 'active' } });
        const link = await requestControl(socket, { kind: 'electron-runtime', appInstanceId, helperId,
            message: { ...envelope, requestId: randomUUID(), type: 'copy-link', location: { kind: 'page', page: 1 } } });
        if (link.kind !== 'electron-runtime' || link.response.type !== 'placekeeper-link') throw new Error('Native link unavailable');
        expect(decodePlacekeeperLink(link.response.link)).toEqual({ path: await realpath(source), location: { kind: 'page', page: 1 } });
        expect(await requestControl(socket, { kind: 'electron-app-control', message: { protocolVersion: 1, type: 'detach-helper', appInstanceId, helperId } })).toMatchObject({ response: { type: 'ack' } });
        expect(await requestControl(socket, { kind: 'electron-app-control', message: { protocolVersion: 1, type: 'activity', appInstanceId,
            activeWindows: 0, bootstrappingWindows: 0 } })).toMatchObject({ response: { type: 'ack' } });
        expect(await readFile(source)).toEqual(bytes);
    } catch (error) { console.error('Native admission boundary diagnostics', JSON.stringify(stages)); throw error; }
    finally { vi.restoreAllMocks(); await daemon?.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
