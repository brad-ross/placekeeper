import { it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { observeIsolatedDaemonStartup } from '../src/host/daemon-startup-diagnostic.js';
it('reports early daemon exit and fixed classified stderr without raw paths or protocol output', async () => {
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stderr, exitCode: 2, signalCode: null }) as unknown as ChildProcess;
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
        const report = observeIsolatedDaemonStartup(child);
        stderr.write('Error: cannot open C:\\private\\source.pdf with proof=secret\n');
        stderr.write('[PlacekeeperDaemon] {"stage":"start-daemon","cause":"browser-source-private-root","errorClass":"Error","message":"private-secret"}\n');
        const reporting = report();
        child.emit('close', 2, null);
        await reporting;
        const output = String(write.mock.calls[0]![0]);
        expect(output).toContain('"exitCode":2'); expect(output).toContain('browser-source-private-root');
        expect(output).not.toContain('source.pdf'); expect(output).not.toContain('secret'); expect(output).not.toContain('proof');
    } finally { write.mockRestore(); stderr.destroy(); }
});
it('caps daemon stderr capture and report count while distinguishing a still-live startup', async () => {
    const stderr = new PassThrough();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
        const report = observeIsolatedDaemonStartup(Object.assign(new EventEmitter(), { stderr, exitCode: null, signalCode: null }) as unknown as ChildProcess);
        stderr.write(Buffer.alloc(20 * 1024, 65)); await report();
        const value = JSON.parse(String(write.mock.calls[0]![0]).slice('[PlacekeeperDaemonStartup] '.length));
        expect(value).toMatchObject({ exitCode: null, capturedBytes: 16 * 1024, truncated: true, reports: [] });
    } finally { write.mockRestore(); stderr.destroy(); }
});
