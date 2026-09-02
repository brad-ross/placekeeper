import { expect, test, type Page } from '@playwright/test';

async function openAnnotationsWorkspace(page: Page) {
  const rightRail = page.getByRole('button', { name: /^(?:Open|Close) right workspace$/u });
  const bottomRail = page.getByRole('button', { name: /^(?:Open|Close) References tray$/u });
  const stage = page.locator('[data-review-stage]');
  const expectedPresentation = (page.viewportSize()?.width ?? 1280) < 900 ? 'bottom' : 'right';
  await expect(stage).toHaveAttribute('data-workspace-presentation', expectedPresentation);
  const workspace = expectedPresentation === 'right'
    ? rightRail
    : bottomRail;
  if (await workspace.getAttribute('aria-expanded') !== 'true') await workspace.click();
  await expect(workspace).toHaveAttribute('aria-expanded', 'true');
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
  const rightRail = page.getByRole('button', { name: /^(?:Open|Close) right workspace$/u });
  const bottomRail = page.getByRole('button', { name: /^(?:Open|Close) References tray$/u });
  const expectedPresentation = (page.viewportSize()?.width ?? 1280) < 900 ? 'bottom' : 'right';
  await expect(page.locator('[data-review-stage]')).toHaveAttribute(
    'data-workspace-presentation',
    expectedPresentation,
  );
  const workspace = expectedPresentation === 'right'
    ? rightRail
    : bottomRail;
  if (await workspace.getAttribute('aria-expanded') === 'true') await workspace.click();
  await expect(workspace).toHaveAttribute('aria-expanded', 'false');
  return workspace;
}

async function currentWorkspaceRail(page: Page) {
  const expectedPresentation = (page.viewportSize()?.width ?? 1280) < 900 ? 'bottom' : 'right';
  await expect(page.locator('[data-review-stage]')).toHaveAttribute(
    'data-workspace-presentation',
    expectedPresentation,
  );
  return expectedPresentation === 'right'
    ? page.getByRole('button', { name: /^(?:Open|Close) right workspace$/u })
    : page.getByRole('button', { name: /^(?:Open|Close) References tray$/u });
}

function outlineDisclosure(page: Page, itemId: string) {
  return page.locator(
    `[data-outline-item="${itemId}"] > .outline-navigator__row > .outline-navigator__disclosure`,
  );
}

