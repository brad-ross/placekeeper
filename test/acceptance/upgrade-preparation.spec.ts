import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { mkdtemp, copyFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PlacekeeperHost } from '../../apps/service/src/host/placekeeper-host.js';

let vite: ViteDevServer;
let devOrigin: string;
test.beforeAll(async () => {
  // Serve current source without rebuilding or modifying installed assets.
  vite = await createServer({ server: { host: '127.0.0.1', port: 4389, strictPort: true, hmr: false }, clearScreen: false });
  await vite.listen();
  const address = vite.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Missing isolated dev server');
  devOrigin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await vite?.close(); });

async function currentSource(page: Page, electron = false) {
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    const source = path.endsWith('/assets/app.js') ? (electron ? '/test/acceptance/upgrade-preparation-harness.ts' : '/apps/web/src/production-entry.tsx') : path;
    if (source.startsWith('/test/acceptance/upgrade-preparation-harness') || source.startsWith('/apps/') || source.startsWith('/packages/') || source.startsWith('/node_modules/') || source.startsWith('/@')) {
      const response = await fetch(`${devOrigin}${source}${new URL(route.request().url()).search}`);
      await route.fulfill({ status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'text/javascript' }, body: Buffer.from(await response.arrayBuffer()) });
    } else await route.continue();
  });
}
async function composer(page: Page) {
  await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true', { timeout: 15000 });
  const canvas = page.locator('.pdf-workspace__page[data-page-index="0"]').first();
  await expect(canvas.locator('img').first()).toBeVisible({ timeout: 15000 });
  await canvas.click({ button: 'right', position: { x: 200, y: 220 } });
  await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
  return page.locator('[data-comment-composer] textarea');
}

