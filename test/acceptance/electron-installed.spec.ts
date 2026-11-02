import { expect, test } from '@playwright/test';
import { InstalledCandidate } from './electron-installed-harness.js';
import { REVIEW_RUNTIME_PROTOCOL, REVIEW_RUNTIME_VERSION } from '../../packages/core/src/review-runtime-protocol.js';

test('packaged candidate renders and activates a real PDF without system Node', async ({}, testInfo) => {
  const candidate = await InstalledCandidate.create();
  try {
    const page = await candidate.launch();
    await expect(page.locator('img').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true');
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
        arbitraryMethod: await rejected(() => shell.request(identity, { ...request, method: 'readFile', payload: { path: '/etc/passwd' } })),
        pathInjection: await rejected(() => shell.request(identity, { ...request, path: '/etc/passwd' })),
      };
    }, { protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION });
    expect(isolation).toEqual({ node: false, wrongWindow: true, arbitraryMethod: true, pathInjection: true });
    await page.screenshot({ path: testInfo.outputPath('review.png') });
    await testInfo.attach('review', { path: testInfo.outputPath('review.png'), contentType: 'image/png' });
    await testInfo.attach('runtime-errors', { body: JSON.stringify(candidate.errors), contentType: 'application/json' });
    expect(candidate.errors).toEqual([]);
  } finally { await candidate.dispose(); }
});
