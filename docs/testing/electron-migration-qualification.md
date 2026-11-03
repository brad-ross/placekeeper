# Electron desktop migration qualification

## Current replacement status (2026-11-03)

Electron is the sole current Placekeeper desktop application on macOS, Windows, and Linux. The Swift/AppKit host is retired. The product, app bundle, and distribution use **Placekeeper**; the installed CLI remains `placekeeper`. Production packaging contains an independent Node runtime rather than running the service through Electron's embedded Node.

The final rebuilt local macOS arm64 package passed **all 12 installed acceptance checks** in 1.3 minutes, recorded in `electron-replacement-installed-final.log`. The earlier reviewed-package run also passed all 12 checks. This is local replacement evidence, not an immutable release or a native Windows/Linux pass. Source-install and acceptance validation used disposable destinations, private service roots, and copied PDFs; it did not replace the user's real installation or recovery.

| Current replacement check | Observed local evidence |
| --- | --- |
| Packaged workflows | The final rebuilt package passed all 12 installed tests (1.3 minutes), including native launcher/MCP discovery, rendering, focused links, two-window lifecycle, restoration, save/reopen, and source replacement. |
| Warm forward/inverse SyncTeX | Genuine compiler-produced PDF/mapping data and the native query tool drove repeated forward jumps and inverse delivery to a real recording-editor child process. |
| Missing/delayed/rebuilt mapping | Missing mapping and a rebuilt PDF with a delayed sidecar resumed the latest explicit request in the same reader. |
| Cold CLI launch | The production renderer persisted page 2, then page 1 in the same app process without a debugging endpoint. A separate manual cold-launch check visibly reached page 2. |
| Native endpoint entry | A local CUA check submitted a synthetic Neovim endpoint in the native source-endpoint dialog; its returned JSON contained the exact submitted path (`electron-replacement-chooser-manual.json`). This checks dialog input/delivery, not a live Neovim connection or named-editor round trip. |
| Canonical unit/integration suite | The final canonical run passed all 2,184 tests in 122 files (187.41 seconds), recorded in `electron-replacement-canonical-green.log`. Final typechecking also passed. |
| Browser regressions | The current canonical Chromium run is pending. |
| Windows/Linux and complete qualification | Current native results remain pending. Earlier candidate CI runs below do not qualify this replacement. |

Build with `pnpm package:desktop`, then run `pnpm test:desktop-installed` against that exact package. Use `PLACEKEEPER_TEST_EXECUTABLE` to select a different actual installation. Run `pnpm test:desktop-platform` on each native platform; skips on another OS are not passes. Installed tests use private roots and copied PDFs, not the user's installation or recovery.

Installed SyncTeX acceptance (`test/acceptance/electron-synctex.spec.ts`) uses genuine PDF/SyncTeX output and a native TeX `synctex` query executable. A saved editor profile launches a real recording adapter process. Process delivery does not prove a named editor's UI placement. Missing query tools must be reported as skips rather than successful round trips. The single native endpoint-entry check above does not establish complete native source-configuration qualification on every platform.

The macOS external compatibility launcher is `Placekeeper.app/Contents/MacOS/placekeeper`; all platforms package launchers under `resources/desktop/bin` (`Contents/Resources` on macOS). Installation does not automatically make Placekeeper the OS default PDF handler. Interactive OS installation, native dialogs, accessibility, DPI/window-manager behavior, Chrome/Codex trust and activation, and complete release qualification remain separate work.

## Historical candidate evidence

The following records describe the earlier candidate revisions, with the AppKit app retained at that time. References to retained AppKit, separate candidate identity, rollback into AppKit, and personal-build commands below are historical. They are not current installation instructions or support commitments. Numeric measurements, artifact identities, and prior CI results are preserved without upgrading their scope.

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
| Native Close after a renderer crash; normal Quit and reopen | Passed on local macOS arm64 | [Artifact identities and observed results](electron-lifecycle-2026-11-02.json): Close left the peer interactive and the exact protected draft recoverable. Normal Quit restored page 2, 125% zoom and bounds. |
| Electron → retained Mac → Electron recovery-compatible service switching | Passed | `desktop-service-rollback.spec.ts` |

The close test initially found an empty earlier draft after current input was lost. The renderer now vetoes unload and requests main-process settlement; main destroys the window only after the current editor value and outstanding requests are acknowledged. A prior protected revision cannot satisfy the current-input check. The test continues to compare exact recovery text rather than merely checking that a draft exists.

The complete shared visual suite produced the same result on this branch and a pristine `3e37ca4b` checkout: 16 passed and 33 failed. Of 62 matching captured PNGs, 50 were byte-identical; the remaining differences were tooltips, carets, animation frames and small toolbar edges. No migration-only failure was found, and baselines were not rewritten. The [paired Mac captures and comparison](electron-appkit-appearance-2026-11-02.json) add a separate test: the same PDF on page 1 at 179% zoom, at 1200 × 764 points. The layouts have the same line breaks and horizontal placement. Electron content begins two points higher; after that translation, more than 99.99% of dark ink lies within one device pixel of ink in the other capture. The captures use different image formats and exclude different parts of the native chrome. This result covers one page and state, not every toolbar, display or interaction.

