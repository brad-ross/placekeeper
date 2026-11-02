import { expect, test, type Page } from '@playwright/test';
import { addStaticKeyboardPageNote, waitForStaticPdf } from '../../scripts/static-browser-journey.js';

const mainPage = (page: Page, index = 0) => page.locator(`.review-document .pdf-workspace__page[data-page-index="${index}"]`);
const viewport = (page: Page) => page.locator('.review-document [data-viewer-framing-viewport]');
const fitButton = (page: Page) => page.locator('[data-review-zoom-action="fit-width"]');

async function openBook(page: Page, scan = false) {
  await page.setViewportSize({ width: 900, height: 1100 });
  await page.goto(`/test/acceptance/review-harness/?fit-modes=${scan ? 'scan' : 'book'}`);
  await waitForStaticPdf(page);
  await expect(page.getByRole('textbox', { name: /^Current zoom/u })).toBeEnabled();
}

async function openZoom(page: Page) {
  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await page.getByRole('button', { name: 'Open zoom controls' }).hover();
  await expect(page.getByRole('menu', { name: 'PDF zoom', exact: true })).toBeVisible();
}

async function fit(page: Page, mode: 'page' | 'width' | 'text') {
  await openZoom(page);
  await fitButton(page).hover();
  await page.getByRole('menuitemradio', { name: `Fit ${mode}`, exact: true }).click();
  await expect(fitButton(page)).toHaveAttribute('aria-busy', 'false');
  await expect(fitButton(page)).toHaveAttribute('data-fit-mode', mode);
  await page.keyboard.press('Escape');
  await page.mouse.move(0, 1090);
}

async function goToPage(page: Page, number: number) {
  const input = page.getByRole('textbox', { name: /^Current page/u });
  await input.fill(String(number));
  await input.press('Enter');
  await expect(mainPage(page, number - 1)).toBeVisible();
  await expect(input).toHaveValue(String(number));
}

async function scale(page: Page, index = 0, width = 600) {
  return mainPage(page, index).evaluate((element, naturalWidth) => element.getBoundingClientRect().width / naturalWidth, width);
}

test('cycles fit modes, supports keyboard choices, and releases horizontal lock only when zoom changes', async ({ page }) => {
  await openBook(page);
  await fit(page, 'width');
  await openZoom(page);
  await fitButton(page).click();
  await expect(fitButton(page)).toHaveAttribute('data-fit-mode', 'text');
  await expect(fitButton(page)).toHaveAttribute('aria-busy', 'false');
  await fitButton(page).focus();
  await fitButton(page).press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: 'Fit page', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(fitButton(page)).toHaveAttribute('data-fit-mode', 'page');
  await fit(page, 'text');
  await openZoom(page);
  await page.locator('[data-review-horizontal-lock]').click();
  const stage = page.locator('[data-review-stage]');
  await expect(stage).toHaveAttribute('data-horizontal-scroll-locked', 'true');
  // An explicit unchanged entry releases fit ownership, but does not change numeric scale.
  const zoomInput = page.getByRole('textbox', { name: /^Current zoom/u });
  await zoomInput.focus();
  await zoomInput.press('Enter');
  await openZoom(page);
  await expect(fitButton(page)).toHaveAttribute('data-fit-active', 'false');
  await expect(stage).toHaveAttribute('data-horizontal-scroll-locked', 'true');
  await page.getByRole('menuitem', { name: 'Zoom in', exact: true }).click();
  await expect(stage).not.toHaveAttribute('data-horizontal-scroll-locked', 'true');
  await fitButton(page).click();
  await expect(fitButton(page)).toHaveAttribute('data-fit-mode', 'page');
});

