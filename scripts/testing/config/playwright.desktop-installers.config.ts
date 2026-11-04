import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../../../test/acceptance',
  testMatch: ['desktop-installers.spec.ts'],
  outputDir: fileURLToPath(new URL('../../../test-results/desktop-installers', import.meta.url)),
  workers: 1,
  retries: 0,
  reporter: 'list',
});
