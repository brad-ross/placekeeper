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

async function expectCompoundReferenceTabs(
  page: Page,
  orientation: 'horizontal' | 'vertical',
): Promise<void> {
  const tablist = page.getByRole('tablist', { name: 'Open references' });
  await expect(tablist).toHaveAttribute('aria-orientation', orientation);
  await expect(tablist.getByRole('tab')).toHaveCount(3);
  await expect(tablist.locator(
    '.reference-tab-segment:has(> [role="tab"][aria-selected="true"])',
  )).toHaveCount(1);
  await expect(tablist.getByRole('button', { name: 'Send to main' })).toBeVisible();
  await expect(tablist.getByRole('button', { name: 'Close active reference' })).toBeVisible();
  await expect(page.locator('.reference-panel__actions')).toHaveCount(0);
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

test('unavailable viewer controls', async ({ page }) => {
  const product = await openScene(page, 'unavailable-controls');
  await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
  await expect(page.getByLabel('Current page')).toHaveText('— / —');
  await expect(page.getByLabel('Zoom level')).toHaveText('—%');
  await expectScene(product, 'unavailable-viewer-controls.png');
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
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-workspace-presentation', 'right');
  const annotation = page.getByRole('button', { name: /highlight · Page 1/u });
  await annotation.focus();
  await expect(annotation.locator('.annotation-item__page')).toHaveText('1');
  await expect(annotation.locator('.annotation-item__separator')).toHaveCount(2);
  await expect(annotation.locator('.annotation-item__section')).toHaveAttribute(
    'title',
    'Identification strategy and conditional comparison groups',
  );
  await expectScene(product, 'wide-annotation-tray.png');
});

test('narrow Annotation Tray', async ({ page }) => {
  const product = await openScene(page, 'tray', { width: 320, height: 720 });
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-workspace-presentation', 'bottom');
  const rail = page.getByRole('button', { name: /^(?:Open|Close) References tray$/u });
  if (await rail.getAttribute('aria-expanded') !== 'true') await rail.click();
  const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
  if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const annotation = page.getByRole('button', { name: /highlight · Page 1/u });
  await annotation.focus();
  const section = annotation.locator('.annotation-item__section');
  const sectionGeometry = await section.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    };
  });
  expect(sectionGeometry.clientWidth).toBeLessThanOrEqual(128);
  expect(sectionGeometry.scrollWidth).toBeGreaterThan(sectionGeometry.clientWidth);
  expect(sectionGeometry).toMatchObject({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
  await expectScene(product, 'narrow-annotation-tray.png');
});

test('wide bottom References tray', async ({ page }) => {
  const product = await openScene(page, 'reference-layout');
  await page.getByRole('button', { name: 'Open References tray' }).click();
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-reference-layout', 'wide-bottom');
  await expectCompoundReferenceTabs(page, 'vertical');
  await expectScene(product, 'wide-bottom-references.png');
});

test('wide coordinated References and tools trays', async ({ page }) => {
  const product = await openScene(page, 'reference-layout');
  await page.getByRole('button', { name: 'Open References tray' }).click();
  await page.getByRole('button', { name: 'Open right workspace' }).click();
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-reference-layout', 'wide-split');
  await expect(page.locator('#review-tools-workspace')).toBeVisible();
  await expectCompoundReferenceTabs(page, 'vertical');
  await expectScene(product, 'wide-split-reference-tools.png');
});

test('wide right-docked References tray', async ({ page }) => {
  const product = await openScene(page, 'reference-layout');
  await page.getByRole('button', { name: 'Open References tray' }).click();
  await page.getByRole('button', { name: 'Move References to right' }).click();
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-reference-layout', 'wide-right');
  await expect(page.getByRole('tab', { name: 'References', exact: true })).toBeVisible();
  await expectCompoundReferenceTabs(page, 'horizontal');
  await expectScene(product, 'wide-right-references.png');
});

test('narrow unified References tray', async ({ page }) => {
  const product = await openScene(page, 'reference-layout', { width: 760, height: 900 });
  await page.getByRole('button', { name: 'Open References tray' }).click();
  await page.getByRole('tab', { name: 'References', exact: true }).click();
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-reference-layout', 'narrow-unified');
  await expect(page.getByRole('tab', { name: 'References', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expectCompoundReferenceTabs(page, 'horizontal');
  await expectScene(product, 'narrow-unified-references.png');
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

for (const state of ['loading', 'empty', 'error'] as const) {
  test(`exceptional annotation ${state}`, async ({ page }) => {
    const product = await openScene(page, `exceptional&exception=${state}`);
    await expectScene(product, `exceptional-annotation-${state}.png`);
  });
}
