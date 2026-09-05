import type { Page } from "@playwright/test";

export async function waitForStaticPdf(page: Page): Promise<void> {
  await page.locator("[data-production-review][data-launch-surface='static']")
    .waitFor({ state: "visible" });
  const image = page.locator("[data-page-index='0'] > img").first();
  await image.waitFor({ state: "visible" });
  const imageHandle = await image.elementHandle();
  if (imageHandle === null) throw new Error("Rendered PDF image disappeared before verification.");
  await page.waitForFunction((element) => (
    element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
  ), imageHandle);
}

export async function addStaticKeyboardPageNote(page: Page, comment: string): Promise<void> {
  await page.locator("[data-page-index='0']").first().focus();
  await page.keyboard.press("Alt+Shift+N");
  const cursor = page.getByRole("button", { name: /^Page Note placement cursor/u });
  await cursor.waitFor({ state: "visible" });
  if (!await cursor.evaluate((element) => element === document.activeElement)) {
    throw new Error("Keyboard Page Note placement did not receive focus.");
  }
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  const composer = page.getByRole("region", { name: "Page Note" });
  await composer.getByRole("textbox", { name: "Comment" }).fill(comment);
  await composer.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("[data-owned-mark='pageNote']").waitFor({ state: "visible" });
}
