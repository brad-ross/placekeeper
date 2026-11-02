import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../../../test/acceptance',
  testMatch: ['windows-save-lock.spec.ts', 'desktop-service-rollback.spec.ts'],
  outputDir: fileURLToPath(new URL('../../../test-results/desktop-platform', import.meta.url)),
  workers: 1,
  retries: 0,
  reporter: 'list',
});
