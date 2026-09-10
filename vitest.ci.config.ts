import { defineConfig } from 'vitest/config';
import { ciUnitFiles } from './scripts/testing/suites';

export default defineConfig({ test: { include: ciUnitFiles } });
