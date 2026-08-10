import { expect, test, type Page } from '@playwright/test';

async function openAnnotationsWorkspace(page: Page) {
  const workspace = page.getByRole('button', { name: /^Workspace/u });
  if (await workspace.getAttribute('aria-expanded') !== 'true') await workspace.click();
  await expect(workspace).toHaveAttribute('aria-expanded', 'true');
  const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
  await expect(annotations).toBeVisible();
  if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();
  await expect(annotations).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#workspace-panel-outline')).toBeHidden();
  await expect(page.locator('#workspace-panel-references')).toBeHidden();
  return { annotations, workspace };
}

async function closeWorkspace(page: Page) {
  const workspace = page.getByRole('button', { name: /^Workspace/u });
  if (await workspace.getAttribute('aria-expanded') === 'true') await workspace.click();
  await expect(workspace).toHaveAttribute('aria-expanded', 'false');
  return workspace;
}

test.describe('canonical review workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html');
    await expect(page.getByRole('button', { name: 'Proofread mode' })).toHaveCount(0);
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

    await expect(page.locator('[data-revision]')).toHaveAttribute('data-revision', '7');
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
    await expect(page.locator('[data-annotation-drawer]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close annotations' })).toHaveCount(0);
    await closeWorkspace(page);
    await openAnnotationsWorkspace(page);
    const entry = page.getByRole('button', { name: /replace · Page 1/ });
    await entry.focus();
    await expect(entry).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-navigated]')).not.toHaveAttribute('data-navigated', 'none');
    const deleteEntry = page.getByRole('button', { name: 'Delete replace on page 1' });
    await deleteEntry.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Annotations in document order')).toBeFocused();
  });

  test('keeps a focused delete-only row cohesive in the bottom annotation tray', async ({ page }) => {
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.locator('#root').evaluate((element) => element.setAttribute('data-production-root', 'true'));
    await page.setViewportSize({ width: 320, height: 720 });
    await openAnnotationsWorkspace(page);

    const drawer = page.locator('[data-annotation-drawer]');
    await expect(drawer).toHaveAttribute('data-annotation-presentation', 'bottom');

    const row = drawer.locator('[data-annotation-origin="owned"][data-annotation-kind="delete"]');
    const content = row.getByRole('button', { name: /delete · Page 1/u });
    const action = row.getByRole('button', { name: 'Delete delete on page 1' });
    await content.focus();

    await expect(action).toHaveAttribute('title', 'Delete annotation');
    await expect(action.locator('svg')).toHaveCount(1);
    await expect(action).toHaveText('');
    await expect(content).toHaveCSS('outline-style', 'none');
    await expect(row).toHaveCSS('outline-style', 'solid');

    const kind = row.locator('.annotation-item__meta strong');
    const pageNumber = row.locator('.annotation-item__page');
    const [kindBounds, pageBounds] = await Promise.all([kind.boundingBox(), pageNumber.boundingBox()]);
    expect(kindBounds).not.toBeNull();
    expect(pageBounds).not.toBeNull();
    expect(pageBounds!.x - (kindBounds!.x + kindBounds!.width)).toBeLessThanOrEqual(12);
  });

  test('keeps the complete annotation header fixed while the tray scrolls', async ({ page }) => {
    for (let index = 0; index < 5; index += 1) {
      if (index > 0) await page.getByRole('button', { name: 'Use selection' }).click();
      await page.getByRole('button', { name: 'Highlight', exact: true }).click();
      await page.getByRole('button', { name: 'Keep without comment' }).click();
    }
    await openAnnotationsWorkspace(page);

    const drawer = page.locator('[data-annotation-scroll-viewport]');
    await drawer.evaluate((element) => {
      Object.assign((element as HTMLElement).style, {
        flex: 'none', height: '8rem', bottom: 'auto',
      });
    });
    const header = drawer.locator('.annotation-drawer__header');
    const before = await header.boundingBox();
    expect(before).not.toBeNull();

    await drawer.evaluate((element) => { element.scrollTop = 10; });
    await expect.poll(() => drawer.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const after = await header.boundingBox();
    expect(after).not.toBeNull();
    expect(after!.y).toBeCloseTo(before!.y, 0);
    expect(after!.height).toBeCloseTo(before!.height, 0);
  });

  test('keeps the annotations tray open while editing an owned annotation', async ({ page }) => {
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    await page.getByRole('button', { name: 'Keep without comment' }).click();
    const { annotations, workspace } = await openAnnotationsWorkspace(page);

    const edit = page.getByRole('button', { name: 'Edit highlight on page 1' });
    await expect(edit).toHaveAttribute('title', 'Edit annotation');
    await expect(edit.locator('svg')).toHaveCount(1);
    await expect(edit).toHaveText('');
    await edit.click();
    const editor = page.getByRole('dialog', { name: 'Edit highlight' });
    await expect(editor).toBeVisible();
    await editor.getByRole('textbox', { name: 'Comment (optional)' }).fill('Edited in the open tray.');
    await editor.getByRole('button', { name: 'Save comment' }).click();

    await expect(editor).toHaveCount(0);
    await expect(workspace).toHaveAttribute('aria-expanded', 'true');
    await expect(annotations).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: /highlight · Page 1 · Edited in the open tray\./u })).toBeVisible();
  });

  test('removes spatial disclosure motion when reduced motion is requested', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openAnnotationsWorkspace(page);
    const drawer = page.locator('[data-annotation-drawer]');
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

    const workspace = page.getByRole('button', { name: /^Workspace/u });
    await workspace.focus();
    await page.keyboard.press('Space');

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

  test('supersedes Page Note placement when opening a review drawer', async ({ page }) => {
    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    const workspace = page.getByRole('button', { name: /^Workspace/u });
    const finish = page.getByRole('button', { name: 'Finish' });

    await canvas.focus();
    await page.keyboard.press('Alt+Shift+N');
    await expect(page.getByRole('button', { name: 'Place Page Note' })).toBeVisible();
    await openAnnotationsWorkspace(page);

    await expect(page.getByRole('button', { name: 'Place Page Note' })).toHaveCount(0);
    await expect(page.locator('[data-annotation-drawer]')).toHaveAttribute('data-list-open', 'true');
    await page.keyboard.press('Escape');
    await expect(workspace).toBeFocused();

    await page.getByRole('button', { name: 'Open page actions' }).click();
    await expect(page.getByRole('menu', { name: 'Page actions' })).toBeVisible();
    await finish.click();

    await expect(page.getByRole('menu', { name: 'Page actions' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Finish review' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(finish).toBeFocused();
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
    await expect(peek).toContainText('highlight');
    await expect(peek).not.toContainText('Page 1');
    await expect(peek.getByRole('button')).toHaveCount(0);
    await canvas.click();
    await expect(peek).toHaveCount(0);

    const beforeActivation = await canvas.boundingBox();
    await markTarget.click();
    const drawer = page.locator('[data-annotation-drawer]');
    await expect(drawer).toHaveAttribute('data-list-open', 'true');
    const row = page.locator('[data-review-item]').first();
    await expect(row).toHaveAttribute('data-active', 'true');
    await expect(row.getByRole('button', { name: /highlight · Page 1/ })).toBeFocused();
    expect(await canvas.boundingBox()).toEqual(beforeActivation);

    const existing = page.getByRole('region', { name: 'Existing PDF annotations' });
    await expect(existing.getByRole('button', { name: /Highlight · Page 1 · Source comment/ })).toBeVisible();
    await expect(existing.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
    await expect(existing.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Workspace/u })).toBeFocused();
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
    await expect(selected.getByRole('button', { name: /highlight · Page 1/ })).toBeFocused();
    expect(await drawer.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollBefore);
  });
});
