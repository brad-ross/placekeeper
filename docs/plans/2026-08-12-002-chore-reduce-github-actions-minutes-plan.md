---
title: Reduce GitHub Actions CI Minute Usage - Plan
type: chore
date: 2026-08-12
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Reduce GitHub Actions CI Minute Usage - Plan

## Goal Capsule

- **Objective:** Cut routine GitHub Actions consumption by moving ordinary validation off billed macOS runners, canceling obsolete work, and running each proof once without dropping meaningful Linux, Chromium, WebKit, visual, packaging, or release evidence.
- **Authority:** The user's approved CI-cost proposals and the Product Contract below govern this change. Existing test semantics and the manual signed-release workflow remain authoritative.
- **Execution profile:** One workflow-and-test-orchestration migration with a pinned Linux visual-baseline transition and a small macOS release adaptation.
- **Stop conditions:** Stop if the canonical PR gate cannot run on Linux without removing a distinct proof layer, if Linux visual output cannot be reviewed on the pinned runner, if the release workflow would expose signing secrets to pull requests, or if `main` does not require pull requests and the stable `CI / test` check before the full push suite is reduced.
- **Tail ownership:** Implement, verify, review, ship, and watch the pull request through CI in the current LFG run.

## Product Contract

### Summary

Routine pull requests will run one deduplicated `test` job on pinned Ubuntu. Superseded runs will cancel, merged `main` commits will receive only a small Linux smoke check, and manual macOS release validation will retain the platform-specific installer, signing, notarization, and Gatekeeper evidence.

### Problem Frame

The current CI workflow runs every pull-request revision and every merged `main` commit on `macos-15`. It repeats an identical lint/typecheck command, regenerates fixtures and rebuilds the web application several times, invokes overlapping unit and browser suites, and retries every Playwright failure once. Recent billing evidence attributes nearly all included-minute consumption to this repository's macOS jobs. The workflow can preserve its distinct proof layers while replacing expensive and duplicated execution with one canonical Linux path.

### Requirements

- R1. Every pull request shall expose the existing stable `CI / test` check from one `ubuntu-24.04` job with read-only repository permissions and no release secrets.
- R2. A push to `main` shall run only a small Linux smoke path rather than repeating the full pull-request suite.
- R3. A newer revision of the same pull request or ref shall cancel its obsolete in-progress run without canceling work for a different pull request.
- R4. The pull-request path shall install dependencies once, generate PDF fixtures once, typecheck once, execute each currently intended Vitest file once, build the web distribution once, and validate the distribution once.
- R5. The pull-request path shall retain the unique PDF-viewer conformance, viewer, review-workflow, Codex-delivery, launch-surface, production-flow, focused WebKit, and visual-regression browser proofs.
- R6. The Linux job shall have a 15-minute bound, shall not rerun whole failed Playwright tests automatically, and shall retain failure traces, screenshots, and reports for seven days.
- R7. Visual comparison shall use Playwright-managed Chromium 1.61.1 on `ubuntu-24.04`, committed reviewed Linux goldens, and no snapshot-update flag in ordinary CI.
- R8. The manual macOS release workflow shall remain `workflow_dispatch`-only and retain both architectures, signing, installed smoke, notarization/stapling, Gatekeeper assessment, and per-architecture artifacts; Darwin-only installer regression tests shall run on its arm64 leg.
- R9. The Linux workflow shall retain pnpm dependency caching but shall not add a Playwright browser-binary cache without timing evidence that restore is cheaper than installation.
- R10. Human- and agent-authored pull requests shall use the same check identity, concurrency isolation, logs, traces, and failure artifacts.

### Acceptance Examples

- AE1. **Normal pull request**
  - **Covers:** R1, R4-R7, R9-R10
  - **Given:** A pull request targets the repository.
  - **When:** GitHub Actions evaluates its current revision.
  - **Then:** One `CI / test` job runs on `ubuntu-24.04`, each canonical phase appears once, Chromium/WebKit/visual proofs compare without update mode, and the job finishes inside 15 minutes.
- AE2. **Superseded pull-request revision**
  - **Covers:** R3, R10
  - **Given:** One pull-request run is still in progress.
  - **When:** A newer commit is pushed to that same pull request.
  - **Then:** The older run is canceled and the new run starts, while runs for other pull requests remain unaffected.
