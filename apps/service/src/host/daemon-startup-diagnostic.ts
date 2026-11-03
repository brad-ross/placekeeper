import { setTimeout as delay } from 'node:timers/promises';
import type { ChildProcess } from 'node:child_process';
import { lifecycleDiagnostic } from '../desktop/lifecycle-control-command.js';

/** Isolated test startup only: drain bounded stderr without forwarding raw paths,
 * document text or Node stacks. This observer does not keep a daemon client alive.
 */
export function observeIsolatedDaemonStartup(child: ChildProcess): () => Promise<void> {
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    const chunks: Buffer[] = []; let captured = 0; let truncated = false;
    child.stderr?.on('data', (chunk: Buffer) => {
        const remaining = 16 * 1024 - captured;
        if (chunk.length > remaining) truncated = true;
        if (remaining > 0) { const kept = chunk.subarray(0, remaining); chunks.push(kept); captured += kept.length; }
    });
    (child.stderr as unknown as { unref?(): void } | null)?.unref?.();
    return async () => {
        if (child.exitCode !== null || child.signalCode !== null) await Promise.race([closed, delay(1000)]);
        const reports: unknown[] = [];
        for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
            if (!line.startsWith('[PlacekeeperDaemon] ')) continue;
            try {
                const value = JSON.parse(line.slice('[PlacekeeperDaemon] '.length));
                const safe = lifecycleDiagnostic('daemon-start', Object.assign(new Error(), {
                    name: value.errorClass, code: value.code, reason: value.reason, nativeCode: value.nativeCode,
                    diagnostic: { exceptionKind: value.exceptionKind, hresult: value.hresult },
                }));
                const cause = ['daemon-not-ready', 'daemon-exited-before-ready', 'launcher-entry-unavailable', 'lifecycle-lock-busy', 'windows-system-directory-unavailable', 'packaged-runtime-validation', 'private-storage', 'windows-native-worker', 'browser-source-private-root'].includes(value.cause) ? value.cause : 'unclassified';
                if (reports.length < 8) reports.push({ ...safe, cause });
            } catch { /* Unknown stderr remains private and is never echoed. */ }
        }
        if (reports.length === 0) {
            const raw = Buffer.concat(chunks).toString('utf8');
            const code = ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_INVALID_URL', 'ERR_DLOPEN_FAILED'].find(code => raw.includes(code));
            if (code) reports.push({ stage: 'daemon-bootstrap', code });
            else if (raw.includes('SyntaxError:')) reports.push({ stage: 'daemon-bootstrap', errorClass: 'SyntaxError' });
        }
        process.stderr.write(`[PlacekeeperDaemonStartup] ${JSON.stringify({ exitCode: child.exitCode,
            signal: child.signalCode, capturedBytes: captured, truncated, reports })}\n`);
    };
}
