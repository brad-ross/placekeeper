import { expect, it, vi } from 'vitest';
import { createServiceClient } from '../src/service-client.js';
const control = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => ({ kind: 'extension-app', response: { status: 'ok', payload: {} } })));
vi.mock('../../service/src/host/launch-control.js', () => ({ requestControl: control }));
vi.mock('../../service/src/host/service-daemon.js', () => ({ defaultDaemonPaths: () => ({ socketPath: '/unused.sock' }) }));

it.each(['chooseFolder', 'locateSave'] as const)('preserves the canonical socket budget for extension %s', async method => {
    const request = { action: 'app' as const, request: { protocolVersion: 1 as const, authority: 'presentation' as const, runtimeId: 'runtime_123', attemptId: 'attempt_123', generation: 1, capability: 'a'.repeat(43), requestId: 'request_123', method, payload: {} } };
    expect(await createServiceClient('/test.sock').extension!(request)).toEqual({ status: 'ok', payload: {} });
    expect(control).toHaveBeenLastCalledWith('/test.sock', { kind: 'extension-app', request }, expect.objectContaining({ timeoutMs: 310_000 }));
});

it('retains the ordinary socket deadline for non-picker extension calls', async () => {
    control.mockResolvedValueOnce({ kind: 'extension-app', response: { status: 'closed' } });
    await createServiceClient('/test.sock').extension!({ action: 'settings-read' });
    expect(control.mock.calls.at(-1)?.[2]).not.toHaveProperty('timeoutMs');
});
