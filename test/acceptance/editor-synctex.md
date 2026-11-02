# Editor-independent SyncTeX acceptance

Implementation plan: [editor-independent SyncTeX](../../docs/plans/2026-11-02-1033-feat-editor-independent-synctex-plan.md). Setup: [editor guide](../../docs/guides/editor-synctex.md).

This is a qualification record, not a release claim. The agent performs VS Code checks through Computer. Zed remains pending user installation. Per the user’s November 2 revision, Neovim live testing is not required and remains unverified. U7 remains incomplete until required checks pass. Sublime Text and Emacs are supplied as unverified recipes.

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
| Swift XCTest | Not run: installed Command Line Tools lack XCTest and no full Xcode installation was available. Swift executable compilation passed. |
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
| Native VS Code CLI profile | To be recorded | Editor-controlled CLI window routing; distinct from embedded precision | Outstanding — user check |
| Zed | Awaiting user installation | Steps 1–8 as applicable, including actual multi-window behavior | Pending installation |
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

These checks do not establish all steps 1–8. Native VS Code CLI routing, multi-window/native coexistence, annotation reconciliation, delayed-sidecar races, and remaining failure cases still need live qualification. Zed remains pending; Neovim is excluded from the required live gate.

### First-open fix verification

The extension previously read the active source cursor after creating a PDF panel, which had already cleared `activeTextEditor`. Capturing the cursor exposed two further startup gaps: delivery before the webview listener existed, and initial restoration reported idle before page geometry was available. The fix retains the explicit cursor, waits for a valid bootstrap handshake, and starts the viewer in restoring state until its existing restoration process completes. Workspace trust is rechecked when using the captured location.

Computer retest with the rebuilt extension and web assets: two separate fresh-panel forward searches reached page 2 on their first invocation, with no warning or retry. Command-click returned to `chapters/result.tex` line 2, column 1. Regression checks: 145 tests passed in the VS Code adapter/coordinator/observer and production-review-app suites; TypeScript passed. This resolves the recorded first-open defect, not the remaining full editor qualification matrix.
