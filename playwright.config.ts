import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: 'chrome',
    headless: true,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/test/conformance/viewer-harness/index.html',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
