import { encodePlacekeeperLink } from "../../packages/core/src/placekeeper-link.js";
import { requestControl } from "../../apps/service/src/host/launch-control.js";
import { watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { InstalledCandidate } from './electron-installed-harness.js';

test('saved window bounds, page, and zoom survive transient startup defaults', async ({}, testInfo) => {
  const candidate = await InstalledCandidate.create('multi-page-text.pdf');
  const stateDirectory = join(candidate.root, 'electron-user-data');
  const statePath = join(stateDirectory, 'windows.json');
  const bounds = { x: 40, y: 60, width: 1000, height: 760 };
  const presentation = { pageIndex: 1, zoom: 1.25 };
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(statePath, JSON.stringify([{ sourcePath: candidate.source, bounds, maximized: false, presentation }]));
  const observed: Array<{ bounds: typeof bounds; presentation?: typeof presentation }> = [];
  const reads: Promise<void>[] = [];
  const watcher = watch(stateDirectory, (_event, name) => {
    if (name?.toString() !== 'windows.json') return;
    reads.push(readFile(statePath, 'utf8').then(text => {
      const state = JSON.parse(text) as Array<{ bounds: typeof bounds; presentation?: typeof presentation }>;
      if (state[0]) observed.push(state[0]);
    }));
  });
  try {
    const page = await candidate.launch({ restoreSavedWindows: true });
    await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true', { timeout: 30_000 });
    await expect(page.locator('.review-chrome__page-input')).toHaveValue('2');
    await expect(page.locator('.review-chrome__zoom-input')).toHaveValue('125');
    await expect.poll(() => page.evaluate(() => window.placekeeper.identity())).toMatchObject({ presentation });
    await expect.poll(() => observed.length).toBeGreaterThan(0);
    watcher.close();
    await Promise.all(reads);
    for (const state of observed) {
      expect(state.presentation).toEqual(presentation);
      expect(state.bounds).toEqual(bounds);
    }
    const restored = JSON.parse(await readFile(statePath, 'utf8')) as Array<{ bounds: typeof bounds; presentation: typeof presentation }>;
    expect(restored[0]).toMatchObject({ bounds, presentation });
    await page.screenshot({ path: testInfo.outputPath('restored-window.png') });
    await testInfo.attach('restored-window', { path: testInfo.outputPath('restored-window.png'), contentType: 'image/png' });
    await testInfo.attach('startup-presentation-observations', { body: JSON.stringify(observed.map(state => ({ bounds: state.bounds, presentation: state.presentation }))), contentType: 'application/json' });

    // A subsequent explicit task/link open chooses its own destination; saved
    // presentation is an initial-restoration input, not an ongoing override.
    const focused = await requestControl(join(candidate.root, 'control.sock'), { kind: 'link-open', request: {
      link: encodePlacekeeperLink({ path: candidate.source, location: { kind: 'page', page: 1 } }), confirmed: true, desktop: 'electron',
    } });
    if (focused.kind !== 'link-open' || !focused.response.ok || !('launchId' in focused.response)) throw new Error('Explicit focused link was not staged');
    const originalIdentity = await page.evaluate(() => window.placekeeper.identity());
    await candidate.openLaunch(focused.response.launchId);
    await expect(page.locator('.review-chrome__page-input')).toHaveValue('1');
    await expect.poll(() => page.evaluate(() => window.placekeeper.identity())).toMatchObject({ windowId: originalIdentity.windowId, presentation: { pageIndex: 0 } });
  } finally { watcher.close(); await Promise.all(reads); await candidate.dispose(); }
});
