import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { ProofreaderHost } from "../../apps/service/src/host/proofreader-host.js";

let root = "";
let host: ProofreaderHost;
let launchUrl = "";
let sourceRoot = "";
let pdf = "";
let multiPagePdf = "";
let rotatedPdf = "";
let referencePdf = "";
let initialSessionId = "";

async function installSelectionCaptureGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let holding = true;
    const releases = new Set<() => void>();
    globalThis.__pdfProofreaderSelectionCaptureTestGate = {
      wait() {
        if (!holding) return Promise.resolve();
        return new Promise<void>((resolve) => releases.add(resolve));
      },
    };
    (globalThis as typeof globalThis & { __releasePdfSelectionCapture(): void })
      .__releasePdfSelectionCapture = () => {
        holding = false;
        for (const release of releases) release();
        releases.clear();
      };
  });
}

async function releaseSelectionCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __releasePdfSelectionCapture(): void })
      .__releasePdfSelectionCapture();
  });
}

async function dragPdfPhrase(
  page: Page,
  pdfPage: ReturnType<Page["locator"]>,
  start: { x: number; y: number },
  end: { x: number; y: number },
  whileDragging?: () => Promise<void>,
): Promise<void> {
  const box = await pdfPage.boundingBox();
  if (!box) throw new Error("Rendered PDF page has no bounds.");
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + end.x, box.y + end.y);
  await whileDragging?.();
  await page.mouse.up();
}

async function waitForRenderedPageImage(
  pdfPage: ReturnType<Page["locator"]>,
): Promise<ReturnType<Page["locator"]>> {
  const image = pdfPage.locator(":scope > img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (
    element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
  ))).toBe(true);
  return image;
}

async function openLinkInReferences(
  page: Page,
  link: ReturnType<Page["locator"]>,
): Promise<void> {
  const action = page.getByRole("menuitem", { name: /Open in References/u });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await link.focus();
    await expect(link).toBeFocused();
    await link.press("Enter");
    try {
      await expect(action).toBeFocused({ timeout: 1_500 });
      await action.press("Enter");
      return;
    } catch {
      // The portaled link can settle between focus and activation; retry once.
    }
  }
  await expect(action).toBeFocused();
  await action.press("Enter");
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /Cannot update|while rendering|Maximum update depth|React/u.test(message.text())
    ) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function openFreshProductionFixture(
  page: Page,
  pdfPath: string,
  failureMessage: string,
): Promise<{ sessionId: string; url: string }> {
  const startupErrors: string[] = [];
  page.on("pageerror", (error) => startupErrors.push(error.message));
  const launched = await host.open({ pdfPath, sourceRootPath: sourceRoot, fork: true });
  if (!launched.ok || launched.kind === "recovery-offered") throw new Error(failureMessage);
  await page.goto(launched.url);
  try {
    await expect(page.locator("[data-production-review]")).toBeVisible();
  } catch (error) {
    throw new Error(`${failureMessage}: ${startupErrors.join("; ") || "production root did not mount"}`, {
      cause: error,
    });
  }
  return { sessionId: launched.sessionId, url: launched.url };
}

async function openAnnotationsWorkspace(page: Page) {
  const workspace = await currentWorkspaceRail(page);
  if (await workspace.getAttribute("aria-expanded") !== "true") await workspace.click();
  await expect(workspace).toHaveAttribute("aria-expanded", "true");
  const annotations = page.getByRole("tab", { name: "Annotations", exact: true });
  await expect(annotations).toBeVisible();
  if (await annotations.getAttribute("aria-selected") !== "true") await annotations.click();
  await expect(annotations).toHaveAttribute("aria-selected", "true");
  return { annotations, workspace };
}

async function currentWorkspaceRail(page: Page) {
  const rightRail = page.getByRole("button", { name: /^(?:Open|Close) right workspace$/u });
  const stage = page.locator('[data-review-stage]');
  const expectedPresentation = (page.viewportSize()?.width ?? 1280) < 900 ? 'bottom' : 'right';
  await expect(stage).toHaveAttribute('data-workspace-presentation', expectedPresentation);
  return expectedPresentation === 'right'
    ? rightRail
    : page.getByRole("button", { name: /^(?:Open|Close) References tray$/u });
}

async function toggleWorkspace(page: Page) {
  const rail = await currentWorkspaceRail(page);
  await rail.click();
  return rail;
}

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pdf-proofreader-production-"));
  sourceRoot = join(root, "source");
  await mkdir(sourceRoot);
  pdf = join(root, "paper.pdf");
  multiPagePdf = join(root, "multi-page.pdf");
  rotatedPdf = join(root, "rotated.pdf");
  referencePdf = join(root, "reference-navigation.pdf");
  await copyFile(resolve("test/fixtures/pdfs/text-native-with-annotations.pdf"), pdf);
  await copyFile(resolve("test/fixtures/pdfs/mixed-text-image.pdf"), multiPagePdf);
  await copyFile(resolve("test/fixtures/pdfs/rotation-90-crop.pdf"), rotatedPdf);
  await copyFile(resolve("test/fixtures/pdfs/reference-navigation.pdf"), referencePdf);
  await copyFile(resolve("test/fixtures/latex/paper.tex"), join(sourceRoot, "paper.tex"));
  host = await ProofreaderHost.start({
    recoveryRoot: join(root, "recovery"),
    webAssets: { root: resolve("dist/web") },
  });
  const launched = await host.open({ pdfPath: pdf, sourceRootPath: sourceRoot });
  if (!launched.ok || launched.kind === "recovery-offered") throw new Error("Production launch failed");
  launchUrl = launched.url;
  initialSessionId = launched.sessionId;
});

