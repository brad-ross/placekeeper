import { expect, test, type Browser, type Frame, type Locator, type Page } from '@playwright/test';

// Compare with the rendered approved artifact, including its final overrides.
// Text lengths and PDF page geometry deliberately remain fixture-dependent.
const typography = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color'];
const icon = ['width', 'height', 'strokeWidth', 'color'];
const surface = ['padding', 'borderTopWidth', 'borderRadius', 'backgroundColor', 'boxShadow'];
const control = [...typography, ...surface, 'minHeight', 'gap'];
async function canonical(browser: Browser, baseURL: string | undefined, scene: string) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1050 } });
  await page.goto(`${baseURL}/docs/plans/assets/neutral-soft-design/index.html`);
  const frame = page.frames().find((frame) => frame.url() === 'about:srcdoc')!;
  // Follow-up row refinements landed after the original approved scene.
  await frame.addStyleTag({ content: `
    #pk-canonical .pk-row { padding: 8px 8px 8px 12px !important; }
    #pk-canonical .pk-row.pk-current { box-shadow: 0 2px 7px rgb(0 0 0 / 2.4%) !important; }
    #pk-canonical .pk-ref-title { min-height: 32px !important; padding: 7px 8px !important; }
  ` });
  await frame.locator('#pk-review-scene').selectOption({ label: scene });
  await page.mouse.move(0, 0);
  return { page, frame };
}
async function product(page: Page, scene: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/test/acceptance/review-harness/index.html?visual=${scene}`);
  await expect(page.locator('[data-review-chrome]').first()).toBeVisible();
  await page.mouse.move(0, 0);
}
function visible(root: Page | Frame, selector: string) { return root.locator(selector).filter({ visible: true }).first(); }
async function styles(locator: Locator, properties: readonly string[]) {
  return locator.evaluate((element, names) => {
    const computed = getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, computed[name as keyof CSSStyleDeclaration]]));
  }, properties);
}
async function match(actual: Locator, approved: Locator, properties: readonly string[]) {
  await expect(actual).toBeVisible();
  await expect(approved).toBeVisible();
  await expect.poll(() => styles(actual, properties)).toEqual(await styles(approved, properties));
}

test('toolbar controls match canonical rest, hover, keyboard, and open-menu states', async ({ page, browser, baseURL }) => {
  const mock = await canonical(browser, baseURL, 'Reading');
  try {
    await product(page, 'reading');
    const copy = visible(page, '.review-chrome__link button');
    const copyMock = mock.frame.locator('.pk-toolbar [data-action="copy"]');
    await match(copy, copyMock, [...control, 'width', 'height']);
    await match(copy.locator('svg'), copyMock.locator('svg'), icon);
    await copy.hover(); await copyMock.hover();
    await match(copy, copyMock, control);
    for (const [owner, button] of [[page, copy], [mock.page, copyMock]] as const) {
      await button.focus(); await owner.keyboard.press('Tab'); await owner.keyboard.press('Shift+Tab');
      await owner.mouse.move(0, 0);
    }
    await match(copy, copyMock, [...control, 'outlineWidth', 'outlineColor', 'outlineOffset']);
    const zoom = visible(page, '.review-chrome__zoom-disclosure');
    const zoomMock = mock.frame.locator('.pk-zoom-trigger');
    await zoom.click(); await zoomMock.click();
    await zoom.focus(); await zoomMock.focus();
    await page.mouse.move(0, 0); await mock.page.mouse.move(0, 0);
    await expect(zoom).toBeFocused();
    await match(zoom, zoomMock, [...control, 'width', 'height']);
    await match(zoom.locator('svg'), zoomMock.locator('svg'), icon);
    await match(visible(page, '.top-bar-menu__surface'), mock.frame.locator('.pk-zoom-popover'), surface);
    // Finish the pointer-hover comparison before checking keyboard navigation.
    // Hover menus close when the pointer leaves, independently of focus.
    await zoom.press('Escape');
    await zoom.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Fit width' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Zoom out' })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(zoom).toBeFocused();
    await expect(page.getByRole('menu', { name: 'PDF zoom' })).toHaveCount(0);
    await zoom.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Fit width' })).toBeFocused();
    await page.keyboard.press('Escape');
    await zoom.click(); await zoom.click();
    await expect(page.getByRole('menu', { name: 'PDF zoom' })).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(page.getByRole('menu', { name: 'PDF zoom' })).toHaveCount(0);
    await zoom.click(); await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'PDF zoom' })).toHaveCount(0);
  } finally { await mock.page.close(); }
});

test('save setup and save-failure surfaces match the approved scenes', async ({ page, browser, baseURL }) => {
  const mock = await canonical(browser, baseURL, 'Save setup');
  try {
    await product(page, 'save-destination');
    await match(page.locator('.save-destination-dialog'), mock.frame.locator('.pk-dialog'), ['borderTopWidth', 'borderRadius', 'backgroundColor', 'boxShadow', 'width']);
    const choice = page.locator('.save-destination-choice').first();
    const mockChoice = mock.frame.locator('.pk-choice').first();
    await match(choice, mockChoice, [...surface, 'gap', 'margin']);
    await choice.hover(); await mockChoice.hover(); await match(choice, mockChoice, surface);
    const input = page.getByRole('textbox', { name: 'Copy name', exact: true });
    const mockInput = mock.frame.locator('.pk-field-label input');
    await match(input, mockInput, [...surface, ...typography]);
    await input.hover(); await mockInput.hover(); await match(input, mockInput, surface);
    await input.focus(); await mockInput.focus();
    await match(input, mockInput, ['outlineStyle', 'boxShadow']);
    await mock.frame.locator('#pk-review-scene').selectOption({ label: 'Save failure' });
    await product(page, 'save-failure');
    // Follow-up: preserve the new palette and type in an upper-left floating toast.
    await match(page.locator('.review-save-notice'), mock.frame.locator('.pk-notice'), ['padding', 'borderTopWidth', 'backgroundColor', ...typography]);
    expect(await styles(page.locator('.review-save-notice'), ['borderRadius', 'borderBottomWidth']))
      .toEqual({ borderRadius: '10px', borderBottomWidth: '0px' });
    await match(page.getByRole('button', { name: 'Retry', exact: true }), mock.frame.locator('[data-action="retry"]'), control);
    await page.getByRole('button', { name: 'Save a copy…', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('save-failure-with-save-options.png') });
  } finally { await mock.page.close(); }
});

test('passage editor and offscreen return use canonical geometry and typography', async ({ page, browser, baseURL }) => {
  const mock = await canonical(browser, baseURL, 'Passage editor');
  try {
    await product(page, 'reading&composer=replacement');
    await match(page.locator('.comment-composer'), mock.frame.locator('.pk-editor'), [...surface, 'width']);
    await match(page.locator('.comment-composer__input'), mock.frame.locator('.pk-editor textarea'), [...surface, ...typography, 'minHeight', 'maxHeight']);
    await expect(page.locator('.comment-composer__input')).toHaveAttribute('placeholder', 'Add a comment…');
    await match(page.locator('.comment-composer__header h2 svg'), mock.frame.locator('.pk-editor-kind svg'), icon);
    await match(page.locator('.comment-composer__actions'), mock.frame.locator('.pk-editor .pk-actions'), ['gap']);
    const inputBox = (await page.locator('.comment-composer__input').boundingBox())!;
    const actionBox = (await page.locator('.comment-composer__actions button').last().boundingBox())!;
    expect(actionBox.y - inputBox.y - inputBox.height).toBeCloseTo(12, 1);
    await match(page.locator('.comment-composer__actions button').last(), mock.frame.locator('.pk-editor [data-action="apply"]'), control);
    await expect(page.locator('.comment-composer__anchor')).toHaveCount(0);
    const canonicalIconReturn = mock.frame.locator('.pk-editor-head [data-action="anchor"]');
    const canonicalIconReturnStyles = await styles(
      canonicalIconReturn,
      ['width', 'height', 'padding', 'borderRadius', 'color'],
    );
    const canonicalIconStyles = await styles(canonicalIconReturn.locator('svg'), icon);
    await mock.frame.locator('#pk-review-scene').selectOption({ label: 'Editor offscreen' });
    await product(page, 'reading&composer=replacement&return=outside');
    await match(page.locator('.comment-composer'), mock.frame.locator('.pk-editor'), surface);
    const returnToPassage = page.getByRole('button', { name: 'Back to passage', exact: true });
    await expect(returnToPassage).toBeVisible();
    await expect(returnToPassage.locator('span')).toHaveCount(0);
    expect(await styles(
      returnToPassage,
      ['width', 'height', 'padding', 'borderRadius', 'color'],
    )).toEqual(canonicalIconReturnStyles);
    expect(await styles(returnToPassage.locator('svg'), icon)).toEqual(canonicalIconStyles);
    await product(page, 'contextual');
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    await expect(page.locator('.comment-composer')).toBeVisible();
    await expect.poll(async () => {
      const bounds = await page.locator('.comment-composer').boundingBox();
      return bounds !== null && bounds.x >= 12 && bounds.x + bounds.width <= 378;
    }).toBe(true);
    await page.screenshot({ path: test.info().outputPath('narrow-passage-editor.png') });
  } finally { await mock.page.close(); }
});

test('annotation rows and full reader retain canonical surface and text hierarchy', async ({ page, browser, baseURL }) => {
  const mock = await canonical(browser, baseURL, 'Annotations');
  try {
    await product(page, 'tray');
    const row = page.locator('[data-review-item="owned-highlight"]');
    const mockRow = mock.frame.locator('.pk-row.pk-current');
    await match(row.locator('.annotation-item__content'), mockRow, ['padding', 'borderRadius']);
    await match(row.locator('.annotation-item__title-row'), mockRow.locator('.pk-row-head'), ['gap', 'minHeight', 'marginBottom']);
    await match(row.locator('.annotation-item__page'), mockRow.locator('.pk-page-label'), typography);
    const more = row.getByRole('button', { name: /Read full Highlight/ });
    await expect(more).toBeVisible();
    await more.click();
    await mock.frame.locator('#pk-review-scene').selectOption({ label: 'Full annotation' });
    const reader = page.locator('.full-annotation-reader');
    await match(reader, mock.frame.locator('.pk-full-reader'), typography);
    await match(reader.locator('.full-annotation-reader__metadata-bar'), mock.frame.locator('.pk-reader-head'), ['gap', 'paddingBottom', 'borderBottomWidth']);
    await match(reader.locator('.full-annotation-reader__metadata'), mock.frame.locator('.pk-reader-meta'), typography);
    await match(reader.locator('.full-annotation-reader__back'), mock.frame.locator('[data-action="reader-back"]'), ['padding', 'width', 'height', 'borderRadius', 'color']);
    await match(reader.locator('.full-annotation-reader__back svg'), mock.frame.locator('[data-action="reader-back"] svg'), icon);
    await match(reader.locator('.full-annotation-reader__body p').first(), mock.frame.locator('.pk-reader-body p').first(), typography);
    await page.screenshot({ path: test.info().outputPath('full-annotation-reader.png') });
  } finally { await mock.page.close(); }
});

test('selection and page-action palettes use canonical controls', async ({ page, browser, baseURL }) => {
  const mock = await canonical(browser, baseURL, 'Text selection');
  try {
    await product(page, 'contextual');
    await match(visible(page, '.review-context-palette'), mock.frame.locator('.pk-palette'), [...surface, 'gap']);
    await match(page.getByRole('button', { name: 'Highlight', exact: true }), mock.frame.locator('[data-action="highlight"]'), control);
    await match(page.getByRole('button', { name: 'Highlight', exact: true }).locator('svg'), mock.frame.locator('[data-action="highlight"] svg'), icon);
    await product(page, 'page-note');
    await match(visible(page, '.review-page-menu'), mock.frame.locator('.pk-palette'), [...surface, 'gap']);
  } finally { await mock.page.close(); }
});

test('Outline and Search share the approved tray and field treatment', async ({ page, browser, baseURL }) => {
  const mock = await canonical(browser, baseURL, 'Outline');
  try {
    await product(page, 'outline&search=canonical');
    await page.getByRole('tab', { name: 'Outline', exact: true }).click();
    await match(visible(page, '.review-tools-workspace'), mock.frame.locator('.pk-aside'), ['backgroundColor', 'borderRadius', 'borderTopWidth']);
    const target = visible(page, '.outline-navigator__destination:not(:disabled)');
    await match(target, mock.frame.locator('.pk-outline').first(), ['padding', ...typography]);
    await match(page.locator('.outline-navigator__disclosure').first(), mock.frame.locator('.pk-outline-disclosure').first(), ['width', 'height', 'padding', 'color']);
    await match(page.locator('.outline-navigator__disclosure svg').first(), mock.frame.locator('.pk-outline-disclosure svg').first(), icon);
    await mock.frame.locator('#pk-review-scene').selectOption({ label: 'Search' });
    await page.getByRole('tab', { name: 'Search', exact: true }).click();
    await match(visible(page, '.pdf-search__query'), mock.frame.locator('.pk-searchbox'), ['height', 'borderTopWidth', 'borderRadius', 'backgroundColor', 'boxShadow', 'gap']);
    await match(page.getByRole('searchbox', { name: 'Search this PDF' }), mock.frame.locator('.pk-searchbox input'), [...typography, 'backgroundColor', 'outlineStyle', 'padding']);
    await page.getByRole('searchbox', { name: 'Search this PDF' }).fill('signal');
    await mock.frame.locator('.pk-searchbox input').fill('signal');
    await match(page.getByRole('button', { name: 'Clear search', exact: true }), mock.frame.locator('[data-action="clear-search"]'), ['width', 'height', 'padding', 'color', 'borderRadius']);
    await match(page.locator('.pdf-search__summary'), mock.frame.locator('.pk-count'), [...typography, 'padding']);
    const result = page.locator('li[data-search-result]').first();
    await result.locator('.pdf-search__result').click();
    await page.getByRole('searchbox', { name: 'Search this PDF' }).focus();
    await page.mouse.move(0, 0);
    // The follow-up design makes search results use the annotation row treatment.
    await mock.frame.locator('#pk-review-scene').selectOption({ label: 'Annotations' });
    await match(result, mock.frame.locator('.pk-row.pk-current'), ['backgroundColor', 'borderRadius', 'boxShadow']);
    await match(result.locator('.pdf-search__result'), mock.frame.locator('.pk-row.pk-current'), ['padding']);
    await match(result.locator('.pdf-search__excerpt'), mock.frame.locator('.pk-row.pk-current p'), typography);
    await page.screenshot({ path: test.info().outputPath('search-workspace.png') });
  } finally { await mock.page.close(); }
});

test('split References uses the canonical tab surfaces and controls', async ({ page, browser, baseURL }) => {
  const mock = await canonical(browser, baseURL, 'Split references');
  try {
    await product(page, 'reference-layout');
    await page.getByRole('button', { name: 'Show References', exact: true }).click();
    const tabs = visible(page, '.reference-tabs');
    await expect(tabs).toHaveAttribute('data-reference-tabs-orientation', 'vertical');
    const current = tabs.locator('.reference-tab-segment').filter({ has: page.locator('[aria-selected="true"]') });
    await expect(current.locator('.reference-tab-segment__selector')).toBeFocused();
    await visible(page, '.review-chrome__page-input').focus();
    await page.mouse.move(0, 0);
    await match(current, mock.frame.locator('.pk-ref-tab.pk-current'), ['borderRadius', 'backgroundColor', 'boxShadow']);
    await match(current.locator('.reference-tab-segment__selector'), mock.frame.locator('.pk-ref-title[aria-selected="true"]'), control);
    await match(current.locator('.reference-tab-segment__page'), mock.frame.locator('.pk-ref-tab.pk-current .pk-ref-page'), typography);
    await match(current.locator('.reference-tab-segment__action').first(), visible(mock.frame, '.pk-ref-tab.pk-current .pk-ref-tab-actions button'), ['padding', 'width', 'height', 'borderRadius', 'color']);
    const panel = visible(page, '.reference-panel__viewport');
    await match(panel, mock.frame.locator('.pk-ref-body'), ['backgroundColor', 'borderRadius', 'borderTopWidth']);
    await page.screenshot({ path: test.info().outputPath('split-references.png') });
  } finally { await mock.page.close(); }
});


test('annotation peek uses the canonical container, row, and actions', async ({ page, browser, baseURL }) => {
  const mock = await canonical(browser, baseURL, 'Annotation peek');
  try {
    await product(page, 'peek');
    await page.locator('[data-owned-focus-id="owned-highlight"]').focus();
    const peek = page.locator('[data-annotation-peek]');
    await peek.locator('.annotation-item__content > button').click();
    await expect(peek).toHaveAttribute('data-peek-selected', 'true');
    const approved = mock.frame.locator('.pk-peek');
    await match(peek, approved, [...surface, 'width']);
    await match(peek.locator('.annotation-item__content'), approved.locator('.pk-row'), ['borderRadius']);
    await expect(peek.locator('.annotation-item__content')).toHaveCSS('padding', '8px');
    await match(peek.locator('.annotation-item__title-row'), approved.locator('.pk-row-head'), ['gap', 'minHeight', 'marginBottom']);
    await match(peek.locator('.annotation-item__page'), approved.locator('.pk-page-label'), typography);
    await match(peek.locator('[data-row-action="edit"]'), approved.locator('[data-action="edit"]'), ['width', 'height', 'padding', 'borderRadius', 'color']);
    await match(peek.locator('[data-row-action="edit"] svg'), approved.locator('[data-action="edit"] svg'), icon);
    await match(peek.locator('.annotation-item__kind-icon svg'), approved.locator('.pk-kind svg'), icon);
    await expect(peek.locator('.annotation-item__quote')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('annotation-peek.png') });
  } finally { await mock.page.close(); }
});
