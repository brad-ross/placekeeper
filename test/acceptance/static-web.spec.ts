import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { inspectPdfAnnotationCatalogWithEmbedPdf } from "../../packages/pdf-backends/src/embedpdf-adapter.js";
import { addStaticKeyboardPageNote, waitForStaticPdf } from "../../scripts/static-browser-journey.js";

const annotatedPdf = resolve("test/fixtures/pdfs/text-native-with-annotations.pdf");
const representativePdf = resolve("test/fixtures/pdfs/rotation-0-crop.pdf");

async function exportReviewedPdf(page: Page): Promise<string> {
  await page.getByRole("button", { name: /Open document actions$/u }).click();
  const failure = page.locator("[data-export-result='failure']");
  const downloadPromise = Promise.race([
    page.waitForEvent("download"),
    failure.waitFor({ state: "visible" }).then(async () => {
      throw new Error((await failure.textContent()) ?? "PDF export failed.");
    }),
  ]);
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

async function openAnnotationsWorkspace(page: Page): Promise<void> {
  const presentation = (page.viewportSize()?.width ?? 1280) < 900 ? "bottom" : "right";
  await expect(page.locator("[data-review-stage]")).toHaveAttribute(
    "data-workspace-presentation",
    presentation,
  );
  const workspace = presentation === "bottom"
    ? page.getByRole("button", { name: /^(?:Open|Close) References tray$/u })
    : page.getByRole("button", { name: /^(?:Open|Close) right workspace$/u });
  if (await workspace.getAttribute("aria-expanded") !== "true") await workspace.click();
  await expect(workspace).toHaveAttribute("aria-expanded", "true");
  const annotations = page.getByRole("tab", { name: "Annotations", exact: true });
  if (await annotations.getAttribute("aria-selected") !== "true") await annotations.click();
  await expect(annotations).toHaveAttribute("aria-selected", "true");
}

async function dragPdfCoordinates(
  page: Page,
  pdfPage: Locator,
  start: { x: number; y: number },
  end: { x: number; y: number },
): Promise<void> {
  const box = await pdfPage.boundingBox();
  if (box === null) throw new Error("Rendered PDF page has no bounds.");
  const scale = box.width / 612;
  await page.mouse.move(box.x + start.x * scale, box.y + start.y * scale);
  await page.mouse.down();
  await page.mouse.move(box.x + end.x * scale, box.y + end.y * scale, { steps: 12 });
  await page.mouse.up();
}

async function placePdfInsertionCaret(
  page: Page,
  pdfPage: Locator,
  position: { x: number; y: number },
): Promise<void> {
  const box = await pdfPage.boundingBox();
  if (box === null) throw new Error("Rendered PDF page has no bounds.");
  const scale = box.width / 612;
  const start = { x: box.x + position.x * scale, y: box.y + position.y * scale };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Keep the browser-space movement inside one glyph even when the viewer is
  // zoomed. PDF-coordinate deltas would scale into a real text selection.
  await page.mouse.move(start.x + 3, start.y);
  await page.mouse.up();
}

test("@critical @representative keeps the local keyboard journey private and round-trips an editable item", async ({ browser, page }) => {
  const requests: { method: string; url: string }[] = [];
  page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));

  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Placekeeper" })).toBeVisible();
  await expect(page.getByText("Annotations must be exported manually in this browser version")).toBeVisible();
  await focusByTab(page, page.getByRole("button", { name: "Upload PDF" }));

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

test("@representative creates a selection-derived highlight on a cropped PDF with a foreign annotation", async ({ browser, page }) => {
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

  const reopenedContext = await browser.newContext({ viewport: { width: 760, height: 900 } });
  const reopened = await reopenedContext.newPage();
  await reopened.emulateMedia({ reducedMotion: "reduce" });
  await reopened.goto(page.url());
  await reopened.locator("input[type=file]").setInputFiles(path);
  await waitForStaticPdf(reopened);
  await expect(reopened.locator("[data-owned-mark='highlight']").first()).toBeVisible();
  await openAnnotationsWorkspace(reopened);
  const editHighlight = reopened.getByRole("button", { name: "Edit Highlight annotation on page 1" });
  await expect(editHighlight).toBeVisible();
  await editHighlight.click();
  const editor = reopened.getByRole("region", { name: "Edit Highlight" });
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(reopened.locator("[data-review-item]", { hasText: "Representative multi-segment highlight." })).toHaveCount(1);
  await expect(reopened.locator("[data-existing-annotation='existing-highlight']")).toHaveCount(1);
  await expect(reopened.locator("[data-existing-annotation='existing-stamp']")).toHaveCount(1);
  await reopenedContext.close();
});

test("exhaustive profile exports and reopens all five editable annotation kinds", async ({
  browser,
  browserName,
  page,
}) => {
  test.skip(browserName !== "chromium", "The all-kinds release journey is Chromium exhaustive coverage.");
  await page.goto("./");
  await page.locator("input[type=file]").setInputFiles(annotatedPdf);
  await waitForStaticPdf(page);
  const pdfPage = page.locator("[data-page-index='0']").first();
  const actions = page.getByRole("toolbar", { name: "Selection review actions" });

  await dragPdfCoordinates(page, pdfPage, { x: 252, y: 99 }, { x: 405, y: 99 });
  await expect(actions).toBeVisible();
  await actions.getByRole("button", { name: "Replace", exact: true }).click();
  const replacement = page.getByRole("region", { name: "Replacement" });
  await replacement.getByRole("textbox", { name: "Replacement" }).fill("a stable replacement");
  await replacement.getByRole("button", { name: "Apply", exact: true }).click();

  await dragPdfCoordinates(page, pdfPage, { x: 72, y: 129 }, { x: 172, y: 129 });
  await expect(actions).toBeVisible();
  await actions.getByRole("button", { name: "Delete", exact: true }).click();

  await dragPdfCoordinates(page, pdfPage, { x: 190, y: 129 }, { x: 450, y: 129 });
  await expect(actions).toBeVisible();
  await actions.getByRole("button", { name: "Highlight", exact: true }).click();
  const highlight = page.getByRole("region", { name: "Highlight Comment" });
  await highlight.getByRole("textbox", { name: "Comment" }).fill("All-kinds highlight.");
  await highlight.getByRole("button", { name: "Save", exact: true }).click();

  await placePdfInsertionCaret(page, pdfPage, { x: 150, y: 99 });
  await expect(page.locator("[data-review-insertion-caret]")).toBeVisible();
  await page.keyboard.type("I");
  const insertion = page.getByRole("region", { name: "Insertion" });
  await insertion.getByRole("textbox", { name: "Insertion" }).fill("inserted text");
  await insertion.getByRole("button", { name: "Apply", exact: true }).click();

  await pdfPage.focus();
  await page.keyboard.press("Alt+Shift+N");
  const pageNoteCursor = page.getByRole("button", { name: /^Page Note placement cursor/u });
  await pageNoteCursor.focus();
  await pageNoteCursor.press("Enter");
  const pageNote = page.getByRole("region", { name: "Page Note" });
  await pageNote.getByRole("textbox", { name: "Comment" }).fill("All-kinds page note.");
  await pageNote.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-review-item]")).toHaveCount(5);

  const path = await exportReviewedPdf(page);
  const catalog = await inspectPdfAnnotationCatalogWithEmbedPdf(new Uint8Array(await readFile(path)));
  expect(catalog.portableItems.map(({ kind }) => kind).sort()).toEqual([
    "delete",
    "highlight",
    "insert",
    "pageNote",
    "replace",
  ]);
  expect(catalog.annotations.map(({ id }) => id)).toEqual(expect.arrayContaining(["existing-highlight", "existing-stamp"]));

  const reopenedContext = await browser.newContext({ viewport: { width: 760, height: 900 } });
  const reopened = await reopenedContext.newPage();
  await reopened.emulateMedia({ reducedMotion: "reduce" });
  await reopened.goto(page.url());
  await reopened.locator("input[type=file]").setInputFiles(path);
  await waitForStaticPdf(reopened);
  await expect(reopened.locator("[data-review-item]")).toHaveCount(5);
  for (const kind of ["replace", "delete", "insert", "highlight", "pageNote"] as const) {
    await expect(reopened.locator(`[data-owned-mark='${kind}']`).first()).toBeVisible();
  }
  await expect(reopened.locator("[data-existing-annotation='existing-highlight']")).toHaveCount(1);
  await expect(reopened.locator("[data-existing-annotation='existing-stamp']")).toHaveCount(1);
  await reopenedContext.close();
});