test.afterAll(async () => {
  await host?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

test("keeps a real reference chain beside the anchored main PDF through reflow and history", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const documentRequests: Array<{ url: string; authorization?: string; cookie?: string }> = [];
  page.on("request", (request) => {
    if (!/\/document\//u.test(new URL(request.url()).pathname)) return;
    const headers = request.headers();
    documentRequests.push({
      url: request.url(),
      ...(headers.authorization === undefined ? {} : { authorization: headers.authorization }),
      ...(headers.cookie === undefined ? {} : { cookie: headers.cookie }),
    });
  });
  const contactedOrigins = new Set<string>();
  page.on("request", (request) => contactedOrigins.add(new URL(request.url()).origin));

  await openFreshProductionFixture(page, referencePdf, "Reference navigation launch failed");
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  const mainViewport = mainWorkspace.locator("[data-viewer-framing-viewport]");
  const mainPageOne = mainWorkspace.locator("[data-page-index='0']");
  await expect(mainPageOne).toBeVisible();
  await expect(page.getByLabel("Current page")).toHaveText("1 / 4");
  await mainWorkspace.evaluate((element) => element.setAttribute("data-reference-main-mount", "stable"));

  const primaryLink = mainWorkspace.getByRole("button", {
    name: "Open PDF link to Primary result, Page 2",
  });
  await primaryLink.focus();
  await page.keyboard.press("Enter");
  const primaryMenu = page.getByRole("menu", { name: "Open Primary result, Page 2" });
  await expect(primaryMenu).toBeVisible();
  await expect(primaryMenu.getByRole("menuitem", { name: /Open in References/u })).toBeFocused();
  await expect(primaryMenu.getByRole("menuitem")).toHaveCount(2);
  await expect(primaryMenu.locator("svg")).toHaveCount(2);
  await expect(primaryMenu.getByRole("menuitem").first()).toHaveText("");
  await expect(primaryMenu.getByRole("menuitem").last()).toHaveText("");
  const firstMenuItemBounds = await primaryMenu.getByRole("menuitem").first().boundingBox();
  expect(firstMenuItemBounds).not.toBeNull();
  expect(firstMenuItemBounds!.width).toBe(34);
  expect(firstMenuItemBounds!.height).toBe(34);
  const menuBounds = await primaryMenu.boundingBox();
  expect(menuBounds).not.toBeNull();
  expect(menuBounds!.width).toBeLessThan(100);
  expect(menuBounds!.height).toBe(44);
  const popoverBounds = await page.locator("[data-link-action-popover]").boundingBox();
  expect(popoverBounds).not.toBeNull();
  expect(popoverBounds!.height).toBe(46);
  expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds!.y).toBeGreaterThanOrEqual(0);
  expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(1280);
  expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(900);
  await page.keyboard.press("Escape");
  await expect(primaryMenu).toHaveCount(0);
  await expect(primaryLink).toBeFocused();
  await expect(page.getByLabel("Current page")).toHaveText("1 / 4");

  await page.keyboard.press("Enter");
  await expect(primaryMenu.getByRole("menuitem", { name: /Open in References/u })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(primaryMenu).toHaveCount(0);
  await expect(primaryLink).not.toBeFocused();

  await primaryLink.click();
  await page.getByRole("menuitem", { name: /Open in References/u }).click();
  const workspace = page.locator("[data-review-workspace]");
  await expect(workspace).toHaveAttribute("data-workspace-open", "true");
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "bottom");
  await expect(page.getByRole("button", { name: "Move References to right" })).toBeVisible();
  const primaryTab = page.getByRole("tab", { name: /Primary result/u });
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await expect(primaryTab).toBeFocused();
  await expect.poll(() => workspace.evaluate((element) => getComputedStyle(element).transform))
    .toBe('none');

  const referenceWorkspace = page.locator("[data-reference-pdf-viewport]");
  const referenceViewport = referenceWorkspace.locator("[data-viewer-framing-viewport]");
  await expect(referenceWorkspace.locator("[data-page-index='1']")).toBeVisible();
  await referenceWorkspace.evaluate((element) => element.setAttribute("data-reference-mount", "stable"));
  const mainScrollBefore = await mainViewport.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }));
  await referenceViewport.evaluate((element) => { element.scrollTop += 96; });
  await expect.poll(() => referenceViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await mainViewport.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }))).toEqual(mainScrollBefore);
  await expect(page.getByLabel("Current page")).toHaveText("1 / 4");

  const detailLink = referenceWorkspace.getByRole("button", {
    name: "Open PDF link to Target-to-target detail link, Page 3",
  });
  await detailLink.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await openLinkInReferences(page, detailLink);
  const detailTab = page.getByRole("tab", { name: /Target-to-target detail link/u });
  const retryDetailReference = page.getByRole("button", { name: "Retry reference" });
  await expect.poll(async () => (await detailTab.count()) + (await retryDetailReference.count()))
    .toBeGreaterThan(0);
  if (await retryDetailReference.isVisible()) await retryDetailReference.click();
  await expect(detailTab).toHaveAttribute("aria-selected", "true");
  await expect(detailTab).toBeFocused();
  await expect(page.getByRole("tablist", { name: "Open references" }).getByRole("tab")).toHaveCount(2);

  const repeatedAlias = mainWorkspace.getByRole("button", {
    name: "Open PDF link to Repeated primary result, Page 2",
  });
  await repeatedAlias.click();
  await expect(page.getByRole("menuitem", { name: /Open in References/u })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await expect(primaryTab).toBeFocused();
  await expect(page.getByRole("tablist", { name: "Open references" }).getByRole("tab")).toHaveCount(2);
  const primaryReferencePage = referenceWorkspace.locator("[data-page-index='1']");
  const referencePositionBeforeReflow = await Promise.all([
    referenceViewport.boundingBox(),
    primaryReferencePage.boundingBox(),
  ]).then(([viewportBounds, pageBounds]) => {
    if (!viewportBounds || !pageBounds) throw new Error("Reference scroll location is unavailable.");
    return (pageBounds.y + pageBounds.height / 2) - (viewportBounds.y + viewportBounds.height / 2);
  });
  const referencePageSizeBeforeReflow = await primaryReferencePage.boundingBox().then((bounds) => {
    if (!bounds) throw new Error("Reference page size is unavailable.");
    return { width: bounds.width, height: bounds.height };
  });
  const referenceTabsList = page.getByRole("tablist", { name: "Open references" });
  await expect(referenceTabsList).toHaveAttribute("aria-orientation", "vertical");
  const [bottomPrimaryTabBox, bottomDetailTabBox] = await Promise.all([
    primaryTab.boundingBox(),
    detailTab.boundingBox(),
  ]);
  if (!bottomPrimaryTabBox || !bottomDetailTabBox) throw new Error("Bottom reference tabs have no bounds.");
  expect(bottomDetailTabBox.y).toBeGreaterThan(bottomPrimaryTabBox.y + bottomPrimaryTabBox.height - 1);
  expect(bottomDetailTabBox.x).toBeCloseTo(bottomPrimaryTabBox.x, 0);
  const bottomCompound = referenceTabsList.locator(
    '.reference-tab-segment:has(> [role="tab"][aria-selected="true"])',
  );
  await expect(bottomCompound.locator('button')).toHaveCount(3);
  const bottomPanelGeometry = await page.locator('.reference-panel').evaluate((panel) => {
    const viewport = panel.querySelector<HTMLElement>('[data-reference-viewport-host]');
    if (!viewport) throw new Error('Reference viewport host is missing.');
    return { panelHeight: panel.clientHeight, viewportHeight: viewport.clientHeight };
  });
  expect(bottomPanelGeometry.viewportHeight).toBe(bottomPanelGeometry.panelHeight);
  await expect(page.locator('.reference-panel__actions')).toHaveCount(0);
  await expect.poll(() => documentRequests.length).toBe(2);
  expect(new Set(documentRequests.map(({ url }) => url)).size).toBe(1);
  expect(documentRequests.every(({ authorization, cookie }) => (
    authorization?.startsWith("Bearer ") === true && cookie === undefined
  ))).toBe(true);

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "bottom");
  await expect(mainWorkspace).toHaveAttribute("data-reference-main-mount", "stable");
  await expect(referenceWorkspace).toHaveAttribute("data-reference-mount", "stable");
  await expect.poll(async () => {
    const [viewportBounds, pageBounds] = await Promise.all([
      referenceViewport.boundingBox(),
      primaryReferencePage.boundingBox(),
    ]);
    if (!viewportBounds || !pageBounds) return Number.POSITIVE_INFINITY;
    const position = (pageBounds.y + pageBounds.height / 2)
      - (viewportBounds.y + viewportBounds.height / 2);
    return Math.abs(position - referencePositionBeforeReflow);
  }).toBeLessThan(48);
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "bottom");
  await expect(mainWorkspace).toHaveAttribute("data-reference-main-mount", "stable");
  await expect(referenceWorkspace).toHaveAttribute("data-reference-mount", "stable");

  const zoomBeforeDocking = await page.getByLabel("Zoom level").textContent();
  const bottomSplitter = page.getByRole("separator", { name: "Resize References" });
  await expect(bottomSplitter).toHaveAttribute("aria-orientation", "horizontal");
  await expect(bottomSplitter).toBeVisible();
  await expect(workspace).toBeVisible();
  const initialBottomValue = Number(await bottomSplitter.getAttribute("aria-valuenow"));
  const openBottomRail = page.locator(
    '[data-workspace-edge-rail="bottom"][data-edge-rail-open="true"]',
  );
  await expect(openBottomRail).toHaveAttribute("aria-label", "Close References tray");
  await expect(openBottomRail).toBeVisible();
  let bottomSplitterBox = await bottomSplitter.boundingBox();
  let initialBottomBounds = await workspace.boundingBox();
  let openBottomRailBox = await openBottomRail.boundingBox();
  await expect.poll(async () => {
    [bottomSplitterBox, initialBottomBounds, openBottomRailBox] = await Promise.all([
      bottomSplitter.boundingBox(),
      workspace.boundingBox(),
      openBottomRail.boundingBox(),
    ]);
    return bottomSplitterBox !== null
      && initialBottomBounds !== null
      && openBottomRailBox !== null;
  }).toBe(true);
  if (!bottomSplitterBox || !initialBottomBounds || !openBottomRailBox) {
    throw new Error("Bottom References edge controls have no bounds.");
  }
  expect(bottomSplitterBox.y + bottomSplitterBox.height / 2).toBeCloseTo(initialBottomBounds.y, 0);
  expect(await bottomSplitter.evaluate((element) => getComputedStyle(element).cursor)).toBe("ns-resize");
  expect(openBottomRailBox.y + openBottomRailBox.height).toBeCloseTo(initialBottomBounds.y, 0);
  await page.mouse.move(
    bottomSplitterBox.x + bottomSplitterBox.width / 2,
    bottomSplitterBox.y + bottomSplitterBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(bottomSplitterBox.x + bottomSplitterBox.width / 2, bottomSplitterBox.y - 48);
  await page.mouse.up();
  await expect.poll(async () => Number(await bottomSplitter.getAttribute("aria-valuenow")))
    .toBeGreaterThan(initialBottomValue);
  const rememberedBottomValue = Number(await bottomSplitter.getAttribute("aria-valuenow"));

  const rightRail = page.getByRole("button", { name: "Open right workspace" });
  await rightRail.click();
  const toolsWorkspace = page.locator("#review-tools-workspace");
  await expect(toolsWorkspace).toHaveAttribute("data-tools-workspace-open", "true");
  await expect.poll(() => toolsWorkspace.evaluate((element) => getComputedStyle(element).transform))
    .toBe("none");
  await expect(page.locator("[data-review-stage]")).toHaveAttribute("data-reference-layout", "wide-split");
  const [toolsBounds, bottomBounds] = await Promise.all([
    toolsWorkspace.boundingBox(),
    workspace.boundingBox(),
  ]);
  if (!toolsBounds || !bottomBounds) throw new Error("Coordinated tray geometry is unavailable.");
  expect(toolsBounds.y + toolsBounds.height).toBeCloseTo(bottomBounds.y, 0);
  const openRightRailBox = await page.getByRole("button", { name: "Close right workspace" }).boundingBox();
  if (!openRightRailBox) throw new Error("Right workspace rail has no bounds.");
  expect(openRightRailBox.x + openRightRailBox.width).toBeCloseTo(toolsBounds.x, 0);
  await mainPageOne.click({ position: { x: 24, y: 24 } });
  await expect(toolsWorkspace).toHaveAttribute("data-tools-workspace-open", "true");
  await expect(workspace).toHaveAttribute("data-workspace-open", "true");

  await page.getByRole("button", { name: "Move References to right" }).click();
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "right");
  await expect(page.getByRole("button", { name: "Open References tray" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close right workspace" })).toHaveAttribute(
    "aria-expanded", "true",
  );
  const workspaceModes = page.getByRole("tablist", { name: "Workspace modes" });
  await expect(workspaceModes.getByRole("tab")).toHaveText(["Outline", "Annotations", "References"]);
  await expect(workspaceModes.getByRole("tab", { name: "References", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(referenceTabsList).toHaveAttribute("aria-orientation", "horizontal");
  const [rightPrimaryTabBox, rightDetailTabBox] = await Promise.all([
    primaryTab.boundingBox(),
    detailTab.boundingBox(),
  ]);
  if (!rightPrimaryTabBox || !rightDetailTabBox) throw new Error("Right reference tabs have no bounds.");
  expect(rightDetailTabBox.x).toBeGreaterThan(rightPrimaryTabBox.x + rightPrimaryTabBox.width - 1);
  expect(rightDetailTabBox.y).toBeCloseTo(rightPrimaryTabBox.y, 0);
  await expect(page.getByRole("button", { name: "Move References to bottom" })).toBeVisible();
  const expectRightWorkspaceSelectorGeometry = async () => {
    const geometry = await workspaceModes.evaluate((tablist) => {
      const header = tablist.closest(".review-workspace__header");
      const referencesSegment = tablist.querySelector<HTMLElement>(
        "[data-workspace-tab-segment='references']",
      );
      const referencesTab = referencesSegment?.querySelector<HTMLElement>("[role='tab']");
      const referencesLabel = referencesSegment?.querySelector<HTMLElement>(
        ".review-workspace__tab-label",
      );
      const moveButton = referencesSegment?.querySelector<HTMLElement>(
        "[data-reference-move='bottom']",
      );
      if (!header || !referencesSegment || !referencesTab || !referencesLabel || !moveButton) {
        throw new Error("Right workspace selector geometry is incomplete.");
      }
      const headerRect = header.getBoundingClientRect();
      const tablistRect = tablist.getBoundingClientRect();
      const segmentRect = referencesSegment.getBoundingClientRect();
      const labelRect = referencesLabel.getBoundingClientRect();
      const moveRect = moveButton.getBoundingClientRect();
      return {
        leftInset: tablistRect.left - headerRect.left,
        rightInset: headerRect.right - tablistRect.right,
        segmentCenter: segmentRect.left + segmentRect.width / 2,
        clusterCenter: (labelRect.left + moveRect.right) / 2,
        gap: moveRect.left - labelRect.right,
      };
    });
    expect(geometry.rightInset).toBeCloseTo(geometry.leftInset, 0);
    expect(geometry.clusterCenter).toBeCloseTo(geometry.segmentCenter, 0);
    expect(geometry.gap).toBeGreaterThanOrEqual(0);
    expect(geometry.gap).toBeLessThanOrEqual(4);
  };
  await expectRightWorkspaceSelectorGeometry();
  const referencesMode = workspaceModes.getByRole("tab", { name: "References", exact: true });
  await workspaceModes.getByRole("tab", { name: "Outline", exact: true }).click();
  const referencesSegment = workspaceModes.locator("[data-workspace-tab-segment='references']");
  const referencesSegmentBox = await referencesSegment.boundingBox();
  if (!referencesSegmentBox) throw new Error("References selector segment has no bounds.");
  await referencesSegment.click({ position: { x: 3, y: referencesSegmentBox.height / 2 } });
  await expect(referencesMode).toHaveAttribute("aria-selected", "true");
  await expect(mainWorkspace).toHaveAttribute("data-reference-main-mount", "stable");
  await expect(referenceWorkspace).toHaveAttribute("data-reference-mount", "stable");

  const rightSplitter = page.getByRole("separator", { name: "Resize References" });
  await expect(rightSplitter).toHaveAttribute("aria-orientation", "vertical");
  const [rightSplitterBox, initialRightBounds] = await Promise.all([
    rightSplitter.boundingBox(),
    workspace.boundingBox(),
  ]);
  if (!rightSplitterBox || !initialRightBounds) throw new Error("Right References edge has no bounds.");
  expect(rightSplitterBox.x + rightSplitterBox.width / 2).toBeCloseTo(initialRightBounds.x, 0);
  expect(await rightSplitter.evaluate((element) => getComputedStyle(element).cursor)).toBe("ew-resize");
  const initialRightValue = Number(await rightSplitter.getAttribute("aria-valuenow"));
  await page.mouse.move(
    rightSplitterBox.x + rightSplitterBox.width / 2,
    rightSplitterBox.y + rightSplitterBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    rightSplitterBox.x + rightSplitterBox.width / 2 - 32,
    rightSplitterBox.y + rightSplitterBox.height / 2,
  );
  await page.mouse.up();
  await expect.poll(async () => Number(await rightSplitter.getAttribute("aria-valuenow")))
    .toBeGreaterThan(initialRightValue);
  await rightSplitter.press("Home");
  const minimumRightValue = Number(await rightSplitter.getAttribute("aria-valuenow"));
  await rightSplitter.press("ArrowLeft");
  await expect.poll(async () => Number(await rightSplitter.getAttribute("aria-valuenow")))
    .toBeGreaterThan(minimumRightValue);
  const rememberedRightValue = Number(await rightSplitter.getAttribute("aria-valuenow"));
  const referenceRightBounds = await workspace.boundingBox();
  expect(referenceRightBounds?.width).toBeCloseTo(rememberedRightValue, 0);
  const rightCompoundGeometry = await referenceTabsList.locator(
    '.reference-tab-segment:has(> [role="tab"][aria-selected="true"])',
  ).evaluate((segment) => {
    const selector = segment.querySelector<HTMLElement>('[role="tab"]');
    const title = selector?.querySelector<HTMLElement>('span');
    const actions = [...segment.querySelectorAll<HTMLElement>('[data-reference-tab-action]')];
    if (!selector || !title || actions.length !== 2) {
      throw new Error('Compound reference geometry is incomplete.');
    }
    const titleStyle = getComputedStyle(title);
    return {
      titleOverflow: titleStyle.overflow,
      titleTextOverflow: titleStyle.textOverflow,
      titleWhiteSpace: titleStyle.whiteSpace,
      actionWidths: actions.map((action) => action.getBoundingClientRect().width),
    };
  });
  expect(rightCompoundGeometry.titleOverflow).toBe('hidden');
  expect(rightCompoundGeometry.titleTextOverflow).toBe('ellipsis');
  expect(rightCompoundGeometry.titleWhiteSpace).toBe('nowrap');
  await expect(primaryTab).toHaveAccessibleName(/Primary result, Page 2/u);
  expect(rightCompoundGeometry.actionWidths[0]).toBeCloseTo(31, 0);
  expect(rightCompoundGeometry.actionWidths[1]).toBeCloseTo(31, 0);
  await expectRightWorkspaceSelectorGeometry();

  await page.getByRole("tab", { name: "Annotations", exact: true }).click();
  await expect.poll(async () => (await workspace.boundingBox())?.width ?? 0)
    .toBeGreaterThan(rememberedRightValue + 32);
  await page.getByRole("tab", { name: "References", exact: true }).click();
  await expect.poll(async () => (await workspace.boundingBox())?.width ?? 0)
    .toBeCloseTo(rememberedRightValue, 0);

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.locator("[data-review-stage]")).toHaveAttribute(
    "data-reference-layout",
    "narrow-unified",
  );
  await expect(page.getByRole("tab", { name: "References", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("[data-review-stage]")).toHaveAttribute(
    "data-reference-layout",
    "wide-right",
  );
  await expect(page.getByRole("tab", { name: "References", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect.poll(async () => (await workspace.boundingBox())?.width ?? 0)
    .toBeCloseTo(rememberedRightValue, 0);

  await page.getByRole("button", { name: "Move References to bottom" }).click();
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "bottom");
  await expect.poll(async () => Number(await bottomSplitter.getAttribute("aria-valuenow")))
    .toBe(rememberedBottomValue);
  await expect(page.getByRole("tab", { name: "References", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Open right workspace" }).click();
  await primaryTab.click();

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.locator("[data-review-stage]")).toHaveAttribute("data-reference-layout", "narrow-unified");
  await expect(page.getByRole("tab", { name: "References", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(mainWorkspace).toHaveAttribute("data-reference-main-mount", "stable");
  await expect(referenceWorkspace).toHaveAttribute("data-reference-mount", "stable");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("[data-review-stage]")).toHaveAttribute("data-reference-layout", "wide-split");
  await expect(toolsWorkspace).toHaveAttribute("data-tools-workspace-open", "true");
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "bottom");
  await expect(page.getByLabel("Zoom level")).toHaveText(zoomBeforeDocking ?? "");
  await expect.poll(async () => {
    const bounds = await primaryReferencePage.boundingBox();
    if (!bounds) return Number.POSITIVE_INFINITY;
    return Math.max(
      Math.abs(bounds.width - referencePageSizeBeforeReflow.width),
      Math.abs(bounds.height - referencePageSizeBeforeReflow.height),
    );
  }).toBeLessThan(1);
  await expect(mainWorkspace).toHaveAttribute("data-reference-main-mount", "stable");
  await expect(referenceWorkspace).toHaveAttribute("data-reference-mount", "stable");

  const finish = page.getByRole('button', { name: 'Finish' });
  await finish.click();
  await expect(workspace).toHaveAttribute('data-workspace-open', 'false');
  await expect(page.getByRole('heading', { name: 'Finish review' })).toBeVisible();
  await expect(page.locator('[data-workspace-edge-rail]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close finish options' }).click();
  await expect(workspace).toHaveAttribute('data-workspace-open', 'true');
  await expect(primaryTab).toHaveAttribute('aria-selected', 'true');
  await expect(primaryTab).toBeFocused();

  await detailTab.click();
  await expect(detailTab).toHaveAttribute("aria-selected", "true");
  await primaryTab.click();
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Close active reference" }).click();
  await expect(primaryTab).toHaveCount(0);
  await expect(detailTab).toHaveAttribute("aria-selected", "true");
  await expect(detailTab).toBeFocused();
  const liveDetailPage = referenceWorkspace.locator("[data-page-index='2']");
  await liveDetailPage.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect.poll(async () => {
    const [viewportBounds, pageBounds] = await Promise.all([
      referenceViewport.boundingBox(),
      liveDetailPage.boundingBox(),
    ]);
    if (!viewportBounds || !pageBounds) return Number.POSITIVE_INFINITY;
    return Math.abs(
      (viewportBounds.y + viewportBounds.height / 2)
      - (pageBounds.y + pageBounds.height / 2),
    );
  }).toBeLessThan(2);
  await page.getByRole("button", { name: "Send to main" }).click();
  await expect(workspace).toHaveAttribute("data-workspace-open", "false");
  await expect(toolsWorkspace).toHaveAttribute("data-tools-workspace-open", "true");
  await expect(page.getByRole("tablist", { name: "Open references", includeHidden: true })).toHaveCount(0);
  await expect(page.getByLabel("Current page")).toHaveText("3 / 4");
  await expect(mainWorkspace.locator("[data-page-index='2']")).toBeFocused();
  const back = page.getByRole("button", { name: "Back in document history" });
  const forward = page.getByRole("button", { name: "Forward in document history" });
  await expect(back).toBeEnabled();
  await back.click();
  await expect(page.getByLabel("Current page")).toHaveText("1 / 4");
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect(page.locator(".review-workspace__status")).toHaveText(
    "Moved forward in document history.",
  );
  await expect(mainWorkspace.locator("[data-page-index='2']")).toBeFocused();

  const workspaceControl = page.getByRole("button", { name: "Open References tray" });
  await workspaceControl.click();
  const emptyReference = page.locator("[data-reference-empty]");
  await expect(emptyReference).toBeVisible();
  await expect(emptyReference).toBeFocused();
  expect(contactedOrigins).toEqual(new Set([new URL(documentRequests[0]!.url).origin]));
});

test("switches and sends references from the right-docked workspace", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, "Right-docked reference launch failed");
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  await expect(mainWorkspace.locator("[data-page-index='0']")).toBeVisible();

  await mainWorkspace.getByRole("button", {
    name: "Open PDF link to Primary result, Page 2",
  }).click();
  await page.getByRole("menuitem", { name: /Open in References/u }).click();
  const workspace = page.locator("[data-review-workspace]");
  const primaryTab = page.getByRole("tab", { name: /Primary result/u });
  const retryReference = page.getByRole("button", { name: "Retry reference" });
  await expect.poll(async () => (await primaryTab.count()) + (await retryReference.count()))
    .toBeGreaterThan(0);
  if (await retryReference.isVisible()) await retryReference.click();
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");

  const referenceWorkspace = page.locator("[data-reference-pdf-viewport]");
  const referenceViewport = referenceWorkspace.locator("[data-viewer-framing-viewport]");
  await expect(referenceWorkspace.locator("[data-page-index='1']")).toBeVisible();
  await referenceViewport.evaluate((element) => { element.scrollTop += 96; });
  const detailLink = referenceWorkspace.getByRole("button", {
    name: "Open PDF link to Target-to-target detail link, Page 3",
  });
  await detailLink.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await openLinkInReferences(page, detailLink);
  const detailTab = page.getByRole("tab", { name: /Target-to-target detail link/u });
  await expect.poll(async () => (await detailTab.count()) + (await retryReference.count()))
    .toBeGreaterThan(0);
  if (await retryReference.isVisible()) await retryReference.click();
  await expect(detailTab).toHaveAttribute("aria-selected", "true");
  const activateReferenceTab = async (tab: ReturnType<Page["locator"]>) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await tab.click();
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      try {
        await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 3_000 });
        return;
      } catch {
        // A quiet navigation failure is explicitly retryable; click once more.
      }
    }
    await expect(tab).toHaveAttribute("aria-selected", "true");
  };

  await page.getByRole("button", { name: "Move References to right" }).click();
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "right");
  await expect.poll(() => workspace.evaluate((element) => getComputedStyle(element).transform))
    .toBe("none");
  await activateReferenceTab(primaryTab);
  await expect(page.locator(".review-workspace__status")).toHaveText("Reference active.");
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await activateReferenceTab(detailTab);
  await expect(page.locator(".review-workspace__status")).toHaveText("Reference active.");
  await expect(detailTab).toHaveAttribute("aria-selected", "true");
  const detailPage = referenceWorkspace.locator("[data-page-index='2']");
  await detailPage.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect.poll(async () => {
    const [viewportBounds, pageBounds] = await Promise.all([
      referenceViewport.boundingBox(),
      detailPage.boundingBox(),
    ]);
    if (!viewportBounds || !pageBounds) return Number.POSITIVE_INFINITY;
    return Math.abs(
      (viewportBounds.y + viewportBounds.height / 2)
      - (pageBounds.y + pageBounds.height / 2),
    );
  }).toBeLessThan(2);

  await page.getByRole("button", { name: "Send to main" }).click();
  await expect(page.locator(".review-workspace__status")).toHaveText(
    "Reference sent to the main document.",
  );
  await expect(workspace).toHaveAttribute("data-workspace-open", "true");
  await expect(workspace).toHaveAttribute("data-workspace-presentation", "right");
  await expect(page.getByLabel("Current page")).toHaveText("3 / 4");
  await expect(detailTab).toHaveCount(0);
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await expect(referenceWorkspace.locator("[data-page-index='1']")).toBeVisible();
});

test("keeps compound reference actions in narrow keyboard order through survivor and final close", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFreshProductionFixture(page, referencePdf, "Narrow compound reference launch failed");
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  await expect(mainWorkspace.locator("[data-page-index='0']")).toBeVisible();

  await mainWorkspace.getByRole("button", {
    name: "Open PDF link to Primary result, Page 2",
  }).click();
  await page.getByRole("menuitem", { name: /Open in References/u }).click();

  const referenceWorkspace = page.locator("[data-reference-pdf-viewport]");
  const primaryTab = page.getByRole("tab", { name: /Primary result/u });
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await expect(primaryTab).toBeFocused();
  const referenceViewport = referenceWorkspace.locator("[data-viewer-framing-viewport]");
  await referenceViewport.evaluate((element) => { element.scrollTop += 96; });
  await expect.poll(() => referenceViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const detailLink = referenceWorkspace.getByRole("button", {
    name: "Open PDF link to Target-to-target detail link, Page 3",
  });
  await detailLink.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await openLinkInReferences(page, detailLink);

  await page.setViewportSize({ width: 760, height: 900 });

  const stage = page.locator("[data-review-stage]");
  const workspace = page.locator("[data-review-workspace]");
  const detailTab = page.getByRole("tab", { name: /Target-to-target detail link/u });
  const retryReference = page.getByRole("button", { name: "Retry reference" });
  await expect.poll(async () => (await detailTab.count()) + (await retryReference.count()))
    .toBeGreaterThan(0);
  if (await retryReference.isVisible()) await retryReference.click();
  await expect(stage).toHaveAttribute("data-reference-layout", "narrow-unified");
  await expect(detailTab).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  const detailPage = referenceWorkspace.locator("[data-page-index='2']");
  await detailPage.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect.poll(async () => {
    const [viewportBounds, pageBounds] = await Promise.all([
      referenceViewport.boundingBox(),
      detailPage.boundingBox(),
    ]);
    if (!viewportBounds || !pageBounds) return Number.POSITIVE_INFINITY;
    return Math.abs(
      (viewportBounds.y + viewportBounds.height / 2)
      - (pageBounds.y + pageBounds.height / 2),
    );
  }).toBeLessThan(2);

  await detailTab.focus();
  await expect(detailTab).toBeFocused();
  const forwardTab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  const backwardTab = browserName === 'webkit' ? 'Shift+Alt+Tab' : 'Shift+Tab';
  await page.keyboard.press(forwardTab);
  const detailSend = page.getByRole("button", { name: "Send to main" });
  await expect(detailSend).toBeFocused();
  await page.keyboard.press(forwardTab);
  await expect(page.getByRole("button", { name: "Close active reference" })).toBeFocused();
  await page.keyboard.press(backwardTab);
  await expect(detailSend).toBeFocused();
  await detailSend.press("Enter");

  await expect(page.getByLabel("Current page")).toHaveText("3 / 4");
  await expect(page.locator(".review-workspace__status")).toHaveText(
    "Reference sent to the main document.",
  );
  await expect(detailTab).toHaveCount(0);
  await expect(workspace).toHaveAttribute("data-workspace-open", "true");
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await expect(primaryTab).toBeFocused();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  const finalClose = page.getByRole("button", { name: "Close active reference" });
  await finalClose.focus();
  await expect(finalClose).toBeFocused();
  await finalClose.press("Enter");

  await expect(page.getByRole("tablist", { name: "Open references", includeHidden: true })).toHaveCount(0);
  await expect(workspace).toHaveAttribute("data-workspace-open", "false");
  await expect(page.getByRole("button", { name: "Open References tray" })).toBeFocused();
});

test("keeps compound reference actions touch sized for coarse pointers", async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  try {
    await openFreshProductionFixture(page, referencePdf, "Coarse-pointer reference launch failed");
    const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
    await expect(mainWorkspace.locator("[data-page-index='0']")).toBeVisible();
    await (await currentWorkspaceRail(page)).click();
    const outline = page.getByRole("navigation", { name: "Document outline" });
    const outlineReference = outline.getByRole("button", {
      name: "Open Details, Page 3 in References",
    });
    await expect(outlineReference).toHaveCSS("opacity", "1");
    expect(await outlineReference.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    })).toEqual({ width: 44, height: 44 });
    await outlineReference.click();

    const actions = page.locator("[data-reference-tab-action]");
    await expect(actions).toHaveCount(2);
    const sizes = await actions.evaluateAll((buttons) => buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    }));
    expect(sizes).toEqual([
      { width: 44, height: 44 },
      { width: 44, height: 44 },
    ]);
  } finally {
    await context.close();
  }
});

