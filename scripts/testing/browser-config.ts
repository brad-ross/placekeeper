import { fileURLToPath } from "node:url";
import type { PlaywrightTestConfig } from "@playwright/test";

/** Shared scheduling and diagnostics only; each profile owns its host policy. */
export const browserDefaults = {
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  outputDir: fileURLToPath(new URL('../../test-results', import.meta.url)),
  reporter: [['list'], ['html', { outputFolder: fileURLToPath(new URL('../../playwright-report', import.meta.url)), open: 'never' }]],
} satisfies PlaywrightTestConfig;

export const browserUseDefaults = {
  headless: true,
  trace: 'retain-on-failure',
  screenshot: 'only-on-failure',
} satisfies PlaywrightTestConfig['use'];

export const serverDefaults = {
  cwd: fileURLToPath(new URL('../../', import.meta.url)),
  reuseExistingServer: false,
  timeout: 30_000,
};
