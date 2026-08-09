import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { ProofreaderHost } from '../../apps/service/src/host/proofreader-host.js';

let installedHost: ProofreaderHost;
let installedLaunchUrl = '';
let installedRoot = '';

test.beforeAll(async () => {
  installedRoot = await mkdtemp(join(tmpdir(), 'warm-neutral-visual-'));
  const sourceRoot = join(installedRoot, 'source');
  await mkdir(sourceRoot);
  const pdf = join(installedRoot, 'paper.pdf');
  await copyFile(resolve('test/fixtures/pdfs/text-native-with-annotations.pdf'), pdf);
  installedHost = await ProofreaderHost.start({
    recoveryRoot: join(installedRoot, 'recovery'),
    webAssets: { root: resolve('dist/web') },
  });
  const launched = await installedHost.open({ pdfPath: pdf, sourceRootPath: sourceRoot });
  if (!launched.ok || launched.kind === 'recovery-offered') throw new Error('Visual production launch failed');
  installedLaunchUrl = launched.url;
});

test.afterAll(async () => {
  await installedHost?.close();
  if (installedRoot) await rm(installedRoot, { recursive: true, force: true });
});

async function openScene(page: Page, scene: string, viewport = { width: 1280, height: 900 }): Promise<Locator> {
  await page.setViewportSize(viewport);
  await page.goto(`/test/acceptance/review-harness/index.html?visual=${scene}`);
  const product = page.locator('[data-production-review]');
  await expect(product).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  return product;
}

async function expectScene(locator: Locator, name: string): Promise<void> {
  await expect(locator).toHaveScreenshot(name, {
    animations: 'disabled',
    maxDiffPixels: 100,
  });
}

test('wide contextual review', async ({ page }) => {
  const product = await openScene(page, 'contextual');
  await page.getByRole('button', { name: 'Highlight', exact: true }).hover();
  await page.getByRole('button', { name: 'Delete' }).focus();
  await expectScene(product, 'wide-contextual.png');
});

test('wide reading', async ({ page }) => {
  const product = await openScene(page, 'reading');
  await expectScene(product, 'wide-reading.png');
});

test('installed real PDF reading', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(installedLaunchUrl);
  const product = page.locator('[data-production-review]');
  await expect(product).toBeVisible();
  const image = page.locator("[data-page-index='0']").first().locator(':scope > img');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (
    element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
  ))).toBe(true);
  await page.evaluate(async () => { await document.fonts.ready; });
  await expectScene(product, 'installed-real-pdf.png');
});

test('wide Annotation Tray', async ({ page }) => {
  const product = await openScene(page, 'tray');
  await expect(page.locator('[data-annotation-drawer]')).toHaveAttribute('data-annotation-presentation', 'right');
  await page.getByRole('button', { name: /highlight · Page 1/u }).focus();
  await expectScene(product, 'wide-annotation-tray.png');
});

test('narrow Annotation Tray', async ({ page }) => {
  const product = await openScene(page, 'tray', { width: 320, height: 720 });
  await expect(page.locator('[data-annotation-drawer]')).toHaveAttribute('data-annotation-presentation', 'bottom');
  await page.getByRole('button', { name: /highlight · Page 1/u }).focus();
  await expectScene(product, 'narrow-annotation-tray.png');
});

test('annotation peek', async ({ page }) => {
  const product = await openScene(page, 'peek');
  await page.locator('[data-owned-focus-id="owned-highlight"]').focus();
  await expect(page.locator('[data-annotation-peek]')).toBeVisible();
  await expectScene(product, 'annotation-peek.png');
});

test('Page Note composer', async ({ page }) => {
  const product = await openScene(page, 'page-note');
  await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
  await page.getByRole('textbox', { name: 'Comment' }).fill('Add the identifying assumption and a cross-reference to Appendix Table A.12.');
  await expectScene(product, 'page-note-composer.png');
});

test('Finish and delivery', async ({ page }) => {
  const product = await openScene(page, 'finish');
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByRole('heading', { name: 'Human delivery' })).toBeVisible();
  await expectScene(product, 'finish-and-delivery.png');
});

for (const state of ['loading', 'empty', 'error'] as const) {
  test(`exceptional annotation ${state}`, async ({ page }) => {
    const product = await openScene(page, `exceptional&exception=${state}`);
    await expectScene(product, `exceptional-annotation-${state}.png`);
  });
}

for (const state of ['success', 'warning', 'error'] as const) {
  test(`exceptional delivery ${state}`, async ({ page }) => {
    const product = await openScene(page, `exceptional&exception=${state}`);
    await page.getByRole('button', { name: 'Finish' }).click();
    await page.getByRole('button', { name: 'Save reviewed copy' }).click();
    await expect(page.locator(`[data-review-status="${state}"]`)).toBeVisible();
    await expectScene(product, `exceptional-delivery-${state}.png`);
  });
}
