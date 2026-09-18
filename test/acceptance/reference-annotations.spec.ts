import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

import { PlacekeeperHost } from '../../apps/service/src/host/placekeeper-host.js';
import {
  addHighlight,
  addPageNote,
  removeReviewItem,
} from '../../packages/core/src/review-commands.js';
import {
  expectFirstVisibleReferenceCard,
  expectFirstVisibleReferencePlacement,
  expectPostClickTransitionWithoutSurface,
  expectReferenceCardProbeOnlyReference,
  installFirstVisibleReferenceCardProbe,
  installFirstVisibleReferencePlacementProbe,
  installPostClickTransitionProbe,
} from '../support/reference-annotation-probes.js';

let root = '';
let sourceRoot = '';
let referencePdf = '';
let annotatedReferencePdf = '';
let host: PlacekeeperHost;

const READY_TIMEOUT = 15_000;
const LONG_REFERENCE_COMMENT = Array.from(
  { length: 48 },
  (_, index) => `Reader paragraph ${index + 1} stays available while the content surface scrolls.`,
).join('\n\n');

// Integrated matrix: shared/repeated/passive content (AE1–AE4, AE8), placement and
// draft continuity (AE5–AE7), stale and failed saves (AE9–AE10), and real selection,
// context, keyboard, multi-fragment, source-mark, and link interactions (AE3, AE11).

async function freshPdf(path: string): Promise<string> {
  const directory = join(root, randomUUID());
  await mkdir(directory);
  const copy = join(directory, basename(path));
  await copyFile(path, copy);
  return copy;
}

async function openFixture(
  page: Page,
  path: string,
  seed?: (sessionId: string) => Promise<void>,
): Promise<string> {
  const launched = await host.open({
    pdfPath: await freshPdf(path),
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Reference annotation production fixture did not launch.');
  }
  await seed?.(launched.sessionId);
  await page.goto(launched.url);
  await expect(page.locator('[data-production-review]')).toHaveAttribute(
    'data-initial-view-ready',
    'true',
  );
  await expect(page.locator(
    '.pdf-workspace:not(.pdf-workspace--reference) .pdf-workspace__page[data-page-index="0"]',
  ))
    .toBeVisible({ timeout: READY_TIMEOUT });
  return launched.sessionId;
}

async function openAnnotations(page: Page): Promise<void> {
  const rail = page.getByRole('button', { name: /^(?:Show|Hide) workspace$/u });
  if (await rail.getAttribute('aria-expanded') !== 'true') await rail.click();
  const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
  if (await annotations.getAttribute('aria-selected') !== 'true') await annotations.click();
  await expect(annotations).toHaveAttribute('aria-selected', 'true');
}

async function expectReferenceReady(page: Page, tab: Locator): Promise<void> {
  const retry = page.getByRole('button', { name: 'Retry reference' });
  const viewport = page.locator('[data-reference-pdf-viewport]');
  const targetIsReady = async () => (
    await tab.count() > 0
      && await tab.getAttribute('aria-selected') === 'true'
      && await viewport.isVisible()
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await expect.poll(async () => (
      await retry.isVisible()
      || await targetIsReady()
    ), { timeout: READY_TIMEOUT }).toBe(true);
    if (await targetIsReady()) break;
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(page.locator('[data-reference-pending="loading"]')).toHaveCount(0, {
      timeout: READY_TIMEOUT,
    });
  }
  await expect(viewport).toBeVisible({
    timeout: READY_TIMEOUT,
  });
  await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: READY_TIMEOUT });
  await expect(page.locator('[data-reference-pending="loading"]')).toHaveCount(0);
}

async function chooseCopyDestination(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Open automatic save options$/u }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose Where to Save Annotations' });
  await dialog.getByRole('textbox', { name: 'Copy name' }).fill(`reference-${randomUUID()}.pdf`);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: READY_TIMEOUT });
}

async function openPrimaryReference(page: Page): Promise<Locator> {
  const main = page.locator('.pdf-workspace:not(.pdf-workspace--reference)');
  await main.getByRole('button', { name: 'Open PDF link to Primary result, Page 2' }).click();
  await page.getByRole('menuitem', { name: /Open in References/u }).click();
  const tab = page.getByRole('tab', { name: /Primary result/u });
  await expectReferenceReady(page, tab);
  return tab;
}

async function mainSnapshot(page: Page) {
  const viewport = page.locator(
    '.pdf-workspace:not(.pdf-workspace--reference) [data-viewer-framing-viewport]',
  );
  return {
    href: page.url(),
    historyLength: await page.evaluate(() => history.length),
    page: await page.getByRole('textbox', { name: /^Current page \d+ of \d+/u }).inputValue(),
    zoom: await page.getByRole('textbox', { name: /^Current zoom \d+ percent/u }).inputValue(),
    scroll: await viewport.evaluate((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
    })),
  };
}

async function clickWithHitEvidence(control: Locator, label: string): Promise<void> {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  if (!box) throw new Error(`${label} has no pointer bounds.`);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const evidence = await control.evaluate((element, center) => {
    const hit = document.elementFromPoint(center.x, center.y);
    const describe = (candidate: Element | null) => candidate === null ? null : {
      tag: candidate.tagName,
      className: candidate.getAttribute('class'),
      role: candidate.getAttribute('role'),
      label: candidate.getAttribute('aria-label'),
      pageIndex: candidate.closest('[data-page-index]')?.getAttribute('data-page-index') ?? null,
      mainPdf: candidate.closest('.pdf-workspace:not(.pdf-workspace--reference)') !== null,
      referencePdf: candidate.closest('[data-reference-pdf-viewport]') !== null,
      rect: candidate.getBoundingClientRect().toJSON(),
    };
    return {
      center,
      control: describe(element),
      hit: describe(hit),
      ownedByControl: hit !== null && element.contains(hit),
    };
  }, point);
  try {
    await control.click({ timeout: 5_000 });
  } catch (error) {
    throw new Error(`${label} pointer hit was blocked: ${JSON.stringify(evidence)}`, {
      cause: error,
    });
  }
}

async function expectReferencePointerTargetNonInteractive(
  page: Page,
  point: { x: number; y: number },
  label: string,
): Promise<void> {
  const evidence = await page.evaluate(({ x, y }) => {
    const interactiveSelector = [
      '[data-pdf-link-control]', '[data-review-contextual-ui]', '[data-review-editor]',
      'input', 'textarea', '[contenteditable="true"]',
    ].join(',');
    const hit = document.elementFromPoint(x, y);
    return {
      pageIndex: hit?.closest('[data-page-index]')?.getAttribute('data-page-index') ?? null,
      referenceOwned: hit?.closest('[data-reference-pdf-viewport]') !== null,
      interactiveTarget: hit?.closest(interactiveSelector)?.outerHTML.slice(0, 800) ?? null,
      hit: hit?.outerHTML.slice(0, 800) ?? null,
    };
  }, point);
  expect(evidence, `${label} hit evidence: ${JSON.stringify(evidence)}`).toMatchObject({
    pageIndex: '0',
    referenceOwned: true,
    interactiveTarget: null,
  });
}

async function dragSelection(page: Page, pdfPage: Locator): Promise<void> {
  await pdfPage.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  const image = pdfPage.locator(':scope > img');
  await expect(image).toBeVisible();
  const box = await pdfPage.boundingBox();
  if (!box) throw new Error('Reference PDF page has no bounds.');
  const scale = box.width / 612;
  // The generated page-2 heading starts at PDF y=50. Keep both endpoints on
  // glyphs so the gesture exercises the viewer's real text-selection path.
  const start = { x: box.x + 92 * scale, y: box.y + 58 * scale };
  const end = { x: box.x + 330 * scale, y: box.y + 58 * scale };
  const hitEvidence = await page.evaluate(({ start, end }) => [start, end].map(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return {
      tag: hit?.tagName,
      className: hit?.getAttribute('class'),
      pageIndex: hit?.closest('[data-page-index]')?.getAttribute('data-page-index'),
      reference: hit?.closest('[data-reference-pdf-viewport]') !== null,
    };
  }), { start, end });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  const actions = page.getByRole('toolbar', { name: 'Selection review actions' });
  try {
    await expect(actions).toBeVisible();
  } catch {
    const nativeSelection = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    const selectionRectCount = await pdfPage.locator(
      ':scope > div[style*="mix-blend-mode"]',
    ).count();
    const cursor = await pdfPage.evaluate((element) => getComputedStyle(element).cursor);
    await page.mouse.click(box.x + 150 * scale, box.y + 68 * scale);
    await page.waitForTimeout(200);
    const insertionCaretCount = await page.locator('[data-review-insertion-caret]').count();
    throw new Error(`Reference selection was not published: ${JSON.stringify({
      hitEvidence,
      nativeSelection,
      selectionRectCount,
      cursor,
      insertionCaretCount,
    })}`);
  }
}

async function referenceSelectionBounds(page: Page) {
  return page.locator(
    '[data-reference-pdf-viewport] .pdf-workspace__page[data-page-index="1"]'
      + ' > div[style*="mix-blend-mode"]',
  ).evaluateAll((elements) => {
    const rects = elements.map((element) => element.getBoundingClientRect())
      .filter(({ width, height }) => width > 0 && height > 0);
    if (rects.length === 0) throw new Error('Reference selection has no painted rectangles.');
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { x: left, y: top, width: right - left, height: bottom - top };
  });
}

async function expectSelectionActionsInsideReference(
  page: Page,
  relationship: 'above' | 'below',
): Promise<void> {
  const actions = page.getByRole('toolbar', { name: 'Selection review actions' });
  const referenceViewport = page.locator('.reference-panel__viewport');
  await expect.poll(async () => {
    const [actionsBounds, viewportBounds, selectionBounds] = await Promise.all([
      actions.boundingBox(),
      referenceViewport.boundingBox(),
      referenceSelectionBounds(page),
    ]);
    if (actionsBounds === null || viewportBounds === null) return false;
    const inside = actionsBounds.x >= viewportBounds.x - 1
      && actionsBounds.y >= viewportBounds.y - 1
      && actionsBounds.x + actionsBounds.width <= viewportBounds.x + viewportBounds.width + 1
      && actionsBounds.y + actionsBounds.height <= viewportBounds.y + viewportBounds.height + 1;
    const related = relationship === 'above'
      ? actionsBounds.y + actionsBounds.height <= selectionBounds.y + 1
      : actionsBounds.y >= selectionBounds.y + selectionBounds.height - 1;
    return inside && related;
  }).toBe(true);
}

