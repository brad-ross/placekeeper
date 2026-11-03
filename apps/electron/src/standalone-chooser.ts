import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { assetResponse } from './resource-protocol.js';

export type StandaloneChooser = { readonly kind: 'folder' | 'pdf'; readonly start: string } | { readonly kind: 'endpoint' };
export function parseStandaloneChooser(args: readonly string[]): StandaloneChooser | undefined {
    if (!args.includes('--placekeeper-choose')) return undefined;
    const [flag, kind, start] = args;
    if (flag !== '--placekeeper-choose' || !['folder', 'pdf', 'endpoint'].includes(kind ?? '') ||
        (kind === 'endpoint' ? args.length !== 2 : args.length !== 3 || !start || !isAbsolute(start) || start.includes('\0'))) throw new Error('Invalid native chooser request');
    return kind === 'endpoint' ? { kind } : { kind: kind as 'folder' | 'pdf', start: start! };
}

export function acceptsStandaloneEndpoint(binding: { frame: unknown; windowId: string; attemptId: string; token: string }, frame: unknown, identity: unknown, token: unknown, endpoint: unknown): boolean {
    const id = identity && typeof identity === 'object' && !Array.isArray(identity) ? identity as Record<string, unknown> : undefined;
    return binding.frame === frame && id?.windowId === binding.windowId && id?.attemptId === binding.attemptId && token === binding.token &&
        (endpoint === null || (typeof endpoint === 'string' && endpoint.length <= 4096 && !endpoint.includes('\0') && !!endpoint.trim()));
}

/** Standalone explicit user selection never registers an app or admits a helper. */
export async function runStandaloneChooser(chooser: StandaloneChooser, preload: string): Promise<void> {
    await app.whenReady();
    let window: BrowserWindow | undefined;
    const selection = Promise.withResolvers<string | null>();
    const timer = setTimeout(() => selection.resolve(null), 120_000);
    try {
        if (chooser.kind !== 'endpoint') {
            void dialog.showOpenDialog({ title: chooser.kind === 'folder' ? 'Choose LaTeX Source Folder' : 'Choose Compiled PDF', defaultPath: chooser.start,
                properties: chooser.kind === 'folder' ? ['openDirectory'] : ['openFile'],
                ...(chooser.kind === 'pdf' ? { filters: [{ name: 'PDF', extensions: ['pdf'] }] } : {}) }).then(result => selection.resolve(result.canceled ? null : result.filePaths[0] ?? null), selection.reject);
        } else {
            const isolated = session.fromPartition(`chooser-${randomUUID()}`);
            isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
            isolated.setPermissionCheckHandler(() => false);
            const root = join(process.resourcesPath, 'desktop', 'electron-web');
            const inventory = new Set<string>();
            async function collect(directory: string, prefix = ''): Promise<void> {
                for (const item of await readdir(directory, { withFileTypes: true })) {
                    if (item.isDirectory()) await collect(join(directory, item.name), prefix + item.name + '/');
                    else if (item.isFile()) inventory.add(prefix + item.name);
                }
            }
            await collect(root);
            isolated.protocol.handle('placekeeper-app', request => assetResponse(root, inventory, request.url));
            window = new BrowserWindow({ width: 600, height: 360, title: 'Neovim endpoint', resizable: false,
                webPreferences: { preload, session: isolated, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
            const contents = window.webContents;
            const identity = { windowId: randomUUID(), attemptId: randomUUID(), sourceEndpointToken: randomUUID() };
            const verify = (event: Electron.IpcMainInvokeEvent) => { if (event.sender !== contents || event.senderFrame !== contents.mainFrame) throw new Error('Unauthorized chooser'); };
            ipcMain.handle('review:identity', event => { verify(event); return identity; });
            ipcMain.handle('review:source-endpoint', (event, id, token, endpoint) => {
                verify(event);
                if (!acceptsStandaloneEndpoint({ frame: contents.mainFrame, windowId: identity.windowId, attemptId: identity.attemptId, token: identity.sourceEndpointToken }, event.senderFrame, id, token, endpoint)) throw new Error('Invalid chooser response');
                selection.resolve(endpoint);
            });
            contents.setWindowOpenHandler(() => ({ action: 'deny' }));
            contents.on('will-navigate', event => event.preventDefault());
            contents.on('will-redirect', event => event.preventDefault());
            contents.on('will-attach-webview', event => event.preventDefault());
            contents.on('render-process-gone', () => selection.reject(new Error('Native chooser interrupted')));
            window.on('closed', () => selection.resolve(null));
            await Promise.race([window.loadURL('placekeeper-app://bundle/electron.html'), selection.promise.then(() => undefined)]);
        }
        const selected = await selection.promise;
        await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify({ selected }) + '\n', error => error ? reject(error) : resolve()));
    } finally {
        clearTimeout(timer);
        ipcMain.removeHandler('review:identity'); ipcMain.removeHandler('review:source-endpoint');
        window?.destroy();
        app.quit();
    }
}
