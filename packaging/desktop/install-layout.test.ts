import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { assertSafeInstallDestination, assertSafeInstallDestinationOnDisk, relocateLegacySourceInstallation, removeOwnedInstallationFiles, resolveInstallLayout } from './install-layout.js';

it('separates Windows executable installation from the published durable support root', () => {
  const options = { platform: 'win32' as const, homeDirectory: 'C:\\Users\\Reader', env: { LOCALAPPDATA: 'C:\\Users\\Reader\\AppData\\Local' } };
  expect(() => resolveInstallLayout({ ...options, env: { PLACEKEEPER_INSTALL_ROOT: 'relative' } })).toThrow('absolute');
  expect(resolveInstallLayout(options).destination).toBe('C:\\Users\\Reader\\AppData\\Local\\Programs\\Placekeeper');
  for (const destination of ['C:\\Users\\Reader\\AppData\\Local', 'C:\\Users\\Reader\\AppData\\Local\\Placekeeper', 'C:\\Users\\Reader\\AppData\\Local\\Placekeeper\\installer\\backup', 'C:\\Users\\Reader\\AppData\\Roaming\\Placekeeper']) {
    expect(() => assertSafeInstallDestination(destination, options)).toThrow('durable');
  }
});
it('relocates and removes only inventoried application files while preserving collocated user work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'install-layout-'));
  try {
    const legacyRoot = join(root, 'Placekeeper'); const destination = join(root, 'Programs/Placekeeper');
    for (const file of ['resources/desktop/service.js', 'recovery/draft.json', 'browser-sources/source.pdf', 'installer/recovery-backup-1/draft.json', 'sentinel.txt']) {
      await mkdir(join(legacyRoot, file, '..'), { recursive: true }); await writeFile(join(legacyRoot, file), file);
    }
    await relocateLegacySourceInstallation({ legacyRoot, destination, ownedFiles: ['resources/desktop/service.js'] });
    await removeOwnedInstallationFiles(destination, ['resources/desktop/service.js']);
    for (const file of ['recovery/draft.json', 'browser-sources/source.pdf', 'installer/recovery-backup-1/draft.json', 'sentinel.txt']) expect(await readFile(join(legacyRoot, file), 'utf8')).toBe(file);
    await expect(removeOwnedInstallationFiles(legacyRoot, ['../sentinel.txt'])).rejects.toThrow();
    await expect(removeOwnedInstallationFiles(legacyRoot, ['recovery/draft.json'])).rejects.toThrow('durable');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('refuses a destination redirected into durable state before creating files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'install-alias-'));
  try {
    const support = join(root, '.local/state/placekeeper');
    await mkdir(support, { recursive: true });
    await symlink(support, join(root, 'alias'));
    await expect(assertSafeInstallDestinationOnDisk(join(root, 'alias/app'), { platform: 'linux', homeDirectory: root, env: {} })).rejects.toThrow('durable');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('protects the existing Linux Electron profile as well as the service state', () => {
  expect(() => assertSafeInstallDestination('/home/reader/.config/Placekeeper/app', { platform: 'linux', homeDirectory: '/home/reader', env: {} })).toThrow('durable');
});