async function openPageNoteContextMenu(page: Page, pdfPage: Locator): Promise<void> {
  await pdfPage.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  const point = await pdfPage.evaluate((element) => {
    const pageBounds = element.getBoundingClientRect();
    const viewport = element.closest<HTMLElement>('[data-viewer-framing-viewport]');
    const viewportBounds = viewport?.getBoundingClientRect();
    if (!viewportBounds) throw new Error('Reference viewport has no bounds.');
    const left = Math.max(pageBounds.left, viewportBounds.left) + 24;
    const right = Math.min(pageBounds.right, viewportBounds.right) - 24;
    const top = Math.max(pageBounds.top, viewportBounds.top) + 24;
    const bottom = Math.min(pageBounds.bottom, viewportBounds.bottom) - 24;
    const unsafe = [
      '[data-owned-mark]', '[data-owned-annotation-layer]', '[data-source-annotation-layer]',
      '[data-source-link-layer]', '[data-pdf-link-interaction]', '[data-review-contextual-ui]',
    ].join(',');
    for (let y = bottom; y >= top; y -= 32) {
      for (let x = right; x >= left; x -= 32) {
        const hit = document.elementFromPoint(x, y);
        if (hit instanceof Element && hit.closest('[data-page-index]') === element
          && hit.closest(unsafe) === null) return { x, y };
      }
    }
    throw new Error('Reference PDF has no visible blank context-menu point.');
  });
  const hitEvidence = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    const state = { root: false, document: false, defaultPrevented: false };
    const root = hit?.closest('[data-reference-pdf-viewport]');
    root?.addEventListener('contextmenu', (event) => {
      state.root = true;
      queueMicrotask(() => { state.defaultPrevented = event.defaultPrevented; });
    }, { once: true });
    document.addEventListener('contextmenu', (event) => {
      state.document = true;
      queueMicrotask(() => { state.defaultPrevented = event.defaultPrevented; });
    }, { once: true });
    (globalThis as typeof globalThis & { __referenceContextProbe?: typeof state })
      .__referenceContextProbe = state;
    return {
      tag: hit?.tagName,
      className: hit?.getAttribute('class'),
      pageIndex: hit?.closest('[data-page-index]')?.getAttribute('data-page-index'),
      reference: root !== null,
    };
  }, point);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  const addPageNote = page.getByRole('menuitem', { name: 'Add Page Note' });
  if (!await addPageNote.isVisible()) {
    const eventEvidence = await page.evaluate(() => (
      globalThis as typeof globalThis & { __referenceContextProbe?: unknown }
    ).__referenceContextProbe);
    throw new Error(`Reference context menu was not published: ${JSON.stringify({
      hitEvidence,
      eventEvidence,
    })}`);
  }
  await addPageNote.click();
}

async function openLongReferenceCard(page: Page) {
  const sessionId = await openFixture(page, referencePdf, async (id) => {
    const state = host.broker.state(id);
    if (!state) throw new Error('Long-card review state is unavailable.');
    await host.broker.acceptMutation(id, addPageNote(
      state,
      0,
      { x: 400, y: 340, width: 18, height: 18 },
      LONG_REFERENCE_COMMENT,
    ));
  });
  await openAnnotations(page);
  const item = host.broker.state(sessionId)!.items.find(
    (candidate) => candidate.payload.comment === LONG_REFERENCE_COMMENT,
  );
  if (!item) throw new Error('Long-card annotation is unavailable.');
  const row = page.locator(`[data-review-item="${item.id}"]`);
  await row.hover();
  await row.getByRole('button', { name: 'Open in References' }).click();
  const activeTab = page.locator('[data-reference-tab][aria-selected="true"]');
  await expectReferenceReady(page, activeTab);
  const mark = page.locator(
    `[data-reference-pdf-viewport] [data-owned-focus-id="${item.id}"]`,
  );
  const ownedMark = page.locator(
    `[data-reference-pdf-viewport] [data-owned-mark][data-review-id="${item.id}"]`,
  ).first();
  const inspection = page.locator('[data-reference-annotation-inspection]');
  await expect(mark).toBeVisible();
  await expect(inspection).toBeVisible();
  return { activeTab, inspection, mark, ownedMark };
}

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'placekeeper-reference-annotations-'));
  sourceRoot = join(root, 'source');
  await mkdir(sourceRoot);
  referencePdf = join(root, 'reference-navigation.pdf');
  annotatedReferencePdf = join(root, 'reference-navigation-annotated.pdf');
  await copyFile(resolve('test/fixtures/pdfs/reference-navigation.pdf'), referencePdf);
  await copyFile(
    resolve('test/fixtures/pdfs/reference-navigation-annotated.pdf'),
    annotatedReferencePdf,
  );
  const residual = await PDFDocument.load(await readFile(referencePdf));
  const metadataOnly = residual.context.obj({
    Type: 'Annot',
    Subtype: 'PlacekeeperResidual',
    Rect: [90, 540, 150, 570],
    Contents: PDFString.of(''),
    T: PDFString.of('Read-only source'),
    NM: PDFString.of('metadata-only-residual'),
  });
  residual.getPage(0).node.set(
    PDFName.of('Annots'),
    residual.context.obj([residual.context.register(metadataOnly)]),
  );
  await writeFile(annotatedReferencePdf, await residual.save());
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

test('reuses an annotation Reference tab, reveals its mark, and leaves Main and the annotation list unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sessionId = await openFixture(page, referencePdf, async (id) => {
    const state = host.broker.state(id);
    if (!state) throw new Error('Seed review state is unavailable.');
    await host.broker.acceptMutation(id, addPageNote(
      state,
      0,
      { x: 90, y: 180, width: 18, height: 18 },
      'Canonical annotation opened in References.',
    ));
    const revised = host.broker.state(id)!;
    await host.broker.acceptMutation(id, addPageNote(
      revised,
      0,
      { x: 150, y: 240, width: 18, height: 18 },
      'Distinct annotation on the same page.',
    ));
  });
  await openAnnotations(page);
  const item = host.broker.state(sessionId)!.items.find(
    (candidate) => candidate.payload.comment === 'Canonical annotation opened in References.',
  )!;
  const mainViewport = page.locator(
    '.pdf-workspace:not(.pdf-workspace--reference) [data-viewer-framing-viewport]',
  );
  await page.waitForTimeout(300);
  const knownMainTop = await mainViewport.evaluate((element) => {
    const next = Math.min(80, Math.max(0, element.scrollHeight - element.clientHeight));
    element.scrollTop = next;
    return next;
  });
  expect(knownMainTop).toBeGreaterThan(0);
  await expect.poll(() => mainViewport.evaluate((element) => element.scrollTop))
    .toBe(knownMainTop);
  await page.waitForTimeout(250);
  await expect.poll(() => mainViewport.evaluate((element) => element.scrollTop))
    .toBe(knownMainTop);
  const unchangedMain = await mainSnapshot(page);
  const row = page.locator(`[data-review-item="${item.id}"]`);
  await row.hover();
  await row.getByRole('button', { name: 'Open in References' }).click();

  const tab = page.locator('[data-reference-tab][aria-selected="true"]');
  await expectReferenceReady(page, tab);
  const referenceMark = page.locator(
    `[data-reference-pdf-viewport] [data-owned-mark][data-review-id="${item.id}"]`,
  );
  await expect(referenceMark).toHaveCount(1);
  await expect(page.locator('[data-reference-annotation-inspection]')).toBeVisible();
  await referenceMark.focus();
  await page.keyboard.press('Enter');
  const inspection = page.locator('[data-reference-annotation-inspection]');
  await expect(inspection).toBeVisible();
  await expect(inspection).toHaveAccessibleName('Page Note annotation preview');
  await expect(inspection).toHaveAttribute('data-annotation-peek', item.id);
  await expect(inspection).toHaveAttribute('data-annotation-state', 'selected');
  await expect(inspection).toHaveAttribute('data-peek-selected', 'true');
  await expect(inspection.locator('[data-full-annotation-reader]')).toHaveCount(0);
  await expect(inspection.locator('.reference-inspection__context')).toHaveCount(0);
  await expect(inspection.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Annotations', exact: true }))
    .toHaveAttribute('aria-selected', 'true');
  expect(await mainSnapshot(page)).toEqual(unchangedMain);

  const tabIdentity = await tab.getAttribute('data-reference-tab');
  const viewport = page.locator('[data-reference-pdf-viewport] [data-viewer-framing-viewport]');
  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await row.hover();
  await row.getByRole('button', { name: 'Open in References' }).click();
  await expect(page.locator(`[data-reference-tab="${tabIdentity}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-reference-pdf-viewport] [data-owned-focus-id="${item.id}"]`))
    .toBeVisible();
  await expect(page.locator('[data-reference-annotation-inspection]')).toBeVisible();
  expect(await mainSnapshot(page)).toEqual(unchangedMain);

  const other = host.broker.state(sessionId)!.items.find(
    (candidate) => candidate.payload.comment === 'Distinct annotation on the same page.',
  )!;
  const otherRow = page.locator(`[data-review-item="${other.id}"]`);
  await otherRow.hover();
  await otherRow.getByRole('button', { name: 'Open in References' }).click();
  await expectReferenceReady(page, page.locator(`[data-reference-tab][aria-selected="true"]`));
  await expect(page.locator('[data-reference-tab]')).toHaveCount(2);
  await expect(page.locator('[data-reference-annotation-inspection]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Hide References' }).click();
  await expect(page.locator('[data-reference-annotation-inspection]')).toHaveCount(0);
  expect(await mainSnapshot(page)).toEqual(unchangedMain);
});

