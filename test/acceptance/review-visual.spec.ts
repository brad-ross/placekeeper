import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { PlacekeeperHost } from '../../apps/service/src/host/placekeeper-host.js';

let installedHost: PlacekeeperHost;
let installedLaunchUrl = '';
let installedRoot = '';

test.beforeAll(async () => {
  installedRoot = await mkdtemp(join(tmpdir(), 'warm-neutral-visual-'));
  const sourceRoot = join(installedRoot, 'source');
  await mkdir(sourceRoot);
  const pdf = join(installedRoot, 'paper.pdf');
  await copyFile(resolve('test/fixtures/pdfs/text-native-with-annotations.pdf'), pdf);
  installedHost = await PlacekeeperHost.start({
    recoveryRoot: join(installedRoot, 'recovery'),
    webAssets: { root: resolve('dist/web') },
  });
  const launched = await installedHost.open({ pdfPath: pdf, sourceRootPath: sourceRoot });
  if (!launched.ok || launched.kind === 'recovery-offered') throw new Error('Visual production launch failed');
  installedLaunchUrl = launched.url;
});

test.afterAll(async () => {
  await installedHost?.close();
  if (installedRoot) await rm(installedRoot, { recursive: true, force: true });
});

async function openScene(page: Page, scene: string, viewport = { width: 1280, height: 900 }): Promise<Locator> {
  await page.setViewportSize(viewport);
  await page.goto(`/test/acceptance/review-harness/index.html?visual=${scene}`);
  const product = page.locator('[data-production-review]');
  await expect(product).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  return product;
}

async function expectScene(locator: Locator, name: string): Promise<void> {
  await expect(locator).toHaveScreenshot(name, {
    animations: 'disabled',
    maxDiffPixels: 100,
    threshold: 0.05,
  });
}

async function openFocusedReattachment(
  page: Page,
  viewport: { readonly width: number; readonly height: number },
): Promise<Locator> {
  await page.setViewportSize(viewport);
  await page.goto('/test/acceptance/review-harness/index.html?visual=tray&reconciliation=1');
  const product = page.locator('.review-shell');
  await expect(product).toBeVisible();
  const workspace = viewport.width < 900
    ? page.locator('#review-workspace')
    : page.locator('#review-tools-workspace');
  const openAttribute = viewport.width < 900 ? 'data-workspace-open' : 'data-tools-workspace-open';
  if (await workspace.getAttribute(openAttribute) !== 'true') {
    await page.getByRole('button', {
      name: 'Show workspace',
    }).click();
  }
  const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
  if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();
  await page.getByRole('button', {
    name: 'Reattach previous Highlight annotation on page 1',
  }).click();
  const detail = page.locator('[data-reconciliation-detail="reattach"]');
  await expect(detail).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  return detail;
}

async function expectFocusedReattachmentGeometry(detail: Locator): Promise<void> {
  const geometry = await detail.evaluate((element) => {
    const header = element.querySelector<HTMLElement>('.reconciliation-workspace__detail-header');
    const title = header?.querySelector<HTMLElement>('h2');
    const pill = header?.querySelector<HTMLElement>('.reconciliation-workspace__state-pill');
    const back = header?.querySelector<HTMLElement>('.full-annotation-reader__back');
    const discard = header?.querySelector<HTMLElement>('.full-annotation-reader__edit');
    if (!header || !title || !pill || !back || !discard) throw new Error('Focused reattachment header is incomplete.');
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      title: title.getBoundingClientRect().toJSON(),
      pill: pill.getBoundingClientRect().toJSON(),
      back: back.getBoundingClientRect().toJSON(),
      discard: discard.getBoundingClientRect().toJSON(),
    };
  });
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.pill.x).toBeGreaterThanOrEqual(geometry.title.x + geometry.title.width - 0.5);
  expect(geometry.pill.y).toBeGreaterThanOrEqual(geometry.title.y - 8);
  expect(geometry.pill.y + geometry.pill.height).toBeLessThanOrEqual(
    geometry.title.y + geometry.title.height + 8,
  );
  expect(geometry.back.width).toBeCloseTo(geometry.discard.width, 1);
  expect(geometry.back.height).toBeCloseTo(geometry.discard.height, 1);
}

async function expectAnnotationTrayOverflow(
  page: Page,
  { verticallyScrollable = false }: { readonly verticallyScrollable?: boolean } = {},
): Promise<void> {
  const viewport = page.locator('[data-annotation-scroll-viewport]');
  const geometry = await viewport.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
    rows: [...element.querySelectorAll<HTMLElement>('li[data-annotation-origin]')]
      .map((row) => ({ clientWidth: row.clientWidth, scrollWidth: row.scrollWidth })),
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.rows.length).toBeGreaterThanOrEqual(5);
  for (const row of geometry.rows) {
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
  }
  if (verticallyScrollable) expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
}

async function expectAnnotationEndcapGeometry(row: Locator, more: Locator): Promise<void> {
  const geometry = await row.evaluate((element) => {
    const content = element.querySelector<HTMLElement>(
      '.annotation-item__content, .existing-annotation__content',
    );
    const excerpt = element.querySelector<HTMLElement>('.annotation-item__excerpt');
    const trigger = element.querySelector<HTMLElement>('[data-read-full-annotation="true"]');
    const excerptMain = element.querySelector<HTMLElement>('.annotation-item__excerpt-main');
    const quote = element.querySelector<HTMLElement>('.annotation-item__quote');
    if (!content || !excerpt || !trigger || !excerptMain) {
      throw new Error('Annotation reader trigger geometry is incomplete.');
    }
    const contentBounds = content.getBoundingClientRect();
    const triggerBounds = trigger.getBoundingClientRect();
    const style = getComputedStyle(trigger);
    const excerptStyle = getComputedStyle(excerpt);
    const excerptMainStyle = getComputedStyle(excerptMain);
    const quoteStyle = quote === null ? null : getComputedStyle(quote);
    return {
      content: {
        left: contentBounds.left,
        right: contentBounds.right,
        top: contentBounds.top,
        bottom: contentBounds.bottom,
      },
      trigger: {
        left: triggerBounds.left,
        right: triggerBounds.right,
        top: triggerBounds.top,
        bottom: triggerBounds.bottom,
      },
      excerptPaddingInlineEnd: Number.parseFloat(excerptStyle.paddingInlineEnd),
      isExcerptChild: trigger.parentElement === excerpt,
      backgroundImage: style.backgroundImage,
      borderRadius: style.borderRadius,
      lineClamp: excerptMainStyle.webkitLineClamp,
      quoteMarginTop: quoteStyle?.marginTop ?? null,
      quoteFontSize: quoteStyle?.fontSize ?? null,
      quoteLineHeight: quoteStyle?.lineHeight ?? null,
    };
  });
  expect(geometry.trigger.left).toBeGreaterThanOrEqual(geometry.content.left);
  expect(geometry.trigger.right).toBeLessThanOrEqual(geometry.content.right + 0.5);
  expect(geometry.trigger.top).toBeGreaterThanOrEqual(geometry.content.top);
  expect(geometry.trigger.bottom).toBeLessThanOrEqual(geometry.content.bottom + 0.5);
  expect(geometry.excerptPaddingInlineEnd).toBe(0);
  expect(geometry.isExcerptChild).toBe(true);
  expect(geometry.backgroundImage).toBe('none');
  expect(geometry.borderRadius).toBe('0px');
  expect(geometry.lineClamp).toBe('3');
  if (geometry.quoteMarginTop !== null) {
    expect(geometry.quoteMarginTop).toBe('6px');
    expect(geometry.quoteFontSize).toBe('13px');
    expect(geometry.quoteLineHeight).toBe('19.5px');
  }
  await expect(more).toHaveAttribute('title', 'Read full annotation');
}

