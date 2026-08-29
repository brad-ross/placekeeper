import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/acceptance",
  testMatch: "chrome-pdf-handoff.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  outputDir: "test-results/chrome-pdf-handoff",
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
