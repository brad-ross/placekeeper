import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { PlacekeeperHost } from '../../apps/service/src/host/placekeeper-host.js';
import { addHighlight, addPageNote } from '../../packages/core/src/review-commands.js';

let temporaryRoot = '';
let sourceRoot = '';
let fixturePdf = '';
let host: PlacekeeperHost;

const LONG_ANNOTATION = [
  'This long annotation explains the identification concern and the evidence needed to resolve it.',
  'It preserves enough detail to require the complete annotation reader rather than a clipped preview.',
].join(' ').repeat(8);

async function waitForRenderedPageImage(page: Page): Promise<Locator> {
  const image = page.locator(".pdf-workspace:not(.pdf-workspace--reference) [data-page-index='0'] > img");
  await expect(image).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => image.evaluate((element) => (
    element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
  ))).toBe(true);
  return image;
}

async function openLongAnnotationFixture(
  page: Page,
  kind: 'pageNote' | 'highlight' = 'pageNote',
): Promise<{ sessionId: string; itemId: string }> {
  const directory = join(temporaryRoot, randomUUID());
  await mkdir(directory);
  const pdfPath = join(directory, basename(fixturePdf));
  await copyFile(fixturePdf, pdfPath);
  const launched = await host.open({ pdfPath, sourceRootPath: sourceRoot, fork: true });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Long-annotation production launch failed.');
  }
  const initial = host.broker.state(launched.sessionId);
  if (initial === undefined) throw new Error('Long-annotation review state is unavailable.');
  const command = kind === 'pageNote'
    ? addPageNote(
        initial,
        0,
        { x: 84, y: 164, width: 18, height: 18 },
        LONG_ANNOTATION,
      )
    : addHighlight(initial, {
        pageIndex: 0,
        quote: 'Body TOC: repeated, aliased, page-only, and distinct-coordinate links',
        prefix: '',
        suffix: '',
        rect: { x: 72, y: 686, width: 344, height: 14 },
        segmentRects: [{ x: 72, y: 686, width: 344, height: 14 }],
        reliable: true,
      }, LONG_ANNOTATION);
  await host.broker.acceptMutation(launched.sessionId, command);
  const itemId = host.broker.state(launched.sessionId)?.items[0]?.id;
  if (itemId === undefined) throw new Error('Long annotation was not created.');
  await page.goto(launched.url);
  await expect(page.locator('[data-production-review]')).toBeVisible();
  await waitForRenderedPageImage(page);
  return { sessionId: launched.sessionId, itemId };
}

async function chooseCopyDestination(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Open automatic save options$/u }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose Where to Save Annotations' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Copy name' })
    .fill(`annotation-followup-${randomUUID()}.pdf`);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toHaveCount(0);
}

async function markCenter(page: Page, itemId: string): Promise<{ x: number; y: number }> {
  const mark = page.locator(`[data-owned-mark][data-review-id="${itemId}"]`).first();
  await expect(mark).toBeVisible();
  const bounds = await mark.boundingBox();
  if (bounds === null) throw new Error('Owned annotation mark has no bounds.');
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

async function openPrimaryReference(page: Page): Promise<void> {
  const link = page.getByRole('button', { name: 'Open PDF link to Primary result, Page 2' });
  await link.focus();
  await link.press('Enter');
  const action = page.getByRole('menuitem', { name: 'Open in References' });
  await expect(action).toBeFocused();
  await action.press('Enter');
  await expect(page.getByRole('tab', { name: /Primary result/u })).toHaveAttribute('aria-selected', 'true');
}

test.beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'placekeeper-annotation-followup-'));
  sourceRoot = join(temporaryRoot, 'source');
  await mkdir(sourceRoot);
  fixturePdf = resolve('test/fixtures/pdfs/reference-navigation.pdf');
  await copyFile(resolve('test/fixtures/latex/paper.tex'), join(sourceRoot, 'paper.tex'));
  host = await PlacekeeperHost.start({
    recoveryRoot: join(temporaryRoot, 'recovery'),
    webAssets: { root: resolve('dist/web') },
  });
});

test.afterAll(async () => {
  await host?.close();
  if (temporaryRoot !== '') await rm(temporaryRoot, { recursive: true, force: true });
});

