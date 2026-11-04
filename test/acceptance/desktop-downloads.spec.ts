import { expect, test } from '@playwright/test';
import { desktopAssetNames, RELEASE_API_URL, RELEASE_REPOSITORY } from '../../packages/core/src/desktop-release.js';

function fixture() {
  const version = '1.2.3';
  return { draft: false, prerelease: false, tag_name: `v${version}`, html_url: `${RELEASE_REPOSITORY}/releases/tag/v${version}`, assets: [...Object.values(desktopAssetNames(version)), 'SHA256SUMS'].map(name => ({ name, state: 'uploaded', size: 123, browser_download_url: `${RELEASE_REPOSITORY}/releases/download/v${version}/${name}` })) };
}
for (const width of [1440, 390]) test(`@critical desktop downloads keep architecture choices and keyboard access at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.route(RELEASE_API_URL, route => route.fulfill({ json: fixture() }));
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { value: 'Macintosh Intel Mac OS X' }));
  await page.goto('./');
  const trigger = page.getByRole('button', { name: 'Install', exact: true }).first();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Install Placekeeper' });
  await expect(dialog).toContainText('About This Mac');
  await expect(dialog.getByRole('link', { name: 'macOS Apple Silicon', exact: true })).toHaveAttribute('href', /macos-arm64.dmg$/);
  await expect(dialog.getByRole('link', { name: 'macOS Intel', exact: true })).toHaveAttribute('href', /macos-x64.dmg$/);
  await expect(dialog.getByRole('link', { name: 'Windows x64', exact: true })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Ubuntu / Debian x64', exact: true })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'SHA256 checksums' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`downloads-${width}.png`), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.mouse.click(2, 2);
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('@critical unavailable desktop metadata exposes source and policy guidance without guessed assets', async ({ page }) => {
  await page.route(RELEASE_API_URL, route => route.fulfill({ json: { ...fixture(), assets: [] } }));
  await page.goto('./');
  await page.getByRole('button', { name: 'Install', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Install Placekeeper' });
  await expect(dialog).toContainText('Desktop downloads are unavailable');
  await expect(dialog).toContainText('Historical release 0.2.4');
  await expect(dialog.locator('a[href*="/releases/download/"]')).toHaveCount(0);
  await expect(dialog).toContainText('source builds are subject to the same policy');
  await expect(dialog).toContainText('no autosave or reload recovery');
  await expect(dialog.getByRole('link', { name: 'source prerequisites and sandbox requirements' })).toBeVisible();
});

test('@critical Windows x64 visitor gets a matching primary download', async ({ page }) => {
  await page.route(RELEASE_API_URL, route => route.fulfill({ json: fixture() }));
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { value: 'Windows NT 10.0; Win64; x64' }));
  await page.goto('./');
  await page.getByRole('button', { name: 'Download for Windows x64', exact: true }).first().click();
  await expect(page.getByRole('dialog').getByRole('link', { name: 'Download for Windows x64', exact: true })).toHaveAttribute('href', /windows-x64-Setup.exe$/);
});
