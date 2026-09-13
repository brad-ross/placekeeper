import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PlacekeeperHost } from '../../apps/service/src/host/placekeeper-host.js';
import { TaskBindingRegistry } from '../../apps/service/src/context/task-binding-registry.js';

let host: PlacekeeperHost;
let root: string;
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'interface-followup-'));
  host = await PlacekeeperHost.start({
    recoveryRoot: join(root, 'recovery'),
    webAssets: { root: resolve('dist/web') },
    taskBindings: new TaskBindingRegistry(),
  });
});
test.afterAll(async () => { await host?.close(); await rm(root, { recursive: true, force: true }); });

async function openPdf(page: Page, codex = false) {
  const pdfPath = join(root, `${test.info().testId.replace(/[^a-z0-9]/gi, '')}.pdf`);
  await copyFile(resolve('test/fixtures/pdfs/reference-navigation.pdf'), pdfPath);
  const result = await host.open({ pdfPath, ...(codex ? { surface: 'codex' as const } : {}) });
  if (!result.ok || result.kind === 'recovery-offered') throw new Error('Fixture launch failed');
  await page.goto(result.url);
  await expect(page.locator('[data-page-index="0"] > img').first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Current page/ })).toHaveValue('1');
}

test('page and zoom menus align to the right edge of their numeric groups', async ({ page }) => {
  await openPdf(page);
  for (const width of [1280, 620, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [openerSelector, groupSelector, label] of [
      ['.review-chrome__page-disclosure', '.review-chrome__page-position', 'Page navigation'],
      ['.review-chrome__zoom-disclosure', '.review-chrome__zoom-cluster', 'PDF zoom'],
    ] as const) {
      await page.locator(`[data-review-chrome] ${openerSelector}:visible`).click();
      const menu = page.getByRole('menu', { name: label, exact: true });
      await expect(menu).toBeVisible();
      const group = page.locator(`[data-review-chrome] ${groupSelector}:visible`);
      const a = (await group.boundingBox())!;
      const b = (await menu.boundingBox())!;
      expect(b.x + b.width).toBeCloseTo(a.x + a.width, 0);
      expect(b.x).toBeGreaterThanOrEqual(6);
      expect(b.x + b.width).toBeLessThanOrEqual(width - 6);
      await menu.press('Escape');
    }
  }
});

test('workspace fade follows the opening tray without another pointer or scroll event', async ({ page }) => {
  await openPdf(page);
  await page.getByRole('button', { name: 'Show workspace', exact: true }).click();
  // Do not move the pointer after opening: the transition itself must publish geometry.
  await page.waitForTimeout(240);
  const geometry = await page.locator('[data-review-stage]').evaluate((stage) => {
    const tray = stage.querySelector('.review-tools-workspace')!.getBoundingClientRect();
    const fade = stage.querySelector('.review-overlay-frame__right-fade')!;
    const bounds = fade.getBoundingClientRect();
    return { gap: tray.left - bounds.right, width: bounds.width,
      display: getComputedStyle(fade).display, background: getComputedStyle(fade).backgroundImage };
  });
  expect(geometry).toMatchObject({ gap: 12, width: 12, display: 'block' });
  expect(geometry.background).toContain('linear-gradient');
  await page.screenshot({ path: test.info().outputPath('opened-tray-fade.png') });
});

test('document history keeps the other toolbar controls mounted and visible', async ({ page }) => {
  await openPdf(page);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await page.getByRole('button', { name: 'Open PDF link to Primary result, Page 2', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open in main document', exact: true }).click();
    await expect(page.getByRole('textbox', { name: /^Current page/ })).toHaveValue('2');
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll<HTMLElement>(
        '[data-review-chrome] > .review-chrome__identity, [data-review-chrome] > .review-chrome__left-controls .review-chrome__page-position, [data-review-chrome] > .review-chrome__viewer-controls .review-chrome__zoom-cluster, [data-review-chrome] > .review-chrome__left-controls [data-review-copy-link]',
      )];
      const audit = { missing: [] as string[], finished: false };
      (window as typeof window & { __chromeAudit?: typeof audit }).__chromeAudit = audit;
      let frames = 0;
      const inspect = () => {
        for (const node of nodes) {
          const style = getComputedStyle(node);
          if (!node.isConnected || node.getBoundingClientRect().width === 0
            || style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
            audit.missing.push(node.className);
          }
        }
        if (++frames < 40) requestAnimationFrame(inspect);
        else audit.finished = true;
      };
      requestAnimationFrame(inspect);
    });
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    await page.getByRole('button', { name: 'Back in document history', exact: true }).click();
    await expect(page.getByRole('textbox', { name: /^Current page/ })).toHaveValue('1');
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { __chromeAudit?: { finished: boolean } }).__chromeAudit?.finished)).toBe(true);
    expect(await page.evaluate(() =>
      (window as typeof window & { __chromeAudit?: { missing: string[] } }).__chromeAudit?.missing)).toEqual([]);
  }
});

