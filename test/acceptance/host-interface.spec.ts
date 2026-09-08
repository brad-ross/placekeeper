import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

test('host bootstrap loads the outline for a resumed document generation', async ({ page }) => {
  await page.goto('/test/acceptance/review-harness/?host-history=1&host-resumed=1');
  await page.getByRole('button', { name: 'Finish host bootstrap' }).click();
  await expect(page.getByRole('textbox', { name: /^Current page \d+ of 4/u })).toBeVisible();
  const show = page.getByRole('button', { name: 'Show workspace', exact: true });
  if (await show.isVisible()) await show.click();
  await page.getByRole('tab', { name: 'Outline', exact: true }).click();
  const destination = page.getByRole('button', { name: 'Overview, Page 2', exact: true });
  await expect(destination).toBeVisible();
  await destination.click();
  await expect(page.getByRole('textbox', { name: /^Current page \d+ of 4/u })).toHaveValue('2');
  await expect(page.locator('[data-outline-state="loading"]')).toHaveCount(0);
});

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
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
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

async function openAnimatedHostReview(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/test/acceptance/review-harness/?host-history=1');
  // This host harness normally omits the production root's design tokens.
  await page.locator('#root').evaluate((root) => { root.dataset.productionRoot = 'true'; });
  await page.getByRole('button', { name: 'Finish host bootstrap' }).click();
  await expect(page.locator('[data-page-index="0"]').first()).toBeVisible();
  await page.waitForTimeout(500);
}

test('normal-motion workspace opening fits once after the tray settles', async ({ page }) => {
  await openAnimatedHostReview(page);
  const samples = await page.evaluate(() => new Promise<{ width: number; trayX: number }[]>((resolve) => {
    const pdf = document.querySelector<HTMLElement>('[data-page-index="0"]')!;
    const tray = document.querySelector<HTMLElement>('#review-tools-workspace')!;
    const samples: { width: number; trayX: number }[] = [];
    const start = performance.now();
    const sample = () => {
      samples.push({ width: pdf.getBoundingClientRect().width, trayX: tray.getBoundingClientRect().x });
      if (performance.now() - start < 900) requestAnimationFrame(sample);
      else resolve(samples);
    };
    sample();
    document.querySelector<HTMLButtonElement>('button[aria-label="Show workspace"]')!.click();
  }));
  const first = samples[0]!;
  const last = samples.at(-1)!;
  expect(last.width).toBeLessThan(first.width - 100);
  expect(samples.some((sample) => sample.trayX < first.trayX - 5 && sample.trayX > last.trayX + 5)).toBe(true);
  for (let index = 1; index < samples.length; index += 1) {
    expect(samples[index]!.width).toBeLessThanOrEqual(samples[index - 1]!.width + 2);
  }
  const closing = await page.evaluate(() => new Promise<{ width: number; x: number }[]>((resolve) => {
    const pdf = document.querySelector<HTMLElement>('[data-page-index="0"]')!;
    const samples: { width: number; x: number }[] = [];
    const start = performance.now();
    const sample = () => {
      const rect = pdf.getBoundingClientRect();
      samples.push({ width: rect.width, x: rect.x });
      if (performance.now() - start < 400) requestAnimationFrame(sample);
      else resolve(samples);
    };
    sample();
    document.querySelector<HTMLButtonElement>('button[aria-label="Hide workspace"]')!.click();
  }));
  expect(closing.every((sample) => Math.abs(sample.width - last.width) < 2)).toBe(true);
  expect(closing.at(-1)!.x).toBeGreaterThan(closing[0]!.x + 100);
  expect(closing.some((sample) => sample.x > closing[0]!.x + 5 && sample.x < closing.at(-1)!.x - 5)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('[data-viewer-framing-viewport]')).toHaveCSS('transition-duration', '0s');
});

