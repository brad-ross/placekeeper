import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { PlacekeeperHost } from '../../apps/service/src/host/placekeeper-host.js';
import { addDelete, addHighlight, addPageNote, addReplace } from '../../packages/core/src/review-commands.js';

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
  kind: 'pageNote' | 'highlight' | 'replace' | 'delete' = 'pageNote',
  options: { content?: string; quote?: string; sibling?: boolean } = {},
): Promise<{ sessionId: string; itemId: string; siblingId?: string }> {
  const directory = join(temporaryRoot, randomUUID());
  await mkdir(directory);
  const pdfPath = join(directory, basename(fixturePdf));
  await copyFile(fixturePdf, pdfPath);
  const launched = await host.open({ pdfPath, sourceRootPath: sourceRoot, fork: true });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error(`Long-annotation production launch failed: ${JSON.stringify(launched)}`);
  }
  const initial = host.broker.state(launched.sessionId);
  if (initial === undefined) throw new Error('Long-annotation review state is unavailable.');
  const anchor = {
    pageIndex: 0,
    quote: options.quote ?? 'Body TOC: repeated, aliased, page-only, and distinct-coordinate links',
    prefix: '', suffix: '',
    rect: { x: 72, y: 686, width: 344, height: 14 },
    segmentRects: [{ x: 72, y: 686, width: 344, height: 14 }],
    reliable: true as const,
  };
  const command = (() => {
    switch (kind) {
      case 'pageNote': return addPageNote(initial, 0, { x: 84, y: 164, width: 18, height: 18 }, options.content ?? LONG_ANNOTATION);
      case 'replace': return addReplace(initial, anchor, options.content ?? LONG_ANNOTATION);
      case 'delete': return addDelete(initial, anchor);
      case 'highlight': return addHighlight(initial, anchor, options.content ?? LONG_ANNOTATION);
    }
  })();
  await host.broker.acceptMutation(launched.sessionId, command);
  const initialIds = new Set(initial.items.map((item) => item.id));
  const itemId = host.broker.state(launched.sessionId)?.items.find((item) => !initialIds.has(item.id))?.id;
  if (itemId === undefined) throw new Error('Long annotation was not created.');
  let siblingId: string | undefined;
  if (options.sibling) {
    const state = host.broker.state(launched.sessionId)!;
    await host.broker.acceptMutation(launched.sessionId, addPageNote(
      state, 0, { x: 200, y: 164, width: 18, height: 18 }, 'Second annotation.',
    ));
    siblingId = host.broker.state(launched.sessionId)!.items.find((item) => item.id !== itemId && !initialIds.has(item.id))!.id;
  }
  await page.goto(launched.url);
  await expect(page.locator('[data-production-review]')).toBeVisible();
  await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true', { timeout: 15_000 });
  await waitForRenderedPageImage(page);
  return { sessionId: launched.sessionId, itemId, ...(siblingId === undefined ? {} : { siblingId }) };
}

async function chooseCopyDestination(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Open automatic save options$/u }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose Where to Save Annotations' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Copy name' })
    .fill(`annotation-followup-${randomUUID()}.pdf`);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
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

interface AnnotationEditFrame {
  readonly elapsedMs: number;
  readonly composerCount: number;
  readonly composerVisibleCount: number;
  readonly composerPlacement: string | null;
  readonly composerRect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number } | null;
  readonly fullReaderCount: number;
  readonly compactPeekCount: number;
  readonly initialViewReady: string | null;
  readonly generationStatus: string | null;
  readonly toolsIdentity: boolean;
  readonly referencesIdentity: boolean;
  readonly toolsPainted: boolean;
  readonly referencesPainted: boolean;
  readonly toolsRect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number } | null;
  readonly referencesRect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number } | null;
}