test('creates, edits, reopens, and deletes one shared selection annotation from References', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sessionId = await openFixture(page, referencePdf);
  await chooseCopyDestination(page);
  await openPrimaryReference(page);
  const unchangedMain = await mainSnapshot(page);
  const referencePage = page.locator(
    '[data-reference-pdf-viewport] .pdf-workspace__page[data-page-index="1"]',
  );
  await dragSelection(page, referencePage);
  await expect(page.locator('[data-review-stage]')).toHaveAttribute(
    'data-reference-layout',
    /wide-(?:bottom|split)/u,
  );
  await expectSelectionActionsInsideReference(page, 'above');
  await page.locator(
    '[data-reference-pdf-viewport] [data-viewer-framing-viewport]',
  ).evaluate((element) => {
    const viewport = element.closest<HTMLElement>('.reference-panel__viewport');
    const selectionRects = Array.from(element.querySelectorAll<HTMLElement>(
      '.pdf-workspace__page[data-page-index="1"] > div[style*="mix-blend-mode"]',
    )).map((selection) => selection.getBoundingClientRect())
      .filter(({ width, height }) => width > 0 && height > 0);
    if (selectionRects.length === 0 || viewport === null) {
      throw new Error('Reference selection geometry is unavailable.');
    }
    const selectionTop = Math.min(...selectionRects.map((rect) => rect.top));
    const viewportBounds = viewport.getBoundingClientRect();
    element.scrollTop += selectionTop - viewportBounds.top - 2;
  });
  await expectSelectionActionsInsideReference(page, 'below');
  const highlight = page.getByRole('toolbar', { name: 'Selection review actions' })
    .getByRole('button', { name: 'Highlight', exact: true });
  await installFirstVisibleReferencePlacementProbe(
    page,
    'reference-highlight-create',
    '[data-comment-composer]',
    '[data-reference-pdf-viewport] [data-authoring-preview="true"]',
  );
  await highlight.click();
  const composer = page.getByRole('region', { name: 'Highlight Comment' });
  await expectFirstVisibleReferencePlacement(
    page,
    'reference-highlight-create',
    composer,
    '[data-reference-pdf-viewport] [data-authoring-preview="true"]',
  );
  await composer.getByRole('textbox', { name: 'Comment (optional)' })
    .fill('Shared Reference highlight.');
  await composer.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(composer).toHaveCount(0);
  await expect.poll(() => host.broker.state(sessionId)?.items.some(
    (candidate) => candidate.payload.comment === 'Shared Reference highlight.',
  )).toBe(true);
  const item = host.broker.state(sessionId)!.items.find(
    (candidate) => candidate.payload.comment === 'Shared Reference highlight.',
  )!;
  expect(item).toMatchObject({ kind: 'highlight', pageIndex: 1 });
  const referenceFragments = page.locator(
    `[data-reference-pdf-viewport] [data-owned-mark][data-review-id="${item.id}"]`,
  );
  await expect.poll(() => referenceFragments.count()).toBeGreaterThan(0);
  await expect(page.locator(
    `.pdf-workspace:not(.pdf-workspace--reference) [data-review-id="${item.id}"]`,
  )).not.toHaveCount(0);
  expect(await mainSnapshot(page)).toEqual(unchangedMain);

  const referenceFocus = page.locator(
    `[data-reference-pdf-viewport] [data-owned-focus-id="${item.id}"]`,
  );
  await expect(referenceFocus).toBeVisible();
  await referenceFocus.focus();
  await page.keyboard.press('Enter');
  const inspection = page.locator('[data-reference-annotation-inspection]');
  await expect(inspection).toHaveAttribute('data-peek-selected', 'true');
  await inspection.hover();
  const editAction = inspection.getByRole('button', {
    name: 'Edit Highlight annotation on page 2',
  });
  await expect(editAction).toBeVisible();
  await installFirstVisibleReferencePlacementProbe(
    page,
    'reference-highlight-edit',
    '[data-comment-composer]',
    `[data-reference-pdf-viewport] [data-owned-mark][data-review-id="${item.id}"]`,
  );
  await installPostClickTransitionProbe(
    page,
    'reference-highlight-edit-open',
    '[data-reference-annotation-inspection]',
    '[data-comment-composer]',
    'to-visible',
  );
  await editAction.click();
  const edit = page.getByRole('region', { name: 'Edit Highlight' });
  await expectPostClickTransitionWithoutSurface(
    page,
    'reference-highlight-edit-open',
    'fromVisible',
  );
  await expectFirstVisibleReferencePlacement(
    page,
    'reference-highlight-edit',
    edit,
    `[data-reference-pdf-viewport] [data-owned-mark][data-review-id="${item.id}"]`,
  );
  await edit.getByRole('textbox', { name: 'Comment' }).fill('Cancelled Reference edit.');
  await installPostClickTransitionProbe(
    page,
    'reference-highlight-edit-cancel',
    '[data-comment-composer]',
    '[data-reference-annotation-inspection]',
    'from-hidden',
  );
  await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expectPostClickTransitionWithoutSurface(
    page,
    'reference-highlight-edit-cancel',
    'toVisible',
  );
  await expect(edit).toHaveCount(0);
  await expect(inspection).toHaveCount(0);

  await referenceFocus.focus();
  await page.keyboard.press('Enter');
  await expect(inspection).toHaveAttribute('data-peek-selected', 'true');
  await inspection.hover();
  await inspection.getByRole('button', {
    name: 'Edit Highlight annotation on page 2',
  }).click();
  const appliedEdit = page.getByRole('region', { name: 'Edit Highlight' });
  await expect(appliedEdit).toBeVisible();
  await appliedEdit.getByRole('textbox', { name: 'Comment' })
    .fill('Edited shared Reference highlight.');
  await installPostClickTransitionProbe(
    page,
    'reference-highlight-edit-apply',
    '[data-comment-composer]',
    '[data-reference-annotation-inspection]',
    'from-hidden',
  );
  await appliedEdit.getByRole('button', { name: 'Apply', exact: true }).click();
  await expectPostClickTransitionWithoutSurface(
    page,
    'reference-highlight-edit-apply',
    'toVisible',
  );
  await expect(appliedEdit).toHaveCount(0);
  await expect(inspection).toHaveCount(0);
  await expect.poll(() => host.broker.state(sessionId)?.items.find(
    (candidate) => candidate.id === item.id,
  )?.payload.comment).toBe('Edited shared Reference highlight.');

  await page.reload();
  await expect(page.locator('[data-production-review]')).toHaveAttribute(
    'data-initial-view-ready',
    'true',
  );
  await openAnnotations(page);
  const row = page.locator(`[data-review-item="${item.id}"]`);
  await expect(row).toContainText('Edited shared Reference highlight.');

  await page.getByRole('button', { name: 'Hide workspace', exact: true }).click();
  const workspace = page.locator('[data-review-workspace]');
  await expect(workspace).toHaveAttribute('data-workspace-open', 'false');
  const mainMark = page.locator(
    `.pdf-workspace:not(.pdf-workspace--reference) [data-owned-mark][data-review-id="${item.id}"]`,
  ).first();
  await mainMark.scrollIntoViewIfNeeded();
  const mainMarkBounds = await mainMark.boundingBox();
  if (!mainMarkBounds) throw new Error('Main annotation mark has no pointer bounds.');
  await page.mouse.click(
    mainMarkBounds.x + mainMarkBounds.width / 2,
    mainMarkBounds.y + mainMarkBounds.height / 2,
  );
  const mainCard = page.locator(
    `[data-annotation-peek="${item.id}"]:not([data-reference-annotation-inspection])`,
  );
  await expect(mainCard).toBeVisible();
  await mainCard.hover();
  await mainCard.getByRole('button', {
    name: 'Edit Highlight annotation on page 2',
  }).click();
  const mainEdit = page.getByRole('region', { name: 'Edit Highlight' });
  await expect(mainEdit).toBeVisible();
  await mainEdit.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(mainEdit).toHaveCount(0);
  await expect(workspace).toHaveAttribute('data-workspace-open', 'false');
  await expect(mainCard).toBeVisible();
  await expect(mainCard).toHaveAttribute('data-peek-selected', 'true');
  const mainPageImage = page.locator(
    '.pdf-workspace:not(.pdf-workspace--reference) .pdf-workspace__page[data-page-index="1"] > img',
  );
  const mainPageBounds = await mainPageImage.boundingBox();
  if (!mainPageBounds) throw new Error('Main PDF page has no outside-click bounds.');
  await page.mouse.click(mainPageBounds.x + 30, mainPageBounds.y + 300);
  await expect(mainCard).toHaveCount(0);

  await openAnnotations(page);
  await row.hover();
  await row.getByRole('button', { name: /Remove Highlight annotation/u }).click();
  await expect.poll(() => host.broker.state(sessionId)?.items.some(({ id }) => id === item.id))
    .toBe(false);
  await expect(page.locator(`[data-review-id="${item.id}"]`)).toHaveCount(0);
});

