import { expect, test } from '@playwright/test';
import { setAnnotationName } from '../../packages/core/src/review-commands.js';
import { nativeBridge } from '../support/codex-native-bridge.js';

const corpus = [
  ['text-native.pdf', 1], ['image-only.pdf', 1], ['mixed-text-image.pdf', 2],
  ['rotation-90-crop.pdf', 1], ['reference-navigation.pdf', 4],
  ['text-native-with-annotations.pdf', 1], ['docmdp-no-annotation.pdf', 1],
  ['encrypted-no-annotation.pdf', 1], ['large-text-heavy.pdf', 120],
] as const;

for (const [fixture, pages] of corpus) test(`test MCP bridge production reader: ${fixture}`, async ({ page }, info) => {
  info.setTimeout(60_000);
  const bridge = await nativeBridge(fixture);
  const start = performance.now();
  try {
    const panel = await bridge.panel(page);
    const firstReadableMs = performance.now() - start;
    const bootstrap = await panel.call('bootstrap');
    expect((bootstrap.state as any).workflow.documentGeneration).toBe(1);
    const raster = await page.locator('[data-page-index="0"] > img').first().evaluate(async (image: HTMLImageElement) => {
      await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight, source: image.src.slice(0, 20) };
    });
    expect(raster.width).toBeGreaterThan(0); expect(raster.height).toBeGreaterThan(0);
    expect(raster.source).toMatch(/^data:image\//u);
    await expect(page.getByRole('textbox', { name: new RegExp(`Current page \\d+ of ${pages}\\.`) })).toBeVisible();
    if (fixture.includes('annotations')) expect((bootstrap.state as any).items.length).toBeGreaterThan(0);
    if (fixture === 'docmdp-no-annotation.pdf' || fixture === 'encrypted-no-annotation.pdf') {
      expect((bootstrap.saveStatus as any).rewriteEligibility).toBeDefined();
      expect((bootstrap.saveStatus as any).rewriteEligibility.eligible).toBe(false);
    }
    if (fixture === 'text-native.pdf' || fixture === 'large-text-heavy.pdf') {
      await page.locator('.pdf-workspace:not(.pdf-workspace--reference) [data-page-index]').first().focus();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
      const searchStart = performance.now();
      await page.getByRole('searchbox', { name: 'Search this PDF' }).fill(fixture === 'text-native.pdf' ? 'equilibrium' : 'corpus-120-48');
      const results = page.locator('#workspace-panel-search [data-search-group="exact"] .annotation-item__navigation');
      await expect(results).toHaveCount(1, { timeout: 20_000 });
      const searchMs = performance.now() - searchStart;
      await results.first().click();
      const target = fixture === 'text-native.pdf' ? '0' : '119';
      await expect(page.locator(`.pdf-workspace:not(.pdf-workspace--reference) [data-page-index="${target}"]`)).toBeVisible();
      await info.attach('bridge-search-timing', { body: JSON.stringify({ fixture, searchMs, actualHost: false, scope: 'test MCP bridge; no Codex scheduling or host limits' }), contentType: 'application/json' });
    }
    expect(await page.evaluate(() => (window as any).nativeAcceptanceErrors)).toEqual([]);
    await info.attach('bridge-reader-evidence', { body: JSON.stringify({ fixture, pages, firstReadableMs, raster, actualHost: false, metric: 'bridge mount to decoded first page; excludes real launcher/display' }), contentType: 'application/json' });
    await panel.disconnect();
    expect(bridge.backend.retentionStatus()).toMatchObject({ presentations: 0, resources: 0 });
  } finally { await bridge.dispose(); }
});

test('test MCP bridge retains nested references and returns to the main reading place', async ({ page }) => {
  const bridge = await nativeBridge('reference-navigation.pdf');
  try {
    await bridge.panel(page);
    const main = page.locator('.pdf-workspace:not(.pdf-workspace--reference)');
    const before = await main.locator('.pdf-workspace__viewport').evaluate((element) => ({ top: element.scrollTop, left: element.scrollLeft }));
    const links = main.getByRole('button', { name: 'Open PDF link to Primary result, Page 2', exact: true });
    // Real internal PDF link hit targets, rather than synthetic reference state.
    await expect(links.first()).toBeVisible();
    await links.first().click();
    await page.getByRole('menuitem', { name: /Open in References/u }).click();
    await expect(page.locator('.pdf-workspace--reference')).toBeVisible();
    const detail = page.locator('[data-reference-pdf-viewport]').getByRole('button', { name: 'Open PDF link to Target-to-target detail link, Page 3', exact: true });
    await detail.evaluate((element: HTMLElement) => element.focus({ preventScroll: true }));
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: /Open in References/u }).click();
    await expect(page.locator('[data-reference-tab]')).toHaveCount(2);
    await page.getByRole('button', { name: 'Hide References' }).click();
    await expect(main).toBeVisible();
    expect(await main.locator('.pdf-workspace__viewport').evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }))).toEqual(before);
  } finally { await bridge.dispose(); }
});

