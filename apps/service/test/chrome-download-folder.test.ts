import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { chromeDownloadFolder } from '../src/browser/chrome-download-folder.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(folders: (string | undefined)[]) {
  const root = await mkdtemp(join(tmpdir(), 'placekeeper-chrome-downloads-'));
  roots.push(root);
  const profiles = folders.map((_, i) => i === 0 ? 'Default' : `Profile ${i}`);
  await writeFile(join(root, 'Local State'), JSON.stringify({ profile: { info_cache: Object.fromEntries(profiles.map(name => [name, {}])) } }));
  for (const [i, profile] of profiles.entries()) {
    await mkdir(join(root, profile));
    await writeFile(join(root, profile, 'Preferences'), JSON.stringify({ download: { default_directory: folders[i] } }));
  }
  return root;
}
it('uses a custom Chrome download folder, including spaces', async () => {
  const root = await fixture(['/Volumes/Work/PDF Downloads']);
  expect(await chromeDownloadFolder({ userDataDirectory: root, defaultFolder: '/Users/test/Downloads' }))
    .toBe('/Volumes/Work/PDF Downloads');
});
it('uses the default Downloads folder when Chrome has no override', async () => {
  const root = await fixture([undefined]);
  expect(await chromeDownloadFolder({ userDataDirectory: root, defaultFolder: '/Users/test/Downloads' }))
    .toBe('/Users/test/Downloads');
});
it('accepts profiles agreeing on a folder but never guesses between different folders', async () => {
  const root = await fixture(['/downloads', '/downloads']);
  expect(await chromeDownloadFolder({ userDataDirectory: root })).toBe('/downloads');
  await writeFile(join(root, 'Profile 1', 'Preferences'), JSON.stringify({ download: { default_directory: '/other' } }));
  expect(await chromeDownloadFolder({ userDataDirectory: root })).toBeUndefined();
});
it('does not guess when preferences are unreadable or a configured path is relative', async () => {
  const root = await fixture(['relative/path']);
  expect(await chromeDownloadFolder({ userDataDirectory: root })).toBeUndefined();
  await writeFile(join(root, 'Default', 'Preferences'), '{');
  expect(await chromeDownloadFolder({ userDataDirectory: root })).toBeUndefined();
});
