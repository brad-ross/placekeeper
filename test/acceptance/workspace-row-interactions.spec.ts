import { expect, test, type Locator, type Page } from '@playwright/test';

const rowPaint = (row: Locator) => row.evaluate((element) => {
  const style = getComputedStyle(element);
  return { background: style.backgroundColor, shadow: style.boxShadow, outline: style.outlineWidth };
});

async function leaveRow(page: Page) {
  await page.mouse.move(0, 0);
  await page.locator('.review-chrome__page-input').focus();
}

for (const scrollbarWidth of [8, 17]) {
  test(`workspace right inset includes its ${scrollbarWidth}px scrollbar`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Custom classic scrollbar sizes are a Chromium geometry fixture.');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/test/acceptance/review-harness/index.html?visual=tray&search=canonical');
    await page.addStyleTag({ content: `
      #workspace-panel-annotations, #workspace-panel-outline, .pdf-search__results {
        max-height: 150px; overflow-y: scroll; scrollbar-gutter: stable; scrollbar-width: auto; scrollbar-color: auto;
      }
      #workspace-panel-annotations::-webkit-scrollbar,
      #workspace-panel-outline::-webkit-scrollbar,
      .pdf-search__results::-webkit-scrollbar { width: ${scrollbarWidth}px; }
    ` });
    for (const mode of ['Outline', 'Annotations', 'Search']) {
      await page.getByRole('tab', { name: mode, exact: true }).click();
      if (mode === 'Search') await page.getByRole('searchbox').fill('signal');
      const row = page.locator(mode === 'Outline' ? '.outline-navigator__row:visible'
        : mode === 'Search' ? '[data-search-result]:visible' : 'li[data-annotation-origin]:visible').first();
      await expect(row).toBeVisible();
      const scroller = page.locator(mode === 'Search' ? '.pdf-search__results'
        : `#workspace-panel-${mode.toLowerCase()}`);
      await expect.poll(() => scroller.evaluate((element) => (element as HTMLElement).offsetWidth - element.clientWidth)).toBe(scrollbarWidth);
      await expect.poll(async () => {
        const scrollBounds = (await scroller.boundingBox())!;
        const rowBounds = (await row.boundingBox())!;
        return Math.round(scrollBounds.x + scrollBounds.width - rowBounds.x - rowBounds.width);
      }).toBe(Math.max(12, scrollbarWidth));
    }
  });
}

