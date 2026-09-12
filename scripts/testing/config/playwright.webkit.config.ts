import { defineConfig } from "@playwright/test";
import { browserDefaults, browserUseDefaults, serverDefaults } from '../browser-config';

export default defineConfig({
  ...browserDefaults,
  testDir: "../../../test",
  use: {
    ...browserUseDefaults,
    browserName: "webkit",
    viewport: { width: 760, height: 900 },
    baseURL: "http://127.0.0.1:4173",
  },
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/test/acceptance/review-harness/index.html",
    ...serverDefaults,
  },
});
