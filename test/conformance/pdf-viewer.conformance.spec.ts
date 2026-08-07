import { expect, test } from '@playwright/test';

type ViewerInspection = {
  pageCount: number;
  text: string;
  reliableTextGeometry: boolean;
  annotationSubtypes: string[];
  renderedWidth: number;
  activeContentExecuted: boolean;
  remoteRequests: string[];
};

declare global {
  interface Window {
    viewerGate: {
      inspect(url: string, timeoutMs?: number): Promise<ViewerInspection>;
    };
  }
}

test.describe('EmbedPDF browser-worker viewer gate', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', (message) => console.log(`[browser:${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => console.log(`[browser:pageerror] ${error.message}`));
    page.on('response', (response) => {
      if (response.status() >= 400) {
        console.log(`[browser:response] ${response.status()} ${response.url()}`);
      }
    });
    await page.goto('/test/conformance/viewer-harness/index.html');
    await page.waitForFunction(() => typeof window.viewerGate?.inspect === 'function');
  });

  test('extracts reliable text geometry and inventories existing annotations', async ({ page }) => {
    const result = await page.evaluate(() =>
      window.viewerGate.inspect('/test/fixtures/pdfs/text-native-with-annotations.pdf'),
    );

    expect(result.pageCount).toBe(1);
    expect(result.text).toContain('Selectable proofreader text');
    expect(result.reliableTextGeometry).toBe(true);
    expect(result.annotationSubtypes).toEqual(expect.arrayContaining(['highlight', 'stamp']));
    expect(result.renderedWidth).toBeGreaterThan(0);
  });

  test('refuses semantic anchors for an image-only page', async ({ page }) => {
    const result = await page.evaluate(() =>
      window.viewerGate.inspect('/test/fixtures/pdfs/image-only.pdf'),
    );

    expect(result.reliableTextGeometry).toBe(false);
    expect(result.text).toBe('');
  });

  test('keeps active content inert and bounds malformed worker failures', async ({ page }) => {
    const remoteRequests: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith('http://127.0.0.1:4173/')) remoteRequests.push(request.url());
    });
    const hostile = await page.evaluate(() =>
      window.viewerGate.inspect('/test/fixtures/pdfs/hostile-actions.pdf'),
    );
    expect(hostile.activeContentExecuted).toBe(false);
    expect(hostile.remoteRequests).toEqual([]);
    expect(remoteRequests).toEqual([]);

    await expect(
      page.evaluate(() =>
        window.viewerGate.inspect('/test/fixtures/pdfs/malformed.pdf', 1_000),
      ),
    ).rejects.toThrow(/invalid|malformed|open|timeout/i);
  });
});