test('opens a residual source mark in References as read only, including metadata-only content', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sessionId = await openFixture(page, annotatedReferencePdf, async (id) => {
    const state = host.broker.state(id);
    if (!state) throw new Error('Owned-to-source inspection state is unavailable.');
    await host.broker.acceptMutation(id, addPageNote(
      state,
      0,
      { x: 400, y: 340, width: 18, height: 18 },
      'Owned inspection replaced by a source inspection.',
    ));
  });
  await openAnnotations(page);
  const ownedItem = host.broker.state(sessionId)!.items.find(
    (candidate) => candidate.payload.comment === 'Owned inspection replaced by a source inspection.',
  );
  if (!ownedItem) throw new Error('Owned-to-source inspection item is unavailable.');
  const ownedRow = page.locator(`[data-review-item="${ownedItem.id}"]`);
  await ownedRow.hover();
  await ownedRow.getByRole('button', { name: 'Open in References' }).click();
  await expectReferenceReady(page, page.locator('[data-reference-tab][aria-selected="true"]'));
  const inspection = page.locator('[data-reference-annotation-inspection]');
  const ownedMark = page.locator(
    `[data-reference-pdf-viewport] [data-owned-mark][data-review-id="${ownedItem.id}"]`,
  ).first();
  await expect(inspection).toHaveAttribute('data-annotation-origin', 'owned');
  await expect(inspection).toHaveAttribute('data-peek-selected', 'true');
  const tab = page.locator('[data-reference-tab][aria-selected="true"]');
  const sourceMark = page.locator('[data-reference-pdf-viewport] [data-source-focus-id]').first();
  await expect(sourceMark).toBeVisible();
  await expect(sourceMark).toHaveAttribute('data-source-focus-id', /metadata-only-residual/u);
  const referencePage = page.locator(
    '[data-reference-pdf-viewport] .pdf-workspace__page[data-page-index="0"]',
  );
  await referencePage.click({ position: { x: 8, y: 8 } });
  await expect(inspection).toHaveCount(0);
  await ownedMark.scrollIntoViewIfNeeded();
  await expect(ownedMark).toBeInViewport();
  const ownedPoint = await ownedMark.evaluate((element) => {
    const referenceRoot = element.closest('[data-reference-pdf-viewport]');
    const referenceViewport = element.closest('.reference-panel__viewport');
    const framingViewport = element.closest('[data-viewer-framing-viewport]');
    const referencePage = element.closest('[data-page-index]');
    if (!referenceRoot || !referenceViewport || !framingViewport || !referencePage) {
      throw new Error('Owned-to-source mark is outside the Reference PDF.');
    }
    const markBounds = element.getBoundingClientRect();
    const rootBounds = referenceRoot.getBoundingClientRect();
    const viewportBounds = referenceViewport.getBoundingClientRect();
    const framingBounds = framingViewport.getBoundingClientRect();
    const pageBounds = referencePage.getBoundingClientRect();
    const left = Math.max(
      markBounds.left,
      rootBounds.left,
      viewportBounds.left,
      framingBounds.left,
      pageBounds.left,
    );
    const top = Math.max(
      markBounds.top,
      rootBounds.top,
      viewportBounds.top,
      framingBounds.top,
      pageBounds.top,
    );
    const right = Math.min(
      markBounds.right,
      rootBounds.right,
      viewportBounds.right,
      framingBounds.right,
      pageBounds.right,
    );
    const bottom = Math.min(
      markBounds.bottom,
      rootBounds.bottom,
      viewportBounds.bottom,
      framingBounds.bottom,
      pageBounds.bottom,
    );
    if (right <= left || bottom <= top) {
      throw new Error('Owned-to-source mark has no visible Reference PDF intersection.');
    }
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  });
  await expectReferencePointerTargetNonInteractive(
    page,
    ownedPoint,
    'Owned-to-source Reference hover',
  );
  await page.mouse.move(ownedPoint.x, ownedPoint.y);
  await expect(inspection).toHaveAttribute('data-annotation-origin', 'owned');
  await expect(inspection).toHaveAttribute('data-peek-selected', 'false');
  await expect(ownedMark).toHaveAttribute('data-corresponding', 'true');
  await expect(ownedMark).toHaveCSS('outline-style', 'solid');

  const referencePageBounds = await referencePage.boundingBox();
  if (!referencePageBounds) throw new Error('Owned-to-source Reference page has no bounds.');
  await page.mouse.move(referencePageBounds.x + 8, referencePageBounds.y + 8);
  await expect(page.locator('[data-reference-pdf-viewport]'))
    .toHaveAttribute('data-owned-mark-hovered', 'false');
  await sourceMark.focus();
  await expect(inspection).toBeVisible();
  await expect(inspection).toHaveAttribute('data-annotation-origin', 'source');
  await expect(inspection).toHaveAttribute('data-peek-selected', 'false');
  await expect(ownedMark).toHaveAttribute('data-corresponding', 'false');
  await expect(ownedMark).toHaveCSS('outline-style', 'none');
  await tab.focus();
  await expect(inspection).toHaveCount(0);
  await sourceMark.focus();
  await expect(inspection).toBeVisible();
  await expect(inspection).toHaveAttribute('data-peek-selected', 'false');
  await page.keyboard.press('Enter');
  await expect(inspection).toBeVisible();
  await expect(inspection).toHaveAttribute('data-peek-selected', 'true');
  await expect(inspection).toHaveAccessibleName('unknow annotation preview');
  await expect(inspection).toHaveAttribute('data-annotation-origin', 'source');
  await expect(inspection).toHaveAttribute('data-readonly', 'true');
  await expect(inspection.locator('.annotation-item__kind-icon')).toHaveAttribute('title', 'unknow');
  await expect(inspection.locator('.annotation-item__page')).toHaveText('1');
  await expect(inspection.locator('.annotation-item__excerpt')).toHaveCount(0);
  await expect(inspection).not.toContainText('Read-only source');
  await expect(inspection).not.toContainText('Annotation contents');
  await inspection.hover();
  await expect(inspection.getByRole('button', { name: /Edit/u })).toHaveCount(0);
  await expect(inspection.getByRole('button', { name: /Remove/u })).toHaveCount(0);
  await expect(inspection.locator('[data-row-action="open-reference"]')).toBeVisible();
  await expect(inspection.locator('[data-row-action="locate"]')).toBeVisible();
  await expect(inspection.getByRole('button', { name: 'Back to annotation in PDF' })).toBeVisible();
  await expect(inspection.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
  await inspection.getByRole('button', { name: 'Open in References' }).focus();
  await page.keyboard.press('Escape');
  await expect(inspection).toHaveCount(0);
  await expect(sourceMark).toBeFocused();
  await expect(page.getByRole('textbox', { name: /^Current page 1 of 4/u })).toHaveValue('1');
});

test('keeps Reference card hover, selection, dismissal, and focus lifecycle mounted', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { activeTab, inspection, mark, ownedMark } = await openLongReferenceCard(page);
  const itemId = await inspection.getAttribute('data-annotation-peek');
  if (!itemId) throw new Error('Long-card annotation identity is unavailable.');
  const mainOwnedMark = page.locator(
    `.pdf-workspace:not(.pdf-workspace--reference) [data-owned-mark][data-review-id="${itemId}"]`,
  ).first();
  const mainFocus = page.locator(
    `.pdf-workspace:not(.pdf-workspace--reference) [data-owned-focus-id="${itemId}"]`,
  );
  const mainCard = page.locator(
    `[data-annotation-peek="${itemId}"]:not([data-reference-annotation-inspection])`,
  );
  await expect(mainOwnedMark).toBeVisible();
  const currentOwnedMarkPoint = async () => {
    const bounds = await ownedMark.boundingBox();
    if (!bounds) throw new Error('Reference annotation mark has no pointer bounds.');
    const point = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    const hit = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return {
        pageIndex: target?.closest('[data-page-index]')?.getAttribute('data-page-index'),
        referenceOwned: target?.closest('[data-reference-pdf-viewport]') != null,
      };
    }, point);
    expect(hit).toEqual({ pageIndex: '0', referenceOwned: true });
    return point;
  };
  const editAction = inspection.getByRole('button', {
    name: 'Edit Page Note annotation on page 1',
  });
  const removeAction = inspection.getByRole('button', {
    name: 'Remove Page Note annotation on page 1',
  });
  const directActions = inspection.locator('.row-action-group__direct');
  await expect(inspection.locator('[data-full-annotation-reader]')).toHaveCount(0);
  await expect(inspection.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);

  await editAction.focus();
  await page.keyboard.press('Escape');
  await expect(inspection).toHaveCount(0);
  await expect(mark).toBeFocused();
  await expect(ownedMark).toHaveAttribute('data-corresponding', 'true');
  await expect(ownedMark).toHaveCSS('outline-style', 'solid');

  await activeTab.hover();
  await activeTab.focus();
  await expect(activeTab).toBeFocused();
  await expect(ownedMark).toHaveAttribute('data-corresponding', 'false');
  await expect(ownedMark).toHaveCSS('outline-style', 'none');

  await mark.focus();
  await expect(inspection).toHaveAttribute('data-peek-selected', 'false');
  await page.keyboard.press('Enter');
  await expect(inspection).toHaveAttribute('data-peek-selected', 'true');
  await page.locator(
    '[data-reference-pdf-viewport] .pdf-workspace__page[data-page-index="0"]',
  ).click({ position: { x: 8, y: 8 } });
  await expect(inspection).toHaveCount(0);

  const toolsWorkspace = page.locator('#review-tools-workspace');
  await toolsWorkspace.getByRole('button', { name: 'Hide workspace', exact: true }).click();
  await expect(toolsWorkspace).toHaveAttribute('data-tools-workspace-open', 'false');
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await ownedMark.scrollIntoViewIfNeeded();
  await expect(ownedMark).toBeInViewport();

  await expect(mainFocus).toBeVisible();
  await mainFocus.focus();
  await expect(mainFocus).toBeFocused();
  await expect(mainCard).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(mainCard).toHaveCount(0);
  await expect(mainFocus).toBeFocused();

  const hoverPoint = await currentOwnedMarkPoint();
  await expectReferencePointerTargetNonInteractive(page, hoverPoint, 'Long-card hover');
  await installFirstVisibleReferenceCardProbe(
    page,
    'reference-hover-with-visible-main-twin',
    itemId,
  );
  await page.mouse.move(hoverPoint.x, hoverPoint.y);
  await expectFirstVisibleReferenceCard(page, 'reference-hover-with-visible-main-twin');
  await expect(inspection).toBeVisible();
  await expect(page.locator('[data-reference-pdf-viewport]'))
    .toHaveAttribute('data-owned-mark-hovered', 'true');
  await expect(ownedMark).toHaveAttribute('data-corresponding', 'true');
  await expect(ownedMark).toHaveAttribute('data-active', 'false');
  await expect(ownedMark).toHaveCSS('outline-style', 'solid');
  await expect(mainCard).toHaveCount(0);
  await expect(mainFocus).toBeFocused();
  await expect(inspection).toHaveAttribute('data-peek-selected', 'false');
  await expect(directActions).toHaveCSS('opacity', '0');
  await expect(directActions).toHaveCSS('pointer-events', 'none');
  await inspection.hover();
  await expect(page.locator('[data-reference-pdf-viewport]'))
    .toHaveAttribute('data-owned-mark-hovered', 'false');
  await expect(ownedMark).toHaveAttribute('data-corresponding', 'true');
  const referenceHoldStartedAt = await page.evaluate(() => performance.now());
  await expect.poll(() => page.evaluate(({ itemId, startedAt }) => {
    const matchingCards = [...document.querySelectorAll<HTMLElement>('[data-annotation-peek]')]
      .filter((element) => element.dataset.annotationPeek === itemId);
    return performance.now() - startedAt >= 180
      && matchingCards.some((element) => (
        element.hasAttribute('data-reference-annotation-inspection')
      ))
      && matchingCards.every((element) => (
        element.hasAttribute('data-reference-annotation-inspection')
      ));
  }, { itemId, startedAt: referenceHoldStartedAt })).toBe(true);
  await expectReferenceCardProbeOnlyReference(
    page,
    'reference-hover-with-visible-main-twin',
  );
  await expect(inspection).toBeVisible();
  await expect(mainCard).toHaveCount(0);
  await expect(inspection).toHaveAttribute('data-peek-selected', 'false');
  await expect(directActions).toHaveCSS('opacity', '1');
  await expect(directActions).toHaveCSS('pointer-events', 'auto');
  await expect(editAction).toBeVisible();
  await expect(removeAction).toBeVisible();
  const referencePage = page.locator(
    '[data-reference-pdf-viewport] .pdf-workspace__page[data-page-index="0"]',
  );
  const referencePageBounds = await referencePage.boundingBox();
  if (!referencePageBounds) throw new Error('Reference page has no pointer bounds.');
  await page.mouse.move(referencePageBounds.x + 8, referencePageBounds.y + 8);
  await expect(inspection).toHaveCount(0);
  await expect(page.locator('[data-reference-pdf-viewport]'))
    .toHaveAttribute('data-owned-mark-hovered', 'false');
  await expect(ownedMark).toHaveAttribute('data-corresponding', 'false');
  await expect(ownedMark).toHaveAttribute('data-active', 'false');
  await expect(ownedMark).toHaveCSS('outline-style', 'none');

  const selectedPoint = await currentOwnedMarkPoint();
  await page.mouse.move(selectedPoint.x, selectedPoint.y);
  await expect(inspection).toHaveAttribute('data-peek-selected', 'false');
  await inspection.hover();
  await expect(directActions).toHaveCSS('opacity', '1');
  await expect(directActions).toHaveCSS('pointer-events', 'auto');
  await expect(editAction).toBeVisible();
  await inspection.locator('.annotation-item__excerpt-main').click();
  await expect(inspection).toBeVisible();
  await expect(inspection).toHaveAttribute('data-peek-selected', 'true');
  await expect(ownedMark).toHaveAttribute('data-corresponding', 'true');
  await expect(ownedMark).toHaveCSS('outline-style', 'solid');
  await page.mouse.move(referencePageBounds.x + 8, referencePageBounds.y + 8);
  const leaveStartedAt = await page.evaluate(() => performance.now());
  await expect.poll(() => page.evaluate((startedAt) => (
    performance.now() - startedAt >= 180
      && document.querySelector('[data-reference-annotation-inspection]') !== null
  ), leaveStartedAt)).toBe(true);
  await expect(inspection).toHaveAttribute('data-peek-selected', 'true');
  await expect(page.locator('[data-reference-pdf-viewport]'))
    .toHaveAttribute('data-owned-mark-hovered', 'false');
  await expect(ownedMark).toHaveAttribute('data-corresponding', 'true');
  await expect(ownedMark).toHaveCSS('outline-style', 'solid');
  await editAction.focus();
  await page.keyboard.press('Escape');
  await expect(inspection).toHaveCount(0);
  await expect(mark).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(inspection).toBeVisible();
  await mark.evaluate((element) => element.remove());
  await editAction.focus();
  await page.keyboard.press('Escape');
  await expect(inspection).toHaveCount(0);
  await expect(activeTab).toBeFocused();
});