test("keeps outline and rejected link metadata inert inside the installed local session", async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const contactedOrigins = new Set<string>();
  page.on("request", (request) => contactedOrigins.add(new URL(request.url()).origin));
  const opened = await openFreshProductionFixture(
    page,
    referencePdf,
    "Reference safety launch failed",
  );
  const sessionOrigin = new URL(opened.url).origin;
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  await expect(mainWorkspace.locator("[data-page-index='0']")).toBeVisible();
  await mainWorkspace.evaluate((element) => element.setAttribute("data-safety-main-mount", "stable"));

  const workspaceControl = await currentWorkspaceRail(page);
  await workspaceControl.click();
  const workspace = page.locator("#review-tools-workspace");
  await expect(workspace).toHaveAttribute("data-tools-workspace-open", "true");
  await expect(page.getByRole("tab", { name: "Outline" })).toHaveAttribute("aria-selected", "true");
  const workspaceHeader = workspace.locator('.review-workspace__header');
  const workspaceModes = page.getByRole('tablist', { name: 'Workspace modes' });
  const headerBox = await workspaceHeader.boundingBox();
  const modesBox = await workspaceModes.boundingBox();
  const railBox = await workspaceControl.boundingBox();
  if (!headerBox || !railBox || !modesBox) throw new Error('Workspace edge controls have no bounds.');
  expect(railBox.y).toBeCloseTo(headerBox.y, 0);
  await expect(page.getByRole('button', { name: 'Close workspace' })).toHaveCount(0);
  const outline = page.getByRole("navigation", { name: "Document outline" });
  await expect(outline).toBeVisible();
  await expect(outline.getByRole("button", { name: "Collapse Details" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(outline.getByRole("button", {
    name: "Nested result, Page 3",
    exact: true,
  })).toBeVisible();
  const hostileOutline = outline.getByRole("button", {
    name: "scriptalert(1)/script hostile outline, Page 2",
    exact: true,
  });
  await expect(hostileOutline).toBeVisible();
  await expect(outline.locator("script,img")).toHaveCount(0);
  expect(await hostileOutline.textContent()).not.toMatch(/[<>\u202e\u0000]/u);

  const details = outline.getByRole("button", { name: "Details, Page 3", exact: true });
  const detailsReference = outline.getByRole("button", {
    name: "Open Details, Page 3 in References",
  });
  const nestedReference = outline.getByRole("button", {
    name: "Open Nested result, Page 3 in References",
  });
  const hostileReference = outline.getByRole("button", {
    name: "Open scriptalert(1)/script hostile outline, Page 2 in References",
  });
  await page.mouse.move(0, 0);
  await expect(detailsReference).toHaveCSS("opacity", "0");
  await expect(nestedReference).toHaveCSS("opacity", "0");

  const nestedRow = nestedReference.locator("..");
  await nestedRow.hover();
  await expect(nestedReference).toHaveCSS("opacity", "1");
  await expect(detailsReference).toHaveCSS("opacity", "0");

  const nestedDestination = outline.getByRole("button", {
    name: "Nested result, Page 3",
    exact: true,
  });
  await nestedDestination.focus();
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(nestedReference).toBeFocused();
  await expect(nestedReference).toHaveCSS("opacity", "1");
  await expect(nestedReference).toHaveCSS("outline-style", "solid");

  await outline.evaluate((element) => { element.style.width = "190px"; });
  const nestedLongLabelGeometry = await hostileReference.evaluate((button) => {
    const row = button.parentElement;
    const destination = row?.querySelector<HTMLElement>(".outline-navigator__destination");
    const label = destination?.querySelector<HTMLElement>("span");
    if (!row || !destination || !label) throw new Error("Outline row geometry is incomplete.");
    const rowBounds = row.getBoundingClientRect();
    const destinationBounds = destination.getBoundingClientRect();
    const actionBounds = button.getBoundingClientRect();
    const rowStyle = getComputedStyle(row);
    const labelStyle = getComputedStyle(label);
    return {
      actionRightInset: rowBounds.right - actionBounds.right,
      actionWidth: actionBounds.width,
      destinationRight: destinationBounds.right,
      actionLeft: actionBounds.left,
      gridColumns: rowStyle.gridTemplateColumns,
      labelClientWidth: label.clientWidth,
      labelScrollWidth: label.scrollWidth,
      labelOverflow: labelStyle.overflow,
      labelTextOverflow: labelStyle.textOverflow,
      labelWhiteSpace: labelStyle.whiteSpace,
    };
  });
  expect(nestedLongLabelGeometry.actionRightInset).toBeCloseTo(0, 0);
  expect(nestedLongLabelGeometry.actionWidth).toBe(31);
  expect(nestedLongLabelGeometry.destinationRight)
    .toBeLessThanOrEqual(nestedLongLabelGeometry.actionLeft);
  expect(nestedLongLabelGeometry.gridColumns.split(" ")).toHaveLength(3);
  expect(nestedLongLabelGeometry.labelScrollWidth)
    .toBeGreaterThan(nestedLongLabelGeometry.labelClientWidth);
  expect(nestedLongLabelGeometry).toMatchObject({
    labelOverflow: "hidden",
    labelTextOverflow: "ellipsis",
    labelWhiteSpace: "nowrap",
  });
  await outline.evaluate((element) => { element.style.removeProperty("width"); });

  const mainViewport = mainWorkspace.locator("[data-viewer-framing-viewport]");
  await mainViewport.evaluate((element) => { element.scrollTop += 32; });
  const mainStateBeforeReference = {
    page: await page.getByLabel("Current page").textContent(),
    scroll: await mainViewport.evaluate((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
    })),
    zoom: await page.getByLabel("Zoom level").textContent(),
    backDisabled: await page.getByRole("button", {
      name: "Back in document history",
    }).isDisabled(),
    forwardDisabled: await page.getByRole("button", {
      name: "Forward in document history",
    }).isDisabled(),
  };
  await detailsReference.click();
  const detailsTab = page.getByRole("tab", { name: /Details, Page 3/u });
  await expect(detailsTab).toHaveAttribute("aria-selected", "true");
  await expect(detailsTab).toBeFocused();
  await expect(page.locator("[data-reference-pdf-viewport] [data-page-index='2']")).toBeVisible();
  await expect(mainWorkspace).toHaveAttribute("data-safety-main-mount", "stable");
  expect({
    page: await page.getByLabel("Current page").textContent(),
    scroll: await mainViewport.evaluate((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
    })),
    zoom: await page.getByLabel("Zoom level").textContent(),
    backDisabled: await page.getByRole("button", {
      name: "Back in document history",
    }).isDisabled(),
    forwardDisabled: await page.getByRole("button", {
      name: "Forward in document history",
    }).isDisabled(),
  }).toEqual(mainStateBeforeReference);
  await detailsReference.click();
  await expect(page.getByRole("tablist", { name: "Open references" }).getByRole("tab"))
    .toHaveCount(1);
  await expect(detailsTab).toBeFocused();
  await page.getByRole("button", { name: "Close active reference" }).click();
  await expect(page.locator("[data-reference-tab]")).toHaveCount(0);

  await details.focus();
  await page.keyboard.press("Enter");
  await expect(details).toBeFocused();
  await expect(workspace).toHaveAttribute("data-tools-workspace-open", "true");
  await expect(page.getByLabel("Current page")).toHaveText("3 / 4");
  await expect(outline.locator("[aria-current='location']")).toHaveAccessibleName(
    "Nested result, Page 3",
  );
  await workspaceControl.click();
  await expect(workspaceControl).toBeFocused();

  const back = page.getByRole("button", { name: "Back in document history" });
  const forward = page.getByRole("button", { name: "Forward in document history" });
  await back.click();
  await expect(page.getByLabel("Current page")).toHaveText("1 / 4");
  await expect(back).toBeDisabled();
  await expect(forward).toBeEnabled();

  const hostileLink = mainWorkspace.getByRole("button", {
    name: "Open PDF link to img src=x onerror=alert(1), Page 3",
  });
  await hostileLink.click();
  const hostileMenu = page.getByRole("menu", {
    name: "Open img src=x onerror=alert(1), Page 3",
  });
  await expect(hostileMenu).toBeVisible();
  await expect(hostileMenu.locator("script,img")).toHaveCount(0);
  expect(await hostileMenu.textContent()).not.toMatch(/[<>\u202e\u0000]/u);
  await page.keyboard.press("Escape");
  await expect(hostileLink).toBeFocused();
  await expect(page.getByLabel("Current page")).toHaveText("1 / 4");

  const next = page.getByRole("button", { name: "Next page" });
  for (const expectedPage of ["2 / 4", "3 / 4", "4 / 4"]) {
    await next.click();
    await expect(page.getByLabel("Current page")).toHaveText(expectedPage);
  }
  await expect(back).toBeDisabled();
  await expect(forward).toBeEnabled();
  const unavailable = mainWorkspace.getByRole("button", { name: "PDF link target unavailable" });
  await expect(unavailable).toHaveCount(6);
  for (let index = 0; index < 6; index += 1) {
    await unavailable.nth(index).click();
    await expect(page.locator("[data-link-action-popover]")).toHaveCount(0);
  }
  await expect(page.locator(".review-workspace__status")).toHaveText(
    "This PDF link cannot be opened safely.",
  );
  await expect(page.getByLabel("Current page")).toHaveText("4 / 4");
  await expect(back).toBeDisabled();
  await expect(forward).toBeEnabled();
  await expect(page.locator("[data-reference-tab]")).toHaveCount(0);
  await expect(workspace).toHaveAttribute("data-tools-workspace-open", "false");
  await expect(mainWorkspace).toHaveAttribute("data-safety-main-mount", "stable");
  expect(await page.locator("body").textContent()).not.toMatch(/example\.invalid|Calculator\.app|Bearer /u);
  expect(contactedOrigins).toEqual(new Set([sessionOrigin]));
});