test('aligns adjacent book text simultaneously and keeps one scale through columns and textless pages', async ({ page }) => {
  await openBook(page);
  await fit(page, 'text');
  const initialScale = await scale(page);
  expect(initialScale).toBeGreaterThan(2);
  await viewport(page).evaluate((element) => {
    const first = element.querySelector('[data-page-index="0"]')!.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    element.scrollTop += first.bottom - bounds.top - bounds.height / 2;
  });
  await expect(mainPage(page, 1)).toBeVisible();
  await expect.poll(async () => {
    const centers = await Promise.all([0, 1].map(async (index) => mainPage(page, index).evaluate((element, naturalCenter) => {
      const rect = element.getBoundingClientRect();
      return rect.left + naturalCenter * rect.width / 600;
    }, index === 0 ? 240 : 360)));
    return Math.abs(centers[0]! - centers[1]!);
  }).toBeLessThan(1);
  await page.screenshot({ path: test.info().outputPath('aligned-book-pages.png') });
  for (const number of [3, 4, 5, 6, 7]) {
    await goToPage(page, number);
    expect(await scale(page, number - 1, number === 7 ? 800 : 600)).toBeCloseTo(initialScale, 3);
  }
  await goToPage(page, 4);
  await viewport(page).evaluate((element) => { element.scrollLeft = 0; });
  const left = await mainPage(page, 3).boundingBox();
  const frame = await viewport(page).boundingBox();
  expect(left!.x).toBeGreaterThanOrEqual(frame!.x - 2);
  await viewport(page).evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  const right = await mainPage(page, 3).boundingBox();
  expect(right!.x + right!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 2);
  const zoom = page.getByRole('textbox', { name: /^Current zoom/u });
  await zoom.fill('150');
  await zoom.press('Enter');
  await expect.poll(() => scale(page, 3)).toBeCloseTo(1.5, 3);
  await expect(mainPage(page, 3)).not.toHaveCSS('transform', 'none');
  await fit(page, 'width');
  await expect(mainPage(page, 3)).toHaveCSS('transform', 'none');
});

test('fits the whole page after height changes and reports a textless document fallback', async ({ page }) => {
  await openBook(page);
  await fit(page, 'page');
  const previous = await scale(page);
  await page.setViewportSize({ width: 900, height: 700 });
  await openZoom(page);
  await expect(fitButton(page)).toHaveAttribute('data-fit-active', 'true');
  await expect.poll(() => scale(page)).toBeLessThan(previous - 0.1);
  const bounds = await mainPage(page).boundingBox();
  const frame = await viewport(page).boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(frame!.y - 2);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 2);
  await openBook(page, true);
  await fit(page, 'text');
  await openZoom(page);
  await expect(fitButton(page)).toHaveAccessibleName(/no reliable text bounds/iu);
  await page.reload();
  await waitForStaticPdf(page);
  await openZoom(page);
  await expect(fitButton(page)).toHaveAttribute('data-fit-mode', 'width');
});

