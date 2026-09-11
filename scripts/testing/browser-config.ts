import type { PlaywrightTestConfig } from "@playwright/test";

/** Shared scheduling and diagnostics only; each profile owns its host policy. */
export const browserDefaults = {
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  outputDir: 'test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
} satisfies PlaywrightTestConfig;

export const browserUseDefaults = {
  headless: true,
  trace: 'retain-on-failure',
  screenshot: 'only-on-failure',
} satisfies PlaywrightTestConfig['use'];

export const serverDefaults = {
  reuseExistingServer: false,
  timeout: 30_000,
};
