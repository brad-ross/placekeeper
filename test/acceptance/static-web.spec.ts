import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { inspectPdfAnnotationCatalogWithEmbedPdf } from "../../packages/pdf-backends/src/embedpdf-adapter.js";
import { addStaticKeyboardPageNote, waitForStaticPdf } from "../../scripts/static-browser-journey.js";

const annotatedPdf = resolve("test/fixtures/pdfs/text-native-with-annotations.pdf");
const representativePdf = resolve("test/fixtures/pdfs/rotation-0-crop.pdf");

async function exportReviewedPdf(page: Page): Promise<string> {
  await page.getByRole("button", { name: /Open document actions$/u }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: /^(?:Retry export|Export)$/u }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (path === null) throw new Error("Browser download did not produce a file.");
  const result = page.locator("[data-export-result='success']");
  await expect(result).toContainText("browser was only asked to start the download");
  await expect(result).toContainText("other PDF content was not comprehensively checked");
  return path;
}

async function assertNoDurableBrowserState(page: Page): Promise<void> {
  expect(await page.evaluate(async () => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    caches: "caches" in globalThis ? await caches.keys() : [],
    databases: typeof indexedDB.databases === "function"
      ? (await indexedDB.databases()).map(({ name }) => name)
      : [],
    serviceWorkers: "serviceWorker" in navigator
      ? (await navigator.serviceWorker.getRegistrations()).map(({ scope }) => scope)
      : [],
  }))).toEqual({ local: [], session: [], caches: [], databases: [], serviceWorkers: [] });
}

async function assertBasicAccessibility(page: Page): Promise<void> {
  const audit = await page.evaluate(() => {
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    const unnamed = [...document.querySelectorAll<HTMLElement>("button, input, a[href]")]
      .filter(visible)
      .filter((element) => {
        const labelledBy = element.getAttribute("aria-labelledby");
        const label = element.getAttribute("aria-label")
          ?? element.getAttribute("title")
          ?? element.textContent
          ?? (element instanceof HTMLInputElement
            ? document.querySelector(`label[for='${CSS.escape(element.id)}']`)?.textContent
            : "");
        return labelledBy === null && label.trim() === "";
      });
    const seenIds = new Set<string>();
    const duplicateIds = [...document.querySelectorAll<HTMLElement>("[id]")]
      .map(({ id }) => id)
      .filter((id) => {
        if (seenIds.has(id)) return true;
        seenIds.add(id);
        return false;
      });
    return {
      unnamed: unnamed.map((element) => element.outerHTML.slice(0, 120)),
      duplicateIds,
      liveRegions: document.querySelectorAll("[aria-live], [role='status'], [role='alert']").length,
    };
  });
  expect(audit.unnamed).toEqual([]);
  expect(audit.duplicateIds).toEqual([]);
  expect(audit.liveRegions).toBeGreaterThan(0);
}

async function focusByTab(page: Page, target: Locator): Promise<void> {
  for (const key of ["Tab", "Alt+Tab"] as const) {
    for (let index = 0; index < 8; index += 1) {
      if (await target.evaluate((element) => element === document.activeElement)) return;
      await page.keyboard.press(key);
    }
  }
  await expect(target).toBeFocused();
}