async function expectAnnotationTitleEndcapGeometry(row: Locator): Promise<void> {
  const geometry = await row.evaluate((element) => {
    const title = element.querySelector<HTMLElement>('.annotation-item__title-row');
    const metadata = element.querySelector<HTMLElement>('.annotation-item__kind-icon');
    const edit = element.querySelector<HTMLElement>('[data-row-action="edit"]');
    const remove = element.querySelector<HTMLElement>('[data-row-action="delete"]');
    const copy = element.querySelector<HTMLElement>('.copy-link-control__trigger--row');
    const actions = element.querySelector<HTMLElement>('.row-action-group__direct');
    const page = element.querySelector<HTMLElement>('.annotation-item__page');
    if (!title || !metadata || !edit || !remove || !copy || !actions || !page) {
      throw new Error('Annotation title endcap geometry is incomplete.');
    }
    const titleBounds = title.getBoundingClientRect();
    const metadataBounds = metadata.getBoundingClientRect();
    const editBounds = edit.getBoundingClientRect();
    const removeBounds = remove.getBoundingClientRect();
    const copyBounds = copy.getBoundingClientRect();
    const actionsBounds = actions.getBoundingClientRect();
    const pageBounds = page.getBoundingClientRect();
    const rowStyle = getComputedStyle(element);
    const contentStyle = getComputedStyle(element.querySelector<HTMLElement>('.annotation-item__content')!);
    const titleStyle = getComputedStyle(title);
    const excerptStyle = getComputedStyle(element.querySelector<HTMLElement>('.annotation-item__excerpt')!);
    const pageStyle = getComputedStyle(page);
    const actionsStyle = getComputedStyle(actions);
    return {
      title: titleBounds.toJSON(),
      metadata: metadataBounds.toJSON(),
      edit: editBounds.toJSON(),
      remove: removeBounds.toJSON(),
      copy: copyBounds.toJSON(),
      actions: actionsBounds.toJSON(),
      page: pageBounds.toJSON(),
      editOpacity: Number.parseFloat(getComputedStyle(edit).opacity),
      removeOpacity: Number.parseFloat(getComputedStyle(remove).opacity),
      copyOpacity: Number.parseFloat(getComputedStyle(copy).opacity),
      row: {
        borderWidth: rowStyle.borderWidth,
        borderRadius: rowStyle.borderRadius,
      },
      contentPadding: [contentStyle.paddingTop, contentStyle.paddingRight, contentStyle.paddingBottom, contentStyle.paddingLeft],
      titleGap: titleStyle.gap,
      titleMinHeight: titleStyle.minHeight,
      titleMarginBottom: titleStyle.marginBottom,
      excerptFontSize: excerptStyle.fontSize,
      excerptLineHeight: excerptStyle.lineHeight,
      pageFontSize: pageStyle.fontSize,
      pageMarginLeft: pageStyle.marginLeft,
      actionsGap: actionsStyle.gap,
    };
  });
  expect(geometry.copy.x).toBeGreaterThanOrEqual(geometry.metadata.x + geometry.metadata.width);
  expect(geometry.copy.x + geometry.copy.width).toBeLessThanOrEqual(
    geometry.title.x + geometry.title.width + 0.5,
  );
  expect(geometry.title.x + geometry.title.width).toBeGreaterThanOrEqual(
    geometry.actions.x + geometry.actions.width - 0.5,
  );
  expect(Math.abs(
    geometry.copy.y + geometry.copy.height / 2
      - (geometry.metadata.y + geometry.metadata.height / 2),
  )).toBeLessThanOrEqual(4);
  expect(geometry.edit.width).toBeCloseTo(geometry.remove.width, 1);
  expect(geometry.remove.width).toBeCloseTo(geometry.copy.width, 1);
  expect(geometry.edit.height).toBeCloseTo(geometry.remove.height, 1);
  expect(geometry.remove.height).toBeCloseTo(geometry.copy.height, 1);
  expect(geometry.edit.width).toBeLessThanOrEqual(34);
  expect(geometry.editOpacity).toBe(geometry.removeOpacity);
  expect(geometry.removeOpacity).toBe(geometry.copyOpacity);
  expect(geometry.page.x + geometry.page.width)
    .toBeCloseTo(geometry.actions.x + geometry.actions.width, 0);
  expect(geometry.row).toEqual({ borderWidth: '0px', borderRadius: '12px' });
  expect(geometry.contentPadding).toEqual(['8px', '12px', '8px', '12px']);
  expect(geometry.titleGap).toBe('6px');
  expect(geometry.titleMinHeight).toBe('27px');
  expect(geometry.titleMarginBottom).toBe('4px');
  expect(geometry.excerptFontSize).toBe('13px');
  expect(geometry.excerptLineHeight).toBe('20.15px');
  expect(geometry.pageFontSize).toBe('11px');
  expect(geometry.actionsGap).toBe('0px');
}

async function expectCompactAnnotationReader(page: Page): Promise<Locator> {
  const reader = page.locator('[data-full-annotation-reader="true"]');
  await expect(reader).toBeVisible();
  const hierarchy = await reader.evaluate((element) => {
    const metadata = element.querySelector<HTMLElement>('.full-annotation-reader__metadata');
    const metadataBar = element.querySelector<HTMLElement>('.full-annotation-reader__metadata-bar');
    const body = element.querySelector<HTMLElement>('.full-annotation-reader__body p');
    const bodyContainer = element.querySelector<HTMLElement>('.full-annotation-reader__body');
    const back = element.querySelector<HTMLElement>('.full-annotation-reader__back');
    if (!metadata || !metadataBar || !body || !bodyContainer || !back) {
      throw new Error('Full annotation reader hierarchy is incomplete.');
    }
    const readerStyle = getComputedStyle(element);
    const barStyle = getComputedStyle(metadataBar);
    const metadataStyle = getComputedStyle(metadata);
    const bodyStyle = getComputedStyle(bodyContainer);
    const paragraphStyle = getComputedStyle(body);
    const backBounds = back.getBoundingClientRect();
    const backStyle = getComputedStyle(back);
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      gap: Number.parseFloat(getComputedStyle(element).gap),
      metadataSize: Number.parseFloat(getComputedStyle(metadata).fontSize),
      bodySize: Number.parseFloat(getComputedStyle(body).fontSize),
      display: readerStyle.display,
      direction: readerStyle.flexDirection,
      readerLineHeight: readerStyle.lineHeight,
      barGap: barStyle.gap,
      barPaddingBottom: barStyle.paddingBottom,
      barBorderBottomWidth: barStyle.borderBottomWidth,
      metadataGap: metadataStyle.gap,
      metadataLineHeight: metadataStyle.lineHeight,
      bodyDisplay: bodyStyle.display,
      bodyOverflowY: bodyStyle.overflowY,
      paragraphLineHeight: paragraphStyle.lineHeight,
      paragraphWhiteSpace: paragraphStyle.whiteSpace,
      backSize: { width: backBounds.width, height: backBounds.height },
      backRadius: backStyle.borderRadius,
      backColor: backStyle.color,
    };
  });
  expect(hierarchy.scrollWidth).toBeLessThanOrEqual(hierarchy.clientWidth + 1);
  expect(hierarchy.gap).toBeLessThanOrEqual(18);
  expect(hierarchy.bodySize).toBeGreaterThan(hierarchy.metadataSize);
  expect(hierarchy.display).toBe('flex');
  expect(hierarchy.direction).toBe('column');
  expect(Number.parseFloat(hierarchy.readerLineHeight)).toBeCloseTo(20.8, 3);
  expect(hierarchy.barGap).toBe('7px');
  expect(hierarchy.barPaddingBottom).toBe('12px');
  expect(hierarchy.barBorderBottomWidth).toBe('0px');
  expect(hierarchy.metadataGap).toBe('7px');
  expect(Number.parseFloat(hierarchy.metadataLineHeight)).toBeCloseTo(19.2, 3);
  expect(hierarchy.bodyDisplay).toBe('block');
  expect(hierarchy.bodyOverflowY).toBe('auto');
  expect(Number.parseFloat(hierarchy.paragraphLineHeight)).toBeCloseTo(20.8, 3);
  expect(hierarchy.paragraphWhiteSpace).toBe('pre-wrap');
  expect(hierarchy.backSize).toEqual({ width: 32, height: 32 });
  expect(hierarchy.backRadius).toBe('10px');
  expect(hierarchy.backColor).toBe('rgb(51, 51, 51)');
  await expect(reader).not.toContainText('Full annotation —');

  const metadataBarBox = await reader.locator('.full-annotation-reader__metadata-bar').boundingBox();
  const metadataBox = await reader.locator('.full-annotation-reader__metadata').boundingBox();
  const backBox = await reader.locator('[data-full-annotation-action="back"]').boundingBox();
  const edit = reader.locator('[data-full-annotation-action="edit"]');
  const editBox = await edit.count() === 0 ? null : await edit.boundingBox();
  if (!metadataBarBox || !metadataBox || !backBox) {
    throw new Error('Reader metadata actions are unavailable.');
  }
  expect(backBox.x).toBeGreaterThanOrEqual(metadataBarBox.x);
  expect(backBox.x + backBox.width).toBeLessThanOrEqual(metadataBox.x + 0.5);
  if (editBox !== null) {
    expect(editBox.x).toBeGreaterThanOrEqual(metadataBox.x + metadataBox.width);
    expect(editBox.x + editBox.width).toBeLessThanOrEqual(
      metadataBarBox.x + metadataBarBox.width + 0.5,
    );
  }
  return reader;
}

