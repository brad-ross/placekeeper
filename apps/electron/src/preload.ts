import { contextBridge, ipcRenderer } from 'electron';
import type { ElectronShellBridge } from '../../../packages/core/src/electron-shell-protocol.js';
const bridge: ElectronShellBridge = {
    identity: () => ipcRenderer.invoke('review:identity'),
    request: (identity, message) => ipcRenderer.invoke('review:request', identity, message),
    createLink: (identity, location) => ipcRenderer.invoke('review:create-link', identity, location),
    focusFailed: (identity, token) => ipcRenderer.invoke('review:focus-failed', identity, token),
    requestClose: identity => ipcRenderer.invoke('review:request-close', identity),
    readyToSettle: identity => ipcRenderer.invoke('review:shell-ready', identity),
    documentReady: (identity, generation) => ipcRenderer.invoke('review:document-ready', identity, generation),
    visible: (identity, generation, token) => ipcRenderer.invoke('review:visible', identity, generation, token),
    commandSurface: (identity, revision, snapshot) => ipcRenderer.invoke('review:commands', identity, revision, snapshot),
    presentation: (identity, state) => ipcRenderer.invoke('review:presentation', identity, state),
    toolbarHeight: (identity, height) => ipcRenderer.invoke('review:toolbar-height', identity, height),
    closeSettled: (identity, token, error) => ipcRenderer.invoke('review:close-settled', identity, token, error),
    writeClipboard: (identity, text) => ipcRenderer.invoke('review:clipboard', identity, text),
    subscribeShell(listener) {
        const receive = (_event: unknown, message: Parameters<typeof listener>[0]) => listener(message);
        ipcRenderer.on('review:shell', receive);
        return () => ipcRenderer.removeListener('review:shell', receive);
    },
    subscribe(listener) {
        const receive = (_event: unknown, message: unknown) => listener(message);
        ipcRenderer.on('review:event', receive);
        return () => { ipcRenderer.removeListener('review:event', receive); };
    },
};
contextBridge.exposeInMainWorld('placekeeper', Object.freeze(bridge));
