import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4175';

export default defineConfig({
  testDir: './test/acceptance',
  testMatch: 'review-visual.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    deviceScaleFactor: 1,
    locale: 'en-US',
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4175',
    url: `${baseURL}/test/acceptance/review-harness/index.html`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