async function expectCompoundReferenceTabs(
  page: Page,
  orientation: 'horizontal' | 'vertical',
): Promise<void> {
  const tablist = page.getByRole('tablist', { name: 'Open references' });
  await expect(tablist).toHaveAttribute('aria-orientation', orientation);
  await expect(tablist.getByRole('tab')).toHaveCount(3);
  const activeSegment = tablist.locator(
    '.reference-tab-segment:has(> [role="tab"][aria-selected="true"])',
  );
  await expect(activeSegment).toHaveCount(1);
  await activeSegment.hover();
  await expect(tablist.getByRole('button', { name: 'Open in main document' })).toBeVisible();
  await expect(tablist.getByRole('button', { name: 'Close active reference' })).toBeVisible();
  const actionGaps = await tablist.locator(
    '.reference-tab-segment:has(> [role="tab"][aria-selected="true"])',
  ).evaluate((segment) => {
    const selector = segment.querySelector('[role="tab"]');
    const actions = [...segment.querySelectorAll<HTMLElement>('.reference-tab-segment__action')];
    if (!selector || actions.length !== 2) throw new Error('Reference tab actions are incomplete.');
    const selectorBounds = selector.getBoundingClientRect();
    const firstBounds = actions[0]!.getBoundingClientRect();
    const secondBounds = actions[1]!.getBoundingClientRect();
    return {
      group: getComputedStyle(segment).columnGap,
      selectorToAction: firstBounds.left - selectorBounds.right,
      actionToAction: secondBounds.left - firstBounds.right,
    };
  });
  expect(actionGaps.group).toBe('0px');
  expect(actionGaps.selectorToAction).toBeCloseTo(0, 1);
  expect(actionGaps.actionToAction).toBeCloseTo(0, 1);
  await expect(page.locator('.reference-panel__actions')).toHaveCount(0);
}

async function clickHoverRevealedReferenceDockAction(action: Locator): Promise<void> {
  await action.evaluate(async (element) => {
    await Promise.all((element.closest('aside')?.getAnimations() ?? [])
      .map((animation) => animation.finished.catch(() => undefined)));
  });
  await action.locator('..').hover();
  await expect(action).toHaveCSS('opacity', '1');
  await expect(action).toHaveCSS('pointer-events', 'auto');
  await action.click();
}

async function openOutlineScene(
  page: Page,
  viewport = { width: 1280, height: 900 },
): Promise<Locator> {
  const product = await openScene(page, 'outline', viewport);
  const workspace = page.locator('#review-tools-workspace');
  if (viewport.width <= 760 && await page.locator('#review-workspace').getAttribute('data-workspace-open') !== 'true') {
    await page.getByRole('button', { name: 'Show workspace' }).click();
  }
  const outlineTab = page.getByRole('tab', { name: 'Outline', exact: true });
  if (await outlineTab.getAttribute('aria-selected') !== 'true') await outlineTab.click();
  await expect(outlineTab).toHaveAttribute('aria-selected', 'true');
  await expect(workspace).toBeVisible();
  return product;
}

async function expectOutlineTreeGeometry(
  page: Page,
  expectedControlSize: number,
): Promise<void> {
  const navigator = page.getByRole('navigation', { name: 'Document outline' });
  const visibleRows = navigator.locator('.outline-navigator__row:visible');
  await expect(visibleRows).toHaveCount(6);
  expect(await navigator.locator('.outline-navigator__title:visible').evaluateAll((titles) => (
    titles.every((title) => getComputedStyle(title).fontWeight === '400')
  ))).toBe(true);

  const rowSpacing = await visibleRows.evaluateAll((rows) => rows.map((row, index) => {
    const bounds = row.getBoundingClientRect();
    let depth = 0;
    let ancestor = row.parentElement;
    while (ancestor) {
      if (ancestor.classList.contains('outline-navigator__children')) depth += 1;
      ancestor = ancestor.parentElement;
    }
    if (index === 0) return { depth, gapAbove: null };
    const previousBounds = rows[index - 1]!.getBoundingClientRect();
    return { depth, gapAbove: bounds.top - previousBounds.bottom };
  }));
  for (let index = 1; index < rowSpacing.length; index += 1) {
    const spacing = rowSpacing[index]!;
    expect(spacing.gapAbove).toBeGreaterThanOrEqual(4);
  }

  const deepestVisibleLevel = await visibleRows.evaluateAll((rows) => Math.max(...rows.map((row) => {
    let depth = 0;
    let ancestor = row.parentElement;
    while (ancestor) {
      if (ancestor.classList.contains('outline-navigator__children')) depth += 1;
      ancestor = ancestor.parentElement;
    }
    return depth;
  })));
  expect(deepestVisibleLevel).toBeGreaterThanOrEqual(3);

  const longItem = navigator.locator('[data-outline-item="outline-long-nested"]');
  const longTitle = longItem.locator('.outline-navigator__title').first();
  const longPage = longItem.locator('.outline-navigator__page').first();
  const titleGeometry = await longTitle.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    };
  });
  expect(titleGeometry.scrollWidth).toBeLessThanOrEqual(titleGeometry.clientWidth + 1);
  expect(titleGeometry).toMatchObject({
    overflow: 'visible',
    textOverflow: 'clip',
    whiteSpace: 'normal',
  });
  await expect(longPage).toBeVisible();
  await expect(longPage).toHaveText('18');

  const visibleBranches = navigator.locator('.outline-navigator__children:visible');
  expect(await visibleBranches.count()).toBeGreaterThanOrEqual(3);
  for (const branch of await visibleBranches.all()) {
    await expect.poll(() => branch.evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.borderLeftStyle}:${style.borderLeftWidth}`;
    })).toBe('none:0px');
  }
  const peerDisclosure = page.getByRole('button', { name: 'Collapse Robustness appendix' });
  const peerChildrenId = await peerDisclosure.getAttribute('aria-controls');
  expect(peerChildrenId).toBeTruthy();
  await peerDisclosure.click();
  await expect(page.locator(`#${peerChildrenId}`)).toBeHidden();

  const disclosureWidth = await navigator.locator('.outline-navigator__disclosure:visible').first()
    .evaluate((element) => element.getBoundingClientRect().width);
  const visibleActions = navigator.locator([
    '.row-action-group__direct:visible button',
    '.row-action-group__secondary:visible > button',
  ].join(', '));
  const actionWidths = await visibleActions.evaluateAll((actions) => actions.map(
    (action) => action.getBoundingClientRect().width,
  ));
  expect(disclosureWidth).toBe(expectedControlSize);
  expect(actionWidths.length).toBeGreaterThan(0);
  expect(actionWidths.every((width) => width === 31 || width === 44)).toBe(true);
  const visibleDirectGroups = navigator.locator('.row-action-group__direct:visible');
  if (await visibleDirectGroups.count() > 0) {
    expect(await visibleDirectGroups.evaluateAll((groups) => groups.map(
      (group) => getComputedStyle(group).gap,
    ))).toEqual(expect.arrayContaining(['2px']));
  }
  const disclosureRhythm = await navigator.locator(
    '.outline-navigator__row:has(.outline-navigator__disclosure)',
  ).first().evaluate((row) => {
    const disclosure = row.querySelector('.outline-navigator__disclosure');
    const title = row.querySelector('.outline-navigator__title');
    if (!disclosure || !title) throw new Error('Outline disclosure rhythm is incomplete.');
    const rowBounds = row.getBoundingClientRect();
    const disclosureBounds = disclosure.getBoundingClientRect();
    const titleBounds = title.getBoundingClientRect();
    const disclosureCenter = disclosureBounds.left + disclosureBounds.width / 2;
    return {
      left: disclosureCenter - rowBounds.left,
      right: titleBounds.left - disclosureCenter,
    };
  });
  expect(Math.abs(disclosureRhythm.left - disclosureRhythm.right))
    .toBeLessThanOrEqual(1);

  const overflow = await navigator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    rows: [...element.querySelectorAll<HTMLElement>('.outline-navigator__row')]
      .filter((row) => row.offsetParent !== null)
      .map((row) => ({ clientWidth: row.clientWidth, scrollWidth: row.scrollWidth })),
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  for (const row of overflow.rows) expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);

  const containedActions = await navigator.locator([
    '.row-action-group__direct:visible button',
    '.row-action-group__secondary:visible > button',
  ].join(', ')).evaluateAll((actions) => (
    actions.every((action) => {
      const actionRect = action.getBoundingClientRect();
      const rowRect = action.closest('.outline-navigator__row')?.getBoundingClientRect();
      return rowRect !== undefined
        && actionRect.left >= rowRect.left - 0.5
        && actionRect.right <= rowRect.right + 0.5;
    })
  ));
  expect(containedActions).toBe(true);
}

