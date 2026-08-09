import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { ProofreaderHost } from "../../apps/service/src/host/proofreader-host.js";

let root = "";
let host: ProofreaderHost;
let launchUrl = "";
let sourceRoot = "";
let pdf = "";
let rotatedPdf = "";
let initialSessionId = "";

async function installSelectionCaptureGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let holding = true;
    const releases = new Set<() => void>();
    globalThis.__pdfProofreaderSelectionCaptureTestGate = {
      wait() {
        if (!holding) return Promise.resolve();
        return new Promise<void>((resolve) => releases.add(resolve));
      },
    };
    (globalThis as typeof globalThis & { __releasePdfSelectionCapture(): void })
      .__releasePdfSelectionCapture = () => {
        holding = false;
        for (const release of releases) release();
        releases.clear();
      };
  });
}

async function releaseSelectionCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __releasePdfSelectionCapture(): void })
      .__releasePdfSelectionCapture();
  });
}

async function dragPdfPhrase(
  page: Page,
  pdfPage: ReturnType<Page["locator"]>,
  start: { x: number; y: number },
  end: { x: number; y: number },
  whileDragging?: () => Promise<void>,
): Promise<void> {
  const box = await pdfPage.boundingBox();
  if (!box) throw new Error("Rendered PDF page has no bounds.");
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + end.x, box.y + end.y);
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

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pdf-proofreader-production-"));
  sourceRoot = join(root, "source");
  await mkdir(sourceRoot);
  pdf = join(root, "paper.pdf");
  rotatedPdf = join(root, "rotated.pdf");
  await copyFile(resolve("test/fixtures/pdfs/text-native-with-annotations.pdf"), pdf);
  await copyFile(resolve("test/fixtures/pdfs/rotation-90-crop.pdf"), rotatedPdf);
  await copyFile(resolve("test/fixtures/latex/paper.tex"), join(sourceRoot, "paper.tex"));
  host = await ProofreaderHost.start({
    recoveryRoot: join(root, "recovery"),
    webAssets: { root: resolve("dist/web") },
  });
  const launched = await host.open({ pdfPath: pdf, sourceRootPath: sourceRoot });
  if (!launched.ok || launched.kind === "recovery-offered") throw new Error("Production launch failed");
  launchUrl = launched.url;
  initialSessionId = launched.sessionId;
});

