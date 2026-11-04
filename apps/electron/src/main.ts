import { resolvePlatformLocations } from '../../service/src/platform/locations.js';
import { app, BrowserWindow, dialog, ipcMain, protocol, session, clipboard, screen, shell } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { defaultDaemonPaths, installedSmokeDaemonPaths, installedSmokeDaemonArgs, electronRuntimeThroughDaemon, electronAppControlThroughDaemon, resolveElectronLaunchThroughDaemon, preflightLinkThroughDaemon, openLinkThroughDaemon } from '../../service/src/host/service-daemon.js';
import { resolvePackagedRuntime, type PackagedRuntimeManifest } from '../../service/src/platform/runtime-layout.js';
import { encodeElectronHelperFrame } from '../../../packages/core/src/electron-helper-protocol.js';
import { ReviewBridge, acceptsRenderer } from './review-bridge.js';
import { readNativeFrames } from '../../service/src/desktop/framed-input.js';
import { parseElectronAppControlResponse } from '../../../packages/core/src/electron-app-control-protocol.js';
import { assetResponse, documentResponse } from './resource-protocol.js';
import { REVIEW_RUNTIME_PROTOCOL, REVIEW_RUNTIME_VERSION } from '../../../packages/core/src/review-runtime-protocol.js';
import { handleWindowsProtocolInstall } from './protocol-install.js';
import { parseInstallerRequest, isolateInstallerProfile, runInstallerUI } from './installer-ui.js';
import { parseStandaloneChooser, runStandaloneChooser } from './standalone-chooser.js';
import { stageDesktopLink } from './open-link.js';
import { parseDesktopOpenIntent, secondInstanceArguments, DesktopInvocationQueue } from './open-intent.js';
import { FocusedVisibilityGate } from './focused-visibility.js';
import { WindowActivityRegistry, ActivityAcknowledgements } from './window-lifecycle.js';
import { DocumentWindowRegistry } from './window-registry.js';
import { parseWindowState, readWindowState, writeWindowState, importLegacyMacPreferences, readLegacyInterfaceScale, type WindowIntent } from './window-state.js';
import { createIntegrationSetup } from './integration-setup.js';
import { pathToFileURL } from 'node:url';
import { installMenus, type WindowCommands } from './menus.js';
import { createManualUpdateAction } from './update-check.js';
import { parseStartupRequest, writeStartupReceipt, writeStartupLoadFailure, retainedStartupRecovery } from './startup-receipt.js';
import { nativeTitlebarOptions, trackTitlebarHover } from './titlebar.js';
import { parseElectronLocation } from '../../../packages/core/src/electron-shell-protocol.js';
import { decodePlacekeeperLink } from '../../../packages/core/src/placekeeper-link.js';
import { REVIEW_COMMAND_IDS } from '../../web/src/review/review-command-surface.js';
const nativeInstaller = parseInstallerRequest(process.argv.slice(1));
const installerProfile = nativeInstaller ? isolateInstallerProfile() : undefined;
const startupRequest = parseStartupRequest(process.env.PLACEKEEPER_STARTUP_REQUEST);
let startupProbePhase: 'initializing' | 'renderer-navigation' | 'shell-retirement' = 'initializing';
if (startupRequest) { const deadline = setTimeout(() => { void (startupProbePhase === 'initializing' ? Promise.resolve() : writeStartupLoadFailure(startupRequest, 'Installed startup acknowledgement timed out', startupProbePhase === 'shell-retirement' ? 'shell-retirement-timeout' : 'renderer-ready-timeout')).catch(error => console.error(error)).finally(() => app.exit(2)); }, 20_000); deadline.unref(); writeFileSync(`${startupRequest.receipt}.started`, JSON.stringify({ attempt:startupRequest.attempt, candidateIdentity:startupRequest.candidateIdentity, pid:process.pid }), { flag:'wx', mode:0o600 }); mkdirSync(startupRequest.profile, { recursive:true }); app.setPath('userData', startupRequest.profile); }
const standaloneChooser = parseStandaloneChooser(process.argv.slice(1));
const installerAction = handleWindowsProtocolInstall(app, { platform: process.platform, argv: process.argv, executable: process.execPath });
const installerEvent = installerAction.handled;
const smokePaths = nativeInstaller ? undefined : installedSmokeDaemonPaths(process.argv.slice(1));
if (smokePaths && !startupRequest) {
    if (!smokePaths.isolatedTestRoot) throw new Error('Electron installed smoke requires an explicit isolated test root');
    const smokeUserData = join(smokePaths.isolatedTestRoot, 'electron-user-data');
    mkdirSync(smokeUserData, { recursive: true });
    app.setPath('userData', smokeUserData);
}
const pendingOpens: string[] = [];
const invocations = new DesktopInvocationQueue();
let routeOpen: ((path: string) => void) | undefined;
if (installerEvent) app.exit(installerAction.exitCode);
else if (nativeInstaller || standaloneChooser) { /* Explicit chooser processes do not own review windows. */ }
else if (!app.requestSingleInstanceLock({ argv: process.argv.slice(1) })) app.quit();
else {
app.on('open-url', (event, url) => { event.preventDefault(); try { invocations.enqueue([url]); } catch (error) { dialog.showErrorBox('Placekeeper could not open', String(error)); } });
app.on('open-file', (event, path) => { event.preventDefault(); if (routeOpen) routeOpen(path); else pendingOpens.push(path); });
app.on('second-instance', (_event, argv, _directory, additionalData) => {
    try {
        const exactArguments = secondInstanceArguments(argv, additionalData);
        invocations.enqueue(exactArguments);
    } catch (error) { console.error('Desktop invocation refused', error); dialog.showErrorBox('Placekeeper could not open', String(error)); }
});
}
protocol.registerSchemesAsPrivileged([
    { scheme: 'placekeeper-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme: 'placekeeper-resource', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
const startupTime = performance.now();
async function start() {
    await app.whenReady();
    if (process.platform === 'darwin' && !smokePaths && !startupRequest) {
        await importLegacyMacPreferences({ profileRoot: app.getPath('userData') }).catch(error => {
            dialog.showErrorBox('Previous window settings could not be imported', `Your original settings are preserved. ${String(error)}`);
        });
    }
    const interfaceScale = await readLegacyInterfaceScale(app.getPath('userData'));
    const root = join(process.resourcesPath, 'desktop');
    const manifest = JSON.parse(await readFile(join(root, 'runtime-manifest.json'), 'utf8')) as PackagedRuntimeManifest;
    if (startupRequest && startupRequest.candidateIdentity !== manifest.installArtifactIdentity) throw new Error('Installed startup candidate changed');
    const expectedIdentity = { daemonIdentity: manifest.daemonIdentity, installArtifactIdentity: manifest.installArtifactIdentity };
    const runtime = await resolvePackagedRuntime(root, manifest, expectedIdentity);
    if (smokePaths !== undefined && smokePaths.isolatedTestRoot === undefined) {
        throw new Error('Electron installed smoke requires an explicit isolated test root');
    }
    const timing = (stage: string, bridge?: ReviewBridge, details?: { readonly inputLength: number }) => { if (smokePaths) process.stdout.write(JSON.stringify({ type: 'electron-timing', stage, elapsedMs: performance.now() - startupTime, windowId: bridge?.windowId, attemptId: bridge?.attemptId, ...details }) + '\n'); };
    timing('startup');
    const paths = { ...(smokePaths ?? defaultDaemonPaths()), webAssetsRoot: runtime.webAssetsRoot, packagedRuntime: { root, manifest, expectedIdentity } };
    const appInstanceId = randomUUID();
    const lifecycle = spawn(runtime.nodeExecutable, [runtime.serviceEntry, 'electron-lifecycle-control', ...(startupRequest ? ['--installed-startup-lease'] : []), ...installedSmokeDaemonArgs(paths)], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, PLACEKEEPER_APP_INSTANCE_ID: appInstanceId, PLACEKEEPER_DAEMON_IDENTITY: manifest.daemonIdentity, PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY: manifest.installArtifactIdentity, PLACEKEEPER_PDFIUM_WASM: join(runtime.webAssetsRoot, 'pdfium.wasm') } });
    let handleUpgrade: ((status: import("../../../packages/core/src/upgrade-review-protocol.js").UpgradeReviewStatus) => void) | undefined;
    let lifecycleStopping = false;
    let lifecycleFailureShown = false;
    const activityAcknowledgements = new ActivityAcknowledgements();
    const failLifecycle = (error: Error) => {
        activityAcknowledgements.fail(error);
        if (lifecycleStopping || lifecycleFailureShown) return;
        lifecycleFailureShown = true;
        if (startupRequest) { console.error(error); app.exit(2); return; }
        console.error('Electron lifecycle control failed', error);
        dialog.showErrorBox('Desktop service connection ended', String(error));
        app.quit();
    };
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
                } else activityAcknowledgements.acknowledge();
                if (response.upgrade) handleUpgrade?.(response.upgrade);
            }
            throw new Error(registered ? 'Lifecycle control channel ended' : 'Lifecycle registration ended early');
        })().catch(error => { reject(error); failLifecycle(error instanceof Error ? error : new Error(String(error))); });
    });
    lifecycle.stdin.write(encodeElectronHelperFrame({ protocolVersion: 1, type: 'register-app', upgradePreparationVersion: 1, appInstanceId, processId: process.pid, startIdentity: randomUUID(), buildIdentity: manifest.installArtifactIdentity, installationIdentity: manifest.installArtifactIdentity }));
    let registrationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([registration, new Promise<never>((_resolve, reject) => { registrationTimer = setTimeout(() => reject(new Error('Lifecycle registration timeout')), 30000); })]);
    }
    finally {
        if (registrationTimer)
            clearTimeout(registrationTimer);
    }
    lifecycle.once('exit', () => failLifecycle(new Error('Desktop lifecycle process exited')));
    lifecycle.stdin.on('error', failLifecycle);
    app.on('will-quit', () => { lifecycleStopping = true; lifecycle.stdin.end(); });
    const registry = new DocumentWindowRegistry<BrowserWindow>();
    type Entry = { window: BrowserWindow; bridge: ReviewBridge; commands?: WindowCommands; configureSource?: () => void; sourceEndpoint?: { token: string; resolve: (endpoint: string | null) => void }; intent: WindowIntent; closeToken?: string; focusedVisibility: FocusedVisibilityGate; permitClose: boolean; rendererReady: boolean; failureShown: boolean; retirement: AbortController; toolbarHeight: number; timer?: ReturnType<typeof setInterval> };
    const entries = new Map<number, Entry>();
    const ownedWindows = new WindowActivityRegistry();
    const statePath = join(app.getPath('userData'), 'windows.json');
    let quitting = false;
    let persistence = Promise.resolve();
    const persist = () => { if (startupRequest) return Promise.resolve(); const windows = [...entries.values()].map(e => e.intent); persistence = persistence.then(() => writeWindowState(statePath, windows)).catch(error => { dialog.showErrorBox('Window restoration could not be saved', String(error)); }); return persistence; };
    const activity = () => {
        const pending = activityAcknowledgements.enqueue(() => {
            if (lifecycle.stdin.writableEnded || lifecycle.stdin.destroyed) throw new Error('Desktop lifecycle control is unavailable');
            lifecycle.stdin.write(encodeElectronHelperFrame({ protocolVersion: 1, type: 'activity', appInstanceId, ...ownedWindows.snapshot() }));
        });
        void pending.catch(error => console.error('Electron window activity failed', error));
        return pending;
    };
    let preparedUpgrade: string | undefined;
    let protectingUpgrade = false;
    handleUpgrade = status => {
        if (status.phase === 'canceled' || status.phase === 'none' || status.phase === 'preview') { preparedUpgrade = undefined; return; }
        if (status.phase === 'preparing' && (preparedUpgrade !== status.attemptId || status.settlementRequired === true) && !protectingUpgrade) {
            protectingUpgrade = true; preparedUpgrade = status.attemptId;
            void (async () => {
                let error: string | undefined;
                try { await persistence; await writeWindowState(statePath, [...entries.values()].map(e => e.intent)); }
                catch (failure) { error = String(failure).slice(0, 1024); }
                if (preparedUpgrade !== status.attemptId) return;
                const request = { attemptId: status.attemptId!, ...(error === undefined ? {} : { error }) };
                await activityAcknowledgements.enqueue(() => lifecycle.stdin.write(encodeElectronHelperFrame({ protocolVersion: 1, type: 'upgrade-settle', appInstanceId, request })));
            })().catch(failLifecycle).finally(() => { protectingUpgrade = false; });
        }
        if (status.phase === 'committed' && status.attemptId === preparedUpgrade) { quitting = true; app.quit(); }
    };
    let upgradePollPending = false;
    const upgradePollTimer = setInterval(() => { if (!lifecycleStopping && !upgradePollPending) { upgradePollPending = true; void activity().finally(() => { upgradePollPending = false; }); } }, 500);
    upgradePollTimer.unref();
    app.on('will-quit', () => clearInterval(upgradePollTimer));
    const focused = () => { const w = BrowserWindow.getFocusedWindow(); return w ? entries.get(w.webContents.id) : undefined; };
    const checkUpdates = createManualUpdateAction({ installedVersion: app.getVersion(), platform: process.platform, architecture: process.arch, present: async options => (await dialog.showMessageBox(options)).response, openExternal: url => shell.openExternal(url) });
    const integrationHelper = () => import(/* @vite-ignore */ pathToFileURL(join(root, 'installer/setup-integrations.mjs')).href);
    const integrations = createIntegrationSetup({ statePath: join(resolvePlatformLocations().appSupportRoot, 'integrations/choices.json'), isolated: !!smokePaths || !!startupRequest,
        present: async options => (await dialog.showMessageBox(options)).response,
        setup: async choices => (await integrationHelper()).setupIntegrations({ resources: root, choices }) });
    const menus = () => installMenus(() => { void chooseOpen(); }, focused, () => { void checkUpdates(); }, () => { void integrations.open(); });
    const verify = (event: Electron.IpcMainInvokeEvent, identity?: unknown, identityRequest = false) => {
        const entry = entries.get(event.sender.id);
        const id = identity as { windowId?: unknown; attemptId?: unknown } | undefined;
        if (!entry || event.senderFrame !== event.sender.mainFrame || entry.bridge.retired || (!identityRequest && !id) || (id && !acceptsRenderer({ frame: event.sender.mainFrame, windowId: entry.bridge.windowId, attemptId: entry.bridge.attemptId, retired: entry.bridge.retired }, event.senderFrame, id.windowId, id.attemptId))) throw new Error('Unauthorized review sender');
        return entry;
    };
    ipcMain.handle('review:identity', event => { const e = verify(event, undefined, true); return { windowId: e.bridge.windowId, attemptId: e.bridge.attemptId, presentation: e.intent.presentation }; });
    ipcMain.handle('review:source-endpoint', (event, id, token, endpoint) => {
        const e = verify(event, id);
        if (!e.sourceEndpoint || token !== e.sourceEndpoint.token || (endpoint !== null && (typeof endpoint !== 'string' || endpoint.length > 4096 || endpoint.includes('\0')))) throw new Error('Invalid source endpoint');
        const pending = e.sourceEndpoint; delete e.sourceEndpoint; pending.resolve(endpoint);
    });
    ipcMain.handle('review:create-link', async (event, id, value) => {
        const e = verify(event, id);
        const location = parseElectronLocation(value);
        if (!location || !e.bridge.active) throw new Error('Invalid native link request');
        const result = await e.bridge.send({ type: 'copy-link', location });
        if (result.type !== 'placekeeper-link') throw new Error('Native link unavailable');
        decodePlacekeeperLink(result.link);
        return result.link;
    });
    ipcMain.handle('review:focus-failed', (event, id, token) => { const e = verify(event, id); if (typeof token === 'string' && e.focusedVisibility.current(token)) { e.focusedVisibility.fail(token); dialog.showErrorBox('Location could not be opened', 'The requested PDF location could not be opened. Try the link again.'); } });
    ipcMain.handle('review:request-close', (event, id) => { const e = verify(event, id); timing('renderer-close-request', e.bridge); e.window.close(); });
    ipcMain.handle('review:shell-ready', (event, id) => { verify(event, id).rendererReady = true; });
    ipcMain.handle('review:request', (event, id, value) => {
        const e = verify(event, id);
        if (smokePaths && value?.method === 'command' && value?.payload?.type === 'put-draft' && typeof value.payload.draft?.text === 'string') timing('draft-input-request', e.bridge, { inputLength: value.payload.draft.text.length });
        return e.bridge.request(value);
    });
    ipcMain.handle('review:document-ready', async (event, id, generation) => { const e = verify(event, id); const b = e.bridge; if (generation !== b.validatedGeneration) throw new Error('Unvalidated document'); b.readyGeneration = generation; timing('document-ready', b);
        if (startupRequest) {
            if (!e.rendererReady || e.intent.sourcePath !== startupRequest.fixture) throw new Error('Installed renderer startup was not validated');
            await writeStartupReceipt(startupRequest, manifest.installArtifactIdentity);
            startupProbePhase = 'shell-retirement';
            // Normal close settlement and lifecycle detach must finish before
            // the installer observes a successful process exit.
            setImmediate(() => app.quit());
        }
    });
    ipcMain.handle('review:visible', async (event, id, generation, token) => { const e = verify(event, id); if (!e.focusedVisibility.accepts(token, generation)) throw new Error('Stale activation evidence'); if (generation !== e.bridge.validatedGeneration || generation !== e.bridge.readyGeneration || !e.window.isVisible()) throw new Error('Unvalidated paint'); e.bridge.paintedGeneration = generation; await e.bridge.activate(); if (!e.focusedVisibility.commit(token, generation)) throw new Error('Superseded activation evidence'); ownedWindows.activated(e.bridge.helperId); timing('visible-active', e.bridge); activity(); menus(); });
    ipcMain.handle('review:clipboard', (event, id, text) => { verify(event, id); if (typeof text !== 'string' || text.length > 4 * 1024 * 1024) throw new Error('Invalid clipboard text'); clipboard.writeText(text); });
    ipcMain.handle('review:presentation', (event, id, presentation) => { const e = verify(event, id); const clean = parseWindowState([{ ...e.intent, presentation }])[0]; if (clean) { e.intent = clean; void persist(); } });
    ipcMain.handle('review:toolbar-height', (event, id, height) => {
        const e = verify(event, id);
        if (typeof height !== 'number' || !Number.isFinite(height) || height < 32 || height > 160) throw new Error('Invalid toolbar height');
        e.toolbarHeight = height;
    });
    ipcMain.handle('review:commands', (event, id, revision, snapshot) => {
        const e = verify(event, id);
        if (!Number.isSafeInteger(revision) || revision <= (e.commands?.revision ?? 0) || !snapshot || !['review', 'editable', 'dialog'].includes(snapshot.focusContext) || !Array.isArray(snapshot.commands) || snapshot.commands.length !== REVIEW_COMMAND_IDS.length || snapshot.commands.some((c: { id: unknown; label: unknown; enabled: unknown }) => !REVIEW_COMMAND_IDS.includes(c.id as never) || typeof c.label !== 'string' || c.label.length > 200 || typeof c.enabled !== 'boolean')) throw new Error('Invalid commands');
        e.commands = { revision, snapshot }; if (focused() === e) menus();
    });
    ipcMain.handle('review:close-settled', async (event, id, token, error) => {
        const e = verify(event, id);
        timing(error === undefined ? 'close-settled' : 'close-settlement-failed', e.bridge);
        if (typeof token !== 'string' || e.closeToken !== token) throw new Error('Stale close');
        delete e.closeToken;
        try { if (error !== undefined) throw new Error(typeof error === 'string' ? error : 'Review input could not be protected'); await e.bridge.settle(); if (e.bridge.retired || entries.get(event.sender.id) !== e) throw new Error('Retired close attempt'); e.permitClose = true; timing('close-protected', e.bridge); e.window.destroy(); }
        catch (failure) { quitting = false; dialog.showErrorBox('Review remains open', String(failure)); throw failure; }
    });
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
    async function createWindow(sourcePath: string, restored?: WindowIntent, launchId?: string, navigationHandle?: string): Promise<BrowserWindow> {
    const isolated = session.fromPartition(`review-${randomUUID()}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.protocol.handle('placekeeper-app', request => assetResponse(assetRoot, inventory, request.url));
    const retirement = new AbortController();
    let bridge: ReviewBridge;
    bridge = new ReviewBridge((message, signal) => electronRuntimeThroughDaemon(appInstanceId, bridge.helperId, message, signal === undefined ? retirement.signal : AbortSignal.any([signal, retirement.signal]), paths, startupRequest ? process.env.PLACEKEEPER_LIFECYCLE_LOCK_TOKEN : undefined), generation => `placekeeper-resource://document/${bridge.attemptId}/${generation}`);
    const bounds = restored?.bounds ?? { width: 1200, height: 900 };
    const usable = screen.getAllDisplays().some(d => (bounds.x ?? d.workArea.x) < d.workArea.x + d.workArea.width && (bounds.y ?? d.workArea.y) < d.workArea.y + d.workArea.height && (bounds.x ?? d.workArea.x) + bounds.width > d.workArea.x && (bounds.y ?? d.workArea.y) + bounds.height > d.workArea.y);
    const window = new BrowserWindow({ ...(startupRequest ? { show:false } : {}), ...nativeTitlebarOptions(), ...(usable ? bounds : { width: bounds.width, height: bounds.height }), minWidth: 600, minHeight: 400, title: basename(sourcePath), backgroundColor: '#f7f7f7', webPreferences: { preload: join(__dirname, 'preload.cjs'), session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    window.webContents.setZoomFactor(interfaceScale);
    timing('window-visible', bridge);
    const entry: Entry = { window, bridge, retirement, toolbarHeight: 52, permitClose: false, focusedVisibility: new FocusedVisibilityGate(), rendererReady: false, failureShown: false, intent: { sourcePath, bounds, maximized: restored?.maximized ?? false, ...(restored?.presentation ? { presentation: restored.presentation } : {}) } };
    entries.set(window.webContents.id, entry); ownedWindows.register(bridge.helperId);
    const windowRegistration = activity();
    const contents = window.webContents;
    const disposeTitlebarHover = trackTitlebarHover(window, () => screen.getCursorScreenPoint(), () => entry.toolbarHeight);
    let retirementPromise: Promise<void> | undefined;
    const retire = () => {
        if (retirementPromise) return retirementPromise;
        bridge.retired = true; retirement.abort();
        entry.sourceEndpoint?.resolve(null); delete entry.sourceEndpoint;
        disposeTitlebarHover();
        if (entry.timer) clearInterval(entry.timer);
        ownedWindows.retiring(bridge.helperId); activity();
        retirementPromise = electronAppControlThroughDaemon({ protocolVersion: 1, type: 'detach-helper', appInstanceId, helperId: bridge.helperId }, undefined, paths).then(response => {
            if (response.type !== 'ack') throw new Error(`Review detach refused: ${response.type}`);
            ownedWindows.detached(bridge.helperId); return activity();
        });
        return retirementPromise;
    };
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    window.on('focus', menus);
    const saveGeometry = () => { entry.intent = { ...entry.intent, bounds: window.getNormalBounds(), maximized: window.isMaximized() }; void persist(); };
    window.on('resize', saveGeometry); window.on('move', saveGeometry);
    window.on('close', event => {
        entry.sourceEndpoint?.resolve(null); delete entry.sourceEndpoint;
        timing(entry.permitClose ? 'close-request-permitted' : bridge.retired ? 'close-request-retired' : !entry.rendererReady ? 'close-request-unready' : 'close-request-settle', bridge);
        if (entry.permitClose || bridge.retired) return;
        if (!entry.rendererReady) { entry.permitClose = true; void retire().catch(() => undefined); return; }
        event.preventDefault();
        if (entry.closeToken) return;
        entry.closeToken = randomUUID();
        contents.send('review:shell', { type: 'settle-close', token: entry.closeToken });
    });
    window.once('closed', () => { entries.delete(contents.id); registry.remove(window); void retire().catch(error => dialog.showErrorBox('Review detach failed', String(error))); if (!quitting) void persist(); menus(); if (quitting && entries.size === 0) { void persistence.finally(() => app.quit()); } });
    const fail = async (reason: unknown) => {
        if (startupRequest) { console.error(reason); app.exit(2); return; }
        if (entry.failureShown || window.isDestroyed()) return;
        entry.failureShown = true;
        await retire().catch(() => undefined);
        if (window.isDestroyed()) return;
        const result = await dialog.showMessageBox(window, { type: 'error', title: 'Review interrupted', message: 'This document could not continue. Acknowledged work remains recoverable.', detail: String(reason), buttons: ['Retry', 'Close'], defaultId: 0, cancelId: 1 });
        const intent = entry.intent;
        registry.remove(window); window.destroy();
        if (result.response === 0) void openDocument(sourcePath, intent).catch(showFailure);
    };
    let sourceSetup: Promise<boolean> | undefined;
    bridge.onSourceSetup = () => {
        if (sourceSetup) return sourceSetup;
        const generation = bridge.projection?.generation;
        const current = () => !bridge.retired && !window.isDestroyed() && entries.get(contents.id) === entry && bridge.projection?.generation === generation;
        sourceSetup = (async () => {
            const result = await electronAppControlThroughDaemon({ protocolVersion: 1, type: 'editor-profiles', appInstanceId }, undefined, paths);
            if (!current() || result.type !== 'editor-profiles') return false;
            if (!result.profiles.length) {
                await dialog.showMessageBox(window, { type: 'info', title: 'Configure Source Navigation', message: 'Add an editor profile using Placekeeper’s installed editor command, then choose Configure Source Navigation again.' });
                return false;
            }
            const choice = await dialog.showMessageBox(window, { type: 'question', title: 'Configure Source Navigation', message: 'Choose the editor to open LaTeX source.', buttons: [...result.profiles.map(profile => profile.name), 'Cancel'], cancelId: result.profiles.length });
            const profile = result.profiles[choice.response];
            if (!profile || !current()) return false;
            let socket: string | undefined;
            if (profile.kind === 'neovim') {
                const endpoint = await new Promise<string | null>(resolve => {
                    const token = randomUUID(); entry.sourceEndpoint = { token, resolve };
                    contents.send('review:shell', { type: 'source-endpoint', token });
                });
                if (!endpoint || !current()) return false;
                socket = endpoint;
            }
            const folder = await dialog.showOpenDialog(window, { title: 'Choose LaTeX Source Folder', properties: ['openDirectory'] });
            if (folder.canceled || !folder.filePaths[0] || !current()) return false;
            const associated = await electronAppControlThroughDaemon({ protocolVersion: 1, type: 'associate-editor', appInstanceId, helperId: bridge.helperId, profile: profile.name, sourceRoot: folder.filePaths[0], ...(socket ? { socket } : {}) }, undefined, paths);
            if (!current()) return false;
            if (associated.type !== 'ack') throw new Error('Check the editor profile, source folder, and Neovim endpoint.');
            return true;
        })().catch(error => { if (current()) dialog.showErrorBox('Source navigation could not be configured', String(error)); return false; }).finally(() => { sourceSetup = undefined; });
        return sourceSetup;
    };
    entry.configureSource = () => { void bridge.onSourceSetup?.(); };
    bridge.onInvalidation = event => { if (!bridge.retired && !contents.isDestroyed()) contents.send('review:event', event); };
    bridge.onRefreshError = error => { if (!bridge.retired && !window.isDestroyed()) void fail(error); };
    contents.on('render-process-gone', (_event, details) => { void fail(details.reason); });
    bridge.chooseDestination = async method => { const result = await dialog.showOpenDialog(window, { properties: method === 'chooseFolder' ? ['openDirectory', 'createDirectory'] : ['openFile'], ...(method === 'locateSave' ? { filters: [{ name: 'PDF', extensions: ['pdf'] }] } : {}) }); return result.canceled ? null : result.filePaths[0] ?? null; };
    isolated.protocol.handle('placekeeper-resource', request => { const p = bridge.projection; return p && request.url === bridge.documentUrl(p.generation) ? documentResponse(bridge, p.generation) : new Response(null, { status: 404 }); });
    try {
        await windowRegistration;
        await bridge.admit(sourcePath, async offer => {
            const labels = { resume: 'Resume Draft', discard: 'Use PDF', fork: 'Recover Copy' };
            const result = await dialog.showMessageBox(window, { type: 'question', title: 'Protected draft', message: 'This PDF has a protected review draft.', detail: 'Resume it, discard it and use the PDF, or open a separate recovered copy.', buttons: [...offer.choices.map(choice => labels[choice]), 'Cancel'], defaultId: 0, cancelId: offer.choices.length });
            const decision = offer.choices[result.response];
            if (decision === undefined) throw new Error('Recovery canceled; protected draft retained');
            return decision;
        }, launchId, navigationHandle);
        let checking = false;
        entry.timer = setInterval(() => { if (!bridge.active || bridge.retired || checking) return; checking = true; void bridge.send({ type: 'keepalive' }).then(result => {
            if (result.type === 'invalidation') contents.send('review:event', { protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION, kind: 'event', event: 'session-invalidated', runtimeId: bridge.windowId, payload: { sessionId: bridge.projection!.sessionId, generation: result.generation, revision: result.revision, reason: result.reason === 'save' || result.reason === 'recovery' ? 'freshness' : result.reason } });
            else return bridge.pollNavigation();
        }).catch(error => { void fail(error); }).finally(() => { checking = false; }); }, 1000);
        if (restored?.maximized) window.maximize();
        if (startupRequest) startupProbePhase = 'renderer-navigation';
        try { await window.loadURL('placekeeper-app://bundle/electron.html'); }
        catch (error) { if (startupRequest) await writeStartupLoadFailure(startupRequest, error); throw error; }
        void persist();
        return window;
    } catch (error) { await retire().catch(() => undefined); window.destroy(); throw error; }
    }
    function showFailure(error: unknown) { console.error(error); dialog.showErrorBox('Placekeeper could not open', String(error)); }
    async function openDocument(path: string, restored?: WindowIntent, launchId?: string, navigationHandle?: string) {
        let created = false;
        const window = await registry.open(path, canonical => { created = true; return createWindow(canonical, restored, launchId, navigationHandle); }, window => { if (window.isMinimized()) window.restore(); window.show(); window.focus(); });
        if (navigationHandle) {
            const entry = entries.get(window.webContents.id);
            if (!entry || entry.bridge.retired) throw new Error('Source navigation review is unavailable');
            const response = await electronAppControlThroughDaemon({ protocolVersion: 1, type: 'bind-navigation', appInstanceId, helperId: entry.bridge.helperId, navigationHandle }, undefined, paths);
            if (response.type !== 'ack' || entry.bridge.retired) throw new Error('Source navigation is no longer available');
        }
        if (launchId && !created) {
            const entry = entries.get(window.webContents.id);
            if (!entry || entry.bridge.retired) throw new Error('Task review is unavailable');
            const token = randomUUID();
            const previous = entry.focusedVisibility.begin(token);
            let attached = false;
            try {
                await entry.bridge.attachLaunch(launchId);
                attached = true;
                if (!entry.focusedVisibility.current(token)) throw new Error('Task launch was superseded');
                const projection = entry.bridge.projection!;
                entry.focusedVisibility.admitted(token, projection.generation);
                const location = parseElectronLocation(projection.location);
                if (projection.location !== undefined && !location) throw new Error('Invalid focused launch location');
                entry.window.webContents.send('review:shell', { type: 'confirm-visible', token, generation: projection.generation, ...(location ? { location } : {}) });
            } catch (error) {
                if (attached) entry.focusedVisibility.fail(token);
                else entry.focusedVisibility.restore(token, previous);
                throw error;
            }
        }
        return window;
    }
    async function chooseOpen() { const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }] }); for (const path of result.filePaths) await openDocument(path).catch(showFailure); }
    async function handleInvocation(args: readonly string[]) {
        const intent = parseDesktopOpenIntent(args);
        if (intent.type === 'link') {
            const launchId = await stageDesktopLink(intent.link, {
                preflight: link => preflightLinkThroughDaemon(link, paths),
                open: request => openLinkThroughDaemon(request, paths),
                confirm: async path => (await dialog.showMessageBox({ type: 'question', title: 'Open Placekeeper link', message: `Open ${basename(path)}?`, detail: path, buttons: ['Open PDF', 'Cancel'], cancelId: 1 })).response === 0,
                recover: async offer => {
                    const labels = { resume: 'Resume Draft', discard: 'Use PDF', fork: 'Recover Copy' };
                    const result = await dialog.showMessageBox({ type: 'question', title: 'Protected draft', message: 'This linked PDF has a protected review draft.', buttons: [...offer.choices.map(choice => labels[choice]), 'Cancel'], cancelId: offer.choices.length });
                    return offer.choices[result.response];
                },
            });
            if (launchId) await handleInvocation(['--placekeeper-launch', launchId]);
        } else if (intent.type === 'navigation') {
            const navigation = await electronAppControlThroughDaemon({ protocolVersion: 1, type: 'redeem-navigation', appInstanceId, ticket: intent.ticket }, undefined, paths);
            if (navigation.type !== 'navigation') throw new Error('Source navigation is no longer available');
            await openDocument(navigation.pdfPath, undefined, undefined, navigation.navigationHandle);
        } else if (intent.type === 'launch') {
            const launch = await resolveElectronLaunchThroughDaemon(intent.launchId, paths);
            if (!launch) throw new Error('Task launch is no longer available');
            await openDocument(launch.sourcePath, undefined, intent.launchId);
        } else for (const path of intent.paths) await openDocument(path).catch(showFailure);
    }
    routeOpen = path => { void openDocument(path).catch(showFailure); };
    invocations.activate(argv => { void handleInvocation(argv).catch(showFailure); });
    app.on('activate', () => { if (entries.size === 0) void chooseOpen(); });
    app.on('before-quit', event => { if (entries.size === 0) return; event.preventDefault(); quitting = true; void persist(); for (const e of entries.values()) e.window.close(); });
    menus();
    if (startupRequest) { await openDocument(startupRequest.fixture); return; }
    const initial = parseDesktopOpenIntent(process.argv.slice(1));
    const queuedPaths = pendingOpens.splice(0);
    const queuedInvocations = invocations.take();
    const hasInitial = initial.type !== 'paths' || initial.paths.length > 0 || queuedPaths.length > 0 || queuedInvocations.length > 0;
    if (hasInitial) {
        await handleInvocation(process.argv.slice(1)).catch(showFailure);
        for (const path of queuedPaths) await openDocument(path).catch(showFailure);
        for (const args of queuedInvocations) await handleInvocation(args).catch(showFailure);
    } else { const restored = await readWindowState(statePath); for (const intent of restored) await openDocument(intent.sourcePath, intent).catch(showFailure); if (entries.size === 0) await chooseOpen(); }
    void integrations.firstLaunch().catch(error => console.error('Optional integration offer unavailable', error));

}
if (nativeInstaller && installerProfile && !installerEvent) void runInstallerUI(nativeInstaller, installerProfile);
if (standaloneChooser && !nativeInstaller && !installerEvent) void runStandaloneChooser(standaloneChooser, join(__dirname, 'preload.cjs')).catch(() => app.exit(2));
if (!nativeInstaller && !standaloneChooser && !installerEvent && app.hasSingleInstanceLock()) void start().catch(async error => { if (startupRequest) { console.error(error); app.exit(2); } else { const recovery = await retainedStartupRecovery(resolve(process.resourcesPath, process.platform === 'darwin' ? '../..' : '..')); dialog.showErrorBox('Placekeeper could not open', `${String(error)}${recovery ? `\n\n${recovery}` : ''}`); app.quit(); } });
app.on('window-all-closed', () => { if (startupRequest || process.platform !== 'darwin') app.quit(); });
