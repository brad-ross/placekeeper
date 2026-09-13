import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const remotePdf = "https://pdf.example.invalid/papers/public-paper.pdf";
const sourceBytes = await readFile(resolve("test/fixtures/pdfs/text-native.pdf"));

test("exhaustive profile opens a controlled HTTPS+CORS PDF without credentials or URL persistence", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const appConsoleMessages: string[] = [];
  page.on("console", (message) => {
    if (message.location().url.startsWith(new URL(page.url()).origin)) {
      appConsoleMessages.push(message.text());
    }
  });
  let requestHeaders: Record<string, string> | undefined;
  await page.route(remotePdf, async (route, request) => {
    requestHeaders = await request.allHeaders();
    await route.fulfill({
      status: 200,
      contentType: "application/pdf",
      headers: {
        "access-control-allow-origin": new URL(page.url()).origin,
        "content-length": String(sourceBytes.byteLength),
      },
      body: sourceBytes,
    });
  });

  await page.goto("./");
  const uploadButton = page.getByRole("button", { name: "Upload PDF" });
  const openButton = page.getByRole("button", { name: "Open", exact: true });
  await expect(uploadButton.locator(".lucide-upload")).toHaveCount(1);
  await expect(openButton.locator(".lucide-link")).toHaveCount(1);
  expect(await page.locator(".static-launcher__card").evaluate((card) => (
    card.scrollWidth <= card.clientWidth
  ))).toBe(true);
  await page.getByLabel("Document URL").fill(remotePdf);
  await openButton.click();
  await expect(page.locator("[data-production-review]")).toHaveAttribute("data-launch-surface", "static");
  await expect(page.locator("[data-page-index='0'] > img").first()).toBeVisible();
  expect(requestHeaders?.cookie).toBeUndefined();
  expect(requestHeaders?.authorization).toBeUndefined();
  expect(requestHeaders?.referer).toBeUndefined();
  expect(page.url()).not.toContain("pdf.example.invalid");
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(remotePdf);
  expect(appConsoleMessages.join("\n")).not.toContain(remotePdf);
  expect(await page.evaluate(async () => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    databases: typeof indexedDB.databases === "function" ? await indexedDB.databases() : [],
  }))).toEqual({ local: [], session: [], databases: [] });
});

test("@representative redacts a failed remote URL and restores keyboard focus for retry", async ({ page }) => {
  const secret = "token-that-must-not-survive";
  const failingUrl = `https://pdf.example.invalid/private.pdf?access_token=${secret}`;
  const appConsoleMessages: string[] = [];
  page.on("console", (message) => {
    if (message.location().url.startsWith(new URL(page.url()).origin)) {
      appConsoleMessages.push(message.text());
    }
  });
  await page.route("https://pdf.example.invalid/**", (route) => route.abort("failed"));

  await page.goto("./");
  const input = page.getByLabel("Document URL");
  await input.fill(failingUrl);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/CORS|network request/u);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  expect(await page.evaluate(() => document.body.textContent)).not.toContain(secret);
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(secret);
  expect(appConsoleMessages.join("\n")).not.toContain(secret);
  expect(page.url()).not.toContain(secret);
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })))
    .toEqual({ local: {}, session: {} });
});

test("exhaustive profile rejects private targets and redirects before a secondary request", async ({ page }) => {
  let privateRequests = 0;
  await page.route("https://10.0.0.1/**", (route) => {
    privateRequests += 1;
    return route.abort();
  });
  await page.goto("./");
  const input = page.getByLabel("Document URL");
  await input.fill("https://10.0.0.1/private.pdf");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("public PDF URL");
  expect(privateRequests).toBe(0);

  await page.route("https://pdf.example.invalid/redirect.pdf", (route) => route.fulfill({
    status: 302,
    headers: { location: "https://10.0.0.1/redirected.pdf" },
  }));
  await input.fill("https://pdf.example.invalid/redirect.pdf");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/redirect|CORS|network request/u);
  expect(privateRequests).toBe(0);
});

test("exhaustive profile cancels a remote open without a late activation", async ({ page }) => {
  let releaseResponse: (() => void) | undefined;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route("https://pdf.example.invalid/slow.pdf", async (route) => {
    await responseGate;
    await route.fulfill({ status: 200, contentType: "application/pdf", body: sourceBytes }).catch(() => undefined);
  });

  await page.goto("./");
  const input = page.getByLabel("Document URL");
  await input.fill("https://pdf.example.invalid/slow.pdf");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Reading the document");
  await page.getByRole("button", { name: "Open", exact: true }).and(page.getByTitle("Cancel opening")).click();
  releaseResponse?.();
  await expect(input).toBeFocused();
  await expect(page.locator("[data-production-review]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Placekeeper", exact: true })).toBeVisible();
});
