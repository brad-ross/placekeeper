import { expect, test, type Page } from '@playwright/test';
import { desktopAssetNames, RELEASE_API_URL, RELEASE_REPOSITORY } from '../../packages/core/src/desktop-release.js';

function fixture() {
  const version = '1.2.3';
  return { draft: false, prerelease: false, tag_name: `v${version}`, html_url: `${RELEASE_REPOSITORY}/releases/tag/v${version}`, assets: [...Object.values(desktopAssetNames(version)), 'SHA256SUMS'].map(name => ({ name, state: 'uploaded', size: 123, browser_download_url: `${RELEASE_REPOSITORY}/releases/download/v${version}/${name}` })) };
}
async function identity(page: Page, userAgent: string, platform = '', maxTouchPoints = 0) {
  await page.addInitScript(({ userAgent, platform, maxTouchPoints }) => {
    for (const [key, value] of Object.entries({ userAgent, platform, maxTouchPoints })) Object.defineProperty(navigator, key, { value, configurable: true });
  }, { userAgent, platform, maxTouchPoints });
}
function controls(page: Page) {
  const root = page.locator('.landing-download').first();
  return { root, main: root.locator('.landing-download__main'), toggle: root.getByRole('button', { name: 'Other download options' }), panel: root.getByRole('navigation', { name: 'Placekeeper downloads' }) };
}
async function footer(page: Page) {
  const { panel } = controls(page);
  await expect(panel.getByRole('link', { name: 'Build from source' })).toHaveAttribute('href', `${RELEASE_REPOSITORY}/blob/main/docs/installation.md`);
  await expect(panel.getByRole('link', { name: 'All releases', exact: true })).toHaveAttribute('href', `${RELEASE_REPOSITORY}/releases`);
  await expect(panel).not.toContainText(/About This Mac|Historical release|prerequisites|upgrade|Copy command/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

for (const width of [1440, 390, 320]) test(`@critical desktop downloads keep architecture choices and keyboard access at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.route(RELEASE_API_URL, route => route.fulfill({ json: fixture() }));
  await identity(page, 'Macintosh Intel Mac OS X');
  await page.goto('./');
  const { root, main, toggle, panel } = controls(page);
  await expect(main).toHaveAttribute('href', /macos-arm64.dmg$/);
  await expect(main).toHaveText('Download for macOS Apple Silicon');
  await page.screenshot({ path: testInfo.outputPath(`downloads-${width}-closed.png`), fullPage: true });
  // Native Tab activation: the primary anchor precedes the separately operable chevron.
  await main.focus();
  await page.keyboard.press('Tab');
  await expect(toggle).toBeFocused();
  expect(await toggle.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('link', { name: 'macOS Apple Silicon', exact: true })).toBeFocused();
  await expect(panel.getByRole('link', { name: 'macOS Intel', exact: true })).toHaveAttribute('href', /macos-x64.dmg$/);
  await expect(panel.getByRole('link', { name: 'Windows x64', exact: true })).toHaveAttribute('href', /windows-x64-Setup.exe$/);
  await expect(panel.getByRole('link', { name: 'Linux Debian / Ubuntu x64', exact: true })).toHaveAttribute('href', /linux-x64.deb$/);
  await footer(page);
  const bounds = (await panel.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const segments = await root.locator('.landing-download__segments').evaluate(element => {
    const main = element.children[0]!.getBoundingClientRect();
    const toggle = element.children[1]!.getBoundingClientRect();
    return { gap: toggle.left - main.right, top: toggle.top - main.top, height: toggle.height - main.height };
  });
  expect(Math.abs(segments.gap)).toBeLessThan(1);
  expect(Math.abs(segments.top)).toBeLessThan(1);
  expect(Math.abs(segments.height)).toBeLessThan(1);
  await expect(page.getByRole('link', { name: /GitHub/ }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`downloads-${width}-open.png`), fullPage: true });
  await page.screenshot({ path: testInfo.outputPath(`downloads-${width}-viewport.png`) });
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(panel).toBeVisible();
  await panel.getByRole('link', { name: 'All releases', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(panel).toBeHidden();
  expect(await root.evaluate(element => element.contains(document.activeElement))).toBe(false);
  await toggle.click();
  const outside = page.getByRole('textbox', { name: 'Document URL' });
  await outside.click();
  await expect(panel).toBeHidden();
  await expect(outside).toBeFocused();
  const toggles = page.getByRole('button', { name: 'Other download options' });
  expect(await toggles.nth(0).getAttribute('aria-controls')).not.toBe(await toggles.nth(1).getAttribute('aria-controls'));
  await toggles.first().click();
  await toggles.nth(1).click();
  await expect(toggles.first()).toHaveAttribute('aria-expanded', 'false');
  await expect(toggles.nth(1)).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(toggles.nth(1)).toBeFocused();
});

for (const [ua, label, suffix] of [
  ['Windows NT 10.0; Win64; x64', 'Windows x64', 'windows-x64-Setup.exe'],
  ['X11; Linux x86_64', 'Linux Debian / Ubuntu x64', 'linux-x64.deb'],
] as const) test(`@critical ${label} visitor activates a matching primary download directly`, async ({ page }) => {
  await page.route(RELEASE_API_URL, route => route.fulfill({ json: fixture() }));
  await identity(page, ua);
  let requested = false;
  await page.route(`**/releases/download/v1.2.3/*${suffix}`, route => {
    requested = true;
    return route.fulfill({ contentType: 'application/octet-stream', headers: { 'content-disposition': `attachment; filename="${suffix}"` }, body: 'mock installer' });
  });
  await page.goto('./');
  const main = page.getByRole('link', { name: `Download for ${label}`, exact: true }).first();
  await expect(main).toHaveAttribute('href', new RegExp(`${suffix.replaceAll('.', '\\.')}$`));
  const downloaded = page.waitForEvent('download');
  await main.click();
  expect((await downloaded).suggestedFilename()).toBe(suffix);
  expect(requested).toBe(true);
  await expect(page.getByRole('navigation', { name: 'Placekeeper downloads' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const [name, ua, platform, touch] of [
  ['unknown', 'Unknown browser', '', 0],
  ['mobile', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile', 'iPhone', 5],
  ['iPad desktop', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 'MacIntel', 5],
] as const) test(`@critical ${name} visitor opens alternatives from either segment`, async ({ page }) => {
  await page.route(RELEASE_API_URL, route => route.fulfill({ json: fixture() }));
  await identity(page, ua, platform, touch);
  await page.goto('./');
  const { main, toggle, panel } = controls(page);
  await expect(main).toHaveRole('button');
  await main.focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('link')).toHaveCount(6);
  await page.keyboard.press('Escape');
  await expect(main).toBeFocused();
  await page.keyboard.press('Space');
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(panel.getByRole('link')).toHaveCount(6);
  await footer(page);
});

test('@critical delayed desktop metadata preserves focused main invoker and pending PDF through Escape', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(RELEASE_API_URL, async route => { await pending; await route.fulfill({ json: fixture() }); });
  await identity(page, 'Windows NT 10.0; Win64; x64');
  let finishPdf!: () => void;
  const pendingPdf = new Promise<void>(resolve => { finishPdf = resolve; });
  await page.route('https://example.org/paper.pdf', async route => {
    await pendingPdf;
    await route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'Not found' });
  });
  try {
    await page.goto('./');
    await page.getByRole('textbox', { name: 'Document URL' }).fill('https://example.org/paper.pdf');
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    const spinner = page.locator('.static-launcher__url button .static-launcher__spinner');
    await expect(spinner).toBeVisible();
    const { main, panel } = controls(page);
    await main.focus();
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('status')).toHaveText('Checking downloads…');
    await expect(panel.locator('[aria-disabled="true"]')).toHaveCount(4);
    await footer(page);
    await expect(main).toBeFocused();
    release();
    await expect(main).toHaveAttribute('href', /windows-x64-Setup.exe$/);
    await expect(main).toBeFocused();
    await expect(panel.getByRole('link')).toHaveCount(6);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(main).toBeFocused();
    await expect(spinner).toBeVisible();
    // Also prove the second entry point cannot cancel the original operation.
    const lowerToggle = page.getByRole('button', { name: 'Other download options' }).nth(1);
    await lowerToggle.click();
    await page.keyboard.press('Escape');
    await expect(lowerToggle).toBeFocused();
    await expect(spinner).toBeVisible();
    finishPdf();
    await expect(page.locator('.static-launcher__toasts [role="alert"]')).toContainText('404');
    await expect(spinner).toHaveCount(0);
  } finally { release(); finishPdf(); }
});

for (const state of ['failed', 'incomplete', 'source-only'] as const) test(`@critical ${state} desktop metadata retains usable footer without guessed assets`, async ({ page }) => {
  await page.route(RELEASE_API_URL, route => state === 'failed' ? route.abort() : route.fulfill({ json: {
    ...fixture(), assets: state === 'incomplete' ? fixture().assets.slice(1) : [{ name: 'placekeeper-source.tar.gz', state: 'uploaded', size: 123, browser_download_url: `${RELEASE_REPOSITORY}/releases/download/v1.2.3/placekeeper-source.tar.gz` }],
  } }));
  await identity(page, 'Windows NT 10.0; Win64; x64');
  await page.goto('./');
  const { main, panel } = controls(page);
  await main.click();
  await expect(panel.getByRole('status')).toHaveCount(0);
  await expect(panel.locator('[aria-disabled="true"]')).toHaveCount(4);
  await expect(panel.locator('a[href*="/releases/download/"]')).toHaveCount(0);
  await expect(main).not.toHaveAttribute('href');
  await footer(page);
});
