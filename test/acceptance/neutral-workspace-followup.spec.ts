import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PlacekeeperHost } from '../../apps/service/src/host/placekeeper-host.js';

let host: PlacekeeperHost;
let root: string;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'neutral-workspace-followup-'));
  host = await PlacekeeperHost.start({
    recoveryRoot: join(root, 'recovery'),
    webAssets: { root: resolve(process.env.PLACEKEEPER_TEST_WEB_ASSETS ?? 'dist/web') },
  });
});

test.afterAll(async () => {
  await host?.close();
  await rm(root, { recursive: true, force: true });
});

async function openPdf(page: Page) {
  const pdfPath = join(root, `${test.info().testId.replace(/[^a-z0-9]/giu, '')}.pdf`);
  await copyFile(resolve('test/fixtures/pdfs/reference-navigation.pdf'), pdfPath);
  const result = await host.open({ pdfPath });
  if (!result.ok || result.kind === 'recovery-offered') throw new Error('Fixture launch failed');
  await page.goto(result.url);
  const pdfPage = page.locator('[data-page-index="0"]').first();
  await expect(pdfPage.locator(':scope > img')).toBeVisible();
  await expect.poll(() => pdfPage.locator(':scope > img').evaluate((element) => (
    element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
  ))).toBe(true);
}

async function openReference(page: Page) {
  await page.getByRole('button', {
    name: 'Open PDF link to Primary result, Page 2',
    exact: true,
  }).click();
  await page.getByRole('menuitem', { name: 'Open in References', exact: true }).click();
  await expect(page.getByRole('tab', {
    name: 'Primary result, Page 2',
    exact: true,
  })).toBeVisible();
}

test('unified bottom workspace keeps the horizontal tray surface', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 900 });
  await openPdf(page);
  await openReference(page);
  await expect(page.locator('[data-review-stage]')).toHaveAttribute(
    'data-reference-layout',
    'narrow-unified',
  );
  await page.getByRole('tab', { name: 'Outline', exact: true }).click();

  const colors = await page.locator('.review-tools-workspace').evaluate((workspace) => {
    const panel = workspace.querySelector<HTMLElement>('.review-workspace__panel:not([hidden])');
    const references = workspace.ownerDocument.querySelector<HTMLElement>('.review-workspace');
    if (!panel || !references) throw new Error('Unified workspace surfaces are missing');
    return {
      panel: getComputedStyle(panel).backgroundColor,
      references: getComputedStyle(references).backgroundColor,
    };
  });
  expect(colors).toEqual({ panel: 'rgb(240, 240, 240)', references: 'rgb(240, 240, 240)' });
});

test('bottom and right Reference tabs share compact geometry and intent actions', async ({
  page,
  browserName,
}) => {
  const forwardTab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPdf(page);
  await openReference(page);
  const tab = page.getByRole('tab', { name: 'Primary result, Page 2', exact: true });
  const segment = page.locator('.reference-tab-segment--compound');
  const action = segment.locator('.reference-tab-segment__action').first();
  const inspect = () => segment.evaluate((row) => {
    const bounds = row.getBoundingClientRect();
    const button = row.querySelector<HTMLElement>('.reference-tab-segment__action:last-child');
    if (!button) throw new Error('Reference action is missing');
    const actionBounds = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      rowHeight: bounds.height,
      actionTop: actionBounds.top - bounds.top,
      actionRight: bounds.right - actionBounds.right,
      actionBottom: bounds.bottom - actionBounds.bottom,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
    };
  });

  await expect(page.getByRole('tablist', { name: 'Open references' }))
    .toHaveAttribute('aria-orientation', 'vertical');
  await expect(page.locator('.reference-tabs')).toHaveCSS('width', '184px');
  await page.locator('.review-chrome__page-input').focus();
  await page.mouse.move(0, 0);
  await expect.poll(inspect).toMatchObject({
    rowHeight: 32,
    actionTop: 3,
    actionRight: 3,
    actionBottom: 3,
    opacity: '0',
    pointerEvents: 'none',
  });
  await segment.hover();
  await expect(action).toHaveCSS('opacity', '1');
  await expect(action).toHaveCSS('pointer-events', 'auto');
  await page.mouse.move(0, 0);
  await tab.focus();
  await page.keyboard.press(forwardTab);
  await expect(action).toBeFocused();
  await expect(action).toHaveCSS('opacity', '1');

  const moveRight = page.getByRole('button', { name: 'Move References to right', exact: true });
  await page.getByRole('tab', { name: 'References', exact: true }).focus();
  await page.keyboard.press(forwardTab);
  await expect(moveRight).toBeFocused();
  await expect(moveRight).toHaveCSS('opacity', '1');
  await moveRight.press('Enter');
  await expect(page.getByRole('tablist', { name: 'Open references' }))
    .toHaveAttribute('aria-orientation', 'horizontal');
  await expect.poll(inspect).toMatchObject({
    rowHeight: 32,
    actionTop: 3,
    actionRight: 3,
    actionBottom: 3,
  });
  await expect(tab).toBeVisible();
});

