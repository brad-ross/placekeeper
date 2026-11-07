import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";

import { PlacekeeperHost } from "../../apps/service/src/host/placekeeper-host.js";
import { addPageNote } from "../../packages/core/src/review-commands.js";
import { readEditableReviewItems } from "../../packages/pdf-backends/src/embedpdf-adapter.js";

/*
 * Legible link destinations (AE1–AE6) against generated LaTeX-style links
 * that carry no author-provided names. The fixture's body page holds, in
 * annotation order: a citation split across a line break into two link
 * areas, a section reference "2.3", an equation reference "1", a null-top
 * XYZ link to the appendix page, and a long two-line citation. The closing
 * page holds one more citation.
 */

const READY_TIMEOUT_MS = 15_000;
const WIDE = { width: 1280, height: 900 } as const;
const AGARWAL = "Agarwal, Dahleh, et al. (2023)";
const LONG_CITATION =
  "Montgomery-Hernandez, Oyelaran-Whitfield, Castellanos-Ruiz, and Van der Berghe-Nakamura (2021)";
const SECTION_HEADING = "2.3 The Aggregated Projection Matrix";

let root = "";
let sourceRoot = "";
let outlinedPdf = "";
let unoutlinedPdf = "";
let host: PlacekeeperHost;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "placekeeper-legible-links-"));
  sourceRoot = join(root, "source");
  await mkdir(sourceRoot);
  outlinedPdf = join(root, "legible-link-destinations.pdf");
  unoutlinedPdf = join(root, "legible-link-destinations-no-outline.pdf");
  await copyFile(resolve("test/fixtures/pdfs/legible-link-destinations.pdf"), outlinedPdf);
  await copyFile(resolve("test/fixtures/pdfs/legible-link-destinations-no-outline.pdf"), unoutlinedPdf);
});

test.beforeEach(async () => {
  host = await PlacekeeperHost.start({
    recoveryRoot: join(root, `recovery-${randomUUID()}`),
    webAssets: { root: resolve("dist/web") },
  });
});

test.afterEach(async ({ page }) => {
  await page.context().close();
  await host.close();
});

test.afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function freshCopy(source: string): Promise<string> {
  const directory = join(root, randomUUID());
  await mkdir(directory);
  const target = join(directory, source.endsWith("no-outline.pdf") ? "equations.pdf" : "paper.pdf");
  await copyFile(source, target);
  return target;
}

