import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

import { PlacekeeperHost } from "../../apps/service/src/host/placekeeper-host.js";

let root = "";
let pdf = "";
let host: PlacekeeperHost;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "placekeeper-reloadable-links-"));
  pdf = join(root, "Paper One.pdf");
  await copyFile(resolve("test/fixtures/pdfs/text-native-with-annotations.pdf"), pdf);
  host = await PlacekeeperHost.start({
    recoveryRoot: join(root, "recovery"),
    webAssets: { root: resolve("dist/web") },
  });
});

test.afterAll(async () => {
  await host?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

test("a live readable review survives repeated hard refresh and fails closed after session end", async ({ page }) => {
  const launched = await host.open({ pdfPath: pdf, surface: "browser", fork: true });
  if (!launched.ok || launched.kind === "recovery-offered") {
    throw new Error("Expected a live browser launch");
  }

  await page.goto(launched.url);
  await expect(page).toHaveURL(new RegExp(`/r/[0-9a-f-]{36}/.+Paper%20One\\.pdf#v=1&page=1$`, "u"));
  await expect(page.locator("#root")).toHaveAttribute("data-production-root", "true");
  expect(page.url()).not.toContain("cap=");

  const readableUrl = page.url();
  for (let refresh = 0; refresh < 2; refresh += 1) {
    await page.reload();
    await expect(page).toHaveURL(readableUrl);
    await expect(page.locator("#root")).toHaveAttribute("data-production-root", "true");
  }

  await host.broker.finish(launched.sessionId);
  await page.reload();
  await expect(page.getByText("This live review is no longer available.")).toBeVisible();
  const reopen = page.getByRole("link", { name: "Reopen in Placekeeper" });
  await expect(reopen).toHaveAttribute(
    "href",
    new RegExp(`^placekeeper:///.*Paper%20One\\.pdf#v=1&page=1$`, "u"),
  );
});
