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

test.describe('canonical review workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html');
    await expect(page.getByRole('button', { name: 'Proofread mode' })).toHaveCount(0);
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

  test('commits all five tools once through keyboard and toolbar paths', async ({ page }) => {
    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    await canvas.focus();
    await page.keyboard.press('l');
    const replacement = page.getByRole('textbox', { name: 'Replacement text' });
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
    const insertion = page.getByRole('textbox', { name: 'Insertion text' });
    await insertion.fill(' ');
    await page.getByRole('button', { name: 'Apply' }).click();

    await page.getByRole('button', { name: 'Use selection' }).click();
    const highlight = page.getByRole('button', { name: 'Highlight', exact: true });
    await highlight.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Keep without comment' }).click();
    await expect(highlight).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear anchors' }).click();
    await page.getByRole('button', { name: 'Use selection' }).click();
    await highlight.click();
    await page.getByRole('textbox', { name: 'Comment (optional)' }).fill('Check the claim.');
    await page.getByRole('button', { name: 'Save comment' }).click();

    await page.getByRole('button', { name: 'Open page actions' }).click();
    await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
    await page.getByRole('textbox', { name: 'Comment' }).fill('Rewrite this paragraph.');
    await page.getByRole('button', { name: 'Save comment' }).click();

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
    await page.getByRole('textbox', { name: 'Replacement text' }).fill('replacement');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(selectionActions).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear anchors' }).click();
    await page.getByRole('button', { name: 'Use selection' }).click();
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    await page.getByRole('button', { name: 'Keep without comment' }).click();
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

    await expect(page.getByLabel('Zoom level')).toHaveText('—%');
    await expect(page.getByRole('spinbutton', { name: 'Zoom percentage' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Enter a zoom percentage/u })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Fit PDF to available width' })).toBeDisabled();
  });

  test('keeps selection actions after rejection and for a newer selection', async ({ page }) => {
    const selectionActions = page.getByRole('toolbar', { name: 'Selection review actions' });

    await page.getByRole('button', { name: 'Reject next command' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(selectionActions).toBeVisible();

    await page.getByRole('button', { name: 'Reject next command' }).click();
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    await page.getByRole('textbox', { name: 'Replacement text' }).fill('rejected replacement');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(selectionActions).toBeVisible();

    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    await page.getByRole('textbox', { name: 'Replacement text' }).fill('accepted replacement');
    await page.getByRole('button', { name: 'Use selection' }).evaluate((button: HTMLButtonElement) => button.click());
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(selectionActions).toBeVisible();
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
    const input = page.getByRole('textbox', { name: 'Replacement text' });
    await input.fill('revised wording');
    await page.setViewportSize({ width: 320, height: 720 });
    await expect(input).toHaveValue('revised wording');
    const inputBounds = await input.boundingBox();
    expect(inputBounds).not.toBeNull();
    expect(inputBounds!.x).toBeGreaterThanOrEqual(0);
    expect(inputBounds!.x + inputBounds!.width).toBeLessThanOrEqual(320);
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('[data-owned-mark]')).toHaveCount(0);
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
    await page.getByRole('button', { name: 'Keep without comment' }).click();
    const { annotations, workspace } = await openAnnotationsWorkspace(page);

    const edit = page.getByRole('button', { name: 'Edit Highlight annotation on page 1' });
    await expect(edit).toHaveAttribute('title', 'Edit annotation');
    await expect(edit.locator('svg')).toHaveCount(1);
    await expect(edit).toHaveText('');
    await edit.click();
    const editor = page.getByRole('dialog', { name: 'Edit Highlight' });
    await expect(editor).toBeVisible();
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.locator('[data-review-item]')).toHaveCount(1);

    await edit.click();
    await expect(editor).toBeVisible();
    await editor.getByRole('textbox', { name: 'Comment (optional)' }).fill('Edited in the open tray.');
    await editor.getByRole('button', { name: 'Save comment' }).click();

    await expect(editor).toHaveCount(0);
    await expect(workspace).toHaveAttribute('aria-expanded', 'true');
    await expect(annotations).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: /Highlight · Page 1 · Edited in the open tray\./u })).toBeVisible();
  });

  test('removes spatial disclosure motion when reduced motion is requested', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openAnnotationsWorkspace(page);
    const drawer = page.locator('#review-tools-workspace');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveCSS('transition-duration', '0s');
    await expect(drawer).toHaveCSS('animation-duration', '0s');
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
    const replacementDialog = page.getByRole('dialog', { name: 'Replacement text' });
    await expect(replacementDialog.getByRole('textbox', { name: 'Replacement text' })).toHaveValue(' ');
    await replacementDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(canvas).toBeFocused();

    const workspace = await currentWorkspaceRail(page);
    await workspace.press('Space');

    await expect(workspace).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('dialog', { name: 'Replacement text' })).toHaveCount(0);
    await expect(page.locator('[data-revision]')).toHaveAttribute('data-revision', '0');
  });

  test('invokes every semantic tool shortcut without activation', async ({ page }) => {
    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    await canvas.focus();
    await page.keyboard.press('Alt+Shift+R');
    await expect(page.getByRole('dialog', { name: 'Replacement text' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    await canvas.focus();
    await page.keyboard.press('Alt+Shift+D');
    await expect(page.locator('[data-revision]')).toHaveAttribute('data-revision', '1');

    await page.getByRole('button', { name: 'Use caret' }).click();
    await canvas.focus();
    await page.keyboard.press('Alt+Shift+I');
    await expect(page.getByRole('dialog', { name: 'Insertion text' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Use selection' }).click();
    await canvas.focus();
    await page.keyboard.press('Alt+Shift+H');
    await expect(page.getByRole('dialog', { name: 'Highlight comment' })).toBeVisible();
    await page.getByRole('button', { name: 'Keep without comment' }).click();

    await canvas.focus();
    await page.keyboard.press('Alt+Shift+N');
    await expect(page.getByRole('button', { name: 'Place Page Note' })).toBeVisible();
    await page.getByRole('button', { name: 'Place Page Note' }).click();
    await expect(page.getByRole('dialog', { name: 'Page Note' })).toBeVisible();
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
    await expect(announcement).toContainText('Choose a reliable text position');
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
    await page.getByRole('button', { name: 'Keep without comment' }).click();

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

    const existing = page.getByRole('region', { name: 'External Annotations (read only)' });
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
      await page.getByRole('button', { name: 'Keep without comment' }).click();
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
