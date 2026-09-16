import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

import { PlacekeeperHost } from "../../apps/service/src/host/placekeeper-host.js";
import { TaskBindingRegistry } from "../../apps/service/src/context/task-binding-registry.js";
import { readEditableReviewItems } from "../../packages/pdf-backends/src/embedpdf-adapter.js";
import { addPageNote, setAnnotationName } from "../../packages/core/src/review-commands.js";
import { ReviewConflictError } from '../../packages/core/src/review-reducer.js';

let root = "";
let host: PlacekeeperHost;
let sourceRoot = "";
let pdf = "";
let plainTextPdf = "";
let multiPagePdf = "";
let rotatedPdf = "";
let referencePdf = "";
let annotatedReferencePdf = "";
let searchPdf = "";
let equationPdf = "";
let crossPagePdf = "";
let metadataTitlePdf = "";

const reportedMathSymbolInventory = [
  ['·', '\\cdot'], ['Π', '\\Pi'], ['α', '\\alpha'], ['δ', '\\delta'],
  ['θ', '\\theta'], ['κ', '\\kappa'], ['λ', '\\lambda'], ['ν', '\\nu'],
  ['ξ', '\\xi'], ['ρ', '\\rho'], ['σ', '\\sigma'], ['τ', '\\tau'],
  ['ϕ', 'varphi'], ['ϵ', 'varepsilon'], ['˜', 'small tilde'],
  ['→', '\\rightarrow'], ['∂', '\\partial'], ['∈', '\\in'], ['∑', '\\sum'],
  ['−', 'minus'], ['∗', '\\ast'], ['∝', '\\propto'], ['∫', '\\int'],
  ['≡', '\\equiv'], ['≤', '\\leq'], ['≥', '\\geq'],
  ['⏐', 'vertical line extension'], ['+', 'plus sign'], ['<', 'less-than sign'],
  ['=', 'equals sign'], ['>', 'greater-than sign'], ['|', 'vertical line'], ['/', 'solidus'],
] as const;

const PRODUCTION_VIEWER_READY_TIMEOUT_MS = 15_000;
const PRODUCTION_SAVE_TIMEOUT_MS = 15_000;
const REFERENCE_READY_TIMEOUT_MS = 15_000;

async function currentPageText(page: Page): Promise<string> {
  const input = page.getByRole('textbox', { name: /^Current page \d+ of \d+/u });
  const label = await input.getAttribute('aria-label');
  const total = label?.match(/ of (\d+)/u)?.[1];
  if (!total) throw new Error('Current page total is unavailable.');
  return `${await input.inputValue()} / ${total}`;
}

// Native non-overlay scrollbars need more than the 12px minimum runway.
async function expectedWorkspaceInset(page: Page): Promise<number> {
  return page.locator('.review-document .pdf-workspace__viewport').evaluate((viewport: HTMLElement) => (
    Math.max(12, viewport.offsetWidth - viewport.clientWidth, viewport.offsetHeight - viewport.clientHeight)
  ));
}

async function currentZoomText(page: Page): Promise<string> {
  const input = page.getByRole('textbox', { name: /^Current zoom \d+ percent/u });
  return `${await input.inputValue()}%`;
}

async function zoomInOnce(page: Page): Promise<void> {
  await page.locator('[data-review-stage]').evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
  });
  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await page.getByRole('button', { name: 'Open zoom controls' }).click();
  const menu = page.getByRole('menu', { name: 'PDF zoom' });
  const previousZoom = Number.parseInt(await currentZoomText(page), 10);
  await menu.getByRole('menuitem', { name: 'Zoom in' }).click();
  await page.keyboard.press('Escape');
  await page.locator('[data-review-stage]').evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
  });
  await expect.poll(async () => {
    const first = Number.parseInt(await currentZoomText(page), 10);
    await page.waitForTimeout(150);
    const second = Number.parseInt(await currentZoomText(page), 10);
    return first === second && second > previousZoom;
  }).toBe(true);
}

async function installSelectionCaptureGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let holding = true;
    const releases = new Set<() => void>();
    const captureGate = {
      wait() {
        if (!holding) return Promise.resolve();
        return new Promise<void>((resolve) => releases.add(resolve));
      },
      isWaiting() {
        return releases.size > 0;
      },
    };
    const testState = globalThis as unknown as {
      __placekeeperSelectionCaptureTestGate: typeof captureGate;
      __releasePdfSelectionCapture(): void;
    };
    testState.__placekeeperSelectionCaptureTestGate = captureGate;
    testState.__releasePdfSelectionCapture = () => {
      holding = false;
      for (const release of releases) release();
      releases.clear();
    };
  });
}

async function waitForSelectionCapture(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const captureGate = globalThis.__placekeeperSelectionCaptureTestGate as
      | (NonNullable<typeof globalThis.__placekeeperSelectionCaptureTestGate> & {
        isWaiting(): boolean;
      })
      | undefined;
    return captureGate?.isWaiting() === true;
  });
}

async function releaseSelectionCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __releasePdfSelectionCapture(): void })
      .__releasePdfSelectionCapture();
  });
}

async function dragPdfPointer(
  page: Page,
  pdfPage: ReturnType<Page["locator"]>,
  start: { x: number; y: number },
  end: { x: number; y: number },
  whileDragging?: () => Promise<void>,
  moveOptions?: { steps?: number },
): Promise<void> {
  const box = await pdfPage.boundingBox();
  if (!box) throw new Error("Rendered PDF page has no bounds.");
  const scale = box.width / 612;
  await page.mouse.move(box.x + start.x * scale, box.y + start.y * scale);
  await page.mouse.down();
  await page.mouse.move(box.x + end.x * scale, box.y + end.y * scale, moveOptions);
  await whileDragging?.();
  await page.mouse.up();
}

async function waitForRenderedPageImage(
  pdfPage: ReturnType<Page["locator"]>,
): Promise<ReturnType<Page["locator"]>> {
  const image = pdfPage.locator(":scope > img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (
    element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
  ))).toBe(true);
  return image;
}

const platformCopyShortcut = process.platform === "darwin" ? "Meta+C" : "Control+C";
const platformPasteShortcut = process.platform === "darwin" ? "Meta+V" : "Control+V";
const platformFindShortcut = process.platform === "darwin" ? "Meta+F" : "Control+F";

async function installPlainTextPasteTarget(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    const target = document.createElement("textarea");
    target.setAttribute("aria-label", "Native copy paste proof");
    target.style.position = "fixed";
    target.style.inset = "auto 8px 8px auto";
    target.style.width = "240px";
    target.style.height = "64px";
    target.style.zIndex = "2147483647";
    document.body.append(target);
  });
  return page.getByRole("textbox", { name: "Native copy paste proof" });
}

async function pasteNativeClipboard(page: Page, target: Locator): Promise<string> {
  await target.focus();
  await page.keyboard.press(platformPasteShortcut);
  return target.inputValue();
}

async function dispatchClipboardCopy(target: Locator): Promise<{
  readonly defaultPrevented: boolean;
  readonly text: string;
}> {
  return target.evaluate((element) => {
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData,
    });
    element.dispatchEvent(event);
    return {
      defaultPrevented: event.defaultPrevented,
      text: clipboardData.getData('text/plain').replace(/\r\n?/gu, '\n'),
    };
  });
}

async function armContextMenuDefaultProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    delete document.documentElement.dataset.pdfContextMenuDefaultPrevented;
    document.addEventListener('contextmenu', (event) => {
      document.documentElement.dataset.pdfContextMenuDefaultPrevented = String(
        event.defaultPrevented,
      );
    }, { once: true });
  });
}

async function showPdfSelectionPage(
  workspace: Locator,
  pageIndex: number,
  lineY: number,
): Promise<{ box: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>; scale: number }> {
  const pdfPage = workspace.locator(`[data-page-index="${pageIndex}"]`);
  await pdfPage.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await waitForRenderedPageImage(pdfPage);
  await expect.poll(async () => {
    await pdfPage.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    const [workspaceBox, pageBox] = await Promise.all([
      workspace.boundingBox(),
      pdfPage.boundingBox(),
    ]);
    if (!workspaceBox || !pageBox) return false;
    const selectableLineY = pageBox.y + lineY * (pageBox.width / 612);
    return selectableLineY >= Math.max(0, workspaceBox.y)
      && selectableLineY <= workspaceBox.y + workspaceBox.height;
  }).toBe(true);
  const box = await pdfPage.boundingBox();
  if (!box) throw new Error(`Rendered PDF page ${pageIndex + 1} has no bounds.`);
  return { box, scale: box.width / 612 };
}

async function dragAcrossProductionPdfPages(
  page: Page,
  workspace: Locator,
  startPageIndex: number,
  endPageIndex: number,
  line: { y: number; startX?: number; endX?: number } = { y: 102 },
  whileSelecting?: () => Promise<void>,
): Promise<void> {
  const forward = startPageIndex < endPageIndex;
  const indexes = Array.from(
    { length: Math.abs(endPageIndex - startPageIndex) + 1 },
    (_, offset) => startPageIndex + (forward ? offset : -offset),
  );
  const start = await showPdfSelectionPage(workspace, startPageIndex, line.y);
  const startX = forward ? (line.startX ?? 70) : (line.endX ?? 390);
  await page.mouse.move(
    start.box.x + startX * start.scale,
    start.box.y + line.y * start.scale,
  );
  await page.mouse.down();
  await page.mouse.move(
    start.box.x + (startX + (forward ? 12 : -12)) * start.scale,
    start.box.y + line.y * start.scale,
    { steps: 3 },
  );
  for (const pageIndex of indexes.slice(1)) {
    const current = await showPdfSelectionPage(workspace, pageIndex, line.y);
    await page.mouse.move(
      current.box.x + (forward ? (line.endX ?? 390) : (line.startX ?? 70)) * current.scale,
      current.box.y + line.y * current.scale,
      { steps: 8 },
    );
  }
  if (indexes.length === 1) {
    await page.mouse.move(
      start.box.x + (forward ? (line.endX ?? 390) : (line.startX ?? 70)) * start.scale,
      start.box.y + line.y * start.scale,
      { steps: 8 },
    );
  }
  await whileSelecting?.();
  await page.mouse.up();
  await expect(workspace.locator(':scope [data-page-index] > div[style*="mix-blend-mode"]'))
    .not.toHaveCount(0);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function openLinkInReferences(
  page: Page,
  link: ReturnType<Page["locator"]>,
): Promise<void> {
  const action = page.getByRole("menuitem", { name: /Open in References/u });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await link.evaluate((element) => element.focus({ preventScroll: true }));
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    try {
      await expect(action).toBeFocused({ timeout: 1_500 });
      await page.keyboard.press("Enter");
      return;
    } catch {
      // The portaled link can settle between focus and activation; retry once.
    }
  }
  await expect(action).toBeFocused();
  await page.keyboard.press("Enter");
}

async function expectReferenceReady(
  page: Page,
  tab: ReturnType<Page["locator"]>,
): Promise<void> {
  const retry = page.getByRole("button", { name: "Retry reference" });
  await expect.poll(async () => (
    await retry.isVisible()
    || (await tab.count() > 0 && await tab.getAttribute('aria-busy') !== 'true')
  ), {
    timeout: REFERENCE_READY_TIMEOUT_MS,
  }).toBe(true);
  if (await retry.isVisible()) await retry.click();
  await expect(tab).toHaveAttribute("aria-selected", "true", {
    timeout: REFERENCE_READY_TIMEOUT_MS,
  });
  await expect(page.locator('[data-reference-pending="loading"]')).toHaveCount(0, {
    timeout: REFERENCE_READY_TIMEOUT_MS,
  });
}

async function clickHoverRevealedReferenceTabAction(action: Locator): Promise<void> {
  const tabSegment = action.locator('..');
  await tabSegment.hover();
  await expect(action).toHaveCSS('opacity', '1');
  await expect(action).toHaveCSS('pointer-events', 'auto');
  await action.click();
}

async function clickHoverRevealedReferenceDockAction(action: Locator): Promise<void> {
  const activityStrip = action.locator('..');
  await activityStrip.hover();
  await expect(action).toHaveCSS('opacity', '1');
  await expect(action).toHaveCSS('pointer-events', 'auto');
  await action.click();
}

async function followLinkInSameReference(
  page: Page,
  link: ReturnType<Page["locator"]>,
): Promise<void> {
  const menu = page.getByRole("menu", {
    name: "Open Target-to-target detail link, Page 3",
  });
  const firstAction = menu.getByRole("menuitem", { name: /Open in References/u });
  const action = menu.getByRole("menuitem", { name: "Follow in this tab" });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await link.evaluate((element) => element.focus({ preventScroll: true }));
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    try {
      await expect(firstAction).toBeFocused({ timeout: 1_500 });
      await expect(menu.getByRole("menuitem")).toHaveCount(4);
      await expect(action).toHaveAttribute("title", "Follow in this tab");
      await expect(action).toHaveText("");
      await page.keyboard.press("ArrowDown");
      await expect(action).toBeFocused({ timeout: 1_500 });
      await page.keyboard.press("Enter");
      return;
    } catch {
      // The portaled link can settle between focus and activation; retry once.
    }
  }
  await expect(firstAction).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(action).toBeFocused();
  await page.keyboard.press("Enter");
}

function pageCoordinate(position: unknown, axis: "x" | "y"): number {
  if (typeof position !== "object" || position === null || Array.isArray(position)) {
    throw new Error("Page Note position is unavailable.");
  }
  const value = (position as Record<string, unknown>)[axis];
  if (typeof value !== "number") throw new Error(`Page-relative ${axis} coordinate is unavailable.`);
  return value;
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /Cannot update|while rendering|Maximum update depth|React/u.test(message.text())
    ) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function freshProductionPdf(pdfPath: string): Promise<string> {
  const freshDirectory = join(root, randomUUID());
  await mkdir(freshDirectory);
  const freshPdfPath = join(freshDirectory, basename(pdfPath));
  await copyFile(pdfPath, freshPdfPath);
  return freshPdfPath;
}

async function openFreshProductionFixture(
  page: Page,
  pdfPath: string,
  failureMessage: string,
  beforeNavigate?: (sessionId: string) => Promise<void>,
): Promise<{ sessionId: string; url: string }> {
  const startupErrors: string[] = [];
  page.on("pageerror", (error) => startupErrors.push(error.message));
  const freshPdfPath = await freshProductionPdf(pdfPath);
  const launched = await host.open({ pdfPath: freshPdfPath, sourceRootPath: sourceRoot, fork: true });
  if (!launched.ok) {
    throw new Error(`${failureMessage}: ${launched.error.kind}: ${launched.error.message}`);
  }
  if (launched.kind === "recovery-offered") {
    throw new Error(`${failureMessage}: recovery was offered unexpectedly`);
  }
  await beforeNavigate?.(launched.sessionId);
  await page.goto(launched.url);
  try {
    await expect(page.locator("[data-production-review]")).toBeVisible();
    await expect(page.locator("[data-production-review]")).toHaveAttribute("data-initial-view-ready", "true");
    await expect(page.locator(".pdf-workspace:not(.pdf-workspace--reference) [data-page-index='0']"))
      .toBeVisible({ timeout: PRODUCTION_VIEWER_READY_TIMEOUT_MS });
  } catch (error) {
    throw new Error(`${failureMessage}: ${startupErrors.join("; ") || "production viewer did not become ready"}`, {
      cause: error,
    });
  }
  return { sessionId: launched.sessionId, url: launched.url };
}

async function chooseFreshCopyDestination(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Open automatic save options$/u }).click();
  const dialog = page.getByRole("dialog", { name: "Choose Where to Save Annotations" });
  const filename = `acceptance-annotations-${randomUUID()}.pdf`;
  const initialChoice = dialog.getByRole("radio", { name: "Modify the original PDF" });
  await expect(initialChoice).toBeEnabled();
  await expect(initialChoice).toBeFocused();
  const name = dialog.getByRole("textbox", { name: "Copy name" });
  await expect(name).toBeEnabled();
  await expect(name).not.toHaveValue("");
  await name.fill(filename);
  await expect(name).toHaveValue(filename);
  await dialog.getByRole("button", { name: "Confirm" }).click();
  try {
    await expect(dialog).toHaveCount(0, { timeout: PRODUCTION_SAVE_TIMEOUT_MS });
  } catch (error) {
    const message = (await dialog.getByRole("alert").allTextContents()).join(" ");
    throw new Error(`Copy destination ${filename} was not established: ${message ?? "no error was shown"}`, {
      cause: error,
    });
  }
}

async function openAnnotationsWorkspace(page: Page) {
  const workspace = await currentWorkspaceRail(page);
  if (await workspace.getAttribute("aria-expanded") !== "true") await workspace.click();
  await expect(workspace).toHaveAttribute("aria-expanded", "true");
  const annotations = page.getByRole("tab", { name: "Annotations", exact: true });
  await expect(annotations).toBeVisible();
  if (await annotations.getAttribute("aria-selected") !== "true") await annotations.click();
  await expect(annotations).toHaveAttribute("aria-selected", "true");
  return { annotations, workspace };
}

async function currentWorkspaceRail(page: Page) {
  return page.getByRole('button', { name: /^(?:Show|Hide) workspace$/u });
}

async function toggleWorkspace(page: Page) {
  const rail = await currentWorkspaceRail(page);
  await rail.click();
  return rail;
}

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "placekeeper-production-"));
  sourceRoot = join(root, "source");
  await mkdir(sourceRoot);
  pdf = join(root, "paper.pdf");
  plainTextPdf = join(root, "plain-text.pdf");
  multiPagePdf = join(root, "multi-page.pdf");
  rotatedPdf = join(root, "rotated.pdf");
  referencePdf = join(root, "reference-navigation.pdf");
  annotatedReferencePdf = join(root, "reference-navigation-annotated.pdf");
  searchPdf = join(root, "pdf-search.pdf");
  equationPdf = join(root, "equation-selection.pdf");
  crossPagePdf = join(root, "cross-page-selection.pdf");
  metadataTitlePdf = join(root, "fallback-filename.pdf");
  await copyFile(resolve("test/fixtures/pdfs/text-native-with-annotations.pdf"), pdf);
  await copyFile(resolve("test/fixtures/pdfs/text-native.pdf"), plainTextPdf);
  await copyFile(resolve("test/fixtures/pdfs/mixed-text-image.pdf"), multiPagePdf);
  await copyFile(resolve("test/fixtures/pdfs/rotation-90-crop.pdf"), rotatedPdf);
  await copyFile(resolve("test/fixtures/pdfs/reference-navigation.pdf"), referencePdf);
  await copyFile(
    resolve("test/fixtures/pdfs/reference-navigation-annotated.pdf"),
    annotatedReferencePdf,
  );
  await copyFile(resolve("test/fixtures/pdfs/pdf-search.pdf"), searchPdf);
  await copyFile(resolve("test/fixtures/pdfs/equation-selection.pdf"), equationPdf);
  await copyFile(resolve("test/fixtures/pdfs/cross-page-selection.pdf"), crossPagePdf);
  const titledDocument = await PDFDocument.create();
  titledDocument.setTitle("Identification Strategy");
  titledDocument.addPage([612, 792]);
  await writeFile(metadataTitlePdf, await titledDocument.save());
  await copyFile(resolve("test/fixtures/latex/paper.tex"), join(sourceRoot, "paper.tex"));
});

test.beforeEach(async () => {
  host = await PlacekeeperHost.start({
    recoveryRoot: join(root, `recovery-${randomUUID()}`),
    webAssets: { root: resolve("dist/web") },
  });
});

test.afterEach(async ({ page }) => {
  // The context owns connections that can outlive its page.
  await page.context().close();
  await host.close();
});

test.afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test('imports standard annotations into the editable tray and saves comment edits and deletion', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { sessionId } = await openFreshProductionFixture(page, pdf, 'Standard annotation import failed');
  const imported = host.broker.state(sessionId)!.items;
  expect(imported).toHaveLength(2);
  expect(imported.every(({ kind }) => kind === 'pdfAnnotation')).toBe(true);
  const item = imported.find(({ payload }) => payload.subtype === 'highlight')!;
  await openAnnotationsWorkspace(page);
  await expect(page.locator('[data-existing-annotation]')).toHaveCount(0);
  await expect(page.getByText('From the PDF', { exact: true })).toHaveCount(0);
  const row = page.locator(`[data-review-item="${item.id}"]`);
  await row.hover();
  await row.getByRole('button', { name: 'Edit Highlight annotation on page 1' }).click();
  const composer = page.getByRole('region', { name: 'Edit Comment' });
  await expect(composer).toBeVisible();
  await composer.getByRole('textbox').fill('An imported comment edited in Placekeeper.');
  await composer.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => host.broker.state(sessionId)?.items.find(({ id }) => id === item.id)?.payload.comment)
    .toBe('An imported comment edited in Placekeeper.');
  await row.hover();
  await row.getByRole('button', { name: 'Remove Highlight annotation on page 1' }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('[data-existing-annotation]')).toHaveCount(0);
  await expect.poll(() => host.broker.state(sessionId)?.items.length).toBe(1);
  await expect.poll(() => host.broker.saveStatus(sessionId)?.sync.phase).toBe('clean');
  const destination = host.broker.saveStatus(sessionId)?.destination;
  if (destination?.phase !== 'active') throw new Error('Imported annotations have no save destination.');
  expect((await readEditableReviewItems(new Uint8Array(await readFile(destination.targetPath)))).map(({ id }) => id))
    .toEqual([imported.find(({ id }) => id !== item.id)!.id]);
});

test("uses PDF metadata for the tab title and the filename when metadata is absent", async ({ page }) => {
  await openFreshProductionFixture(page, metadataTitlePdf, "Metadata-title launch failed");
  await expect(page).toHaveTitle("Identification Strategy");

  await openFreshProductionFixture(page, plainTextPdf, "Filename-title launch failed");
  await expect(page).toHaveTitle("plain-text.pdf");
});

test('records links opened from References in Main document history', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, 'Reference link history launch failed');
  const main = page.locator('.pdf-workspace:not(.pdf-workspace--reference)');
  await openLinkInReferences(page, main.getByRole('button', {
    name: 'Open PDF link to Primary result, Page 2',
  }));
  await expectReferenceReady(page, page.getByRole('tab', { name: /Primary result/u }));
  const link = page.locator('[data-reference-pdf-viewport]').getByRole('button', {
    name: 'Open PDF link to Target-to-target detail link, Page 3',
  });
  await link.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await link.click();
  await page.getByRole('menuitem', { name: 'Open in main document', exact: true }).click();
  await expect.poll(() => currentPageText(page)).toBe('3 / 4');
  const back = page.getByRole('button', { name: 'Back in document history' });
  await expect(back).toBeVisible();
  await expect(back).toBeEnabled();
  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await back.click();
  await expect.poll(() => currentPageText(page)).toBe('1 / 4');
  const forward = page.getByRole('button', { name: 'Forward in document history' });
  await expect(forward).toBeEnabled();
  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await forward.click();
  await expect.poll(() => currentPageText(page)).toBe('3 / 4');
});

test('keeps toolbar icons visible throughout document-history navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, 'Toolbar icon continuity launch failed');
  await page.getByRole('button', {
    name: 'Open PDF link to Primary result, Page 2',
  }).click();
  await page.getByRole('menuitem', { name: 'Open in main document' }).click();
  await expect.poll(() => currentPageText(page)).toBe('2 / 4');
  const back = page.getByRole('button', { name: 'Back in document history' });
  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await back.hover();
  const expectedHistoryBackground = await back.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--pk-hover)';
    document.body.append(probe);
    const background = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return background;
  });
  await expect.poll(() => back.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).toBe(expectedHistoryBackground);
  await page.evaluate((expectedBackground) => {
    const stableIconSelector = [
      '[data-review-chrome] > .review-chrome__identity .review-icon',
      '[data-review-chrome] > .review-chrome__viewer-controls .review-icon:not(.review-chrome__main-history-control .review-icon)',
    ].join(', ');
    const stableIcons = [...document.querySelectorAll<SVGElement>(stableIconSelector)];
    const navigation = document.querySelector<HTMLElement>('.review-chrome__navigation-cluster');
    const initialHistoryControl = document.querySelector<HTMLElement>(
      '[data-review-chrome] > .review-chrome__left-controls [data-main-history="back"]',
    );
    if (!navigation || !initialHistoryControl || stableIcons.length === 0) {
      throw new Error('Toolbar continuity probe could not find its controls.');
    }
    const baselineNavigationWidth = navigation.getBoundingClientRect().width;
    const audit = {
      finished: false,
      baselineNavigationWidth,
      expectedBackground,
      samples: [] as Array<{
        stableIconsPainted: boolean;
        navigationWidth: number;
        historyControlCount: number;
        historyControlsPainted: boolean;
        historyDirection: string | null;
        historyBackground: string | null;
        historyHovered: boolean;
        initialControlRetained: boolean;
      }>,
    };
    (window as typeof window & { __toolbarIconAudit?: typeof audit }).__toolbarIconAudit = audit;
    let frames = 0;
    const inspect = () => {
      const historyControls = [...document.querySelectorAll<HTMLElement>(
        '[data-review-chrome] > .review-chrome__left-controls [data-main-history]',
      )];
      const painted = (node: Element) => {
        const bounds = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return node.isConnected
          && bounds.width > 0
          && bounds.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0';
      };
      audit.samples.push({
        stableIconsPainted: stableIcons.every(painted),
        navigationWidth: navigation.getBoundingClientRect().width,
        historyControlCount: historyControls.length,
        historyControlsPainted: historyControls.every(painted),
        historyDirection: historyControls[0]?.dataset.mainHistory ?? null,
        historyBackground: historyControls[0]
          ? getComputedStyle(historyControls[0]).backgroundColor
          : null,
        historyHovered: historyControls[0]?.matches(':hover') ?? false,
        initialControlRetained: historyControls[0] === initialHistoryControl,
      });
      if (++frames < 60) requestAnimationFrame(inspect);
      else audit.finished = true;
    };
    requestAnimationFrame(inspect);
  }, expectedHistoryBackground);
  await back.click();
  await expect.poll(() => currentPageText(page)).toBe('1 / 4');
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __toolbarIconAudit?: { finished: boolean } }
  ).__toolbarIconAudit?.finished)).toBe(true);
  const audit = await page.evaluate(() => (
    window as typeof window & {
      __toolbarIconAudit?: {
        baselineNavigationWidth: number;
        expectedBackground: string;
        samples: Array<{
          stableIconsPainted: boolean;
          navigationWidth: number;
          historyControlCount: number;
          historyControlsPainted: boolean;
          historyDirection: string | null;
          historyBackground: string | null;
          historyHovered: boolean;
          initialControlRetained: boolean;
        }>;
      };
    }
  ).__toolbarIconAudit);
  expect(audit).toBeDefined();
  expect(audit!.samples).toHaveLength(60);
  expect(audit!.samples.every((sample) => sample.stableIconsPainted)).toBe(true);
  expect(audit!.samples.every((sample) => sample.historyControlCount > 0)).toBe(true);
  expect(audit!.samples.every((sample) => sample.historyControlsPainted)).toBe(true);
  expect(audit!.samples.every(
    (sample) => sample.navigationWidth >= audit!.baselineNavigationWidth,
  )).toBe(true);
  expect(audit!.samples.every((sample) => sample.historyHovered)).toBe(true);
  expect(audit!.samples.every(
    (sample) => sample.historyBackground === audit!.expectedBackground,
  )).toBe(true);
  expect(audit!.samples.some((sample) => sample.historyDirection === 'forward')).toBe(true);
  expect(audit!.samples.every((sample) => sample.initialControlRetained)).toBe(true);
  await expect(page.getByRole('button', { name: 'Forward in document history' })).toBeEnabled();
});

test("keeps mounted Codex context through fresh-page re-entry, then fails closed on a hung scope poll", async ({ page }) => {
  const clientNow = Date.now();
  const taskBindings = new TaskBindingRegistry({
    now: () => new Date(clientNow),
    pendingTtlMs: 1_000,
    activeLeaseTtlMs: 2_000,
  });
  const clockedHost = await PlacekeeperHost.start({
    recoveryRoot: join(root, "clocked-codex-recovery"),
    webAssets: { root: resolve("dist/web") },
    taskBindings,
  });
  try {
    const launched = await clockedHost.open({
      pdfPath: referencePdf,
      sourceRootPath: sourceRoot,
      surface: "codex",
      fork: true,
    });
    if (!launched.ok || launched.kind === "recovery-offered" || launched.bindProof === undefined) {
      throw new Error("Expected bindable Codex production launch");
    }
    const url = new URL(launched.url);
    const capability = new URLSearchParams(url.hash.slice(1)).get("cap")!;
    expect(taskBindings.claim({
      bindProof: launched.bindProof,
      taskSessionId: "mounted-clock-task",
      reviewSessionId: launched.sessionId,
      documentGeneration: launched.documentGeneration,
    })).toMatchObject({ status: "pending" });
    expect(taskBindings.activateBrowser({
      reviewSessionId: launched.sessionId,
      documentGeneration: launched.documentGeneration,
      browserCapability: capability,
    })).toMatchObject({ status: "active" });
    expect((await clockedHost.context.refresh({ taskSessionId: "mounted-clock-task" })).status)
      .toBe("current");

    await page.clock.install({ time: clientNow });
    // The host clock is fixed too; slow browser setup must not expire its lease.
    await page.clock.setFixedTime(clientNow);
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const testWindow = window as typeof window & { __placekeeperHangScopePoll?: boolean };
        if (
          new URL(requestUrl, window.location.href).pathname.endsWith("/scope") &&
          testWindow.__placekeeperHangScopePoll === true
        ) {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Scope request aborted", "AbortError"));
            }, { once: true });
          });
        }
        return nativeFetch(input, init);
      };
    });
    await page.goto(launched.url);
    const status = page.locator("[data-codex-context]");
    await expect(status).toHaveAttribute("data-codex-context", "current");
    await expect(status).toHaveAttribute("aria-label", /Agent context current at review revision \d+/);
    await expect(status.locator(".lucide-bot")).toBeVisible();
    expect((await status.boundingBox())?.width).toBe(32);
    await status.hover();
    await expect(status.locator("[role='tooltip']")).toBeVisible();
    await expect(status.locator("[role='tooltip']")).toContainText("PDF content and annotations are synced with the connected agent");

    const readableUrl = new URL(page.url());
    const pageThreeUrl = `${readableUrl.origin}${readableUrl.pathname}#v=1&page=3`;
    await page.goto("about:blank");
    await page.goto(pageThreeUrl);
    await expect(page).toHaveURL(pageThreeUrl);
    await expect.poll(() => currentPageText(page)).toBe("3 / 4");
    await expect(page.locator("[data-codex-context]")).toHaveAttribute(
      "data-codex-context",
      "current",
    );
    await page.evaluate(() => {
      const testWindow = window as typeof window & { __placekeeperHangScopePoll?: boolean };
      testWindow.__placekeeperHangScopePoll = true;
    });

    await page.clock.setFixedTime(clientNow + 2_100);
    await page.clock.fastForward(2_100);
    await expect(status).toHaveAttribute("data-codex-context", "connecting");
    await expect(status.locator(".lucide-bot")).toBeVisible();
    await expect(status.locator("[role='tooltip']")).toContainText("Agent context updating");

    await page.clock.setFixedTime(clientNow + 5_600);
    await page.clock.fastForward(3_500);
    await expect(status).toHaveAttribute("data-codex-context", "unavailable");
    await expect(status.locator(".lucide-bot")).toBeVisible();
    await expect(status.locator("[role='tooltip']")).toContainText("Reopen this PDF from your agent");
  } finally {
    await clockedHost.close();
  }
});

test('keeps a distant search destination stationary from its first visible frame', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const pdfDocument = await PDFDocument.load(await readFile(searchPdf));
  for (let index = 0; index < 16; index += 1) pdfDocument.insertPage(1, [612, 792]);
  pdfDocument.addPage([1000, 792]);
  const distantSearchPdf = join(root, 'distant-search.pdf');
  await writeFile(distantSearchPdf, await pdfDocument.save());
  await openFreshProductionFixture(page, distantSearchPdf, 'Distant search launch failed');
  const main = page.locator('.pdf-workspace:not(.pdf-workspace--reference)');
  await main.locator('[data-page-index="0"]').focus();
  await page.keyboard.press(platformFindShortcut);
  const zoom = page.getByRole('textbox', { name: /Current zoom \d+ percent/u });
  await zoom.fill('100');
  await zoom.press('Enter');
  const readingBounds = await page.locator('.review-document').boundingBox();
  if (!readingBounds) throw new Error('Reading viewport unavailable');
  const fittedPercent = Math.floor((readingBounds.width - 48) / pdfDocument.getPage(0).getWidth() * 100);
  await zoom.fill(String(fittedPercent));
  await zoom.press('Enter');
  await expect(zoom).toHaveValue(String(fittedPercent));
  await page.getByRole('searchbox', { name: 'Search this PDF' }).fill('stable');
  const results = page.locator('#workspace-panel-search [data-search-group="exact"] .annotation-item__navigation');
  await expect(results).toHaveCount(2);
  await results.nth(1).click();
  await expect(page.getByRole('textbox', { name: /^Current page/ })).toHaveValue('18');
  await expect(main.locator('[data-page-index="0"]')).toHaveCount(0);
  await page.evaluate(() => {
    const state = { running: true, positions: [] as { x: number; y: number }[] };
    (window as unknown as { distantJumpFrames: typeof state }).distantJumpFrames = state;
    const sample = () => {
      if (!state.running) return;
      const main = document.querySelector('.pdf-workspace:not(.pdf-workspace--reference)');
      const viewport = main?.querySelector('[data-viewer-framing-viewport]')?.getBoundingClientRect();
      const bounds = main?.querySelector('[data-page-index="0"]')?.getBoundingClientRect();
      if (viewport && bounds && bounds.top < viewport.bottom && bounds.bottom > viewport.top) {
        state.positions.push({ x: bounds.x, y: bounds.y });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  let positions: { x: number; y: number }[] = [];
  try {
    await results.first().click();
    await expect(page.getByRole('textbox', { name: /^Current page/ })).toHaveValue('1');
    await expect.poll(() => page.evaluate(() => (
      (window as unknown as { distantJumpFrames: { positions: unknown[] } }).distantJumpFrames.positions.length
    ))).toBeGreaterThan(8);
  } finally {
    positions = await page.evaluate(() => {
      const state = (window as unknown as { distantJumpFrames: { running: boolean; positions: { x: number; y: number }[] } }).distantJumpFrames;
      state.running = false;
      return state.positions;
    });
  }
  for (const axis of ['x', 'y'] as const) {
    expect(Math.max(...positions.map((position) => position[axis]))
      - Math.min(...positions.map((position) => position[axis]))).toBeLessThan(2);
  }
});

for (const viewportWidth of [1280, 760]) {
  test(`keeps fitted pages visible across search, page controls, annotations, and history at width ${viewportWidth}`, async ({ page }) => {
    await page.setViewportSize({ width: viewportWidth, height: 900 });
    // A wider page leaves horizontal scroll range even while a narrow page fits.
    const mixedWidthDocument = await PDFDocument.load(await readFile(searchPdf));
    mixedWidthDocument.addPage([1000, 792]);
    const mixedWidthPdf = join(root, 'mixed-width-search.pdf');
    await writeFile(mixedWidthPdf, await mixedWidthDocument.save());
    await openFreshProductionFixture(page, mixedWidthPdf, 'Search fit-width launch failed', async (sessionId) => {
      const state = host.broker.state(sessionId)!;
      await host.broker.acceptMutation(sessionId, addPageNote(
        state, 1, { x: 570, y: 160, width: 18, height: 18 }, 'Fitted jump destination.',
      ));
    });
    await page.locator('[data-review-stage]').evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
    });
    const main = page.locator('.pdf-workspace:not(.pdf-workspace--reference)');
    await main.locator('[data-page-index="0"]').focus();
    await page.keyboard.press(platformFindShortcut);
    await expect(page.getByRole('searchbox', { name: 'Search this PDF' })).toBeVisible();
    // Opening Search can start a fit-width transition; enter the manual test
    // scale only after that existing transition has reached its final frame.
    await page.locator('[data-review-stage]').evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
    });
    const results = page.locator('#workspace-panel-search [data-search-group="exact"] .annotation-item__navigation');
    const zoom = page.getByRole('textbox', { name: /Current zoom \d+ percent/u });
    await zoom.fill('100');
    await zoom.press('Enter');
    await expect(zoom).toHaveValue('100');
    const rightFade = page.locator('.review-overlay-frame__right-fade:visible');
    const zoomTrigger = page.getByRole('button', { name: 'Open zoom controls' });
    await zoomTrigger.focus();
    if (await zoomTrigger.getAttribute('aria-expanded') === 'true') await zoomTrigger.press('Escape');
    await expect(zoomTrigger).toHaveAttribute('aria-expanded', 'false');
    await zoomTrigger.press('Enter');
    await page.getByRole('menuitem', { name: 'Fit width', exact: true }).click();
    await page.keyboard.press('Escape');
    // Use the app's settled fit geometry, then preserve that scale as manual zoom.
    await expect.poll(() => zoom.inputValue()).not.toBe('100');
    const fittedPercent = await zoom.inputValue();
    await zoom.fill(fittedPercent);
    await zoom.press('Enter');
    await expect(zoom).toHaveValue(fittedPercent);
    const fittedZoom = await zoom.inputValue();
    await page.getByRole('searchbox', { name: 'Search this PDF' }).fill('stable');
    await expect(results).toHaveCount(2);
    const expectFittedPage = async (index: number) => {
      await expect(page.getByRole('textbox', { name: new RegExp(`Current page ${index + 1} of`) })).toHaveValue(String(index + 1));
      await expect(zoom).toHaveValue(fittedZoom);
      const pdfPage = main.locator(`[data-page-index="${index}"]`);
      await expect.poll(async () => {
        const viewport = await main.locator('[data-viewer-framing-viewport]').boundingBox();
        const bounds = await pdfPage.boundingBox();
        const fade = await rightFade.count() > 0 ? await rightFade.boundingBox() : null;
        if (!viewport || !bounds) return Number.POSITIVE_INFINITY;
        const right = fade?.x ?? viewport.x + viewport.width;
        return Math.max(viewport.x - bounds.x, bounds.x + bounds.width - right);
      }).toBeLessThan(2);
    };
    await results.first().click();
    await expectFittedPage(0);
    await page.evaluate(() => {
      const state = { running: true, overflow: [] as number[] };
      (window as unknown as { jumpFrames: typeof state }).jumpFrames = state;
      const sample = () => {
        if (!state.running) return;
        const main = document.querySelector('.pdf-workspace:not(.pdf-workspace--reference)');
        const viewport = main?.querySelector('[data-viewer-framing-viewport]')?.getBoundingClientRect();
        const bounds = main?.querySelector('[data-page-index="1"]')?.getBoundingClientRect();
        const fade = Array.from(document.querySelectorAll('.review-overlay-frame__right-fade'))
          .find((element) => element.getBoundingClientRect().width > 0)?.getBoundingClientRect();
        if (viewport && bounds && bounds.top < viewport.bottom && bounds.bottom > viewport.top) {
          state.overflow.push(Math.max(viewport.left - bounds.left, bounds.right - (fade?.left ?? viewport.right)));
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await results.nth(1).click();
    await expectFittedPage(1);
    const paintedOverflow = await page.evaluate(() => {
      const state = (window as unknown as { jumpFrames: { running: boolean; overflow: number[] } }).jumpFrames;
      state.running = false;
      return state.overflow;
    });
    expect(paintedOverflow.length).toBeGreaterThan(0);
    expect(Math.max(...paintedOverflow)).toBeLessThan(2);
    const pageTrigger = page.getByRole('button', { name: /Open page navigation/ });
    await pageTrigger.click();
    await page.getByRole('menuitem', { name: 'Previous page', exact: true }).click();
    await expectFittedPage(0);
    await expect(page.getByRole('menu', { name: 'Page navigation' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Next page', exact: true }).click();
    await expectFittedPage(1);
    await page.keyboard.press('Escape');
    const pageInput = page.getByRole('textbox', { name: /^Current page/ });
    await pageInput.click();
    await expect(pageInput).toBeFocused();
    await pageInput.fill('1');
    await expect(pageInput).toHaveValue('1');
    await pageInput.press('Enter');
    await expectFittedPage(0);
    await openAnnotationsWorkspace(page);
    await page.locator('#workspace-panel-annotations').getByRole('button', {
      name: /^Page Note · Page 2 · .*Fitted jump destination\.$/u,
    }).first().click();
    await expectFittedPage(1);
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    await page.getByRole('button', { name: 'Back in document history', exact: true }).click();
    await expectFittedPage(0);
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    await page.getByRole('button', { name: 'Forward in document history', exact: true }).click();
    await expectFittedPage(1);
  });
}

test("searches extracted PDF text with variants, history, references, and retained responsive state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors = collectBrowserErrors(page);
  await openFreshProductionFixture(page, searchPdf, "PDF search launch failed");
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  const firstPage = mainWorkspace.locator("[data-page-index='0']");
  await expect(firstPage).toBeVisible();
  await firstPage.focus();

  // Leave the native macOS fullscreen shortcut available to the host.
  await page.keyboard.press('Control+Meta+f');
  await expect(page.getByRole('searchbox', { name: 'Search this PDF' })).toHaveCount(0);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
  const query = page.getByRole("searchbox", { name: "Search this PDF" });
  await expect(page.getByRole("tab", { name: "Search", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: "Hide workspace" })).toBeVisible();
  await query.click();
  await expect(query).toBeFocused();
  await expect.poll(() => query.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe("rgba(0, 0, 0, 0)");
  await firstPage.focus();
  await expect.poll(() => query.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe("rgba(0, 0, 0, 0)");
  await query.focus();
  await query.fill("stable");

  const searchPanel = page.locator("#workspace-panel-search");
  await expect(searchPanel).toBeVisible();
  await expect(searchPanel.locator(".pdf-search")).toHaveAttribute("data-pdf-search-state", "partial");
  await expect(searchPanel).toContainText("2 of 3 pages searchable");
  await expect(searchPanel).not.toContainText("Searched 2 of 3 pages with reliable text.");
  await expect(searchPanel).not.toContainText("Try a symbol name or LaTeX command");
  await expect(searchPanel).not.toContainText("Symbols in this PDF");
  await expect(searchPanel.locator(".pdf-search__search-icon")).toBeVisible();
  const clearSearch = searchPanel.getByRole("button", { name: "Clear search" });
  await expect(clearSearch).toBeVisible();
  const clearSearchGeometry = await clearSearch.evaluate((button) => {
    const input = button.closest('.pdf-search__query');
    const icon = button.querySelector<SVGElement>('.review-icon');
    if (!input) throw new Error('Search input is missing beside its clear action.');
    if (!icon) throw new Error('Search clear action icon is missing.');
    const buttonBounds = button.getBoundingClientRect();
    const inputBounds = input.getBoundingClientRect();
    const iconBounds = icon.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      width: buttonBounds.width,
      height: buttonBounds.height,
      verticalInset: Math.min(
        buttonBounds.top - inputBounds.top,
        inputBounds.bottom - buttonBounds.bottom,
      ),
      centerDelta: Math.abs(
        (buttonBounds.top + buttonBounds.height / 2) - (inputBounds.top + inputBounds.height / 2),
      ),
      iconCenterXOffset:
        (iconBounds.left + iconBounds.width / 2) - (buttonBounds.left + buttonBounds.width / 2),
      iconCenterYOffset:
        (iconBounds.top + iconBounds.height / 2) - (buttonBounds.top + buttonBounds.height / 2),
      rightInset: inputBounds.right - buttonBounds.right,
      minWidth: style.minWidth,
      maxWidth: style.maxWidth,
      minHeight: style.minHeight,
      maxHeight: style.maxHeight,
      borderStyle: style.borderStyle,
      borderRadius: style.borderRadius,
    };
  });
  expect(clearSearchGeometry.width).toBeCloseTo(28, 1);
  expect(clearSearchGeometry.height).toBeCloseTo(28, 1);
  expect(clearSearchGeometry.verticalInset).toBeGreaterThanOrEqual(4);
  expect(clearSearchGeometry.centerDelta).toBeLessThanOrEqual(1);
  expect(clearSearchGeometry.iconCenterXOffset).toBeCloseTo(0, 1);
  expect(clearSearchGeometry.iconCenterYOffset).toBeCloseTo(0, 1);
  expect(clearSearchGeometry.rightInset).toBeCloseTo(4, 1);
  expect(clearSearchGeometry).toMatchObject({
    minWidth: '28px',
    maxWidth: '28px',
    minHeight: '28px',
    maxHeight: '28px',
    borderStyle: 'none',
    borderRadius: '10px',
  });
  await clearSearch.click();
  await expect(query).toHaveValue("");
  await query.fill("stable");
  const exact = searchPanel.locator(".pdf-search__group").filter({ hasText: "Exact matches" });
  const related = searchPanel.locator(".pdf-search__group").filter({ hasText: "Related matches" });
  await expect(exact.locator("[data-search-result]")).toHaveCount(2);
  await expect(related.locator("[data-search-result]")).toHaveCount(2);
  await expect(searchPanel).not.toContainText("First occurrence");
  await expect(searchPanel).not.toContainText("Exact text");
  await expect(exact.locator(".pdf-search__result-match").first()).toHaveText("stable");
  const firstResultExcerpt = exact.locator(".pdf-search__excerpt").first();
  const firstResultCard = exact.locator("[data-search-result]").first();
  await expect(firstResultCard).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(firstResultCard).toHaveCSS("border-style", "none");
  await expect(firstResultCard).toHaveCSS("border-radius", "12px");
  await expect(firstResultCard).toHaveCSS("padding", "0px");
  await firstResultCard.hover();
  const directSearchAction = firstResultCard.getByRole("button", {
    name: "Open result on page 1 in References",
  });
  const [searchTabControlBounds, directSearchActionBounds] = await Promise.all([
    page.getByRole("tab", { name: "Search", exact: true }).boundingBox(),
    directSearchAction.boundingBox(),
  ]);
  if (!searchTabControlBounds || !directSearchActionBounds) {
    throw new Error("Direct Search result and tray controls did not render measurable bounds.");
  }
  expect(directSearchActionBounds.width).toBeCloseTo(26, 1);
  expect(directSearchActionBounds.height).toBeCloseTo(26, 1);
  await firstResultCard.evaluate((element) => { element.style.width = "250px"; });
  const compactSearchActions = firstResultCard.getByRole("button", {
    name: "Open result on page 1 in References",
  });
  await expect(firstResultCard.locator('.row-action-group__secondary')).toBeHidden();
  await expect(compactSearchActions).toBeVisible();
  const [searchTabBounds, compactSearchActionBounds] = await Promise.all([
    page.getByRole("tab", { name: "Search", exact: true }).boundingBox(),
    compactSearchActions.boundingBox(),
  ]);
  if (!searchTabBounds || !compactSearchActionBounds) {
    throw new Error("Search result and tray controls did not render measurable bounds.");
  }
  expect(compactSearchActionBounds.width).toBeCloseTo(26, 1);
  expect(compactSearchActionBounds.height).toBeCloseTo(26, 1);
  await firstResultCard.evaluate((element) => { element.style.removeProperty("width"); });
  await expect(firstResultCard.locator('.pdf-search__result-heading .pdf-search__result-page')).toBeVisible();
  await expect(firstResultExcerpt).toBeVisible();
  await expect(firstResultExcerpt.locator('.pdf-search__result-page')).toHaveCount(0);
  await expect(related).toContainText("stabilizes");
  await expect(related).toContainText("Stability");

  await query.fill("");
  await query.focus();
  const symbolSuggestions = page.getByRole("listbox", { name: "Suggested symbols" });
  await expect(symbolSuggestions).toBeVisible();
  await expect(symbolSuggestions.getByRole("option", { name: /degree/u })).toBeVisible();
  const suggestedGlyphs = async () => symbolSuggestions.getByRole("option").evaluateAll(
    (options) => options.map((option) => option.getAttribute("data-search-symbol")),
  );
  const expectedGreekSuggestions = [
    "Π", "α", "δ", "θ", "κ", "λ", "ν", "ξ", "ρ", "σ", "τ", "ϕ", "ϵ",
  ];
  await expect.poll(suggestedGlyphs).toEqual(expect.arrayContaining([
    ...expectedGreekSuggestions,
    "+",
    "|",
    ".",
  ]));
  const fullRankedSuggestions = await suggestedGlyphs();
  const representativePositions = ["Π", "𝟘", "+", "|", "."]
    .map((glyph) => fullRankedSuggestions.indexOf(glyph));
  expect(representativePositions.every((position) => position >= 0)).toBe(true);
  expect(representativePositions).toEqual([...representativePositions].sort((left, right) => left - right));
  expect(fullRankedSuggestions.filter((glyph) => expectedGreekSuggestions.includes(glyph ?? "")))
    .toEqual(expectedGreekSuggestions);
  await expect(symbolSuggestions.getByRole("heading")).toHaveCount(0);

  await query.fill("greek");
  await expect.poll(suggestedGlyphs).toEqual([...expectedGreekSuggestions, "·"]);
  await query.fill("");
  await expect.poll(suggestedGlyphs).toEqual(fullRankedSuggestions);
  for (const [glyph, alias] of reportedMathSymbolInventory) {
    await query.fill(alias);
    const results = searchPanel.locator("[data-search-result]");
    await expect(results, alias).toHaveCount(1);
    await expect(results.first().locator(".pdf-search__result-match"), alias).toHaveText(glyph);
  }
  await query.fill("");
  await query.focus();
  await expect(symbolSuggestions.getByRole("option", {
    name: "⏐ vertical line extension",
    exact: true,
  })).toBeVisible();
  await expect(symbolSuggestions.getByRole("option", { name: /⏐.*\(/u })).toHaveCount(0);
  await query.fill("deg");
  const degreeSuggestion = symbolSuggestions.getByRole("option", { name: /degree/u });
  await expect(degreeSuggestion).toBeVisible();
  await degreeSuggestion.click();
  await expect(query).toHaveValue("°");
  await expect(symbolSuggestions).toBeHidden();
  await expect(searchPanel.locator("[data-search-result]")).toHaveCount(1);
  await expect(searchPanel).not.toContainText("Exact symbol");
  await query.fill("degree sign");
  await expect(searchPanel.locator("[data-search-result]")).toHaveCount(1);
  await query.fill("\\textdegree");
  await expect(searchPanel.locator("[data-search-result]")).toHaveCount(1);
  await query.fill("90°");
  await expect(searchPanel.locator("[data-search-result]")).toHaveCount(1);
  await expect(searchPanel).not.toContainText("Exact formula");
  await query.fill("90°+");
  await expect(searchPanel.locator("[data-search-result]")).toHaveCount(0);
  await expect(searchPanel).toContainText("could not be matched confidently");
  await expect(searchPanel.locator(".pdf-search__alternatives")
    .getByRole("button", { name: "° degree sign (\\textdegree)", exact: true })).toBeVisible();
  await query.fill("\\doesnotexist");
  const rankedAlternatives = searchPanel.locator(".pdf-search__alternatives").getByRole("button");
  await expect(rankedAlternatives).toHaveCount(8);
  expect(await rankedAlternatives.evaluateAll((buttons) => buttons.map((button) => (
    Array.from(button.textContent?.trim() ?? "")[0]
  )))).toEqual(expectedGreekSuggestions.slice(0, 8));
  await query.fill("stable");
  await expect(exact.locator("[data-search-result]")).toHaveCount(2);

  await exact.locator(".pdf-search__result").nth(1).click();
  await expect.poll(() => currentPageText(page)).toBe("2 / 3");
  const activeSearchHighlights = mainWorkspace.locator(
    "[data-page-index='1'] [data-pdf-search-highlight]",
  );
  await expect(activeSearchHighlights).toHaveCount(2);
  const exactVisibleHighlight = mainWorkspace.locator(
    "[data-page-index='1'] [data-pdf-search-highlight][data-pdf-search-match-kind='exact']",
  );
  const relatedVisibleHighlight = mainWorkspace.locator(
    "[data-page-index='1'] [data-pdf-search-highlight][data-pdf-search-match-kind='related']",
  );
  await expect(exactVisibleHighlight).toHaveCount(1);
  await expect(relatedVisibleHighlight).toHaveCount(1);
  const [exactHighlightColor, relatedHighlightColor] = await Promise.all([
    exactVisibleHighlight.evaluate((element) => getComputedStyle(element).backgroundColor),
    relatedVisibleHighlight.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(exactHighlightColor).not.toBe("transparent");
  expect(relatedHighlightColor).not.toBe("transparent");
  expect(exactHighlightColor).not.toBe(relatedHighlightColor);
  await expect(activeSearchHighlights.first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Back in document history" })).toBeEnabled();
  const mainViewport = mainWorkspace.locator("[data-viewer-framing-viewport]");
  const mainPositionBeforeReference = await mainViewport.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }));

  await firstResultCard.hover();
  await firstResultCard
    .getByRole("button", { name: "Open result on page 1 in References" }).click();
  const searchReferenceTab = page.getByRole("tab", { name: /stable, Page 1/u });
  await expectReferenceReady(page, searchReferenceTab);
  const referenceWorkspace = page.locator(".pdf-workspace--reference");
  await expect(referenceWorkspace.locator(
    "[data-page-index='0'] [data-pdf-search-highlight][data-pdf-search-match-kind='exact']",
  )).toHaveCount(1);
  await expect(referenceWorkspace.locator(
    "[data-page-index='0'] [data-pdf-search-highlight][data-pdf-search-match-kind='related']",
  )).toHaveCount(1);
  await expect.poll(() => mainViewport.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }))).toEqual(mainPositionBeforeReference);
  await expect(query).toHaveValue("stable");

  const sendMotion = await mainViewport.evaluateHandle((element) => {
    type SendMotionState = {
      samples: Array<{ left: number; top: number }>;
      done: boolean;
      timedOut: boolean;
      fallbackTimer: number;
    };
    const state: SendMotionState = {
      samples: [{ left: element.scrollLeft, top: element.scrollTop }],
      done: false,
      timedOut: false,
      fallbackTimer: 0,
    };
    const finish = () => {
      if (state.done) return;
      state.done = true;
      element.removeEventListener("scroll", record);
      window.clearTimeout(state.fallbackTimer);
    };
    const record = () => {
      state.samples.push({ left: element.scrollLeft, top: element.scrollTop });
    };
    element.addEventListener("scroll", record, { passive: true });
    state.fallbackTimer = window.setTimeout(() => {
      state.timedOut = true;
      finish();
    }, 2_000);
    return { state, finish };
  });
  await clickHoverRevealedReferenceTabAction(
    page.getByRole("button", { name: "Open in main document" }),
  );
  await expect(page.getByRole("tab", { name: /stable, Page 1/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open References tray" })).toHaveCount(0);
  await expect.poll(() => currentPageText(page)).toBe("1 / 3");
  await expect(page.locator("[data-reference-pdf-viewport]")).toHaveCount(0);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(resolve, 250)));
  }));
  await sendMotion.evaluate(({ finish }) => finish());
  await expect.poll(() => sendMotion.evaluate(({ state }) => state.done)).toBe(true);
  expect(await sendMotion.evaluate(({ state }) => state.timedOut)).toBe(false);
  const sendMotionSamples = await sendMotion.evaluate(({ state }) => state.samples);
  await sendMotion.dispose();
  // Fitting the reference can legitimately change either scroll offset while
  // zoom and CSS padding settle. Once page 1 is reached, it must stay there;
  // requiring monotonically decreasing horizontal offsets rejects valid fits.
  const arrival = sendMotionSamples.findIndex(({ top }) => top <= 8);
  expect(arrival).toBeGreaterThanOrEqual(0);
  expect(sendMotionSamples.slice(arrival).every(({ top }) => top <= 8)).toBe(true);
  const settledPosition = await mainViewport.evaluate((element) => ({
    left: element.scrollLeft, top: element.scrollTop,
  }));
  await page.waitForTimeout(250);
  expect(await mainViewport.evaluate((element) => ({
    left: element.scrollLeft, top: element.scrollTop,
  }))).toEqual(settledPosition);
  expect(await currentPageText(page)).toBe("1 / 3");

  const workspaceTabs = page.getByRole("tablist", { name: "Workspace modes" }).getByRole("tab");
  await expect(workspaceTabs).toHaveCount(2);
  expect(await workspaceTabs.evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label"))))
    .toEqual(["Search", "Annotations"]);
  await page.getByRole("tab", { name: "Search", exact: true }).click();
  await expect(query).toHaveValue("stable");

  await page.setViewportSize({ width: 700, height: 900 });
  await expect(page.locator("[data-review-stage]")).toHaveAttribute(
    "data-workspace-presentation",
    "bottom",
  );
  const narrowWorkspaceTabs = page.getByRole("tablist", { name: "Workspace modes" }).getByRole("tab");
  await expect(narrowWorkspaceTabs).toHaveCount(2);
  expect(await narrowWorkspaceTabs.evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label"))))
    .toEqual(["Search", "Annotations"]);
  await page.getByRole("tab", { name: "Search", exact: true }).click();
  await expect(query).toBeVisible();
  await expect(query).toHaveValue("stable");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("[data-review-stage]")).toHaveAttribute(
    "data-workspace-presentation",
    "right",
  );
  await expect(query).toHaveValue("stable");
  expect(errors).toEqual([]);
});

for (const { label, width } of [
  { label: 'wide', width: 1280 },
  { label: 'narrow', width: 760 },
] as const) {
  test(`restores Search focus only from its last focused target in the ${label} workspace`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFreshProductionFixture(page, equationPdf, 'Search focus launch failed');
    const mainPage = page.locator('[data-pdf-copy-surface="main"] [data-page-index="0"]');
    await mainPage.focus();
    await page.keyboard.press(platformFindShortcut);

    const query = page.getByRole('searchbox', { name: 'Search this PDF' });
    const searchPanel = page.locator('#workspace-panel-search');
    const suggestions = page.getByRole('listbox', { name: 'Suggested symbols' });
    const annotations = page.getByRole('tab', { name: 'Annotations', exact: true });
    const search = page.getByRole('tab', { name: 'Search', exact: true });
    await expect(query).toBeFocused();
    await expect(suggestions).toBeVisible();

    await query.fill('ν');
    await expect(suggestions).toBeHidden();
    await query.click();
    await expect(suggestions).toBeHidden();
    const result = searchPanel.locator('[data-search-result] .annotation-item__navigation').first();
    await result.click();
    await expect(searchPanel).toBeVisible();
    await expect(search).toHaveAttribute('aria-selected', 'true');
    await result.click();
    await expect(searchPanel).toBeVisible();
    await query.fill('nu');
    await expect(suggestions).toBeVisible();
    await mainPage.click({ position: { x: 20, y: 20 } });
    await expect(mainPage).toBeFocused();
    await expect(suggestions).toBeHidden();
    await annotations.click();
    await search.click();
    await expect(query).toHaveValue('nu');
    await expect(searchPanel).toBeFocused();
    await expect(query).not.toBeFocused();
    await expect(suggestions).toBeHidden();

    await page.getByRole('button', { name: 'Hide workspace' }).click();
    await page.getByRole('button', { name: 'Show workspace' }).click();
    await expect(searchPanel).toBeFocused();
    await expect(query).not.toBeFocused();
    await expect(suggestions).toBeHidden();

    await page.keyboard.press(platformFindShortcut);
    await expect(query).toBeFocused();
    await expect(suggestions).toBeVisible();
    await annotations.click();
    await search.click();
    await expect(query).toBeFocused();
    await expect(suggestions).toBeVisible();
    await query.fill('');
    await mainPage.click({ position: { x: 20, y: 20 } });
    await expect(mainPage).toBeFocused();
    await annotations.click();
    await search.click();
    await expect(query).toHaveValue('');
    await expect(searchPanel).toBeFocused();
    await expect(query).not.toBeFocused();
    await expect(suggestions).toBeHidden();

    await page.keyboard.press(platformFindShortcut);
    await expect(query).toBeFocused();
    await expect(suggestions).toBeVisible();
  });
}

test("keeps a real reference chain beside the anchored main PDF through reflow and history", async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          const state = globalThis as typeof globalThis & {
            __copiedPdfTargetLink?: string;
            __rejectPdfTargetCopy?: boolean;
            __holdPdfTargetCopy?: boolean;
            __releasePdfTargetCopy?: () => void;
            __pdfTargetCopyCount?: number;
          };
          state.__pdfTargetCopyCount = (state.__pdfTargetCopyCount ?? 0) + 1;
          if (state.__rejectPdfTargetCopy) throw new Error("denied");
          if (state.__holdPdfTargetCopy) {
            await new Promise<void>((resolve) => { state.__releasePdfTargetCopy = resolve; });
          }
          state.__copiedPdfTargetLink = value;
        },
      },
    });
  });
  const documentRequests: Array<{ url: string; authorization?: string; cookie?: string }> = [];
  page.on("request", (request) => {
    if (!/\/document\//u.test(new URL(request.url()).pathname)) return;
    const headers = request.headers();
    documentRequests.push({
      url: request.url(),
      ...(headers.authorization === undefined ? {} : { authorization: headers.authorization }),
      ...(headers.cookie === undefined ? {} : { cookie: headers.cookie }),
    });
  });
  const contactedOrigins = new Set<string>();
  page.on("request", (request) => contactedOrigins.add(new URL(request.url()).origin));

  await openFreshProductionFixture(page, referencePdf, "Reference navigation launch failed");
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  const mainViewport = mainWorkspace.locator("[data-viewer-framing-viewport]");
  const mainPageOne = mainWorkspace.locator("[data-page-index='0']");
  await expect(mainPageOne).toBeVisible();
  await expect.poll(() => currentPageText(page)).toBe("1 / 4");
  await mainWorkspace.evaluate((element) => element.setAttribute("data-reference-main-mount", "stable"));

  const primaryLink = mainWorkspace.getByRole("button", {
    name: "Open PDF link to Primary result, Page 2",
  });
  await primaryLink.focus();
  await page.keyboard.press("Enter");
  const primaryMenu = page.getByRole("menu", { name: "Open Primary result, Page 2" });
  await expect(primaryMenu).toBeVisible();
  await expect(primaryMenu.getByRole("menuitem", { name: /Open in References/u })).toBeFocused();
  await expect(primaryMenu.getByRole("menuitem")).toHaveCount(3);
  await expect(primaryMenu.locator("svg")).toHaveCount(3);
  await expect(primaryMenu.getByRole("menuitem").first()).toHaveAttribute("aria-label", "Open in References");
  await expect(primaryMenu.getByRole("menuitem").nth(1)).toHaveAttribute("aria-label", "Open in main document");
  const copyTargetLink = primaryMenu.getByRole("menuitem", {
    name: "Copy link to exact destination on page 2",
  });
  await expect(copyTargetLink).not.toHaveAttribute("title", "Copy exact destination link");
  await expect(primaryMenu.getByRole("menuitem").first()).toHaveText("");
  await expect(primaryMenu.getByRole("menuitem").last()).toHaveText("");
  const firstMenuItemBounds = await primaryMenu.getByRole("menuitem").first().boundingBox();
  expect(firstMenuItemBounds).not.toBeNull();
  expect(firstMenuItemBounds!.width).toBe(32);
  expect(firstMenuItemBounds!.height).toBe(32);
  const menuBounds = await primaryMenu.boundingBox();
  expect(menuBounds).not.toBeNull();
  expect(menuBounds!.width).toBeLessThan(140);
  expect(menuBounds!.height).toBe(44);
  const popoverBounds = await page.locator("[data-link-action-popover]").boundingBox();
  expect(popoverBounds).not.toBeNull();
  expect(popoverBounds!.height).toBe(46);
  expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds!.y).toBeGreaterThanOrEqual(0);
  expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(1280);
  expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(900);
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __holdPdfTargetCopy?: boolean })
      .__holdPdfTargetCopy = true;
  });
  await copyTargetLink.click();
  await expect(copyTargetLink).toHaveAttribute("aria-busy", "true");
  await copyTargetLink.click();
  expect(await page.evaluate(() => (
    globalThis as typeof globalThis & { __pdfTargetCopyCount?: number }
  ).__pdfTargetCopyCount)).toBe(1);
  await page.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __holdPdfTargetCopy?: boolean;
      __releasePdfTargetCopy?: () => void;
    };
    state.__holdPdfTargetCopy = false;
    state.__releasePdfTargetCopy?.();
  });
  await expect(primaryMenu).toHaveCount(0);
  await expect(primaryLink).toBeFocused();
  await expect.poll(() => currentPageText(page)).toBe("1 / 4");
  expect(await page.evaluate(() => (
    globalThis as typeof globalThis & { __copiedPdfTargetLink?: string }
  ).__copiedPdfTargetLink)).toMatch(/#v=2&page=2&mode=/u);
  await page.keyboard.press("Enter");
  await expect(primaryMenu.getByRole("menuitem", { name: /Open in References/u })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(primaryMenu.getByRole("menuitem", { name: "Open in main document" })).toBeFocused();
  await expect(primaryMenu).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(copyTargetLink).toBeFocused();
  await expect(primaryMenu).toBeVisible();
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __rejectPdfTargetCopy?: boolean })
      .__rejectPdfTargetCopy = true;
  });
  await page.keyboard.press("Enter");
  const fallbackLink = primaryMenu.getByRole("textbox", { name: "Placekeeper link" });
  await expect(fallbackLink).toHaveValue(/#v=2&page=2&mode=/u);
  await expect(copyTargetLink).toBeFocused();
  const failedPopoverBounds = await page.locator("[data-link-action-popover]").boundingBox();
  expect(failedPopoverBounds).not.toBeNull();
  expect(failedPopoverBounds!.x).toBeGreaterThanOrEqual(0);
  expect(failedPopoverBounds!.y).toBeGreaterThanOrEqual(0);
  expect(failedPopoverBounds!.x + failedPopoverBounds!.width).toBeLessThanOrEqual(1280);
  expect(failedPopoverBounds!.y + failedPopoverBounds!.height).toBeLessThanOrEqual(900);
  await page.keyboard.press("Tab");
  await expect(fallbackLink).toBeFocused();
  await page.keyboard.press("Tab");
  const retryCopy = primaryMenu.getByRole("button", { name: "Retry" });
  await expect(retryCopy).toBeFocused();
  await expect(primaryMenu).toBeVisible();
  const failedTargetLink = await fallbackLink.inputValue();
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __rejectPdfTargetCopy?: boolean })
      .__rejectPdfTargetCopy = false;
  });
  await retryCopy.click();
  await expect(primaryMenu).toHaveCount(0);
  await expect(primaryLink).toBeFocused();
  expect(await page.evaluate(() => (
    globalThis as typeof globalThis & { __copiedPdfTargetLink?: string }
  ).__copiedPdfTargetLink)).toBe(failedTargetLink);

  await openLinkInReferences(page, primaryLink);
  const workspace = page.locator("[data-review-workspace]");
  await expect(workspace).toHaveAttribute("data-workspace-open", "true");
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "bottom");
  await expect(page.getByRole("button", { name: "Move References to right" })).toBeVisible();
  const primaryTab = page.getByRole("tab", { name: /Primary result/u });
  await expectReferenceReady(page, primaryTab);
  await expect(primaryTab).toBeFocused();
  await expect.poll(() => workspace.evaluate((element) => getComputedStyle(element).transform))
    .toBe('none');

  const referenceWorkspace = page.locator("[data-reference-pdf-viewport]");
  const referenceViewport = referenceWorkspace.locator("[data-viewer-framing-viewport]");
  const primaryReferencePage = referenceWorkspace.locator("[data-page-index='1']");
  await expect(primaryReferencePage).toBeVisible();
  await expect.poll(async () => {
    const [viewportBounds, pageBounds] = await Promise.all([
      referenceViewport.boundingBox(),
      primaryReferencePage.boundingBox(),
    ]);
    return viewportBounds !== null
      && pageBounds !== null
      && viewportBounds.width > 0
      && pageBounds.width > 0;
  }).toBe(true);
  const [
    initialReferenceViewportBounds,
    initialReferenceClientBox,
    initialReferencePageBounds,
  ] = await Promise.all([
    referenceViewport.boundingBox(),
    referenceViewport.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left + element.clientLeft,
        width: element.clientWidth,
      };
    }),
    primaryReferencePage.boundingBox(),
  ]);
  if (!initialReferenceViewportBounds || !initialReferencePageBounds) {
    throw new Error("Initial Reference viewer geometry is unavailable.");
  }
  const initialReferenceLeftGap = initialReferencePageBounds.x - initialReferenceClientBox.left;
  const initialReferenceRightGap = initialReferenceClientBox.left
    + initialReferenceClientBox.width
    - initialReferencePageBounds.x
    - initialReferencePageBounds.width;
  const initialReferenceHorizontalInset = initialReferenceClientBox.width
    - initialReferencePageBounds.width;
  expect(initialReferenceHorizontalInset).toBeGreaterThan(0);
  expect(initialReferenceHorizontalInset).toBeLessThan(64);
  expect(initialReferenceLeftGap).toBeGreaterThan(0);
  expect(initialReferenceRightGap).toBeGreaterThan(0);
  expect(Math.max(initialReferenceLeftGap, initialReferenceRightGap)).toBeLessThan(32);
  expect(Math.abs(initialReferenceLeftGap - initialReferenceRightGap)).toBeLessThan(4);
  expect(initialReferencePageBounds.height).toBeGreaterThan(initialReferenceViewportBounds.height * 2);
  await referenceWorkspace.evaluate((element) => element.setAttribute("data-reference-mount", "stable"));
  const mainScrollBefore = await mainViewport.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }));
  await referenceViewport.evaluate((element) => { element.scrollTop += 96; });
  await expect.poll(() => referenceViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await mainViewport.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }))).toEqual(mainScrollBefore);
  await expect.poll(() => currentPageText(page)).toBe("1 / 4");

  const detailLink = referenceWorkspace.getByRole("button", {
    name: "Open PDF link to Target-to-target detail link, Page 3",
  });
  await detailLink.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await openLinkInReferences(page, detailLink);
  const detailTab = page.getByRole("tab", { name: /Target-to-target detail link/u });
  await expectReferenceReady(page, detailTab);
  await expect(detailTab).toBeFocused();
  await expect(page.getByRole("tablist", { name: "Open references" }).getByRole("tab")).toHaveCount(2);

  const repeatedAlias = mainWorkspace.getByRole("button", {
    name: "Open PDF link to Repeated primary result, Page 2",
  });
  await repeatedAlias.click();
  await expect(page.getByRole("menuitem", { name: /Open in References/u })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await expect(primaryTab).toBeFocused();
  await expect(page.getByRole("tablist", { name: "Open references" }).getByRole("tab")).toHaveCount(2);
  const referencePositionBeforeReflow = await Promise.all([
    referenceViewport.boundingBox(),
    primaryReferencePage.boundingBox(),
  ]).then(([viewportBounds, pageBounds]) => {
    if (!viewportBounds || !pageBounds) throw new Error("Reference scroll location is unavailable.");
    return (pageBounds.y + pageBounds.height / 2) - (viewportBounds.y + viewportBounds.height / 2);
  });
  const referencePageSizeBeforeReflow = await primaryReferencePage.boundingBox().then((bounds) => {
    if (!bounds) throw new Error("Reference page size is unavailable.");
    return { width: bounds.width, height: bounds.height };
  });
  const referenceTabsList = page.getByRole("tablist", { name: "Open references" });
  await expect(referenceTabsList).toHaveAttribute("aria-orientation", "vertical");
  const [bottomPrimaryTabBox, bottomDetailTabBox] = await Promise.all([
    primaryTab.boundingBox(),
    detailTab.boundingBox(),
  ]);
  if (!bottomPrimaryTabBox || !bottomDetailTabBox) throw new Error("Bottom reference tabs have no bounds.");
  expect(bottomDetailTabBox.y).toBeGreaterThan(bottomPrimaryTabBox.y + bottomPrimaryTabBox.height - 1);
  expect(bottomDetailTabBox.x).toBeCloseTo(bottomPrimaryTabBox.x, 0);
  const bottomCompound = referenceTabsList.locator(
    '.reference-tab-segment:has(> [role="tab"][aria-selected="true"])',
  );
  await expect(bottomCompound.locator('button')).toHaveCount(3);
  const bottomPanelGeometry = await page.locator('.reference-panel').evaluate((panel) => {
    const viewport = panel.querySelector<HTMLElement>('[data-reference-viewport-host]');
    if (!viewport) throw new Error('Reference viewport host is missing.');
    const panelBounds = panel.closest('.review-workspace')!.getBoundingClientRect();
    const tabsBounds = panel.parentElement!.querySelector('.reference-tabs')!.getBoundingClientRect();
    const viewportBounds = viewport.getBoundingClientRect();
    return {
      top: viewportBounds.top - panelBounds.top,
      right: panelBounds.right - viewportBounds.right,
      bottom: panelBounds.bottom - viewportBounds.bottom,
      left: viewportBounds.left - tabsBounds.right,
    };
  });
  expect(bottomPanelGeometry).toEqual({ top: 12, right: 12, bottom: 12, left: 12 });
  await expect(page.locator('.reference-panel__actions')).toHaveCount(0);
  // Main viewer, source-annotation style inventory, and the shared reference viewer.
  await expect.poll(() => documentRequests.length).toBe(3);
  expect(new Set(documentRequests.map(({ url }) => url)).size).toBe(1);
  expect(documentRequests.every(({ authorization, cookie }) => (
    authorization?.startsWith("Bearer ") === true && cookie === undefined
  ))).toBe(true);

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "bottom");
  await expect(mainWorkspace).toHaveAttribute("data-reference-main-mount", "stable");
  await expect(referenceWorkspace).toHaveAttribute("data-reference-mount", "stable");
  await expect.poll(async () => {
    const [viewportBounds, pageBounds] = await Promise.all([
      referenceViewport.boundingBox(),
      primaryReferencePage.boundingBox(),
    ]);
    if (!viewportBounds || !pageBounds) return Number.POSITIVE_INFINITY;
    const position = (pageBounds.y + pageBounds.height / 2)
      - (viewportBounds.y + viewportBounds.height / 2);
    return Math.abs(position - referencePositionBeforeReflow);
  }).toBeLessThan(48);
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "bottom");
  await expect(mainWorkspace).toHaveAttribute("data-reference-main-mount", "stable");
  await expect(referenceWorkspace).toHaveAttribute("data-reference-mount", "stable");

  const zoomBeforeDocking = await currentZoomText(page);
  const bottomSplitter = page.getByRole("separator", { name: "Resize References" });
  await expect(bottomSplitter).toHaveAttribute("aria-orientation", "horizontal");
  await expect(bottomSplitter).toBeVisible();
  await expect(workspace).toBeVisible();
  const initialBottomValue = Number(await bottomSplitter.getAttribute("aria-valuenow"));
  await expect(workspace.getByRole("button", { name: "Hide References" })).toBeVisible();
  let bottomSplitterBox = await bottomSplitter.boundingBox();
  let initialBottomBounds = await workspace.boundingBox();
  await expect.poll(async () => {
    [bottomSplitterBox, initialBottomBounds] = await Promise.all([
      bottomSplitter.boundingBox(),
      workspace.boundingBox(),
    ]);
    return bottomSplitterBox !== null
      && initialBottomBounds !== null;
  }).toBe(true);
  if (!bottomSplitterBox || !initialBottomBounds) {
    throw new Error("Bottom References edge controls have no bounds.");
  }
  expect(bottomSplitterBox.y).toBeCloseTo(initialBottomBounds.y, 0);
  expect(await bottomSplitter.evaluate((element) => getComputedStyle(element).cursor)).toBe("ns-resize");
  await page.mouse.move(
    bottomSplitterBox.x + bottomSplitterBox.width / 2,
    bottomSplitterBox.y + bottomSplitterBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(bottomSplitterBox.x + bottomSplitterBox.width / 2, bottomSplitterBox.y - 48);
  await page.mouse.up();
  await expect.poll(async () => Number(await bottomSplitter.getAttribute("aria-valuenow")))
    .toBeGreaterThan(initialBottomValue);
  const rememberedBottomValue = Number(await bottomSplitter.getAttribute("aria-valuenow"));

  const rightRail = page.getByRole("button", { name: "Show workspace" });
  await rightRail.click();
  const toolsWorkspace = page.locator("#review-tools-workspace");
  await expect(toolsWorkspace).toHaveAttribute("data-tools-workspace-open", "true");
  await expect.poll(() => toolsWorkspace.evaluate((element) => getComputedStyle(element).transform))
    .toBe("none");
  await expect(page.locator("[data-review-stage]")).toHaveAttribute("data-reference-layout", "wide-split");
  const [toolsBounds, bottomBounds] = await Promise.all([
    toolsWorkspace.boundingBox(),
    workspace.boundingBox(),
  ]);
  if (!toolsBounds || !bottomBounds) throw new Error("Coordinated tray geometry is unavailable.");
  expect(bottomBounds.y - (toolsBounds.y + toolsBounds.height)).toBeCloseTo(await expectedWorkspaceInset(page), 0);
  await expect(toolsWorkspace.getByRole("button", { name: "Hide workspace" })).toBeVisible();
  await mainPageOne.click({ position: { x: 24, y: 24 } });
  await expect(toolsWorkspace).toHaveAttribute("data-tools-workspace-open", "true");
  await expect(workspace).toHaveAttribute("data-workspace-open", "true");

  await clickHoverRevealedReferenceDockAction(
    page.getByRole("button", { name: "Move References to right" }),
  );
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "right");
  await expect(page.getByRole("button", { name: "Open References tray" })).toHaveCount(0);
  await expect(workspace.getByRole("button", { name: "Hide References" })).toHaveAttribute(
    "aria-expanded", "true",
  );
  const workspaceModes = page.getByRole("tablist", { name: "Workspace modes" });
  const modeTabs = workspaceModes.getByRole("tab");
  await expect(modeTabs).toHaveCount(4);
  expect(await modeTabs.evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label"))))
    .toEqual(["Outline", "Search", "Annotations", "References"]);
  await expect(workspaceModes.getByRole("tab", { name: "References", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(referenceTabsList).toHaveAttribute("aria-orientation", "horizontal");
  const [rightPrimaryTabBox, rightDetailTabBox] = await Promise.all([
    primaryTab.boundingBox(),
    detailTab.boundingBox(),
  ]);
  if (!rightPrimaryTabBox || !rightDetailTabBox) throw new Error("Right reference tabs have no bounds.");
  expect(rightDetailTabBox.x).toBeGreaterThan(rightPrimaryTabBox.x + rightPrimaryTabBox.width - 1);
  expect(rightDetailTabBox.y).toBeCloseTo(rightPrimaryTabBox.y, 0);
  await expect(page.getByRole("button", { name: "Move References to bottom" })).toBeVisible();
  const rightStripGeometry = await workspaceModes.evaluate((tablist) => {
    const header = tablist.closest<HTMLElement>(".review-workspace__header");
    const strip = tablist.closest<HTMLElement>(".review-workspace__activity-strip");
    const tabs = [...tablist.querySelectorAll<HTMLElement>("[role='tab']")];
    const selectedTab = tablist.querySelector<HTMLElement>("[role='tab'][aria-selected='true']");
    const selectedLabel = selectedTab?.querySelector<HTMLElement>("[data-workspace-mode-label]");
    const moveButton = strip?.querySelector<HTMLElement>("[data-reference-move='bottom']");
    if (!header || !strip || !selectedTab || !selectedLabel || !moveButton || tabs.length !== 4) {
      throw new Error("Right workspace activity-strip geometry is incomplete.");
    }
    const headerRect = header.getBoundingClientRect();
    const stripRect = strip.getBoundingClientRect();
    const inactiveWidths = tabs
      .filter((tab) => tab.getAttribute("aria-selected") !== "true")
      .map((tab) => tab.getBoundingClientRect().width);
    return {
      leftInset: stripRect.left - headerRect.left,
      rightSlack: headerRect.right - stripRect.right,
      stripWidth: stripRect.width,
      headerWidth: headerRect.width,
      inactiveWidths,
      selectedWidth: selectedTab.getBoundingClientRect().width,
      moveWidth: moveButton.getBoundingClientRect().width,
      labelFits: selectedLabel.scrollWidth <= selectedLabel.clientWidth,
      visibleLabelCount: strip.querySelectorAll("[data-workspace-mode-label]").length,
      moveSharesReferenceSegment:
        moveButton.parentElement === strip
        && selectedTab.closest('.review-workspace__mode-segment--compound') !== null
        && !tablist.contains(moveButton),
    };
  });
  expect(rightStripGeometry.leftInset).toBeCloseTo(46, 1);
  expect(rightStripGeometry.rightSlack).toBeGreaterThan(0);
  expect(rightStripGeometry.stripWidth).toBeLessThan(rightStripGeometry.headerWidth);
  expect(new Set(rightStripGeometry.inactiveWidths.map((width) => Math.round(width))).size).toBe(1);
  expect(rightStripGeometry.selectedWidth).toBeGreaterThan(rightStripGeometry.inactiveWidths[0]!);
  expect(rightStripGeometry.moveWidth).toBeCloseTo(rightStripGeometry.inactiveWidths[0]!, 0);
  expect(rightStripGeometry.labelFits).toBe(true);
  expect(rightStripGeometry.visibleLabelCount).toBe(1);
  expect(rightStripGeometry.moveSharesReferenceSegment).toBe(true);
  const referencesMode = workspaceModes.getByRole("tab", { name: "References", exact: true });
  await workspaceModes.getByRole("tab", { name: "Outline", exact: true }).click();
  await expect(page.getByRole("button", { name: "Move References to bottom" })).toHaveCount(0);
  await referencesMode.click();
  await expect(referencesMode).toHaveAttribute("aria-selected", "true");
  const moveReferencesBottom = page.getByRole("button", { name: "Move References to bottom" });
  await expect(moveReferencesBottom).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const activeReferenceTab = referenceTabsList.locator('[role="tab"][aria-selected="true"]');
  await expect(activeReferenceTab).toBeFocused();
  await referencesMode.focus();
  await expect(referencesMode).toBeFocused();
  await referencesMode.press("ArrowLeft");
  const annotationsMode = workspaceModes.getByRole("tab", { name: "Annotations", exact: true });
  await expect(annotationsMode).toBeFocused();
  await annotationsMode.press("ArrowLeft");
  const searchMode = workspaceModes.getByRole("tab", { name: "Search", exact: true });
  await expect(searchMode).toBeFocused();
  await expect(referencesMode).toHaveAttribute("aria-selected", "true");
  await searchMode.press("Enter");
  await expect(searchMode).toHaveAttribute("aria-selected", "true");
  await expect(moveReferencesBottom).toHaveCount(0);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await searchMode.press("ArrowRight");
  await expect(annotationsMode).toBeFocused();
  await annotationsMode.press("ArrowRight");
  await expect(referencesMode).toBeFocused();
  await referencesMode.press("Space");
  await expect(referencesMode).toHaveAttribute("aria-selected", "true");
  await expect(moveReferencesBottom).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(activeReferenceTab).toBeFocused();
  await referencesMode.focus();
  await expect(referencesMode).toBeFocused();
  const workspaceForwardTab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  await page.keyboard.press(workspaceForwardTab);
  await expect(moveReferencesBottom).toBeFocused();
  await expect(mainWorkspace).toHaveAttribute("data-reference-main-mount", "stable");
  await expect(referenceWorkspace).toHaveAttribute("data-reference-mount", "stable");

  const rightSplitter = page.getByRole("separator", { name: "Resize References" });
  await expect(rightSplitter).toHaveAttribute("aria-orientation", "vertical");
  const [rightSplitterBox, initialRightBounds] = await Promise.all([
    rightSplitter.boundingBox(),
    workspace.boundingBox(),
  ]);
  if (!rightSplitterBox || !initialRightBounds) throw new Error("Right References edge has no bounds.");
  expect(rightSplitterBox.x).toBeCloseTo(initialRightBounds.x, 0);
  expect(await rightSplitter.evaluate((element) => getComputedStyle(element).cursor)).toBe("ew-resize");
  const initialRightValue = Number(await rightSplitter.getAttribute("aria-valuenow"));
  await page.mouse.move(
    rightSplitterBox.x + rightSplitterBox.width / 2,
    rightSplitterBox.y + rightSplitterBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    rightSplitterBox.x + rightSplitterBox.width / 2 - 32,
    rightSplitterBox.y + rightSplitterBox.height / 2,
  );
  await page.mouse.up();
  await expect.poll(async () => Number(await rightSplitter.getAttribute("aria-valuenow")))
    .toBeGreaterThan(initialRightValue);
  await rightSplitter.press("Home");
  const minimumRightValue = Number(await rightSplitter.getAttribute("aria-valuenow"));
  const minimumSelectorGeometry = await workspaceModes.evaluate((tablist) => {
    const strip = tablist.closest<HTMLElement>(".review-workspace__activity-strip");
    const header = tablist.closest<HTMLElement>(".review-workspace__header");
    const tabs = [...tablist.querySelectorAll<HTMLElement>("[role='tab']")];
    const selectedLabel = tablist.querySelector<HTMLElement>("[data-workspace-mode-label]");
    const moveButton = strip?.querySelector<HTMLElement>("[data-reference-move='bottom']");
    if (!strip || !header || tabs.length === 0 || !selectedLabel || !moveButton) {
      throw new Error("Minimum-width workspace activity-strip geometry is incomplete.");
    }
    const stripRect = strip.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const firstRect = tabs[0]!.getBoundingClientRect();
    const lastRect = tabs.at(-1)!.getBoundingClientRect();
    const moveRect = moveButton.getBoundingClientRect();
    return {
      firstLeft: firstRect.left,
      lastRight: lastRect.right,
      moveRight: moveRect.right,
      stripLeft: stripRect.left,
      stripRight: stripRect.right,
      headerRight: headerRect.right,
      labelOverflow: getComputedStyle(selectedLabel).textOverflow,
      labelWhiteSpace: getComputedStyle(selectedLabel).whiteSpace,
    };
  });
  expect(minimumSelectorGeometry.firstLeft)
    .toBeGreaterThanOrEqual(minimumSelectorGeometry.stripLeft - 1);
  expect(minimumSelectorGeometry.lastRight)
    .toBeLessThanOrEqual(minimumSelectorGeometry.stripRight + 1);
  expect(minimumSelectorGeometry.moveRight)
    .toBeLessThanOrEqual(minimumSelectorGeometry.stripRight + 1);
  expect(minimumSelectorGeometry.moveRight)
    .toBeLessThanOrEqual(minimumSelectorGeometry.headerRight + 1);
  expect(minimumSelectorGeometry.labelOverflow).toBe("ellipsis");
  expect(minimumSelectorGeometry.labelWhiteSpace).toBe("nowrap");
  await rightSplitter.press("ArrowLeft");
  await expect.poll(async () => Number(await rightSplitter.getAttribute("aria-valuenow")))
    .toBeGreaterThan(minimumRightValue);
  const rememberedRightValue = Number(await rightSplitter.getAttribute("aria-valuenow"));
  const referenceRightBounds = await workspace.boundingBox();
  expect(referenceRightBounds?.width).toBeCloseTo(rememberedRightValue, 0);
  const rightCompoundGeometry = await referenceTabsList.locator(
    '.reference-tab-segment:has(> [role="tab"][aria-selected="true"])',
  ).evaluate((segment) => {
    const selector = segment.querySelector<HTMLElement>('[role="tab"]');
    const title = selector?.querySelector<HTMLElement>('span');
    const actions = [...segment.querySelectorAll<HTMLElement>('[data-reference-tab-action]')];
    if (!selector || !title || actions.length !== 2) {
      throw new Error('Compound reference geometry is incomplete.');
    }
    const titleStyle = getComputedStyle(title);
    return {
      titleOverflow: titleStyle.overflow,
      titleTextOverflow: titleStyle.textOverflow,
      titleWhiteSpace: titleStyle.whiteSpace,
      actionWidths: actions.map((action) => action.getBoundingClientRect().width),
    };
  });
  expect(rightCompoundGeometry.titleOverflow).toBe('hidden');
  expect(rightCompoundGeometry.titleTextOverflow).toBe('ellipsis');
  expect(rightCompoundGeometry.titleWhiteSpace).toBe('nowrap');
  await expect(primaryTab).toHaveAccessibleName(/Primary result, Page 2/u);
  expect(rightCompoundGeometry.actionWidths[0]).toBeCloseTo(26, 0);
  expect(rightCompoundGeometry.actionWidths[1]).toBeCloseTo(26, 0);

  await page.getByRole("tab", { name: "Search", exact: true }).click();
  await expect.poll(async () => (await workspace.boundingBox())?.width ?? 0)
    .toBeCloseTo(rememberedRightValue, 0);
  await page.getByRole("tab", { name: "References", exact: true }).click();
  await expect.poll(async () => (await workspace.boundingBox())?.width ?? 0)
    .toBeCloseTo(rememberedRightValue, 0);

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.locator("[data-review-stage]")).toHaveAttribute(
    "data-reference-layout",
    "narrow-unified",
  );
  await expect(page.getByRole("tab", { name: "References", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: "Move References to bottom" })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("[data-review-stage]")).toHaveAttribute(
    "data-reference-layout",
    "wide-right",
  );
  await expect(page.getByRole("tab", { name: "References", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: "Move References to bottom" })).toBeVisible();
  await page.getByRole("button", { name: "Move References to bottom" }).focus();
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.getByRole("tab", { name: "References", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(async () => (await workspace.boundingBox())?.width ?? 0)
    .toBeCloseTo(rememberedRightValue, 0);

  await clickHoverRevealedReferenceDockAction(
    page.getByRole("button", { name: "Move References to bottom" }),
  );
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "bottom");
  await expect.poll(async () => Number(await bottomSplitter.getAttribute("aria-valuenow")))
    .toBe(rememberedBottomValue);
  await expect(page.getByRole("tab", { name: "References", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tablist", { name: "Workspace modes" }))
    .toHaveAttribute("data-workspace-mode-count", "1");
  await expect(page.getByRole("button", { name: "Move References to right" })).toBeVisible();
  const bottomReferencesMode = page.getByRole("tab", { name: "References", exact: true });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await bottomReferencesMode.focus();
  await bottomReferencesMode.press(workspaceForwardTab);
  await expect(page.getByRole("button", { name: "Move References to right" })).toBeFocused();
  await page.getByRole("button", { name: "Show workspace" }).click();
  await primaryTab.click();

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.locator("[data-review-stage]")).toHaveAttribute("data-reference-layout", "narrow-unified");
  await expect(page.getByRole("tab", { name: "References", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(mainWorkspace).toHaveAttribute("data-reference-main-mount", "stable");
  await expect(referenceWorkspace).toHaveAttribute("data-reference-mount", "stable");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("[data-review-stage]")).toHaveAttribute("data-reference-layout", "wide-split");
  await expect(toolsWorkspace).toHaveAttribute("data-tools-workspace-open", "true");
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "bottom");
  // The default fit-width scale refits when the tools tray occupies reading space.
  await expect.poll(async () => Number.parseInt(await currentZoomText(page), 10))
    .toBeLessThan(Number.parseInt(zoomBeforeDocking, 10));
  await expect.poll(async () => {
    const viewport = await mainViewport.boundingBox();
    const paper = await mainPageOne.boundingBox();
    const fade = await page.locator('.review-overlay-frame__right-fade:visible').boundingBox();
    if (!viewport || !paper || !fade) return Number.POSITIVE_INFINITY;
    return Math.max(viewport.x - paper.x, paper.x + paper.width - fade.x);
  }).toBeLessThan(2);
  await expect.poll(async () => {
    const bounds = await primaryReferencePage.boundingBox();
    if (!bounds) return Number.POSITIVE_INFINITY;
    return Math.max(
      Math.abs(bounds.width - referencePageSizeBeforeReflow.width),
      Math.abs(bounds.height - referencePageSizeBeforeReflow.height),
    );
  }).toBeLessThan(1);
  await expect(mainWorkspace).toHaveAttribute("data-reference-main-mount", "stable");
  await expect(referenceWorkspace).toHaveAttribute("data-reference-mount", "stable");

  await expect(page.getByRole('button', { name: 'Codex' })).toHaveCount(0);
  await expect(page.locator('[data-codex-context]')).toHaveCount(0);
  await expect(workspace).toHaveAttribute('data-workspace-open', 'true');
  await expect(primaryTab).toHaveAttribute('aria-selected', 'true');

  await detailTab.click();
  await expect(detailTab).toHaveAttribute("aria-selected", "true");
  await primaryTab.click();
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await clickHoverRevealedReferenceTabAction(
    page.getByRole("button", { name: "Close active reference" }),
  );
  await expect(primaryTab).toHaveCount(0);
  await expect(detailTab).toHaveAttribute("aria-selected", "true");
  await expect(detailTab).toBeFocused();
  const liveDetailPage = referenceWorkspace.locator("[data-page-index='2']");
  await liveDetailPage.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect.poll(async () => {
    const [viewportBounds, pageBounds] = await Promise.all([
      referenceViewport.boundingBox(),
      liveDetailPage.boundingBox(),
    ]);
    if (!viewportBounds || !pageBounds) return Number.POSITIVE_INFINITY;
    return Math.abs(
      (viewportBounds.y + viewportBounds.height / 2)
      - (pageBounds.y + pageBounds.height / 2),
    );
  }).toBeLessThan(2);
  await clickHoverRevealedReferenceTabAction(
    page.getByRole("button", { name: "Open in main document" }),
  );
  await expect(workspace).toHaveAttribute("data-workspace-open", "false");
  await expect(toolsWorkspace).toHaveAttribute("data-tools-workspace-open", "true");
  await expect(page.locator(".review-workspace__status")).toHaveText(
    "Reference sent to the main document.",
  );
  await expect(page.getByRole("tablist", {
    name: "Open references",
    includeHidden: true,
  }).getByRole("tab", { includeHidden: true })).toHaveCount(0);
  const mainPageThree = mainWorkspace.locator("[data-page-index='2']");
  const expectMainPageThreeSettled = async () => expect.poll(async () => {
    const [viewportBounds, pageBounds] = await Promise.all([
      mainViewport.boundingBox(),
      mainPageThree.boundingBox(),
    ]);
    if (!viewportBounds || !pageBounds) return Number.POSITIVE_INFINITY;
    return Math.abs(
      (viewportBounds.y + viewportBounds.height / 2)
      - (pageBounds.y + pageBounds.height / 2),
    );
  }).toBeLessThan(2);
  await expectMainPageThreeSettled();
  const back = page.getByRole("button", { name: "Back in document history" });
  const forward = page.getByRole("button", { name: "Forward in document history" });
  await expect(back).toBeEnabled();
  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await back.click();
  await expect.poll(() => currentPageText(page)).toBe("1 / 4");
  await expect(forward).toBeEnabled();
  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await forward.click();
  await expect(page.locator(".review-workspace__status")).toHaveText(
    "Moved forward in document history.",
  );
  await expectMainPageThreeSettled();

  const workspaceControl = page.getByRole("button", { name: "Open References tray" });
  await expect(workspaceControl).toHaveCount(0);
  await expect(page.locator("[data-reference-empty]")).toHaveCount(0);
  expect(contactedOrigins).toEqual(new Set([new URL(documentRequests[0]!.url).origin]));
});

test("follows a PDF link in the same reference tab without moving main", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, "Same-reference navigation launch failed");
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  const mainViewport = mainWorkspace.locator("[data-viewer-framing-viewport]");
  await expect(mainWorkspace.locator("[data-page-index='0']")).toBeVisible();

  const primaryLink = mainWorkspace.getByRole("button", {
    name: "Open PDF link to Primary result, Page 2",
  });
  await openLinkInReferences(page, primaryLink);
  const primaryTab = page.getByRole("tab", { name: /Primary result/u });
  await expectReferenceReady(page, primaryTab);

  const referenceWorkspace = page.locator("[data-reference-pdf-viewport]");
  const referenceViewport = referenceWorkspace.locator("[data-viewer-framing-viewport]");
  await expect(referenceWorkspace.locator("[data-page-index='1']")).toBeVisible();
  const mainBefore = {
    page: await currentPageText(page),
    zoom: await currentZoomText(page),
    scroll: await mainViewport.evaluate((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
    })),
    backDisabled: !(await page.getByRole("button", { name: "Back in document history" }).isVisible()),
    forwardDisabled: !(await page.getByRole("button", { name: "Forward in document history" }).isVisible()),
  };

  const detailLink = referenceWorkspace.getByRole("button", {
    name: "Open PDF link to Target-to-target detail link, Page 3",
  });
  await detailLink.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await followLinkInSameReference(page, detailLink);

  await expect(page.locator(".review-workspace__status"))
    .toHaveText("Reference destination opened.");
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tablist", { name: "Open references" }).getByRole("tab"))
    .toHaveCount(1);
  const destinationPage = referenceWorkspace.locator("[data-page-index='2']");
  await expect(destinationPage).toBeVisible();
  await expect(destinationPage).toBeFocused();
  await expect.poll(() => referenceViewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  expect(await currentPageText(page)).toBe(mainBefore.page);
  expect(await currentZoomText(page)).toBe(mainBefore.zoom);
  expect(await mainViewport.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }))).toEqual(mainBefore.scroll);
  expect(!(await page.getByRole("button", { name: "Back in document history" }).isVisible()))
    .toBe(mainBefore.backDisabled);
  expect(!(await page.getByRole("button", { name: "Forward in document history" }).isVisible()))
    .toBe(mainBefore.forwardDisabled);
});

test("returns an explored reference without moving main or browser history", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, "Reference return launch failed");

  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  const mainViewport = mainWorkspace.locator("[data-viewer-framing-viewport]");
  await expect(mainWorkspace.locator("[data-page-index='0']")).toBeVisible();
  const primaryLink = mainWorkspace.getByRole("button", {
    name: "Open PDF link to Primary result, Page 2",
  });
  await openLinkInReferences(page, primaryLink);

  const primaryTab = page.getByRole("tab", { name: /Primary result/u });
  await expectReferenceReady(page, primaryTab);
  const referenceWorkspace = page.locator("[data-reference-pdf-viewport]");
  const referenceViewport = referenceWorkspace.locator("[data-viewer-framing-viewport]");
  const originPage = referenceWorkspace.locator("[data-page-index='1']");
  const returnControl = page.getByRole("button", { name: "Return to reference" });
  await expect(originPage).toBeVisible();
  await expect(returnControl).toHaveCount(0);

  // Seed a second tab before exploration so the returned framing can be verified across a switch.
  const detailLink = referenceWorkspace.getByRole("button", {
    name: "Open PDF link to Target-to-target detail link, Page 3",
  });
  await detailLink.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await openLinkInReferences(page, detailLink);
  const detailTab = page.getByRole("tab", { name: /Target-to-target detail link/u });
  await expectReferenceReady(page, detailTab);
  await primaryTab.click();
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await expect(originPage).toBeVisible();

  const initialOriginWidth = await originPage.boundingBox().then((bounds) => bounds?.width ?? 0);
  expect(initialOriginWidth).toBeGreaterThan(0);
  const mainBefore = {
    page: await currentPageText(page),
    zoom: await currentZoomText(page),
    scroll: await mainViewport.evaluate((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
    })),
    url: page.url(),
    browserHistory: await page.evaluate(() => ({
      length: history.length,
      state: JSON.stringify(history.state),
    })),
    backDisabled: !(await page.getByRole("button", { name: "Back in document history" }).isVisible()),
    forwardDisabled: !(await page.getByRole("button", { name: "Forward in document history" }).isVisible()),
  };

  await referenceViewport.hover();
  const scrollBeforeWheel = await referenceViewport.evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, 24);
  await expect.poll(() => referenceViewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(scrollBeforeWheel);
  await expect(returnControl).toHaveCount(0);

  // Continue with real wheel input until the semantic origin leaves the viewport.
  for (let step = 0; step < 3; step += 1) {
    const scrollBeforeStep = await referenceViewport.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, 480);
    await expect.poll(() => referenceViewport.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(scrollBeforeStep);
  }
  await expect(returnControl).toBeVisible();

  let previousReferenceScroll = -1;
  let stableReferenceScrollSamples = 0;
  await expect.poll(async () => {
    const current = await referenceViewport.evaluate((element) => element.scrollTop);
    stableReferenceScrollSamples = Math.abs(current - previousReferenceScroll) < 0.5
      ? stableReferenceScrollSamples + 1
      : 0;
    previousReferenceScroll = current;
    return stableReferenceScrollSamples;
  }).toBeGreaterThanOrEqual(2);

  await clickHoverRevealedReferenceTabAction(
    page.getByRole("button", { name: "Return to reference" }),
  );
  await expect(page.locator(".review-workspace__status")).toHaveText("Returned to reference.");
  await expect(returnControl).toHaveCount(0);
  await expect(originPage).toBeFocused();
  await expect(originPage).toBeVisible();
  await expect.poll(() => originPage.boundingBox().then((bounds) => bounds?.width ?? 0))
    .toBeCloseTo(initialOriginWidth, 0);

  const returnedLocation = await Promise.all([
    referenceViewport.evaluate((element) => element.scrollTop),
    originPage.boundingBox(),
    referenceViewport.boundingBox(),
  ]).then(([scrollTop, pageBounds, viewportBounds]) => {
    if (!pageBounds || !viewportBounds) throw new Error("Returned Reference geometry is unavailable.");
    return {
      scrollTop,
      relativeTop: pageBounds.y - viewportBounds.y,
    };
  });
  await detailTab.click();
  await expect(detailTab).toHaveAttribute("aria-selected", "true");
  await primaryTab.click();
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await expect(returnControl).toHaveCount(0);
  await expect.poll(async () => {
    const [scrollTop, pageBounds, viewportBounds] = await Promise.all([
      referenceViewport.evaluate((element) => element.scrollTop),
      originPage.boundingBox(),
      referenceViewport.boundingBox(),
    ]);
    if (!pageBounds || !viewportBounds) return Number.POSITIVE_INFINITY;
    return Math.max(
      Math.abs(scrollTop - returnedLocation.scrollTop),
      Math.abs((pageBounds.y - viewportBounds.y) - returnedLocation.relativeTop),
    );
  }).toBeLessThan(3);

  expect(await currentPageText(page)).toBe(mainBefore.page);
  expect(await currentZoomText(page)).toBe(mainBefore.zoom);
  expect(await mainViewport.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }))).toEqual(mainBefore.scroll);
  expect(page.url()).toBe(mainBefore.url);
  expect(await page.evaluate(() => ({
    length: history.length,
    state: JSON.stringify(history.state),
  }))).toEqual(mainBefore.browserHistory);
  expect(!(await page.getByRole("button", { name: "Back in document history" }).isVisible()))
    .toBe(mainBefore.backDisabled);
  expect(!(await page.getByRole("button", { name: "Forward in document history" }).isVisible()))
    .toBe(mainBefore.forwardDisabled);
});

test("returns an explored reference after right and narrow layout reflow", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, "Reference return reflow launch failed");
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  await expect(mainWorkspace.locator("[data-page-index='0']")).toBeVisible();
  await openLinkInReferences(page, mainWorkspace.getByRole("button", {
    name: "Open PDF link to Primary result, Page 2",
  }));

  const primaryTab = page.getByRole("tab", { name: /Primary result/u });
  await expectReferenceReady(page, primaryTab);
  const stage = page.locator("[data-review-stage]");
  const referenceWorkspace = page.locator("[data-reference-pdf-viewport]");
  const referenceViewport = referenceWorkspace.locator("[data-viewer-framing-viewport]");
  const originPage = referenceWorkspace.locator("[data-page-index='1']");
  const returnControl = page.getByRole("button", { name: "Return to reference" });
  const driftFromOrigin = async () => {
    await referenceViewport.hover();
    for (let step = 0; step < 6 && await returnControl.count() === 0; step += 1) {
      const before = await referenceViewport.evaluate((element) => element.scrollTop);
      const maximum = await referenceViewport.evaluate((element) => (
        Math.max(0, element.scrollHeight - element.clientHeight)
      ));
      const direction = before >= maximum - 1 ? -1 : 1;
      await page.mouse.wheel(0, direction * 480);
      await expect.poll(() => referenceViewport.evaluate((element, previous) => (
        Math.abs(element.scrollTop - previous)
      ), before)).toBeGreaterThan(0);
    }
    await expect(returnControl).toBeVisible();
  };
  const returnAndExpectFocusedOrigin = async () => {
    await clickHoverRevealedReferenceTabAction(returnControl);
    await expect(page.locator(".review-workspace__status")).toHaveText("Returned to reference.");
    await expect(returnControl).toHaveCount(0);
    await expect(originPage).toBeVisible();
    await expect(originPage).toBeFocused();
  };

  await clickHoverRevealedReferenceDockAction(
    page.getByRole("button", { name: "Move References to right" }),
  );
  await expect(stage).toHaveAttribute("data-reference-layout", "wide-right");
  await driftFromOrigin();
  await returnAndExpectFocusedOrigin();

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(stage).toHaveAttribute("data-reference-layout", "narrow-unified");
  await driftFromOrigin();
  await returnAndExpectFocusedOrigin();
});

test("keeps main PDF link hit targets below an open References viewer", async ({ page }) => {
  await page.setViewportSize({ width: 1367, height: 1324 });
  await openFreshProductionFixture(page, referencePdf, "Reference layering launch failed");
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  await expect(mainWorkspace.locator("[data-page-index='0']")).toBeVisible();

  const primaryLink = mainWorkspace.getByRole("button", {
    name: "Open PDF link to Primary result, Page 2",
  });
  await openLinkInReferences(page, primaryLink);

  const referenceWorkspace = page.locator("[data-reference-pdf-viewport]");
  await expect(referenceWorkspace).toBeVisible();
  const referenceSurface = page.locator("[data-review-workspace]");
  const moveReferencesBottom = page.getByRole("button", { name: "Move References to bottom" });
  if (await moveReferencesBottom.isVisible()) {
    await clickHoverRevealedReferenceDockAction(moveReferencesBottom);
  }
  await expect(referenceSurface).toHaveAttribute("data-workspace-presentation", "bottom");
  await expect.poll(() => referenceSurface.evaluate((element) => getComputedStyle(element).transform))
    .toBe("none");
  const mainDetailLink = mainWorkspace.getByRole("button", {
    name: "Open PDF link to Target-to-target detail link, Page 3",
  });
  await expect(mainDetailLink).toBeAttached();
  await mainDetailLink.evaluate((element) => {
    const reference = document.querySelector<HTMLElement>("[data-reference-pdf-viewport]");
    const viewport = element.closest(".pdf-workspace")
      ?.querySelector<HTMLElement>("[data-viewer-framing-viewport]");
    if (!reference || !viewport) throw new Error("PDF viewer layers are unavailable.");
    const referenceBounds = reference.getBoundingClientRect();
    const linkBounds = element.getBoundingClientRect();
    const linkCenterY = linkBounds.top + linkBounds.height / 2;
    const referenceCenterY = referenceBounds.top + referenceBounds.height / 2;
    viewport.scrollTop += linkCenterY - referenceCenterY;
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  const hitState = await mainDetailLink.evaluate((element) => {
    const reference = document.querySelector<HTMLElement>("[data-reference-pdf-viewport]");
    if (!reference) throw new Error("Reference PDF viewer is unavailable.");
    const referenceBounds = reference.getBoundingClientRect();
    const linkBounds = element.getBoundingClientRect();
    const intersection = {
      left: Math.max(referenceBounds.left, linkBounds.left),
      right: Math.min(referenceBounds.right, linkBounds.right),
      top: Math.max(referenceBounds.top, linkBounds.top),
      bottom: Math.min(referenceBounds.bottom, linkBounds.bottom),
    };
    const overlap = intersection.right > intersection.left && intersection.bottom > intersection.top;
    if (!overlap) return { topmost: "no-overlap", referenceBounds, linkBounds };
    const hit = document.elementFromPoint(
      (intersection.left + intersection.right) / 2,
      (intersection.top + intersection.bottom) / 2,
    );
    const topmost = hit?.closest("[data-reference-pdf-viewport]")
      ? "reference"
      : hit?.closest(".pdf-workspace:not(.pdf-workspace--reference)") ? "main" : "workspace";
    return { topmost, referenceBounds, linkBounds };
  });

  expect(hitState).not.toEqual(expect.objectContaining({ topmost: "no-overlap" }));
  expect(hitState.topmost).not.toBe("main");
});

for (const width of [1280, 760]) {
  for (const destination of ['outline', 'search', 'annotation'] as const) {
    test(`keeps Back unpainted until toolbar interaction after ${destination} navigation at ${width}px`, async ({ page, browserName }) => {
      await page.setViewportSize({ width, height: 900 });
      await openFreshProductionFixture(
        page,
        destination === 'search' ? searchPdf : referencePdf,
        'Document history visibility launch failed',
        destination === 'annotation' ? async (sessionId) => {
          const state = host.broker.state(sessionId);
          if (!state) throw new Error('Annotation history state is missing');
          await host.broker.acceptMutation(sessionId, addPageNote(
            state, 2, { x: 80, y: 160, width: 18, height: 18 }, 'History visibility destination.',
          ));
        } : undefined,
      );
      await openAnnotationsWorkspace(page);
      let destinationButton: Locator;
      if (destination === 'outline') {
        await page.getByRole('tab', { name: 'Outline', exact: true }).click();
        destinationButton = page.getByRole('button', { name: 'Details, Page 3', exact: true });
      } else if (destination === 'search') {
        await page.getByRole('tab', { name: 'Search', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Search this PDF' }).fill('stable');
        const results = page.locator('[data-search-group="exact"] [data-search-result]');
        await expect(results).toHaveCount(2);
        destinationButton = results.nth(1).locator('.annotation-item__navigation');
      } else {
        destinationButton = page.locator('#workspace-panel-annotations').getByRole('button', {
          name: /^Page Note · Page 3 · .*History visibility destination\.$/u,
        }).first();
      }
      const targetPage = destination === 'search' ? '2' : '3';
      const [samples] = await Promise.all([
        page.evaluate(async (target) => new Promise<Array<{ clipPath: string; revealed: boolean }>>((resolve) => {
          const samples: Array<{ clipPath: string; revealed: boolean }> = [];
          const deadline = performance.now() + 5_000;
          let settledFrames = 0;
          const capture = () => {
            const bar = document.querySelector('[data-review-chrome]');
            const back = bar?.querySelector('[data-main-history="back"]');
            if (back) samples.push({
              clipPath: getComputedStyle(back).clipPath,
              revealed: bar!.matches(':hover, :has(:focus-visible)'),
            });
            const reached = document.querySelector<HTMLInputElement>('.review-chrome__page-input')?.value === target;
            settledFrames = back && reached ? settledFrames + 1 : 0;
            if (settledFrames >= 12 || performance.now() >= deadline) resolve(samples);
            else requestAnimationFrame(capture);
          };
          requestAnimationFrame(capture);
        }), targetPage),
        destinationButton.click(),
      ]);
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every(({ clipPath, revealed }) => clipPath === 'inset(50%)' && !revealed)).toBe(true);
      const pageInput = page.locator('.review-chrome__page-input');
      await expect(pageInput).toHaveValue(targetPage);
      const bar = page.locator('[data-review-chrome]');
      const back = bar.locator('[data-main-history="back"]');
      await bar.hover({ position: { x: 2, y: 2 } });
      await expect(back).toHaveCSS('clip-path', 'none');
      await page.locator('.pdf-workspace:not(.pdf-workspace--reference)').hover({ position: { x: 30, y: 100 } });
      await expect(back).toHaveCSS('clip-path', 'inset(50%)');
      // Keyboard entry through the page control reveals history without
      // removing its buttons from the normal tab order.
      await pageInput.focus();
      const tabKey = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
      await page.keyboard.press(tabKey);
      await expect(back).toHaveCSS('clip-path', 'none');
      for (let steps = 0; steps < 5 && !await back.evaluate((element) => element === document.activeElement); steps += 1) {
        await page.keyboard.press(tabKey);
      }
      await expect(back).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(pageInput).toHaveValue('1');
      await expect(bar.locator('[data-main-history="forward"]')).toHaveCSS('clip-path', 'inset(50%)');
      await bar.hover({ position: { x: 2, y: 2 } });
      await page.getByRole('button', { name: 'Forward in document history', exact: true }).click();
      await expect(pageInput).toHaveValue(targetPage);
    });
  }
}

test("records annotation tray jumps in document history", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(
    page,
    referencePdf,
    "Annotation history launch failed",
    async (sessionId) => {
      const initialState = host.broker.state(sessionId);
      if (!initialState) throw new Error("Annotation history review state is missing");
      await host.broker.acceptMutation(
        sessionId,
        addPageNote(
          initialState,
          2,
          { x: 80, y: 160, width: 18, height: 18 },
          "History destination.",
        ),
      );
    },
  );
  await expect.poll(() => currentPageText(page)).toBe("1 / 4");

  await openAnnotationsWorkspace(page);
  const annotationsPanel = page.locator('#workspace-panel-annotations');
  const pageThreeAnnotation = annotationsPanel.getByRole("button", {
    name: /^Page Note · Page 3 · .*History destination\.$/u,
  }).first();
  await expect(pageThreeAnnotation).toBeVisible();
  const pageThreeCopyLink = annotationsPanel.getByRole("button", {
    name: "Copy link to Page Note annotation on page 3",
  });
  await expect(pageThreeCopyLink).toBeVisible();
  await expect(pageThreeCopyLink).toBeDisabled();
  await expect(pageThreeCopyLink).toHaveAttribute(
    "title",
    "Save annotation before copying its link",
  );

  const back = page.getByRole("button", { name: "Back in document history" });
  const forward = page.getByRole("button", { name: "Forward in document history" });
  await expect(back).toHaveCount(0);
  await pageThreeAnnotation.click();
  await expect.poll(() => currentPageText(page)).toBe("3 / 4");
  await expect(back).toBeEnabled();

  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await back.click();
  await expect.poll(() => currentPageText(page)).toBe("1 / 4");
  await expect(forward).toBeEnabled();

  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await forward.click();
  await expect.poll(() => currentPageText(page)).toBe("3 / 4");
});

for (const seededAnnotation of [false, true]) {
  test(`opens the annotations tray without moving the PDF${seededAnnotation ? ' when annotations exist' : ''}`, async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 900 });
    await openFreshProductionFixture(
      page,
      referencePdf,
      'Passive annotations launch failed',
      seededAnnotation
        ? async (sessionId) => {
            const initialState = host.broker.state(sessionId);
            if (!initialState) throw new Error('Passive annotations review state is missing');
            await host.broker.acceptMutation(
              sessionId,
              addPageNote(
                initialState,
                0,
                { x: 80, y: 160, width: 18, height: 18 },
                'Do not navigate here when the tray opens.',
              ),
            );
          }
        : undefined,
    );

    const workspace = await currentWorkspaceRail(page);
    await workspace.click();
    await page.getByRole('tab', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Search', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await page.locator('[data-review-stage]').evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
    });
    const viewport = page.locator('[data-viewer-framing-viewport]');
    await expect(viewport).toHaveCount(1);
    // Exercise user scrolling so the framing controller records the reading position.
    await viewport.hover({ position: { x: 100, y: 100 } });
    await page.mouse.wheel(0, 420);
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const readingTop = await viewport.evaluate(async element => {
      let previous = element.scrollTop;
      let stableFrames = 0;
      while (stableFrames < 3) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        stableFrames = element.scrollTop === previous ? stableFrames + 1 : 0;
        previous = element.scrollTop;
      }
      return previous;
    });
    expect(readingTop).toBeGreaterThan(0);

    await page.getByRole('tab', { name: 'Annotations', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Annotations', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect.poll(() => viewport.evaluate((element, expected) => (
      Math.abs(element.scrollTop - expected)
    ), readingTop)).toBeLessThan(1);
  });
}

test("settles tray copy actions without selection or tooltip flashes", async ({ page }) => {
  await page.addInitScript(() => {
    const copyState = globalThis as typeof globalThis & {
      __holdTrayCopy?: boolean;
      __releaseTrayCopy?: () => void;
    };
    copyState.__holdTrayCopy = true;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          if (!copyState.__holdTrayCopy) return;
          await new Promise<void>((resolve) => { copyState.__releaseTrayCopy = resolve; });
        },
      },
    });
  });
  await openFreshProductionFixture(
    page,
    annotatedReferencePdf,
    "Tray copy focus launch failed",
  );

  await openAnnotationsWorkspace(page);
  const annotationRow = page.locator('[data-review-item]').first();
  const annotationId = await annotationRow.getAttribute('data-review-item');
  if (!annotationId) throw new Error('Owned annotation row has no stable id.');
  const annotationMark = page.locator(`[data-owned-mark][data-review-id="${annotationId}"]`);
  const annotationCopy = annotationRow.getByRole('button', {
    name: 'Copy link to Delete annotation on page 1',
  });
  await expect(annotationCopy).toBeEnabled();
  await expect(annotationCopy).not.toHaveAttribute('title');
  await annotationRow.hover();
  await annotationCopy.click();
  await expect(annotationCopy.locator('..')).toHaveAttribute('data-copy-link-status', 'pending');
  await expect(annotationCopy).toBeEnabled();
  await expect(annotationCopy).toBeFocused();
  await page.mouse.move(0, 0);
  await expect(annotationCopy).toBeFocused();
  await expect(annotationRow).not.toHaveAttribute('data-active', 'true');
  await expect(annotationRow).toHaveAttribute('data-corresponding', 'false');
  await expect(annotationMark).not.toHaveAttribute('data-corresponding', 'true');
  await expect(annotationRow).toHaveCSS('outline-style', 'none');
  await page.evaluate(() => {
    const copyState = globalThis as typeof globalThis & {
      __holdTrayCopy?: boolean;
      __releaseTrayCopy?: () => void;
    };
    copyState.__holdTrayCopy = false;
    copyState.__releaseTrayCopy?.();
  });
  await expect(annotationCopy.locator('..')).toHaveAttribute('data-copy-link-status', 'success');
  await expect(annotationCopy).not.toBeFocused();
  await expect(annotationCopy.locator('.row-action-group__direct')).toHaveCount(0);
  await expect(annotationRow.locator('.row-action-group__direct')).toHaveCSS('opacity', '0');

  await annotationRow.locator('.annotation-item__content').click();
  await page.getByLabel('Current page').hover();
  await expect(annotationRow).toHaveAttribute('data-active', 'true');
  const annotationActiveBackground = await annotationRow.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = getComputedStyle(element)
      .getPropertyValue('--review-surface-panel')
      .trim();
    document.body.append(probe);
    const normalized = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return normalized;
  });
  await expect(annotationRow).toHaveCSS('background-color', annotationActiveBackground);
  await annotationRow.hover();
  await page.getByLabel('Current page').hover();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(annotationRow).toHaveCSS('background-color', annotationActiveBackground);

  await page.getByRole('tab', { name: 'Outline', exact: true }).click();
  await expect(page.locator('#workspace-panel-outline')).toBeFocused();
  const overview = page.getByRole('button', { name: 'Overview, Page 2', exact: true });
  const outlineRow = overview.locator('..');
  await overview.focus();
  const outlineCopy = outlineRow.getByRole('button', {
    name: 'Copy exact destination link for Overview, Page 2',
  });
  await expect(outlineCopy).not.toHaveAttribute('title');
  await page.evaluate(() => {
    const copyState = globalThis as typeof globalThis & {
      __holdTrayCopy?: boolean;
      __releaseTrayCopy?: () => void;
    };
    copyState.__holdTrayCopy = true;
    delete copyState.__releaseTrayCopy;
  });
  await outlineRow.hover();
  await outlineCopy.click();
  await expect(outlineCopy.locator('..')).toHaveAttribute('data-copy-link-status', 'pending');
  await expect(outlineCopy).toBeEnabled();
  await expect(outlineCopy).toBeFocused();
  await page.mouse.move(0, 0);
  await expect(outlineCopy).toBeFocused();
  await page.evaluate(() => {
    const copyState = globalThis as typeof globalThis & {
      __holdTrayCopy?: boolean;
      __releaseTrayCopy?: () => void;
    };
    copyState.__holdTrayCopy = false;
    copyState.__releaseTrayCopy?.();
  });
  await expect(outlineCopy.locator('..')).toHaveAttribute('data-copy-link-status', 'success');
  await expect(outlineCopy).not.toBeFocused();
  await expect(outlineRow).not.toHaveAttribute('data-current', 'true');
  await expect(outlineRow).toHaveCSS('outline-style', 'none');
  const outlineActions = outlineRow.locator('.row-action-group__direct');
  await expect(outlineActions).toHaveCSS('opacity', '0');

  await outlineCopy.focus();
  await outlineCopy.press('Enter');
  await expect(outlineCopy.locator('..')).toHaveAttribute('data-copy-link-status', 'success');
  await expect(outlineCopy).toBeFocused();
  await expect(outlineActions).toHaveCSS('opacity', '1');
});

test("switches and sends references from the right-docked workspace", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, "Right-docked reference launch failed");
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  await expect(mainWorkspace.locator("[data-page-index='0']")).toBeVisible();

  const primaryLink = mainWorkspace.getByRole("button", {
    name: "Open PDF link to Primary result, Page 2",
  });
  await openLinkInReferences(page, primaryLink);
  const workspace = page.locator("[data-review-workspace]");
  const primaryTab = page.getByRole("tab", { name: /Primary result/u });
  await expectReferenceReady(page, primaryTab);

  const referenceWorkspace = page.locator("[data-reference-pdf-viewport]");
  const referenceViewport = referenceWorkspace.locator("[data-viewer-framing-viewport]");
  await expect(referenceWorkspace.locator("[data-page-index='1']")).toBeVisible();
  await referenceViewport.evaluate((element) => { element.scrollTop += 96; });
  const detailLink = referenceWorkspace.getByRole("button", {
    name: "Open PDF link to Target-to-target detail link, Page 3",
  });
  await detailLink.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await openLinkInReferences(page, detailLink);
  const detailTab = page.getByRole("tab", { name: /Target-to-target detail link/u });
  await expectReferenceReady(page, detailTab);
  await clickHoverRevealedReferenceDockAction(
    page.getByRole("button", { name: "Move References to right" }),
  );
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "right");
  await expect.poll(() => workspace.evaluate((element) => getComputedStyle(element).transform))
    .toBe("none");
  await workspace.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
  });
  const rightTabGeometry = await page.getByRole("tablist", { name: "Open references" })
    .evaluate((tablist) => [...tablist.querySelectorAll<HTMLElement>(
      '[data-reference-tab-segment]',
    )].map((segment) => {
      const selector = segment.querySelector<HTMLElement>('[data-reference-tab]');
      const actions = [...segment.querySelectorAll<HTMLElement>('[data-reference-tab-action]')];
      const bounds = segment.getBoundingClientRect();
      return {
        width: bounds.width,
        selectorWidth: selector?.getBoundingClientRect().width ?? 0,
        actionSizes: actions.map((action) => {
          const actionBounds = action.getBoundingClientRect();
          return {
            width: actionBounds.width,
            height: actionBounds.height,
            verticalInset: (bounds.height - actionBounds.height) / 2,
            borderRadius: getComputedStyle(action).borderRadius,
          };
        }),
      };
    }));
  expect(rightTabGeometry).toHaveLength(2);
  // Horizontal tabs size to their labels, with the longer title capped at 184px.
  expect(rightTabGeometry[0]!.width).toBeLessThan(rightTabGeometry[1]!.width);
  expect(rightTabGeometry[1]!.width).toBeCloseTo(184, 0);
  expect(rightTabGeometry[1]!.selectorWidth).toBeLessThan(rightTabGeometry[1]!.width - 50);
  expect(rightTabGeometry[1]!.actionSizes).toHaveLength(2);
  for (const action of rightTabGeometry[1]!.actionSizes) {
    expect(action.width).toBeCloseTo(26, 0);
    expect(action.height).toBeCloseTo(26, 0);
    expect(action.verticalInset).toBeGreaterThanOrEqual(3);
    expect(action.borderRadius).not.toBe('0px');
  }

  await primaryTab.click();
  await expect(page.locator(".review-workspace__status")).toHaveText("Reference active.");
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await detailTab.click();
  await expect(page.locator(".review-workspace__status")).toHaveText("Reference active.");
  await expect(detailTab).toHaveAttribute("aria-selected", "true");
  const detailPage = referenceWorkspace.locator("[data-page-index='2']");
  await detailPage.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect.poll(async () => {
    const [viewportBounds, pageBounds] = await Promise.all([
      referenceViewport.boundingBox(),
      detailPage.boundingBox(),
    ]);
    if (!viewportBounds || !pageBounds) return Number.POSITIVE_INFINITY;
    return Math.abs(
      (viewportBounds.y + viewportBounds.height / 2)
      - (pageBounds.y + pageBounds.height / 2),
    );
  }).toBeLessThan(2);

  await clickHoverRevealedReferenceTabAction(
    page.getByRole("button", { name: "Open in main document" }),
  );
  await expect(page.locator(".review-workspace__status")).toHaveText(
    "Reference sent to the main document.",
  );
  await expect(workspace).toHaveAttribute("data-workspace-open", "true");
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "right");
  await expect.poll(() => currentPageText(page)).toBe("3 / 4");
  await expect(detailTab).toHaveCount(0);
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await expect(referenceWorkspace.locator("[data-page-index='1']")).toBeVisible();
});

test("keeps compound reference actions in narrow keyboard order through survivor and final close", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, "Narrow compound reference launch failed");
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  await expect(mainWorkspace.locator("[data-page-index='0']")).toBeVisible();

  const primaryLink = mainWorkspace.getByRole("button", {
    name: "Open PDF link to Primary result, Page 2",
  });
  await openLinkInReferences(page, primaryLink);

  const referenceWorkspace = page.locator("[data-reference-pdf-viewport]");
  const primaryTab = page.getByRole("tab", { name: /Primary result/u });
  await expectReferenceReady(page, primaryTab);
  await expect(primaryTab).toBeFocused();
  const referenceViewport = referenceWorkspace.locator("[data-viewer-framing-viewport]");
  await referenceViewport.evaluate((element) => { element.scrollTop += 96; });
  await expect.poll(() => referenceViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const detailLink = referenceWorkspace.getByRole("button", {
    name: "Open PDF link to Target-to-target detail link, Page 3",
  });
  await detailLink.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await openLinkInReferences(page, detailLink);

  await page.setViewportSize({ width: 760, height: 900 });

  const stage = page.locator("[data-review-stage]");
  const workspace = page.locator("[data-review-workspace]");
  const detailTab = page.getByRole("tab", { name: /Target-to-target detail link/u });
  await expectReferenceReady(page, detailTab);
  await expect(stage).toHaveAttribute("data-reference-layout", "narrow-unified");
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  const detailPage = referenceWorkspace.locator("[data-page-index='2']");
  await detailPage.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect.poll(async () => {
    const [viewportBounds, pageBounds] = await Promise.all([
      referenceViewport.boundingBox(),
      detailPage.boundingBox(),
    ]);
    if (!viewportBounds || !pageBounds) return Number.POSITIVE_INFINITY;
    if (pageBounds.height <= 0) return Number.POSITIVE_INFINITY;
    return Math.abs(
      (viewportBounds.y + viewportBounds.height / 2)
      - (pageBounds.y + pageBounds.height / 2),
    ) / (pageBounds.height / 2);
  }).toBeLessThan(1);

  await detailTab.focus();
  await expect(detailTab).toBeFocused();
  const forwardTab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  const backwardTab = browserName === 'webkit' ? 'Shift+Alt+Tab' : 'Shift+Tab';
  await page.keyboard.press(forwardTab);
  const detailSend = page.getByRole("button", { name: "Open in main document" });
  await expect(detailSend).toBeFocused();
  await page.keyboard.press(forwardTab);
  await expect(page.getByRole("button", { name: "Close active reference" })).toBeFocused();
  await page.keyboard.press(backwardTab);
  await expect(detailSend).toBeFocused();
  await detailSend.press("Enter");

  await expect.poll(() => currentPageText(page)).toBe("3 / 4");
  await expect(page.locator(".review-workspace__status")).toHaveText(
    "Reference sent to the main document.",
  );
  await expect(detailTab).toHaveCount(0);
  await expect(workspace).toHaveAttribute("data-workspace-open", "true");
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await expect(primaryTab).toBeFocused();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  const finalClose = page.getByRole("button", { name: "Close active reference" });
  await finalClose.press("Enter");

  await expect(page.getByRole("tablist", { name: "Open references", includeHidden: true })).toHaveCount(0);
  await expect(workspace).toHaveAttribute("data-workspace-open", "false");
  const reopenTools = page.getByRole("button", { name: "Show workspace" });
  await expect(reopenTools).toBeFocused();
  await reopenTools.click();
  await expect(page.getByRole("tab", { name: "References", exact: true })).toHaveCount(0);
});

test("keeps compound reference actions touch sized for coarse pointers", async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 320, height: 900 },
  });
  const page = await context.newPage();
  try {
    await openFreshProductionFixture(page, referencePdf, "Coarse-pointer reference launch failed");
    const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
    await expect(mainWorkspace.locator("[data-page-index='0']")).toBeVisible();
    await (await currentWorkspaceRail(page)).click();
    const outline = page.getByRole("navigation", { name: "Document outline" });
    const outlineActions = outline.getByRole("button", {
      name: "Secondary actions for Details, Page 3",
    });
    await expect(outlineActions).toHaveAttribute("aria-haspopup", "menu");
    await expect(outlineActions).toHaveAttribute("aria-expanded", "false");
    const controlledMenuId = await outlineActions.getAttribute("aria-controls");
    expect(controlledMenuId).toMatch(/^row-actions-menu-/u);
    const outlineActionBounds = await outlineActions.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    });
    expect(outlineActionBounds.width).toBeCloseTo(44, 2);
    expect(outlineActionBounds.height).toBeCloseTo(44, 2);
    const disclosure = outline.getByRole("button", { name: "Collapse Details" });
    const disclosureBounds = await disclosure.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    });
    expect(disclosureBounds.width).toBeCloseTo(44, 2);
    expect(disclosureBounds.height).toBeCloseTo(44, 2);
    const coarseTreeGeometry = await outline.evaluate((navigator) => {
      const branchRow = navigator.querySelector<HTMLElement>(".outline-navigator__row");
      const leafRow = navigator.querySelector<HTMLElement>(
        ".outline-navigator__children .outline-navigator__row",
      );
      const spacer = leafRow?.querySelector<HTMLElement>(
        ".outline-navigator__disclosure-spacer",
      );
      if (!branchRow || !leafRow || !spacer) throw new Error("Coarse outline geometry is incomplete.");
      const navigatorBounds = navigator.getBoundingClientRect();
      const leafBounds = leafRow.getBoundingClientRect();
      const spacerBounds = spacer.getBoundingClientRect();
      return {
        columns: getComputedStyle(branchRow).gridTemplateColumns.split(" ").map(Number.parseFloat),
        spacer: { width: spacerBounds.width, height: spacerBounds.height },
        contained: leafBounds.left >= navigatorBounds.left && leafBounds.right <= navigatorBounds.right,
        noHorizontalOverflow: navigator.scrollWidth <= navigator.clientWidth,
      };
    });
    expect(coarseTreeGeometry.columns).toHaveLength(3);
    expect(coarseTreeGeometry.columns[0]).toBe(52);
    expect(coarseTreeGeometry.columns[2]).toBe(64);
    expect(coarseTreeGeometry).toMatchObject({
      contained: true,
      noHorizontalOverflow: true,
    });
    expect(coarseTreeGeometry.spacer.width).toBeCloseTo(44, 2);
    expect(coarseTreeGeometry.spacer.height).toBeCloseTo(44, 2);
    await outlineActions.click();
    await expect(outlineActions).toHaveAttribute("aria-expanded", "true");
    const outlineMenu = page.getByRole("menu", { name: "Actions for Details, Page 3" });
    await expect(outlineMenu).toHaveAttribute("id", controlledMenuId ?? "");
    await expect(outlineMenu.getByRole("menuitem")).toHaveCount(2);
    await expect(outlineMenu.getByRole("menuitem", {
      name: "Copy exact destination link for Details, Page 3",
    }).locator(".lucide-link")).toBeVisible();
    const openDetails = outlineMenu.getByRole("menuitem", {
      name: "Open Details, Page 3 in References",
    });
    await expect(openDetails).toBeFocused();
    await page.keyboard.press("Enter");
    await expectReferenceReady(page, page.getByRole("tab", { name: /Details, Page 3/u }));

    const actions = page.locator("[data-reference-tab-action]");
    await expect(actions).toHaveCount(2);
    const sizes = await actions.evaluateAll((buttons) => buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    }));
    expect(sizes).toEqual([
      { width: 44, height: 44 },
      { width: 44, height: 44 },
    ]);
    const activityStrips = page.locator(
      '.review-workspace__header:visible > .review-workspace__activity-strip',
    );
    await expect(activityStrips).toHaveCount(1);
    const stripGeometry = await activityStrips.evaluateAll((strips) => strips.map((strip) => {
      const header = strip.closest<HTMLElement>('.review-workspace__header');
      if (!header) throw new Error('Activity strip has no workspace header.');
      const stripBounds = strip.getBoundingClientRect();
      const headerBounds = header.getBoundingClientRect();
      const tabs = [...strip.querySelectorAll<HTMLElement>('[role="tab"]')];
      return {
        topContained: stripBounds.top >= headerBounds.top,
        bottomContained: stripBounds.bottom <= headerBounds.bottom,
        tabs: tabs.map((tab) => {
          const bounds = tab.getBoundingClientRect();
          return {
            height: bounds.height,
            width: bounds.width,
            selected: tab.getAttribute('aria-selected') === 'true',
          };
        }),
      };
    }));
    expect(stripGeometry.every(({ topContained, bottomContained }) => (
      topContained && bottomContained
    ))).toBe(true);
    expect(stripGeometry.flatMap(({ tabs }) => tabs)
      .every(({ height, width }) => height === 44 && width >= 44)).toBe(true);
    expect(stripGeometry.flatMap(({ tabs }) => tabs)
      .filter(({ selected }) => !selected)
      .every(({ width }) => width === 44)).toBe(true);
  } finally {
    await context.close();
  }
});

test("keeps outline and rejected link metadata inert inside the installed local session", async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const contactedOrigins = new Set<string>();
  page.on("request", (request) => contactedOrigins.add(new URL(request.url()).origin));
  const opened = await openFreshProductionFixture(
    page,
    referencePdf,
    "Reference safety launch failed",
  );
  const sessionOrigin = new URL(opened.url).origin;
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  await expect(mainWorkspace.locator("[data-page-index='0']")).toBeVisible();
  await mainWorkspace.evaluate((element) => element.setAttribute("data-safety-main-mount", "stable"));

  const workspaceControl = await currentWorkspaceRail(page);
  await workspaceControl.click();
  const workspace = page.locator("#review-tools-workspace");
  await expect(workspace).toHaveAttribute("data-tools-workspace-open", "true");
  await expect(workspace).toHaveCSS('transform', 'none');
  await expect(page.getByRole("tab", { name: "Outline" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole('button', { name: 'Close workspace' })).toHaveCount(0);
  const outline = page.getByRole("navigation", { name: "Document outline" });
  await expect(outline).toBeVisible();
  const detailsDisclosure = outline.locator(".outline-navigator__disclosure");
  await expect(detailsDisclosure).toHaveAccessibleName("Collapse Details");
  await expect(detailsDisclosure).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(outline.getByRole("button", {
    name: "Nested result, Page 3",
    exact: true,
  })).toBeVisible();
  const hostileOutline = outline.getByRole("button", {
    name: "scriptalert(1)/script hostile outline, Page 2",
    exact: true,
  });
  await expect(hostileOutline).toBeVisible();
  await expect(outline.locator("script,img")).toHaveCount(0);
  expect(await hostileOutline.textContent()).not.toMatch(/[<>\u202e\u0000]/u);

  const details = outline.getByRole("button", { name: "Details, Page 3", exact: true });
  const detailsReference = outline.getByRole("button", {
    name: "Open Details, Page 3 in References",
  });
  const nestedReference = outline.getByRole("button", {
    name: "Open Nested result, Page 3 in References",
  });
  const detailsRow = details.locator("..");
  const openDetailsInReferences = async () => {
    await details.focus();
    if (await detailsReference.isVisible()) {
      await detailsReference.click();
      return;
    }
    await detailsRow.getByRole("button", {
      name: "Secondary actions for Details, Page 3",
    }).click();
    await page.getByRole("menu", { name: "Actions for Details, Page 3" }).getByRole(
      "menuitem",
      { name: "Open Details, Page 3 in References" },
    ).click();
  };
  await page.mouse.move(0, 0);
  await expect(detailsRow.locator(".row-action-group__direct")).toHaveCSS("opacity", "0");

  const nestedDestination = outline.getByRole("button", {
    name: "Nested result, Page 3",
    exact: true,
  });
  const nestedRow = nestedDestination.locator("..");
  await expect(nestedRow.locator(".row-action-group__direct")).toHaveCSS("opacity", "0");
  const detailsChildrenId = await detailsDisclosure.getAttribute("aria-controls");
  if (!detailsChildrenId) throw new Error("Details disclosure does not control an outline branch.");
  const detailsChildren = outline.locator(`[id="${detailsChildrenId}"]`);

  const quietRowStyle = await nestedRow.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      borderStyle: style.borderStyle,
      borderWidth: style.borderWidth,
      controlRadius: style.getPropertyValue("--review-radius-control").trim(),
      padding: style.padding,
    };
  });
  expect(quietRowStyle).toEqual({
    backgroundColor: "rgba(0, 0, 0, 0)",
    borderRadius: quietRowStyle.controlRadius,
    borderStyle: "none",
    borderWidth: "0px",
    controlRadius: "9px",
    padding: "0px 4px",
  });

  const expandedBranchGeometry = await detailsChildren.evaluate((children) => {
    const parentRow = children.previousElementSibling as HTMLElement | null;
    const childRows = Array.from(
      children.querySelectorAll<HTMLElement>(":scope > ul > li > .outline-navigator__row"),
    );
    if (!parentRow || childRows.length < 2) throw new Error("Outline branch rhythm is incomplete.");
    const parentBounds = parentRow.getBoundingClientRect();
    const firstChildBounds = childRows[0]!.getBoundingClientRect();
    const secondChildBounds = childRows[1]!.getBoundingClientRect();
    const style = getComputedStyle(children);
    const parentLabel = parentRow.querySelector<HTMLElement>(".outline-navigator__title");
    const childLabel = childRows[0]!.querySelector<HTMLElement>(".outline-navigator__title");
    if (!parentLabel || !childLabel) throw new Error("Outline branch labels are incomplete.");
    return {
      borderLeftStyle: style.borderLeftStyle,
      borderLeftWidth: style.borderLeftWidth,
      childToChild: secondChildBounds.top - firstChildBounds.bottom,
      labelIndent: childLabel.getBoundingClientRect().left
        - parentLabel.getBoundingClientRect().left,
      parentToFirstChild: firstChildBounds.top - parentBounds.bottom,
    };
  });
  expect(expandedBranchGeometry.borderLeftStyle).toBe("none");
  expect(expandedBranchGeometry.borderLeftWidth).toBe("0px");
  expect(expandedBranchGeometry.labelIndent).toBeCloseTo(14, 0);
  expect(expandedBranchGeometry.parentToFirstChild).toBeCloseTo(4, 0);
  expect(expandedBranchGeometry.childToChild).toBeCloseTo(4, 0);

  const detailsLabel = details.locator(".outline-navigator__title");
  const expandedLabelX = (await detailsLabel.boundingBox())?.x;
  if (expandedLabelX === undefined) throw new Error("Details label has no expanded bounds.");
  const expandedCaretTransform = await detailsDisclosure.locator(".review-icon")
    .evaluate((icon) => getComputedStyle(icon).transform);
  expect(expandedCaretTransform).not.toBe("none");
  await detailsDisclosure.click();
  await expect(detailsDisclosure).toHaveAttribute("aria-expanded", "false");
  await expect(detailsDisclosure.locator(".review-icon")).toHaveCSS("transform", "none");
  await expect(detailsChildren).toHaveAttribute("hidden", "");
  await expect(detailsChildren).toHaveAttribute("inert", "");
  await expect(detailsChildren).toBeHidden();
  expect(await detailsChildren.evaluate((children) => children.getClientRects().length)).toBe(0);
  expect((await detailsLabel.boundingBox())?.x).toBeCloseTo(expandedLabelX, 0);
  await detailsDisclosure.click();
  await expect(detailsDisclosure).toHaveAttribute("aria-expanded", "true");
  await expect(detailsDisclosure.locator(".review-icon")).toHaveCSS(
    "transform",
    expandedCaretTransform,
  );
  await expect(detailsChildren).toBeVisible();
  await expect(detailsChildren).toHaveCSS("border-left-width", "0px");
  await expect(detailsChildren).toHaveCSS("border-left-style", "none");
  expect((await detailsLabel.boundingBox())?.x).toBeCloseTo(expandedLabelX, 0);

  const forwardTab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  await detailsDisclosure.focus();
  await page.keyboard.press(forwardTab);
  await expect(details).toBeFocused();
  await page.keyboard.press(forwardTab);
  await expect(detailsReference).toBeFocused();

  await page.getByLabel("Current page").focus();
  await nestedRow.hover();
  await expect(nestedRow).toHaveCSS("background-color", "rgb(231, 231, 231)");
  await expect(detailsRow).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(nestedRow.locator(".row-action-group__direct")).toHaveCSS("opacity", "1");
  await expect(detailsRow.locator(".row-action-group__direct")).toHaveCSS("opacity", "0");
  await page.mouse.move(0, 0);
  await nestedDestination.focus();
  await expect(nestedRow).toHaveCSS("background-color", "rgb(231, 231, 231)");
  await expect(detailsRow).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(nestedRow.locator(".row-action-group__direct")).toHaveCSS("opacity", "1");

  const pageMetadataGeometry = await details.evaluate((destination) => {
    const summary = destination.querySelector<HTMLElement>(".outline-navigator__summary");
    const label = destination.querySelector<HTMLElement>(".outline-navigator__title");
    const pageNumber = destination.querySelector<HTMLElement>(".outline-navigator__page");
    if (!summary || !label || !pageNumber) throw new Error("Outline page metadata is incomplete.");
    const labelText = document.createRange();
    labelText.selectNodeContents(label);
    const summaryBounds = summary.getBoundingClientRect();
    const pageBounds = pageNumber.getBoundingClientRect();
    return {
      gap: pageBounds.left - labelText.getBoundingClientRect().right,
      trailing: summaryBounds.right - pageBounds.right,
    };
  });
  expect(pageMetadataGeometry.gap).toBeGreaterThanOrEqual(10);
  expect(pageMetadataGeometry.trailing).toBeCloseTo(-6, 0);

  await page.keyboard.press(forwardTab);
  await expect(nestedReference).toBeFocused();
  await expect(nestedReference).toHaveCSS("opacity", "1");
  await expect(nestedReference).toHaveCSS("outline-style", "solid");

  const detailsDirect = detailsRow.locator(".row-action-group__direct");
  const detailsSecondary = detailsRow.locator(".row-action-group__secondary");
  await detailsRow.evaluate((element) => { element.style.width = "273px"; });
  await expect(detailsDirect).toHaveCSS("display", "flex");
  await expect(detailsSecondary).toHaveCSS("display", "none");
  await detailsRow.evaluate((element) => { element.style.width = "271px"; });
  await expect(detailsDirect).toHaveCSS("display", "flex");
  await expect(detailsSecondary).toHaveCSS("display", "none");
  await detailsRow.evaluate((element) => { element.style.removeProperty("width"); });

  await outline.evaluate((element) => { element.style.width = "190px"; });
  const fineDisclosureGeometry = await detailsDisclosure.evaluate((button) => {
    const icon = button.querySelector<SVGElement>(".review-icon");
    if (!icon) throw new Error("Outline disclosure icon is missing.");
    const buttonBounds = button.getBoundingClientRect();
    const iconBounds = icon.getBoundingClientRect();
    return {
      height: buttonBounds.height,
      iconCenterDeltaX: Math.abs(
        (buttonBounds.left + (buttonBounds.width / 2)) - (iconBounds.left + (iconBounds.width / 2)),
      ),
      iconCenterDeltaY: Math.abs(
        (buttonBounds.top + (buttonBounds.height / 2)) - (iconBounds.top + (iconBounds.height / 2)),
      ),
      marginLeft: getComputedStyle(button).marginLeft,
      width: buttonBounds.width,
    };
  });
  expect(fineDisclosureGeometry).toMatchObject({
    height: 34,
    marginLeft: "0px",
    width: 28,
  });
  expect(fineDisclosureGeometry.iconCenterDeltaX).toBeLessThanOrEqual(1);
  expect(fineDisclosureGeometry.iconCenterDeltaY).toBeLessThanOrEqual(1);

  const hostileRow = hostileOutline.locator("..");
  await hostileRow.hover();
  const hostileDirectActions = hostileRow.locator(".row-action-group__direct");
  await expect(hostileDirectActions).toHaveCSS("display", "flex");
  await expect(hostileDirectActions).toHaveCSS("opacity", "1");
  await expect(hostileDirectActions.getByRole("button")).toHaveCount(2);
  await expect(hostileRow.locator(".row-action-group__secondary")).toHaveCSS("display", "none");

  const nestedLongLabelGeometry = await hostileRow.evaluate((row) => {
    const destination = row?.querySelector<HTMLElement>(".outline-navigator__destination");
    const spacer = row?.querySelector<HTMLElement>(".outline-navigator__disclosure-spacer");
    const summary = destination?.querySelector<HTMLElement>(".outline-navigator__summary");
    const label = destination?.querySelector<HTMLElement>(".outline-navigator__title");
    const pageNumber = destination?.querySelector<HTMLElement>(".outline-navigator__page");
    const actions = row.querySelector<HTMLElement>(".row-action-group");
    const navigator = row?.closest<HTMLElement>(".outline-navigator");
    if (!destination || !spacer || !summary || !label || !pageNumber || !actions || !navigator) {
      throw new Error("Outline row geometry is incomplete.");
    }
    const navigatorBounds = navigator.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    const destinationBounds = destination.getBoundingClientRect();
    const summaryBounds = summary.getBoundingClientRect();
    const actionBounds = actions.getBoundingClientRect();
    const spacerBounds = spacer.getBoundingClientRect();
    const labelText = document.createRange();
    labelText.selectNodeContents(label);
    const pageBounds = pageNumber.getBoundingClientRect();
    const rowStyle = getComputedStyle(row);
    const destinationStyle = getComputedStyle(destination);
    const labelStyle = getComputedStyle(label);
    return {
      actionRightInset: rowBounds.right - actionBounds.right,
      actionWidth: actionBounds.width,
      contained: rowBounds.left >= navigatorBounds.left && rowBounds.right <= navigatorBounds.right,
      rowBorderStyle: rowStyle.borderStyle,
      rowPaddingRight: rowStyle.paddingRight,
      destinationLeftInset: destinationBounds.left - rowBounds.left,
      destinationRight: destinationBounds.right,
      actionLeft: actionBounds.left,
      gridColumns: rowStyle.gridTemplateColumns,
      noHorizontalOverflow: navigator.scrollWidth <= navigator.clientWidth,
      spacerHeight: spacerBounds.height,
      spacerWidth: spacerBounds.width,
      destinationDisplay: destinationStyle.display,
      destinationText: destination.textContent,
      pageText: pageNumber.textContent,
      pageGap: pageBounds.left - labelText.getBoundingClientRect().right,
      pageTrailing: summaryBounds.right - pageBounds.right,
      pageLeft: pageBounds.left,
      pageRight: pageBounds.right,
      labelFontSize: labelStyle.fontSize,
      labelOverflow: labelStyle.overflow,
      labelTextOverflow: labelStyle.textOverflow,
      labelWhiteSpace: labelStyle.whiteSpace,
    };
  });
  expect(nestedLongLabelGeometry.actionRightInset).toBeCloseTo(4, 0);
  expect(nestedLongLabelGeometry.actionWidth).toBe(64);
  expect(nestedLongLabelGeometry).toMatchObject({
    contained: true,
    noHorizontalOverflow: true,
    rowBorderStyle: "none",
    rowPaddingRight: "4px",
    spacerHeight: 34,
    spacerWidth: 28,
  });
  expect(nestedLongLabelGeometry.actionRightInset).toBeCloseTo(4, 0);
  const outlineColumns = nestedLongLabelGeometry.gridColumns.split(" ");
  expect(outlineColumns).toHaveLength(2);
  expect(Number.parseFloat(outlineColumns[0]!)).toBe(28);
  expect(nestedLongLabelGeometry.destinationLeftInset).toBeCloseTo(32, 0);
  expect(nestedLongLabelGeometry).toMatchObject({
    destinationDisplay: "flex",
    destinationText: "scriptalert(1)/script hostile outline2",
    pageText: "2",
    labelFontSize: "13px",
  });
  expect(nestedLongLabelGeometry.pageRight)
    .toBeLessThanOrEqual(nestedLongLabelGeometry.destinationRight);
  expect(nestedLongLabelGeometry.pageGap).toBeGreaterThanOrEqual(10);
  expect(nestedLongLabelGeometry.pageTrailing).toBeCloseTo(-6, 0);
  expect(nestedLongLabelGeometry).toMatchObject({
    labelOverflow: "visible",
    labelTextOverflow: "clip",
    labelWhiteSpace: "normal",
  });
  await outline.evaluate((element) => { element.style.removeProperty("width"); });

  await page.getByRole("tab", { name: "Annotations", exact: true }).click();
  const sourceRows = workspace.locator('[data-annotation-origin="owned"]');
  const unsectionedPageOne = sourceRows.filter({
    has: page.locator('.annotation-item__page', { hasText: /^1$/u }),
  }).first();
  await expect(unsectionedPageOne).toBeVisible();
  await expect(unsectionedPageOne.locator('.annotation-item__section')).toHaveCount(0);
  await expect(unsectionedPageOne.locator('.annotation-item__separator')).toHaveCount(0);

  const nestedAnnotation = sourceRows.filter({
    has: page.locator('.annotation-item__page', { hasText: /^3$/u }),
  }).first();
  await expect(nestedAnnotation).toBeVisible();
  await expect(nestedAnnotation).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(nestedAnnotation).toHaveCSS('border-style', 'none');
  await expect(nestedAnnotation).toHaveCSS('border-radius', '12px');
  await expect(nestedAnnotation).toHaveCSS('padding', '0px');
  await expect(nestedAnnotation.locator('.annotation-item__page')).toHaveText('3');
  await expect(nestedAnnotation.locator('.annotation-item__separator')).toHaveCount(0);
  await expect(nestedAnnotation.locator('.annotation-item__section')).toHaveCount(0);
  await expect(nestedAnnotation.locator('.annotation-item__navigation')).toHaveAccessibleName(
    /Page 3/u,
  );
  await page.getByRole("tab", { name: "Outline", exact: true }).click();
  await expect(nestedReference).toBeVisible();

  const mainViewport = mainWorkspace.locator("[data-viewer-framing-viewport]");
  await mainViewport.hover();
  await page.mouse.wheel(0, 32);
  await expect.poll(() => mainViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.waitForTimeout(200);
  const historyControlState = async (name: string) => {
    const control = page.getByRole("button", { name });
    if (await control.count() === 0) return "absent";
    return await control.isDisabled() ? "disabled" : "enabled";
  };
  const captureMainState = async () => ({
    page: await currentPageText(page),
    scroll: await mainViewport.evaluate((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
    })),
    zoom: await currentZoomText(page),
    backState: await historyControlState("Back in document history"),
    forwardState: await historyControlState("Forward in document history"),
  });
  const mainStateBeforeReference = await captureMainState();
  const expectMainStateUnchanged = async (expectedState = mainStateBeforeReference) => {
    await expect(mainWorkspace).toHaveAttribute("data-safety-main-mount", "stable");
    expect(await captureMainState()).toEqual(expectedState);
  };
  await openDetailsInReferences();
  const detailsTab = page.getByRole("tab", { name: /Details, Page 3/u });
  const referenceWorkspace = page.locator("[data-review-workspace]");
  await expect(referenceWorkspace).toHaveAttribute("data-workspace-presentation", "bottom");
  await expect(detailsTab).toHaveAttribute("aria-selected", "true");
  await expect(detailsTab).toBeFocused();
  const detailsReferenceCard = detailsTab.locator('..');
  await expect(detailsReferenceCard).toHaveCSS('border-style', 'none');
  await expect(detailsReferenceCard).toHaveCSS('border-radius', '10px');
  await expect(detailsReferenceCard).toHaveCSS('padding', '0px 3px 0px 0px');
  await expect(page.locator("[data-reference-pdf-viewport] [data-page-index='2']")).toBeVisible();
  await expectMainStateUnchanged();
  await openDetailsInReferences();
  await expect(page.getByRole("tablist", { name: "Open references" }).getByRole("tab"))
    .toHaveCount(1);
  await expect(detailsTab).toBeFocused();

  await clickHoverRevealedReferenceTabAction(
    page.getByRole("button", { name: "Close active reference" }),
  );
  await expect(page.locator("[data-reference-tab]")).toHaveCount(0);

  const stage = page.locator("[data-review-stage]");
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(stage).toHaveAttribute("data-reference-layout", "narrow-unified");
  await page.getByRole("tab", { name: "Outline", exact: true }).click();
  await expect(detailsReference).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const mainStateBeforeNarrowReference = await captureMainState();
  await page.waitForTimeout(200);
  await expectMainStateUnchanged(mainStateBeforeNarrowReference);
  await openDetailsInReferences();
  await expect(stage).toHaveAttribute("data-reference-layout", "narrow-unified");
  await expect(detailsTab).toHaveAttribute("aria-selected", "true");
  await expect(detailsTab).toBeFocused();
  await expect(page.locator("[data-reference-pdf-viewport] [data-page-index='2']")).toBeVisible();
  await expectMainStateUnchanged(mainStateBeforeNarrowReference);
  await clickHoverRevealedReferenceTabAction(
    page.getByRole("button", { name: "Close active reference" }),
  );
  await expect(page.locator("[data-reference-tab]")).toHaveCount(0);
  await page.getByRole("tab", { name: "Outline", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(stage).toHaveAttribute("data-reference-layout", "wide-right");

  await expect(details).toBeVisible();
  await details.focus();
  await expect(details).toBeFocused();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(details).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(details).toBeFocused();
  await expect(workspace).toHaveAttribute("data-tools-workspace-open", "true");
  await expect.poll(() => currentPageText(page)).toBe("3 / 4");
  const currentOutlineDestination = outline.locator("[aria-current='location']");
  await expect(currentOutlineDestination).toHaveAccessibleName(
    "Details, Page 3",
  );
  const currentOutlineRow = currentOutlineDestination.locator("..");
  const selectionBackground = await currentOutlineRow.evaluate((row) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = getComputedStyle(row)
      .getPropertyValue("--review-selection-bg")
      .trim();
    document.body.append(probe);
    const normalized = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return normalized;
  });
  await expect(currentOutlineRow).toHaveCSS("background-color", selectionBackground);
  const currentMarker = await currentOutlineRow.evaluate((row) => {
    const rowStyle = getComputedStyle(row);
    const markerStyle = getComputedStyle(row, "::before");
    return {
      markerBackground: markerStyle.backgroundColor,
      markerContent: markerStyle.content,
      markerLeft: markerStyle.left,
      markerPointerEvents: markerStyle.pointerEvents,
      markerPosition: markerStyle.position,
      markerWidth: markerStyle.width,
      rowBackground: rowStyle.backgroundColor,
    };
  });
  expect(currentMarker).toMatchObject({
    markerContent: "none",
    markerLeft: "auto",
    markerPointerEvents: "auto",
    markerPosition: "static",
    markerWidth: "auto",
  });
  expect(currentMarker.rowBackground).not.toBe("rgba(0, 0, 0, 0)");
  await currentOutlineDestination.focus();
  await currentOutlineRow.hover();
  await expect(currentOutlineRow).toHaveCSS("background-color", currentMarker.rowBackground);
  expect(await currentOutlineRow.evaluate((row) => getComputedStyle(row, "::before").content))
    .toBe("none");
  await workspaceControl.click();
  await expect(workspaceControl).toBeFocused();

  const back = page.getByRole("button", { name: "Back in document history" });
  const forward = page.getByRole("button", { name: "Forward in document history" });
  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await back.click();
  await expect.poll(() => currentPageText(page)).toBe("1 / 4");
  await expect(back).toHaveCount(0);
  await expect(forward).toBeEnabled();

  const hostileLink = mainWorkspace.getByRole("button", {
    name: "Open PDF link to img src=x onerror=alert(1), Page 3",
  });
  await hostileLink.click();
  const hostileMenu = page.getByRole("menu", {
    name: "Open img src=x onerror=alert(1), Page 3",
  });
  await expect(hostileMenu).toBeVisible();
  await expect(hostileMenu.locator("script,img")).toHaveCount(0);
  expect(await hostileMenu.textContent()).not.toMatch(/[<>\u202e\u0000]/u);
  await page.keyboard.press("Escape");
  await expect(hostileLink).toBeFocused();
  await expect.poll(() => currentPageText(page)).toBe("1 / 4");

  for (const [pageNumber, expectedPage] of [[2, "2 / 4"], [3, "3 / 4"], [4, "4 / 4"]] as const) {
    const currentPage = page.getByRole('textbox', { name: /^Current page \d+ of 4/u });
    await currentPage.fill(String(pageNumber));
    await currentPage.press('Enter');
    await expect.poll(() => currentPageText(page)).toBe(expectedPage);
  }
  await expect(back).toHaveCount(0);
  await expect(forward).toBeEnabled();
  const unavailable = mainWorkspace.getByRole("button", { name: "PDF link target unavailable" });
  await expect(unavailable).toHaveCount(6);
  for (let index = 0; index < 6; index += 1) {
    await unavailable.nth(index).click();
    await expect(page.locator("[data-link-action-popover]")).toHaveCount(0);
  }
  await expect(page.locator(".review-workspace__status")).toHaveText(
    "This PDF link cannot be opened safely.",
  );
  await expect.poll(() => currentPageText(page)).toBe("4 / 4");
  await expect(back).toHaveCount(0);
  await expect(forward).toBeEnabled();
  await expect(page.locator("[data-reference-tab]")).toHaveCount(0);
  await expect(workspace).toHaveAttribute("data-tools-workspace-open", "false");
  await expect(mainWorkspace).toHaveAttribute("data-safety-main-mount", "stable");
  expect(await page.locator("body").textContent()).not.toMatch(/example\.invalid|Calculator\.app|Bearer /u);
  expect(contactedOrigins).toEqual(new Set([sessionOrigin]));
});

test("collapses an outline-free PDF with source annotations to Search and restores workspace focus", async ({ page }) => {
  await openFreshProductionFixture(page, pdf, "No-outline launch failed");
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  await expect(mainWorkspace.locator("[data-page-index='0']")).toBeVisible();
  await mainWorkspace.evaluate((element) => element.setAttribute("data-empty-outline-main-mount", "stable"));
  const workspaceControl = await currentWorkspaceRail(page);
  await workspaceControl.click();
  const workspace = page.locator('#review-tools-workspace');
  const modes = page.getByRole('tablist', { name: 'Workspace modes' });
  await expect(modes.getByRole('tab', { name: 'Outline' })).toHaveCount(0);
  await expect(workspace.locator('#workspace-panel-outline')).toHaveCount(0);
  await expect(modes.getByRole('tab', { name: 'Annotations', exact: true })).toBeVisible();
  const searchMode = modes.getByRole('tab', { name: 'Search', exact: true });
  await expect(searchMode).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const visibleModes = modes.getByRole('tab');
  const expectedModes = ['Search', 'Annotations'];
  await expect(visibleModes).toHaveCount(expectedModes.length);
  expect(await visibleModes.evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('aria-label'))))
    .toEqual(expectedModes);
  const intrinsicGeometry = await modes.evaluate((tablist) => {
    const strip = tablist.closest<HTMLElement>('.review-workspace__activity-strip');
    const header = tablist.closest<HTMLElement>('.review-workspace__header');
    const tabs = [...tablist.querySelectorAll<HTMLElement>('[role="tab"]')];
    const label = tablist.querySelector<HTMLElement>('[data-workspace-mode-label]');
    if (!strip || !header || tabs.length === 0 || !label) {
      throw new Error('Workspace activity strip has no visible modes.');
    }
    const stripBounds = strip.getBoundingClientRect();
    const headerBounds = header.getBoundingClientRect();
    const firstBounds = tabs[0]!.getBoundingClientRect();
    const lastBounds = tabs.at(-1)!.getBoundingClientRect();
    return {
      firstInset: firstBounds.left - stripBounds.left,
      lastInset: stripBounds.right - lastBounds.right,
      leftAlignment: stripBounds.left - headerBounds.left,
      rightSlack: headerBounds.right - stripBounds.right,
      widths: tabs.map((tab) => tab.getBoundingClientRect().width),
      labelFits: label.scrollWidth <= label.clientWidth,
      visibleLabelCount: strip.querySelectorAll('[data-workspace-mode-label]').length,
    };
  });
  expect(intrinsicGeometry.firstInset).toBeGreaterThanOrEqual(0);
  expect(intrinsicGeometry.lastInset).toBeGreaterThanOrEqual(0);
  expect(intrinsicGeometry.leftAlignment).toBeCloseTo(46, 1);
  expect(intrinsicGeometry.rightSlack).toBeGreaterThan(0);
  expect(new Set(intrinsicGeometry.widths.map((width) => Math.round(width))).size)
    .toBeGreaterThan(1);
  expect(intrinsicGeometry.labelFits).toBe(true);
  expect(intrinsicGeometry.visibleLabelCount).toBe(1);
  await expect(workspace.locator('#workspace-panel-annotations')).toHaveCount(1);
  await expect(workspace).not.toContainText('Review comments');
  await expect(workspace).not.toContainText('Source PDF');
  await expect(workspace.locator('.existing-annotations__readonly')).toHaveCount(0);
  await expect(workspace.locator('.annotation-item__section')).toHaveCount(0);
  await workspaceControl.click();
  await expect(workspaceControl).toBeFocused();
  await expect(mainWorkspace).toHaveAttribute("data-empty-outline-main-mount", "stable");
});

test("retries one failed reference clone without exposing raw load details", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let documentRequestCount = 0;
  const documentHeaders: Array<{ authorization?: string; cookie?: string }> = [];
  await page.route("**/document/**", async (route) => {
    documentRequestCount += 1;
    const headers = route.request().headers();
    documentHeaders.push({
      ...(headers.authorization === undefined ? {} : { authorization: headers.authorization }),
      ...(headers.cookie === undefined ? {} : { cookie: headers.cookie }),
    });
    if (documentRequestCount === 3) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await openFreshProductionFixture(page, referencePdf, "Reference retry launch failed");
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  const primaryLink = mainWorkspace.getByRole("button", {
    name: "Open PDF link to Primary result, Page 2",
  });
  await primaryLink.click();
  await page.getByRole("menuitem", { name: /Open in References/u }).click();

  const retry = page.getByRole("button", { name: "Retry reference" });
  await expect(retry).toBeVisible();
  await expect(retry).toBeFocused();
  await expect(page.locator("[data-reference-state='error']")).toContainText(
    "Reference unavailable.",
  );
  await expect(page.locator(".review-workspace__status")).toHaveText(
    "Reference unavailable. Retry when ready.",
  );
  expect(await page.locator("body").textContent()).not.toMatch(/net::|ERR_|Bearer /u);

  await retry.click();
  const primaryTab = page.getByRole("tab", { name: /Primary result/u });
  await expect.poll(() => documentRequestCount).toBeGreaterThanOrEqual(3);
  await expectReferenceReady(page, primaryTab);
  await expect(primaryTab).toBeFocused();
  await expect(page.locator("[data-reference-pdf-viewport] [data-page-index='1']")).toBeVisible();
  expect(documentRequestCount).toBeGreaterThanOrEqual(3);
  expect(documentRequestCount).toBeLessThanOrEqual(4);
  expect(documentHeaders.every(({ authorization, cookie }) => (
    authorization?.startsWith("Bearer ") === true && cookie === undefined
  ))).toBe(true);
});

test('creates an insertion from middle-of-line PDFium caret geometry', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 720 });
  const launched = await host.open({
    pdfPath: await freshProductionPdf(plainTextPdf),
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Real caret insertion launch failed');
  }
  await page.goto(launched.url);
  await chooseFreshCopyDestination(page);

  const pdfPage = page.locator("[data-page-index='0']").first();
  await expect(pdfPage).toBeVisible();
  await waitForRenderedPageImage(pdfPage);
  await dragPdfPointer(page, pdfPage, { x: 150, y: 99 }, { x: 150, y: 99 });

  const insertionCaret = page.locator('[data-review-insertion-caret]');
  await expect(insertionCaret).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Insertion review action' })).toHaveCount(0);
  await expect(insertionCaret).toHaveCSS('animation-name', 'review-insertion-caret-blink');
  await expect(insertionCaret).toHaveCSS('background-color', 'rgb(73, 103, 137)');
  const [pageBox, caretBox] = await Promise.all([pdfPage.boundingBox(), insertionCaret.boundingBox()]);
  if (!pageBox || !caretBox) throw new Error('Insertion caret geometry is unavailable.');
  const pageScale = pageBox.width / 612;
  expect(caretBox.width).toBeCloseTo(1.25, 2);
  expect(caretBox.x + caretBox.width / 2 - pageBox.x).toBeCloseTo(149 * pageScale, 0);
  expect(caretBox.y - pageBox.y).toBeCloseTo(89 * pageScale, 0);

  const mainViewport = page.locator('[data-viewer-framing-viewport]');
  const scrollBefore = await mainViewport.evaluate((element) => element.scrollTop);
  await mainViewport.evaluate((element) => { element.scrollTop += 120; });
  await expect.poll(() => mainViewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(scrollBefore);
  await expect.poll(async () => {
    const [currentPageBox, currentCaretBox] = await Promise.all([
      pdfPage.boundingBox(),
      insertionCaret.boundingBox(),
    ]);
    return currentPageBox && currentCaretBox
      ? currentCaretBox.y - currentPageBox.y
      : Number.NaN;
  }).toBeCloseTo(caretBox.y - pageBox.y, 0);
  const [scrolledPageBox, scrolledCaretBox] = await Promise.all([
    pdfPage.boundingBox(),
    insertionCaret.boundingBox(),
  ]);
  if (!scrolledPageBox || !scrolledCaretBox) {
    throw new Error('Scrolled insertion caret geometry is unavailable.');
  }
  expect(scrolledCaretBox.x - scrolledPageBox.x).toBeCloseTo(caretBox.x - pageBox.x, 0);
  expect(scrolledCaretBox.y - scrolledPageBox.y).toBeCloseTo(caretBox.y - pageBox.y, 0);

  await page.keyboard.type('P');
  const composer = page.getByRole('region', { name: 'Insertion' });
  await expect(composer.getByRole('textbox', { name: 'Insertion' })).toHaveValue('P');
  await composer.getByRole('textbox', { name: 'Insertion' }).fill('Precisely ');
  await composer.getByRole('button', { name: 'Apply' }).click();

  await expect.poll(() => host.broker.state(launched.sessionId)?.items.length).toBe(1);
  expect(host.broker.state(launched.sessionId)?.items).toEqual([
    expect.objectContaining({
      kind: 'insert',
      pageIndex: 0,
      payload: expect.objectContaining({
        position: { x: 149, y: 89, width: 2, height: 16 },
        leftContext: 'Selectable p',
        rightContext: 'lacekeeper text: unique equilibrium clearly.\r\nMu',
        proposedText: 'Precisely ',
        reliable: true,
      }),
    }),
  ]);
});

test('keeps the insertion caret visible beside an open workspace', async ({ page }) => {
  const launched = await host.open({
    pdfPath: await freshProductionPdf(plainTextPdf),
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Workspace caret launch failed');
  }
  await page.goto(launched.url);

  const pdfPage = page.locator("[data-page-index='0']").first();
  await expect(pdfPage).toBeVisible();
  await waitForRenderedPageImage(pdfPage);
  const workspaceControl = await currentWorkspaceRail(page);
  if (await workspaceControl.getAttribute('aria-expanded') !== 'true') {
    await workspaceControl.click();
  }
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('tab', { name: 'Search', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  const pageBox = await pdfPage.boundingBox();
  if (!pageBox) throw new Error('Rendered PDF page has no bounds.');
  const pageScale = pageBox.width / 612;
  await page.mouse.click(pageBox.x + 150 * pageScale, pageBox.y + 99 * pageScale);

  const insertionCaret = page.locator('[data-review-insertion-caret]');
  await expect(insertionCaret).toBeVisible();
  await expect(insertionCaret).toHaveCSS('animation-name', 'review-insertion-caret-blink');
  await expect(insertionCaret).toHaveCSS('background-color', 'rgb(73, 103, 137)');
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');
});

test('keeps repeated-click PDF text selection out of insertion mode', async ({ page }) => {
  const launched = await host.open({
    pdfPath: await freshProductionPdf(pdf),
    sourceRootPath: sourceRoot,
    surface: 'vscode',
    fork: true,
  });
  if (!launched.ok) {
    throw new Error(
      `Repeated-click selection launch failed: ${launched.error.kind}: ${launched.error.message}`,
    );
  }
  if (launched.kind === 'recovery-offered') {
    throw new Error('Repeated-click selection launch failed: recovery was offered unexpectedly');
  }
  await page.goto(launched.url);

  const pdfPage = page.locator("[data-page-index='0']").first();
  await expect(pdfPage).toBeVisible();
  await waitForRenderedPageImage(pdfPage);
  const box = await pdfPage.boundingBox();
  if (!box) throw new Error('Rendered PDF page has no bounds.');
  const scale = box.width / 612;
  await page.mouse.click(box.x + 150 * scale, box.y + 99 * scale, { clickCount: 3 });

  await expect(page.getByRole('toolbar', { name: 'Selection review actions' })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Insertion review action' })).toHaveCount(0);
  await expect(page.locator('[data-review-insertion-caret]')).toHaveCount(0);
});

test("one installed-style browser tree preserves review state across responsive layout", async ({ page }) => {
  const sourcePdfPath = await freshProductionPdf(pdf);
  const launched = await host.open({
    pdfPath: sourcePdfPath,
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Installed-style production launch failed");
  }
  const launchUrl = launched.url;
  const initialSessionId = launched.sessionId;
  const initialItems = host.broker.state(initialSessionId)!.items;
  const initialIds = new Set(initialItems.map(item => item.id));
  const assetResponses: string[] = [];
  const contactedOrigins = new Set<string>();
  page.on("request", (request) => contactedOrigins.add(new URL(request.url()).origin));
  page.on("response", (response) => {
    if (response.url().includes("/assets/")) assetResponses.push(response.url());
  });
  const browserErrors = collectBrowserErrors(page);
  await installSelectionCaptureGate(page);
  await page.goto(launchUrl);
  await expect(page.locator("[data-production-review]")).toBeVisible();
  await expect(page.getByRole("button", { name: /paper\.pdf.*Open automatic save options/u })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Actions" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Codex" })).toHaveCount(0);
  await expect(page.locator("[data-codex-context]")).toHaveCount(0);
  await expect(page.getByText(/Revision \d+/u)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Finish" })).toHaveCount(0);
  await expect.poll(() => assetResponses.some((url) => url.endsWith("/app.css"))).toBe(true);
  await expect.poll(() => assetResponses.some((url) => url.endsWith("/pdfium.wasm"))).toBe(true);

  await expect(page.getByRole("button", { name: "Proofread mode" })).toHaveCount(0);
  await chooseFreshCopyDestination(page);
  const revisionBeforeReplacement = host.broker.state(initialSessionId)!.revision;
  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await expect.poll(() => currentPageText(page)).toBe('1 / 1');
  const workspace = page.locator('.pdf-workspace');
  await workspace.evaluate((element) => { element.setAttribute('data-mount-probe', 'stable'); });
  const renderedPageImage = await waitForRenderedPageImage(pageCanvas);
  const canvasBoxBeforeSelection = await pageCanvas.boundingBox();
  expect(canvasBoxBeforeSelection).not.toBeNull();
  if (canvasBoxBeforeSelection === null) throw new Error("Rendered PDF page has no bounds.");
  await expect(renderedPageImage).toHaveCSS("pointer-events", "none");
  await dragPdfPointer(
    page,
    pageCanvas,
    { x: 76, y: 98 },
    { x: 405, y: 98 },
    async () => {
      const selectionOverlay = pageCanvas.locator(':scope > div[style*="mix-blend-mode"]');
      await expect(selectionOverlay).toBeVisible();
      await expect(selectionOverlay.locator(':scope > div').first())
        .toHaveCSS('background-color', 'rgb(207, 222, 234)');
      expect(await renderedPageImage.evaluate((image) => {
        const selection = window.getSelection();
        if (!selection) return false;
        return Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
          .some((range) => range.intersectsNode(image));
      })).toBe(false);
    },
  );
  await expect(pageCanvas).toBeFocused();
  await expect(pageCanvas).toHaveCSS("outline-style", "none");
  await waitForSelectionCapture(page);
  await expect(page.locator("[data-viewer-status]")).toHaveCount(0);
  await expect.poll(async () => (await pageCanvas.boundingBox())?.y)
    .toBe(canvasBoxBeforeSelection.y);
  await page.keyboard.press("b");
  await releaseSelectionCapture(page);

  const replacementComposer = page.getByRole("region", { name: "Replacement" });
  await expect(replacementComposer).toBeVisible();
  const replacementTextbox = replacementComposer.getByRole("textbox", { name: "Replacement" });
  await expect(replacementTextbox).toHaveValue("b");
  await page.keyboard.type("la");
  await expect(replacementTextbox).toHaveValue("bla");
  const originalDigest = await sha256(sourcePdfPath);
  await replacementComposer.getByRole("button", { name: "Apply" }).click();
  await expect(replacementComposer).toHaveCount(0);
  await expect(pageCanvas.locator(':scope > div[style*="mix-blend-mode"]')).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Selection review actions' })).toHaveCount(0);
  await expect(page.locator("[data-review-item]")).toHaveCount(initialItems.length + 1);
  await expect.poll(() => host.broker.saveStatus(initialSessionId)?.sync.phase).toBe("clean");
  const replacementState = host.broker.state(initialSessionId);
  expect(replacementState?.revision).toBeGreaterThan(revisionBeforeReplacement);
  expect(replacementState?.items).toHaveLength(initialItems.length + 1);
  const replacementItem = replacementState?.items.find(item => !initialIds.has(item.id));
  expect(replacementState?.items.filter(item => initialIds.has(item.id))).toEqual(initialItems);
  expect(replacementItem).toMatchObject({
    kind: "replace",
    pageIndex: 0,
    payload: {
      quote: "Selectable placekeeper text: unique equilibrium clearly",
      proposedText: "bla",
      reliable: true,
    },
  });
  const replacementSegments = replacementItem?.payload.segmentRects;
  expect(Array.isArray(replacementSegments)).toBe(true);
  expect(replacementItem?.payload.rect).toEqual(
    Array.isArray(replacementSegments) ? replacementSegments[0] : undefined,
  );
  expect(replacementItem?.payload.rect).toEqual({
    x: 72,
    y: 89,
    width: 338,
    height: 16,
  });
  const savedTarget = host.broker.saveStatus(initialSessionId)?.destination;
  expect(savedTarget?.phase).toBe("active");
  if (savedTarget?.phase !== "active") throw new Error("Save destination was not established");
  expect(savedTarget.kind).toBe("copy");
  await access(savedTarget.targetPath);
  expect(await sha256(sourcePdfPath)).toBe(originalDigest);
  await expect(page.getByRole("button", { name: /paper\.pdf, Saved\. Open automatic save options/u })).toBeVisible();

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.locator("[data-owned-mark='replace']")).toHaveCount(1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("[data-owned-mark='replace']")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Codex" })).toHaveCount(0);
  await expect(page.locator("[data-codex-context]")).toHaveCount(0);
  await expect(pageCanvas).toHaveCount(1);
  await expect(workspace).toHaveAttribute('data-mount-probe', 'stable');
  expect(contactedOrigins).toEqual(new Set([new URL(launchUrl).origin]));
  expect(browserErrors).toEqual([]);
});

test('edits the current page and preserves real viewer state through responsive top-bar changes', async ({ page }) => {
  const launched = await host.open({
    pdfPath: await freshProductionPdf(multiPagePdf),
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Fresh multi-page navigation launch failed');
  }
  const browserErrors = collectBrowserErrors(page);
  await page.goto(launched.url);
  await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true');
  await chooseFreshCopyDestination(page);
  const navigationRevisionBaseline = host.broker.state(launched.sessionId)!.revision;

  const firstPage = page.locator("[data-page-index='0']").first();
  const secondPage = page.locator("[data-page-index='1']").first();
  await expect(firstPage).toBeVisible();
  await expect.poll(() => currentPageText(page)).toBe('1 / 2');
  await waitForRenderedPageImage(firstPage);

  const workspace = page.locator('.pdf-workspace');
  await workspace.evaluate((element) => {
    element.setAttribute('data-page-navigation-mount-probe', 'stable');
  });
  const firstPageBox = await firstPage.boundingBox();
  if (!firstPageBox) throw new Error('First rendered PDF page has no bounds.');
  await firstPage.click({
    button: 'right',
    position: { x: firstPageBox.width * 0.8, y: firstPageBox.height * 0.7 },
  });
  await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
  const composer = page.getByRole('region', { name: 'Page Note' });
  await composer.getByRole('textbox', { name: 'Comment' }).fill('Keep this surrounding review state.');
  await composer.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => host.broker.state(launched.sessionId)?.items.length).toBe(1);
  await expect.poll(() => host.broker.saveStatus(launched.sessionId)?.sync.phase).toBe('clean');

  const { annotations, workspace: workspaceRail } = await openAnnotationsWorkspace(page);
  const noteRow = page.getByRole('button', {
    name: /Page Note · Page 1 · Keep this surrounding review state\./u,
  });
  await expect(noteRow).toBeVisible();
  await zoomInOnce(page);
  const zoomBeforeNavigation = await currentZoomText(page);
  if (zoomBeforeNavigation === null) throw new Error('Zoom context is unavailable before resizing.');

  const viewerViewport = page.locator('[data-viewer-framing-viewport]');
  const panStartTop = await viewerViewport.evaluate((element) => element.scrollTop);
  await viewerViewport.hover();
  await page.mouse.wheel(0, 40);
  await expect.poll(() => viewerViewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(panStartTop + 10);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const manualPanTop = await viewerViewport.evaluate((element) => element.scrollTop);

  await page.getByRole('button', { name: 'Page 1 of 2. Open page navigation' }).click();
  await page.getByRole('menu', { name: 'Page navigation' })
    .getByRole('menuitem', { name: 'Next page' }).click();

  await expect(page.getByRole('textbox', {
    name: 'Current page 2 of 2. Enter a page number',
  })).toHaveValue('2');
  await expect(secondPage).toBeVisible();
  await expect(firstPage).toHaveCount(1);
  await expect(secondPage).toHaveCount(1);
  await expect(workspace).toHaveAttribute('data-page-navigation-mount-probe', 'stable');
  expect(await currentZoomText(page)).toBe(zoomBeforeNavigation);
  await expect(workspaceRail).toHaveAttribute('aria-expanded', 'true');
  await expect(annotations).toHaveAttribute('aria-selected', 'true');
  await expect(noteRow).toBeVisible();
  expect(host.broker.state(launched.sessionId)?.revision).toBeGreaterThan(navigationRevisionBaseline);
  expect(host.broker.state(launched.sessionId)?.items).toHaveLength(1);

  await expect.poll(() => viewerViewport.evaluate(async (element) => {
    const before = element.scrollTop;
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    return Math.abs(element.scrollTop - before);
  })).toBeLessThan(0.5);
  const navigationTargetTop = await viewerViewport.evaluate((element) => element.scrollTop);
  const navigationPageBounds = await secondPage.boundingBox();
  if (!navigationPageBounds) throw new Error('Explicit page-navigation target has no bounds.');
  expect(Math.abs(navigationTargetTop - manualPanTop)).toBeGreaterThan(5);
  const expectNavigationTarget = async () => {
    await expect.poll(() => currentPageText(page)).toBe('2 / 2');
    await expect.poll(async () => Math.abs(
      ((await secondPage.boundingBox())?.y ?? Number.POSITIVE_INFINITY) - navigationPageBounds.y,
    )).toBeLessThan(1);
    await expect.poll(() => viewerViewport.evaluate(
      (element, staleManualTop) => Math.abs(element.scrollTop - staleManualTop),
      manualPanTop,
    )).toBeGreaterThan(5);
  };
  await toggleWorkspace(page);
  await expect(workspaceRail).toHaveAttribute('aria-expanded', 'false');
  await expectNavigationTarget();
  await toggleWorkspace(page);
  await expect(workspaceRail).toHaveAttribute('aria-expanded', 'true');
  await expectNavigationTarget();

  await workspace.evaluate((element) => {
    element.setAttribute('data-responsive-chrome-mount-probe', 'stable');
  });
  await noteRow.hover();
  await page.getByRole('button', { name: 'Edit Page Note annotation on page 1' }).click();
  const draftComposer = page.getByRole('region', { name: 'Edit Page Note' });
  const draftEditor = draftComposer.getByRole('textbox', { name: 'Comment' });
  await draftEditor.fill('Keep this draft through top-bar recomposition.');
  const pageBeforeResize = await currentPageText(page);
  if (pageBeforeResize === null) throw new Error('Current page context is unavailable before resizing.');
  const pageMatch = pageBeforeResize.match(/^(\d+) \/ (\d+)$/u);
  if (!pageMatch) throw new Error('Current page context is unavailable before resizing.');
  const scrollMetrics = await viewerViewport.evaluate((element) => ({
    maximum: Math.max(0, element.scrollHeight - element.clientHeight),
    top: element.scrollTop,
  }));
  const requestedScroll = scrollMetrics.top > scrollMetrics.maximum / 2
    ? Math.max(0, scrollMetrics.top - 80)
    : Math.min(scrollMetrics.maximum, scrollMetrics.top + 80);
  expect(requestedScroll).not.toBe(scrollMetrics.top);
  await viewerViewport.dispatchEvent('wheel', {
    bubbles: true,
    deltaY: requestedScroll > scrollMetrics.top ? 80 : -80,
  });
  await viewerViewport.evaluate((element, top) => { element.scrollTop = top; }, requestedScroll);
  await expect.poll(() => viewerViewport.evaluate((element) => element.scrollTop))
    .toBeCloseTo(requestedScroll, 0);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const scrollBeforeResize = await viewerViewport.evaluate((element) => element.scrollTop);
  expect(scrollBeforeResize).toBeGreaterThan(0);
  const expectPreservedScroll = async () => {
    // WebKit can settle by one compact-control width after the runway switches axes.
    await expect.poll(() => viewerViewport.evaluate((element, desiredTop) => {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      return Math.abs(element.scrollTop - Math.min(desiredTop, maximum));
    }, scrollBeforeResize)).toBeLessThan(36);
  };

  await page.setViewportSize({ width: 320, height: 900 });
  const chrome = page.locator('[data-review-chrome]');
  await expect(chrome).toHaveAttribute('data-review-chrome-presentation', 'expanded');
  await expect(page.getByRole('textbox', {
    name: `Current page ${pageMatch[1]} of ${pageMatch[2]}. Enter a page number`,
  })).toBeVisible();
  await expect(page.getByRole('textbox', {
    name: `Current zoom ${zoomBeforeNavigation.replace('%', '')} percent. Enter a zoom percentage`,
  })).toBeVisible();
  await expect(draftEditor).toHaveValue('Keep this draft through top-bar recomposition.');
  await expect(page.locator('#review-tools-workspace'))
    .toHaveAttribute('data-workspace-presentation', 'bottom');
  await expect(page.locator('#review-tools-workspace'))
    .toHaveAttribute('data-tools-workspace-open', 'true');
  await expect(workspace).toHaveAttribute('data-responsive-chrome-mount-probe', 'stable');
  await expectPreservedScroll();

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(chrome).toHaveAttribute('data-review-chrome-presentation', 'expanded');
  await expect.poll(() => currentPageText(page)).toBe(pageBeforeResize);
  await expect.poll(() => currentZoomText(page)).toBe(zoomBeforeNavigation);
  await expect(draftEditor).toHaveValue('Keep this draft through top-bar recomposition.');
  await expect(page.locator('#review-tools-workspace'))
    .toHaveAttribute('data-workspace-presentation', 'right');
  await expect(page.locator('#review-tools-workspace'))
    .toHaveAttribute('data-authoring-takeover', 'true');
  await expect(workspace).toHaveAttribute('data-responsive-chrome-mount-probe', 'stable');
  await expectPreservedScroll();
  await draftComposer.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(draftComposer).toHaveCount(0);
  await expect.poll(() => host.broker.saveStatus(launched.sessionId)?.sync.phase).toBe('clean');
  expect(host.broker.state(launched.sessionId)?.revision).toBeGreaterThan(navigationRevisionBaseline);
  expect(host.broker.state(launched.sessionId)?.items[0]?.payload)
    .toEqual(expect.objectContaining({ comment: 'Keep this draft through top-bar recomposition.' }));
  expect(browserErrors).toEqual([]);
});

test('returns a live PDF annotation preview through document history without retargeting it', async ({ page }) => {
  const launched = await openFreshProductionFixture(
    page,
    multiPagePdf,
    'Fresh authoring Return launch failed',
  );
  await chooseFreshCopyDestination(page);
  const revisionBeforeDraft = host.broker.state(launched.sessionId)!.revision;

  const firstPage = page.locator("[data-page-index='0']").first();
  await waitForRenderedPageImage(firstPage);
  const firstPageBox = await firstPage.boundingBox();
  if (!firstPageBox) throw new Error('First authoring page has no bounds.');
  await firstPage.click({
    button: 'right',
    position: { x: firstPageBox.width * 0.75, y: firstPageBox.height * 0.65 },
  });
  await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
  const composer = page.getByRole('region', { name: 'Page Note' });
  const editor = composer.getByRole('textbox', { name: 'Comment' });
  await editor.fill('Draft remains on the original page.');
  const preview = page.locator('[data-authoring-preview="true"]');
  await expect(preview).toHaveAttribute('data-owned-mark', 'pageNote');

  const currentPage = page.getByRole('textbox', {
    name: 'Current page 1 of 2. Enter a page number',
  });
  await currentPage.fill('2');
  await page.keyboard.press('Enter');
  await expect.poll(() => currentPageText(page)).toBe('2 / 2');
  await expect.poll(() => new URL(page.url()).hash).toContain('page=2');
  await expect(editor).toHaveValue('Draft remains on the original page.');

  const returnToAnchor = composer.getByRole('button', { name: 'Back to passage' });
  await expect(returnToAnchor).toBeEnabled();
  await returnToAnchor.click();
  await expect(editor).toHaveValue('Draft remains on the original page.');
  await expect.poll(() => new URL(page.url()).hash).toContain('page=1');
  await expect(composer.locator('.comment-composer__anchor')).toHaveCount(0);

  const back = page.getByRole('button', { name: 'Back in document history' });
  const forward = page.getByRole('button', { name: 'Forward in document history' });
  await expect(back).toBeEnabled();
  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await back.click();
  await expect.poll(() => currentPageText(page)).toBe('2 / 2');
  await expect(composer).toBeVisible();
  await expect(editor).toHaveValue('Draft remains on the original page.');
  await expect(forward).toBeEnabled();
  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await forward.click();
  await expect.poll(() => new URL(page.url()).hash).toContain('page=1');
  await expect(back).toBeEnabled();
  await expect(composer.locator('.comment-composer__anchor')).toHaveCount(0);
  await expect(preview).toHaveAttribute('data-owned-mark', 'pageNote');

  await editor.focus();
  await expect(editor).toBeFocused();
  await composer.getByRole('button', { name: 'Cancel' }).click();
  expect(host.broker.state(launched.sessionId)?.revision).toBeGreaterThan(revisionBeforeDraft);
});

test('defers an ordinary external replacement through UI save and publishes it with the new annotation', async ({ page }) => {
  const sourcePath = await freshProductionPdf(plainTextPdf);
  const launched = await host.open({ pdfPath: sourcePath, sourceRootPath: sourceRoot, fork: true });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Ordinary refresh lifecycle launch failed');
  }
  await page.goto(launched.url);
  await expect(page.locator("[data-page-index='0']").first()).toBeVisible();
  await chooseFreshCopyDestination(page);

  const pdfPage = page.locator("[data-page-index='0']").first();
  const pageBox = await pdfPage.boundingBox();
  if (!pageBox) throw new Error('Ordinary refresh page has no bounds.');
  await pdfPage.click({
    button: 'right',
    position: { x: pageBox.width * 0.7, y: pageBox.height * 0.55 },
  });
  await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
  const composer = page.getByRole('region', { name: 'Page Note' });
  await composer.getByRole('textbox', { name: 'Comment' }).fill('Included in the successor generation.');

  const replacement = await PDFDocument.load(await readFile(sourcePath));
  replacement.setSubject(`external-${randomUUID()}`);
  const observed = Promise.withResolvers<void>();
  const unsubscribeObservation = host.broker.onLocalDocumentObservation((event) => {
    if (event.sessionId === launched.sessionId && event.changed) observed.resolve();
  });
  await writeFile(sourcePath, await replacement.save());
  await observed.promise;
  unsubscribeObservation();
  expect(host.broker.state(launched.sessionId)?.workflow.documentGeneration).toBe(1);

  await composer.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(composer).toHaveCount(0);
  await expect.poll(() => host.broker.state(launched.sessionId)?.workflow.documentGeneration).toBe(2);
  expect(host.broker.state(launched.sessionId)?.items).toEqual([
    expect.objectContaining({
      kind: 'pageNote',
      payload: expect.objectContaining({ comment: 'Included in the successor generation.' }),
      reconciliation: expect.objectContaining({ baseGeneration: 1 }),
    }),
  ]);
});

test('follows a rendered reading passage through inserted pages without changing zoom or focus', async ({ page }) => {
  let observedResolution: Awaited<ReturnType<typeof host.broker.resolveReadingLocation>> | undefined;
  const resolveReadingLocation = host.broker.resolveReadingLocation.bind(host.broker);
  host.broker.resolveReadingLocation = async (...input) => {
    observedResolution = await resolveReadingLocation(...input);
    return observedResolution;
  };
  const sourcePath = await freshProductionPdf(plainTextPdf);
  const launched = await host.open({ pdfPath: sourcePath, sourceRootPath: sourceRoot, fork: true });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Reading continuity launch failed');
  }
  await page.goto(launched.url);
  const predecessorPage = page.locator("[data-page-index='0']").first();
  await waitForRenderedPageImage(predecessorPage);
  await zoomInOnce(page);
  const zoomBefore = await currentZoomText(page);
  await page.evaluate(() => {
    const probe = document.createElement('button');
    probe.id = 'refresh-focus-probe';
    probe.textContent = 'Reading focus probe';
    probe.style.position = 'fixed';
    probe.style.inset = '0 auto auto 0';
    document.body.append(probe);
  });
  const focusProbe = page.locator('#refresh-focus-probe');
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await focusProbe.focus();
  await expect(focusProbe).toBeFocused();
  const pageTopBefore = await predecessorPage.evaluate((element) => element.getBoundingClientRect().top);

  const original = await PDFDocument.load(await readFile(sourcePath));
  const replacement = await PDFDocument.create();
  replacement.addPage([612, 792]);
  const [retained] = await replacement.copyPages(original, [0]);
  replacement.addPage(retained!);
  await writeFile(sourcePath, await replacement.save({ useObjectStreams: false }));

  await expect.poll(() => host.broker.state(launched.sessionId)?.workflow.documentGeneration).toBe(2);
  await expect.poll(() => observedResolution, { timeout: PRODUCTION_VIEWER_READY_TIMEOUT_MS }).toBeDefined();
  expect(observedResolution).toMatchObject({ status: 'resolved', generation: 2, pageIndex: 1 });
  if (observedResolution?.status !== 'resolved') throw new Error('Reading passage did not resolve.');
  const alignmentTolerance = observedResolution.rect.height * Number.parseFloat(zoomBefore) / 100;
  await expect.poll(() => currentPageText(page), { timeout: PRODUCTION_VIEWER_READY_TIMEOUT_MS }).toBe('2 / 2');
  const successorPage = page.locator("[data-page-index='1']").first();
  await waitForRenderedPageImage(successorPage);
  expect(await currentZoomText(page)).toBe(zoomBefore);
  await expect(focusProbe).toBeFocused();
  await expect.poll(async () => Math.abs(
    await successorPage.evaluate((element) => element.getBoundingClientRect().top) - pageTopBefore,
  ), { timeout: PRODUCTION_VIEWER_READY_TIMEOUT_MS }).toBeLessThan(alignmentTolerance);
});

test('settles on the bounded reading fallback when the shared resolver rejects', async ({ page }) => {
  const attempted = Promise.withResolvers<void>();
  host.broker.resolveReadingLocation = async () => {
    attempted.resolve();
    throw new Error('reading inspection unavailable');
  };
  const sourcePath = await freshProductionPdf(plainTextPdf);
  const launched = await host.open({
    pdfPath: sourcePath,
    sourceRootPath: sourceRoot,
    workflowMode: 'generated-output',
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') throw new Error('Reading fallback launch failed');
  await page.goto(launched.url);
  await waitForRenderedPageImage(page.locator("[data-page-index='0']").first());
  await zoomInOnce(page);
  const zoomBefore = await currentZoomText(page);

  const original = await PDFDocument.load(await readFile(sourcePath));
  const replacement = await PDFDocument.create();
  replacement.addPage([612, 792]);
  const [retained] = await replacement.copyPages(original, [0]);
  replacement.addPage(retained!);
  await writeFile(sourcePath, await replacement.save({ useObjectStreams: false }));

  await attempted.promise;
  await expect.poll(() => host.broker.state(launched.sessionId)?.workflow.documentGeneration).toBe(2);
  await expect(page.locator('[data-production-review]')).toHaveAttribute('data-location-restore-status', 'idle');
  await expect.poll(() => currentPageText(page)).toBe('1 / 2');
  expect(await currentZoomText(page)).toBe(zoomBefore);
});

test('settles on the bounded fallback when rendered page text capture is unavailable', async ({ page }) => {
  let resolverCalled = false;
  const resolveReadingLocation = host.broker.resolveReadingLocation.bind(host.broker);
  host.broker.resolveReadingLocation = async (...input) => {
    resolverCalled = true;
    return resolveReadingLocation(...input);
  };
  const predecessor = await PDFDocument.create();
  predecessor.addPage([612, 792]);
  const sourcePath = join(root, `image-only-reading-${randomUUID()}.pdf`);
  await writeFile(sourcePath, await predecessor.save({ useObjectStreams: false }));
  const launched = await host.open({
    pdfPath: sourcePath,
    sourceRootPath: sourceRoot,
    workflowMode: 'generated-output',
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') throw new Error('Capture fallback launch failed');
  await page.goto(launched.url);
  await waitForRenderedPageImage(page.locator("[data-page-index='0']").first());
  await zoomInOnce(page);
  const zoomBefore = await currentZoomText(page);

  const replacement = await PDFDocument.create();
  replacement.addPage([612, 792]);
  replacement.addPage([612, 792]);
  await writeFile(sourcePath, await replacement.save({ useObjectStreams: false }));

  await expect.poll(() => host.broker.state(launched.sessionId)?.workflow.documentGeneration).toBe(2);
  await expect(page.locator('[data-production-review]')).toHaveAttribute('data-location-restore-status', 'idle');
  await expect.poll(() => currentPageText(page)).toBe('1 / 2');
  expect(await currentZoomText(page)).toBe(zoomBefore);
  expect(resolverCalled).toBe(false);
});

test('same-page scrolling cancels a delayed reading passage restore', async ({ page }) => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const resolveReadingLocation = host.broker.resolveReadingLocation.bind(host.broker);
  host.broker.resolveReadingLocation = async (...input) => {
    const resolution = await resolveReadingLocation(...input);
    started.resolve();
    await release.promise;
    return resolution;
  };
  const sourcePath = await freshProductionPdf(plainTextPdf);
  const launched = await host.open({ pdfPath: sourcePath, sourceRootPath: sourceRoot, fork: true });
  if (!launched.ok || launched.kind === 'recovery-offered') throw new Error('Delayed reading launch failed');
  await page.goto(launched.url);
  await waitForRenderedPageImage(page.locator("[data-page-index='0']").first());

  const original = await PDFDocument.load(await readFile(sourcePath));
  const replacement = await PDFDocument.create();
  replacement.addPage([612, 792]);
  const [retained] = await replacement.copyPages(original, [0]);
  replacement.addPage(retained!);
  await writeFile(sourcePath, await replacement.save({ useObjectStreams: false }));
  await started.promise;

  const viewport = page.locator('[data-viewer-framing-viewport]');
  await viewport.hover();
  await page.mouse.wheel(0, 80);
  release.resolve();

  await expect(page.locator('[data-production-review]')).toHaveAttribute('data-location-restore-status', 'fallback');
  await expect.poll(() => currentPageText(page)).toBe('1 / 2');
});

test('a newer generation cancels a delayed predecessor reading restore', async ({ page }) => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const resolveReadingLocation = host.broker.resolveReadingLocation.bind(host.broker);
  let calls = 0;
  host.broker.resolveReadingLocation = async (...input) => {
    calls += 1;
    const resolution = await resolveReadingLocation(...input);
    if (calls === 1) {
      started.resolve();
      await release.promise;
    }
    return resolution;
  };
  const sourcePath = await freshProductionPdf(plainTextPdf);
  const launched = await host.open({ pdfPath: sourcePath, sourceRootPath: sourceRoot, fork: true });
  if (!launched.ok || launched.kind === 'recovery-offered') throw new Error('Generation fence launch failed');
  await page.goto(launched.url);
  await waitForRenderedPageImage(page.locator("[data-page-index='0']").first());

  const original = await PDFDocument.load(await readFile(sourcePath));
  const first = await PDFDocument.create();
  first.addPage([612, 792]);
  const [firstRetained] = await first.copyPages(original, [0]);
  first.addPage(firstRetained!);
  await writeFile(sourcePath, await first.save({ useObjectStreams: false }));
  await started.promise;

  const second = await PDFDocument.create();
  second.addPage([612, 792]);
  second.addPage([612, 792]);
  const [secondRetained] = await second.copyPages(original, [0]);
  second.addPage(secondRetained!);
  await writeFile(sourcePath, await second.save({ useObjectStreams: false }));
  await expect.poll(() => host.broker.state(launched.sessionId)?.workflow.documentGeneration).toBe(3);
  release.resolve();

  await expect.poll(() => currentPageText(page), { timeout: PRODUCTION_VIEWER_READY_TIMEOUT_MS }).toBe('1 / 3');
  await expect(page.locator('[data-production-review]')).not.toHaveAttribute('data-location-restore-status', 'restoring');
});

test('keeps a first-page multiline highlight composer stable and reveals one icon only when fully offscreen', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(
    page,
    plainTextPdf,
    'First-page highlight composer launch failed',
  );
  await chooseFreshCopyDestination(page);

  const viewport = page.locator('[data-viewer-framing-viewport]');
  await viewport.evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
  const pdfPage = page.locator("[data-page-index='0']").first();
  await waitForRenderedPageImage(pdfPage);
  await dragPdfPointer(page, pdfPage, { x: 76, y: 98 }, { x: 405, y: 128 }, undefined, { steps: 12 });
  const selectionActions = page.getByRole('toolbar', { name: 'Selection review actions' });
  await expect(selectionActions).toBeVisible();
  await selectionActions.getByRole('button', { name: 'Highlight', exact: true }).click();

  const composer = page.getByRole('region', { name: 'Highlight Comment' });
  await expect(composer).toBeVisible();
  await expect(composer.locator('.comment-composer__anchor')).toHaveCount(0);
  await expect(composer).not.toContainText('Back to passage');
  const settled = await composer.evaluate(async (element) => {
    const scrollport = document.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
    const samples: Array<{ left: number; top: number; width: number; height: number; scrollTop: number }> = [];
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const bounds = element.getBoundingClientRect();
      samples.push({
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
        scrollTop: scrollport?.scrollTop ?? Number.NaN,
      });
    }
    return samples;
  });
  const last = settled.at(-1)!;
  for (const sample of settled.slice(10)) {
    expect(sample.left).toBeCloseTo(last.left, 1);
    expect(sample.top).toBeCloseTo(last.top, 1);
    expect(sample.width).toBeCloseTo(last.width, 1);
    expect(sample.height).toBeCloseTo(last.height, 1);
    expect(sample.scrollTop).toBe(0);
  }

  for (const name of ['Cancel'] as const) {
    const action = composer.getByRole('button', { name, exact: true });
    await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await action.hover();
    await expect(action).toHaveCSS('background-color', 'rgb(231, 231, 231)');
  }

  const previewMarks = page.locator('[data-authoring-preview="true"]');
  await expect.poll(() => previewMarks.count()).toBeGreaterThan(1);
  const partialScroll = await previewMarks.evaluateAll((elements) => {
    const scrollport = document.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
    if (scrollport === null) throw new Error('Main PDF scrollport is unavailable.');
    const first = elements
      .map((element) => element.getBoundingClientRect())
      .sort((left, right) => left.top - right.top)[0];
    if (first === undefined) throw new Error('Highlight preview geometry is unavailable.');
    return Math.ceil(scrollport.scrollTop + first.bottom - scrollport.getBoundingClientRect().top + 2);
  });
  await viewport.evaluate((element, scrollTop) => { element.scrollTop = scrollTop; }, partialScroll);
  await expect.poll(() => previewMarks.evaluateAll((elements) => {
    const viewportBounds = document.querySelector<HTMLElement>('[data-viewer-framing-viewport]')
      ?.getBoundingClientRect();
    if (viewportBounds === undefined) return false;
    const rects = elements.map((element) => element.getBoundingClientRect());
    return rects.some((rect) => rect.bottom <= viewportBounds.top)
      && rects.some((rect) => (
        rect.bottom > viewportBounds.top && rect.top < viewportBounds.bottom
      ));
  })).toBe(true);
  const partialReturnStates = await composer.evaluate(async (element) => {
    const states: boolean[] = [];
    for (let frame = 0; frame < 20; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      states.push(element.querySelector('.comment-composer__anchor') !== null);
    }
    return states;
  });
  expect(partialReturnStates).toEqual(Array.from({ length: 20 }, () => false));

  const fullyOffscreenScroll = await previewMarks.evaluateAll((elements) => {
    const scrollport = document.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
    if (scrollport === null) throw new Error('Main PDF scrollport is unavailable.');
    const lastBottom = Math.max(...elements.map((element) => element.getBoundingClientRect().bottom));
    return Math.ceil(scrollport.scrollTop + lastBottom - scrollport.getBoundingClientRect().top + 2);
  });
  await viewport.evaluate((element, scrollTop) => { element.scrollTop = scrollTop; }, fullyOffscreenScroll);
  await expect.poll(() => previewMarks.evaluateAll((elements) => {
    const viewportTop = document.querySelector<HTMLElement>('[data-viewer-framing-viewport]')!
      .getBoundingClientRect().top;
    return elements.every((element) => element.getBoundingClientRect().bottom <= viewportTop);
  })).toBe(true);
  const returnToPassage = composer.getByRole('button', { name: 'Back to passage' });
  await expect(returnToPassage).toBeVisible();
  await expect(returnToPassage.locator('span')).toHaveCount(0);
  await expect(composer.locator('.comment-composer__header > .comment-composer__anchor'))
    .toHaveCount(1);

  await viewport.evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(returnToPassage).toHaveCount(0);
  await composer.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('keeps VS Code composer controls aligned with the web desktop control size', async ({ page }) => {
  const launched = await host.open({
    pdfPath: await freshProductionPdf(multiPagePdf),
    sourceRootPath: sourceRoot,
    surface: 'vscode',
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('VS Code composer sizing launch failed.');
  }
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto(launched.url);

  const review = page.locator('[data-production-review]');
  await expect(review).toHaveAttribute('data-launch-surface', 'vscode');
  const firstPage = page.locator("[data-page-index='0']").first();
  await waitForRenderedPageImage(firstPage);
  const firstPageBox = await firstPage.boundingBox();
  if (!firstPageBox) throw new Error('VS Code composer page has no bounds.');
  await firstPage.click({
    button: 'right',
    position: { x: firstPageBox.width * 0.75, y: firstPageBox.height * 0.65 },
  });
  await page.getByRole('menuitem', { name: 'Add Page Note' }).click();

  const composer = page.getByRole('region', { name: 'Page Note' });
  await expect(composer).toBeVisible();
  const actionHeights = await composer.locator('.comment-composer__actions button')
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  expect(actionHeights).not.toHaveLength(0);
  expect(actionHeights.every((height) => Math.abs(height - 30) < 0.5)).toBe(true);

  const currentPage = page.getByRole('textbox', {
    name: 'Current page 1 of 2. Enter a page number',
  });
  await currentPage.fill('2');
  await page.keyboard.press('Enter');

  const returnToAnchor = composer.getByRole('button', { name: 'Back to passage' });
  await expect(returnToAnchor).toBeVisible();
  const [anchorBox, cancelBox] = await Promise.all([
    returnToAnchor.boundingBox(),
    composer.getByRole('button', { name: 'Cancel' }).boundingBox(),
  ]);
  expect(anchorBox).not.toBeNull();
  expect(cancelBox).not.toBeNull();
  expect(anchorBox!.width).toBeCloseTo(32, 0);
  expect(anchorBox!.height).toBeCloseTo(32, 0);
  await expect(returnToAnchor.locator('span')).toHaveCount(0);
  expect(cancelBox!.height).toBeCloseTo(30, 0);
});

test('adds, reads, and edits a full annotation through the production PDF', async ({ page }) => {
  const launched = await openFreshProductionFixture(
    page,
    pdf,
    'Full annotation production launch failed',
  );
  await chooseFreshCopyDestination(page);
  const annotationBaseline = host.broker.state(launched.sessionId)!;
  const baselineIds = new Set(annotationBaseline.items.map(item => item.id));
  const pdfPage = page.locator("[data-page-index='0']").first();
  await waitForRenderedPageImage(pdfPage);
  const pageBox = await pdfPage.boundingBox();
  if (!pageBox) throw new Error('Full annotation PDF page has no bounds.');
  await pdfPage.click({
    button: 'right',
    position: { x: pageBox.width * 0.72, y: pageBox.height * 0.7 },
  });
  await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
  const initialComment = 'This production note keeps enough detail to require the full annotation reader. '.repeat(7);
  const createComposer = page.getByRole('region', { name: 'Page Note' });
  await createComposer.getByRole('textbox', { name: 'Comment' }).fill(initialComment);
  await createComposer.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => host.broker.state(launched.sessionId)?.items.length)
    .toBe(annotationBaseline.items.length + 1);
  await expect.poll(() => host.broker.saveStatus(launched.sessionId)?.sync.phase).toBe('clean');
  await expect(createComposer).toHaveCount(0);

  const item = host.broker.state(launched.sessionId)?.items.find(item => !baselineIds.has(item.id));
  if (!item) throw new Error('Saved full annotation is unavailable.');
  const markFocus = page.locator(`[data-owned-focus-id="${item.id}"]`);
  await markFocus.evaluate((element) => {
    (element as HTMLElement).focus({ preventScroll: true });
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
  });
  const peek = page.locator(`[data-annotation-peek="${item.id}"]`);
  await expect(peek).toBeVisible();
  await peek.getByRole('button', { name: /Read full Page Note annotation on page 1/u }).click();
  const reader = page.getByRole('region', { name: 'Full Page Note annotation on page 1' });
  await expect(reader).toContainText(initialComment);

  await reader.locator('[data-full-annotation-action="edit"]').click();
  const editComposer = page.getByRole('region', { name: 'Edit Page Note' });
  const revisedComment = 'The edited production note remains long enough to stay in the full annotation reader. '.repeat(7);
  await editComposer.getByRole('textbox', { name: 'Comment' }).fill(revisedComment);
  await editComposer.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => host.broker.state(launched.sessionId)?.revision).toBeGreaterThan(annotationBaseline.revision);
  await expect.poll(() => host.broker.saveStatus(launched.sessionId)?.sync.phase).toBe('clean');
  await expect(reader).toContainText(revisedComment);
  await reader.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(reader).toHaveCount(0);

  await page.reload();
  await expect(page.locator('[data-production-review]')).toBeVisible();
  await expect(page.locator(`[data-owned-focus-id="${item.id}"]`)).toHaveCount(1);
  await openAnnotationsWorkspace(page);
  const persistedRow = page.locator(`[data-review-item="${item.id}"]`);
  await expect(persistedRow).toBeVisible();
  await expect(persistedRow).toContainText(revisedComment);
  expect(host.broker.state(launched.sessionId)?.revision).toBeGreaterThan(annotationBaseline.revision);
});

test('keeps the right workspace inset and PDF runway stable across open and close', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, pdf, 'Right workspace geometry launch failed');
  // Manual zoom preserves page scale so opening the tray adds PDF runway.
  await zoomInOnce(page);

  const stage = page.locator('[data-review-stage]');
  const viewport = page.locator('[data-viewer-framing-viewport]');
  const tray = page.locator('#review-tools-workspace');
  const workspace = page.locator('.pdf-workspace');
  await workspace.evaluate((element) => { element.dataset.workspaceGeometryProbe = 'stable'; });
  const closedWidth = await viewport.evaluate((element) => element.scrollWidth);

  await openAnnotationsWorkspace(page);
  await expect(tray).toHaveAttribute('data-workspace-presentation', 'right');
  const [stageBox, trayBox] = await Promise.all([stage.boundingBox(), tray.boundingBox()]);
  if (!stageBox || !trayBox) throw new Error('Right workspace geometry is unavailable.');
  expect(trayBox.y - stageBox.y).toBeCloseTo(0, 0);
  expect(stageBox.x + stageBox.width - trayBox.x - trayBox.width).toBeCloseTo(await expectedWorkspaceInset(page), 0);
  expect(stageBox.y + stageBox.height - trayBox.y - trayBox.height).toBeCloseTo(await expectedWorkspaceInset(page), 0);
  expect(await viewport.evaluate((element) => element.scrollWidth)).toBeGreaterThan(closedWidth);
  await expect(workspace).toHaveAttribute('data-workspace-geometry-probe', 'stable');

  await toggleWorkspace(page);
  await expect(tray).toHaveAttribute('data-tools-workspace-open', 'false');
  await expect.poll(() => viewport.evaluate((element) => element.scrollWidth)).toBe(closedWidth);
  await expect(workspace).toHaveAttribute('data-workspace-geometry-probe', 'stable');
});

test('keeps the bottom workspace evenly inset across open and close', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 820, height: 900 });
  await openFreshProductionFixture(page, pdf, 'Bottom workspace geometry launch failed');

  const stage = page.locator('[data-review-stage]');
  const tray = page.locator('#review-tools-workspace');
  await expect(tray).toHaveAttribute('data-workspace-presentation', 'bottom');
  await openAnnotationsWorkspace(page);
  const [stageBox, trayBox] = await Promise.all([stage.boundingBox(), tray.boundingBox()]);
  if (!stageBox || !trayBox) throw new Error('Bottom workspace geometry is unavailable.');
  expect(trayBox.x - stageBox.x).toBeCloseTo(await expectedWorkspaceInset(page), 0);
  expect(stageBox.x + stageBox.width - trayBox.x - trayBox.width).toBeCloseTo(await expectedWorkspaceInset(page), 0);
  expect(stageBox.y + stageBox.height - trayBox.y - trayBox.height).toBeCloseTo(await expectedWorkspaceInset(page), 0);

  await toggleWorkspace(page);
  await expect(tray).toHaveAttribute('data-tools-workspace-open', 'false');
});

test('shows zoom actions only when fitting or horizontal locking is useful', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, 'Conditional zoom actions launch failed');
  const menu = page.getByRole('menu', { name: 'PDF zoom', exact: true });
  const fit = page.getByRole('menuitem', { name: 'Fit width', exact: true });
  const lock = page.getByRole('menuitemcheckbox', { name: 'Horizontal lock' });
  const openMenu = async () => {
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    await page.getByRole('button', { name: 'Open zoom controls' }).hover();
    await expect(menu).toBeVisible();
  };
  const setZoom = async (value: string) => {
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    const zoom = page.getByRole('textbox', { name: /Current zoom \d+ percent/u });
    await zoom.fill(value);
    await zoom.press('Enter');
    await openMenu();
  };
  await openMenu();
  await expect(fit).toHaveCount(0);
  await expect(lock).toHaveCount(0);
  const trailingPositions = async () => Promise.all(['Zoom out', 'Zoom in'].map(async (name) => (await page.getByRole('menuitem', { name, exact: true }).boundingBox())!.x));
  const originalPositions = await trailingPositions();
  const zoomOutWithoutLockFlash = async () => {
    const probe = await page.evaluateHandle(() => {
      const state = { appeared: false, observer: new MutationObserver((records) => {
        if (records.some((record) => [...record.addedNodes].some((node) => node instanceof Element
          && (node.matches('[data-review-horizontal-lock]') || node.querySelector('[data-review-horizontal-lock]'))))) state.appeared = true;
      }) };
      state.observer.observe(document.body, { childList: true, subtree: true });
      return state;
    });
    try {
      await page.getByRole('menuitem', { name: 'Zoom out', exact: true }).click();
      // Observe the entire 140ms animation, including intermediate DOM insertions.
      await page.waitForTimeout(250);
      expect(await probe.evaluate((state) => state.appeared)).toBe(false);
      await expect(lock).toHaveCount(0);
    } finally {
      await probe.evaluate((state) => state.observer.disconnect());
      await probe.dispose();
    }
  };
  await zoomOutWithoutLockFlash();
  await setZoom('250');
  await expect(fit).toBeVisible();
  await expect(lock).toBeVisible();
  await expect.poll(trailingPositions).toEqual(originalPositions);
  const actionLabels = await menu.locator('[role=menuitem], [role=menuitemcheckbox]').evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')));
  expect(actionLabels).toEqual(['Horizontal lock', 'Fit width', 'Zoom out', 'Zoom in']);
  await lock.click();
  await expect(lock).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.review-document [data-viewer-framing-viewport]')).toHaveCSS('overflow-x', 'hidden');
  await fit.click();
  await expect(fit).toHaveCount(0);
  await expect(lock).toHaveCount(0);
  await expect.poll(trailingPositions).toEqual(originalPositions);
  await setZoom('50');
  await expect(fit).toBeVisible();
  await expect(lock).toHaveCount(0);
  await zoomOutWithoutLockFlash();
});

test('locks horizontal PDF scrolling at the current offset without blocking vertical scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, 'Horizontal lock launch failed');
  const viewport = page.locator('.review-document [data-viewer-framing-viewport]');
  const zoom = page.getByRole('textbox', { name: /Current zoom \d+ percent/u });
  await expect(zoom).toBeVisible();
  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await zoom.fill('250');
  await zoom.press('Enter');
  await expect.poll(() => viewport.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(100);
  const bounds = (await viewport.boundingBox())!;
  const scroll = async (x: number, y: number) => {
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(x, y);
  };
  await viewport.evaluate((element) => { element.scrollLeft = 0; });
  await scroll(200, 0);
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const toggle = async () => {
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    await page.getByRole('button', { name: 'Open zoom controls' }).hover();
    const lock = page.getByRole('menuitemcheckbox', { name: 'Horizontal lock' });
    const fit = (await page.getByRole('menuitem', { name: 'Fit width' }).boundingBox())!;
    const lockBounds = (await lock.boundingBox())!;
    expect(lockBounds.x + lockBounds.width).toBeLessThanOrEqual(fit.x);
    await lock.click();
    return lock;
  };
  await expect(await toggle()).toHaveAttribute('aria-checked', 'true');
  await expect(viewport).toHaveCSS('overflow-x', 'hidden');
  const locked = await viewport.evaluate((element) => ({ x: element.scrollLeft, y: element.scrollTop }));
  await scroll(300, 250);
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(locked.y);
  expect(await viewport.evaluate((element) => element.scrollLeft)).toBe(locked.x);
  await expect(await toggle()).toHaveAttribute('aria-checked', 'false');
  await scroll(-200, 0);
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeLessThan(locked.x);
});

test('keeps native PDF scrollbars exposed without shifting pages', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, 'Scrollbar fixture launch failed');
  const main = page.locator('.pdf-workspace:not(.pdf-workspace--reference)');
  const viewport = main.locator('[data-viewer-framing-viewport]');
  await openLinkInReferences(page, main.getByRole('button', { name: 'Open PDF link to Primary result, Page 2' }));
  const referencePanel = page.locator('.review-workspace__panel--references');
  expect(await referencePanel.evaluate((element) => (element as HTMLElement).offsetWidth - element.clientWidth)).toBe(0);
  await expect(page.locator('[data-review-workspace]')).toHaveAttribute('data-workspace-presentation', 'bottom');
  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  const zoom = page.getByRole('textbox', { name: /Current zoom \d+ percent\. Enter a zoom percentage/u });
  await zoom.fill('250');
  await zoom.press('Enter');
  await expect.poll(() => viewport.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 760) {
      await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-annotation-presentation', 'bottom');
      await openAnnotationsWorkspace(page);
    }
    const geometry = await viewport.evaluate((element) => {
      const frame = document.querySelector('.review-overlay-frame')!;
      return {
        clip: getComputedStyle(frame).clipPath,
        rightInset: (element as HTMLElement).offsetWidth - element.clientWidth,
        bottomInset: (element as HTMLElement).offsetHeight - element.clientHeight,
        bottom: element.getBoundingClientRect().bottom,
      };
    });
    // Decorative overlays leave the native scrollbar edge unobstructed.
    expect(geometry.clip).toBe(geometry.rightInset === 0 && geometry.bottomInset === 0
      ? 'inset(0px)' : `inset(0px ${geometry.rightInset}px ${geometry.bottomInset}px 0px)`);
    expect(geometry.bottom).toBe(900);
    await expect(viewport).toHaveCSS('scrollbar-width', 'auto');
    await expect(viewport).toHaveCSS('scrollbar-color', await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('scrollbar-color')));
    expect(await viewport.evaluate((element) => getComputedStyle(element, '::-webkit-scrollbar').width)).toBe('auto');
    const scrollGeometry = () => viewport.evaluate((element) => ({
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      pageLeft: element.querySelector('[data-page-index]')!.getBoundingClientRect().left,
    }));
    await page.locator('[data-review-stage]').evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
    });
    const beforeScroll = await scrollGeometry();
    await viewport.evaluate((element) => { element.scrollTop += 25; });
    expect(await scrollGeometry()).toEqual(beforeScroll);

  }
});

test('defaults a real PDF to fit width and refits bottom and resizable right reading widths', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, 'Fit Width production launch failed');
  // Exercise native scrollbar occupancy without changing the host's preferences.
  await page.route('**/__test-scrollbar.css', (route) => route.fulfill({
    contentType: 'text/css',
    body: `.review-document .pdf-workspace__viewport::-webkit-scrollbar { width: 12px; height: 12px; }
      .review-document .pdf-workspace__viewport::-webkit-scrollbar-thumb { background: #888; }`,
  }));
  await page.addStyleTag({ url: new URL('/__test-scrollbar.css', page.url()).href });

  const mainWorkspace = page.locator('.pdf-workspace:not(.pdf-workspace--reference)');
  const mainViewport = mainWorkspace.locator('[data-viewer-framing-viewport]');
  const mainPage = mainWorkspace.locator("[data-page-index='0']");
  const referenceWorkspace = page.locator('[data-review-workspace]');
  const fitWidth = page.getByRole('menuitem', { name: 'Fit width' });
  const fitAndWait = async () => {
    const trigger = page.getByRole('button', { name: 'Open zoom controls' });
    await trigger.focus();
    if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await trigger.press('Enter');
    await expect(page.getByRole('menu', { name: 'PDF zoom', exact: true })).toBeVisible();
    await expect(fitWidth).toBeVisible();
    await fitWidth.click();
    await expect(fitWidth).toHaveCount(0);
  };
  const zoomValue = () => page.getByRole('textbox', {
    name: /Current zoom \d+ percent\. Enter a zoom percentage/u,
  });
  await expect(mainPage).toBeVisible();
  await waitForRenderedPageImage(mainPage);
  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await page.getByRole('button', { name: 'Open zoom controls' }).click();
  await expect(fitWidth).toHaveCount(0);
  await expect(mainViewport).toHaveCSS('scrollbar-gutter', 'stable');
  await mainWorkspace.evaluate((element) => element.setAttribute('data-fit-width-main-mount', 'stable'));
  await expect(page.getByRole('textbox', { name: /Current page 1 of 4/u })).toHaveValue('1');

  const horizontalGeometry = async (rightEdge?: number) => {
    const [viewportBounds, pageBounds, clientBox, runwayRight] = await Promise.all([
      mainViewport.boundingBox(),
      mainPage.boundingBox(),
      mainViewport.evaluate((element) => ({
        left: element.clientLeft,
        width: element.clientWidth,
      })),
      mainWorkspace.locator('[data-viewer-runway]').evaluate((element) => {
        const parent = element.parentElement;
        return parent === null
          ? 0
          : Math.max(0, element.getBoundingClientRect().width - parent.getBoundingClientRect().width);
      }),
    ]);
    if (!viewportBounds || !pageBounds) throw new Error('Fit Width geometry is unavailable.');
    const intervalLeft = viewportBounds.x + clientBox.left;
    const clientRight = intervalLeft + clientBox.width;
    const fade = page.locator('.review-overlay-frame__right-fade:visible');
    const fadeLeft = await fade.count() > 0 ? (await fade.boundingBox())?.x : undefined;
    const intervalRight = Math.min(rightEdge ?? clientRight, clientRight - runwayRight, rightEdge === undefined ? (fadeLeft ?? clientRight) : clientRight);
    return {
      pageWidth: pageBounds.width,
      intervalWidth: intervalRight - intervalLeft,
      leftGap: pageBounds.x - intervalLeft,
      rightGap: intervalRight - (pageBounds.x + pageBounds.width),
      pageLeft: pageBounds.x,
      pageRight: pageBounds.x + pageBounds.width,
      intervalLeft,
      intervalRight,
    };
  };
  const expectFitted = async (standardGap: number, rightEdge?: number) => {
    const rightGap = rightEdge === undefined ? 0 : standardGap;
    await expect.poll(async () => {
      const geometry = await horizontalGeometry(rightEdge);
      return Math.max(
        Math.abs(geometry.pageWidth - (geometry.intervalWidth - standardGap - rightGap)),
        Math.abs(geometry.leftGap - standardGap),
        Math.abs(geometry.rightGap - rightGap),
      );
    }).toBeLessThan(3);
    const geometry = await horizontalGeometry(rightEdge);
    expect(geometry.pageLeft).toBeGreaterThanOrEqual(geometry.intervalLeft + standardGap - 3);
    expect(geometry.pageRight).toBeLessThanOrEqual(geometry.intervalRight - rightGap + 3);
    return geometry;
  };

  const standardGap = 52;
  const closedGeometry = await expectFitted(standardGap);
  const expectScrollbarAtWindowEdge = async () => {
    if (await fitWidth.isVisible()) {
      await page.keyboard.press('Escape');
      await expect(fitWidth).toHaveCount(0);
    }
    const stageBounds = (await page.locator('[data-review-stage]').boundingBox())!;
    await expect.poll(async () => {
      const bounds = (await mainViewport.boundingBox())!;
      return Math.abs(bounds.x + bounds.width - stageBounds.x - stageBounds.width);
    }).toBeLessThan(1);
    const before = await mainViewport.evaluate((element) => element.scrollTop);
    const x = stageBounds.x + stageBounds.width - 6;
    const y = stageBounds.y + stageBounds.height * 0.8;
    expect(await mainViewport.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element, { x, y })).toBe(true);
    if (testInfo.project.use.headless === false) {
      await page.mouse.click(x, y);
    } else {
      // Headless browsers suppress native scrollbar clicks. Wheel input still
      // proves the outer gutter reaches the actual PDF scrollport.
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, 300);
    }
    await expect.poll(() => mainViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
    await mainViewport.evaluate((element, top) => { element.scrollTop = top; }, before);
  };
  await expectScrollbarAtWindowEdge();
  await expect.poll(() => mainViewport.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBe(0);
  await mainViewport.evaluate((element) => { element.scrollLeft = 30; });
  expect(await mainViewport.evaluate((element) => element.scrollLeft)).toBe(0);
  const closedZoom = await zoomValue().inputValue();
  await zoomValue().fill('250');
  await zoomValue().press('Enter');
  await expect.poll(() => mainViewport.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeGreaterThan(0);
  await fitAndWait();
  await expectFitted(standardGap);
  await expect.poll(() => mainViewport.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBe(0);

  const primaryLink = mainWorkspace.getByRole('button', {
    name: 'Open PDF link to Primary result, Page 2',
  });
  await openLinkInReferences(page, primaryLink);
  await expect(referenceWorkspace).toHaveAttribute('data-workspace-open', 'true');
  await expect(referenceWorkspace).toHaveAttribute('data-workspace-presentation', 'bottom');
  const primaryTab = page.getByRole('tab', { name: /Primary result/u });
  await expectReferenceReady(page, primaryTab);
  await referenceWorkspace.evaluate((element) => {
    element.setAttribute('data-fit-width-workspace-mount', 'stable');
  });

  expect(await zoomValue().inputValue()).toBe(closedZoom);
  const bottomGeometry = await expectFitted(standardGap);
  expect(bottomGeometry.pageWidth).toBeCloseTo(closedGeometry.pageWidth, 0);
  await expect(page.getByRole('textbox', { name: /Current page 1 of 4/u })).toHaveValue('1');

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-annotation-presentation', 'bottom');
  expect(await zoomValue().inputValue()).toBe(closedZoom);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-annotation-presentation', 'right');
  expect(await zoomValue().inputValue()).toBe(closedZoom);

  await clickHoverRevealedReferenceDockAction(
    page.getByRole('button', { name: 'Move References to right' }),
  );
  await expect(referenceWorkspace).toHaveAttribute('data-workspace-presentation', 'right');
  await expect.poll(() => referenceWorkspace.evaluate((element) => getComputedStyle(element).transform))
    .toBe('none');
  await expect.poll(async () => (await referenceWorkspace.boundingBox())?.x ?? 0)
    .toBeGreaterThan(0);
  const rightWorkspaceBounds = await referenceWorkspace.boundingBox();
  if (!rightWorkspaceBounds) throw new Error('Right workspace has no bounds.');
  expect(await zoomValue().inputValue()).toBe(closedZoom);
  expect(await mainPage.boundingBox().then((bounds) => bounds?.width))
    .toBeCloseTo(bottomGeometry.pageWidth, 0);
  await expect.poll(async () => {
    const bounds = (await mainWorkspace.boundingBox())!;
    return Math.abs(bounds.x + bounds.width - rightWorkspaceBounds.x);
  }).toBeLessThan(1);
  await fitAndWait();
  const initialRightGeometry = await expectFitted(24, rightWorkspaceBounds.x);
  await expectScrollbarAtWindowEdge();
  expect(initialRightGeometry.pageWidth).toBeLessThan(bottomGeometry.pageWidth);
  const rightFitZoom = await zoomValue().inputValue();

  const rightSplitter = page.getByRole('separator', { name: 'Resize References' });
  await expect(rightSplitter).toHaveAttribute('aria-orientation', 'vertical');
  await rightSplitter.press('ArrowLeft');
  await expect.poll(async () => (await referenceWorkspace.boundingBox())?.width ?? 0)
    .toBeGreaterThan(rightWorkspaceBounds.width);
  const resizedWorkspaceBounds = await referenceWorkspace.boundingBox();
  if (!resizedWorkspaceBounds) throw new Error('Resized right workspace has no bounds.');
  expect(await zoomValue().inputValue()).toBe(rightFitZoom);
  expect(await mainPage.boundingBox().then((bounds) => bounds?.width)).toBeCloseTo(
    initialRightGeometry.pageWidth,
    0,
  );

  await fitAndWait();
  const resizedRightGeometry = await expectFitted(24, resizedWorkspaceBounds.x);
  expect(resizedRightGeometry.pageWidth).toBeLessThan(initialRightGeometry.pageWidth);
  const resizedFitZoom = await zoomValue().inputValue();

  await page.setViewportSize({ width: 1240, height: 900 });
  await expect(referenceWorkspace).toHaveAttribute('data-workspace-presentation', 'right');
  expect(await zoomValue().inputValue()).toBe(resizedFitZoom);
  expect(await mainPage.boundingBox().then((bounds) => bounds?.width)).toBeCloseTo(
    resizedRightGeometry.pageWidth,
    0,
  );
  await fitAndWait();
  const resizedViewportWorkspaceBounds = await referenceWorkspace.boundingBox();
  if (!resizedViewportWorkspaceBounds) throw new Error('Responsive right workspace has no bounds.');
  await expectFitted(24, resizedViewportWorkspaceBounds.x);

  await expect(mainWorkspace).toHaveAttribute('data-fit-width-main-mount', 'stable');
  await expect(referenceWorkspace).toHaveAttribute('data-fit-width-workspace-mount', 'stable');
  await expect(primaryTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: /Current page 1 of 4/u })).toHaveValue('1');

  await openFreshProductionFixture(page, pdf, 'Annotation tray Fit Width launch failed');
  await expect(mainPage).toBeVisible();
  await waitForRenderedPageImage(mainPage);
  await page.getByRole('button', { name: 'Show workspace' }).click();
  const toolsWorkspace = page.locator('#review-tools-workspace');
  await expect(toolsWorkspace).toHaveAttribute('data-tools-workspace-open', 'true');
  await expect.poll(() => toolsWorkspace.evaluate((element) => getComputedStyle(element).transform))
    .toBe('none');
  const toolsBounds = await toolsWorkspace.boundingBox();
  if (!toolsBounds) throw new Error('Right annotation workspace has no bounds.');
  await expectFitted(24, toolsBounds.x);

  const zoomInput = zoomValue();
  await zoomInput.fill('100');
  await zoomInput.press('Enter');
  await expect(zoomValue()).toHaveValue('100');
  const preFitRightGap = (await horizontalGeometry(toolsBounds.x)).rightGap;
  const fitTransition = mainPage.evaluate(async (pageElement) => {
    const rightGaps: number[] = [];
    await new Promise<void>((resolve) => {
      let frame = 0;
      const sample = () => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            const tray = document.querySelector<HTMLElement>('#review-tools-workspace');
            if (tray) {
              rightGaps.push(tray.getBoundingClientRect().left - pageElement.getBoundingClientRect().right);
            }
            frame += 1;
            if (frame >= 30) resolve();
            else sample();
          }, 0);
        });
      };
      sample();
      document.documentElement.dataset.fitTransitionSampler = 'ready';
    });
    delete document.documentElement.dataset.fitTransitionSampler;
    return rightGaps;
  });
  await expect.poll(() => page.evaluate(
    () => document.documentElement.dataset.fitTransitionSampler,
  )).toBe('ready');
  await fitAndWait();
  const paintedRightGaps = await fitTransition;
  expect(paintedRightGaps.length).toBeGreaterThan(0);
  expect(Math.min(...paintedRightGaps))
    .toBeGreaterThanOrEqual(Math.min(preFitRightGap, 24) - 3);
  await expectFitted(24, toolsBounds.x);
  await expect(zoomValue()).not.toHaveValue('100');
});

test('refits opening workspaces only from fit width and preserves manual reading', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const launched = await host.open({
    pdfPath: await freshProductionPdf(pdf),
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Fresh adaptive annotations launch failed');
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(launched.url);
  await chooseFreshCopyDestination(page);

  const stage = page.locator('[data-review-stage]');
  const drawer = page.locator('#review-tools-workspace');
  const viewport = page.locator('[data-viewer-framing-viewport]');
  const pdfPage = page.locator("[data-page-index='0']").first();
  const runway = page.locator('[data-viewer-runway]');
  const workspace = page.locator('.pdf-workspace');
  await expect(pdfPage).toBeVisible();
  await expect(viewport).toHaveCount(1);
  await expect(runway).toHaveCount(1);
  await expect.poll(() => currentZoomText(page)).toMatch(/\d+%/u);
  await workspace.evaluate((element) => { element.setAttribute('data-adaptive-mount-probe', 'stable'); });

  await expect.poll(() => viewport.evaluate(async (element) => {
    const before = element.scrollTop;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return Math.abs(element.scrollTop - before);
  })).toBeLessThan(0.5);

  const initialWidth = (await pdfPage.boundingBox())!.width;
  await openAnnotationsWorkspace(page);
  await expect(drawer).toHaveAttribute('data-workspace-presentation', 'right');
  const expectOpeningFit = async () => {
    await expect.poll(() => drawer.evaluate((element) => getComputedStyle(element).transform))
      .toBe('none');
    await expect.poll(async () => {
      const pageBounds = (await pdfPage.boundingBox())!;
      const viewportBounds = (await viewport.boundingBox())!;
      const client = await viewport.evaluate((element) => ({ left: element.clientLeft, width: element.clientWidth }));
      const readingBounds = (await workspace.boundingBox())!;
      const right = Math.min(viewportBounds.x + client.left + client.width, readingBounds.x + readingBounds.width);
      const gap = await stage.getAttribute('data-right-surface-open') === 'true' ? 24 : 10;
      return Math.max(Math.abs(pageBounds.x - viewportBounds.x - client.left - gap),
        Math.abs(right - pageBounds.x - pageBounds.width - gap));
    }).toBeLessThan(3);
  };
  await expectOpeningFit();
  expect((await pdfPage.boundingBox())!.width).toBeLessThan(initialWidth);
  const fittedZoom = await currentZoomText(page);
  await toggleWorkspace(page);
  await expect(drawer).toBeHidden();
  expect(await currentZoomText(page)).toBe(fittedZoom);

  await zoomInOnce(page);
  const manualZoom = await currentZoomText(page);
  await toggleWorkspace(page);
  await expect(drawer).toBeVisible();
  expect(await currentZoomText(page)).toBe(manualZoom);

  await zoomInOnce(page);
  const zoomAfterManualAdjustment = await currentZoomText(page);
  await page.setViewportSize({ width: 1240, height: 900 });
  await expect(stage).toHaveAttribute('data-annotation-presentation', 'right');
  expect(await currentZoomText(page)).toBe(zoomAfterManualAdjustment);
  await toggleWorkspace(page);
  await expect(drawer).toBeHidden();
  expect(await currentZoomText(page)).toBe(zoomAfterManualAdjustment);
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(stage).toHaveAttribute('data-annotation-presentation', 'bottom');
  await viewport.evaluate((element) => {
    element.scrollTop = Math.min(240, Math.max(0, element.scrollHeight - element.clientHeight));
  });
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await toggleWorkspace(page);
  await expect(drawer).toHaveAttribute('data-workspace-presentation', 'bottom');
  const narrowStage = await stage.boundingBox();
  const bottomDrawer = await drawer.boundingBox();
  if (!narrowStage || !bottomDrawer) throw new Error('Bottom annotations geometry is unavailable.');
  expect(bottomDrawer.x - narrowStage.x).toBeCloseTo(await expectedWorkspaceInset(page), 0);
  expect(narrowStage.x + narrowStage.width - bottomDrawer.x - bottomDrawer.width).toBeCloseTo(await expectedWorkspaceInset(page), 0);
  expect(narrowStage.y + narrowStage.height - bottomDrawer.y - bottomDrawer.height).toBeCloseTo(await expectedWorkspaceInset(page), 0);
  expect(bottomDrawer.height).toBeCloseTo(narrowStage.height * 0.43, 0);
  expect(await currentZoomText(page)).toBe(zoomAfterManualAdjustment);
  await toggleWorkspace(page);

  const pageBox = await pdfPage.boundingBox();
  const narrowViewportBox = await viewport.boundingBox();
  if (!pageBox || !narrowViewportBox) throw new Error('Narrow PDF page has no bounds.');
  const futureSheetTop = bottomDrawer.y;
  const noteClientX = Math.max(
    pageBox.x + 28,
    Math.min(pageBox.x + pageBox.width * 0.7, narrowViewportBox.x + narrowViewportBox.width - 28),
  );
  const noteClientY = Math.max(
    pageBox.y + 28,
    narrowViewportBox.y + 28,
    Math.min(
      pageBox.y + pageBox.height - 28,
      futureSheetTop + 48,
      narrowViewportBox.y + narrowViewportBox.height - 28,
    ),
  );
  await page.mouse.click(noteClientX, noteClientY, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
  const noteComment = page.getByRole('textbox', { name: 'Comment' });
  await noteComment.fill('Reveal this note above the sheet.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(noteComment).toHaveCount(0);
  await expect.poll(() => host.broker.saveStatus(launched.sessionId)?.sync.phase).toBe('clean');

  const noteMark = page.locator('[data-owned-mark="pageNote"]').last();
  const noteFocus = page.locator('[data-owned-focus-id]').last();
  await expect(noteMark).toBeVisible();
  const markBefore = await noteMark.boundingBox();
  const markScrollBefore = await viewport.evaluate((element) => element.scrollTop);
  if (!markBefore) throw new Error('Page Note mark has no bounds.');
  expect(markBefore.y + markBefore.height).toBeGreaterThan(futureSheetTop - 1);

  await noteFocus.evaluate((element) => {
    (element as HTMLElement).focus({ preventScroll: true });
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
  });
  const notePeek = page.getByRole('complementary', { name: 'Page Note annotation preview' });
  await expect(notePeek).toBeVisible();
  await expect(drawer).toBeHidden();
  expect(await viewport.evaluate((element) => element.scrollTop)).toBeCloseTo(markScrollBefore, 0);
  await page.getByRole('button', { name: 'Show workspace' }).click();
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('data-workspace-presentation', 'bottom');
  await expect(notePeek).toHaveCount(0);
  expect(await currentZoomText(page)).toBe(zoomAfterManualAdjustment);
  const activeReviewId = await noteMark.getAttribute('data-review-id');
  if (!activeReviewId) throw new Error('Page Note mark has no canonical review id.');
  await expect(page.locator(`[data-review-item="${activeReviewId}"]`)).toHaveAttribute('data-active', 'true');
  await expect.poll(async () => {
    const mark = await noteMark.boundingBox();
    const sheet = await drawer.boundingBox();
    return mark && sheet ? sheet.y - (mark.y + mark.height) : Number.NEGATIVE_INFINITY;
  }).toBeGreaterThanOrEqual(9);
  await expect.poll(() => viewport.evaluate(async (element) => {
    const start = element.scrollTop;
    for (let frame = 0; frame < 8; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (Math.abs(element.scrollTop - start) > 0.5) return false;
    }
    return true;
  })).toBe(true);
  const revealedScrollTop = await viewport.evaluate((element) => element.scrollTop);

  await page.setViewportSize({ width: 760, height: 820 });
  await expect(stage).toHaveAttribute('data-annotation-presentation', 'bottom');
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeCloseTo(revealedScrollTop, 0);

  const responsiveZoom = await currentZoomText(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(stage).toHaveAttribute('data-annotation-presentation', 'right');
  await expect(drawer).toBeVisible();
  await expect(page.locator(`[data-review-item="${activeReviewId}"]`)).toHaveAttribute('data-active', 'true');
  await expect(workspace).toHaveAttribute('data-adaptive-mount-probe', 'stable');
  expect(await currentZoomText(page)).toBe(responsiveZoom);
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(stage).toHaveAttribute('data-annotation-presentation', 'bottom');
  await expect(drawer).toBeVisible();
  await expect(page.locator(`[data-review-item="${activeReviewId}"]`)).toHaveAttribute('data-active', 'true');
  await expect(workspace).toHaveAttribute('data-adaptive-mount-probe', 'stable');

  const pageBeforeFinalClose = await pdfPage.boundingBox();
  if (!pageBeforeFinalClose) throw new Error('Final open-workspace PDF page has no bounds.');
  const scrollBeforeFinalClose = await viewport.evaluate((element) => element.scrollTop);
  await toggleWorkspace(page);
  await expect.poll(() => viewport.evaluate((element, previousTop) => {
    const reachableTop = Math.min(previousTop, Math.max(0, element.scrollHeight - element.clientHeight));
    return Math.abs(element.scrollTop - reachableTop);
  }, scrollBeforeFinalClose)).toBeLessThan(0.5);
  await expect.poll(async () => {
    const pageAfterFinalClose = await pdfPage.boundingBox();
    return pageAfterFinalClose?.x ?? Number.NaN;
  }).toBeCloseTo(pageBeforeFinalClose.x, 0);
});

test('uses the same expanded review tree for a narrow VS Code embed launch', async ({ page }) => {
  const launched = await host.open({
    pdfPath: await freshProductionPdf(referencePdf),
    sourceRootPath: sourceRoot,
    surface: 'vscode',
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') throw new Error('VS Code embed launch failed');
  const initialState = host.broker.state(launched.sessionId);
  if (!initialState) throw new Error('VS Code embed review state is missing.');
  await host.broker.acceptMutation(
    launched.sessionId,
    addPageNote(
      initialState,
      0,
      { x: 80, y: 160, width: 18, height: 18 },
      'Narrow toolbar history probe.',
    ),
  );
  expect(new URL(launched.url).searchParams.get('embed')).toBe('vscode');
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(launched.url);
  await chooseFreshCopyDestination(page);
  const revisionBeforeHistory = host.broker.state(launched.sessionId)!.revision;
  await expect(page.locator('[data-production-review]')).toHaveCount(1);
  const chrome = page.locator('[data-review-chrome]');
  await expect(chrome).toHaveCount(1);
  await expect(chrome).toHaveAttribute('data-review-chrome-presentation', 'expanded');
  await expect(page.locator('.pdf-workspace')).toHaveCount(1);
  const pdfPage = page.locator("[data-page-index='0']").first();
  await expect(pdfPage).toBeVisible();
  const { workspace: workspaceControl } = await openAnnotationsWorkspace(page);
  await expect(page.getByRole('button', { name: 'Close annotations' })).toHaveCount(0);
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-annotation-presentation', 'bottom');
  await expect.poll(async () => {
    const box = await page.locator('#review-tools-workspace').boundingBox();
    return box === null ? Number.POSITIVE_INFINITY : Math.abs(box.x + box.width - 320);
  }).toBeCloseTo(await expectedWorkspaceInset(page), 0);

  const expectMenuInsideViewport = async (menu: ReturnType<Page['locator']>) => {
    const bounds = await menu.boundingBox();
    if (!bounds) throw new Error('Compact top-bar menu has no bounds.');
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(720);
  };

  const undo = page.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeEnabled();
  await chrome.hover({ position: { x: 2, y: 2 } });
  await undo.click();
  const redo = page.getByRole('button', { name: 'Redo' });
  await expect(redo).toBeEnabled();
  await chrome.hover({ position: { x: 2, y: 2 } });
  await redo.click();

  const pageInput = page.getByRole('textbox', {
    name: 'Current page 1 of 4. Enter a page number',
  });
  await pageInput.fill('2');
  await pageInput.press('Enter');
  await expect(page.getByRole('textbox', {
    name: 'Current page 2 of 4. Enter a page number',
  })).toBeFocused();
  const navigationTrigger = page.getByRole('button', {
    name: 'Page 2 of 4. Open page navigation',
  });
  await navigationTrigger.click();
  const navigationMenu = page.getByRole('menu', { name: 'Page navigation' });
  await expect(navigationMenu).toBeVisible();
  await expectMenuInsideViewport(navigationMenu);
  const previousPage = navigationMenu.getByRole('menuitem', { name: 'Previous page' });
  await previousPage.click();
  await expect(navigationMenu).toBeVisible();
  await expect(navigationMenu.getByRole('menuitem', { name: 'Next page' })).toBeFocused();
  await expect(page.getByRole('textbox', {
    name: 'Current page 1 of 4. Enter a page number',
  })).toBeVisible();

  const zoomInput = page.getByRole('textbox', { name: /Current zoom \d+ percent/u });
  const zoomBefore = await currentZoomText(page);
  const zoomTrigger = page.getByRole('button', { name: 'Open zoom controls' });
  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await zoomTrigger.click();
  await expect(navigationMenu).toHaveCount(0);
  const zoomMenu = page.getByRole('menu', { name: 'PDF zoom' });
  await expect(zoomMenu).toBeVisible();
  await expectMenuInsideViewport(zoomMenu);
  const zoomIn = zoomMenu.getByRole('menuitem', { name: 'Zoom in' });
  await zoomIn.click();
  await expect(zoomMenu).toBeVisible();
  await expect(zoomIn).toBeFocused();
  await expect.poll(() => currentZoomText(page)).not.toBe(zoomBefore);
  await page.keyboard.press('Escape');
  await expect(zoomMenu).toHaveCount(0);
  await expect(zoomTrigger).toBeFocused();
  await expect(zoomInput).toBeVisible();
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');

  const scrollViewport = page.locator('[data-viewer-framing-viewport]');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const scrollable = await scrollViewport.evaluate((element) => element.scrollHeight > element.clientHeight);
    if (scrollable) break;
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    await zoomTrigger.click();
    await page.getByRole('menu', { name: 'PDF zoom' })
      .getByRole('menuitem', { name: 'Zoom in' }).click();
    await page.keyboard.press('Escape');
  }
  await expect.poll(() => scrollViewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');
  const scrollBefore = await scrollViewport.evaluate((element) => element.scrollTop);
  const stage = await page.locator('[data-review-stage]').boundingBox();
  if (!stage) throw new Error('Review stage has no bounds.');
  await page.mouse.move(stage.x + 24, stage.y + stage.height / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => scrollViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollBefore);
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');

  await scrollViewport.dispatchEvent('pointerdown', {
    pointerId: 41, pointerType: 'touch', isPrimary: true, button: 0, clientX: 24, clientY: 300,
  });
  const touchScrollLeft = await scrollViewport.evaluate((element) => {
    element.scrollLeft = Math.min(element.scrollLeft + 48, element.scrollWidth - element.clientWidth);
    return element.scrollLeft;
  });
  expect(touchScrollLeft).toBeGreaterThan(0);
  await scrollViewport.dispatchEvent('pointerdown', {
    pointerId: 42, pointerType: 'touch', isPrimary: false, button: 0, clientX: 30, clientY: 300,
  });
  await scrollViewport.dispatchEvent('pointerup', {
    pointerId: 42, pointerType: 'touch', isPrimary: false, button: 0, clientX: 30, clientY: 300,
  });
  await scrollViewport.dispatchEvent('pointerup', {
    pointerId: 41, pointerType: 'touch', isPrimary: true, button: 0, clientX: 24, clientY: 300,
  });
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');

  const dragStart = { x: stage.x + 24, y: stage.y + stage.height / 2 };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x, dragStart.y + 18);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.up();
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');

  await scrollViewport.evaluate((element) => {
    element.dataset.pointerCancels = '0';
    element.addEventListener('pointercancel', () => {
      element.dataset.pointerCancels = String(Number(element.dataset.pointerCancels ?? '0') + 1);
    });
  });
  await page.mouse.click(stage.x + 24, stage.y + stage.height / 2);
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');
  await expect(scrollViewport).toHaveAttribute('data-pointer-cancels', '0');
  await toggleWorkspace(page);
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'false');
  expect(await scrollViewport.evaluate((element) => element.scrollLeft)).toBeCloseTo(touchScrollLeft, 0);
  expect(host.broker.state(launched.sessionId)?.revision).toBe(revisionBeforeHistory + 2);
  expect(host.broker.state(launched.sessionId)?.items).toHaveLength(initialState.items.length + 1);
});

for (const surface of ['browser', 'vscode'] as const) {
  test(`uses the shared generated-output document menu and blocked route on ${surface}`, async ({ page }) => {
    const launched = await host.open({
      pdfPath: await freshProductionPdf(pdf),
      sourceRootPath: sourceRoot,
      surface,
      workflowMode: 'generated-output',
      fork: true,
    });
    if (!launched.ok || launched.kind === 'recovery-offered') {
      throw new Error(`${surface} generated-output launch failed`);
    }
    const state = host.broker.state(launched.sessionId);
    if (!state) throw new Error(`${surface} generated-output state is unavailable`);
    const timestamp = '2026-08-31T12:00:00.000Z';
    await host.broker.acceptMutation(launched.sessionId, {
      type: 'put-draft',
      expectedRevision: state.revision,
      expectedDraftRevision: -1,
      draft: {
        id: randomUUID(),
        ownerViewId: `acceptance-${surface}`,
        baseGeneration: state.workflow.documentGeneration,
        revision: 0,
        kind: 'highlight',
        pageIndex: 0,
        text: 'Keep this protected generated-output draft.',
        anchor: {
          kind: 'selection',
          pageIndex: 0,
          quote: 'existing supported highlight',
          prefix: 'Before ',
          suffix: ' after.',
          rect: { x: 72, y: 92, width: 120, height: 14 },
          segmentRects: [{ x: 72, y: 92, width: 120, height: 14 }],
        },
        disposition: {
          kind: 'missing',
          reason: 'The previous passage is not present in this PDF.',
        },
        status: 'protected',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });

    await page.setViewportSize({ width: 760, height: 900 });
    await page.goto(launched.url);
    const review = page.locator('[data-production-review]');
    await expect(review).toHaveAttribute('data-launch-surface', surface);
    const firstPage = page.locator("[data-page-index='0']").first();
    await waitForRenderedPageImage(firstPage);
    const viewer = page.locator('.pdf-workspace:not(.pdf-workspace--reference)');
    await viewer.evaluate((element) => {
      element.setAttribute('data-shared-menu-mount-probe', 'stable');
    });
    await zoomInOnce(page);
    const zoomBefore = await currentZoomText(page);

    const trigger = page.getByRole('button', { name: /Open document actions$/u });
    await expect(trigger.locator('.review-icon')).toHaveCount(1);
    await trigger.click();
    const menu = page.getByRole('menu', { name: /Actions for/u });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('data-export-eligibility', 'blocked');
    const exportAction = menu.getByRole('menuitem', { name: 'Export', exact: true });
    await expect(exportAction).toHaveAttribute('aria-disabled', 'true');
    await expect(menu.getByText('1 annotation to resolve.')).toBeVisible();
    const openAnnotations = menu.getByRole('menuitem', { name: 'Open Annotations' });
    await expect(openAnnotations).toHaveClass(/document-actions__annotations-link/u);
    await expect(openAnnotations.locator('.review-icon')).toBeVisible();
    await openAnnotations.click();

    await expect(page.getByRole('tab', { name: 'Annotations', exact: true }))
      .toHaveAttribute('aria-selected', 'true');
    const attention = page.getByRole('region', { name: 'Needs attention' });
    await expect(attention).toBeVisible();
    const pendingDraft = attention.getByRole('button', {
      name: 'Reattach previous Highlight annotation on page 1',
    });
    await expect(pendingDraft).toBeFocused();
    await expect(page.getByRole('region', { name: 'Annotations', exact: true })
      .locator('[data-annotation-origin="owned"]')).not.toHaveCount(0);
    await expect(viewer).toHaveAttribute('data-shared-menu-mount-probe', 'stable');
    expect(await currentZoomText(page)).toBe(zoomBefore);
    const panelGeometry = await page.locator('#workspace-panel-annotations').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(panelGeometry.scrollWidth).toBeLessThanOrEqual(panelGeometry.clientWidth + 1);
  });
}

test('allows PDF text interaction without dismissing the Annotation Tray', async ({ page }) => {
  const launched = await host.open({
    pdfPath: await freshProductionPdf(pdf),
    sourceRootPath: sourceRoot,
    surface: 'vscode',
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Fresh tray-dismiss launch failed');
  }
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto(launched.url);
  const pdfPage = page.locator("[data-page-index='0']").first();
  await waitForRenderedPageImage(pdfPage);
  const { workspace: workspaceControl } = await openAnnotationsWorkspace(page);
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-annotation-presentation', 'bottom');

  const box = await pdfPage.boundingBox();
  if (!box) throw new Error('Rendered PDF page has no bounds.');
  await page.mouse.click(box.x + 76, box.y + 98);
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');
  await page.mouse.move(box.x + 245, box.y + 98);
  await page.waitForTimeout(250);
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');
});

for (const selection of [
  { label: 'forward two-page', start: 0, end: 1, pages: [1, 2] },
  { label: 'reverse three-page', start: 2, end: 0, pages: [1, 2, 3] },
] as const) {
  test(`copies a real ${selection.label} Main PDF selection through the platform shortcut and native paste`, async ({ page }) => {
    const launched = await openFreshProductionFixture(
      page,
      crossPagePdf,
      'Cross-page Main copy launch failed',
    );
    const pasteTarget = await installPlainTextPasteTarget(page);
    const main = page.locator('[data-pdf-copy-surface="main"]');
    const expectedText = selection.pages.map((pageNumber) => (
      `PAGE ${String(pageNumber).padStart(2, '0')}: cross-page semantic selection contract.`
    )).join('\n');

    await dragAcrossProductionPdfPages(page, main, selection.start, selection.end);
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toBe(expectedText);

    const selectedPage = main.locator(`[data-page-index="${selection.end}"]`);
    const selectedPageBox = await selectedPage.boundingBox();
    if (!selectedPageBox) throw new Error('Selected PDF page has no bounds.');
    await armContextMenuDefaultProbe(page);
    await page.mouse.click(selectedPageBox.x + 180, selectedPageBox.y + 102, {
      button: 'right',
    });
    await expect(page.locator('html'))
      .toHaveAttribute('data-pdf-context-menu-default-prevented', 'false');
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toBe(expectedText);
    await page.keyboard.press(platformCopyShortcut);

    expect(await pasteNativeClipboard(page, pasteTarget)).toBe(expectedText);
    expect(host.broker.state(launched.sessionId)?.revision).toBe(0);
    expect(host.broker.state(launched.sessionId)?.items).toHaveLength(0);
    await expect(main.locator(':scope [data-page-index] > div[style*="mix-blend-mode"]'))
      .not.toHaveCount(0);
  });
}

test('copies a real Main PDF selection from the selection action popup', async ({ page }) => {
  const launched = await openFreshProductionFixture(
    page,
    crossPagePdf,
    'Selection action Copy launch failed',
  );
  const pasteTarget = await installPlainTextPasteTarget(page);
  const main = page.locator('[data-pdf-copy-surface="main"]');
  const expectedText = [
    'PAGE 01: cross-page semantic selection contract.',
    'PAGE 02: cross-page semantic selection contract.',
  ].join('\n');

  await dragAcrossProductionPdfPages(page, main, 0, 1);
  const actions = page.getByRole('toolbar', { name: 'Selection review actions' });
  await expect(actions).toBeVisible();
  await actions.getByRole('button', { name: 'Copy', exact: true }).click();

  await expect.poll(() => page.locator('p.sr-only[role="status"]').allTextContents())
    .toContain('Copied selected text from Main PDF.');
  expect(await pasteNativeClipboard(page, pasteTarget)).toBe(expectedText);

  await pasteTarget.fill('');
  await actions.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(actions.getByRole('button', { name: 'Copy', exact: true })).toBeFocused();
  await page.keyboard.press(platformCopyShortcut);
  expect(await pasteNativeClipboard(page, pasteTarget)).toBe(expectedText);
  await page.evaluate(() => {
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => false,
    });
  });
  await actions.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect.poll(() => page.locator('p.sr-only[role="status"]').allTextContents())
    .not.toContain('Copied selected text from Main PDF.');
  const copyFailure = page.locator('.review-toast--error');
  await expect(copyFailure).toBeVisible();
  await expect(copyFailure).toContainText('could not copy the selected text');
  expect(host.broker.state(launched.sessionId)?.revision).toBe(0);
  expect(host.broker.state(launched.sessionId)?.items).toHaveLength(0);
  await expect(main.locator(':scope [data-page-index] > div[style*="mix-blend-mode"]'))
    .not.toHaveCount(0);
});

test('keeps prior clipboard text while a real cross-page selection is still pending', async ({ page }) => {
  const launched = await openFreshProductionFixture(
    page,
    crossPagePdf,
    'Pending cross-page copy launch failed',
  );
  const main = page.locator('[data-pdf-copy-surface="main"]');
  const pasteTarget = await installPlainTextPasteTarget(page);
  const clipboardSentinel = 'clipboard text from before the pending PDF selection';
  await pasteTarget.fill(clipboardSentinel);
  await pasteTarget.selectText();
  await page.keyboard.press(platformCopyShortcut);

  await dragAcrossProductionPdfPages(page, main, 0, 1, { y: 102 }, async () => {
    await page.keyboard.press(platformCopyShortcut);
    await expect.poll(() => page.locator('p.sr-only[role="status"]').allTextContents())
      .toContain('Selected text is still being read. Retry Copy when it is ready.');
  });

  await pasteTarget.fill('');
  expect(await pasteNativeClipboard(page, pasteTarget)).toBe(clipboardSentinel);
  expect(host.broker.state(launched.sessionId)?.revision).toBe(0);
  await expect(main.locator(':scope [data-page-index] > div[style*="mix-blend-mode"]'))
    .not.toHaveCount(0);
});

test('copies exactly 12 selected pages through the platform shortcut and native paste', async ({ page }) => {
  test.setTimeout(90_000);
  const launched = await openFreshProductionFixture(
    page,
    crossPagePdf,
    'Cross-page 12-page copy launch failed',
  );
  const main = page.locator('[data-pdf-copy-surface="main"]');
  const pasteTarget = await installPlainTextPasteTarget(page);
  const expectedWithinLimit = Array.from({ length: 12 }, (_, index) => (
    `PAGE ${String(index + 1).padStart(2, '0')}: cross-page semantic selection contract.`
  )).join('\n');

  await dragAcrossProductionPdfPages(page, main, 0, 11);
  await page.keyboard.press(platformCopyShortcut);
  expect(await pasteNativeClipboard(page, pasteTarget)).toBe(expectedWithinLimit);

  expect(host.broker.state(launched.sessionId)?.revision).toBe(0);
  expect(host.broker.state(launched.sessionId)?.items).toHaveLength(0);
  await expect(main.locator(':scope [data-page-index] > div[style*="mix-blend-mode"]'))
    .not.toHaveCount(0);
});

test('rejects a real 13-page copy without changing the clipboard, selection, or review state', async ({ page }) => {
  test.setTimeout(90_000);
  const launched = await openFreshProductionFixture(
    page,
    crossPagePdf,
    'Cross-page 13-page copy launch failed',
  );
  const main = page.locator('[data-pdf-copy-surface="main"]');
  const pasteTarget = await installPlainTextPasteTarget(page);
  const clipboardSentinel = 'clipboard remains unchanged after rejected PDF copy';
  await pasteTarget.fill(clipboardSentinel);
  await pasteTarget.selectText();
  await page.keyboard.press(platformCopyShortcut);

  await dragAcrossProductionPdfPages(page, main, 0, 12);
  await page.keyboard.press(platformCopyShortcut);
  const limitError = page.locator('.review-toast--error');
  await expect(limitError).toBeVisible();
  await expect(limitError).toContainText('12 pages');
  await expect(limitError).toHaveAttribute('data-viewer-status');
  await pasteTarget.fill('');
  expect(await pasteNativeClipboard(page, pasteTarget)).toBe(clipboardSentinel);
  expect(host.broker.state(launched.sessionId)?.revision).toBe(0);
  expect(host.broker.state(launched.sessionId)?.items).toHaveLength(0);
  await expect(main.locator(':scope [data-page-index] > div[style*="mix-blend-mode"]'))
    .not.toHaveCount(0);
});

test('rejects every review action from a real 13-page selection without changing review state', async ({ page }) => {
  test.setTimeout(90_000);
  const launched = await openFreshProductionFixture(
    page,
    crossPagePdf,
    'Cross-page 13-page review action launch failed',
  );
  await chooseFreshCopyDestination(page);
  const revisionBeforeSelection = host.broker.state(launched.sessionId)!.revision;
  const main = page.locator('[data-pdf-copy-surface="main"]');
  await dragAcrossProductionPdfPages(page, main, 0, 12);
  await expect.poll(() => page.locator('[data-review-contextual-host]')
    .getAttribute('data-selection-status')).toBe('over-limit');
  const actions = page.getByRole('toolbar', { name: 'Selection review actions' });
  await expect(actions).toBeVisible();

  for (const action of ['Copy', 'Replace', 'Delete', 'Highlight'] as const) {
    await actions.getByRole('button', { name: action, exact: true }).click();
    const limitError = page.locator('.review-toast--error');
    await expect(limitError).toBeVisible();
    await expect(limitError).toContainText('12 pages');
    expect(host.broker.state(launched.sessionId)?.revision).toBe(revisionBeforeSelection);
    expect(host.broker.state(launched.sessionId)?.items).toHaveLength(0);
  }

  await expect(page.getByRole('region', { name: /Replacement|Highlight Comment/u })).toHaveCount(0);
  await expect(main.locator(':scope [data-page-index] > div[style*="mix-blend-mode"]'))
    .not.toHaveCount(0);
});

for (const action of ['Replace', 'Delete', 'Highlight'] as const) {
  test(`creates one atomic cross-page ${action} from a real selection`, async ({ page }) => {
    const launched = await openFreshProductionFixture(
      page,
      crossPagePdf,
      `Cross-page ${action} launch failed`,
    );
    await chooseFreshCopyDestination(page);
    const main = page.locator('[data-pdf-copy-surface="main"]');
    await dragAcrossProductionPdfPages(page, main, 0, 1);
    const actions = page.getByRole('toolbar', { name: 'Selection review actions' });
    await expect(actions).toBeVisible();
    await actions.getByRole('button', { name: action, exact: true }).click();
    if (action === 'Replace') {
      const composer = page.getByRole('region', { name: 'Replacement' });
      await composer.getByRole('textbox', { name: 'Replacement' }).fill('Replacement across pages');
      await composer.getByRole('button', { name: 'Apply' }).click();
    } else if (action === 'Highlight') {
      const composer = page.getByRole('region', { name: 'Highlight Comment' });
      await expect(composer).toBeVisible();
      await composer.getByRole('button', { name: 'Save', exact: true }).click();
    }

    await expect.poll(() => host.broker.state(launched.sessionId)?.items.length).toBe(1);
    await expect.poll(() => host.broker.saveStatus(launched.sessionId)?.sync.phase).toBe('clean');
    const item = host.broker.state(launched.sessionId)?.items[0];
    expect(host.broker.state(launched.sessionId)?.items).toHaveLength(1);
    expect(item?.kind).toBe(action.toLowerCase());
    expect(item?.payload.pages).toHaveLength(2);
    expect(item?.payload.quote).toBe([
      'PAGE 01: cross-page semantic selection contract.',
      'PAGE 02: cross-page semantic selection contract.',
    ].join('\n'));
    await expect(page.locator('[data-review-item]')).toHaveCount(1);
    await expect(page.locator(`[data-review-id="${item!.id}"]`)).toHaveCount(2);

    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await page.locator('[data-review-chrome]').hover();
    await undo.click();
    await expect.poll(() => host.broker.state(launched.sessionId)?.items.length).toBe(0);
    const redo = page.getByRole('button', { name: 'Redo', exact: true });
    await redo.click();
    await expect.poll(() => host.broker.state(launched.sessionId)?.items.length).toBe(1);
    expect(host.broker.state(launched.sessionId)?.items[0]?.id).toBe(item?.id);

    await page.reload();
    await expect(page.locator('[data-production-review]')).toBeVisible();
    await expect(page.locator('[data-review-item]')).toHaveCount(1);
    await expect(page.locator(`[data-review-id="${item!.id}"]`)).toHaveCount(2);
  });
}

test('copies only the focused Main or Reference selection and preserves DOM precedence', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const launched = await openFreshProductionFixture(
    page,
    referencePdf,
    'Focused PDF copy launch failed',
  );
  const initialItems = host.broker.state(launched.sessionId)!.items;
  const main = page.locator('[data-pdf-copy-surface="main"]');
  const primaryLink = main.getByRole('button', {
    name: 'Open PDF link to Primary result, Page 2',
  });
  await openLinkInReferences(page, primaryLink);
  const primaryTab = page.getByRole('tab', { name: /Primary result/u });
  await expectReferenceReady(page, primaryTab);
  const reference = page.locator('[data-pdf-copy-surface="reference"]');
  const pasteTarget = await installPlainTextPasteTarget(page);

  await dragAcrossProductionPdfPages(page, main, 0, 1, { y: 58 });
  await dragAcrossProductionPdfPages(page, reference, 1, 2, { y: 58, endX: 350 });
  await expect(main.locator(':scope [data-page-index] > div[style*="mix-blend-mode"]'))
    .not.toHaveCount(0);
  await expect(reference.locator(':scope [data-page-index] > div[style*="mix-blend-mode"]'))
    .not.toHaveCount(0);
  const referenceText = [
    'Reference navigation fixture — page 2',
    'Primary target. Follow the target-to-target link for details.',
    'Reference navigation fixture — page 3',
  ].join('\n');
  await expect.poll(() => page.evaluate(() => (
    window.getSelection()?.toString().replace(/\r\n?/gu, '\n') ?? ''
  )))
    .toBe(referenceText);
  await reference.locator('[data-page-index="1"]').focus();
  await page.keyboard.press(platformCopyShortcut);
  expect(await page.locator('p.sr-only[role="status"]').allTextContents())
    .toContain('Copied selected text from Reference PDF.');
  const owner = page.locator('[data-pdf-copy-owner]');
  await expect(owner).toHaveAttribute('data-pdf-copy-owner', 'reference');
  await expect(owner).toHaveText('Copy source: Reference PDF');
  expect(await pasteNativeClipboard(page, pasteTarget)).toBe(referenceText);

  await reference.locator('[data-page-index="1"]').focus();
  const closeReferences = page.getByRole('button', { name: 'Hide References' });
  await closeReferences.click();
  const openReferences = page.getByRole('button', { name: 'Show References' });
  await expect(openReferences).toHaveAttribute('aria-expanded', 'false');
  await expect(openReferences).toBeFocused();
  await expect(owner).toHaveAttribute('data-pdf-copy-owner', 'none');
  await expect(owner).toHaveText('Copy source: No PDF focused');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe('');
  await openReferences.click();
  await expect(primaryTab).toBeFocused();
  await page.locator('[data-review-stage]').evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)));
  });

  await pasteTarget.fill('');
  await main.locator('[data-page-index="0"]').focus();
  await expect(owner).toHaveAttribute('data-pdf-copy-owner', 'main');
  await page.keyboard.press(platformCopyShortcut);
  expect(await pasteNativeClipboard(page, pasteTarget)).toBe([
    'Reference navigation fixture — page 1',
    'Body TOC: repeated, aliased, page-only, and distinct-coordinate links',
    'Reference navigation fixture — page 2',
  ].join('\n'));

  const ordinaryDomSentinel = 'ordinary browser selection keeps native copy precedence';
  await page.evaluate((text) => {
    const marker = document.createElement('div');
    marker.id = 'ordinary-dom-selection-sentinel';
    marker.tabIndex = -1;
    marker.style.position = 'fixed';
    marker.style.inset = '8px auto auto 8px';
    marker.style.zIndex = '2147483647';
    marker.append('ordinary selection start ');
    const intersectedBridge = document.createElement('span');
    intersectedBridge.dataset.pdfNativeSelectionBridge = 'test';
    intersectedBridge.textContent = text;
    marker.append(intersectedBridge, ' ordinary selection end');
    document.body.append(marker);
    marker.focus();
    const range = document.createRange();
    range.selectNodeContents(marker);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    delete document.documentElement.dataset.ordinaryDomCopyPrevented;
    window.addEventListener('copy', (event) => {
      document.documentElement.dataset.ordinaryDomCopyPrevented = String(event.defaultPrevented);
    }, { once: true });
  }, ordinaryDomSentinel);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toContain(ordinaryDomSentinel);
  await page.keyboard.press(platformCopyShortcut);
  await expect(page.locator('html')).toHaveAttribute('data-ordinary-dom-copy-prevented', 'false');
  expect(await pasteNativeClipboard(page, pasteTarget)).toContain(ordinaryDomSentinel);
  await page.locator('#ordinary-dom-selection-sentinel').evaluate((marker) => marker.remove());

  await pasteTarget.fill('native editable text');
  await pasteTarget.selectText();
  await page.keyboard.press(platformCopyShortcut);
  await pasteTarget.fill('');
  expect(await pasteNativeClipboard(page, pasteTarget)).toBe('native editable text');
  expect(host.broker.state(launched.sessionId)?.revision).toBe(0);
  expect(host.broker.state(launched.sessionId)?.items).toEqual(initialItems);
  await expect(main.locator(':scope [data-page-index] > div[style*="mix-blend-mode"]'))
    .not.toHaveCount(0);
  await expect(reference.locator(':scope [data-page-index] > div[style*="mix-blend-mode"]'))
    .not.toHaveCount(0);
});

test('clears Main and Reference PDF selections before preserving link actions', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(
    page,
    referencePdf,
    'Selected PDF link launch failed',
  );
  const main = page.locator('[data-pdf-copy-surface="main"]');
  const mainSelection = main.locator(':scope [data-page-index] > div[style*="mix-blend-mode"]');
  await dragAcrossProductionPdfPages(page, main, 0, 1, { y: 58 });
  await expect(page.getByRole('toolbar', { name: 'Selection review actions' })).toBeVisible();
  await expect(mainSelection).not.toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .not.toBe('');

  const primaryLink = main.getByRole('button', {
    name: 'Open PDF link to Primary result, Page 2',
  });
  await primaryLink.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await primaryLink.click();
  await expect(page.getByRole('toolbar', { name: 'Selection review actions' })).toHaveCount(0);
  await expect(mainSelection).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe('');
  const primaryAction = page.getByRole('menuitem', { name: 'Open in References' });
  await expect(primaryAction).toBeFocused();
  await page.keyboard.press('Enter');
  const primaryTab = page.getByRole('tab', { name: /Primary result/u });
  await expectReferenceReady(page, primaryTab);

  const reference = page.locator('[data-pdf-copy-surface="reference"]');
  const referenceSelection = reference.locator(
    ':scope [data-page-index] > div[style*="mix-blend-mode"]',
  );
  await dragAcrossProductionPdfPages(page, reference, 1, 2, { y: 58, endX: 350 });
  await expect(referenceSelection).not.toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .not.toBe('');
  const detailLink = reference.getByRole('button', {
    name: 'Open PDF link to Target-to-target detail link, Page 3',
  });
  await detailLink.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await detailLink.click();
  await expect(referenceSelection).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe('');
  await expect(page.getByRole('menuitem', { name: 'Open in References' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const followAction = page.getByRole('menuitem', { name: 'Follow in this tab' });
  await expect(followAction).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(reference.locator('[data-page-index="2"]')).toBeFocused();
});

test('keeps a Reference PDF selection native for the standard context menu', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(
    page,
    referencePdf,
    'Reference native context-menu launch failed',
  );
  const main = page.locator('[data-pdf-copy-surface="main"]');
  await openLinkInReferences(page, main.getByRole('button', {
    name: 'Open PDF link to Primary result, Page 2',
  }));
  await expectReferenceReady(page, page.getByRole('tab', { name: /Primary result/u }));
  const reference = page.locator('[data-pdf-copy-surface="reference"]');
  await dragAcrossProductionPdfPages(page, reference, 1, 2, { y: 58, endX: 350 });
  const referenceText = [
    'Reference navigation fixture — page 2',
    'Primary target. Follow the target-to-target link for details.',
    'Reference navigation fixture — page 3',
  ].join('\n');
  await expect.poll(() => page.evaluate(() => (
    window.getSelection()?.toString().replace(/\r\n?/gu, '\n') ?? ''
  )))
    .toBe(referenceText);
  const selectedReferencePage = await showPdfSelectionPage(reference, 2, 58);
  await armContextMenuDefaultProbe(page);
  await page.mouse.click(
    selectedReferencePage.box.x + 180 * selectedReferencePage.scale,
    selectedReferencePage.box.y + 58 * selectedReferencePage.scale,
    { button: 'right' },
  );
  await expect(page.locator('html'))
    .toHaveAttribute('data-pdf-context-menu-default-prevented', 'false');
  expect(await page.evaluate(() => (
    window.getSelection()?.toString().replace(/\r\n?/gu, '\n') ?? ''
  )))
    .toBe(referenceText);
});

test('revokes Reference copy authority across tab switch, Send to Main, and final close', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const launched = await openFreshProductionFixture(
    page,
    referencePdf,
    'Reference copy lifecycle launch failed',
  );
  const initialItems = host.broker.state(launched.sessionId)!.items;
  const main = page.locator('[data-pdf-copy-surface="main"]');
  const primaryLink = main.getByRole('button', {
    name: 'Open PDF link to Primary result, Page 2',
  });
  await openLinkInReferences(page, primaryLink);
  const primaryTab = page.getByRole('tab', { name: /Primary result/u });
  await expectReferenceReady(page, primaryTab);
  const reference = page.locator('[data-pdf-copy-surface="reference"]');

  await dragAcrossProductionPdfPages(page, main, 0, 1, { y: 58 });
  await dragAcrossProductionPdfPages(page, reference, 1, 2, { y: 58, endX: 350 });
  const primaryReferencePage = reference.locator('[data-page-index="1"]');
  await primaryReferencePage.focus();
  const primaryReferenceText = await page.evaluate(() => (
    window.getSelection()?.toString().replace(/\r\n?/gu, '\n') ?? ''
  ));
  expect(primaryReferenceText).not.toBe('');
  expect(await dispatchClipboardCopy(primaryReferencePage)).toEqual({
    defaultPrevented: true,
    text: primaryReferenceText,
  });
  const detailLink = reference.getByRole('button', {
    name: 'Open PDF link to Target-to-target detail link, Page 3',
  });
  await detailLink.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await openLinkInReferences(page, detailLink);
  const detailTab = page.getByRole('tab', { name: /Target-to-target detail link/u });
  await expectReferenceReady(page, detailTab);
  expect(await dispatchClipboardCopy(detailTab)).toEqual({
    defaultPrevented: false,
    text: '',
  });

  await dragAcrossProductionPdfPages(page, reference, 2, 3, { y: 58, endX: 350 });
  const detailReferencePage = reference.locator('[data-page-index="2"]');
  await detailReferencePage.focus();
  const detailReferenceText = await page.evaluate(() => (
    window.getSelection()?.toString().replace(/\r\n?/gu, '\n') ?? ''
  ));
  expect(detailReferenceText).not.toBe('');
  expect(await dispatchClipboardCopy(detailReferencePage)).toEqual({
    defaultPrevented: true,
    text: detailReferenceText,
  });
  await clickHoverRevealedReferenceTabAction(
    page.getByRole('button', { name: 'Open in main document' }),
  );
  await expect(detailTab).toHaveCount(0);
  await expect(primaryTab).toHaveAttribute('aria-selected', 'true');
  await expect(primaryTab).toBeFocused();
  expect(await dispatchClipboardCopy(primaryTab)).toEqual({
    defaultPrevented: false,
    text: '',
  });
  await waitForRenderedPageImage(reference.locator('[data-page-index="1"]'));
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(primaryTab).toBeFocused();

  await dragAcrossProductionPdfPages(page, reference, 1, 2, { y: 58, endX: 350 });
  await primaryReferencePage.focus();
  const reopenedReferenceText = await page.evaluate(() => (
    window.getSelection()?.toString().replace(/\r\n?/gu, '\n') ?? ''
  ));
  expect(reopenedReferenceText).not.toBe('');
  expect(await dispatchClipboardCopy(primaryReferencePage)).toEqual({
    defaultPrevented: true,
    text: reopenedReferenceText,
  });
  await clickHoverRevealedReferenceTabAction(
    page.getByRole('button', { name: 'Close active reference' }),
  );
  await expect(page.locator('[data-reference-tab]')).toHaveCount(0);
  const openReferences = page.getByRole('button', { name: 'Show workspace' });
  await expect(openReferences).toBeFocused();
  expect(await dispatchClipboardCopy(openReferences)).toEqual({
    defaultPrevented: false,
    text: '',
  });
  expect(host.broker.state(launched.sessionId)?.items).toEqual(initialItems);
});

test('keeps PDF drag selection available while the Annotation Tray is open', async ({ page }) => {
  const launched = await host.open({
    pdfPath: await freshProductionPdf(pdf),
    sourceRootPath: sourceRoot,
    surface: 'vscode',
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Fresh tray-selection launch failed');
  }
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto(launched.url);
  const pdfPage = page.locator("[data-page-index='0']").first();
  await waitForRenderedPageImage(pdfPage);
  const { workspace: workspaceControl } = await openAnnotationsWorkspace(page);
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-annotation-presentation', 'bottom');

  const selectionRects = pdfPage.locator(':scope > div[style*="mix-blend-mode"]');
  const rectCountBeforeDrag = await selectionRects.count();
  const box = await pdfPage.boundingBox();
  if (!box) throw new Error('Rendered PDF page has no bounds.');
  await page.mouse.move(box.x + 76, box.y + 98);
  await page.mouse.down();
  await page.mouse.move(box.x + 245, box.y + 98, { steps: 8 });
  await expect.poll(() => selectionRects.count()).toBeGreaterThan(rectCountBeforeDrag);
  await page.mouse.up();

  await expect.poll(() => selectionRects.count()).toBeGreaterThan(rectCountBeforeDrag);
  const selectionActions = page.getByRole('toolbar', { name: 'Selection review actions' });
  await expect(selectionActions).toBeVisible();
  const overlayOrder = await page.locator('[data-review-stage]').evaluate((stage) => {
    const contextual = stage.querySelector<HTMLElement>('[data-review-contextual-host]');
    const drawerHost = stage.querySelector<HTMLElement>('[data-review-drawer-host]');
    if (!contextual || !drawerHost) throw new Error('Review overlay layers are unavailable.');
    return {
      contextual: Number.parseInt(getComputedStyle(contextual).zIndex, 10),
      drawer: Number.parseInt(getComputedStyle(drawerHost).zIndex, 10),
    };
  });
  expect(overlayOrder.contextual).toBeGreaterThan(overlayOrder.drawer);
  await selectionActions.getByRole('button', { name: 'Highlight', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Highlight Comment' })).toBeVisible();
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-authoring-takeover', 'true');
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('inert', '');
  await expect(page.locator('#review-tools-workspace')).toHaveAttribute('data-tools-workspace-open', 'true');
  await expect(workspaceControl).toBeVisible();
  expect(await workspaceControl.evaluate((control) => {
    const workspace = control.closest<HTMLElement>('#review-workspace, #review-tools-workspace');
    (control as HTMLElement).focus();
    return {
      insideInertWorkspace: workspace?.hasAttribute('inert') === true,
      focusBlocked: document.activeElement !== control,
    };
  })).toEqual({ insideInertWorkspace: true, focusBlocked: true });
});

test("cancels the pending first annotation without modifying the PDF or creating a copy", async ({ page }) => {
  const cancelPdf = join(root, `cancel-${randomUUID()}.pdf`);
  await copyFile(pdf, cancelPdf);
  const launched = await host.open({ pdfPath: cancelPdf, sourceRootPath: sourceRoot, fork: true });
  if (!launched.ok || launched.kind === "recovery-offered") throw new Error("Cancel launch failed");
  const initialReview = host.broker.state(launched.sessionId)!;
  const originalBytes = await readFile(cancelPdf);
  await page.goto(launched.url);
  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await waitForRenderedPageImage(pageCanvas);
  await pageCanvas.click({ button: "right", position: { x: 320, y: 420 } });
  await page.getByRole("menuitem", { name: "Add Page Note" }).click();
  const composer = page.locator('[data-comment-composer]');
  await expect(page.getByRole("region", { name: "Page Note" })).toBeVisible();
  const comment = composer.locator('textarea');
  await comment.fill("Do not keep this note.");
  expect(host.broker.state(launched.sessionId)?.items).toEqual(initialReview.items);
  await expect.poll(() => host.broker.state(launched.sessionId)?.pendingDrafts[0]?.text)
    .toBe('Do not keep this note.');
  await expect(access(cancelPdf.replace(/\.pdf$/u, "-annotated.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(page.locator(
    '[data-owned-mark="pageNote"][data-authoring-preview="true"]',
  )).toHaveCount(1);

  await composer.getByRole("button", { name: "Cancel" }).click();
  await expect(composer).toHaveCount(0);
  await expect(page.locator('[data-authoring-preview="true"]')).toHaveCount(0);
  expect(host.broker.state(launched.sessionId)?.items).toEqual(initialReview.items);
  expect(host.broker.state(launched.sessionId)?.pendingDrafts).toEqual([]);
  expect(await readFile(cancelPdf)).toEqual(originalBytes);
});

test("selects Page Notes only until the next click outside annotations", async ({ page, browserName }) => {
  const launched = await host.open({
    pdfPath: await freshProductionPdf(pdf),
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Fresh Page Note production launch failed");
  }
  const browserErrors = collectBrowserErrors(page);
  await page.goto(launched.url);
  await chooseFreshCopyDestination(page);
  const initialReview = host.broker.state(launched.sessionId)!;

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await expect.poll(() => currentPageText(page)).toBe("1 / 1");
  await waitForRenderedPageImage(pageCanvas);
  const canvasBox = await pageCanvas.boundingBox();
  if (!canvasBox) throw new Error("Rendered PDF page has no bounds.");
  const scale = canvasBox.width / 612;
  const point = { x: 610 * scale, y: 790 * scale };

  await pageCanvas.click({ button: "right", position: point });
  const addPageNote = page.getByRole("menuitem", { name: "Add Page Note" });
  await expect(addPageNote).toBeVisible();
  await expect(addPageNote).toBeFocused();
  await addPageNote.click();

  const composer = page.getByRole("region", { name: "Page Note" });
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox", { name: "Comment" }).fill("Check the conclusion.");
  await composer.getByRole("button", { name: "Save", exact: true }).click();

  await expect.poll(() => host.broker.state(launched.sessionId)?.items.length)
    .toBe(initialReview.items.length + 1);
  await expect.poll(() => host.broker.saveStatus(launched.sessionId)?.sync.phase).toBe("clean");
  await expect(composer).toHaveCount(0);
  const state = host.broker.state(launched.sessionId);
  expect(state?.revision).toBeGreaterThan(initialReview.revision);
  expect(state?.items).toHaveLength(initialReview.items.length + 1);
  const note = state?.items.find((item) => !initialReview.items.some((old) => old.id === item.id));
  expect(note).toMatchObject({
    kind: "pageNote",
    pageIndex: 0,
    payload: {
      comment: "Check the conclusion.",
      position: { width: 18, height: 18 },
    },
  });
  const position = note?.payload.position;
  expect(position).toMatchObject({ width: 18, height: 18 });
  expect(Math.abs(pageCoordinate(position, "x") - 594)).toBeLessThanOrEqual(1);
  expect(Math.abs(pageCoordinate(position, "y") - 774)).toBeLessThanOrEqual(1);
  expect(note?.id).toBeTruthy();
  const mark = page.locator(`[data-owned-mark="pageNote"][data-review-id="${note!.id}"]`);
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveAttribute("data-active", "false");

  const secondPoint = { x: 300 * scale, y: 300 * scale };
  await pageCanvas.click({ button: "right", position: secondPoint });
  await page.getByRole("menuitem", { name: "Add Page Note" }).click();
  await page.getByRole("region", { name: "Page Note" })
    .getByRole("textbox", { name: "Comment" })
    .fill("Check the evidence.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => host.broker.state(launched.sessionId)?.items
    .some((item) => item.payload.comment === "Check the evidence.")).toBe(true);
  const secondNote = host.broker.state(launched.sessionId)?.items
    .find((item) => item.payload.comment === "Check the evidence.");
  expect(secondNote?.id).toBeTruthy();
  const secondMark = page.locator(`[data-owned-mark="pageNote"][data-review-id="${secondNote!.id}"]`);
  const secondRow = page.locator(`[data-review-item="${secondNote!.id}"]`);
  await expect(secondMark).toHaveCount(1);

  await mark.scrollIntoViewIfNeeded();
  const markBox = await mark.boundingBox();
  if (!markBox) throw new Error("Rendered Page Note mark has no bounds.");
  await page.mouse.click(markBox.x + markBox.width / 2, markBox.y + markBox.height / 2, {
    button: "right",
  });
  await expect(page.getByRole("menu", { name: "Page actions" })).toHaveCount(0);
  await expect(mark).toHaveAttribute("data-active", "false");
  await expect(page.locator('[data-workspace-edge-rail][aria-expanded="true"]')).toHaveCount(0);

  const markFocus = page.locator(`[data-owned-focus-id="${note!.id}"]`);
  if (browserName === "webkit") {
    await markFocus.evaluate((element) => {
      (element as HTMLElement).focus({ preventScroll: true });
      element.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    });
  } else {
    await page.mouse.click(markBox.x + markBox.width / 2, markBox.y + markBox.height / 2);
  }
  const row = page.locator(`[data-review-item="${note!.id}"]`);
  const workspace = await currentWorkspaceRail(page);
  await expect(mark).toHaveAttribute("data-active", "true");
  await expect(row).toHaveAttribute("data-active", "true");
  await expect(workspace).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(`[data-annotation-peek="${note!.id}"]`)).toBeVisible();

  const secondMarkFocus = page.locator(`[data-owned-focus-id="${secondNote!.id}"]`);
  await secondMarkFocus.evaluate((element) => {
    (element as HTMLElement).focus({ preventScroll: true });
    element.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  });
  await page.mouse.move(0, 0);
  await expect(mark).toHaveAttribute("data-corresponding", "false");
  await expect(secondMark).toHaveAttribute("data-corresponding", "true");
  await expect(mark).toHaveAttribute("data-active", "false");
  await expect(row).toHaveAttribute("data-active", "false");
  await expect(secondMark).toHaveAttribute("data-active", "true");
  await expect(secondRow).toHaveAttribute("data-active", "true");
  await expect(workspace).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(`[data-annotation-peek="${secondNote!.id}"]`)).toBeVisible();

  const blankPdfPoint = await pageCanvas.evaluate((element) => {
    const pageBounds = element.getBoundingClientRect();
    const viewport = element.closest<HTMLElement>('[data-viewer-framing-viewport]');
    const viewportBounds = viewport?.getBoundingClientRect();
    if (!viewportBounds) throw new Error('PDF viewport has no bounds after annotation activation.');
    const left = Math.max(pageBounds.left, viewportBounds.left) + 16;
    const right = Math.min(pageBounds.right, viewportBounds.right) - 16;
    const top = Math.max(pageBounds.top, viewportBounds.top) + 16;
    const bottom = Math.min(pageBounds.bottom, viewportBounds.bottom) - 16;
    const centeredCandidates = [
      { x: (left + right) / 2, y: (top + bottom) / 2 },
      { x: left + (right - left) * 0.25, y: top + (bottom - top) * 0.5 },
      { x: left + (right - left) * 0.75, y: top + (bottom - top) * 0.5 },
      { x: left + (right - left) * 0.5, y: top + (bottom - top) * 0.25 },
      { x: left + (right - left) * 0.5, y: top + (bottom - top) * 0.75 },
    ];
    for (const { x, y } of centeredCandidates) {
      const hit = document.elementFromPoint(x, y);
      if (
        hit instanceof Element
        && hit.closest('[data-page-index]') === element
        && hit.closest('[data-owned-focus-id], [data-owned-mark], [data-annotation-peek]') === null
      ) return { x, y };
    }
    for (let y = top; y <= bottom; y += 32) {
      for (let x = left; x <= right; x += 32) {
        const hit = document.elementFromPoint(x, y);
        if (
          hit instanceof Element
          && hit.closest('[data-page-index]') === element
          && hit.closest('[data-owned-focus-id], [data-owned-mark], [data-annotation-peek]') === null
        ) return { x, y };
      }
    }
    throw new Error('No unobscured blank PDF point is available after annotation activation.');
  });
  if (browserName === 'webkit') {
    // Headless WebKit does not deliver native pointer events after this test's
    // standard context-menu gesture, so exercise the same validated blank-PDF move and click
    // through DOM events. The move clears any owned-mark hover retained at the menu point.
    await pageCanvas.evaluate((element) => {
      (element as HTMLElement).focus({ preventScroll: true });
    });
    await pageCanvas.dispatchEvent('pointermove', {
      pointerId: 1,
      button: 0,
      buttons: 0,
      clientX: blankPdfPoint.x,
      clientY: blankPdfPoint.y,
    });
    await pageCanvas.dispatchEvent('click', {
      button: 0,
      clientX: blankPdfPoint.x,
      clientY: blankPdfPoint.y,
    });
  } else {
    await page.mouse.click(blankPdfPoint.x, blankPdfPoint.y);
  }
  await expect(mark).toHaveAttribute("data-active", "false");
  await expect(row).toHaveAttribute("data-active", "false");
  await expect(secondMark).toHaveAttribute("data-active", "false");
  await expect(secondRow).toHaveAttribute("data-active", "false");
  await expect(workspace).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-annotation-peek]')).toHaveCount(0);

  await markFocus.evaluate((element) => {
    (element as HTMLElement).focus({ preventScroll: true });
    element.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  });
  await expect(row).toHaveAttribute("data-active", "true");
  const zoomBeforeDeselect = await currentZoomText(page);
  if (browserName === 'webkit') {
    const zoomControls = page.getByRole('button', { name: 'Open zoom controls' });
    await zoomControls.dispatchEvent('click');
    const zoomIn = page.getByRole('menu', { name: 'PDF zoom' })
      .getByRole('menuitem', { name: 'Zoom in' });
    await expect(zoomIn).toBeVisible();
    await zoomIn.dispatchEvent('click');
  } else {
    await zoomInOnce(page);
  }
  await expect.poll(() => currentZoomText(page)).not.toBe(zoomBeforeDeselect);
  await expect(mark).toHaveAttribute("data-active", "false");
  await expect(row).toHaveAttribute("data-active", "false");
  await expect(workspace).toHaveAttribute("aria-expanded", "false");

  expect(host.broker.state(launched.sessionId)?.revision).toBeGreaterThan(initialReview.revision);
  expect(browserErrors).toEqual([]);
});

test("places a crop-relative Page Note through the real PDF keyboard cursor", async ({ page }) => {
  const launched = await host.open({
    pdfPath: await freshProductionPdf(pdf),
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Fresh keyboard Page Note production launch failed");
  }
  const browserErrors = collectBrowserErrors(page);
  await page.goto(launched.url);
  await chooseFreshCopyDestination(page);
  const initialReview = host.broker.state(launched.sessionId)!;

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await expect.poll(() => currentPageText(page)).toBe("1 / 1");
  await waitForRenderedPageImage(pageCanvas);
  await pageCanvas.focus();
  await page.keyboard.press("Alt+Shift+N");
  const cursor = page.getByRole("button", { name: /^Page Note placement cursor/u });
  await expect(cursor).toBeVisible();
  await expect(cursor).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  const composer = page.getByRole("region", { name: "Page Note" });
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox", { name: "Comment" }).fill("Keyboard-placed note.");
  await composer.getByRole("button", { name: "Save", exact: true }).click();

  await expect.poll(() => host.broker.state(launched.sessionId)?.items.length)
    .toBe(initialReview.items.length + 1);
  await expect.poll(() => host.broker.saveStatus(launched.sessionId)?.sync.phase).toBe("clean");
  const state = host.broker.state(launched.sessionId);
  expect(state?.revision).toBeGreaterThan(initialReview.revision);
  expect(state?.items).toHaveLength(initialReview.items.length + 1);
  const note = state?.items.find((item) => !initialReview.items.some((old) => old.id === item.id));
  expect(note).toMatchObject({
    kind: "pageNote",
    pageIndex: 0,
    payload: {
      comment: "Keyboard-placed note.",
      position: { x: 310, y: 400, width: 18, height: 18 },
    },
  });
  expect(note?.id).toBeTruthy();
  await expect(page.locator(
    `[data-owned-mark="pageNote"][data-review-id="${note!.id}"]`,
  )).toHaveCount(1);
  expect(browserErrors).toEqual([]);
});

test("normalizes a real context gesture on a rotated cropped PDF into crop-relative page space", async ({ page }) => {
  const launched = await host.open({
    pdfPath: await freshProductionPdf(rotatedPdf),
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Rotated Page Note production launch failed");
  }
  const browserErrors = collectBrowserErrors(page);
  await page.goto(launched.url);
  await chooseFreshCopyDestination(page);
  const initialReview = host.broker.state(launched.sessionId)!;

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await expect.poll(() => currentPageText(page)).toBe("1 / 1");
  await waitForRenderedPageImage(pageCanvas);
  const canvasBox = await pageCanvas.boundingBox();
  if (!canvasBox) throw new Error("Rendered rotated PDF page has no bounds.");
  const scale = canvasBox.width / 720;

  await pageCanvas.click({
    button: "right",
    position: { x: 300 * scale, y: 200 * scale },
  });
  await page.getByRole("menuitem", { name: "Add Page Note" }).click();
  const composer = page.getByRole("region", { name: "Page Note" });
  await composer.getByRole("textbox", { name: "Comment" }).fill("Rotated geometry note.");
  await composer.getByRole("button", { name: "Save", exact: true }).click();

  await expect.poll(() => host.broker.state(launched.sessionId)?.items.length)
    .toBe(initialReview.items.length + 1);
  await expect.poll(() => host.broker.saveStatus(launched.sessionId)?.sync.phase).toBe("clean");
  const state = host.broker.state(launched.sessionId);
  expect(state?.items).toHaveLength(initialReview.items.length + 1);
  const note = state?.items.find((item) => !initialReview.items.some((old) => old.id === item.id));
  expect(note).toMatchObject({
    kind: "pageNote",
    pageIndex: 0,
    payload: {
      comment: "Rotated geometry note.",
      position: { width: 18, height: 18 },
    },
  });
  expect(Math.abs(pageCoordinate(note?.payload.position, "x") - 200)).toBeLessThanOrEqual(1);
  expect(Math.abs(pageCoordinate(note?.payload.position, "y") - 420)).toBeLessThanOrEqual(1);
  expect(note?.id).toBeTruthy();
  await expect(page.locator(
    `[data-owned-mark="pageNote"][data-review-id="${note!.id}"]`,
  )).toHaveCount(1);
  expect(browserErrors).toEqual([]);
});

test("anchors highlight and delete annotations across inline and display equations", async ({ page }) => {
  const launched = await openFreshProductionFixture(
    page,
    equationPdf,
    "Fresh equation-selection production launch failed",
  );
  const browserErrors = collectBrowserErrors(page);
  await chooseFreshCopyDestination(page);

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await waitForRenderedPageImage(pageCanvas);
  await dragPdfPointer(
    page,
    pageCanvas,
    { x: 72, y: 98 },
    { x: 360, y: 98 },
    undefined,
    { steps: 8 },
  );

  let selectionActions = page.getByRole("toolbar", { name: "Selection review actions" });
  await expect(selectionActions).toBeVisible();
  await expect(page.locator("[data-viewer-status]")).toHaveCount(0);
  await selectionActions.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect(page.getByRole("region", { name: "Highlight Comment" })).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("region", { name: "Highlight Comment" })).toHaveCount(0);
  await expect(page.locator("[data-owned-mark='highlight']")).toHaveCount(3);

  await dragPdfPointer(
    page,
    pageCanvas,
    { x: 190, y: 168 },
    { x: 330, y: 168 },
    undefined,
    { steps: 8 },
  );
  selectionActions = page.getByRole("toolbar", { name: "Selection review actions" });
  await expect(selectionActions).toBeVisible();
  await expect(page.locator("[data-viewer-status]")).toHaveCount(0);
  await selectionActions.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(page.locator("[data-review-item]")).toHaveCount(2);
  await expect.poll(() => page.locator("[data-owned-mark='delete']").count()).toBeGreaterThan(1);
  const state = host.broker.state(launched.sessionId);
  expect(state?.items).toHaveLength(2);
  expect(state?.items[0]).toMatchObject({
    kind: "highlight",
    pageIndex: 0,
    payload: { reliable: true },
  });
  expect(state?.items[1]).toMatchObject({
    kind: "delete",
    pageIndex: 0,
    payload: { reliable: true },
  });
  const inlineQuote = state?.items[0]?.payload.quote;
  const displayQuote = state?.items[1]?.payload.quote;
  const inlineSegments = state?.items[0]?.payload.segmentRects;
  const displaySegments = state?.items[1]?.payload.segmentRects;
  if (
    typeof inlineQuote !== "string" ||
    typeof displayQuote !== "string" ||
    !Array.isArray(inlineSegments) ||
    !Array.isArray(displaySegments)
  ) throw new Error("Equation selection anchors are incomplete.");
  expect(inlineQuote).toContain("distance dij remains");
  expect(displayQuote.replace(/\s+/gu, "")).toContain("tk|ij=ν-1k·d");
  expect(inlineSegments).toHaveLength(3);
  expect(displaySegments.length).toBeGreaterThan(1);
  expect(browserErrors).toEqual([]);
});

for (const key of ["Delete", "Backspace"] as const) {
  test(`a fresh real selection queues exactly one ${key} command while capture is pending`, async ({ page }) => {
    const launched = await host.open({
      pdfPath: await freshProductionPdf(pdf),
      sourceRootPath: sourceRoot,
      fork: true,
    });
    if (!launched.ok || launched.kind === "recovery-offered") {
      throw new Error(`Fresh ${key} production launch failed`);
    }
    const browserErrors = collectBrowserErrors(page);
    await installSelectionCaptureGate(page);
    await page.goto(launched.url);
    await chooseFreshCopyDestination(page);
    const initialReview = host.broker.state(launched.sessionId)!;

    const pageCanvas = page.locator("[data-page-index='0']").first();
    await expect(pageCanvas).toBeVisible();
    await waitForRenderedPageImage(pageCanvas);
    await dragPdfPointer(
      page,
      pageCanvas,
      { x: 253, y: 98 },
      { x: 405, y: 98 },
      undefined,
      { steps: 12 },
    );
    await expect(pageCanvas).toBeFocused();
    await waitForSelectionCapture(page);
    await expect(page.locator("[data-viewer-status]")).toHaveCount(0);
    const urlBeforeKey = page.url();
    await page.keyboard.press(key);
    await releaseSelectionCapture(page);

    await expect(page.locator("[data-review-item]")).toHaveCount(initialReview.items.length + 1);
    await expect(page.locator("[data-owned-mark='delete']")).toHaveCount(1);
    expect(page.url()).toBe(urlBeforeKey);
    const state = host.broker.state(launched.sessionId);
    expect(state?.revision).toBe(initialReview.revision + 1);
    await expect.poll(() => host.broker.saveStatus(launched.sessionId)?.sync.phase).toBe("clean");
    expect(state?.items).toHaveLength(initialReview.items.length + 1);
    const deletion = state?.items.find((item) => item.kind === "delete");
    expect(deletion).toMatchObject({
      kind: "delete",
      pageIndex: 0,
      payload: {
        quote: "unique equilibrium clearly",
        reliable: true,
      },
    });
    const segments = deletion?.payload.segmentRects;
    expect(Array.isArray(segments)).toBe(true);
    expect(deletion?.payload.rect).toEqual(
      Array.isArray(segments) ? segments[0] : undefined,
    );
    expect(deletion?.payload.rect).toEqual({
      x: 252,
      y: 89,
      width: 158,
      height: 16,
    });
    expect(browserErrors).toEqual([]);
  });
}

test("shows command conflicts until a retry succeeds", async ({ page }) => {
  await page.routeWebSocket(/\/control$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((message) => serverSocket.send(message));
    serverSocket.onMessage(() => undefined);
  });
  const launched = await openFreshProductionFixture(
    page,
    pdf,
    "Fresh command-conflict production launch failed",
  );
  await chooseFreshCopyDestination(page);
  const initialReview = host.broker.state(launched.sessionId)!;

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await waitForRenderedPageImage(pageCanvas);
  await dragPdfPointer(page, pageCanvas, { x: 253, y: 98 }, { x: 405, y: 98 });
  const selectionActions = page.getByRole("toolbar", { name: "Selection review actions" });
  await expect(selectionActions).toBeVisible();

  const externalState = host.broker.state(launched.sessionId);
  if (!externalState) throw new Error("Command-conflict review state is missing");
  await host.broker.acceptMutation(
    launched.sessionId,
    addPageNote(
      externalState,
      0,
      { x: 80, y: 160, width: 18, height: 18 },
      "External review window note.",
    ),
  );

  await selectionActions.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("[data-viewer-status]")).toContainText(
    "Another review window changed this draft",
  );
  await expect(selectionActions).toBeVisible();

  await selectionActions.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("[data-viewer-status]")).toHaveCount(0);
  await expect(page.locator("[data-review-item]")).toHaveCount(initialReview.items.length + 2);
  expect(host.broker.state(launched.sessionId)?.revision).toBe(initialReview.revision + 2);
});

test('merges a first-annotation conflict through its protected draft', async ({ page }) => {
  const launched = await openFreshProductionFixture(
    page,
    pdf,
    'Fresh pending-destination conflict launch failed',
  );
  await chooseFreshCopyDestination(page);
  const initialReview = host.broker.state(launched.sessionId)!;
  const pageCanvas = page.locator("[data-page-index='0']").first();
  await waitForRenderedPageImage(pageCanvas);
  await dragPdfPointer(page, pageCanvas, { x: 253, y: 98 }, { x: 405, y: 98 });
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  const composer = page.getByRole('region', { name: 'Replacement' });
  const editor = composer.getByRole('textbox', { name: 'Replacement' });
  await editor.fill('retry from authoritative state');
  await expect.poll(() => host.broker.state(launched.sessionId)?.pendingDrafts[0]?.text)
    .toBe('retry from authoritative state');
  for (let attempt = 0; ; attempt += 1) {
    const externalState = host.broker.state(launched.sessionId);
    if (!externalState) throw new Error('Pending-destination conflict state is missing.');
    try {
      await host.broker.acceptMutation(
        launched.sessionId,
        addPageNote(
          externalState,
          0,
          { x: 80, y: 160, width: 18, height: 18 },
          'External conflict note.',
        ),
      );
      break;
    } catch (error) {
      if (!(error instanceof ReviewConflictError) || attempt >= 4) throw error;
    }
  }
  await composer.getByRole('button', { name: 'Apply' }).click();
  await expect(composer).toHaveCount(0);
  await expect.poll(() => host.broker.state(launched.sessionId)?.items.length)
    .toBe(initialReview.items.length + 2);
  expect(host.broker.state(launched.sessionId)?.items.some((item) =>
    item.kind === 'pageNote' && item.payload.comment === 'External conflict note.')).toBe(true);
  expect(host.broker.state(launched.sessionId)?.items.some((item) =>
    item.kind === 'replace' && item.payload.proposedText === 'retry from authoritative state')).toBe(true);
  expect(host.broker.state(launched.sessionId)?.pendingDrafts).toEqual([]);
});

test("discards queued typing when a pending selection is cleared", async ({ page }) => {
  const launched = await host.open({
    pdfPath: await freshProductionPdf(pdf),
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Fresh pending-clear production launch failed");
  }
  await installSelectionCaptureGate(page);
  await page.goto(launched.url);
  await chooseFreshCopyDestination(page);
  const initialReview = host.broker.state(launched.sessionId)!;

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await waitForRenderedPageImage(pageCanvas);
  await dragPdfPointer(page, pageCanvas, { x: 76, y: 98 }, { x: 245, y: 98 });
  await waitForSelectionCapture(page);
  await expect(page.locator("[data-viewer-status]")).toHaveCount(0);
  await page.keyboard.type("discard me");

  await pageCanvas.click({ position: { x: 500, y: 300 } });
  await releaseSelectionCapture(page);

  await expect(page.getByRole("region", { name: "Replacement" })).toHaveCount(0);
  await expect(page.locator("[data-review-item]")).toHaveCount(initialReview.items.length);
  expect(host.broker.state(launched.sessionId)?.revision).toBe(initialReview.revision);
});

test("keeps only typing for the newest pending selection", async ({ page }) => {
  const launched = await host.open({
    pdfPath: await freshProductionPdf(pdf),
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Fresh pending-supersession production launch failed");
  }
  await installSelectionCaptureGate(page);
  await page.goto(launched.url);
  await chooseFreshCopyDestination(page);
  const initialReview = host.broker.state(launched.sessionId)!;

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await waitForRenderedPageImage(pageCanvas);
  await dragPdfPointer(page, pageCanvas, { x: 76, y: 98 }, { x: 245, y: 98 });
  await waitForSelectionCapture(page);
  await expect(page.locator("[data-viewer-status]")).toHaveCount(0);
  await page.keyboard.type("obsolete");

  await dragPdfPointer(page, pageCanvas, { x: 253, y: 98 }, { x: 405, y: 98 });
  await page.keyboard.type("current");
  await releaseSelectionCapture(page);

  const replacementComposer = page.getByRole("region", { name: "Replacement" });
  await expect(replacementComposer).toBeVisible();
  await expect(replacementComposer.getByRole("textbox", { name: "Replacement" })).toHaveValue("current");
  await replacementComposer.getByRole("button", { name: "Apply" }).click();
  await expect(replacementComposer).toHaveCount(0);
  await expect(page.locator("[data-review-item]")).toHaveCount(initialReview.items.length + 1);
  const state = host.broker.state(launched.sessionId);
  expect(state?.revision).toBeGreaterThan(initialReview.revision);
  await expect.poll(() => host.broker.saveStatus(launched.sessionId)?.sync.phase).toBe("clean");
  expect(state?.items).toHaveLength(initialReview.items.length + 1);
  const replacement = state?.items.find((item) => item.kind === "replace");
  expect(replacement).toMatchObject({
    kind: "replace",
    payload: {
      proposedText: "current",
    },
  });
  expect(replacement?.payload.quote).not.toBe("");
});

for (const dock of ['closed', 'bottom', 'right'] as const) {
  test(`keeps the PDF point under wheel zoom and centers toolbar zoom with workspace ${dock}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openFreshProductionFixture(page, referencePdf, 'Anchored zoom launch failed');
    const workspace = page.locator('.pdf-workspace:not(.pdf-workspace--reference)');
    const viewport = workspace.locator('[data-viewer-framing-viewport]');
    const sheet = workspace.locator('[data-page-index="0"]');
    await waitForRenderedPageImage(sheet);
    if (dock !== 'closed') {
      await openLinkInReferences(page, workspace.getByRole('button', { name: 'Open PDF link to Primary result, Page 2' }));
      if (dock === 'right') await clickHoverRevealedReferenceDockAction(page.getByRole('button', { name: 'Move References to right' }));
      await expect(page.locator('[data-review-workspace]')).toHaveAttribute('data-workspace-presentation', dock);
      await expect.poll(() => page.locator('[data-review-workspace]').evaluate((element) => getComputedStyle(element).transform)).toBe('none');
    }
    await page.locator('[data-review-stage]').evaluate(async (element) => {
      await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
    });
    const rect = (await sheet.boundingBox())!;
    const reading = (await workspace.boundingBox())!;
    const pointer = { x: Math.round(reading.x + reading.width * 0.65), y: Math.round(rect.y + 200) };
    const normalized = { x: (pointer.x - rect.x) / rect.width, y: (pointer.y - rect.y) / rect.height };
    await page.mouse.move(pointer.x, pointer.y);
    for (const delta of [-70, -70, 70]) {
      const before = (await sheet.boundingBox())!.width;
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, delta);
      await expect.poll(async () => Math.abs((await sheet.boundingBox())!.width - before)).toBeGreaterThan(10);
      await page.keyboard.up('Control');
      await expect.poll(async () => {
        const next = (await sheet.boundingBox())!;
        return Math.max(Math.abs(next.x + normalized.x * next.width - pointer.x),
          Math.abs(next.y + normalized.y * next.height - pointer.y));
      }).toBeLessThan(2);
    }
    // Several events in one task must not capture geometry from an unfinished zoom.
    const burstBefore = (await sheet.boundingBox())!;
    const burstFraction = { x: (pointer.x - burstBefore.x) / burstBefore.width, y: (pointer.y - burstBefore.y) / burstBefore.height };
    await viewport.evaluate((element, point) => {
      for (let i = 0; i < 4; i += 1) element.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, ctrlKey: true, deltaY: -12, clientX: point.x, clientY: point.y,
      }));
    }, pointer);
    await expect.poll(async () => (await sheet.boundingBox())!.width).toBeGreaterThan(burstBefore.width * 1.2);
    await expect.poll(async () => {
      const next = (await sheet.boundingBox())!;
      return Math.max(Math.abs(next.x + burstFraction.x * next.width - pointer.x),
        Math.abs(next.y + burstFraction.y * next.height - pointer.y));
    }).toBeLessThan(3);
    const pinchBefore = (await sheet.boundingBox())!;
    const pinchFraction = { x: (pointer.x - pinchBefore.x) / pinchBefore.width, y: (pointer.y - pinchBefore.y) / pinchBefore.height };
    await viewport.evaluate((element, point) => {
      const send = (type: string, radius: number) => {
        const touches = [-radius, radius].map((offset, identifier) => ({
          identifier, target: element, clientX: point.x + offset, clientY: point.y,
        }));
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: touches });
        element.dispatchEvent(event);
      };
      send('touchstart', 50);
      send('touchmove', 60);
      send('touchmove', 70);
      const end = new Event('touchend', { bubbles: true });
      Object.defineProperty(end, 'touches', { value: [] });
      element.dispatchEvent(end);
    }, pointer);
    await expect.poll(async () => (await sheet.boundingBox())!.width).toBeGreaterThan(pinchBefore.width * 1.35);
    await expect.poll(async () => {
      const next = (await sheet.boundingBox())!;
      return Math.max(Math.abs(next.x + pinchFraction.x * next.width - pointer.x),
        Math.abs(next.y + pinchFraction.y * next.height - pointer.y));
    }).toBeLessThan(2);
    const box = (await viewport.boundingBox())!;
    const area = (await workspace.boundingBox())!;
    const client = await viewport.evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }));
    const bottom = dock === 'bottom' ? (await page.locator('[data-review-workspace]').boundingBox())!.y : box.y + client.height;
    const center = { x: (box.x + Math.min(box.x + client.width, area.x + area.width)) / 2, y: (box.y + bottom) / 2 };
    const before = (await sheet.boundingBox())!;
    const fraction = { x: (center.x - before.x) / before.width, y: (center.y - before.y) / before.height };
    await zoomInOnce(page);
    await expect.poll(async () => {
      const next = (await sheet.boundingBox())!;
      return Math.max(Math.abs(next.x + fraction.x * next.width - center.x),
        Math.abs(next.y + fraction.y * next.height - center.y));
    }).toBeLessThan(2);
  });
}

test('keeps page and zoom popups aligned on every painted frame as actions appear', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, 'Popup resize launch failed');
  const checkResize = async (label: string, trigger: Locator, action: string) => {
    await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
    await trigger.hover();
    const menu = page.getByRole('menu', { name: label, exact: true });
    await expect(menu).toBeVisible();
    const id = await menu.getAttribute('id');
    await expect.poll(async () => {
      const [popup, anchor] = await Promise.all([menu.boundingBox(), trigger.boundingBox()]);
      return Math.abs(popup!.x + popup!.width - anchor!.x - anchor!.width);
    }).toBeLessThan(1);
    const samples = page.evaluate(async (menuId) => {
      const surface = document.getElementById(menuId!)!;
      const opener = document.querySelector<HTMLElement>(`[aria-controls="${menuId}"]`)!;
      const frames: Array<{ error: number; connected: boolean; open: boolean; width: number }> = [];
      await new Promise<void>((resolve) => {
        let count = 0;
        const sample = () => requestAnimationFrame(() => setTimeout(() => {
          const bounds = surface.getBoundingClientRect();
          frames.push({ error: Math.abs(bounds.right - opener.getBoundingClientRect().right),
            connected: surface.isConnected, open: surface.matches(':popover-open'), width: bounds.width });
          if (++count < 30) sample();
          else resolve();
        }, 0));
        document.documentElement.dataset.popupSampler = 'ready';
        sample();
      });
      delete document.documentElement.dataset.popupSampler;
      return frames;
    }, id);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.popupSampler)).toBe('ready');
    await menu.getByRole('menuitem', { name: action, exact: true }).click();
    const frames = await samples;
    expect(frames.every((frame) => frame.connected && frame.open)).toBe(true);
    expect(Math.max(...frames.map((frame) => frame.width)) - Math.min(...frames.map((frame) => frame.width))).toBeGreaterThan(20);
    expect(Math.max(...frames.map((frame) => frame.error))).toBeLessThan(1);
    await page.keyboard.press('Escape');
  };
  const zoomTrigger = page.getByRole('button', { name: 'Open zoom controls' });
  await checkResize('PDF zoom', zoomTrigger, 'Zoom in');
  await checkResize('PDF zoom', zoomTrigger, 'Fit width');
  const pageTrigger = page.getByRole('button', { name: /Page \d+ of 4\. Open page navigation/u });
  await checkResize('Page navigation', pageTrigger, 'Next page');
  await checkResize('Page navigation', pageTrigger, 'Previous page');
  const pageInput = page.getByRole('textbox', { name: /Current page \d+ of 4/u });
  await pageInput.fill('4');
  await pageInput.press('Enter');
  await expect(pageInput).toHaveValue('4');
  await checkResize('Page navigation', pageTrigger, 'Previous page');
  await checkResize('Page navigation', pageTrigger, 'Next page');
});

test('zooms continuously without rebuilding PDF page layout on every gesture frame', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, 'Smooth zoom launch failed');
  const workspace = page.locator('.pdf-workspace:not(.pdf-workspace--reference)');
  const viewport = workspace.locator('[data-viewer-framing-viewport]');
  const sheet = workspace.locator('[data-page-index="0"]');
  await waitForRenderedPageImage(sheet);
  const result = await viewport.evaluate(async (element) => {
    const sheet = element.querySelector<HTMLElement>('[data-page-index="0"]')!;
    const widths = new Set([sheet.style.width]);
    const observer = new MutationObserver(() => widths.add(sheet.style.width));
    observer.observe(sheet, { attributes: true, attributeFilter: ['style'] });
    const bounds = element.getBoundingClientRect();
    const before = sheet.getBoundingClientRect();
    const point = { x: Math.round(bounds.left + element.clientWidth * 0.6), y: Math.round(bounds.top + 200) };
    const normalized = { x: (point.x - before.left) / before.width, y: (point.y - before.top) / before.height };
    const intervals: number[] = [];
    const drift: number[] = [];
    let previous = performance.now();
    for (let i = 0; i < 30; i += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const now = performance.now();
      intervals.push(now - previous);
      previous = now;
      element.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, ctrlKey: true, deltaY: -2, clientX: point.x, clientY: point.y,
      }));
      const rect = sheet.getBoundingClientRect();
      drift.push(Math.max(Math.abs(rect.left + normalized.x * rect.width - point.x),
        Math.abs(rect.top + normalized.y * rect.height - point.y)));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    observer.disconnect();
    const final = sheet.getBoundingClientRect();
    return { layoutChanges: widths.size - 1, p95FrameMs: intervals.sort((a, b) => a - b)[Math.floor(intervals.length * .95)],
      maxDrift: Math.max(...drift), finalDrift: Math.max(Math.abs(final.left + normalized.x * final.width - point.x), Math.abs(final.top + normalized.y * final.height - point.y)), scale: final.width / before.width };
  });
  await testInfo.attach('zoom-performance.json', { body: JSON.stringify(result), contentType: 'application/json' });
  console.log('ZOOM_PERFORMANCE', JSON.stringify(result));
  expect(result.scale).toBeGreaterThan(1.25);
  expect(result.maxDrift).toBeLessThan(3);
  expect(result.finalDrift).toBeLessThan(2);
  expect(result.layoutChanges).toBeLessThanOrEqual(2);
});

test('animates toolbar zoom through intermediate sizes and respects reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openFreshProductionFixture(page, referencePdf, 'Animated zoom launch failed');
  const workspace = page.locator('.pdf-workspace:not(.pdf-workspace--reference)');
  const sheet = workspace.locator('[data-page-index="0"]');
  await waitForRenderedPageImage(sheet);
  await page.locator('[data-review-chrome]').hover({ position: { x: 2, y: 2 } });
  await page.getByRole('button', { name: 'Open zoom controls' }).hover();
  const zoomContent = workspace.locator('[data-viewer-zoom-content]');
  // Sample the real animation clock rather than depending on CI's rendering frame rate.
  await zoomContent.evaluate(element => {
    const originalAnimate = element.animate;
    element.animate = function (...args) {
      element.animate = originalAnimate;
      const animation = originalAnimate.apply(this, args);
      animation.pause();
      animation.currentTime = 0;
      return animation;
    };
  });
  await page.getByRole('menuitem', { name: 'Zoom in', exact: true }).click();
  const samples = await zoomContent.evaluate(async element => {
    const animation = element.getAnimations()[0];
    if (!animation?.effect) throw new Error('Toolbar zoom did not start an animation');
    const duration = Number(animation.effect.getTiming().duration);
    if (!(duration > 0)) throw new Error('Toolbar zoom animation has no duration');
    const sheet = element.querySelector('[data-page-index="0"]')!;
    const result: number[] = [];
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      animation.currentTime = duration * progress;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      result.push(sheet.getBoundingClientRect().width);
    }
    animation.play();
    await animation.finished;
    return result;
  });
  expect(new Set(samples.map(Math.round)).size).toBeGreaterThan(3);
  expect(samples.at(-1)!).toBeGreaterThan(samples[0]!);
  for (let i = 1; i < samples.length; i += 1) expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]! - 1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const before = (await sheet.boundingBox())!.width;
  await page.getByRole('menuitem', { name: 'Zoom in', exact: true }).click();
  await expect.poll(async () => (await sheet.boundingBox())!.width).toBeGreaterThan(before);
  expect(await workspace.locator('[data-viewer-zoom-content]').evaluate((element) => element.getAnimations().length)).toBe(0);
});

test('settles an interrupted zoom before keyboard page navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, 'Interrupted zoom launch failed');
  const workspace = page.locator('.pdf-workspace:not(.pdf-workspace--reference)');
  const viewport = workspace.locator('[data-viewer-framing-viewport]');
  const sheet = workspace.locator('[data-page-index="0"]');
  await waitForRenderedPageImage(sheet);
  const input = page.getByRole('textbox', { name: /Current page \d+ of 4/u });
  await input.fill('3');
  // Start zoom while the page editor owns focus, then immediately submit it.
  await viewport.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    element.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, ctrlKey: true, deltaY: -30,
      clientX: bounds.left + 300, clientY: bounds.top + 200,
    }));
  });
  await input.press('Enter');
  await expect(input).toHaveValue('3');
  await expect(workspace.locator('[data-viewer-zoom-content]')).toHaveCSS('transform', 'none');
  await page.waitForTimeout(200);
  await expect(input).toHaveValue('3');
});

for (const width of [1280, 620, 360]) {
  test(`document annotation name saves, cancels, and matches copy input at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { sessionId } = await openFreshProductionFixture(page, plainTextPdf, 'Annotation name fixture failed');
    const open = async () => {
      await page.getByRole('button', { name: /Open automatic save options$/u }).click();
      const dialog = page.getByRole('dialog', { name: 'Choose where to save annotations', exact: true });
      await expect(dialog).toBeVisible();
      return dialog;
    };
    let dialog = await open();
    const name = dialog.getByRole('textbox', { name: 'Name on annotations', exact: true });
    await expect(name).toHaveValue('Placekeeper');
    await name.fill('Brad Ross');
    const styles = await dialog.evaluate((element) => {
      const fields = element.querySelectorAll('.save-destination-filename input');
      return [...fields].map((field) => {
        const style = getComputedStyle(field);
        return [style.font, style.padding, style.border, style.borderRadius, style.backgroundColor];
      });
    });
    expect(styles).toHaveLength(2);
    expect(styles[0]).toEqual(styles[1]);
    await dialog.getByRole('radio', { name: 'Modify the original PDF' }).check();
    await expect(name).toHaveValue('Brad Ross');
    await expect(dialog.getByRole('textbox', { name: 'Copy name' })).toHaveCount(0);
    await name.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(host.broker.state(sessionId)?.annotationName).toBeUndefined();
    dialog = await open();
    await expect(dialog.getByRole('textbox', { name: 'Name on annotations' })).toHaveValue('Placekeeper');
    await dialog.getByRole('radio', { name: 'Modify the original PDF' }).check();
    await dialog.getByRole('textbox', { name: 'Name on annotations' }).fill('  Brad Ross  ');
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => host.broker.state(sessionId)?.annotationName).toBe('Brad Ross');
    expect(host.broker.state(sessionId)?.items).toHaveLength(0);
    dialog = await open();
    await dialog.getByRole('textbox', { name: 'Name on annotations' }).fill('Cancelled name');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(host.broker.state(sessionId)?.annotationName).toBe('Brad Ross');
    dialog = await open();
    await dialog.getByRole('radio', { name: 'Modify the original PDF' }).check();
    await dialog.getByRole('textbox', { name: 'Name on annotations' }).fill('   ');
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => host.broker.state(sessionId)?.annotationName).toBe('Placekeeper');
  });
}

test('document annotation name preserves rejected save drafts for correction and retry', async ({ page }) => {
  const { sessionId } = await openFreshProductionFixture(page, plainTextPdf, 'Rejected name fixture failed');
  await page.getByRole('button', { name: /Open automatic save options$/u }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose where to save annotations', exact: true });
  const name = dialog.getByRole('textbox', { name: 'Name on annotations' });
  await name.fill('x'.repeat(100_000));
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Annotation name');
  await expect(name).toHaveValue('x'.repeat(100_000));
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAccessibleDescription(/Annotation name/u);
  expect(host.broker.state(sessionId)?.annotationName).toBeUndefined();
  expect(host.broker.saveStatus(sessionId)?.destination.phase).toBe("none");
  await name.fill('Corrected name');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => host.broker.state(sessionId)?.annotationName).toBe('Corrected name');
});

test('document annotation name is unchanged when establishing the destination fails', async ({ page }) => {
  const { sessionId } = await openFreshProductionFixture(page, plainTextPdf, 'Failed destination name fixture failed');
  const commands: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(`/s/${sessionId}/commands`)) commands.push(request.postDataJSON());
  });
  await page.route(`**/s/${sessionId}/save/original`, (route) => route.fulfill({ status: 500, body: 'Failed destination' }));
  await page.getByRole('button', { name: /Open automatic save options$/u }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose where to save annotations', exact: true });
  await dialog.getByRole('radio', { name: 'Modify the original PDF' }).check();
  await dialog.getByRole('textbox', { name: 'Name on annotations' }).fill('Unconfirmed name');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(commands).toEqual([]);
  expect(host.broker.state(sessionId)?.annotationName).toBeUndefined();
  await expect(dialog.getByRole('textbox', { name: 'Name on annotations' })).toHaveValue('Unconfirmed name');
});

test('document annotation name advances only the pending first annotation revision it owns', async ({ page }) => {
  const { sessionId } = await openFreshProductionFixture(page, plainTextPdf, 'Pending annotation name fixture failed');
  const commands: { type: string; expectedRevision: number }[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(`/s/${sessionId}/commands`)) commands.push(request.postDataJSON());
    if (request.url().endsWith(`/s/${sessionId}/save/original`)) commands.push(request.postDataJSON().confirmation.command);
  });
  const canvas = page.locator("[data-page-index='0']").first();
  await waitForRenderedPageImage(canvas);
  await canvas.click({ button: 'right', position: { x: 320, y: 420 } });
  await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
  const composer = page.locator('[data-comment-composer]');
  await composer.locator('textarea').fill('First annotation with chosen name.');
  await composer.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose where to save annotations', exact: true });
  await dialog.getByRole('radio', { name: 'Modify the original PDF' }).check();
  await dialog.getByRole('textbox', { name: 'Name on annotations' }).fill('Brad Ross');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(composer).toHaveCount(0);
  await expect.poll(() => host.broker.state(sessionId)?.items.length).toBe(1);
  expect(host.broker.state(sessionId)).toMatchObject({ annotationName: 'Brad Ross' });
  expect(host.broker.state(sessionId)?.revision).toBeGreaterThan(2);
  expect(commands.find(({ type }) => type === 'set-annotation-name'))
    .toMatchObject({ type: 'set-annotation-name', expectedRevision: expect.any(Number) });
  expect(commands.at(-1)?.expectedRevision).toBeGreaterThan(0);
});


test('document annotation name export rejects a concurrent rename and retries the retained choice', async ({ page }) => {
  const launched = await host.open({
    pdfPath: await freshProductionPdf(plainTextPdf), sourceRootPath: sourceRoot,
    surface: 'browser', workflowMode: 'generated-output', fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') throw new Error('Export race fixture failed');
  const state = host.broker.state(launched.sessionId)!;
  await host.broker.acceptMutation(launched.sessionId, addPageNote(
    state, 0, { x: 80, y: 160, width: 18, height: 18 }, 'Chosen author survives export retry.',
  ));
  await page.goto(launched.url);
  await waitForRenderedPageImage(page.locator("[data-page-index='0']").first());
  let raced = false;
  await page.route(`**/s/${launched.sessionId}/export`, async (route) => {
    if (!raced) {
      raced = true;
      await host.broker.acceptMutation(launched.sessionId,
        setAnnotationName(host.broker.state(launched.sessionId)!, 'Other Window'));
    }
    await route.continue();
  });
  await page.getByRole('button', { name: /Open document actions$/u }).click();
  await page.getByRole('menuitem', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export reviewed PDF', exact: true });
  const name = dialog.getByRole('textbox', { name: 'Name on annotations', exact: true });
  await name.fill('Alice');
  const conflict = page.waitForResponse((response) => response.url().endsWith(`/s/${launched.sessionId}/export`));
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(dialog.getByRole('alert')).toContainText(/changed/u);
  await expect(name).toHaveValue('Alice');
  const exported = page.waitForResponse((response) => response.url().endsWith(`/s/${launched.sessionId}/export`) && response.ok());
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const result = await (await exported).json();
  await expect(dialog).toHaveCount(0);
  const items = await readEditableReviewItems(new Uint8Array(await readFile(result.path)));
  expect(items).toHaveLength(1);
  expect(items[0]?.importedAnnotationAuthor).toBe('Alice');
});
