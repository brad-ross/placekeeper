# Repository code-quality audit — 2026-09-07

The highest-value follow-up work is defining terminal lifetimes for retained service records, reducing repeated recovery scans without weakening filesystem checks, and shrinking the orchestration interface of `ReviewShell`. Five local cleanups were applied. Larger changes below are recommendations, not verified fixes.

## Scope and method

Repository-wide review of human-authored code under `apps`, `packages`, `scripts`, `packaging`, and `test`, including the service, web UI, shared PDF/core packages, Chrome extension, VS Code integration, native macOS host, and Electron spike. The tracked code inventory contains 425 TypeScript, TSX, JavaScript-module, Swift, and shell files, including tests and tooling. Generated assets, vendored code, dependencies, lockfiles, and binary fixtures were excluded from simplification.

Three independent review passes examined reuse, code quality, and efficiency. Findings were checked against callers, tests, and existing architecture documentation before editing. Coverage combines repository-wide structural searches with targeted implementation reads; it is not a claim of exhaustive line-by-line verification or a benchmark of every runtime path.

Already sound: strict TypeScript checks include unused locals and parameters; save/export code explicitly handles durability and recovery; runtime boundaries retain input validation, quotas, generation fences, and idempotency checks. Similar-looking serializers, geometry converters, and protocol validators often implement different contracts. Those distinctions should remain explicit.

## Applied changes

| Category | Change | Behavior preservation |
| --- | --- | --- |
| Reuse | Extract the identical Chrome/macOS runtime `canonicalJson` implementations to `apps/service/src/runtime/canonical-json.ts`. | The implementation is copied unchanged, including locale-based key sorting and unusual `undefined` encodings. Shared tests pin those behaviors; core serializers remain separate. |
| Quality | Remove `workspaceIsVisible` and its unused surface parameter from `apps/web/src/app/ReviewShell.tsx`. | Its only production caller now uses the same boolean expression directly. Remove only the assertion that tested the identity wrapper; workspace behavior tests remain. |
| Quality | Replace the “U3/U4” comment in `ReviewShellProps` with the enduring overlay-geometry/framing invariant. | Documentation-only change within code. |
| Efficiency | Retain progressive exact PDF search matches in a `Map` keyed by result ID in `apps/web/src/pdf/pdf-search-controller.ts`. | Each new match is deduplicated once rather than rebuilding the deduplication map from all accumulated matches on every publication. Last-value-wins semantics, insertion order, sorting, query reset conditions, and publication cadence remain unchanged. This does not eliminate repeated sorting or page scans. |
| Efficiency | Release the timeout and abort listener in `packages/pdf-backends/src/backend-host.ts` when a write settles. | Preserve writer invocation, race ordering, typed errors, limits, and digest checks. Cleanup runs on success, rejected or synchronously throwing writers, invalid output, cancellation, and timeout. Six regression cases verify resource release. |

Applied counts: **reuse 1, quality 2, efficiency 2**. Two new test files are included in the explicit CI test configuration.

## Deferred and rejected findings

Ten candidate groups were not applied. Priority here indicates follow-up value, not a reproduced incident severity.

1. **High: operation-journal retention.** `apps/service/src/browser/chrome-runtime.ts:154` retains successful operation promises for the lifetime of the journal and writes persistent per-operation records. No terminal cleanup or size bound was found. These records prevent replaying side effects after a lost response or crash, so blindly adding TTL/LRU eviction would weaken a safety guarantee. Define terminal session ownership, durable tombstone/replay behavior, and a supported retry horizon first. Then test sustained operations, service restarts, lost responses, expired retries, and cleanup of both memory and disk.

2. **High: completed export caches.** `apps/service/src/export/export-coordinator.ts:146` retains every completed copy/replacement delivery result; only in-flight maps are removed. Memory grows with distinct successful delivery keys. Tie cache release to an explicit end of retry eligibility rather than evicting active idempotency records. Verify same-delivery retries still return the original result without creating or replacing another file.

3. **High: activated canonical-review records.** `apps/service/src/browser/chrome-runtime-backend.ts:53` retains records/index entries and an activated-key set. `detach()` releases presentation leases; `release()` discards only never-activated provisional reviews. Detached reviews may intentionally remain recoverable, so detachment must not become deletion. Introduce a separate terminal cleanup contract with the broker and test activate/detach/reconnect/discard cycles, including multiple presentations and in-flight work.

