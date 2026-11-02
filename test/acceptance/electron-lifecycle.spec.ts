import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { InstalledCandidate } from './electron-installed-harness.js';
import { REVIEW_RUNTIME_PROTOCOL, REVIEW_RUNTIME_VERSION } from '../../packages/core/src/review-runtime-protocol.js';

async function ready(page: Page): Promise<void> {
  await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true', { timeout: 30_000 });
}

test('duplicate opens preserve the window and closing protects current input while another PDF remains usable', async () => {
  test.setTimeout(90_000);
  const candidate = await InstalledCandidate.create();
  try {
    const first = await candidate.launch();
    await ready(first);
    const originalBytes = await readFile(candidate.source);
    const secondPath = join(candidate.root, 'Second PDF.pdf');
    await copyFile(candidate.source, secondPath);
    await test.step('Open the second PDF through a second process', () => candidate.open(secondPath));
    await expect.poll(() => candidate.pages().filter(page => page.url().startsWith('placekeeper-app:')).length).toBe(2);
    const second = candidate.pages().find(page => page !== first && page.url().startsWith('placekeeper-app:'))!;
    await ready(second);
    const identity = await first.evaluate(() => window.placekeeper.identity());
    await test.step('Reopen the first PDF without creating another window', () => candidate.open(candidate.source));
    await expect.poll(() => first.evaluate(() => document.hasFocus())).toBe(true);
    expect(candidate.pages().filter(page => page.url().startsWith('placekeeper-app:'))).toHaveLength(2);
    expect(await first.evaluate(() => window.placekeeper.identity())).toMatchObject({ windowId: identity.windowId, attemptId: identity.attemptId });

    const pdfPage = first.locator(".pdf-workspace__page[data-page-index='0']").first();
    await pdfPage.click({ button: 'right', position: { x: 40, y: 300 } });
    await first.getByRole('menuitem', { name: 'Add Page Note' }).click();
    const editor = first.locator('[data-comment-composer] textarea');
    await expect(editor).toBeVisible();
    const text = 'Protect the exact current editor input when this native window closes.';
    await editor.fill(text);
    const sessionId = await first.evaluate(async ({ protocol, version }) => {
      const shell = window.placekeeper;
      const id = await shell.identity();
      const result = await shell.request(id, { protocol, version, kind: 'request', runtimeId: id.windowId,
        requestId: crypto.randomUUID(), method: 'bootstrap', payload: {} }) as { sessionId: string };
      return result.sessionId;
    }, { protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION });
    const closed = first.waitForEvent('close');
    await first.evaluate(() => window.close());
    await test.step('Wait for protected-input settlement and native window close', () => closed);
    const draft = JSON.parse(await readFile(join(candidate.root, 'recovery', sessionId, 'draft.json'), 'utf8')) as {
      payload: { state: { pendingDrafts: Array<{ text: string }> } };
    };
    expect(draft.payload.state.pendingDrafts.some(item => item.text === text)).toBe(true);
    expect(await readFile(candidate.source)).toEqual(originalBytes);
    await ready(second);
    expect(second.isClosed()).toBe(false);
    await expect(second.locator('img').first()).toBeVisible();
  } finally { await candidate.dispose(); }
});