test.afterAll(async () => {
  await host?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

test("one installed-style browser tree preserves review state across responsive layout", async ({ page }) => {
  const assetResponses: string[] = [];
  const contactedOrigins = new Set<string>();
  page.on("request", (request) => contactedOrigins.add(new URL(request.url()).origin));
  page.on("response", (response) => {
    if (response.url().includes("/assets/")) assetResponses.push(response.url());
  });
  const browserErrors = collectBrowserErrors(page);
  await installSelectionCaptureGate(page);
  await page.goto(launchUrl);
  await expect(page.getByRole("heading", { name: "paper.pdf" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Review views" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Human delivery", includeHidden: true })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Codex delivery", includeHidden: true })).toBeHidden();
  await expect.poll(() => assetResponses.some((url) => url.endsWith("/app.css"))).toBe(true);
  await expect.poll(() => assetResponses.some((url) => url.endsWith("/pdfium.wasm"))).toBe(true);

  await expect(page.getByRole("button", { name: "Proofread mode" })).toHaveCount(0);
  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await expect(page.getByLabel('Current page')).toHaveText('1 / 1');
  const workspace = page.locator('.pdf-workspace');
  await workspace.evaluate((element) => { element.setAttribute('data-mount-probe', 'stable'); });
  const renderedPageImage = await waitForRenderedPageImage(pageCanvas);
  const canvasBoxBeforeSelection = await pageCanvas.boundingBox();
  expect(canvasBoxBeforeSelection).not.toBeNull();
  if (canvasBoxBeforeSelection === null) throw new Error("Rendered PDF page has no bounds.");
  await expect(renderedPageImage).toHaveCSS("pointer-events", "none");
  await dragPdfPhrase(
    page,
    pageCanvas,
    { x: 76, y: 98 },
    { x: 405, y: 98 },
    async () => {
      await expect(pageCanvas.locator(':scope > div[style*="mix-blend-mode"]')).toBeVisible();
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
  await expect(page.getByRole("alert")).toContainText("Reading the selected text");
  await expect.poll(async () => (await pageCanvas.boundingBox())?.y)
    .toBe(canvasBoxBeforeSelection.y);
  await page.keyboard.press("b");
  await releaseSelectionCapture(page);

  const replacementDialog = page.getByRole("dialog", { name: "Replacement text" });
  await expect(replacementDialog).toBeVisible();
  const replacementTextbox = replacementDialog.getByRole("textbox", { name: "Replacement text" });
  await expect(replacementTextbox).toHaveValue("b");
  await page.keyboard.type("la");
  await expect(replacementTextbox).toHaveValue("bla");
  await replacementDialog.getByRole("button", { name: "Apply" }).click();
  await expect(replacementDialog).toHaveCount(0);
  await expect(page.locator("[data-review-item]")).toHaveCount(1);
  const replacementState = host.broker.state(initialSessionId);
  expect(replacementState?.revision).toBe(1);
  expect(replacementState?.items).toHaveLength(1);
  expect(replacementState?.items[0]).toMatchObject({
    kind: "replace",
    pageIndex: 0,
    payload: {
      quote: "Selectable proofreader text: unique equilibrium clearly",
      proposedText: "bla",
      reliable: true,
    },
  });
  const replacementSegments = replacementState?.items[0]?.payload.segmentRects;
  expect(Array.isArray(replacementSegments)).toBe(true);
  expect(replacementState?.items[0]?.payload.rect).toEqual(
    Array.isArray(replacementSegments) ? replacementSegments[0] : undefined,
  );
  expect(replacementState?.items[0]?.payload.rect).toEqual({
    x: 72,
    y: 881,
    width: 334,
    height: 16,
  });

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.locator("[data-owned-mark='replace']")).toHaveCount(1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("[data-owned-mark='replace']")).toHaveCount(1);
  const canvasBoxBeforeFinish = await pageCanvas.boundingBox();

  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByRole("heading", { name: "Finish review" })).toBeVisible();
  await expect.poll(async () => {
    const box = await page.locator('[data-review-finish-slot]').boundingBox();
    return box === null ? Number.POSITIVE_INFINITY : Math.abs(box.x + box.width - 1280);
  }).toBeLessThanOrEqual(1);
  await expect(page.getByText("1 review item")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Human delivery" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Codex delivery" })).toBeVisible();
  await expect(pageCanvas).toHaveCount(1);
  await expect(workspace).toHaveAttribute('data-mount-probe', 'stable');
  expect(await pageCanvas.boundingBox()).toEqual(canvasBoxBeforeFinish);

  const originalDigest = await sha256(pdf);
  await page.getByRole("button", { name: "Save reviewed copy" }).click();
  const savedStatus = page.getByRole("status").filter({ hasText: "Reviewed copy saved to" });
  await expect(savedStatus).toBeVisible();
  const savedText = await savedStatus.textContent();
  const reviewedPath = savedText?.match(/^Reviewed copy saved to (.+?)(?: The reviewed copy|$)/u)?.[1];
  expect(reviewedPath).toBeTruthy();
  await access(reviewedPath!);
  expect(await sha256(pdf)).toBe(originalDigest);

  await page.getByRole("button", { name: "Prepare Codex handoff" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Confirm this external data flow" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Confirm and prepare" })).toBeFocused();
  await page.setViewportSize({ width: 320, height: 720 });
  await expect(confirm).toBeVisible();
  await expect(pageCanvas).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Finish review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare Codex handoff" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Finish review", includeHidden: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Finish" })).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Finish" }).click();
  await page.getByRole("button", { name: "Prepare Codex handoff" }).click();
  await expect(confirm).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: sourceRoot })).toBeVisible();
  await confirm.getByRole("button", { name: "Confirm and prepare" }).click();
  await expect(page.getByText(/^Handoff JSON:/u)).toBeVisible();
  const handoffPath = (await page.getByText(/^Handoff JSON:/u).textContent())?.replace("Handoff JSON: ", "");
  const codexReviewedPath = (await page.getByText(/^Reviewed PDF:/u).textContent())?.replace("Reviewed PDF: ", "");
  expect(handoffPath).toBeTruthy();
  expect(codexReviewedPath).toBeTruthy();
  await access(handoffPath!);
  await access(codexReviewedPath!);
  expect((await realpath(handoffPath!)).startsWith(`${await realpath(sourceRoot)}/`)).toBe(true);
  await expect(page.locator("#codex-instruction")).toContainText(handoffPath!);
  await page.getByRole("button", { name: "Close finish options" }).click();
  await expect(page.getByText(/^Handoff JSON:/u)).toBeHidden();
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByText(/^Handoff JSON:/u)).toHaveText(`Handoff JSON: ${handoffPath}`);
  expect(contactedOrigins).toEqual(new Set([new URL(launchUrl).origin]));
  expect(browserErrors).toEqual([]);
});

