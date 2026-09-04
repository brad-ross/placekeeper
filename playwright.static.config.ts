import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/acceptance",
  testMatch: "static-web.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  outputDir: "test-results/static-web",
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4174",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec vite preview --config apps/web/vite.static.config.ts --host 127.0.0.1 --port 4174",
    url: "http://127.0.0.1:4174/",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
