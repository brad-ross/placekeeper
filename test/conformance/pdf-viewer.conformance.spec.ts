import { expect, test } from '@playwright/test';

type ViewerInspection = {
  pageCount: number;
  text: string;
  textRectContents: string[];
  reliableTextGeometry: boolean;
  annotationSubtypes: string[];
  renderedWidth: number;
  activeContentExecuted: boolean;
  remoteRequests: string[];
  navigationLinks: Array<{
    pageIndex: number;
    contents: string;
    subject: string;
    target: {
      kind: 'destination' | 'goto' | 'remote-goto' | 'uri' | 'launch' | 'unsupported' | 'missing';
      pageIndex?: number;
      zoomMode?: number;
      params?: number[];
    };
  }>;
  bookmarks: Array<{
    title: string;
    depth: number;
    target: { kind: string; pageIndex?: number };
  }>;
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
    expect(result.text).toContain('Selectable placekeeper text');
    expect(result.textRectContents).toEqual([
      'Selectable placekeeper text: unique equilibrium clearly.',
      'Multiline selection with soft-hyphen-like and combining context.',
    ]);
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

  test('exposes only embedded reference metadata without requesting rejected targets', async ({ page }) => {
    const remoteRequests: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith('http://127.0.0.1:4173/')) remoteRequests.push(request.url());
    });

    const result = await page.evaluate(() =>
      window.viewerGate.inspect('/test/fixtures/pdfs/reference-navigation.pdf'),
    );

    expect(result.pageCount).toBe(4);
    expect(result.navigationLinks).toHaveLength(14);
    expect(result.navigationLinks.map(({ target }) => target.kind)).toEqual(expect.arrayContaining([
      'destination',
      'uri',
      'launch',
      'unsupported',
      'missing',
    ]));
    expect(result.navigationLinks.filter(({ target }) => target.pageIndex === 1)).toHaveLength(4);
    expect(result.navigationLinks.find(({ contents }) => contents === 'Malformed local destination')?.target)
      .toMatchObject({ kind: 'destination', pageIndex: -1 });
    expect(result.navigationLinks.find(({ contents }) => contents === 'Out-of-bounds destination')?.target)
      .toMatchObject({ kind: 'destination', pageIndex: 99 });
    const primary = result.navigationLinks.find(({ contents }) => contents === 'Primary result');
    const repeated = result.navigationLinks.find(({ subject }) => subject === 'Repeated primary result');
    const alias = result.navigationLinks.find(({ contents }) => contents === 'Named alias for primary result');
    const distinct = result.navigationLinks.find(({ contents }) => contents === 'Distinct coordinate on primary page');
    expect(repeated?.target).toEqual(primary?.target);
    expect(alias?.target).toMatchObject({
      kind: primary?.target.kind,
      pageIndex: primary?.target.pageIndex,
      zoomMode: primary?.target.zoomMode,
      params: primary?.target.params,
    });
    expect(distinct?.target.pageIndex).toBe(primary?.target.pageIndex);
    expect(distinct?.target.params).not.toEqual(primary?.target.params);
    expect(result.navigationLinks.filter(({ pageIndex }) => pageIndex === 3).map(({ target }) => target.kind))
      .toEqual(['uri', 'unsupported', 'launch', 'destination', 'missing', 'destination']);
    expect(result.bookmarks.map(({ title, depth }) => ({ title, depth }))).toEqual(expect.arrayContaining([
      { title: 'Overview', depth: 0 },
      { title: 'Details', depth: 0 },
      { title: 'Nested result', depth: 1 },
    ]));
    expect(result.bookmarks.some(({ title }) => title.includes('<script>alert(1)</script>'))).toBe(true);
    expect(result.activeContentExecuted).toBe(false);
    expect(result.remoteRequests).toEqual([]);
    expect(remoteRequests).toEqual([]);

    const absent = await page.evaluate(() =>
      window.viewerGate.inspect('/test/fixtures/pdfs/text-native.pdf'),
    );
    expect(absent.bookmarks).toEqual([]);
  });
});