test("reports an honest empty outline and restores workspace focus", async ({ page }) => {
  await openFreshProductionFixture(page, pdf, "No-outline launch failed");
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  await expect(mainWorkspace.locator("[data-page-index='0']")).toBeVisible();
  await mainWorkspace.evaluate((element) => element.setAttribute("data-empty-outline-main-mount", "stable"));
  const workspaceControl = await currentWorkspaceRail(page);
  await workspaceControl.click();
  await expect(page.locator("[data-outline-state='empty']")).toHaveText(
    "This PDF has no embedded outline.",
  );
  await workspaceControl.click();
  await expect(workspaceControl).toBeFocused();
  await expect(mainWorkspace).toHaveAttribute("data-empty-outline-main-mount", "stable");
});

test("retries one failed reference clone without exposing raw load details", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let documentRequestCount = 0;
  const documentHeaders: Array<{ authorization?: string; cookie?: string }> = [];
  await page.route("**/document/**", async (route) => {
    documentRequestCount += 1;
    const headers = route.request().headers();
    documentHeaders.push({
      ...(headers.authorization === undefined ? {} : { authorization: headers.authorization }),
      ...(headers.cookie === undefined ? {} : { cookie: headers.cookie }),
    });
    if (documentRequestCount === 2) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await openFreshProductionFixture(page, referencePdf, "Reference retry launch failed");
  const mainWorkspace = page.locator(".pdf-workspace:not(.pdf-workspace--reference)");
  const primaryLink = mainWorkspace.getByRole("button", {
    name: "Open PDF link to Primary result, Page 2",
  });
  await primaryLink.click();
  await page.getByRole("menuitem", { name: /Open in References/u }).click();

  const retry = page.getByRole("button", { name: "Retry reference" });
  await expect(retry).toBeVisible();
  await expect(retry).toBeFocused();
  await expect(page.locator("[data-reference-state='error']")).toContainText(
    "Reference unavailable.",
  );
  await expect(page.locator(".review-workspace__status")).toHaveText(
    "Reference unavailable. Retry when ready.",
  );
  expect(await page.locator("body").textContent()).not.toMatch(/net::|ERR_|Bearer /u);

  await retry.click();
  const primaryTab = page.getByRole("tab", { name: /Primary result/u });
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  await expect(primaryTab).toBeFocused();
  await expect(page.locator("[data-reference-pdf-viewport] [data-page-index='1']")).toBeVisible();
  expect(documentRequestCount).toBe(3);
  expect(documentHeaders.every(({ authorization, cookie }) => (
    authorization?.startsWith("Bearer ") === true && cookie === undefined
  ))).toBe(true);
});

test("one installed-style browser tree preserves review state across responsive layout", async ({ page }) => {
  const assetResponses: string[] = [];
  const contactedOrigins = new Set<string>();
  page.on("request", (request) => contactedOrigins.add(new URL(request.url()).origin));
  page.on("response", (response) => {
    if (response.url().includes("/assets/")) assetResponses.push(response.url());
  });
  const browserErrors = collectBrowserErrors(page);
  await installSelectionCaptureGate(page);
  await page.goto(launchUrl);
  await expect(page.getByRole("heading", { name: "paper.pdf" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Review views" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Human delivery", includeHidden: true })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Codex delivery", includeHidden: true })).toBeHidden();
  await expect.poll(() => assetResponses.some((url) => url.endsWith("/app.css"))).toBe(true);
  await expect.poll(() => assetResponses.some((url) => url.endsWith("/pdfium.wasm"))).toBe(true);

  await expect(page.getByRole("button", { name: "Proofread mode" })).toHaveCount(0);
  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await expect(page.getByLabel('Current page')).toHaveText('1 / 1');
  const workspace = page.locator('.pdf-workspace');
  await workspace.evaluate((element) => { element.setAttribute('data-mount-probe', 'stable'); });
  const renderedPageImage = await waitForRenderedPageImage(pageCanvas);
  const canvasBoxBeforeSelection = await pageCanvas.boundingBox();
  expect(canvasBoxBeforeSelection).not.toBeNull();
  if (canvasBoxBeforeSelection === null) throw new Error("Rendered PDF page has no bounds.");
  await expect(renderedPageImage).toHaveCSS("pointer-events", "none");
  await dragPdfPhrase(
    page,
    pageCanvas,
    { x: 76, y: 98 },
    { x: 405, y: 98 },
    async () => {
      const selectionOverlay = pageCanvas.locator(':scope > div[style*="mix-blend-mode"]');
      await expect(selectionOverlay).toBeVisible();
      await expect(selectionOverlay.locator(':scope > div').first())
        .toHaveCSS('background-color', 'rgb(219, 231, 255)');
      expect(await renderedPageImage.evaluate((image) => {
        const selection = window.getSelection();
        if (!selection) return false;
        return Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
          .some((range) => range.intersectsNode(image));
      })).toBe(false);
    },
  );
  await expect(pageCanvas).toBeFocused();
  await expect(pageCanvas).toHaveCSS("outline-style", "none");
  await expect(page.getByRole("alert")).toContainText("Reading the selected text");
  await expect.poll(async () => (await pageCanvas.boundingBox())?.y)
    .toBe(canvasBoxBeforeSelection.y);
  await page.keyboard.press("b");
  await releaseSelectionCapture(page);

  const replacementDialog = page.getByRole("dialog", { name: "Replacement text" });
  await expect(replacementDialog).toBeVisible();
  const replacementTextbox = replacementDialog.getByRole("textbox", { name: "Replacement text" });
  await expect(replacementTextbox).toHaveValue("b");
  await page.keyboard.type("la");
  await expect(replacementTextbox).toHaveValue("bla");
  await replacementDialog.getByRole("button", { name: "Apply" }).click();
  await expect(replacementDialog).toHaveCount(0);
  await expect(pageCanvas.locator(':scope > div[style*="mix-blend-mode"]')).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Selection review actions' })).toHaveCount(0);
  await expect(page.locator("[data-review-item]")).toHaveCount(1);
  const replacementState = host.broker.state(initialSessionId);
  expect(replacementState?.revision).toBe(1);
  expect(replacementState?.items).toHaveLength(1);
  expect(replacementState?.items[0]).toMatchObject({
    kind: "replace",
    pageIndex: 0,
    payload: {
      quote: "Selectable proofreader text: unique equilibrium clearly",
      proposedText: "bla",
      reliable: true,
    },
  });
  const replacementSegments = replacementState?.items[0]?.payload.segmentRects;
  expect(Array.isArray(replacementSegments)).toBe(true);
  expect(replacementState?.items[0]?.payload.rect).toEqual(
    Array.isArray(replacementSegments) ? replacementSegments[0] : undefined,
  );
  expect(replacementState?.items[0]?.payload.rect).toEqual({
    x: 72,
    y: 881,
    width: 334,
    height: 16,
  });

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.locator("[data-owned-mark='replace']")).toHaveCount(1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("[data-owned-mark='replace']")).toHaveCount(1);
  const canvasBoxBeforeFinish = await pageCanvas.boundingBox();

  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByRole("heading", { name: "Finish review" })).toBeVisible();
  await expect.poll(async () => {
    const box = await page.locator('[data-review-finish-slot]').boundingBox();
    return box === null ? Number.POSITIVE_INFINITY : Math.abs(box.x + box.width - 1280);
  }).toBeLessThanOrEqual(1);
  await expect(page.getByText("1 review item")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Human delivery" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Codex delivery" })).toBeVisible();
  await expect(pageCanvas).toHaveCount(1);
  await expect(workspace).toHaveAttribute('data-mount-probe', 'stable');
  expect(await pageCanvas.boundingBox()).toEqual(canvasBoxBeforeFinish);

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
  await expect(confirm.getByRole("button", { name: "Confirm and prepare" })).toBeFocused();
  await page.setViewportSize({ width: 320, height: 720 });
  await expect(confirm).toBeVisible();
  await expect(pageCanvas).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Finish review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare Codex handoff" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Finish review", includeHidden: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Finish" })).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Finish" }).click();
  await page.getByRole("button", { name: "Prepare Codex handoff" }).click();
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
  await page.getByRole("button", { name: "Close finish options" }).click();
  await expect(page.getByText(/^Handoff JSON:/u)).toBeHidden();
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByText(/^Handoff JSON:/u)).toHaveText(`Handoff JSON: ${handoffPath}`);
  expect(contactedOrigins).toEqual(new Set([new URL(launchUrl).origin]));
  expect(browserErrors).toEqual([]);
});

