import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFString, decodePDFRawStream, degrees } from 'pdf-lib';
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { inspectPdfAnnotationCatalogWithEmbedPdf } from "../../packages/pdf-backends/src/embedpdf-adapter.js";
import { addStaticKeyboardPageNote, waitForStaticPdf } from "../../scripts/static-browser-journey.js";

const annotatedPdf = resolve("test/fixtures/pdfs/text-native-with-annotations.pdf");
const representativePdf = resolve("test/fixtures/pdfs/rotation-0-crop.pdf");

async function exportReviewedPdf(page: Page, options: {
  readonly annotationName?: string;
  readonly expectedName?: string;
} = {}): Promise<string> {
  if (!await page.getByRole("menuitem", { name: /^(?:Retry export|Export)$/u }).isVisible()) {
    await page.getByRole("button", { name: /Open document actions$/u }).click();
  }
  await page.getByRole("menuitem", { name: /^(?:Retry export|Export)$/u }).click();
  const dialog = page.getByRole('dialog', { name: 'Export reviewed PDF', exact: true });
  const name = dialog.getByRole('textbox', { name: 'Name on annotations', exact: true });
  await expect(name).toBeFocused();
  if (options.expectedName !== undefined) await expect(name).toHaveValue(options.expectedName);
  if (options.annotationName !== undefined) await name.fill(options.annotationName);
  const failure = page.locator("[data-export-result='failure'], [data-export-annotation-backdrop] [role='alert']");
  const downloadPromise = Promise.race([
    page.waitForEvent("download"),
    failure.waitFor({ state: "visible" }).then(async () => {
      throw new Error((await failure.textContent()) ?? "PDF export failed.");
    }),
  ]);
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
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
  const workspace = page.locator(presentation === "bottom" ? "#review-workspace" : "#review-tools-workspace");
  const openAttribute = presentation === "bottom" ? "data-workspace-open" : "data-tools-workspace-open";
  if (await workspace.getAttribute(openAttribute) !== "true") {
    await page.getByRole("button", { name: "Show workspace", exact: true }).click();
  }
  await expect(workspace).toHaveAttribute(openAttribute, "true");
  await expect(workspace).toBeVisible();
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

async function stableBoundingBox(
  locator: Locator,
): Promise<NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>> {
  let previous: Awaited<ReturnType<Locator['boundingBox']>> = null;
  let current: Awaited<ReturnType<Locator['boundingBox']>> = null;
  let stableSamples = 0;
  await expect.poll(async () => {
    current = await locator.boundingBox();
    if (current === null || previous === null) {
      stableSamples = 0;
    } else {
      const unchanged = (['x', 'y', 'width', 'height'] as const)
        .every((field) => Math.abs(current![field] - previous![field]) < 0.25);
      stableSamples = unchanged ? stableSamples + 1 : 0;
    }
    previous = current;
    return stableSamples;
  }).toBeGreaterThanOrEqual(3);
  if (current === null) throw new Error('Rendered PDF page has no stable bounds.');
  return current;
}

test("@critical @representative keeps the local keyboard journey private and round-trips an editable item", async ({ browser, page }) => {
  const requests: { method: string; url: string }[] = [];
  page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));

  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Placekeeper", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Try it with your own document", exact: true })).toBeVisible();
  await focusByTab(page, page.getByRole("button", { name: "Upload PDF" }));

  const sourceDocument = await PDFDocument.load(await readFile(annotatedPdf));
  const importedAnnotations = sourceDocument.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
  for (let index = 0; index < importedAnnotations.size(); index += 1) {
    importedAnnotations.lookup(index, PDFDict).set(PDFName.of('T'), PDFString.of(`Original reviewer ${index + 1}`));
  }
  const sourceBytes = await sourceDocument.save();
  await page.locator("input[type=file]").setInputFiles({
    name: 'reviewer-authors.pdf', mimeType: 'application/pdf', buffer: Buffer.from(sourceBytes),
  });
  await waitForStaticPdf(page);
  await addStaticKeyboardPageNote(page, "Static export proof.");
  await assertBasicAccessibility(page);
  await assertNoDurableBrowserState(page);

  expect(await page.evaluate(() => !globalThis.dispatchEvent(
    new Event("beforeunload", { cancelable: true }),
  ))).toBe(true);
  await page.evaluate(() => globalThis.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect(page.locator("[data-production-review]")).toBeVisible();

  let downloads = 0;
  page.on('download', () => { downloads += 1; });
  await page.getByRole('button', { name: /Open document actions$/u }).click();
  await page.getByRole('menuitem', { name: 'Export', exact: true }).click();
  const cancelledDialog = page.getByRole('dialog', { name: 'Export reviewed PDF', exact: true });
  const draftName = cancelledDialog.getByRole('textbox', { name: 'Name on annotations', exact: true });
  await expect(draftName).toHaveValue('Placekeeper');
  await draftName.fill('Cancelled annotation name');
  await draftName.press('Escape');
  await expect(cancelledDialog).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Export', exact: true })).toHaveAttribute('aria-disabled', 'false');
  await expect(page.locator("[data-export-result='success']")).toHaveCount(0);
  expect(downloads).toBe(0);
  await assertNoDurableBrowserState(page);

  const sourceCatalog = await inspectPdfAnnotationCatalogWithEmbedPdf(sourceBytes);
  expect(sourceCatalog.annotations.map(({ author }) => author)).toEqual([
    'Original reviewer 1', 'Original reviewer 2',
  ]);
  const firstDownload = await exportReviewedPdf(page, { expectedName: 'Placekeeper', annotationName: '  Brad Ross  ' });
  expect(downloads).toBe(1);
  const firstCatalog = await inspectPdfAnnotationCatalogWithEmbedPdf(new Uint8Array(await readFile(firstDownload)));
  expect(firstCatalog.annotations).toEqual(expect.arrayContaining([
    expect.objectContaining({ subtype: "highlight", contents: "Existing supported highlight" }),
    expect.objectContaining({ subtype: "stamp", contents: "Existing unsupported stamp" }),
    expect.objectContaining({ contents: "Static export proof.", author: "Brad Ross", hasNormalAppearance: true }),
  ]));
  const nativeSemantics = (catalog: typeof sourceCatalog) => catalog.nativeAnnotations?.map(({ item }) => {
    const { id: _id, payload, ...semanticItem } = item;
    const { identityProvenance: _identityProvenance, ...semanticPayload } = payload;
    return { ...semanticItem, payload: semanticPayload };
  });
  expect(nativeSemantics(firstCatalog)).toEqual(nativeSemantics(sourceCatalog));
  expect(firstCatalog.nativeAnnotations?.map(({ item }) => item.payload.identityProvenance))
    .toEqual(['verified', 'verified']);
  for (const original of sourceCatalog.annotations) {
    expect(firstCatalog.annotations.find(({ contents }) => contents === original.contents)?.author).toBe(original.author);
  }
  expect(firstCatalog.portableItems).toEqual([
    expect.objectContaining({ kind: "pageNote", payload: expect.objectContaining({ comment: "Static export proof." }) }),
  ]);

  const reopened = await browser.newPage({ viewport: { width: 760, height: 900 } });
  await reopened.emulateMedia({ reducedMotion: "reduce" });
  await reopened.goto(page.url());
  await reopened.locator("input[type=file]").setInputFiles(firstDownload);
  await waitForStaticPdf(reopened);
  await expect(reopened.locator("[data-owned-mark='pageNote']")).toHaveCount(1);
  await expect(reopened.locator("[data-review-item]", { hasText: "Existing supported highlight" })).toHaveCount(1);
  await expect(reopened.locator("[data-review-item]", { hasText: "Existing unsupported stamp" })).toHaveCount(1);
  await expect(reopened.locator("[data-review-item]", { hasText: "Static export proof." })).toHaveCount(1);
  await expect(reopened.getByRole("button", { name: /Open document actions$/u })).toBeVisible();
  const secondDownload = await exportReviewedPdf(reopened, { expectedName: 'Brad Ross' });
  const secondCatalog = await inspectPdfAnnotationCatalogWithEmbedPdf(new Uint8Array(await readFile(secondDownload)));
  expect(secondCatalog.portableItems).toHaveLength(1);
  expect(secondCatalog.annotations.find(({ contents }) => contents === 'Static export proof.')?.author).toBe('Brad Ross');
  const portableId = secondCatalog.portableItems[0]?.id;
  expect(portableId).toBe(firstCatalog.portableItems[0]?.id);
  expect(secondCatalog.annotations.filter(({ id }) => id === portableId)).toHaveLength(1);
  expect(firstCatalog.nativeAnnotations).toHaveLength(2);
  expect(secondCatalog.nativeAnnotations).toEqual(firstCatalog.nativeAnnotations);
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
  expect(catalog.annotations).toEqual(expect.arrayContaining([
    expect.objectContaining({ subtype: "highlight", contents: "Existing supported highlight" }),
    expect.objectContaining({ subtype: "stamp", contents: "Existing unsupported stamp" }),
  ]));

  const reopenedContext = await browser.newContext({ viewport: { width: 760, height: 900 } });
  const reopened = await reopenedContext.newPage();
  await reopened.emulateMedia({ reducedMotion: "reduce" });
  await reopened.goto(page.url());
  await reopened.locator("input[type=file]").setInputFiles(path);
  await waitForStaticPdf(reopened);
  await expect(reopened.locator("[data-owned-mark='highlight']").first()).toBeVisible();
  await openAnnotationsWorkspace(reopened);
  const highlightRow = reopened.locator(`[data-review-item="${item.id}"]`);
  await highlightRow.hover();
  const editHighlight = highlightRow.getByRole("button", { name: "Edit Highlight annotation on page 1", exact: true });
  await expect(editHighlight).toBeVisible();
  await editHighlight.click();
  const editor = reopened.getByRole("region", { name: "Edit Highlight" });
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(reopened.locator("[data-review-item]", { hasText: "Representative multi-segment highlight." })).toHaveCount(1);
  await expect(reopened.locator("[data-review-item]", { hasText: "Existing supported highlight" })).toHaveCount(1);
  await expect(reopened.locator("[data-review-item]", { hasText: "Existing unsupported stamp" })).toHaveCount(1);
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
  await expect(page.locator("[data-review-item]")).toHaveCount(2);
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

  // Use unmarked text: clicking the imported highlight selects that annotation.
  await placePdfInsertionCaret(page, pdfPage, { x: 235, y: 99 });
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
  await expect(page.locator("[data-review-item]")).toHaveCount(7);

  const path = await exportReviewedPdf(page);
  const catalog = await inspectPdfAnnotationCatalogWithEmbedPdf(new Uint8Array(await readFile(path)));
  expect(catalog.portableItems.map(({ kind }) => kind).sort()).toEqual([
    "delete",
    "highlight",
    "insert",
    "pageNote",
    "replace",
  ]);
  expect((catalog.nativeAnnotations ?? []).map(({ item }) => item.payload.comment).sort()).toEqual([
    "Existing supported highlight",
    "Existing unsupported stamp",
  ]);

  const reopenedContext = await browser.newContext({ viewport: { width: 760, height: 900 } });
  const reopened = await reopenedContext.newPage();
  await reopened.emulateMedia({ reducedMotion: "reduce" });
  await reopened.goto(page.url());
  await reopened.locator("input[type=file]").setInputFiles(path);
  await waitForStaticPdf(reopened);
  await expect(reopened.locator("[data-review-item]")).toHaveCount(7);
  for (const kind of ["replace", "delete", "insert", "highlight", "pageNote"] as const) {
    await expect(reopened.locator(`[data-owned-mark='${kind}']`).first()).toBeVisible();
  }
  await expect(reopened.locator("[data-review-item]").filter({ hasText: "Existing supported highlight" })).toHaveCount(1);
  await expect(reopened.locator("[data-review-item]").filter({ hasText: "Existing unsupported stamp" })).toHaveCount(1);
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
  await page.getByRole('textbox', { name: 'Document URL' }).fill('https://example.org/paper.pdf');
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


for (const rotation of [0, 90]) test(`imported annotations use reader defaults and preserve explicit PDF styling (${rotation} degrees)`, async ({ page }) => {
  const pdf = await PDFDocument.load(await readFile(resolve('test/fixtures/pdfs/text-native.pdf')));
  const target = pdf.getPage(0);
  target.setRotation(degrees(rotation));
  if (rotation) target.setCropBox(20, 30, 560, 730);
  const appearance = pdf.context.register(pdf.context.stream('0 0 1 rg 0 0 100 18 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 18], Resources: {},
  }));
  const entries = [
    { Subtype: 'Highlight' },
    { Subtype: 'StrikeOut' },
    { Subtype: 'Underline' },
    { Subtype: 'Squiggly' },
    { Subtype: 'Caret' },
    { Subtype: 'Text' },
    { Subtype: 'Highlight', C: [0, 1, 0], CA: 0.65 },
    { Subtype: 'Highlight', AP: { N: appearance }, C: [0, 0, 1], CA: 0.8 },
  ];
  target.node.set(PDFName.of('Annots'), pdf.context.obj(entries.map((entry, index) => {
    const y = 650 - index * 30;
    return pdf.context.register(pdf.context.obj({ Type: 'Annot', Rect: [72, y, 172, y + 18],
      QuadPoints: [72, y + 18, 172, y + 18, 72, y, 172, y],
      Contents: PDFString.of(`Source comment ${index}`), ...entry }));
  })));
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles({ name: 'source-styles.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await waitForStaticPdf(page);
  await expect(page.locator('[data-review-item]')).toHaveCount(8);
  await expect(page.locator('[data-source-reader-mark]')).toHaveCount(7);
  for (const kind of ['highlight', 'delete', 'underline', 'squiggly', 'insert', 'pageNote']) {
    await expect(page.locator(`[data-source-reader-mark="${kind}"]`).first()).toBeVisible();
  }
  const highlights = page.locator('[data-source-reader-mark="highlight"]');
  const defaults = await highlights.first().evaluate((element) => ({
    fill: getComputedStyle(element).getPropertyValue('--pdf-comment-fill').trim(),
    ink: getComputedStyle(element).getPropertyValue('--pdf-note-ink').trim(),
  }));
  expect(defaults).toEqual({ fill: 'rgb(245 196 35 / 25%)', ink: '#b1840d' });
  await expect(highlights.nth(1)).toHaveCSS('opacity', '0.65');
  expect(await highlights.nth(1).evaluate((element) => getComputedStyle(element).getPropertyValue('--pdf-note-ink').trim().toLowerCase())).toBe('#00ff00');
  await page.screenshot({ path: `tmp/source-annotation-styles-desktop-${rotation}.png`, fullPage: true });
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(highlights.first()).toBeVisible();
  await page.screenshot({ path: `tmp/source-annotation-styles-narrow-${rotation}.png`, fullPage: true });
  const exportedPath = await exportReviewedPdf(page);
  const exported = await PDFDocument.load(await readFile(exportedPath));
  const reopened = exported.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
  expect(reopened.size()).toBe(8);
  expect(reopened.lookup(0, PDFDict).has(PDFName.of('C'))).toBe(false);
  expect(reopened.lookup(0, PDFDict).has(PDFName.of('CA'))).toBe(false);
  expect(reopened.lookup(0, PDFDict).has(PDFName.of('AP'))).toBe(false);
  expect(reopened.lookup(6, PDFDict).lookup(PDFName.of('C'), PDFArray).asArray().map((value) => (value as PDFNumber).asNumber())).toEqual([0, 1, 0]);
  expect(reopened.lookup(6, PDFDict).lookup(PDFName.of('CA'), PDFNumber).asNumber()).toBeCloseTo(0.65, 6);
  const stream = reopened.lookup(7, PDFDict).lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
  expect(new TextDecoder().decode(decodePDFRawStream(stream).decode())).toBe('0 0 1 rg 0 0 100 18 re f');
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles(exportedPath);
  await waitForStaticPdf(page);
  await expect(page.locator('[data-source-reader-mark]')).toHaveCount(7);
});

for (const width of [390, 1280]) test(`@critical landing showcase and PDF controls work at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Placekeeper', exact: true })).toBeVisible();
  const upload = page.getByRole('button', { name: 'Upload PDF', exact: true });
  await expect(upload).toBeVisible();
  if (width === 1280) expect((await upload.boundingBox())!.y).toBeLessThan(700);
  await expect(page.getByLabel('Document URL')).toBeVisible();
  const showcase = page.getByRole('tablist', { name: 'Explore features' });
  await expect(showcase.getByRole('tab', { name: 'Read with focus', exact: true })).toHaveAttribute('aria-selected', 'true');
  for (const label of ['Read with focus', 'Follow references', 'Make comments']) {
    const tab = showcase.getByRole('tab', { name: label, exact: true });
    await expect(tab).toBeVisible();
    await expect(tab.locator('svg')).toBeVisible();
    if (width === 390) {
      await expect(tab.getByText(label, { exact: true })).toBeHidden();
      await tab.hover();
      await expect(page.getByRole('tooltip', { name: label, exact: true })).toBeVisible();
      await page.mouse.move(0, 0);
      await expect(page.getByRole('tooltip')).toHaveCount(0);
    } else {
      await expect(tab.getByText(label, { exact: true })).toBeVisible();
    }
  }
  for (const name of ['Follow references', 'Make comments', 'Read with focus']) {
    const feature = showcase.getByRole('tab', { name, exact: true });
    await feature.focus();
    await page.keyboard.press('Enter');
    await expect(feature).toHaveAttribute('aria-selected', 'true');
    await expect(showcase.locator('[aria-selected="true"]')).toHaveCount(1);
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page.locator('iframe[aria-hidden="false"]')).toHaveAttribute('title', `${name} interactive demo`);
  }
  await page.locator('iframe[aria-hidden="false"]').scrollIntoViewIfNeeded();
  const demo = page.frameLocator('iframe[aria-hidden="false"]');
  await demo.locator('[data-initial-view-ready="true"]').waitFor({ state: 'attached' });
  await expect(demo.locator('[data-page-index="13"] > img').first()).toBeVisible();
  await expect(demo.locator('[data-owned-mark]')).toHaveCount(0);
  await demo.getByRole('button', { name: 'Show workspace', exact: true }).click();
  await expect(demo.getByRole('tab', { name: 'Outline', exact: true })).toBeEnabled();
  if (width === 1280) {
    expect(await demo.locator('body').evaluate(() => innerWidth)).toBe(1000);
    const frameBox = (await page.locator('iframe[aria-hidden="false"]').boundingBox())!;
    const tray = (await demo.getByRole('complementary', { name: 'Outline, search, and annotations', exact: true }).boundingBox())!;
    expect(tray.x).toBeGreaterThan(frameBox.x + frameBox.width / 2);
  }
  await expect(demo.getByRole('tab', { name: 'Search', exact: true })).toBeDisabled();
  await expect(demo.getByRole('tab', { name: 'Annotations', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /^Chrome/ }).click();
  await expect(page.getByRole('figure', { name: 'Chrome Extension (experimental) window screenshot' })).toBeVisible();
  await page.getByRole('link', { name: 'Try it', exact: true }).click();
  await expect(upload).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('@critical selecting the reference demo restores its sample only when references are empty', async ({ page }) => {
  await page.goto('./');
  const demo = page.frameLocator('iframe[aria-hidden="false"]');
  await demo.locator('[data-initial-view-ready="true"]').waitFor({ state: 'attached' });
  const features = page.getByRole('tablist', { name: 'Explore features' });
  const reference = features.getByRole('tab', { name: 'Follow a reference', exact: true });
  const appendix = demo.getByRole('tab', { name: 'Appendix A, Page 31', exact: true });
  await reference.click();
  await expect(appendix).toBeVisible();
  await reference.click();
  await expect(appendix).toHaveCount(1);
  for (const switchAway of [false, true]) {
    await demo.getByRole('button', { name: 'Close active reference', exact: true }).click();
    await expect(appendix).toHaveCount(0);
    if (switchAway) await features.getByRole('tab', { name: 'Read with focus', exact: true }).click();
    await reference.click();
    await expect(appendix).toBeVisible();
    await expect(demo.locator('[data-reference-pdf-viewport] [data-page-index="30"] > img').first()).toBeVisible();
  }
});

test('@critical landing demos support zoom, references, and isolated comments', async ({ page }) => {
  page.setDefaultTimeout(10_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./');
  const iframe = page.locator('iframe[aria-hidden="false"]');
  const demo = page.frameLocator('iframe[aria-hidden="false"]');
  await demo.locator('[data-initial-view-ready="true"]').waitFor({ state: 'attached' });
  const feature = (name: string) => page.getByRole('tablist', { name: 'Explore features' }).getByRole('tab', { name, exact: true });
  await iframe.scrollIntoViewIfNeeded();
  await expect(demo.locator('[data-page-index="13"] > img').first()).toBeVisible();
  const zoom = demo.getByRole('textbox', { name: /^Current zoom/ });
  await zoom.focus();
  await zoom.fill('200');
  await zoom.press('Enter');
  await expect(zoom).toHaveValue('200');
  await demo.getByRole('button', { name: 'Open zoom controls', exact: true }).focus();
  await page.keyboard.press('Enter');
  const lock = demo.getByRole('menuitemcheckbox', { name: 'Horizontal lock', exact: true });
  await expect(lock).toBeVisible();
  const checked = await lock.getAttribute('aria-checked');
  await lock.focus();
  await page.keyboard.press('Enter');
  await expect(lock).toHaveAttribute('aria-checked', checked === 'true' ? 'false' : 'true');
  await page.keyboard.press('Escape');

  await zoom.fill('100');
  await zoom.press('Enter');
  await feature('Follow references').click();
  await iframe.scrollIntoViewIfNeeded();
  await expect(demo.locator('[data-page-index="13"] > img').first()).toBeVisible();
  // Let the tray's opening animation and focus handoff settle before driving
  // the document directly with keyboard input.
  await demo.locator('body').evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
  await expect(demo.locator('[data-reference-pdf-viewport] [data-page-index="30"] > img').first()).toBeVisible();
  await expect(demo.getByRole('tab', { name: 'Appendix A, Page 31', exact: true })).toBeFocused();
  await expect(zoom).toHaveValue('100');
  await expect(demo.getByRole('textbox', { name: /^Current page/ })).toHaveValue('14');
  const pageInput = demo.getByRole('textbox', { name: /^Current page/ });
  await pageInput.fill('15');
  await pageInput.press('Enter');
  await expect(pageInput).toHaveValue('15');
  await demo.locator('[data-pdf-copy-surface="main"] [data-page-index="14"]').getByRole('button', { name: 'Open PDF link to Page 31', exact: true }).first().click();
  await demo.getByRole('menuitem', { name: 'Open in References', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(demo.getByText('Reference opened: Page 31.', { exact: true })).toBeAttached();
  const reference = demo.locator('[data-reference-pdf-viewport] [data-viewer-framing-viewport]');
  await expect(reference.locator('[data-page-index="30"] > img').first()).toBeVisible();
  const before = await reference.evaluate((element) => element.scrollTop);
  await expect(async () => {
    await reference.hover({ position: { x: 160, y: 100 } });
    await page.mouse.wheel(0, 220);
    expect(await reference.evaluate((element) => element.scrollTop)).not.toBe(before);
  }).toPass({ timeout: 5_000 });
  await expect(demo.getByRole('textbox', { name: /^Current page/ })).toHaveValue('15');
  await pageInput.fill('14');
  await pageInput.press('Enter');

  await feature('Make comments').click();
  await iframe.scrollIntoViewIfNeeded();
  await expect(demo.locator('[data-page-index="13"] > img').first()).toBeVisible();
  await expect(demo.getByRole('tab', { name: 'Annotations', exact: true })).toHaveAttribute('aria-selected', 'true');
  await demo.locator('body').evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
  // Four seeded annotations paint five segments (the deletion spans two lines).
  await expect(demo.locator('[data-owned-mark]')).toHaveCount(5);
  await demo.getByRole('button', { name: 'Edit Highlight annotation on page 14', exact: true }).click();
  const editor = demo.getByRole('textbox', { name: 'Comment (optional)', exact: true });
  await editor.fill('A comment in the landing demo.');
  await demo.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(demo.getByText('A comment in the landing demo.', { exact: true })).toBeVisible();
  const readerIdentity = await demo.locator('body').evaluate(() => performance.timeOrigin);
  await feature('Read with focus').click();
  await expect(demo.locator('[data-owned-mark]')).toHaveCount(0);
  await expect(demo.getByRole('textbox', { name: /^Current zoom/ })).toHaveValue('100');
  await feature('Make comments').click();
  await expect(demo.locator('[data-page-index="13"] > img').first()).toBeVisible();
  expect(await demo.locator('body').evaluate(() => performance.timeOrigin)).toBe(readerIdentity);
  await expect(demo.locator('[data-owned-mark]')).toHaveCount(5);
  await expect(demo.getByText('A comment in the landing demo.', { exact: true })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(representativePdf);
  await waitForStaticPdf(page);
  await expect(iframe).toHaveCount(0);
  await expect(page.locator('[data-owned-mark]')).toHaveCount(0);
});


test('@critical visitors can add demo annotations and hide them between modes', async ({ page }) => {
  await page.goto('./');
  const feature = (name: string) => page.getByRole('tablist', { name: 'Explore features' }).getByRole('tab', { name, exact: true });
  const demo = page.frameLocator('iframe');
  await demo.locator('[data-initial-view-ready="true"]').waitFor({ state: 'attached' });
  await feature('Make comments').click();
  await page.locator('iframe').scrollIntoViewIfNeeded();
  await expect(demo.locator('[data-owned-mark]')).toHaveCount(5);
  await demo.locator('body').evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
  await demo.locator('[data-page-index="13"]').first().focus();
  await page.keyboard.press('Alt+Shift+N');
  const cursor = demo.getByRole('button', { name: /^Page Note placement cursor/ });
  await cursor.focus();
  await page.keyboard.press('Enter');
  const comment = demo.getByRole('textbox', { name: 'Comment', exact: true });
  await comment.fill('My own annotation.');
  await demo.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(comment).toHaveCount(0);
  await expect(demo.locator('[data-owned-mark]')).toHaveCount(6);
  for (const name of ['Read with focus', 'Follow references']) {
    await feature(name).click();
    await expect(demo.locator('[data-owned-mark]')).toHaveCount(0);
    await expect(demo.locator('.annotation-peek')).toHaveCount(0);
  }
  await feature('Make comments').click();
  await expect(demo.locator('[data-owned-mark]')).toHaveCount(6);
  await expect(demo.getByText('My own annotation.', { exact: true })).toBeVisible();
});

test('@critical selecting demo text opens annotation actions after switching modes', async ({ page }) => {
  await page.setViewportSize({ width: 1324, height: 1100 });
  await page.goto('./');
  await page.locator('iframe').scrollIntoViewIfNeeded();
  const demo = page.frameLocator('iframe');
  await demo.locator('[data-initial-view-ready="true"]').waitFor({ state: 'attached' });
  const pdf = demo.locator('[data-page-index="13"] > img').first();
  await expect(pdf).toBeVisible();
  await page.getByRole('tab', { name: 'Make comments', exact: true }).click();
  await expect(demo.locator('[data-owned-mark]')).toHaveCount(5);
  await demo.locator('body').evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
  const box = await stableBoundingBox(pdf);
  const scale = box.width / 612;
  // Drag across the unannotated first line of Section 4.1 in the real paper.
  await page.mouse.move(box.x + 52 * scale, box.y + 375 * scale);
  await page.mouse.down();
  await page.mouse.move(box.x + 300 * scale, box.y + 375 * scale, { steps: 20 });
  await page.mouse.up();
  await expect(demo.locator('[data-selection-status="reliable"]')).toBeAttached();
  const highlight = demo.getByRole('button', { name: 'Highlight', exact: true });
  await expect(highlight).toBeVisible();
  await page.getByRole('tab', { name: 'Read with focus', exact: true }).click();
  await expect(highlight).toBeHidden();
  await page.getByRole('tab', { name: 'Make comments', exact: true }).click();
  await expect(highlight).toBeVisible();
});

test('@critical visitors can insert text in the comments demo', async ({ page }) => {
  await page.setViewportSize({ width: 1324, height: 1100 });
  await page.goto('./');
  await page.locator('iframe').scrollIntoViewIfNeeded();
  const demo = page.frameLocator('iframe');
  await demo.locator('[data-initial-view-ready="true"]').waitFor({ state: 'attached' });
  const pdf = demo.locator('[data-page-index="13"] > img').first();
  await expect(pdf).toBeVisible();
  await page.getByRole('tab', { name: 'Make comments', exact: true }).click();
  await expect(demo.locator('[data-owned-mark]')).toHaveCount(5);
  await demo.locator('body').evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
  const box = await stableBoundingBox(pdf);
  const scale = box.width / 612;
  await page.mouse.click(box.x + 160 * scale, box.y + 375 * scale);
  const caret = demo.locator('[data-review-insertion-caret]');
  await expect(caret).toBeVisible();
  await page.getByRole('tab', { name: 'Read with focus', exact: true }).click();
  await expect(caret).toBeHidden();
  await page.getByRole('tab', { name: 'Make comments', exact: true }).click();
  await expect(caret).toBeVisible();
  // Reopening the tray refits the page. Do not click coordinates captured
  // before the transition while its geometry is still changing.
  await demo.locator('body').evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  });
  const reopenedBox = await stableBoundingBox(pdf);
  const reopenedScale = reopenedBox.width / 612;
  await page.mouse.click(reopenedBox.x + 160 * reopenedScale, reopenedBox.y + 375 * reopenedScale);
  await page.keyboard.type('New text');
  await expect(demo.getByRole('textbox', { name: 'Insertion', exact: true })).toHaveValue('New text');
  await demo.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(demo.locator('[data-owned-mark]')).toHaveCount(6);
  await page.getByRole('tab', { name: 'Read with focus', exact: true }).click();
  await expect(demo.locator('[data-owned-mark]')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Make comments', exact: true }).click();
  await expect(demo.locator('[data-owned-mark]')).toHaveCount(6);
});

test('@critical real-paper demo keeps its metadata while bounding the main preview', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./');
  const demo = page.frameLocator('iframe');
  await demo.locator('[data-initial-view-ready="true"]').waitFor({ state: 'attached' });
  const currentPage = demo.getByRole('textbox', { name: /^Current page/ });
  await expect(currentPage).toBeVisible();
  await expect(demo.locator('header.review-chrome')).toContainText('/ 100');
  const viewport = demo.locator('.pdf-workspace:not(.pdf-workspace--reference) [data-viewer-framing-viewport]').first();
  for (const zoomPercent of ['100', '150']) {
    const zoom = demo.getByRole('textbox', { name: /^Current zoom/ });
    await zoom.fill(zoomPercent);
    await zoom.press('Enter');
    await currentPage.fill('100');
    await currentPage.press('Enter');
    await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(currentPage).toHaveValue('16');
  }
  await currentPage.fill('1');
  await currentPage.press('Enter');
  await viewport.hover({ position: { x: 150, y: 150 } });
  await page.mouse.wheel(0, -30000);
  await expect(currentPage).toHaveValue('14');
  const momentum = await viewport.evaluate((element) => {
    const offsets: number[] = [];
    const canceled: boolean[] = [];
    for (const deltaY of [-10000, -600, -240, -80, -20, -4]) {
      canceled.push(!element.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })));
      offsets.push(element.scrollTop);
    }
    return { offsets, canceled };
  });
  expect(momentum.canceled.every(Boolean)).toBe(true);
  expect(new Set(momentum.offsets).size).toBe(1);
  await demo.getByRole('button', { name: 'Show workspace', exact: true }).click();
  await expect(demo.getByRole('button', { name: /Theoretical Properties/ }).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Follow references', exact: true }).click();
  await expect(demo.getByRole('tab', { name: 'Appendix A, Page 31', exact: true })).toBeVisible();
  await expect(demo.locator('[data-reference-pdf-viewport] [data-page-index="30"] > img').first()).toBeVisible();
  await expect(currentPage).toHaveValue('14');
});

test('@critical demo starts fitted and Fit Width keeps the requested scale', async ({ page }) => {
  await page.addInitScript(() => {
    const checkFirstPaint = () => {
      const reader = document.querySelector<HTMLElement>('[data-initial-view-ready]');
      if (reader?.dataset.initialViewReady === 'true') return;
      if (reader && getComputedStyle(reader).visibility !== 'hidden') {
        document.body.dataset.unfittedDemoPaint = 'true';
      }
      requestAnimationFrame(checkFirstPaint);
    };
    requestAnimationFrame(checkFirstPaint);
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./');
  const demo = page.frameLocator('iframe');
  await demo.locator('[data-initial-view-ready="true"]').waitFor({ state: 'attached' });
  const zoom = demo.getByRole('textbox', { name: /^Current zoom/ });
  await expect(zoom).toHaveValue('146');
  await expect(demo.getByRole('textbox', { name: /^Current page/ })).toHaveValue('14');
  const readPage = demo.locator('[data-pdf-copy-surface="main"] [data-page-index="13"] > img').first();
  // Initial fitting must match the button's horizontal geometry, not just its percentage.
  const initialBounds = (await readPage.boundingBox())!;
  await expect(demo.locator('body')).not.toHaveAttribute('data-unfitted-demo-paint', 'true');
  for (const mode of ['Read with focus', 'Follow references', 'Make comments']) {
    await page.getByRole('tab', { name: mode, exact: true }).click();
    await demo.locator('body').evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
    });
    // Fit width depends on the browser's scrollbar gutter. Check the actual
    // reading width, then require the explicit fit to restore that same scale.
    if (mode === 'Make comments') {
      await expect(async () => {
        const geometry = await readPage.evaluate((image) => {
          const workspace = image.closest('.pdf-workspace')!;
          const viewport = workspace.querySelector<HTMLElement>('[data-viewer-framing-viewport]')!;
          const bounds = viewport.getBoundingClientRect();
          const right = Math.min(bounds.left + viewport.clientLeft + viewport.clientWidth, workspace.getBoundingClientRect().right);
          // The open tray leaves a 12px inset plus 12px fade on each side.
          return { pageWidth: image.getBoundingClientRect().width, available: right - bounds.left - viewport.clientLeft - 48 };
        });
        expect(Math.abs(geometry.pageWidth - geometry.available)).toBeLessThan(1);
      }).toPass();
    }
    const fitted = await zoom.inputValue();
    await zoom.fill('200');
    await zoom.press('Enter');
    await expect(zoom).toHaveValue('200');
    const viewport = demo.locator('[data-pdf-copy-surface="main"] [data-viewer-framing-viewport]');
    await viewport.hover({ position: { x: 150, y: 150 } });
    await viewport.evaluate(async () => { for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame); });
    const upwardScroll = viewport.evaluate(async (element) => {
      const offsets: number[] = [];
      const record = () => offsets.push(element.scrollTop);
      element.addEventListener('scroll', record);
      for (let i = 0; i < 20; i++) await new Promise(requestAnimationFrame);
      element.removeEventListener('scroll', record);
      return offsets;
    });
    await page.mouse.wheel(0, -30000);
    const offsets = await upwardScroll;
    // Upward scrolling must stop, never overshoot and then jump down to page 14.
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeLessThanOrEqual(offsets[i - 1]! + 1);
    await demo.getByRole('button', { name: 'Open zoom controls', exact: true }).click();
    await demo.getByRole('menuitem', { name: 'Fit width', exact: true }).click();
    await expect(zoom).toHaveValue(fitted);
    // Catch a transient successful fit followed by rollback during anchor settlement.
    await expect(zoom).toHaveJSProperty('value', fitted);
    const samples = await zoom.evaluate(async (input: HTMLInputElement) => {
      const values: string[] = [];
      for (let frame = 0; frame < 20; frame += 1) {
        await new Promise(requestAnimationFrame);
        values.push(input.value);
      }
      return values;
    });
    expect(new Set(samples)).toEqual(new Set([fitted]));
    if (mode === 'Read with focus') {
      const fittedBounds = (await readPage.boundingBox())!;
      expect(Math.abs(fittedBounds.x - initialBounds.x)).toBeLessThan(1);
      expect(Math.abs(fittedBounds.width - initialBounds.width)).toBeLessThan(1);
    }
  }
});


for (const width of [1440, 390]) test(`@critical installation dialog preserves the demo and equal divider spacing at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto('./');
  const demo = page.frameLocator('iframe[aria-hidden="false"]');
  await demo.locator('[data-initial-view-ready="true"]').waitFor({ state: 'attached' });
  await page.getByRole('tab', { name: 'Make comments', exact: true }).click();
  await expect(demo.locator('[data-owned-mark]')).toHaveCount(5);
  const identity = await demo.locator('body').evaluate(() => performance.timeOrigin);
  const separator = page.locator('.static-launcher__separator');
  const spacing = await separator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      above: bounds.top - element.previousElementSibling!.getBoundingClientRect().bottom,
      below: element.nextElementSibling!.getBoundingClientRect().top - bounds.bottom,
    };
  });
  expect(spacing.above).toBeGreaterThan(0);
  expect(Math.abs(spacing.above - spacing.below)).toBeLessThan(1);
  const triggers = page.getByRole('button', { name: 'Install', exact: true });
  await expect(triggers).toHaveCount(2);
  const dialog = page.getByRole('dialog', { name: 'Install Placekeeper', exact: true });
  for (const index of [0, 1]) {
    await triggers.nth(index).click();
    await expect(dialog).toBeVisible();
    await expect(page.locator('dialog')).toHaveCount(1);
    const copy = dialog.getByRole('button', { name: 'Copy command', exact: true });
    await expect(copy).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(copy).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(copy).toBeFocused();
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    if (index === 0) await page.keyboard.press('Escape');
    else await page.mouse.click(2, 2);
    await expect(dialog).toBeHidden();
    await expect(triggers.nth(index)).toBeFocused();
    expect(await demo.locator('body').evaluate(() => performance.timeOrigin)).toBe(identity);
    await expect(page.getByRole('tab', { name: 'Make comments', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(demo.locator('[data-owned-mark]')).toHaveCount(5);
  }
  await triggers.first().click();
  await page.mouse.click(2, 2);
  await expect(dialog).toBeHidden();
  await expect(triggers.first()).toBeFocused();
});

test('@critical dismissing installation preserves a pending document open', async ({ page }) => {
  let finishRequest!: () => void;
  const pending = new Promise<void>((resolve) => { finishRequest = resolve; });
  await page.route('https://example.org/paper.pdf', async (route) => {
    await pending;
    await route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'Not found' });
  });
  try {
    await page.goto('./');
    await page.getByRole('textbox', { name: 'Document URL' }).fill('https://example.org/paper.pdf');
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    const spinner = page.locator('.static-launcher__url button .static-launcher__spinner');
    await expect(spinner).toBeVisible();
    await page.getByRole('button', { name: 'Install', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Install Placekeeper', exact: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(spinner).toBeVisible();
    finishRequest();
    await expect(page.locator('.static-launcher__toasts [role="alert"]')).toContainText('404');
    await expect(spinner).toHaveCount(0);
  } finally {
    finishRequest();
  }
});

test('@critical installation command reports clipboard success and remains selectable on failure', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { document.body.dataset.copiedInstallCommand = text; },
    } });
  });
  await page.getByRole('button', { name: 'Install', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Install Placekeeper', exact: true });
  const command = dialog.getByLabel('Install command', { exact: true });
  const text = await command.textContent();
  await dialog.getByRole('button', { name: 'Copy command', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Command copied.');
  await expect(page.locator('body')).toHaveAttribute('data-copied-install-command', text!);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
    } });
  });
  await dialog.getByRole('button', { name: 'Copy command', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Couldn’t copy. Select the command and copy it manually.');
  expect(await command.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  })).toBe(text);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Install', exact: true }).first().click();
  await expect(dialog.getByRole('status')).toBeEmpty();
});
