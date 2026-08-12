import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    codexHarness: {
      reset(): void;
      changeRetention(): void;
      makeEmpty(): void;
      prepared(): number;
      saved(): number;
      open(): void;
      close(): void;
      holdPrepare(): void;
      resolvePrepare(): void;
    };
  }
}

test.describe("manual Codex delivery phases", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) },
      });
    });
  });

  test("confirms changed scope, preserves a selectable prompt on clipboard denial, and checks user-selected results", async ({ page }) => {
    const requestedUrls: string[] = [];
    const mutationRequests: string[] = [];
    page.on("request", (request) => {
      requestedUrls.push(request.url());
      if (request.method() !== "GET") mutationRequests.push(`${request.method()} ${request.url()}`);
    });
    await page.goto("/test/acceptance/codex-harness/index.html");
    const localOrigin = new URL(page.url()).origin;
    const externalRequests = () => requestedUrls.filter((url) => new URL(url).origin !== localOrigin);
    await page.getByRole("button", { name: "Prepare Codex handoff" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    expect(externalRequests()).toEqual([]);
    expect(mutationRequests).toEqual([]);
    expect(await page.evaluate(() => window.codexHarness.prepared())).toBe(0);
    await page.getByRole("button", { name: "Confirm and prepare" }).click();
    await expect(page.getByText("Ready —", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Ready-to-paste instruction")).toHaveValue("Full local instruction");

    await page.getByRole("button", { name: "Close Codex options" }).click();
    await expect(page.locator("[data-codex-drawer]")).toHaveAttribute("aria-hidden", "true");
    await page.getByRole("button", { name: "Open Codex" }).click();
    await expect(page.locator("[data-codex-drawer]")).toHaveAttribute("aria-hidden", "false");
    await expect(page.getByText("Ready —", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Ready-to-paste instruction")).toHaveValue("Full local instruction");

    await page.getByRole("button", { name: "Copy instruction" }).click();
    await expect(page.getByRole("status")).toContainText("Clipboard access was denied");
    await expect(page.getByLabel("Ready-to-paste instruction")).toBeVisible();
    await page.getByRole("button", { name: "Save instruction" }).click();
    expect(await page.evaluate(() => window.codexHarness.saved())).toBe(1);

    await page.getByRole("button", { name: "Continue to Result" }).click();
    await page.getByLabel("Returned disposition JSON").setInputFiles({ name: "disposition.json", mimeType: "application/json", buffer: Buffer.from("{}") });
    await page.getByLabel("Revised PDF, if the build succeeded").setInputFiles({ name: "paper-revised.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") });
    await page.getByRole("button", { name: "Check Result" }).click();
    await expect(page.getByRole("status")).toContainText("Complete: Exact IDs, digests, changed paths, and clean output verified");
    await page.evaluate(() => window.codexHarness.close());
    await page.evaluate(() => window.codexHarness.open());
    await expect(page.getByLabel("Returned disposition JSON")).toHaveValue(/disposition\.json/u);
    await expect(page.getByRole("status")).toContainText("Complete: Exact IDs, digests, changed paths, and clean output verified");

    await page.evaluate(() => window.codexHarness.reset());
    await page.getByRole("button", { name: "Prepare Codex handoff" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByText("Ready —", { exact: false })).toBeVisible();
    await page.evaluate(() => window.codexHarness.changeRetention());
    await page.getByRole("button", { name: "Prepare Codex handoff" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    expect(externalRequests()).toEqual([]);
    expect(mutationRequests).toEqual([]);
  });

  test("disables Codex delivery for an empty canonical annotation set", async ({ page }) => {
    await page.goto("/test/acceptance/codex-harness/index.html");
    await page.evaluate(() => window.codexHarness.makeEmpty());
    await expect(page.getByRole("button", { name: "Prepare Codex handoff" })).toBeDisabled();
    await expect(page.getByText("There are no annotations to hand off", { exact: false })).toBeVisible();
  });

  test("contains focus while confirmation controls are disabled during preparation", async ({ page }) => {
    await page.goto("/test/acceptance/codex-harness/index.html");
    await page.evaluate(() => window.codexHarness.holdPrepare());
    await page.getByRole("button", { name: "Prepare Codex handoff" }).click();

    const confirmation = page.getByRole("alertdialog", {
      name: "Confirm this external data flow",
    });
    await confirmation.getByRole("button", { name: "Confirm and prepare" }).click();
    await expect(confirmation.getByRole("button", { name: "Confirm and prepare" })).toBeDisabled();
    await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(confirmation).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(confirmation).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(confirmation).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toBeFocused();

    await page.evaluate(() => window.codexHarness.resolvePrepare());
    await expect(page.getByText("Ready —", { exact: false })).toBeVisible();
  });
});