test('uses the new hover card and opens long PDF marks in a deletable full reader', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { sessionId, itemId } = await openLongAnnotationFixture(page);
  await chooseCopyDestination(page);

  const center = await markCenter(page, itemId);
  await page.mouse.move(center.x, center.y);
  const peek = page.locator(`[data-annotation-peek="${itemId}"]`);
  await expect(peek).toBeVisible();
  await expect(peek.locator('.annotation-item__title-row')).toBeVisible();
  await expect(peek.locator('.annotation-item__excerpt-main')).toHaveCSS('-webkit-line-clamp', '3');
  await expect(peek).toHaveCSS('border-radius', '16px');
  await expect(peek).not.toHaveCSS('box-shadow', 'none');
  await expect(peek.locator('.row-action-group')).toHaveCount(0);
  await peek.hover();
  await expect(peek).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(peek).toHaveCount(0);

  await page.mouse.click(center.x, center.y);
  const reader = page.locator('[data-full-annotation-reader="true"]:visible');
  await expect(reader).toBeVisible();
  await expect(reader).toContainText(LONG_ANNOTATION.slice(0, 120));
  const edit = reader.locator('[data-full-annotation-action="edit"]');
  const remove = reader.locator('[data-full-annotation-action="delete"]');
  await expect(edit).toBeVisible();
  await expect(remove).toBeVisible();
  const [editBounds, removeBounds] = await Promise.all([edit.boundingBox(), remove.boundingBox()]);
  if (editBounds === null || removeBounds === null) throw new Error('Full reader actions have no bounds.');
  expect(removeBounds.x).toBeGreaterThan(editBounds.x);

  await remove.click();
  await expect(reader).toHaveCount(0);
  await expect(page.locator(`[data-review-id="${itemId}"]`)).toHaveCount(0);
  await expect.poll(() => host.broker.state(sessionId)?.items.length).toBe(0);
});

const editContinuityLayouts = [
  {
    name: 'wide split with bottom References and right Annotations',
    viewport: { width: 1280, height: 900 },
    referencePresentation: 'bottom',
    toolsPresentation: 'right',
    configure: async (page: Page) => {
      const moveBottom = page.getByRole('button', { name: 'Move References to bottom' });
      if (await moveBottom.isVisible()) {
        await moveBottom.locator('xpath=..').hover();
        await moveBottom.click();
      }
      await page.getByRole('button', { name: 'Show workspace' }).click();
    },
  },
  {
    name: 'wide right-docked workspace',
    viewport: { width: 1280, height: 900 },
    referencePresentation: 'right',
    toolsPresentation: 'right',
    configure: async (page: Page) => {
      const moveRight = page.getByRole('button', { name: 'Move References to right' });
      if (await moveRight.isVisible()) {
        await moveRight.locator('xpath=..').hover();
        await moveRight.click();
      }
    },
  },
  {
    name: 'narrow bottom workspace',
    viewport: { width: 520, height: 760 },
    referencePresentation: 'bottom',
    toolsPresentation: 'bottom',
    configure: async (_page: Page) => undefined,
  },
] as const;

