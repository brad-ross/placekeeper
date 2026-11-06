# Placekeeper

Placekeeper is a focused everyday PDF reader and annotator for serious readers. It preserves your place and train of thought across annotation, search, and nested reference lookup, produces a portable reviewed PDF from a recoverable session, and can supply task-scoped live PDF and annotation context to its Codex plugin.

<img src="packaging/macos/icon/Placekeeper.svg" alt="Placekeeper's two-page reference-and-return app icon" width="128">

## Install

The current desktop application uses Electron on macOS, Windows, and Linux. Use [published releases](https://github.com/brad-ross/placekeeper/releases/latest) for available downloads, notes and checksums. A complete desktop release provides Apple Silicon and Intel Mac DMGs, Windows x64 Setup.exe and Ubuntu/Debian x64 deb packages, including all runtime dependencies without a development toolchain. Use **Install Placekeeper.app** inside the DMG, **Setup.exe**, or the OS package manager; see the [installation guide](docs/installation.md).

Version **0.2.4** was the older AppKit source-only release for Apple Silicon Macs. The new Electron installer set is published after all four hosted builds and packaged runtime tests pass, with exact source and artifact provenance. Locally built artifacts do not establish downloaded OS approval or public-release migration.

From a checkout, install Node.js 24+, pnpm 11.16.0, and a native C compiler, then run `./install.sh` on macOS/Linux or `./install.ps1` from Visual Studio Developer PowerShell on Windows. The source installer builds locally and installs the app with its own Node runtime; system Node is needed to build, not to run the installed app. Run with `--dry-run` to inspect the destination first.

See [Install and uninstall](docs/installation.md) for platform paths, build requirements, updates, and optional integrations. See [manual upgrades and recovery](docs/desktop-upgrades.md) before replacing an existing installation. Current replacement qualification is [recorded separately](docs/testing/electron-migration-qualification.md); previous candidate results do not qualify the latest replacement. See [Privacy and recovery](docs/privacy-and-recovery.md) for local storage behavior.

### Web beta (not yet published)

A front-end-only web beta is implemented as a lightweight, export-only companion to the full Placekeeper app. It can open one local PDF or a compatible public HTTPS PDF, create and edit Review Items, export a reviewed copy, and restore Placekeeper-owned items as editable when that copy is uploaded again. It has no autosave or reload recovery: exporting is the only durability action. The project-site build is for non-confidential PDFs, and remote URL use discloses the complete URL and ordinary request metadata to the remote host.

The public link is intentionally absent. Publication under the Placekeeper name remains blocked until the external clearance, protected deployment, live-origin smoke, and real-Safari qualification in the [web beta runbook](docs/web-beta.md) are complete. See [Privacy and recovery](docs/privacy-and-recovery.md#front-end-only-web-beta) and [Support and diagnostics](docs/support.md#web-beta) before testing a local build.

## Use

After installation, open Placekeeper and choose a local PDF. On macOS you can also choose **Open With → Placekeeper** in Finder. PDFs open in an Electron window with bundled review and PDF assets. Installation does not automatically select Placekeeper as the OS default PDF handler. The app performs no telemetry, and leaves the original PDF unchanged unless you explicitly choose the separately confirmed Replace Original action.

On macOS, Chrome 151 or newer can render top-level PDFs in the complete Placekeeper review client without leaving the PDF's original tab or URL. Choose Chrome in first-launch setup or **Help → Set Up Integrations**, then load the prepared **Placekeeper PDF Viewer** extension from the runtime folder reported by setup, then turn on **Open PDFs automatically** from its Placekeeper toolbar popup. It begins paused, offers a one-PDF **Use Chrome viewer** bypass before activation, and does not change Placekeeper's macOS PDF-handler rank. See [Install and uninstall](docs/installation.md#open-chrome-pdfs-automatically) for setup and troubleshooting.

Desktop app launches open Electron windows; Codex plugin launches open the shared review in a native MCP panel. Ordinary browser launches keep readable local review addresses whose fragment records only the current page or a saved Placekeeper item. Chrome-intercepted PDFs instead retain their source URL; Placekeeper Back and Forward traverse document locations without adding browser-history entries, so browser Back returns to the page before the PDF. Chrome therefore omits the redundant document-level **Copy Link**, while precise item links still emit capability-free `placekeeper:///…` app links. A matching verified source and PDF digest rejoin the same service-owned review after reload or reopen, while every tab receives its own presentation lease.

When another application saves or replaces an open local PDF at the same path, Placekeeper refreshes it automatically in the desktop app, Chrome, the native Codex panel, ordinary browsers, and VS Code. This also applies to ordinary PDFs with no LaTeX project. Placekeeper keeps the last valid version through a missing, partial, unreadable, or invalid write and resumes when a valid replacement appears. Identical bytes do not reload the review.

Automatic refresh waits while any window in the shared review is creating, editing, or manually reattaching an annotation, including a background window. It resumes after every active interaction is saved, cancelled, closed, or disconnected. Saved annotations and protected drafts are reconciled with the newest valid PDF; uncertain or missing attachments remain available for manual reattachment rather than being assigned to a guess. Each view keeps its own reading place and zoom when possible.

With the bundled Codex plugin installed, ask Codex to open one explicit local PDF in Placekeeper. The hosting task is bound only after the installed launcher and native display receive matching trusted hook attestations. Each later prompt refreshes the current Review Items, Existing PDF Annotations, and save status; Codex retrieves bounded PDF text, layout, render, or annotation evidence only when needed. Finder, ordinary-browser, and VS Code launches remain unbound and show no Codex control. After an update, review plugin trust and enablement, fully quit and restart Codex, then use a new task. A remounted or disconnected panel offers **Reconnect**: explicitly ask its chat to reconnect; accepted work remains recoverable. The remembered PDF hint lasts only while the local service lives (up to 24 hours), so supply the PDF again after a service restart.

### Navigate between LaTeX source and the desktop PDF viewer

The installed `placekeeper` command supports local editor profiles and the shared `view-source --editor NAME --source PATH --line N [--pdf PATH]` command, which handles source approval and session renewal. Low-level session registration and `forward-search` remain available. **Review → Go to Source** returns through the current editor association; directly opened PDFs offer an editor and source-folder chooser. Command-click on macOS or Ctrl-click on Windows/Linux also returns a PDF location to source. A native TeX `synctex` executable and matching mapping file are required. See the [editor setup guide](docs/guides/editor-synctex.md) for VS Code, Zed, Neovim, Sublime Text, and Emacs recipes and their verification status.

### Editor integrations

First launch offers independent, default-off VS Code, Chrome and Codex choices, with Skip and **Help → Set Up Integrations** for later. Setup failure does not block reading. Prepared/registered means host trust, enablement, reload or verification can still be pending. See the [installation guide](docs/installation.md#optional-integrations). Zed setup below remains a Mac source-installer option.

Select Zed setup in the installer and choose **manual** (jump on demand) or **preview** (jump after a successful build). Placekeeper configures Zed’s existing LaTeX extension to use the shared viewer command and preserves your build command and output directories. Preview retains the build wrapper so delayed automatic requests cannot overtake manual navigation. Run **task: spawn → Placekeeper: Forward SyncTeX**, then approve the source folder on first use. Use `--zed=manual` or `--zed=preview` for explicit installation choices. See the [Zed setup guide](docs/guides/editor-synctex.md#zed).

Select VS Code setup, apply the prepared launcher setting and install/refresh its extension as reported, then reload the VS Code window. You can skip it and rerun later. If the CLI is unavailable, use **Extensions: Install from VSIX** with `~/Applications/Placekeeper.app/Contents/Resources/integrations/placekeeper.vsix`, open a local trusted LaTeX workspace, and run **Placekeeper: View PDF** or **Placekeeper: Forward SyncTeX**. The extension opens the shared Placekeeper client directly in one reusable VS Code panel. Its JavaScript, CSS, inline PDFium worker, and PDFium WASM are integrity-checked local extension assets; the working loop uses no iframe, external browser, or network fallback.

Placekeeper observes successful LaTeX output replacement but does not build LaTeX or write the generated PDF. Refresh preserves reading position by default. Set `placekeeper.followAfterBuild` to `true` only if you want the embedded panel to follow the saved source cursor after builds; manual SyncTeX commands remain available with the setting off. After a rebuild, the same panel refreshes atomically, preserves current or explicitly unresolved Review Items, and shows **possibly stale** when a saved source has no valid successor. **Placekeeper: Export Reviewed PDF** is the only reviewed-PDF write path and always targets a distinct file.

LaTeX Workshop 10.18.x users may opt into **Placekeeper: Configure LaTeX Workshop** after opening the output in Placekeeper. The command previews workspace-only changes and uses the installed scoped launcher at `~/Applications/Placekeeper.app/Contents/MacOS/placekeeper-vscode`; it never changes user settings. Because LaTeX Workshop does not provide a supported custom-viewer API, this compatibility route is best-effort. If its probe fails, if LaTeX Workshop is absent, or on the VS Code 1.95 support floor, use the supported **Placekeeper: View PDF** and **Placekeeper: Forward SyncTeX** commands. **Placekeeper: Restore LaTeX Workshop Settings** restores only values Placekeeper still owns.

## Supported release scope

Source builds target macOS arm64/x64, Windows x64, and Linux x64. `pnpm package:desktop` builds the production desktop distribution. A local macOS DMG fresh installation passed in an isolated environment. Downloaded unsigned OS approval, native Windows/Linux lifecycle qualification, real-host integration trust and migration from actual public 0.2.4 remain pending. See the [installation guide](docs/installation.md) and [historical qualification record](docs/testing/electron-migration-qualification.md). Distribution is intentionally unsigned/unnotarized. Publication requires all four hosted builds and packaged runtime tests, immutable build provenance and matching staged/public download hashes; attended installer and full lifecycle reports are optional additional evidence. Updates are checked manually from the app menu and installed manually, with no background update checks or automatic replacement.

## Development

See [Contributing](CONTRIBUTING.md) for the repository map, build prerequisites, test aliases, and style ownership. The [documentation index](docs/README.md) separates operating instructions, current learnings, and historical plans.

### Web links in PDFs

Embedded HTTP and HTTPS hyperlinks open with a click or keyboard activation in the main PDF and Reference Tabs. Hover or focus a link to inspect its destination. Desktop and VS Code hand it to the OS default browser; Chrome opens another tab; Codex uses its host's browser preference and presentation rules. The PDF keeps its reading position. If opening fails, the message offers a copy button and a selectable URL. Printed URLs without hyperlink annotations and non-web protocols are not enabled.
