import { open, rename, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
export interface StartupRequest {
    version: 1;
    attempt: string;
    candidateIdentity: string;
    receipt: string;
    profile: string;
    fixture: string;
}
export function parseStartupRequest(raw: string | undefined): StartupRequest | undefined {
    if (raw === undefined) return undefined;
    const value = JSON.parse(raw) as StartupRequest;
    if (value.version !== 1 || !/^[a-f0-9]{48}$/u.test(value.attempt) || !/^[a-f0-9]{64}$/u.test(value.candidateIdentity) || ![value.receipt,value.profile,value.fixture].every(path => typeof path === 'string' && isAbsolute(path))) throw new Error('Invalid installed startup request');
    return value;
}
/** Written only after the installed preload and renderer acknowledge their
 * validated document generation. A started process is never readiness. */
export async function writeStartupReceipt(request: StartupRequest, candidateIdentity: string): Promise<void> {
    if (request.candidateIdentity !== candidateIdentity) throw new Error('Installed startup identity changed');
    const temporary = `${request.receipt}.${request.attempt}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ version:1, attempt:request.attempt, candidateIdentity, pid:process.pid, rendererReady:true })); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, request.receipt);
}
export async function verifyStartupReceipt(request: StartupRequest): Promise<void> {
    const value = JSON.parse(await readFile(request.receipt, 'utf8'));
    if (value.version !== 1 || value.attempt !== request.attempt || value.candidateIdentity !== request.candidateIdentity || value.rendererReady !== true || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error('Installed shell did not acknowledge this activation attempt');
}

/** Late startup recovery is guidance only. Never restore the old recovery copy:
 * canonical user work may have advanced since successful activation. */
export async function retainedStartupRecovery(appPath: string): Promise<string | undefined> {
    const { createHash } = await import('node:crypto');
    const { dirname, join, resolve } = await import('node:path');
    const { lstat } = await import('node:fs/promises');
    const destination = resolve(appPath);
    const root = join(dirname(destination), '.placekeeper-install-transactions', createHash('sha256').update(destination).digest('hex').slice(0, 24));
    try {
        const record = JSON.parse(await readFile(join(root, 'journal.json'), 'utf8'));
        if (record.version !== 1 || record.destination !== destination || record.phase !== 'complete' || !/^[a-f0-9]{48}$/u.test(record.attempt) || !isAbsolute(record.backupRoot)) return undefined;
        const previous = join(root, record.attempt, process.platform === 'darwin' ? 'previous.app' : 'previous');
        if (record.previous !== previous) return undefined;
        const retained = await lstat(previous).then(info => info.isDirectory() && !info.isSymbolicLink(), () => false)
            ? previous : record.previousLocation?.retainedInPlace === true && isAbsolute(record.previousLocation.app) ? record.previousLocation.app : undefined;
        if (!retained || !(await lstat(retained)).isDirectory()) return undefined;
        return `A previous installation is retained at ${retained}. Close this version before opening the previous app. The verified recovery backup is at ${record.backupRoot}. Your current documents and recovery data have not been replaced. If the previous app cannot read newer recovery data, keep both copies and use a compatible version.`;
    } catch { return undefined; }
}

export async function writeStartupLoadFailure(request: StartupRequest, error: unknown, stage: 'renderer-load' | 'renderer-ready-timeout' | 'shell-retirement-timeout' = 'renderer-load'): Promise<void> {
    const file = await open(`${request.receipt}.failure`, 'wx', 0o600);
    try {
        await file.writeFile(JSON.stringify({ version:1, attempt:request.attempt, candidateIdentity:request.candidateIdentity,
            stage, url:'placekeeper-app://bundle/electron.html', message:String(error) }));
        await file.sync();
    } finally { await file.close(); }
}
