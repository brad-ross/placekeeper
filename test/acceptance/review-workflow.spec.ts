import { expect, test, type Locator, type Page } from '@playwright/test';

async function clickHoverRevealedReferenceDockAction(action: Locator) {
  await action.locator('..').hover();
  await expect(action).toHaveCSS('opacity', '1');
  await expect(action).toHaveCSS('pointer-events', 'auto');
  await action.click();
}

async function openAnnotationsWorkspace(page: Page) {
  const stage = page.locator('[data-review-stage]');
  const expectedPresentation = (page.viewportSize()?.width ?? 1280) < 900 ? 'bottom' : 'right';
  await expect(stage).toHaveAttribute('data-workspace-presentation', expectedPresentation);
  const workspace = expectedPresentation === 'right'
    ? page.locator('#review-tools-workspace')
    : page.locator('#review-workspace');
  const openAttribute = expectedPresentation === 'right'
    ? 'data-tools-workspace-open'
    : 'data-workspace-open';
  if (await workspace.getAttribute(openAttribute) !== 'true') {
    await page.getByRole('button', { name: 'Show workspace' }).click();
  }
  await expect(workspace).toHaveAttribute(openAttribute, 'true');
  await expect(workspace).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
  await expect(annotations).toBeVisible();
  if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();
  await expect(annotations).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(page.locator('#workspace-panel-outline')).toBeHidden();
  await expect(page.locator('#workspace-panel-references')).toBeHidden();
  return { annotations, workspace };
}

async function closeWorkspace(page: Page) {
  const expectedPresentation = (page.viewportSize()?.width ?? 1280) < 900 ? 'bottom' : 'right';
  await expect(page.locator('[data-review-stage]')).toHaveAttribute(
    'data-workspace-presentation',
    expectedPresentation,
  );
  const surface = expectedPresentation === 'right'
    ? page.locator('#review-tools-workspace')
    : page.locator('#review-workspace');
  const openAttribute = expectedPresentation === 'right'
    ? 'data-tools-workspace-open'
    : 'data-workspace-open';
  if (await surface.getAttribute(openAttribute) === 'true') {
    await page.getByRole('button', {
      name: expectedPresentation === 'right' ? 'Hide workspace' : 'Hide workspace',
    }).click();
  }
  await expect(surface).toHaveAttribute(openAttribute, 'false');
  const rail = page.getByRole('button', {
    name: 'Show workspace',
  });
  await expect(rail).toHaveAttribute('aria-expanded', 'false');
  return rail;
}

async function currentWorkspaceRail(page: Page) {
  const expectedPresentation = (page.viewportSize()?.width ?? 1280) < 900 ? 'bottom' : 'right';
  await expect(page.locator('[data-review-stage]')).toHaveAttribute(
    'data-workspace-presentation',
    expectedPresentation,
  );
  return expectedPresentation === 'right'
    ? page.getByRole('button', { name: 'Show workspace' })
    : page.getByRole('button', { name: 'Show workspace' });
}

function outlineDisclosure(page: Page, itemId: string) {
  return page.locator(
    `[data-outline-item="${itemId}"] > .outline-navigator__row > .outline-navigator__disclosure`,
  );
}

async function installMainScrollport(page: Page, scrollbarWidth = 0) {
  await page.locator('.review-document').evaluate((host, width) => {
    const viewport = document.createElement('div');
    viewport.dataset.viewerFramingViewport = '';
    viewport.dataset.testMainScrollport = '';
    Object.assign(viewport.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'scroll',
      opacity: '0',
      pointerEvents: 'none',
    });
    const content = document.createElement('div');
    Object.assign(content.style, { width: '2000px', height: '1200px' });
    viewport.append(content);
    if (width > 0) {
      Object.defineProperties(viewport, {
        offsetWidth: { configurable: true, value: 200 },
        clientWidth: { configurable: true, value: 200 - width },
      });
    }
    host.append(viewport);
    viewport.scrollLeft = 41;
    viewport.scrollTop = 137;
    viewport.dispatchEvent(new Event('scroll'));
  }, scrollbarWidth);
  return page.locator('[data-test-main-scrollport]');
}

async function installRuntimeClassicScrollport(page: Page, scrollbarWidth = 20) {
  await page.addStyleTag({ content: `
    [data-test-runtime-scrollport] {
      scrollbar-gutter: stable;
      scrollbar-width: auto;
    }
    [data-test-runtime-scrollport]::-webkit-scrollbar {
      width: var(--test-scrollbar-size, ${scrollbarWidth}px);
      height: var(--test-scrollbar-size, ${scrollbarWidth}px);
    }
  ` });
  await page.locator('.review-document').evaluate((host) => {
    const viewport = document.createElement('div');
    viewport.dataset.viewerFramingViewport = '';
    viewport.dataset.testRuntimeScrollport = '';
    Object.assign(viewport.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'scroll',
      opacity: '0',
      pointerEvents: 'none',
    });
    const content = document.createElement('div');
    Object.assign(content.style, { width: '2000px', height: '1200px' });
    viewport.append(content);
    host.append(viewport);
    viewport.scrollLeft = 41;
    viewport.scrollTop = 137;
    viewport.dispatchEvent(new Event('scroll'));
  });
  return page.locator('[data-test-runtime-scrollport]');
}