for (const width of [1280, 640]) {
  test(`References retains its height throughout its animated exit at ${width}px`, async ({ page }) => {
    await openAnimatedHostReview(page, width);
    await page.getByRole('button', { name: 'Open PDF link to Primary result, Page 2', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open in References', exact: true }).click();
    const references = page.locator('.review-workspace');
    await expect(references).toHaveAttribute('data-workspace-open', 'true');
    await page.waitForTimeout(300);
    const samples = await page.evaluate(() => new Promise<{ height: number; y: number }[]>((resolve) => {
      const tray = document.querySelector<HTMLElement>('.review-workspace')!;
      const samples: { height: number; y: number }[] = [];
      const start = performance.now();
      const sample = () => {
        const rect = tray.getBoundingClientRect();
        samples.push({ height: rect.height, y: rect.y });
        if (performance.now() - start < 500) requestAnimationFrame(sample);
        else resolve(samples);
      };
      sample();
      tray.querySelector<HTMLButtonElement>('button[aria-label="Hide References"], button[aria-label="Hide workspace"]')!.click();
    }));
    const first = samples[0]!;
    const last = samples.at(-1)!;
    expect(first.height).toBeGreaterThan(100);
    expect(samples.every((sample) => Math.abs(sample.height - first.height) < 1)).toBe(true);
    expect(last.y).toBeGreaterThan(first.y + 100);
    expect(samples.some((sample) => sample.y > first.y + 5 && sample.y < last.y - 5)).toBe(true);
  });
}

for (const { referencesOpen, tall } of [
  { referencesOpen: false, tall: false },
  { referencesOpen: true, tall: false },
  { referencesOpen: false, tall: true },
  { referencesOpen: true, tall: true },
]) {
  test(`workspace opening at low zoom commits its first fitted frame with References ${referencesOpen ? 'open' : 'closed'} in a ${tall ? 'tall' : 'standard'} viewport`, async ({ page }) => {
    await openAnimatedHostReview(page);
    if (tall) await page.setViewportSize({ width: 1006, height: 1481 });
    if (referencesOpen) {
      await page.getByRole('button', { name: 'Open PDF link to Primary result, Page 2', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Open in References', exact: true }).click();
      await expect(page.locator('.review-workspace')).toHaveAttribute('data-workspace-open', 'true');
    }
    const zoom = page.getByRole('textbox', { name: /Current zoom/ });
    await zoom.fill('60');
    await zoom.press('Enter');
    await page.waitForTimeout(400);
    const samples = await page.evaluate(() => new Promise<{ width: number; y: number; trayHeight: number; trayX: number }[]>((resolve) => {
      const pdf = document.querySelector<HTMLElement>('[data-page-index="0"]')!;
      const tray = document.querySelector<HTMLElement>('#review-tools-workspace')!;
      const samples: { width: number; y: number; trayHeight: number; trayX: number }[] = [];
      const start = performance.now();
      const sample = () => {
        const rect = pdf.getBoundingClientRect();
        const trayRect = tray.getBoundingClientRect();
        samples.push({ width: rect.width, y: rect.y, trayHeight: trayRect.height, trayX: trayRect.x });
        if (performance.now() - start < 900) requestAnimationFrame(sample);
        else resolve(samples);
      };
      sample();
      document.querySelector<HTMLButtonElement>('button[aria-label="Show workspace"]')!.click();
    }));
    const first = samples[0]!;
    const last = samples.at(-1)!;
    expect(last.width).toBeGreaterThan(first.width + 100);
    const fittedFrames = samples.filter((sample) => Math.abs(sample.width - last.width) < 2);
    expect(fittedFrames.length).toBeGreaterThan(2);
    for (const frame of fittedFrames) expect(Math.abs(frame.y - last.y)).toBeLessThan(2);
    expect(samples.every((sample) => Math.abs(sample.trayHeight - first.trayHeight) < 1)).toBe(true);
    expect(samples.some((sample) => sample.trayX < first.trayX - 5 && sample.trayX > last.trayX + 5)).toBe(true);
  });
}
