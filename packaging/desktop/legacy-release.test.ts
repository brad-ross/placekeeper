import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseLegacyMacPreferences } from './legacy-release.js';
import { DraftSnapshotStore } from '../../apps/service/src/recovery/draft-snapshot.js';
const fixtures = new URL('../../test/fixtures/legacy-release-0.2.4/', import.meta.url);
it('validates released preference keys and converts one-based pages without retaining authority', async () => {
  const value = JSON.parse(await readFile(new URL('preferences.json', fixtures), 'utf8'));
  expect(parseLegacyMacPreferences(value)).toEqual({ interfaceScale: 1.25, windows: [{ sourcePath: '/private/example/paper.pdf', bounds: { width: 1200, height: 900 }, maximized: false, presentation: { pageIndex: 2, zoom: 16 } }] });
  value['Placekeeper.RestorableDocumentWindows.v1'][0].sessionId = 'secret';
  expect(parseLegacyMacPreferences(value).windows).toEqual([]);
  expect(parseLegacyMacPreferences({ 'Placekeeper.AppZoom.v1': true }).interfaceScale).toBeUndefined();
  expect(parseLegacyMacPreferences({ 'Placekeeper.RestorableDocumentWindows.v1': [{ sourcePath: '/paper.pdf\0', frame: '{{0, 0}, {900, 600}}' }] }).windows).toEqual([]);
});
it('pins byte-exact released source evidence and reads each released recovery schema with the current reader', async () => {
  const ledger = JSON.parse(await readFile(new URL('ledger.json', fixtures), 'utf8'));
  expect(ledger.identity.executable).toBe('PlacekeeperMac');
  expect(ledger.commit).toBe('3e37ca4b84dde61725b8e03d87dbc3023f1d1f4f');
  for (const file of ledger.evidence) expect(createHash('sha256').update(await readFile(new URL(file.storedPath, fixtures))).digest('hex')).toBe(file.sha256);
  const root = await mkdtemp(join(tmpdir(), 'released-recovery-'));
  try {
    for (const version of [1, 2, 3]) {
      const store = new DraftSnapshotStore(join(root, `legacy00${version}`)); await store.initialize();
      await writeFile(store.currentPath, await readFile(new URL(`recovery-v${version}.json`, fixtures)));
      const recovered = await store.recover();
      expect(recovered?.schemaVersion).toBe(3);
      expect(recovered?.state.revision).toBe(7);
      expect(recovered?.source).toMatchObject({ disposition: 'local', canonicalSourcePath: '/private/example/paper.pdf' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
