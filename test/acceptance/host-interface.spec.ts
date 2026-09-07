import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

for (const source of ['main', 'reference']) {
  test(`host bootstrap attaches history before opening a ${source} link in Main`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/test/acceptance/review-harness/?host-history=1');
    await expect(page.locator('[data-runtime-loading-workspace]')).toBeVisible();
    await page.getByRole('button', { name: 'Finish host bootstrap' }).click();
    await expect(page.locator('[data-runtime-loading-workspace]')).toHaveCount(0);
    const mainLink = page.getByRole('button', { name: 'Open PDF link to Primary result, Page 2' });
    await mainLink.click();
    if (source === 'reference') {
      await page.getByRole('menuitem', { name: 'Open in References', exact: true }).click();
      await expect(page.getByRole('tab', { name: /Primary result/u })).toHaveAttribute('aria-selected', 'true');
      const link = page.locator('[data-reference-pdf-viewport]').getByRole('button', {
        name: 'Open PDF link to Target-to-target detail link, Page 3',
      });
      await link.scrollIntoViewIfNeeded();
      await link.click();
    }
    await page.getByRole('menuitem', { name: 'Open in main document', exact: true }).click();
    const pageInput = page.getByRole('textbox', { name: /^Current page \d+ of \d+/u });
    const destination = source === 'main' ? '2' : '3';
    await expect(pageInput).toHaveValue(destination);
    const back = page.getByRole('button', { name: 'Back in document history' });
    await expect(back).toBeVisible();
    await expect(back).toBeEnabled();
    await back.click();
    await expect(pageInput).toHaveValue('1');
    await page.getByRole('button', { name: 'Forward in document history' }).click();
    await expect(pageInput).toHaveValue(destination);
  });
}

test('host reattachment with no unresolved annotations gives transient neutral feedback', async ({ page }) => {
  await page.goto('/test/acceptance/review-harness/?host-reattach=1');
  const notice = page.locator('[data-host-command-status]');
  await expect(notice).toHaveCount(0);
  await page.getByRole('button', { name: 'Request host reattachment' }).click();
  await expect(notice).toHaveText('No annotations need reattachment.');
  await expect(notice).toHaveAttribute('role', 'status');
  const position = await notice.boundingBox();
  expect(position!.x).toBeLessThan(100);
  expect(position!.y).toBeLessThan(150);
  await expect(notice).toHaveCount(0, { timeout: 8_000 });
  await page.getByRole('button', { name: 'Request host reattachment' }).click();
  await expect(notice).toBeVisible();
});

// Run the real extension entrypoints with only the Chrome/native transport mocked.
// No installed extension preferences or user recovery records are changed.
async function chromePage(page: Page, entry: 'handler' | 'popup') {
  await page.addInitScript(() => {
    const messages = new Set<(message: unknown) => void>();
    const disconnects = new Set<() => void>();
    const audit = { sent: [] as Record<string, unknown>[], fallback: false, enabled: true };
    (window as typeof window & { __chromeUiAudit: typeof audit }).__chromeUiAudit = audit;
    const chrome = {
      storage: { local: {
        get: async (key: string) => ({ [key]: audit.enabled }),
        set: async (values: Record<string, boolean>) => {
          audit.enabled = Object.values(values)[0]!;
        },
      } },
      mimeHandler: {
        getMimeHandlerOptions: async () => ({ enabled: audit.enabled }),
        setMimeHandlerOptions: async (_type: string, options: { enabled: boolean }) => {
          audit.enabled = options.enabled;
        },
        getStreamInfo: async () => ({ originalUrl: 'file:///fixture/paper.pdf', streamUrl: 'blob:fixture', tabId: 1, embedded: false }),
        abortAndFallbackToNativeHandler: async () => { audit.fallback = true; },
      },
      runtime: {
        getURL: (path: string) => new URL(path, location.origin).href,
        connectNative: () => ({
          onMessage: { addListener: (listener: (message: unknown) => void) => messages.add(listener), removeListener: (listener: (message: unknown) => void) => messages.delete(listener) },
          onDisconnect: { addListener: (listener: () => void) => disconnects.add(listener), removeListener: (listener: () => void) => disconnects.delete(listener) },
          disconnect: () => {},
          postMessage: (message: Record<string, unknown>) => {
            audit.sent.push(message);
            const reply = (body: Record<string, unknown>) => queueMicrotask(() => {
              for (const listener of messages) listener({ protocolVersion: 2, connectionId: message.connectionId, ...body });
            });
            if (message.type === 'hello') reply({ type: 'hello-ack', protocol: 'placekeeper.chrome-runtime', leaseMs: 90_000 });
            if (message.type === 'begin') reply({ type: 'ack', lane: 'acquisition', requestId: message.requestId });
            if (message.type === 'cancel') reply({ type: 'ack', lane: 'acquisition', requestId: message.requestId });
            if (message.type === 'finish') reply({ type: 'recovery-offered', lane: 'lifecycle', requestId: message.requestId,
              choices: ['resume', 'discard', 'fork'], offer: { id: 'recovery-offer-0001', expiresAt: '2030-01-01T00:00:00.000Z' } });
          },
        }),
      },
    };
    Object.defineProperty(window, 'chrome', { configurable: true, value: chrome });
  });
  const html = await readFile(resolve(`apps/chrome-extension/${entry}.html`), 'utf8');
  await page.route(`**/apps/chrome-extension/${entry}.html`, (route) => route.fulfill({
    contentType: 'text/html', body: html.replaceAll('"/src/', '"/apps/chrome-extension/src/'),
  }));
  await page.goto(`/apps/chrome-extension/${entry}.html`);
}

