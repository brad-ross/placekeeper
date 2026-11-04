import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const controls = {
  apparmor: '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
  clone: '/proc/sys/kernel/unprivileged_userns_clone',
  limit: '/proc/sys/user/max_user_namespaces',
};
async function readControl(path) {
  try { return (await readFile(path, 'utf8')).trim(); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** A user-owned unpacked Electron folder cannot supply a privileged setuid
 * sandbox. Require usable unprivileged namespaces before copying such a folder.
 * The deb route establishes the sandbox helper through the OS package manager. */
export async function assertLinuxUserSandbox(options = {}) {
  const read = options.readControl ?? readControl;
  const probe = options.probe ?? (() => execute('unshare', ['--user', '--map-root-user', '--', '/usr/bin/true'], { shell: false, timeout: 5000, maxBuffer: 16 * 1024 }));
  const uid = options.uid ?? process.getuid?.();
  if (uid === 0) throw new Error('Run the user-local source installer as an ordinary user; Electron cannot use its normal sandbox as root.');
  const values = {};
  try {
    for (const [name, path] of Object.entries(controls)) {
      const value = await read(path);
      if (value !== undefined && !/^\d+$/u.test(value)) throw new Error('Unrecognized namespace setting');
      values[name] = value === undefined ? undefined : BigInt(value);
    }
  } catch { throw new Error('Cannot verify Linux namespace settings for a user-local Electron installation.'); }
  if (values.apparmor !== undefined && values.apparmor !== 0n) throw new Error('AppArmor restricts unprivileged user namespaces, so this user-owned unpacked app cannot establish its Chromium sandbox.');
  if (values.clone === 0n || values.limit === 0n) throw new Error('Unprivileged user namespaces are disabled, so this user-owned unpacked app cannot establish its Chromium sandbox.');
  try { await probe(); }
  catch { throw new Error('The unshare user-namespace probe is unavailable or blocked, so the user-local Chromium sandbox could not be verified.'); }
}
