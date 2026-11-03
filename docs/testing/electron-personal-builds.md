# Electron personal test builds

These candidates are separate from the installed Mac application. Their name is **Placekeeper Candidate**, macOS bundle identifier is `local.placekeeper.electron-candidate`, and Windows executable is `PlacekeeperCandidate.exe`. Packaging does not register a PDF handler, canonical URL protocol, browser native host, VS Code setting, or Codex configuration. Keep the current Mac app installed throughout evaluation.

## Build on the target OS

Use a clean checkout at a recorded commit, Node **24.22.1**, pnpm **11.16.0**, and `pnpm install --frozen-lockfile`. Electron **45.2.1**, Forge **8.0.1**, and independent daemon Node **24.22.1** are pinned. The build downloads the official Node archive for the selected target and checks its committed SHA-256 before extraction. Do not substitute Electron's embedded Node for the daemon writer runtime.

Run from the repository root:

```sh
pnpm catalog:check
pnpm exec vitest run packaging/desktop/packaging.test.ts
node --import tsx packaging/desktop/build.ts --target darwin-arm64
pnpm --dir apps/electron make --platform=darwin --arch=arm64
```

Use the matching target and Forge flags on each native build host:

| Build host | Build target | Forge flags | Personal artifact |
| --- | --- | --- | --- |
| macOS arm64 | `darwin-arm64` | `--platform=darwin --arch=arm64` | ZIP containing `.app` |
| macOS x64 | `darwin-x64` | `--platform=darwin --arch=x64` | ZIP containing `.app` |
| Windows x64 | `win32-x64` | `--platform=win32 --arch=x64` | Squirrel per-user `Setup.exe` with supporting packages |
| Ubuntu 24.04 x64 | `linux-x64` | `--platform=linux --arch=x64` | `.deb` |

Windows 11 provides `tar.exe` (bsdtar), used to extract the Node ZIP without shell interpolation. macOS and Linux extract the gzip tar archive with `tar`. Ubuntu needs the C compiler, `fakeroot`, and `dpkg` (`sudo apt-get install build-essential fakeroot dpkg`). macOS needs the command-line developer tools, including `clang` and `iconutil`; native entry points target macOS 13 or newer. On Windows, run from a Visual Studio x64 Native Tools shell with MSVC `cl.exe` available; the workflow configures that environment before building. Existing reviewed icon PNGs produce the desktop icons; Windows ICO embeds the existing 256px PNG. No public signing, notarization, automatic updates, or publishing is configured.

Run `make` immediately after building the same target. Forge checks the prepared payload and shell hashes and rejects changed/stale resources. Final packages are under `dist/desktop-artifacts/make`; intermediate unpacked applications are also under `dist/desktop-artifacts`. Building creates files in the checkout and never installs them.

## Manual CI artifacts

The `Desktop personal candidates` workflow is manual only and can also be called by the existing manual CI workflow. To build a feature branch before the new workflow is present on the default branch, dispatch **CI** at that branch with the `desktop_candidate` boolean set to `true`. Its default `false` runs the existing CI suite. With GitHub CLI, for example:

```sh
gh workflow run ci.yml --ref YOUR_BRANCH -f desktop_candidate=true
```

The candidate workflow uses macOS arm64 and Intel hosts, Windows Server 2025 x64, and Ubuntu 24.04 x64 ([GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)). It generates fixtures, runs native platform tests, builds each installer, and exercises the packaged application with Node absent from PATH. Linux runs the GUI check under Xvfb; it does not bypass the sandbox. The GUI smoke uses the unpacked application produced by Forge, so installation/uninstallation of the maker-produced installer still needs separate evidence. Each job uploads installers, `SHA256SUMS`, and build/runtime evidence for 14 days. It has read-only repository permissions and no release publisher. Downloaded artifact containers should be unpacked to obtain the maker-produced ZIP, Setup.exe, or deb; do not reconstruct a Mac app from individual files because its framework symlinks must remain intact.

A Windows Server build is **not** Windows 11 installation evidence. A hosted macOS build is **not** macOS 13 qualification. Successful workflow completion proves packaging on the recorded runner, not installed review behavior, accessibility, integration, or performance.

## Inspect identities and dependencies

Each application's `resources/desktop` directory (macOS: `Placekeeper Candidate.app/Contents/Resources/desktop`) includes:

- `runtime-manifest.json`: target, daemon/runtime identities, Node and service hashes/versions, and the complete served web asset inventory.
- `build-evidence.json`: source commit, dirty-checkout flag, lockfile hash, exact Electron and daemon Node versions, downloaded Node archive hash, payload hashes, and shell hashes. A dirty source commit alone cannot reproduce those local edits; retain the checkout or build from a clean commit.
- `node/LICENSE`: the independent Node runtime and bundled component notices.
- `licenses/`: the reviewed catalog attribution plus complete available license/notice files and an inventory for production dependencies and their transitive closure. Build fails if one has no notice file. This is conservative: a production dependency can appear even if tree-shaken from a particular bundle.

Electron's own license and Chromium notices remain in the application package. Record `process.versions` from an installed smoke test to capture the embedded Chromium and Electron Node versions in addition to the separately pinned daemon Node. Hash the final maker-produced artifacts, since their bytes differ from the payload identity and ZIP/installer metadata can vary between builds. These instructions reproduce inputs and payload inventories; they do not promise byte-identical installers.

