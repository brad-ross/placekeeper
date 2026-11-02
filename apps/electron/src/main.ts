import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultDaemonPaths, installedSmokeDaemonPaths, installedSmokeDaemonArgs, electronRuntimeThroughDaemon, electronAppControlThroughDaemon } from '../../service/src/host/service-daemon.js';
import { resolvePackagedRuntime, type PackagedRuntimeManifest } from '../../service/src/platform/runtime-layout.js';
import { encodeElectronHelperFrame } from '../../../packages/core/src/electron-helper-protocol.js';
import { ReviewBridge, acceptsRenderer } from './review-bridge.js';
import { readNativeFrames } from '../../service/src/desktop/framed-input.js';
import { parseElectronAppControlResponse } from '../../../packages/core/src/electron-app-control-protocol.js';
import { assetResponse, documentResponse } from './resource-protocol.js';
import { REVIEW_RUNTIME_PROTOCOL, REVIEW_RUNTIME_VERSION } from '../../../packages/core/src/review-runtime-protocol.js';
protocol.registerSchemesAsPrivileged([
    { scheme: 'placekeeper-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme: 'placekeeper-resource', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
async function start() {
    await app.whenReady();
    const root = join(process.resourcesPath, 'desktop');
    const manifest = JSON.parse(await readFile(join(root, 'runtime-manifest.json'), 'utf8')) as PackagedRuntimeManifest;
    const expectedIdentity = { daemonIdentity: manifest.daemonIdentity, installArtifactIdentity: manifest.installArtifactIdentity };
    const runtime = await resolvePackagedRuntime(root, manifest, expectedIdentity);
    const smokePaths = installedSmokeDaemonPaths(process.argv.slice(1));
    if (smokePaths !== undefined && smokePaths.isolatedTestRoot === undefined) {
        throw new Error('Electron installed smoke requires an explicit isolated test root');
    }
    const paths = { ...(smokePaths ?? defaultDaemonPaths()), webAssetsRoot: runtime.webAssetsRoot, packagedRuntime: { root, manifest, expectedIdentity } };
    const appInstanceId = randomUUID();
    const lifecycle = spawn(runtime.nodeExecutable, [runtime.serviceEntry, 'electron-lifecycle-control', ...installedSmokeDaemonArgs(paths)], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, PLACEKEEPER_APP_INSTANCE_ID: appInstanceId, PLACEKEEPER_DAEMON_IDENTITY: manifest.daemonIdentity, PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY: manifest.installArtifactIdentity, PLACEKEEPER_PDFIUM_WASM: join(runtime.webAssetsRoot, 'pdfium.wasm') } });
    const registration = new Promise<void>((resolve, reject) => {
        lifecycle.once('error', reject);
        void (async () => {
            let registered = false;
            for await (const raw of readNativeFrames(lifecycle.stdout)) {
                const response = parseElectronAppControlResponse(raw);
                if (response?.type !== 'ack' || response.appInstanceId !== appInstanceId)
                    throw new Error('Lifecycle registration refused');
                if (!registered) {
                    registered = true;
                    resolve();
                }
            }
            if (!registered)
                throw new Error('Lifecycle registration ended early');
        })().catch(error => { reject(error); app.quit(); });
    });
    lifecycle.stdin.write(encodeElectronHelperFrame({ protocolVersion: 1, type: 'register-app', appInstanceId, processId: process.pid, startIdentity: randomUUID(), buildIdentity: manifest.installArtifactIdentity }));
    let registrationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([registration, new Promise<never>((_resolve, reject) => { registrationTimer = setTimeout(() => reject(new Error('Lifecycle registration timeout')), 30000); })]);
    }
    finally {
        if (registrationTimer)
            clearTimeout(registrationTimer);
    }
    lifecycle.once('exit', () => { app.quit(); });
    app.on('before-quit', () => lifecycle.stdin.end());
    let sourcePath = process.argv.slice(1).find(value => value.toLowerCase().endsWith('.pdf'));
    if (!sourcePath)
        sourcePath = (await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })).filePaths[0];
    if (!sourcePath) {
        app.quit();
        return;
    }
    const isolated = session.fromPartition(`review-${randomUUID()}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    const assetRoot = join(root, 'electron-web');
    const inventory = new Set<string>();
    async function collect(directory: string, prefix = ''): Promise<void> { for (const item of await readdir(directory, { withFileTypes: true })) {
        const name = prefix + item.name;
        if (item.isDirectory())
            await collect(join(directory, item.name), name + '/');
        else if (item.isFile())
            inventory.add(name);
    } }
    await collect(assetRoot);
    isolated.protocol.handle('placekeeper-app', request => assetResponse(assetRoot, inventory, request.url));
    const retirement = new AbortController();
    let bridge: ReviewBridge;
    bridge = new ReviewBridge((message, signal) => electronRuntimeThroughDaemon(appInstanceId, bridge.helperId, message, signal === undefined ? retirement.signal : AbortSignal.any([signal, retirement.signal]), paths), generation => `placekeeper-resource://document/${bridge.attemptId}/${generation}`);
    await bridge.admit(sourcePath);
    isolated.protocol.handle('placekeeper-resource', request => {
        const expected = bridge.documentUrl(bridge.projection!.generation);
        return request.url === expected ? documentResponse(bridge, bridge.projection!.generation) : new Response(null, { status: 404 });
    });
    const window = new BrowserWindow({ width: 1200, height: 900, webPreferences: { preload: join(__dirname, 'preload.cjs'), session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    lifecycle.stdin.write(encodeElectronHelperFrame({ protocolVersion: 1, type: 'activity', appInstanceId, activeWindows: 1, bootstrappingWindows: 0 }));
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    const verify = (event: Electron.IpcMainInvokeEvent, identity: unknown) => {
        const id = identity as {
            windowId?: unknown;
            attemptId?: unknown;
        } | null;
        if (!id || !acceptsRenderer({ frame: contents.mainFrame, windowId: bridge.windowId, attemptId: bridge.attemptId, retired: bridge.retired }, event.senderFrame, id.windowId, id.attemptId) || event.sender !== contents)
            throw new Error('Unauthorized review sender');
    };
    ipcMain.handle('review:identity', event => {
        if (event.sender !== contents || event.senderFrame !== contents.mainFrame || bridge.retired) {
            throw new Error('Unauthorized sender');
        }
        return { windowId: bridge.windowId, attemptId: bridge.attemptId };
    });
    ipcMain.handle('review:request', (event, identity, value) => {
        verify(event, identity);
        return bridge.request(value);
    });
    ipcMain.handle('review:document-ready', (event, identity, generation) => {
        verify(event, identity);
        if (generation !== bridge.validatedGeneration) {
            throw new Error('Unvalidated document');
        }
        bridge.readyGeneration = generation;
    });
    ipcMain.handle('review:visible', async (event, identity, generation) => {
        verify(event, identity);
        if (generation !== bridge.validatedGeneration || generation !== bridge.readyGeneration || !window.isVisible()) {
            throw new Error('Unvalidated paint');
        }
        bridge.paintedGeneration = generation;
        await bridge.activate();
    });
    let checking = false;
    const timer = setInterval(() => {
        if (!bridge.active || bridge.retired || checking) return;
        checking = true;
        void bridge.send({ type: 'keepalive' }).then(result => {
            if (result.type !== 'invalidation') return;
            contents.send('review:event', {
                protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION,
                kind: 'event', event: 'session-invalidated', runtimeId: bridge.windowId,
                payload: {
                    sessionId: bridge.projection!.sessionId,
                    generation: result.generation, revision: result.revision,
                    reason: result.reason === 'save' || result.reason === 'recovery' ? 'freshness' : result.reason,
                },
            });
        }).catch(() => window.destroy()).finally(() => { checking = false; });
    }, 1000);
    window.once('closed', () => {
        clearInterval(timer);
        bridge.retired = true;
        retirement.abort();
        void electronAppControlThroughDaemon({
            protocolVersion: 1, type: 'detach-helper', appInstanceId, helperId: bridge.helperId,
        }, undefined, paths).catch(() => lifecycle.stdin.end());
        for (const channel of ['identity', 'request', 'document-ready', 'visible']) {
            ipcMain.removeHandler(`review:${channel}`);
        }
    });
    await window.loadURL('placekeeper-app://bundle/electron.html');
}
void start().catch(error => { dialog.showErrorBox('Placekeeper could not open', String(error)); app.quit(); });
app.on('window-all-closed', () => app.quit());