test('uses the same compact review tree for a narrow VS Code embed launch', async ({ page }) => {
  const launched = await host.open({
    pdfPath: pdf,
    sourceRootPath: sourceRoot,
    surface: 'vscode',
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') throw new Error('VS Code embed launch failed');
  expect(new URL(launched.url).searchParams.get('embed')).toBe('vscode');
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(launched.url);
  await expect(page.locator('[data-production-review]')).toHaveCount(1);
  await expect(page.locator('[data-review-chrome]')).toHaveCount(1);
  await expect(page.locator('.pdf-workspace')).toHaveCount(1);
  const pdfPage = page.locator("[data-page-index='0']").first();
  await expect(pdfPage).toBeVisible();
  await page.getByRole('button', { name: /Annotations/u }).click();
  await expect(page.getByRole('button', { name: 'Close annotations' })).toHaveCount(0);
  await expect.poll(async () => {
    const box = await page.locator('[data-annotation-drawer]').boundingBox();
    return box === null ? Number.POSITIVE_INFINITY : Math.abs(box.x + box.width - 320);
  }).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: /highlight · Page 1 · Existing supported highlight/iu }).click();
  await expect.poll(async () => {
    const box = await page.locator('[data-annotation-drawer]').boundingBox();
    return box === null ? Number.POSITIVE_INFINITY : Math.abs(box.x + box.width - 320);
  }).toBeLessThanOrEqual(1);

  const zoomBefore = await page.getByLabel('Zoom level').textContent();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByLabel('Zoom level')).not.toHaveText(zoomBefore ?? '');
  await expect(page.getByRole('button', { name: /Annotations/u })).toHaveAttribute('aria-expanded', 'true');

  await pdfPage.evaluate((element) => {
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const overflowY = getComputedStyle(ancestor).overflowY;
      if (/^(auto|scroll)$/u.test(overflowY)) {
        ancestor.dataset.viewerScrollViewport = 'true';
        return;
      }
    }
    throw new Error('Viewer scroll viewport is missing.');
  });
  const scrollViewport = page.locator('[data-viewer-scroll-viewport="true"]');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const scrollable = await scrollViewport.evaluate((element) => element.scrollHeight > element.clientHeight);
    if (scrollable) break;
    await page.getByRole('button', { name: 'Zoom in' }).click();
  }
  await expect.poll(() => scrollViewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(page.getByRole('button', { name: /Annotations/u })).toHaveAttribute('aria-expanded', 'true');
  const scrollBefore = await scrollViewport.evaluate((element) => element.scrollTop);
  const stage = await page.locator('[data-review-stage]').boundingBox();
  if (!stage) throw new Error('Review stage has no bounds.');
  await page.mouse.move(stage.x + 24, stage.y + stage.height / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => scrollViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollBefore);
  await expect(page.getByRole('button', { name: /Annotations/u })).toHaveAttribute('aria-expanded', 'true');

  await scrollViewport.dispatchEvent('pointerdown', {
    pointerId: 41, pointerType: 'touch', isPrimary: true, button: 0, clientX: 24, clientY: 300,
  });
  await scrollViewport.dispatchEvent('pointerdown', {
    pointerId: 42, pointerType: 'touch', isPrimary: false, button: 0, clientX: 30, clientY: 300,
  });
  await scrollViewport.dispatchEvent('pointerup', {
    pointerId: 42, pointerType: 'touch', isPrimary: false, button: 0, clientX: 30, clientY: 300,
  });
  await scrollViewport.dispatchEvent('pointerup', {
    pointerId: 41, pointerType: 'touch', isPrimary: true, button: 0, clientX: 24, clientY: 300,
  });
  await expect(page.getByRole('button', { name: /Annotations/u })).toHaveAttribute('aria-expanded', 'true');

  await page.mouse.down();
  await page.mouse.move(stage.x + 24, stage.y + stage.height / 2 + 18);
  await page.mouse.up();
  await expect(page.getByRole('button', { name: /Annotations/u })).toHaveAttribute('aria-expanded', 'true');

  await scrollViewport.evaluate((element) => {
    element.dataset.pointerCancels = '0';
    element.addEventListener('pointercancel', () => {
      element.dataset.pointerCancels = String(Number(element.dataset.pointerCancels ?? '0') + 1);
    });
  });
  await page.mouse.click(stage.x + 24, stage.y + stage.height / 2);
  await expect(page.getByRole('button', { name: /Annotations/u })).toHaveAttribute('aria-expanded', 'false');
  await expect(scrollViewport).toHaveAttribute('data-pointer-cancels', '1');
  expect(host.broker.state(launched.sessionId)?.revision).toBe(0);
});

