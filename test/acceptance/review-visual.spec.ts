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
  });
}

async function expectCompoundReferenceTabs(
  page: Page,
  orientation: 'horizontal' | 'vertical',
): Promise<void> {
  const tablist = page.getByRole('tablist', { name: 'Open references' });
  await expect(tablist).toHaveAttribute('aria-orientation', orientation);
  await expect(tablist.getByRole('tab')).toHaveCount(3);
  await expect(tablist.locator(
    '.reference-tab-segment:has(> [role="tab"][aria-selected="true"])',
  )).toHaveCount(1);
  await expect(tablist.getByRole('button', { name: 'Send to main document' })).toBeVisible();
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
  expect(actionGaps.group).toBe('2px');
  expect(actionGaps.selectorToAction).toBeCloseTo(2, 1);
  expect(actionGaps.actionToAction).toBeCloseTo(2, 1);
  await expect(page.locator('.reference-panel__actions')).toHaveCount(0);
}

async function openOutlineScene(
  page: Page,
  viewport = { width: 1280, height: 900 },
): Promise<Locator> {
  const product = await openScene(page, 'outline', viewport);
  const workspace = page.locator('#review-tools-workspace');
  if (viewport.width <= 760) {
    const rail = page.getByRole('button', { name: /^(?:Open|Close) References tray$/u });
    if (await rail.getAttribute('aria-expanded') !== 'true') await rail.click();
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
  expect(titleGeometry.scrollWidth).toBeGreaterThan(titleGeometry.clientWidth);
  expect(titleGeometry).toMatchObject({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
  await expect(longPage).toBeVisible();
  await expect(longPage).toHaveText('18');

  const visibleGuides = navigator.locator('.outline-navigator__children:visible');
  expect(await visibleGuides.count()).toBeGreaterThanOrEqual(3);
  for (const guide of await visibleGuides.all()) {
    await expect.poll(() => guide.evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.borderLeftStyle}:${style.borderLeftWidth}`;
    })).toBe('solid:1px');
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

test('unavailable viewer controls', async ({ page }) => {
  const product = await openScene(page, 'unavailable-controls');
  await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
  await expect(page.getByLabel('Current page')).toHaveText('— / —');
  await expect(page.getByLabel('Zoom level')).toHaveText('—%');
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
  const identityBox = await page.locator('.review-chrome__save-identity').boundingBox();
  const copyLinkBox = await page.locator('[data-review-copy-link]').boundingBox();
  const viewerControlsBox = await page.locator('.review-chrome__viewer-controls').boundingBox();
  if (!identityBox || !copyLinkBox || !viewerControlsBox) {
    throw new Error('Document chrome geometry is unavailable.');
  }
  expect(copyLinkBox.x).toBeGreaterThanOrEqual(identityBox.x + identityBox.width);
  expect(copyLinkBox.x - (identityBox.x + identityBox.width)).toBeLessThanOrEqual(2.5);
  expect(copyLinkBox.x + copyLinkBox.width).toBeLessThan(viewerControlsBox.x);
  await page.evaluate(async () => { await document.fonts.ready; });
  await expectScene(product, 'installed-real-pdf.png');
});

test('wide Annotation Tray', async ({ page }) => {
  const product = await openScene(page, 'tray');
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-workspace-presentation', 'right');
  const railBox = await page.getByRole('button', { name: 'Close right workspace' }).boundingBox();
  const modesBox = await page.getByRole('tablist', { name: 'Workspace modes' }).boundingBox();
  if (!railBox || !modesBox) throw new Error('Workspace navigation geometry is unavailable.');
  expect(Math.abs(
    railBox.y + railBox.height / 2 - (modesBox.y + modesBox.height / 2),
  )).toBeLessThanOrEqual(0.5);
  const annotation = page.getByRole('button', { name: /Highlight · Page 1/u });
  await annotation.focus();
  await expect(page.getByRole('button', { name: /Copy link to Highlight annotation on page 1/u })
    .locator('.lucide-link')).toBeVisible();
  await expect(annotation.locator('.annotation-item__page')).toHaveText('1');
  await expect(annotation.locator('.annotation-item__separator')).toHaveCount(2);
  await expect(annotation.locator('.annotation-item__section')).toHaveAttribute(
    'title',
    'Identification strategy and conditional comparison groups',
  );
  await expectScene(product, 'wide-annotation-tray.png');
});

test('narrow Annotation Tray', async ({ page }) => {
  const product = await openScene(page, 'tray', { width: 320, height: 720 });
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-workspace-presentation', 'bottom');
  const rail = page.getByRole('button', { name: /^(?:Open|Close) References tray$/u });
  if (await rail.getAttribute('aria-expanded') !== 'true') await rail.click();
  const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
  if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const annotation = page.getByRole('button', { name: /Highlight · Page 1/u });
  await annotation.focus();
  const section = annotation.locator('.annotation-item__section');
  const sectionGeometry = await section.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    };
  });
  expect(sectionGeometry.clientWidth).toBeLessThanOrEqual(128);
  expect(sectionGeometry.scrollWidth).toBeGreaterThan(sectionGeometry.clientWidth);
  expect(sectionGeometry).toMatchObject({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
  await expectScene(product, 'narrow-annotation-tray.png');
});

test('wide Outline tree', async ({ page }) => {
  const product = await openOutlineScene(page);
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-workspace-presentation', 'right');
  await expectOutlineTreeGeometry(page, 31);
  await page.getByRole('button', {
    name: 'Conditional comparison estimates, Page 24',
    exact: true,
  }).focus();
  await expect(page.getByRole('button', {
    name: 'Copy exact destination link for Conditional comparison estimates, Page 24',
  }).locator('.lucide-link')).toBeVisible();
  await expect(page.locator('[data-outline-item="outline-long-nested"] > .outline-navigator__row'))
    .toHaveAttribute('data-current', 'true');
  await expectScene(product, 'wide-outline-tree.png');
});

test('Outline current location remains distinct while pressed', async ({ page }) => {
  await openOutlineScene(page);
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
  expect(currentShadowWhilePressed).not.toBe(currentShadowAtRest);
  expect(currentShadowWhilePressed).toContain('inset');
  await page.mouse.up();
  await expect(currentRow).toHaveCSS('box-shadow', currentShadowAtRest);
});

test('narrow Outline tree', async ({ page }) => {
  const product = await openOutlineScene(page, { width: 320, height: 720 });
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-workspace-presentation', 'bottom');
  const coarsePointer = await page.evaluate(() => (
    window.matchMedia('(hover: none), (pointer: coarse)').matches
  ));
  await expectOutlineTreeGeometry(page, coarsePointer ? 44 : 31);
  await page.getByRole('button', {
    name: 'Conditional comparison estimates, Page 24',
    exact: true,
  }).focus();
  await expect(page.locator('[data-outline-item="outline-long-nested"] > .outline-navigator__row'))
    .toHaveAttribute('data-current', 'true');
  await expectScene(product, 'narrow-outline-tree.png');
});

test('wide bottom References tray', async ({ page }) => {
  const product = await openScene(page, 'reference-layout');
  await page.getByRole('button', { name: 'Open References tray' }).click();
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-reference-layout', 'wide-bottom');
  await expectCompoundReferenceTabs(page, 'vertical');
  await expectScene(product, 'wide-bottom-references.png');
});

test('wide coordinated References and tools trays', async ({ page }) => {
  const product = await openScene(page, 'reference-layout');
  await page.getByRole('button', { name: 'Open References tray' }).click();
  await page.getByRole('button', { name: 'Open right workspace' }).click();
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-reference-layout', 'wide-split');
  await expect(page.locator('#review-tools-workspace')).toBeVisible();
  await expectCompoundReferenceTabs(page, 'vertical');
  await expectScene(product, 'wide-split-reference-tools.png');
});

test('wide right-docked References tray', async ({ page }) => {
  const product = await openScene(page, 'reference-layout');
  await page.getByRole('button', { name: 'Open References tray' }).click();
  await page.getByRole('button', { name: 'Move References to right' }).click();
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-reference-layout', 'wide-right');
  await expect(page.getByRole('tab', { name: 'References', exact: true })).toBeVisible();
  await expectCompoundReferenceTabs(page, 'horizontal');
  await expectScene(product, 'wide-right-references.png');
});

test('reference-layout workspace mode buttons remain interactive', async ({ page }) => {
  await openScene(page, 'reference-layout');
  await page.getByRole('button', { name: 'Open References tray' }).click();
  await page.getByRole('button', { name: 'Move References to right' }).click();

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
  await page.getByRole('button', { name: 'Open References tray' }).click();

  const equation = page.getByRole('tab', {
    name: 'Equation (14): Equilibrium response mapping, Page 27',
  });
  await equation.click();
  await expect(equation).toHaveAttribute('aria-selected', 'true');

  const lemma = page.getByRole('tab', {
    name: 'Lemma 2: Local identification under conditional independence, Page 18',
  });
  await lemma.click();
  await expect(lemma).toHaveAttribute('aria-selected', 'true');
});

test('narrow unified References tray', async ({ page }) => {
  const product = await openScene(page, 'reference-layout', { width: 760, height: 900 });
  await page.getByRole('button', { name: 'Open References tray' }).click();
  await page.getByRole('tab', { name: 'References', exact: true }).click();
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-reference-layout', 'narrow-unified');
  await expect(page.getByRole('tab', { name: 'References', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: /^Move References to /u })).toHaveCount(0);
  await expectCompoundReferenceTabs(page, 'horizontal');
  await expectScene(product, 'narrow-unified-references.png');
});

for (const scene of [
  {
    name: 'wide bottom Reference return chip',
    snapshot: 'wide-bottom-reference-return.png',
    viewport: { width: 1280, height: 900 },
    prepare: async (page: Page) => {
      await page.getByRole('button', { name: 'Open References tray' }).click();
      await expect(page.locator('[data-review-stage]'))
        .toHaveAttribute('data-reference-layout', 'wide-bottom');
    },
  },
  {
    name: 'wide right Reference return chip',
    snapshot: 'wide-right-reference-return.png',
    viewport: { width: 1280, height: 900 },
    prepare: async (page: Page) => {
      await page.getByRole('button', { name: 'Open References tray' }).click();
      await page.getByRole('button', { name: 'Move References to right' }).click();
      await expect(page.locator('[data-review-stage]'))
        .toHaveAttribute('data-reference-layout', 'wide-right');
    },
  },
  {
    name: 'narrow Reference return chip',
    snapshot: 'narrow-reference-return.png',
    viewport: { width: 760, height: 900 },
    prepare: async (page: Page) => {
      await page.getByRole('button', { name: 'Open References tray' }).click();
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
    await expect(returnControl).toBeVisible();
    await returnControl.scrollIntoViewIfNeeded();
    const clearance = await returnControl.evaluate((control) => {
      const viewport = document.querySelector<HTMLElement>('[data-reference-viewport-host]');
      if (!viewport) throw new Error('Reference viewport host is unavailable.');
      const controlBounds = control.getBoundingClientRect();
      const viewportBounds = viewport.getBoundingClientRect();
      return {
        insideLeft: controlBounds.left >= viewportBounds.left,
        insideTop: controlBounds.top >= viewportBounds.top,
        clearOfScrollbar: controlBounds.right < viewportBounds.right - 8,
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
  await page.getByRole('button', { name: 'Open References tray' }).click();
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

for (const state of ['loading', 'empty', 'error'] as const) {
  test(`exceptional annotation ${state}`, async ({ page }) => {
    const product = await openScene(page, `exceptional&exception=${state}`);
    await expectScene(product, `exceptional-annotation-${state}.png`);
  });
}