test('wide contextual review', async ({ page }) => {
  const product = await openScene(page, 'contextual');
  await page.getByRole('button', { name: 'Highlight', exact: true }).hover();
  await page.getByRole('button', { name: 'Delete' }).focus();
  await expectScene(product, 'wide-contextual.png');
});

test('wide reading', async ({ page }) => {
  const product = await openScene(page, 'reading');
  await expect(page.getByRole('button', { name: 'Copy link to current PDF location' })
    .locator('.lucide-link')).toBeVisible();
  await expectScene(product, 'wide-reading.png');
});

test('narrow responsive top-bar menu', async ({ page }) => {
  await openScene(page, 'reading', { width: 390, height: 720 });
  const chrome = page.locator('[data-review-chrome]');
  await expect(chrome).toHaveCSS('height', '50px');
  await expect(chrome).toHaveAttribute('data-review-chrome-presentation', 'expanded');
  await page.getByRole('button', {
    name: 'Page 4 of 128. Open page navigation',
  }).click();
  await expect(page.getByRole('menu', { name: 'Page navigation' })).toBeVisible();
  await expect(page).toHaveScreenshot('narrow-responsive-top-bar-menu.png', {
    animations: 'disabled',
    maxDiffPixels: 100,
    threshold: 0.05,
  });
});

test('unavailable viewer controls', async ({ page }) => {
  const product = await openScene(page, 'unavailable-controls');
  await expect(page.getByRole('button', { name: 'Previous page' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Page navigation unavailable' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Zoom out' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open zoom controls' })).toBeDisabled();
  await expect(page.getByLabel('Current page unavailable')).toHaveText('—');
  await expect(page.getByLabel('Zoom unavailable')).toHaveText('—');
  await expectScene(product, 'unavailable-viewer-controls.png');
});

test('installed real PDF reading', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(installedLaunchUrl);
  const product = page.locator('[data-production-review]');
  await expect(product).toBeVisible();
  const image = page.locator("[data-page-index='0']").first().locator(':scope > img');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (
    element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
  ))).toBe(true);
  const identityBox = await page.locator(
    '[data-review-chrome] > .review-chrome__identity .review-chrome__save-identity',
  ).boundingBox();
  const copyLinkBox = await page.locator(
    '[data-review-chrome] > .review-chrome__viewer-controls [data-review-copy-link]',
  ).boundingBox();
  const viewerControlsBox = await page.locator(
    '[data-review-chrome] > .review-chrome__viewer-controls',
  ).boundingBox();
  if (!identityBox || !copyLinkBox || !viewerControlsBox) {
    throw new Error('Document chrome geometry is unavailable.');
  }
  expect(viewerControlsBox.x).toBeGreaterThanOrEqual(identityBox.x + identityBox.width);
  expect(copyLinkBox.x).toBeGreaterThan(viewerControlsBox.x);
  expect(copyLinkBox.x + copyLinkBox.width).toBeLessThanOrEqual(
    viewerControlsBox.x + viewerControlsBox.width + 0.5,
  );
  await page.evaluate(async () => { await document.fonts.ready; });
  await expectScene(product, 'installed-real-pdf.png');
});

test('wide Annotation Tray', async ({ page }) => {
  const product = await openScene(page, 'tray');
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-workspace-presentation', 'right');
  const railBox = await page.getByRole('button', { name: 'Hide workspace' }).boundingBox();
  const modesBox = await page.getByRole('tablist', { name: 'Workspace modes' }).boundingBox();
  const headerBox = await page.locator('.review-workspace__header').boundingBox();
  const stripBox = await page.locator('.review-workspace__activity-strip').boundingBox();
  if (!railBox || !modesBox || !headerBox || !stripBox) {
    throw new Error('Workspace navigation geometry is unavailable.');
  }
  expect(Math.abs(
    railBox.y + railBox.height / 2 - (modesBox.y + modesBox.height / 2),
  )).toBeLessThanOrEqual(8);
  expect(stripBox.x).toBeGreaterThanOrEqual(headerBox.x);
  expect(stripBox.y).toBeGreaterThanOrEqual(headerBox.y);
  expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 0.5);
  expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height + 0.5);
  const row = page.locator('[data-review-item="owned-highlight"]');
  const more = row.getByRole('button', { name: /Read full Highlight annotation on page 1/u });
  const fittingOwned = page.locator('[data-review-item="owned-replace"]');
  const fittingImported = page.locator('[data-existing-annotation="source-highlight-short"]');
  const overflowingImported = page.locator('[data-existing-annotation="source-highlight-long"]');
  await expect(more).toBeVisible();
  await expect(page.locator('#review-tools-workspace')).toHaveCSS(
    'background-color',
    'rgb(240, 240, 240)',
  );
  expect(await row.evaluate((element) => getComputedStyle(element, '::before').content))
    .toBe('none');
  await expect(fittingOwned.locator('[data-read-full-annotation="true"]')).toBeHidden();
  await expect(fittingImported.locator('[data-read-full-annotation="true"]')).toBeHidden();
  await expect(overflowingImported.locator('[data-read-full-annotation="true"]')).toBeVisible();
  await expectAnnotationTrayOverflow(page);
  await expectAnnotationEndcapGeometry(row, more);
  await expectAnnotationTitleEndcapGeometry(row);
  await expect(page.getByRole('button', { name: /Copy link to Highlight annotation on page 1/u })
    .locator('.lucide-link')).toBeVisible();
  await expect(row.locator('.annotation-item__page')).toHaveText('1');
  await expect(row.locator('.annotation-item__separator')).toHaveCount(0);
  await expect(row.locator('.annotation-item__section')).toHaveCount(0);
  await expectScene(product, 'wide-annotation-tray.png');

  await more.focus();
  await expect(more).toBeFocused();
  await expect.poll(() => more.evaluate((element) => getComputedStyle(element).outlineWidth))
    .toBe('2px');
  await expectScene(product, 'wide-annotation-more-focus.png');

  await more.evaluate((element) => element.blur());
  await more.hover();
  await expect.poll(() => more.evaluate((element) => getComputedStyle(element).cursor))
    .toBe('pointer');
  await expectScene(product, 'wide-annotation-more-hover.png');

  const fittingNavigation = fittingOwned.locator('.annotation-item__navigation');
  await fittingNavigation.click();
  await expect(fittingOwned).toHaveAttribute('data-active', 'true');
  await page.mouse.move(500, 500);
  await page.locator('.review-chrome button').first().focus();
  await expect(fittingOwned.locator('[data-row-action="edit"]')).toBeVisible();
  await expect.poll(() => fittingOwned.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe('rgb(255, 255, 255)');

  await more.click();
  const reader = await expectCompactAnnotationReader(page);
  await expect(reader).toHaveAttribute('data-annotation-origin', 'owned');
  await expect(page.locator('[data-full-annotation-action="edit"]')).toBeVisible();
  await expect(reader).toContainText('complete reviewer-authored argument');
  await expect(reader).not.toContainText('identifying variation is local to the comparison group');
  await expectScene(product, 'wide-full-annotation-reader-owned.png');
});

test('focused reattachment hierarchy', async ({ page }) => {
  const wide = await openFocusedReattachment(page, { width: 1280, height: 900 });
  await expectFocusedReattachmentGeometry(wide);
  await expectScene(wide, 'wide-focused-reattachment.png');

  const narrow = await openFocusedReattachment(page, { width: 320, height: 900 });
  await expectFocusedReattachmentGeometry(narrow);
  await expectScene(narrow, 'narrow-focused-reattachment.png');
});

