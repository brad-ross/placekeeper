import { expect, test } from '@playwright/test';

test('sibling save dialog blocks native PDF commands and restores them when closed', async ({ page }) => {
  await page.goto('/test/acceptance/review-harness/index.html?native-commands=1');
  const snapshot = () => page.locator('#root').evaluate((element) => JSON.parse(
    (element as HTMLElement).dataset.nativeCommandSnapshot!,
  ) as { focusContext: string; commands: { id: string; enabled: boolean }[] });
  const pdfCommands = async () => (await snapshot()).commands
    .filter(({ id }) => ['zoom-in', 'zoom-out', 'fit-width'].includes(id));
  await expect.poll(async () => (await pdfCommands()).map(({ enabled }) => enabled)).toEqual([true, true, true]);
  await page.getByRole('button', { name: 'Open sibling save dialog', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(async () => (await snapshot()).focusContext).toBe('dialog');
  await expect.poll(async () => (await pdfCommands()).map(({ enabled }) => enabled)).toEqual([false, false, false]);
  const requests = page.locator('[data-viewer-zoom-requests]');
  const before = await requests.getAttribute('data-viewer-zoom-requests');
  // Native dispatch bypasses modal DOM hit testing, as an app menu does.
  for (const command of ['zoom-in', 'zoom-out', 'fit-width']) {
    await page.getByRole('button', { name: `Native ${command}`, exact: true }).evaluate(
      (element) => (element as HTMLButtonElement).click(),
    );
  }
  await expect(requests).toHaveAttribute('data-viewer-zoom-requests', before!);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => (await pdfCommands()).map(({ enabled }) => enabled)).toEqual([true, true, true]);
  await page.getByRole('button', { name: 'Native zoom-out', exact: true }).click();
  await expect(requests).not.toHaveAttribute('data-viewer-zoom-requests', before!);
});
