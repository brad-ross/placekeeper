import { expect, test } from '@playwright/test';

test.describe('automatic PDF refresh annotation lifecycle', () => {
  test('consumes a durable annotation receipt after the editor closes and restores focus', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?interaction-lifecycle=1');
    const highlight = page.getByRole('button', { name: 'Highlight', exact: true });
    await highlight.focus();
    await highlight.click();
    const composer = page.getByRole('region', { name: 'Highlight Comment' });
    await expect(composer).toBeVisible();
    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'active');
    const editor = composer.getByRole('textbox', { name: 'Comment (optional)' });
    await editor.fill('Durable before refresh.');
    await editor.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'active');
    await editor.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '.' }));
    });
    await page.getByRole('button', { name: /Open automatic save options/u }).click();
    await expect(page.getByRole('dialog', { name: 'Choose Where to Save Annotations' })).toBeVisible();
    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'active');
    await page.keyboard.press('Escape');
    await expect(composer).toBeVisible();
    await expect(editor).toHaveValue('Durable before refresh.');
    await composer.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(composer).toHaveCount(0);
    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'released');
    await expect.poll(async () => page.locator('#root').getAttribute('data-interaction-events')).toBe(
      '["begin:1","finalize:2:applied","acknowledge:3"]',
    );
    await expect(page.locator('[data-owned-mark="highlight"]')).toHaveText('Durable before refresh.');
    await expect(page.getByRole('application', { name: 'PDF review canvas' })).toBeFocused();
  });

  test('durably discards a cancelled draft before releasing its generation hold', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?interaction-lifecycle=1');
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    const composer = page.getByRole('region', { name: 'Highlight Comment' });
    await composer.getByRole('textbox', { name: 'Comment (optional)' }).fill('Do not apply this draft.');
    await composer.getByRole('button', { name: 'Cancel' }).click();

    await expect(composer).toHaveCount(0);
    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'released');
    await expect.poll(async () => page.locator('#root').getAttribute('data-interaction-events')).toBe(
      '["begin:1","finalize:2:discarded","acknowledge:3"]',
    );
    await expect(page.locator('[data-owned-mark="highlight"]')).toHaveCount(0);
  });

  test('releases an admission that resolves after its authoring surface unmounts', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?interaction-lifecycle=1&begin-delayed=1&host-export=1');
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Highlight Comment' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Remount review shell' }).click();
    await page.getByRole('button', { name: 'Finish interaction begin' }).click();

    await expect.poll(async () => page.locator('#root').getAttribute('data-interaction-events')).toBe(
      '["begin:1","release:2"]',
    );
    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'released');
    await expect(page.getByRole('region', { name: 'Highlight Comment' })).toHaveCount(0);
  });

  test('retries the exact terminal request after a lost response and an already-published successor', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?interaction-lifecycle=1&finalize-response-lost=1');
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    const composer = page.getByRole('region', { name: 'Highlight Comment' });
    await composer.getByRole('textbox', { name: 'Comment (optional)' }).fill('Committed before reconnect.');
    await composer.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(composer).toBeVisible();
    await expect.poll(async () => JSON.parse(
      await page.locator('#root').getAttribute('data-finalize-requests') ?? '[]',
    )).toHaveLength(1);
    await composer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(composer).toHaveCount(0);
    await expect(page.locator('[data-owned-mark="highlight"]')).toHaveText('Committed before reconnect.');
    await expect.poll(async () => JSON.parse(
      await page.locator('#root').getAttribute('data-finalize-requests') ?? '[]',
    )).toHaveLength(2);
    const requests = JSON.parse(
      await page.locator('#root').getAttribute('data-finalize-requests') ?? '[]',
    ) as unknown[];
    expect(requests[1]).toEqual(requests[0]);
    await expect(page.locator('#root')).toHaveAttribute(
      'data-interaction-events',
      '["begin:1","finalize:2:applied","finalize:2:applied","acknowledge:3"]',
    );
  });

  test('finalizes manual reattachment through a protected draft and cannot reuse predecessor geometry', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=default&interaction-lifecycle=1');
    await page.getByRole('button', { name: 'Show workspace' }).click();
    const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
    if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();
    await page.getByRole('button', {
      name: 'Reattach previous Highlight annotation on page 1',
    }).click();
    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'active');
    const detail = page.locator('[data-reconciliation-detail="reattach"]');
    await detail.getByRole('button', { name: 'Confirm' }).click();

    await expect(detail).toHaveCount(0);
    await expect.poll(async () => page.locator('#root').getAttribute('data-interaction-events')).toBe(
      '["begin:1","finalize:2:applied","acknowledge:3"]',
    );
    await expect(page.getByRole('button', {
      name: 'Reattach previous Highlight annotation on page 1',
    })).toHaveCount(0);
  });

  test('reconciles an uncertain manual reattachment before cancel can orphan its hold', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=default&interaction-lifecycle=1&finalize-response-lost=1');
    await page.getByRole('button', { name: 'Show workspace' }).click();
    const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
    if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();
    await page.getByRole('button', {
      name: 'Reattach previous Highlight annotation on page 1',
    }).click();
    await page.locator('[data-reconciliation-detail="reattach"]')
      .getByRole('button', { name: 'Confirm' }).click();

    await expect.poll(async () => page.locator('#root').getAttribute('data-interaction-events')).toBe(
      '["begin:1","finalize:2:applied","finalize:2:applied","acknowledge:3"]',
    );
    const requests = JSON.parse(
      await page.locator('#root').getAttribute('data-finalize-requests') ?? '[]',
    ) as unknown[];
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'released');
    await expect(page.getByRole('button', {
      name: 'Reattach previous Highlight annotation on page 1',
    })).toHaveCount(0);
  });
});
