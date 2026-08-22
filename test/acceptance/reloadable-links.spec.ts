import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { addPageNote } from "../../packages/core/src/review-commands.js";
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

test("a live Codex review copies a browser-safe URL, survives refresh, and reopens in place", async ({ page }) => {
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
  const launched = await host.open({ pdfPath: pdf, surface: "codex", fork: true });
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
  await expect(page.locator('[data-copy-link-status="success"]').getByRole("status"))
    .toHaveClass("sr-only");
  await expect(page.locator(".copy-link-control__status")).toHaveCount(0);
  const copiedLink = await page.evaluate(() => (
    globalThis as typeof globalThis & { __copiedPlacekeeperLink?: string }
  ).__copiedPlacekeeperLink);
  expect(copiedLink).toMatch(
    /^http:\/\/127\.0\.0\.1:\d+\/r\/[0-9a-f-]{36}\/.*Paper%20One\.pdf#v=1&page=1$/u,
  );
  const pasted = await page.context().newPage();
  await pasted.goto(copiedLink!);
  await expect(pasted.locator("#root")).toHaveAttribute("data-production-root", "true");
  await expectCurrentPage(pasted, "1 / 4");
  await pasted.close();

  await host.broker.finish(launched.sessionId);
  const slowPage = await page.context().newPage();
  let releaseApp!: () => void;
  const appGate = new Promise<void>((resolve) => { releaseApp = resolve; });
  await slowPage.route("**/assets/app.js", async (route) => {
    await appGate;
    await route.continue();
  });
  await slowPage.goto(page.url(), { waitUntil: "domcontentloaded" });
  const earlyReopen = slowPage.getByRole("link", { name: "Reopen" });
  await expect(earlyReopen).toHaveAttribute("href", "#");
  await expect(earlyReopen).toHaveAttribute("aria-disabled", "true");
  await earlyReopen.evaluate((anchor) => {
    if (!(anchor instanceof HTMLAnchorElement)) throw new Error("Expected recovery link");
    anchor.click();
  });
  expect(new URL(slowPage.url()).protocol).toBe("http:");
  releaseApp();
  await expect(slowPage.getByRole("button", { name: "Reopen" })).toBeVisible();
  await expect(earlyReopen).toHaveCount(0);
  await slowPage.close();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Reopen Paper One.pdf" })).toBeFocused();
  const reopen = page.getByRole("button", { name: "Reopen" });
  await expect(page.getByLabel("Placekeeper link")).toHaveCount(0);
  await expect(page.getByLabel("Browser link")).toHaveCount(0);
  await page.getByRole("button", { name: "Copy Link" }).click();
  expect(await page.evaluate(() => (
    globalThis as typeof globalThis & { __copiedPlacekeeperLink?: string }
  ).__copiedPlacekeeperLink)).toMatch(
    /^placekeeper:\/\/\/.*Paper%20One\.pdf#v=1&page=1$/u,
  );
  await reopen.click();
  await expect(page.getByRole("button", { name: "Open this PDF" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(page.locator("#root")).toHaveAttribute("data-production-root", "true");
  await expectCurrentPage(page, "1 / 4");
  await expect(page).toHaveURL(/\/r\/[0-9a-f-]{36}\/.*Paper%20One\.pdf#v=1&page=1$/u);
});

test("a pending restarted browser is promoted to Codex without remounting", async ({ page }) => {
  const restartRoot = await mkdtemp(join(tmpdir(), "placekeeper-reconnect-browser-"));
  const restartPdf = join(restartRoot, "restart.pdf");
  await copyFile(resolve("test/fixtures/pdfs/reference-navigation.pdf"), restartPdf);
  const first = await PlacekeeperHost.start({
    recoveryRoot: join(restartRoot, "recovery"),
    webAssets: { root: resolve("dist/web") },
  });
  let successor: PlacekeeperHost | undefined;
  try {
    const launched = await first.open({ pdfPath: restartPdf, surface: "codex" });
    if (!launched.ok || launched.kind === "recovery-offered" || launched.bindProof === undefined) {
      throw new Error("Expected a task-bindable review");
    }
    await first.broker.claimTaskBinding({
      bindProof: launched.bindProof,
      taskSessionId: "restart-owner-task",
      reviewSessionId: launched.sessionId,
      documentGeneration: launched.documentGeneration,
    });
    await page.goto(launched.url);
    await expect(page.locator("#root")).toHaveAttribute("data-production-root", "true");
    const staleUrl = page.url();
    const port = first.server.port;
    // Closing the page releases its control socket so the old listener can
    // relinquish the fixed loopback port before the successor starts.
    await page.goto("about:blank");
    await first.server.close();

    successor = await PlacekeeperHost.start({
      recoveryRoot: join(restartRoot, "recovery"),
      webAssets: { root: resolve("dist/web") },
      port,
    });
    await page.goto(staleUrl);
    await page.getByRole("button", { name: "Reopen" }).click();
    await expect(page.getByRole("button", { name: "Open this PDF" })).toHaveCount(0);
    await expect(page.locator("#root")).toHaveAttribute("data-production-root", "true");
    await expect(page.locator('[data-codex-context]')).toHaveCount(0);
    const rootElement = await page.locator("#root").elementHandle();

    await successor.broker.prepareTaskContext("restart-owner-task");

    await expect(page.locator('[data-codex-context]')).toHaveAttribute("data-codex-context", "connecting");
    expect(await rootElement?.evaluate((element) => element.isConnected)).toBe(true);
  } finally {
    await successor?.close();
    await first.close().catch(() => undefined);
    await rm(restartRoot, { recursive: true, force: true });
  }
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
  expect(await outlineCopy.getAttribute("title")).toBeNull();
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

test("a successor daemon keeps the old origin but serves a stale view as inert click-only recovery", async ({ page, browserName }) => {
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
    await expect(page.getByRole("heading", { name: "Reopen Successor Paper.pdf" })).toBeFocused();
    await expect(page.locator(".terminal-recovery__document")).toHaveCount(0);
    await expect(page.getByText(/unfinished work is available/iu)).toBeVisible();
    const reopenButton = page.getByRole("button", { name: "Reopen" });
    const copyButton = page.getByRole("button", { name: "Copy Link" });
    await expect(reopenButton).toBeVisible();
    await expect(reopenButton).toHaveAttribute("data-icon", "redo");
    await expect(reopenButton.locator(".review-icon")).toHaveCount(1);
    await expect(copyButton).toBeVisible();
    await expect(copyButton).toHaveAttribute("data-icon", "link");
    await expect(copyButton.locator(".review-icon")).toHaveCount(1);
    const footerGeometry = await page.evaluate(() => {
      const footer = document.querySelector<HTMLElement>(".terminal-recovery__footer")!;
      const button = document.querySelector<HTMLElement>(".terminal-recovery__footer button")!;
      const status = document.querySelector<HTMLElement>(".terminal-recovery__copy-status")!;
      const style = getComputedStyle(footer);
      return {
        actualHeight: footer.getBoundingClientRect().height,
        expectedHeight: button.getBoundingClientRect().height
          + Number.parseFloat(style.paddingTop)
          + Number.parseFloat(style.paddingBottom)
          + Number.parseFloat(style.borderTopWidth),
        statusDisplay: getComputedStyle(status).display,
      };
    });
    expect(footerGeometry.statusDisplay).toBe("none");
    expect(Math.abs(footerGeometry.actualHeight - footerGeometry.expectedHeight)).toBeLessThanOrEqual(1);
    const bodyGeometry = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>(".terminal-recovery__body")!;
      const explanation = body.querySelector<HTMLElement>("p:first-child")!;
      const actions = document.querySelector<HTMLElement>(".terminal-recovery__actions")!;
      const style = getComputedStyle(body);
      return {
        actualHeight: body.getBoundingClientRect().height,
        expectedHeight: explanation.getBoundingClientRect().height
          + Number.parseFloat(style.paddingTop)
          + Number.parseFloat(style.paddingBottom),
        actionsDisplay: getComputedStyle(actions).display,
      };
    });
    expect(bodyGeometry.actionsDisplay).toBe("none");
    expect(Math.abs(bodyGeometry.actualHeight - bodyGeometry.expectedHeight)).toBeLessThanOrEqual(1);
    await expect(page.getByLabel("Browser link")).toHaveCount(0);
    await expect(page.getByLabel("Placekeeper link")).toHaveCount(0);
    expect(page.url()).toBe(`${readableUrl.origin}${readableUrl.pathname}${exactFragment}`);
    expect(requests.some((url) => url.startsWith("placekeeper:"))).toBe(false);
    expect(requests.some((url) => new URL(url).pathname.endsWith("/reopen"))).toBe(false);
    expect(requests.some((url) => new URL(url).pathname.endsWith("/resume"))).toBe(false);
    expect(requests.some((url) => new URL(url).pathname.startsWith("/s/"))).toBe(false);
    await expect(page.getByRole("heading", { name: "Reopen Successor Paper.pdf" })).toBeFocused();
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(page.getByRole("button", { name: "Copy Link" })).toBeFocused();
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(page.getByRole("button", { name: "Reopen" })).toBeFocused();
    const staleViewId = /^\/r\/([0-9a-f-]{36})\//u.exec(readableUrl.pathname)?.[1];
    if (staleViewId === undefined) throw new Error("Expected a readable stale-view route");
    let requestBody: unknown;
    await page.route(`**/r/${staleViewId}/reopen`, async (route) => {
      requestBody = route.request().postDataJSON();
      await route.fulfill({ status: 409 });
    });
    const reopen = page.getByRole("button", { name: "Reopen" });
    await reopen.click();
    await expect(page.getByRole("alert")).toContainText("could not reopen this PDF");
    await expect(page.getByRole("alert")).toBeFocused();
    await expect(reopen).toBeEnabled();
    expect(requestBody).toEqual({
      link: expect.stringMatching(
        /^placekeeper:\/\/\/.*Successor%20Paper\.pdf#v=2&page=1&mode=fit-horizontal&params=640$/u,
      ),
      confirmed: true,
    });
    await page.evaluate(() => {
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
    const beforeCopyUrl = page.url();
    const beforeCopySelection = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    await page.getByRole("button", { name: "Copy Link" }).click();
    expect(await copiedPlacekeeperLink(page)).toMatch(
      /^placekeeper:\/\/\/.*Successor%20Paper\.pdf#v=2&page=1&mode=fit-horizontal&params=640$/u,
    );
    expect(page.url()).toBe(beforeCopyUrl);
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? ""))
      .toBe(beforeCopySelection);
    await expect(page.getByRole("status")).toContainText("Placekeeper link copied");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => Promise.reject(new Error("denied")) },
      });
    });
    await page.getByRole("button", { name: "Copy Link" }).click();
    await expect(page.getByText(/Clipboard access failed/iu)).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeFocused();
    await expect(page.getByLabel("Canonical Placekeeper link")).toHaveValue(
      /^placekeeper:\/\/\/.*Successor%20Paper\.pdf#v=2&page=1&mode=fit-horizontal&params=640$/u,
    );
    expect((await page.context().cookies(readableUrl.origin)).some(({ name }) => name === "placekeeper_view"))
      .toBe(false);
    await page.unroute(`**/r/${staleViewId}/reopen`);
    await page.getByRole("button", { name: "Reopen" }).click();
    await expect(page.getByRole("button", { name: "Open this PDF" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
    await expect(page.locator("#root")).toHaveAttribute("data-production-root", "true");
    await expect(page).toHaveURL(
      /\/r\/[0-9a-f-]{36}\/.*Successor%20Paper\.pdf#v=2&page=1&mode=fit-horizontal&params=640$/u,
    );
  } finally {
    await first?.close();
    await successor?.close();
    await rm(successorRoot, { recursive: true, force: true });
  }
});

test("a successor offers a real protected draft and preserves exact choices across retryable failures", async ({ page, browserName }) => {
  test.setTimeout(60_000);
  const recoveryRoot = await mkdtemp(join(tmpdir(), "placekeeper-successor-draft-"));
  const draftPdf = join(recoveryRoot, "Protected Draft.pdf");
  await copyFile(resolve("test/fixtures/pdfs/text-native-with-annotations.pdf"), draftPdf);
  let first: PlacekeeperHost | undefined;
  let successor: PlacekeeperHost | undefined;
  try {
    first = await PlacekeeperHost.start({
      recoveryRoot: join(recoveryRoot, "recovery"),
      webAssets: { root: resolve("dist/web") },
      port: 0,
    });
    const launched = await first.open({ pdfPath: draftPdf, surface: "browser", fork: true });
    if (!launched.ok || launched.kind === "recovery-offered") {
      throw new Error("Expected the predecessor protected-draft launch");
    }
    const state = first.broker.state(launched.sessionId);
    if (state === undefined) throw new Error("Expected predecessor review state");
    await first.broker.acceptMutation(
      launched.sessionId,
      addPageNote(state, 0, { x: 96, y: 120, width: 12, height: 16 }, "Keep this draft note"),
    );
    await page.goto(launched.url);
    await expect(page.locator("#root")).toHaveAttribute("data-production-root", "true");
    await expect(page).toHaveURL(/\/r\/[0-9a-f-]{36}\//u);
    const staleUrl = page.url();
    const predecessorPort = first.server.port;

    await page.goto("about:blank");
    await first.close();
    first = undefined;
    successor = await PlacekeeperHost.start({
      recoveryRoot: join(recoveryRoot, "recovery"),
      webAssets: { root: resolve("dist/web") },
      port: predecessorPort,
    });
    await page.goto(staleUrl);
    await expect(page.locator("[data-terminal-recovery='enhanced']")).toBeVisible();
    const ordinaryHeight = await page.locator("[data-terminal-recovery]")
      .evaluate((element) => element.getBoundingClientRect().height);
    await page.getByRole("button", { name: "Reopen" }).click();

    const resume = page.getByRole("button", { name: "Resume draft" });
    const discard = page.getByRole("button", { name: "Discard draft" });
    const fork = page.getByRole("button", { name: "Open separate copy" });
    await expect(resume).toHaveAttribute("data-icon", "redo");
    await expect(discard).toHaveAttribute("data-icon", "delete");
    await expect(fork).toHaveAttribute("data-icon", "plus");
    await expect(resume.locator(".review-icon")).toHaveCount(1);
    await expect(discard.locator(".review-icon")).toHaveCount(1);
    await expect(fork.locator(".review-icon")).toHaveCount(1);
    await expect(resume).toBeFocused();
    await expect(page.locator(".terminal-recovery__choice")).toHaveCount(3);
    const offeredHeight = await page.locator("[data-terminal-recovery]")
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(offeredHeight).toBeGreaterThan(ordinaryHeight);
    await expect(page.getByText("Continue the protected draft with all unfinished work.")).toBeVisible();
    await expect(page.getByText(/Permanently remove the protected draft/iu)).toBeVisible();
    await expect(page.getByText(/independent session/iu)).toBeVisible();

    const tabKey = browserName === "webkit" ? "Alt+Tab" : "Tab";
    await page.keyboard.press(tabKey);
    await expect(discard).toBeFocused();
    await page.keyboard.press(tabKey);
    await expect(fork).toBeFocused();
    await page.keyboard.press(tabKey);
    await expect(page.getByRole("button", { name: "Copy Link" })).toBeFocused();

    const viewId = /^\/r\/([0-9a-f-]{36})\//u.exec(new URL(staleUrl).pathname)?.[1];
    if (viewId === undefined) throw new Error("Expected a protected-draft stale route");
    const captured: Array<Record<string, unknown>> = [];
    const reopenRoute = `**/r/${viewId}/reopen`;
    await page.route(reopenRoute, async (route) => {
      captured.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 409 });
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.getByRole("button", { name: "Resume draft" }).click();
      await expect(page.getByRole("alert")).toContainText("all choices remain available");
      await expect(page.getByRole("alert")).toBeFocused();
      await expect(page.locator(".terminal-recovery__choice")).toHaveCount(3);
    }
    await page.getByRole("button", { name: "Open separate copy" }).click();
    await expect(page.getByRole("alert")).toBeFocused();
    await expect(page.locator(".terminal-recovery__choice")).toHaveCount(3);

    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText(/Permanently discard the unfinished draft for Protected Draft\.pdf/iu))
      .toBeVisible();
    await expect(page.getByText(/This cannot be undone/iu)).toBeVisible();
    await expect(page.getByRole("button", { name: "Permanently discard draft" })).toBeFocused();
    await expect(page.getByRole("button", { name: "Keep draft" })).toBeVisible();
    await page.getByRole("button", { name: "Permanently discard draft" }).click();
    await expect(page.getByRole("alert")).toBeFocused();
    await expect(page.locator(".terminal-recovery__choice")).toHaveCount(3);

    expect(captured).toHaveLength(4);
    expect(captured.map(({ recovery }) => recovery)).toEqual(["resume", "resume", "fork", "discard"]);
    for (const payload of captured) {
      expect(payload).toMatchObject({
        confirmed: true,
        link: expect.stringMatching(
          /^placekeeper:\/\/\/.*Protected%20Draft\.pdf#v=1&page=1$/u,
        ),
        recoveryOffer: {
          id: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/u),
          expiresAt: expect.any(String),
        },
        recoveryOperationId: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/u),
      });
    }
    expect(captured[1]!.recoveryOffer).toEqual(captured[0]!.recoveryOffer);
    expect(captured[2]!.recoveryOffer).toEqual(captured[0]!.recoveryOffer);
    expect(captured[3]!.recoveryOffer).toEqual(captured[0]!.recoveryOffer);
    expect(captured[1]!.recoveryOperationId).toBe(captured[0]!.recoveryOperationId);
    expect(captured[2]!.recoveryOperationId).not.toBe(captured[0]!.recoveryOperationId);
    expect(captured[3]!.recoveryOperationId).not.toBe(captured[0]!.recoveryOperationId);

    await page.unroute(reopenRoute);
    let actualResult: { ok: true; url: string } | undefined;
    let rejectedStaleOffer = false;
    await page.route(reopenRoute, async (route) => {
      if (!rejectedStaleOffer) {
        rejectedStaleOffer = true;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { kind: "recovery-offer-unavailable" },
          }),
        });
        return;
      }
      const response = await route.fetch();
      const json = await response.json() as { ok: true; url?: string };
      if (typeof json.url === "string") actualResult = { ok: true, url: json.url };
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Resume draft" }).click();
    await expect(page.getByRole("alert")).toContainText("no longer current");
    await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
    await expect(page.locator(".terminal-recovery__choice")).toHaveCount(0);
    await page.getByRole("button", { name: "Reopen" }).click();
    await expect(page.getByRole("button", { name: "Resume draft" })).toBeFocused();
    await page.getByRole("button", { name: "Resume draft" }).click();
    await expect(page.locator("#root")).toHaveAttribute("data-production-root", "true");
    expect(actualResult).toBeDefined();
    const resumedSessionId = /^\/s\/([^/]+)\/bootstrap$/u
      .exec(new URL(actualResult!.url).pathname)?.[1];
    expect(resumedSessionId).toBeDefined();
    expect(successor.broker.state(resumedSessionId!)).toMatchObject({
      revision: 1,
      items: [{ payload: { comment: "Keep this draft note" } }],
    });
  } finally {
    await first?.close();
    await successor?.close();
    await rm(recoveryRoot, { recursive: true, force: true });
  }
});

