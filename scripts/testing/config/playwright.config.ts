import { defineConfig } from '@playwright/test';
import { browserDefaults, browserUseDefaults, serverDefaults, browserTestOrigin, browserTestServerCommand } from '../browser-config';
import { browserTestFiles } from '../suites';

export default defineConfig({
  ...browserDefaults,
  testDir: '../../../test',
  testMatch: browserTestFiles.default,
  use: {
    ...browserUseDefaults,
    baseURL: browserTestOrigin,
    browserName: 'chromium',
  },
  webServer: {
    command: browserTestServerCommand,
    url: `${browserTestOrigin}/test/conformance/viewer-harness/index.html`,
    ...serverDefaults,
  },
});