- AE3. **Merged or direct `main` push**
  - **Covers:** R2
  - **Given:** A commit reaches `main`.
  - **When:** The CI workflow runs for the push event.
  - **Then:** It performs checkout, cached dependency installation, and the small typecheck smoke only; browser installation and the full test/build phases do not run.
- AE4. **Browser failure**
  - **Covers:** R6, R10
  - **Given:** A Chromium, WebKit, or visual assertion fails.
  - **When:** The job exits.
  - **Then:** The assertion is not automatically rerun, retained-on-failure diagnostics are uploaded when present, and the failed phase remains visible by name.
- AE5. **Manual signed release**
  - **Covers:** R8
  - **Given:** An authorized maintainer manually dispatches the release workflow.
  - **When:** The arm64 and Intel matrix executes.
  - **Then:** Both existing release legs run unchanged release evidence, and the arm64 preflight additionally executes the Darwin-only installer contract tests excluded from Linux.

### Scope Boundaries

- Do not weaken or delete standalone developer test scripts merely because CI gains a deduplicated orchestration path.
- Do not add broad test retries, sharding, a multi-job matrix, or a browser-binary cache in this change.
- Do not change application behavior, release secrets, signing identities, notarization policy, or artifact contents.
- Do not copy or rename Darwin screenshots as Linux goldens; Linux output must come from the pinned Linux runner and be reviewed.
- Do not add a separate CI path for agent-authored changes.

## Planning Contract

### Key Technical Decisions

- KTD1. **Put the full pull-request gate on pinned Linux.** (session-settled: user-approved — chosen over continuing routine macOS CI: the billing evidence showed macOS consuming nearly all included minutes at roughly ten times the Linux rate.) Keep the stable workflow/job names `CI` and `test` and run the full pull-request contract on `ubuntu-24.04`.
- KTD2. **Run one canonical, deduplicated phase graph.** (session-settled: user-approved — chosen over chaining the overlapping `test:u*` scripts: repeated fixtures, builds, typechecks, and tests spend minutes without adding distinct evidence.) Add explicit CI-oriented package scripts/configuration for the union of Vitest files already intended by the current workflow and the unique browser specs. Generate fixtures once, build the web distribution once, and keep named workflow steps so cost and failures remain attributable.
- KTD3. **Cancel only obsolete work for the same PR or ref.** (session-settled: user-approved — chosen over allowing every superseded revision to finish: the older result cannot establish mergeability for the newer commit.) Use workflow name plus pull-request number, falling back to ref, as the concurrency group with `cancel-in-progress: true`. This preserves parallel work across different PRs.
- KTD4. **Keep only a small `main` push smoke path after protection is enforced.** Retain `push: main` for dependency install plus typecheck, condition every expensive setup and phase on `pull_request`, and thereby cover the direct-push blind spot without repeating the full protected-merge suite. Before this reduction reaches `main`, require a repository ruleset that requires pull requests and the stable `CI / test` check.
- KTD5. **Align installed browsers and failure diagnostics.** Replace the default system-Chrome channel with Playwright-managed Chromium, install Chromium and WebKit with Ubuntu dependencies, set retries to zero, and retain traces on failure. This avoids independently versioned Chrome and repeat billing while preserving actionable evidence.
- KTD6. **Establish Ubuntu as the canonical visual environment.** Generate every current visual scene on `ubuntu-24.04` with pinned Playwright Chromium, review the output against the existing design intent, commit `*-linux.png` goldens, remove obsolete/unreferenced Darwin goldens once macOS visual CI is gone, and update the installed-host contract. CI remains comparison-only.
- KTD7. **Keep platform-specific proof in the manual macOS gate.** (session-settled: user-approved — chosen over moving signing/notarization work into ordinary Linux CI: Apple platform tools and release secrets belong only in the manually dispatched release workflow.) Mark only the two installer-execution cases in `packaging/macos/packaging.test.ts` Darwin-only so the remaining static packaging contracts run on Linux. Execute the full packaging file on the arm64 release leg before secrets are used; retain the existing release matrix and release operations.
- KTD8. **Treat browser caching as a measured follow-up.** Continue using `actions/setup-node`'s pnpm cache. Playwright browser archives are not cached because Ubuntu system dependencies still require installation and official guidance says archive restore is often not faster than download.

### Assumptions

