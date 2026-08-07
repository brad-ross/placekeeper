import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    deliveryHarness: {
      addFeedback(): void;
      resolveSave(): void;
      resolveReplace(): void;
      replaceCalls(): number;
    };
  }
}

test.describe("human delivery controls", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/test/acceptance/delivery-harness/index.html");
  });

  test("explains and disables empty delivery while keeping lifecycle actions available", async ({ page }) => {
    const save = page.getByRole("button", { name: "Save reviewed copy" });
    const replace = page.getByRole("button", { name: "Replace Original…" });
    await expect(save).toBeDisabled();
    await expect(replace).toBeDisabled();
    await expect(save).toHaveAttribute("aria-describedby", "delivery-disabled-reason");
    await expect(replace).toHaveAttribute("aria-describedby", "delivery-disabled-reason");
    await expect(page.locator("#delivery-disabled-reason")).toContainText(
      "Human and Codex delivery are unavailable",
    );
    await expect(page.getByRole("button", { name: "Finish review" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Discard review" })).toBeEnabled();
  });

  test("does not report save success before completion and confirms replacement explicitly", async ({ page }) => {
    await page.evaluate(() => window.deliveryHarness.addFeedback());
    const save = page.getByRole("button", { name: "Save reviewed copy" });
    await save.click();
    await expect(page.getByRole("button", { name: "Saving reviewed copy…" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Finish review" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Discard review" })).toBeEnabled();
    await expect(page.getByRole("status")).toHaveCount(0);
    await page.evaluate(() => window.deliveryHarness.resolveSave());
    await expect(page.getByRole("status")).toContainText("paper-reviewed.pdf");

    await page.getByRole("button", { name: "Replace Original…" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    expect(await page.evaluate(() => window.deliveryHarness.replaceCalls())).toBe(0);
    await page.getByRole("button", { name: "Confirm Replace Original" }).click();
    await expect(page.getByRole("button", { name: "Finish review" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Discard review" })).toBeEnabled();
    expect(await page.evaluate(() => window.deliveryHarness.replaceCalls())).toBe(1);
    await page.evaluate(() => window.deliveryHarness.resolveReplace());
    await expect(page.getByRole("status")).toContainText("Original explicitly replaced");
  });
});