async function beginAnnotationEditFrameAudit(page: Page): Promise<void> {
  await page.evaluate(() => {
    const startedAt = performance.now();
    const audit = {
      finished: false,
      stopRequested: false,
      postSettleFrames: 4,
      timedOut: false,
      samples: [] as AnnotationEditFrame[],
    };
    (window as typeof window & { __annotationEditSurfaceAudit?: typeof audit }).__annotationEditSurfaceAudit = audit;
    const tools = document.querySelector<HTMLElement>('#review-tools-workspace');
    const references = document.querySelector<HTMLElement>('#review-workspace');
    const rect = (element: HTMLElement | null) => {
      if (element === null) return null;
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    };
    const painted = (element: HTMLElement | null) => {
      if (element === null) return false;
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return element.isConnected
        && element.getClientRects().length > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.visibility !== 'collapse'
        && Number(style.opacity) > 0
        && bounds.width > 0
        && bounds.height > 0;
    };
    const visibleCount = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
      .filter(painted).length;
    const sample = () => {
      if (audit.finished) return;
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs > 5_000) {
        audit.timedOut = true;
        audit.finished = true;
        return;
      }
      const composers = [...document.querySelectorAll<HTMLElement>('[data-comment-composer]')];
      const composer = composers.find(painted) ?? null;
      const bounds = composer?.getBoundingClientRect();
      audit.samples.push({
        elapsedMs,
        composerCount: composers.length,
        composerVisibleCount: composers.filter(painted).length,
        composerPlacement: composer?.dataset.composerPlacement ?? null,
        composerRect: bounds === undefined ? null : {
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
        },
        fullReaderCount: visibleCount('[data-full-annotation-reader="true"]'),
        compactPeekCount: visibleCount('[data-annotation-peek]:not(.annotation-peek--reader)'),
        initialViewReady: document.querySelector<HTMLElement>('[data-production-review]')
          ?.dataset.initialViewReady ?? null,
        generationStatus: document.querySelector<HTMLElement>('[data-generation-status]')
          ?.dataset.generationStatus ?? 'idle',
        toolsIdentity: tools !== null && tools.isConnected
          && document.querySelector('#review-tools-workspace') === tools,
        referencesIdentity: references !== null && references.isConnected
          && document.querySelector('#review-workspace') === references,
        toolsPainted: painted(tools),
        referencesPainted: painted(references),
        toolsRect: rect(tools),
        referencesRect: rect(references),
      });
      if (audit.stopRequested) {
        audit.postSettleFrames -= 1;
        if (audit.postSettleFrames === 0) {
          audit.finished = true;
          return;
        }
      }
      requestAnimationFrame(sample);
    };
    sample();
  });
}

async function finishAnnotationEditFrameAudit(page: Page): Promise<readonly AnnotationEditFrame[]> {
  await page.evaluate(() => {
    const audit = (window as typeof window & {
      __annotationEditSurfaceAudit?: { stopRequested: boolean };
    }).__annotationEditSurfaceAudit;
    if (audit !== undefined) audit.stopRequested = true;
  });
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __annotationEditSurfaceAudit?: { finished: boolean } }
  ).__annotationEditSurfaceAudit?.finished)).toBe(true);
  const result = await page.evaluate(() => {
    const auditedWindow = window as typeof window & {
      __annotationEditSurfaceAudit?: { samples: AnnotationEditFrame[]; timedOut: boolean };
    };
    const audit = auditedWindow.__annotationEditSurfaceAudit;
    const captured = { samples: audit?.samples ?? [], timedOut: audit?.timedOut ?? true };
    delete auditedWindow.__annotationEditSurfaceAudit;
    return captured;
  });
  expect(result.timedOut).toBe(false);
  return result.samples;
}

function expectStableWorkspaceFrames(
  frames: readonly AnnotationEditFrame[],
  tools: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  references: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): void {
  expect(frames.every((frame) => (
    frame.initialViewReady === 'true'
    && frame.generationStatus === 'idle'
    && frame.toolsIdentity
    && frame.referencesIdentity
    && frame.toolsPainted
    && frame.referencesPainted
    && frame.toolsRect !== null
    && frame.referencesRect !== null
    && frame.toolsRect.left === tools.x
    && frame.toolsRect.top === tools.y
    && frame.toolsRect.width === tools.width
    && frame.toolsRect.height === tools.height
    && frame.referencesRect.left === references.x
    && frame.referencesRect.top === references.y
    && frame.referencesRect.width === references.width
    && frame.referencesRect.height === references.height
  ))).toBe(true);
}