test('task-first generated Annotation Tray and blocked document menu', async ({ page }) => {
  const product = await openScene(page, 'tray&reconciliation=mixed');
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-tools-workspace-open', 'true');
  const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
  if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();

  const headings = page.locator('#workspace-panel-annotations h2');
  await expect(headings).toHaveText(['Needs attention']);
  const resolved = page.locator('[data-review-item="00000000-0000-4000-8000-000000000208"]');
  await resolved.locator('.annotation-item__navigation').focus();
  await expect(resolved.locator('.row-action-group__direct')).toHaveCSS('opacity', '1');
  await expectScene(product, 'wide-generated-annotation-tray.png');

  await page.getByRole('button', { name: /Open document actions$/u }).click();
  const menu = page.getByRole('menu', { name: /Actions for/u });
  await expect(menu).toHaveAttribute('data-export-eligibility', 'blocked');
  await expect(menu.getByRole('menuitem', { name: 'Export', exact: true }))
    .toHaveAttribute('aria-disabled', 'true');
  const openAnnotations = menu.getByRole('menuitem', { name: 'Open Annotations' });
  await expect(openAnnotations).toBeVisible();
  await expect(openAnnotations.locator('.review-icon')).toBeVisible();
  await expectScene(product, 'wide-generated-document-actions.png');
});

test('height-constrained generated Annotation Tray stays contained', async ({ page }) => {
  const viewport = { width: 320, height: 560 };
  const product = await openScene(page, 'tray&reconciliation=mixed', viewport);
  await expect(page.locator('#review-workspace')).toHaveAttribute('data-workspace-open', 'true');
  const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
  if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();
  const panel = page.locator('#workspace-panel-annotations');
  const geometry = await panel.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      left: bounds.left,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1);
  expect(geometry.bottom).toBeLessThanOrEqual(viewport.height + 1);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  await expect(page.locator('[data-annotation-scroll-viewport]')).toHaveCSS('overflow-y', 'auto');
  await expectScene(product, 'height-constrained-generated-annotation-tray.png');
});

test('coarse-pointer generated Annotation Tray keeps contextual controls visible', async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 720 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  const page = await context.newPage();
  try {
    const product = await openScene(page, 'tray&reconciliation=mixed', { width: 390, height: 720 });
    await expect(page.locator('#review-workspace')).toHaveAttribute('data-workspace-open', 'true');
    const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
    if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const action = page.locator('[data-review-item="00000000-0000-4000-8000-000000000208"]')
      .locator('[data-row-action]').first();
    await expect(action).toHaveCSS('opacity', '1');
    const bounds = await action.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    await expectScene(product, 'coarse-generated-annotation-tray.png');
  } finally {
    await context.close();
  }
});

test('narrow Annotation Tray', async ({ page }) => {
  const product = await openScene(page, 'tray', { width: 320, height: 720 });
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-workspace-presentation', 'bottom');
  await expect(page.locator('#review-workspace')).toHaveAttribute('data-workspace-open', 'true');
  const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
  if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(page.locator('[data-annotation-scroll-viewport]')).toHaveCSS(
    'background-color',
    'rgb(240, 240, 240)',
  );
  const row = page.locator('[data-review-item="owned-highlight"]');
  const annotation = row.getByRole('button', { name: /Highlight · Page 1/u });
  await annotation.focus();
  await expect(row.locator('.annotation-item__section')).toHaveCount(0);
  await expect(row.locator('.annotation-item__separator')).toHaveCount(0);
  await expectAnnotationTrayOverflow(page, { verticallyScrollable: true });
  const imported = page.locator('[data-existing-annotation="source-highlight-long"]');
  const more = imported.getByRole('button', {
    name: /Read full Highlight annotation on page 8/u,
  });
  await imported.scrollIntoViewIfNeeded();
  await expect(more).toBeVisible();
  await expectAnnotationEndcapGeometry(imported, more);
  const endcapTarget = await more.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      width: bounds.width,
      height: bounds.height,
    };
  });
  expect(endcapTarget.width).toBeGreaterThanOrEqual(44);
  expect(endcapTarget.height).toBeGreaterThanOrEqual(28);
  await expectScene(product, 'narrow-annotation-tray.png');

  const scrollViewport = page.locator('[data-annotation-scroll-viewport]');
  const scrollBefore = await scrollViewport.evaluate((element) => element.scrollTop);
  expect(scrollBefore).toBeGreaterThan(0);
  await more.click();
  const reader = await expectCompactAnnotationReader(page);
  await expect.poll(() => scrollViewport.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(reader).toHaveAttribute('data-annotation-origin', 'source');
  await expect(reader).toContainText('Read only');
  await expect(reader).toContainText('reported robustness checks isolate the same comparison group');
  await expect(page.locator('[data-full-annotation-action="edit"]')).toHaveCount(0);
  await expectScene(product, 'narrow-full-annotation-reader-imported.png');

  await page.locator('[data-full-annotation-action="back"]').click();
  await expect(page.locator('#workspace-panel-annotations')).toBeFocused();
  await expect.poll(() => scrollViewport.evaluate((element) => element.scrollTop)).toBe(scrollBefore);
});

test('wide Outline tree', async ({ page }) => {
  const product = await openOutlineScene(page);
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-workspace-presentation', 'right');
  const outlineToggleGeometry = await page.getByRole('button', {
    name: 'Collapse all outline entries',
  }).evaluate((button) => {
    const header = button.closest<HTMLElement>('.review-workspace__header');
    const modeStrip = header?.querySelector<HTMLElement>('.review-workspace__activity-strip');
    const searchTab = modeStrip?.querySelector<HTMLElement>('#workspace-mode-search');
    if (!searchTab || !header || !modeStrip) {
      throw new Error('Outline workspace navbar geometry is incomplete.');
    }
    const buttonBounds = button.getBoundingClientRect();
    const icon = button.querySelector<SVGElement>('.review-icon');
    if (!icon) throw new Error('Outline expansion icon is missing.');
    const iconBounds = icon.getBoundingClientRect();
    const tabBounds = searchTab.getBoundingClientRect();
    const headerBounds = header.getBoundingClientRect();
    return {
      usesReferenceMoveClasses:
        button.classList.contains('review-workspace__move')
        && button.classList.contains('review-workspace__move--activity')
        && button.classList.contains('review-workspace__move--header-action'),
      isDirectHeaderAction: button.parentElement === header,
      width: buttonBounds.width,
      height: buttonBounds.height,
      tabWidth: tabBounds.width,
      tabHeight: tabBounds.height,
      centerDelta: Math.abs(
        (buttonBounds.top + buttonBounds.height / 2) - (tabBounds.top + tabBounds.height / 2),
      ),
      iconCenterXOffset:
        (iconBounds.left + iconBounds.width / 2) - (buttonBounds.left + buttonBounds.width / 2),
      iconCenterYOffset:
        (iconBounds.top + iconBounds.height / 2) - (buttonBounds.top + buttonBounds.height / 2),
      rightInset: headerBounds.right - buttonBounds.right,
    };
  });
  expect(outlineToggleGeometry.usesReferenceMoveClasses).toBe(true);
  expect(outlineToggleGeometry.isDirectHeaderAction).toBe(true);
  expect(outlineToggleGeometry.width).toBeCloseTo(outlineToggleGeometry.tabWidth, 1);
  expect(outlineToggleGeometry.height).toBeCloseTo(outlineToggleGeometry.tabHeight, 1);
  expect(outlineToggleGeometry.centerDelta).toBeLessThanOrEqual(1);
  expect(outlineToggleGeometry.iconCenterXOffset).toBeCloseTo(0.5, 1);
  expect(outlineToggleGeometry.iconCenterYOffset).toBeCloseTo(1, 1);
  expect(outlineToggleGeometry.rightInset).toBeCloseTo(12, 1);
  await expectOutlineTreeGeometry(page, 28);
  await page.getByRole('button', {
    name: 'Conditional comparison estimates, Page 24',
    exact: true,
  }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', {
    name: 'Copy exact destination link for Conditional comparison estimates, Page 24',
  }).locator('.lucide-link')).toBeVisible();
  await expect(page.locator('[data-outline-item="outline-long-nested"] > .outline-navigator__row'))
    .toHaveAttribute('data-current', 'true');
  await expectScene(product, 'wide-outline-tree.png');
});

