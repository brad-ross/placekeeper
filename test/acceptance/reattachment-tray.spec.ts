import { expect, test, type Locator, type Page } from '@playwright/test';

const fixtureUrl = '/test/acceptance/review-harness/index.html?reconciliation=1';
const productionFixtureUrl = '/test/acceptance/review-harness/index.html?visual=tray&reconciliation=1';

const viewports = [
  { name: 'wide', width: 1280, height: 900 },
  { name: 'narrow', width: 390, height: 720 },
] as const;

async function openAnnotations(page: Page) {
  const presentation = (page.viewportSize()?.width ?? 1280) < 900 ? 'bottom' : 'right';
  const workspace = presentation === 'bottom'
    ? page.locator('#review-workspace')
    : page.locator('#review-tools-workspace');
  const openAttribute = presentation === 'bottom'
    ? 'data-workspace-open'
    : 'data-tools-workspace-open';

  await expect(page.locator('[data-review-stage]')).toHaveAttribute(
    'data-workspace-presentation',
    presentation,
  );
  if (await workspace.getAttribute(openAttribute) !== 'true') {
    await page.getByRole('button', { name: 'Show workspace' }).click();
  }
  await expect(workspace).toHaveAttribute(openAttribute, 'true');

  const annotationsTab = page.getByRole('tab', { name: 'Annotations', exact: true });
  if (await annotationsTab.getAttribute('aria-selected') !== 'true') {
    await annotationsTab.click();
  }
  await expect(annotationsTab).toHaveAttribute('aria-selected', 'true');

  const panel = page.locator('[data-annotation-scroll-viewport]');
  await expect(panel).toBeVisible();
  return panel;
}

async function openFixture(
  page: Page,
  viewport: { readonly name: string; readonly width: number; readonly height: number },
) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(fixtureUrl);
  return openAnnotations(page);
}

async function openProductionFixture(
  page: Page,
  viewport: { readonly name: string; readonly width: number; readonly height: number },
) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(productionFixtureUrl);
  await expect(page.locator('#root')).toHaveAttribute('data-production-root', 'true');
  return openAnnotations(page);
}

function reattachmentRow(panel: Locator) {
  return panel.locator('[data-reconciliation-entry]').filter({
    has: panel.page().getByRole('button', {
      name: /Reattach previous Highlight annotation on page 1/u,
    }),
  });
}

async function isPainted(locator: Locator) {
  return locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    let current: Element | null = element;
    let effectiveOpacity = 1;
    while (current !== null) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      effectiveOpacity *= Number(style.opacity);
      current = current.parentElement;
    }
    return effectiveOpacity > 0 && bounds.width > 0 && bounds.height > 0;
  });
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('Expected the trailing row control to have geometry.');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function rowSurface(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
    };
  });
}

async function expectElementsInsideVisiblePanel(panel: Locator, elements: Locator) {
  const geometry = await panel.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      left: bounds.left,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  });
  expect(geometry.scrollTop).toBe(0);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1);
  for (const bounds of await elements.evaluateAll((nodes) => nodes.map((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
  }))) {
    expect(bounds.left).toBeGreaterThanOrEqual(geometry.left - 1);
    expect(bounds.top).toBeGreaterThanOrEqual(geometry.top - 1);
    expect(bounds.right).toBeLessThanOrEqual(geometry.right + 1);
    expect(bounds.bottom).toBeLessThanOrEqual(geometry.bottom + 1);
  }
}

async function expectReaderActionStyling(reader: Locator) {
  for (const button of [
    reader.getByRole('button', { name: 'Cancel' }),
    reader.getByRole('button', { name: 'Attach' }),
  ]) {
    const style = await button.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        borderTopWidth: computed.borderTopWidth,
        borderRadius: computed.borderRadius,
        fontSize: computed.fontSize,
        minHeight: computed.minHeight,
      };
    });
    expect(style).toMatchObject({
      borderTopWidth: '0px',
      borderRadius: '9px',
      fontSize: '12px',
      minHeight: '30px',
    });
  }
}

