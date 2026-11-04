import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../../../test/acceptance',
  testMatch: ['electron-installed.spec.ts', 'electron-lifecycle.spec.ts', 'electron-restoration.spec.ts', 'electron-review-workflow.spec.ts', 'electron-launcher.spec.ts', 'electron-focused-link.spec.ts', 'electron-synctex.spec.ts', 'electron-upgrade-preparation.spec.ts'],
  timeout: 60_000,
  outputDir: fileURLToPath(new URL('../../../test-results/electron-installed', import.meta.url)),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
});