test('Outline pointer and keyboard states match the canonical tree', async ({ page }) => {
  await openOutlineScene(page);
  const navigator = page.getByRole('navigation', { name: 'Document outline' });
  const inactiveRow = navigator.locator(
    '.outline-navigator__row:not([data-current="true"]):has(.outline-navigator__destination:not(:disabled))',
  ).first();
  const inactiveDestination = inactiveRow.locator('.outline-navigator__destination');
  const currentRow = page.locator(
    '[data-outline-item="outline-long-nested"] > .outline-navigator__row',
  );
  const currentDestination = currentRow.locator('.outline-navigator__destination');
  const currentBackground = await currentRow.evaluate(
    (row) => getComputedStyle(row).backgroundColor,
  );
  const currentShadowAtRest = await currentRow.evaluate(
    (row) => getComputedStyle(row).boxShadow,
  );
  const currentDestinationBounds = await currentDestination.boundingBox();
  expect(currentDestinationBounds).not.toBeNull();
  await page.mouse.move(
    currentDestinationBounds!.x + currentDestinationBounds!.width / 2,
    currentDestinationBounds!.y + currentDestinationBounds!.height / 2,
  );
  await page.mouse.down();
  await expect(currentRow).toHaveCSS('background-color', currentBackground);
  const currentShadowWhilePressed = await currentRow.evaluate(
    (row) => getComputedStyle(row).boxShadow,
  );
  expect(currentShadowWhilePressed).toBe(currentShadowAtRest);
  await expect(currentRow).toHaveCSS('outline-style', 'none');
  await page.mouse.up();
  await expect(currentRow).toHaveCSS('box-shadow', currentShadowAtRest);

  await inactiveDestination.hover();
  await expect(inactiveRow).toHaveCSS('background-color', 'rgb(231, 231, 231)');
  await expect(inactiveRow).toHaveCSS('outline-style', 'none');

  await page.keyboard.press('Tab');
  await inactiveDestination.focus();
  await expect(inactiveDestination).toBeFocused();
  await expect(inactiveDestination).toHaveCSS('outline-width', '2px');
  await expect(inactiveDestination).toHaveCSS('outline-color', 'rgb(73, 103, 137)');
  await expect(inactiveDestination).toHaveCSS('outline-offset', '3px');
  await expect(inactiveRow).toHaveCSS('outline-style', 'none');

  const copyAction = currentRow.locator('.copy-link-control__trigger--row');
  await currentRow.hover();
  await copyAction.hover();
  await expect(copyAction).toHaveCSS('background-color', 'rgb(231, 231, 231)');
  await expect(copyAction).toHaveCSS('border-top-width', '0px');
  await page.keyboard.press('Tab');
  await copyAction.focus();
  await expect(copyAction).toBeFocused();
  await page.mouse.move(1, 1);
  await expect(copyAction).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(copyAction).toHaveCSS('outline-width', '2px');
  await expect(copyAction).toHaveCSS('outline-color', 'rgb(73, 103, 137)');
  await expect(copyAction).toHaveCSS('outline-offset', '3px');
  await expect(currentRow).toHaveCSS('outline-style', 'none');
});

test('narrow Outline tree', async ({ page }) => {
  const product = await openOutlineScene(page, { width: 320, height: 720 });
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-workspace-presentation', 'bottom');
  const coarsePointer = await page.evaluate(() => (
    window.matchMedia('(hover: none), (pointer: coarse)').matches
  ));
  await expectOutlineTreeGeometry(page, coarsePointer ? 44 : 28);
  await page.getByRole('button', {
    name: 'Conditional comparison estimates, Page 24',
    exact: true,
  }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('[data-outline-item="outline-long-nested"] > .outline-navigator__row'))
    .toHaveAttribute('data-current', 'true');
  await expectScene(product, 'narrow-outline-tree.png');
});

test('wide bottom References tray', async ({ page }) => {
  const product = await openScene(page, 'reference-layout');
  await page.getByRole('button', { name: 'Show References' }).click();
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-reference-layout', 'wide-bottom');
  await expectCompoundReferenceTabs(page, 'vertical');
  await expectScene(product, 'wide-bottom-references.png');
});

test('wide coordinated References and tools trays', async ({ page }) => {
  const product = await openScene(page, 'reference-layout');
  await page.getByRole('button', { name: 'Show References' }).click();
  await page.getByRole('button', { name: 'Show workspace' }).click();
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-reference-layout', 'wide-split');
  await expect(page.locator('#review-tools-workspace')).toBeVisible();
  await expectCompoundReferenceTabs(page, 'vertical');
  await expectScene(product, 'wide-split-reference-tools.png');
});

test('wide right-docked References tray', async ({ page }) => {
  const product = await openScene(page, 'reference-layout');
  await page.getByRole('button', { name: 'Show References' }).click();
  const moveReferences = page.getByRole('button', { name: 'Move References to right' });
  await clickHoverRevealedReferenceDockAction(moveReferences);
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-reference-layout', 'wide-right');
  await expect(page.getByRole('tab', { name: 'References', exact: true })).toBeVisible();
  await expectCompoundReferenceTabs(page, 'horizontal');
  await expectScene(product, 'wide-right-references.png');
});

test('reference-layout workspace mode buttons remain interactive', async ({ page }) => {
  await openScene(page, 'reference-layout');
  await page.getByRole('button', { name: 'Show References' }).click();
  const moveReferencesRight = page.getByRole('button', { name: 'Move References to right' });
  await clickHoverRevealedReferenceDockAction(moveReferencesRight);
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-reference-layout', 'wide-right');

  const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
  await annotations.click();
  await expect(annotations).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Move References to bottom' })).toHaveCount(0);

  const references = page.getByRole('tab', { name: 'References', exact: true });
  await references.click();
  await expect(references).toHaveAttribute('aria-selected', 'true');
  const moveReferences = page.getByRole('button', { name: 'Move References to bottom' });
  await expect(moveReferences).toBeVisible();
  expect(await moveReferences.evaluate((button) => (
    button.parentElement?.classList.contains('review-workspace__activity-strip--compound') === true
      && button.previousElementSibling?.getAttribute('role') === 'tablist'
      && !button.previousElementSibling.contains(button)
  ))).toBe(true);
});

test('reference-layout reference tab selectors remain interactive', async ({ page }) => {
  await openScene(page, 'reference-layout');
  await page.getByRole('button', { name: 'Show References' }).click();

  const equation = page.getByRole('tab', {
    name: 'Equation (14): Equilibrium response mapping, Page 27',
  });
  const lemma = page.getByRole('tab', {
    name: 'Lemma 2: Local identification under conditional independence, Page 18',
  });
  await expect(equation.locator('span')).toHaveCSS('font-weight', '400');
  await expect(equation.locator('small')).toHaveCSS('font-weight', '400');
  await expect(lemma.locator('span')).toHaveCSS('font-weight', '400');
  await expect(lemma.locator('small')).toHaveCSS('font-weight', '400');
  await equation.click();
  await expect(equation).toHaveAttribute('aria-selected', 'true');
  await lemma.click();
  await expect(lemma).toHaveAttribute('aria-selected', 'true');
});

test('narrow unified References tray', async ({ page }) => {
  const product = await openScene(page, 'reference-layout', { width: 760, height: 900 });
  await page.getByRole('button', { name: 'Show workspace' }).click();
  await page.getByRole('tab', { name: 'References', exact: true }).click();
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-reference-layout', 'narrow-unified');
  await expect(page.getByRole('tab', { name: 'References', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: /^Move References to /u })).toHaveCount(0);
  await expectCompoundReferenceTabs(page, 'horizontal');
  await expectScene(product, 'narrow-unified-references.png');
});

