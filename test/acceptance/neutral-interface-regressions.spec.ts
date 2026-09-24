import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
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

async function clickHoverRevealedReferenceTabAction(action: Locator) {
  await action.locator('..').hover();
  await expect(action).toHaveCSS('opacity', '1');
  await expect(action).toHaveCSS('pointer-events', 'auto');
  await action.click();
}

async function clickHoverRevealedReferenceDockAction(action: Locator) {
  await action.locator('..').hover();
  await expect(action).toHaveCSS('opacity', '1');
  await expect(action).toHaveCSS('pointer-events', 'auto');
  await action.click();
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
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('search-input.png') });
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
    expect(color.background).toBe('rgb(207, 222, 234)');
    expect(color.mix).toBe('multiply');
    expect(color.width).toBeGreaterThan(0);
    expect(color.height).toBeGreaterThan(0);
  }
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('visible-pdf-selection.png') });
});

test('reference tray has one 12px inset around its viewer at wide and narrow widths', async ({ page }) => {
  await openPdf(page, 'reference-navigation.pdf');
  await page.getByRole('button', { name: 'Open PDF link to Primary result, Page 2', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open in References', exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Open references' })).toBeVisible();
  for (const width of [1280, 621]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('tablist', { name: 'Open references' })).toHaveAttribute('aria-orientation', width > 760 ? 'vertical' : 'horizontal');
    await expect(page.getByRole('tab', { name: 'Primary result, Page 2', exact: true })).toBeVisible();
    await expect.poll(async () => page.locator('.reference-panel__viewport').evaluate((viewport) => {
      const tray = viewport.closest('.review-workspace')!.getBoundingClientRect();
      const panel = viewport.closest('.review-workspace__panel--references')!;
      const tabs = panel.querySelector('.reference-tabs')!.getBoundingClientRect();
      const box = viewport.getBoundingClientRect();
      const vertical = panel.getAttribute('data-reference-tabs-orientation') === 'vertical';
      return [box.top - (vertical ? tray.top : tabs.bottom), tray.right - box.right,
        tray.bottom - box.bottom, box.left - (vertical ? tabs.right : tray.left)].map(Math.round);
    })).toEqual([12, 12, 12, 12]);
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`reference-insets-${width}.png`) });
  }
});

test('reference PDF selection uses the visible PDF color independently of tray selection', async ({ page }) => {
  await openPdf(page, 'reference-navigation.pdf');
  await page.getByRole('button', { name: 'Open PDF link to Primary result, Page 2', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open in References', exact: true }).click();
  await expect(page.locator('.reference-panel')).toHaveCSS('background-color', 'rgb(240, 240, 240)');
  await clickHoverRevealedReferenceDockAction(
    page.getByRole('button', { name: 'Move References to right', exact: true }),
  );
  await expect(page.locator('.reference-panel')).toHaveCSS('background-color', 'rgb(240, 240, 240)');
  const viewport = page.locator('[data-reference-pdf-viewport] [data-viewer-framing-viewport]');
  await expect(page.getByRole('tab', { name: 'Primary result, Page 2', exact: true })).toBeVisible();
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
    expect(color).toBe('rgb(207, 222, 234)');
  }
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('visible-reference-selection.png') });
});