test.describe('canonical review workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html');
    await expect(page.getByRole('button', { name: 'Proofread mode' })).toHaveCount(0);
  });

  test('discloses mounted annotation actions at intent without activating their row', async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.getByRole('button', { name: 'Seed annotations' }).click();
    await openAnnotationsWorkspace(page);

    const candidate = page.locator(
      '[data-review-item][data-active="false"]:has([data-row-action="edit"])',
    ).first();
    const itemId = await candidate.getAttribute('data-review-item');
    if (itemId === null) throw new Error('No inactive editable annotation row is available.');
    const row = page.locator(`[data-review-item="${itemId}"]`);
    const navigation = row.locator('.annotation-item__navigation');
    const actions = row.locator('.row-action-group__direct');
    const edit = row.locator('[data-row-action="edit"]');
    const remove = row.locator('[data-row-action="delete"]');
    await expect(row).toBeVisible();
    await expect(edit).toHaveCount(1);
    await expect(remove).toHaveCount(1);
    await expect(actions).toHaveCSS('opacity', '0');

    await row.hover();
    await expect(actions).toHaveCSS('opacity', '1');
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS('opacity', '0');

    await navigation.focus();
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(edit).toBeFocused();
    await expect(actions).toHaveCSS('opacity', '1');

    await edit.click();
    await expect(row).toHaveAttribute('data-active', 'false');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(row).toHaveAttribute('data-active', 'false');

    await navigation.click();
    await expect(row).toHaveAttribute('data-active', 'true');
    await page.getByRole('application', { name: 'PDF review canvas' }).focus();
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(actions).toHaveCSS('opacity', '1');
  });

  test('keeps coarse-pointer annotation actions visible, touch-sized, and layout-stable', async ({ browser }) => {
    const context = await browser.newContext({
      hasTouch: true,
      viewport: { width: 390, height: 720 },
    });
    const touchPage = await context.newPage();
    try {
      await touchPage.goto('/test/acceptance/review-harness/index.html');
      await touchPage.locator('#root').evaluate((element) => {
        element.setAttribute('data-production-root', 'true');
      });
      await touchPage.getByRole('button', { name: 'Seed annotations' }).click();
      await openAnnotationsWorkspace(touchPage);
      expect(await touchPage.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

      const row = touchPage.locator(
        '[data-review-item]:has([data-row-action="edit"])',
      ).first();
      const edit = row.locator('[data-row-action="edit"]');
      const remove = row.locator('[data-row-action="delete"]');
      const scrollViewport = touchPage.locator('[data-annotation-scroll-viewport]');
      const before = await Promise.all([
        row.evaluate((element) => element.getBoundingClientRect().height),
        scrollViewport.evaluate((element) => element.scrollHeight),
      ]);
      await expect(edit).toHaveCSS('opacity', '1');
      for (const action of [edit, remove]) {
        const geometry = await action.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            boundsWidth: bounds.width,
            boundsHeight: bounds.height,
            computedWidth: style.width,
            computedHeight: style.height,
            minWidth: style.minWidth,
            maxWidth: style.maxWidth,
            touchSize: style.getPropertyValue('--review-control-touch'),
          };
        });
        expect(geometry).toMatchObject({
          computedWidth: '44px',
          computedHeight: '44px',
          minWidth: '44px',
          maxWidth: '44px',
          touchSize: '44px',
        });
        expect(geometry.boundsWidth).toBeGreaterThanOrEqual(44);
        expect(geometry.boundsHeight).toBeGreaterThanOrEqual(44);
      }

      await edit.focus();
      const after = await Promise.all([
        row.evaluate((element) => element.getBoundingClientRect().height),
        scrollViewport.evaluate((element) => element.scrollHeight),
      ]);
      expect(after).toEqual(before);
    } finally {
      await context.close();
    }
  });

  test('resolves previous annotations through focused, annotation-native detail views', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=1');
    const documentActionsTrigger = page.getByRole('button', { name: /Open document actions/u });
    await expect(documentActionsTrigger.locator('.review-icon')).toBeVisible();
    await documentActionsTrigger.click();
    const exportAction = page.getByRole('menuitem', { name: 'Export', exact: true });
    await expect(exportAction).toHaveAttribute('aria-disabled', 'true');
    const blockerDescription = await exportAction.getAttribute('aria-describedby');
    expect(blockerDescription).toMatch(/^document-export-reason-/u);
    await expect(page.locator(`#${blockerDescription}`)).toHaveText('2 annotations to resolve.');
    await expect(page.getByText('2 annotations to resolve.')).toBeVisible();
    const attention = page.locator('[data-document-actions-attention]');
    await expect(attention).toBeVisible();
    const openAnnotations = page.getByRole('menuitem', { name: 'Open Annotations' });
    await expect(openAnnotations).toBeVisible();
    await expect(openAnnotations.locator('.review-icon')).toBeVisible();
    await openAnnotations.click();
    await expect(page.getByRole('tab', { name: 'Annotations', exact: true }).locator('.review-icon'))
      .toBeVisible();

    const reconciliation = page.getByRole('region', { name: 'Needs attention' });
    await expect(reconciliation.getByRole('heading', {
      name: 'Needs attention',
    })).toBeVisible();
    await expect(reconciliation.locator('[data-reconciliation-entry]')).toHaveCount(2);
    await expect(reconciliation.getByRole('button', {
      name: 'Reattach previous Highlight annotation on page 1',
    })).toBeFocused();
    await expect(documentActionsTrigger).not.toBeFocused();
    await expect(reconciliation.locator('[data-reconciliation-action="reattach"]')).toHaveCount(0);
    await expect(reconciliation.getByRole('button', {
      name: 'Discard Delete annotation on page 2',
    })).toBeVisible();

    await reconciliation.getByRole('button', {
      name: 'Reattach previous Highlight annotation on page 1',
    }).click();
    const reattachDetail = page.locator('[data-reconciliation-detail="reattach"]');
    await expect(reattachDetail).toHaveAttribute(
      'aria-label',
      'Resolve previous Highlight annotation on page 1',
    );
    await expect(reattachDetail.getByRole('heading', { name: 'Reattach highlight' })).toBeVisible();
    await expect(reattachDetail.getByText('Your annotation')).toBeVisible();
    await expect(reattachDetail.getByText('Check the identifying variation.')).toBeVisible();
    await expect(reattachDetail.getByText('Multiple matches')).toHaveCount(1);
    await expect(reattachDetail.getByText('Previously attached to · Page 1')).toBeVisible();
    await expect(reattachDetail.getByText('the previous identification argument')).toBeVisible();
    await expect(reattachDetail.getByText('Select the intended text in the PDF, then confirm.')).toBeVisible();
    await expect(reattachDetail.locator('.full-annotation-reader__metadata')).toHaveCount(0);
    await expect(reattachDetail.locator('[data-reattachment-preview]')).toHaveCount(0);
    await expect(reattachDetail.locator('.reconciliation-workspace__editor')).toHaveCount(0);
    await reattachDetail.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('button', {
      name: 'Reattach previous Highlight annotation on page 1',
    })).toBeFocused();

    await reconciliation.getByRole('button', {
      name: 'Reattach previous Highlight annotation on page 1',
    }).click();
    await expect(page.getByRole('region', { name: 'Annotations', exact: true })).toHaveCount(0);
    await expect(reattachDetail.getByRole('button', { name: 'Confirm' })).toBeEnabled();

    await reattachDetail.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('[data-reconciliation-detail]')).toHaveCount(0);
    await expect(page.getByText('Reattachment saved.')).toHaveCount(0);
    await expect(page.locator('[data-reconciliation-entry]')).toHaveCount(1);
    await expect(page.getByRole('button', {
      name: 'Reattach previous Delete annotation on page 2',
    })).toBeFocused();
    await expect(page.getByRole('region', { name: 'Annotations', exact: true })).toContainText(
      'Check the identifying variation.',
    );

    const deleteAction = page.getByRole('button', {
      name: 'Discard Delete annotation on page 2',
    });
    const destructiveColor = await deleteAction.evaluate((element) => getComputedStyle(element).color);
    await deleteAction.click();
    const discardDetail = page.locator('[data-reconciliation-detail="discard"]');
    await expect(discardDetail).toHaveAttribute(
      'aria-label',
      'Resolve previous Delete annotation on page 2',
    );
    await expect(discardDetail.getByText('obsolete robustness sentence')).toBeVisible();
    await expect(discardDetail.getByText('Missing text')).toHaveCount(1);
    await expect(discardDetail.getByText('The original text is no longer present. Select its new location.')).toHaveCount(0);
    const discardButton = discardDetail.getByRole('button', { name: 'Discard', exact: true });
    await expect(discardButton).toHaveCSS('color', destructiveColor);
    await expect(discardButton.locator('.review-icon')).toHaveCSS('color', destructiveColor);
    await discardButton.click();

    await expect(page.locator('[data-reconciliation-entry]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Needs attention' })).toHaveCount(0);
    await expect(page.getByText('No previous annotations need attention.')).toHaveCount(0);
    await expect(page.getByText('Discard recorded.')).toHaveCount(0);
    await expect(page.locator('[data-workspace-focus-token="annotations:section"]')).toBeFocused();

    await documentActionsTrigger.click();
    await expect(exportAction).toHaveAttribute('aria-disabled', 'false');
    const eligibleMenu = page.getByRole('menu', { name: /Actions for/u });
    await expect(eligibleMenu.locator(':scope > *')).toHaveCount(1);
    await exportAction.click();
    await expect(page.locator('[data-export-count]')).toHaveAttribute('data-export-count', '1');
    await expect(page.getByText('Reviewed PDF exported.')).toBeVisible();
    await expect(exportAction).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(documentActionsTrigger).toBeFocused();
  });

  test('limits the document-title hover surface without moving toolbar groups', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=ready');
    await page.locator('#root').evaluate((element) => {
      element.setAttribute('data-production-root', 'true');
    });
    const trigger = page.getByRole('button', { name: /Open document actions/u });
    const documentActions = page.locator(
      '[data-review-chrome] > .review-chrome__identity .document-actions',
    );
    const geometry = await documentActions.evaluate((element) => {
      const triggerElement = element.querySelector<HTMLElement>('[data-document-actions-trigger]');
      if (triggerElement === null) throw new Error('Document actions trigger is unavailable.');
      return {
        slot: element.getBoundingClientRect().toJSON(),
        trigger: triggerElement.getBoundingClientRect().toJSON(),
      };
    });

    expect(geometry.trigger.x).toBeCloseTo(geometry.slot.x, 0);
    expect(geometry.trigger.width).toBeCloseTo(geometry.slot.width, 0);
    await trigger.hover();
    await expect(trigger).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.mouse.move(
      geometry.trigger.x + geometry.trigger.width + 8,
      geometry.trigger.y + geometry.trigger.height / 2,
    );
    await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  });

  test('routes a blocked export back to the active protected draft without discarding it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=ready');
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    const composer = page.getByRole('region', { name: 'Highlight Comment' });
    const editor = composer.getByRole('textbox', { name: 'Comment (optional)' });
    await editor.fill('Keep this protected draft exactly as written.');
    await expect(page.locator('[data-pending-drafts]')).toHaveAttribute('data-pending-drafts', '1');

    const documentActionsTrigger = page.getByRole('button', { name: /Open document actions/u });
    await documentActionsTrigger.click();
    await expect(page.getByRole('menuitem', { name: 'Export', exact: true }))
      .toHaveAttribute('aria-disabled', 'true');
    await page.getByRole('menuitem', { name: 'Open Annotations' }).click();

    await expect(composer).toBeVisible();
    await expect(editor).toHaveValue('Keep this protected draft exactly as written.');
    await expect(editor).toBeFocused();
    await expect(page.locator('[data-pending-drafts]')).toHaveAttribute('data-pending-drafts', '1');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('routes a pending draft without an active composer to its attention row', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=pending-draft');
    await page.getByRole('button', { name: /Open document actions/u }).click();
    await page.getByRole('menuitem', { name: 'Open Annotations' }).click();

    await expect(page.getByRole('button', {
      name: 'Reattach previous Highlight annotation on page 1',
    })).toBeFocused();
  });

  test('shows Page Note source context only when it identifies the prior location', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=page-notes');
    await openAnnotationsWorkspace(page);

    await page.getByRole('button', {
      name: 'Reattach previous Page Note annotation on page 3',
    }).click();
    const detail = page.locator('[data-reconciliation-detail="reattach"]');
    await expect(detail.getByRole('heading', { name: 'Reattach page note' })).toBeVisible();
    await expect(detail.getByText('Previously attached to · Page 3')).toBeVisible();
    await expect(detail.getByText('Original PDF text:')).toHaveCount(0);
    await expect(detail.getByText('Page 3', { exact: true })).toHaveCount(0);
    await detail.getByRole('button', { name: 'Back' }).click();

    await page.getByRole('button', {
      name: 'Reattach previous Page Note annotation on page 4',
    }).click();
    await expect(detail.getByText('Previously attached to · Page 4')).toBeVisible();
    await expect(detail.getByText('The appendix extends the comparison.')).toBeVisible();
  });

  test('keeps stale confirmation, pending export, and retry feedback inside document actions', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=stale');
    const trigger = page.getByRole('button', { name: /Open document actions/u });
    await trigger.click();
    let exportAction = page.getByRole('menuitem', { name: 'Export', exact: true });
    await exportAction.click();
    await expect(page.getByText('Export the last successful PDF?')).toBeVisible();
    const cancel = page.getByRole('menuitem', { name: 'Cancel' });
    await expect(cancel).toBeFocused();
    await cancel.click();
    await expect(exportAction).toBeFocused();
    await exportAction.click();
    await page.getByRole('menuitem', { name: 'Confirm export' }).click();
    await expect(page.locator('[data-export-count]')).toHaveAttribute('data-export-count', '1');
    await expect(page.getByText('Reviewed PDF exported.')).toBeVisible();

    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=ready&export=delayed');
    await page.getByRole('button', { name: /Open document actions/u }).click();
    exportAction = page.getByRole('menuitem', { name: 'Export', exact: true });
    await exportAction.evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    await expect(page.getByRole('menuitem', { name: 'Exporting…', exact: true })).toBeVisible();
    await expect(page.getByText('Exporting reviewed PDF…')).toHaveCount(0);
    await expect(page.locator('[data-export-count]')).toHaveAttribute('data-export-count', '1');
    await page.getByRole('button', { name: 'Finish harness export' }).evaluate(element => (element as HTMLButtonElement).click());
    await expect(page.getByText('Reviewed PDF exported.')).toBeVisible();
    await expect(exportAction).toBeFocused();

    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=ready&export=fail-once');
    await page.getByRole('button', { name: /Open document actions/u }).click();
    await page.getByRole('menuitem', { name: 'Export', exact: true }).click();
    const retry = page.getByRole('menuitem', { name: 'Retry export' });
    await expect(page.getByText('Export failed. Your review is still available; try again.')).toBeVisible();
    await expect(retry).toBeFocused();
    await retry.click();
    await expect(page.locator('[data-export-count]')).toHaveAttribute('data-export-count', '2');
    await expect(page.getByText('Reviewed PDF exported.')).toBeVisible();
  });

  test('routes host export requests through blocked, stale, pending, and retry states', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=1&host-export=1');
    let menu = page.getByRole('menu', { name: /Actions for/u });
    await expect(menu).toHaveAttribute('data-export-eligibility', 'blocked');
    await expect(menu.getByText('2 annotations to resolve.')).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Open Annotations' })).toBeFocused();
    await expect(page.locator('[data-export-count]')).toHaveAttribute('data-export-count', '0');

    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=stale&host-export=1');
    menu = page.getByRole('menu', { name: /Actions for/u });
    await expect(menu.getByText('Export the last successful PDF?')).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Cancel' })).toBeFocused();
    await expect(page.locator('[data-export-count]')).toHaveAttribute('data-export-count', '0');

    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=ready&export=fail-once&host-export=1');
    menu = page.getByRole('menu', { name: /Actions for/u });
    const retry = menu.getByRole('menuitem', { name: 'Retry export' });
    await expect(retry).toBeFocused();
    await expect(menu.getByText('Export failed. Your review is still available; try again.')).toBeVisible();
    await retry.click();
    await expect(page.locator('[data-export-count]')).toHaveAttribute('data-export-count', '2');
    await expect(menu.getByText('Reviewed PDF exported.')).toBeVisible();

    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=ready&export=delayed&host-export=1');
    menu = page.getByRole('menu', { name: /Actions for/u });
    await expect(menu.getByRole('menuitem', { name: 'Exporting…', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Request host export' }).evaluate((element) => {
      (element as HTMLButtonElement).click();
    });
    await expect(menu.getByText('Exporting reviewed PDF…')).toHaveCount(0);
    await expect(page.locator('[data-export-count]')).toHaveAttribute('data-export-count', '1');
    await page.getByRole('button', { name: 'Finish harness export' }).evaluate(element => (element as HTMLButtonElement).click());
    await expect(menu.getByText('Reviewed PDF exported.')).toBeVisible();
    await page.getByRole('button', { name: 'Remount review shell' }).click();
    await expect(page.locator('[data-export-count]')).toHaveAttribute('data-export-count', '1');
    await expect(page.getByRole('menu', { name: /Actions for/u })).toHaveCount(0);
  });

  test('preserves stale export confirmation through responsive reflow and clears it on close', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=stale');
    const trigger = page.getByRole('button', { name: /Open document actions/u });
    await trigger.click();
    await page.getByRole('menuitem', { name: 'Export', exact: true }).click();
    await expect(page.getByText('Export the last successful PDF?')).toBeVisible();

    await page.setViewportSize({ width: 320, height: 900 });
    await expect(page.getByRole('menu', { name: /Actions for/u })).toBeVisible();
    await expect(page.getByText('Export the last successful PDF?')).toBeVisible();

    await trigger.click();
    await expect(page.getByRole('menu', { name: /Actions for/u })).toHaveCount(0);
    await trigger.click();
    await expect(page.getByRole('menuitem', { name: 'Export', exact: true })).toBeVisible();
    await expect(page.getByText('Export the last successful PDF?')).toHaveCount(0);
  });

  test('presents reconciling and failed refresh export states from the document title', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=stale');
    const status = page.locator('[data-generation-status]');
    await expect(status).toContainText('Source changed; waiting for an updated PDF.');
    await expect(status.locator('.lucide-info')).toBeVisible();
    await expect(status.locator('.lucide-loader-circle')).toHaveCount(0);
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=ready&refresh=reconciling');
    const spinner = status.locator('.lucide-loader-circle');
    await expect(spinner).toHaveCSS('animation-name', 'review-loader-spin');
    const initialTransform = await spinner.evaluate((element) => getComputedStyle(element).transform);
    await expect.poll(() => spinner.evaluate((element) => getComputedStyle(element).transform)).not.toBe(initialTransform);
    await page.getByRole('button', { name: /Open document actions/u }).click();
    let menu = page.getByRole('menu', { name: /Actions for/u });
    await expect(menu).toHaveAttribute('data-export-eligibility', 'blocked');
    await expect(menu.getByRole('menuitem', { name: 'Export', exact: true }))
      .toHaveAttribute('aria-disabled', 'true');
    await expect(menu.getByText(
      'Export becomes available after document reconciliation finishes.',
    )).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Open Annotations' })).toHaveCount(0);

    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=ready&refresh=failed');
    await page.getByRole('button', { name: /Open document actions/u }).click();
    menu = page.getByRole('menu', { name: /Actions for/u });
    await expect(menu).toHaveAttribute('data-export-eligibility', 'eligible');
    await expect(menu.getByText(
      'The last successful PDF may be stale. Confirm before exporting this generation.',
    )).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Export', exact: true }).click();
    await expect(menu.getByText('Export the last successful PDF?')).toBeVisible();
  });

  test('keeps focus and References coherent when a live outline disappears and returns', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: 'Set outline tree' }).click();
    await page.getByRole('button', { name: 'Show workspace' }).click();
    const outlineDestination = page.getByRole('button', {
      name: 'Harness section, Page 1',
      exact: true,
    });
    await outlineDestination.focus();

    await page.getByRole('button', { name: 'Set outline empty' }).evaluate((button) => (
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ));
    const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
    const search = page.getByRole('tab', { name: 'Search', exact: true });
    await expect(page.getByRole('tab', { name: 'Outline', exact: true })).toHaveCount(0);
    await expect(search).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#workspace-panel-search')).toBeFocused();

    await page.getByRole('button', { name: 'Set outline tree' }).evaluate((button) => (
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ));
    await expect(page.getByRole('tab', { name: 'Outline', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('#workspace-panel-outline')).toBeFocused();

    await page.getByRole('button', { name: 'Open harness reference' }).press('Enter');
    await page.getByRole('button', { name: 'Show References' }).click();
    await clickHoverRevealedReferenceDockAction(
      page.getByRole('button', { name: 'Move References to right' }),
    );
    await expect(page.locator('[data-review-stage]')).toHaveAttribute(
      'data-reference-layout',
      'wide-right',
    );
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    const references = page.getByRole('tab', { name: 'References', exact: true });
    await expect(references).toHaveAttribute('aria-selected', 'true');
    const outlineTab = page.getByRole('tab', { name: 'Outline', exact: true });
    await references.focus();
    await page.keyboard.press('ArrowRight');
    await expect(outlineTab).toBeFocused();
    await page.getByRole('button', { name: 'Set outline empty' }).evaluate((button) => (
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ));
    await expect(page.getByRole('tab', { name: 'Outline', exact: true })).toHaveCount(0);
    await expect(references).toHaveAttribute('aria-selected', 'true');
    await expect(references).toBeFocused();

    await page.keyboard.press('ArrowLeft');
    await expect(annotations).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(references).toBeFocused();

    await page.setViewportSize({ width: 760, height: 900 });
    await expect(page.locator('[data-review-stage]')).toHaveAttribute(
      'data-reference-layout',
      'narrow-unified',
    );
    await expect(page.getByRole('tab', { name: 'Outline', exact: true })).toHaveCount(0);
    await expect(references).toHaveAttribute('aria-selected', 'true');
  });

  test('restores the exact branch set through the wired outline expansion control', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: 'Set outline tree' }).click();
    await page.getByRole('button', { name: 'Show workspace' }).click();

    const harness = outlineDisclosure(page, 'harness-outline');
    const nested = outlineDisclosure(page, 'harness-outline-nested');
    const supplemental = outlineDisclosure(page, 'supplemental-outline');
    await expect(harness).toHaveAttribute('aria-expanded', 'true');
    await expect(nested).toHaveAttribute('aria-expanded', 'true');
    await expect(supplemental).toHaveAttribute('aria-expanded', 'true');

    await supplemental.click();
    await expect(supplemental).toHaveAttribute('aria-expanded', 'false');
    await page.locator('.review-workspace__header').hover();
    await page.getByRole('button', { name: 'Collapse all outline entries' }).click();
    await expect(page.getByRole('button', {
      name: 'Restore previous outline expansion',
    })).toHaveAttribute('aria-pressed', 'true');
    await expect(harness).toHaveAttribute('aria-expanded', 'false');
    await expect(nested).toHaveAttribute('aria-expanded', 'false');
    await expect(supplemental).toHaveAttribute('aria-expanded', 'false');

    await supplemental.click();
    await expect(supplemental).toHaveAttribute('aria-expanded', 'true');
    await page.locator('.review-workspace__header').hover();
    await page.getByRole('button', { name: 'Restore previous outline expansion' }).click();
    await expect(harness).toHaveAttribute('aria-expanded', 'true');
    await expect(nested).toHaveAttribute('aria-expanded', 'true');
    await expect(supplemental).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('button', {
      name: 'Collapse all outline entries',
    })).toHaveAttribute('aria-pressed', 'false');
  });

  test('resets a pending outline restore when the document generation changes', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: 'Set outline tree' }).click();
    await page.getByRole('button', { name: 'Show workspace' }).click();
    await page.locator('.review-workspace__header').hover();
    await page.getByRole('button', { name: 'Collapse all outline entries' }).click();
    await expect(page.getByRole('button', {
      name: 'Restore previous outline expansion',
    })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Begin outline replacement' }).evaluate((button) => (
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ));
    await expect(page.locator('[data-outline-state="loading"]')).toHaveText('Outline is loading');
    await expect(page.getByRole('button', {
      name: 'Restore previous outline expansion',
    })).toHaveCount(0);

    await page.getByRole('button', { name: 'Load replacement outline tree' }).evaluate((button) => (
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ));
    await expect(page.getByRole('tab', { name: 'Outline', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(outlineDisclosure(page, 'replacement-outline')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(page.getByRole('button', {
      name: 'Collapse all outline entries',
    })).toHaveAttribute('aria-pressed', 'false');
  });

  test('commits all five tools once through keyboard and toolbar paths', async ({ page }) => {
    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    await canvas.focus();
    await page.keyboard.press('l');
    const replacement = page.getByRole('textbox', { name: 'Replacement' });
    await expect(replacement).toBeFocused();
    await page.keyboard.type('oc');
    await expect(replacement).toHaveValue('loc');
    await replacement.fill('locally unique equilibrium');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('[data-revision]')).toHaveAttribute('data-revision', '1');
    await expect(page.locator('[data-owned-mark="replace"]')).toHaveText('locally unique equilibrium');

    await page.getByRole('button', { name: 'Use selection' }).click();
    await canvas.focus();
    await page.keyboard.press('Backspace');
    await page.getByRole('button', { name: 'Use caret' }).click();
    await canvas.focus();
    await page.keyboard.press('p');
    const insertion = page.getByRole('textbox', { name: 'Insertion' });
    await insertion.fill(' ');
    await page.getByRole('button', { name: 'Apply' }).click();

    await page.getByRole('button', { name: 'Use selection' }).click();
    const highlight = page.getByRole('button', { name: 'Highlight', exact: true });
    await highlight.click();
    await expect(page.getByRole('region', { name: 'Highlight Comment' })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(highlight).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear anchors' }).click();
    await page.getByRole('button', { name: 'Use selection' }).click();
    await highlight.click();
    await page.getByRole('textbox', { name: 'Comment (optional)' }).fill('Check the claim.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await page.getByRole('button', { name: 'Open page actions' }).click();
    await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
    await page.getByRole('textbox', { name: 'Comment' }).fill('Rewrite this paragraph.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.locator('[data-revision]')).toHaveAttribute('data-revision', '6');
    await expect(page.locator('[data-revision]')).toHaveAttribute(
      'data-kinds',
      'replace,delete,insert,highlight,highlight,pageNote',
    );
    await expect(page.locator('[data-owned-annotation-layer] [data-owned-mark]')).toHaveCount(6);
  });

  test('dismisses selection actions after an annotation is completed', async ({ page }) => {
    const selectionActions = page.getByRole('toolbar', { name: 'Selection review actions' });

    await expect(selectionActions).toBeVisible();
    for (const name of ['Replace', 'Delete', 'Highlight']) {
      const action = selectionActions.getByRole('button', { name, exact: true });
      await expect(action.locator('.review-icon')).toBeVisible();
      await expect(action).toHaveText('');
    }
    await selectionActions.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(selectionActions).toHaveCount(0);
    await expect(page.locator('[data-anchor-kind]')).toHaveAttribute('data-anchor-kind', 'none');

    await page.getByRole('button', { name: 'Clear anchors' }).click();
    await page.getByRole('button', { name: 'Use selection' }).click();
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(selectionActions).toBeVisible();

    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    await page.getByRole('textbox', { name: 'Replacement' }).fill('replacement');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(selectionActions).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear anchors' }).click();
    await page.getByRole('button', { name: 'Use selection' }).click();
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(selectionActions).toHaveCount(0);
  });

  test('keeps selection actions visible while Workspace Annotations is toggled', async ({ page }) => {
    const selectionActions = page.getByRole('toolbar', { name: 'Selection review actions' });

    await expect(selectionActions).toBeVisible();
    await openAnnotationsWorkspace(page);
    await expect(page.locator('[data-anchor-kind]')).toHaveAttribute('data-anchor-kind', 'selection');
    await expect(selectionActions).toBeVisible();

    await closeWorkspace(page);
    await expect(selectionActions).toBeVisible();

    await openAnnotationsWorkspace(page);
    await expect(page.locator('[data-anchor-kind]')).toHaveAttribute('data-anchor-kind', 'selection');
    await expect(selectionActions).toBeVisible();
    await closeWorkspace(page);
    await expect(selectionActions).toBeVisible();

    await page.getByRole('button', { name: 'Clear anchors' }).click();
    await expect(selectionActions).toHaveCount(0);
  });

  test('preserves scroll position while the reading viewport narrows for trays', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 760 });
    const viewport = await installMainScrollport(page, 17);
    const initialViewport = await viewport.boundingBox();
    const initialLocation = await viewport.evaluate((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
    }));
    await expect.poll(() => page.locator('[data-review-stage]').evaluate((element) => (
      getComputedStyle(element).getPropertyValue('--review-overlay-inset').trim()
    ))).toBe('17px');

    await openAnnotationsWorkspace(page);
    const openViewport = (await viewport.boundingBox())!;
    expect(openViewport.width).toBeLessThan(initialViewport!.width);
    expect({ x: openViewport.x, y: openViewport.y, height: openViewport.height })
      .toEqual({ x: initialViewport!.x, y: initialViewport!.y, height: initialViewport!.height });
    expect(await viewport.evaluate((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
    }))).toEqual(initialLocation);
    await closeWorkspace(page);
    expect(await viewport.boundingBox()).toEqual(initialViewport);

    await page.getByRole('button', { name: 'Open harness reference' }).click();
    await page.getByRole('button', { name: 'Show workspace' }).click();
    await page.setViewportSize({ width: 760, height: 720 });
    await page.locator('[data-review-stage]').evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)));
    });
    await expect.poll(async () => {
      const stage = await page.locator('[data-review-stage]').boundingBox();
      const tray = await page.locator('#review-workspace').boundingBox();
      return stage && tray ? stage.y + stage.height - tray.y - tray.height : Number.NaN;
    }).toBeCloseTo(17, 0);
    const [stageBounds, surfaceBounds] = await Promise.all([
      page.locator('[data-review-stage]').boundingBox(),
      page.locator('#review-workspace').boundingBox(),
    ]);
    expect(stageBounds).not.toBeNull();
    expect(surfaceBounds).not.toBeNull();
    expect(surfaceBounds!.x - stageBounds!.x).toBeCloseTo(17, 0);
    expect(stageBounds!.x + stageBounds!.width - surfaceBounds!.x - surfaceBounds!.width)
      .toBeCloseTo(17, 0);
    expect(stageBounds!.y + stageBounds!.height - surfaceBounds!.y - surfaceBounds!.height)
      .toBeCloseTo(17, 0);
    expect(await viewport.evaluate((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
    }))).toEqual(initialLocation);
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '',
    );
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:;commands:;fit:',
    );
  });

  test('routes view shortcuts from reference focus while preserving editable input', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installRuntimeClassicScrollport(page);
    await page.getByRole('button', { name: 'Set outline tree' }).evaluate(element => (element as HTMLButtonElement).click());
    await page.getByRole('application', { name: 'PDF review canvas' }).focus();
    await page.keyboard.press('Control+Meta+o');
    await expect(page.getByRole('tab', { name: 'Outline', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Control+Meta+a');
    await expect(page.getByRole('tab', { name: 'Annotations', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Open harness reference' }).press('Enter');
    await page.keyboard.press('Control+Meta+r');
    await expect(page.locator('#workspace-panel-references')).toBeVisible();
    await page.keyboard.press('Control+Meta+0');
    await expect(page.getByRole('textbox', { name: 'Current zoom 88 percent. Enter a zoom percentage' })).toHaveValue('88');
    await page.keyboard.press('Control+Meta+l');
    await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-horizontal-scroll-locked', 'true');
    await page.keyboard.press('Control+Meta+l');
    await expect(page.locator('[data-review-stage]')).not.toHaveAttribute('data-horizontal-scroll-locked', 'true');
    const input = page.getByRole('textbox', { name: 'Native input', exact: true });
    await input.fill('keep this text');
    await input.press('Control+Meta+l');
    await expect(input).toHaveValue('keep this text');
    await expect(input).toBeFocused();
    await expect(page.locator('[data-review-stage]')).not.toHaveAttribute('data-horizontal-scroll-locked', 'true');
  });

  test('keeps the gap above bottom References equal to the outside tray inset', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installRuntimeClassicScrollport(page);
    await page.getByRole('button', { name: 'Open harness reference' }).press('Enter');
    await page.getByRole('button', { name: 'Show References' }).click();
    await page.getByRole('button', { name: 'Show workspace' }).click();
    const stage = page.locator('[data-review-stage]');
    await expect(stage).toHaveAttribute('data-reference-layout', 'wide-split');
    await expect.poll(async () => stage.evaluate((element) => {
      const reference = element.querySelector('#review-workspace')!.getBoundingClientRect();
      const tools = element.querySelector('#review-tools-workspace')!.getBoundingClientRect();
      const inset = Number.parseFloat(getComputedStyle(element).getPropertyValue('--review-overlay-inset'));
      return Math.abs(reference.top - tools.bottom - inset);
    })).toBeLessThan(1);
  });

  test('backs tray margins while excluding only actual scrollbar tracks', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 720 });
    const viewport = await installRuntimeClassicScrollport(page);
    await viewport.evaluate((element) => {
      element.firstElementChild?.setAttribute('style', 'width: 100%; height: 1600px; background: white');
    });
    await page.getByRole('button', { name: 'Open harness reference' }).press('Enter');
    await page.getByRole('button', { name: 'Show workspace' }).click();
    await expect.poll(() => viewport.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const backing = page.locator('.review-overlay-frame');
    const expectedClip = () => viewport.evaluate((element) => {
      const scrollport = element as HTMLElement;
      const width = scrollport.offsetWidth - scrollport.clientWidth;
      const height = scrollport.offsetHeight - scrollport.clientHeight;
      return `inset(0px ${width}px ${height}px 0px)`;
    });
    await expect(backing).toHaveCSS('clip-path', await expectedClip());
    await viewport.evaluate((element) => {
      (element.firstElementChild as HTMLElement).style.width = '2000px';
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(backing).toHaveCSS('clip-path', await expectedClip());
    await viewport.evaluate((element) => {
      element.style.scrollbarWidth = 'none';
      element.style.setProperty('--test-scrollbar-size', '0px');
      element.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(expectedClip).toBe('inset(0px 0px 0px 0px)');
    await expect(backing).toHaveCSS('clip-path', 'inset(0px)');
  });

  test('includes an actual wide classic scrollbar track in the common outside tray inset', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium exposes deterministic custom classic scrollbar metrics in CI.');
    await page.setViewportSize({ width: 760, height: 720 });
    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-workspace-presentation', 'bottom');
    const initialCanvas = await canvas.boundingBox();
    const viewport = await installRuntimeClassicScrollport(page);
    const tracks = await viewport.evaluate((element) => {
      const scrollport = element as HTMLElement;
      return {
        vertical: scrollport.offsetWidth - scrollport.clientWidth - scrollport.clientLeft,
        horizontal: scrollport.offsetHeight - scrollport.clientHeight - scrollport.clientTop,
      };
    });
    expect(tracks.vertical).toBeGreaterThan(12);
    // Headless Chromium on macOS reserves the styled vertical track while retaining
    // an overlay horizontal track. Test the runtime metrics rather than inventing it.
    expect(tracks.horizontal).toBeGreaterThanOrEqual(0);
    await expect.poll(() => page.locator('[data-review-stage]').evaluate((element) => (
      getComputedStyle(element).getPropertyValue('--review-overlay-inset').trim()
    ))).toBe(`${Math.max(tracks.vertical, tracks.horizontal)}px`);

    await page.getByRole('button', { name: 'Open harness reference' }).press('Enter');
    await page.getByRole('button', { name: 'Show workspace' }).click();
    const [stageBounds, surfaceBounds, viewportBounds] = await Promise.all([
      page.locator('[data-review-stage]').boundingBox(),
      page.locator('#review-workspace').boundingBox(),
      viewport.boundingBox(),
    ]);
    expect(stageBounds).not.toBeNull();
    expect(surfaceBounds).not.toBeNull();
    expect(viewportBounds).not.toBeNull();
    expect(surfaceBounds!.x - stageBounds!.x).toBeCloseTo(tracks.vertical, 0);
    expect(stageBounds!.x + stageBounds!.width - surfaceBounds!.x - surfaceBounds!.width)
      .toBeCloseTo(tracks.vertical, 0);
    expect(stageBounds!.y + stageBounds!.height - surfaceBounds!.y - surfaceBounds!.height)
      .toBeCloseTo(Math.max(tracks.vertical, tracks.horizontal), 0);
    const documentBounds = await page.locator('.review-document').boundingBox();
    expect(viewportBounds).toEqual(documentBounds);
    expect(await canvas.boundingBox()).toEqual(initialCanvas);
    await expect(page.getByRole('button', { name: 'Hide workspace' })).toBeVisible();
    await page.getByRole('button', { name: 'Hide workspace' }).focus();
    await expect(page.getByRole('button', { name: 'Hide workspace' })).toBeFocused();
  });

  test('keeps enlarged review text and fixed workspace actions reachable at compact and desktop widths', async ({ page }) => {
    await page.addStyleTag({ content: `
      [data-review-stage] button,
      [data-review-stage] input,
      [data-review-stage] textarea,
      [data-review-stage] [role='tab'],
      [data-review-stage] [role='menuitem'] {
        font-size: 20px !important;
      }
    ` });
    await page.getByRole('button', { name: 'Seed annotations' }).click();
    await openAnnotationsWorkspace(page);

    for (const width of [320, 736, 1280]) {
      await page.setViewportSize({ width, height: 760 });
      const presentation = width < 900 ? 'bottom' : 'right';
      await expect(page.locator('[data-review-stage]')).toHaveAttribute(
        'data-workspace-presentation',
        presentation,
      );
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      const surface = page.locator(
        presentation === 'right' ? '#review-tools-workspace' : '#review-workspace',
      );
      const openAttribute = presentation === 'right'
        ? 'data-tools-workspace-open'
        : 'data-workspace-open';
      if (await surface.getAttribute(openAttribute) !== 'true') {
        await page.getByRole('button', { name: 'Show workspace' }).click();
        await expect(surface).toHaveAttribute(openAttribute, 'true');
      }
      await expect.poll(() => page.locator('[data-review-stage]').evaluate((element) => (
        element.scrollWidth <= element.clientWidth
      ))).toBe(true);
      const header = page.locator(
        presentation === 'right'
          ? '#review-tools-workspace .review-workspace__header'
          : '#review-workspace .review-workspace__header',
      );
      const scroller = page.locator('[data-annotation-scroll-viewport]');
      await expect(header).toBeVisible();
      const headerBefore = await header.boundingBox();
      await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      const headerAfter = await header.boundingBox();
      expect(headerAfter).toEqual(headerBefore);
      const hide = page.getByRole('button', { name: 'Hide workspace' });
      await expect(hide).toBeVisible();
      await hide.focus();
      await expect(hide).toBeFocused();
      const hideBounds = await hide.boundingBox();
      expect(hideBounds).not.toBeNull();
      expect(hideBounds!.x).toBeGreaterThanOrEqual(0);
      expect(hideBounds!.x + hideBounds!.width).toBeLessThanOrEqual(width);
    }
  });

  test('edits the viewer-published current page through Enter and ordinary blur', async ({ page }) => {
    const currentPage = page.getByRole('textbox', {
      name: 'Current page 3 of 12. Enter a page number',
    });
    await currentPage.click();

    await expect(currentPage).toBeFocused();
    await expect(currentPage).toHaveValue('3');
    await currentPage.fill('8');
    await expect(currentPage).toHaveValue('8');
    await currentPage.press('Enter');

    await expect(page.getByRole('textbox', {
      name: 'Current page 8 of 12. Enter a page number',
    })).toBeFocused();
    await expect(page.locator('[data-viewer-page-commands]')).toHaveAttribute(
      'data-viewer-page-commands',
      'go:8',
    );
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '8',
    );

    const pageNumber = page.getByRole('textbox', {
      name: 'Current page 8 of 12. Enter a page number',
    });
    await pageNumber.fill('5');
    const nativeInput = page.getByRole('textbox', { name: 'Native input' });
    await nativeInput.focus();

    await expect(nativeInput).toBeFocused();
    await expect(page.getByRole('textbox', {
      name: 'Current page 5 of 12. Enter a page number',
    })).toBeVisible();
    await expect(page.locator('[data-viewer-page-commands]')).toHaveAttribute(
      'data-viewer-page-commands',
      'go:8,go:5',
    );
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '8,5',
    );
  });

  test('keeps direct page and zoom controls usable while the neutral toolbar wraps', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?responsive=full');
    await page.setViewportSize({ width: 320, height: 720 });
    const chrome = page.locator('[data-review-chrome]');
    await expect(chrome).toHaveAttribute('data-review-chrome-presentation', 'expanded');

    const pageInput = page.getByRole('textbox', {
      name: 'Current page 3 of 12. Enter a page number',
    });
    await pageInput.fill('6');
    await pageInput.press('Enter');
    await expect(page.getByRole('textbox', {
      name: 'Current page 6 of 12. Enter a page number',
    })).toBeFocused();

    const pageMenuTrigger = page.getByRole('button', {
      name: 'Page 6 of 12. Open page navigation',
    });
    await pageMenuTrigger.click();
    const pageMenu = page.getByRole('menu', { name: 'Page navigation' });
    await expect(pageMenu.getByRole('menuitem', { name: 'Previous page' })).toBeVisible();
    await expect(pageMenu.getByRole('menuitem', { name: 'Next page' })).toBeVisible();

    const zoomInput = page.getByRole('textbox', {
      name: 'Current zoom 110 percent. Enter a zoom percentage',
    });
    await zoomInput.fill('120');
    await zoomInput.press('Enter');
    await expect(page.getByRole('textbox', {
      name: 'Current zoom 120 percent. Enter a zoom percentage',
    })).toBeFocused();
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    await page.getByRole('button', { name: 'Open zoom controls' }).hover();
    const zoomMenu = page.getByRole('menu', { name: 'PDF zoom' });
    await expect(zoomMenu.getByRole('menuitem')).toHaveCount(3);
    await expect(zoomMenu.getByRole('menuitem', { name: 'Fit width' })).toBeVisible();
  });

  test('keeps unavailable direct viewer controls inert without disturbing an open workspace', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?responsive=full');
    await page.setViewportSize({ width: 320, height: 720 });
    await openAnnotationsWorkspace(page);
    await page.getByRole('button', { name: 'Make page controls unavailable' }).evaluate(element => (element as HTMLButtonElement).click());
    await expect(page.getByLabel('Current page unavailable')).toHaveText('—');
    await expect(page.getByRole('button', { name: 'Page navigation unavailable' })).toBeDisabled();
    await page.getByRole('button', { name: 'Make zoom controls unavailable' }).evaluate(element => (element as HTMLButtonElement).click());
    await expect(page.getByLabel('Zoom unavailable')).toHaveText('—');
    await expect(page.getByRole('button', { name: 'Open zoom controls' })).toBeDisabled();
    await expect(page.locator('#review-workspace')).toHaveAttribute('data-workspace-open', 'true');
  });

  test('caps long titles and lets short titles shrink across responsive widths', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?visual=reading');
    await page.setViewportSize({ width: 1280, height: 720 });
    const chrome = page.locator('[data-review-chrome]');
    await expect(chrome).toHaveAttribute('data-review-chrome-presentation', 'expanded');

    const longTitle = chrome.locator(':scope > .review-chrome__identity .review-chrome__filename');
    const originalTitle = await longTitle.textContent();
    const longTitleGeometry = await longTitle.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      truncated: element.scrollWidth > element.clientWidth,
    }));
    expect(longTitleGeometry.truncated).toBe(true);
    expect(longTitleGeometry.width).toBeLessThanOrEqual(256.5);
    const shortTitleGeometry = await longTitle.evaluate((element) => {
      element.textContent = 'A.pdf';
      return {
        width: element.getBoundingClientRect().width,
        truncated: element.scrollWidth > element.clientWidth,
      };
    });
    expect(shortTitleGeometry.truncated).toBe(false);
    expect(shortTitleGeometry.width).toBeLessThan(80);
    await longTitle.evaluate((element, title) => { element.textContent = title; }, originalTitle);

    for (const width of [760, 480, 320]) {
      await page.setViewportSize({ width, height: 720 });
      // Platform font metrics may select a different measured presentation.
      // The visible controls must still fit and retain their touch targets.
      await expect(chrome.getByRole('button', { name: 'Open zoom controls' })).toBeVisible();
      await expect(chrome).toHaveCSS('overflow', 'visible');
    }
  });

  test('matches the canonical filename, agent, page, and zoom geometry', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?responsive=full');
    await page.setViewportSize({ width: 1280, height: 720 });
    const chrome = page.locator('[data-review-chrome]');
    const filenameControl = chrome.locator(':scope > .review-chrome__identity > .review-chrome__save-identity');
    const context = chrome.locator(':scope > .review-chrome__identity > [data-review-context-status]');
    const pagePosition = chrome.locator('[data-review-page-position]');
    const pageDisclosure = chrome.locator('.review-chrome__page-disclosure');
    const zoomGroup = chrome.locator('[data-review-chrome-group="zoom"]');
    const zoomValue = zoomGroup.locator('.review-chrome__zoom-value');
    const zoomInput = zoomGroup.locator('.review-chrome__zoom-input');
    const zoomSuffix = zoomGroup.locator('.review-chrome__zoom-suffix');
    const zoomDisclosure = zoomGroup.locator('.review-chrome__zoom-disclosure');

    const geometry = await chrome.evaluate((element) => {
      const bounds = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      const styles = (selector: string) => getComputedStyle(element.querySelector<HTMLElement>(selector)!);
      const file = bounds(':scope > .review-chrome__identity > .review-chrome__save-identity');
      const contextStatus = bounds(':scope > .review-chrome__identity > [data-review-context-status]');
      const pageGroup = bounds('[data-review-page-position]');
      const pageNumber = bounds('.review-chrome__page-input');
      const pageButton = bounds('.review-chrome__page-disclosure');
      const pageText = bounds('.review-chrome__page-disclosure > span');
      const zoom = bounds('[data-review-chrome-group="zoom"]');
      const zoomNumber = bounds('.review-chrome__zoom-input');
      const zoomUnit = bounds('.review-chrome__zoom-suffix');
      const zoomButton = bounds('.review-chrome__zoom-disclosure');
      const zoomIcon = bounds('.review-chrome__zoom-disclosure .review-icon');
      return {
        file: file.toJSON(), context: contextStatus.toJSON(),
        pageGroup: pageGroup.toJSON(), pageNumber: pageNumber.toJSON(), pageButton: pageButton.toJSON(), pageText: pageText.toJSON(),
        zoom: zoom.toJSON(), zoomNumber: zoomNumber.toJSON(), zoomUnit: zoomUnit.toJSON(), zoomButton: zoomButton.toJSON(), zoomIcon: zoomIcon.toJSON(),
        filePadding: [styles(':scope > .review-chrome__identity > .review-chrome__save-identity').paddingTop, styles(':scope > .review-chrome__identity > .review-chrome__save-identity').paddingRight],
        fileGap: styles(':scope > .review-chrome__identity > .review-chrome__save-identity').gap,
        fileRadius: styles(':scope > .review-chrome__identity > .review-chrome__save-identity').borderRadius,
        pageAlign: styles('.review-chrome__page-input').textAlign,
      };
    });

    expect(geometry.file.height).toBe(32);
    expect(geometry.filePadding).toEqual(['6px', '8px']);
    expect(geometry.fileGap).toBe('7px');
    expect(geometry.fileRadius).toBe('10px');
    const controlGaps = await chrome.locator(':scope > .review-chrome__viewer-controls').evaluate((element) => {
      const controls = Array.from(element.children).flatMap((child) =>
        child.matches('.review-chrome__edit-cluster, .review-chrome__navigation-cluster')
          ? Array.from(child.children)
          : [child]);
      const boxes = controls.map((control) => control.getBoundingClientRect()).filter((box) => box.width > 0);
      return boxes.slice(1).map((box, index) => box.left - boxes[index]!.right);
    });
    for (const gap of controlGaps) expect(gap).toBeCloseTo(8, 1);
    expect(Math.abs(geometry.file.x + geometry.file.width + 8 - geometry.context.x)).toBeLessThanOrEqual(.5);
    expect(Math.abs(geometry.file.y + geometry.file.height / 2 - geometry.context.y - geometry.context.height / 2)).toBeLessThanOrEqual(.5);
    expect(geometry.pageNumber.width).toBe(26);
    expect(geometry.pageAlign).toBe('center');
    expect(Math.abs(geometry.pageNumber.x + geometry.pageNumber.width - geometry.pageButton.x)).toBeLessThanOrEqual(.5);
    expect(Math.abs(geometry.pageButton.width - geometry.pageText.width - 6)).toBeLessThanOrEqual(.5);
    expect(Math.abs(geometry.zoom.x + 5 - geometry.zoomNumber.x)).toBeLessThanOrEqual(.5);
    expect(Math.abs(geometry.zoomNumber.x + geometry.zoomNumber.width - geometry.zoomUnit.x)).toBeLessThanOrEqual(.5);
    expect(Math.abs(geometry.zoomUnit.x + geometry.zoomUnit.width - geometry.zoomButton.x)).toBeLessThanOrEqual(.5);
    expect(geometry.zoomButton.width).toBe(20);
    expect(geometry.zoomButton.height).toBe(32);
    expect(Math.abs(geometry.zoomButton.x + geometry.zoomButton.width / 2 - geometry.zoomIcon.x - geometry.zoomIcon.width / 2)).toBeLessThanOrEqual(.5);

    await pagePosition.hover();
    await expect(pagePosition).toHaveCSS('background-color', 'rgb(231, 231, 231)');
    await expect(pageDisclosure).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await pageDisclosure.click();
    await expect(pagePosition).toHaveCSS('background-color', 'rgb(231, 231, 231)');
    await expect(pageDisclosure).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await pageDisclosure.click();
    await page.mouse.move(0, 200);
    await expect(page.getByRole('menu', { name: 'Page navigation', exact: true })).toBeHidden();
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    await zoomGroup.hover();
    await expect(zoomGroup).toHaveCSS('background-color', 'rgb(231, 231, 231)');
    await expect(zoomDisclosure).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await zoomDisclosure.click();
    await expect(zoomGroup).toHaveCSS('background-color', 'rgb(231, 231, 231)');
    await expect(zoomDisclosure).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await zoomDisclosure.click();
    await page.mouse.move(0, 200);
    await expect(page.getByRole('menu', { name: 'PDF zoom', exact: true })).toBeHidden();

    await expect(filenameControl.locator(':scope > .review-icon + .review-chrome__filename')).toHaveCount(1);
    await expect(context).toBeVisible();
    await expect(zoomValue).toBeVisible();
    await expect(zoomInput).toBeVisible();
    await expect(zoomSuffix).toBeVisible();
  });

  test('reveals right-side controls on bar hover and dismisses hover menus outside their trigger and popup', async ({ page }) => {
    const bar = page.locator('[data-review-chrome]');
    const rightControls = bar.locator(':scope > .review-chrome__viewer-controls');
    const expectToolbarRevealed = async () => {
      await expect(rightControls).toHaveCSS('opacity', '1');
      for (const control of await bar.locator('[data-review-copy-link], [data-main-history]').all()) {
        await expect(control).toHaveCSS('opacity', '1');
        await expect(control).toHaveCSS('pointer-events', 'auto');
      }
      for (const control of await bar.locator('[data-main-history]').all()) {
        await expect(control).toHaveCSS('clip-path', 'none');
      }
    };
    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    await canvas.hover();
    await expect(rightControls).toHaveCSS('opacity', '0');
    for (const control of await bar.locator('[data-review-copy-link], [data-main-history]').all()) {
      await expect(control).toHaveCSS('opacity', '0');
    }
    for (const control of await bar.locator('[data-main-history]').all()) {
      await expect(control).toHaveCSS('clip-path', 'inset(50%)');
    }
    await bar.hover({ position: { x: 2, y: 2 } });
    await expect(rightControls).toHaveCSS('opacity', '1');
    for (const control of await bar.locator('[data-review-copy-link], [data-main-history]').all()) {
      await expect(control).toHaveCSS('opacity', '1');
    }
    await page.getByRole('button', { name: 'Open zoom controls' }).hover();
    const zoomMenu = page.getByRole('menu', { name: 'PDF zoom', exact: true });
    await expect(zoomMenu).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open zoom controls' })).not.toBeFocused();
    const zoomBox = bar.locator('.review-chrome__zoom-cluster');
    const zoomHoverColor = await zoomBox.evaluate((element) => getComputedStyle(element).backgroundColor);
    const zoomBoxBounds = (await zoomBox.boundingBox())!;
    const zoomPopupBounds = (await zoomMenu.boundingBox())!;
    await page.mouse.move(zoomBoxBounds.x + zoomBoxBounds.width / 2,
      (zoomBoxBounds.y + zoomBoxBounds.height + zoomPopupBounds.y) / 2);
    await page.waitForTimeout(1100);
    await expect(zoomMenu).toBeVisible();
    await expect(zoomBox).toHaveCSS('background-color', zoomHoverColor);
    await expectToolbarRevealed();
    await page.waitForTimeout(700);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await zoomMenu.getByRole('menuitem', { name: 'Zoom out', exact: true }).hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    expect(await tooltip.evaluate((element) => element.matches(':popover-open'))).toBe(true);
    const tooltipBounds = await tooltip.boundingBox();
    const menuBounds = await zoomMenu.boundingBox();
    expect(tooltipBounds!.y).toBeGreaterThanOrEqual(menuBounds!.y + menuBounds!.height + 5);

    await zoomMenu.hover();
    await expect(zoomMenu).toBeVisible();
    await expectToolbarRevealed();
    await expect(rightControls).toHaveCSS('opacity', '1');
    await canvas.hover();
    await expect(zoomMenu).toHaveCount(0);
    await expect(rightControls).toHaveCSS('opacity', '0');

    await page.locator('[data-review-page-position]').hover();
    const pageMenu = page.getByRole('menu', { name: 'Page navigation', exact: true });
    await expect(pageMenu).toBeVisible();
    const pageBox = page.locator('[data-review-page-position]');
    const pageHoverColor = await pageBox.evaluate((element) => getComputedStyle(element).backgroundColor);
    const pageBoxBounds = (await pageBox.boundingBox())!;
    const pagePopupBounds = (await pageMenu.boundingBox())!;
    await page.mouse.move(pageBoxBounds.x + pageBoxBounds.width / 2,
      (pageBoxBounds.y + pageBoxBounds.height + pagePopupBounds.y) / 2);
    await page.waitForTimeout(1100);
    await expect(pageMenu).toBeVisible();
    await expect(pageBox).toHaveCSS('background-color', pageHoverColor);
    await expectToolbarRevealed();
    await pageMenu.getByRole('menuitem', { name: 'Next page' }).hover();
    await expect(pageMenu).toBeVisible();
    await expectToolbarRevealed();
    await canvas.hover();
    await expect(pageMenu).toHaveCount(0);

    const zoomTrigger = page.getByRole('button', { name: 'Open zoom controls' });
    await zoomTrigger.focus();
    await zoomTrigger.press('Enter');
    await expect(zoomMenu.getByRole('menuitem', { name: 'Fit width' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(zoomMenu.getByRole('menuitem', { name: 'Zoom in' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(zoomMenu).toHaveCount(0);
    await expect(zoomTrigger).toBeFocused();
  });

  test('keeps the top bar to one contained 50px row across supported widths', async ({ page }) => {
    await page.locator('#root').evaluate((element) => {
      element.setAttribute('data-production-root', 'true');
    });
    for (const width of [1280, 760, 641, 640, 521, 520, 481, 480, 390, 361, 360, 320]) {
      await page.setViewportSize({ width, height: 720 });
      const chrome = page.locator('[data-review-chrome]');
      await expect(chrome).toHaveCSS('height', '50px');
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));

      const geometry = await chrome.evaluate((element) => {
        const identity = element.querySelector<HTMLElement>(':scope > .review-chrome__identity');
        const controls = element.querySelector<HTMLElement>(':scope > .review-chrome__viewer-controls');
        const navigation = element.querySelector<HTMLElement>(':scope > .review-chrome__left-controls');
        if (!identity || !controls || !navigation) throw new Error('Review chrome geometry is incomplete.');
        const chromeBounds = element.getBoundingClientRect();
        const identityBounds = identity.getBoundingClientRect();
        const controlsBounds = controls.getBoundingClientRect();
        const visibleBounds = (selector: string) => [...element.querySelectorAll<HTMLElement>(selector)]
          .filter((child) => getComputedStyle(child).display !== 'none')
          .map((child) => child.getBoundingClientRect().toJSON());
        return {
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          height: chromeBounds.height,
          identity: identityBounds.toJSON(),
          controls: controlsBounds.toJSON(),
          navigation: navigation.getBoundingClientRect().toJSON(),
          identityChildren: visibleBounds(':scope > .review-chrome__identity > *'),
          saveChildren: visibleBounds(':scope > .review-chrome__identity .review-chrome__save-identity > :not(.sr-only)'),
          filename: element.querySelector<HTMLElement>(':scope > .review-chrome__identity .review-chrome__filename')?.getBoundingClientRect().toJSON(),
        };
      });

      expect(geometry.height).toBe(50);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
      const visibleColumns = [geometry.identity, geometry.navigation, geometry.controls]
        .filter((item) => item.width > 0.5);
      for (let index = 1; index < visibleColumns.length; index += 1) {
        expect(visibleColumns[index - 1]!.x + visibleColumns[index - 1]!.width)
          .toBeLessThanOrEqual(visibleColumns[index]!.x + 0.5);
      }
      for (const children of [geometry.identityChildren, geometry.saveChildren]) {
        for (let index = 1; index < children.length; index += 1) {
          expect(children[index - 1]!.x + children[index - 1]!.width)
            .toBeLessThanOrEqual(children[index]!.x + 0.5);
        }
      }
      if ((geometry.filename?.width ?? 0) > 0) {
        expect(geometry.filename!.width).toBeGreaterThanOrEqual(40);
      }
      for (const item of [geometry.identity, geometry.navigation, geometry.controls]) {
        expect(item.y).toBeGreaterThanOrEqual(-0.5);
        expect(item.y + item.height).toBeLessThanOrEqual(50.5);
      }
    }
  });

  test('keeps compact top-bar controls touch-sized on coarse pointers', async ({ browser }) => {
    const context = await browser.newContext({
      hasTouch: true,
      viewport: { width: 320, height: 720 },
    });
    const touchPage = await context.newPage();
    try {
      await touchPage.goto('/test/acceptance/review-harness/index.html?responsive=full');
      await touchPage.locator('#root').evaluate((element) => {
        element.setAttribute('data-production-root', 'true');
      });
      expect(await touchPage.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

      const chrome = touchPage.locator('[data-review-chrome]');
      for (const width of [760, 641, 521, 481, 390, 361, 320]) {
        await touchPage.setViewportSize({ width, height: 720 });
        await touchPage.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        const chromeButtons = chrome.locator(':scope > .review-chrome__identity button, :scope > .review-chrome__left-controls button, :scope > .review-chrome__viewer-controls button');
        const chromeButtonHeights = await chromeButtons.evaluateAll((buttons) => (
          buttons.map((button) => button.getBoundingClientRect().height)
        ));
        expect(chromeButtonHeights.length).toBeGreaterThan(0);
        expect(chromeButtonHeights.every((height) => height >= 44)).toBe(true);
        const sizingIconWidths = await chrome.locator(
          '[data-review-chrome-sizing-rack] .review-chrome__icon-control',
        ).evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().width));
        expect(sizingIconWidths.length).toBeGreaterThan(0);
        expect(sizingIconWidths.every((iconWidth) => iconWidth >= 44)).toBe(true);
        const geometry = await chrome.evaluate((element) => {
          const bounds = (selector: string) => element.querySelector<HTMLElement>(selector)?.getBoundingClientRect().toJSON();
          const chromeBounds = element.getBoundingClientRect();
          return {
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            chrome: chromeBounds.toJSON(),
            identity: bounds(':scope > .review-chrome__identity'),
            controls: bounds(':scope > .review-chrome__viewer-controls'),
            saveIdentity: bounds(':scope > .review-chrome__identity .review-chrome__save-identity'),
            copy: bounds(':scope > .review-chrome__left-controls [data-review-copy-link]'),
            filename: bounds(':scope > .review-chrome__identity .review-chrome__filename'),
            recoveryDisplay: element.querySelector<HTMLElement>(':scope > .review-chrome__identity .review-chrome__save-recovery') === null
              ? null
              : getComputedStyle(element.querySelector<HTMLElement>(':scope > .review-chrome__identity .review-chrome__save-recovery')!).display,
            contextDisplay: getComputedStyle(element.querySelector<HTMLElement>(':scope > .review-chrome__identity .review-chrome__context')!).display,
          };
        });
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
        expect(geometry.identity).toBeDefined();
        expect(geometry.controls).toBeDefined();
        expect(geometry.saveIdentity).toBeDefined();
        expect(geometry.copy).toBeDefined();
        expect(geometry.copy!.width).toBeGreaterThanOrEqual(44);
        expect(geometry.filename).toBeDefined();
        expect(geometry.identity!.x + geometry.identity!.width)
          .toBeLessThanOrEqual(geometry.controls!.x + 0.5);
        if (width === 320) {
          expect(geometry.chrome.x).toBeLessThanOrEqual(geometry.saveIdentity!.x + 0.5);
          expect(geometry.saveIdentity!.x + geometry.saveIdentity!.width)
            .toBeLessThanOrEqual(geometry.copy!.x + 0.5);
          expect(geometry.controls!.x + geometry.controls!.width)
            .toBeLessThanOrEqual(geometry.chrome.x + geometry.chrome.width + 0.5);
          expect(geometry.recoveryDisplay).toBeNull();
          expect(geometry.contextDisplay).toBe('none');
        }
      }

      // The measured presentation can vary with platform font metrics; the
      // geometry and 44px touch targets above are the public contract.
      await expect(chrome.getByRole('button', { name: 'Open zoom controls' })).toBeVisible();

      await touchPage.getByRole('button', {
        name: 'Page 3 of 12. Open page navigation',
      }).tap();
      const menu = touchPage.getByRole('menu', { name: 'Page navigation' });
      await expect(menu).toBeVisible();
      const menuButtonHeights = await menu.locator('button').evaluateAll((buttons) => (
        buttons.map((button) => button.getBoundingClientRect().height)
      ));
      expect(menuButtonHeights.length).toBeGreaterThan(0);
      for (const height of menuButtonHeights) expect(height).toBeGreaterThanOrEqual(44);
      await touchPage.getByRole('button', {
        name: 'Page 3 of 12. Open page navigation',
      }).tap();
      await expect(menu).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('cancels page editing with Escape without closing the Annotation Tray', async ({ page }) => {
    const { annotations, workspace } = await openAnnotationsWorkspace(page);
    const currentPage = page.getByRole('textbox', {
      name: 'Current page 3 of 12. Enter a page number',
    });
    await currentPage.fill('9');
    await currentPage.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      isComposing: true,
    });
    await expect(currentPage).toBeFocused();
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '',
    );
    await currentPage.press('Escape');

    await expect(currentPage).toBeFocused();
    await expect(workspace).toBeVisible();
    await expect(annotations).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#review-tools-workspace')).toBeVisible();
    await expect(page.locator('[data-viewer-page-commands]')).toHaveAttribute(
      'data-viewer-page-commands',
      '',
    );
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '',
    );
  });

  test('preserves click-through when dirty or invalid page input blurs to another control', async ({ page }) => {
    const pageNumber = page.locator('.review-chrome__page-input');
    const pageDisclosure = page.getByRole('button', {
      name: 'Page 3 of 12. Open page navigation',
    });
    await pageNumber.fill('5');
    await pageDisclosure.click();
    await expect(page.getByRole('menu', { name: 'Page navigation' })).toBeVisible();
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '5',
    );

    await page.keyboard.press('Escape');
    await pageNumber.fill('1.5');
    const zoomInput = page.locator('.review-chrome__zoom-input');
    await zoomInput.click();
    await expect(zoomInput).toBeFocused();
    await expect(pageNumber).toHaveValue('5');
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '5',
    );
  });

  test('clamps signed page drafts, rejects malformed or unsafe values, and cancels invalid blur', async ({ page }) => {
    const pageNumber = page.locator('.review-chrome__page-input');
    await pageNumber.fill('0');
    await pageNumber.press('Enter');
    await expect(pageNumber).toHaveValue('1');

    await pageNumber.fill('+40');
    await pageNumber.press('Enter');
    await expect(pageNumber).toHaveValue('12');

    await pageNumber.fill('12');
    await pageNumber.press('Enter');
    await expect(page.locator('[data-viewer-page-commands]')).toHaveAttribute(
      'data-viewer-page-commands',
      'go:1,go:12',
    );
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '1,12',
    );

    await pageNumber.fill('1.5');
    await pageNumber.press('Enter');

    const rangeError = page.getByRole('alert');
    await expect(pageNumber).toHaveAttribute('aria-invalid', 'true');
    const rangeErrorId = await rangeError.getAttribute('id');
    expect(rangeErrorId).toBeTruthy();
    await expect(pageNumber).toHaveAttribute('aria-describedby', rangeErrorId!);
    await expect(pageNumber).toHaveAttribute('aria-errormessage', rangeErrorId!);
    await expect(rangeError).toHaveText('Enter a whole page number from 1 to 12');
    await expect(page.locator('[data-viewer-page-commands]')).toHaveAttribute(
      'data-viewer-page-commands',
      'go:1,go:12',
    );
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '1,12',
    );

    await pageNumber.fill('1e1');
    await expect(pageNumber).toHaveAttribute('aria-invalid', 'false');
    await expect(rangeError).toHaveCount(0);
    await pageNumber.press('Enter');
    await expect(pageNumber).toHaveAttribute('aria-invalid', 'true');
    await expect(rangeError).toHaveText('Enter a whole page number from 1 to 12');

    await pageNumber.fill('9007199254740992');
    await pageNumber.press('Enter');
    await expect(pageNumber).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('[data-viewer-page-commands]')).toHaveAttribute(
      'data-viewer-page-commands',
      'go:1,go:12',
    );
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '1,12',
    );

    await pageNumber.fill('');
    await expect(pageNumber).toHaveAttribute('aria-invalid', 'false');
    await page.getByRole('textbox', { name: 'Native input' }).focus();

    await expect(pageNumber).toHaveValue('12');
    await expect(pageNumber).toBeVisible();
    await expect(page.locator('[data-viewer-page-commands]')).toHaveAttribute(
      'data-viewer-page-commands',
      'go:1,go:12',
    );
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '1,12',
    );
  });

  test('does not offer page editing while page controls are unavailable', async ({ page }) => {
    await page.getByRole('button', { name: 'Make page controls unavailable' }).evaluate(element => (element as HTMLButtonElement).click());

    await expect(page.getByLabel('Current page unavailable')).toHaveText('—');
    await expect(page.getByRole('textbox', { name: /Enter a page number/u })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Page navigation unavailable' })).toBeDisabled();
  });

  test('runs Previous and Next exactly once from the page menu', async ({ page }) => {
    const disclosure = page.getByRole('button', { name: 'Page 3 of 12. Open page navigation' });
    await disclosure.click();
    let nextPage = page.getByRole('menuitem', { name: 'Next page' });
    await nextPage.click();

    await expect(nextPage).toBeFocused();
    await expect(page.getByRole('textbox', {
      name: 'Current page 4 of 12. Enter a page number',
    })).toBeVisible();
    await expect(page.locator('[data-viewer-page-commands]')).toHaveAttribute(
      'data-viewer-page-commands',
      'next:4',
    );
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '',
    );

    const previousPage = page.getByRole('menuitem', { name: 'Previous page' });
    await previousPage.click();

    await expect(previousPage).toBeFocused();
    await expect(page.getByRole('textbox', {
      name: 'Current page 3 of 12. Enter a page number',
    })).toBeVisible();
    await expect(page.locator('[data-viewer-page-commands]')).toHaveAttribute(
      'data-viewer-page-commands',
      'next:4,previous:3',
    );
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '',
    );

    nextPage = page.getByRole('menuitem', { name: 'Next page' });
    await nextPage.click();

    await expect(nextPage).toBeFocused();
    await expect(page.getByRole('textbox', {
      name: 'Current page 4 of 12. Enter a page number',
    })).toBeVisible();
    await expect(page.locator('[data-viewer-page-commands]')).toHaveAttribute(
      'data-viewer-page-commands',
      'next:4,previous:3,next:4',
    );
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '',
    );
  });

  test('edits viewer-published zoom through Enter and ordinary blur', async ({ page }) => {
    const zoomLevel = page.getByRole('textbox', {
      name: 'Current zoom 110 percent. Enter a zoom percentage',
    });
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    await zoomLevel.click();

    let zoomPercentage = zoomLevel;
    await expect(zoomPercentage).toBeFocused();
    await expect(zoomPercentage).toHaveValue('110');
    await zoomPercentage.fill('125');
    await expect(zoomPercentage).toHaveValue('125');
    await zoomPercentage.press('Enter');

    await expect(page.getByRole('textbox', {
      name: 'Current zoom 125 percent. Enter a zoom percentage',
    })).toBeFocused();
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:125;commands:go:125;fit:',
    );

    await page.getByRole('textbox', {
      name: 'Current zoom 125 percent. Enter a zoom percentage',
    }).click();
    zoomPercentage = page.getByRole('textbox', {
      name: 'Current zoom 125 percent. Enter a zoom percentage',
    });
    await zoomPercentage.fill('140');
    const nativeInput = page.getByRole('textbox', { name: 'Native input' });
    await nativeInput.focus();

    await expect(nativeInput).toBeFocused();
    await expect(page.getByRole('textbox', {
      name: 'Current zoom 140 percent. Enter a zoom percentage',
    })).toBeVisible();
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:125|140;commands:go:125|go:140;fit:',
    );
  });

  test('keeps an exact fitted scale when an unchanged zoom edit closes', async ({ page }) => {
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    await page.getByRole('button', { name: 'Open zoom controls' }).hover();
    await page.getByRole('menuitem', { name: 'Fit width' }).click();
    const fitResult = page.getByRole('textbox', {
      name: 'Current zoom 88 percent. Enter a zoom percentage',
    });
    await fitResult.click();
    const zoomPercentage = fitResult;
    await zoomPercentage.press('Enter');
    await expect(fitResult).toBeFocused();
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:;commands:fit:88;fit:fit',
    );

    await fitResult.click();
    await page.getByRole('textbox', { name: 'Native input' }).focus();
    await expect(fitResult).toHaveValue('88');
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:;commands:fit:88;fit:fit',
    );
  });

  test('clamps signed zoom drafts, rejects malformed or unsafe values, and cancels invalid blur', async ({ page }) => {
    const zoomPercentage = page.locator('.review-chrome__zoom-input');
    await zoomPercentage.fill('-1');
    await zoomPercentage.press('Enter');
    await expect(zoomPercentage).toHaveValue('20');

    await zoomPercentage.fill('+9000');
    await zoomPercentage.press('Enter');
    await expect(zoomPercentage).toHaveValue('6000');

    await zoomPercentage.fill('6000');
    await zoomPercentage.press('Enter');
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:20|6000;commands:go:20|go:6000;fit:',
    );

    await zoomPercentage.fill('100.5');
    await zoomPercentage.press('Enter');

    const rangeError = page.getByRole('alert');
    await expect(zoomPercentage).toBeFocused();
    await expect(zoomPercentage).toHaveAttribute('aria-invalid', 'true');
    const rangeErrorId = await rangeError.getAttribute('id');
    expect(rangeErrorId).toBeTruthy();
    await expect(zoomPercentage).toHaveAttribute('aria-describedby', rangeErrorId!);
    await expect(zoomPercentage).toHaveAttribute('aria-errormessage', rangeErrorId!);
    await expect(rangeError).toHaveText('Enter a whole zoom percentage from 20 to 6000');
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:20|6000;commands:go:20|go:6000;fit:',
    );

    await zoomPercentage.fill('1e2');
    await expect(zoomPercentage).toHaveAttribute('aria-invalid', 'false');
    await expect(rangeError).toHaveCount(0);
    await zoomPercentage.press('Enter');
    await expect(zoomPercentage).toHaveAttribute('aria-invalid', 'true');

    await zoomPercentage.fill('9007199254740992');
    await zoomPercentage.press('Enter');
    await expect(zoomPercentage).toHaveAttribute('aria-invalid', 'true');

    await zoomPercentage.fill('');
    await page.getByRole('textbox', { name: 'Native input' }).focus();
    await expect(zoomPercentage).toHaveValue('6000');
    await expect(zoomPercentage).toBeVisible();
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:20|6000;commands:go:20|go:6000;fit:',
    );
  });

  test('cancels zoom editing with Escape without closing workspace or Finish', async ({ page }) => {
    const { annotations, workspace } = await openAnnotationsWorkspace(page);
    const zoomLevel = page.getByRole('textbox', {
      name: /Current zoom \d+ percent\. Enter a zoom percentage/u,
    });
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    const originalZoom = await zoomLevel.inputValue();
    const originalRequests = await page.locator('[data-viewer-zoom-requests]').getAttribute('data-viewer-zoom-requests');
    await zoomLevel.click();
    const zoomPercentage = zoomLevel;
    await zoomPercentage.fill('125');

    await zoomPercentage.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      isComposing: true,
    });
    await expect(zoomPercentage).toBeFocused();
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      originalRequests!,
    );

    await zoomPercentage.press('Escape');
    await expect(zoomLevel).toBeFocused();
    await expect(zoomLevel).toHaveValue(originalZoom);
    await expect(workspace).toBeVisible();
    await expect(annotations).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#review-tools-workspace')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Finish review' })).toHaveCount(0);
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      originalRequests!,
    );
  });

  test('runs Zoom Out, Zoom In, and Fit Width exactly once from the zoom menu', async ({ page }) => {
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    await page.getByRole('button', { name: 'Open zoom controls' }).hover();
    const zoomOut = page.getByRole('menuitem', { name: 'Zoom out' });
    await zoomOut.click();
    await expect(zoomOut).toBeFocused();
    await expect(page.getByRole('textbox', {
      name: 'Current zoom 100 percent. Enter a zoom percentage',
    })).toBeVisible();

    const zoomIn = page.getByRole('menuitem', { name: 'Zoom in' });
    await zoomIn.click();
    await expect(zoomIn).toBeFocused();
    await expect(page.getByRole('textbox', {
      name: 'Current zoom 110 percent. Enter a zoom percentage',
    })).toBeVisible();

    const fitWidth = page.getByRole('menuitem', { name: 'Fit width' });
    await fitWidth.click();
    await expect(fitWidth).toBeFocused();
    await expect(page.getByRole('textbox', {
      name: 'Current zoom 88 percent. Enter a zoom percentage',
    })).toBeVisible();

    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:;commands:out:100|in:110|fit:88;fit:fit',
    );
  });

  test('does not offer zoom editing or Fit Width while zoom is unavailable', async ({ page }) => {
    await page.getByRole('button', { name: 'Make zoom controls unavailable' }).evaluate(element => (element as HTMLButtonElement).click());

    await expect(page.getByLabel('Zoom unavailable')).toHaveText('—');
    await expect(page.getByRole('textbox', { name: /Enter a zoom percentage/u })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open zoom controls' })).toBeDisabled();
  });

  test('keeps the frozen authoring session after rejection and preserves a newer selection', async ({ page }) => {
    const selectionActions = page.getByRole('toolbar', { name: 'Selection review actions' });

    await page.getByRole('button', { name: 'Reject next command' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(selectionActions).toBeVisible();

    await page.getByRole('button', { name: 'Reject next command' }).click();
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    const replacement = page.getByRole('textbox', { name: 'Replacement' });
    await replacement.fill('rejected replacement');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(replacement).toHaveValue('rejected replacement');
    await expect(page.locator('.review-workspace__status')).toContainText('Review changed elsewhere');

    await page.getByRole('button', { name: 'Use selection' }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(replacement).toHaveValue('rejected replacement');
    await page.getByRole('application', { name: 'PDF review canvas' }).focus();
    await page.keyboard.press('Alt+Shift+N');
    await expect(page.getByRole('button', { name: 'Place Page Note' })).toHaveCount(0);
    await expect(replacement).toHaveValue('rejected replacement');

    await replacement.fill('accepted replacement');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(selectionActions).toBeVisible();
  });

  test('gives the composer temporary tray ownership and restores exact workspace state', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.getByRole('button', { name: 'Seed annotations' }).click();
    await openAnnotationsWorkspace(page);
    const workspace = page.locator('#review-tools-workspace');
    const references = page.locator('#review-workspace');
    const panel = page.locator('[data-annotation-scroll-viewport]');
    const rows = panel.locator('[data-review-item]');
    const origin = rows.nth(7);
    const originContent = origin.locator('.annotation-item__content');
    const originEdit = origin.locator('[data-row-action="edit"]');
    await originContent.click();
    await panel.evaluate((element) => { element.scrollTop = 137; });
    const restoredScroll = await panel.evaluate((element) => element.scrollTop);
    expect(restoredScroll).toBeGreaterThan(0);
    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    const canvasBefore = await canvas.boundingBox();
    await workspace.evaluate((element) => element.setAttribute('data-takeover-mount-probe', 'stable'));
    await references.evaluate((element) => element.setAttribute('data-takeover-mount-probe', 'stable'));

    await originEdit.evaluate((button: HTMLButtonElement) => button.click());
    const composer = page.getByRole('region', { name: 'Edit Page Note' });
    await expect(composer).toBeVisible();
    await expect(workspace).toHaveAttribute('data-authoring-takeover', 'true');
    await expect(references).toHaveAttribute('data-authoring-takeover', 'true');
    await expect(workspace).toHaveAttribute('inert', '');
    await expect(references).toHaveAttribute('inert', '');
    await expect(workspace).toHaveAttribute('aria-hidden', 'false');
    await expect(references).toHaveAttribute('aria-hidden', 'true');
    await expect(workspace).toBeVisible();
    await expect(references).not.toBeVisible();
    await expect(page.locator('[data-workspace-edge-rail]')).toHaveCount(0);
    await expect(page.locator('[data-reference-resize-handle]')).toHaveCount(0);
    await expect(origin).toHaveAttribute('data-active', 'true');

    await page.locator('[data-owned-focus-id]').nth(2).click();
    await expect(page.locator('[data-workspace-mode="annotations"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(origin).toHaveAttribute('data-active', 'true');
    await panel.evaluate((element) => { element.scrollTop = 0; });

    await composer.evaluate((element) => element.setAttribute('data-composer-mount-probe', 'stable'));
    await page.setViewportSize({ width: 840, height: 760 });
    const stage = page.locator('[data-review-stage]');
    await expect(stage).toHaveAttribute('data-annotation-presentation', 'bottom');
    const [tabletComposer, tabletStage] = await Promise.all([
      composer.boundingBox(),
      stage.boundingBox(),
    ]);
    expect(tabletComposer).not.toBeNull();
    expect(tabletStage).not.toBeNull();
    expect(tabletComposer!.x).toBeGreaterThanOrEqual(tabletStage!.x);
    expect(tabletComposer!.x + tabletComposer!.width)
      .toBeLessThanOrEqual(tabletStage!.x + tabletStage!.width);
    expect(tabletComposer!.y + tabletComposer!.height).toBeLessThanOrEqual(760);

    await page.setViewportSize({ width: 520, height: 420 });
    await expect(composer).toHaveAttribute('data-composer-mount-probe', 'stable');
    const narrowInput = composer.locator('textarea');
    await narrowInput.focus();
    await expect.poll(async () => {
      const [input, body] = await Promise.all([
        narrowInput.boundingBox(),
        composer.locator('.comment-composer__body').boundingBox(),
      ]);
      return input !== null && body !== null
        && input.y + input.height <= body.y + body.height + 1;
    }).toBe(true);
    const [composerBounds, titleBounds, editorBounds, actionBounds, bodyBounds] = await Promise.all([
      composer.boundingBox(),
      composer.locator('.comment-composer__header').boundingBox(),
      narrowInput.boundingBox(),
      composer.locator('.comment-composer__actions').boundingBox(),
      composer.locator('.comment-composer__body').boundingBox(),
    ]);
    expect(composerBounds).not.toBeNull();
    expect(titleBounds).not.toBeNull();
    expect(editorBounds).not.toBeNull();
    expect(actionBounds).not.toBeNull();
    expect(bodyBounds).not.toBeNull();
    expect(composerBounds!.height).toBeLessThanOrEqual(420);
    expect(titleBounds!.y).toBeGreaterThanOrEqual(0);
    expect(actionBounds!.y + actionBounds!.height).toBeLessThanOrEqual(420);
    expect(editorBounds!.y + editorBounds!.height)
      .toBeLessThanOrEqual(bodyBounds!.y + bodyBounds!.height + 1);
    await page.setViewportSize({ width: 1280, height: 760 });
    await expect(composer).toHaveAttribute('data-composer-mount-probe', 'stable');
    await composer.getByRole('button', { name: 'Cancel' }).click();

    await expect(composer).toHaveCount(0);
    await expect(workspace).toHaveAttribute('data-takeover-mount-probe', 'stable');
    await expect(references).toHaveAttribute('data-takeover-mount-probe', 'stable');
    await expect(workspace).not.toHaveAttribute('data-authoring-takeover', 'true');
    await expect(workspace).not.toHaveAttribute('inert', '');
    await expect(workspace).toHaveAttribute('aria-hidden', 'false');
    await expect(origin).toHaveAttribute('data-active', 'true');
    await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBe(restoredScroll);
    await expect(originEdit).toBeFocused();
    expect(await canvas.boundingBox()).toEqual(canvasBefore);

    await origin.hover();
    await originEdit.click();
    const acceptedComposer = page.getByRole('region', { name: 'Edit Page Note' });
    await acceptedComposer.getByRole('textbox', { name: 'Comment' }).fill('Applied from takeover');
    await panel.evaluate((element) => { element.scrollTop = 0; });
    await acceptedComposer.getByRole('button', { name: 'Apply' }).click();
    await expect(acceptedComposer).toHaveCount(0);
    await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBe(restoredScroll);
    await expect(origin).toHaveAttribute('data-active', 'true');
    await expect(originEdit).toBeFocused();
  });

  test('reads a full annotation without moving the PDF and restores list selection, scroll, and trigger focus', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.getByRole('button', { name: 'Seed annotations' }).click();
    await page.getByRole('button', { name: 'Seed long annotation' }).click();
    await openAnnotationsWorkspace(page);
    const mainViewport = await installMainScrollport(page);

    const panel = page.locator('[data-annotation-scroll-viewport]');
    const rows = panel.locator('[data-review-item]');
    const previouslySelected = rows.first();
    await previouslySelected.locator('.annotation-item__content').click();
    const previousId = await previouslySelected.getAttribute('data-review-item');
    const navigationBefore = await page.locator('[data-navigated]').getAttribute('data-navigated');
    const zoomBefore = await page.locator('[data-viewer-zoom-requests]')
      .getAttribute('data-viewer-zoom-requests');

    const openingRow = rows.filter({
      has: page.getByRole('button', { name: /Read full Page Note annotation on page 3/u }),
    });
    const more = openingRow.getByRole('button', { name: /Read full Page Note annotation on page 3/u });
    await openingRow.scrollIntoViewIfNeeded();
    await expect(more).toBeVisible();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await openingRow.scrollIntoViewIfNeeded();
    const scrollBefore = await panel.evaluate((element) => element.scrollTop);

    await more.evaluate((button) => (button as HTMLButtonElement).click());
    const reader = page.getByRole('region', { name: 'Full Page Note annotation on page 3' });
    const back = page.locator('[data-full-annotation-action="back"]');
    await expect(reader).toBeVisible();
    await expect(back).toBeFocused();
    await expect(reader).toContainText(
      'This long annotation explains the identification concern',
    );
    await expect(reader).not.toContainText('Original text');
    await expect(reader).not.toContainText('Full annotation —');
    await expect(page.locator('[data-navigated]')).toHaveAttribute('data-navigated', navigationBefore ?? '');
    await expect(page.locator('[data-viewer-zoom-requests]'))
      .toHaveAttribute('data-viewer-zoom-requests', zoomBefore ?? '');
    await expect(mainViewport).toHaveJSProperty('scrollTop', 137);
    await expect(mainViewport).toHaveJSProperty('scrollLeft', 41);
    await expect(panel.locator('[data-review-item]')).toHaveCount(0);

    await back.press('Enter');
    await expect(page.locator('[data-full-annotation-reader="true"]')).toHaveCount(0);
    await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBe(scrollBefore);
    await expect(panel.locator(`[data-review-item="${previousId}"]`)).toHaveAttribute('data-active', 'true');
    await expect(more).toBeFocused();
    await expect(page.locator('[data-navigated]')).toHaveAttribute('data-navigated', navigationBefore ?? '');
    await expect(page.locator('[data-viewer-zoom-requests]'))
      .toHaveAttribute('data-viewer-zoom-requests', zoomBefore ?? '');
    await expect(mainViewport).toHaveJSProperty('scrollTop', 137);
    await expect(mainViewport).toHaveJSProperty('scrollLeft', 41);
  });

  test('cancels reader editing back to the same full annotation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.getByRole('button', { name: 'Seed long annotation' }).click();
    await openAnnotationsWorkspace(page);

    const row = page.locator('[data-review-item]').last();
    await row.getByRole('button', { name: /Read full Page Note annotation/u }).click();
    const reader = page.locator('[data-full-annotation-reader="true"]');
    const edit = page.locator('[data-full-annotation-action="edit"]');
    await edit.click();

    const composer = page.getByRole('region', { name: 'Edit Page Note' });
    await expect(composer).toBeVisible();
    await composer.getByRole('button', { name: 'Cancel' }).click();

    await expect(composer).toHaveCount(0);
    await expect(reader).toContainText('This long annotation explains the identification concern');
    await expect(edit).toBeFocused();
  });

  test('applies reader edits and refreshes the live full annotation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.getByRole('button', { name: 'Seed long annotation' }).click();
    await openAnnotationsWorkspace(page);

    await page.locator('[data-review-item]').last()
      .getByRole('button', { name: /Read full Page Note annotation/u }).click();
    const reader = page.locator('[data-full-annotation-reader="true"]');
    const edit = page.locator('[data-full-annotation-action="edit"]');
    await edit.click();
    const composer = page.getByRole('region', { name: 'Edit Page Note' });
    const refreshed = 'Applied reader text stays long enough to remain a full annotation. '.repeat(6);
    await composer.getByRole('textbox', { name: 'Comment' }).fill(refreshed);
    await composer.getByRole('button', { name: 'Apply', exact: true }).click();

    await expect(composer).toHaveCount(0);
    await expect(reader).toContainText(refreshed);
    await expect(edit).toBeFocused();
  });

  test('returns to the row when an accepted reader edit no longer overflows', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.getByRole('button', { name: 'Seed long annotation' }).click();
    await openAnnotationsWorkspace(page);

    const row = page.locator('[data-review-item]').filter({
      has: page.getByRole('button', { name: /Read full Page Note annotation/u }),
    });
    const itemId = await row.getAttribute('data-review-item');
    await row.getByRole('button', { name: /Read full Page Note annotation/u }).click();
    const reader = page.locator('[data-full-annotation-reader="true"]');
    await page.locator('[data-full-annotation-action="edit"]').click();
    const composer = page.getByRole('region', { name: 'Edit Page Note' });
    await composer.getByRole('textbox', { name: 'Comment' }).fill('Short note.');
    await composer.getByRole('button', { name: 'Apply', exact: true }).click();

    await expect(reader).toHaveCount(0);
    const restoredRow = page.locator(`[data-review-item="${itemId}"]`);
    await expect(restoredRow).toHaveAttribute('data-active', 'true');
    await expect(restoredRow.locator('[data-read-full-annotation="true"]')).toBeHidden();
    await expect(restoredRow.locator('.annotation-item__navigation')).toBeFocused();
  });

  test('keeps newer reader focus when Back restoration frames are superseded', async ({ page }) => {
    await page.getByRole('button', { name: 'Seed long annotation' }).click();
    await page.getByRole('button', { name: 'Seed long annotation' }).click();
    await openAnnotationsWorkspace(page);

    const rows = page.locator('[data-review-item]').filter({
      has: page.getByRole('button', { name: /Read full Page Note annotation/u }),
    });
    const firstId = await rows.first().getAttribute('data-review-item');
    const secondId = await rows.last().getAttribute('data-review-item');
    const navigationBefore = await page.locator('[data-navigated]').getAttribute('data-navigated');
    expect(firstId).not.toBe(secondId);
    await rows.first().getByRole('button', { name: /Read full Page Note annotation/u }).click();
    await expect(page.locator('[data-full-annotation-reader="true"]')).toBeVisible();

    await page.evaluate(() => {
      const originalRequest = window.requestAnimationFrame.bind(window);
      const originalCancel = window.cancelAnimationFrame.bind(window);
      let nextId = 100_000;
      const callbacks = new Map<number, FrameRequestCallback>();
      Object.assign(window, {
        __heldAnnotationFrames: { callbacks, originalRequest, originalCancel },
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          const id = nextId;
          nextId += 1;
          callbacks.set(id, callback);
          return id;
        },
        cancelAnimationFrame: (id: number) => callbacks.delete(id),
      });
      (document.querySelector('.full-annotation-reader__back') as HTMLButtonElement).click();
    });
    await expect(page.locator(`[data-review-item="${secondId}"]`)).toBeVisible();
    await page.locator(`[data-review-item="${secondId}"]`)
      .getByRole('button', { name: /Read full Page Note annotation/u })
      .evaluate((button) => (button as HTMLButtonElement).click());

    await page.evaluate(() => {
      const held = (window as typeof window & {
        __heldAnnotationFrames: {
          callbacks: Map<number, FrameRequestCallback>;
          originalRequest: typeof window.requestAnimationFrame;
          originalCancel: typeof window.cancelAnimationFrame;
        };
      }).__heldAnnotationFrames;
      window.requestAnimationFrame = held.originalRequest;
      window.cancelAnimationFrame = held.originalCancel;
      for (const callback of held.callbacks.values()) callback(performance.now());
      delete (window as unknown as { __heldAnnotationFrames?: unknown }).__heldAnnotationFrames;
    });
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));

    await expect(page.locator('[data-full-annotation-action="back"]')).toBeFocused();
    await expect(page.locator('[data-navigated]')).toHaveAttribute('data-navigated', navigationBefore ?? '');
    await expect(page.locator('[data-annotation-scroll-viewport]')).toHaveJSProperty('scrollTop', 0);
  });

  test('opens an imported full reader without moving the main PDF and shows Return only when available', async ({ page }) => {
    const mainViewport = await installMainScrollport(page);
    await openAnnotationsWorkspace(page);
    const annotations = page.getByRole('region', { name: 'Annotations', exact: true });
    await annotations.getByRole('button', {
      name: /Read full Highlight annotation on page 1/u,
    }).click();

    await expect(page.locator('[data-navigated]')).toHaveAttribute('data-navigated', 'none');
    await expect(mainViewport).toHaveJSProperty('scrollTop', 137);
    await expect(mainViewport).toHaveJSProperty('scrollLeft', 41);
    const reader = page.locator('[data-full-annotation-reader="true"]');
    await expect(reader).toContainText('Source comment with enough authored detail');
    await expect(reader.getByRole('button', { name: /Return to/u })).toHaveCount(0);
    await expect(page.locator('[data-full-annotation-action="edit"]')).toHaveCount(0);
  });

  test('rejects stale document and imported-generation restoration state', async ({ page }) => {
    await page.getByRole('button', { name: 'Seed annotations' }).click();
    await page.getByRole('button', { name: 'Seed long annotation' }).click();
    await openAnnotationsWorkspace(page);
    const panel = page.locator('[data-annotation-scroll-viewport]');
    const ownedRow = page.locator('[data-review-item]').filter({
      has: page.getByRole('button', { name: /Read full Page Note annotation/u }),
    }).last();
    await ownedRow.scrollIntoViewIfNeeded();
    await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await ownedRow.getByRole('button', { name: /Read full Page Note annotation/u }).click();
    await page.getByRole('button', { name: 'Replace source authority' }).evaluate((button) => {
      (button as HTMLButtonElement).click();
    });

    await expect(page.locator('[data-full-annotation-reader="true"]')).toHaveCount(0);
    await expect(page.locator('#workspace-panel-annotations')).toBeFocused();
    await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBe(0);

    const annotations = page.getByRole('region', { name: 'Annotations', exact: true });
    await annotations.getByRole('button', {
      name: /Read full Highlight annotation on page 1/u,
    }).click();
    await page.getByRole('button', { name: 'Refresh existing annotations' }).evaluate((button) => {
      (button as HTMLButtonElement).click();
    });
    await expect(page.locator('[data-full-annotation-reader="true"]')).toHaveCount(0);
    await expect(page.locator('#workspace-panel-annotations')).toBeFocused();
  });

  test('clearing a reader Highlight comment restores its exact source-only row', async ({ page }) => {
    const longComment = 'This highlight comment is intentionally long enough to overflow the compact annotation card. '.repeat(5);
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    const composer = page.getByRole('region', { name: 'Highlight Comment' });
    await composer.getByRole('textbox', { name: 'Comment (optional)' }).fill(longComment);
    await composer.getByRole('button', { name: 'Save', exact: true }).click();
    await openAnnotationsWorkspace(page);

    const row = page.locator('[data-review-item][data-annotation-kind="highlight"]');
    const itemId = await row.getAttribute('data-review-item');
    await row.getByRole('button', { name: /Read full Highlight annotation/u }).click();
    const reader = page.locator('[data-full-annotation-reader="true"]');
    await page.locator('[data-full-annotation-action="edit"]').click();
    const editor = page.getByRole('region', { name: 'Edit Highlight' });
    await editor.getByRole('textbox', { name: 'Comment (optional)' }).fill('');
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();

    await expect(editor).toHaveCount(0);
    await expect(reader).toHaveCount(0);
    const restoredRow = page.locator(`[data-review-item="${itemId}"]`);
    await expect(restoredRow).toHaveAttribute('data-active', 'true');
    await expect(restoredRow.locator('[data-read-full-annotation="true"]')).toHaveCount(0);
    await expect(restoredRow.locator('.annotation-item__navigation')).toBeFocused();
  });

  test('falls back to row navigation when a restored More control is hidden', async ({ page }) => {
    await page.getByRole('button', { name: 'Seed long annotation' }).click();
    await openAnnotationsWorkspace(page);
    const row = page.locator('[data-review-item]').last();
    await row.getByRole('button', { name: /Read full Page Note annotation/u }).click();
    await page.addStyleTag({ content: '[data-read-full-annotation="true"] { display: none !important; }' });

    await page.getByRole('button', { name: 'Back', exact: true }).press('Enter');

    await expect(row.locator('.annotation-item__navigation')).toBeFocused();
  });

  test('drops reader editing safely when its document or item authority becomes stale', async ({ page }) => {
    await page.getByRole('button', { name: 'Seed annotations' }).click();
    await page.getByRole('button', { name: 'Seed long annotation' }).click();
    await openAnnotationsWorkspace(page);
    const row = page.locator('[data-review-item]').filter({
      has: page.getByRole('button', { name: /Read full Page Note annotation/u }),
    }).last();
    const itemId = await row.getAttribute('data-review-item');
    await row.getByRole('button', { name: /Read full Page Note annotation/u }).click();
    await page.locator('[data-full-annotation-action="edit"]').click();

    await page.getByRole('button', { name: 'Replace source authority' }).evaluate((button) => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(page.getByRole('region', { name: 'Edit Page Note' })).toHaveCount(0);
    await expect(page.locator('[data-full-annotation-reader="true"]')).toHaveCount(0);
    await expect(page.locator(`[data-review-item="${itemId}"]`)).toBeVisible();

    await page.locator(`[data-review-item="${itemId}"]`)
      .locator('.annotation-item__navigation')
      .evaluate((button: HTMLButtonElement) => button.click());
    await page.locator(`[data-review-item="${itemId}"]`)
      .getByRole('button', { name: /Read full Page Note annotation/u }).click();
    await page.locator('[data-full-annotation-action="edit"]').click();
    await page.getByRole('button', { name: 'Remove active annotation' }).evaluate((button) => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(page.getByRole('region', { name: 'Edit Page Note' })).toHaveCount(0);
    await expect(page.locator('[data-full-annotation-reader="true"]')).toHaveCount(0);
    await expect(page.locator(`[data-review-item="${itemId}"]`)).toHaveCount(0);
    await expect(page.locator('[data-review-item]')).not.toHaveCount(0);
    await expect(page.locator('[data-review-item][data-active="true"]')).toHaveCount(0);
  });

  test('keeps a closed tray closed and gives Save Destination Escape precedence', async ({ page }) => {
    await page.getByRole('button', { name: 'Seed annotations' }).click();
    const workspace = await currentWorkspaceRail(page);
    await expect(workspace).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    const composer = page.getByRole('region', { name: 'Replacement' });
    const input = composer.getByRole('textbox', { name: 'Replacement' });
    const inputElement = page.locator('[data-comment-composer] textarea');
    await input.fill('draft survives save setup');

    await page.getByRole('button', { name: /Open automatic save options/u }).click();
    const destination = page.getByRole('dialog', { name: 'Choose Where to Save Annotations' });
    await expect(destination).toBeVisible();
    await expect(page.locator('[data-review-drawer-host]')).toHaveAttribute('inert', '');
    await inputElement.evaluate((element) => element.focus());
    await expect(inputElement).not.toBeFocused();
    await page.keyboard.press('Escape');

    await expect(destination).toHaveCount(0);
    await expect(composer).toBeVisible();
    await expect(inputElement).toHaveValue('draft survives save setup');
    await expect(inputElement).toBeFocused();
    await page.locator('[data-owned-focus-id]').first().click({ force: true });
    await expect(page.locator('#review-tools-workspace')).toHaveAttribute(
      'data-tools-workspace-open',
      'false',
    );
    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    await canvas.focus();
    await expect(canvas).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(composer).toHaveCount(0);
    await expect(workspace).toHaveAttribute('aria-expanded', 'false');
  });

  test('freezes review mutations while the composer yields focus to the PDF', async ({ page }) => {
    await page.getByRole('button', { name: 'Seed annotations' }).click();
    const revision = page.locator('[data-revision]');
    const revisionBefore = await revision.getAttribute('data-revision');
    const kindsBefore = await revision.getAttribute('data-kinds');
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    const composer = page.getByRole('region', { name: 'Replacement' });
    const editor = composer.getByRole('textbox', { name: 'Replacement' });
    await editor.fill('frozen draft');

    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    await canvas.focus();
    await expect(canvas).toBeFocused();
    await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Redo' })).toHaveCount(0);
    await page.keyboard.type('x');
    await page.keyboard.press('Delete');
    await page.keyboard.press('ControlOrMeta+z');

    await expect(revision).toHaveAttribute('data-revision', revisionBefore ?? '');
    await expect(revision).toHaveAttribute('data-kinds', kindsBefore ?? '');
    await expect(editor).toHaveValue('frozen draft');
    await editor.focus();
    await expect(editor).toBeFocused();
  });

  test('places a cross-page editor at its visible endpoint and preserves it when the passage moves offscreen', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?placement=targets');
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    const composer = page.getByRole('region', { name: 'Replacement' });
    const editor = composer.getByRole('textbox', { name: 'Replacement' });
    await editor.fill('cross-page draft survives movement');
    const preview = page.locator('[data-harness-authoring-preview]');
    await expect(preview).toHaveCount(1);
    await preview.first().evaluate((first) => {
      const second = first.cloneNode() as HTMLElement;
      const position = (element: HTMLElement, pageIndex: string, left: string, top: string) => {
        element.dataset.previewPage = pageIndex;
        Object.assign(element.style, {
          position: 'fixed',
          left,
          top,
          width: '80px',
          height: '18px',
          pointerEvents: 'none',
        });
      };
      position(first as HTMLElement, '0', '40px', '-240px');
      position(second, '1', '420px', '180px');
      first.parentElement?.append(second);
      window.dispatchEvent(new Event('resize'));
    });
    const visibleEndpoint = page.locator('[data-harness-authoring-preview][data-preview-page="1"]');
    await expect(visibleEndpoint).toBeVisible();
    await expect.poll(async () => {
      const [editorBounds, targetBounds] = await Promise.all([
        composer.boundingBox(),
        visibleEndpoint.boundingBox(),
      ]);
      if (!editorBounds || !targetBounds) return Number.POSITIVE_INFINITY;
      return Math.abs(editorBounds.x - (targetBounds.x + targetBounds.width + 12));
    }).toBeLessThan(4);
    const visiblePlacement = await composer.boundingBox();
    await preview.evaluateAll((elements) => {
      elements.forEach((element) => {
        (element as HTMLElement).style.top = '-400px';
      });
      window.dispatchEvent(new Event('resize'));
    });
    await expect(editor).toHaveValue('cross-page draft survives movement');
    await expect.poll(async () => {
      const bounds = await composer.boundingBox();
      return bounds === null || visiblePlacement === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(bounds.x - visiblePlacement.x);
    }).toBeLessThan(4);

    await page.setViewportSize({ width: 736, height: 700 });
    await expect(page.locator('[data-review-stage]')).toHaveAttribute(
      'data-workspace-presentation',
      'bottom',
    );
    await expect.poll(async () => {
      const bounds = await composer.boundingBox();
      return bounds === null ? Number.POSITIVE_INFINITY : bounds.x + bounds.width;
    }).toBeLessThanOrEqual(736);
    const resizedBounds = await composer.boundingBox();
    expect(resizedBounds).not.toBeNull();
    expect(resizedBounds!.x).toBeGreaterThanOrEqual(0);
    expect(resizedBounds!.x + resizedBounds!.width).toBeLessThanOrEqual(736);
    expect(resizedBounds!.y).toBeGreaterThanOrEqual(0);
    expect(resizedBounds!.y + resizedBounds!.height).toBeLessThanOrEqual(700);
    await expect(editor).toHaveValue('cross-page draft survives movement');

    await page.setViewportSize({ width: 320, height: 700 });
    await expect.poll(async () => {
      const bounds = await composer.boundingBox();
      return bounds === null ? Number.POSITIVE_INFINITY : bounds.x + bounds.width;
    }).toBeLessThanOrEqual(320);
    const compactBounds = await composer.boundingBox();
    expect(compactBounds).not.toBeNull();
    expect(compactBounds!.x).toBeGreaterThanOrEqual(0);
    expect(compactBounds!.x + compactBounds!.width).toBeLessThanOrEqual(320);
    expect(compactBounds!.y).toBeGreaterThanOrEqual(0);
    expect(compactBounds!.y + compactBounds!.height).toBeLessThanOrEqual(700);
    await expect(editor).toHaveValue('cross-page draft survives movement');
    await expect(editor).toBeFocused();
  });

  test('keeps the narrow editor reachable above a software keyboard visual viewport', async ({ page }) => {
    await page.addInitScript(() => {
      const viewport = new EventTarget();
      Object.defineProperties(viewport, {
        width: { value: 520 },
        height: { value: 260 },
        offsetLeft: { value: 0 },
        offsetTop: { value: 0 },
        pageLeft: { value: 0 },
        pageTop: { value: 0 },
        scale: { value: 1 },
      });
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: viewport,
      });
    });
    await page.setViewportSize({ width: 520, height: 760 });
    await page.reload();
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    const composer = page.getByRole('region', { name: 'Replacement' });
    const editor = composer.getByRole('textbox', { name: 'Replacement' });
    await editor.focus();
    await expect.poll(() => composer.evaluate((element) => {
      const body = element.querySelector<HTMLElement>('.comment-composer__body');
      const input = element.querySelector<HTMLElement>('.comment-composer__input');
      if (body === null || input === null) return false;
      const bodyBounds = body.getBoundingClientRect();
      const inputBounds = input.getBoundingClientRect();
      return Math.min(inputBounds.bottom, bodyBounds.bottom)
        - Math.max(inputBounds.top, bodyBounds.top) >= 44;
    })).toBe(true);
    const [header, body, input, actions] = await Promise.all([
      composer.locator('.comment-composer__header').boundingBox(),
      composer.locator('.comment-composer__body').boundingBox(),
      editor.boundingBox(),
      composer.locator('.comment-composer__actions').boundingBox(),
    ]);
    expect(header).not.toBeNull();
    expect(body).not.toBeNull();
    expect(input).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(header!.y).toBeGreaterThanOrEqual(0);
    expect(actions!.y + actions!.height).toBeLessThanOrEqual(260);
    expect(Math.min(input!.y + input!.height, body!.y + body!.height)
      - Math.max(input!.y, body!.y)).toBeGreaterThanOrEqual(44);
    await expect(editor).toBeFocused();
  });

  test('does not clear a newer selection when an older annotation finishes saving', async ({ page }) => {
    const selectionActions = page.getByRole('toolbar', { name: 'Selection review actions' });

    await page.getByRole('button', { name: 'Hold next command' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Use selection' }).click();
    await page.getByRole('button', { name: 'Release command' }).click();

    await expect(page.locator('[data-anchor-kind]')).toHaveAttribute('data-anchor-kind', 'selection');
    await expect(selectionActions).toBeVisible();
  });

  test('keeps canonical history, focus, and mounted draft state across the breakpoint', async ({ page }) => {
    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    await canvas.focus();
    await page.keyboard.press('r');
    const input = page.getByRole('textbox', { name: 'Replacement' });
    await input.fill('revised wording');
    await page.setViewportSize({ width: 320, height: 720 });
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await expect(input).toHaveValue('revised wording');
    await expect(page.locator('[data-review-stage]'))
      .toHaveAttribute('data-annotation-presentation', 'bottom');
    const inputBounds = await input.boundingBox();
    expect(inputBounds).not.toBeNull();
    expect(inputBounds!.x).toBeGreaterThanOrEqual(0);
    expect(inputBounds!.x + inputBounds!.width).toBeLessThanOrEqual(320);
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('[data-owned-mark]')).toHaveCount(0);
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(page.locator('[data-owned-mark="replace"]')).toHaveCount(1);

    await openAnnotationsWorkspace(page);
    await expect(page.locator('#review-tools-workspace')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close annotations' })).toHaveCount(0);
    await closeWorkspace(page);
    await openAnnotationsWorkspace(page);
    const entry = page.getByRole('button', { name: /Replace · Page 1/ });
    await entry.focus();
    await expect(entry).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-navigated]')).not.toHaveAttribute('data-navigated', 'none');
    const deleteEntry = page.getByRole('button', { name: 'Remove Replace annotation on page 1' });
    await deleteEntry.focus();
    await page.keyboard.press('Enter');
    const adjacentSource = page.locator('[data-existing-annotation][data-readonly="true"]')
      .getByRole('button', { name: /Highlight · Page 1/u });
    await expect(adjacentSource).toBeFocused();
  });

  test('keeps a focused delete-only row cohesive in the bottom annotation tray', async ({ page }) => {
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.locator('#root').evaluate((element) => element.setAttribute('data-production-root', 'true'));
    await page.setViewportSize({ width: 320, height: 720 });
    await openAnnotationsWorkspace(page);

    const drawer = page.locator('#review-tools-workspace');
    await expect(drawer).toHaveAttribute('data-workspace-presentation', 'bottom');

    const row = drawer.locator('[data-annotation-origin="owned"][data-annotation-kind="delete"]');
    const content = row.getByRole('button', { name: /Delete · Page 1/u });
    const action = row.getByRole('button', { name: 'Remove Delete annotation on page 1' });
    await page.keyboard.press('Tab');
    await content.focus();
    await expect(content).toBeFocused();

    await expect(action.locator('svg')).toHaveCount(1);
    await expect(action).toHaveText('');
    await expect(content).toHaveCSS('outline-style', 'solid');
    await expect(content).toHaveCSS('outline-width', '2px');
    await expect(content).toHaveCSS('outline-offset', '3px');
    await expect(row).toHaveCSS('outline-style', 'none');

    const kind = row.locator('.annotation-item__kind-icon');
    const pageNumber = row.locator('.annotation-item__page');
    const [kindBounds, pageBounds, actionBounds, rowBounds] = await Promise.all([
      kind.boundingBox(),
      pageNumber.boundingBox(),
      action.boundingBox(),
      row.boundingBox(),
    ]);
    expect(kindBounds).not.toBeNull();
    expect(pageBounds).not.toBeNull();
    expect(actionBounds).not.toBeNull();
    expect(rowBounds).not.toBeNull();
    await expect(kind).toHaveAttribute('title', 'Delete');
    expect(actionBounds!.x).toBeGreaterThanOrEqual(kindBounds!.x + kindBounds!.width);
    expect(pageBounds!.x + pageBounds!.width).toBeCloseTo(actionBounds!.x + actionBounds!.width, 0);
    await expect(pageNumber).toHaveCSS('opacity', '0');
    expect(rowBounds!.x + rowBounds!.width - (pageBounds!.x + pageBounds!.width)).toBeLessThanOrEqual(13);
    await expect(pageNumber).toHaveText('1');
  });

  test('presents owned and source annotations in one list without provenance labels', async ({ page }) => {
    await openAnnotationsWorkspace(page);

    const annotations = page.getByRole('region', { name: 'Annotations', exact: true });
    await expect(annotations).toBeVisible();
    await expect(annotations.getByRole('list', { name: 'Annotations in document order' })).toHaveCount(1);
    const source = annotations.locator('[data-existing-annotation][data-readonly="true"]');
    await expect(source).toHaveCount(1);
    await expect(source.locator('.annotation-item__provenance')).toHaveCount(0);
    await expect(page.getByText('From this PDF', { exact: true })).toHaveCount(0);
    await expect(source.getByRole('button', { name: /^Edit/u })).toHaveCount(0);
    await expect(source.getByRole('button', { name: /^(Delete|Remove)/u })).toHaveCount(0);
  });

  test('keeps the annotations tray open while editing an owned annotation', async ({ page }) => {
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const { annotations, workspace } = await openAnnotationsWorkspace(page);

    const edit = page.getByRole('button', { name: 'Edit Highlight annotation on page 1' });
    await expect(edit.locator('svg')).toHaveCount(1);
    await expect(edit).toHaveText('');
    await edit.focus();
    await edit.press('Enter');
    const editor = page.getByRole('region', { name: 'Edit Highlight' });
    await expect(editor).toBeVisible();
    await expect(workspace).toHaveAttribute(
      (await workspace.getAttribute('id')) === 'review-tools-workspace'
        ? 'data-tools-workspace-open'
        : 'data-workspace-open',
      'true',
    );
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.locator('[data-review-item]')).toHaveCount(1);

    await edit.focus();
    await edit.press('Enter');
    await expect(editor).toBeVisible();
    await editor.getByRole('textbox', { name: 'Comment (optional)' }).fill('Edited in the open tray.');
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();

    await expect(editor).toHaveCount(0);
    await expect(workspace).toBeVisible();
    await expect(annotations).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: /Highlight · Page 1 · Edited in the open tray\./u })).toBeVisible();
  });

  test('removes spatial disclosure motion when reduced motion is requested', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openAnnotationsWorkspace(page);
    const drawer = page.locator('#review-tools-workspace');
    const rail = page.locator('[data-workspace-edge-rail]');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveCSS('transition-duration', '0s');
    await expect(drawer).toHaveCSS('animation-duration', '0s');
    await closeWorkspace(page);
    await expect(rail).toHaveCSS('transition-duration', '0s');
  });

  test('keeps native editors and composer fields outside semantic command capture', async ({ page }) => {
    const revision = page.locator('[data-revision]');
    const input = page.getByRole('textbox', { name: 'Native input' });
    await input.fill('input value');
    await input.press('Backspace');
    await input.press('Alt+Shift+D');
    await expect(input).toHaveValue('input valu');
    await expect(revision).toHaveAttribute('data-revision', '0');

    const textarea = page.getByRole('textbox', { name: 'Native textarea' });
    await textarea.fill('textarea value');
    await textarea.press('Delete');
    await textarea.press('Alt+Shift+H');
    await expect(textarea).toHaveValue('textarea value');
    await expect(revision).toHaveAttribute('data-revision', '0');
    await textarea.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      element.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: '結',
        inputType: 'insertCompositionText',
        isComposing: true,
      }));
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '結論' }));
    });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(revision).toHaveAttribute('data-revision', '0');

    for (const name of ['Contenteditable editor', 'Review editor']) {
      const editor = page.getByRole('textbox', { name });
      await editor.focus();
      await page.keyboard.type(' native');
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Alt+Shift+D');
      await expect(editor).toContainText('nativ');
      await expect(revision).toHaveAttribute('data-revision', '0');
    }

    await page.getByRole('button', { name: 'Open page actions' }).click();
    await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
    const composer = page.getByRole('textbox', { name: 'Comment' });
    await composer.fill('composer value');
    await composer.press('Alt+Shift+D');
    await composer.press('Backspace');
    await expect(composer).toHaveValue('composer valu');
    await expect(revision).toHaveAttribute('data-revision', '0');
  });

  test('preserves native Space activation on review controls', async ({ page }) => {
    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    await canvas.focus();
    await page.keyboard.press('Space');
    const replacementComposer = page.getByRole('region', { name: 'Replacement' });
    await expect(replacementComposer.getByRole('textbox', { name: 'Replacement' })).toHaveValue(' ');
    await replacementComposer.getByRole('button', { name: 'Cancel' }).click();
    await expect(canvas).toBeFocused();

    const workspace = await currentWorkspaceRail(page);
    await workspace.press('Space');

    await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-tools-workspace-open', 'true');
    await expect(page.getByRole('region', { name: 'Replacement' })).toHaveCount(0);
    await expect(page.locator('[data-revision]')).toHaveAttribute('data-revision', '0');
  });

  test('keeps annotation preview geometry stable while typing a highlight comment', async ({ page }) => {
    await page.getByRole('button', { name: 'Use selection' }).click();
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    const composer = page.getByRole('region', { name: 'Highlight Comment' });
    const editor = composer.getByRole('textbox', { name: 'Comment (optional)' });
    await expect(composer).toBeVisible();
    const updatesBeforeTyping = await page.locator('#root').getAttribute(
      'data-authoring-preview-updates',
    );

    await editor.fill('Comment text should not refresh unchanged PDF geometry.');

    await expect(page.locator('#root')).toHaveAttribute(
      'data-authoring-preview-updates',
      updatesBeforeTyping ?? '',
    );
  });

  test('invokes action shortcuts while insertion remains typing-only', async ({ page }) => {
    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    await canvas.focus();
    await page.keyboard.press('Alt+Shift+R');
    await expect(page.getByRole('region', { name: 'Replacement' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    await canvas.focus();
    await page.keyboard.press('Alt+Shift+D');
    await expect(page.locator('[data-revision]')).toHaveAttribute('data-revision', '1');

    await page.getByRole('button', { name: 'Use caret' }).click();
    await expect(page.locator('[data-review-insertion-caret]')).toBeVisible();
    await expect(page.getByRole('toolbar', { name: 'Insertion review action' })).toHaveCount(0);
    await canvas.focus();
    await page.keyboard.press('Alt+Shift+I');
    await expect(page.getByRole('region', { name: 'Insertion' })).toHaveCount(0);
    await page.keyboard.type('i');
    await expect(page.getByRole('region', { name: 'Insertion' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Insertion' })).toHaveValue('i');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Use selection' }).click();
    await canvas.focus();
    await page.keyboard.press('Alt+Shift+H');
    await expect(page.getByRole('region', { name: 'Highlight Comment' })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await canvas.focus();
    await page.keyboard.press('Alt+Shift+N');
    await expect(page.getByRole('button', { name: 'Place Page Note' })).toBeVisible();
    await page.getByRole('button', { name: 'Place Page Note' }).click();
    await expect(page.getByRole('region', { name: 'Page Note' })).toBeVisible();
  });

  test('announces anchor recovery and creates no mutation when selection authority is absent', async ({ page }) => {
    const announcement = page.locator('.review-workspace__status');
    await page.getByRole('button', { name: 'Clear anchors' }).click();
    await expect(page.getByRole('toolbar', { name: 'Selection review actions' })).toHaveCount(0);
    await page.getByRole('application', { name: 'PDF review canvas' }).focus();
    await page.keyboard.press('Alt+Shift+R');
    await expect(announcement).toContainText('Select reliable text');
    await page.keyboard.press('Alt+Shift+D');
    await expect(announcement).toContainText('Select reliable text');
    await page.keyboard.press('Alt+Shift+I');
    await expect(page.getByRole('region', { name: 'Insertion' })).toHaveCount(0);
    await page.keyboard.press('Alt+Shift+H');
    await expect(announcement).toContainText('Select reliable text');
    await expect(page.locator('[data-revision]')).toHaveAttribute('data-revision', '0');
  });

  test('light-dismisses the Page Note menu without mutating the review', async ({ page }) => {
    await page.getByRole('button', { name: 'Open page actions' }).click();
    await expect(page.getByRole('menu', { name: 'Page actions' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Add Page Note' })).toBeFocused();

    await page.getByRole('application', { name: 'PDF review canvas' }).click();

    await expect(page.getByRole('menu', { name: 'Page actions' })).toHaveCount(0);
    await expect(page.locator('[data-revision]')).toHaveAttribute('data-revision', '0');
  });

  for (const workspace of ['closed', 'outline'] as const) {
    test(`shows and hides annotation hover previews without timers with workspace ${workspace}`, async ({ page }) => {
      await page.getByRole('button', { name: 'Highlight', exact: true }).click();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      if (workspace === 'outline') {
        await page.getByRole('button', { name: 'Show workspace' }).click();
        await page.getByRole('tab', { name: 'Outline', exact: true }).click();
      }
      const mark = page.locator('[data-owned-focus-id]').first();
      const peek = page.locator('[data-annotation-peek]');
      await page.clock.install();
      await page.clock.pauseAt(new Date());
      await mark.dispatchEvent('pointerover', { pointerType: 'mouse' });
      await expect(peek).toBeVisible();
      await mark.dispatchEvent('pointerout', { pointerType: 'mouse' });
      await expect(peek).toHaveCount(0);
      await mark.dispatchEvent('pointerover', { pointerType: 'mouse' });
      await expect(peek).toBeVisible();
      await peek.dispatchEvent('pointerover', { pointerType: 'mouse' });
      await mark.dispatchEvent('pointerout', { pointerType: 'mouse' });
      await expect(peek).toBeVisible();
      await peek.dispatchEvent('pointerout', { pointerType: 'mouse' });
      await expect(peek).toHaveCount(0);
    });
  }

  test('shows a hoverable mark peek and opens one selected owned row without shifting the document', async ({ page }) => {
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    const markTarget = page.locator('[data-owned-focus-id]').first();
    await expect(markTarget).toHaveCount(1);

    await markTarget.hover();
    await canvas.hover();
    await page.waitForTimeout(380);
    await expect(page.locator('[data-annotation-peek]')).toHaveCount(0);

    await markTarget.focus();
    const peek = page.locator('[data-annotation-peek]');
    await expect(peek).toBeVisible();
    await expect(peek).toHaveAttribute('aria-label', 'Highlight annotation preview');
    await expect(peek).not.toContainText('Page 1');
    await markTarget.click();
    await peek.hover();
    await expect(peek.getByRole('button', { name: 'Edit Highlight annotation on page 1' })).toBeVisible();
    await expect(peek.getByRole('button', { name: 'Remove Highlight annotation on page 1' })).toBeVisible();
    await canvas.click();
    await expect(peek).toHaveCount(0);

    await openAnnotationsWorkspace(page);
    const beforeActivation = await canvas.boundingBox();
    await markTarget.click();
    const drawer = page.locator('#review-tools-workspace');
    await expect(drawer).toHaveAttribute('data-tools-workspace-open', 'true');
    const row = page.locator('[data-review-item]').first();
    await expect(row).toHaveAttribute('data-active', 'true');
    await expect(row.getByRole('button', { name: /Highlight · Page 1/ })).toBeFocused();
    expect(await canvas.boundingBox()).toEqual(beforeActivation);

    const annotations = page.getByRole('region', { name: 'Annotations', exact: true });
    const source = annotations.locator('[data-existing-annotation][data-readonly="true"]');
    await expect(source.getByRole('button', { name: /Highlight · Page 1 · Source comment/ })).toBeVisible();
    await expect(source.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
    await expect(source.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(await currentWorkspaceRail(page)).toBeFocused();
    await expect(page.locator('[data-owned-mark]').first()).toHaveAttribute('data-active', 'true');
    await expect(row).toHaveAttribute('data-active', 'true');
  });

  test('keeps offscreen correspondence quiet without scrolling until explicit mark activation', async ({ page }) => {
    for (let index = 0; index < 7; index += 1) {
      if (index > 0) {
        await page.getByRole('button', { name: 'Clear anchors' }).click();
        await page.getByRole('button', { name: 'Use selection' }).click();
      }
      await page.getByRole('button', { name: 'Highlight', exact: true }).click();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
    }
    await openAnnotationsWorkspace(page);
    const drawer = page.locator('[data-annotation-scroll-viewport]');
    await drawer.evaluate((element) => {
      Object.assign((element as HTMLElement).style, {
        flex: 'none', height: '7rem', bottom: 'auto',
      });
    });
    const lastMark = page.locator('[data-owned-focus-id]').last();
    const scrollBefore = await drawer.evaluate((element) => element.scrollTop);

    await lastMark.focus();
    await expect(page.locator('[data-correspondence-direction]')).toHaveCount(0);
    expect(await drawer.evaluate((element) => element.scrollTop)).toBe(scrollBefore);

    await page.keyboard.press('Enter');
    const selected = page.locator('[data-review-item][data-active="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected.getByRole('button', { name: /Highlight · Page 1/ })).toBeFocused();
    expect(await drawer.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollBefore);
  });
});