for (const scene of [
  {
    name: 'wide bottom Reference row return action',
    snapshot: 'wide-bottom-reference-return.png',
    viewport: { width: 1280, height: 900 },
    prepare: async (page: Page) => {
      await page.getByRole('button', { name: 'Show References' }).click();
      await expect(page.locator('[data-review-stage]'))
        .toHaveAttribute('data-reference-layout', 'wide-bottom');
    },
  },
  {
    name: 'wide right Reference row return action',
    snapshot: 'wide-right-reference-return.png',
    viewport: { width: 1280, height: 900 },
    prepare: async (page: Page) => {
      await page.getByRole('button', { name: 'Show References' }).click();
      const moveReferences = page.getByRole('button', { name: 'Move References to right' });
      await clickHoverRevealedReferenceDockAction(moveReferences);
      await expect(page.locator('[data-review-stage]'))
        .toHaveAttribute('data-reference-layout', 'wide-right');
    },
  },
  {
    name: 'narrow Reference row return action',
    snapshot: 'narrow-reference-return.png',
    viewport: { width: 760, height: 900 },
    prepare: async (page: Page) => {
      await page.getByRole('button', { name: 'Show workspace' }).click();
      await page.getByRole('tab', { name: 'References', exact: true }).click();
      await expect(page.locator('[data-review-stage]'))
        .toHaveAttribute('data-reference-layout', 'narrow-unified');
    },
  },
] as const) {
  test(scene.name, async ({ page }) => {
    const product = await openScene(
      page,
      'reference-layout&referenceReturn=visible',
      scene.viewport,
    );
    await scene.prepare(page);
    const returnControl = page.getByRole('button', { name: 'Return to reference' });
    await returnControl.locator('..').hover();
    await expect(returnControl).toBeVisible();
    await returnControl.scrollIntoViewIfNeeded();
    const clearance = await returnControl.evaluate((control) => {
      const viewport = control.closest<HTMLElement>('.reference-tab-segment');
      if (!viewport) throw new Error('Reference tab row is unavailable.');
      const controlBounds = control.getBoundingClientRect();
      const viewportBounds = viewport.getBoundingClientRect();
      return {
        insideLeft: controlBounds.left >= viewportBounds.left,
        insideTop: controlBounds.top >= viewportBounds.top,
        clearOfScrollbar: controlBounds.right <= viewportBounds.right,
        topmost: document.elementFromPoint(
          controlBounds.left + controlBounds.width / 2,
          controlBounds.top + controlBounds.height / 2,
        )?.closest('[data-reference-return]') === control,
      };
    });
    expect(clearance).toEqual({
      insideLeft: true,
      insideTop: true,
      clearOfScrollbar: true,
      topmost: true,
    });
    await expectScene(product, scene.snapshot);
  });
}

test('failed Reference return preserves focus on its retryable icon control', async ({ page }) => {
  await openScene(page, 'reference-layout&referenceReturn=visible');
  await page.getByRole('button', { name: 'Show References' }).click();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const returnControl = page.getByRole('button', { name: 'Return to reference' });
  await returnControl.focus();
  await returnControl.press('Enter');
  await expect(returnControl).toHaveAttribute('aria-disabled', 'true');
  await expect(returnControl).not.toHaveAttribute('aria-disabled', 'true');
  await expect(returnControl).toBeFocused();
});

test('annotation peek', async ({ page }) => {
  const product = await openScene(page, 'peek');
  await page.locator('[data-owned-focus-id="owned-highlight"]').focus();
  await expect(page.locator('[data-annotation-peek]')).toBeVisible();
  await expectScene(product, 'annotation-peek.png');
});

test('Page Note composer', async ({ page }) => {
  const product = await openScene(page, 'page-note');
  await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
  await page.getByRole('textbox', { name: 'Comment' }).fill('Add the identifying assumption and a cross-reference to Appendix Table A.12.');
  await expectScene(product, 'page-note-composer.png');
});

for (const composer of [
  { name: 'replacement', title: 'Replacement', primary: 'Apply' },
  { name: 'insertion', title: 'Insertion', primary: 'Apply' },
  { name: 'highlight', title: 'Highlight Comment', primary: 'Save', keep: true },
  { name: 'page-note', title: 'Page Note', primary: 'Save' },
  { name: 'edit-highlight', title: 'Edit Highlight', primary: 'Apply' },
  { name: 'edit-page-note', title: 'Edit Page Note', primary: 'Apply' },
  { name: 'edit-replacement', title: 'Edit Replacement', primary: 'Apply' },
  { name: 'edit-insertion', title: 'Edit Insertion', primary: 'Apply' },
] as const) {
  test(`${composer.title} uses the contextual composer contract`, async ({ page }) => {
    await openScene(page, `reading&composer=${composer.name}`);
    const surface = page.getByRole('region', { name: composer.title });
    await expect(surface).toBeVisible();
    await expect(surface).not.toHaveAttribute('aria-modal');
    await expect(surface.locator('[data-source-context]')).toHaveCount(0);
    await expect(surface.getByRole('button', { name: 'Read Document' })).toHaveCount(0);
    await expect(surface.locator('.comment-composer__anchor')).toHaveCount(0);
    await expect(surface.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(surface.getByRole('button', { name: composer.primary, exact: true })).toBeVisible();
    await expect(surface.getByRole('button', { name: 'Keep', exact: true }))
      .toHaveCount(composer.keep === true ? 1 : 0);
  });
}

test('wide replacement composer stays passage-adjacent without reframing the PDF', async ({ page }) => {
  const product = await openScene(page, 'contextual');
  const document = page.locator('.review-document');
  const documentBefore = await document.boundingBox();
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  const composer = page.getByRole('region', { name: 'Replacement' });
  await composer.getByRole('textbox', { name: 'Replacement' }).fill('a locally unique equilibrium');
  const [stageBounds, composerBounds, documentAfter] = await Promise.all([
    page.locator('[data-review-stage]').boundingBox(),
    composer.boundingBox(),
    document.boundingBox(),
  ]);
  expect(stageBounds).not.toBeNull();
  expect(composerBounds).not.toBeNull();
  expect(documentBefore).not.toBeNull();
  expect(documentAfter).toEqual(documentBefore);
  await expect(composer).toHaveAttribute('data-composer-placement', 'side');
  expect(composerBounds!.x).toBeGreaterThanOrEqual(stageBounds!.x + 240);
  expect(composerBounds!.x + composerBounds!.width)
    .toBeLessThanOrEqual(stageBounds!.x + stageBounds!.width);
  expect(composerBounds!.y).toBeGreaterThanOrEqual(stageBounds!.y);
  expect(composerBounds!.y + composerBounds!.height)
    .toBeLessThanOrEqual(stageBounds!.y + stageBounds!.height);
  await expect(page.locator('[data-visual-document]')).toBeVisible();
  await expectScene(product, 'wide-contextual-replacement-composer.png');
});

test('wide tray takeover preserves PDF geometry behind the editor', async ({ page }) => {
  const product = await openScene(page, 'tray');
  const document = page.locator('.review-document');
  const documentBefore = await document.boundingBox();
  const row = page.locator('[data-review-item="owned-highlight"]');
  await row.hover();
  await row.getByRole('button', { name: 'Edit Highlight annotation on page 1' }).click();
  const composer = page.getByRole('region', { name: 'Edit Highlight' });
  await expect(composer).toBeVisible();
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('inert', '');
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute(
    'data-authoring-takeover',
    'true',
  );
  expect(await document.boundingBox()).toEqual(documentBefore);
  await expectScene(product, 'wide-contextual-tray-takeover.png');
});

test('narrow composer uses one contained bottom surface with compact actions', async ({ page }) => {
  const viewport = { width: 520, height: 720 };
  const product = await openScene(page, 'contextual', viewport);
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  const composer = page.getByRole('region', { name: 'Replacement' });
  const geometry = await composer.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      top: bounds.top,
      left: bounds.left,
      right: bounds.right,
      bottom: bounds.bottom,
      actionHeights: [...element.querySelectorAll<HTMLButtonElement>(
        '.comment-composer__actions button',
      )].map((button) => button.getBoundingClientRect().height),
    };
  });
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(viewport.width);
  expect(geometry.bottom).toBeLessThanOrEqual(viewport.height);
  expect(geometry.actionHeights.every((height) => Math.abs(height - 30) <= 0.5)).toBe(true);
  await expectScene(product, 'narrow-contextual-composer.png');
});