test('cancels an owned-mark press when the active Reference tab changes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sessionId = await openFixture(page, referencePdf, async (id) => {
    const state = host.broker.state(id);
    if (!state) throw new Error('Cross-tab pointer fixture state is unavailable.');
    await host.broker.acceptMutation(id, addPageNote(
      state,
      0,
      { x: 400, y: 340, width: 18, height: 18 },
      'Pointer press belongs to its initiating Reference tab.',
    ));
    await host.broker.acceptMutation(id, addPageNote(
      host.broker.state(id)!,
      0,
      { x: 460, y: 400, width: 18, height: 18 },
      'Successor Reference tab must not inherit the pointer press.',
    ));
  });
  await openAnnotations(page);
  const state = host.broker.state(sessionId)!;
  const initiatingItem = state.items.find(
    (item) => item.payload.comment === 'Pointer press belongs to its initiating Reference tab.',
  );
  const successorItem = state.items.find(
    (item) => item.payload.comment === 'Successor Reference tab must not inherit the pointer press.',
  );
  if (!initiatingItem || !successorItem) throw new Error('Cross-tab pointer items are unavailable.');
  const openItem = async (id: string) => {
    const row = page.locator(`[data-review-item="${id}"]`);
    await row.hover();
    await row.getByRole('button', { name: 'Open in References' }).click();
    const selectedTab = page.locator('[data-reference-tab][aria-selected="true"]');
    await expectReferenceReady(page, selectedTab);
    return selectedTab.getAttribute('data-reference-tab');
  };
  const initiatingTabIdentity = await openItem(initiatingItem.id);
  const successorTabIdentity = await openItem(successorItem.id);
  if (!initiatingTabIdentity || !successorTabIdentity) {
    throw new Error('Cross-tab pointer identities are unavailable.');
  }
  const initiatingTab = page.locator(`[data-reference-tab="${initiatingTabIdentity}"]`);
  const successorTab = page.locator(`[data-reference-tab="${successorTabIdentity}"]`);
  await initiatingTab.click();
  await expectReferenceReady(page, initiatingTab);
  const inspection = page.locator('[data-reference-annotation-inspection]');
  await page.keyboard.press('Escape');
  await expect(inspection).toHaveCount(0);
  const initiatingMark = page.locator(
    `[data-reference-pdf-viewport] [data-owned-mark][data-review-id="${initiatingItem.id}"]`,
  );
  const bounds = await initiatingMark.boundingBox();
  if (!bounds) throw new Error('Initiating Reference mark has no pointer bounds.');
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await expectReferencePointerTargetNonInteractive(page, point, 'Cross-tab pointerdown');
  await page.mouse.move(point.x, point.y);
  await expect(inspection).toHaveAttribute('data-peek-selected', 'false');
  await page.mouse.down();
  await successorTab.focus();
  await page.keyboard.press('Enter');
  await expectReferenceReady(page, successorTab);
  await page.mouse.up();
  await expect(inspection).toHaveCount(0);
});

