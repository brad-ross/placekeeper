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
): Promise<void> {
  const box = await pdfPage.boundingBox();
  if (!box) throw new Error("Rendered PDF page has no bounds.");
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + end.x, box.y + end.y);
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

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pdf-proofreader-production-"));
  sourceRoot = join(root, "source");
  await mkdir(sourceRoot);
  pdf = join(root, "paper.pdf");
  await copyFile(resolve("test/fixtures/pdfs/text-native-with-annotations.pdf"), pdf);
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
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /Cannot update|while rendering|Maximum update depth|React/u.test(message.text())
    ) browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await installSelectionCaptureGate(page);
  await page.goto(launchUrl);
  await expect(page.getByRole("heading", { name: "Local PDF Proofreader" })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Review tools" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Human delivery" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Codex delivery" })).toBeVisible();
  await expect.poll(() => assetResponses.some((url) => url.endsWith("/app.css"))).toBe(true);
  await expect.poll(() => assetResponses.some((url) => url.endsWith("/pdfium.wasm"))).toBe(true);

  await expect(page.getByRole("button", { name: "Proofread mode" })).toHaveCount(0);
  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  const renderedPageImage = await waitForRenderedPageImage(pageCanvas);
  await expect(renderedPageImage).toHaveCSS("pointer-events", "none");
  await dragPdfPhrase(page, pageCanvas, { x: 76, y: 98 }, { x: 405, y: 98 });
  await expect(pageCanvas).toBeFocused();
  await expect(page.getByRole("alert")).toContainText("Reading the selected text");
  await page.keyboard.type("revised");
  await releaseSelectionCapture(page);

  const replacementDialog = page.getByRole("dialog", { name: "Replacement text" });
  await expect(replacementDialog).toBeVisible();
  await expect(replacementDialog.getByRole("textbox", { name: "Replacement text" })).toHaveValue("revised");
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
      proposedText: "revised",
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

  await pageCanvas.click({ position: { x: 80, y: 100 } });
  await page.getByRole("button", { name: "Page Note" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("Production review note");
  await dialog.getByRole("button", { name: /save/i }).click();
  await expect(page.getByText("Production review note")).toBeVisible();
  await expect(page.locator("[data-owned-mark='pageNote']")).toHaveCount(1);

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.locator("[data-owned-mark='pageNote']")).toHaveCount(1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("[data-owned-mark='pageNote']")).toHaveCount(1);

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
  expect(contactedOrigins).toEqual(new Set([new URL(launchUrl).origin]));
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
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /Cannot update|while rendering|Maximum update depth|React/u.test(message.text())
      ) browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
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
