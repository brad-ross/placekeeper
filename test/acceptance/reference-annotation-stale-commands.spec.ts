import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';

import { PlacekeeperHost } from '../../apps/service/src/host/placekeeper-host.js';
import { addPageNote } from '../../packages/core/src/review-commands.js';

const READY_TIMEOUT = 15_000;

let root = '';
let sourceRoot = '';
let referencePdf = '';
let replacementPdf = '';
let host: PlacekeeperHost;

async function freshPdf(path: string): Promise<string> {
  const directory = join(root, randomUUID());
  await mkdir(directory);
  const copy = join(directory, basename(path));
  await copyFile(path, copy);
  return copy;
}

async function openFixture(
  page: Page,
  workflowMode: 'standard' | 'generated-output',
): Promise<{
  readonly sessionId: string;
  readonly documentGeneration: number;
  readonly livePdf: string;
  readonly itemId: string;
}> {
  const livePdf = await freshPdf(referencePdf);
  const launched = await host.open({
    pdfPath: livePdf,
    sourceRootPath: sourceRoot,
    workflowMode,
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Stale-command Reference fixture did not launch.');
  }
  const initial = host.broker.state(launched.sessionId);
  if (!initial) throw new Error('Stale-command Reference state is unavailable.');
  await host.broker.acceptMutation(launched.sessionId, addPageNote(
    initial,
    0,
    { x: 90, y: 180, width: 18, height: 18 },
    'Deferred Reference edit target.',
  ));
  const item = host.broker.state(launched.sessionId)?.items.find(
    (candidate) => candidate.payload.comment === 'Deferred Reference edit target.',
  );
  if (!item) throw new Error('Deferred Reference edit item is unavailable.');

  await page.goto(launched.url);
  await expect(page.locator('[data-production-review]')).toHaveAttribute(
    'data-initial-view-ready',
    'true',
  );
  await expect(page.locator(
    '.pdf-workspace:not(.pdf-workspace--reference) .pdf-workspace__page[data-page-index="0"]',
  )).toBeVisible({ timeout: READY_TIMEOUT });
  return {
    sessionId: launched.sessionId,
    documentGeneration: launched.documentGeneration,
    livePdf,
    itemId: item.id,
  };
}

async function openReferenceEditor(page: Page, itemId: string): Promise<{
  readonly composer: ReturnType<Page['getByRole']>;
  readonly editor: ReturnType<Page['getByRole']>;
  readonly apply: ReturnType<Page['getByRole']>;
}> {
  const workspace = page.getByRole('button', { name: /^(?:Show|Hide) workspace$/u });
  if (await workspace.getAttribute('aria-expanded') !== 'true') await workspace.click();
  const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
  if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();
  const row = page.locator(`[data-review-item="${itemId}"]`);
  await row.hover();
  await row.getByRole('button', { name: 'Open in References' }).click();
  await expect(page.locator('[data-reference-pdf-viewport]')).toBeVisible({
    timeout: READY_TIMEOUT,
  });
  const inspection = page.locator('[data-reference-annotation-inspection]');
  await expect(inspection).toBeVisible();
  await expect(inspection).toHaveAttribute('data-peek-selected', 'true');
  await inspection.hover();
  await inspection.getByRole('button', { name: 'Edit Page Note annotation on page 1' }).click();
  const composer = page.getByRole('region', { name: 'Edit Page Note' });
  const editor = composer.getByRole('textbox', { name: 'Comment' });
  const apply = composer.getByRole('button', { name: 'Apply', exact: true });
  await expect(editor).toBeVisible();
  return { composer, editor, apply };
}

async function deferNextCommand(
  page: Page,
  sessionId: string,
  commandType: 'apply-draft' | 'put-draft',
): Promise<{
  readonly entered: Promise<Request>;
  release(): void;
}> {
  const entered = Promise.withResolvers<Request>();
  const release = Promise.withResolvers<void>();
  let held = false;
  await page.route(`**/s/${sessionId}/commands`, async (route) => {
    const command = route.request().postDataJSON() as { readonly type?: unknown };
    if (held || command.type !== commandType) {
      await route.continue();
      return;
    }
    held = true;
    entered.resolve(route.request());
    await release.promise;
    await route.continue();
  });
  return { entered: entered.promise, release: release.resolve };
}

async function replaceAuthority(input: {
  readonly sessionId: string;
  readonly documentGeneration: number;
  readonly livePdf: string;
}): Promise<void> {
  await copyFile(replacementPdf, input.livePdf);
  const replacement = await host.broker.replaceLiveDocument({
    sessionId: input.sessionId,
    outputPath: input.livePdf,
    observationEpoch: 1,
  });
  expect(replacement).toMatchObject({
    status: 'committed',
    previousGeneration: input.documentGeneration,
    documentGeneration: input.documentGeneration + 1,
  });
}

async function releaseAndWaitForConflict(
  page: Page,
  request: Request,
  release: () => void,
): Promise<void> {
  const responsePromise = page.waitForResponse((response) => (
    response.request().url() === request.url()
    && response.request().postData() === request.postData()
  ));
  release();
  const response = await responsePromise;
  expect(response.status()).toBe(409);
  await response.finished();
}

async function expectRecoverableEditor(input: {
  readonly page: Page;
  readonly draft: string;
  readonly composer: ReturnType<Page['getByRole']>;
  readonly editor: ReturnType<Page['getByRole']>;
  readonly apply: ReturnType<Page['getByRole']>;
}): Promise<void> {
  await expect(input.composer).toBeVisible();
  await expect(input.editor).toHaveValue(input.draft);
  await expect(input.apply).toBeDisabled();
  await expect(input.page.locator('[data-authoring-preview="true"]')).toHaveCount(0);
}

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'placekeeper-reference-stale-commands-'));
  sourceRoot = join(root, 'source');
  await mkdir(sourceRoot);
  referencePdf = resolve('test/fixtures/pdfs/reference-navigation.pdf');
  replacementPdf = resolve('test/fixtures/pdfs/reference-navigation-annotated.pdf');
});