test('workspace rows use Outline selection, hover, focus, and resize treatments', async ({
  page,
  browserName,
}) => {
  const forwardTab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  const backwardTab = browserName === 'webkit' ? 'Shift+Alt+Tab' : 'Shift+Tab';
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPdf(page);
  await openReference(page);

  const bottomTray = page.locator('.review-workspace');
  const bottomHandle = page.locator('[data-reference-resize-handle="bottom"]');
  // Resize feedback follows the full rounded tray edge.
  const bottomCorners = await Promise.all([bottomTray.boundingBox(), bottomHandle.boundingBox()]);
  expect(bottomCorners[0]).not.toBeNull();
  expect(bottomCorners[1]).not.toBeNull();
  expect(bottomCorners[1]!.x - bottomCorners[0]!.x).toBeCloseTo(0, 0);
  expect(bottomCorners[0]!.x + bottomCorners[0]!.width
    - bottomCorners[1]!.x - bottomCorners[1]!.width).toBeCloseTo(0, 0);

  const moveRight = page.getByRole('button', { name: 'Move References to right', exact: true });
  await page.getByRole('tab', { name: 'References', exact: true }).focus();
  await page.keyboard.press(forwardTab);
  await expect(moveRight).toBeFocused();
  await moveRight.press('Enter');
  const rightTray = page.locator('.review-workspace');
  const rightHandle = page.locator('[data-reference-resize-handle="right"]');
  const rightCorners = await Promise.all([rightTray.boundingBox(), rightHandle.boundingBox()]);
  expect(rightCorners[0]).not.toBeNull();
  expect(rightCorners[1]).not.toBeNull();
  expect(rightCorners[1]!.y - rightCorners[0]!.y).toBeCloseTo(0, 0);
  expect(rightCorners[0]!.y + rightCorners[0]!.height
    - rightCorners[1]!.y - rightCorners[1]!.height).toBeCloseTo(0, 0);

  await page.getByRole('tab', { name: 'Search', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search this PDF' });
  await search.fill('target');
  const results = page.locator('li[data-search-result]');
  await expect.poll(() => results.count()).toBeGreaterThan(1);
  const first = results.first();
  const second = results.nth(1);
  const firstNavigation = first.locator('.annotation-item__navigation');
  const firstActions = first.locator('.row-action-group__direct');

  await second.hover();
  await expect(second).toHaveCSS('background-color', 'rgb(231, 231, 231)');
  await firstNavigation.click();
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tab', { name: 'Search', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(first).toBeVisible();
  await expect(first).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(firstNavigation).not.toBeFocused();
  await expect(firstNavigation).toHaveCSS('outline-style', 'none');
  await expect(firstActions).toHaveCSS('opacity', '0');
  await first.hover();
  await expect(first).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(firstActions).toHaveCSS('opacity', '1');
  await page.mouse.move(0, 0);
  await firstNavigation.focus();
  await page.keyboard.press(forwardTab);
  await page.keyboard.press(backwardTab);
  await expect(firstNavigation).toBeFocused();
  await expect(firstNavigation).toHaveCSS('outline-style', 'solid');
  await expect(firstActions).toHaveCSS('opacity', '1');

  await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
  const annotationRows = page.locator('li[data-annotation-origin]');
  await expect.poll(() => annotationRows.count()).toBeGreaterThan(0);
  for (const content of await annotationRows.evaluateAll((rows) => rows.map((row) => (
    getComputedStyle(row, '::before').content
  )))) expect(content).toBe('none');
});
