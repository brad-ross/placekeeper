import { it, expect } from 'vitest';
import { encodeNativeHelperFrame, decodeNativeHelperFrame } from '../../../packages/core/src/native-helper-protocol.js';
import { runNativeLifecycleControlCommand, lifecycleDiagnostic, type NativeLifecycleDiagnostic } from '../src/desktop/lifecycle-control-command.js';
const appInstanceId = 'app_instance_1234';
const registration = { protocolVersion: 1, type: 'register-app', appInstanceId, processId: 123,
    startIdentity: 'start_identity_1234', buildIdentity: 'build_identity_1234' };
async function* input(...messages: unknown[]) { for (const message of messages) yield encodeNativeHelperFrame(message); }

it('classifies registration failure on diagnostics while keeping framed stdout empty', async () => {
    const output: Buffer[] = []; const diagnostics: NativeLifecycleDiagnostic[] = [];
    const error = Object.assign(new Error('C:\\private\\proof-token.pdf'), { name: 'WindowsNativeWorkerError', reason: 'owner-mismatch',
        diagnostic: { exceptionKind: 'UnauthorizedAccessException', hresult: -2147024891 } });
    const code = await runNativeLifecycleControlCommand({ input: input(registration), appInstanceId,
        write: async frame => { output.push(frame); }, exchange: async () => { throw error; }, diagnostic: value => diagnostics.push(value) });
    expect(code).toBe(2); expect(output).toEqual([]);
    expect(diagnostics).toEqual([{ stage: 'exchange-register-app', errorClass: 'WindowsNativeWorkerError', cause: 'unclassified',
        reason: 'owner-mismatch', exceptionKind: 'UnauthorizedAccessException', hresult: -2147024891 }]);
    expect(JSON.stringify(diagnostics)).not.toContain('private'); expect(JSON.stringify(diagnostics)).not.toContain('proof-token');
});
it('keeps only valid binary protocol frames on stdout when later activity fails', async () => {
    const output: Buffer[] = []; const diagnostics: NativeLifecycleDiagnostic[] = [];
    const ack = { protocolVersion: 1, type: 'ack', appInstanceId } as const;
    const code = await runNativeLifecycleControlCommand({ input: input(registration, { protocolVersion: 1, type: 'activity', appInstanceId, activeWindows: 1, bootstrappingWindows: 1 }), appInstanceId,
        write: async frame => { output.push(frame); }, exchange: async message => { if (message.type === 'activity') throw new Error('The local placekeeper service did not become ready'); return ack; },
        diagnostic: value => diagnostics.push(value) });
    expect(code).toBe(2); expect(output).toHaveLength(1); expect(decodeNativeHelperFrame(output[0]!)).toEqual(ack);
    expect(diagnostics).toEqual([{ stage: 'exchange-activity', errorClass: 'Error', cause: 'daemon-not-ready' }]);
});
it('distinguishes fixed runtime, lock and environment causes without echoing raw errors', () => {
    expect(lifecycleDiagnostic('initialize', new Error('Packaged runtime digest mismatch: private/file'))).toMatchObject({ cause: 'packaged-runtime-validation' });
    expect(lifecycleDiagnostic('exchange-register-app', new Error('Placekeeper lifecycle coordination is busy'))).toMatchObject({ cause: 'lifecycle-lock-busy' });
    expect(lifecycleDiagnostic('exchange-register-app', new Error('Windows system directory is unavailable'))).toMatchObject({ cause: 'windows-system-directory-unavailable' });
    const error = Object.assign(new Error('secret message'), { name: '/private/error', code: 'secret', reason: 'secret' });
    expect(lifecycleDiagnostic('read-input', error)).toEqual({ stage: 'read-input', cause: 'unclassified', errorClass: 'Error' });
});
