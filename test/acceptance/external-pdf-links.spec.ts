import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { PlacekeeperHost } from '../../apps/service/src/host/placekeeper-host.js';

const destination = 'https://example.com/paper?q=one#abstract';
let root: string;
let host: PlacekeeperHost;
let source: string;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'placekeeper-web-links-'));
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = [pdf.addPage([612, 792]), pdf.addPage([612, 792])];
  for (const page of pages) {
    page.drawText('Read the paper online', { x: 72, y: 660, font, size: 16 });
    page.drawText('https://printed.example.com (plain text)', { x: 72, y: 600, font, size: 12 });
    page.node.set(PDFName.of('Annots'), pdf.context.obj([
      pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [72, 650, 300, 680],
        A: { S: 'URI', URI: PDFString.of(destination) } })),
      pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [72, 550, 300, 580],
        Dest: [pages[1]!.ref, 'XYZ', 0, 720, 0] })),
      pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [72, 500, 300, 530],
        A: { S: 'URI', URI: PDFString.of('file:///tmp/should-not-open') } })),
    ]));
    page.drawText('Open the second page', { x: 72, y: 560, font, size: 16 });
    page.drawText('Non-web destination', { x: 72, y: 510, font, size: 16 });
  }
  source = join(root, 'web-links.pdf');
  await writeFile(source, await pdf.save());
});
test.beforeEach(async () => {
  host = await PlacekeeperHost.start({ recoveryRoot: join(root, randomUUID()), webAssets: { root: resolve('dist/web') } });
});
test.afterEach(async ({ page }) => { await page.context().close(); await host.close(); });
test.afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  const result = await host.open({ pdfPath: source, fork: true });
  if (!result.ok || result.kind === 'recovery-offered') throw new Error('Fixture failed to open');
  await page.goto(result.url);
  await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true', { timeout: 15000 });
  return page.locator('.pdf-workspace:not(.pdf-workspace--reference)');
}

test('click and keyboard open a new tab without moving either PDF surface', async ({ page, context }) => {
  await context.route('https://example.com/**', route => route.fulfill({ body: '<title>Destination</title>Paper', contentType: 'text/html' }));
  const main = await open(page);
  const link = main.getByRole('button', { name: `Open web link: ${destination}`, exact: true }).first();
  await expect(link).toBeVisible();
  const originalUrl = page.url();
  const before = await main.locator('[data-viewer-framing-viewport]').evaluate(el => el.scrollTop);
  expect(context.pages()).toHaveLength(1);
  await link.hover();
  await expect(page.getByRole('tooltip')).toHaveText(destination);
  expect(context.pages()).toHaveLength(1);
  const newPage = context.waitForEvent('page');
  await link.click();
  const opened = await newPage;
  await opened.waitForLoadState();
  expect(opened.url()).toBe(destination);
  expect(await opened.evaluate(() => window.opener)).toBeNull();
  await opened.close();
  expect(page.url()).toBe(originalUrl);
  expect(await main.locator('[data-viewer-framing-viewport]').evaluate(el => el.scrollTop)).toBe(before);
  await main.getByRole('button', { name: 'Open PDF link to Page 2', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Open in References' }).click();
  const reference = page.locator('.pdf-workspace--reference');
  const refLink = reference.locator(".pdf-workspace__page[data-page-index='1']").getByRole('button', { name: `Open web link: ${destination}`, exact: true });
  await expect(refLink).toBeVisible();
  await expect(page.locator('[data-reference-pending="loading"]')).toHaveCount(0);
  await refLink.scrollIntoViewIfNeeded();
  await page.keyboard.press('Tab');
  await refLink.evaluate(el => (el as HTMLElement).focus({ preventScroll: true }));
  await expect(page.getByRole('tooltip')).toHaveText(destination);
  expect(context.pages()).toHaveLength(1);
  const referenceBefore = await reference.locator('[data-viewer-framing-viewport]').evaluate(el => el.scrollTop);
  const secondPage = context.waitForEvent('page');
  await refLink.press('Enter');
  const second = await secondPage;
  await second.waitForLoadState();
  expect(second.url()).toBe(destination);
  await second.close();
  expect(await reference.locator('[data-viewer-framing-viewport]').evaluate(el => el.scrollTop)).toBe(referenceBefore);
  await expect(reference).toBeVisible();
  expect(await main.locator('[data-viewer-framing-viewport]').evaluate(el => el.scrollTop)).toBe(before);
});

test('rejected opening keeps a selectable URL and handles clipboard denial', async ({ page }) => {
  const main = await open(page);
  await page.evaluate(() => {
    window.open = () => { throw new Error('Host rejected'); };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } });
  });
  await main.getByRole('button', { name: `Open web link: ${destination}`, exact: true }).first().click();
  await expect(page.getByRole('alert')).toHaveText('Couldn’t open this link');
  const url = page.getByLabel('Web link URL', { exact: true });
  await expect(url).toHaveText(destination);
  await page.getByRole('button', { name: 'Copy URL', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Select the link to copy it manually.' })).toBeVisible();
  await url.focus();
  expect(await url.evaluate(el => getComputedStyle(el).userSelect)).toBe('text');
  await page.screenshot({ path: '/tmp/placekeeper-link-recovery-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(url).toBeVisible();
  expect(await page.locator('.external-link-recovery').evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '/tmp/placekeeper-link-recovery-mobile.png' });
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; } } }));
  await page.getByRole('button', { name: 'Copy URL', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'URL copied.' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(destination);
  await page.getByRole('button', { name: 'Dismiss link error', exact: true }).click();
  await expect(url).toHaveCount(0);
});

test('printed URLs and non-web actions never call the opener', async ({ page }) => {
  const main = await open(page);
  await page.evaluate(() => { window.open = () => { throw new Error('Unexpected opening'); }; });
  await expect(main.getByRole('button', { name: /printed.example/ })).toHaveCount(0);
  await main.getByRole('button', { name: 'PDF link target unavailable', exact: true }).first().click();
  await expect(page.getByLabel('Web link URL', { exact: true })).toHaveCount(0);
});