test('selection, page notes, and distant destinations follow shifted page geometry', async ({ page }) => {
  await openBook(page);
  await fit(page, 'text');
  await viewport(page).evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(async () => (await mainPage(page).boundingBox())!.y).toBeGreaterThan(40);
  const initialScale = await scale(page);
  const first = await mainPage(page).boundingBox();
  // Select a body row below the first-page link.
  await page.mouse.move(first!.x + 90 * initialScale, first!.y + 116 * initialScale);
  await page.mouse.down();
  await page.mouse.move(first!.x + 270 * initialScale, first!.y + 116 * initialScale, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole('toolbar', { name: 'Selection review actions' })).toBeVisible();
  await expect(page.locator('[data-pdf-native-selection-bridge="main"]')).toHaveText(/^Body page 01 line 03: selectab/u);
  await page.keyboard.press('Escape');
  await addStaticKeyboardPageNote(page, 'A note on the aligned page');
  const mark = page.locator('[data-owned-mark="pageNote"]');
  const parentIndex = await mark.evaluate((element) => element.closest('[data-page-index]')?.getAttribute('data-page-index'));
  expect(parentIndex).toBe('0');
  const notePosition = () => mark.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const pdf = element.closest('.pdf-workspace__page')!.getBoundingClientRect();
    const zoom = pdf.width / 600;
    return { x: (rect.left - pdf.left) / zoom, y: (rect.top - pdf.top) / zoom };
  });
  expect(Math.abs((await notePosition()).x - 304)).toBeLessThan(0.25);
  expect(Math.abs((await notePosition()).y - 400)).toBeLessThan(0.25);
  await fit(page, 'width');
  expect(Math.abs((await notePosition()).x - 304)).toBeLessThan(0.25);
  expect(Math.abs((await notePosition()).y - 400)).toBeLessThan(0.25);
  await fit(page, 'text');
  await goToPage(page, 1);
  const link = page.getByRole('button', { name: /Open PDF link.*Page 12/iu }).first();
  await link.scrollIntoViewIfNeeded();
  await link.focus();
  await link.press('Enter');
  const destinationFrames = await page.getByRole('menuitem', { name: 'Open in main document', exact: true })
    .evaluate((button) => new Promise<{ x: number; y: number; width: number; height: number }[]>((resolve) => {
      const samples: { x: number; y: number; width: number; height: number }[] = [];
      let frames = 0;
      const sample = () => {
        const target = document.querySelector('.review-document .pdf-workspace__page[data-page-index="11"]');
        const viewport = document.querySelector('.review-document [data-viewer-framing-viewport]')!;
        const rect = target?.getBoundingClientRect();
        const frame = viewport.getBoundingClientRect();
        if (rect && rect.bottom > frame.top && rect.top < frame.bottom) {
          const zoom = rect.width / 600;
          samples.push({ x: rect.left + 210 * zoom - frame.left, y: rect.top + 80 * zoom - frame.top, width: frame.width, height: frame.height });
        }
        if (++frames < 40) requestAnimationFrame(sample);
        else resolve(samples);
      };
      (button as HTMLElement).click();
      requestAnimationFrame(sample);
    }));
  expect(destinationFrames.length).toBeGreaterThan(0);
  for (const frame of destinationFrames) {
    expect(frame.x).toBeGreaterThanOrEqual(-2);
    expect(frame.x).toBeLessThan(frame.width);
    expect(frame.y).toBeGreaterThanOrEqual(-2);
    expect(frame.y).toBeLessThan(frame.height);
  }
  await expect(mainPage(page, 11)).toBeVisible();
  expect(await scale(page, 11)).toBeCloseTo(initialScale, 3);
  const destination = await mainPage(page, 11).boundingBox();
  const frame = await viewport(page).boundingBox();
  const targetX = destination!.x + 210 * initialScale;
  const targetY = destination!.y + 80 * initialScale;
  expect(targetX).toBeGreaterThanOrEqual(frame!.x - 2);
  expect(targetX).toBeLessThan(frame!.x + frame!.width);
  expect(targetY).toBeGreaterThanOrEqual(frame!.y - 2);
  expect(targetY).toBeLessThan(frame!.y + frame!.height);
});

test('active text fitting follows right workspace closure while custom zoom stays fixed', async ({ page }) => {
  await openBook(page);
  await page.setViewportSize({ width: 1400, height: 1100 });
  const workspace = page.locator('#review-tools-workspace');
  await page.getByRole('button', { name: 'Show workspace', exact: true }).click();
  await expect(workspace).toHaveAttribute('data-tools-workspace-open', 'true');
  await fit(page, 'text');
  const dockedScale = await scale(page);
  await page.getByRole('button', { name: 'Hide workspace', exact: true }).click();
  await expect(workspace).toHaveAttribute('data-tools-workspace-open', 'false');
  await expect.poll(() => scale(page)).toBeGreaterThan(dockedScale + 0.1);
  await openZoom(page);
  await expect(fitButton(page)).toHaveAttribute('data-fit-active', 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Show workspace', exact: true }).click();
  await expect(workspace).toHaveAttribute('data-tools-workspace-open', 'true');
  const zoom = page.getByRole('textbox', { name: /^Current zoom/u });
  await zoom.fill('150');
  await zoom.press('Enter');
  await expect.poll(() => scale(page)).toBeCloseTo(1.5, 3);
  await page.getByRole('button', { name: 'Hide workspace', exact: true }).click();
  await expect(workspace).toHaveAttribute('data-tools-workspace-open', 'false');
  // Read beyond the resize debounce and CSS transition to detect an unwanted refit.
  const samples = await mainPage(page).evaluate((element) => new Promise<number[]>((resolve) => {
    const values: number[] = [];
    const start = performance.now();
    const sample = () => {
      values.push(element.getBoundingClientRect().width / 600);
      if (performance.now() - start < 700) requestAnimationFrame(sample);
      else resolve(values);
    };
    sample();
  }));
  for (const value of samples) expect(value).toBeCloseTo(1.5, 3);
});
