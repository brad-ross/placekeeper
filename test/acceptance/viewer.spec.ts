import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __htmlPayloadExecuted: boolean;
    viewerAcceptance: {
      ready: boolean;
      selectionGeometryReady(): boolean;
      selectionRectCount(): number;
      selectionAnchorStatus(): string;
      goToPage(pageNumber: number): void;
      reviewItemCount(): number;
    };
  }
}

test.describe('shared viewer foundation', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', (message) => console.log(`[browser:${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => console.log(`[browser:pageerror] ${error.message}`));
    await page.goto('/test/acceptance/viewer-harness/index.html');
    await page.waitForFunction(() => window.viewerAcceptance?.ready === true);
    await expect(page.locator('[data-page-index="0"]')).toBeVisible();
  });

  test('uses a real pointer selection without creating edits outside Proofread mode', async ({ page }) => {
    const pdfPage = page.locator('[data-page-index="0"]');
    await page.waitForFunction(() => window.viewerAcceptance.selectionGeometryReady());
    const box = await pdfPage.boundingBox();
    if (!box) throw new Error('Rendered PDF page has no bounds.');

    await page.mouse.move(box.x + 76, box.y + 98);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(455, box.width - 30), box.y + 105, { steps: 12 });
    await page.mouse.up();

    await expect.poll(() => page.evaluate(() => window.viewerAcceptance.selectionRectCount())).toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => window.viewerAcceptance.selectionAnchorStatus()))
      .toBe('reliable');
    expect(await page.evaluate(() => window.viewerAcceptance.reviewItemCount())).toBe(0);

    const proofread = page.getByRole('button', { name: 'Proofread mode' });
    await proofread.focus();
    await page.keyboard.press('Space');
    await expect(proofread).toHaveAttribute('aria-pressed', 'true');
    await proofread.click();
    await expect(proofread).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => window.viewerAcceptance.reviewItemCount())).toBe(0);
  });

  test('renders source and tool strings as inert text and keeps annotations read-only', async ({ page }) => {
    const inventory = page.getByLabel('Existing annotations');
    const payload = '<img src=x onerror="globalThis.__htmlPayloadExecuted=true">';
    await expect(inventory.getByRole('listitem')).toHaveCount(4);
    await expect(inventory.getByText('Existing supported highlight')).toBeVisible();
    await expect(inventory.getByText('Existing unsupported stamp')).toBeVisible();
    await expect(page.locator('[data-document-title]')).toContainText(payload);
    await expect(page.getByRole('alert')).toContainText(payload);
    await expect(inventory.getByRole('listitem').filter({ hasText: payload })).toHaveCount(1);
    expect(await page.evaluate(() => window.__htmlPayloadExecuted)).toBe(false);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(page.locator('[data-source-annotation-layer]')).toHaveCSS('pointer-events', 'none');
  });

  test('keeps Page Note and navigation available when page semantics are unavailable', async ({ page }) => {
    await page.goto('/test/acceptance/viewer-harness/index.html?fixture=mixed');
    await page.waitForFunction(() => window.viewerAcceptance?.ready === true);
    await expect(page.locator('[data-page-index="0"]')).toBeVisible();
    const proofread = page.getByRole('button', { name: 'Proofread mode' });
    await proofread.click();
    await expect(page.locator('[data-semantic-tools-enabled]')).toHaveAttribute(
      'data-semantic-tools-enabled',
      'true',
    );
    await page.evaluate(() => window.viewerAcceptance.goToPage(2));
    await expect(page.locator('[data-recovery-kind="page"]')).toContainText('Page Note');
    await expect(page.getByRole('button', { name: 'Page Note' })).toBeEnabled();
    await expect(page.locator('[data-semantic-tools-enabled]')).toHaveAttribute(
      'data-semantic-tools-enabled',
      'false',
    );
    await expect(page.locator('[data-page-index="1"]')).toBeVisible();
  });

  test('shows the shared recovery path for an unreliable selection', async ({ page }) => {
    await page.goto('/test/acceptance/viewer-harness/index.html?unreliable=selection');
    await page.waitForFunction(() => window.viewerAcceptance?.ready === true);
    await expect(page.locator('[data-recovery-kind="selection"]')).toContainText(
      'Adjust the selection or use Page Note',
    );
    await expect(page.getByRole('button', { name: 'Page Note' })).toBeEnabled();
  });
});