test("terminal recovery contains narrow and short touch viewports without undersized actions", async ({ browser }) => {
  const geometryRoot = await mkdtemp(join(tmpdir(), "placekeeper-recovery-geometry-"));
  const geometryHost = await PlacekeeperHost.start({
    recoveryRoot: join(geometryRoot, "recovery"),
    webAssets: { root: resolve("dist/web") },
    port: 0,
  });
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 320, height: 568 },
  });
  const page = await context.newPage();
  try {
    await page.goto(
      `${geometryHost.server.origin}/r/${randomUUID()}/private/tmp/Narrow%20Paper.pdf#v=1&page=1`,
    );
    await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const narrow = await page.evaluate(() => ({
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      recovery: document.querySelector<HTMLElement>("[data-terminal-recovery]")!.getBoundingClientRect().toJSON(),
      copy: document.querySelector<HTMLElement>(".terminal-recovery__copy-actions > button")!
        .getBoundingClientRect().toJSON(),
      reopen: document.querySelector<HTMLElement>(".terminal-recovery__primary-actions > button")!
        .getBoundingClientRect().toJSON(),
      controls: [...document.querySelectorAll<HTMLElement>("button")]
        .map((control) => control.getBoundingClientRect().toJSON()),
    }));
    expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.innerWidth);
    expect(narrow.recovery.left).toBeGreaterThanOrEqual(0);
    expect(narrow.recovery.right).toBeLessThanOrEqual(narrow.innerWidth);
    expect(narrow.copy.right).toBeLessThan(narrow.reopen.left);
    expect(Math.abs(narrow.copy.top - narrow.reopen.top)).toBeLessThanOrEqual(1);
    expect(narrow.controls.length).toBeGreaterThanOrEqual(2);
    for (const control of narrow.controls) expect(control.height).toBeGreaterThanOrEqual(44);

    await page.setViewportSize({ width: 800, height: 320 });
    const short = await page.evaluate(() => ({
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      recovery: document.querySelector<HTMLElement>("[data-terminal-recovery]")!.getBoundingClientRect().toJSON(),
      copy: document.querySelector<HTMLElement>(".terminal-recovery__copy-actions > button")!
        .getBoundingClientRect().toJSON(),
      reopen: document.querySelector<HTMLElement>(".terminal-recovery__primary-actions > button")!
        .getBoundingClientRect().toJSON(),
      controls: [...document.querySelectorAll<HTMLElement>("button")]
        .map((control) => control.getBoundingClientRect().toJSON()),
    }));
    expect(short.scrollWidth).toBeLessThanOrEqual(short.innerWidth);
    expect(short.recovery.width).toBeLessThan(short.innerWidth);
    expect(short.recovery.left).toBeGreaterThan(0);
    expect(short.recovery.right).toBeLessThan(short.innerWidth);
    expect(short.copy.right).toBeLessThan(short.reopen.left);
    expect(Math.abs(short.copy.top - short.reopen.top)).toBeLessThanOrEqual(1);
    for (const control of short.controls) {
      expect(control.left).toBeGreaterThanOrEqual(0);
      expect(control.right).toBeLessThanOrEqual(short.innerWidth);
    }
    await page.getByRole("button", { name: "Reopen" }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Copy Link" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Copy Link" })).toBeVisible();
  } finally {
    await context.close();
    await geometryHost.close();
    await rm(geometryRoot, { recursive: true, force: true });
  }
});
