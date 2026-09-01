import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const fullSuiteSteps = [
  'Install Playwright browsers and system dependencies',
  'Generate PDF fixtures',
  'Run canonical unit tests',
  'Build web distribution',
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
  it('runs the full CI suite when dispatched manually', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('workflow_dispatch:');
    for (const stepName of fullSuiteSteps) {
      expect(stepBlock(workflow, stepName)).not.toContain(
        "if: github.event_name == 'pull_request'",
      );
    }
  });
});