interface ReaderParitySignature {
  readonly surface: {
    readonly reader: string;
    readonly header: string;
    readonly body: string;
  };
  readonly readerGap: number;
  readonly headerPaddingBottom: number;
  readonly metadata: {
    readonly fontFamily: string;
    readonly fontSize: number;
    readonly fontWeight: string;
    readonly lineHeight: number;
  };
  readonly content: {
    readonly fontFamily: string;
    readonly fontSize: number;
    readonly fontWeight: string;
    readonly lineHeight: number;
    readonly paragraphSpacing: number;
  };
}

async function readerParitySignature(
  reader: Locator,
  metadataSelector: string,
  contentSelector: string,
): Promise<ReaderParitySignature> {
  return reader.evaluate((element, { metadataSelector, contentSelector }) => {
    const header = element.querySelector<HTMLElement>('.full-annotation-reader__metadata-bar');
    const body = element.querySelector<HTMLElement>('.full-annotation-reader__body');
    const metadata = element.querySelector<HTMLElement>(metadataSelector);
    const content = element.querySelector<HTMLElement>(contentSelector);
    if (!header || !body || !metadata || !content) {
      throw new Error('Reader parity structure is incomplete.');
    }
    const readerStyle = getComputedStyle(element);
    const headerStyle = getComputedStyle(header);
    const bodyStyle = getComputedStyle(body);
    const metadataStyle = getComputedStyle(metadata);
    const contentStyle = getComputedStyle(content);
    const number = (value: string) => Number.parseFloat(value);
    let paragraphSpacing = number(contentStyle.marginBottom);
    if (content.matches(':last-child') && content.parentElement !== null) {
      const probe = document.createElement(content.tagName.toLocaleLowerCase());
      probe.hidden = true;
      content.parentElement.append(probe);
      paragraphSpacing = number(getComputedStyle(content).marginBottom);
      probe.remove();
    }
    return {
      surface: {
        reader: readerStyle.backgroundColor,
        header: headerStyle.backgroundColor,
        body: bodyStyle.backgroundColor,
      },
      readerGap: number(readerStyle.gap),
      headerPaddingBottom: number(headerStyle.paddingBottom),
      metadata: {
        fontFamily: metadataStyle.fontFamily,
        fontSize: number(metadataStyle.fontSize),
        fontWeight: metadataStyle.fontWeight,
        lineHeight: number(metadataStyle.lineHeight),
      },
      content: {
        fontFamily: contentStyle.fontFamily,
        fontSize: number(contentStyle.fontSize),
        fontWeight: contentStyle.fontWeight,
        lineHeight: number(contentStyle.lineHeight),
        paragraphSpacing,
      },
    };
  }, { metadataSelector, contentSelector });
}

async function canonicalReaderSignature(panel: Locator): Promise<ReaderParitySignature> {
  const trigger = panel.getByRole('button', {
    name: /Read full Highlight annotation on page 8/u,
  });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const reader = panel.locator('[data-full-annotation-reader="true"]');
  await expect(reader).toHaveAttribute('data-annotation-origin', 'source');
  const signature = await readerParitySignature(
    reader,
    '.full-annotation-reader__metadata',
    '.full-annotation-reader__body p',
  );
  await reader.locator('[data-full-annotation-action="back"]').click();
  await expect(reader).toHaveCount(0);
  return signature;
}

