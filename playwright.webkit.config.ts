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
    baseURL: "http://127.0.0.1:4173",
  },
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/test/acceptance/review-harness/index.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