for (const width of [1280, 620, 390]) {
  test(`workspace row intent and page/action endcaps match the outline at ${width}px`, async ({ page, browserName }) => {
    page.on('pageerror', (error) => { throw error; });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/test/acceptance/review-harness/index.html?visual=outline');
    const openOutlineWorkspace = page.getByRole('button', { name: 'Show workspace', exact: true });
    if (await openOutlineWorkspace.isVisible()) await openOutlineWorkspace.click();
    await page.getByRole('tab', { name: 'Outline', exact: true }).click();
    const collapse = page.locator('[data-outline-expansion-toggle]:visible');
    await page.mouse.move(0, 0);
    await page.locator('.review-chrome__page-input').focus();
    await expect(collapse).toHaveCSS('opacity', '0');
    await page.locator('.review-workspace__header:visible').first().hover();
    await expect(collapse).toHaveCSS('opacity', '1');
    await page.mouse.move(0, 0);
    await page.keyboard.press('Tab');
    await collapse.focus();
    await expect(collapse).toHaveCSS('opacity', '1');

    const outline = page.locator('.outline-navigator__row:visible:not([data-current="true"]):has(.row-action-group)').first();
    await outline.hover();
    const outlineHover = await rowPaint(outline);
    expect(outlineHover.background).toBe('rgb(231, 231, 231)');
    await expect(outline.locator('.outline-navigator__page')).toHaveCSS('opacity', '0');
    await expect(outline.locator('.row-action-group__direct')).toHaveCSS('opacity', '1');
    await outline.locator('.outline-navigator__destination').click();
    const pointerFocusesOutline = await outline.locator('.outline-navigator__destination')
      .evaluate((element) => element === document.activeElement);

    await page.goto('/test/acceptance/review-harness/index.html?visual=tray&search=canonical');
    const openTrayWorkspace = page.getByRole('button', { name: 'Show workspace', exact: true });
    if (await openTrayWorkspace.isVisible()) await openTrayWorkspace.click();
    await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
    for (const annotation of await page.locator('li[data-annotation-origin]').all()) {
      const heading = (await annotation.locator('.annotation-item__title-row').boundingBox())!;
      const number = (await annotation.locator('.annotation-item__page').boundingBox())!;
      expect(Math.abs(number.x + number.width - heading.x - heading.width)).toBeLessThan(1);
    }

    for (const kind of ['Annotations', 'Search']) {
      await page.getByRole('tab', { name: kind, exact: true }).click();
      if (kind === 'Search') await page.getByRole('searchbox').fill('signal');
      const row = kind === 'Search'
        ? page.locator('[data-search-result]').first()
        : page.locator('[data-review-item="owned-replace"]');
      await row.hover();
      const cardBounds = (await row.locator('.annotation-item__content').boundingBox())!;
      const lastActionBounds = (await row.locator('.row-action-group__direct > :last-child').boundingBox())!;
      expect(Math.abs((lastActionBounds.y - cardBounds.y)
        - (cardBounds.x + cardBounds.width - lastActionBounds.x - lastActionBounds.width))).toBeLessThan(1);
      const navigation = row.locator('.annotation-item__navigation');
      const actions = row.locator('.row-action-group__direct');
      const number = row.locator('.annotation-item__page, .pdf-search__result-page');
      await leaveRow(page);
      await expect(actions).toHaveCSS('display', 'flex');
      await expect(row.locator('.row-action-group__secondary')).toBeHidden();
      await expect(actions).toHaveCSS('opacity', '0');
      await expect(number).toHaveCSS('opacity', '1');
      const body = row.locator('.annotation-item__body-row, .pdf-search__excerpt');
      const before = await body.boundingBox();
      await row.hover();
      expect(await rowPaint(row)).toEqual(outlineHover);
      await expect(actions).toHaveCSS('opacity', '1');
      await expect(number).toHaveCSS('opacity', '0');
      expect(await body.boundingBox()).toEqual(before);
      const numberBox = (await number.boundingBox())!;
      const actionBox = (await actions.boundingBox())!;
      expect(Math.abs(numberBox.x + numberBox.width - actionBox.x - actionBox.width)).toBeLessThan(1);
      const previousSelection = await row.getAttribute('data-active');
      await actions.locator('.copy-link-control__trigger').click();
      await expect(row).toHaveAttribute('data-active', previousSelection!);
      await navigation.click();
      await expect(row).toHaveAttribute('data-active', 'true');
      await page.mouse.move(0, 0);
      expect(await navigation.evaluate((element) => element === document.activeElement)).toBe(pointerFocusesOutline);
      await expect(actions).toHaveCSS('opacity', pointerFocusesOutline ? '1' : '0');
      await expect(number).toHaveCSS('opacity', pointerFocusesOutline ? '0' : '1');
      await expect(row).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      await leaveRow(page);
      await expect(actions).toHaveCSS('opacity', '0');
      await expect(number).toHaveCSS('opacity', '1');
      await row.hover();
      await expect(row).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      await navigation.focus();
      await page.mouse.move(0, 0);
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
      await expect(actions.locator('button').first()).toBeFocused();
      await expect(actions).toHaveCSS('opacity', '1');
      await expect(number).toHaveCSS('opacity', '0');
      await expect(actions.locator('button').first()).toHaveCSS('outline-color', 'rgb(73, 103, 137)');
      await leaveRow(page);
    }
  });
}

test('touch rows expose actions in the page slot while read-only rows retain page numbers', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto('/test/acceptance/review-harness/index.html?visual=tray&search=canonical');
    const open = page.getByRole('button', { name: 'Show workspace', exact: true });
    if (await open.isVisible()) await open.click();
    await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
    const owned = page.locator('[data-review-item="owned-highlight"]');
    await expect(owned.locator('.annotation-item__page')).toHaveCSS('opacity', '0');
    await expect(owned.locator('.row-action-group__direct')).toHaveCSS('opacity', '1');
    for (const button of await owned.locator('.row-action-group__direct button').all()) {
      await expect(button).toHaveCSS('height', '44px');
    }
    const source = page.locator('[data-existing-annotation="source-highlight-short"]');
    await source.locator('.annotation-item__navigation').click();
    await expect(source).toHaveAttribute('data-active', 'true');
    await expect(source.locator('.annotation-item__page')).toHaveCSS('opacity', '1');
    await expect(source.locator('.row-action-group')).toHaveCount(0);
    await expect(source).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await page.getByRole('tab', { name: 'Search', exact: true }).click();
    await page.getByRole('searchbox').fill('signal');
    const result = page.locator('[data-search-result]').first();
    await expect(result.locator('.pdf-search__result-page')).toHaveCSS('opacity', '0');
    await expect(result.locator('.row-action-group__direct')).toHaveCSS('opacity', '1');
  } finally {
    await context.close();
  }
});