Linux CI exposed intermittent Blob resource errors and a composer disappearing during source-refresh authoring. Deterministic regressions found two defects: decoded or temporarily hidden raster URLs were revoked while React state could reuse them; an older bootstrap response could overwrite a newer accepted draft revision and replay editor admission. Raster URLs now remain owned until replacement or unmount. Bootstrap snapshots cannot roll back accepted identity, and ordinary Electron refreshes preserve their existing interaction attachment.

The corrected local package passes all nine installed workflow tests. The focused runtime, authoring and raster suite passes 80 tests, and a real Chromium/React regression verifies image remount and exact resource release. The original CI Blob UUID was not conclusively classified; the raster failure mechanism was reproduced independently. No authoring retries or console-error filters were added. Native run `41580676334` at `228566a3` subsequently passed all nine packaged tests on Windows Server 2025, Ubuntu 24.04, and both macOS architectures. All four candidate artifacts were produced.

### Requirement coverage and limits

| Requirement | Implemented mechanism and evidence boundary |
| --- | --- |
| R1 | Native Forge targets for macOS arm64/x64 ZIP, Windows x64 Setup.exe and Ubuntu x64 deb; independent Node, PDFium and service packaged. Native artifact results are recorded below. |
| R2 | One production React review tree, shared CSS/icons, native window chrome. Paired AppKit/Electron document-layout comparison above; additional sizes, DPI settings, states and OS desktops remain unqualified. |
| R3 | Separate candidate name/identifier; no automatic handler or integration registration. Explicit registration uses ownership receipts and refuses existing configuration. |
| R4 | Shared navigation, authoring, source/save/export model. Actual packaged save/edit/undo/redo/source-refresh tests pass; native clipboard, dialogs and every navigation modality still need interactive OS qualification. |
| R5 | Per-window bridges, duplicate-open registry, bounded presentation restoration, renderer failure retry. Two-window and close isolation pass; native Retry and Close after real renderer crashes pass; normal Quit restores bounds, page and zoom on macOS arm64. |
| R6 | Durable service recovery, exact-input normal-close barrier, pending-operation retirement. Service switch and crash evidence are distinguished from normal close. |
| R7 | Explicit Electron identity and native task-launch registry reuse canonical generation, revision, interaction and task authority. Correlated visible activation is required before task binding; focused and stale launch cases have service tests. |
| R8 | Exact service identity reuse; incompatible/uninspectable service refusal; explicit quiescent switch with verified recovery backup and exact readiness. No automatic incumbent kill or alternate writer root. |
| R9 | Sandboxed/context-isolated renderer, per-window request fences and custom resource protocols. Windows mutual challenge/epoch authentication and private ACL creation have independent code review and platform tests; actual Windows execution is recorded separately. |
| R10 | Sibling staging and durable publication; Windows write-through rename preserves ACLs and uncertainty. No delete-before-rename fallback. The real Windows lock test is not counted as passed on macOS. |
| R11 | Native CLI/Chrome launchers, explicit VS Code selection, packaged MCP and opt-in registration. Service contract and packaged discovery tests do not substitute for interactive external-host qualification. |
| R12 | Reproducible cold/warm launch and macOS CPU/memory measurement harness. Launch/CPU/RSS results and exploratory renderer responsiveness samples are recorded below; no claim of AppKit-equivalent resource use. |
| R13 | Personal build/selection instructions, artifact inventories and this report. The old Mac application is retained. |

AE1 is exercised in the packaged lifecycle test. AE2 native Retry after renderer crash passes with exact acknowledged draft text and an unaffected second document; the native Close choice also preserved the draft for explicit reopen and kept the peer usable. AE3 passes on native Windows CI: the test independently confirms an active sharing lock, preserves the original on failure and saves after an explicit retry. AE4–AE6 have service-level authority/lifecycle tests; complete installed Chrome/AppKit/task-host scenarios remain separate qualification work.

### Platform matrix

| Platform | Evidence status |
| --- | --- |
| Local macOS arm64 | Actual packaged review tests above; native macOS 15 arm64 CI ZIP and all nine packaged tests passed in run `41580676334` at `228566a3`; no installation over the user's app |
| macOS x64 | Native macOS 15 Intel CI ZIP and all nine packaged tests passed in run `41580676334` at `228566a3` |
| macOS 13 | Untested; compatible minimum version is not execution evidence |
| Windows Server 2025 x64 | Native run `41580676334` at `228566a3`: 85 platform unit/integration tests, locked-save/retry acceptance, installer build, and all nine packaged workflow tests passed. Setup.exe is a candidate artifact; an interactive Windows 11 install was not tested. |
| Windows 11 x64 | Untested locally; Windows Server CI cannot establish Windows 11 installer, DPI or Narrator behavior |
| Ubuntu 24.04 x64 | Native CI built and installed the deb, verified root-owned mode-4755 Chromium sandbox, and passed all nine packaged tests under Xvfb in run `41580676334` at `228566a3`, including the corrected refresh and raster paths. Interactive X11/Wayland and accessibility remain unqualified |
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