test("@critical @representative keeps the local keyboard journey private and round-trips an editable item", async ({ browser, page }) => {
  const requests: { method: string; url: string }[] = [];
  page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));

  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Try Placekeeper on one PDF" })).toBeVisible();
  await expect(page.getByLabel("Privacy and saving limits")).toContainText("Non-confidential, export-only beta");
  await expect(page.getByLabel("Privacy and saving limits")).toContainText("no autosave or reload recovery");
  await focusByTab(page, page.getByRole("button", { name: "Choose a PDF" }));

  await page.locator("input[type=file]").setInputFiles(annotatedPdf);
  await waitForStaticPdf(page);
  await addStaticKeyboardPageNote(page, "Static export proof.");
  await assertBasicAccessibility(page);
  await assertNoDurableBrowserState(page);

  expect(await page.evaluate(() => !globalThis.dispatchEvent(
    new Event("beforeunload", { cancelable: true }),
  ))).toBe(true);
  await page.evaluate(() => globalThis.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect(page.locator("[data-production-review]")).toBeVisible();

  const firstDownload = await exportReviewedPdf(page);
  const firstCatalog = await inspectPdfAnnotationCatalogWithEmbedPdf(new Uint8Array(await readFile(firstDownload)));
  expect(firstCatalog.annotations).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "existing-highlight", contents: "Existing supported highlight" }),
    expect.objectContaining({ id: "existing-stamp", contents: "Existing unsupported stamp" }),
    expect.objectContaining({ contents: "Static export proof.", hasNormalAppearance: true }),
  ]));
  expect(firstCatalog.portableItems).toEqual([
    expect.objectContaining({ kind: "pageNote", payload: expect.objectContaining({ comment: "Static export proof." }) }),
  ]);

  const reopened = await browser.newPage({ viewport: { width: 760, height: 900 } });
  await reopened.emulateMedia({ reducedMotion: "reduce" });
  await reopened.goto(page.url());
  await reopened.locator("input[type=file]").setInputFiles(firstDownload);
  await waitForStaticPdf(reopened);
  await expect(reopened.locator("[data-owned-mark='pageNote']")).toHaveCount(1);
  await expect(reopened.locator("[data-existing-annotation='existing-highlight']")).toHaveCount(1);
  await expect(reopened.locator("[data-existing-annotation='existing-stamp']")).toHaveCount(1);
  await expect(reopened.locator("[data-review-item]", { hasText: "Static export proof." })).toHaveCount(1);
  await expect(reopened.getByRole("button", { name: /Open document actions$/u })).toBeVisible();
  const secondDownload = await exportReviewedPdf(reopened);
  const secondCatalog = await inspectPdfAnnotationCatalogWithEmbedPdf(new Uint8Array(await readFile(secondDownload)));
  expect(secondCatalog.portableItems).toHaveLength(1);
  const portableId = secondCatalog.portableItems[0]?.id;
  expect(portableId).toBe(firstCatalog.portableItems[0]?.id);
  expect(secondCatalog.annotations.filter(({ id }) => id === portableId)).toHaveLength(1);
  expect(secondCatalog.annotations.map(({ id }) => id)).toEqual(expect.arrayContaining(["existing-highlight", "existing-stamp"]));
  await assertNoDurableBrowserState(reopened);
  await reopened.close();

  const sameOriginRequests = requests.filter(({ url }) => url.startsWith(new URL(page.url()).origin));
  expect(requests.filter(({ method }) => !["GET", "HEAD"].includes(method))).toEqual([]);
  expect(sameOriginRequests.some(({ url }) => /(?:\/api\/|\/sessions?\/|\/tasks?\/)/u.test(url))).toBe(false);

  await page.evaluate(() => globalThis.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
  await expect(page.locator("[data-production-review]")).toHaveCount(0);
});

test("@representative creates a selection-derived highlight on a cropped PDF with a foreign annotation", async ({ page }) => {
  await page.goto("./");
  await page.locator("input[type=file]").setInputFiles(representativePdf);
  await waitForStaticPdf(page);
  const pdfPage = page.locator("[data-page-index='0']").first();
  const box = await pdfPage.boundingBox();
  if (box === null) throw new Error("Rendered cropped page has no bounds.");
  const actions = page.getByRole("toolbar", { name: "Selection review actions" });
  const scale = box.width / 540;
  const start = { x: (72 - 36) * scale + 6, y: (756 - 695) * scale };
  const end = { x: Math.min((500 - 36) * scale, box.width - 40), y: (756 - 665) * scale };
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + end.x, box.y + end.y, { steps: 24 });
  await page.mouse.up();
  await expect(actions).toBeVisible();
  await actions.getByRole("button", { name: "Highlight", exact: true }).click();
  const composer = page.getByRole("region", { name: "Highlight Comment" });
  await composer.getByRole("textbox", { name: "Comment" }).fill("Representative multi-segment highlight.");
  await composer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-owned-mark='highlight']").first()).toBeVisible();
  const path = await exportReviewedPdf(page);
  const catalog = await inspectPdfAnnotationCatalogWithEmbedPdf(new Uint8Array(await readFile(path)));
  const item = catalog.portableItems.find(
    (candidate) => candidate.kind === "highlight"
      && candidate.payload.comment === "Representative multi-segment highlight.",
  );
  expect(item).toMatchObject({ kind: "highlight", payload: { comment: "Representative multi-segment highlight." } });
  if (item?.kind !== "highlight") throw new Error("Highlight did not reopen as an owned item.");
  expect(Array.isArray(item.payload.segmentRects) ? item.payload.segmentRects.length : 0).toBeGreaterThan(1);
  expect(catalog.annotations.map(({ id }) => id)).toEqual(expect.arrayContaining(["existing-highlight", "existing-stamp"]));
});

test("exhaustive profile rejects unsupported input, announces recovery, and restores launcher focus", async ({ page }) => {
  await page.goto("./");
  await page.locator("input[type=file]").setInputFiles({
    name: "not-a-pdf.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a PDF"),
  });
  await expect(page.getByRole("alert")).toContainText("does not look like a PDF");
  await expect(page.getByRole("button", { name: "Choose a PDF" })).toBeFocused();
  await expect(page.locator("[data-production-review]")).toHaveCount(0);
});