test("exhaustive profile rejects unsupported input, announces recovery, and restores launcher focus", async ({ page }) => {
  await page.goto("./");
  await page.locator("input[type=file]").setInputFiles({
    name: "not-a-pdf.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a PDF"),
  });
  await expect(page.getByRole("alert")).toContainText("does not look like a PDF");
  await expect(page.getByRole("button", { name: "Upload PDF" })).toBeFocused();
  await expect(page.locator("[data-production-review]")).toHaveCount(0);
});

test('export menu fits its action and export-only chrome omits a save-status dot', async ({ page }) => {
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles(annotatedPdf);
  await waitForStaticPdf(page);
  await expect(page.locator('.review-chrome__save-dot')).toHaveCount(0);
  await page.getByRole('button', { name: /Open document actions$/u }).click();
  const menu = page.locator('.document-actions__menu');
  await expect(menu).toBeVisible();
  const bounds = (await menu.boundingBox())!;
  expect(bounds.width).toBeLessThan(160);
  await expect(page.getByRole('menuitem', { name: 'Export', exact: true })).toBeVisible();
});

test('URL opening uses an in-button spinner and reports failure in a corner toast', async ({ page }) => {
  let finishRequest!: () => void;
  const pending = new Promise<void>((resolve) => { finishRequest = resolve; });
  await page.route('https://example.org/paper.pdf', async (route) => {
    await pending;
    await route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'Not found' });
  });
  await page.goto('./');
  const card = page.locator('.static-launcher__card');
  const before = (await card.boundingBox())!;
  await page.getByRole('textbox', { name: 'PDF URL' }).fill('https://example.org/paper.pdf');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.static-launcher__url button .static-launcher__spinner')).toBeVisible();
  await expect(page.locator('.static-launcher__progress')).toHaveCount(0);
  expect((await card.boundingBox())!.height).toBe(before.height);
  finishRequest();
  const toast = page.locator('.static-launcher__toasts [role="alert"]');
  await expect(toast).toBeVisible();
  expect((await toast.boundingBox())!.y).toBeLessThan(40);
  await expect(card.locator('[role="alert"]')).toHaveCount(0);
  await expect(page.locator('.static-launcher__spinner')).toHaveCount(0);
});
