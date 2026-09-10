import { defineConfig } from "@playwright/test";
import { browserDefaults } from './scripts/testing/browser-config';
import { browserTestFiles } from './scripts/testing/suites';

export default defineConfig({
  ...browserDefaults,
  testDir: "./test/acceptance",
  testMatch: browserTestFiles.chromeHandoff,
  outputDir: "test-results/chrome-pdf-handoff",
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