function expectComposerTransition(
  frames: readonly AnnotationEditFrame[],
  before: 0 | 1,
  after: 0 | 1,
): void {
  expect(frames.length).toBeGreaterThan(4);
  expect(frames[0]?.composerVisibleCount).toBe(before);
  expect(frames.at(-1)?.composerVisibleCount).toBe(after);
  expect(frames.some(({ composerVisibleCount }) => composerVisibleCount === before)).toBe(true);
  expect(frames.some(({ composerVisibleCount }) => composerVisibleCount === after)).toBe(true);
  expect(frames.every(({ composerCount, composerVisibleCount }) => (
    composerCount <= 1 && composerVisibleCount <= 1
  ))).toBe(true);
}

test.beforeEach(async () => {
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

test.afterEach(async ({ page }) => {
  // The context owns connections that can outlive its page.
  await page.context().close();
  await host?.close();
  if (temporaryRoot !== '') await rm(temporaryRoot, { recursive: true, force: true });
});

test('uses neutral focus on Back after opening the full annotation text', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { itemId } = await openLongAnnotationFixture(page);
  await chooseCopyDestination(page);
  const center = await markCenter(page, itemId);
  await page.mouse.click(center.x, center.y);
  const peek = page.locator(`[data-annotation-peek="${itemId}"]`);
  await peek.locator('[data-read-full-annotation]').click();
  const reader = page.locator('[data-full-annotation-reader="true"]:visible');
  const back = reader.getByRole('button', { name: 'Back', exact: true });
  await expect(back).toBeFocused();
  await expect(back).toHaveCSS('outline-style', 'none');
  await expect(back).toHaveCSS('box-shadow', 'none');
  await back.press('Enter');
  await expect(reader).toHaveCount(0);
  await expect(peek).toBeVisible();
});

test('keeps reader edits continuously represented while Edit, Cancel, and Apply settle', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { itemId } = await openLongAnnotationFixture(page);
  await chooseCopyDestination(page);
  const center = await markCenter(page, itemId);
  await page.mouse.click(center.x, center.y);
  const compactPeek = page.locator(`[data-annotation-peek="${itemId}"]`);
  await compactPeek.locator('[data-read-full-annotation]').click();
  const reader = page.locator('[data-full-annotation-reader="true"]:visible');
  await expect(reader).toBeVisible();

  await beginAnnotationEditFrameAudit(page);
  await reader.locator('[data-full-annotation-action="edit"]').click();
  const composer = page.getByRole('region', { name: 'Edit Page Note' });
  await expect(composer).toBeVisible();
  const openingFrames = await finishAnnotationEditFrameAudit(page);
  expectComposerTransition(openingFrames, 0, 1);
  for (const frame of openingFrames.filter(({ composerVisibleCount }) => composerVisibleCount === 1)) {
    expect(frame.composerPlacement).not.toBeNull();
    expect(frame.composerRect?.width).toBeGreaterThan(0);
    expect(frame.composerRect?.height).toBeGreaterThan(0);
  }
  const placedOpeningFrames = openingFrames.filter((frame) => frame.composerVisibleCount === 1);
  const initialComposerRect = placedOpeningFrames[0]?.composerRect;
  expect(initialComposerRect).toBeDefined();
  if (initialComposerRect === undefined || initialComposerRect === null) {
    throw new Error('The first painted composer frame had no finite rectangle.');
  }
  expect([
    initialComposerRect.left,
    initialComposerRect.top,
    initialComposerRect.width,
    initialComposerRect.height,
  ].every(Number.isFinite)).toBe(true);
  for (const { composerRect } of placedOpeningFrames) {
    expect(Math.max(
      Math.abs((composerRect?.left ?? 0) - (initialComposerRect?.left ?? 0)),
      Math.abs((composerRect?.top ?? 0) - (initialComposerRect?.top ?? 0)),
      Math.abs((composerRect?.width ?? 0) - (initialComposerRect?.width ?? 0)),
      Math.abs((composerRect?.height ?? 0) - (initialComposerRect?.height ?? 0)),
    )).toBeLessThan(1);
  }
  expect(openingFrames.every(({ initialViewReady, generationStatus }) => (
    initialViewReady === 'true' && generationStatus === 'idle'
  ))).toBe(true);

  await beginAnnotationEditFrameAudit(page);
  await composer.getByRole('button', { name: 'Cancel' }).click();
  await expect(reader).toBeVisible();
  const cancelFrames = await finishAnnotationEditFrameAudit(page);
  expectComposerTransition(cancelFrames, 1, 0);
  expect(cancelFrames[0]?.fullReaderCount).toBe(0);
  expect(cancelFrames.at(-1)?.fullReaderCount).toBe(1);
  expect(cancelFrames.every((frame) => (
    frame.composerVisibleCount + frame.fullReaderCount > 0
    && frame.compactPeekCount === 0
    && frame.initialViewReady === 'true'
    && frame.generationStatus === 'idle'
  ))).toBe(true);

  await reader.locator('[data-full-annotation-action="edit"]').click();
  await expect(composer).toBeVisible();
  const edited = `${LONG_ANNOTATION} Applied without an intermediate compact popup.`;
  await composer.getByRole('textbox', { name: 'Comment' }).fill(edited);
  await beginAnnotationEditFrameAudit(page);
  await composer.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(reader).toContainText('Applied without an intermediate compact popup.');
  const applyFrames = await finishAnnotationEditFrameAudit(page);
  expectComposerTransition(applyFrames, 1, 0);
  expect(applyFrames[0]?.fullReaderCount).toBe(0);
  expect(applyFrames.at(-1)?.fullReaderCount).toBe(1);
  expect(applyFrames.every((frame) => (
    frame.composerVisibleCount + frame.fullReaderCount > 0
    && frame.compactPeekCount === 0
    && frame.initialViewReady === 'true'
    && frame.generationStatus === 'idle'
  ))).toBe(true);
});

