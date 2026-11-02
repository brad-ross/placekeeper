import type { ElectronShellBridge, ElectronShellIdentity } from '../../../../packages/core/src/electron-shell-protocol.js';
import { createRpcHostRuntime } from './vscode-runtime.js';
export function createElectronHostRuntime(bridge: ElectronShellBridge, identity: ElectronShellIdentity) {
    const listeners = new Set<(value: unknown) => void>();
    return createRpcHostRuntime({ runtimeId: identity.windowId,
        postMessage(message) { if ((message as {
            kind?: unknown;
        }).kind === "cancel")
            return; void bridge.request(identity, message).then(response => { for (const listener of listeners)
            listener(response); }, () => { for (const listener of listeners)
            listener({ ...(message as object), kind: 'response', ok: false }); }); },
        subscribe(listener) { listeners.add(listener); const unsubscribe = bridge.subscribe(listener); return () => { listeners.delete(listener); unsubscribe(); }; },
    }, { host: 'electron' });
}
