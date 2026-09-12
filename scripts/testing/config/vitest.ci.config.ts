import { defineConfig } from 'vitest/config';
import { ciUnitFiles } from '../suites';

export default defineConfig({ test: { include: ciUnitFiles } });
