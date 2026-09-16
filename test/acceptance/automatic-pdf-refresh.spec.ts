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
      '["begin:1","begin:1","finalize:2:applied","acknowledge:3"]',
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
      '["begin:1","begin:1","finalize:2:discarded","acknowledge:3"]',
    );
    await expect(page.locator('[data-owned-mark="highlight"]')).toHaveCount(0);
  });

  test('reacquires an actively typed editor before a replacement can publish after reconnect', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?interaction-lifecycle=1&interaction-reconnect=1');
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    const composer = page.getByRole('region', { name: 'Highlight Comment' });
    const editor = composer.getByRole('textbox', { name: 'Comment (optional)' });
    await editor.fill('Still typing through reconnect.');

    await page.getByRole('button', { name: 'Reconnect then attempt source replacement' }).click();

    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'active');
    await expect(page.locator('#root')).toHaveAttribute('data-replacement-blocked', 'true');
    await expect(composer).toBeVisible();
    await expect(editor).toHaveValue('Still typing through reconnect.');
    await expect(page.locator('#root')).toHaveAttribute(
      'data-interaction-events',
      '["begin:1","begin:1"]',
    );
    await composer.getByRole('button', { name: 'Cancel' }).click();
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

  test('recovers a fresh editor after begin fails before admission', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?interaction-lifecycle=1&begin-preaccept-fails=1');
    const highlight = page.getByRole('button', { name: 'Highlight', exact: true });
    await highlight.click();
    await expect(page.getByRole('region', { name: 'Highlight Comment' })).toHaveCount(0);
    await expect(page.locator('#root')).not.toHaveAttribute('data-interaction-hold', 'active');

    await highlight.click();
    await expect(page.getByRole('region', { name: 'Highlight Comment' })).toBeVisible();
    const requests = JSON.parse(await page.locator('#root').getAttribute('data-begin-requests') ?? '[]') as Array<{
      interactionToken: string; order: number;
    }>;
    expect(requests).toHaveLength(2);
    expect(requests[0]?.interactionToken).not.toBe(requests[1]?.interactionToken);
    expect(requests.map(({ order }) => order)).toEqual([1, 3]);
    await page.getByRole('region', { name: 'Highlight Comment' })
      .getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'released');
  });

  test('releases a lost accepted begin before a fresh user retry can open', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?interaction-lifecycle=1&begin-response-lost=1');
    const highlight = page.getByRole('button', { name: 'Highlight', exact: true });
    await highlight.click();
    await expect(page.getByRole('region', { name: 'Highlight Comment' })).toHaveCount(0);
    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'released');

    await highlight.click();
    const composer = page.getByRole('region', { name: 'Highlight Comment' });
    await expect(composer).toBeVisible();
    await composer.getByRole('button', { name: 'Cancel' }).click();
    await expect(composer).toHaveCount(0);
    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'released');
    await expect(page.locator('#root')).toHaveAttribute(
      'data-interaction-events',
      '["begin:1","release:2","begin:3","begin:3","finalize:4:discarded","acknowledge:5"]',
    );
    const begins = JSON.parse(await page.locator('#root').getAttribute('data-begin-requests') ?? '[]') as Array<{
      interactionToken: string; order: number;
    }>;
    expect(begins).toHaveLength(3);
    expect(begins[0]?.interactionToken).not.toBe(begins[1]?.interactionToken);
    expect(begins[2]).toEqual(begins[1]);
    const releases = JSON.parse(
      await page.locator('#root').getAttribute('data-release-requests') ?? '[]',
    ) as Array<{ interactionToken: string; order: number }>;
    expect(releases).toEqual([{ interactionToken: begins[0]?.interactionToken, order: 2 }]);
  });

  test('keeps retrying an abandoned release until the next user action can recover it', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?interaction-lifecycle=1&begin-delayed=1&release-fails-twice=1&host-export=1');
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    await page.getByRole('button', { name: 'Remount review shell' }).click();
    await page.getByRole('button', { name: 'Finish interaction begin' }).click();
    await expect.poll(async () => JSON.parse(
      await page.locator('#root').getAttribute('data-release-requests') ?? '[]',
    )).toHaveLength(2);
    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'active');

    const highlight = page.getByRole('button', { name: 'Highlight', exact: true });
    await highlight.click();
    await expect.poll(async () => JSON.parse(
      await page.locator('#root').getAttribute('data-begin-requests') ?? '[]',
    )).toHaveLength(2);
    await page.getByRole('button', { name: 'Finish interaction begin' }).click();
    const composer = page.getByRole('region', { name: 'Highlight Comment' });
    await expect(composer).toBeVisible();
    const releases = JSON.parse(
      await page.locator('#root').getAttribute('data-release-requests') ?? '[]',
    ) as Array<{ interactionToken: string; order: number }>;
    expect(releases).toHaveLength(3);
    expect(releases[1]).toEqual(releases[0]);
    expect(releases[2]).toEqual(releases[0]);
    await composer.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'released');
  });

  test('retries an abandoned unmount release with the exact request', async ({ page }) => {
    await page.goto('/test/acceptance/review-harness/index.html?interaction-lifecycle=1&begin-delayed=1&release-response-lost=1&host-export=1');
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    await page.getByRole('button', { name: 'Remount review shell' }).click();
    await page.getByRole('button', { name: 'Finish interaction begin' }).click();

    await expect.poll(async () => page.locator('#root').getAttribute('data-interaction-events')).toBe(
      '["begin:1","release:2","release:2"]',
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
      '["begin:1","begin:1","finalize:2:applied","begin:1","finalize:2:applied","acknowledge:3"]',
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

  test('reacquires a manual reattachment before replacement can publish after reconnect', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=default&interaction-lifecycle=1&interaction-reconnect=1');
    await page.getByRole('button', { name: 'Show workspace' }).click();
    const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
    if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();
    await page.getByRole('button', {
      name: 'Reattach previous Highlight annotation on page 1',
    }).click();
    const detail = page.locator('[data-reconciliation-detail="reattach"]');
    await expect(detail).toBeVisible();

    await page.getByRole('button', { name: 'Reconnect then attempt source replacement' }).click();

    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'active');
    await expect(page.locator('#root')).toHaveAttribute('data-replacement-blocked', 'true');
    await expect(detail).toBeVisible();
    await expect(page.locator('#root')).toHaveAttribute(
      'data-interaction-events',
      '["begin:1","begin:1"]',
    );
    await detail.getByRole('button', { name: 'Confirm' }).click();
    await expect(detail).toHaveCount(0);
    await expect(page.locator('#root')).toHaveAttribute(
      'data-interaction-events',
      '["begin:1","begin:1","finalize:2:applied","acknowledge:3"]',
    );
  });

  test('releases a manual reattachment when its selected record vanishes elsewhere', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.goto('/test/acceptance/review-harness/index.html?reconciliation=default&interaction-lifecycle=1&external-reconciliation-removal=1');
    await page.getByRole('button', { name: 'Show workspace' }).click();
    const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
    if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();
    await page.getByRole('button', {
      name: 'Reattach previous Highlight annotation on page 1',
    }).click();
    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'active');

    await page.getByRole('button', { name: 'Resolve selected reconciliation elsewhere' }).click();

    await expect(page.locator('[data-reconciliation-detail="reattach"]')).toHaveCount(0);
    await expect(page.locator('#root')).toHaveAttribute('data-interaction-hold', 'released');
    await expect(page.locator('#root')).toHaveAttribute(
      'data-interaction-events',
      '["begin:1","release:2"]',
    );
    await expect(page.getByRole('button', {
      name: 'Reattach previous Delete annotation on page 2',
    })).toBeFocused();
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
