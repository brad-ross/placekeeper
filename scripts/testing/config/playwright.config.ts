import { defineConfig } from '@playwright/test';
import { browserDefaults, browserUseDefaults, serverDefaults } from '../browser-config';
import { browserTestFiles } from '../suites';

export default defineConfig({
  ...browserDefaults,
  testDir: '../../../test',
  testMatch: browserTestFiles.default,
  use: {
    ...browserUseDefaults,
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
  },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/test/conformance/viewer-harness/index.html',
    ...serverDefaults,
  },
});