test('keeps long Reference card text and actions reachable in a compact viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { inspection } = await openLongReferenceCard(page);
  const editAction = inspection.getByRole('button', {
    name: 'Edit Page Note annotation on page 1',
  });
  const deleteAction = inspection.getByRole('button', {
    name: 'Remove Page Note annotation on page 1',
  });
  await expect(inspection).toHaveAttribute('data-peek-selected', 'true');
  await expect(inspection.locator('[data-full-annotation-reader]')).toHaveCount(0);
  await expect(inspection.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
  const body = inspection.locator('.annotation-item__excerpt');
  expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await inspection.hover();
  await expect(editAction).toBeVisible();
  await expect(deleteAction).toBeVisible();

  await page.setViewportSize({ width: 300, height: 600 });
  await expect(inspection).toBeVisible();
  await expect.poll(() => body.evaluate(
    (element) => element.scrollHeight > element.clientHeight,
  )).toBe(true);
  await expect(editAction).toBeVisible();
  await expect(deleteAction).toBeVisible();
  await body.evaluate((element) => { element.scrollTop = 0; });
  const compactScrollportBounds = await body.boundingBox();
  if (!compactScrollportBounds) throw new Error('Compact Reference scrollport has no bounds.');
  await page.mouse.move(
    compactScrollportBounds.x + compactScrollportBounds.width / 2,
    compactScrollportBounds.y + compactScrollportBounds.height / 2,
  );
  await page.mouse.wheel(0, 10_000);
  await expect.poll(() => body.evaluate(
    (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
  )).toBe(true);
  const compactGeometry = await body.evaluate((element) => {
    const card = element.closest<HTMLElement>('[data-reference-annotation-inspection]');
    const text = element.querySelector<HTMLElement>('.annotation-item__excerpt-text');
    const node = text?.firstChild;
    if (card === null || !(node instanceof Text) || node.length === 0) {
      throw new Error('Compact Reference card text geometry is unavailable.');
    }
    const finalCharacter = document.createRange();
    finalCharacter.setStart(node, node.length - 1);
    finalCharacter.setEnd(node, node.length);
    return {
      card: card.getBoundingClientRect().toJSON(),
      scrollport: element.getBoundingClientRect().toJSON(),
      finalCharacter: finalCharacter.getBoundingClientRect().toJSON(),
      scrollTop: element.scrollTop,
    };
  });
  expect(compactGeometry.scrollTop).toBeGreaterThan(0);
  expect(compactGeometry.scrollport.y).toBeGreaterThanOrEqual(compactGeometry.card.y - 1);
  expect(compactGeometry.scrollport.y + compactGeometry.scrollport.height)
    .toBeLessThanOrEqual(compactGeometry.card.y + compactGeometry.card.height + 1);
  expect(compactGeometry.finalCharacter.y).toBeGreaterThanOrEqual(
    compactGeometry.scrollport.y - 1,
  );
  expect(compactGeometry.finalCharacter.y + compactGeometry.finalCharacter.height)
    .toBeLessThanOrEqual(
      compactGeometry.scrollport.y + compactGeometry.scrollport.height + 1,
    );
  const [compactCardBounds, compactEditBounds, compactDeleteBounds] = await Promise.all([
    inspection.boundingBox(),
    editAction.boundingBox(),
    deleteAction.boundingBox(),
  ]);
  if (!compactCardBounds || !compactEditBounds || !compactDeleteBounds) {
    throw new Error('Compact Reference card action geometry is unavailable.');
  }
  for (const actionBounds of [compactEditBounds, compactDeleteBounds]) {
    expect(actionBounds.x).toBeGreaterThanOrEqual(compactCardBounds.x - 1);
    expect(actionBounds.x + actionBounds.width)
      .toBeLessThanOrEqual(compactCardBounds.x + compactCardBounds.width + 1);
    expect(actionBounds.y).toBeGreaterThanOrEqual(compactCardBounds.y - 1);
    expect(actionBounds.y + actionBounds.height)
      .toBeLessThanOrEqual(compactCardBounds.y + compactCardBounds.height + 1);
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(inspection).toBeVisible();
  await inspection.hover();
  await expect(editAction).toBeVisible();
  await expect(deleteAction).toBeVisible();
  await editAction.click();
  const composer = page.getByRole('region', { name: 'Edit Page Note' });
  await expect(composer.getByRole('textbox', { name: 'Comment' }))
    .toHaveValue(LONG_REFERENCE_COMMENT);
  await expect(composer.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
  await expect(composer.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await composer.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(composer).toHaveCount(0);
});

test('opens an editable native import beside References without resizing the tray', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sessionId = await openFixture(page, referencePdf);
  await openAnnotations(page);
  const native = host.broker.state(sessionId)!.items.find(
    (item) => item.kind === 'pdfAnnotation' && item.pageIndex === 0,
  );
  if (!native) throw new Error('Editable native annotation is unavailable.');
  const row = page.locator(`[data-review-item="${native.id}"]`);
  await row.hover();
  await row.getByRole('button', { name: 'Open in References' }).click();
  await expectReferenceReady(page, page.locator('[data-reference-tab][aria-selected="true"]'));
  const inspection = page.locator('[data-reference-annotation-inspection]');
  await expect(inspection).toBeVisible();
  if (await inspection.getAttribute('data-placement') === 'bottom-sheet') {
    const geometryEvidence = await page.locator(
      `[data-reference-pdf-viewport] [data-owned-native-geometry][data-review-id="${native.id}"]`,
    ).evaluateAll((elements) => elements.map((element) => ({
      rect: element.getBoundingClientRect().toJSON(),
      style: element.getAttribute('style'),
      pageRect: element.closest('.pdf-workspace__page')?.getBoundingClientRect().toJSON() ?? null,
      viewportRect: element.closest('[data-viewer-framing-viewport]')
        ?.getBoundingClientRect().toJSON() ?? null,
      scrollTop: element.closest<HTMLElement>('[data-viewer-framing-viewport]')?.scrollTop ?? null,
    })));
    const referenceFields = await page.locator('[data-reference-pdf-viewport] input')
      .evaluateAll((elements) => elements.map((element) => ({
        label: element.getAttribute('aria-label'),
        value: (element as HTMLInputElement).value,
      })));
    const placementEvidence = await inspection.evaluate((element) => {
      const reader = element.closest<HTMLElement>('.annotation-peek--reference-inspection') ?? element;
      const stage = document.querySelector<HTMLElement>('[data-review-stage]');
      const scrollport = document.querySelector<HTMLElement>(
        '[data-reference-pdf-viewport] [data-viewer-framing-viewport]',
      );
      const computed = getComputedStyle(reader);
      return {
        stageRect: stage?.getBoundingClientRect().toJSON() ?? null,
        scrollportRect: scrollport?.getBoundingClientRect().toJSON() ?? null,
        visualViewport: window.visualViewport === null ? null : {
          offsetLeft: window.visualViewport.offsetLeft,
          offsetTop: window.visualViewport.offsetTop,
          width: window.visualViewport.width,
          height: window.visualViewport.height,
        },
        readerRect: reader.getBoundingClientRect().toJSON(),
        readerStyle: reader.getAttribute('style'),
        placement: element.getAttribute('data-placement')
          ?? reader.getAttribute('data-annotation-placement'),
        maxWidth: computed.maxWidth,
        maxHeight: computed.maxHeight,
      };
    });
    throw new Error(`Editable native reader used a sheet: ${JSON.stringify({
      geometryEvidence,
      referenceFields,
      placementEvidence,
      main: await mainSnapshot(page),
    })}`);
  }
  await expect(inspection.getByRole('button', {
    name: /Edit .* annotation on page 1/u,
  })).toBeVisible();
  await expect(inspection.getByRole('button', {
    name: /Remove .* annotation on page 1/u,
  })).toBeVisible();
  const tray = page.getByRole('complementary', { name: 'References' });
  const nativeMark = page.locator(
    `[data-reference-pdf-viewport] [data-owned-focus-id="${native.id}"]`,
  ).first();
  const [trayBefore, readerBounds] = await Promise.all([tray.boundingBox(), inspection.boundingBox()]);
  if (!trayBefore || !readerBounds) throw new Error('Native reader geometry is unavailable.');
  expect(readerBounds.y).toBeLessThan(trayBefore.y);
  await inspection.getByRole('button', { name: /Edit .* annotation on page 1/u }).focus();
  await page.keyboard.press('Escape');
  await expect(inspection).toHaveCount(0);
  await expect(nativeMark).toBeFocused();
  const nativeBounds = await page.locator(
    `[data-reference-pdf-viewport] [data-owned-native-geometry][data-review-id="${native.id}"]`,
  ).first().boundingBox();
  if (!nativeBounds) throw new Error('Native Reference mark has no pointer bounds.');
  await page.mouse.click(
    nativeBounds.x + nativeBounds.width / 2,
    nativeBounds.y + nativeBounds.height / 2,
  );
  await expect(inspection).toBeVisible();
  await expect(inspection).toHaveAttribute('data-peek-selected', 'true');
  expect(await tray.boundingBox()).toEqual(trayBefore);

  await page.setViewportSize({ width: 300, height: 600 });
  await nativeMark.focus();
  await page.keyboard.press('Enter');
  await expect(inspection).toBeVisible();
  await expect(inspection).toHaveAttribute('data-annotation-peek', native.id);
  await expect(inspection).toHaveAttribute('data-peek-selected', 'true');
  await expect(inspection.locator('[data-full-annotation-reader]')).toHaveCount(0);
});

test('closes a deleted passive reader and preserves a stale edit with Save disabled', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sessionId = await openFixture(page, referencePdf, async (id) => {
    const initial = host.broker.state(id)!;
    await host.broker.acceptMutation(id, addPageNote(
      initial,
      0,
      { x: 90, y: 180, width: 18, height: 18 },
      'Passive deletion target.',
    ));
    const revised = host.broker.state(id)!;
    await host.broker.acceptMutation(id, addPageNote(
      revised,
      0,
      { x: 150, y: 240, width: 18, height: 18 },
      'Stale editing target.',
    ));
  });
  await openAnnotations(page);
  const passive = host.broker.state(sessionId)!.items.find(
    (item) => item.payload.comment === 'Passive deletion target.',
  )!;
  const stale = host.broker.state(sessionId)!.items.find(
    (item) => item.payload.comment === 'Stale editing target.',
  )!;
  const passiveRow = page.locator(`[data-review-item="${passive.id}"]`);
  await passiveRow.hover();
  await passiveRow.getByRole('button', { name: 'Open in References' }).click();
  await expectReferenceReady(page, page.locator('[data-reference-tab][aria-selected="true"]'));
  await expect(page.locator('[data-reference-annotation-inspection]')).toBeVisible();
  await host.broker.acceptMutation(
    sessionId,
    removeReviewItem(host.broker.state(sessionId)!, passive.id),
  );
  await expect(page.locator('[data-reference-annotation-inspection]')).toHaveCount(0);

  const staleRow = page.locator(`[data-review-item="${stale.id}"]`);
  await staleRow.hover();
  await staleRow.getByRole('button', { name: 'Open in References' }).click();
  await expectReferenceReady(page, page.locator('[data-reference-tab][aria-selected="true"]'));
  const inspection = page.locator('[data-reference-annotation-inspection]');
  await expect(inspection).toHaveAttribute('data-peek-selected', 'true');
  await inspection.hover();
  await inspection.getByRole('button', {
    name: 'Edit Page Note annotation on page 1',
  }).click();
  const composer = page.getByRole('region', { name: 'Edit Page Note' });
  const editor = composer.getByRole('textbox', { name: 'Comment' });
  const recoverableDraft = 'Recover this text after the target disappears.';
  await editor.fill(recoverableDraft);
  await expect.poll(() => host.broker.state(sessionId)?.pendingDrafts.find(
    (candidate) => candidate.targetItemId === stale.id,
  )?.text).toBe(recoverableDraft);
  await host.broker.acceptMutation(
    sessionId,
    removeReviewItem(host.broker.state(sessionId)!, stale.id),
  );
  await expect(editor).toHaveValue(recoverableDraft);
  await expect(composer.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  expect(host.broker.state(sessionId)!.items.some(({ id }) => id === stale.id)).toBe(false);
});

test('defers document authority replacement while a Reference edit is active', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const livePdf = await freshPdf(referencePdf);
  const launched = await host.open({
    pdfPath: livePdf,
    sourceRootPath: sourceRoot,
    workflowMode: 'generated-output',
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Generated-output Reference fixture did not launch.');
  }
  const initial = host.broker.state(launched.sessionId);
  if (!initial) throw new Error('Generated-output Reference state is unavailable.');
  await host.broker.acceptMutation(launched.sessionId, addPageNote(
    initial,
    0,
    { x: 90, y: 180, width: 18, height: 18 },
    'Document replacement edit target.',
  ));
  await page.goto(launched.url);
  await expect(page.locator('[data-production-review]')).toHaveAttribute(
    'data-initial-view-ready',
    'true',
  );
  await expect(page.locator(
    '.pdf-workspace:not(.pdf-workspace--reference) .pdf-workspace__page[data-page-index="0"]',
  )).toBeVisible({ timeout: READY_TIMEOUT });

  await openAnnotations(page);
  const item = host.broker.state(launched.sessionId)!.items.find(
    (candidate) => candidate.payload.comment === 'Document replacement edit target.',
  );
  if (!item) throw new Error('Document replacement edit item is unavailable.');
  const row = page.locator(`[data-review-item="${item.id}"]`);
  await row.hover();
  await row.getByRole('button', { name: 'Open in References' }).click();
  await expectReferenceReady(page, page.locator('[data-reference-tab][aria-selected="true"]'));
  const inspection = page.locator('[data-reference-annotation-inspection]');
  await expect(inspection).toHaveAttribute('data-peek-selected', 'true');
  await inspection.hover();
  await inspection.getByRole('button', {
    name: 'Edit Page Note annotation on page 1',
  }).click();
  const composer = page.getByRole('region', { name: 'Edit Page Note' });
  const editor = composer.getByRole('textbox', { name: 'Comment' });
  const apply = composer.getByRole('button', { name: 'Apply', exact: true });
  const draft = 'Keep this Reference draft after document authority changes.';
  await editor.fill(draft);
  await expect(page.locator(
    `[data-reference-pdf-viewport] [data-review-id="${item.id}"][data-authoring-preview="true"]`,
  )).not.toHaveCount(0);
  await expect.poll(() => host.broker.state(launched.sessionId)?.pendingDrafts.some(
    (candidate) => candidate.text === draft,
  )).toBe(true);

  await host.broker.markLiveDocumentPossiblyStale(launched.sessionId, 1);
  await copyFile(annotatedReferencePdf, livePdf);
  const replacement = await host.broker.replaceLiveDocument({
    sessionId: launched.sessionId,
    outputPath: livePdf,
    observationEpoch: 2,
  });
  expect(replacement).toMatchObject({
    status: 'deferred',
    documentGeneration: launched.documentGeneration,
    reason: 'active-review-interaction',
  });
  await expect(composer).toBeVisible();
  await expect(editor).toHaveValue(draft);
  await expect(apply).toBeEnabled();
  await expect(page.locator(
    `[data-reference-pdf-viewport] [data-review-id="${item.id}"][data-authoring-preview="true"]`,
  )).not.toHaveCount(0);
  expect(host.broker.state(launched.sessionId)!.items.some(
    (candidate) => candidate.payload.comment === draft,
  )).toBe(false);
  await composer.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(composer).toHaveCount(0);
  await expect.poll(() => host.broker.state(launched.sessionId)?.workflow.documentGeneration, {
    timeout: READY_TIMEOUT,
  }).toBe(launched.documentGeneration + 1);
  expect(host.broker.state(launched.sessionId)?.pendingDrafts).toHaveLength(0);
});

test('recovers a closed annotation-origin editor and reuses its tab after applying the edit', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sessionId = await openFixture(page, referencePdf, async (id) => {
    const state = host.broker.state(id);
    if (!state) throw new Error('Annotation-origin recovery state is unavailable.');
    await host.broker.acceptMutation(id, addPageNote(
      state,
      0,
      { x: 90, y: 180, width: 18, height: 18 },
      'Annotation-origin recovery target.',
    ));
  });
  await openAnnotations(page);
  const item = host.broker.state(sessionId)!.items.find(
    (candidate) => candidate.payload.comment === 'Annotation-origin recovery target.',
  );
  if (!item) throw new Error('Annotation-origin recovery item is unavailable.');
  const row = page.locator(`[data-review-item="${item.id}"]`);
  await row.hover();
  await row.getByRole('button', { name: 'Open in References' }).click();
  const originTab = page.locator('[data-reference-tab][aria-selected="true"]');
  await expectReferenceReady(page, originTab);
  const tabIdentity = await originTab.getAttribute('data-reference-tab');
  if (!tabIdentity) throw new Error('Annotation-origin tab identity is unavailable.');

  const inspection = page.locator('[data-reference-annotation-inspection]');
  await expect(inspection).toHaveAttribute('data-peek-selected', 'true');
  await inspection.hover();
  await inspection.getByRole('button', {
    name: 'Edit Page Note annotation on page 1',
  }).click();
  const composer = page.getByRole('region', { name: 'Edit Page Note' });
  const editor = composer.getByRole('textbox', { name: 'Comment' });
  const revisedComment = 'Recovered edit still belongs to its annotation-origin tab.';
  await editor.fill(revisedComment);

  await originTab.hover();
  const close = page.getByRole('button', { name: 'Close active reference', exact: true });
  await expect(close).toBeVisible();
  await close.click();
  await expect(originTab).toHaveCount(0);
  await expect(editor).toHaveValue(revisedComment);
  const backToPassage = composer.getByRole('button', { name: 'Back to passage' });
  await expect(backToPassage).toBeVisible();
  await backToPassage.click();

  const recreatedTab = page.locator(`[data-reference-tab="${tabIdentity}"]`);
  await expectReferenceReady(page, recreatedTab);
  await expect(page.locator(
    `[data-reference-pdf-viewport] [data-owned-focus-id="${item.id}"]`,
  )).toBeVisible();
  await expect(composer).toHaveAttribute('data-composer-placement', 'side');
  await expect(composer.getByRole('button', { name: 'Resume editing' })).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(revisedComment);
  await expect(composer.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
  await composer.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(composer).toHaveCount(0);
  await expect(row).toContainText(revisedComment);

  await row.hover();
  await row.getByRole('button', { name: 'Open in References' }).click();
  await expectReferenceReady(page, recreatedTab);
  await expect(page.locator(`[data-reference-tab="${tabIdentity}"]`)).toHaveCount(1);
  await expect(page.locator('[data-reference-tab]')).toHaveCount(1);
  await expect(inspection).toContainText(revisedComment);
});

test('authors on a Reference page and preserves one focused draft through switch, hide, layout, and closure', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sessionId = await openFixture(page, referencePdf);
  await chooseCopyDestination(page);
  const originTab = await openPrimaryReference(page);
  const reference = page.locator('[data-reference-pdf-viewport]');
  const detailLink = reference.getByRole('button', {
    name: 'Open PDF link to Target-to-target detail link, Page 3',
  });
  await detailLink.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await detailLink.click();
  await page.getByRole('menuitem', { name: /Open in References/u }).click();
  const detailTab = page.getByRole('tab', { name: /Target-to-target detail link/u });
  await expectReferenceReady(page, detailTab);
  await originTab.click();
  await expectReferenceReady(page, originTab);
  const referencePage = page.locator('[data-reference-pdf-viewport] [data-page-index="1"]');
  await expect(referencePage).toBeVisible();
  const tray = page.getByRole('complementary', { name: 'References' });
  const trayBefore = await tray.boundingBox();
  await openPageNoteContextMenu(page, referencePage);

  const composer = page.getByRole('region', { name: 'Page Note' });
  const editor = composer.getByRole('textbox', { name: 'Comment' });
  const draft = 'Reference draft survives resize, closure, and an authoritative retry.';
  await expect(composer).not.toContainText('Primary result · Page 2');
  await editor.fill(draft);
  await editor.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(10, 25));
  const editorNode = await editor.evaluateHandle((element) => element);
  const [trayAfter, composerBounds] = await Promise.all([tray.boundingBox(), composer.boundingBox()]);
  expect(trayAfter).toEqual(trayBefore);
  if (!trayAfter || !composerBounds) throw new Error('Reference composer geometry is unavailable.');
  await expect(composer).toHaveAttribute('data-composer-placement', 'side');
  expect(composerBounds.width).toBeLessThan(trayAfter.width);
  expect(composerBounds.x).toBeGreaterThanOrEqual(trayAfter.x);
  expect(composerBounds.x + composerBounds.width)
    .toBeLessThanOrEqual(trayAfter.x + trayAfter.width);

  await clickWithHitEvidence(detailTab, 'Detail Reference tab');
  await expectReferenceReady(page, detailTab);
  await expect(editor).toHaveValue(draft);
  await expect(composer.getByRole('button', { name: 'Back to passage' })).toBeVisible();
  expect(await editor.evaluate((element, original) => element === original, editorNode)).toBe(true);
  await clickWithHitEvidence(originTab, 'Origin Reference tab');
  await expectReferenceReady(page, originTab);
  await expect(composer).toHaveAttribute('data-composer-placement', 'side');
  await editor.focus();
  await expect(editor).toBeFocused();

  await clickWithHitEvidence(
    page.getByRole('button', { name: 'Hide References' }),
    'Hide References',
  );
  await expect(editor).toHaveValue(draft);
  await expect(composer).toHaveAttribute('data-composer-placement', 'side');
  expect(await editor.evaluate((element, original) => element === original, editorNode)).toBe(true);
  await clickWithHitEvidence(
    page.getByRole('button', { name: 'Show References' }),
    'Show References',
  );
  await expectReferenceReady(page, originTab);
  await expect(composer).toHaveAttribute('data-composer-placement', 'side');
  await editor.focus();
  await expect(editor).toBeFocused();
  await editor.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(10, 25));

  await page.setViewportSize({ width: 300, height: 600 });
  await expect(composer).toHaveAttribute('data-composer-placement', 'bottom-sheet');
  await expect(editor).toHaveValue(draft);
  await expect(editor).toBeFocused();
  expect(await editor.evaluate((element) => ({
    start: (element as HTMLTextAreaElement).selectionStart,
    end: (element as HTMLTextAreaElement).selectionEnd,
  }))).toEqual({ start: 10, end: 25 });
  expect(await editor.evaluate((element, original) => element === original, editorNode)).toBe(true);
  await expect(composer.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await expect(composer.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(composer).toHaveAttribute('data-composer-placement', 'side');
  await expect(editor).toHaveValue(draft);
  expect(await editor.evaluate((element, original) => element === original, editorNode)).toBe(true);

  await originTab.hover();
  const close = page.getByRole('button', { name: 'Close active reference', exact: true });
  await expect(close).toBeVisible();
  await clickWithHitEvidence(close, 'Close origin Reference tab');
  await expect(originTab).toHaveCount(0);
  await expect(editor).toHaveValue(draft);
  await expect(composer.getByRole('button', { name: 'Back to passage' })).toBeVisible();

  await page.keyboard.press('Alt+Shift+N');
  await expect(page.locator('[data-comment-composer]')).toHaveCount(1);
  await page.setViewportSize({ width: 300, height: 600 });
  await expect(composer).toHaveAttribute('data-composer-placement', 'bottom-sheet');
  await composer.getByRole('button', { name: 'Back to passage' }).click();
  const recreatedTab = page.locator('[data-reference-tab][aria-selected="true"]');
  try {
    await expectReferenceReady(page, recreatedTab);
  } catch (error) {
    const recoveryEvidence = await page.evaluate(() => {
      const reference = document.querySelector<HTMLElement>('[data-reference-pdf-viewport]');
      const viewport = reference?.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
      const targetPage = reference?.querySelector<HTMLElement>('.pdf-workspace__page[data-page-index="1"]');
      const workspace = document.querySelector<HTMLElement>('aside[data-review-workspace]');
      const layout = document.querySelector<HTMLElement>('.review-layout');
      const drawerHost = document.querySelector<HTMLElement>('.review-drawer-host');
      const rect = (element: HTMLElement | null | undefined) =>
        element?.getBoundingClientRect().toJSON() ?? null;
      return {
        tabs: Array.from(document.querySelectorAll<HTMLElement>('[data-reference-tab]')).map((tab) => ({
          identity: tab.dataset.referenceTab,
          label: tab.textContent?.trim(),
          selected: tab.getAttribute('aria-selected'),
        })),
        status: Array.from(document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]'))
          .map((element) => element.textContent?.trim()).filter(Boolean),
        reference: reference === null ? null : {
          rect: reference.getBoundingClientRect().toJSON(),
          display: getComputedStyle(reference).display,
          visibility: getComputedStyle(reference).visibility,
        },
        viewport: viewport === null || viewport === undefined ? null : {
          rect: viewport.getBoundingClientRect().toJSON(),
          clientHeight: viewport.clientHeight,
          scrollTop: viewport.scrollTop,
        },
        targetPage: targetPage === null || targetPage === undefined
          ? null
          : targetPage.getBoundingClientRect().toJSON(),
        workspace: workspace === null ? null : {
          open: workspace.dataset.workspaceOpen,
          hidden: workspace.getAttribute('aria-hidden'),
          inert: workspace.hasAttribute('inert'),
          presentation: workspace.dataset.workspacePresentation,
          rect: rect(workspace),
        },
        layout: layout === null ? null : {
          referenceLayout: layout.dataset.referenceLayout,
          rect: rect(layout),
        },
        drawerHost: rect(drawerHost),
      };
    });
    throw new Error(`Compact passage recovery failed: ${JSON.stringify(recoveryEvidence)}`, {
      cause: error,
    });
  }
  await expect(page.locator(
    '[data-reference-pdf-viewport] .pdf-workspace__page[data-page-index="1"]',
  )).toBeVisible();
  await expect(composer.getByRole('button', { name: 'Resume editing' })).toBeVisible();
  await composer.getByRole('button', { name: 'Resume editing' }).click();
  await expect(editor).toHaveValue(draft);
  await expect(editor).toBeFocused();
  expect(await editor.evaluate((element) => ({
    start: (element as HTMLTextAreaElement).selectionStart,
    end: (element as HTMLTextAreaElement).selectionEnd,
  }))).toEqual({ start: 10, end: 25 });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(composer).toHaveAttribute('data-composer-placement', 'side');

  const external = host.broker.state(sessionId)!;
  await host.broker.acceptMutation(sessionId, addPageNote(
    external,
    3,
    { x: 80, y: 160, width: 18, height: 18 },
    'Concurrent annotation.',
  ));
  await composer.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(composer).toHaveCount(0);
  await expect.poll(() => host.broker.state(sessionId)?.items.some(
    (item) => item.payload.comment === draft,
  )).toBe(true);
  const saved = host.broker.state(sessionId)!.items.find((item) => item.payload.comment === draft);
  expect(saved).toMatchObject({ kind: 'pageNote', pageIndex: 1 });
  await expect(page.getByRole('textbox', { name: /^Current page 1 of 4/u })).toHaveValue('1');
});

test('retains Reference draft text and Main state when the PDF save fails', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sessionId = await openFixture(page, referencePdf);
  await chooseCopyDestination(page);
  await openPrimaryReference(page);
  const unchangedMain = await mainSnapshot(page);
  const referencePage = page.locator('[data-reference-pdf-viewport] [data-page-index="1"]');
  await openPageNoteContextMenu(page, referencePage);
  const composer = page.getByRole('region', { name: 'Page Note' });
  const editor = composer.getByRole('textbox', { name: 'Comment' });
  const draft = 'Keep this draft after the destination disappears.';
  await editor.fill(draft);
  const destination = host.broker.saveStatus(sessionId)?.destination;
  if (destination?.phase !== 'active' || destination.kind !== 'copy') {
    throw new Error('Copy save destination is unavailable.');
  }
  await rm(destination.targetPath, { force: true });
  await mkdir(destination.targetPath);
  await composer.getByRole('button', { name: 'Save', exact: true }).click();
  const failure = page.getByRole('alert');
  await expect(failure).toContainText('Couldn’t save your latest annotations.');
  const save = composer.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save.locator('.lucide-loader-circle')).toBeVisible();
  await expect(composer.getByRole('status')).toHaveText('Saving annotation to PDF.');
  await expect(composer).not.toContainText(
    'Waiting for the PDF to save. Use Retry in the save alert.',
  );
  await expect(editor).toHaveValue(draft);
  await expect(editor).toHaveAttribute('readonly', '');
  await expect(composer).toBeVisible();
  await expect(save).toBeDisabled();
  await expect.poll(() => host.broker.saveStatus(sessionId)?.sync.phase).toBe('not-saved');
  const accepted = host.broker.state(sessionId)!;
  const acceptedItem = accepted.items.find((item) => item.payload.comment === draft);
  if (!acceptedItem) throw new Error('Failed persistence did not retain its canonical annotation.');

  await failure.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => host.broker.saveStatus(sessionId)?.sync.phase).toBe('not-saved');
  await expect(editor).toHaveValue(draft);
  await expect(composer).toBeVisible();
  expect(host.broker.state(sessionId)!.items.filter((item) => item.payload.comment === draft))
    .toHaveLength(1);

  await failure.getByRole('button', { name: 'Save a copy…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose Where to Save Annotations' });
  await dialog.getByRole('textbox', { name: 'Copy name' })
    .fill(`recovered-${randomUUID()}.pdf`);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => host.broker.saveStatus(sessionId)?.sync.phase).toBe('clean');
  await expect(composer).toHaveCount(0);
  const recovered = host.broker.state(sessionId)!;
  expect(recovered.revision).toBe(accepted.revision);
  expect(recovered.items.filter((item) => item.payload.comment === draft).map((item) => item.id))
    .toEqual([acceptedItem.id]);
  expect(await mainSnapshot(page)).toEqual(unchangedMain);
});

