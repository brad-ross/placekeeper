---
title: Run the real acceptance suites locally while CI is manual-only
date: 2026-09-26
category: workflow-issues
module: Browser acceptance suites and CI gating
problem_type: workflow_issue
component: testing_framework
severity: high
applies_when:
  - Changing apps/web behaviour while the browser acceptance workflow runs only on manual dispatch
  - A pull request shows only the static web check green
  - Triaging a batch of acceptance failures after the suite has gone unrun for a while
  - Running Playwright acceptance specs locally before shipping a UI change
symptoms:
  - About forty acceptance tests failed with no pull-request signal
  - Several failures reproduced on main as well as on the branch
  - Running the acceptance Playwright config without its file list reported many more failures than the real suite
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - development_workflow
  - tooling
tags: [ci, playwright, acceptance-tests, workflow-dispatch, test-drift, local-verification, e2e]
---

# Run the real acceptance suites locally while CI is manual-only

## Context

`.github/workflows/ci.yml` is the only workflow that runs the browser acceptance and visual suites (`pnpm test:ci:unit`, `test:ci:chromium`, `test:ci:webkit`, `test:ci:visual`). Its trigger is currently manual:

```yaml
# Temporarily manual-only. Restore the pull_request and push triggers to re-enable CI.
on:
  workflow_dispatch:
```

(`.github/workflows/ci.yml:3-5`). Pull requests run only `.github/workflows/static-web.yml`, the bounded static gate (`pnpm test:static:pr`) against the built static site. A green pull request therefore says nothing about the Chromium, WebKit, or visual acceptance specs.

The last manual `ci.yml` runs were on 2026-09-14. Later merges changed behaviour those specs encoded, and nothing ran them:

- #117 (merged 2026-09-18) moved reattachment into the full annotation reader, so specs still expected the old headings and a "Needs attention" region. It also added an interaction-owner `claim-owner` step to the Chrome native handshake. The host-interface spec's mocked native port never answered it, and its mocked `chrome-runtime` module lacked the new owner-claim export, so the handler stalled at "Opening this PDF in Placekeeper…".
- #121 (merged 2026-09-18) kept References usable while an annotation is being edited. A spec still expected the References tray to go inert.

Running the real suite for PR #130 (open as of this writing) surfaced about forty failures in this session's local runs. Some came from that branch, and many already failed on `main`. After the specs caught up, the full `test:e2e` list passed 350/350.

## Guidance

**Check whether CI actually ran.** Before trusting the acceptance suite's history, read `ci.yml`'s `on:` block and `gh run list --workflow ci.yml --limit 5`, then compare the last run date with PRs merged since (`gh pr view <n> --json mergedAt`). You can also start `ci.yml` by hand with `workflow_dispatch`.

**Run suites the way their definitions do.** `scripts/testing/suites.ts` pins each suite's Playwright config and an explicit spec list (`test:e2e` at `scripts/testing/suites.ts:322`, `test:ci:chromium` at `:479`). Run them through `pnpm test:e2e` or `pnpm test:ci:chromium`, or reproduce the same config plus file list. Pointing Playwright at `scripts/testing/config/playwright.config.ts` without the list sweeps in static and visual specs that belong to other configs. An early run for PR #130 reported 79 failures that way. Visual specs use `playwright.visual.config.ts`, and their baselines are Linux-only. Static specs use `playwright.static.config.ts`.

**Build what the specs read.** Production specs load built assets:

- `dist/web` comes from `pnpm build:web` (`vite build --config apps/web/vite.production.config.ts`).
- The packaged-runtime bootstrap test reads `dist/macos-web/assets/shell.js` (`test/acceptance/production-flow.spec.ts:559`), built by `pnpm build:macos:web`.
- `test:e2e` itself runs `pnpm build:vscode` first.

Stale or missing builds produce failures that look like regressions.

**Leave the dev server alone during a run.** The acceptance config's `webServer` is a live `vite` dev server on 127.0.0.1:4173 serving source (`scripts/testing/config/playwright.config.ts:14-16`). Editing `apps/web` mid-run changes what the harness tests see. A broad `pkill -f "vite --host 127.0.0.1 --port 4173"` to stop an ad-hoc probe server also kills the suite's server and fails every later test. Run probes on another port, or wait for the suite to finish.

**Baseline against `main`, then read the merging PR.** For each failure, check whether it also fails on `main`. If it does, find the PR that changed the behaviour and read its intent before touching the spec:

- Update the spec when the change was deliberate (#121's usable References tray).
- Fix the product when it was not. #117 had also dropped the text around an insertion's or page note's old location from the reattach view. That was restored in PR #130 rather than asserted away.

## Why This Matters

A gate that stops running announces nothing. Pull requests keep merging on the narrower check, and the acceptance suite's failures compound with no per-PR signal of which change caused which. Whoever runs the suite next inherits every drift at once. They can easily blame their own branch, chase failures that are older than it, or "fix" a test by encoding a regression.

## When to Apply

- Before shipping any change under `apps/web` while `ci.yml` has no `pull_request` trigger.
- When acceptance failures appear in bulk after a quiet period.
- When deciding whether a failing spec or the product is wrong.

Restoring the `pull_request` and `push` triggers in `ci.yml` removes the need for most of this. The plan that designed that workflow still describes per-PR runs (`docs/plans/2026-08-12-002-chore-reduce-github-actions-minutes-plan.md`).

## Examples

A faithful local run of the Chromium acceptance suite:

```bash
pnpm build:web
pnpm build:macos:web
pnpm test:e2e
```

Pointing Playwright at the acceptance config alone, without the suite's file list, is the failure-inflating variant to avoid:

```bash
pnpm exec playwright test --config scripts/testing/config/playwright.config.ts
```

## Related

- [Prove temporal UI stability across stateful lifecycle seams](./prove-temporal-ui-stability-across-stateful-lifecycle-seams.md)
- [Prove CSS extraction equivalence with failing visual baselines](./prove-css-extraction-equivalence-with-failing-visual-baselines.md)
- [Press Enter or hover the row, not focus-then-click, for hidden row actions](../test-failures/playwright-focus-then-click-hidden-row-actions.md): one of the drift fixes found in the same catch-up.