async function expectReconciliationReaderParity(
  reader: Locator,
  canonical: ReaderParitySignature,
  mode: 'reattach' | 'discard',
) {
  await expect(reader).toHaveAttribute('data-reconciliation-detail', mode);
  await expect(reader.getByText('Check the identifying variation.', { exact: true })).toBeVisible();
  await expect(reader.getByText('the previous identification argument', { exact: true })).toBeVisible();
  await expect(reader.locator('.full-annotation-reader__body > p')).toHaveText(
    'Check the identifying variation.',
  );
  await expect(reader.locator('.full-annotation-reader__quote > p')).toHaveText(
    'the previous identification argument',
  );

  const actual = await readerParitySignature(
    reader,
    '.full-annotation-reader__metadata',
    '.full-annotation-reader__body > p',
  );
  expect(actual.surface).toEqual(canonical.surface);
  expect(actual.readerGap).toBeCloseTo(canonical.readerGap, 3);
  expect(actual.headerPaddingBottom).toBeCloseTo(canonical.headerPaddingBottom, 3);
  expect(actual.metadata).toEqual(canonical.metadata);
  expect(actual.content).toEqual(canonical.content);

  const sourceTypography = await reader.locator('.full-annotation-reader__quote > p')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        fontFamily: style.fontFamily,
        fontSize: Number.parseFloat(style.fontSize),
        fontWeight: style.fontWeight,
        lineHeight: Number.parseFloat(style.lineHeight),
      };
    });
  expect(sourceTypography).toEqual({
    fontFamily: canonical.content.fontFamily,
    fontSize: canonical.content.fontSize,
    fontWeight: canonical.content.fontWeight,
    lineHeight: canonical.content.lineHeight,
  });

  const hierarchy = await reader.evaluate((element) => {
    const authored = element.querySelector<HTMLElement>('.full-annotation-reader__body > p');
    const prior = element.querySelector<HTMLElement>('.full-annotation-reader__quote');
    if (!authored || !prior) throw new Error('Reader content hierarchy is incomplete.');
    const authoredBounds = authored.getBoundingClientRect();
    const priorBounds = prior.getBoundingClientRect();
    return {
      separation: priorBounds.top - authoredBounds.bottom,
      authoredParagraphSpacing: Number.parseFloat(getComputedStyle(authored).marginBottom),
      sourceBackground: getComputedStyle(prior).backgroundColor,
    };
  });
  expect(hierarchy.separation).toBeGreaterThanOrEqual(0);
  expect(hierarchy.authoredParagraphSpacing).toBeCloseTo(canonical.content.paragraphSpacing, 3);
  expect(hierarchy.sourceBackground).toBe(canonical.surface.reader);
}

test('detached annotation swaps its warning for discard at pointer and keyboard intent', async ({ page, browserName }, testInfo) => {
  const panel = await openFixture(page, viewports[0]);
  const row = reattachmentRow(panel);
  const navigation = row.getByRole('button', {
    name: /Reattach previous Highlight annotation on page 1/u,
  });
  const warning = row.locator('[data-annotation-status-icon="warning"]');
  const discard = row.getByRole('button', {
    name: 'Discard Highlight annotation on page 1',
  });

  await expect(row).toBeVisible();
  await expect(warning).toHaveCount(1);
  await expect(discard).toHaveCount(1);
  await page.getByRole('application', { name: 'PDF review canvas' }).focus();
  await page.mouse.move(0, 0);
  expect(await isPainted(warning)).toBe(true);
  expect(await isPainted(discard)).toBe(false);
  const warningCenter = await center(warning);

  await row.hover();
  expect(await isPainted(warning)).toBe(false);
  expect(await isPainted(discard)).toBe(true);
  const discardHoverCenter = await center(discard);
  expect(Math.abs(discardHoverCenter.x - warningCenter.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(discardHoverCenter.y - warningCenter.y)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('hover.png') });

  await page.mouse.move(0, 0);
  await navigation.focus();
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
  await expect(discard).toBeFocused();
  expect(await isPainted(warning)).toBe(false);
  expect(await isPainted(discard)).toBe(true);
  const discardFocusCenter = await center(discard);
  expect(discardFocusCenter).toEqual(discardHoverCenter);
});

test('production touch controls stay 44px and contained in a short reader', async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 520 },
  });
  const page = await context.newPage();
  try {
    const panel = await openFixture(page, { name: 'short-touch', width: 390, height: 520 });
    await page.locator('#root').evaluate((element) => {
      element.setAttribute('data-production-root', 'true');
    });
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const row = reattachmentRow(panel);
    const warning = row.locator('[data-annotation-status-icon="warning"]');
    const discard = row.getByRole('button', {
      name: 'Discard Highlight annotation on page 1',
    });
    expect(await isPainted(warning)).toBe(false);
    expect(await isPainted(discard)).toBe(true);
    const warningCenter = await center(warning);
    const discardCenter = await center(discard);
    expect(Math.abs(discardCenter.x - warningCenter.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(discardCenter.y - warningCenter.y)).toBeLessThanOrEqual(1);

    await row.getByRole('button', {
      name: /Reattach previous Highlight annotation on page 1/u,
    }).click();
    const reader = panel.locator('[data-reconciliation-reader][data-reconciliation-detail="reattach"]');
    const body = reader.locator('.full-annotation-reader__body');
    await expect(reader.getByText('Select the text to reattach to in the PDF.', { exact: true }))
      .toBeVisible();
    expect(await body.evaluate((element) => element.clientHeight)).toBeGreaterThan(0);
    const controls = [
      { name: 'Back', locator: reader.locator('[data-full-annotation-action="back"]') },
      { name: 'Delete', locator: reader.getByRole('button', { name: 'Delete' }) },
      { name: 'Cancel', locator: reader.getByRole('button', { name: 'Cancel' }) },
      { name: 'Attach', locator: reader.getByRole('button', { name: 'Attach' }) },
    ];
    for (const control of controls) {
      const bounds = await control.locator.boundingBox();
      if (bounds === null) throw new Error('Expected production touch control geometry.');
      expect(bounds.width, `${control.name} touch width`).toBeGreaterThanOrEqual(44);
      expect(bounds.height, `${control.name} touch height`).toBeGreaterThanOrEqual(44);
    }
    await expectElementsInsideVisiblePanel(
      panel,
      reader.locator('[data-reattachment-selection-mode], button'),
    );
    await page.screenshot({ path: testInfo.outputPath('short-production-touch-reader.png') });
  } finally {
    await context.close();
  }
});