test('edits the current page in a real multi-page viewer without losing adjacent state', async ({ page }) => {
  const launched = await host.open({
    pdfPath: multiPagePdf,
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Fresh multi-page navigation launch failed');
  }
  const browserErrors = collectBrowserErrors(page);
  await page.goto(launched.url);

  const firstPage = page.locator("[data-page-index='0']").first();
  const secondPage = page.locator("[data-page-index='1']").first();
  await expect(firstPage).toBeVisible();
  await expect(page.getByLabel('Current page')).toHaveText('1 / 2');
  await waitForRenderedPageImage(firstPage);

  const workspace = page.locator('.pdf-workspace');
  await workspace.evaluate((element) => {
    element.setAttribute('data-page-navigation-mount-probe', 'stable');
  });
  const firstPageBox = await firstPage.boundingBox();
  if (!firstPageBox) throw new Error('First rendered PDF page has no bounds.');
  await firstPage.click({
    button: 'right',
    position: { x: firstPageBox.width * 0.8, y: firstPageBox.height * 0.7 },
  });
  await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
  const composer = page.getByRole('dialog', { name: 'Page Note' });
  await composer.getByRole('textbox', { name: 'Comment' }).fill('Keep this surrounding review state.');
  await composer.getByRole('button', { name: 'Save comment' }).click();
  await expect.poll(() => host.broker.state(launched.sessionId)?.revision).toBe(1);

  const { annotations, workspace: workspaceRail } = await openAnnotationsWorkspace(page);
  const noteRow = page.getByRole('button', {
    name: /pageNote · Page 1 · Keep this surrounding review state\./u,
  });
  await expect(noteRow).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  const zoomBeforeNavigation = await page.getByLabel('Zoom level').textContent();

  const currentPage = page.getByRole('button', {
    name: 'Current page 1 of 2. Enter a page number',
  });
  await currentPage.click();
  const pageNumber = page.getByRole('spinbutton', { name: 'Page number' });
  await expect(pageNumber).toBeFocused();
  await page.keyboard.type('2');
  await expect(pageNumber).toHaveValue('2');
  await pageNumber.press('Enter');

  await expect(page.getByRole('button', {
    name: 'Current page 2 of 2. Enter a page number',
  })).toBeFocused();
  await expect(secondPage).toBeVisible();
  await expect(firstPage).toHaveCount(1);
  await expect(secondPage).toHaveCount(1);
  await expect(workspace).toHaveAttribute('data-page-navigation-mount-probe', 'stable');
  expect(await page.getByLabel('Zoom level').textContent()).toBe(zoomBeforeNavigation);
  await expect(workspaceRail).toHaveAttribute('aria-expanded', 'true');
  await expect(annotations).toHaveAttribute('aria-selected', 'true');
  await expect(noteRow).toBeVisible();
  expect(host.broker.state(launched.sessionId)?.revision).toBe(1);
  expect(host.broker.state(launched.sessionId)?.items).toHaveLength(1);
  expect(browserErrors).toEqual([]);
});

test('minimally reveals the PDF beside the adaptive annotations surface and restores untouched movement', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const launched = await host.open({
    pdfPath: pdf,
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Fresh adaptive annotations launch failed');
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(launched.url);

  const stage = page.locator('[data-review-stage]');
  const drawer = page.locator('#review-tools-workspace');
  const viewport = page.locator('[data-viewer-framing-viewport]');
  const pdfPage = page.locator("[data-page-index='0']").first();
  const runway = page.locator('[data-viewer-runway]');
  const workspace = page.locator('.pdf-workspace');
  await expect(pdfPage).toBeVisible();
  await expect(viewport).toHaveCount(1);
  await expect(runway).toHaveCount(1);
  await expect(page.getByLabel('Zoom level')).toHaveText(/\d+%/u);
  await workspace.evaluate((element) => { element.setAttribute('data-adaptive-mount-probe', 'stable'); });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pageBounds = await pdfPage.boundingBox();
    const stageBounds = await stage.boundingBox();
    if (pageBounds && stageBounds && pageBounds.width > stageBounds.width - 384) break;
    await page.getByRole('button', { name: 'Zoom in' }).click();
  }
  await expect.poll(() => viewport.evaluate(async (element) => {
    const before = element.scrollTop;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return Math.abs(element.scrollTop - before);
  })).toBeLessThan(0.5);

  const widePageBefore = await pdfPage.boundingBox();
  const wideScrollBefore = await viewport.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
    width: element.scrollWidth,
  }));
  const zoomBefore = await page.getByLabel('Zoom level').textContent();
  const runwayBefore = await runway.boundingBox();
  if (!widePageBefore) throw new Error('Wide PDF page has no bounds.');
  if (!runwayBefore) throw new Error('Viewer runway has no bounds.');

  await openAnnotationsWorkspace(page);
  await expect(stage).toHaveAttribute('data-annotation-presentation', 'right');
  await expect(drawer).toHaveAttribute('data-workspace-presentation', 'right');
  await expect(drawer).toBeVisible();
  const wideDrawer = await drawer.boundingBox();
  const wideViewport = await viewport.boundingBox();
  if (!wideDrawer || !wideViewport) throw new Error('Wide annotations geometry is unavailable.');
  await expect.poll(async () => (await runway.boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(runwayBefore.width + wideDrawer.width - 1);
  const expectedHorizontalReveal = Math.max(
    0,
    Math.min(widePageBefore.x + widePageBefore.width, wideViewport.x + wideViewport.width) - wideDrawer.x,
  );
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft))
    .toBeCloseTo(wideScrollBefore.left + expectedHorizontalReveal, 0);
  const widePageAfter = await pdfPage.boundingBox();
  if (!widePageAfter) throw new Error('Revealed PDF page has no bounds.');
  expect(widePageBefore.x - widePageAfter.x).toBeCloseTo(expectedHorizontalReveal, 0);
  expect(widePageAfter.y).toBeCloseTo(widePageBefore.y, 0);
  expect(widePageAfter.width).toBeCloseTo(widePageBefore.width, 0);
  expect(await page.getByLabel('Zoom level').textContent()).toBe(zoomBefore);
  expect(await viewport.evaluate((element) => element.scrollWidth)).toBeGreaterThanOrEqual(
    wideScrollBefore.width + Math.floor(expectedHorizontalReveal),
  );

  await toggleWorkspace(page);
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft))
    .toBeCloseTo(wideScrollBefore.left, 0);
  const widePageRestored = await pdfPage.boundingBox();
  expect(widePageRestored?.x).toBeCloseTo(widePageBefore.x, 0);

  await toggleWorkspace(page);
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft))
    .toBeCloseTo(wideScrollBefore.left + expectedHorizontalReveal, 0);
  const automaticLeft = await viewport.evaluate((element) => element.scrollLeft);
  await viewport.hover();
  await page.mouse.wheel(40, 0);
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(automaticLeft);
  const deliberateLeft = await viewport.evaluate((element) => element.scrollLeft);
  await toggleWorkspace(page);
  await expect.poll(() => runway.evaluate((element) => {
    const parent = element.parentElement;
    if (!parent) return Number.NaN;
    return element.getBoundingClientRect().width - parent.getBoundingClientRect().width;
  })).toBeCloseTo(0, 0);
  const naturalHorizontalMaximum = await viewport.evaluate((element) => (
    Math.max(0, element.scrollWidth - element.clientWidth)
  ));
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft))
    .toBeCloseTo(Math.min(deliberateLeft, naturalHorizontalMaximum), 0);

  await toggleWorkspace(page);
  await expect.poll(() => viewport.evaluate((element, desiredLeft) => {
    const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
    return Math.abs(element.scrollLeft - Math.min(desiredLeft, maximum));
  }, deliberateLeft)).toBeLessThan(1);
  await page.setViewportSize({ width: 1240, height: 900 });
  await expect(stage).toHaveAttribute('data-annotation-presentation', 'right');
  await toggleWorkspace(page);
  await expect.poll(() => viewport.evaluate((element, desiredLeft) => {
    const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
    return Math.abs(element.scrollLeft - Math.min(desiredLeft, maximum));
  }, deliberateLeft)).toBeLessThan(1);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(stage).toHaveAttribute('data-annotation-presentation', 'bottom');
  const narrowHorizontalMaximum = await viewport.evaluate((element) => (
    Math.max(0, element.scrollWidth - element.clientWidth)
  ));
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft))
    .toBeCloseTo(Math.min(deliberateLeft, narrowHorizontalMaximum), 0);
  const narrowScrollBefore = await viewport.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }));
  await toggleWorkspace(page);
  await expect(drawer).toHaveAttribute('data-workspace-presentation', 'bottom');
  const narrowStage = await stage.boundingBox();
  const bottomDrawer = await drawer.boundingBox();
  if (!narrowStage || !bottomDrawer) throw new Error('Bottom annotations geometry is unavailable.');
  expect(bottomDrawer.x).toBeCloseTo(narrowStage.x, 0);
  expect(bottomDrawer.width).toBeCloseTo(narrowStage.width, 0);
  expect(bottomDrawer.y + bottomDrawer.height).toBeCloseTo(narrowStage.y + narrowStage.height, 0);
  expect(bottomDrawer.height).toBeCloseTo(narrowStage.height * 0.43, 0);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBeCloseTo(narrowScrollBefore.top, 0);
  await toggleWorkspace(page);

  const pageBox = await pdfPage.boundingBox();
  if (!pageBox) throw new Error('Narrow PDF page has no bounds.');
  const futureSheetTop = narrowStage.y + narrowStage.height * (1 - 0.43);
  const noteClientY = Math.min(pageBox.y + pageBox.height - 28, futureSheetTop + 48);
  await pdfPage.click({
    button: 'right',
    position: {
      x: Math.min(pageBox.width - 28, pageBox.width * 0.7),
      y: noteClientY - pageBox.y,
    },
  });
  await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
  await page.getByRole('textbox', { name: 'Comment' }).fill('Reveal this note above the sheet.');
  await page.getByRole('button', { name: 'Save comment' }).click();

  const noteMark = page.locator('[data-owned-mark="pageNote"]').last();
  const noteFocus = page.locator('[data-owned-focus-id]').last();
  await expect(noteMark).toBeVisible();
  const markBefore = await noteMark.boundingBox();
  const markScrollBefore = await viewport.evaluate((element) => element.scrollTop);
  if (!markBefore) throw new Error('Page Note mark has no bounds.');
  expect(markBefore.y + markBefore.height).toBeGreaterThan(futureSheetTop);

  await noteFocus.evaluate((element) => {
    (element as HTMLElement).focus({ preventScroll: true });
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
  });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('data-workspace-presentation', 'bottom');
  const activeReviewId = await noteMark.getAttribute('data-review-id');
  if (!activeReviewId) throw new Error('Page Note mark has no canonical review id.');
  await expect(page.locator(`[data-review-item="${activeReviewId}"]`)).toHaveAttribute('data-active', 'true');
  await expect.poll(async () => {
    const mark = await noteMark.boundingBox();
    const sheet = await drawer.boundingBox();
    return mark && sheet ? sheet.y - (mark.y + mark.height) : Number.NEGATIVE_INFINITY;
  }).toBeGreaterThanOrEqual(9);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(markScrollBefore);

  await page.setViewportSize({ width: 760, height: 820 });
  await expect(stage).toHaveAttribute('data-annotation-presentation', 'bottom');
  await expect.poll(async () => {
    const mark = await noteMark.boundingBox();
    const sheet = await drawer.boundingBox();
    return mark && sheet ? sheet.y - (mark.y + mark.height) : Number.NEGATIVE_INFINITY;
  }).toBeGreaterThanOrEqual(9);

  const responsiveZoom = await page.getByLabel('Zoom level').textContent();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(stage).toHaveAttribute('data-annotation-presentation', 'right');
  await expect(drawer).toBeVisible();
  await expect(page.locator(`[data-review-item="${activeReviewId}"]`)).toHaveAttribute('data-active', 'true');
  await expect(workspace).toHaveAttribute('data-adaptive-mount-probe', 'stable');
  expect(await page.getByLabel('Zoom level').textContent()).toBe(responsiveZoom);
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(stage).toHaveAttribute('data-annotation-presentation', 'bottom');
  await expect(drawer).toBeVisible();
  await expect(page.locator(`[data-review-item="${activeReviewId}"]`)).toHaveAttribute('data-active', 'true');
  await expect(workspace).toHaveAttribute('data-adaptive-mount-probe', 'stable');

  await toggleWorkspace(page);
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeCloseTo(markScrollBefore, 0);
  // Responsive rail and scrollbar geometry may clamp by one compact-control width.
  await expect.poll(() => viewport.evaluate((element, desiredLeft) => {
    const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
    return Math.abs(element.scrollLeft - Math.min(desiredLeft, maximum));
  }, deliberateLeft)).toBeLessThan(36);
});