The independent Node executable, service entry, served client, Electron client, PDF workers, WASM, notices, and launcher assets belong in the packaged resource inventory. The Electron shell resides in ASAR; executable daemon resources remain outside ASAR. Never run the source checkout's service as a substitute for an installed-artifact test.

## Install and evaluate deliberately

Use a disposable OS account first, with no existing Placekeeper install or service. Copy a PDF into a path containing spaces and Unicode. Record OS version, architecture, artifact SHA-256, source/payload identities, fixture hash, display scaling, and initial service state.

- **macOS:** Extract the maker ZIP with Archive Utility or `ditto -x -k`, preserving app framework symlinks. Move the candidate to a separate folder or `/Applications/Placekeeper Candidate.app`. Launch that exact application. An unsigned downloaded personal build can require the per-application **Open Anyway** action in Privacy & Security after an attempted open; do not globally disable Gatekeeper. Do not overwrite the existing Placekeeper app.
- **Windows 11:** Run the target's Squirrel `Setup.exe` as the current user. Record the actual installed path and launch that candidate. Unsigned downloads can produce SmartScreen prompts; inspect the expected build identity before choosing the per-file action. Squirrel installer lifecycle invocations must quit before normal single-instance registration, window creation, or daemon startup. Uninstall the candidate through Installed apps after evaluation.
- **Ubuntu 24.04:** Install the generated package with `sudo apt install ./PATH_TO_CANDIDATE.deb`, then launch its installed desktop entry/executable. Run the review session as an ordinary user. Do not add `--no-sandbox` or disable Chromium's OS sandbox to obtain a passing result. Record X11 versus Wayland. Remove the actual package name reported by `dpkg-deb -f PATH_TO_CANDIDATE.deb Package` after evaluation.

For a self-contained launch check, execute the installed candidate with Node absent from PATH (on macOS/Linux, for example, a minimal `/usr/bin:/bin` PATH). Confirm the daemon executable comes from `resources/desktop/node/bin`, the PDF workers/WASM load from packaged assets, and no source checkout or old Mac app is required. Repeat installer lifecycle events in a disposable Windows account and confirm no document window or daemon starts.

Opening multiple PDFs, duplicate focus, annotations, acknowledged Protected Draft recovery, source replacement, save/export, and renderer failure recovery must be exercised in the installed artifact. Test Windows replacement-denied behavior with a genuinely held file and verify original bytes and recoverable edits remain. Run the installed, platform, integration, visual, and performance qualification suites and record failures and untested combinations in the migration qualification report. The packaging unit tests are not substitutes for these checks.

## Candidate selection, integrations, and rollback

Normal use retains one canonical service authority. Close review windows and finish or retain acknowledged recovery before changing service versions. If the candidate reports an incompatible incumbent, stop and inspect that service and its active reviews; do not kill it or launch a second writer against the same PDF. An isolated test state must be explicit and must use disposable PDF copies, not documents currently open in the canonical service.

The standalone `launcher.mjs` is included in the resource payload and uses the bundled independent Node. Native entry points are in `resources/desktop/bin` (macOS: `Contents/Resources/desktop/bin`): `placekeeper` / `placekeeper.exe` forwards CLI arguments and `placekeeper-chrome-native-host` / `placekeeper-chrome-native-host.exe` starts the existing Chrome native protocol. They locate the bundled runtime relative to their own executable and preserve binary standard input/output, standard error, and the child exit status. They work while the GUI is closed. Registration must resolve the **installed candidate's** independent Node, launcher, and service paths. For Chrome registration, select the native-host executable, including the actual `.exe` on Windows. The validated existing extension bundle is under `resources/desktop/integrations/chrome-extension` (macOS: `Contents/Resources/desktop/integrations/chrome-extension`), ready for explicit Load unpacked setup in a disposable Chrome profile. Its existing extension key and native host identity are preserved; packaging alone does not load or register it. The existing Codex renderer and MCP server are bundled under `resources/desktop/codex-mcp` (`review-v1.html`, `server.js`, and module metadata). Point opt-in MCP configuration at the bundled Node executable and `codex-mcp/server.js`; use the native CLI entry point for candidate discovery. Browser, VS Code, and Codex integration setup remains an explicit separate action and must record candidate-owned changes for reversal. Verify setup and teardown in disposable host profiles before modifying a personal profile.

To roll back, close the candidate, confirm no active reviews or Task Bindings remain, stop its service through the normal quiescent service lifecycle, and launch the retained Mac application with compatible recovery data. Verify acknowledged recovery opens correctly using disposable recovery copies before a personal cutover. Removing the candidate must preserve review/recovery data and unrelated registrations. Do not remove the retained Mac app or switch default handlers as part of this evaluation.

## Current evidence boundary

See the [qualification report](electron-migration-qualification.md) for native CI artifacts, packaged workflow results, Mac appearance and performance measurements, and outstanding checks. The Mac candidate runs alongside AppKit; use disposable documents for evaluation. Windows Server CI does not establish Windows 11 installer, DPI, or accessibility behavior; Ubuntu Xvfb does not establish interactive Wayland behavior.
