import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { inspectPdfAnnotationCatalogWithEmbedPdf } from "../../packages/pdf-backends/src/embedpdf-adapter.js";

test("opens a local PDF, annotates in memory, and downloads a verified copy", async ({ page }) => {
  const nonReadRequests: string[] = [];
  page.on("request", (request) => {
    if (!['GET', 'HEAD'].includes(request.method())) nonReadRequests.push(request.url());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Review a PDF without uploading it" })).toBeVisible();
  await expect(page.getByText("No autosave, accounts, uploads, or recovery after this tab closes.")).toBeVisible();

  await page.locator("input[type=file]").setInputFiles(
    resolve("test/fixtures/pdfs/text-native-with-annotations.pdf"),
  );
  const review = page.locator("[data-production-review]");
  await expect(review).toHaveAttribute("data-launch-surface", "static");
  const pdfPage = page.locator("[data-page-index='0']").first();
  const image = pdfPage.locator(":scope > img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (
    element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
  ))).toBe(true);

  await page.evaluate(() => {
    globalThis.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  });
  await expect(review).toHaveAttribute("data-launch-surface", "static");

  const pageBox = await pdfPage.boundingBox();
  if (pageBox === null) throw new Error("Rendered PDF page has no bounds.");
  await pdfPage.click({
    button: "right",
    position: { x: pageBox.width * 0.78, y: pageBox.height * 0.7 },
  });
  await page.getByRole("menuitem", { name: "Add Page Note" }).click();
  const composer = page.getByRole("region", { name: "Page Note" });
  await composer.getByRole("textbox", { name: "Comment" }).fill("Static export proof.");
  await composer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-owned-mark='pageNote']")).toHaveCount(1);
  await expect(page.getByRole("dialog", { name: /save/i })).toHaveCount(0);

  const documentActions = page.getByRole("button", { name: /Open document actions$/u });
  await expect(documentActions.locator("[data-save-phase='not-saved']")).toHaveCount(1);
  await documentActions.click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("text-native-with-annotations-reviewed.pdf");
  const path = await download.path();
  if (path === null) throw new Error("Browser download did not produce a file.");

  const inspected = await inspectPdfAnnotationCatalogWithEmbedPdf(new Uint8Array(await readFile(path)));
  expect(inspected.annotations).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "existing-highlight", contents: "Existing supported highlight" }),
    expect.objectContaining({ id: "existing-stamp", contents: "Existing unsupported stamp" }),
    expect.objectContaining({ contents: "Static export proof.", hasNormalAppearance: true }),
  ]));
  expect(inspected.portableItems).toEqual([
    expect.objectContaining({
      kind: "pageNote",
      payload: expect.objectContaining({ comment: "Static export proof." }),
    }),
  ]);
  expect(nonReadRequests).toEqual([]);

  await page.evaluate(() => {
    globalThis.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  });
  await expect(page.locator("#root")).toBeEmpty();
});