test('uses the hover card and explicitly expands long PDF annotations in a deletable full reader', async ({ page }) => {
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
  await peek.locator('[data-read-full-annotation]').click();
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
  await expect.poll(() => host.broker.state(sessionId)?.items.some((item) => item.id === itemId)).toBe(false);
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
    `keeps ${layout.name} and the real PDF continuously painted while Edit, Cancel, and Apply settle`,
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
  await beginAnnotationEditFrameAudit(page);
  await row.getByRole('button', { name: 'Edit Highlight annotation on page 1' }).click();
  const composer = page.getByRole('region', { name: 'Edit Highlight' });
  await expect(composer).toBeVisible();
  const openingFrames = await finishAnnotationEditFrameAudit(page);
  expectComposerTransition(openingFrames, 0, 1);
  expect(openingFrames.every((frame) => (
    frame.initialViewReady === 'true'
    && frame.generationStatus === 'idle'
    && frame.toolsIdentity
    && frame.referencesIdentity
    && frame.toolsPainted
    && frame.referencesPainted
  ))).toBe(true);
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

  await beginAnnotationEditFrameAudit(page);
  await composer.getByRole('button', { name: 'Cancel' }).click();
  await expect(composer).toHaveCount(0);
  const cancelFrames = await finishAnnotationEditFrameAudit(page);
  expectComposerTransition(cancelFrames, 1, 0);
  expectStableWorkspaceFrames(cancelFrames, toolsBefore, referencesBefore);

  await row.hover();
  await row.getByRole('button', { name: 'Edit Highlight annotation on page 1' }).click();
  await expect(composer).toBeVisible();

  const edited = `${LONG_ANNOTATION} Applied without a viewer flash.`;
  await composer.getByRole('textbox', { name: 'Comment (optional)' }).fill(edited);
  await beginAnnotationEditFrameAudit(page);
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
  const applySurfaceFrames = await finishAnnotationEditFrameAudit(page);
  expectComposerTransition(applySurfaceFrames, 1, 0);
  expectStableWorkspaceFrames(applySurfaceFrames, toolsBefore, referencesBefore);
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


test('selected compact popup offers return when its PDF annotation leaves the frame', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { itemId } = await openLongAnnotationFixture(page, 'pageNote', { content: 'Short note.' });
  const center = await markCenter(page, itemId);
  await page.mouse.click(center.x, center.y);
  const peek = page.locator(`[data-annotation-peek="${itemId}"]`);
  await expect(peek).toBeVisible();
  const locate = peek.getByRole('button', { name: 'Back to annotation in PDF', exact: true });
  await expect(locate).toHaveCount(0);
  await page.locator('[data-viewer-framing-viewport]').hover({ position: { x: 100, y: 100 } });
  await page.mouse.wheel(0, 1500);
  await expect(locate).toBeVisible();
  await locate.click();
  await expect(locate).toHaveCount(0);
  const returned = await markCenter(page, itemId);
  expect(returned.y).toBeGreaterThan(50);
  expect(returned.y).toBeLessThan(900);
});

async function expandPopup(page: Page, itemId: string) {
  const center = await markCenter(page, itemId);
  await page.mouse.click(center.x, center.y);
  const reader = page.locator('.annotation-peek--reader');
  await expect(reader).toHaveCount(0);
  await page.locator(`[data-annotation-peek="${itemId}"] [data-read-full-annotation]`).click();
  await expect(reader).toBeVisible();
  return reader;
}

test('expanded popup yields to another PDF annotation and reopens as a compact card', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { itemId, siblingId } = await openLongAnnotationFixture(page, 'pageNote', { sibling: true });
  const reader = await expandPopup(page, itemId);
  const second = await markCenter(page, siblingId!);
  await page.mouse.click(second.x, second.y);
  await expect(reader).toHaveCount(0);
  await expect(page.locator(`[data-annotation-peek="${siblingId}"]`)).toBeVisible();
  const first = await markCenter(page, itemId);
  await page.mouse.click(first.x, first.y);
  await expect(page.locator(`[data-annotation-peek="${itemId}"]`)).toBeVisible();
  await expect(reader).toHaveCount(0);
});

