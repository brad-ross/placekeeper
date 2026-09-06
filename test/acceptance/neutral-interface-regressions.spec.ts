import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PlacekeeperHost } from '../../apps/service/src/host/placekeeper-host.js';

let host: PlacekeeperHost;
let root: string;
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'neutral-interface-regressions-'));
  host = await PlacekeeperHost.start({
    recoveryRoot: join(root, 'recovery'),
    webAssets: { root: resolve(process.env.PLACEKEEPER_TEST_WEB_ASSETS ?? 'dist/web') },
  });
});
test.afterAll(async () => { await host?.close(); await rm(root, { recursive: true, force: true }); });

async function openPdf(page: Page, fixture: string) {
  const pdfPath = join(root, `${test.info().testId.replace(/[^a-z0-9]/gi, '')}.pdf`);
  await copyFile(resolve('test/fixtures/pdfs', fixture), pdfPath);
  const result = await host.open({ pdfPath });
  if (!result.ok || result.kind === 'recovery-offered') throw new Error('Fixture launch failed');
  await page.goto(result.url);
  const pdfPage = page.locator('[data-page-index="0"]').first();
  await expect(pdfPage.locator(':scope > img')).toBeVisible();
  await expect.poll(() => pdfPage.locator(':scope > img').evaluate((el) =>
    el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0)).toBe(true);
  return pdfPage;
}

test('PDF link pointer opening does not impersonate a tooltip hover', async ({ page }) => {
  await openPdf(page, 'reference-navigation.pdf');
  const link = page.getByRole('button', { name: 'Open PDF link to Primary result, Page 2', exact: true });
  await link.click();
  const action = page.getByRole('menuitem', { name: 'Open in References', exact: true });
  await expect(action).toBeFocused();
  await page.waitForTimeout(700);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await action.hover();
  await expect(page.getByRole('tooltip', { name: 'Open in References', exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await action.press('Escape');
  await expect(link).toBeFocused();
  await link.press('Enter');
  await expect(action).toBeFocused();
  await expect(page.getByRole('tooltip', { name: 'Open in References', exact: true })).toBeVisible();
});

test('search has a borderless input and equally inset clear action', async ({ page }) => {
  await openPdf(page, 'reference-navigation.pdf');
  await page.getByRole('button', { name: 'Show workspace', exact: true }).click();
  await page.getByRole('tab', { name: 'Search', exact: true }).click();
  const input = page.getByRole('searchbox', { name: 'Search this PDF' });
  await input.fill('Primary');
  const rows = page.locator('li[data-search-result]');
  await expect.poll(() => rows.count()).toBeGreaterThan(0);
  await page.mouse.move(0, 0);
  await expect(rows.first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(rows.first()).toHaveCSS('border-top-width', '0px');
  const clear = page.getByRole('button', { name: 'Clear search', exact: true });
  await expect(clear).toBeVisible();
  const geometry = await input.evaluate((el) => {
    const query = el.closest('.pdf-search__query')!;
    const button = query.querySelector('.pdf-search__clear')!;
    const q = query.getBoundingClientRect(); const b = button.getBoundingClientRect();
    const style = getComputedStyle(el); const bs = getComputedStyle(button);
    return { top: b.top - q.top, bottom: q.bottom - b.bottom, right: q.right - b.right,
      width: b.width, height: b.height, outline: style.outlineStyle, shadow: style.boxShadow,
      border: style.borderTopWidth, transform: bs.transform, inputWidth: el.getBoundingClientRect().width };
  });
  expect(geometry).toMatchObject({ top: 4, bottom: 4, right: 4, width: 28, height: 28,
    outline: 'none', shadow: 'none', border: '0px', transform: 'none' });
  await page.screenshot({ path: test.info().outputPath('search-input.png') });
  await clear.click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');
  await expect(clear).toBeHidden();
  expect((await input.boundingBox())!.width).toBeCloseTo(geometry.inputWidth, 1);
});

test('PDF text selection remains visibly colored when annotation actions appear', async ({ page }) => {
  const pdfPage = await openPdf(page, 'text-native.pdf');
  const box = (await pdfPage.boundingBox())!;
  const scale = box.width / 612;
  await page.mouse.move(box.x + 74 * scale, box.y + 97 * scale);
  await page.mouse.down();
  await page.mouse.move(box.x + 245 * scale, box.y + 97 * scale, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole('toolbar', { name: 'Selection review actions' })).toBeVisible();
  const rectangles = pdfPage.locator(':scope > div[style*="mix-blend-mode"]');
  await expect.poll(() => rectangles.count()).toBeGreaterThan(0);
  const colors = await rectangles.locator(':scope > div').evaluateAll((els) => els.map((el) => ({
    background: getComputedStyle(el).backgroundColor,
    mix: getComputedStyle(el.parentElement!).mixBlendMode,
    width: el.getBoundingClientRect().width,
    height: el.getBoundingClientRect().height,
  })));
  expect(colors.length).toBeGreaterThan(0);
  for (const color of colors) {
    expect(color.background).toBe('rgb(219, 231, 255)');
    expect(color.mix).toBe('multiply');
    expect(color.width).toBeGreaterThan(0);
    expect(color.height).toBeGreaterThan(0);
  }
  await page.screenshot({ path: test.info().outputPath('visible-pdf-selection.png') });
});

test('reference PDF selection uses the visible PDF color independently of tray selection', async ({ page }) => {
  await openPdf(page, 'reference-navigation.pdf');
  await page.getByRole('button', { name: 'Open PDF link to Primary result, Page 2', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open in References', exact: true }).click();
  await expect(page.locator('.reference-panel')).toHaveCSS('background-color', 'rgb(240, 240, 240)');
  await page.getByRole('button', { name: 'Move References to right', exact: true }).click();
  await expect(page.locator('.reference-panel')).toHaveCSS('background-color', 'rgb(240, 240, 240)');
  const viewport = page.locator('[data-reference-pdf-viewport] [data-viewer-framing-viewport]');
  await expect(page.locator('[data-reference-pdf-viewport] [data-page-index="1"] > img')).toBeVisible();
  await viewport.evaluate((el) => { el.scrollTop = 0; });
  const pdfPage = page.locator('[data-reference-pdf-viewport] [data-page-index="0"]');
  await expect(pdfPage.locator(':scope > img')).toBeVisible();
  await page.waitForTimeout(600);
  const box = (await pdfPage.boundingBox())!;
  const scale = box.width / 612;
  await page.mouse.move(box.x + 74 * scale, box.y + 57 * scale);
  await page.mouse.down();
  await page.mouse.move(box.x + 245 * scale, box.y + 57 * scale, { steps: 12 });
  await page.mouse.up();
  const rectangles = pdfPage.locator(':scope > div[style*="mix-blend-mode"] > div');
  await expect.poll(() => rectangles.count()).toBeGreaterThan(0);
  for (const color of await rectangles.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor))) {
    expect(color).toBe('rgb(219, 231, 255)');
  }
  await page.screenshot({ path: test.info().outputPath('visible-reference-selection.png') });
});
