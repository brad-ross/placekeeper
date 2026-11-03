# Editor-independent SyncTeX acceptance

Implementation plan: [editor-independent SyncTeX](../../docs/plans/2026-11-02-1033-feat-editor-independent-synctex-plan.md). Setup: [editor guide](../../docs/guides/editor-synctex.md).

This is a qualification record, not a release claim. The agent performs VS Code checks through Computer. Zed 1.26.2 is installed; recorded Computer checks appear below. Per the user’s November 2 revision, Neovim live testing is not required and remains unverified. U7 remains incomplete until required checks pass. Sublime Text and Emacs are supplied as unverified recipes.

## Automated and candidate evidence — November 2, 2026

Environment: Apple silicon, macOS 26.7.1; candidate app version 0.2.4; contained Node 24.14.0; TeX Live 2026. Candidate built from this PR stack into a temporary directory and relocated for command testing. No installation or release was published.

| Check | Result and scope |
|---|---|
| Service, security, web, source-rebuild, packaging regression run | 996/997 passed initially; the remaining native gate assertion looked for existing diagnostic text in its former file. Corrected to check the actual owner and caller; targeted gate passed. |
| Remaining default-suite review, save/export, and host integration tests | 872 tests passed across 39 files. Includes the VS Code materialization test that failed during an overlapping reviewer run. |
| Editor recipes | Four fixture tests passed: Texlab argv/settings, Zed argv/settings, executable Neovim helper token capture, and executable Sublime literal arguments. These do not prove editor UI placement. |
| TypeScript/lint and production bundles | Passed before final review fixes; final validation recorded below. |
| Native executable and candidate | Release build, contained resources, build identity, and ad-hoc signature validation passed. |
| Native PDF readiness | First smoke exceeded 60 seconds. Repeat with a 120-second budget passed document readiness and runtime activation. Interactive inspection also confirmed PDF rendering. |
| Swift XCTest | 49 tests passed on the macOS 15.8.2 ARM64 CI runner with Xcode 16.4 and Swift 6.1.2; run 41554458506. Local Command Line Tools still lack XCTest. |
| Installed cold/warm SyncTeX and return | Passed with a two-page fixture in a path with spaces, relocated test app, unrelated cwd, bundle-contained Node, and isolated daemon/editor state. Native AX inspection showed line 5 → page 2, line 3 → page 1 in the same window, then quit/relaunch → page 2. File → Go to Source invoked the capture executable with the expected source file, line 5, column 1. This is process-delivery evidence, not a real-editor UI result. |

Final combined Vitest run: **1,374 tests passed across 75 files**. Eight mounted browser regressions passed in both Chromium and WebKit. They cover request replacement, clearing, unmount, successful/failed acknowledgements, repeated forward/cancel/reverse commands, point-inverse retirement before readiness and during navigation, and the rendered VS Code acknowledgement. The concurrent-admission root fix subsequently passed 49 targeted tests. After arranging the PRs, 182 focused tests and TypeScript passed. Final PR-specific review fixes passed 31 native/runtime tests, 5 focused VS Code acknowledgement tests, 49 coordinator/runtime tests, and TypeScript.

Installed testing caught and fixed dropped outer-bridge navigation events and canonicalization of an approved absolute compiler source path. Relative source paths resolved through a different directory alias can still differ from the compiler spelling; the guide documents using the matching absolute path or rebuilding with the editor path. The installed check used `/tmp/pk-editor-smoke/source with spaces/main.tex`, its `build/main.pdf`, and a capture executable that records argv without opening a real editor.

Review fixes also cover displayed-generation fencing before native reverse dispatch, actionable return-editor failures, renderer-acknowledged manual navigation, and zero-based SyncTeX column conversion, native forward/reverse ordering, captured follow invalidation after inverse search, VS Code inverse-gesture precedence, delayed source-document focus, and presentation roots during concurrent admission. None substitutes for the required checks below.

