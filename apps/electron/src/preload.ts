import { contextBridge, ipcRenderer } from 'electron';
import type { ElectronShellBridge } from '../../../packages/core/src/electron-shell-protocol.js';
const bridge: ElectronShellBridge = {
    identity: () => ipcRenderer.invoke('review:identity'),
    request: (identity, message) => ipcRenderer.invoke('review:request', identity, message),
    documentReady: (identity, generation) => ipcRenderer.invoke('review:document-ready', identity, generation),
    visible: (identity, generation) => ipcRenderer.invoke('review:visible', identity, generation),
    subscribe(listener) {
        const receive = (_event: unknown, message: unknown) => listener(message);
        ipcRenderer.on('review:event', receive);
        return () => { ipcRenderer.removeListener('review:event', receive); };
    },
};
contextBridge.exposeInMainWorld('placekeeper', Object.freeze(bridge));