for (const viewport of viewports) {
  test(`${viewport.name} detached card opens a sole reader-style attachment screen and restores the list`, async ({ page }, testInfo) => {
    const panel = await openFixture(page, viewport);
    const row = reattachmentRow(panel);
    const warning = row.locator('[data-annotation-status-icon="warning"]');
    const discard = row.getByRole('button', {
      name: 'Discard Highlight annotation on page 1',
    });
    const trigger = row.getByRole('button', {
      name: /Reattach previous Highlight annotation on page 1/u,
    });
    const selectionActions = page.getByRole('toolbar', { name: 'Selection review actions' });
    await page.mouse.move(0, 0);
    const restingSurface = await rowSurface(row);
    await expect(selectionActions).toBeVisible();
    await trigger.click();

    const reader = panel.locator(
      '[data-reconciliation-reader][data-reconciliation-detail="reattach"]',
    );
    await expect(reader).toHaveAttribute('data-full-annotation-reader', 'true');
    await expect(reader).toHaveAttribute('aria-label', 'Reattach highlight, previously page 1');
    await expect(reader.locator('.full-annotation-reader__metadata')).toBeVisible();
    await expect(reader.locator('.full-annotation-reader__metadata .annotation-item__page'))
      .toHaveText('1');
    await expect(reader.locator('.full-annotation-reader__metadata .annotation-item__kind-icon'))
      .toHaveAttribute('title', 'Highlight');
    await expect(reader.locator('[data-reattachment-selection-mode]')).toBeVisible();
    await expect(reader.getByText('Select the text to reattach to in the PDF.', { exact: true }))
      .toBeVisible();
    await expect(selectionActions).toBeHidden();
    await expect(panel.getByRole('list', { name: 'Annotations in document order' })).toHaveCount(0);
    await expect(panel.locator('[data-reconciliation-entry]')).toHaveCount(0);
    const back = reader.locator('[data-full-annotation-action="back"]');
    await expect(back).toHaveAccessibleName('Back');
    await expect(back).toBeFocused();

    await expectElementsInsideVisiblePanel(
      panel,
      reader.locator('[data-reattachment-selection-mode], button'),
    );
    await expectReaderActionStyling(reader);
    expect(await reader.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-reader.png`),
    });

    await back.click();
    await expect(reader).toHaveCount(0);
    await expect(panel.getByRole('list', { name: 'Annotations in document order' })).toBeVisible();
    await expect(trigger).toBeFocused();
    await page.mouse.move(0, 0);
    expect(await isPainted(warning)).toBe(true);
    expect(await isPainted(discard)).toBe(false);
    expect(await rowSurface(row)).toEqual(restingSurface);
    await expect(selectionActions).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(reader).toBeVisible();
    await expect(back).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(reader).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(selectionActions).toBeVisible();

    await trigger.click();
    await expect(reader).toBeVisible();
    await expect(selectionActions).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(reader).toHaveCount(0);
    await expect(panel.getByRole('list', { name: 'Annotations in document order' })).toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(selectionActions).toBeVisible();

    await trigger.click();
    await expect(selectionActions).toBeHidden();
    await reader.getByRole('button', { name: 'Cancel' }).click();
    await expect(reader).toHaveCount(0);
    await expect(panel.getByRole('list', { name: 'Annotations in document order' })).toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(selectionActions).toBeVisible();
  });

  test(`${viewport.name} production reattach and discard readers match the canonical full reader`, async ({ page }, testInfo) => {
    const panel = await openProductionFixture(page, viewport);
    const canonical = await canonicalReaderSignature(panel);
    const row = reattachmentRow(panel);
    const reattach = row.getByRole('button', {
      name: /Reattach previous Highlight annotation on page 1/u,
    });
    const initialReconciliationCount = await panel.locator('[data-reconciliation-entry]').count();
    const initialRowState = await row.evaluate((element) => ({
      target: element.getAttribute('data-reconciliation-item')
        ?? element.getAttribute('data-reconciliation-draft'),
      text: element.textContent,
    }));

    await reattach.click();
    const reader = panel.locator('[data-reconciliation-reader]');
    await expectReconciliationReaderParity(reader, canonical, 'reattach');
    await expect(reader.getByText('Select the text to reattach to in the PDF.', { exact: true }))
      .toBeVisible();
    const readerDelete = reader.locator('.full-annotation-reader__header-actions')
      .getByRole('button', { name: 'Delete' });
    await expect(readerDelete).toHaveAttribute('data-full-annotation-action', 'delete');
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => (
        requestAnimationFrame(() => resolve())
      )));
    });
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-production-reattach.png`),
    });

    await readerDelete.click();
    await expectReconciliationReaderParity(reader, canonical, 'discard');
    await expect(reader.locator('[data-discard-confirmation]')).toBeVisible();
    await reader.getByRole('button', { name: 'Cancel' }).click();
    await expect(reader).toHaveCount(0);
    await expect(reattach).toBeFocused();
    await expect(panel.locator('[data-reconciliation-entry]')).toHaveCount(initialReconciliationCount);
    expect(await row.evaluate((element) => ({
      target: element.getAttribute('data-reconciliation-item')
        ?? element.getAttribute('data-reconciliation-draft'),
      text: element.textContent,
    }))).toEqual(initialRowState);
    await row.hover();
    await row.getByRole('button', {
      name: 'Discard Highlight annotation on page 1',
    }).click();
    await expectReconciliationReaderParity(reader, canonical, 'discard');
    await expect(reader.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(reader.getByRole('button', { name: 'Discard', exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-production-discard.png`),
    });
  });
}

test('reattachment suppresses PDF caret and action shortcuts until the reader exits', async ({ page }) => {
  const panel = await openFixture(page, viewports[0]);
  const canvas = page.getByRole('application', { name: 'PDF review canvas' });
  const trigger = reattachmentRow(panel).getByRole('button', {
    name: /Reattach previous Highlight annotation on page 1/u,
  });
  const caret = page.locator('[data-review-insertion-caret]');

  await page.getByRole('button', { name: 'Use caret' }).click();
  await expect(caret).toBeVisible();
  await trigger.click();
  const reader = panel.locator('[data-reconciliation-reader][data-reconciliation-detail="reattach"]');
  await expect(reader).toBeVisible();
  await expect(caret).toBeHidden();
  await reader.locator('[data-full-annotation-action="back"]').click();
  await expect(reader).toHaveCount(0);
  await expect(caret).toBeVisible();

  await trigger.click();
  await expect(caret).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);
  await expect(caret).toBeVisible();

  await trigger.click();
  await expect(caret).toBeHidden();
  await reader.getByRole('button', { name: 'Cancel' }).click();
  await expect(reader).toHaveCount(0);
  await expect(caret).toBeVisible();

  await page.getByRole('button', { name: 'Use selection' }).click();
  const selectionActions = page.getByRole('toolbar', { name: 'Selection review actions' });
  await expect(selectionActions).toBeVisible();
  const stateOutput = page.locator('output[data-revision]');
  const beforeShortcuts = await stateOutput.evaluate((element) => ({
    revision: element.getAttribute('data-revision'),
    kinds: element.getAttribute('data-kinds'),
  }));
  if (beforeShortcuts.revision === null) throw new Error('Expected harness review revision.');

  await trigger.click();
  await expect(reader).toBeVisible();
  for (const shortcut of ['Alt+Shift+KeyD', 'Alt+Shift+KeyH', 'Alt+Shift+KeyR']) {
    await page.keyboard.press(shortcut);
    await expect(reader, `${shortcut} must leave reattachment in control`).toBeVisible();
    await expect(page.getByRole('region', { name: 'Highlight Comment' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Replacement' })).toHaveCount(0);
    expect(await stateOutput.evaluate((element) => ({
      revision: element.getAttribute('data-revision'),
      kinds: element.getAttribute('data-kinds'),
    })), `${shortcut} must not mutate the review`).toEqual(beforeShortcuts);
  }

  await reader.locator('[data-full-annotation-action="back"]').click();
  await expect(selectionActions).toBeVisible();

  await canvas.focus();
  await page.keyboard.press('Alt+Shift+KeyR');
  const replacement = page.getByRole('region', { name: 'Replacement' });
  await expect(replacement).toBeVisible();
  await replacement.getByRole('button', { name: 'Cancel' }).click();
  await expect(replacement).toHaveCount(0);

  await page.getByRole('button', { name: 'Use selection' }).click();
  await expect(selectionActions).toBeVisible();
  await canvas.focus();
  await page.keyboard.press('Alt+Shift+KeyH');
  const highlight = page.getByRole('region', { name: 'Highlight Comment' });
  await expect(highlight).toBeVisible();
  await highlight.getByRole('button', { name: 'Cancel' }).click();
  await expect(highlight).toHaveCount(0);

  await page.getByRole('button', { name: 'Use selection' }).click();
  await expect(selectionActions).toBeVisible();
  await canvas.focus();
  const beforeDelete = await stateOutput.evaluate((element) => ({
    revision: element.getAttribute('data-revision'),
    kinds: element.getAttribute('data-kinds'),
  }));
  if (beforeDelete.revision === null || beforeDelete.kinds === null) {
    throw new Error('Expected pre-delete review state.');
  }
  await page.keyboard.press('Alt+Shift+KeyD');
  await expect(stateOutput).toHaveAttribute(
    'data-revision',
    String(Number(beforeDelete.revision) + 1),
  );
  await expect(stateOutput).toHaveAttribute(
    'data-kinds',
    `${beforeDelete.kinds},delete`,
  );
});

test('header Delete settles a failed terminal reattachment before later interactions', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto(
    '/test/acceptance/review-harness/index.html?reconciliation=default'
      + '&interaction-lifecycle=1&finalize-fails-twice=1',
  );
  const panel = await openAnnotations(page);
  const root = page.locator('#root');
  const stateOutput = page.locator('output[data-revision]');
  const highlightEntry = reattachmentRow(panel);
  const highlightTrigger = highlightEntry.getByRole('button', {
    name: /Reattach previous Highlight annotation on page 1/u,
  });
  const highlightTarget = await highlightEntry.getAttribute('data-reconciliation-item');
  if (highlightTarget === null) throw new Error('Expected detached highlight target identity.');
  await highlightTrigger.click();
  const reader = panel.locator('[data-reconciliation-reader][data-reconciliation-detail="reattach"]');
  await expect(root).toHaveAttribute('data-interaction-hold', 'active');
  await reader.getByRole('button', { name: 'Attach' }).click();

  await expect.poll(async () => JSON.parse(
    await root.getAttribute('data-finalize-requests') ?? '[]',
  )).toHaveLength(2);
  await expect(reader).toBeVisible();
  await expect(reader.getByText(
    'connection reset before durable interaction finalization',
    { exact: true },
  )).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Delete' })).toBeEnabled();
  await expect(stateOutput).toHaveAttribute('data-pending-drafts', '1');

  await reader.getByRole('button', { name: 'Delete' }).click();

  await expect(reader).toHaveCount(0);
  await expect(panel.locator('[data-discard-confirmation]')).toHaveCount(0);
  await expect.poll(async () => JSON.parse(
    await root.getAttribute('data-finalize-requests') ?? '[]',
  )).toHaveLength(3);
  const finalizeRequests = JSON.parse(
    await root.getAttribute('data-finalize-requests') ?? '[]',
  ) as Array<{ readonly outcome: string }>;
  expect(finalizeRequests[1]).toEqual(finalizeRequests[0]);
  expect(finalizeRequests[2]).toEqual(finalizeRequests[0]);
  expect(finalizeRequests.map(({ outcome }) => outcome)).toEqual([
    'applied',
    'applied',
    'applied',
  ]);
  expect(JSON.parse(await root.getAttribute('data-release-requests') ?? '[]')).toEqual([]);
  await expect(root).toHaveAttribute(
    'data-interaction-events',
    '["begin:1","finalize:2:applied","acknowledge:3"]',
  );
  await expect(root).toHaveAttribute('data-interaction-hold', 'released');
  await expect(stateOutput).toHaveAttribute('data-pending-drafts', '0');
  const kinds = (await stateOutput.getAttribute('data-kinds') ?? '').split(',').sort();
  expect(kinds).toEqual(['delete', 'highlight']);
  await expect(panel.locator('[data-reconciliation-entry]')).toHaveCount(1);
  await expect(highlightTrigger).toHaveCount(0);
  await expect(panel.locator(`[data-review-item="${highlightTarget}"]`)).toHaveCount(1);

  const deleteTrigger = panel.getByRole('button', {
    name: 'Reattach previous Delete annotation on page 2',
  });
  await deleteTrigger.click();
  await expect(root).toHaveAttribute('data-interaction-hold', 'active');
  await panel.locator('[data-reconciliation-reader][data-reconciliation-detail="reattach"]')
    .locator('[data-full-annotation-action="back"]')
    .click();
  await expect(deleteTrigger).toBeFocused();
  await expect(root).toHaveAttribute('data-interaction-hold', 'released');
  await expect.poll(async () => JSON.parse(
    await root.getAttribute('data-release-requests') ?? '[]',
  )).toHaveLength(1);
});

test('Escape from the PDF closes the attachment reader instead of the workspace', async ({ page }) => {
  const panel = await openFixture(page, viewports[0]);
  const workspace = page.locator('#review-tools-workspace');
  const trigger = reattachmentRow(panel).getByRole('button', {
    name: /Reattach previous Highlight annotation on page 1/u,
  });
  await trigger.click();
  const reader = panel.locator('[data-reconciliation-reader][data-reconciliation-detail="reattach"]');
  await expect(reader).toBeVisible();

  await page.getByRole('application', { name: 'PDF review canvas' }).focus();
  await expect(page.getByRole('application', { name: 'PDF review canvas' })).toBeFocused();
  await page.keyboard.press('Escape');

  await expect(workspace).toHaveAttribute('data-tools-workspace-open', 'true');
  await expect(reader).toHaveCount(0);
  await expect(panel.getByRole('list', { name: 'Annotations in document order' })).toBeVisible();
  await expect(trigger).toBeFocused();
});

test('reattachment reader keeps selection errors in place and restores the list after success', async ({ page }) => {
  const panel = await openFixture(page, viewports[0]);
  const row = reattachmentRow(panel);
  await row.getByRole('button', {
    name: /Reattach previous Highlight annotation on page 1/u,
  }).click();

  const reader = panel.locator('[data-reconciliation-reader][data-reconciliation-detail="reattach"]');
  const back = reader.locator('[data-full-annotation-action="back"]');
  const cancel = reader.getByRole('button', { name: 'Cancel' });
  const attach = reader.getByRole('button', { name: 'Attach' });
  await expect(attach).toBeEnabled();

  await page.getByRole('button', { name: 'Clear anchors' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect(attach).toBeDisabled();
  await expect(attach).toBeVisible();
  await page.getByRole('button', { name: 'Use selection' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect(attach).toBeEnabled();

  await page.getByRole('button', { name: 'Reject next command' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await attach.click();
  await expect(reader).toBeVisible();
  await expect(reader.getByText('Review changed elsewhere. Try again.', { exact: true })).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Annotations in document order' })).toHaveCount(0);
  await expectElementsInsideVisiblePanel(
    panel,
    reader.locator('[data-reattachment-selection-mode], button'),
  );
  await expectReaderActionStyling(reader);

  await page.getByRole('button', { name: 'Hold next command' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await attach.click();
  await expect(back).toBeDisabled();
  await expect(cancel).toBeDisabled();
  await expect(attach).toBeDisabled();
  await expectElementsInsideVisiblePanel(
    panel,
    reader.locator('[data-reattachment-selection-mode], button'),
  );
  await page.getByRole('button', { name: 'Release command' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect(reader).toHaveCount(0);
  await expect(panel.getByRole('list', { name: 'Annotations in document order' })).toBeVisible();
  await expect(panel.locator('[data-reconciliation-entry]')).toHaveCount(1);
  await expect(panel.getByRole('button', {
    name: /Reattach previous Delete annotation on page 2/u,
  })).toBeFocused();
});

test('long reattachment content scrolls inside the reader body while actions remain visible', async ({ page }, testInfo) => {
  const panel = await openFixture(page, { name: 'short', width: 390, height: 520 });
  await reattachmentRow(panel).getByRole('button', {
    name: /Reattach previous Highlight annotation on page 1/u,
  }).click();
  const reader = panel.locator('[data-reconciliation-reader][data-reconciliation-detail="reattach"]');
  const body = reader.locator('.full-annotation-reader__body');
  await reader.locator('.full-annotation-reader__body > p').evaluate((element) => {
    element.textContent = `${element.textContent ?? ''} `.repeat(35);
  });
  await reader.locator('.full-annotation-reader__quote > p').evaluate((element) => {
    element.textContent = `${element.textContent ?? ''} `.repeat(30);
  });

  const bodyGeometry = await body.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(bodyGeometry.scrollHeight).toBeGreaterThan(bodyGeometry.clientHeight);
  expect(bodyGeometry.overflowY).toMatch(/^(auto|scroll)$/u);
  await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expectElementsInsideVisiblePanel(
    panel,
    reader.locator('[data-reattachment-selection-mode], button'),
  );
  await page.screenshot({ path: testInfo.outputPath('long-reader.png') });
});

test('long rejection remains accessible without clipping short-pane actions', async ({ page }, testInfo) => {
  const panel = await openFixture(page, { name: 'short-error', width: 390, height: 520 });
  await reattachmentRow(panel).getByRole('button', {
    name: /Reattach previous Highlight annotation on page 1/u,
  }).click();
  const reader = panel.locator('[data-reconciliation-reader][data-reconciliation-detail="reattach"]');
  await page.getByRole('button', { name: 'Reject next command' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await reader.getByRole('button', { name: 'Attach' }).click();

  const message = reader.locator('.reconciliation-workspace__message[role="status"]');
  await expect(message).toHaveText('Review changed elsewhere. Try again.');
  const longError = 'The review changed elsewhere while this annotation was being reattached. '
    .repeat(12).trim();
  await message.evaluate((element, text) => { element.textContent = text; }, longError);
  await expect(message).toHaveText(longError);
  await expect(message).toBeVisible();

  const body = reader.locator('.full-annotation-reader__body');
  expect(await message.evaluate((element) => (
    element.parentElement?.classList.contains('full-annotation-reader__body') === true
  ))).toBe(true);
  const bodyGeometry = await body.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      top: bounds.top,
      bottom: bounds.bottom,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    };
  });
  expect(bodyGeometry.clientHeight).toBeGreaterThan(0);
  expect(bodyGeometry.scrollHeight).toBeGreaterThan(bodyGeometry.clientHeight);
  expect(bodyGeometry.overflowY).toMatch(/^(auto|scroll)$/u);
  const initialMessage = await message.boundingBox();
  if (initialMessage === null) throw new Error('Expected visible rejection message geometry.');
  expect(initialMessage.y).toBeGreaterThanOrEqual(bodyGeometry.top - 1);
  expect(initialMessage.y).toBeLessThan(bodyGeometry.bottom);
  await body.evaluate((element) => {
    const message = element.querySelector<HTMLElement>('.reconciliation-workspace__message');
    if (message === null) throw new Error('Rejection message is not inside the reader body.');
    element.scrollTop = message.getBoundingClientRect().height - element.clientHeight;
  });
  expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const scrolledMessage = await message.boundingBox();
  if (scrolledMessage === null) throw new Error('Expected reachable rejection message geometry.');
  expect(scrolledMessage.y + scrolledMessage.height).toBeLessThanOrEqual(bodyGeometry.bottom + 1);
  expect(scrolledMessage.y + scrolledMessage.height).toBeGreaterThan(bodyGeometry.top);
  await expectElementsInsideVisiblePanel(
    panel,
    reader.locator('[data-reattachment-selection-mode], button'),
  );
  await page.screenshot({ path: testInfo.outputPath('long-error-reader.png') });
});