test.beforeEach(async () => {
  host = await PlacekeeperHost.start({
    recoveryRoot: join(root, `recovery-${randomUUID()}`),
    webAssets: { root: resolve('dist/web') },
  });
});

test.afterEach(async ({ page }) => {
  await page.context().close();
  await host.close();
});

test.afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test('retains the editor after a deferred Apply command returns stale', async ({ page }) => {
  const opened = await openFixture(page, 'generated-output');
  const { composer, editor, apply } = await openReferenceEditor(page, opened.itemId);
  const draft = 'Keep this edit after its deferred Apply response becomes stale.';
  await editor.fill(draft);
  await expect(page.locator('[data-authoring-preview="true"]')).not.toHaveCount(0);
  await expect.poll(() => host.broker.state(opened.sessionId)?.pendingDrafts.find(
    (candidate) => candidate.text === draft,
  )?.text).toBe(draft);

  const gate = await deferNextCommand(page, opened.sessionId, 'apply-draft');
  await apply.click();
  const request = await gate.entered;
  try {
    await replaceAuthority(opened);
    await expectRecoverableEditor({ page, draft, composer, editor, apply });
    await releaseAndWaitForConflict(page, request, gate.release);
    await expectRecoverableEditor({ page, draft, composer, editor, apply });
    expect(host.broker.state(opened.sessionId)?.items.some(
      (candidate) => candidate.payload.comment === draft,
    )).toBe(false);
    await composer.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(composer).toHaveCount(0);
  } finally {
    gate.release();
  }
});

test('retains the editor after a deferred put-draft command returns stale', async ({ page }) => {
  const opened = await openFixture(page, 'generated-output');
  const gate = await deferNextCommand(page, opened.sessionId, 'put-draft');
  const editorPromise = openReferenceEditor(page, opened.itemId);
  const request = await gate.entered;
  try {
    const { composer, editor, apply } = await editorPromise;
    const draft = 'Keep this protected draft after its deferred response becomes stale.';
    await editor.fill(draft);
    await replaceAuthority(opened);
    await expectRecoverableEditor({ page, draft, composer, editor, apply });
    await releaseAndWaitForConflict(page, request, gate.release);
    await expectRecoverableEditor({ page, draft, composer, editor, apply });
    expect(host.broker.state(opened.sessionId)?.pendingDrafts).toHaveLength(0);
    await composer.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(composer).toHaveCount(0);
  } finally {
    gate.release();
  }
});
