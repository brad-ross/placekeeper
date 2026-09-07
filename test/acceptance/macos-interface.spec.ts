import { expect, test, type Page } from '@playwright/test';

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface DragMessage {
  readonly type: 'drag-regions';
  readonly geometryIdentity: string;
  readonly transitioning: boolean;
  readonly regions: readonly Rect[];
}

function overlaps(first: Rect, second: Rect): boolean {
  return first.x < second.x + second.width && first.x + first.width > second.x
    && first.y < second.y + second.height && first.y + first.height > second.y;
}

async function latestSettledDrag(page: Page, identity: string): Promise<DragMessage> {
  await expect.poll(() => page.evaluate((expectedIdentity) => {
    const messages = (window as typeof window & { __macMessages: unknown[] }).__macMessages;
    return messages.filter((candidate) => {
      const message = candidate as Partial<DragMessage>;
      return message.type === 'drag-regions'
        && message.geometryIdentity === expectedIdentity
        && message.transitioning === false;
    }).length;
  }, identity)).toBeGreaterThan(0);
  return page.evaluate((expectedIdentity) => {
    const messages = (window as typeof window & { __macMessages: unknown[] }).__macMessages;
    return messages.filter((candidate) => {
      const message = candidate as Partial<DragMessage>;
      return message.type === 'drag-regions'
        && message.geometryIdentity === expectedIdentity
        && message.transitioning === false;
    }).at(-1) as DragMessage;
  }, identity);
}

async function settledDragCount(page: Page, identity: string): Promise<number> {
  return page.evaluate((expectedIdentity) => {
    const messages = (window as typeof window & { __macMessages: unknown[] }).__macMessages;
    return messages.filter((candidate) => {
      const message = candidate as Partial<DragMessage>;
      return message.type === 'drag-regions'
        && message.geometryIdentity === expectedIdentity
        && message.transitioning === false;
    }).length;
  }, identity);
}

