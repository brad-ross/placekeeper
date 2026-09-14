import { expect, test, type Page } from '@playwright/test';
import type { ViewerInteractionEvent } from '../../apps/web/src/pdf/viewer-interaction-events.js';
import { PDF_SELECTION_PAGE_LIMIT } from '../../apps/web/src/pdf/selection-page-limit.js';
import type { ViewerSelectionEvidence } from '../../apps/web/src/pdf/viewer-selection-adapter.js';

type SelectionContract = Awaited<ReturnType<Window['viewerAcceptance']['selectionContract']>>;

declare global {
  interface Window {
    __htmlPayloadExecuted: boolean;
    viewerAcceptance: {
      ready: boolean;
      selectionGeometryReady(pageIndex?: number): boolean;
      selectionRectCount(): number;
      selectionContract(): Promise<ViewerSelectionEvidence | null>;
      caretAnchorPageIndex(): number | null;
      caretAnchorLeftContext(): string;
      setZoom(level: number): void;
      zoomLevel(): number;
      selectionAnchorStatus(): string;
      goToPage(pageNumber: number): void;
      reviewItemCount(): number;
      interactionCount(type: ViewerInteractionEvent['type']): number;
    };
  }
}

// These pointer fixtures express positions in PDF points. Keep their initial
// scale explicit; production's fit-to-width default is covered separately.
async function prepareCoordinateFixture(page: Page) {
  await page.waitForFunction(() => window.viewerAcceptance?.ready === true);
  await page.waitForFunction(() => window.viewerAcceptance.selectionGeometryReady(0));
  await expect.poll(async () => {
    await page.evaluate(() => window.viewerAcceptance.setZoom(1));
    return page.locator('[data-page-index="0"]').evaluate(element => element.getBoundingClientRect().width);
  }).toBe(612);
}

async function showSelectablePdfPage(page: Page, pageIndex: number) {
  const pdfPage = page.locator(`[data-page-index="${pageIndex}"]`);
  await expect.poll(async () => {
    await page.evaluate(
      (pageNumber) => window.viewerAcceptance.goToPage(pageNumber),
      pageIndex + 1,
    );
    if (await pdfPage.count() === 0) return false;
    return pdfPage.evaluate((element) => {
      const selectableLineY = element.getBoundingClientRect().top + 98;
      return selectableLineY > 0 && selectableLineY < window.innerHeight;
    });
  }).toBe(true);
  await expect(pdfPage).toBeVisible();
  await page.waitForFunction(
    (targetPageIndex) => window.viewerAcceptance.selectionGeometryReady(targetPageIndex),
    pageIndex,
  );
  return pdfPage;
}

async function dragAcrossSelectionPages(
  page: Page,
  lastPageIndex: number,
  direction: 'forward' | 'reverse',
): Promise<{ evidence: NonNullable<SelectionContract>; intermediateTextOffscreen: boolean }> {
  await page.goto('/test/acceptance/viewer-harness/index.html?fixture=cross-page-selection');
  await prepareCoordinateFixture(page);

  const startPageIndex = direction === 'forward' ? 0 : lastPageIndex;
  const endPageIndex = direction === 'forward' ? lastPageIndex : 0;
  const visitOrder = direction === 'forward'
    ? Array.from({ length: lastPageIndex }, (_, index) => index + 1)
    : Array.from({ length: lastPageIndex }, (_, index) => lastPageIndex - index - 1);
  const startPage = await showSelectablePdfPage(page, startPageIndex);
  const startBox = await startPage.boundingBox();
  if (!startBox) throw new Error('Cross-page selection start page has no bounds.');
  const startX = direction === 'forward' ? startBox.x + 74 : startBox.x + 300;
  await page.mouse.move(startX, startBox.y + 98);
  await page.mouse.down();
  await page.mouse.move(
    direction === 'forward' ? startX + 12 : startX - 12,
    startBox.y + 98,
    { steps: 3 },
  );
  await expect.poll(async () => (await page.evaluate(
    () => window.viewerAcceptance.selectionContract(),
  ))?.selecting).toBe(true);

  for (const pageIndex of visitOrder) {
    const pdfPage = await showSelectablePdfPage(page, pageIndex);
    const box = await pdfPage.boundingBox();
    if (!box) throw new Error(`Cross-page selection page ${pageIndex + 1} has no bounds.`);
    await page.mouse.move(
      direction === 'forward' ? box.x + 300 : box.x + 74,
      box.y + 98,
      { steps: 8 },
    );
  }

  const intermediatePageIndex = Math.floor(lastPageIndex / 2);
  const intermediateImage = page.locator(`[data-page-index="${intermediatePageIndex}"] > img`);
  const intermediateTextOffscreen = await intermediateImage.evaluate((element) => {
    const selectableLineY = element.getBoundingClientRect().top + 98;
    return selectableLineY <= 0 || selectableLineY >= window.innerHeight;
  }).catch(() => true);
  const endPage = page.locator(`[data-page-index="${endPageIndex}"]`);
  await endPage.evaluate((element) => {
    element.dataset.crossPagePointerups = '0';
    element.addEventListener('pointerup', () => {
      element.dataset.crossPagePointerups = String(
        Number(element.dataset.crossPagePointerups ?? '0') + 1,
      );
    }, { once: true });
  });
  await page.mouse.up();
  await expect(endPage).toHaveAttribute('data-cross-page-pointerups', '1');

  await expect.poll(async () => (await page.evaluate(
    () => window.viewerAcceptance.selectionContract(),
  ))?.selecting).toBe(false);
  const evidence = await page.evaluate(() => window.viewerAcceptance.selectionContract());
  if (!evidence) throw new Error('Cross-page selection did not return public semantic evidence.');
  return { evidence, intermediateTextOffscreen };
}

