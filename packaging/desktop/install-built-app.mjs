import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { desktopExecutable, resolveLauncherRuntime } from './launcher.mjs';
const execute = promisify(execFile);
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
export function runtimeRoot(app, platform = process.platform) {
  return join(app, platform === 'darwin' ? 'Contents/Resources/desktop' : 'resources/desktop');
}

/** Called only under daemon coordinate-install's lifecycle lock after drain and
 * verified recovery backup. Never discard the prior app before exact readiness. */
export async function installBuiltApp(built, destination, readiness, port, invoke = execute, isolatedRoot) {
  if (![built, destination, readiness].every(isAbsolute) || resolve(built) === resolve(destination)) throw new Error('Expected distinct absolute app paths');
  const candidateRoot = runtimeRoot(built);
  await resolveLauncherRuntime(candidateRoot);
  if (!(await lstat(desktopExecutable(candidateRoot))).isFile()) throw new Error('Desktop executable is missing');
  const expected = process.platform === 'darwin' ? join(destination, 'Contents/MacOS/placekeeper') : join(runtimeRoot(destination), 'bin', `placekeeper${process.platform === 'win32' ? '.exe' : ''}`);
  if (resolve(readiness) !== resolve(expected)) throw new Error('Unexpected installed readiness executable');
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  if (await exists(destination) && !(await lstat(destination)).isDirectory()) throw new Error('Refusing non-directory installation');
  const transaction = await mkdtemp(join(parent, '.placekeeper-replace-'));
  const previous = join(transaction, 'previous');
  const staged = join(transaction, 'staged');
  const receipt = join(transaction, 'ready.json');
  let movedOld = false, movedNew = false, started = false, committed = false, rollbackSafe = true;
  const isolation = port === undefined ? [] : ['--isolated-installed-smoke', '--http-port', port, ...(isolatedRoot === undefined ? [] : ['--isolated-test-root', isolatedRoot])];
  try {
    await cp(built, staged, { recursive: true, verbatimSymlinks: true });
    await resolveLauncherRuntime(runtimeRoot(staged));
    if (await exists(destination)) { await rename(destination, previous); movedOld = true; }
    await rename(staged, destination); movedNew = true;
    started = true;
    await invoke(readiness, ['daemon', 'ensure-ready', '--receipt', receipt, ...isolation], { env: process.env, timeout: 30_000, maxBuffer: 65_536 });
    committed = true;
  } finally {
    if (!committed) {
      if (started) {
        try { await invoke(readiness, ['daemon', 'stop-ready', '--receipt', receipt, ...isolation], { env: process.env, timeout: 30_000, maxBuffer: 65_536 }); }
        catch { rollbackSafe = false; }
      }
      if (rollbackSafe) {
        if (movedNew) await rename(destination, join(transaction, 'failed'));
        if (movedOld) await rename(previous, destination);
      }
    }
    if (rollbackSafe) await rm(transaction, { recursive: true, force: true });
    else throw new Error(`Candidate retirement failed; preserved installation and backup at ${transaction}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [built, destination, readiness, port, isolatedRoot] = process.argv.slice(2);
  await installBuiltApp(built, destination, readiness, port, execute, isolatedRoot);
}
