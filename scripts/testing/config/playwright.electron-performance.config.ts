import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../../../test/acceptance',
  testMatch: ['electron-performance.spec.ts', 'electron-responsiveness.spec.ts'],
  timeout: 30 * 60_000,
  outputDir: fileURLToPath(new URL('../../../test-results/electron-performance', import.meta.url)),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
});
