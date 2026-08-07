import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    browserName: "webkit",
    headless: true,
    viewport: { width: 760, height: 900 },
  },
});
