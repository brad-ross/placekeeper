import { expect, test } from '@playwright/test';
import { extensionReader } from '../support/extension-reader.js';

test('extension activation waits for preferences, then real tools, drafts and partial context removal compose', async ({ page }, info) => {
  info.setTimeout(60_000);
  const reader = await extensionReader(page);
  try {
    await expect(page.locator('[data-production-review]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).extensionAcceptance.publications)).toEqual([]);
    await reader.ready();
    await expect.poll(() => page.evaluate(() => (window as any).extensionAcceptance.publications.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).extensionAcceptance.publications.every((p: any) => p.settingsLoaded))).toBe(true);
    const snapshot = await reader.tool('inspect_review', {});
    expect(snapshot).toMatchObject({ status: 'current', documentGeneration: 1 });
    expect(snapshot.annotations.map((a: any) => a.id)).toEqual(reader.bridge.broker.state(reader.bridge.sessionId)!.items.map(a => a.id));
    const search = await reader.tool('search_document', { query: 'equilibrium', documentGeneration: 1 });
    expect(search.results.length).toBeGreaterThan(0);
    const revealed = await reader.tool('reveal_search_result', { resultId: search.results[0].id, documentGeneration: 1 });
    expect(revealed, JSON.stringify(revealed)).toMatchObject({ status: 'navigated', page: 1 });
    expect(await reader.tool('navigate_page', { page: 1, documentGeneration: 2 })).toMatchObject({ status: 'unavailable', reason: 'stale-generation' });
    const chooser = page.locator('.review-discussion-actions');
    await chooser.locator('summary').click();
    await chooser.getByRole('checkbox').first().check();
    await chooser.getByRole('button', { name: 'Discuss these annotations', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).extensionAcceptance.messages.length)).toBe(1);
    const message = await page.evaluate(() => (window as any).extensionAcceptance.messages[0]);
    expect(message._meta['openai/message']).toEqual({ target: 'active', send: false });
    expect(message.content[0].text).toContain(snapshot.annotations[0].text);
    await expect.poll(() => page.evaluate(() => (window as any).extensionAcceptance.context.content.length)).toBe(2);
    const removed = await page.evaluate(() => {
      const state = (window as any).extensionAcceptance;
      const removed = state.context.content.find((b: any) => b.resource.uri.includes('/attachment/')).resource.uri;
      state.context = { ...state.context, updateId: 'human-partial-removal', content: state.context.content.filter((b: any) => b.resource.uri !== removed) };
      state.shell.hostContextChanged({ 'openai/modelContext': state.context });
      return removed;
    });
    await page.locator('#controls summary').click();
    await page.getByRole('checkbox', { name: 'Share current selection in background context', exact: true }).uncheck();
    await expect.poll(() => page.evaluate(uri => (window as any).extensionAcceptance.context.content.some((b: any) => b.resource.uri === uri), removed)).toBe(false);
    await page.getByRole('checkbox', { name: 'Allow explicitly included review snapshots in other chats', exact: true }).check();
    await page.getByRole('button', { name: 'Include this review snapshot', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Update included snapshot', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Remove this review from mentions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Include this review snapshot', exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).extensionAcceptance.shell.hostContextChanged({ displayMode: 'inline' }));
    await expect(page.locator('#root')).toBeHidden();
    expect(await reader.tool('navigate_page', { page: 1, documentGeneration: 1 })).toMatchObject({ status: 'navigated', page: 1 });
    await expect(page.locator('#root')).toBeVisible();
    expect(await page.evaluate(() => (window as any).extensionAcceptance.expansionRequests)).toBe(1);
    await info.attach('extension-boundary-evidence', { body: JSON.stringify({ actualHost: false, sessionId: reader.bridge.sessionId, generation: snapshot.documentGeneration, annotationIds: snapshot.annotations.map((a: any) => a.id), requests: reader.requests, draftSend: false }), contentType: 'application/json' });
  } finally { await reader.dispose(); }
});

