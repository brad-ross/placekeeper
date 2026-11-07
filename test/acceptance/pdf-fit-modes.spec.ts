import { reviewEdgeGeometry } from '../../scripts/testing/review-edge-geometry.js';
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

test('mounts an asynchronously bootstrapped HTTP static session without desktop worker resources', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const target = window as typeof window & { __runtimeWorkerUrls?: string[] };
    target.__runtimeWorkerUrls = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        target.__runtimeWorkerUrls!.push(String(url));
        super(url, options);
      }
    };
  });
  await openBook(page);
  await expect(page.locator('#root')).toHaveAttribute('data-runtime-ready-generation', '1');
  await expect(page.locator('[data-production-review]')).toHaveAttribute('data-launch-surface', 'static');
  expect(errors).toEqual([]);
  const workers = await page.evaluate(() => {
    const urls = (window as typeof window & { __runtimeWorkerUrls?: string[] }).__runtimeWorkerUrls ?? [];
    const engineUrl = new URL('/dist/web/pdfium-worker.js', location.origin).href;
    const engineCount = urls.filter(url => new URL(url, location.href).href === engineUrl).length;
    const encoderCount = urls.filter(url => {
      const parsed = new URL(url, location.href);
      return parsed.protocol === 'blob:' && parsed.origin === location.origin;
    }).length;
    return { engineCount, encoderCount, unexpectedUrls: urls.filter(url => {
      const parsed = new URL(url, location.href);
      return parsed.href !== engineUrl && !(parsed.protocol === 'blob:' && parsed.origin === location.origin);
    }) };
  });
  // The viewer requests one Blob encoder worker per PDFium engine.
  expect(workers.engineCount).toBeGreaterThanOrEqual(1);
  expect(workers.encoderCount).toBe(workers.engineCount);
  expect(workers.unexpectedUrls).toEqual([]);
});