## Fixture and repeated procedure

Use a temporary project whose path contains spaces, with `main.tex`, an included `chapters/result.tex`, `build/main.pdf`, and matching `build/main.synctex.gz`. Include distinguishable text on at least two pages and enough source lines to identify the expected destination. Build with `latexmk -pdf -synctex=1 -outdir=build main.tex`. For the alternate mapping-directory case, place only the matching sidecar in a separate directory and pass `--synctex-directory`.

Record the app build identity, extension version, editor version, TeX distribution/SyncTeX version, fixture paths, command/settings, observed file/line/page, and screenshot or log evidence. Use a registration for the actual originating editor session. Never include live session or association tokens in a shared report.

1. With the native app closed, run explicit forward search to an included source line on page two from a directory outside the checkout. Verify the native PDF and destination, then repeat to page one and verify the same window is reused. Repeat after relocating the app.
2. Invoke reverse search at a distinguishable PDF point. Verify the actual file and line in the originating editor; record column behavior separately where supplied. Optional Neovim qualification, if installed later: use two sockets and verify the intended instance. For Zed, record its chosen window rather than claiming exact session routing.
3. Rebuild while reading another page at a custom zoom. With following off, verify refresh preserves the reading position. Enable following explicitly, capture before building, and verify the saved cursor is followed. Disable it again.
4. Delay sidecar publication, issue A then B navigation, and finish A last. Only B may navigate. Repeat with editor A, editor B, then editor A again; an old automatic follow must not retake the view or return editor.
5. Open a native view and an embedded VS Code view of the same PDF. Verify their source roots and editor associations remain independent. Repeat manual forward search twice and inverse search while a saved-cursor follow is pending.
6. Open the PDF directly in Finder. On first inverse search, cancel setup and confirm reading remains available with no association. Retry with an editor and source root, then verify source return.
7. Remove the sidecar, use an ambiguous pair, remove the editor/socket, and choose a source outside the approved root. Verify actionable failure, no unintended editor launch, and continued reading.
8. Add annotations, rebuild with moved and removed text, and verify the existing reconciliation behavior and unresolved attachments. Confirm no stale mapping is used for the refreshed PDF.

## Editor results

| Editor | Versions / fixture | Forward, inverse, refresh, ordering, routing evidence | Status |
|---|---|---|---|
| Embedded VS Code | VS Code 1.141.0 arm64; extension 0.1.1 development host; candidate 0.2.4 | Computer results below | Partial — tested checks pass; remaining qualification pending |
| Native VS Code CLI profile | VS Code 1.141.0; packaged extension 0.1.1; candidate 0.2.4 | Native/embedded coexistence and native return below | Core checks passed |
| Zed | 1.26.2; native candidate 0.2.4; TeX Live 2026 | Task/round-trip, multi-window routing, refresh, follow precedence, delayed mapping below | Core checks passed; broader host qualification pending |
| Neovim | Not installed in this qualification environment | Automated adapter/recipe coverage only; live two-socket and buffer tests optional | Unverified — not a required gate |
| Sublime Text | Not exercised | Recipe fixture only | Unverified |
| Emacs | Not exercised | Configuration review only | Unverified |

A skipped or unavailable editor is not a passing result. Keep these gates visible in the PR and release notes until evidence resolves them.

## Computer-driven VS Code evidence — November 2, 2026

Isolated development host loaded the repository extension (0.1.1), using candidate `/tmp/placekeeper-synctex-reviewed/Placekeeper.app` via a wrapper with private HOME and TeX PATH. This does not qualify a marketplace/VSIX installation. VS Code 1.141.0 arm64, commit `2a59476c9bfcb90b3ddc372c36762471b7dfad1c`; TeX Live 2026, latexmk 4.88, SyncTeX 1.5. Fixture: `/private/tmp/pk-vscode-acceptance/project with spaces`, included `chapters/result.tex`, output `build/main.pdf`. UI actions and observations used Computer native accessibility and screenshots.