- GitHub's repository settings currently show no classic branch protection and no ruleset. Enabling a `main` ruleset that requires pull requests and the stable `CI / test` check is therefore a pre-merge dependency, not an assumed existing control.
- The repository does not currently use GitHub's merge queue; therefore no `merge_group` trigger is required. If a merge queue is enabled later, its required-check event must be added without changing the `test` identity.
- The small `main` smoke remains useful after the ruleset is active because it verifies an exceptional administrator bypass without paying for duplicate browser validation.
- `ubuntu-24.04` remains available as a GitHub-hosted label and is materially cheaper in included-minute accounting than macOS.
- The first Linux visual baseline may need to be harvested from the pull request runner's failure artifact and committed in a follow-up revision; the final gate must pass without update mode.

### Sources and Research

- `.github/workflows/ci.yml`, `.github/workflows/release-macos.yml`, and `package.json` define the current triggers, runner, overlapping phases, and release boundary.
- `playwright.config.ts`, `playwright.webkit.config.ts`, and `playwright.visual.config.ts` define the current system-Chrome mismatch, whole-test retry, cross-engine coverage, and canonical screenshot environment.
- `packaging/macos/packaging.test.ts`, `install.sh`, and `packaging/macos/install-built-app.sh` identify the two executable Darwin-only installer cases; the rest of the packaging contract is portable.
- `docs/solutions/test-failures/webkit-recoverable-reference-flow-acceptance-test.md` and `docs/solutions/architecture-patterns/adaptive-annotation-tray-framing.md` require retaining focused WebKit, semantic recovery, unit, shell-acceptance, and real-browser geometry proofs.
- `docs/solutions/test-failures/wait-for-committed-wheel-zoom-before-pointer-selection.md` supports semantic synchronization rather than broad CI retries.
- `docs/solutions/integration-issues/portable-pdf-annotations-invisible-in-external-viewers.md` keeps writer conformance on Linux and external-viewer/release evidence on macOS.
- [GitHub Actions runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing) establishes the substantial hosted macOS/Linux price multiplier.
- [GitHub Actions concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency) defines cancel-in-progress grouping semantics.
- [GitHub dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching) supports retaining the package-manager cache.
- [Playwright continuous integration](https://playwright.dev/docs/ci) specifies browser-plus-system-dependency installation on Linux and recommends against browser-binary caching in typical CI.

## Implementation Units

### U1. Define the canonical CI test phases and diagnostics

- **Goal:** Replace overlapping workflow invocations with reusable, named phases that preserve the current intended evidence exactly once.
- **Requirements:** R4-R6, R9-R10; covers AE1 and AE4.
- **Dependencies:** None.
- **Files:**
  - `package.json`
  - a minimal CI-specific Vitest config or equivalent explicit file inventory
  - `playwright.config.ts`
  - `playwright.webkit.config.ts`
  - `playwright.visual.config.ts`
- **Approach:**
  1. Inventory the union of Vitest files reached by `test:pdf-conformance`, `test:service`, `test:u4`, `test:u5`, `test:u6`, and `test:u7-host`; encode that union in one `test:ci:unit` phase without repeating files or broadening to unrelated tests.
  2. Add one Chromium phase covering PDF viewer conformance plus `viewer`, `review-workflow`, `codex-delivery`, `launch-surfaces`, and `production-flow`; preserve the focused WebKit `review-workflow` and `production-flow` phase and the visual config as separate named phases.
  3. Keep developer-facing self-contained scripts intact, but add an aggregate `test:ci` command that generates fixtures, typechecks, runs canonical unit tests, builds the web distribution once, runs the three browser phases, and validates distribution.
  4. Use Playwright-managed Chromium in the default config and set `retries: 0` in all three configs. Set traces to `retain-on-failure`, screenshots to `only-on-failure`, keep `test-results/` as the output directory, and configure an HTML report under `playwright-report/` so the uploaded paths contain actionable evidence without a retry.
- **Patterns to follow:** Existing single-worker browser configs and failure artifact paths; existing focused WebKit semantic assertions.
- **Test scenarios:**
  1. Covers R4. Every previously intended Vitest file is selected once and duplicate unit files are absent from the canonical inventory.
  2. Covers R5. Every unique current Chromium spec runs once; both intentional WebKit specs run once; all current visual scenes run once.
  3. Covers R6. A diagnostic smoke failure produces retained trace/screenshot output without executing the failed test twice.
- **Verification:** Validate package JSON/config syntax, list selected tests where supported, and run each canonical phase locally where the current host supports it.

### U2. Make packaging validation portable while retaining Darwin evidence

- **Goal:** Allow the canonical Vitest phase to run on Linux without discarding real macOS installer validation.
- **Requirements:** R4 and R8; covers AE1 and AE5.
- **Dependencies:** U1.
- **Files:**
  - `packaging/macos/packaging.test.ts`
  - `.github/workflows/release-macos.yml`
- **Approach:**
  1. Guard only the source-installer dry-run and transactional installed-app replacement tests when `process.platform !== 'darwin'`; leave manifest, notarization-plan, launcher, and doctor-evidence contracts active on Linux.
  2. Add one arm64-only release preflight step that runs the full packaging test on macOS before certificate import.
  3. Preserve both release runners and every existing secret-backed package, smoke, signing, notarization, Gatekeeper, and artifact step.
- **Patterns to follow:** The existing architecture matrix and pre-secret validation/build ordering in `release-macos.yml`.
- **Test scenarios:**
  1. Covers R8. Linux reports exactly two Darwin-only skips while portable packaging tests pass.
  2. Covers AE5. The arm64 release leg executes both installer cases; the Intel leg avoids duplicate packaging-test cost while retaining all architecture-specific release evidence.
- **Verification:** Run the packaging file locally on Darwin, inspect Linux selection/skips in PR CI, and validate release workflow syntax without dispatching it.

### U3. Replace routine macOS execution with bounded, cancelable Linux CI

- **Goal:** Apply the runner, trigger, concurrency, and phase-layout cost controls while preserving the stable gate and diagnostics.
- **Requirements:** R1-R6, R9-R10; covers AE1-AE4.
- **Dependencies:** U1-U2.
- **Files:**
  - `.github/workflows/ci.yml`
- **Approach:**
  1. Keep `pull_request` and `push: main`, add workflow/PR-or-ref concurrency, retain read-only permissions, preserve job id `test`, pin `runs-on: ubuntu-24.04`, and set `timeout-minutes: 15`.
  2. Before merging the workflow reduction, verify a `main` repository ruleset requires pull requests and the stable `CI / test` status check. Treat missing protection as a rollout blocker rather than shipping typecheck-only direct pushes.
  3. Reuse checkout, pnpm setup, Node 24.14.0, frozen install, and pnpm cache for both events.
  4. Run typecheck for both events. Condition Playwright installation with `--with-deps chromium webkit`, fixtures, canonical unit tests, one build, Chromium, WebKit, visual, and distribution validation on pull requests only.
  5. Preserve separate named steps and the failure-only seven-day Playwright artifact upload; canceled obsolete runs need not upload diagnostics.
- **Patterns to follow:** Existing workflow action versions, cache, permissions, artifact paths, and job identity.
- **Test scenarios:**
  1. Covers AE1. A PR produces one Ubuntu `CI / test` check with all full phases once.
  2. Covers AE2. A follow-up commit cancels only the older run from the same PR.
  3. Covers AE3. A `main` push skips browser installation and all full phases after typecheck.
  4. Covers AE4. A Playwright failure uploads available diagnostics after the named failing phase.
- **Verification:** Parse the workflow, inspect the GitHub run's event/runner/step list, and compare its billable runner class and duration with a recent macOS run.

### U4. Establish and document the pinned Linux visual baseline

- **Goal:** Preserve pixel regression coverage after removing macOS from ordinary CI.
- **Requirements:** R5-R7; covers AE1 and AE4.
- **Dependencies:** U1 and U3.
- **Files:**
  - `test/acceptance/review-visual.spec.ts-snapshots/*-linux.png`
  - obsolete/unreferenced Darwin snapshots in the same directory
  - `test/acceptance/installed-hosts.md`
- **Approach:**
  1. Generate and review the current `codex-handoff-darwin.png` scene on macOS so the renamed scene has a like-for-like approved design reference before the obsolete finish/delivery snapshots are removed.
  2. Generate all snapshot names referenced by the current visual spec on `ubuntu-24.04` with Playwright 1.61.1 Chromium, including the current `codex-handoff` scene.
  3. Review Linux output against the current Darwin scenes and documented Warm Neutral intent; accept platform rendering differences only when hierarchy, content, focus, hover, state, and geometry remain correct.
  4. Commit the Linux goldens, remove Darwin snapshots no longer referenced or no longer used by CI, and document the exact Ubuntu/Chromium/device-scale contract.
  5. Rerun the ordinary visual command without any update flag on the same runner until it is a read-only green comparison.
- **Patterns to follow:** `docs/plans/2026-08-09-001-feat-warm-neutral-review-design-language-plan.md` for deterministic scenes, product-only capture, fixed locale/color/viewport, and reviewed-golden policy.
- **Test scenarios:**
  1. Covers R7. Every current scene has exactly one committed Linux baseline selected by Ubuntu CI, including the renamed Codex handoff scene.
  2. Covers R7. Obsolete delivery/finish Darwin snapshots are absent after the scene inventory is reconciled.
  3. Covers AE1. A second Ubuntu visual run passes without creating or changing snapshots.
- **Verification:** Review the rendered baseline set, compare the snapshot manifest to `toHaveScreenshot` names, and require a clean read-only visual run on the PR.

## Verification Contract

| Gate | Command or evidence | Proves |
|---|---|---|
| Workflow/config syntax | Parse `.github/workflows/*.yml`, `package.json`, and TypeScript configs | The runner, event conditions, scripts, and release workflow are structurally valid |
| Type safety | `pnpm typecheck` | The canonical shared smoke gate passes |
| Canonical unit phase | `pnpm test:ci:unit` | The intended Vitest union runs once, with only Darwin-execution cases skipped on Linux |
| Web distribution build | `pnpm build:web` | The production web assets required by production-flow and visual tests are produced once |
| Chromium behavior | `pnpm test:ci:chromium` | PDF conformance and all unique Chromium acceptance flows pass |
| WebKit behavior | `pnpm test:ci:webkit` | The focused cross-engine recovery and geometry contract passes |
| Visual regression | `pnpm test:ci:visual` | Reviewed Ubuntu goldens compare read-only for every current scene |
| Distribution manifest | `pnpm validate:distribution` | The packaged-file contract remains valid |
| Aggregate local contract | `pnpm test:ci` | The canonical phase ordering is reproducible outside workflow YAML |
| PR lifecycle | GitHub `CI / test` run plus a superseding follow-up revision | Ubuntu runner, stable check identity, timeout, diagnostics, and same-PR cancellation work |
| Main lifecycle | First post-merge `main` run | Only the small Linux smoke path runs after merge |
| Release preservation | Workflow diff and arm64 preflight placement | Manual dual-architecture signing/notarization evidence is unchanged and Darwin-only tests remain owned |

## Rollout and Observability

- Treat the first PR run as the authoritative Linux compatibility and timing measurement. The 15-minute timeout must retain meaningful margin on an uncached run.
- If the first run lacks Linux visual goldens, harvest them only from a reviewed same-repository branch run. Inspect the extracted PNGs without executing artifact HTML, commit the approved images under the expected `*-linux.png` names, and rerun without update mode.
- Before shrinking the `main` push path, record repository-settings evidence that pull requests and `CI / test` are required. If that control is unavailable, retain the full Linux push path until it is available.
- Push one follow-up revision while a PR run is active when practical, and verify GitHub marks only that PR's superseded revision canceled.
- Compare the successful PR's runner class and elapsed/billable duration with a recent macOS run. Do not add browser caching unless the install step remains a measured material share and a prototype proves net savings.
- After merge, verify the `push` run stops after typecheck and the manual `Release macOS` workflow remains undispatched.

## Definition of Done

- R1-R10 and AE1-AE5 are satisfied.
- Routine PR validation uses one bounded `ubuntu-24.04` job and keeps the stable `CI / test` identity.
- Obsolete revisions cancel per PR/ref; distinct PRs remain isolated.
- Each intended unit/build/browser/visual/distribution proof runs once, with no broad Playwright retries.
- The pinned Linux visual baseline is complete, reviewed, committed, documented, and green without update mode.
- A `main` ruleset requires pull requests and `CI / test`; only then is the `main` push path smoke-only, while manual macOS release evidence and secrets remain isolated and complete.
- The final PR CI passes and demonstrates a material reduction in macOS runner usage and duplicate work.