test('uses the same compact review tree for a narrow VS Code embed launch', async ({ page }) => {
  const launched = await host.open({
    pdfPath: pdf,
    sourceRootPath: sourceRoot,
    surface: 'vscode',
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') throw new Error('VS Code embed launch failed');
  expect(new URL(launched.url).searchParams.get('embed')).toBe('vscode');
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(launched.url);
  await expect(page.locator('[data-production-review]')).toHaveCount(1);
  await expect(page.locator('[data-review-chrome]')).toHaveCount(1);
  await expect(page.locator('.pdf-workspace')).toHaveCount(1);
  const pdfPage = page.locator("[data-page-index='0']").first();
  await expect(pdfPage).toBeVisible();
  const { workspace: workspaceControl } = await openAnnotationsWorkspace(page);
  await expect(page.getByRole('button', { name: 'Close annotations' })).toHaveCount(0);
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-annotation-presentation', 'bottom');
  await expect.poll(async () => {
    const box = await page.locator('#review-tools-workspace').boundingBox();
    return box === null ? Number.POSITIVE_INFINITY : Math.abs(box.x + box.width - 320);
  }).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: /highlight · Page 1 · Existing supported highlight/iu }).click();
  await expect.poll(async () => {
    const box = await page.locator('#review-tools-workspace').boundingBox();
    return box === null ? Number.POSITIVE_INFINITY : Math.abs(box.x + box.width - 320);
  }).toBeLessThanOrEqual(1);

  const zoomBefore = await page.getByLabel('Zoom level').textContent();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByLabel('Zoom level')).not.toHaveText(zoomBefore ?? '');
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');

  const scrollViewport = page.locator('[data-viewer-framing-viewport]');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const scrollable = await scrollViewport.evaluate((element) => element.scrollHeight > element.clientHeight);
    if (scrollable) break;
    await page.getByRole('button', { name: 'Zoom in' }).click();
  }
  await expect.poll(() => scrollViewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');
  const scrollBefore = await scrollViewport.evaluate((element) => element.scrollTop);
  const stage = await page.locator('[data-review-stage]').boundingBox();
  if (!stage) throw new Error('Review stage has no bounds.');
  await page.mouse.move(stage.x + 24, stage.y + stage.height / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => scrollViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollBefore);
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');

  await scrollViewport.dispatchEvent('pointerdown', {
    pointerId: 41, pointerType: 'touch', isPrimary: true, button: 0, clientX: 24, clientY: 300,
  });
  const touchScrollLeft = await scrollViewport.evaluate((element) => {
    element.scrollLeft = Math.min(element.scrollLeft + 48, element.scrollWidth - element.clientWidth);
    return element.scrollLeft;
  });
  expect(touchScrollLeft).toBeGreaterThan(0);
  await scrollViewport.dispatchEvent('pointerdown', {
    pointerId: 42, pointerType: 'touch', isPrimary: false, button: 0, clientX: 30, clientY: 300,
  });
  await scrollViewport.dispatchEvent('pointerup', {
    pointerId: 42, pointerType: 'touch', isPrimary: false, button: 0, clientX: 30, clientY: 300,
  });
  await scrollViewport.dispatchEvent('pointerup', {
    pointerId: 41, pointerType: 'touch', isPrimary: true, button: 0, clientX: 24, clientY: 300,
  });
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');

  const dragStart = { x: stage.x + 24, y: stage.y + stage.height / 2 };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x, dragStart.y + 18);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.up();
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');

  await scrollViewport.evaluate((element) => {
    element.dataset.pointerCancels = '0';
    element.addEventListener('pointercancel', () => {
      element.dataset.pointerCancels = String(Number(element.dataset.pointerCancels ?? '0') + 1);
    });
  });
  await page.mouse.click(stage.x + 24, stage.y + stage.height / 2);
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');
  await expect(scrollViewport).toHaveAttribute('data-pointer-cancels', '0');
  await page.getByRole('button', { name: 'Close References tray' }).click();
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'false');
  expect(await scrollViewport.evaluate((element) => element.scrollLeft)).toBeCloseTo(touchScrollLeft, 0);
  expect(host.broker.state(launched.sessionId)?.revision).toBe(0);
});

