# Electron desktop migration qualification

This report records implementation and personal-build evidence. It is not approval to replace the installed AppKit application. The candidate uses the shared production review client and canonical service; AppKit remains available. Public distribution, automatic updates, signing/notarization for distribution, and changing default handlers are outside this change.

## Evidence recorded on 2026-11-02

Local host: macOS arm64. Exact OS, hardware, artifact and fixture hashes are recorded by the performance reports and packaged build evidence. Electron 45.2.1 and independent daemon Node 24.22.1 are pinned. The retained AppKit candidate uses its existing pinned Node 24.14.0. Electron 44 and later require macOS 13 or newer ([Electron compatibility notice](https://www.electronjs.org/blog/electron-44-0)); macOS 13 execution still needs a native test host.

All local candidate tests use explicit `--isolated-installed-smoke --http-port PORT --isolated-test-root ROOT` arguments and copied PDFs. Ordinary launches retain the canonical per-user service root. Test roots are not a production fallback for incompatible service versions.

### Packaged behavior

| Scenario | Local result | Evidence |
| --- | --- | --- |
| Render and visibly activate a real PDF with system Node absent from PATH | Passed | `electron-installed.spec.ts` |
| Renderer has no Node globals; wrong-window, arbitrary-method and path injection requests rejected | Passed | `electron-installed.spec.ts` |
| Two documents; duplicate open focuses existing window without replacing its identity | Passed | `electron-lifecycle.spec.ts` |
| Closing one window protects the exact current unsaved editor text and leaves the other usable | Passed | `electron-lifecycle.spec.ts`; exact recovery-file assertion and original PDF-byte comparison |
| Edit, undo, redo, publish to original; reopen portable annotation from a separate recovery root | Passed | `electron-review-workflow.spec.ts` |
| External source replacement observed; subsequent save preserves successor pages and metadata | Passed | `electron-review-workflow.spec.ts` |
| Native launchers and bundled MCP discovery without system Node | Passed | `electron-launcher.spec.ts`; malformed/unauthorized launch rejection and real MCP discovery |
| Focused native link navigates an existing window before task activation; Copy Link remains available | Passed | `electron-focused-link.spec.ts`; same window/attempt, page 3, task unavailable before navigation and current afterward |
| Cancel protected draft without a save destination | Passed | `electron-review-workflow.spec.ts`; composer closes, canonical draft clears and original PDF bytes remain unchanged |
| Renderer crash followed by native Retry | Passed on local macOS arm64 | Actual CDP renderer crash after exact-text protection; native Retry restores protected draft under a new attempt and leaves the second document usable |
| Electron → retained Mac → Electron recovery-compatible service switching | Passed | `desktop-service-rollback.spec.ts` |

The close test initially found an empty earlier draft after current input was lost. The renderer now vetoes unload and requests main-process settlement; main destroys the window only after the current editor value and outstanding requests are acknowledged. A prior protected revision cannot satisfy the current-input check. The test continues to compare exact recovery text rather than merely checking that a draft exists.

The complete shared visual suite produced the same result on this branch and a pristine `3e37ca4b` checkout: 16 passed and 33 failed. Of 62 matching captured PNGs, 50 were byte-identical; the remaining differences were tooltips, carets, animation frames and small toolbar edges. No migration-only failure was found, and baselines were not rewritten. This establishes comparison with the shared browser baseline, not paired native AppKit or cross-platform visual qualification.

### Requirement coverage and limits

| Requirement | Implemented mechanism and evidence boundary |
| --- | --- |
| R1 | Native Forge targets for macOS arm64/x64 ZIP, Windows x64 Setup.exe and Ubuntu x64 deb; independent Node, PDFium and service packaged. Native artifact results are recorded below. |
| R2 | One production React review tree, shared CSS/icons, native window chrome. Existing browser appearance regression suite and packaged screenshot are separate evidence from a paired AppKit screenshot comparison. |
| R3 | Separate candidate name/identifier; no automatic handler or integration registration. Explicit registration uses ownership receipts and refuses existing configuration. |
| R4 | Shared navigation, authoring, source/save/export model. Actual packaged save/edit/undo/redo/source-refresh tests pass; native clipboard, dialogs and every navigation modality still need interactive OS qualification. |
| R5 | Per-window bridges, duplicate-open registry, bounded presentation restoration, renderer failure retry. Two-window and close isolation pass; native Retry after an actual renderer crash passes; Close choice and restoration still require additional installed-app exercises. |
| R6 | Durable service recovery, exact-input normal-close barrier, pending-operation retirement. Service switch and crash evidence are distinguished from normal close. |
| R7 | Explicit Electron identity and native task-launch registry reuse canonical generation, revision, interaction and task authority. Correlated visible activation is required before task binding; focused and stale launch cases have service tests. |
| R8 | Exact service identity reuse; incompatible/uninspectable service refusal; explicit quiescent switch with verified recovery backup and exact readiness. No automatic incumbent kill or alternate writer root. |
| R9 | Sandboxed/context-isolated renderer, per-window request fences and custom resource protocols. Windows mutual challenge/epoch authentication and private ACL creation have independent code review and platform tests; actual Windows execution is recorded separately. |
| R10 | Sibling staging and durable publication; Windows write-through rename preserves ACLs and uncertainty. No delete-before-rename fallback. The real Windows lock test is not counted as passed on macOS. |
| R11 | Native CLI/Chrome launchers, explicit VS Code selection, packaged MCP and opt-in registration. Service contract and packaged discovery tests do not substitute for interactive external-host qualification. |
| R12 | Reproducible cold/warm launch and macOS CPU/memory measurement harness. Results and unmeasured metrics are recorded below; no claim of AppKit-equivalent resource use. |
| R13 | Personal build/selection instructions, artifact inventories and this report. The old Mac application is retained. |

AE1 is exercised in the packaged lifecycle test. AE2 native Retry after renderer crash passes with exact acknowledged draft text and an unaffected second document; the native Close branch remains untested. AE3 has a real Windows replacement-denied test and remains untested locally. AE4–AE6 have service-level authority/lifecycle tests; complete installed Chrome/AppKit/task-host scenarios remain separate qualification work.

### Platform matrix

| Platform | Evidence status |
| --- | --- |
| Local macOS arm64 | Actual packaged review tests above; native macOS 15 arm64 CI ZIP and all eight packaged tests also passed at `9e7cd7d`; no installation over the user's app |
| macOS x64 | Native macOS 15 Intel CI ZIP and all eight packaged tests passed in run `41555449177` at `9e7cd7d` |
| macOS 13 | Untested; compatible minimum version is not execution evidence |
| Windows 11 x64 | Untested locally; Windows Server CI cannot establish Windows 11 installer, DPI or Narrator behavior |
| Ubuntu 24.04 x64 | Native CI built and installed the deb, verified root-owned mode-4755 Chromium sandbox, and passed packaged tests under Xvfb in run `41555449177`; interactive X11/Wayland and accessibility remain unqualified |
| VoiceOver / Narrator / Linux accessibility | Untested |

## Performance

`pnpm test:desktop-performance` uses 20 measured process launches per cold/warm condition and fixture, with a separate unmeasured daemon-warm priming launch. Cold means fresh isolated application state and stopped daemon; filesystem caches are uncontrolled. Usable-page timing starts immediately before OS process spawn and includes CDP observation overhead. Main-import-relative timing is not presented as process startup timing.

The macOS resource test measures cumulative CPU over at least 60 seconds and records Electron and daemon process-tree RSS separately and together over 12 normal document close/reopen cycles. Shared RSS pages can be counted more than once. Stable process inventory is required for CPU accounting. A low RSS growth ratio alone does not prove internal worker disposal.

The complete local run passed on Apple M5 / Darwin 25.6.0 arm64 (24 GiB RAM), using the packaged candidate with ASAR SHA-256 `a3444059c96e19c2733690a46c1772bc8a5a687f793563ef773494af7e15851a`. [Raw samples, artifact/fixture hashes, and memory accounting](electron-performance-2026-11-02.json) identify the measured build. This was an ordinary desktop session with other applications present, not a dedicated benchmark host.

| Fixture | Cold p95 | Daemon-warm p95 | Samples per condition | Target |
| --- | ---: | ---: | ---: | ---: |
| Small text | 2.12 s | 1.93 s | 20 | 6 s |
| Long text | 2.08 s | 2.90 s | 20 | 6 s |
| Image smoke fixture | 2.80 s | 1.81 s | 20 | 12 s |
| Annotated text | 2.90 s | 3.87 s | 20 | 6 s |

Combined idle CPU averaged 0.82% of one core over 60 seconds (target below 2%). Across 12 close/reopen cycles, combined post-close RSS peaked 10.5% above the first stabilized cycle (target at most 15%). First-cycle RSS was 317.8 MiB Electron plus 66.6 MiB daemon, 384.3 MiB combined; the peak combined value was 424.5 MiB. RSS accounting can count shared pages more than once. The local arm64 ZIP is 169,950,112 bytes (162.1 MiB); the unpacked app occupies 424,252 KiB (414.3 MiB) on this filesystem.

An earlier incomplete run lost the automation page target despite the renderer having initialized and remaining alive. Three bounded startup probes and the subsequent complete 160-launch run passed; no product cause was established. The harness now records raw target/disconnect diagnostics on recurrence. Another test failure was a normal-close/CDP-reply race; the corrected harness still requires the close event and idle-state checks.

First visible shell, visible input response, scroll/zoom frame intervals, a representative large scanned corpus, long-recovery cases, and a paired AppKit performance comparison remain unmeasured. The plan's targets are unchanged; missing measurements and target misses are not passes.

## Running qualification

See [personal build instructions](electron-personal-builds.md). Build the exact artifact before running `pnpm test:desktop-installed`; use `PLACEKEEPER_TEST_EXECUTABLE` to select another actual installation. `pnpm test:desktop-platform` includes real Windows-only checks and skips them on other hosts.

Rollback requires explicit `PLACEKEEPER_ROLLBACK_ELECTRON_RESOURCES` and `PLACEKEEPER_ROLLBACK_MAC_RESOURCES` pointing to newly built, manifest-verified resource directories. It uses a disposable recovery root and copied PDF. It proves packaged service-reader compatibility, not native AppKit GUI behavior.

Browser regression suites accept `PLACEKEEPER_BROWSER_TEST_PORT` for concurrent checkouts. Each run must serve this checkout, never reuse an unrelated test server. Performance measurements should run after builds and regression tests settle.