async function selectAcrossPageLimit(page: Page): Promise<{
  withinLimit: NonNullable<SelectionContract>;
  overLimit: NonNullable<SelectionContract>;
}> {
  await page.goto('/test/acceptance/viewer-harness/index.html?fixture=cross-page-selection');
  await prepareCoordinateFixture(page);

  for (let pageIndex = 0; pageIndex <= PDF_SELECTION_PAGE_LIMIT; pageIndex += 1) {
    await page.evaluate(
      (pageNumber) => window.viewerAcceptance.goToPage(pageNumber),
      pageIndex + 1,
    );
    await page.waitForFunction(
      (targetPageIndex) => window.viewerAcceptance.selectionGeometryReady(targetPageIndex),
      pageIndex,
    );
  }

  const startPage = await showSelectablePdfPage(page, 0);
  const startBox = await startPage.boundingBox();
  if (!startBox) throw new Error('Page-limit selection start page has no bounds.');
  await page.mouse.move(startBox.x + 74, startBox.y + 98);
  await page.mouse.down();
  await page.mouse.move(startBox.x + 86, startBox.y + 98, { steps: 3 });
  await expect.poll(async () => (await page.evaluate(
    () => window.viewerAcceptance.selectionContract(),
  ))?.selecting).toBe(true);

  const twelfthPage = await showSelectablePdfPage(page, PDF_SELECTION_PAGE_LIMIT - 1);
  const twelfthBox = await twelfthPage.boundingBox();
  if (!twelfthBox) throw new Error('Twelfth selection page has no bounds.');
  await page.mouse.move(twelfthBox.x + 300, twelfthBox.y + 98, { steps: 8 });
  const withinLimit = await page.evaluate(() => window.viewerAcceptance.selectionContract());
  if (!withinLimit) throw new Error('Twelve-page selection evidence is unavailable.');

  const thirteenthPage = await showSelectablePdfPage(page, PDF_SELECTION_PAGE_LIMIT);
  const thirteenthBox = await thirteenthPage.boundingBox();
  if (!thirteenthBox) throw new Error('Thirteenth selection page has no bounds.');
  await page.mouse.move(thirteenthBox.x + 300, thirteenthBox.y + 98, { steps: 8 });
  await thirteenthPage.evaluate((element) => {
    element.dataset.crossPagePointerups = '0';
    element.addEventListener('pointerup', () => {
      element.dataset.crossPagePointerups = String(
        Number(element.dataset.crossPagePointerups ?? '0') + 1,
      );
    }, { once: true });
  });
  await page.mouse.up();
  await expect(thirteenthPage).toHaveAttribute('data-cross-page-pointerups', '1');
  await expect.poll(async () => (await page.evaluate(
    () => window.viewerAcceptance.selectionContract(),
  ))?.selecting).toBe(false);
  const overLimit = await page.evaluate(() => window.viewerAcceptance.selectionContract());
  if (!overLimit) throw new Error('Thirteen-page selection evidence is unavailable.');
  return { withinLimit, overLimit };
}