test('allows PDF text interaction without dismissing the Annotation Tray', async ({ page }) => {
  const launched = await host.open({
    pdfPath: pdf,
    sourceRootPath: sourceRoot,
    surface: 'vscode',
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Fresh tray-dismiss launch failed');
  }
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto(launched.url);
  const pdfPage = page.locator("[data-page-index='0']").first();
  await waitForRenderedPageImage(pdfPage);
  const { workspace: workspaceControl } = await openAnnotationsWorkspace(page);
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-annotation-presentation', 'bottom');

  const box = await pdfPage.boundingBox();
  if (!box) throw new Error('Rendered PDF page has no bounds.');
  await page.mouse.click(box.x + 76, box.y + 98);
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');
  await page.mouse.move(box.x + 245, box.y + 98);
  await page.waitForTimeout(250);
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');
});

test('keeps PDF drag selection available while the Annotation Tray is open', async ({ page }) => {
  const launched = await host.open({
    pdfPath: pdf,
    sourceRootPath: sourceRoot,
    surface: 'vscode',
    fork: true,
  });
  if (!launched.ok || launched.kind === 'recovery-offered') {
    throw new Error('Fresh tray-selection launch failed');
  }
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto(launched.url);
  const pdfPage = page.locator("[data-page-index='0']").first();
  await waitForRenderedPageImage(pdfPage);
  const { workspace: workspaceControl } = await openAnnotationsWorkspace(page);
  await expect(page.locator('[data-review-stage]')).toHaveAttribute('data-annotation-presentation', 'bottom');

  const selectionRects = pdfPage.locator(':scope > div[style*="mix-blend-mode"]');
  const rectCountBeforeDrag = await selectionRects.count();
  const box = await pdfPage.boundingBox();
  if (!box) throw new Error('Rendered PDF page has no bounds.');
  await page.mouse.move(box.x + 76, box.y + 98);
  await page.mouse.down();
  await page.mouse.move(box.x + 245, box.y + 98, { steps: 8 });
  await expect.poll(() => selectionRects.count()).toBeGreaterThan(rectCountBeforeDrag);
  await page.mouse.up();

  await expect.poll(() => selectionRects.count()).toBeGreaterThan(rectCountBeforeDrag);
  const selectionActions = page.getByRole('toolbar', { name: 'Selection review actions' });
  await expect(selectionActions).toBeVisible();
  const overlayOrder = await page.locator('[data-review-stage]').evaluate((stage) => {
    const contextual = stage.querySelector<HTMLElement>('[data-review-contextual-host]');
    const drawerHost = stage.querySelector<HTMLElement>('[data-review-drawer-host]');
    if (!contextual || !drawerHost) throw new Error('Review overlay layers are unavailable.');
    return {
      contextual: Number.parseInt(getComputedStyle(contextual).zIndex, 10),
      drawer: Number.parseInt(getComputedStyle(drawerHost).zIndex, 10),
    };
  });
  expect(overlayOrder.contextual).toBeGreaterThan(overlayOrder.drawer);
  await selectionActions.getByRole('button', { name: 'Highlight', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Highlight comment' })).toBeVisible();
  await expect(workspaceControl).toHaveAttribute('aria-expanded', 'true');
});

test("creates a canonical Page Note from a real PDF context gesture without secondary-activating its mark", async ({ page }) => {
  const launched = await host.open({
    pdfPath: pdf,
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Fresh Page Note production launch failed");
  }
  const browserErrors = collectBrowserErrors(page);
  await page.goto(launched.url);

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await expect(page.getByLabel("Current page")).toHaveText("1 / 1");
  await waitForRenderedPageImage(pageCanvas);
  const canvasBox = await pageCanvas.boundingBox();
  if (!canvasBox) throw new Error("Rendered PDF page has no bounds.");
  const scale = canvasBox.width / 612;
  const point = { x: 500 * scale, y: 600 * scale };

  await pageCanvas.click({ button: "right", position: point });
  const addPageNote = page.getByRole("menuitem", { name: "Add Page Note" });
  await expect(addPageNote).toBeVisible();
  await expect(addPageNote).toBeFocused();
  await addPageNote.click();

  const composer = page.getByRole("dialog", { name: "Page Note" });
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox", { name: "Comment" }).fill("Check the conclusion.");
  await composer.getByRole("button", { name: "Save comment" }).click();

  await expect.poll(() => host.broker.state(launched.sessionId)?.revision).toBe(1);
  const state = host.broker.state(launched.sessionId);
  expect(state?.revision).toBe(1);
  expect(state?.items).toHaveLength(1);
  const note = state?.items[0];
  expect(note).toMatchObject({
    kind: "pageNote",
    pageIndex: 0,
    payload: {
      comment: "Check the conclusion.",
      position: { width: 18, height: 18 },
    },
  });
  const position = note?.payload.position;
  expect(position).toMatchObject({ x: 500, y: 1392, width: 18, height: 18 });
  expect(note?.id).toBeTruthy();
  const mark = page.locator(`[data-owned-mark="pageNote"][data-review-id="${note!.id}"]`);
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveAttribute("data-active", "false");

  const markBox = await mark.boundingBox();
  if (!markBox) throw new Error("Rendered Page Note mark has no bounds.");
  await page.mouse.click(markBox.x + markBox.width / 2, markBox.y + markBox.height / 2, {
    button: "right",
  });
  await expect(page.getByRole("menu", { name: "Page actions" })).toHaveCount(0);
  await expect(mark).toHaveAttribute("data-active", "false");
  await expect(page.locator('[data-workspace-edge-rail][aria-expanded="true"]')).toHaveCount(0);
  expect(host.broker.state(launched.sessionId)?.revision).toBe(1);
  expect(browserErrors).toEqual([]);
});

test("places a canonical Page Note through the real PDF keyboard cursor", async ({ page }) => {
  const launched = await host.open({
    pdfPath: pdf,
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Fresh keyboard Page Note production launch failed");
  }
  const browserErrors = collectBrowserErrors(page);
  await page.goto(launched.url);

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await expect(page.getByLabel("Current page")).toHaveText("1 / 1");
  await waitForRenderedPageImage(pageCanvas);
  await pageCanvas.focus();
  await page.keyboard.press("Alt+Shift+N");
  const cursor = page.getByRole("button", { name: /^Page Note placement cursor/u });
  await expect(cursor).toBeVisible();
  await expect(cursor).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  const composer = page.getByRole("dialog", { name: "Page Note" });
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox", { name: "Comment" }).fill("Keyboard-placed note.");
  await composer.getByRole("button", { name: "Save comment" }).click();

  await expect.poll(() => host.broker.state(launched.sessionId)?.revision).toBe(1);
  const state = host.broker.state(launched.sessionId);
  expect(state?.revision).toBe(1);
  expect(state?.items).toHaveLength(1);
  const note = state?.items[0];
  expect(note).toMatchObject({
    kind: "pageNote",
    pageIndex: 0,
    payload: {
      comment: "Keyboard-placed note.",
      position: { x: 310, y: 1192, width: 18, height: 18 },
    },
  });
  expect(note?.id).toBeTruthy();
  await expect(page.locator(
    `[data-owned-mark="pageNote"][data-review-id="${note!.id}"]`,
  )).toHaveCount(1);
  expect(browserErrors).toEqual([]);
});

test("normalizes a real context gesture on a rotated cropped PDF into canonical page space", async ({ page }) => {
  const launched = await host.open({
    pdfPath: rotatedPdf,
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Rotated Page Note production launch failed");
  }
  const browserErrors = collectBrowserErrors(page);
  await page.goto(launched.url);

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await expect(page.getByLabel("Current page")).toHaveText("1 / 1");
  await waitForRenderedPageImage(pageCanvas);
  const canvasBox = await pageCanvas.boundingBox();
  if (!canvasBox) throw new Error("Rendered rotated PDF page has no bounds.");
  const scale = canvasBox.width / 720;

  await pageCanvas.click({
    button: "right",
    position: { x: 300 * scale, y: 200 * scale },
  });
  await page.getByRole("menuitem", { name: "Add Page Note" }).click();
  const composer = page.getByRole("dialog", { name: "Page Note" });
  await composer.getByRole("textbox", { name: "Comment" }).fill("Rotated geometry note.");
  await composer.getByRole("button", { name: "Save comment" }).click();

  await expect.poll(() => host.broker.state(launched.sessionId)?.revision).toBe(1);
  const state = host.broker.state(launched.sessionId);
  expect(state?.items).toHaveLength(1);
  const note = state?.items[0];
  expect(note).toMatchObject({
    kind: "pageNote",
    pageIndex: 0,
    payload: {
      comment: "Rotated geometry note.",
      position: { x: 236, y: 1176, width: 18, height: 18 },
    },
  });
  expect(note?.id).toBeTruthy();
  await expect(page.locator(
    `[data-owned-mark="pageNote"][data-review-id="${note!.id}"]`,
  )).toHaveCount(1);
  expect(browserErrors).toEqual([]);
});

for (const key of ["Delete", "Backspace"] as const) {
  test(`a fresh real selection queues exactly one ${key} command while capture is pending`, async ({ page }) => {
    const launched = await host.open({
      pdfPath: pdf,
      sourceRootPath: sourceRoot,
      fork: true,
    });
    if (!launched.ok || launched.kind === "recovery-offered") {
      throw new Error(`Fresh ${key} production launch failed`);
    }
    const browserErrors = collectBrowserErrors(page);
    await installSelectionCaptureGate(page);
    await page.goto(launched.url);

    const pageCanvas = page.locator("[data-page-index='0']").first();
    await expect(pageCanvas).toBeVisible();
    await waitForRenderedPageImage(pageCanvas);
    await dragPdfPhrase(page, pageCanvas, { x: 253, y: 98 }, { x: 405, y: 98 });
    await expect(pageCanvas).toBeFocused();
    await expect(page.getByRole("alert")).toContainText("Reading the selected text");
    const urlBeforeKey = page.url();
    await page.keyboard.press(key);
    await releaseSelectionCapture(page);

    await expect(page.locator("[data-review-item]")).toHaveCount(1);
    await expect(page.locator("[data-owned-mark='delete']")).toHaveCount(1);
    expect(page.url()).toBe(urlBeforeKey);
    const state = host.broker.state(launched.sessionId);
    expect(state?.revision).toBe(1);
    expect(state?.items).toHaveLength(1);
    expect(state?.items[0]).toMatchObject({
      kind: "delete",
      pageIndex: 0,
      payload: {
        quote: "unique equilibrium clearly",
        reliable: true,
      },
    });
    const segments = state?.items[0]?.payload.segmentRects;
    expect(Array.isArray(segments)).toBe(true);
    expect(state?.items[0]?.payload.rect).toEqual(
      Array.isArray(segments) ? segments[0] : undefined,
    );
    expect(state?.items[0]?.payload.rect).toEqual({
      x: 248,
      y: 881,
      width: 158,
      height: 16,
    });
    expect(browserErrors).toEqual([]);
  });
}

test("discards queued typing when a pending selection is cleared", async ({ page }) => {
  const launched = await host.open({
    pdfPath: pdf,
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Fresh pending-clear production launch failed");
  }
  await installSelectionCaptureGate(page);
  await page.goto(launched.url);

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await waitForRenderedPageImage(pageCanvas);
  await dragPdfPhrase(page, pageCanvas, { x: 76, y: 98 }, { x: 245, y: 98 });
  await expect(page.getByRole("alert")).toContainText("Reading the selected text");
  await page.keyboard.type("discard me");

  await pageCanvas.click({ position: { x: 500, y: 300 } });
  await releaseSelectionCapture(page);

  await expect(page.getByRole("dialog", { name: "Replacement text" })).toHaveCount(0);
  await expect(page.locator("[data-review-item]")).toHaveCount(0);
  expect(host.broker.state(launched.sessionId)?.revision).toBe(0);
});

test("keeps only typing for the newest pending selection", async ({ page }) => {
  const launched = await host.open({
    pdfPath: pdf,
    sourceRootPath: sourceRoot,
    fork: true,
  });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Fresh pending-supersession production launch failed");
  }
  await installSelectionCaptureGate(page);
  await page.goto(launched.url);

  const pageCanvas = page.locator("[data-page-index='0']").first();
  await expect(pageCanvas).toBeVisible();
  await waitForRenderedPageImage(pageCanvas);
  await dragPdfPhrase(page, pageCanvas, { x: 76, y: 98 }, { x: 245, y: 98 });
  await expect(page.getByRole("alert")).toContainText("Reading the selected text");
  await page.keyboard.type("obsolete");

  await dragPdfPhrase(page, pageCanvas, { x: 253, y: 98 }, { x: 405, y: 98 });
  await page.keyboard.type("current");
  await releaseSelectionCapture(page);

  const replacementDialog = page.getByRole("dialog", { name: "Replacement text" });
  await expect(replacementDialog).toBeVisible();
  await expect(replacementDialog.getByRole("textbox", { name: "Replacement text" })).toHaveValue("current");
  await replacementDialog.getByRole("button", { name: "Apply" }).click();
  await expect(replacementDialog).toHaveCount(0);
  await expect(page.locator("[data-review-item]")).toHaveCount(1);
  const state = host.broker.state(launched.sessionId);
  expect(state?.revision).toBe(1);
  expect(state?.items).toHaveLength(1);
  expect(state?.items[0]).toMatchObject({
    kind: "replace",
    payload: {
      proposedText: "current",
    },
  });
  expect(state?.items[0]?.payload.quote).not.toBe("");
});
