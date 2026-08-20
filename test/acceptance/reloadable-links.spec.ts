import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { PlacekeeperHost } from "../../apps/service/src/host/placekeeper-host.js";

let root = "";
let pdf = "";
let host: PlacekeeperHost;

async function expectCurrentPage(page: Page, value: string): Promise<void> {
  await expect(page.locator('.review-chrome__page-control')).toHaveText(value, { timeout: 15_000 });
}

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "placekeeper-reloadable-links-"));
  pdf = join(root, "Paper One.pdf");
  await copyFile(resolve("test/fixtures/pdfs/reference-navigation.pdf"), pdf);
  host = await PlacekeeperHost.start({
    recoveryRoot: join(root, "recovery"),
    webAssets: { root: resolve("dist/web") },
  });
});

test.afterAll(async () => {
  await host?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

test("a live readable review survives repeated hard refresh and fails closed after session end", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (globalThis as typeof globalThis & { __copiedPlacekeeperLink?: string })
            .__copiedPlacekeeperLink = value;
        },
      },
    });
  });
  const launched = await host.open({ pdfPath: pdf, surface: "browser", fork: true });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Expected a live browser launch");
  }

  await page.goto(launched.url);
  await expect(page).toHaveURL(new RegExp(`/r/[0-9a-f-]{36}/.+Paper%20One\\.pdf#v=1&page=1$`, "u"));
  await expect(page.locator("#root")).toHaveAttribute("data-production-root", "true");
  await expectCurrentPage(page, "1 / 4");
  expect(page.url()).not.toContain("cap=");

  await page.evaluate(() => history.replaceState(history.state, "", "#v=1&page=3"));
  await page.reload();
  await expect(page).toHaveURL(/#v=1&page=3$/u);
  await expectCurrentPage(page, "3 / 4");
  const readableUrl = page.url();
  for (let refresh = 0; refresh < 2; refresh += 1) {
    await page.reload();
    await expect(page).toHaveURL(readableUrl);
    await expect(page.locator("#root")).toHaveAttribute("data-production-root", "true");
    await expectCurrentPage(page, "3 / 4");
  }

  const historyLength = await page.evaluate(() => history.length);
  const returnLink = page.locator('.pdf-workspace:not(.pdf-workspace--reference)').getByRole(
    "button",
    { name: "Open PDF link to Footnote return to body TOC, Page 1" },
  );
  await returnLink.click();
  const returnMenu = page.getByRole("menu", {
    name: "Open Footnote return to body TOC, Page 1",
  });
  await expect(returnMenu).toBeVisible();
  await returnMenu.getByRole("menuitem", { name: "Open in main document" }).click();
  await expectCurrentPage(page, "1 / 4");
  await expect(page).toHaveURL(/#v=1&page=1$/u);
  await expect.poll(() => page.evaluate(() => history.length)).toBe(historyLength + 1);

  const back = page.getByRole("button", { name: "Back in document history" });
  const forward = page.getByRole("button", { name: "Forward in document history" });
  await expect(back).toBeEnabled();
  await back.click();
  await expectCurrentPage(page, "3 / 4");
  await expect(page).toHaveURL(/#v=1&page=3$/u);
  await expect(forward).toBeEnabled();
  await forward.click();
  await expectCurrentPage(page, "1 / 4");
  await expect(page).toHaveURL(/#v=1&page=1$/u);

  await page.getByRole("button", { name: "Copy link to current PDF location" }).click();
  await expect(page.locator('[data-copy-link-status="success"]').getByRole("status"))
    .toHaveText("Link copied.");
  expect(await page.evaluate(() => (
    globalThis as typeof globalThis & { __copiedPlacekeeperLink?: string }
  ).__copiedPlacekeeperLink)).toMatch(/^placekeeper:\/\/\/.*Paper%20One\.pdf#v=1&page=1$/u);

  await host.broker.finish(launched.sessionId);
  await page.reload();
  await expect(page.getByText("This live review is no longer available.")).toBeVisible();
  const reopen = page.getByRole("link", { name: "Reopen in Placekeeper" });
  await expect(reopen).toHaveAttribute(
    "href",
    new RegExp(`^placekeeper:///.*Paper%20One\\.pdf#v=1&page=1$`, "u"),
  );
  await expect(page.getByRole("heading", { name: "Reopen this PDF" })).toBeFocused();
  await expect(page.getByLabel("Placekeeper link")).toHaveValue(
    new RegExp(`^placekeeper:///.*Paper%20One\\.pdf#v=1&page=1$`, "u"),
  );
});

test("a successor daemon keeps the old origin but serves a stale view as inert click-only recovery", async ({ page }) => {
  const successorRoot = await mkdtemp(join(tmpdir(), "placekeeper-successor-view-"));
  const successorPdf = join(successorRoot, "Successor Paper.pdf");
  await copyFile(resolve("test/fixtures/pdfs/text-native-with-annotations.pdf"), successorPdf);
  let first: PlacekeeperHost | undefined;
  let successor: PlacekeeperHost | undefined;
  try {
    first = await PlacekeeperHost.start({
      recoveryRoot: join(successorRoot, "first-recovery"),
      webAssets: { root: resolve("dist/web") },
      port: 0,
    });
    const launched = await first.open({ pdfPath: successorPdf, surface: "browser", fork: true });
    if (!launched.ok || launched.kind === "recovery-offered") {
      throw new Error("Expected a predecessor browser launch");
    }
    await page.goto(launched.url);
    await expect(page.locator("#root")).toHaveAttribute("data-production-root", "true");
    const readableUrl = new URL(page.url());
    const predecessorPort = first.server.port;

    await first.close();
    first = undefined;
    successor = await PlacekeeperHost.start({
      recoveryRoot: join(successorRoot, "successor-recovery"),
      webAssets: { root: resolve("dist/web") },
      port: predecessorPort,
    });
    expect(successor.server.origin).toBe(readableUrl.origin);

    await page.evaluate(() => { location.hash = "#unsafe"; });
    const requests: string[] = [];
    const recordRequest = (request: { url(): string }) => requests.push(request.url());
    page.on("request", recordRequest);
    await page.reload();
    await expect(page.locator("[data-terminal-recovery]")).toBeVisible();
    await expect(page.getByText("This live review is no longer available.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Reopen in Placekeeper" })).toHaveAttribute(
      "href",
      /^placekeeper:\/\/\/.*Successor%20Paper\.pdf#v=1&page=1$/u,
    );
    expect(page.url()).toBe(`${readableUrl.origin}${readableUrl.pathname}#unsafe`);
    expect(requests.some((url) => url.startsWith("placekeeper:"))).toBe(false);
    expect(requests.some((url) => new URL(url).pathname.endsWith("/resume"))).toBe(false);
    expect(requests.some((url) => new URL(url).pathname.startsWith("/s/"))).toBe(false);
    await expect(page.getByRole("heading", { name: "Reopen this PDF" })).toBeFocused();
    await expect(page.getByLabel("Placekeeper link")).toHaveValue(
      /^placekeeper:\/\/\/.*Successor%20Paper\.pdf#v=1&page=1$/u,
    );
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => Promise.reject(new Error("denied")) },
      });
    });
    await page.getByRole("button", { name: "Copy Link" }).click();
    await expect(page.getByRole("alert")).toContainText("Clipboard access failed");
    await expect(page.getByRole("button", { name: "Retry" })).toBeFocused();
    expect((await page.context().cookies(readableUrl.origin)).some(({ name }) => name === "placekeeper_view"))
      .toBe(false);
  } finally {
    await first?.close();
    await successor?.close();
    await rm(successorRoot, { recursive: true, force: true });
  }
});
