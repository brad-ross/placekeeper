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

async function copiedPlacekeeperLink(page: Page): Promise<string> {
  const link = await page.evaluate(() => (
    globalThis as typeof globalThis & { __copiedPlacekeeperLink?: string }
  ).__copiedPlacekeeperLink);
  if (link === undefined) throw new Error("No Placekeeper Link was copied");
  return link;
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

test("copies canonical PDF destinations and reopens them without source UI state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
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
    throw new Error("Expected a destination-link browser launch");
  }
  await page.goto(launched.url);
  await expectCurrentPage(page, "1 / 4");

  await page.getByRole("button", { name: "Open right workspace" }).click();
  const outline = page.getByRole("navigation", { name: "Document outline" });
  await expect(outline).toBeVisible();
  const overview = outline.getByRole("button", { name: "Overview, Page 2", exact: true });
  await overview.focus();
  const outlineCopy = outline.getByRole("button", {
    name: "Copy exact destination link for Overview, Page 2",
  });
  await expect(outlineCopy).toHaveAttribute("title", "Copy exact destination link");
  await expect(outlineCopy.locator(".lucide-link")).toBeVisible();
  await outlineCopy.click();
  const outlineLink = await copiedPlacekeeperLink(page);
  expect(outlineLink).toMatch(/#v=2&page=2&mode=xyz&params=72,640,0$/u);

  const pageOnly = outline.getByRole("button", {
    name: "Page-only appendix, Page 4",
    exact: true,
  });
  await pageOnly.focus();
  const pageOnlyCopy = outline.getByRole("button", {
    name: "Copy page link for Page-only appendix, Page 4",
  });
  await pageOnlyCopy.click();
  expect(await copiedPlacekeeperLink(page)).toMatch(/#v=1&page=4$/u);

  await page.getByRole("tab", { name: "Search", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search this PDF" });
  await search.fill("Detail target");
  const result = page.locator("[data-search-result]").first();
  await expect(result).toBeVisible();
  await result.getByRole("button").first().focus();
  const searchCopy = result.getByRole("button", {
    name: /Copy page link for Search result on page/u,
  });
  await searchCopy.click();
  expect(await copiedPlacekeeperLink(page)).toMatch(/#v=1&page=3$/u);

  await page.getByRole("button", { name: "Close right workspace" }).click();
  const primaryLink = page.locator(".pdf-workspace:not(.pdf-workspace--reference)").getByRole(
    "button",
    { name: "Open PDF link to Primary result, Page 2" },
  );
  await primaryLink.click();
  const linkMenu = page.getByRole("menu", { name: "Open Primary result, Page 2" });
  const popoverCopy = linkMenu.getByRole("menuitem", {
    name: "Copy link to exact destination on page 2",
  });
  await expect(popoverCopy.locator(".lucide-link")).toBeVisible();
  await popoverCopy.click();
  expect(await copiedPlacekeeperLink(page)).toBe(outlineLink);

  const reopened = await host.openLink({ link: outlineLink });
  if (!reopened.ok || reopened.kind === "confirmation-required" || reopened.kind === "recovery-offered") {
    throw new Error("Expected the copied exact destination to reopen");
  }
  await page.goto(reopened.url);
  await expect(page).toHaveURL(/#v=2&page=2&mode=xyz&params=72,640,0$/u);
  await expectCurrentPage(page, "2 / 4");
  await expect(page.locator("#review-tools-workspace")).toHaveAttribute(
    "data-tools-workspace-open",
    "false",
  );
  await expect(page.locator("[data-review-workspace]")).toHaveAttribute("data-workspace-open", "false");
  await expect(page.locator("[data-link-action-popover]")).toHaveCount(0);
  await expect(page.locator(".review-workspace__status")).toHaveText("");

  await page.evaluate(() => history.pushState(history.state, "", "#v=1&page=3"));
  await page.goBack();
  await expect(page).toHaveURL(/#v=2&page=2&mode=xyz&params=72,640,0$/u);
  await expectCurrentPage(page, "2 / 4");
  await page.goForward();
  await expect(page).toHaveURL(/#v=1&page=3$/u);
  await expectCurrentPage(page, "3 / 4");
  await page.goBack();
  await expect(page).toHaveURL(/#v=2&page=2&mode=xyz&params=72,640,0$/u);
  await expectCurrentPage(page, "2 / 4");

  await page.evaluate(() => history.replaceState(
    history.state,
    "",
    "#v=2&page=3&mode=fit-rectangle&params=10,10,10,20",
  ));
  await page.reload();
  await expect(page).toHaveURL(/#v=1&page=3$/u);
  await expectCurrentPage(page, "3 / 4");
  await expect(page.locator(".review-workspace__status")).toHaveText(
    "The exact destination is unavailable. Opened page 3 instead.",
  );

  await page.evaluate(() => history.replaceState(
    history.state,
    "",
    "#v=2&page=99&mode=fit-page",
  ));
  await page.reload();
  await expect(page).toHaveURL(/#v=1&page=1$/u);
  await expectCurrentPage(page, "1 / 4");
  await expect(page.locator(".review-workspace__status")).toHaveText(
    "The exact destination is unavailable. Opened page 1 instead.",
  );

  await page.evaluate(() => history.replaceState(history.state, "", "#v=1&page=4"));
  await page.reload();
  await expect(page).toHaveURL(/#v=1&page=4$/u);
  await expectCurrentPage(page, "4 / 4");
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

    const exactFragment = "#v=2&page=1&mode=fit-horizontal&params=640";
    await page.evaluate((fragment) => { location.hash = fragment; }, exactFragment);
    const requests: string[] = [];
    const recordRequest = (request: { url(): string }) => requests.push(request.url());
    page.on("request", recordRequest);
    await page.reload();
    await expect(page.locator("[data-terminal-recovery]")).toBeVisible();
    await expect(page.getByText("This live review is no longer available.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Reopen in Placekeeper" })).toHaveAttribute(
      "href",
      /^placekeeper:\/\/\/.*Successor%20Paper\.pdf#v=2&page=1&mode=fit-horizontal&params=640$/u,
    );
    expect(page.url()).toBe(`${readableUrl.origin}${readableUrl.pathname}${exactFragment}`);
    expect(requests.some((url) => url.startsWith("placekeeper:"))).toBe(false);
    expect(requests.some((url) => new URL(url).pathname.endsWith("/resume"))).toBe(false);
    expect(requests.some((url) => new URL(url).pathname.startsWith("/s/"))).toBe(false);
    await expect(page.getByRole("heading", { name: "Reopen this PDF" })).toBeFocused();
    await expect(page.getByLabel("Placekeeper link")).toHaveValue(
      /^placekeeper:\/\/\/.*Successor%20Paper\.pdf#v=2&page=1&mode=fit-horizontal&params=640$/u,
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
