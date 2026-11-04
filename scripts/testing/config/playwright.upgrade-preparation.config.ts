import { defineConfig } from '@playwright/test';
import { browserDefaults, browserUseDefaults } from '../browser-config';
export default defineConfig({
  ...browserDefaults, testDir: '../../../test',
  testMatch: ['acceptance/upgrade-preparation.spec.ts'],
  use: { ...browserUseDefaults, browserName: 'chromium' },
});
