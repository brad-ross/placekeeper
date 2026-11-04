import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../../../test/acceptance',
  testMatch: ['desktop-installers.spec.ts', 'legacy-0.2.4-upgrade.spec.ts', 'desktop-debian.spec.ts'],
  outputDir: fileURLToPath(new URL('../../../test-results/desktop-installers', import.meta.url)),
  use: { actionTimeout:15_000, trace:'retain-on-failure', screenshot:'only-on-failure' },
  workers: 1,
  retries: 0,
  reporter: 'list',
});