test('keeps fit choices within their hover region and preserves deliberate keyboard access', async ({ page }) => {
  await openBook(page);
  await openZoom(page);
  const choices = page.getByRole('menu', { name: 'PDF fit modes', exact: true });
  const zoomIn = page.getByRole('menuitem', { name: 'Zoom in', exact: true });
  await fitButton(page).hover();
  await expect(choices).toBeVisible();
  const hoverBackground = await fitButton(page).evaluate((button) => {
    const color = document.createElement('span');
    color.style.color = getComputedStyle(button).getPropertyValue('--pk-hover');
    return color.style.color;
  });
  await expect(fitButton(page)).toHaveCSS('background-color', hoverBackground);
  expect(hoverBackground).not.toBe('rgba(0, 0, 0, 0)');
  await zoomIn.hover();
  await expect(choices).toBeHidden();
  await expect(fitButton(page)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  await fitButton(page).hover();
  await choices.hover();
  await expect(choices).toBeVisible();
  await expect(fitButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(fitButton(page)).toHaveCSS('background-color', hoverBackground);
  await zoomIn.hover();
  await expect(choices).toBeHidden();

  await fitButton(page).hover();
  await page.getByRole('menuitemradio', { name: 'Fit page', exact: true }).click();
  await expect(fitButton(page)).toHaveAttribute('data-fit-active', 'true');
  await expect(choices).toBeHidden();
  await zoomIn.hover();
  await expect(choices).toBeHidden();
  await expect(fitButton(page)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  await fitButton(page).focus();
  await fitButton(page).press('ArrowDown');
  const fitPage = page.getByRole('menuitemradio', { name: 'Fit page', exact: true });
  await expect(fitPage).toBeFocused();
  await expect(fitPage).toHaveCSS('outline-style', 'solid');
  await choices.hover();
  await zoomIn.hover();
  await expect(choices).toBeVisible();
  await expect(fitButton(page)).toHaveCSS('background-color', hoverBackground);
  await expect(fitPage).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(fitButton(page)).toHaveAttribute('data-fit-mode', 'width');
  await expect(choices).toBeHidden();
});

test('keeps a fit icon throughout fit mode changes', async ({ page }) => {
  await openBook(page);
  await openZoom(page);
  for (const mode of ['text', 'page', 'width']) {
    const displayedLoadingIcon = await fitButton(page).evaluate((button) => new Promise<boolean>((resolve) => {
      let loading = false;
      const inspect = (node: Node) => {
        if (node instanceof Element && (node.matches('.lucide-loader-circle') || node.querySelector('.lucide-loader-circle'))) loading = true;
      };
      const observer = new MutationObserver((records) => {
        inspect(button);
        for (const record of records) for (const node of record.addedNodes) inspect(node);
      });
      observer.observe(button, { childList: true, subtree: true });
      inspect(button);
      (button as HTMLButtonElement).click();
      const sample = () => {
        inspect(button);
        if (button.getAttribute('aria-busy') === 'true') requestAnimationFrame(sample);
        else requestAnimationFrame(() => {
          observer.disconnect();
          resolve(loading);
        });
      };
      requestAnimationFrame(sample);
    }));
    expect(displayedLoadingIcon).toBe(false);
    await expect(fitButton(page)).toHaveAttribute('data-fit-mode', mode);
    await expect(fitButton(page)).toHaveAttribute('aria-busy', 'false');
    await expect(fitButton(page).locator('svg')).toBeVisible();
  }
});

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
  await expect(fitButton(page)).toHaveAttribute('data-fit-mode', 'text');
  await expect(fitButton(page)).toHaveAttribute('data-fit-active', 'true');
  await expect(fitButton(page)).toHaveAttribute('aria-busy', 'false');
  await fitButton(page).click();
  await expect(fitButton(page)).toHaveAttribute('data-fit-mode', 'page');
});

for (const { mode, next, scan } of [
  { mode: 'page', next: 'width', scan: false },
  { mode: 'width', next: 'text', scan: false },
  { mode: 'text', next: 'page', scan: false },
  { mode: 'text', next: 'page', scan: true },
] as const) {
  test(`reapplies inactive ${mode} fitting before cycling${scan ? ' with text fallback' : ''}`, async ({ page }) => {
    await openBook(page, scan);
    await fit(page, mode);
    const currentScale = () => scale(page, 0, scan ? 612 : 600);
    const fittedScale = await currentScale();
    const zoom = page.getByRole('textbox', { name: /^Current zoom/u });
    await zoom.fill('150');
    await zoom.press('Enter');
    await expect.poll(currentScale).toBeCloseTo(1.5, 3);
    await openZoom(page);
    await expect(fitButton(page)).toHaveAttribute('data-fit-active', 'false');
    await expect(fitButton(page)).toHaveAccessibleName(`Fit mode: Custom zoom. Apply: Fit ${mode}`);
    await fitButton(page).click();
    await expect(fitButton(page)).toHaveAttribute('data-fit-mode', mode);
    await expect(fitButton(page)).toHaveAttribute('data-fit-active', 'true');
    await expect(fitButton(page)).toHaveAttribute('aria-busy', 'false');
    await expect.poll(currentScale).toBeCloseTo(fittedScale, 3);
    await expect(fitButton(page)).toHaveAccessibleName(
      `Fit mode: ${scan ? 'Fit width, no reliable text bounds' : `Fit ${mode}`}. Next: Fit ${next}`,
    );
    await fitButton(page).click();
    await expect(fitButton(page)).toHaveAttribute('data-fit-mode', next);
    await expect(fitButton(page)).toHaveAttribute('data-fit-active', 'true');
    await expect(fitButton(page)).toHaveAttribute('aria-busy', 'false');
  });
}

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

test('switches from text to whole-page fitting in a wide short viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/test/acceptance/review-harness/?fit-modes=book');
  await waitForStaticPdf(page);
  await fit(page, 'text');
  await fit(page, 'page');
  const bounds = await mainPage(page).boundingBox();
  const frame = await viewport(page).boundingBox();
  expect(bounds!.height).toBeLessThan(frame!.height);
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
  const openInMain = page.getByRole('menuitem', { name: 'Open in main document', exact: true });
  await expect(async () => {
    if (!await openInMain.isVisible()) {
      await link.focus();
      await link.press('Enter');
    }
    await expect(openInMain).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 5_000 });
  const destinationFrames = await openInMain
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
  await page.getByRole('group', { name: 'Workspace trays', exact: true }).getByRole('button', { name: 'Hide workspace', exact: true }).click();
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
  await page.getByRole('group', { name: 'Workspace trays', exact: true }).getByRole('button', { name: 'Hide workspace', exact: true }).click();
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

test('refits text to the reading area when the workspace opens during a resize fit', async ({ page }) => {
  await openBook(page);
  await fit(page, 'text');
  await goToPage(page, 2);
  await openZoom(page);
  await page.getByRole('button', { name: 'Show workspace', exact: true }).evaluate((button) => {
    const fitControl = document.querySelector('[data-review-zoom-action="fit-width"]')!;
    const zoom = document.querySelector<HTMLInputElement>('.review-chrome__zoom-input')!;
    const initialZoom = Number(zoom.value);
    // Open as soon as the resize changes the zoom, while the fit still owns
    // the operation and before it validates the new geometry on later frames.
    const observer = new MutationObserver(() => {
      if (fitControl.getAttribute('aria-busy') !== 'true' || Number(zoom.value) <= initialZoom) return;
      observer.disconnect();
      (button as HTMLButtonElement).click();
    });
    observer.observe(fitControl, { attributes: true });
    observer.observe(zoom, { attributeFilter: ['value'] });
  });
  await page.setViewportSize({ width: 1400, height: 1100 });
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-tools-workspace-open', 'true');
  const readingWidth = await page.locator('.review-document').evaluate((element) => element.getBoundingClientRect().width);
  // Fit text leaves 36px on either side and 24px for the tray inset and fade.
  await expect.poll(() => scale(page, 1)).toBeCloseTo((readingWidth - 96) / 300, 2);
  await openZoom(page);
  await expect(fitButton(page)).toHaveAttribute('aria-busy', 'false');
  await expect(fitButton(page)).toHaveAttribute('data-fit-active', 'true');
});

for (const scrollbarWidth of [null, 15]) {
  test(`balances text margins within the clear reading area with the workspace hidden and open with ${scrollbarWidth === null ? 'native' : `${scrollbarWidth}px`} scrollbars`, async ({ page, browserName }) => {
    test.skip(scrollbarWidth !== null && browserName !== 'chromium',
      'Only Chromium reserves native scrollbar space for explicit scrollbar pseudo-element sizes.');
    await openBook(page);
    if (scrollbarWidth !== null) {
      await page.addStyleTag({ content: `
        .review-document .pdf-workspace__viewport::-webkit-scrollbar { width: ${scrollbarWidth}px; height: ${scrollbarWidth}px; }
        .review-document .pdf-workspace__viewport::-webkit-scrollbar-thumb { background: #888; }
      ` });
      await expect.poll(() => viewport(page).evaluate((element) =>
        (element as HTMLElement).offsetWidth - element.clientWidth)).toBe(scrollbarWidth);
    }
    await expect.poll(() => viewport(page).evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.paddingLeft, style.paddingRight];
    })).toEqual(['10px', '10px']);
    const frame = page.locator('.review-overlay-frame');
    await expect(frame.locator('.review-overlay-frame__right-backing')).toHaveCSS('display', 'none');
    await expect(frame.locator('.review-overlay-frame__right-fade')).toHaveCSS('display', 'none');
    await fit(page, 'text');
    const expectBalancedMargins = async (index = 0) => {
      await expect.poll(async () => {
        const { clearRight } = await page.locator('[data-review-stage]').evaluate(reviewEdgeGeometry);
        return mainPage(page, index).evaluate((element, { pageIndex, clearRight }) => {
          const bounds = element.getBoundingClientRect();
          const zoom = bounds.width / 600;
          const textLeft = bounds.left + (pageIndex % 2 === 0 ? 90 : 210) * zoom;
          const textRight = textLeft + 300 * zoom;
          const viewport = element.closest('.review-document')!.getBoundingClientRect();
          // Native horizontal scrolling quantizes to whole CSS pixels; WebKit
          // truncates fractional offsets. Compare centers, since a margin
          // difference doubles that subpixel positioning error.
          return Math.abs((textLeft + textRight) / 2 - (viewport.left + clearRight) / 2);
        }, { pageIndex: index, clearRight });
      }).toBeLessThan(1);
    };
    await expectBalancedMargins();
    await viewport(page).evaluate((element) => {
      const next = element.querySelector('[data-page-index="1"]')!.getBoundingClientRect();
      element.scrollTop += next.top - element.getBoundingClientRect().top;
    });
    await expectBalancedMargins(1);
    await goToPage(page, 1);
    await expectBalancedMargins();
    await goToPage(page, 2);
    await expectBalancedMargins(1);
    await page.setViewportSize({ width: 1400, height: 1100 });
    await expectBalancedMargins(1);
    // A centered frame can paint before the resize fit has finished owning
    // its geometry. Do not overlap the next disclosure with that operation.
    await openZoom(page);
    await expect(fitButton(page)).toHaveAttribute('aria-busy', 'false');
    await expect(fitButton(page)).toHaveAttribute('data-fit-active', 'true');
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 1090);
    await page.getByRole('button', { name: 'Show workspace', exact: true }).click();
    await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-tools-workspace-open', 'true');
    await expectBalancedMargins(1);
    await page.getByRole('group', { name: 'Workspace trays', exact: true }).getByRole('button', { name: 'Hide workspace', exact: true }).click();
    await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-tools-workspace-open', 'false');
    await expectBalancedMargins(1);
  });
}
