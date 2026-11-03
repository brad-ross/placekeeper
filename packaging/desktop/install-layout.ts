import { cp, lstat, mkdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, posix, win32 } from 'node:path';

export interface InstallLayoutOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
}
export function resolveInstallLayout(options: InstallLayoutOptions = {}) {
  const platform = options.platform ?? process.platform;
  const path = platform === 'win32' ? win32 : posix;
  const home = options.homeDirectory ?? homedir();
  const env = options.env ?? process.env;
  const absolute = (value: string | undefined, fallback: string) => value && path.isAbsolute(value) && !value.includes('\0') ? value : fallback;
  const local = absolute(env.LOCALAPPDATA, path.join(home, 'AppData', 'Local'));
  const supportRoot = platform === 'darwin' ? path.join(home, 'Library/Application Support/Placekeeper')
    : platform === 'win32' ? path.join(local, 'Placekeeper')
    : path.join(absolute(env.XDG_STATE_HOME, path.join(home, '.local/state')), 'placekeeper');
  if (env.PLACEKEEPER_INSTALL_ROOT !== undefined && (!path.isAbsolute(env.PLACEKEEPER_INSTALL_ROOT) || env.PLACEKEEPER_INSTALL_ROOT.includes('\0'))) throw new Error('Expected an absolute installation destination');
  const parent = absolute(env.PLACEKEEPER_INSTALL_ROOT, platform === 'darwin' ? path.join(home, 'Applications')
    : platform === 'win32' ? path.join(local, 'Programs') : path.join(home, '.local/share'));
  const electronProfileRoot = platform === 'darwin' ? supportRoot : platform === 'win32'
    ? path.join(absolute(env.APPDATA, path.join(home, 'AppData/Roaming')), 'Placekeeper')
    : path.join(absolute(env.XDG_CONFIG_HOME, path.join(home, '.config')), 'Placekeeper');
  return { electronProfileRoot, protectedRoots: [...new Set([supportRoot, electronProfileRoot])], destination: path.join(parent, platform === 'darwin' ? 'Placekeeper.app' : platform === 'win32' ? 'Placekeeper' : 'placekeeper'), supportRoot,
    recoveryRoot: path.join(supportRoot, 'recovery'), backupRoot: path.join(supportRoot, 'installer'),
    legacySourceRoot: platform === 'win32' ? path.join(local, 'Placekeeper') : undefined };
}
export function assertSafeInstallDestination(destination: string, options: InstallLayoutOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const path = platform === 'win32' ? win32 : posix;
  if (!path.isAbsolute(destination) || destination.includes('\0')) throw new Error('Expected an absolute installation destination');
  const { protectedRoots } = resolveInstallLayout(options);
  const normalize = (value: string) => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const a = normalize(destination);
  const contains = (parent: string, child: string) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
  if (protectedRoots.some(root => { const b = normalize(root); return contains(a, b) || contains(b, a); })) throw new Error('Installation destination overlaps durable user state or recovery backups');
}
/** Resolve existing ancestors too: a parent symlink must not redirect replacement into data. */
export async function assertSafeInstallDestinationOnDisk(destination: string, options: InstallLayoutOptions = {}): Promise<void> {
  assertSafeInstallDestination(destination, options);
  async function canonical(path: string): Promise<string> {
    try { return await realpath(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = dirname(path); if (parent === path) throw error; return join(await canonical(parent), basename(path)); }
  }
  const actual = await canonical(destination);
  const protectedRoots = await Promise.all(resolveInstallLayout(options).protectedRoots.map(canonical));
  // Keep the same disjointness rule for symlink-resolved roots.
  const relative = (parent: string, child: string) => { const p = process.platform === 'win32' ? win32 : posix; const value = p.relative(parent, child); return value === '' || (!value.startsWith(`..${p.sep}`) && value !== '..' && !p.isAbsolute(value)); };
  if (protectedRoots.some(root => relative(actual, root) || relative(root, actual))) throw new Error('Installation destination overlaps durable user state or recovery backups');
}
function ownedPath(root: string, entry: string): string {
  if (!entry || entry.includes('\\') || entry.includes('\0') || posix.isAbsolute(entry) || entry.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe installation inventory path');
  if (['recovery', 'browser-sources', 'electron', 'installer', 'settings', 'documents'].includes(entry.split('/')[0]!.toLowerCase())) throw new Error('Inventory cannot own durable user state');
  return join(root, ...entry.split('/'));
}
async function existingFile(root: string, entry: string): Promise<string | undefined> {
  const file = ownedPath(root, entry);
  const rootStat = await lstat(root).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!rootStat) return undefined;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Installation inventory root must be a directory, not a symbolic link');
  let current = root;
  for (const part of entry.split('/')) {
    current = join(current, part);
    try { const stat = await lstat(current); if (stat.isSymbolicLink()) throw new Error('Installation inventory traverses a symbolic link'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  if (!(await lstat(file)).isFile()) throw new Error('Installation inventory must name individual files');
  return file;
}
/** A manifest lists files, never ownership of a directory's unknown descendants. */
export async function removeOwnedInstallationFiles(root: string, ownedFiles: readonly string[]): Promise<void> {
  const files = await Promise.all(ownedFiles.map(entry => existingFile(root, entry)));
  for (const file of files) if (file) {
    await unlink(file);
    for (let parent = dirname(file); parent !== root; parent = dirname(parent)) {
      try { await rmdir(parent); } catch (error) { if (['ENOTEMPTY', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) break; throw error; }
    }
  }
}
/** Caller holds the installation lease and has retired the old host. Destination
 * is the retained previous-version tree; activation and rollback belong to the caller. */
export async function relocateLegacySourceInstallation({ legacyRoot, destination, ownedFiles }: { legacyRoot: string; destination: string; ownedFiles: readonly string[] }): Promise<void> {
  if (join(legacyRoot, '.') === join(destination, '.')) throw new Error('Relocation needs distinct paths');
  const files = await Promise.all(ownedFiles.map(entry => existingFile(legacyRoot, entry)));
  // Copy exclusively before removing anything; failures retain the original usable installation.
  for (const [index, file] of files.entries()) if (file) {
    const target = ownedPath(destination, ownedFiles[index]!);
    await mkdir(dirname(target), { recursive: true });
    await cp(file, target, { force: false, errorOnExist: true });
  }
  await removeOwnedInstallationFiles(legacyRoot, ownedFiles);
}