test("creates a canonical Page Note from a real PDF context gesture without secondary-activating its mark", async ({ page }) => {
  const launched = await host.open({
    pdfPath: pdf,
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Fresh Page Note production launch failed");
  }
  const browserErrors = collectBrowserErrors(page);
  await page.goto(launched.url);

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await expect(page.getByLabel("Current page")).toHaveText("1 / 1");
  await waitForRenderedPageImage(pageCanvas);
  const canvasBox = await pageCanvas.boundingBox();
  if (!canvasBox) throw new Error("Rendered PDF page has no bounds.");
  const scale = canvasBox.width / 612;
  const point = { x: 500 * scale, y: 600 * scale };

  await pageCanvas.click({ button: "right", position: point });
  const addPageNote = page.getByRole("menuitem", { name: "Add Page Note" });
  await expect(addPageNote).toBeVisible();
  await expect(addPageNote).toBeFocused();
  await addPageNote.click();

  const composer = page.getByRole("dialog", { name: "Page Note" });
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox", { name: "Comment" }).fill("Check the conclusion.");
  await composer.getByRole("button", { name: "Save comment" }).click();

  await expect.poll(() => host.broker.state(launched.sessionId)?.revision).toBe(1);
  const state = host.broker.state(launched.sessionId);
  expect(state?.revision).toBe(1);
  expect(state?.items).toHaveLength(1);
  const note = state?.items[0];
  expect(note).toMatchObject({
    kind: "pageNote",
    pageIndex: 0,
    payload: {
      comment: "Check the conclusion.",
      position: { width: 18, height: 18 },
    },
  });
  const position = note?.payload.position;
  expect(position).toMatchObject({ x: 500, y: 1392, width: 18, height: 18 });
  expect(note?.id).toBeTruthy();
  const mark = page.locator(`[data-owned-mark="pageNote"][data-review-id="${note!.id}"]`);
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveAttribute("data-active", "false");

  const markBox = await mark.boundingBox();
  if (!markBox) throw new Error("Rendered Page Note mark has no bounds.");
  await page.mouse.click(markBox.x + markBox.width / 2, markBox.y + markBox.height / 2, {
    button: "right",
  });
  await expect(page.getByRole("menu", { name: "Page actions" })).toHaveCount(0);
  await expect(mark).toHaveAttribute("data-active", "false");
  await expect(page.getByRole("button", { name: /Annotations/u })).toHaveAttribute("aria-expanded", "false");
  expect(host.broker.state(launched.sessionId)?.revision).toBe(1);
  expect(browserErrors).toEqual([]);
});

test("places a canonical Page Note through the real PDF keyboard cursor", async ({ page }) => {
  const launched = await host.open({
    pdfPath: pdf,
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Fresh keyboard Page Note production launch failed");
  }
  const browserErrors = collectBrowserErrors(page);
  await page.goto(launched.url);

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await expect(page.getByLabel("Current page")).toHaveText("1 / 1");
  await waitForRenderedPageImage(pageCanvas);
  await pageCanvas.focus();
  await page.keyboard.press("Alt+Shift+N");
  const cursor = page.getByRole("button", { name: /^Page Note placement cursor/u });
  await expect(cursor).toBeVisible();
  await expect(cursor).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  const composer = page.getByRole("dialog", { name: "Page Note" });
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox", { name: "Comment" }).fill("Keyboard-placed note.");
  await composer.getByRole("button", { name: "Save comment" }).click();

  await expect.poll(() => host.broker.state(launched.sessionId)?.revision).toBe(1);
  const state = host.broker.state(launched.sessionId);
  expect(state?.revision).toBe(1);
  expect(state?.items).toHaveLength(1);
  const note = state?.items[0];
  expect(note).toMatchObject({
    kind: "pageNote",
    pageIndex: 0,
    payload: {
      comment: "Keyboard-placed note.",
      position: { x: 310, y: 1192, width: 18, height: 18 },
    },
  });
  expect(note?.id).toBeTruthy();
  await expect(page.locator(
    `[data-owned-mark="pageNote"][data-review-id="${note!.id}"]`,
  )).toHaveCount(1);
  expect(browserErrors).toEqual([]);
});

test("normalizes a real context gesture on a rotated cropped PDF into canonical page space", async ({ page }) => {
  const launched = await host.open({
    pdfPath: rotatedPdf,
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Rotated Page Note production launch failed");
  }
  const browserErrors = collectBrowserErrors(page);
  await page.goto(launched.url);

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await expect(page.getByLabel("Current page")).toHaveText("1 / 1");
  await waitForRenderedPageImage(pageCanvas);
  const canvasBox = await pageCanvas.boundingBox();
  if (!canvasBox) throw new Error("Rendered rotated PDF page has no bounds.");
  const scale = canvasBox.width / 720;

  await pageCanvas.click({
    button: "right",
    position: { x: 300 * scale, y: 200 * scale },
  });
  await page.getByRole("menuitem", { name: "Add Page Note" }).click();
  const composer = page.getByRole("dialog", { name: "Page Note" });
  await composer.getByRole("textbox", { name: "Comment" }).fill("Rotated geometry note.");
  await composer.getByRole("button", { name: "Save comment" }).click();

  await expect.poll(() => host.broker.state(launched.sessionId)?.revision).toBe(1);
  const state = host.broker.state(launched.sessionId);
  expect(state?.items).toHaveLength(1);
  const note = state?.items[0];
  expect(note).toMatchObject({
    kind: "pageNote",
    pageIndex: 0,
    payload: {
      comment: "Rotated geometry note.",
      position: { x: 236, y: 1176, width: 18, height: 18 },
    },
  });
  expect(note?.id).toBeTruthy();
  await expect(page.locator(
    `[data-owned-mark="pageNote"][data-review-id="${note!.id}"]`,
  )).toHaveCount(1);
  expect(browserErrors).toEqual([]);
});

for (const key of ["Delete", "Backspace"] as const) {
  test(`a fresh real selection queues exactly one ${key} command while capture is pending`, async ({ page }) => {
    const launched = await host.open({
      pdfPath: pdf,
      sourceRootPath: sourceRoot,
      fork: true,
    });
    if (!launched.ok || launched.kind === "recovery-offered") {
      throw new Error(`Fresh ${key} production launch failed`);
    }
    const browserErrors = collectBrowserErrors(page);
    await installSelectionCaptureGate(page);
    await page.goto(launched.url);

    const pageCanvas = page.locator("[data-page-index='0']").first();
    await expect(pageCanvas).toBeVisible();
    await waitForRenderedPageImage(pageCanvas);
    await dragPdfPhrase(page, pageCanvas, { x: 253, y: 98 }, { x: 405, y: 98 });
    await expect(pageCanvas).toBeFocused();
    await expect(page.getByRole("alert")).toContainText("Reading the selected text");
    const urlBeforeKey = page.url();
    await page.keyboard.press(key);
    await releaseSelectionCapture(page);

    await expect(page.locator("[data-review-item]")).toHaveCount(1);
    await expect(page.locator("[data-owned-mark='delete']")).toHaveCount(1);
    expect(page.url()).toBe(urlBeforeKey);
    const state = host.broker.state(launched.sessionId);
    expect(state?.revision).toBe(1);
    expect(state?.items).toHaveLength(1);
    expect(state?.items[0]).toMatchObject({
      kind: "delete",
      pageIndex: 0,
      payload: {
        quote: "unique equilibrium clearly",
        reliable: true,
      },
    });
    const segments = state?.items[0]?.payload.segmentRects;
    expect(Array.isArray(segments)).toBe(true);
    expect(state?.items[0]?.payload.rect).toEqual(
      Array.isArray(segments) ? segments[0] : undefined,
    );
    expect(state?.items[0]?.payload.rect).toEqual({
      x: 248,
      y: 881,
      width: 158,
      height: 16,
    });
    expect(browserErrors).toEqual([]);
  });
}

test("discards queued typing when a pending selection is cleared", async ({ page }) => {
  const launched = await host.open({
    pdfPath: pdf,
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Fresh pending-clear production launch failed");
  }
  await installSelectionCaptureGate(page);
  await page.goto(launched.url);

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await waitForRenderedPageImage(pageCanvas);
  await dragPdfPhrase(page, pageCanvas, { x: 76, y: 98 }, { x: 245, y: 98 });
  await expect(page.getByRole("alert")).toContainText("Reading the selected text");
  await page.keyboard.type("discard me");

  await pageCanvas.click({ position: { x: 500, y: 300 } });
  await releaseSelectionCapture(page);

  await expect(page.getByRole("dialog", { name: "Replacement text" })).toHaveCount(0);
  await expect(page.locator("[data-review-item]")).toHaveCount(0);
  expect(host.broker.state(launched.sessionId)?.revision).toBe(0);
});

test("keeps only typing for the newest pending selection", async ({ page }) => {
  const launched = await host.open({
    pdfPath: pdf,
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Fresh pending-supersession production launch failed");
  }
  await installSelectionCaptureGate(page);
  await page.goto(launched.url);

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await waitForRenderedPageImage(pageCanvas);
  await dragPdfPhrase(page, pageCanvas, { x: 76, y: 98 }, { x: 245, y: 98 });
  await expect(page.getByRole("alert")).toContainText("Reading the selected text");
  await page.keyboard.type("obsolete");

  await dragPdfPhrase(page, pageCanvas, { x: 253, y: 98 }, { x: 405, y: 98 });
  await page.keyboard.type("current");
  await releaseSelectionCapture(page);

  const replacementDialog = page.getByRole("dialog", { name: "Replacement text" });
  await expect(replacementDialog).toBeVisible();
  await expect(replacementDialog.getByRole("textbox", { name: "Replacement text" })).toHaveValue("current");
  await replacementDialog.getByRole("button", { name: "Apply" }).click();
  await expect(replacementDialog).toHaveCount(0);
  await expect(page.locator("[data-review-item]")).toHaveCount(1);
  const state = host.broker.state(launched.sessionId);
  expect(state?.revision).toBe(1);
  expect(state?.items).toHaveLength(1);
  expect(state?.items[0]).toMatchObject({
    kind: "replace",
    payload: {
      proposedText: "current",
    },
  });
  expect(state?.items[0]?.payload.quote).not.toBe("");
});
