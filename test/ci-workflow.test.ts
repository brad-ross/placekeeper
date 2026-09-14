import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { suites, suiteCommand, ciUnitFiles } from '../scripts/testing/suites';

const fullSuiteSteps = [
  'Install Playwright browsers and system dependencies',
  'Generate PDF fixtures',
  'Build shared client distributions',
  'Run canonical unit tests',
  'Run Chromium acceptance tests',
  'Run WebKit acceptance tests',
  'Run visual regression tests',
  'Validate distribution manifest',
] as const;

function stepBlock(workflow: string, stepName: string): string {
  const start = workflow.indexOf(`      - name: ${stepName}`);
  expect(start, `missing CI step: ${stepName}`).toBeGreaterThanOrEqual(0);
  const next = workflow.indexOf('\n      - name:', start + 1);
  return workflow.slice(start, next === -1 ? workflow.length : next);
}

describe('manual CI workflow', () => {
  it('builds shared web assets before packaging tests enter the canonical unit suite', async () => {
    const packageManifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageManifest.scripts?.['test:ci:unit']).toBe(
      'node --import tsx scripts/testing/run-suite.ts test:ci:unit',
    );
    expect(suites['test:ci:unit']?.[0]).toBe('pnpm build:vscode');
    expect(suiteCommand('test:ci:unit')).toBe('pnpm build:vscode && vitest run --config scripts/testing/config/vitest.ci.config.ts');
    expect(ciUnitFiles).toContain('packaging/macos/update-vscode.test.mjs');
  });

  it('runs the full CI suite when dispatched manually', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('workflow_dispatch:');
    expect(stepBlock(workflow, 'Build shared client distributions')).toMatch(/run: pnpm build\s*$/u);
    expect(workflow.indexOf('- name: Build shared client distributions')).toBeLessThan(
      workflow.indexOf('- name: Run canonical unit tests'),
    );
    for (const stepName of fullSuiteSteps) {
      expect(stepBlock(workflow, stepName)).not.toContain(
        "if: github.event_name == 'pull_request'",
      );
    }
  });
});