- **Initial opening failure, fixed below:** forward from `result.tex` line 2 opened the PDF on page 1 with “Forward SyncTeX is unavailable. PDF review remains available.” Direct SyncTeX queries against both output and private snapshot returned page 2. Subsequent warm invocation succeeded. Closing the PDF panel and forwarding into a fresh panel reproduced the same warning and page-1 result. Root cause and fix recorded below.
- **Passed warm navigation:** toolbar forward from `result.tex` line 2 reached page 2; Command-click on the chapter passage focused `result.tex`, line 2, column 1. Forward from `main.tex` line 3 reached page 1 in the same panel.
- **Passed refresh with following off:** rebuild changed the included source; image identities changed while page 1 and custom 93% zoom remained.
- **Passed enabled following:** enabled `placekeeper.followAfterBuild`, saved an edit with cursor on chapter line 2, then compiled. The PDF moved from page 1 to page 2 and retained 93% zoom.
- **Passed manual precedence:** saved another chapter edit, manually navigated to `main.tex` line 3 before compilation, then compiled. The refreshed PDF remained page 1 at 93%; the older chapter follow did not retake it.

These checks do not establish all steps 1–8. Native VS Code CLI routing, multi-window/native coexistence, annotation reconciliation, delayed-sidecar races, and remaining failure cases still need live qualification. Zed results are recorded below; Neovim is excluded from the required live gate.

### First-open fix verification

The extension previously read the active source cursor after creating a PDF panel, which had already cleared `activeTextEditor`. Capturing the cursor exposed two further startup gaps: delivery before the webview listener existed, and initial restoration reported idle before page geometry was available. The fix retains the explicit cursor, waits for a valid bootstrap handshake, and starts the viewer in restoring state until its existing restoration process completes. Workspace trust is rechecked when using the captured location.

Computer retest with the rebuilt extension and web assets: two separate fresh-panel forward searches reached page 2 on their first invocation, with no warning or retry. Command-click returned to `chapters/result.tex` line 2, column 1. Regression checks: 145 tests passed in the VS Code adapter/coordinator/observer and production-review-app suites; TypeScript passed. This resolves the recorded first-open defect, not the remaining full editor qualification matrix.

## Computer-driven Zed evidence — November 2, 2026

Zed 1.26.2 from `/Applications/Zed.app`, CLI `Contents/MacOS/cli`; candidate `/tmp/placekeeper-zed-acceptance/Placekeeper.app` (0.2.4, rebuilt with the first-open fix), isolated service on loopback port 49229 and private HOME. Native process was explicitly started with that HOME; these results do not prove a cold LaunchServices launch with custom test environment. Fixture `/private/tmp/pk-zed-acceptance/project with spaces`, included chapter and separate `build/main.pdf`; task uses the corrected working-tree recipe. LaTeX extension was not installed; this tests Zed tasks, not Texlab.

- **Found and fixed task quoting:** the original args array was joined by Zed into a shell command, splitting both PDF/source paths at spaces. Actual task argv and exit status 2 confirmed the failure. The corrected task passes values through environment variables and quoted shell expansions. The updated executable shell regression fails before the fix and passes with spaces, apostrophe, dollar sign, backtick and semicolon in filenames. All four editor-recipe tests pass.
- **Task forward and inverse passed:** actual Zed task at `chapters/result.tex` line 2 opened native page 2. Command-click on the first text line returned to that file at line 2, column 1. File → Go to Source also returned to the included file (line 3 for the viewport-center query).
- **Current cursor/window reuse passed:** spawning the task from `main.tex` line 3 passed that new source/row and moved the same native PDF window to page 1.
- **Refresh preservation passed:** at page 1 and custom 159% zoom, rebuilding changed page images without changing page or zoom.
- **Multi-window return observed:** with a second, unrelated Zed workspace active, native Go to Source selected the existing fixture workspace and `main.tex`. This is observed CLI behavior, not a promise of exact originating-window routing.
- **Native follow and precedence passed:** CLI follow using the current Zed association reached the chapter on page 2 at 159%. After a newer explicit request to page 1, replaying the old association was rejected as stale and page 1 remained. This exercises the native follow protocol, not a Zed automatic-build hook.
- **Delayed mapping passed:** published a changed PDF while withholding its sidecar. Forward search displayed “Waiting for SyncTeX data for this PDF…” and kept page 1 readable. Publishing the matching sidecar resumed the pending request to page 2 with no manual retry.

