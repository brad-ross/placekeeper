import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { requestControl } from '../../service/src/host/launch-control.js';
const sockets = vi.hoisted(() => [] as any[]);
vi.mock('node:net', () => ({
    createServer: vi.fn(),
    createConnection: () => {
        const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), setEncoding: vi.fn(), destroy: vi.fn(), write: () => queueMicrotask(() => { socket.emit('data', '{"kind":"extension-app","response":{"status":"closed"}}'); socket.emit('end'); }) });
        sockets.push(socket); queueMicrotask(() => socket.emit('connect')); return socket;
    },
}));
it.skipIf(process.platform === 'win32').each(['chooseFolder', 'locateSave'] as const)('assigns the canonical nested %s control deadline without a native picker', async method => {
    await requestControl('/unused.sock', { kind: 'extension-app', request: { action: 'app', request: { protocolVersion: 1, authority: 'presentation', runtimeId: 'runtime_123', attemptId: 'attempt_123', generation: 1, capability: 'a'.repeat(43), requestId: 'request_123', method, payload: {} } } });
    expect(sockets.at(-1).setTimeout).toHaveBeenCalledWith(310_000, expect.any(Function));
});
