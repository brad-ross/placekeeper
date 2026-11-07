import { expect, test } from '@playwright/test';
import { InstalledCandidate } from './electron-installed-harness.js';
import { REVIEW_RUNTIME_PROTOCOL, REVIEW_RUNTIME_VERSION } from '../../packages/core/src/review-runtime-protocol.js';

test('packaged candidate renders and activates a real PDF without system Node', async ({}, testInfo) => {
  const candidate = await InstalledCandidate.create();
  try {
    const page = await candidate.launch();
    await expect(page.locator('img').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true');
    await expect.poll(() => candidate.timings().some(event => event.stage === 'visible-active')).toBe(true);
    const titlebarGeometry = () => page.evaluate(() => {
      const overlay = (navigator as Navigator & { windowControlsOverlay?: {
        visible: boolean; getTitlebarAreaRect(): DOMRect;
      } }).windowControlsOverlay;
      const chrome = document.querySelector<HTMLElement>('[data-review-chrome]')!;
      const bounds = chrome.getBoundingClientRect();
      const shell = chrome.closest<HTMLElement>('.electron-review-shell')!;
      const macOS = shell.dataset.nativePlatform === 'darwin';
      const interfaceScale = Number(getComputedStyle(shell).getPropertyValue('--electron-interface-scale')) || 1;
      const safe = overlay?.getTitlebarAreaRect();
      const identity = chrome.querySelector<HTMLElement>('.review-chrome__identity')!.getBoundingClientRect();
      const navigation = chrome.querySelector<HTMLElement>('.review-chrome__left-controls')!.getBoundingClientRect();
      const controls = [...chrome.querySelectorAll<HTMLElement>('button,input,[tabindex]')]
        .filter(element => element.checkVisibility());
      return {
        nativeControlsVisible: overlay?.visible === true,
        top: bounds.top, height: bounds.height,
        expectedHeight: macOS ? 52 : Math.max(52, safe?.height ?? 0),
        filenameGap: navigation.left - identity.right,
        leadingInset: identity.left,
        expectedLeadingInset: macOS ? 32 + 60 / interfaceScale : Math.max(16, safe?.left ?? 0),
        controlsInsideSafeArea: Boolean(safe) && controls.every(element => {
          const rect = element.getBoundingClientRect();
          return rect.left >= safe!.left && rect.right <= safe!.right;
        }),
        drag: getComputedStyle(chrome).getPropertyValue('-webkit-app-region'),
        inputsClickable: controls.every(element => getComputedStyle(element).getPropertyValue('-webkit-app-region') === 'no-drag'),
        controlGroups: [...chrome.querySelectorAll<HTMLElement>('[data-review-chrome-group]')]
          .filter(element => element.checkVisibility())
          .map(element => ({ group: element.dataset.reviewChromeGroup,
            region: getComputedStyle(element).getPropertyValue('-webkit-app-region') })),
      };
    });
    await expect.poll(titlebarGeometry).toMatchObject({ nativeControlsVisible: true, top: 0,
      filenameGap: 10, controlsInsideSafeArea: true, drag: 'drag', inputsClickable: true });
    const spacing = await titlebarGeometry();
    expect(spacing.height).toBe(spacing.expectedHeight);
    expect(spacing.leadingInset).toBe(spacing.expectedLeadingInset);
    // Native hit testing includes the spaces between controls in each group.
    expect(spacing.controlGroups).toEqual([
      { group: 'navigation', region: 'no-drag' },
      { group: 'history', region: 'no-drag' },
      { group: 'zoom', region: 'no-drag' },
    ]);
    const trayControls = page.getByRole('group', { name: 'Workspace trays', exact: true });
    await expect(trayControls).toHaveCSS('-webkit-app-region', 'no-drag');
    const workspaceToggle = trayControls.getByRole('button', { name: 'Show Workspace', exact: true });
    await expect(workspaceToggle).toHaveAttribute('aria-expanded', 'false');
    await workspaceToggle.click();
    const expandedToggle = trayControls.getByRole('button', { name: 'Hide Workspace', exact: true });
    await expect(expandedToggle).toHaveAttribute('aria-expanded', 'true');
    const tray = page.locator('#review-tools-workspace[data-tools-workspace-open="true"], #review-workspace[data-workspace-open="true"]');
    await tray.getByRole('button', { name: 'Hide Workspace', exact: true }).click();
    await expect(workspaceToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(workspaceToggle).toBeFocused();

    const pageInput = page.locator('[data-review-chrome] .review-chrome__page-input');
    await pageInput.click();
    await expect(pageInput).toBeFocused();
    await pageInput.fill('1');
    await pageInput.press('Enter');
    await page.getByRole('button', { name: /Open automatic save options/ }).click();
    const saveDialog = page.getByRole('dialog', { name: 'Choose where to save annotations' });
    await expect(saveDialog).toBeVisible();
    await saveDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(saveDialog).not.toBeVisible();
    const zoomDisclosure = page.getByRole('button', { name: 'Open zoom controls', exact: true });
    const zoomBounds = (await zoomDisclosure.boundingBox())!;
    await page.mouse.move(zoomBounds.x + zoomBounds.width / 2, zoomBounds.y + zoomBounds.height / 2);
    await expect(zoomDisclosure).toHaveCSS('pointer-events', 'auto');
    await zoomDisclosure.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    const scope = await page.evaluate(async ({ protocol, version }) => {
      const shell = window.placekeeper;
      const identity = await shell.identity();
      const common = { protocol, version, kind: 'request', runtimeId: identity.windowId };
      const bootstrap = await shell.request(identity, { ...common, requestId: crypto.randomUUID(), method: 'bootstrap', payload: {} }) as Record<string, unknown>;
      return shell.request(identity, {
        ...common, requestId: crypto.randomUUID(), method: 'scope', payload: {},
        sessionId: bootstrap.sessionId, generation: bootstrap.generation, revision: bootstrap.revision,
      });
    }, { protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION });
    expect(scope).toMatchObject({ ok: true, method: 'scope' });
    const isolation = await page.evaluate(async ({ protocol, version }) => {
      const shell = window.placekeeper;
      const identity = await shell.identity();
      const request = { protocol, version, kind: 'request', runtimeId: identity.windowId,
        requestId: crypto.randomUUID(), method: 'bootstrap', payload: {} };
      const rejected = async (action: () => Promise<unknown>) => {
        try { await action(); return false; } catch { return true; }
      };
      return {
        node: 'require' in window || 'process' in window,
        wrongWindow: await rejected(() => shell.request({ ...identity, windowId: crypto.randomUUID() }, request)),
        foreignToolbar: await rejected(() => shell.toolbarHeight({ ...identity, windowId: crypto.randomUUID() }, 52)),
        invalidToolbar: await rejected(() => shell.toolbarHeight(identity, Number.NaN)),
        arbitraryMethod: await rejected(() => shell.request(identity, { ...request, method: 'readFile', payload: { path: '/etc/passwd' } })),
        pathInjection: await rejected(() => shell.request(identity, { ...request, path: '/etc/passwd' })),
      };
    }, { protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION });
    expect(isolation).toEqual({ node: false, wrongWindow: true, foreignToolbar: true, invalidToolbar: true, arbitraryMethod: true, pathInjection: true });
    await page.screenshot({ path: testInfo.outputPath('review.png') });
    await testInfo.attach('review', { path: testInfo.outputPath('review.png'), contentType: 'image/png' });
    await testInfo.attach('runtime-errors', { body: JSON.stringify(candidate.errors), contentType: 'application/json' });
    expect(candidate.errors).toEqual([]);
  } finally { await candidate.dispose(); }
});
