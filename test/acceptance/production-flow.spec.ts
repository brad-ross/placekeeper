import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

import { ProofreaderHost } from "../../apps/service/src/host/proofreader-host.js";

let root = "";
let host: ProofreaderHost;
let launchUrl = "";
let sourceRoot = "";
let pdf = "";

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
  await page.goto(launchUrl);
  await expect(page.getByRole("heading", { name: "Local PDF Proofreader" })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Review tools" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Human delivery" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Codex delivery" })).toBeVisible();
  await expect.poll(() => assetResponses.some((url) => url.endsWith("/app.css"))).toBe(true);
  await expect.poll(() => assetResponses.some((url) => url.endsWith("/pdfium.wasm"))).toBe(true);

  await page.getByRole("button", { name: "Proofread mode" }).click();
  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
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
});