for (const width of [1440, 375]) test(`extension sharing and discussion layout at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const reader = await extensionReader(page);
  try {
    await reader.ready();
    await page.locator('#controls summary').click();
    await page.locator('.review-discussion-actions summary').click();
    await expect(page.getByRole('checkbox', { name: 'Share background review context', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Discuss these annotations', exact: true })).toBeVisible();
    const geometry = await page.evaluate(() => {
      const controls = document.getElementById('controls')!.getBoundingClientRect();
      const chooser = document.querySelector('.review-discussion-actions')!.getBoundingClientRect();
      return { documentWidth: document.documentElement.scrollWidth, viewport: innerWidth, controls: { top: controls.top, bottom: controls.bottom }, chooser: { left: chooser.left, right: chooser.right, top: chooser.top, bottom: chooser.bottom } };
    });
    expect(geometry.documentWidth).toBeLessThanOrEqual(width + 1);
    expect(geometry.chooser.left).toBeGreaterThanOrEqual(0);
    expect(geometry.chooser.right).toBeLessThanOrEqual(width);
    expect(geometry.chooser.top).toBeGreaterThanOrEqual(geometry.controls.bottom);
    const raster = await page.locator('[data-page-index="0"] > img').first().evaluate(async (image: HTMLImageElement) => {
      await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let inkPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3]! > 0 && Math.min(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) < 128) inkPixels++;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return { width: image.naturalWidth, height: image.naturalHeight, inkPixels };
    });
    expect(raster.inkPixels).toBeGreaterThan(100);
    await info.attach(`extension-${width}px`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    // At narrow widths this short fixture's text is beneath the open chooser.
    // A second view distinguishes that expected overlay from a blank PDF raster.
    await page.locator('.review-discussion-actions summary').click();
    await info.attach(`extension-${width}px-reader`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await info.attach('layout-boundary', { body: JSON.stringify({ actualHost: false, ...geometry, raster }), contentType: 'application/json' });
  } finally { await reader.dispose(); }
});

test('extension selection creates an editable captured draft without accepting an annotation', async ({ page }) => {
  const reader = await extensionReader(page, 'text-native.pdf');
  try {
    await reader.ready();
    const zoom = page.getByRole('textbox', { name: /^Current zoom/ });
    await zoom.fill('100'); await zoom.press('Enter');
    await expect(zoom).toHaveValue('100');
    const pdf = page.locator('.pdf-workspace:not(.pdf-workspace--reference) [data-page-index="0"]').first();
    await expect.poll(async () => Math.round((await pdf.boundingBox())?.width ?? 0)).toBe(612);
    await page.locator('.pdf-workspace:not(.pdf-workspace--reference) .pdf-workspace__viewport').evaluate(element => { element.scrollTop = 0; });
    const box = await pdf.boundingBox(); if (!box) throw Error('Missing PDF page');
    await page.mouse.move(box.x + 76, box.y + 98); await page.mouse.down();
    await page.mouse.move(box.x + Math.min(455, box.width - 30), box.y + 105, { steps: 12 }); await page.mouse.up();
    await expect(page.getByRole('button', { name: 'Ask about this selection', exact: true })).toBeVisible();
    const snapshot = await reader.tool('inspect_review', {});
    expect(snapshot.selection.text.length).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Ask about this selection', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).extensionAcceptance.messages.length)).toBe(1);
    const message = await page.evaluate(() => (window as any).extensionAcceptance.messages[0]);
    expect(message._meta['openai/message'].send).toBe(false);
    expect(message.content[0].text).toContain(snapshot.selection.text);
    expect(reader.bridge.broker.state(reader.bridge.sessionId)?.items).toEqual([]);
  } finally { await reader.dispose(); }
});

test('extension observes external sharing-off before a pending publication can reach the host', async ({ page }) => {
  const reader = await extensionReader(page);
  try {
    await page.evaluate(() => {
      const state = (window as any).extensionAcceptance;
      state.publicationGate = new Promise<void>(resolve => { state.releasePublication = resolve; });
    });
    await reader.ready();
    await expect(page.getByText('Updating context for chat…', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const state = (window as any).extensionAcceptance;
      state.settings = { backgroundContext: false, selectionSharing: false, mentions: false }; state.revision++;
      state.shell.wake();
    });
    await page.locator('#controls summary').click();
    await expect(page.getByRole('checkbox', { name: 'Share background review context', exact: true })).not.toBeChecked();
    await page.evaluate(() => (window as any).extensionAcceptance.releasePublication());
    await expect(page.getByText('Background context is paused for this app.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).extensionAcceptance.publications.some((p: any) => p.content.length > 0))).toBe(false);
    expect(await reader.tool('inspect_review', {})).toMatchObject({ status: 'current', documentGeneration: 1 });
  } finally { await reader.dispose(); }
});