4. **Medium: repeated recovery traversal.** `apps/service/src/sessions/session-broker.ts:523` scans all recovery directories during initialization; recovery enumeration immediately scans again. `apps/service/src/recovery/draft-snapshot.ts:276` also scans for abandoned temporary files whenever initialization runs, including before persistence. Broker `#store()` creates new store instances, so a per-instance initialization flag alone will not solve the repeated work. Separate startup cleanup from ongoing permission/path validation and define cache invalidation after removal or errors. Measure scans with many retained sessions; test external directory changes and abandoned temporary files. Do not memoize away security or data-loss checks.

5. **Medium: `ReviewShell` orchestration interface.** `apps/web/src/app/ReviewShell.tsx:164` exposes roughly 100 values and callbacks across save, authoring, selection, annotations, viewer, workspace/navigation, and host commands. This increases coupling and makes ownership difficult to follow. Migrate one domain at a time to explicit controller/view-model objects, extracting a subcontainer only where it creates a useful boundary. Preserve callback identity, effect dependencies, focus, and geometry timing. Require browser workflow evidence for this refactor; mass regrouping in a cleanup pass would obscure behavior changes.

6. **Conditional: scope polling rerenders.** `apps/web/src/app/ProductionReviewApp.tsx:900` polls every 1.5 seconds and assigns the returned scope object even when fields are equivalent. Consider a semantic no-change updater, but first measure which responses actually remain identical: context lease/currentness fields can legitimately change. Preserve reconnect promotion, authorization freshness, timeout behavior, and visible status. Slower polling or reliance on another notification channel requires a freshness-policy decision.

7. **Medium: remaining progressive-search work.** `apps/web/src/pdf/pdf-search-controller.ts:533` still scans indexed pages and sorts accumulated matches on each page publication. The applied map change removes repeated deduplication only. Batching publications or incrementally merging sorted runs may help match-heavy documents, but batching changes observable timing. Benchmark a large synthetic document, retain progressive actionable results, and verify symbol-alias expansion and out-of-order page completion before changing this further.

8. **Benchmark first: retention-scan concurrency.** `apps/service/src/recovery/retention.ts:42` walks session directories sequentially and performs further per-store work. Bounded concurrency may reduce latency after initialization cleanup is separated. Preserve deletion order and retention policy; measure disk contention rather than assuming more concurrency is faster.

9. **Benchmark first: independent launch work.** `apps/service/src/sessions/session-broker.ts:832` includes rewrite assessment and recovery discovery that may overlap. Starting both together changes error and side-effect ordering. Establish those contracts and benchmark launch latency before replacing the sequence with `Promise.all`.

10. **Rejected: blanket consolidation of similar helpers.** Native Node digest wrappers should not use the pure-JavaScript browser-compatible `sha256Hex` merely for reuse. A one-shot local 4 MiB comparison produced the same digest but took about **1.5 ms native versus 18.6 ms shared JavaScript**; this is a directional check, not a formal benchmark. The shared implementation also copies the entire padded input. HTML escaping, geometry/order helpers, core canonical serializers, protocol parsers, cancellation helpers, and trivial record/clamp wrappers differ in context or edge-case behavior. React ref/state mirrors can serve asynchronous callbacks; legacy/persisted compatibility paths cannot be removed without evidence about consumers. No worthwhile behavior-equivalent consolidation was established for these groups.

## Verification

- Project-wide typecheck and lint use the same configured command: `tsc -p tsconfig.base.json --noEmit`. Both were executed directly against the installed dependency tree because pnpm's pinned-version bootstrap stalled. Dependencies were linked locally from a worktree with an identical lockfile; no dependency versions or lockfiles changed.
- Focused final verification: **163 tests passed across 7 files**, covering both host runtimes, shared serialization, backend cleanup, progressive search, workspace layout, and packaging.
- Final CI unit/conformance suite: **1,070 tests passed across 63 files**, including the two added regression/conformance files.
- Service, web, VS Code, and Chrome bundles were built. Existing Vite warnings concern a deprecated bundler option and EmbedPDF's browser-externalized `crypto` import.
- Initial service integration failures were sandbox `listen EPERM` errors. They passed with local socket access. The initial packaging failure was missing generated Chrome shared assets; building the Chrome bundle resolved it.
- `git diff --check` passed. Full Playwright, installed-host, visual, and native Swift suites were not run; no host-specific UI behavior or Swift code changed.

Changes are local and uncommitted. Deferred retention and lifecycle findings remain open.
