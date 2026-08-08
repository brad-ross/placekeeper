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
    const renderedPageImage = pdfPage.locator(':scope > img');
    await expect(renderedPageImage).toBeVisible();
    await pdfPage.evaluate((element) => {
      element.dataset.nativeDragstarts = '0';
      element.dataset.pointerdowns = '0';
      element.dataset.pointerups = '0';
      element.addEventListener('dragstart', () => {
        element.dataset.nativeDragstarts = String(
          Number(element.dataset.nativeDragstarts ?? '0') + 1,
        );
      });
      element.addEventListener('pointerdown', (event) => {
        element.dataset.pointerdowns = String(Number(element.dataset.pointerdowns ?? '0') + 1);
        element.dataset.pointerdownTarget = event.target === element ? 'page' : 'descendant';
      });
      element.addEventListener('pointerup', (event) => {
        element.dataset.pointerups = String(Number(element.dataset.pointerups ?? '0') + 1);
        element.dataset.pointerupTarget = event.target === element ? 'page' : 'descendant';
      });
    });
    const box = await pdfPage.boundingBox();
    if (!box) throw new Error('Rendered PDF page has no bounds.');

    await page.mouse.move(box.x + 76, box.y + 98);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(455, box.width - 30), box.y + 105, { steps: 12 });
    await page.mouse.up();

    await expect(renderedPageImage).toHaveCSS('pointer-events', 'none');
    await expect(pdfPage).toHaveAttribute('data-native-dragstarts', '0');
    await expect(pdfPage).toHaveAttribute('data-pointerdowns', '1');
    await expect(pdfPage).toHaveAttribute('data-pointerups', '1');
    await expect(pdfPage).toHaveAttribute('data-pointerdown-target', 'page');
    await expect(pdfPage).toHaveAttribute('data-pointerup-target', 'page');
    await expect.poll(() => page.evaluate(() => window.viewerAcceptance.selectionRectCount())).toBeGreaterThan(0);
    const visibleSelection = pdfPage.locator(':scope > div[style*="mix-blend-mode"]');
    await expect(visibleSelection).toBeVisible();
    await expect(visibleSelection).toHaveCSS('pointer-events', 'none');
    await expect
      .poll(() => page.evaluate(() => window.viewerAcceptance.selectionAnchorStatus()))
      .toBe('reliable');
    expect(await page.evaluate(() => window.viewerAcceptance.reviewItemCount())).toBe(0);

    await pdfPage.click({ position: { x: box.width - 30, y: box.height - 30 } });
    await expect.poll(() => page.evaluate(() => window.viewerAcceptance.selectionRectCount())).toBe(0);
    await expect(visibleSelection).toHaveCount(0);

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -10);
    await page.keyboard.up('Control');
    await expect.poll(async () => (await pdfPage.boundingBox())?.width ?? 0).toBeGreaterThan(box.width);

    await pdfPage.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    const zoomedBox = await pdfPage.boundingBox();
    if (!zoomedBox) throw new Error('Zoomed PDF page has no bounds.');
    const zoomScale = zoomedBox.width / box.width;
    await pdfPage.evaluate((element) => {
      element.dataset.nativeDragstarts = '0';
      element.dataset.pointerdowns = '0';
      element.dataset.pointerups = '0';
    });
    await page.mouse.move(zoomedBox.x + 76 * zoomScale, zoomedBox.y + 98 * zoomScale);
    await page.mouse.down();
    await page.mouse.move(
      zoomedBox.x + Math.min(455, box.width - 30) * zoomScale,
      zoomedBox.y + 105 * zoomScale,
      { steps: 12 },
    );
    await page.mouse.up();

    await expect(pdfPage).toHaveAttribute('data-native-dragstarts', '0');
    await expect(pdfPage).toHaveAttribute('data-pointerdowns', '1');
    await expect(pdfPage).toHaveAttribute('data-pointerups', '1');
    await expect
      .poll(() => page.evaluate(() => window.viewerAcceptance.selectionRectCount()))
      .toBeGreaterThan(0);

    await pdfPage.evaluate((element) => {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const overflowY = getComputedStyle(ancestor).overflowY;
        if (/^(auto|scroll)$/u.test(overflowY) && ancestor.scrollHeight > ancestor.clientHeight) {
          ancestor.dataset.viewerScrollViewport = 'true';
          return;
        }
      }
      throw new Error('Viewer scroll viewport is missing.');
    });
    const scrollViewport = page.locator('[data-viewer-scroll-viewport="true"]');
    await scrollViewport.hover();
    await page.mouse.wheel(0, 160);
    await expect.poll(() => scrollViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(renderedPageImage).toHaveCSS('pointer-events', 'none');

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
    await expect(page.locator('[data-owned-annotation-layer]')).toHaveCSS('pointer-events', 'none');
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
