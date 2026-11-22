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
    control.mockResolvedValueOnce({ kind: 'extension-app', response: { status: 'recent-reviews', items: [] } });
    expect(await createServiceClient('/test.sock').extension!({ action: 'recent-list' })).toEqual({ status: 'recent-reviews', items: [] });
    expect(control.mock.calls.at(-1)?.[2]).not.toHaveProperty('timeoutMs');
});

it('accepts the renamed recent-documents status from a newer daemon and keeps the legacy spelling', async () => {
    const items = [{ id: 'a'.repeat(32), title: 'Paper.pdf', updatedAt: '2026-11-05T12:00:00.000Z' }];
    for (const status of ['recent-reviews', 'recent-documents']) {
        control.mockResolvedValueOnce({ kind: 'extension-app', response: { status, items } });
        expect(await createServiceClient('/test.sock').extension!({ action: 'recent-list' })).toEqual({ status: 'recent-reviews', items });
    }
});

it('forwards a renamed export method from a newer shell to the daemon in the legacy spelling', async () => {
    const envelope = { protocolVersion: 1 as const, authority: 'presentation' as const, runtimeId: 'runtime_123', attemptId: 'attempt_123', generation: 1, capability: 'a'.repeat(43), requestId: 'request_123', payload: {} };
    await createServiceClient('/test.sock').extension!({ action: 'app', request: { ...envelope, method: 'exportAnnotatedCopy' as 'exportReviewedCopy' } });
    expect(control).toHaveBeenLastCalledWith('/test.sock', { kind: 'extension-app', request: { action: 'app', request: { ...envelope, method: 'exportReviewedCopy' } } }, expect.anything());
});
