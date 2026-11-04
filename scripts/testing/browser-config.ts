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

const testPort = Number(process.env.PLACEKEEPER_BROWSER_TEST_PORT ?? '4173');
if (!Number.isInteger(testPort) || testPort < 1024 || testPort > 65535) {
  throw new Error('PLACEKEEPER_BROWSER_TEST_PORT must be an unprivileged TCP port.');
}
export const browserTestOrigin = `http://127.0.0.1:${testPort}`;
export const browserTestServerCommand = `pnpm exec vite --host 127.0.0.1 --port ${testPort} --strictPort`;