async function openFixture(
  page: Page,
  source: string,
  options: {
    readonly generatedOutput?: boolean;
    readonly pageNote?: boolean;
    readonly viewport?: { readonly width: number; readonly height: number };
  } = {},
): Promise<{ readonly sessionId: string }> {
  await page.setViewportSize(options.viewport ?? WIDE);
  const launched = await host.open({
    pdfPath: await freshCopy(source),
    sourceRootPath: sourceRoot,
    fork: true,
    ...(options.generatedOutput ? { surface: "browser" as const, workflowMode: "generated-output" as const } : {}),
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Legible link fixture launch failed");
  }
  if (options.pageNote) {
    const state = host.broker.state(launched.sessionId)!;
    await host.broker.acceptMutation(launched.sessionId, addPageNote(
      state, 0, { x: 480, y: 80, width: 18, height: 18 }, "Only real annotations are exported.",
    ));
  }
  await page.goto(launched.url);
  await expect(page.locator("[data-production-review]")).toHaveAttribute("data-initial-view-ready", "true", {
    timeout: READY_TIMEOUT_MS,
  });
  await expect(mainWorkspace(page).locator(".pdf-workspace__page[data-page-index='0']"))
    .toBeVisible({ timeout: READY_TIMEOUT_MS });
  return { sessionId: launched.sessionId };
}

function mainWorkspace(page: Page): Locator {
  return page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
}

function referenceWorkspace(page: Page): Locator {
  return page.locator(".pdf-workspace--reference");
}

/** Link controls on the body page, in annotation order (see the fixture). */
function bodyLink(page: Page, pageNumber: number, index = 0): Locator {
  return mainWorkspace(page)
    .getByRole("button", { name: `Open PDF link to Page ${pageNumber}`, exact: true })
    .nth(index);
}

async function settle(link: Locator): Promise<void> {
  await link.evaluate((element) => new Promise<void>((resolve, reject) => {
    let previous = "";
    let stableFrames = 0;
    const deadline = performance.now() + 5_000;
    const sample = () => {
      const rect = element.getBoundingClientRect();
      const current = `${rect.x},${rect.y},${rect.width},${rect.height}`;
      stableFrames = current === previous ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames >= 10) resolve();
      else if (performance.now() > deadline) reject(new Error("Link did not settle"));
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
}

/** Opens a link's action menu by keyboard, retrying once if the link moved. */
async function openLinkMenu(page: Page, link: Locator, pageNumber: number): Promise<Locator> {
  const menu = page.getByRole("menu", { name: `Open Page ${pageNumber}, Page ${pageNumber}` });
  await link.scrollIntoViewIfNeeded();
  await settle(link);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await link.evaluate((element) => element.focus({ preventScroll: true }));
    await page.keyboard.press("Enter");
    try {
      await expect(menu).toBeVisible({ timeout: 1_500 });
      return menu;
    } catch {
      // A settling layout can dismiss a freshly opened menu; retry.
    }
  }
  await expect(menu).toBeVisible();
  return menu;
}

async function expectSnippetReady(menu: Locator): Promise<Locator> {
  const snippet = menu.locator("[data-destination-snippet]");
  await expect(snippet).toHaveAttribute("data-snippet-status", "ready", { timeout: READY_TIMEOUT_MS });
  return snippet;
}

async function chooseOpenInReferences(page: Page, menu: Locator, tabName: string | RegExp): Promise<Locator> {
  await menu.getByRole("menuitem", { name: "Open in References" }).click();
  const tab = page.getByRole("tab", { name: tabName });
  await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: READY_TIMEOUT_MS });
  await expect(page.locator('[data-reference-pending="loading"]')).toHaveCount(0, {
    timeout: READY_TIMEOUT_MS,
  });
  return tab;
}

function referenceBandLayer(page: Page): Locator {
  return referenceWorkspace(page).locator("[data-pdf-destination-band-layer]");
}

function mainBandLayer(page: Page): Locator {
  return mainWorkspace(page).locator("[data-pdf-destination-band-layer]");
}

const FIXTURE_PAGE_COUNT = 6;

async function scrollViewportTo(workspace: Locator, pageIndex: number): Promise<void> {
  const viewport = workspace.locator("[data-viewer-framing-viewport]");
  const page = workspace.locator(`.pdf-workspace__page[data-page-index='${pageIndex}']`);
  // Pages far from the reading position are virtualized; approach them first.
  if (await page.count() === 0) {
    await viewport.evaluate((element, { index, count }) => {
      element.scrollTop = (element.scrollHeight * index) / count;
    }, { index: pageIndex, count: FIXTURE_PAGE_COUNT });
    await expect(page).toBeAttached({ timeout: READY_TIMEOUT_MS });
  }
  await viewport.evaluate((viewport, index) => {
    const target = viewport.querySelector<HTMLElement>(`.pdf-workspace__page[data-page-index='${index}']`);
    if (!target) throw new Error(`Page ${index} is not laid out`);
    const offset = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    viewport.scrollBy({ top: offset, behavior: "instant" as ScrollBehavior });
  }, pageIndex);
}

async function boundsInside(inner: Locator, outer: Locator): Promise<boolean> {
  const [innerBox, outerBox] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  if (!innerBox || !outerBox) return false;
  return innerBox.y >= outerBox.y - 1
    && innerBox.y + innerBox.height <= outerBox.y + outerBox.height + 1;
}

test("Covers AE1. a split citation previews its bibliography entry, names its tab, and keeps its band", async ({ page }) => {
  await openFixture(page, outlinedPdf);
  const citation = bodyLink(page, 4, 0);
  const menu = await openLinkMenu(page, citation, 4);

  // The snippet comes first, above one row of icon actions and the page.
  const snippet = await expectSnippetReady(menu);
  const extent = snippet.locator("[data-destination-snippet-extent]");
  await expect(extent).toHaveCount(3);
  // The highlight paints in the band's blue even though the menu is portaled
  // outside the review root.
  await expect(extent.first()).toHaveCSS("background-color", "rgba(56, 132, 230, 0.24)");
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toHaveAttribute("aria-label", "Open in References");
  await expect(items.nth(1)).toHaveAttribute("aria-label", "Open in main document");
  await expect(menu.locator(".copy-link-control")).toHaveCount(0);
  await expect(items.first()).toBeFocused();
  const snippetBox = await snippet.boundingBox();
  const firstItemBox = await items.first().boundingBox();
  const lastItemBox = await items.last().boundingBox();
  const destinationActions = menu.getByRole("group", { name: "Destination actions" });
  const previewControls = menu.getByRole("group", { name: "Preview controls" });
  const [destinationBox, controlsBox] = await Promise.all([
    destinationActions.boundingBox(),
    previewControls.boundingBox(),
  ]);
  expect(controlsBox!.x - (destinationBox!.x + destinationBox!.width)).toBeGreaterThanOrEqual(8);
  expect(snippetBox!.y + snippetBox!.height).toBeLessThanOrEqual(firstItemBox!.y + 1);
  // Icon actions share one row, left-aligned, and the page sits at its right end.
  expect(Math.abs(lastItemBox!.y - firstItemBox!.y)).toBeLessThan(1);
  expect(firstItemBox!.x - snippetBox!.x).toBeLessThan(2);
  const pageNumeral = menu.locator(".link-action-popover__page");
  await expect(pageNumeral).toHaveText("4");
  const pageBox = await pageNumeral.boundingBox();
  expect(snippetBox!.x + snippetBox!.width - (pageBox!.x + pageBox!.width)).toBeLessThan(8);
  expect(pageBox!.y + pageBox!.height / 2 - (firstItemBox!.y + firstItemBox!.height / 2)).toBeLessThan(2);
  // Tooltips open below the menu, never over the snippet.
  const tooltip = page.getByRole("tooltip", { name: "Open in References", exact: true });
  await expect(tooltip).toBeVisible();
  expect((await tooltip.boundingBox())!.y).toBeGreaterThan(firstItemBox!.y + firstItemBox!.height);
  await page.locator("[data-link-action-popover]").screenshot({
    path: test.info().outputPath("link-menu-with-snippet.png"),
    animations: "disabled",
  });

  const returnToReference = previewControls.getByRole("menuitem", { name: "Return to reference" });
  const previewOffset = () => snippet.evaluate((element) => [element.scrollLeft, element.scrollTop]);
  const initialOffset = await previewOffset();
  const mainViewport = mainWorkspace(page).locator("[data-viewer-framing-viewport]");
  const mainScrollTop = await mainViewport.evaluate((element) => element.scrollTop);
  await expect(returnToReference).toHaveCount(0);

  const zoomIn = menu.getByRole("menuitem", { name: "Zoom in", exact: true });
  const zoomOut = menu.getByRole("menuitem", { name: "Zoom out", exact: true });
  const previewPage = snippet.locator('[data-snippet-page-index="3"]');
  const previewWidth = async () => (await previewPage.boundingBox())!.width;
  const previewCenter = async () => {
    const [frame, paper] = await Promise.all([snippet.boundingBox(), previewPage.boundingBox()]);
    return {
      x: (frame!.x + frame!.width / 2 - paper!.x) / paper!.width,
      y: (frame!.y + frame!.height / 2 - paper!.y) / paper!.height,
    };
  };
  const rasterWidth = () => previewPage.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth);
  const initialWidth = await previewWidth();
  const initialCenter = await previewCenter();
  await expect.poll(rasterWidth).toBeGreaterThan(0);
  const initialRasterWidth = await rasterWidth();
  await zoomIn.click();
  await expect.poll(previewWidth).toBeGreaterThan(initialWidth);
  await expect.poll(rasterWidth).toBeGreaterThan(initialRasterWidth);
  const zoomedCenter = await previewCenter();
  expect(zoomedCenter.x).toBeCloseTo(initialCenter.x, 2);
  expect(zoomedCenter.y).toBeCloseTo(initialCenter.y, 2);
  await expect(returnToReference).toBeVisible();
  await zoomOut.click();
  await expect.poll(previewWidth).toBeCloseTo(initialWidth, 0);
  await zoomOut.click();
  await expect.poll(previewWidth).toBeLessThan(initialWidth);
  await returnToReference.press("Enter");
  await expect(returnToReference).toHaveCount(0);
  await expect.poll(previewWidth).toBeCloseTo(initialWidth, 0);
  await expect.poll(previewOffset).toEqual(initialOffset);

  await snippet.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -70);
  await page.keyboard.up("Control");
  await expect.poll(previewWidth).toBeGreaterThan(initialWidth);
  await returnToReference.click();
  await expect.poll(previewOffset).toEqual(initialOffset);

  await snippet.hover();
  await page.mouse.wheel(60, 90);
  await expect(returnToReference).toBeVisible();
  expect((await previewOffset())[0]).toBeGreaterThan(initialOffset[0]!);
  expect((await previewOffset())[1]).toBeGreaterThan(initialOffset[1]!);
  expect((await returnToReference.boundingBox())!.y).toBeGreaterThan(snippetBox!.y + snippetBox!.height);
  await returnToReference.press("Enter");
  await expect(returnToReference).toHaveCount(0);
  await expect.poll(previewOffset).toEqual(initialOffset);
  await expect(items.first()).toBeFocused();
  expect(await mainViewport.evaluate((element) => element.scrollTop)).toBe(mainScrollTop);

  const center = { x: snippetBox!.x + snippetBox!.width / 2, y: snippetBox!.y + snippetBox!.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x - 40, center.y - 40);
  await page.mouse.up();
  await expect(returnToReference).toBeVisible();
  await page.mouse.move(center.x - 40, center.y - 40);
  await page.mouse.down();
  await page.mouse.move(center.x, center.y);
  await page.mouse.up();
  await expect(returnToReference).toHaveCount(0);
  await expect.poll(previewOffset).toEqual(initialOffset);

  const targetPage = snippet.locator('[data-snippet-page-index="3"]');
  const distanceToNextPage = await targetPage.evaluate((element) =>
    element.getBoundingClientRect().bottom - element.closest('[data-destination-snippet]')!.getBoundingClientRect().top);
  await snippet.hover();
  await page.mouse.wheel(0, distanceToNextPage + 24);
  await expect(snippet.locator('[data-snippet-page-index="4"] img')).toBeInViewport();
  await snippet.press("End");
  const lastPageImage = snippet.locator('[data-snippet-page-index="5"] img');
  await expect(lastPageImage).toBeInViewport();
  await expect.poll(() => lastPageImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(returnToReference).toBeVisible();
  await snippet.press("Home");
  const firstPageImage = snippet.locator('[data-snippet-page-index="0"] img');
  await expect(firstPageImage).toBeInViewport();
  await expect.poll(() => firstPageImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await returnToReference.press("Enter");
  await expect(returnToReference).toHaveCount(0);
  await expect.poll(previewOffset).toEqual(initialOffset);
  await expect(extent.first()).toBeInViewport();
  expect(await mainViewport.evaluate((element) => element.scrollTop)).toBe(mainScrollTop);

  const tab = await chooseOpenInReferences(page, menu, `${AGARWAL}, Page 4`);
  await expect(tab).toHaveAttribute("aria-label", `${AGARWAL}, Page 4`);

  // The whole three-line bibliography entry carries the band.
  const bands = referenceBandLayer(page).locator("[data-pdf-destination-band]");
  await expect(bands).toHaveCount(3, { timeout: READY_TIMEOUT_MS });
  await expect(bands.first()).toHaveCSS("mix-blend-mode", "multiply");
  await expect(referenceBandLayer(page)).toHaveAttribute("aria-hidden", "true");
  await expect(bands.first()).toHaveCSS("pointer-events", "none");
  await page.screenshot({ path: test.info().outputPath("banded-reference-tab.png"), animations: "disabled" });

  const reference = referenceWorkspace(page);
  const referenceViewport = reference.locator("[data-viewer-framing-viewport]");
  const trayReturn = page.getByRole("button", { name: "Return to reference", exact: true });
  const bandBottom = () => bands.last().evaluate((band) => {
    const viewport = band.closest("[data-viewer-framing-viewport]")!;
    return band.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top;
  });
  await expect.poll(bandBottom).toBeGreaterThan(0);
  await page.locator(".review-chrome__page-input").focus();
  await referenceViewport.hover();
  await page.mouse.wheel(0, Math.ceil(await bandBottom()) + 8);
  await expect.poll(bandBottom).toBeLessThan(0);
  await expect(reference.locator(".pdf-workspace__page[data-page-index='3']")).toBeInViewport();
  await expect(trayReturn).toHaveCSS("opacity", "0");
  await trayReturn.locator("..").hover();
  await expect(trayReturn).toHaveCSS("opacity", "1");
  await trayReturn.click();
  await expect(trayReturn).toHaveCount(0);
  await expect(bands.first()).toBeInViewport();

  // Scroll offsets can also change without a wheel, key, or pointer event in the viewer.
  const returnedTop = await referenceViewport.evaluate((element) => element.scrollTop);
  const drift = Math.ceil(await bandBottom()) + 8;
  await referenceViewport.evaluate((element, delta) => { element.scrollTop += delta; }, drift);
  await expect.poll(bandBottom).toBeLessThan(0);
  await expect(trayReturn).toHaveCSS("opacity", "1");
  await scrollViewportTo(reference, 5);
  await expect(reference.locator(".pdf-workspace__page[data-page-index='5']")).toBeInViewport();
  await referenceViewport.evaluate((element, top) => { element.scrollTop = top; }, returnedTop);
  await expect(trayReturn).toHaveCount(0);
  await expect(bands).toHaveCount(3, { timeout: READY_TIMEOUT_MS });
  await expect(bands.first()).toBeVisible();
});

test("Covers AE2. a section reference tab is named after the destination heading", async ({ page }) => {
  await openFixture(page, outlinedPdf);
  const menu = await openLinkMenu(page, bodyLink(page, 2), 2);
  await expectSnippetReady(menu);
  const tab = await chooseOpenInReferences(page, menu, `${SECTION_HEADING}, Page 2`);
  await expect(tab).not.toHaveAttribute("aria-label", /^2\.3,/u);
  await expect(referenceBandLayer(page).locator("[data-pdf-destination-band]")).not.toHaveCount(0);
});

test("Covers AE3. an equation reference without an outline is named by its kind", async ({ page }) => {
  await openFixture(page, unoutlinedPdf);
  const menu = await openLinkMenu(page, bodyLink(page, 3), 3);
  await expectSnippetReady(menu);
  await chooseOpenInReferences(page, menu, "Eq. 1, Page 3");
  await expect(referenceBandLayer(page).locator("[data-pdf-destination-band]")).toHaveCount(1, {
    timeout: READY_TIMEOUT_MS,
  });
});

test("Covers AE4. the main-reader band clears once scrolled fully out of view and stays cleared", async ({ page }) => {
  await openFixture(page, outlinedPdf);
  const menu = await openLinkMenu(page, bodyLink(page, 4, 0), 4);
  await expectSnippetReady(menu);
  await menu.getByRole("menuitem", { name: "Open in main document" }).click();

  const layer = mainBandLayer(page);
  const bands = layer.locator("[data-pdf-destination-band]");
  await expect(bands).toHaveCount(3, { timeout: READY_TIMEOUT_MS });
  // The band appears while the jump is still settling; scrolling before it
  // settles would be pulled back to the destination.
  await expect(page.locator(".review-workspace__status"))
    .toHaveText("Main document destination opened.", { timeout: READY_TIMEOUT_MS });
  const viewport = mainWorkspace(page).locator("[data-viewer-framing-viewport]");
  await expect.poll(() => boundsInside(bands.first(), viewport)).toBe(true);

  // Reading on while the entry stays visible keeps the band.
  await viewport.evaluate((element) => element.scrollBy({ top: 40, behavior: "instant" as ScrollBehavior }));
  await page.waitForTimeout(300);
  await expect(bands).toHaveCount(3);

  // Scrolling the entry fully out of view clears it; scrolling back does not restore it.
  await scrollViewportTo(mainWorkspace(page), 5);
  await expect(layer).toHaveCount(0, { timeout: READY_TIMEOUT_MS });
  await scrollViewportTo(mainWorkspace(page), 3);
  await expect(mainWorkspace(page).locator(".pdf-workspace__page[data-page-index='3']")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(layer).toHaveCount(0);
});

test("Covers AE5. a null-top link previews the top of its page with no highlight and no band", async ({ page }) => {
  await openFixture(page, outlinedPdf, { viewport: { width: 480, height: 800 } });
  const menu = await openLinkMenu(page, bodyLink(page, 5), 5);
  const snippet = await expectSnippetReady(menu);
  await expect(menu.locator(".link-action-popover__page")).toHaveText("5");
  await expect(snippet.locator("[data-destination-snippet-extent]")).toHaveCount(0);
  const scrollTop = () => snippet.evaluate((element) => element.scrollTop);
  const initialScrollTop = await scrollTop();
  const targetPage = snippet.locator('[data-snippet-page-index="4"]');
  await expect.poll(async () => {
    const [targetBounds, previewBounds] = await Promise.all([targetPage.boundingBox(), snippet.boundingBox()]);
    return Math.abs(targetBounds!.y - previewBounds!.y);
  }).toBeLessThan(2);
  const returnToReference = menu.getByRole("menuitem", { name: "Return to reference" });
  await expect(returnToReference).toHaveCount(0);
  await snippet.press("ArrowDown");
  await expect(returnToReference).toBeVisible();
  await returnToReference.click();
  await expect(returnToReference).toHaveCount(0);
  await expect.poll(scrollTop).toBe(initialScrollTop);

  const initialWidth = (await targetPage.boundingBox())!.width;
  await menu.getByRole("menuitem", { name: "Zoom out", exact: true }).click();
  await expect.poll(async () => {
    const [frame, paper] = await Promise.all([snippet.boundingBox(), targetPage.boundingBox()]);
    const left = paper!.x - frame!.x;
    const right = frame!.x + frame!.width - (paper!.x + paper!.width);
    return Math.min(left, right);
  }).toBeGreaterThan(10);
  const [frame, paper] = await Promise.all([snippet.boundingBox(), targetPage.boundingBox()]);
  expect(paper!.x + paper!.width / 2).toBeCloseTo(frame!.x + frame!.width / 2, 0);
  await returnToReference.click();
  await expect.poll(async () => (await targetPage.boundingBox())!.width).toBeCloseTo(initialWidth, 0);

  await snippet.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const send = (type: string, radius: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value: type === "touchend" ? [] : [-radius, radius].map((offset) => ({
          clientX: bounds.x + bounds.width / 2 + offset,
          clientY: bounds.y + bounds.height / 2,
        })),
      });
      element.dispatchEvent(event);
    };
    send("touchstart", 20);
    send("touchmove", 30);
    send("touchend", 0);
  });
  await expect.poll(async () => (await targetPage.boundingBox())!.width).toBeGreaterThan(initialWidth);
  await returnToReference.click();
  await expect.poll(scrollTop).toBe(initialScrollTop);
  // The clicked words name the tab; the whole-page target adds no kind label.
  const tab = await chooseOpenInReferences(page, menu, "supplementary appendix, Page 5");
  await expect(tab).toBeVisible();
  await expect(referenceWorkspace(page).locator(".pdf-workspace__page[data-page-index='4']")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator("[data-pdf-destination-band-layer]")).toHaveCount(0);
});

