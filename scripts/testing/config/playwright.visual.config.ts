import { defineConfig } from '@playwright/test';
import { browserDefaults, browserUseDefaults, serverDefaults } from '../browser-config';
import { browserTestFiles } from '../suites';

const baseURL = 'http://127.0.0.1:4175';

export default defineConfig({
  ...browserDefaults,
  testDir: '../../../test/acceptance',
  testMatch: browserTestFiles.visual,
  expect: { timeout: 5_000 },
  use: {
    ...browserUseDefaults,
    baseURL,
    browserName: 'chromium',
    deviceScaleFactor: 1,
    locale: 'en-US',
    colorScheme: 'light',
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4175',
    url: `${baseURL}/test/acceptance/review-harness/index.html`,
    ...serverDefaults,
  },
});