async function controlStyle(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);
    return { border: style.borderTopWidth, radius: style.borderRadius, font: style.fontSize,
      weight: style.fontWeight, background: style.backgroundColor, color: style.color, minHeight: style.minHeight };
  });
}

test('Chrome protected recovery uses the shared neutral dialog language and remains reachable at narrow sizes', async ({ page }) => {
  await chromePage(page, 'handler');
  const dialog = page.getByRole('dialog', { name: 'Existing review recovered' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeFocused();
  expect(await controlStyle(page, '.handler-dialog')).toMatchObject({ border: '0px', radius: '17px', background: 'rgb(255, 255, 255)' });
  expect(await controlStyle(page, '.handler-dialog h1')).toMatchObject({ font: '15px', weight: '500', color: 'rgb(51, 51, 51)' });
  expect(await controlStyle(page, '[data-recovery-choice="fork"]')).toMatchObject({ border: '0px', radius: '10px', font: '13px', weight: '400', minHeight: '32px', background: 'rgba(0, 0, 0, 0)' });
  await page.getByRole('button', { name: 'Fork', exact: true }).hover();
  await expect.poll(async () => (await controlStyle(page, '[data-recovery-choice="fork"]')).background).toBe('rgb(231, 231, 231)');
  expect((await controlStyle(page, '[data-recovery-choice="discard"]')).background).toBe('rgb(250, 240, 238)');
  for (const viewport of [{ width: 1280, height: 900 }, { width: 320, height: 320 }]) {
    await page.setViewportSize(viewport);
    for (const name of ['Default', 'Discard', 'Fork', 'Resume']) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      const bounds = (await button.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(12);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 12);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 12);
    }
    await page.screenshot({ path: test.info().outputPath(`chrome-recovery-${viewport.width}.png`) });
  }
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Opening the protected review…');
  const choices = await page.evaluate(() => (window as typeof window & {
    __chromeUiAudit: { sent: Record<string, unknown>[] };
  }).__chromeUiAudit.sent.filter(({ type }) => type === 'recover'));
  expect(choices).toHaveLength(1);
  expect(choices[0]).toMatchObject({ decision: 'resume', offer: { id: 'recovery-offer-0001' } });
});

test('Chrome recovery keeps Default separate and keyboard-operable', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chrome extension keyboard traversal is certified in Chromium.');
  await chromePage(page, 'handler');
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Fork', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Discard', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Default', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as typeof window & {
    __chromeUiAudit: { fallback: boolean };
  }).__chromeUiAudit.fallback)).toBe(true);
});

test('Chrome popup opens without toggle focus and preserves switch contrast on hover', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 240 });
  await chromePage(page, 'popup');
  const control = page.getByRole('switch', { name: 'Open PDFs automatically' });
  await expect(control).toBeChecked();
  await expect(page.getByRole('heading', { name: 'Placekeeper', exact: true })).toBeFocused();
  await expect(control).not.toBeFocused();
  await control.hover();
  await expect.poll(async () => (await controlStyle(page, '.switch__control')).background).toBe('rgb(37, 37, 37)');
  await control.click();
  await expect(control).not.toBeChecked();
  await expect.poll(() => control.evaluate((element) => element.matches(':focus-visible'))).toBe(false);
  await page.screenshot({ path: test.info().outputPath('chrome-popup-pointer.png') });
});

test('Chrome popup supports Tab and Space with a neutral keyboard focus ring', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chrome popup keyboard traversal is certified in Chromium.');
  await page.setViewportSize({ width: 320, height: 240 });
  await chromePage(page, 'popup');
  const control = page.getByRole('switch', { name: 'Open PDFs automatically' });
  await expect(page.getByRole('heading', { name: 'Placekeeper', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(control).toBeFocused();
  await expect.poll(() => control.evaluate((element) => getComputedStyle(element).outlineColor)).toBe('rgb(112, 112, 112)');
  await page.keyboard.press('Space');
  await expect(control).not.toBeChecked();
  await expect(control).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('chrome-popup.png') });
});
