import { expect, test } from '@playwright/test';

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
    await expect(highlight).toBeFocused();
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

  test('keeps canonical history, focus, and mounted draft state across the breakpoint', async ({ page }) => {
    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    await canvas.focus();
    await page.keyboard.press('r');
    const input = page.getByRole('textbox', { name: 'Replacement text' });
    await input.fill('revised wording');
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(input).toHaveValue('revised wording');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('[data-owned-mark]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(page.locator('[data-owned-mark="replace"]')).toHaveCount(1);

    await page.getByRole('button', { name: 'Annotations' }).click();
    const entry = page.getByRole('button', { name: /replace · Page 1/ });
    await entry.click();
    await expect(page.locator('[data-navigated]')).not.toHaveAttribute('data-navigated', 'none');
    await page.getByRole('button', { name: 'Delete replace on page 1' }).click();
    await expect(page.getByLabel('Annotations in document order')).toBeFocused();
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

    const annotations = page.getByRole('button', { name: 'Annotations' });
    await annotations.focus();
    await page.keyboard.press('Space');

    await expect(annotations).toHaveAttribute('aria-expanded', 'true');
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
    const announcement = page.locator('.review-shell > [role="status"]');
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

  test('delays a hoverable mark peek and opens one selected owned row without shifting the document', async ({ page }) => {
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    await page.getByRole('button', { name: 'Keep without comment' }).click();

    const canvas = page.getByRole('application', { name: 'PDF review canvas' });
    const markTarget = page.locator('[data-owned-focus-id]').first();
    await expect(markTarget).toHaveCount(1);
    const before = await canvas.boundingBox();

    await markTarget.hover();
    await canvas.hover();
    await page.waitForTimeout(380);
    await expect(page.locator('[data-annotation-peek]')).toHaveCount(0);

    await markTarget.focus();
    const peek = page.locator('[data-annotation-peek]');
    await expect(peek).toBeVisible();
    await expect(peek).toContainText('highlight · Page 1');
    await page.keyboard.press('Escape');
    await expect(peek).toHaveCount(0);

    await markTarget.click();
    const drawer = page.locator('[data-annotation-drawer]');
    await expect(drawer).toHaveAttribute('data-list-open', 'true');
    const row = page.locator('[data-review-item]').first();
    await expect(row).toHaveAttribute('data-active', 'true');
    await expect(row.getByRole('button', { name: /highlight · Page 1/ })).toBeFocused();
    expect(await canvas.boundingBox()).toEqual(before);

    const existing = page.getByRole('region', { name: 'Existing PDF annotations' });
    await expect(existing.getByRole('button', { name: /Highlight · Page 1 · Source comment/ })).toBeVisible();
    await expect(existing.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
    await expect(existing.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
  });

  test('shows an offscreen direction cue without scrolling until explicit mark activation', async ({ page }) => {
    for (let index = 0; index < 7; index += 1) {
      await page.getByRole('button', { name: 'Highlight', exact: true }).click();
      await page.getByRole('button', { name: 'Keep without comment' }).click();
    }
    await page.getByRole('button', { name: 'Annotations' }).click();
    const drawer = page.locator('[data-annotation-drawer]');
    await drawer.evaluate((element) => {
      Object.assign((element as HTMLElement).style, { height: '7rem', bottom: 'auto' });
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
