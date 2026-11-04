import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import { createElectronHostRuntime } from '../../web/src/host/electron-runtime.js';
import { parseElectronLocation, type ElectronShellBridge } from '../../../packages/core/src/electron-shell-protocol.js';
it('Electron exposes native link creation to shared copy controls and rejects late retired results', async () => {
    const identity = { windowId: randomUUID(), attemptId: randomUUID() };
    let resolve!: (value: string) => void;
    const requested: unknown[] = [];
    const bridge = { subscribe: () => () => {}, createLink: async (id: unknown, location: unknown) => { requested.push([id, location]); return new Promise<string>(done => { resolve = done; }); } } as unknown as ElectronShellBridge;
    const runtime = createElectronHostRuntime(bridge, identity);
    const pending = runtime.createLink({ kind: 'page', page: 3 });
    resolve('placekeeper:///Papers/paper.pdf#v=1&page=3');
    expect(await pending).toBe('placekeeper:///Papers/paper.pdf#v=1&page=3');
    expect(requested).toEqual([[identity, { kind: 'page', page: 3 }]]);
    const late = runtime.createLink({ kind: 'page', page: 4 });
    runtime.dispose(); resolve('placekeeper:///Papers/paper.pdf#v=1&page=4');
    await expect(late).rejects.toThrow('Retired');
});
it('native link location accepts closed page/item/destination data and rejects privileged additions', () => {
    expect(parseElectronLocation({ kind: 'page', page: 4 })).toEqual({ kind: 'page', page: 4 });
    expect(parseElectronLocation({ kind: 'page', page: 0 })).toBeUndefined();
    expect(parseElectronLocation({ kind: 'other', page: 1 })).toBeUndefined();
    expect(parseElectronLocation({ kind: 'destination', page: 2, mode: 'fit-page', params: [] })).toEqual({ kind: 'destination', page: 2, mode: 'fit-page', params: [] });
    expect(parseElectronLocation({ kind: 'page', page: 1, sourcePath: '/private/file.pdf' })).toBeUndefined();
});

it('native link creation rejects a privileged filesystem URL instead of publishing it', async () => {
    const runtime = createElectronHostRuntime({ subscribe: () => () => {}, createLink: async () => 'file:///private/paper.pdf' } as unknown as ElectronShellBridge,
        { windowId: randomUUID(), attemptId: randomUUID() });
    await expect(runtime.createLink({ kind: 'page', page: 1 })).rejects.toThrow();
    runtime.dispose();
});