Remaining live qualification: cold launch through the normal installed environment; packaged VSIX installation; native VS Code CLI routing and native/embedded coexistence/editor takeover; direct Finder setup/cancel; ambiguous mapping, unavailable editor and out-of-root errors; annotation reconciliation with moved/removed text. Existing automated coverage does not turn these remaining live checks into passes. Swift XCTest remains unavailable without full Xcode.

## Final packaging and regression checks — November 2, 2026

- **Passed packaged VSIX installation:** VS Code's supported CLI installed the candidate VSIX into fresh `/tmp/pk-final-vscode/user` and `/tmp/pk-final-vscode/extensions` directories and reported `placekeeper-local.placekeeper-vscode@0.1.1`. All 12 bundled files match the installed files; the manifest differs only by VS Code's added `__metadata`. Actual activation and navigation in this installed profile remain pending.
- **Passed final native packaging:** rebuilt `/tmp/placekeeper-final-acceptance/Placekeeper.app` with the corrected Zed recipe. Candidate resource/identity validation and strict deep code-signature verification passed. Its VSIX is byte-identical to the one installed above, and its Zed recipe matches the source tree.
- **Passed focused regressions:** 98 tests across VS Code extension/rebuild navigation, editor return adapters/handoff, and integration recipes; TypeScript passed. The initial sandboxed run could not open local test sockets; the run with socket access passed all tests.
- **Live checks blocked:** Computer reported the Mac locked with automatic unlock paused after physical input. An unlock is required before continuing the remaining native/editor interactions. No unobserved interaction is recorded as passing.
- **Swift test execution pending:** the manual CI workflow now includes a macOS runner with Xcode and a `native_only` input, allowing Swift XCTest to run without installing full Xcode locally. A workflow definition is not a passing test result; the run outcome must be recorded after execution.

## Native qualification follow-up — November 2, 2026