test.describe('canonical review workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html');
    await expect(page.getByRole('button', { name: 'Proofread mode' })).toHaveCount(0);
  });

  test('discloses mounted annotation actions at intent without activating their row', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.getByRole('button', { name: 'Seed annotations' }).click();
    await openAnnotationsWorkspace(page);

    const candidate = page.locator(
      '[data-review-item][data-active="false"]:has([data-annotation-action="edit"])',
    ).first();
    const itemId = await candidate.getAttribute('data-review-item');
    if (itemId === null) throw new Error('No inactive editable annotation row is available.');
    const row = page.locator(`[data-review-item="${itemId}"]`);
    const navigation = row.locator('.annotation-item__navigation');
    const edit = row.locator('[data-annotation-action="edit"]');
    const remove = row.locator('[data-annotation-action="delete"]');
    await expect(row).toBeVisible();
    await expect(edit).toHaveCount(1);
    await expect(remove).toHaveCount(1);
    await expect(edit).toHaveCSS('opacity', '0');

    await row.hover();
    await expect(edit).toHaveCSS('opacity', '1');
    await page.mouse.move(0, 0);
    await expect(edit).toHaveCSS('opacity', '0');

    await navigation.focus();
    await page.keyboard.press('Tab');
    await expect(edit).toBeFocused();
    await expect(edit).toHaveCSS('opacity', '1');

    await edit.click();
    await expect(row).toHaveAttribute('data-active', 'false');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(row).toHaveAttribute('data-active', 'false');

    await navigation.click();
    await expect(row).toHaveAttribute('data-active', 'true');
    await page.getByRole('application', { name: 'PDF review canvas' }).focus();
    await page.mouse.move(0, 0);
    await expect(edit).toHaveCSS('opacity', '1');
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
        '[data-review-item]:has([data-annotation-action="edit"])',
      ).first();
      const edit = row.locator('[data-annotation-action="edit"]');
      const remove = row.locator('[data-annotation-action="delete"]');
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
    await expect(documentActionsTrigger.locator('.review-icon')).toHaveCount(0);
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
    await expect(openAnnotations.locator('.lucide-list-checks')).toBeVisible();
    await openAnnotations.click();
    await expect(page.getByRole('tab', { name: 'Annotations', exact: true }).locator('.lucide-list-checks'))
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
    await expect(page.getByRole('region', { name: 'Owned annotations' })).toHaveCount(0);
    await expect(reattachDetail.getByRole('button', { name: 'Confirm' })).toBeEnabled();

    await reattachDetail.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.locator('[data-reconciliation-detail]')).toHaveCount(0);
    await expect(page.getByText('Reattachment saved.')).toHaveCount(0);
    await expect(page.locator('[data-reconciliation-entry]')).toHaveCount(1);
    await expect(page.getByRole('button', {
      name: 'Reattach previous Delete annotation on page 2',
    })).toBeFocused();
    await expect(page.getByRole('region', { name: 'Owned annotations' })).toContainText(
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
    await expect(page.getByText('Exporting reviewed PDF…')).toBeVisible();
    await expect(page.locator('[data-export-count]')).toHaveAttribute('data-export-count', '1');
    await expect(page.getByText('Reviewed PDF exported.')).toBeVisible();
    await expect(exportAction).toBeFocused();

    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=ready&export=fail-once');
    await page.getByRole('button', { name: /Open document actions/u }).click();
    await page.getByRole('menuitem', { name: 'Export', exact: true }).click();
    const retry = page.getByRole('menuitem', { name: 'Retry export' });
    await expect(page.getByText('Export failed safely. Try again.')).toBeVisible();
    await expect(retry).toBeFocused();
    await retry.click();
    await expect(page.locator('[data-export-count]')).toHaveAttribute('data-export-count', '2');
    await expect(page.getByText('Reviewed PDF exported.')).toBeVisible();
  });

  test('clears stale export confirmation when a responsive transition closes document actions', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=stale');
    const trigger = page.getByRole('button', { name: /Open document actions/u });
    await trigger.click();
    await page.getByRole('menuitem', { name: 'Export', exact: true }).click();
    await expect(page.getByText('Export the last successful PDF?')).toBeVisible();

    await page.setViewportSize({ width: 320, height: 900 });
    await expect(page.getByRole('menu', { name: /Actions for/u })).toHaveCount(0);

    await trigger.click();
    await expect(page.getByRole('menuitem', { name: 'Export', exact: true })).toBeVisible();
    await expect(page.getByText('Export the last successful PDF?')).toHaveCount(0);
  });

  test('presents reconciling and failed refresh export states from the document title', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=ready&refresh=reconciling');
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
    await page.getByRole('button', { name: 'Open right workspace' }).click();
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

    await page.getByRole('button', { name: 'Open harness reference' }).click();
    await page.getByRole('button', { name: 'Open References tray' }).click();
    await page.getByRole('button', { name: 'Move References to right' }).click();
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
    await page.getByRole('button', { name: 'Open right workspace' }).click();

    const harness = outlineDisclosure(page, 'harness-outline');
    const nested = outlineDisclosure(page, 'harness-outline-nested');
    const supplemental = outlineDisclosure(page, 'supplemental-outline');
    await expect(harness).toHaveAttribute('aria-expanded', 'true');
    await expect(nested).toHaveAttribute('aria-expanded', 'true');
    await expect(supplemental).toHaveAttribute('aria-expanded', 'true');

    await supplemental.click();
    await expect(supplemental).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Collapse all outline entries' }).click();
    await expect(page.getByRole('button', {
      name: 'Restore previous outline expansion',
    })).toHaveAttribute('aria-pressed', 'true');
    await expect(harness).toHaveAttribute('aria-expanded', 'false');
    await expect(nested).toHaveAttribute('aria-expanded', 'false');
    await expect(supplemental).toHaveAttribute('aria-expanded', 'false');

    await supplemental.click();
    await expect(supplemental).toHaveAttribute('aria-expanded', 'true');
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
    await page.getByRole('button', { name: 'Open right workspace' }).click();
    await page.getByRole('button', { name: 'Collapse all outline entries' }).click();
    await expect(page.getByRole('button', {
      name: 'Restore previous outline expansion',
    })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Begin outline replacement' }).evaluate((button) => (
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ));
    await expect(page.locator('[data-outline-state="loading"]')).toHaveText('Outline is loading…');
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
    await page.getByRole('button', { name: 'Keep', exact: true }).click();
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
      await expect(action).toHaveAttribute('title', name);
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
    await page.getByRole('button', { name: 'Keep', exact: true }).click();
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

  test('edits the viewer-published current page through Enter and ordinary blur', async ({ page }) => {
    const currentPage = page.getByRole('button', {
      name: 'Current page 3 of 12. Enter a page number',
    });
    await currentPage.click();

    const pageNumber = page.getByRole('spinbutton', { name: 'Page number' });
    await expect(pageNumber).toBeFocused();
    await expect(pageNumber).toHaveValue('3');
    await page.keyboard.type('8');
    await expect(pageNumber).toHaveValue('8');
    await pageNumber.press('Enter');

    await expect(page.getByRole('button', {
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

    await page.getByRole('button', {
      name: 'Current page 8 of 12. Enter a page number',
    }).click();
    await pageNumber.fill('5');
    const nativeInput = page.getByRole('textbox', { name: 'Native input' });
    await nativeInput.focus();

    await expect(nativeInput).toBeFocused();
    await expect(page.getByRole('button', {
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

  test('progressively compacts the top bar into repeatable semantic menus', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?responsive=full');
    await page.setViewportSize({ width: 320, height: 720 });
    const chrome = page.locator('[data-review-chrome]');
    await expect(chrome).toHaveAttribute('data-review-chrome-presentation', 'navigationCompact');

    const historyTrigger = page.getByRole('button', { name: 'Edit history' });
    await expect(historyTrigger.locator('.review-icon')).toHaveCount(2);

    const navigationTrigger = page.getByRole('button', {
      name: 'Document navigation, current page 3 of 12',
    });
    await navigationTrigger.click();
    const navigationMenu = page.getByRole('menu', { name: 'Document navigation' });
    await expect(navigationMenu).toBeVisible();
    await expect(navigationMenu.getByRole('menuitem')).toHaveCount(5);
    await expect(navigationMenu.getByRole('menuitem').nth(0)).toHaveAttribute('aria-label', 'Back in document history');
    await expect(navigationMenu.getByRole('menuitem').nth(1)).toHaveAttribute('aria-label', 'Forward in document history');
    await expect(navigationMenu.getByRole('menuitem').nth(2)).toHaveAttribute('aria-label', 'Previous page');
    await expect(navigationMenu.getByRole('menuitem').nth(3)).toHaveAttribute('aria-label', 'Current page 3 of 12. Enter a page number');
    await expect(navigationMenu.getByRole('menuitem').nth(4)).toHaveAttribute('aria-label', 'Next page');
    const nextPage = navigationMenu.getByRole('menuitem', { name: 'Next page' });
    await nextPage.click();
    await expect(navigationMenu).toBeVisible();
    await expect(nextPage).toBeFocused();
    await expect(page.getByRole('button', {
      name: 'Document navigation, current page 4 of 12',
    })).toBeVisible();

    await navigationMenu.getByRole('menuitem', {
      name: 'Current page 4 of 12. Enter a page number',
    }).click();
    const compactPageInput = page.getByRole('spinbutton', { name: 'Page number' });
    await compactPageInput.fill('6');
    await compactPageInput.press('Enter');
    await expect(navigationMenu).toHaveCount(0);
    await expect(page.getByRole('button', {
      name: 'Document navigation, current page 6 of 12',
    })).toBeFocused();

    const zoomTrigger = page.getByRole('button', {
      name: 'PDF zoom, current zoom 110 percent',
    });
    await zoomTrigger.click();
    await expect(navigationMenu).toHaveCount(0);
    const zoomMenu = page.getByRole('menu', { name: 'PDF zoom' });
    await expect(zoomMenu).toBeVisible();
    await expect(zoomMenu.getByRole('menuitem').nth(0)).toHaveAttribute('aria-label', 'Zoom out');
    await expect(zoomMenu.getByRole('menuitem').nth(1)).toHaveAttribute('aria-label', 'Zoom in');
    await expect(zoomMenu.getByRole('menuitem').nth(2)).toHaveAttribute('aria-label', 'Current zoom 110 percent. Enter a zoom percentage');
    await expect(zoomMenu.getByRole('menuitem').nth(3)).toHaveAttribute('aria-label', 'Fit PDF to available width');
    const zoomIn = zoomMenu.getByRole('menuitem', { name: 'Zoom in' });
    await zoomIn.click();
    await expect(zoomMenu).toBeVisible();
    await expect(zoomIn).toBeFocused();
    await expect(page.getByRole('button', {
      name: 'PDF zoom, current zoom 120 percent',
    })).toBeVisible();

    await zoomMenu.getByRole('menuitem', {
      name: 'Current zoom 120 percent. Enter a zoom percentage',
    }).click();
    const compactZoomInput = page.getByRole('spinbutton', { name: 'Zoom percentage' });
    await compactZoomInput.fill('9999');
    await compactZoomInput.press('Enter');
    await expect(zoomMenu).toBeVisible();
    await expect(compactZoomInput).toHaveAttribute('aria-invalid', 'true');
    await compactZoomInput.press('Escape');
    await expect(zoomMenu).toHaveCount(0);
    await expect(page.getByRole('button', {
      name: 'PDF zoom, current zoom 120 percent',
    })).toBeFocused();

    await page.getByRole('button', {
      name: 'PDF zoom, current zoom 120 percent',
    }).click();
    const fitWidth = zoomMenu.getByRole('menuitem', { name: 'Fit PDF to available width' });
    await fitWidth.click();
    await expect(zoomMenu).toHaveCount(0);
    await expect(page.getByRole('button', {
      name: /PDF zoom, current zoom \d+ percent/u,
    })).toBeFocused();
  });

  test('keeps all-disabled compact menus in keyboard ownership', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?responsive=full');
    await page.setViewportSize({ width: 320, height: 720 });
    const { workspace } = await openAnnotationsWorkspace(page);

    await page.getByRole('button', { name: 'Make page controls unavailable' }).click();
    const navigationTrigger = page.getByRole('button', {
      name: 'Document navigation, page unavailable',
    });
    await navigationTrigger.focus();
    await navigationTrigger.press('Enter');
    const navigationMenu = page.getByRole('menu', { name: 'Document navigation' });
    await expect(navigationMenu).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(navigationMenu).toHaveCount(0);
    await expect(navigationTrigger).toBeFocused();
    await expect(workspace).toHaveAttribute('aria-expanded', 'true');

    await page.getByRole('button', { name: 'Make zoom controls unavailable' }).click();
    const zoomTrigger = page.getByRole('button', { name: 'PDF zoom unavailable' });
    await zoomTrigger.focus();
    await zoomTrigger.press('Enter');
    const zoomMenu = page.getByRole('menu', { name: 'PDF zoom' });
    await expect(zoomMenu).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(zoomMenu).toHaveCount(0);
    await expect(zoomTrigger).toBeFocused();
    await expect(workspace).toHaveAttribute('aria-expanded', 'true');
  });

  test('keeps a portaled compact menu attached when its trigger resizes', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?responsive=full');
    await page.setViewportSize({ width: 760, height: 720 });
    const chrome = page.locator('[data-review-chrome]');
    await chrome.evaluate((element) => { element.style.width = '320px'; });
    await expect(chrome).toHaveAttribute('data-review-chrome-presentation', 'navigationCompact');
    const navigationTrigger = page.getByRole('button', {
      name: 'Document navigation, current page 3 of 12',
    });
    await navigationTrigger.click();
    const navigationMenu = page.getByRole('menu', { name: 'Document navigation' });
    await expect(navigationMenu).toBeVisible();
    const initialLeft = Number.parseFloat(await navigationMenu.evaluate((element) => element.style.left));

    await navigationTrigger.evaluate((element) => {
      element.style.transform = 'translateX(40px)';
    });
    await expect.poll(async () => Number.parseFloat(
      await navigationMenu.evaluate((element) => element.style.left),
    )).not.toBe(initialLeft);

    const geometry = await Promise.all([
      navigationTrigger.boundingBox(),
      navigationMenu.boundingBox(),
    ]);
    if (!geometry[0] || !geometry[1]) throw new Error('Compact menu geometry is unavailable.');
    expect(geometry[1].x).toBeLessThanOrEqual(geometry[0].x + geometry[0].width);
    expect(geometry[1].x + geometry[1].width).toBeGreaterThanOrEqual(geometry[0].x);
  });

  test('does not let deferred focus close a newer compact menu', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?responsive=full');
    await page.setViewportSize({ width: 320, height: 720 });
    await page.getByRole('button', {
      name: 'PDF zoom, current zoom 110 percent',
    }).click();
    const zoomMenu = page.getByRole('menu', { name: 'PDF zoom' });
    await expect(zoomMenu).toBeVisible();
    await page.evaluate(() => {
      const original = window.requestAnimationFrame.bind(window);
      let held: FrameRequestCallback | null = null;
      window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        if (held === null) {
          held = callback;
          window.requestAnimationFrame = original;
          return 2_147_483_647;
        }
        return original(callback);
      };
      (window as typeof window & { flushHeldTopBarFrame?: () => void }).flushHeldTopBarFrame = () => {
        const callback = held;
        held = null;
        callback?.(performance.now());
      };
    });
    await zoomMenu.getByRole('menuitem', { name: 'Fit PDF to available width' }).click();
    await expect(zoomMenu).toHaveCount(0);

    await page.getByRole('button', { name: 'Edit history' }).click();
    const historyMenu = page.getByRole('menu', { name: 'Edit history' });
    await expect(historyMenu).toBeVisible();
    await page.evaluate(() => {
      (window as typeof window & { flushHeldTopBarFrame?: () => void }).flushHeldTopBarFrame?.();
    });
    await expect(historyMenu).toBeVisible();
    await expect(historyMenu).toBeFocused();
  });

  test('keeps a readable title floor and collapses Edit history, Zoom, then Navigation', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?visual=reading');
    await page.setViewportSize({ width: 1280, height: 720 });
    const chrome = page.locator('[data-review-chrome]');
    await expect(chrome).toHaveAttribute('data-review-chrome-presentation', 'expanded');

    const longTitle = chrome.locator(':scope > .review-chrome__identity strong');
    expect(await longTitle.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

    const reachCollapsedPresentation = async (
      target: 'zoomCompact' | 'historyCompact' | 'navigationCompact',
      previous: 'expanded' | 'zoomCompact' | 'historyCompact',
    ) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const widths = await chrome.locator('[data-review-chrome-sizing-rack]').evaluate((rack, names) => {
          const width = (name: string) => rack.querySelector<HTMLElement>(
            `[data-review-chrome-candidate="${name}"]`,
          )?.getBoundingClientRect().width ?? 0;
          return { previous: width(names.previous), target: width(names.target) };
        }, { previous, target });
        expect(widths.previous).toBeGreaterThan(widths.target);
        const width = Math.max(320, Math.floor((widths.previous + widths.target) / 2));
        await page.setViewportSize({ width, height: 720 });
        await page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        if (await chrome.getAttribute('data-review-chrome-presentation') === target) return;
      }
      await expect(chrome).toHaveAttribute('data-review-chrome-presentation', target);
    };

    const expectReadableFilename = async () => {
      const filenameWidth = await chrome.locator(
        ':scope > .review-chrome__identity .review-chrome__save-identity strong',
      ).evaluate((element) => element.getBoundingClientRect().width);
      expect(filenameWidth).toBeGreaterThanOrEqual(143.5);
    };

    await expectReadableFilename();
    await reachCollapsedPresentation('historyCompact', 'expanded');
    await expectReadableFilename();
    await reachCollapsedPresentation('zoomCompact', 'historyCompact');
    await expectReadableFilename();
    await reachCollapsedPresentation('navigationCompact', 'zoomCompact');
    await expectReadableFilename();

    for (const target of ['zoomCompact', 'historyCompact', 'expanded'] as const) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const required = await chrome.locator(
          `[data-review-chrome-candidate="${target}"]`,
        ).evaluate((element) => element.getBoundingClientRect().width);
        await page.setViewportSize({ width: Math.ceil(required + 24), height: 720 });
        await page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        if (await chrome.getAttribute('data-review-chrome-presentation') === target) break;
      }
      await expect(chrome).toHaveAttribute('data-review-chrome-presentation', target);
      await expectReadableFilename();
    }
  });

  test('keeps the top bar to one contained 58px row across supported widths', async ({ page }) => {
    await page.locator('#root').evaluate((element) => {
      element.setAttribute('data-production-root', 'true');
    });
    for (const width of [1280, 760, 641, 640, 521, 520, 481, 480, 390, 361, 360, 320]) {
      await page.setViewportSize({ width, height: 720 });
      const chrome = page.locator('[data-review-chrome]');
      await expect(chrome).toHaveCSS('height', '58px');
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));

      const geometry = await chrome.evaluate((element) => {
        const identity = element.querySelector<HTMLElement>(':scope > .review-chrome__identity');
        const controls = element.querySelector<HTMLElement>(':scope > .review-chrome__viewer-controls');
        const actions = element.querySelector<HTMLElement>(':scope > .review-chrome__actions');
        if (!identity || !controls || !actions) throw new Error('Review chrome geometry is incomplete.');
        const chromeBounds = element.getBoundingClientRect();
        const identityBounds = identity.getBoundingClientRect();
        const controlsBounds = controls.getBoundingClientRect();
        const actionsBounds = actions.getBoundingClientRect();
        const visibleBounds = (selector: string) => [...element.querySelectorAll<HTMLElement>(selector)]
          .filter((child) => getComputedStyle(child).display !== 'none')
          .map((child) => child.getBoundingClientRect().toJSON());
        return {
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          height: chromeBounds.height,
          identity: identityBounds.toJSON(),
          controls: controlsBounds.toJSON(),
          actions: actionsBounds.toJSON(),
          identityChildren: visibleBounds(':scope > .review-chrome__identity > *'),
          saveChildren: visibleBounds(':scope > .review-chrome__identity .review-chrome__save-identity > :not(.sr-only)'),
          filename: element.querySelector<HTMLElement>(':scope > .review-chrome__identity .review-chrome__save-identity strong')?.getBoundingClientRect().toJSON(),
        };
      });

      expect(geometry.height).toBe(58);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
      const visibleColumns = [geometry.identity, geometry.controls, geometry.actions]
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
      expect(geometry.filename?.width).toBeGreaterThanOrEqual(
        width <= 360 ? 71.5 : width <= 480 ? 95.5 : 143.5,
      );
      for (const item of [geometry.identity, geometry.controls, geometry.actions]) {
        expect(item.y).toBeGreaterThanOrEqual(-0.5);
        expect(item.y + item.height).toBeLessThanOrEqual(58.5);
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
        const chromeButtons = chrome.locator(':scope > .review-chrome__identity button, :scope > .review-chrome__viewer-controls button');
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
            copy: bounds(':scope > .review-chrome__identity [data-review-copy-link]'),
            filename: bounds(':scope > .review-chrome__identity .review-chrome__save-identity strong'),
            recoveryDisplay: getComputedStyle(element.querySelector<HTMLElement>(':scope > .review-chrome__identity .review-chrome__save-recovery')!).display,
            contextDisplay: getComputedStyle(element.querySelector<HTMLElement>(':scope > .review-chrome__actions .review-chrome__context')!).display,
          };
        });
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
        expect(geometry.identity).toBeDefined();
        expect(geometry.controls).toBeDefined();
        expect(geometry.saveIdentity).toBeDefined();
        expect(geometry.copy).toBeDefined();
        expect(geometry.copy!.width).toBeGreaterThanOrEqual(44);
        expect(geometry.filename?.width).toBeGreaterThanOrEqual(
          width <= 360 ? 71.5 : width <= 480 ? 95.5 : 143.5,
        );
        expect(geometry.identity!.x + geometry.identity!.width)
          .toBeLessThanOrEqual(geometry.controls!.x + 0.5);
        if (width === 320) {
          expect(geometry.chrome.x).toBeLessThanOrEqual(geometry.saveIdentity!.x + 0.5);
          expect(geometry.saveIdentity!.x + geometry.saveIdentity!.width)
            .toBeLessThanOrEqual(geometry.copy!.x + 0.5);
          expect(geometry.copy!.x + geometry.copy!.width)
            .toBeLessThanOrEqual(geometry.identity!.x + geometry.identity!.width + 0.5);
          expect(geometry.controls!.x + geometry.controls!.width)
            .toBeLessThanOrEqual(geometry.chrome.x + geometry.chrome.width + 0.5);
          expect(geometry.recoveryDisplay).toBe('none');
          expect(geometry.contextDisplay).toBe('none');
        }
      }

      await expect(chrome).toHaveAttribute('data-review-chrome-presentation', 'navigationCompact');

      await touchPage.getByRole('button', {
        name: 'Document navigation, current page 3 of 12',
      }).click();
      const menu = touchPage.getByRole('menu', { name: 'Document navigation' });
      await expect(menu).toBeVisible();
      const menuButtonHeights = await menu.locator('button').evaluateAll((buttons) => (
        buttons.map((button) => button.getBoundingClientRect().height)
      ));
      expect(menuButtonHeights.length).toBeGreaterThan(0);
      for (const height of menuButtonHeights) expect(height).toBeGreaterThanOrEqual(44);
    } finally {
      await context.close();
    }
  });

  test('cancels page editing with Escape without closing the Annotation Tray', async ({ page }) => {
    const { annotations, workspace } = await openAnnotationsWorkspace(page);
    const currentPage = page.getByRole('button', {
      name: 'Current page 3 of 12. Enter a page number',
    });
    await currentPage.click();
    const pageNumber = page.getByRole('spinbutton', { name: 'Page number' });
    await pageNumber.fill('9');
    await pageNumber.press('Escape');

    await expect(currentPage).toBeFocused();
    await expect(workspace).toHaveAttribute('aria-expanded', 'true');
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

  test('announces invalid page ranges, clears the error on change, and cancels invalid blur', async ({ page }) => {
    const currentPage = page.getByRole('button', {
      name: 'Current page 3 of 12. Enter a page number',
    });
    await currentPage.click();
    const pageNumber = page.getByRole('spinbutton', { name: 'Page number' });
    await pageNumber.fill('13');
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
      '',
    );
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '',
    );

    await pageNumber.fill('1.5');
    await expect(pageNumber).toHaveAttribute('aria-invalid', 'false');
    await expect(rangeError).toHaveCount(0);
    await pageNumber.press('Enter');
    await expect(pageNumber).toHaveAttribute('aria-invalid', 'true');
    await expect(rangeError).toHaveText('Enter a whole page number from 1 to 12');
    await expect(page.locator('[data-viewer-page-commands]')).toHaveAttribute(
      'data-viewer-page-commands',
      '',
    );
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '',
    );

    await pageNumber.fill('');
    await expect(pageNumber).toHaveAttribute('aria-invalid', 'false');
    await page.getByRole('textbox', { name: 'Native input' }).focus();

    await expect(pageNumber).toHaveCount(0);
    await expect(currentPage).toBeVisible();
    await expect(page.locator('[data-viewer-page-commands]')).toHaveAttribute(
      'data-viewer-page-commands',
      '',
    );
    await expect(page.locator('[data-viewer-page-requests]')).toHaveAttribute(
      'data-viewer-page-requests',
      '',
    );
  });

  test('does not offer page editing while page controls are unavailable', async ({ page }) => {
    await page.getByRole('button', { name: 'Make page controls unavailable' }).click();

    await expect(page.getByLabel('Current page')).toHaveText('— / —');
    await expect(page.getByRole('spinbutton', { name: 'Page number' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Enter a page number/u })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  test('lets Previous and Next win over a dirty page draft exactly once', async ({ page }) => {
    await page.getByRole('button', {
      name: 'Current page 3 of 12. Enter a page number',
    }).click();
    const pageNumber = page.getByRole('spinbutton', { name: 'Page number' });
    await pageNumber.fill('10');
    const nextPage = page.getByRole('button', { name: 'Next page' });
    await nextPage.click();

    await expect(nextPage).toBeFocused();
    await expect(page.getByRole('button', {
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

    await page.getByRole('button', {
      name: 'Current page 4 of 12. Enter a page number',
    }).click();
    await pageNumber.fill('11');
    const previousPage = page.getByRole('button', { name: 'Previous page' });
    await expect(pageNumber).toBeFocused();
    await previousPage.evaluate((button: HTMLButtonElement) => button.click());

    await expect(previousPage).toBeFocused();
    await expect(page.getByRole('button', {
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

    await page.getByRole('button', {
      name: 'Current page 3 of 12. Enter a page number',
    }).click();
    await pageNumber.fill('10');
    await nextPage.dispatchEvent('pointerdown', { button: 0, pointerId: 1 });
    await pageNumber.evaluate((input: HTMLInputElement) => input.blur());
    await nextPage.evaluate((button: HTMLButtonElement) => button.click());

    await expect(nextPage).toBeFocused();
    await expect(page.getByRole('button', {
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
    const zoomLevel = page.getByRole('button', {
      name: 'Current zoom 110 percent. Enter a zoom percentage',
    });
    await zoomLevel.click();

    const zoomPercentage = page.getByRole('spinbutton', { name: 'Zoom percentage' });
    await expect(zoomPercentage).toBeFocused();
    await expect(zoomPercentage).toHaveValue('110');
    await page.keyboard.type('125');
    await expect(zoomPercentage).toHaveValue('125');
    await zoomPercentage.press('Enter');

    await expect(page.getByRole('button', {
      name: 'Current zoom 125 percent. Enter a zoom percentage',
    })).toBeFocused();
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:125;commands:go:125;fit:',
    );

    await page.getByRole('button', {
      name: 'Current zoom 125 percent. Enter a zoom percentage',
    }).click();
    await zoomPercentage.fill('140');
    const nativeInput = page.getByRole('textbox', { name: 'Native input' });
    await nativeInput.focus();

    await expect(nativeInput).toBeFocused();
    await expect(page.getByRole('button', {
      name: 'Current zoom 140 percent. Enter a zoom percentage',
    })).toBeVisible();
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:125|140;commands:go:125|go:140;fit:',
    );
  });

  test('keeps an exact fitted scale when an unchanged zoom edit closes', async ({ page }) => {
    await page.getByRole('button', { name: 'Fit PDF to available width' }).click();
    const fitResult = page.getByRole('button', {
      name: 'Current zoom 88 percent. Enter a zoom percentage',
    });
    await fitResult.click();
    const zoomPercentage = page.getByRole('spinbutton', { name: 'Zoom percentage' });
    await zoomPercentage.press('Enter');
    await expect(fitResult).toBeFocused();
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:;commands:fit:88;fit:fit',
    );

    await fitResult.click();
    await page.getByRole('textbox', { name: 'Native input' }).focus();
    await expect(page.getByRole('spinbutton', { name: 'Zoom percentage' })).toHaveCount(0);
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:;commands:fit:88;fit:fit',
    );
  });

  test('announces invalid zoom ranges and cancels invalid blur', async ({ page }) => {
    const zoomLevel = page.getByRole('button', {
      name: 'Current zoom 110 percent. Enter a zoom percentage',
    });
    await zoomLevel.click();
    const zoomPercentage = page.getByRole('spinbutton', { name: 'Zoom percentage' });
    await zoomPercentage.fill('6001');
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
      'direct:;commands:;fit:',
    );

    await zoomPercentage.fill('1.5');
    await expect(zoomPercentage).toHaveAttribute('aria-invalid', 'false');
    await expect(rangeError).toHaveCount(0);
    await zoomPercentage.press('Enter');
    await expect(zoomPercentage).toHaveAttribute('aria-invalid', 'true');

    await zoomPercentage.fill('');
    await page.getByRole('textbox', { name: 'Native input' }).focus();
    await expect(zoomPercentage).toHaveCount(0);
    await expect(zoomLevel).toBeVisible();
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:;commands:;fit:',
    );
  });

  test('cancels zoom editing with Escape without closing workspace or Finish', async ({ page }) => {
    const { annotations, workspace } = await openAnnotationsWorkspace(page);
    const zoomLevel = page.getByRole('button', {
      name: 'Current zoom 110 percent. Enter a zoom percentage',
    });
    await zoomLevel.click();
    const zoomPercentage = page.getByRole('spinbutton', { name: 'Zoom percentage' });
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
      'direct:;commands:;fit:',
    );

    await zoomPercentage.press('Escape');
    await expect(zoomLevel).toBeFocused();
    await expect(workspace).toHaveAttribute('aria-expanded', 'true');
    await expect(annotations).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#review-tools-workspace')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Finish review' })).toHaveCount(0);
    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:;commands:;fit:',
    );
  });

  test('lets Zoom Out, Zoom In, and Fit Width win over dirty zoom drafts exactly once', async ({ page }) => {
    const zoomPercentage = page.getByRole('spinbutton', { name: 'Zoom percentage' });
    await page.getByRole('button', {
      name: 'Current zoom 110 percent. Enter a zoom percentage',
    }).click();
    await zoomPercentage.fill('125');
    const zoomOut = page.getByRole('button', { name: 'Zoom out' });
    await zoomOut.dispatchEvent('pointerdown', { button: 0, pointerId: 1 });
    await zoomPercentage.evaluate((input: HTMLInputElement) => input.blur());
    await zoomOut.click();
    await expect(zoomOut).toBeFocused();
    await expect(page.getByRole('button', {
      name: 'Current zoom 100 percent. Enter a zoom percentage',
    })).toBeVisible();

    await page.getByRole('button', {
      name: 'Current zoom 100 percent. Enter a zoom percentage',
    }).click();
    await zoomPercentage.fill('130');
    const zoomIn = page.getByRole('button', { name: 'Zoom in' });
    await zoomIn.evaluate((button: HTMLButtonElement) => button.click());
    await expect(zoomIn).toBeFocused();
    await expect(page.getByRole('button', {
      name: 'Current zoom 110 percent. Enter a zoom percentage',
    })).toBeVisible();

    await page.getByRole('button', {
      name: 'Current zoom 110 percent. Enter a zoom percentage',
    }).click();
    await zoomPercentage.fill('150');
    const fitWidth = page.getByRole('button', { name: 'Fit PDF to available width' });
    await fitWidth.click();
    await expect(fitWidth).toBeFocused();
    await expect(page.getByRole('button', {
      name: 'Current zoom 88 percent. Enter a zoom percentage',
    })).toBeVisible();

    await expect(page.locator('[data-viewer-zoom-requests]')).toHaveAttribute(
      'data-viewer-zoom-requests',
      'direct:;commands:out:100|in:110|fit:88;fit:fit',
    );
  });

  test('does not offer zoom editing or Fit Width while zoom is unavailable', async ({ page }) => {
    await page.getByRole('button', { name: 'Make zoom controls unavailable' }).click();

    await expect(page.getByLabel('Zoom unavailable')).toHaveText('—%');
    await expect(page.getByRole('spinbutton', { name: 'Zoom percentage' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Enter a zoom percentage/u })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Fit PDF to available width' })).toBeDisabled();
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
    const originEdit = origin.locator('[data-annotation-action="edit"]');
    await originContent.click();
    await panel.evaluate((element) => { element.scrollTop = 137; });
    const restoredScroll = await panel.evaluate((element) => element.scrollTop);
    expect(restoredScroll).toBeGreaterThan(0);
    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    const canvasBefore = await canvas.boundingBox();
    await workspace.evaluate((element) => element.setAttribute('data-takeover-mount-probe', 'stable'));
    await references.evaluate((element) => element.setAttribute('data-takeover-mount-probe', 'stable'));

    await originEdit.click();
    const composer = page.getByRole('region', { name: 'Edit Page Note' });
    await expect(composer).toBeVisible();
    await expect(workspace).toHaveAttribute('data-authoring-takeover', 'true');
    await expect(references).toHaveAttribute('data-authoring-takeover', 'true');
    await expect(workspace).toHaveAttribute('inert', '');
    await expect(references).toHaveAttribute('inert', '');
    await expect(workspace).toHaveAttribute('aria-hidden', 'true');
    await expect(references).toHaveAttribute('aria-hidden', 'true');
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
    expect(tabletComposer!.x).toBeCloseTo(tabletStage!.x, 0);
    expect(tabletComposer!.width).toBeCloseTo(tabletStage!.width, 0);
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

  test('reads a full annotation in the tray and restores list selection, scroll, and More focus', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.getByRole('button', { name: 'Seed annotations' }).click();
    await page.getByRole('button', { name: 'Seed long annotation' }).click();
    await openAnnotationsWorkspace(page);

    const panel = page.locator('[data-annotation-scroll-viewport]');
    const rows = panel.locator('[data-review-item]');
    const previouslySelected = rows.first();
    await previouslySelected.locator('.annotation-item__content').click();
    const previousId = await previouslySelected.getAttribute('data-review-item');

    const openingRow = rows.filter({
      has: page.getByRole('button', { name: /Read full Page Note annotation on page 3/u }),
    });
    const openingId = await openingRow.getAttribute('data-review-item');
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
    await expect(page.locator('[data-navigated]')).toHaveAttribute('data-navigated', openingId!);
    await expect(panel.locator('[data-review-item]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.locator('[data-full-annotation-reader="true"]')).toHaveCount(0);
    await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBe(scrollBefore);
    await expect(panel.locator(`[data-review-item="${previousId}"]`)).toHaveAttribute('data-active', 'true');
    await expect(more).toBeFocused();
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
    await expect(page.locator('[data-navigated]')).toHaveAttribute('data-navigated', secondId!);
    await expect(page.locator('[data-annotation-scroll-viewport]')).toHaveJSProperty('scrollTop', 0);
  });

  test('opens imported readers through existing PDF navigation', async ({ page }) => {
    await openAnnotationsWorkspace(page);
    const existing = page.getByRole('region', { name: 'From this PDF' });
    await existing.getByRole('button', {
      name: /Read full Highlight annotation on page 1/u,
    }).click();

    await expect(page.locator('[data-navigated]')).toHaveAttribute(
      'data-navigated',
      'source:source-highlight',
    );
    const reader = page.locator('[data-full-annotation-reader="true"]');
    await expect(reader).toContainText('Source comment with enough authored detail');
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

    const existing = page.getByRole('region', { name: 'From this PDF' });
    await existing.getByRole('button', {
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
    await page.addStyleTag({ content: '.annotation-item__more { display: none !important; }' });

    await page.getByRole('button', { name: 'Back', exact: true }).click();

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
      .locator('.annotation-item__navigation').click();
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
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Redo' })).toBeDisabled();
    await page.keyboard.type('x');
    await page.keyboard.press('Delete');
    await page.keyboard.press('ControlOrMeta+z');

    await expect(revision).toHaveAttribute('data-revision', revisionBefore ?? '');
    await expect(revision).toHaveAttribute('data-kinds', kindsBefore ?? '');
    await expect(editor).toHaveValue('frozen draft');
    await editor.focus();
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
    await expect(input).toHaveValue('revised wording');
    await expect(page.locator('[data-review-stage]'))
      .toHaveAttribute('data-annotation-presentation', 'bottom');
    const inputBounds = await input.boundingBox();
    expect(inputBounds).not.toBeNull();
    expect(inputBounds!.x).toBeGreaterThanOrEqual(0);
    expect(inputBounds!.x + inputBounds!.width).toBeLessThanOrEqual(320);
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('button', { name: 'Edit history' }).click();
    const historyMenu = page.getByRole('menu', { name: 'Edit history' });
    await historyMenu.getByRole('menuitem', { name: 'Undo' }).click();
    await expect(page.locator('[data-owned-mark]')).toHaveCount(0);
    await historyMenu.getByRole('menuitem', { name: 'Redo' }).click();
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
    await expect(page.getByLabel('Annotations in document order')).toBeFocused();
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
    await content.focus();

    await expect(action).toHaveAttribute('title', 'Delete annotation');
    await expect(action.locator('svg')).toHaveCount(1);
    await expect(action).toHaveText('');
    await expect(content).toHaveCSS('outline-style', 'none');
    await expect(row).toHaveCSS('outline-style', 'solid');

    const kind = row.locator('.annotation-item__meta strong');
    const separator = row.locator('.annotation-item__separator');
    const pageNumber = row.locator('.annotation-item__page');
    const [kindBounds, separatorBounds, pageBounds] = await Promise.all([
      kind.boundingBox(),
      separator.boundingBox(),
      pageNumber.boundingBox(),
    ]);
    expect(kindBounds).not.toBeNull();
    expect(separatorBounds).not.toBeNull();
    expect(pageBounds).not.toBeNull();
    expect(separatorBounds!.x - (kindBounds!.x + kindBounds!.width)).toBeLessThanOrEqual(5);
    expect(pageBounds!.x - (separatorBounds!.x + separatorBounds!.width)).toBeLessThanOrEqual(5);
    await expect(pageNumber).toHaveText('1');
  });

  test('uses matching simple section headers for owned and existing annotations', async ({ page }) => {
    await openAnnotationsWorkspace(page);

    const headers = page.locator('.annotation-drawer__header, .existing-annotations__header');
    await expect(headers).toHaveCount(2);
    const styles = await headers.evaluateAll((elements) => elements.map((element) => {
      const heading = element.querySelector('h2');
      const headerStyle = getComputedStyle(element);
      const headingStyle = heading ? getComputedStyle(heading) : null;
      return {
        position: headerStyle.position,
        marginBottom: headerStyle.marginBottom,
        fontFamily: headingStyle?.fontFamily,
        fontSize: headingStyle?.fontSize,
        fontWeight: headingStyle?.fontWeight,
      };
    }));
    expect(styles[0]).toEqual(styles[1]);
    expect(styles[0]).toMatchObject({ position: 'static', marginBottom: '10px' });
  });

  test('keeps the annotations tray open while editing an owned annotation', async ({ page }) => {
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    await page.getByRole('button', { name: 'Keep', exact: true }).click();
    const { annotations, workspace } = await openAnnotationsWorkspace(page);

    const edit = page.getByRole('button', { name: 'Edit Highlight annotation on page 1' });
    await expect(edit).toHaveAttribute('title', 'Edit annotation');
    await expect(edit.locator('svg')).toHaveCount(1);
    await expect(edit).toHaveText('');
    await edit.click();
    const editor = page.getByRole('region', { name: 'Edit Highlight' });
    await expect(editor).toBeVisible();
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.locator('[data-review-item]')).toHaveCount(1);

    await edit.click();
    await expect(editor).toBeVisible();
    await editor.getByRole('textbox', { name: 'Comment (optional)' }).fill('Edited in the open tray.');
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();

    await expect(editor).toHaveCount(0);
    await expect(workspace).toHaveAttribute('aria-expanded', 'true');
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

    await expect(workspace).toHaveAttribute('aria-expanded', 'true');
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
    await page.getByRole('button', { name: 'Keep', exact: true }).click();

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

  test('delays a hoverable mark peek and opens one selected owned row without shifting the document', async ({ page }) => {
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    await page.getByRole('button', { name: 'Keep', exact: true }).click();

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
    await expect(peek).toContainText('Highlight');
    await expect(peek).not.toContainText('Page 1');
    await expect(peek.getByRole('button')).toHaveCount(0);
    await canvas.click();
    await expect(peek).toHaveCount(0);

    const beforeActivation = await canvas.boundingBox();
    await markTarget.click();
    const drawer = page.locator('#review-tools-workspace');
    await expect(drawer).toHaveAttribute('data-tools-workspace-open', 'true');
    const row = page.locator('[data-review-item]').first();
    await expect(row).toHaveAttribute('data-active', 'true');
    await expect(row.getByRole('button', { name: /Highlight · Page 1/ })).toBeFocused();
    expect(await canvas.boundingBox()).toEqual(beforeActivation);

    const existing = page.getByRole('region', { name: 'From this PDF' });
    await expect(existing.getByRole('button', { name: /Highlight · Page 1 · Source comment/ })).toBeVisible();
    await expect(existing.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
    await expect(existing.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(await currentWorkspaceRail(page)).toBeFocused();
    await expect(page.locator('[data-owned-mark]').first()).toHaveAttribute('data-active', 'true');
    await expect(row).toHaveAttribute('data-active', 'true');
  });

  test('shows an offscreen direction cue without scrolling until explicit mark activation', async ({ page }) => {
    for (let index = 0; index < 7; index += 1) {
      if (index > 0) {
        await page.getByRole('button', { name: 'Clear anchors' }).click();
        await page.getByRole('button', { name: 'Use selection' }).click();
      }
      await page.getByRole('button', { name: 'Highlight', exact: true }).click();
      await page.getByRole('button', { name: 'Keep', exact: true }).click();
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
    await expect(page.locator('[data-correspondence-direction="below"]')).toBeVisible();
    expect(await drawer.evaluate((element) => element.scrollTop)).toBe(scrollBefore);

    await page.keyboard.press('Enter');
    const selected = page.locator('[data-review-item][data-active="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected.getByRole('button', { name: /Highlight · Page 1/ })).toBeFocused();
    expect(await drawer.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollBefore);
  });
});