test.describe('passage edit continuity', () => {
  for (const layout of editContinuityLayouts) test(
    `keeps ${layout.name} and the real PDF continuously painted while Apply settles`,
    async ({ page }) => {
  await page.setViewportSize(layout.viewport);
  const { itemId } = await openLongAnnotationFixture(page, 'highlight');
  await chooseCopyDestination(page);
  await openPrimaryReference(page);
  await layout.configure(page);
  const references = page.locator('#review-workspace');
  await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
  const tools = page.locator('#review-tools-workspace');
  await expect(references).toHaveAttribute('data-workspace-presentation', layout.referencePresentation);
  await expect(tools).toHaveAttribute('data-workspace-presentation', layout.toolsPresentation);
  await expect(tools).toHaveAttribute('data-tools-workspace-open', 'true');
  await expect.poll(() => tools.evaluate((element) => getComputedStyle(element).transform))
    .toBe('none');
  await expect.poll(() => references.evaluate((element) => getComputedStyle(element).transform))
    .toBe('none');
  await tools.evaluate((element) => element.setAttribute('data-edit-mount-probe', 'stable'));
  await references.evaluate((element) => element.setAttribute('data-edit-mount-probe', 'stable'));
  const [toolsBefore, referencesBefore] = await Promise.all([tools.boundingBox(), references.boundingBox()]);
  if (toolsBefore === null || referencesBefore === null) throw new Error('Tray bounds are unavailable.');

  const row = page.locator(`[data-review-item="${itemId}"]`);
  await row.hover();
  await row.getByRole('button', { name: 'Edit Highlight annotation on page 1' }).click();
  const composer = page.getByRole('region', { name: 'Edit Highlight' });
  await expect(composer).toBeVisible();
  for (const tray of [tools, references]) {
    await expect(tray).toBeVisible();
    await expect(tray).toHaveAttribute('data-authoring-takeover', 'true');
    await expect(tray).toHaveAttribute('inert', '');
    await expect(tray).toHaveAttribute('aria-hidden', 'false');
    await expect(tray).toHaveAttribute('data-edit-mount-probe', 'stable');
  }
  const [toolsDuring, referencesDuring] = await Promise.all([tools.boundingBox(), references.boundingBox()]);
  expect(toolsDuring).toEqual(toolsBefore);
  expect(referencesDuring).toEqual(referencesBefore);

  const edited = `${LONG_ANNOTATION} Applied without a viewer flash.`;
  await composer.getByRole('textbox', { name: 'Comment (optional)' }).fill(edited);
  await page.evaluate((reviewId) => {
    const image = document.querySelector<HTMLImageElement>(
      ".pdf-workspace:not(.pdf-workspace--reference) [data-page-index='0'] > img",
    );
    const mark = document.querySelector<HTMLElement>(`[data-review-id="${reviewId}"]`);
    if (image === null || mark === null) throw new Error('Viewer continuity targets are unavailable.');
    const baseline = image.getBoundingClientRect();
    const baselineSource = image.currentSrc || image.src;
    const audit = {
      finished: false,
      samples: [] as Array<{
        imageConnected: boolean;
        imageIdentity: boolean;
        markConnected: boolean;
        markIdentity: boolean;
        imagePainted: boolean;
        ancestorsPainted: boolean;
        imageDecoded: boolean;
        sourceIdentity: boolean;
        left: number;
        top: number;
        width: number;
        height: number;
      }>,
    };
    (window as typeof window & { __annotationEditPaintAudit?: typeof audit }).__annotationEditPaintAudit = audit;
    let frames = 0;
    const sample = () => {
      const currentImage = document.querySelector<HTMLImageElement>(
        ".pdf-workspace:not(.pdf-workspace--reference) [data-page-index='0'] > img",
      );
      const currentMark = document.querySelector<HTMLElement>(`[data-review-id="${reviewId}"]`);
      const bounds = image.getBoundingClientRect();
      const style = getComputedStyle(image);
      let ancestor: HTMLElement | null = image;
      let ancestorsPainted = true;
      while (ancestor !== null) {
        const ancestorStyle = getComputedStyle(ancestor);
        if (
          ancestorStyle.display === 'none'
          || ancestorStyle.visibility === 'hidden'
          || ancestorStyle.visibility === 'collapse'
          || Number(ancestorStyle.opacity) === 0
        ) {
          ancestorsPainted = false;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      audit.samples.push({
        imageConnected: image.isConnected,
        imageIdentity: currentImage === image,
        markConnected: mark.isConnected,
        markIdentity: currentMark === mark,
        imagePainted: style.display !== 'none' && style.visibility !== 'hidden'
          && style.opacity !== '0' && bounds.width > 0 && bounds.height > 0,
        ancestorsPainted,
        imageDecoded: image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
        sourceIdentity: (image.currentSrc || image.src) === baselineSource,
        left: bounds.left - baseline.left,
        top: bounds.top - baseline.top,
        width: bounds.width - baseline.width,
        height: bounds.height - baseline.height,
      });
      frames += 1;
      if (frames < 45) requestAnimationFrame(sample);
      else audit.finished = true;
    };
    requestAnimationFrame(sample);
  }, itemId);
  await composer.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(composer).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __annotationEditPaintAudit?: { finished: boolean } }
  ).__annotationEditPaintAudit?.finished)).toBe(true);
  const audit = await page.evaluate(() => (
    window as typeof window & {
      __annotationEditPaintAudit?: {
        samples: Array<{
          imageConnected: boolean; imageIdentity: boolean; markConnected: boolean; markIdentity: boolean;
          imagePainted: boolean; ancestorsPainted: boolean; imageDecoded: boolean;
          sourceIdentity: boolean; left: number; top: number; width: number; height: number;
        }>;
      };
    }
  ).__annotationEditPaintAudit);
  expect(audit?.samples).toHaveLength(45);
  for (const sample of audit?.samples ?? []) {
    expect(sample).toMatchObject({
      imageConnected: true,
      imageIdentity: true,
      markConnected: true,
      markIdentity: true,
      imagePainted: true,
      ancestorsPainted: true,
      imageDecoded: true,
      sourceIdentity: true,
    });
    expect(Math.max(Math.abs(sample.left), Math.abs(sample.top), Math.abs(sample.width), Math.abs(sample.height)))
      .toBeLessThan(1);
  }
  await expect(tools).toHaveAttribute('data-edit-mount-probe', 'stable');
  await expect(references).toHaveAttribute('data-edit-mount-probe', 'stable');
  expect(await tools.boundingBox()).toEqual(toolsBefore);
  expect(await references.boundingBox()).toEqual(referencesBefore);
  await expect(row).toContainText('Applied without a viewer flash.');
    },
  );
});