test('save errors float at the upper left without shifting the PDF or toolbar', async ({ page }) => {
  let failed = true;
  const status = () => ({
    destination: { phase: 'active', generation: 1, kind: 'copy', targetPath: '/tmp/annotated.pdf' },
    sync: { phase: failed ? 'not-saved' : 'clean', desiredRevision: 0, savedRevision: failed ? -1 : 0,
      ...(failed ? { failure: 'write-failed' } : {}) },
  });
  await page.route('**/save/status', (route) => route.fulfill({ json: status() }));
  await page.route('**/save/retry', (route) => { failed = false; return route.fulfill({ json: status() }); });
  await openPdf(page);
  const notice = page.locator('.review-save-notice');
  await expect(notice).toBeVisible({ timeout: 10000 });
  const stage = (await page.locator('[data-review-stage]').boundingBox())!;
  const bounds = (await notice.boundingBox())!;
  expect(bounds.x - stage.x).toBeGreaterThanOrEqual(6);
  expect(bounds.x - stage.x).toBeLessThanOrEqual(14);
  expect(bounds.y - stage.y).toBeGreaterThanOrEqual(6);
  expect(bounds.y - stage.y).toBeLessThanOrEqual(14);
  expect(bounds.width).toBeLessThanOrEqual(384);
  await expect(notice).toHaveCSS('border-radius', '10px');
  await expect(notice.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('floating-error.png') });
  await notice.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(notice).toBeHidden();
  expect(await page.locator('[data-review-stage]').boundingBox()).toEqual(stage);
});

test('agent status opens to the right and stays inside desktop and narrow viewports', async ({ page }) => {
  await openPdf(page, true);
  const status = page.locator('[data-review-context-status] .codex-context-status');
  await expect(status).toBeVisible();
  for (const width of [1280, 620, 521]) {
    await page.setViewportSize({ width, height: 900 });
    await status.hover();
    const tooltip = status.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    const a = (await status.boundingBox())!;
    const b = (await tooltip.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(6);
    expect(b.x + b.width).toBeLessThanOrEqual(width - 6);
    if (a.x + b.width <= width - 6) expect(b.x).toBeCloseTo(a.x, 0);
    await page.mouse.move(0, 0);
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(status).toBeHidden();
});

test('search results share annotation row spacing, metadata, and action styling', async ({ page }) => {
  await openPdf(page);
  await page.getByRole('button', { name: 'Show workspace', exact: true }).click();
  await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
  const annotation = page.locator('li[data-annotation-origin]').first();
  await expect(annotation).toBeVisible();
  const rowStyles = (row: Element) => {
    const style = getComputedStyle(row);
    const content = getComputedStyle(row.querySelector('.annotation-item__content, .existing-annotation__content')!);
    return { radius: style.borderRadius, border: style.borderTopWidth, background: style.backgroundColor,
      padding: content.padding, display: style.display, font: content.fontFamily };
  };
  await page.mouse.move(0, 0);
  const annotationStyle = await annotation.evaluate(rowStyles);
  await page.getByRole('tab', { name: 'Search', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search this PDF' }).fill('Primary');
  const result = page.locator('li[data-search-result]').first();
  await expect(result).toBeVisible();
  expect(await result.evaluate(rowStyles)).toEqual(annotationStyle);
  await result.hover();
  const heading = result.locator('.annotation-item__title-row');
  const excerpt = result.locator('.pdf-search__excerpt');
  expect((await heading.boundingBox())!.y + (await heading.boundingBox())!.height)
    .toBeLessThanOrEqual((await excerpt.boundingBox())!.y);
  const actions = result.locator('.row-action-group__direct button');
  for (const action of await actions.all()) {
    await expect(action).toHaveCSS('width', '26px');
    await expect(action).toHaveCSS('height', '26px');
    await expect(action).toHaveCSS('padding', '0px');
  }
  await expect(result.locator('.pdf-search__result-separator')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('annotation-style-search.png') });
});
