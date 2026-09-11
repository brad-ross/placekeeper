# Repository organization verification

Date: 2026-09-10. Baseline: `b415ceba1191ee81ba8a16c0b0f07c1947c96e4a` (merged PR #92). Implementation through `3a4c804` on `codex/repository-organization`. The accepted plan remains a separate, unchanged working-tree artifact. This report records behavior-preserving organization, not a repair of pre-existing application or test failures.

## Implementation evidence

| Unit | Commit | Result |
| --- | --- | --- |
| U1: suite/config ownership | `2c936e1` | 38 migrated command strings and 14 effective configurations matched baseline; public aliases, ordered stages, prerequisites, and default membership preserved. Focused 16 tests passed. |
| U2: PDFium build helpers | `3050a61` | Shared loading/emission and worker extraction moved below host configs; worker and WASM hashes unchanged. |
| U3: neutral contracts | `4755233` | Type-only declarations moved below component consumers; 43 focused tests and typecheck passed. |
| U4: pure web policy | `05905d4` | 33 extracted declarations matched normalized baseline ASTs; 145 tests passed with the same baseline dialog-class failure. |
| U5: app lifecycle hooks | `79db3da` | Search, save destination, SyncTeX, and context owners extracted; 198 tests passed with the same baseline dialog-class failure. |
| U6: reader/authoring hooks | `2091122` | Reader restoration and authoring command/draft lifecycles extracted; neutral authoring contract avoids importing its consumer. 133 tests passed with the same baseline duplicate-page-text failure. |
| U7: CSS ownership | `c869e6d` | Nine expanded original CSS ASTs identical; 15 new bodies are contiguous original byte substrings. All 74 source-contract tests passed after import-aware reading, with assertions unchanged. |
| U8: recovery bookkeeping | `d37d8f6` | Broker retains authority, indexes, persistence and tails; 88 recovery/security/retention tests passed. Error facade identity remains covered. |
| U9: presentation records | `278ee82` | View metadata and reconnect waiters extracted; 95 focused tests plus 42 recovery tests passed. |
| U10: SyncTeX preparation | `5cf2dec` | Cached preparation stays synchronous; only sidecar staging introduces an await. 110 focused tests passed. |
| U11: transition preparation | `d7e2f73` | Fresh open, recovered review, and document replacement prepare candidates while broker owns commit/publication/fences. 124 focused tests passed. |
| U12: documentation | `3a4c804` | All 40 learnings refreshed, 53 glossary entries reviewed, contributor/docs navigation added; 251 local links and cited source paths checked with no unresolved targets. See the [complete refresh report](2026-09-10-repository-organization-compound-refresh.md). |

U13 closes with this verification record and the completed code-review receipt. Environment limitations and baseline failures remain explicit; they were not repaired or counted as passes.

Each code wave received separate reuse, quality, and efficiency reviews. The retained quality correction moved the authoring contract out of `ReviewShell`. No snapshot baselines were regenerated and no product behavior was changed to satisfy stale assertions.

## Final build and test gates

Environment: macOS arm64; Node 26.8.x for repository tooling, pnpm 11.16.0, Vitest 4.1.10, installed Playwright browsers. Native packaging used the manifest-pinned Node 24.14.0 runtime. Swift testing used the installed Command Line Tools; XCTest was unavailable. Loopback-dependent checks ran with local socket access; sandbox `EPERM` failures were not treated as product failures.

| Gate | Outcome |
| --- | --- |
| `pnpm build` | Passed service, refreshed shared web/VS Code, and Chrome bundle stages. |
| `pnpm build:macos:web` and isolated native candidate build | Passed. Packaged native JS/CSS compared with final build inputs. |
| `pnpm typecheck` | Passed. |
| `pnpm test:ci:unit` | 1,170 passed; 3 failures already reproduced on baseline (details below). |
| Explicit suite/worker/SyncTeX characterization | 46 tests passed across 3 files; default suite membership remains unchanged. |
| `pnpm test:static:pr` | Passed static unit, typecheck, project-site build, distribution validation and critical Chromium artifact flow. |
| Static representative WebKit artifact profile | 3 passed, covering failed-URL privacy/focus, keyboard import/edit/export/reimport, and cropped-PDF highlight creation. |
| `pnpm test:static` | Chromium exhaustive: 11 passed, 1 baseline cancellation timeout; the aggregate stopped before secondary engines. The same Cancel-button timeout was reproduced on the original revision. |
| Static representative Firefox artifact profile | 3 passed; run separately after the aggregate stopped. |
| Distribution validation after `pnpm build` | Service syntax passed; manifest validator stopped at the existing web-JS size budget (2,598,548 bytes). Fresh baseline: 3,151,874 bytes; final: 3,155,221 bytes. |
| `pnpm test:macos:gate` | 33 TypeScript tests passed; Swift tests could not compile because the selected Command Line Tools SDK lacks XCTest. The native executable itself compiled. |
| `pnpm test:chrome-handoff` | 185 unit tests passed, 1 baseline dialog-class failure; separate browser stage: 3 passed, 1 skipped because MIME-handler automation was unavailable. |
| Original visual suite | Baseline and final both 17 passed / 32 failed. All 30 emitted actual snapshot images are byte-identical across revisions. Two failures occur before snapshot capture. |
| Production/review workflow comparison, Chromium | Same bounded run on both revisions: 19 passed / 8 failed, 126 not run after the failure limit. Failure names match. |
| WebKit host/design/authoring/workspace comparison | Baseline and final both 42 passed, 8 failed, 2 skipped, 74 not run after the failure limit; all eight failure names match. |
| Final structured code review | Complete: nine reviewers and one validation batch; no retained actionable code findings. Receipt: `final-3a4c804`, reviewed implementation through `3a4c804`. |

## Baseline failures and coverage limits

The final CI failures are the same three persistent failures observed before extraction:

- `apps/web/test/production-review-app.test.tsx`: exact dialog class expects a value without the existing `review-choice-dialog` class.
- `apps/service/test/live-context-service.test.ts` and `codex-live-context.integration.test.ts`: expect the fixture's native annotations to remain foreign/read-only, while baseline ingestion already imports them as editable native Review Items.

The baseline's missing Chrome distribution failure disappeared after the required build. Its catalog-update timeout passed on a focused retry and in the final CI run. The separate reader source-render assertion at `reference-workspace.test.tsx:431` expects page text `18` once, but the baseline already renders it twice.

The exhaustive static cancellation test waits for a `Cancel` button that is absent on both revisions. Distribution validation also fails on both revisions at its existing catalog bundle-size threshold; this refactor adds 3,347 uncompressed JavaScript bytes (about 0.11%). The budget was not raised.

Browser failures include stale visual snapshots, controls whose expected hit target is covered by existing navigation chrome, and obsolete annotation-population assumptions. They are preserved as failures, not counted as passing coverage. Bounded runs establish equivalence only for executed cases; they do not claim every omitted browser test passed. The original annotation-behavior Chromium baseline was also stopped after repeated missing-owned-mark failures; it provides failure provenance, not full-suite coverage.

## Requirements coverage

R1–R2 are supported by the unit, browser, host, configuration, asset, and native comparisons above, subject to the recorded failures and unexecuted cases. R3–R4 are implemented by the suite registry and host-neutral PDFium tooling. R5 is covered by neutral contracts and the policy/lifecycle extraction units; existing controllers retain domain authority. R6 is supported by expanded CSS AST equivalence and byte-identical actual visual snapshots. R7 is supported by broker ownership review and recovery/reconnect/transition tests. R8 is covered by the complete 40-learning refresh and contributor navigation. R9 is covered by the unit commits and this final evidence record. No dependency, lockfile, protocol, persisted-schema, or manual CI activation change was introduced.

## Native first paint and asset integrity

An immutable baseline checkout was created under `/tmp/placekeeper-organization-baseline`. Baseline and final native candidates were built under separate temporary output directories and launched with the same two-page PDF fixture through the repository's private-state runner. The installed app and user profile were not replaced.

Before any resize, both native candidates visibly painted the PDF. Opening the workspace visibly painted its Search surface and retained the PDF; the window remained 1200 by 768. This is native pixel evidence, not merely accessibility bounds or browser WebKit geometry. The final candidate was closed after inspection. The native picker path was not verified in this run; original dated picker evidence in the learning remains explicitly historical.

The final expanded CSS stream preserves selectors, values, declaration order, specificity, `!important`, at-rule conditions, portal scope, and the native overflow override. No declarations were removed or token families aliased. The worker remains SHA-256 `4463487ece74309901036d06584c7296509eba9b26ff67d9154e32dfc8d04b5a`; WASM remains `c0af5a6aca30d7e54a149c3a68e317116ca906d6edc28fd3318b12c7d9478ac8`.

## Evidence locations

Local logs and comparison artifacts are retained under `/tmp/placekeeper-*`, including:

- `final-build.log`, `final-ci.log`, `final-static-pr.log`, `final-static-full.log`, `final-static-webkit.log`, `final-static-firefox.log`, and `final-characterization.log`.
- `baseline-static-cancel.log`, `baseline-distribution.log`, `final-distribution.log`, `final-macos-gate.log`, `final-chrome-handoff.log`, and `final-chrome-browser.log`.
- `visual-baseline-results`, `visual-final-results`, and `visual-comparison.json`.
- `baseline-webkit.log`, `final-webkit.log`, `workflow-baseline-core.log`, and `final-workflow-core.log`.
- `u7-css-proof.cjs`, `u7-css-proof.txt`, `u7-css-before`, and `u7-css-ownership.md`.
- `native-final-build.log`, `native-final-run.log`, and `final-asset-evidence.json`.

The final review receipt and rejected-candidate rationale are retained at `/tmp/placekeeper-review/ce-code-review/final-3a4c804/review.json`. No fix batches were needed and no justified code findings remain unresolved.

These temporary artifacts are local verification evidence, not release assets. No installation, push, or PR publication was performed.