test('reference labels, actions, return control, and dock controls follow the canonical layout', async ({ page }) => {
  await openPdf(page, 'reference-navigation.pdf');
  await page.getByRole('button', { name: 'Open PDF link to Primary result, Page 2', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open in References', exact: true }).click();
  const tab = page.getByRole('tab', { name: 'Primary result, Page 2', exact: true });
  await expect(tab).toBeVisible();
  const row = page.locator('.reference-tab-segment--compound');
  const inspect = async () => row.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const title = el.querySelector('.reference-tab-segment__selector')!;
    const name = title.querySelector('span')!.getBoundingClientRect();
    const number = title.querySelector('small')!;
    const n = number.getBoundingClientRect();
    const actions = Array.from(el.querySelectorAll('.reference-tab-segment__action, .reference-panel__return'));
    const last = actions.at(-1)!.getBoundingClientRect();
    return { pageText: number.textContent, titleAlign: Math.abs(name.y + name.height / 2 - n.y - n.height / 2),
      actionRight: b.right - last.right, actionTop: last.top - b.top, actionBottom: b.bottom - last.bottom,
      rowHeight: b.height, actionWidth: last.width, actionHeight: last.height,
      overflow: actions.some(a => a.getBoundingClientRect().right > b.right) };
  });
  await expect.poll(inspect).toMatchObject({ pageText: '2', actionRight: 3, actionTop: 3, actionBottom: 3,
    rowHeight: 32, actionWidth: 26, actionHeight: 26, overflow: false });
  expect((await inspect()).titleAlign).toBeLessThan(1);
  const dockRight = page.getByRole('button', { name: 'Move References to right', exact: true });
  const dockBox = (await dockRight.boundingBox())!;
  const viewerBox = (await page.locator('.reference-panel__viewport').boundingBox())!;
  expect(viewerBox.x - dockBox.x - dockBox.width).toBeCloseTo(12, 0);
  const viewport = page.locator('[data-reference-pdf-viewport] [data-viewer-framing-viewport]');
  await expect(viewport).toBeVisible();
  await viewport.hover();
  await page.mouse.wheel(0, 600);
  const returnButton = page.getByRole('button', { name: 'Return to reference', exact: true });
  await expect(returnButton).toBeVisible();
  await expect(row.getByRole('button', { name: 'Return to reference', exact: true })).toBeVisible();
  await expect.poll(inspect).toMatchObject({ actionRight: 3, actionTop: 3, actionBottom: 3, overflow: false });
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('reference-tab-return-bottom.png') });
  await clickHoverRevealedReferenceTabAction(returnButton);
  await expect(returnButton).toBeHidden();
  await clickHoverRevealedReferenceDockAction(dockRight);
  await expect(page.getByRole('tablist', { name: 'Open references' })).toHaveAttribute('aria-orientation', 'horizontal');
  await expect.poll(inspect).toMatchObject({ actionRight: 3, actionTop: 3, actionBottom: 3,
    rowHeight: 32, actionWidth: 26, actionHeight: 26, overflow: false });
  expect((await inspect()).titleAlign).toBeLessThan(1);
  const dockBottom = page.getByRole('button', { name: 'Move References to bottom', exact: true });
  await expect(page.locator('.review-tools-workspace[data-tools-workspace-shared="true"]')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const headerBox = (await page.locator('.review-workspace > .review-workspace__header').boundingBox())!;
  const bottomButtonBox = (await dockBottom.boundingBox())!;
  expect(headerBox.x + headerBox.width - bottomButtonBox.x - bottomButtonBox.width).toBeCloseTo(12, 0);
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('reference-tab-right.png') });
});

test('save failure offers copy recovery and handles retry pending, failure, and success', async ({ page }) => {
  let clean = false;
  let retries = 0;
  let releaseRetry: (() => void) | undefined;
  const saveStatus = () => ({
    destination: { phase: 'active', generation: 1, kind: 'copy', targetPath: '/tmp/annotated.pdf' },
    sync: { phase: clean ? 'clean' : 'not-saved', desiredRevision: 0, savedRevision: clean ? 0 : -1,
      ...(clean ? {} : { failure: 'write-failed' }) },
  });
  await page.route('**/save/status', (route) => route.fulfill({ json: saveStatus() }));
  await page.route('**/save/retry', async (route) => {
    retries += 1;
    await new Promise<void>((resolve) => { releaseRetry = resolve; });
    if (retries === 1) await route.fulfill({ status: 500, json: { error: 'Write failed' } });
    else { clean = true; await route.fulfill({ json: saveStatus() }); }
  });
  await openPdf(page, 'text-native.pdf');
  const notice = page.locator('.review-save-notice');
  await expect(notice).toContainText('Couldn’t save your latest annotations.');
  await notice.getByRole('button', { name: 'Save a copy…', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  const retry = notice.getByRole('button', { name: 'Retry', exact: true });
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect(notice.getByRole('button', { name: 'Save a copy…', exact: true })).toBeDisabled();
  await expect.poll(() => retries).toBe(1);
  releaseRetry!();
  await expect(notice).toContainText('Saving could not be retried safely.');
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect.poll(() => retries).toBe(2);
  releaseRetry!();
  await expect(notice).toHaveCount(0);
  await expect(page.locator('.review-chrome__save-dot')).toHaveCount(0);
});

test('terminal recovery keeps the shared dialog treatment and reachable narrow actions', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.goto(`${host.server.origin}/r/00000000-0000-4000-8000-000000000099/private/tmp/Review%20paper.pdf#v=1&page=1`);
  const recovery = page.locator('.terminal-recovery');
  await expect(recovery).toBeVisible();
  await expect(recovery).toHaveCSS('border-top-width', '0px');
  await expect(recovery).toHaveCSS('border-radius', '17px');
  await expect(recovery.locator('h1')).toHaveCSS('font-size', '15px');
  await expect(recovery.locator('button').first()).toHaveCSS('font-size', '13px');
  await page.screenshot({ path: test.info().outputPath('recovery-wide.png') });
  await page.setViewportSize({ width: 390, height: 600 });
  await expect.poll(() => recovery.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (const button of await recovery.locator('button').all()) {
    const bounds = (await button.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(12);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(378);
  }
  await page.screenshot({ path: test.info().outputPath('recovery-narrow.png') });
});