test('keeps Reference links above marks and creates a keyboard Page Note on the active Reference page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sessionId = await openFixture(page, referencePdf, async (id) => {
    const state = host.broker.state(id);
    if (!state) throw new Error('Overlap fixture review state is unavailable.');
    await host.broker.acceptMutation(id, addHighlight(state, {
      pageIndex: 1,
      quote: 'Target-to-target overlap',
      prefix: '',
      suffix: '',
      rect: { x: 72, y: 172, width: 288, height: 20 },
      segmentRects: [
        { x: 72, y: 172, width: 228, height: 20 },
        { x: 300, y: 172, width: 60, height: 20 },
      ],
      reliable: true,
    }, 'Two fragments overlap the PDF link.'));
  });
  await chooseCopyDestination(page);
  await openPrimaryReference(page);
  const reference = page.locator('[data-reference-pdf-viewport]');
  const overlap = host.broker.state(sessionId)!.items.find(
    (item) => item.payload.comment === 'Two fragments overlap the PDF link.',
  );
  if (!overlap) throw new Error('Overlap fixture annotation is unavailable.');
  await expect(reference.locator(`[data-owned-mark][data-review-id="${overlap.id}"]`))
    .toHaveCount(2);
  const targetLink = reference.getByRole('button', {
    name: 'Open PDF link to Target-to-target detail link, Page 3',
  });
  await expect(targetLink).toBeVisible();
  const overlapMarks = await reference
    .locator(`[data-owned-mark][data-review-id="${overlap.id}"]`)
    .all();
  const [linkBounds, ...markBounds] = await Promise.all([
    targetLink.boundingBox(),
    ...overlapMarks.map((mark) => mark.boundingBox()),
  ]);
  if (!linkBounds) throw new Error('Overlapping Reference link geometry is unavailable.');
  const concreteMarkBounds = markBounds.map((bounds) => {
    if (!bounds) throw new Error('Overlapping Reference mark geometry is unavailable.');
    return bounds;
  });
  const overlapBounds = concreteMarkBounds
    .map((bounds) => ({
      left: Math.max(linkBounds.x, bounds.x),
      top: Math.max(linkBounds.y, bounds.y),
      right: Math.min(linkBounds.x + linkBounds.width, bounds.x + bounds.width),
      bottom: Math.min(linkBounds.y + linkBounds.height, bounds.y + bounds.height),
    }))
    .find((bounds) => bounds.right > bounds.left && bounds.bottom > bounds.top);
  if (!overlapBounds) throw new Error('Reference link does not overlap the owned annotation.');
  const overlapPoint = {
    x: (overlapBounds.left + overlapBounds.right) / 2,
    y: (overlapBounds.top + overlapBounds.bottom) / 2,
  };
  expect(await targetLink.evaluate((element, point) => {
    const hit = document.elementFromPoint(point.x, point.y);
    return hit !== null && element.contains(hit);
  }, overlapPoint)).toBe(true);
  await page.mouse.click(overlapPoint.x, overlapPoint.y);
  const openInReferences = page.getByRole('menuitem', { name: /Open in References/u });
  await expect(openInReferences).toBeVisible();
  await expect(page.locator('[data-reference-annotation-inspection]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(openInReferences).toHaveCount(0);
  await expect(targetLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(openInReferences).toBeFocused();
  await page.keyboard.press('Escape');

  const pageTwo = reference.locator('.pdf-workspace__page[data-page-index="1"]');
  await pageTwo.focus();
  await page.keyboard.press('Alt+Shift+N');
  const cursor = page.getByRole('button', { name: /^Page Note placement cursor/u });
  await expect(cursor).toBeFocused();
  expect(await cursor.evaluate((element) => (
    element.closest('[data-page-index]')?.getAttribute('data-page-index')
  ))).toBe('1');
  await page.keyboard.press('Enter');
  const composer = page.getByRole('region', { name: 'Page Note' });
  await composer.getByRole('textbox', { name: 'Comment' }).fill('Keyboard note from References.');
  await composer.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => host.broker.state(sessionId)?.items.some(
    (item) => item.payload.comment === 'Keyboard note from References.',
  )).toBe(true);
  const saved = host.broker.state(sessionId)!.items.find(
    (item) => item.payload.comment === 'Keyboard note from References.',
  );
  expect(saved).toMatchObject({ kind: 'pageNote', pageIndex: 1 });
  await expect(page.getByRole('textbox', { name: /^Current page 1 of 4/u })).toHaveValue('1');
});
