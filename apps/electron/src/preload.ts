import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type { ElectronShellBridge } from '../../../packages/core/src/electron-shell-protocol.js';
const bridge: ElectronShellBridge = {
    windowChromeMetrics: () => ({ platform: process.platform, scale: webFrame.getZoomFactor() }),
    sourceEndpoint: (identity, token, endpoint) => ipcRenderer.invoke('document:source-endpoint', identity, token, endpoint),
    identity: () => ipcRenderer.invoke('document:identity'),
    request: (identity, message) => ipcRenderer.invoke('document:request', identity, message),
    openExternalUrl: (identity, url) => ipcRenderer.invoke('document:open-external-url', identity, url),
    createLink: (identity, location) => ipcRenderer.invoke('document:create-link', identity, location),
    focusFailed: (identity, token) => ipcRenderer.invoke('document:focus-failed', identity, token),
    requestClose: identity => ipcRenderer.invoke('document:request-close', identity),
    readyToSettle: identity => ipcRenderer.invoke('document:shell-ready', identity),
    documentReady: (identity, generation) => ipcRenderer.invoke('document:document-ready', identity, generation),
    visible: (identity, generation, token) => ipcRenderer.invoke('document:visible', identity, generation, token),
    commandSurface: (identity, revision, snapshot) => ipcRenderer.invoke('document:commands', identity, revision, snapshot),
    presentation: (identity, state) => ipcRenderer.invoke('document:presentation', identity, state),
    toolbarHeight: (identity, height) => ipcRenderer.invoke('document:toolbar-height', identity, height),
    closeSettled: (identity, token, error) => ipcRenderer.invoke('document:close-settled', identity, token, error),
    writeClipboard: (identity, text) => ipcRenderer.invoke('document:clipboard', identity, text),
    subscribeShell(listener) {
        const receive = (_event: unknown, message: Parameters<typeof listener>[0]) => listener(message);
        ipcRenderer.on('document:shell', receive);
        return () => ipcRenderer.removeListener('document:shell', receive);
    },
    subscribe(listener) {
        const receive = (_event: unknown, message: unknown) => listener(message);
        ipcRenderer.on('document:event', receive);
        return () => { ipcRenderer.removeListener('document:event', receive); };
    },
};
contextBridge.exposeInMainWorld('placekeeper', Object.freeze(bridge));