test('outside click and Escape dismiss an expanded popup without retaining full view', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { itemId } = await openLongAnnotationFixture(page);
  const reader = await expandPopup(page, itemId);
  const image = await waitForRenderedPageImage(page);
  const bounds = (await image.boundingBox())!;
  await page.mouse.click(bounds.x + 30, bounds.y + 300);
  await expect(reader).toHaveCount(0);
  await expect(page.locator('[data-annotation-peek]')).toHaveCount(0);
  const center = await markCenter(page, itemId);
  await page.mouse.click(center.x, center.y);
  await expect(page.locator(`[data-annotation-peek="${itemId}"]`)).toBeVisible();
  await expect(reader).toHaveCount(0);
  await page.locator(`[data-annotation-peek="${itemId}"] [data-read-full-annotation]`).click();
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);
  await expect(page.locator('[data-annotation-peek]')).toHaveCount(0);
});


for (const [kind, content] of [['highlight', 'Short comment.'], ['highlight', ''], ['replace', 'Short replacement.'], ['delete', '']] as const) {
  test(`full ${kind} popup retains overflowing source text with ${content || 'no authored text'}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const quote = 'This is the complete original passage whose text must remain readable. '.repeat(24) + 'SOURCE PASSAGE END.';
    const { itemId } = await openLongAnnotationFixture(page, kind, { content, quote });
    await page.locator(`[data-owned-mark][data-review-id="${itemId}"]`).first().scrollIntoViewIfNeeded();
    const center = await markCenter(page, itemId);
    await page.mouse.click(center.x, center.y);
    const peek = page.locator(`[data-annotation-peek="${itemId}"]`);
    const more = peek.locator('[data-read-full-annotation]');
    await expect(more).toBeVisible();
    expect((await peek.boundingBox())!.height).toBeLessThan(240);
    await more.click();
    const reader = page.locator('.annotation-peek--reader');
    await expect(reader).toContainText(quote);
    if (kind === 'delete') await expect(reader.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    if (content) await expect(reader).toContainText(content);
    const body = reader.locator('.full-annotation-reader__body');
    await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(reader.getByText(/SOURCE PASSAGE END/)).toBeVisible();
  });
}

test('keeps the initial Mac workspace toggle above the PDF viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 768 });
  await openLongAnnotationFixture(page);
  await page.locator('[data-launch-surface]').first().evaluate((element) => {
    element.setAttribute('data-launch-surface', 'macos');
  });
  const rail = page.locator('[data-workspace-edge-rail="right"]');
  await expect(rail).toBeVisible();
  await expect(rail).toBeInViewport();
  const ownsHitTarget = () => rail.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return hit === element || (hit !== null && element.contains(hit));
  });
  expect(await ownsHitTarget()).toBe(true);
  await rail.click();
  await expect(page.getByRole('tab', { name: 'Outline', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hide workspace', exact: true }).click();
  await expect(rail).toBeVisible();
  expect(await ownsHitTarget()).toBe(true);
});