for (const width of [1280, 620]) {
  test(`returning from a long annotation releases pointer hover and preserves keyboard return at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/test/acceptance/review-harness/index.html?visual=tray');
    const open = page.getByRole('button', { name: 'Show workspace', exact: true });
    if (await open.isVisible()) await open.click();
    await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
    const row = page.locator('[data-review-item="owned-highlight"]');
    const more = row.locator('[data-read-full-annotation="true"]');
    await more.click();
    await page.locator('[data-full-annotation-action="back"]').click();
    await expect(page.locator('#workspace-panel-annotations')).toBeFocused();
    await page.mouse.move(0, 0);
    await expect(row.locator('.row-action-group__direct')).toHaveCSS('opacity', '0');
    await expect(row.locator('.annotation-item__page')).toHaveCSS('opacity', '1');
    await row.hover();
    await expect(row.locator('.row-action-group__direct')).toHaveCSS('opacity', '1');
    await expect(row.locator('.annotation-item__page')).toHaveCSS('opacity', '0');
    await page.mouse.move(0, 0);
    await expect(row.locator('.row-action-group__direct')).toHaveCSS('opacity', '0');
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-full-annotation-action="back"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(more).toBeFocused();
  });
}

test('collapsed narrow workspace matches the bottom References rail backing and fade', async ({ page }) => {
  const appearance = () => page.locator('[data-review-stage]').evaluate((stage) => {
    const rail = stage.querySelector<HTMLElement>('[data-workspace-edge-rail="bottom"]')!;
    const backing = stage.querySelector<HTMLElement>('.review-overlay-frame__bottom-backing')!;
    const fade = stage.querySelector<HTMLElement>('.review-overlay-frame__bottom-fade')!;
    const stageBox = stage.getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    const backingStyle = getComputedStyle(backing);
    const fadeStyle = getComputedStyle(fade);
    return {
      left: railBox.left - stageBox.left,
      bottom: stageBox.bottom - railBox.bottom,
      width: railBox.width,
      height: railBox.height,
      backingDisplay: backingStyle.display,
      backingColor: backingStyle.backgroundColor,
      backingHeight: backing.getBoundingClientRect().height,
      fadeDisplay: fadeStyle.display,
      fadeBackground: fadeStyle.backgroundImage,
      fadeHeight: fade.getBoundingClientRect().height,
    };
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/test/acceptance/review-harness/index.html?visual=reference-layout');
  await expect(page.getByRole('button', { name: 'Show References', exact: true })).toBeVisible();
  const reference = await appearance();
  expect(reference.backingDisplay).toBe('block');
  expect(reference.fadeDisplay).toBe('block');
  expect(reference.fadeBackground).toContain('linear-gradient');
  for (const width of [760, 620, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/test/acceptance/review-harness/index.html?visual=reading');
    const close = page.getByRole('button', { name: 'Hide workspace', exact: true });
    if (await close.isVisible()) await close.click();
    const open = page.getByRole('button', { name: 'Show workspace', exact: true });
    await expect(open).toHaveAttribute('data-workspace-edge-rail', 'bottom');
    await expect.poll(appearance).toEqual(reference);
    await open.click();
    await page.getByRole('button', { name: 'Hide workspace', exact: true }).click();
    await expect.poll(appearance).toEqual(reference);
  }
});

test('bottom resize handle sits inside the tray and follows its upper corners', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/test/acceptance/review-harness/index.html?visual=reference-layout');
  await page.getByRole('button', { name: 'Show References', exact: true }).click();
  const handle = page.locator('[data-reference-resize-handle="bottom"]');
  const tray = page.locator('.review-workspace[data-workspace-presentation="bottom"]');
  await expect(handle).toBeVisible();
  await expect.poll(async () => Math.abs((await handle.boundingBox())!.y - (await tray.boundingBox())!.y)).toBeLessThan(0.5);
  const trayBox = (await tray.boundingBox())!;
  const handleBox = (await handle.boundingBox())!;
  expect(handleBox.y).toBeCloseTo(trayBox.y, 0);
  expect(handleBox.x).toBeCloseTo(trayBox.x, 0);
  expect(handleBox.width).toBeCloseTo(trayBox.width, 0);
  await handle.hover();
  const paint = await handle.evaluate((element) => {
    const line = getComputedStyle(element, '::after');
    return { radius: line.borderTopLeftRadius, top: line.top, border: line.borderTopWidth, opacity: line.opacity };
  });
  expect(paint).toMatchObject({ radius: '16px', top: '0px', border: '0px' });
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 5);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y - 45, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await tray.boundingBox())!.height).toBeGreaterThan(trayBox.height + 30);
});

test('vertical reference tabs fill their rail and horizontal tabs fit their titles', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/test/acceptance/review-harness/index.html?visual=reference-layout');
  await page.getByRole('button', { name: 'Show References', exact: true }).click();
  const tab = page.locator('.reference-tab-segment:visible').first();
  await expect(tab).toBeVisible();
  const title = tab.locator('.reference-tab-segment__selector span').first();
  const verticalTabs = page.locator('.reference-tabs[data-reference-tabs-orientation="vertical"]:visible');
  await expect(verticalTabs).toBeVisible();
  await title.evaluate((element) => { element.textContent = 'A long reference title that should reach the maximum tab width'; });
  expect((await tab.boundingBox())!.width).toBeCloseTo((await verticalTabs.boundingBox())!.width, 0);
  await title.evaluate((element) => { element.textContent = 'Note'; });
  expect((await tab.boundingBox())!.width).toBeCloseTo((await verticalTabs.boundingBox())!.width, 0);
  const dockRight = page.getByRole('button', { name: 'Move References to right', exact: true });
  await dockRight.focus();
  await dockRight.press('Enter');
  const horizontalTabs = page.locator('.reference-tabs[data-reference-tabs-orientation="horizontal"]:visible');
  await expect(horizontalTabs).toBeVisible();
  await title.evaluate((element) => { element.textContent = 'A long reference title that should reach the maximum tab width'; });
  const longWidth = (await tab.boundingBox())!.width;
  await title.evaluate((element) => { element.textContent = 'Note'; });
  expect((await tab.boundingBox())!.width).toBeLessThan(longWidth);
  expect((await tab.boundingBox())!.width).toBeGreaterThanOrEqual(112);
  const handle = page.locator('[data-reference-resize-handle="right"]');
  const tray = page.locator('.review-workspace[data-workspace-presentation="right"]');
  await expect(handle).toBeVisible();
  await expect.poll(async () => Math.abs((await handle.boundingBox())!.x - (await tray.boundingBox())!.x)).toBeLessThan(.5);
  const shape = await handle.evaluate((element) => {
    const style = getComputedStyle(element, '::after');
    return { radius: style.borderTopLeftRadius, gradient: style.backgroundImage, overflow: getComputedStyle(element).overflow };
  });
  expect(shape.radius).toBe('16px');
  expect(shape.gradient).toContain('to right');
  expect(shape.overflow).toBe('hidden');
});

test('horizontal reference tabs in a bottom workspace fit short titles', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 900 });
  await page.goto('/test/acceptance/review-harness/index.html?visual=reference-layout');
  await page.getByRole('button', { name: 'Show workspace', exact: true }).click();
  await page.getByRole('tab', { name: 'References', exact: true }).click();
  const tabs = page.locator('.reference-tabs[data-reference-tabs-orientation="horizontal"]:visible');
  await expect(tabs).toBeVisible();
  const tab = tabs.locator('.reference-tab-segment').first();
  const title = tab.locator('.reference-tab-segment__selector span').first();
  await title.evaluate((element) => { element.textContent = 'A long reference title that should reach the maximum tab width'; });
  const longWidth = (await tab.boundingBox())!.width;
  await title.evaluate((element) => { element.textContent = 'Note'; });
  expect((await tab.boundingBox())!.width).toBeLessThan(longWidth);
  expect((await tab.boundingBox())!.width).toBeGreaterThanOrEqual(112);
});
