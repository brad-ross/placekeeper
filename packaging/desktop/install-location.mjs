import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const transactionsName = '.placekeeper-install-transactions';

export function installTransactionRoot(destination) {
  const hash = createHash('sha256').update(destination).digest('hex').slice(0, 24);
  return join(dirname(destination), transactionsName, hash);
}

/** A downloaded, staged, or retained copy has no completed install at its path. */
export function macAppHasCompletedInstallation(bundle) {
  try {
    const app = realpathSync(bundle);
    const { dev, ino } = lstatSync(app, { bigint: true });
    const identity = JSON.parse(readFileSync(join(app, 'Contents/Resources/desktop/runtime-manifest.json'), 'utf8')).installArtifactIdentity;
    if (!/^[a-f0-9]{64}$/u.test(identity)) return false;
    const root = installTransactionRoot(app);
    const parent = dirname(root);
    if (!lstatSync(parent).isDirectory()) return false;
    function authorizes(directory) {
      try {
        if (!lstatSync(directory).isDirectory()) return false;
        const record = JSON.parse(readFileSync(join(directory, 'journal.json'), 'utf8'));
        return record.version === 1 && record.installed?.identity === identity &&
          record.installed.device === String(dev) && record.installed.inode === String(ino) &&
          ['complete', 'staging', 'restored'].includes(record.phase) &&
          realpathSync(record.destination) === app;
      } catch {
        return false;
      }
    }
    if (authorizes(root)) return true;
    // An explicit install destination can use a symlink to the parent folder.
    // The journal is beside the real app, but keyed by the path used to install.
    return readdirSync(parent, { withFileTypes: true }).some(entry =>
      entry.isDirectory() && /^[a-f0-9]{24}$/u.test(entry.name) &&
      join(parent, entry.name) !== root && authorizes(join(parent, entry.name)));
  } catch {
    return false;
  }
}
