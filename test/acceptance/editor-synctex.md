# Editor-independent SyncTeX acceptance

Implementation plan: [editor-independent SyncTeX](../../docs/plans/2026-11-02-1033-feat-editor-independent-synctex-plan.md). Setup: [editor guide](../../docs/guides/editor-synctex.md).

This is a qualification record, not a release claim. The user owns the personal VS Code, Zed, and Neovim checks below. U7 remains incomplete until they are recorded. Sublime Text and Emacs are supplied as unverified recipes.

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

Final combined Vitest run: **1,374 tests passed across 75 files**. Five mounted browser regressions passed in both Chromium and WebKit. They cover request replacement, clearing, unmount, successful/failed acknowledgements, and repeated forward/cancel/reverse commands. The concurrent-admission root fix subsequently passed 49 targeted tests and TypeScript.

Installed testing caught and fixed dropped outer-bridge navigation events and canonicalization of an approved absolute compiler source path. Relative source paths resolved through a different directory alias can still differ from the compiler spelling; the guide documents using the matching absolute path or rebuilding with the editor path. The installed check used `/tmp/pk-editor-smoke/source with spaces/main.tex`, its `build/main.pdf`, and a capture executable that records argv without opening a real editor.

Review fixes also cover zero-based SyncTeX column conversion, native forward/reverse ordering, captured follow invalidation after inverse search, VS Code inverse-gesture precedence, delayed source-document focus, and presentation roots during concurrent admission. None substitutes for the user-owned checks below.

## Fixture and repeated procedure

Use a temporary project whose path contains spaces, with `main.tex`, an included `chapters/result.tex`, `build/main.pdf`, and matching `build/main.synctex.gz`. Include distinguishable text on at least two pages and enough source lines to identify the expected destination. Build with `latexmk -pdf -synctex=1 -outdir=build main.tex`. For the alternate mapping-directory case, place only the matching sidecar in a separate directory and pass `--synctex-directory`.

Record the app build identity, extension version, editor version, TeX distribution/SyncTeX version, fixture paths, command/settings, observed file/line/page, and screenshot or log evidence. Use a registration for the actual originating editor session. Never include live session or association tokens in a shared report.

1. With the native app closed, run explicit forward search to an included source line on page two from a directory outside the checkout. Verify the native PDF and destination, then repeat to page one and verify the same window is reused. Repeat after relocating the app.
2. Invoke reverse search at a distinguishable PDF point. Verify the actual file and line in the originating editor; record column behavior separately where supplied. For Neovim, use two sockets and verify the intended instance. For Zed, record its chosen window rather than claiming exact session routing.
3. Rebuild while reading another page at a custom zoom. With following off, verify refresh preserves the reading position. Enable following explicitly, capture before building, and verify the saved cursor is followed. Disable it again.
4. Delay sidecar publication, issue A then B navigation, and finish A last. Only B may navigate. Repeat with editor A, editor B, then editor A again; an old automatic follow must not retake the view or return editor.
5. Open a native view and an embedded VS Code view of the same PDF. Verify their source roots and editor associations remain independent. Repeat manual forward search twice and inverse search while a saved-cursor follow is pending.
6. Open the PDF directly in Finder. On first inverse search, cancel setup and confirm reading remains available with no association. Retry with an editor and source root, then verify source return.
7. Remove the sidecar, use an ambiguous pair, remove the editor/socket, and choose a source outside the approved root. Verify actionable failure, no unintended editor launch, and continued reading.
8. Add annotations, rebuild with moved and removed text, and verify the existing reconciliation behavior and unresolved attachments. Confirm no stale mapping is used for the refreshed PDF.

## User-owned editor results

| Editor | Versions / fixture | Forward, inverse, refresh, ordering, routing evidence | Status |
|---|---|---|---|
| Embedded VS Code | To be recorded | Steps 1–8 as applicable; include current extension version | Outstanding — user check |
| Native VS Code CLI profile | To be recorded | Editor-controlled CLI window routing; distinct from embedded precision | Outstanding — user check |
| Zed | Not installed in this qualification environment | Steps 1–8 as applicable, including actual multi-window behavior | Outstanding — user check |
| Neovim | Not installed in this qualification environment | Steps 1–8 as applicable, including two sockets and unsaved buffer protection | Outstanding — user check |
| Sublime Text | Not exercised | Recipe fixture only | Unverified |
| Emacs | Not exercised | Configuration review only | Unverified |

A skipped or unavailable editor is not a passing result. Keep these gates visible in the PR and release notes until evidence resolves them.