test('publishes aligned, control-safe macOS drag geometry across menus and fullscreen', async ({ browser }) => {
  const context = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1200, height: 820 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const target = window as typeof window & { __macMessages: unknown[]; webkit?: unknown };
    target.__macMessages = [];
    target.webkit = {
      messageHandlers: {
        placekeeperShell: {
          postMessage(message: unknown) { target.__macMessages.push(message); },
        },
      },
    };
  });
  await page.goto('/apps/web/macos.html');

  const windowedIdentity = 'geometry_windowed_1234';
  await page.evaluate(({ identity }) => {
    (window as typeof window & { __PLACEKEEPER_MAC_RECEIVE__?: (value: unknown) => void })
      .__PLACEKEEPER_MAC_RECEIVE__?.({
        protocolVersion: 1,
        type: 'bootstrap',
        document: {
          displayName: 'Paper.pdf',
          resource: {
            url: 'placekeeper-resource://document/resource_12345678?generation=1&role=document',
            generation: 1,
            mime: 'application/pdf',
            byteLength: 995,
            digest: 'a'.repeat(64),
          },
        },
        geometry: {
          identity,
          trafficLightInset: 86,
          trafficLightBounds: [
            { x: 16, y: 20, width: 14, height: 14 },
            { x: 36, y: 20, width: 14, height: 14 },
            { x: 56, y: 20, width: 14, height: 14 },
          ],
          trailingInset: 16,
        },
      });
  }, { identity: windowedIdentity });

  let drag = await latestSettledDrag(page, windowedIdentity);
  const aligned = await page.evaluate(() => {
    const chrome = document.querySelector<HTMLElement>('.review-chrome')!;
    const title = document.querySelector<HTMLElement>('.review-chrome__save-identity')!;
    const chromeBounds = chrome.getBoundingClientRect();
    const titleBounds = title.getBoundingClientRect();
    return {
      chrome: { x: chromeBounds.x, y: chromeBounds.y, width: chromeBounds.width, height: chromeBounds.height },
      title: { x: titleBounds.x, y: titleBounds.y, width: titleBounds.width, height: titleBounds.height },
      controls: [...chrome.querySelectorAll<HTMLElement>(
        "button,input,select,textarea,a[href],summary,[contenteditable]:not([contenteditable='false']),[role='button'],[role='link'],[tabindex]:not([tabindex='-1'])",
      )].filter((element) => element.closest("[inert],[hidden],[aria-hidden='true']") === null)
        .map((element) => {
          const bounds = element.getBoundingClientRect();
          return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        }).filter(({ width, height }) => width > 0 && height > 0),
    };
  });
  expect(aligned.chrome.height).toBe(54);
  expect(aligned.title.y - aligned.chrome.y + aligned.title.height / 2).toBe(27);
  expect(drag.regions.length).toBeGreaterThan(0);
  for (const region of drag.regions) {
    for (const control of aligned.controls) expect(overlaps(region, control)).toBe(false);
  }

  const settledBeforePopup = await settledDragCount(page, windowedIdentity);
  await page.evaluate(() => {
    const popup = document.createElement('div');
    popup.className = 'document-actions__menu top-bar-menu__surface';
    popup.dataset.macosProofPopup = 'true';
    Object.assign(popup.style, {
      position: 'fixed', left: '850px', top: '48px', width: '180px', display: 'grid',
    });
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = 'Fit width';
    popup.append(item);
    document.body.append(popup);
    document.querySelector('.review-chrome')?.setAttribute('data-top-bar-menu-open', 'zoom');
  });
  await expect.poll(() => settledDragCount(page, windowedIdentity)).toBeGreaterThan(settledBeforePopup);
  drag = await latestSettledDrag(page, windowedIdentity);
  const popupEvidence = await page.locator('[data-macos-proof-popup]').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maxHeight: style.maxHeight,
      overflowY: style.overflowY,
    };
  });
  let popupBounds: Rect = popupEvidence;
  expect(popupEvidence.height).toBeLessThan(100);
  expect(popupEvidence.maxHeight).toBe('796px');
  expect(popupEvidence.overflowY).toBe('auto');
  for (const region of drag.regions) expect(overlaps(region, popupBounds)).toBe(false);

  const nativeDismissal = await page.evaluate(() => {
    let received: { target: string; pointerType: string; bubbles: boolean; cancelable: boolean } | undefined;
    document.addEventListener('pointerdown', (event) => {
      received = {
        target: event.target === document ? 'document' : 'other',
        pointerType: event.pointerType,
        bubbles: event.bubbles,
        cancelable: event.cancelable,
      };
    }, { capture: true, once: true });
    (window as typeof window & { __PLACEKEEPER_MAC_DISMISS_TOP_BAR_MENUS__?: () => void })
      .__PLACEKEEPER_MAC_DISMISS_TOP_BAR_MENUS__?.();
    return received;
  });
  expect(nativeDismissal).toEqual({
    target: 'document',
    pointerType: 'mouse',
    bubbles: true,
    cancelable: true,
  });

  const settledBeforeMove = await settledDragCount(page, windowedIdentity);
  await page.locator('[data-macos-proof-popup]').evaluate((element) => { element.style.top = '44px'; });
  await expect.poll(() => settledDragCount(page, windowedIdentity)).toBeGreaterThan(settledBeforeMove);
  drag = await latestSettledDrag(page, windowedIdentity);
  popupBounds = await page.locator('[data-macos-proof-popup]').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  });
  for (const region of drag.regions) expect(overlaps(region, popupBounds)).toBe(false);

  const settledBeforeRemoval = await settledDragCount(page, windowedIdentity);
  await page.locator('[data-macos-proof-popup]').evaluate((element) => {
    element.remove();
    document.querySelector('[data-review-chrome]')?.removeAttribute('data-top-bar-menu-open');
  });
  await expect.poll(() => settledDragCount(page, windowedIdentity)).toBeGreaterThan(settledBeforeRemoval);
  drag = await latestSettledDrag(page, windowedIdentity);
  expect(drag.regions.some((region) => overlaps(region, popupBounds))).toBe(true);

  const fullscreenIdentity = 'geometry_fullscreen_1234';
  await page.evaluate(({ identity }) => {
    (window as typeof window & { __PLACEKEEPER_MAC_RECEIVE__?: (value: unknown) => void })
      .__PLACEKEEPER_MAC_RECEIVE__?.({
        protocolVersion: 1,
        type: 'geometry-changed',
        geometry: {
          identity,
          trafficLightInset: 16,
          trafficLightBounds: [],
          trailingInset: 16,
        },
      });
  }, { identity: fullscreenIdentity });
  drag = await latestSettledDrag(page, fullscreenIdentity);
  expect(await page.locator('[data-review-chrome]').evaluate((element) => element.getBoundingClientRect().height)).toBe(50);
  const fullscreenControls = await page.locator('[data-review-chrome]').evaluate((chrome) => (
    [...chrome.querySelectorAll<HTMLElement>('button,input,a[href],[role=button],[tabindex]')]
      .filter((element) => element.closest("[inert],[hidden],[aria-hidden='true']") === null)
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      }).filter(({ width, height }) => width > 0 && height > 0)
  ));
  for (const region of drag.regions) {
    for (const control of fullscreenControls) expect(overlaps(region, control)).toBe(false);
  }
  await context.close();
});