test('the out-of-view anchor uses one icon return action in the composer header', async ({ page }) => {
  const product = await openScene(page, 'reading&composer=replacement&context=long&return=outside');
  const composer = page.getByRole('region', { name: 'Replacement' });
  const before = await composer.boundingBox();
  const anchor = composer.getByRole('button', { name: 'Back to passage' });
  await expect(anchor).toBeVisible();
  await expect(anchor.locator('span')).toHaveCount(0);
  await expect(composer.locator('.comment-composer__header > .comment-composer__anchor'))
    .toHaveCount(1);
  const inputBox = await composer.getByRole('textbox').boundingBox();
  const actionsBox = await composer.locator('.comment-composer__actions').boundingBox();
  expect(inputBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(actionsBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height);
  expect(await composer.boundingBox()).toEqual(before);
  await expectScene(product, 'wide-contextual-long-source.png');

  const measureAnchorLayout = async () => composer.evaluate((element) => {
    const header = element.querySelector<HTMLElement>('.comment-composer__header');
    const body = element.querySelector<HTMLElement>('.comment-composer__body');
    const returnControl = element.querySelector<HTMLElement>('.comment-composer__anchor');
    const cancel = element.querySelector<HTMLElement>('.comment-composer__actions button');
    if (!header || !body || !cancel) throw new Error('Composer geometry is incomplete.');
    return {
      header: header.getBoundingClientRect().toJSON(),
      body: body.getBoundingClientRect().toJSON(),
      anchor: returnControl?.getBoundingClientRect().toJSON() ?? null,
      cancel: cancel.getBoundingClientRect().toJSON(),
    };
  });
  const wideOutside = await measureAnchorLayout();
  await openScene(page, 'reading&composer=replacement&context=long&return=visible');
  const wideVisible = await measureAnchorLayout();
  expect(wideOutside.anchor).not.toBeNull();
  expect(wideOutside.anchor!.width).toBe(wideOutside.anchor!.height);
  expect(wideOutside.anchor!.height).toBe(32);
  expect(wideVisible.anchor).toBeNull();
  expect(wideOutside.cancel.height).toBe(30);
  expect(wideOutside.header.height).toBeCloseTo(wideVisible.header.height, 0);
  expect(wideOutside.body.y).toBeCloseTo(wideVisible.body.y, 0);

  const mediumViewport = { width: 840, height: 720 };
  await openScene(
    page,
    'reading&composer=replacement&context=long&return=outside',
    mediumViewport,
  );
  await expect(page.locator('[data-review-stage]')).toHaveAttribute(
    'data-annotation-presentation',
    'bottom',
  );
  const mediumOutside = await measureAnchorLayout();
  await openScene(
    page,
    'reading&composer=replacement&context=long&return=visible',
    mediumViewport,
  );
  const mediumVisible = await measureAnchorLayout();
  expect(mediumOutside.anchor).not.toBeNull();
  expect(mediumOutside.anchor!.width).toBe(mediumOutside.anchor!.height);
  expect(mediumOutside.anchor!.height).toBe(32);
  expect(mediumVisible.anchor).toBeNull();
  expect(mediumOutside.cancel.height).toBe(30);
  expect(mediumOutside.header.height).toBeCloseTo(mediumVisible.header.height, 0);
  expect(mediumOutside.body.y).toBeCloseTo(mediumVisible.body.y, 0);

  const narrowViewport = { width: 520, height: 720 };
  await openScene(
    page,
    'reading&composer=replacement&context=long&return=outside',
    narrowViewport,
  );
  const narrowOutside = await measureAnchorLayout();
  await openScene(
    page,
    'reading&composer=replacement&context=long&return=visible',
    narrowViewport,
  );
  const narrowVisible = await measureAnchorLayout();
  expect(narrowOutside.anchor).not.toBeNull();
  expect(narrowOutside.anchor!.width).toBe(narrowOutside.anchor!.height);
  expect(narrowOutside.anchor!.height).toBe(32);
  expect(narrowVisible.anchor).toBeNull();
  expect(narrowOutside.cancel.height).toBe(30);
  expect(narrowOutside.header.height).toBeCloseTo(narrowVisible.header.height, 0);
  expect(narrowOutside.body.y).toBeCloseTo(narrowVisible.body.y, 0);
});

test('no anchor control is shown when its location is unavailable', async ({ page }) => {
  const product = await openScene(page, 'reading&composer=insertion&context=unavailable&return=unavailable');
  const composer = page.getByRole('region', { name: 'Insertion' });
  await expect(composer.locator('.comment-composer__anchor')).toHaveCount(0);
  await expect(composer.locator('[data-source-context]')).toHaveCount(0);
  await expectScene(product, 'wide-contextual-unavailable-anchor.png');
});

test('Save Destination owns the modal layer above a preserved composer', async ({ page }) => {
  const product = await openScene(page, 'save-destination&composer=replacement&return=outside');
  const destination = page.getByRole('dialog', { name: 'Choose Where to Save Annotations' });
  const previewHost = page.locator('[data-composer-preview-host]');
  await expect(destination).toBeVisible();
  await expect(previewHost).toHaveAttribute('inert', '');
  await expect(previewHost).toHaveAttribute('aria-hidden', 'true');
  const layers = await page.locator('[data-production-review]').evaluate((root) => {
    const dialog = root.querySelector<HTMLElement>('.save-destination-backdrop');
    const composer = root.querySelector<HTMLElement>('[data-composer-preview-host]');
    if (!dialog || !composer) throw new Error('Composer and Save Destination layers are required.');
    return {
      dialog: Number.parseInt(getComputedStyle(dialog).zIndex, 10),
      composer: Number.parseInt(getComputedStyle(composer).zIndex, 10),
    };
  });
  expect(layers.dialog).toBeGreaterThan(layers.composer);
  await expectScene(product, 'save-destination-over-composer.png');
});

test('pending Return motion respects reduced-motion preference', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openScene(page, 'reading&composer=replacement&return=pending');
  const pending = page.getByRole('button', { name: 'Returning to passage' });
  await expect(pending).toBeDisabled();
  await expect(pending.locator('.lucide-loader-circle')).toHaveCSS('animation-name', 'none');
});

test('Save Destination modal', async ({ page }) => {
  const product = await openScene(page, 'save-destination');
  const dialog = page.getByRole('dialog', { name: 'Choose Where to Save Annotations' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeVisible();
  await expectScene(product, 'save-destination-modal.png');
});

test('Save Destination recovery modal', async ({ page }) => {
  const product = await openScene(page, 'save-recovery');
  const dialog = page.getByRole('dialog', { name: 'Choose Where to Save Annotations' });
  await expect(dialog.getByText('This PDF isn’t up to date')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Locate PDF…' })).toBeVisible();
  await expectScene(product, 'save-destination-recovery-modal.png');
});

test('Save Destination establishing motion respects user preference', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openScene(page, 'save-destination&establishing=1');
  const spinner = page.getByRole('dialog', { name: 'Choose Where to Save Annotations' })
    .locator('.lucide-loader-circle');
  await expect(spinner).toBeVisible();
  await expect(spinner).toHaveCSS('animation-name', 'none');
});

for (const scene of [
  { name: 'page-note', surfaceName: 'Page Note', role: 'region', openComposer: true, viewport: { width: 320, height: 720 } },
  { name: 'save-recovery', surfaceName: 'Choose Where to Save Annotations', role: 'dialog', openComposer: false, viewport: { width: 320, height: 320 } },
] as const) {
  test(`narrow ${scene.surfaceName} surface remains contained with compact actions`, async ({ page }) => {
    await openScene(page, scene.name, scene.viewport);
    if (scene.openComposer) await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
    const surface = page.getByRole(scene.role, { name: scene.surfaceName });
    await expect(surface).toBeVisible();
    const geometry = await surface.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const buttons = [...element.querySelectorAll<HTMLButtonElement>('button')];
      const body = element.querySelector<HTMLElement>('.compact-editorial-modal__body');
      const active = document.activeElement;
      const bodyBounds = body?.getBoundingClientRect();
      const activeBounds = active instanceof HTMLElement ? active.getBoundingClientRect() : undefined;
      return {
        top: bounds.top,
        left: bounds.left,
        right: bounds.right,
        bottom: bounds.bottom,
        buttonHeights: buttons.map((button) => button.getBoundingClientRect().height),
        activeIsVisible: body !== null
          && active instanceof HTMLElement
          && body.contains(active)
          && bodyBounds !== undefined
          && activeBounds !== undefined
          && activeBounds.top >= bodyBounds.top
          && activeBounds.bottom <= bodyBounds.bottom,
      };
    });
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(scene.viewport.width);
    expect(geometry.bottom).toBeLessThanOrEqual(scene.viewport.height);
    expect(geometry.buttonHeights.length).toBeGreaterThan(0);
    expect(Math.min(...geometry.buttonHeights)).toBeGreaterThanOrEqual(scene.openComposer ? 30 : 32);
    expect(geometry.activeIsVisible).toBe(true);
  });
}

for (const state of ['loading', 'empty', 'error'] as const) {
  test(`exceptional annotation ${state}`, async ({ page }) => {
    const product = await openScene(page, `exceptional&exception=${state}`);
    await expectScene(product, `exceptional-annotation-${state}.png`);
  });
}