test("Covers AE6. a banded destination is neither listed as an annotation nor exported", async ({ page }) => {
  await openFixture(page, outlinedPdf, { generatedOutput: true, pageNote: true });
  const menu = await openLinkMenu(page, bodyLink(page, 4, 0), 4);
  await expectSnippetReady(menu);
  await chooseOpenInReferences(page, menu, `${AGARWAL}, Page 4`);
  await expect(referenceBandLayer(page).locator("[data-pdf-destination-band]")).toHaveCount(3, {
    timeout: READY_TIMEOUT_MS,
  });

  const annotationsTab = page.getByRole("tab", { name: "Annotations", exact: true });
  if (!(await annotationsTab.isVisible())) await page.getByRole("button", { name: "Show workspace" }).click();
  await annotationsTab.click();
  const list = page.getByRole("region", { name: "Annotations", exact: true });
  await expect(list.locator("li[data-annotation-origin]")).toHaveCount(1);
  await expect(list).not.toContainText("Agarwal");
  await expect(referenceBandLayer(page).locator("[data-pdf-destination-band]")).toHaveCount(3);

  await page.getByRole("button", { name: /Open document actions$/u }).click();
  await page.getByRole("menuitem", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export reviewed PDF", exact: true });
  const exported = page.waitForResponse((response) => response.url().endsWith("/export") && response.ok());
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  const result = await (await exported).json() as { path: string };
  const bytes = new Uint8Array(await readFile(result.path));
  const items = await readEditableReviewItems(bytes);
  expect(items).toHaveLength(1);
  expect(items[0]?.kind).toBe("pageNote");

  // Beyond the source's eight link annotations, only the page note was written.
  const source = await PDFDocument.load(await readFile(outlinedPdf));
  const output = await PDFDocument.load(bytes);
  const subtypes = (document: PDFDocument) => document.getPages().flatMap((pdfPage) => {
    const annots = pdfPage.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) return [];
    return annots.asArray().map((entry) => {
      const annotation = document.context.lookup(entry, PDFDict);
      return annotation.get(PDFName.of("Subtype"))?.toString() ?? "";
    });
  });
  const sourceSubtypes = subtypes(source);
  const outputSubtypes = subtypes(output);
  expect(sourceSubtypes.filter((subtype) => subtype === "/Link")).toHaveLength(8);
  expect(outputSubtypes.filter((subtype) => subtype !== "/Link" && subtype !== "/Popup")).toHaveLength(1);
});

