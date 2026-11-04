import type { ElectronShellBridge, ElectronShellIdentity } from '../../../../packages/core/src/electron-shell-protocol.js';
import { decodePlacekeeperLink, type PlacekeeperLinkLocation } from '../../../../packages/core/src/placekeeper-link.js';
import { MemoryReviewLocationHistory } from '../review/review-location-history.js';
import { createRpcHostRuntime } from './vscode-runtime.js';
export function createElectronHostRuntime(bridge: ElectronShellBridge, identity: ElectronShellIdentity) {
    const listeners = new Set<(value: unknown) => void>();
    let disposed = false;
    let history: MemoryReviewLocationHistory | undefined;
    let generation: number | undefined;
    const runtime = createRpcHostRuntime({ runtimeId: identity.windowId,
        postMessage(message) { if ((message as {
            kind?: unknown;
        }).kind === "cancel")
            return; void bridge.request(identity, message).then(response => { for (const listener of listeners)
            listener(response); }, () => { for (const listener of listeners)
            listener({ ...(message as object), kind: 'response', ok: false }); }); },
        subscribe(listener) { listeners.add(listener); const unsubscribe = bridge.subscribe(listener); return () => { listeners.delete(listener); unsubscribe(); }; },
    }, { host: 'electron' });
    return { ...runtime,

        get capabilities() { return runtime.capabilities!; },
        async bootstrap(signal?: AbortSignal) {
            const snapshot = await runtime.bootstrap(signal);
            if (disposed) throw new Error('Retired reader');
            history = snapshot.locationHistory instanceof MemoryReviewLocationHistory ? snapshot.locationHistory : undefined;
            generation = snapshot.generation;
            return snapshot;
        },
        async navigateFocused(location: PlacekeeperLinkLocation, expectedGeneration: number) {
            if (disposed || expectedGeneration !== generation || !history) throw new Error('Focused reader generation is unavailable');
            await history.navigate(location);
            if (disposed || expectedGeneration !== generation) throw new Error('Focused reader was replaced');
        },
        async createLink(location: PlacekeeperLinkLocation) {
            if (disposed) throw new Error('Retired reader');
            const link = await bridge.createLink(identity, location);
            if (disposed) throw new Error('Retired reader');
            decodePlacekeeperLink(link);
            return link;
        },
        dispose() { disposed = true; history = undefined; runtime.dispose(); },
    };
}
