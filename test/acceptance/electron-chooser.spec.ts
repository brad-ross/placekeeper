import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

async function openEndpointChooser(page: import('@playwright/test').Page) {
    const shell = await readFile(resolve('dist/electron-web/assets/shell.js'));
    const css = await readFile(resolve('dist/electron-web/assets/shell.css'));
    await page.addInitScript(() => {
        const target = window as typeof window & { __chooserResults?: unknown[] };
        target.__chooserResults = [];
        Object.defineProperty(window, 'placekeeper', { value: Object.freeze({
            identity: async () => ({ windowId: 'window12345678', attemptId: 'attempt12345678', sourceEndpointToken: 'token12345678' }),
            sourceEndpoint: async (identity: unknown, token: string, endpoint: string | null) => { target.__chooserResults!.push({ identity, token, endpoint }); },
            writeClipboard: async () => {},
            request: async () => { throw new Error('A standalone chooser cannot admit a review'); },
        }) });
    });
    await page.route('**/chooser.js', route => route.fulfill({ contentType: 'text/javascript', body: shell }));
    await page.route('**/chooser.css', route => route.fulfill({ contentType: 'text/css', body: css }));
    await page.route('**/chooser.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/chooser.css"></head><body><div id="root"></div><script type="module" src="/chooser.js"></script></body></html>' }));
    await page.goto('/chooser.html');
}

test('standalone Neovim chooser submits Windows named pipes without review authority', async ({ page }) => {
    await openEndpointChooser(page);
    const input = page.getByRole('textbox', { name: 'Socket or named pipe' });
    await expect(input).toBeFocused();
    await expect(page.getByRole('button', { name: 'Choose Source Folder…' })).toBeDisabled();
    await input.fill('\\\\.\\pipe\\nvim-main');
    await page.getByRole('button', { name: 'Choose Source Folder…' }).click();
    expect(await page.evaluate(() => (window as typeof window & { __chooserResults?: unknown[] }).__chooserResults)).toEqual([{ identity: { windowId: 'window12345678', attemptId: 'attempt12345678', sourceEndpointToken: 'token12345678' }, token: 'token12345678', endpoint: '\\\\.\\pipe\\nvim-main' }]);
});

test('standalone Neovim chooser traps focus and Escape cancels without a selection', async ({ page }) => {
    await openEndpointChooser(page);
    const input = page.getByRole('textbox', { name: 'Socket or named pipe' });
    await input.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(input).toBeFocused();
    await input.press('Escape');
    expect(await page.evaluate(() => (window as typeof window & { __chooserResults?: Array<{ endpoint: unknown }> }).__chooserResults?.map(result => result.endpoint))).toEqual([null]);
});
