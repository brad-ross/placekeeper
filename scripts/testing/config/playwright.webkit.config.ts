import { defineConfig } from "@playwright/test";
import { browserDefaults, browserUseDefaults, serverDefaults, browserTestOrigin, browserTestServerCommand } from '../browser-config';

export default defineConfig({
  ...browserDefaults,
  testDir: "../../../test",
  use: {
    ...browserUseDefaults,
    browserName: "webkit",
    viewport: { width: 760, height: 900 },
    baseURL: browserTestOrigin,
  },
  webServer: {
    command: browserTestServerCommand,
    url: `${browserTestOrigin}/test/acceptance/review-harness/index.html`,
    ...serverDefaults,
  },
});