test.describe('shared viewer foundation', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', (message) => console.log(`[browser:${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => console.log(`[browser:pageerror] ${error.message}`));
    await page.goto('/test/acceptance/viewer-harness/index.html');
    await prepareCoordinateFixture(page);
    await expect(page.locator('[data-page-index="0"]')).toBeVisible();
  });

  test('uses a real pointer selection without creating edits', async ({ page }) => {
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
    await expect.poll(() => page.evaluate(() => window.viewerAcceptance.selectionRectCount()))
      .toBeGreaterThan(0);
    expect(await renderedPageImage.evaluate((image) => {
      const selection = window.getSelection();
      if (!selection) return false;
      return Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
        .some((range) => range.intersectsNode(image));
    })).toBe(false);
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
    await expect.poll(() => page.evaluate(() => window.viewerAcceptance.zoomLevel()))
      .toBeGreaterThan(1);
    await expect.poll(async () => (await pdfPage.boundingBox())?.width ?? 0).toBeGreaterThan(box.width);

    const zoomedBox = await pdfPage.boundingBox();
    if (!zoomedBox) throw new Error('Zoomed PDF page has no bounds.');
    const zoomScale = zoomedBox.width / box.width;
    await pdfPage.hover({ position: { x: 76 * zoomScale, y: 98 * zoomScale } });
    const stableZoomedBox = await pdfPage.boundingBox();
    if (!stableZoomedBox) throw new Error('Stable zoomed PDF page has no bounds.');
    const stableZoomScale = stableZoomedBox.width / box.width;
    await pdfPage.evaluate((element) => {
      element.dataset.nativeDragstarts = '0';
      element.dataset.pointerdowns = '0';
      element.dataset.pointerups = '0';
    });
    await page.mouse.down();
    await page.mouse.move(
      stableZoomedBox.x + Math.min(455, box.width - 30) * stableZoomScale,
      stableZoomedBox.y + 105 * stableZoomScale,
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

    await expect(page.getByRole('button', { name: 'Proofread mode' })).toHaveCount(0);
    expect(await page.evaluate(() => window.viewerAcceptance.reviewItemCount())).toBe(0);
  });

  for (const direction of ['forward', 'reverse'] as const) {
    test(`completes a real ${direction} cross-page pointer selection`, async ({ page }) => {
      const { evidence, intermediateTextOffscreen } = await dragAcrossSelectionPages(
        page,
        2,
        direction,
      );
      expect(intermediateTextOffscreen).toBe(true);
      expect(evidence).toMatchObject({ active: true, selecting: false, stable: true });
      expect(evidence.formatted.map(({ pageIndex }) => pageIndex)).toEqual([0, 1, 2]);
      expect(evidence.formatted.every(({ segmentRects }) => segmentRects.length > 0)).toBe(true);
      expect(evidence.pages.map(({ pageIndex }) => pageIndex)).toEqual([0, 1, 2]);
      expect(evidence.pages.every(({ geometryCached }) => geometryCached)).toBe(true);
      expect(evidence.geometryPageIndexes).toEqual(expect.arrayContaining([0, 1, 2]));
      expect(evidence.text).toHaveLength(3);
      expect(evidence.text[0]).toContain('PAGE 01');
      expect(evidence.text[1]).toContain('PAGE 02');
      expect(evidence.text[2]).toContain('PAGE 03');
      expect(evidence.selectionGeneration.length).toBeGreaterThan(0);
      const repeatedEvidence = await page.evaluate(() => window.viewerAcceptance.selectionContract());
      expect(repeatedEvidence?.selectionGeneration).toBe(evidence.selectionGeneration);
      expect(repeatedEvidence?.text).toEqual(evidence.text);
    });
  }

  test('retains 12-page evidence and detects a selected 13th page above cache pressure', async ({ page }) => {
    test.setTimeout(90_000);
    const { withinLimit, overLimit } = await selectAcrossPageLimit(page);
    expect(withinLimit).toMatchObject({
      pageCount: PDF_SELECTION_PAGE_LIMIT,
      withinPageLimit: true,
      stable: true,
    });
    expect(withinLimit.pages).toHaveLength(PDF_SELECTION_PAGE_LIMIT);
    expect(withinLimit.formatted).toHaveLength(PDF_SELECTION_PAGE_LIMIT);
    expect(withinLimit.pages.every(({ geometryCached }) => geometryCached)).toBe(true);

    expect(overLimit).toMatchObject({
      pageCount: PDF_SELECTION_PAGE_LIMIT + 1,
      withinPageLimit: false,
      stable: true,
      selection: { start: { page: 0 }, end: { page: PDF_SELECTION_PAGE_LIMIT } },
    });
    expect(overLimit.pages).toHaveLength(PDF_SELECTION_PAGE_LIMIT + 1);
    expect(overLimit.formatted).toHaveLength(PDF_SELECTION_PAGE_LIMIT + 1);
    expect(overLimit.pages.every(({ geometryCached }) => geometryCached)).toBe(true);
    expect(overLimit.pages.every(({ text }) => text === null)).toBe(true);
    expect(overLimit.text).toEqual([]);
  });

  test('never arms text selection from a secondary pointer gesture', async ({ page }) => {
    const pdfPage = page.locator('[data-page-index="0"]');
    await page.waitForFunction(() => window.viewerAcceptance.selectionGeometryReady());
    const box = await pdfPage.boundingBox();
    if (!box) throw new Error('Rendered PDF page has no bounds.');

    await page.mouse.move(box.x + 76, box.y + 98);
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await page.mouse.click(box.x + 500, box.y + 500);
    await page.mouse.move(box.x + 245, box.y + 98);

    await expect.poll(() => page.evaluate(() => window.viewerAcceptance.selectionRectCount()))
      .toBe(0);
  });

  test('treats Control-click as a context gesture without publishing a caret', async ({ page }) => {
    const pdfPage = page.locator('[data-page-index="0"]');
    await page.waitForFunction(() => window.viewerAcceptance.selectionGeometryReady());
    const box = await pdfPage.boundingBox();
    if (!box) throw new Error('Rendered PDF page has no bounds.');
    const caretCountBefore = await page.evaluate(() => window.viewerAcceptance.interactionCount('caret'));

    await page.mouse.move(box.x + 500, box.y + 500);
    await page.keyboard.down('Control');
    await page.mouse.down();
    await page.keyboard.up('Control');
    await page.mouse.up();

    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.viewerAcceptance.interactionCount('caret')))
      .toBe(caretCountBefore);
  });

  test('does not retain DOM pointer capture or block composer actions after reverse SyncTeX', async ({ page }) => {
    const reverseSyncTexModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const reverseSyncTexModifierKey = process.platform === 'darwin'
      ? { metaKey: true }
      : { ctrlKey: true };
    await page.goto(
      '/test/acceptance/viewer-harness/index.html?reverse-synctex=true&composer=replacement',
    );
    await prepareCoordinateFixture(page);
    const pdfPage = page.locator('[data-page-index="0"]');
    await expect(pdfPage).toBeVisible();
    const box = await pdfPage.boundingBox();
    if (!box) throw new Error('Rendered PDF page has no bounds.');

    await page.mouse.move(box.x + 320, box.y + 180);
    await page.keyboard.down(reverseSyncTexModifier);
    await page.mouse.down();
    await page.keyboard.up(reverseSyncTexModifier);

    expect(await pdfPage.evaluate((element) => element.hasPointerCapture(1))).toBe(false);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (
      window.viewerAcceptance.interactionCount('reverse-synctex')
    ))).toBe(1);

    const composer = page.getByRole('region', { name: 'Replacement' });
    await composer.getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => page.evaluate(() => (
      window.viewerAcceptance.composerActionCount('cancel')
    ))).toBe(1);

    await page.mouse.move(box.x + 320, box.y + 180);
    await page.keyboard.down(reverseSyncTexModifier);
    await page.mouse.down();
    await page.keyboard.up(reverseSyncTexModifier);
    await page.mouse.up();
    await composer.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => page.evaluate(() => (
      window.viewerAcceptance.composerActionCount('apply')
    ))).toBe(1);

    await pdfPage.dispatchEvent('pointerdown', {
      pointerId: 91,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
      ...reverseSyncTexModifierKey,
      clientX: box.x + 320,
      clientY: box.y + 180,
    });
    await pdfPage.dispatchEvent('pointermove', {
      pointerId: 91,
      pointerType: 'mouse',
      isPrimary: true,
      button: -1,
      buttons: 0,
      clientX: box.x + 330,
      clientY: box.y + 190,
    });
    await pdfPage.dispatchEvent('pointerup', {
      pointerId: 91,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 0,
      clientX: box.x + 330,
      clientY: box.y + 190,
    });
    expect(await page.evaluate(() => (
      window.viewerAcceptance.interactionCount('reverse-synctex')
    ))).toBe(2);

    const caretCountBefore = await page.evaluate(() => (
      window.viewerAcceptance.interactionCount('caret')
    ));
    await page.mouse.move(box.x + 320, box.y + 180);
    await page.keyboard.down(reverseSyncTexModifier);
    await page.mouse.down();
    await page.keyboard.up(reverseSyncTexModifier);
    await page.mouse.move(box.x - 20, box.y - 20);
    await page.mouse.up();
    await page.mouse.move(box.x + 400, box.y + 220);
    await page.mouse.click(box.x + 400, box.y + 220);

    expect(await page.evaluate(() => (
      window.viewerAcceptance.interactionCount('reverse-synctex')
    ))).toBe(2);
    await expect.poll(() => page.evaluate(() => (
      window.viewerAcceptance.interactionCount('caret')
    ))).toBe(caretCountBefore + 1);
  });

  test('repairs a missing primary release before hover movement', async ({ page }) => {
    const pdfPage = page.locator('[data-page-index="0"]');
    await page.waitForFunction(() => window.viewerAcceptance.selectionGeometryReady());
    const box = await pdfPage.boundingBox();
    if (!box) throw new Error('Rendered PDF page has no bounds.');

    await pdfPage.dispatchEvent('pointerdown', {
      pointerId: 92,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: box.x + 76,
      clientY: box.y + 98,
    });
    await pdfPage.dispatchEvent('pointermove', {
      pointerId: 92,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 0,
      clientX: box.x + 245,
      clientY: box.y + 98,
    });

    await expect.poll(() => page.evaluate(() => window.viewerAcceptance.selectionRectCount()))
      .toBe(0);
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
    await prepareCoordinateFixture(page);
    await expect(page.locator('[data-page-index="0"]')).toBeVisible();
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

  test('publishes insertion carets on every text page', async ({ page }) => {
    await page.goto('/test/acceptance/viewer-harness/index.html?fixture=multi-text');
    await prepareCoordinateFixture(page);
    const first = page.locator('[data-page-index="0"]');
    await expect(first).toBeVisible();
    await page.waitForFunction(() => window.viewerAcceptance.selectionGeometryReady(0));
    await first.click({ position: { x: 150, y: 130 } });
    await expect.poll(() => page.evaluate(() => window.viewerAcceptance.caretAnchorPageIndex()))
      .toBe(0);
    await expect.poll(() => page.evaluate(() => window.viewerAcceptance.caretAnchorLeftContext()))
      .toContain('Repeated insertion context.');

    await page.evaluate(() => window.viewerAcceptance.goToPage(2));
    const second = page.locator('[data-page-index="1"]');
    await expect(second).toBeVisible();
    await page.waitForFunction(() => window.viewerAcceptance.selectionGeometryReady(1));
    await second.click({ position: { x: 150, y: 130 } });
    await expect.poll(() => page.evaluate(() => window.viewerAcceptance.caretAnchorPageIndex()))
      .toBe(1);
    await expect.poll(() => page.evaluate(() => window.viewerAcceptance.caretAnchorLeftContext()))
      .toContain('Repeated insertion context.');
  });

  test('shows the shared recovery path for an unreliable selection', async ({ page }) => {
    await page.goto('/test/acceptance/viewer-harness/index.html?unreliable=selection');
    await prepareCoordinateFixture(page);
    await expect(page.locator('[data-recovery-kind="selection"]')).toContainText(
      'Adjust the selection or use Page Note',
    );
    await expect(page.getByRole('button', { name: 'Page Note' })).toBeEnabled();
  });
});

test('stops the PDF loading indicator animation under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let releaseDocument: (() => void) | undefined;
  await page.route('**/text-native-with-annotations.pdf', async (route) => {
    await new Promise<void>((resolve) => { releaseDocument = resolve; });
    await route.continue();
  });

  try {
    await page.goto('/test/acceptance/viewer-harness/index.html', { waitUntil: 'domcontentloaded' });
    const loader = page.locator('.pdf-workspace__loading');
    await expect(loader).toBeVisible();
    await expect(loader.locator('.review-icon')).toHaveCSS('animation-name', 'none');
  } finally {
    releaseDocument?.();
    await page.unrouteAll({ behavior: 'wait' });
  }
});


test('reports an unreadable PDF instead of leaving the local loading screen forever', async ({ page }) => {
  await page.route('**/test/fixtures/pdfs/text-native-with-annotations.pdf', (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: '' }));
  await page.goto('/test/acceptance/viewer-harness/index.html');
  await expect(page.getByRole('alert').filter({ hasText: 'This PDF could not be loaded.' })).toBeVisible();
  await expect(page.getByText('Loading local PDF…', { exact: true })).toHaveCount(0);
});