test("a long link-derived tab name truncates in the right-docked bar and keeps its full accessible name", async ({ page }) => {
  await openFixture(page, outlinedPdf);
  const menu = await openLinkMenu(page, bodyLink(page, 4, 2), 4);
  await expectSnippetReady(menu);
  const fullName = `${LONG_CITATION}, Page 4`;
  const tab = await chooseOpenInReferences(page, menu, fullName);
  await expect(tab).toHaveAttribute("aria-label", fullName);

  const label = tab.locator("span").first();
  const tablist = page.getByRole("tablist", { name: "Open references" });

  // Bottom dock: tabs stack in a vertical rail and the name fills the rail.
  await expect(page.locator("[data-review-stage]")).toHaveAttribute("data-reference-layout", "wide-bottom");
  await expect(tablist).toHaveAttribute("aria-orientation", "vertical");
  const rail = await label.evaluate((element) => ({
    overflow: getComputedStyle(element).textOverflow,
    truncated: element.scrollWidth > element.clientWidth,
    width: element.getBoundingClientRect().width,
    railWidth: element.closest('[role="tablist"]')!.getBoundingClientRect().width,
  }));
  expect(rail.overflow).toBe("ellipsis");
  expect(rail.truncated).toBe(true);
  expect(rail.width).toBeGreaterThan(rail.railWidth * 0.5);

  // Right dock: the horizontal tab is capped and the name ends in an ellipsis.
  const moveRight = page.getByRole("button", { name: "Move References to right" });
  await moveRight.locator("..").hover();
  await expect(moveRight).toHaveCSS("opacity", "1");
  await moveRight.click();
  await expect(page.locator("[data-review-stage]")).toHaveAttribute("data-reference-layout", "wide-right");
  await expect(tablist).toHaveAttribute("aria-orientation", "horizontal");
  const capped = await label.evaluate((element) => ({
    overflow: getComputedStyle(element).textOverflow,
    truncated: element.scrollWidth > element.clientWidth,
    tabWidth: element.closest('[role="tab"]')!.getBoundingClientRect().width,
  }));
  expect(capped.overflow).toBe("ellipsis");
  expect(capped.truncated).toBe(true);
  expect(capped.tabWidth).toBeLessThanOrEqual(13 * 16 + 1);
  await expect(page.getByRole("tab", { name: fullName })).toHaveAttribute("aria-label", fullName);
});