The corrected local renderer package also passed a [targeted resource regression](electron-resource-performance-2026-11-02-renderer-retention.json): 0.52% idle CPU over 60.04 seconds and 11.61% maximum post-close RSS growth across twelve cycles, within the same 2%/15% limits. Combined RSS was 388.7 MiB initially, 433.8 MiB at peak and 413.3 MiB finally. All recorded payload hashes matched before and after. The 160-launch matrix was not repeated for this renderer correction.

An earlier incomplete run lost the automation page target despite the renderer having initialized and remaining alive. Three bounded startup probes and the subsequent complete 160-launch run passed; no product cause was established. The harness now records raw target/disconnect diagnostics on recurrence. Another test failure was a normal-close/CDP-reply race; the corrected harness still requires the close event and idle-state checks.

[Responsiveness samples and screenshots](electron-responsiveness-2026-11-02.json) identify a later local package with the restoration fix. Across three cold launches, renderer first-contentful-paint ranged from 1.20 to 1.77 seconds; the first observed screenshot containing initial reader controls took 1.32 to 1.90 seconds from spawn. In one interactive session, 40 trusted keystrokes produced a p95 renderer response of 30.2 ms. The p95 animation-frame intervals were 17.5 ms while scrolling (320 intervals) and 17.6 ms while editing zoom (152 intervals).

These measurements observe renderer presentation opportunities, not physical display latency. The three launches do not qualify the 1.5-second p95 first-visible-shell target. A large scanned corpus, long-recovery cases, an AppKit resource comparison and comparable measurements on Windows and Linux remain open.

The recorded launch/resource, appearance and responsiveness runs identify their exact artifacts. They preceded the local Windows-drive link correction; they are not repeat measurements of each subsequent service payload. Windows links currently support local drive-letter PDFs; UNC shares and device paths remain rejected.

## Integrated native toolbar (2026-11-03)

The candidate now places native window controls in the reader toolbar: macOS traffic lights on the left, and Windows/Linux controls on the right. The toolbar reserves the native overlay's safe area and removes that reservation in fullscreen. Interface-size changes reposition or resize the native controls with the toolbar.

The local Mac package was visually checked at normal and increased interface size, at 600-point window width, and entering/leaving fullscreen. The user confirmed that dragging the blank toolbar moves the window normally. Automated native dragging was inconclusive; an unpackaged Electron diagnostic confirmed a native draggable region across the toolbar. Page input, save options, and the hover-revealed zoom menu work in the packaged acceptance check.

At `efd9682a`, typecheck and all configured regression suites passed: 1,712 unit/integration tests, 103 browser checks, and nine packaged-app tests. The service suite initially returned a safe `superseded` result in a test racing its filesystem observer; the affected file's 42 tests and the full 585-test service suite subsequently passed without service changes. Host integration initially found stale generated web payloads; rebuilding those distributions produced 399 unit/integration and 14 browser passes. The cancellation acceptance test now reads the acknowledged previous recovery snapshot only when the current pathname is temporarily absent during rotation; all exact draft and item assertions remain unchanged.

The focused titlebar review completed with no actionable findings. Native [run 41654616327](https://github.com/brad-ross/placekeeper/actions/runs/41654616327) passed on Linux but failed on Windows and both Mac architectures. The pending acceptance corrections account for the native overlay's actual height and the page-note region's optional count suffix; a fresh native run is still required for this revision.

The package containing the hover tracker passed a [Mac resource regression](electron-toolbar-performance-2026-11-03.json): 0.63% idle CPU over at least 60 seconds and 12.55% peak post-close RSS growth over twelve close/reopen cycles, within the unchanged 2%/15% limits. This measurement precedes the final spacing-only correction and does not isolate individual cursor-sampler callbacks or establish Windows/Linux performance.

## Historical qualification procedure

The subsequent local toolbar spacing correction was checked against the native screenshot with `Sample review.pdf`: the visible gaps between the traffic lights, filename icon/text, and page number are approximately 26 pixels on either side of the filename group. The final rebuilt package passed all nine installed-app checks. An earlier run failed to click the hover-revealed copy-link control; its focused retry and the final full suite passed. Reusing an old isolated preview root produced a lifecycle-registration alert, so the final visual check used a fresh isolated root with the earlier sample files retained.

See [personal build instructions](electron-personal-builds.md). Build the exact artifact before running `pnpm test:desktop-installed`; use `PLACEKEEPER_TEST_EXECUTABLE` to select another actual installation. `pnpm test:desktop-platform` includes real Windows-only checks and skips them on other hosts.

Rollback requires explicit `PLACEKEEPER_ROLLBACK_ELECTRON_RESOURCES` and `PLACEKEEPER_ROLLBACK_MAC_RESOURCES` pointing to newly built, manifest-verified resource directories. It uses a disposable recovery root and copied PDF. It proves packaged service-reader compatibility, not native AppKit GUI behavior.

Browser regression suites accept `PLACEKEEPER_BROWSER_TEST_PORT` for concurrent checkouts. Each run must serve this checkout, never reuse an unrelated test server. Performance measurements should run after builds and regression tests settle.
