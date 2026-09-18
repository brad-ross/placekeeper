import { expect, test } from '@playwright/test';

test('releases a concurrently deleted edited item before closing its editor', async ({ page }) => {
  await page.goto('/test/acceptance/review-harness/index.html?interaction-lifecycle=1');
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Show workspace' }).click();
  const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
  if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();
  const row = page.locator('[data-review-item]').filter({
    has: page.getByRole('button', { name: 'Edit Highlight annotation on page 1' }),
  });
  await row.locator('.annotation-item__navigation').evaluate((button) => {
    (button as HTMLButtonElement).click();
  });

  await page.getByRole('button', { name: 'Edit Highlight annotation on page 1' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByRole('region', { name: 'Edit Highlight' })).toBeVisible();
  await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'active');

  await page.getByRole('button', { name: 'Remove active annotation' }).evaluate((button) => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  await expect(page.getByRole('region', { name: 'Edit Highlight' })).toHaveCount(0);
  await expect(page.locator('#root')).not.toHaveAttribute('data-interaction-hold', 'active');
  await expect(page.getByRole('button', { name: 'Edit Highlight annotation on page 1' })).toHaveCount(0);
});