test("main link hit targets and their menu stay below an overlapping References viewer", async ({ page }) => {
  await openFixture(page, outlinedPdf);
  const first = await openLinkMenu(page, bodyLink(page, 4, 0), 4);
  await expectSnippetReady(first);
  await chooseOpenInReferences(page, first, `${AGARWAL}, Page 4`);
  const stage = page.locator("[data-review-stage]");
  await expect(stage).toHaveAttribute("data-reference-layout", "wide-bottom");
  const referenceSurface = page.locator("[data-review-workspace]");
  await expect.poll(() => referenceSurface.evaluate((element) => getComputedStyle(element).transform))
    .toBe("none");

  // Scroll a main-document link beneath the bottom-docked References viewer.
  const covered = mainWorkspace(page)
    .getByRole("button", { name: "Open PDF link to Page 4", exact: true })
    .last();
  await scrollViewportTo(mainWorkspace(page), 5);
  await expect(covered).toBeAttached();
  await covered.evaluate((element) => {
    const reference = document.querySelector<HTMLElement>("[data-reference-pdf-viewport]");
    const viewport = element.closest(".pdf-workspace")
      ?.querySelector<HTMLElement>("[data-viewer-framing-viewport]");
    if (!reference || !viewport) throw new Error("PDF viewer layers are unavailable.");
    const referenceBounds = reference.getBoundingClientRect();
    const linkBounds = element.getBoundingClientRect();
    viewport.scrollTop += (linkBounds.top + linkBounds.height / 2)
      - (referenceBounds.top + referenceBounds.height / 2);
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const hit = await covered.evaluate((element) => {
    const reference = document.querySelector<HTMLElement>("[data-reference-pdf-viewport]")!;
    const referenceBounds = reference.getBoundingClientRect();
    const linkBounds = element.getBoundingClientRect();
    const left = Math.max(referenceBounds.left, linkBounds.left);
    const right = Math.min(referenceBounds.right, linkBounds.right);
    const top = Math.max(referenceBounds.top, linkBounds.top);
    const bottom = Math.min(referenceBounds.bottom, linkBounds.bottom);
    if (right <= left || bottom <= top) return { topmost: "no-overlap", x: 0, y: 0 };
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const target = document.elementFromPoint(x, y);
    return {
      topmost: target?.closest("[data-reference-pdf-viewport]")
        ? "reference"
        : target?.closest(".pdf-workspace:not(.pdf-workspace--reference)") ? "main" : "other",
      x,
      y,
    };
  });
  expect(hit.topmost).not.toBe("no-overlap");
  expect(hit.topmost).not.toBe("main");
  await page.mouse.click(hit.x, hit.y);
  await expect(page.locator("[data-link-action-popover]")).toHaveCount(0);

  // A menu opened from a visible main link is placed on screen and is the topmost surface.
  const menu = await openLinkMenu(page, bodyLink(page, 2), 2);
  await expectSnippetReady(menu);
  const placement = await page.locator("[data-link-action-popover]").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return { bounds: bounds.toJSON() as DOMRect, topmost: target !== null && element.contains(target) };
  });
  expect(placement.bounds.left).toBeGreaterThanOrEqual(0);
  expect(placement.bounds.top).toBeGreaterThanOrEqual(0);
  expect(placement.bounds.right).toBeLessThanOrEqual(WIDE.width);
  expect(placement.bounds.bottom).toBeLessThanOrEqual(WIDE.height);
  expect(placement.topmost).toBe(true);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});