- **Swift XCTest passed:** [run 41554458506](https://github.com/brad-ross/placekeeper/actions/runs/41554458506) ran all 49 tests with zero failures. Earlier runs exposed stale fixtures and a real public-link parser bug: Foundation represents the empty authority in `placekeeper:///` as an empty string. The parser now accepts that representation while rejecting remote authorities, query data, and malformed paths. Refresh fixtures dispatch replies to their expected helper request type when navigation polls are also queued.
- **Unassociated native setup cancellation and return passed:** after reopening the isolated test review without an editor binding, Go to Source offered setup; Cancel retained the rendered two-page document at page 1 and 179% zoom. Retrying setup, selecting the Zed profile and the fixture source root, then Go to Source opened `main.tex` in the existing Zed fixture workspace. This verifies setup behavior; direct Finder cold opening is a separate check.
- **Coexistence failure found:** native editor admissions previously created standard-mode sessions, which rejected VS Code generated-output admission. A trusted navigation admission fix and real-broker regression are under review; live retest remains pending.

### Corrected candidate live checks

Candidate `/tmp/placekeeper-coexistence-reviewed/Placekeeper.app`, isolated daemon on port 49239, private HOME `/tmp/pk-coexistence-acceptance/home`, source fixture `/private/tmp/pk-coexistence-acceptance/project with spaces`. Packaged VSIX remains the verified 0.1.1 payload in the isolated VS Code profile.

- **Native-first/embedded coexistence passed:** Zed-profile native forward opened page 2. The installed VSIX then opened the same PDF on page 2 without the former admission failure. Native VS Code-profile forward moved the native window to page 1 while embedded reading remained page 2. Native Go to Source opened `main.tex` at line 3, column 1 in the specified isolated VS Code profile. The `/tmp` versus `/private/tmp` alias caused VS Code's ordinary untrusted-file prompt; only the generated fixture was approved, without changing global prompt preferences.
- **Out-of-root failure passed:** the initially copied sidecar referenced the prior fixture directory. Embedded inverse search displayed “The SyncTeX source location is outside the approved workspace” and retained the readable PDF. Recompilation in the current root supplied the valid mapping used for native return.
- **Missing-sidecar failure passed:** a separately opened PDF without either sidecar stayed readable on page 1 and displayed “Waiting for SyncTeX data for this PDF…”.
- **Ambiguous-sidecar rejection passed:** a fresh PDF with both `.synctex` and `.synctex.gz` stayed readable and refused navigation. Its generic error was insufficiently specific; the final message now instructs the user to keep only the matching sidecar format. Live verification of the revised wording follows the final web rebuild.
- **Unavailable-editor failure passed:** registered a disposable executable, moved it aside, then requested inverse search. The PDF stayed on page 2 at 157% and explained that the return editor was unavailable and needed re-registration. No fallback editor was selected.
- **Direct document opening and setup passed:** opened a fresh fixture through macOS `open -a` without an editor ticket (the same document-open route used by Finder). First Go to Source offered setup; cancellation retained page 1 at 179%. Choosing Zed and the approved fixture root enabled return to `main.tex`. A later VS Code-profile forward reused this review on page 2 while preserving standard-mode automatic-save behavior.
- **Annotation reconciliation passed:** created a highlight and comment on “sentence” through the native UI. Adding 3 cm of vertical space moved its resolved anchor from y=161 to y=246 PDF points in generation 3. Removing the sentence retained its comment and exposed “Reattach previous Highlight annotation … Missing text” in generation 4.
- **Refresh preservation defect found:** page 2 with an explicit 157% zoom reset to page 1 at fit width during rebuilding and remained in “Restoring the prior reading position” until a later explicit navigation. Reproduced with the workspace closed. This gate remains open until the final fix and live retest.
- **Normal-environment cold launch blocked by user choice:** another incompatible service had existing reviews. The candidate refused replacement and preserved them. The user explicitly requested keeping those reviews open and leaving this check blocked; no default-environment service was stopped.
- **Final native CI passed:** [run 41555516017](https://github.com/brad-ross/placekeeper/actions/runs/41555516017) passed after the native admission serialization change. Local final admission suite: 55 tests across four files; TypeScript passed.

### Final refresh fix verification

Candidate `/tmp/placekeeper-refresh-final/Placekeeper.app` uses the same isolated fixture and daemon port. New document resources previously replaced the predecessor viewer before its asynchronous reading-location capture finished. The viewer now retains the predecessor state/resources until capture completes, then commits the successor generation and resources together.

- **Native repeated refresh passed:** selected page 2 at explicit 157% zoom, rebuilt with changed chapter text and vertical spacing, and rebuilt again with different spacing. The rendered document showed the new text, remained on page 2 at 157%, and returned to “The document is ready” without a manual navigation request.
- **Ambiguity wording passed:** forwarding into the two-sidecar fixture left page 1 readable and displayed “Multiple SyncTeX sidecars were found. Keep only the matching .synctex or .synctex.gz file, then retry.”
- **Regression coverage:** the delayed-capture browser case holds the actual reading capture while a real broker successor arrives; it checks that the predecessor viewer remains mounted, then restores the moved passage at 157%. A second browser case checks repeated generation replacements, page relocation, zoom and focus. Both pass on the final source. All 67 production-review-app unit tests and TypeScript pass. Focused independent correctness and adversarial review found no actionable issues.

The normal-environment cold-launch check remains blocked at the user's explicit request to preserve the other service's open reviews. Live Neovim testing is optional and unverified; Sublime Text and Emacs remain unverified recipes. Earlier outstanding-check lists describe their point in the qualification sequence; the follow-up results above supersede them where explicitly tested. No release or merge is implied by these checks.

### Zed Texlab qualification

Zed 1.26.2, LaTeX extension 0.2.3, bundled Texlab 5.26.0, latexmk 4.88 and Placekeeper candidate 0.2.4. The two-page fixture used a project path containing spaces and a separate build directory. This run exercised the extension's opt-in build-on-save preview.

- With the viewer and build settings only in the trusted project's `.zed/settings.json`, Zed started Texlab and sent the save event, but answered Texlab's configuration request with the extension's default build settings and no viewer.
- With `lsp.texlab.settings.texlab` in Zed **user settings**, the configuration exchange included the requested build and viewer. Saving an edit on line 5 invoked latexmk, and the Texlab process launched the viewer with the correct `build/main.pdf`, `main.tex` and line 5. A fixture-only logging wrapper forwarded the arguments to the installed candidate, which opened page 2.
- Native **File → Go to Source** returned to the existing Zed workspace at `main.tex` line 5, column 1. No Zed task was invoked. The temporary user settings were removed after testing.

### Seamless Zed installation and persistent approval — November 2, 2026

Candidate `/tmp/placekeeper-zed-ready/Placekeeper.app`; Zed 1.26.2, existing LaTeX extension 0.2.3, bundled Texlab 5.26.0. Installed artifact identity: `950f99dc1b430aa00435e2b3f9cfecc2b24f2df7d49f89ed9969b149ac44419c`. The isolated run used private HOME `/private/tmp/pk-seamless-live/home`, loopback port 49249, and a two-page fixture under `paper with spaces`, with `main.tex` and separate `out/main.pdf`. Temporary Zed user settings routed the generated callbacks through a shim that selected only the private HOME; the normal user service and its reviews were not changed.

- **Installed setup passed:** the candidate's actual `setupHost` generated the Zed user settings and global manual task. JSONC comments, the custom latexmk executable/arguments, and the `out` output directory were preserved. This used Zed's existing LaTeX extension; no Placekeeper Zed extension, manual session registration, or project source-root grant was needed during installation.
- **First-use approval and preview passed:** saving an edit at `main.tex` line 5 built the document and opened the native **Allow Zed Source Navigation** folder picker. Approving the exact fixture project opened page 2. The final chooser uses the native app helper; an earlier invisible AppleScript chooser was replaced before this check.
- **Inverse navigation passed:** native **Go to Source** returned to the existing Zed workspace at line 5, column 1.
- **Persistence across restart passed:** after restarting the isolated app and daemon, another edit and save reached page 2 without another approval, settings edit, or session command.
- **Installer-created manual navigation passed:** spawning the generated global **Placekeeper: Forward SyncTeX** task from line 3 reached page 1.
- **Automated checks passed:** 99 tests across the final seven focused installer/adapter/service files; the initial combined setup/packaging/source-release run's 108 passing checks, the added standalone bundled-JSONC/license/identity check, and three targeted notice/baseline/package checks passed. TypeScript and `git diff --check` passed. Independent review exercised 137 tests and reported no actionable findings.

A live second-project approval was not exercised; the 21-test adapter suite includes coverage for persistent approval of multiple source roots. A canceled preview build wrapper may suppress further automatic PDF jumps until Texlab restarts; restarting the language server clears that state. Exact originating-window routing remains Zed's CLI behavior. These isolated results do not close the normal-environment cold-launch gate that remains blocked at the user's request to preserve existing reviews.