for (const width of [620, 360]) {
  test(`Mac recovery shares Placekeeper controls and sends one choice at ${width}px`, async ({ browser }) => {
    const context = await browser.newContext({ bypassCSP: true, viewport: { width, height: 380 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const target = window as typeof window & { __recoveryChoices: unknown[]; webkit?: unknown };
      target.__recoveryChoices = [];
      Object.defineProperty(target, "webkit", { value: { messageHandlers: { placekeeperRecovery: {
        postMessage: (message: unknown) => target.__recoveryChoices.push(message),
      } } } });
    });
    try {
      for (const choice of ['resume', 'fork', 'discard']) {
        await page.goto('/apps/web/recovery.html');
        await expect(page.getByRole('heading', { name: 'Existing review recovered' })).toBeVisible();
        const resume = page.getByRole('button', { name: 'Resume', exact: true });
        await expect(resume).toBeFocused();
        await expect(resume).toHaveCSS('background-color', 'rgb(60, 60, 60)');
        await expect(page.getByRole('dialog')).toHaveCSS('border-radius', '17px');
        const buttons = page.locator('[data-recovery-choice]');
        await expect(buttons).toHaveCount(3);
        for (const button of await buttons.all()) {
          const rect = (await button.boundingBox())!;
          expect(rect.x).toBeGreaterThanOrEqual(0);
          expect(rect.x + rect.width).toBeLessThanOrEqual(width);
          await expect(button.locator('svg')).toBeVisible();
        }
        if (choice === 'resume') await page.screenshot({ path: test.info().outputPath(`recovery-ready-${width}.png`) });
        if (choice === 'resume') await page.keyboard.press('Enter');
        else await page.locator(`[data-recovery-choice="${choice}"]`).click();
        await expect(page.getByRole('status')).toHaveText('Opening the protected review…');
        for (const button of await buttons.all()) await expect(button).toBeDisabled();
        await expect.poll(() => page.evaluate(() => (window as typeof window & { __recoveryChoices: unknown[] }).__recoveryChoices))
          .toEqual([{ ready: true }, { decision: choice }]);
      }
      await page.goto('/apps/web/recovery.html');
      await page.evaluate(() => window.dispatchEvent(new Event('placekeeper-recovery-failed')));
      await expect(page.getByRole('status')).toContainText('Close this window and try again');
      for (const button of await page.locator('[data-recovery-choice]').all()) await expect(button).toBeDisabled();
      await page.screenshot({ path: test.info().outputPath(`recovery-failed-${width}.png`) });
    } finally { await context.close(); }
  });
}