for (const mode of ['browser', 'electron', 'failed']) test(`actual composer upgrade ${mode === 'failed' ? 'cancels failed persistence and restores both views' : mode === 'electron' ? 'keeps Electron mounted when renderer observes commit first' : 'protects final input before global commit and reopen'}`, async ({ page, context }) => {
  test.setTimeout(60000);
  const failPersistence = mode === 'failed';
  const root = await mkdtemp(join(tmpdir(), 'pk-upgrade-dom-'));
  const pdf = join(root, 'paper.pdf'); await copyFile('test/fixtures/pdfs/text-native.pdf', pdf);
  const recoveryRoot = join(root, 'recovery');
  let host = await PlacekeeperHost.start({ recoveryRoot, port: 0, webAssets: { root: resolve('dist/web') } });
  try {
    const first = await host.open({ pdfPath: pdf, fork: true });
    const second = await host.open({ pdfPath: pdf });
    if (!first.ok || first.kind === 'recovery-offered' || !second.ok || second.kind === 'recovery-offered') throw new Error('Expected live reviews');
    expect(second.sessionId).toBe(first.sessionId);
    const peer = await context.newPage();
    await Promise.all([currentSource(page, mode === 'electron'), currentSource(peer, mode === 'electron')]);
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await Promise.all([page.goto(first.url), peer.goto(second.url)]);
    const input = await composer(page); const peerInput = await composer(peer);
    await peerInput.fill('peer draft before upgrade');
    await expect.poll(() => host.broker.state(first.sessionId)?.pendingDrafts.some(d => d.text === 'peer draft before upgrade')).toBe(true);
    // Stagger the two real poll loops: the later host changes the revision after
    // the first acknowledgement, requiring reproof without another local write.
    let preparationStarted = false;
    const ownerSettled = Promise.withResolvers<void>();
    page.on('response', response => { if (response.url().endsWith('/upgrade/settle')) ownerSettled.resolve(); });
    await peer.route('**/upgrade/poll', async route => {
      if (preparationStarted) await ownerSettled.promise;
      await route.continue();
    });
    // Suspend all further repaint callbacks, as hidden documents may do. Input
    // settlement and cancellation must still run through the runtime poll loop.
    await Promise.all([page, peer].map(p => p.evaluate(() => { window.requestAnimationFrame = () => 1; })));
    await input.fill('final DOM value immediately before preparation');
    const original = host.broker.protectChromeReview.bind(host.broker);
    if (failPersistence) host.broker.protectChromeReview = async () => { throw new Error('Injected durable persistence failure'); };
    host.upgradeParticipants.refresh();
    const attempt = host.upgradePreparation.preview('development', { daemonIdentity: 'a'.repeat(64), installArtifactIdentity: 'b'.repeat(64) });
    expect(attempt.participants.length).toBeGreaterThanOrEqual(2);
    preparationStarted = true;
    host.upgradePreparation.begin(attempt, true);
    await host.prepareUpgradeTasks();
    await expect.poll(() => { const status = host.upgradePreparation.status(attempt); return status.phase === 'canceled' && !failPersistence ? status.reason : status.phase; }, { timeout: 10000 }).toBe(failPersistence ? 'canceled' : 'ready');
    host.broker.protectChromeReview = original;
    if (failPersistence) {
      for (const editor of [input, peerInput]) {
        await expect.poll(() => editor.evaluate(e => e.closest('[inert]') === null)).toBe(true);
        await editor.fill('editable after failed upgrade');
        await expect(editor).toHaveValue('editable after failed upgrade');
      }
      expect(host.lifecycle.admissionAllowed()).toBe(true);
    } else {
      const files = await readdir(join(recoveryRoot, first.sessionId));
      const snapshots = await Promise.all(files.filter(f => f.endsWith('.json')).map(f => readFile(join(recoveryRoot, first.sessionId, f), 'utf8')));
      expect(snapshots.join('\n')).toContain('final DOM value immediately before preparation');
      expect(snapshots.join('\n')).toContain('peer draft before upgrade');
      expect(host.broker.state(first.sessionId)?.pendingDrafts).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'final DOM value immediately before preparation' })]));
      host.upgradePreparation.commit(attempt);
      if (mode === 'electron') {
        // Wait beyond multiple renderer polls while native main deliberately has
        // not observed commit. Settlement callbacks must remain registered.
        await page.waitForTimeout(1200);
        for (const surface of [page, peer]) {
          await expect(surface.locator('[data-production-review]')).toBeVisible();
          expect(await surface.evaluate(() => (window as typeof window & { __upgradeLifecycle: unknown }).__upgradeLifecycle)).toEqual({ disposed: 0, closeRequested: 0 });
        }
      } else {
        await expect(page.getByText('This review was protected and closed for the upgrade.', { exact: false })).toBeVisible();
        await expect(peer.getByText('This review was protected and closed for the upgrade.', { exact: false })).toBeVisible();
      }
      await Promise.all([page.close(), peer.close()]);
      await host.close();
      host = await PlacekeeperHost.start({ recoveryRoot, port: 0, webAssets: { root: resolve('dist/web') } });
      const offer = await host.open({ pdfPath: pdf });
      if (!offer.ok || offer.kind !== 'recovery-offered') throw new Error('Expected durable recovery offer after service restart');
      const reopened = await host.open({ pdfPath: pdf, recovery: 'resume', recoveryOffer: offer.recoveryOffer, recoveryOperationId: randomUUID() });
      if (!reopened.ok || reopened.kind === 'recovery-offered') throw new Error('Expected resumed review');
      const reopenedPage = await context.newPage(); await currentSource(reopenedPage); await reopenedPage.goto(reopened.url);
      await expect(reopenedPage.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true', { timeout: 15000 });
      expect(host.broker.state(reopened.sessionId)?.pendingDrafts).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: 'final DOM value immediately before preparation' }),
        expect.objectContaining({ text: 'peer draft before upgrade' }),
      ]));
    }
    expect(errors).toEqual([]);
  } finally { await context.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});