test('test MCP bridge production authoring preserves protected draft, edit, delete and history', async ({ page }, info) => {
  info.setTimeout(60_000);
  const bridge = await nativeBridge('text-native.pdf');
  try {
    const panel = await bridge.panel(page);
    await panel.call('chooseCopy', { filename: 'authoring.pdf' }); await bridge.saving.drain();
    const source = await bridge.sourceBytes();
    const pdfPage = page.locator('.pdf-workspace:not(.pdf-workspace--reference) [data-page-index="0"]').first();
    const box = await pdfPage.boundingBox(); if (!box) throw new Error('Missing page geometry');
    await pdfPage.click({ button: 'right', position: { x: box.width * .7, y: box.height * .55 } });
    await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
    const composer = page.getByRole('region', { name: /^Page Note/u });
    await composer.getByRole('textbox', { name: 'Comment', exact: true }).fill('Created through production UI');
    await expect.poll(() => bridge.broker.state(bridge.sessionId)?.pendingDrafts[0]?.text).toBe('Created through production UI');
    await composer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(composer).toHaveCount(0);
    await expect.poll(() => bridge.broker.state(bridge.sessionId)?.items.length).toBe(1);
    expect(bridge.broker.state(bridge.sessionId)?.pendingDrafts).toEqual([]);
    const id = bridge.broker.state(bridge.sessionId)!.items[0]!.id;
    await page.getByRole('button', { name: 'Show workspace' }).click();
    await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
    const row = page.locator(`[data-review-item="${id}"]`);
    await row.hover(); await row.getByRole('button', { name: 'Edit Page Note annotation on page 1' }).click();
    const edit = page.getByRole('region', { name: /^Edit Page Note/u });
    await edit.getByRole('textbox', { name: 'Comment', exact: true }).fill('Edited through production UI');
    await edit.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(row).toContainText('Edited through production UI');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Undo', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(row).toContainText('Created through production UI');
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Redo', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(row).toContainText('Edited through production UI');
    await row.hover(); await row.getByRole('button', { name: 'Remove Page Note annotation on page 1' }).click();
    await expect.poll(() => bridge.broker.state(bridge.sessionId)?.items.length).toBe(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Undo', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(row).toContainText('Edited through production UI');
    await bridge.saving.drain();
    expect(bridge.broker.saveStatus(bridge.sessionId)?.sync).toMatchObject({ phase: 'clean', savedRevision: bridge.broker.state(bridge.sessionId)!.revision });
    expect(await bridge.sourceBytes()).toEqual(source);
    expect(await page.evaluate(() => (window as any).nativeAcceptanceErrors)).toEqual([]);
  } finally { await bridge.dispose(); }
});


test('test MCP bridge export conflict preserves annotation-name recovery guidance', async ({ page }) => {
  const bridge = await nativeBridge('text-native-with-annotations.pdf', { workflowMode: 'generated-output' });
  try {
    await bridge.panel(page);
    const original = bridge.broker.freezeDelivery.bind(bridge.broker);
    const source = await bridge.sourceBytes();
    let writes = 0; bridge.setBeforeWrite(async () => { writes++; });
    let changed = false;
    bridge.broker.freezeDelivery = async (...args) => {
      if (!changed) {
        changed = true;
        await bridge.broker.acceptMutation(bridge.sessionId, setAnnotationName(bridge.broker.state(bridge.sessionId)!, 'Other window'));
      }
      return original(...args);
    };
    await page.getByRole('button', { name: /Open document actions$/u }).click();
    await page.getByRole('menuitem', { name: 'Export', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export reviewed PDF', exact: true });
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(dialog).toContainText('Review changed. Confirm the annotation name again to export the latest review.');
    expect(changed).toBe(true);
    expect(writes).toBe(0);
    expect(await bridge.sourceBytes()).toEqual(source);
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => (window as any).nativeAcceptanceErrors)).toEqual([]);
  } finally { await bridge.dispose(); }
});


test('test MCP bridge imported comment inspection and Cancel leave original bytes unchanged', async ({ page }, info) => {
  info.setTimeout(60_000);
  const bridge = await nativeBridge('text-native-with-annotations.pdf');
  try {
    await bridge.panel(page);
    const before = await bridge.sourceBytes();
    const items = structuredClone(bridge.broker.state(bridge.sessionId)!.items);
    let writes = 0; bridge.setBeforeWrite(async () => { writes++; });
    await page.getByRole('button', { name: 'Show workspace' }).click();
    await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
    for (const item of items) {
      const row = page.locator(`[data-review-item="${item.id}"]`);
      await row.hover(); await row.getByRole('button', { name: /^Edit .* annotation on page 1$/u }).click();
      const composer = page.getByRole('region', { name: /^Edit /u });
      await expect(composer.getByRole('textbox', { name: 'Comment (optional)', exact: true })).toHaveValue(String(item.payload.comment));
      await expect.poll(() => bridge.broker.state(bridge.sessionId)?.pendingDrafts[0]?.targetItemId).toBe(item.id);
      await composer.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(composer).toHaveCount(0);
      await expect.poll(() => bridge.broker.state(bridge.sessionId)?.pendingDrafts.length).toBe(0);
      await bridge.saving.drain();
      expect((await bridge.sourceBytes()).equals(before)).toBe(true);
    }
    expect(writes).toBe(0);
    expect(bridge.broker.state(bridge.sessionId)?.items).toEqual(items);
    expect(bridge.broker.saveStatus(bridge.sessionId)?.sync).toMatchObject({ phase: 'clean', desiredRevision: 4, savedRevision: 4 });
    expect(await page.evaluate(() => (window as any).nativeAcceptanceErrors)).toEqual([]);
  } finally { await bridge.dispose(); }
});
