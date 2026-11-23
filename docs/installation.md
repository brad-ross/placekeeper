# Install and uninstall

Placekeeper's desktop application uses Electron on macOS, Windows, and Linux. Desktop installers include the reader client, service, PDFium assets and pinned Node runtime. Running an installed app requires no Node.js, pnpm or compiler. Installation leaves your default PDF reader alone.

## Download availability

Use [all releases](https://github.com/brad-ross/placekeeper/releases/latest) for available files and release notes. The website offers desktop links only when the published stable release includes all four installers and `SHA256SUMS`. An unavailable check is not evidence that your app is current.

Version **0.2.4** was the older **AppKit source-only release for Apple Silicon macOS**, not an Electron installer. Desktop installer publication requires all four hosted builds and packaged runtime tests, immutable build provenance and matching staged/public download hashes; do not construct download links for an unpublished version. A locally built macOS DMG fresh install has passed in an isolated environment. Actual browser-downloaded unsigned OS approval, Windows/Linux native lifecycle checks, and migration from the real public 0.2.4 remain unqualified. [Historical qualification](testing/electron-migration-qualification.md) applies only to its recorded revisions.

## Desktop installers

When a complete desktop release is available, download the file for the computer where you will install it. On a Mac, **Apple menu → About This Mac** identifies an Apple Silicon Chip or Intel Processor. A browser's “Intel Mac” user agent is not reliable architecture detection.

| Platform | Supported entrypoint | Default installation |
| --- | --- | --- |
| macOS Apple Silicon or Intel | Open the DMG, then **Install Placekeeper.app** inside it | `~/Applications/Placekeeper.app` |
| Windows x64 | Run the versioned **Setup.exe** | `%LOCALAPPDATA%\Programs\Placekeeper` |
| Ubuntu / Debian x64 | Install the exact `.deb` with the OS package manager, then launch Placekeeper as your ordinary user | Immutable runtimes under `/opt/placekeeper/runtimes/<artifact-identity>` |

On macOS use the installer inside the mounted image for both installation and upgrades. Do not drag a candidate over a running app in Finder. Windows Setup extracts the complete candidate and runs the coordinator before changing the incumbent. Neither route uses an unguarded overwrite. The Debian package stages a root-owned runtime; the next explicit ordinary-user launch coordinates that user's activation. Package updates leave other users' running versions intact. Never run the GUI as root.

For a downloaded Debian package, use `sudo apt install /absolute/path/to/the-downloaded.deb`, substituting its exact path. This requires administrator approval for the package, not for the GUI. The package needs an executable, SUID-capable runtime filesystem and its verified root-owned sandbox helper. If mount policy or sandbox checks fail, ask the administrator to correct the installation; do not disable the sandbox. See [Ubuntu's package installation guide](https://help.ubuntu.com/community/InstallingSoftware).

### Unsigned approval (provisional)

These are platform-vendor instructions, **not a claim that downloaded Placekeeper artifacts have passed approval testing**. Hosted packaged runtime tests do not establish browser-downloaded OS approval; attended approval testing is separate optional evidence. Keep browser download security metadata intact. Check the downloaded file against the release's `SHA256SUMS` before proceeding; matching a checksum establishes file consistency, not publisher identity or safety.

On macOS, open **Install Placekeeper.app** once. If macOS blocks an unidentified or unnotarized app and you trust this download, open **System Settings → Privacy & Security**, find that app's blocked notice, and choose **Open Anyway** if offered. Confirm the named app and any authentication request. The installed Placekeeper app may require its own approval. If macOS reports malware, damage, or offers no permitted exception, stop and investigate. Follow [Apple's per-app approval guidance](https://support.apple.com/en-us/102445); do not disable Gatekeeper or remove quarantine metadata.

On Windows, if the normal **Windows protected your PC** SmartScreen warning appears, inspect **More info** and use **Run anyway** only if offered and you trust the exact download. See [Microsoft's SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app). Smart App Control and organizational application policies can block unsigned apps with no individual exception. [Microsoft documents that Smart App Control has no per-app bypass](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions). Stop and contact your administrator when approval is denied; do not turn off security protections to install Placekeeper.

On Ubuntu/Debian, the package manager may ask for administrator authentication and report dependencies or package errors. Review those messages. A successful package extraction alone does not establish sandbox operation or per-user activation.

### When installation is blocked

Source installation is an alternative only where local builds and execution are permitted. It is not a policy bypass. Ask your administrator if unsigned or locally built software is prohibited. Where neither desktop route is allowed, the web reader offers one local PDF or a compatible public HTTPS PDF, annotations, and annotated-copy export. It has **no autosave or reload recovery**: export before closing or reloading. It does not supply desktop integrations or shared-service recovery. Use non-confidential PDFs; remote URLs and normal request metadata reach the remote host. The [web beta runbook](web-beta.md) still governs publication and browser qualification.

## Install from a checkout

Obtain the intended repository revision or source archive and read its own prerequisites. The website's short source bootstrap follows the latest stable release; check the release's own notes before running it. Legacy version 0.2.4 builds the older AppKit app. For the current Electron checkout, install **Node.js 24+**, **pnpm 11.16.0**, and a native C compiler: clang on macOS, a C toolchain on Linux, or Visual Studio C++ build tools in Developer PowerShell on Windows. macOS 13+ is required by Electron 45; minimum-version execution remains unqualified. Linux also needs Electron's runtime libraries. SyncTeX separately requires a native TeX `synctex` executable and matching mapping file; ordinary PDF reading does not.

From the repository directory:

```sh
# macOS or Linux
./install.sh --dry-run
./install.sh
```

```powershell
# Windows, in Visual Studio Developer PowerShell
./install.ps1 --dry-run
./install.ps1
```

The source installer uses the frozen lockfile, builds and packages locally, then enters the same guarded replacement flow. The installed app has its own runtime. On Windows it invokes `pnpm.exe`; if pnpm supplies only a shim, set `PLACEKEEPER_PNPM_CLI` to its JavaScript entry file, which is invoked through Node without a shell.

Linux per-user source installation requires verified unprivileged user namespaces. Both dry run and installation reject root, restricted or unreadable AppArmor/user-namespace controls, and a failed `unshare --user --map-root-user -- /usr/bin/true` probe before building or changing an app. A user-owned sandbox helper is not a substitute for a root-owned setuid helper. If the check fails and local package installation is permitted, build a deb with `pnpm install --frozen-lockfile` then `pnpm package:desktop`; install the exact generated file under `dist/desktop-artifacts/make/guarded/linux/x64/` through the package manager. Source installation never runs sudo or weakens sandbox settings.

Source targets are macOS arm64/x64, Windows x64, Linux x64. `pnpm package:desktop` generates distribution artifacts under `dist/desktop-artifacts/make/`; staged applications are under `dist/desktop-artifacts/Placekeeper-<platform>-<arch>/`. Producing an artifact does not prove native execution.

The per-user source defaults are the Mac/Windows locations above and `~/.local/share/placekeeper` on Linux. `PLACEKEEPER_INSTALL_ROOT` overrides the destination's parent; `PLACEKEEPER_USER_HOME` selects the source installer's home. Destinations overlapping user state are rejected. The native CLI is `Contents/MacOS/placekeeper` in the Mac app and `resources/desktop/bin/placekeeper.exe` (Windows) or `resources/desktop/bin/placekeeper` (Linux). The deb installs the stable `/usr/bin/placekeeper` dispatcher. macOS retains its compatibility CLI paths.

## Updates and recovery

Use **Help → Check for Updates** to check manually. It reports a newer release, current version, a local version ahead of stable, or an unavailable check. Checks do not download or replace anything and do not run periodically. Download the desired installer and follow [Manual upgrades and recovery](desktop-upgrades.md). Source users rerun the installer from the intended checkout in an interactive terminal.

## Optional integrations

First launch offers independent, default-off **VS Code**, **Chrome**, **Codex**, and **Claude Desktop** (experimental) setup choices. Choose **Skip** to read PDFs immediately, or return through **Help → Set Up Integrations**. Failure of an integration does not prevent ordinary reading. Setup reports skipped, prepared/registered with host action pending, or failed outcomes. Registration is not completed interactive verification.

Source installation offers the same portable operations through prompts or explicit choices:

```sh
./install.sh --chrome=setup --vscode=skip --codex=ask --claude=skip --zed=skip
```

```powershell
./install.ps1 --chrome=setup --vscode=skip --codex=ask --claude=skip
```

Chrome, VS Code, Codex and Claude Desktop (`--claude`) accept `ask`, `setup`, or `skip`; prompts default to skip. The older Mac source-compatible Zed option also accepts `manual` and `preview`. It remains available on macOS through the source installer; use the [editor guide](guides/editor-synctex.md) for other editors and SyncTeX. Setup grants no source-folder access.

VS Code setup prepares the launcher setting and may submit the VSIX to its CLI. Apply the reported setting, install the bundled VSIX through **Extensions: Install from VSIX** if needed, reload, check extension enablement and workspace trust, and verify a PDF handoff. Windows setup reports the manual VSIX step.

Chrome setup registers the native host. In `chrome://extensions`, enable **Developer mode** and **Load unpacked** from the reported runtime's `integrations/chrome-extension` folder. Approve permissions, reload Chrome and verify a PDF handoff. A legacy 0.2.4 extension must be loaded again from the new folder.

Codex setup prepares a complete local marketplace in the support root's `integrations/codex` directory. In Codex Plugins add that marketplace, install/update `codex-plugin`, review trust and enablement, fully restart Codex and use a new chat. Verify the Placekeeper skill, display tool and trusted hooks. Existing plugin caches may require reinstall/update; never edit caches to force enablement.

Skipping an integration later leaves its existing registration in place. Owned registration receipts and choices live under the support root's `integrations` directory. Edited/unowned registrations are preserved for inspection. Retry setup after resolving a reported issue or moving an installation. Real-host trust and end-to-end verification remain separate qualification steps.

### Claude Desktop (experimental)

Claude Desktop support is experimental. The reader, chat context, chat-driven search and the reopening dialog have been tried with a development candidate in Claude Desktop 6.28899.6 on macOS 26.7.1. Setup from the installed app is covered by automated tests only and has not yet been tried with a real Claude Desktop. See [Documents in Claude Desktop](guides/claude-desktop.md) for what you can do once it is set up.

1. Install Claude Desktop and open it once, so that it creates its settings folder. Then quit it.
2. In Placekeeper choose **Help → Set Up Integrations** and choose **Set Up** for **Claude Desktop (experimental)**, or accept it on first launch. From a checkout, pass `--claude=setup` to `./install.sh` or `./install.ps1`.
3. Fully quit Claude Desktop and reopen it. Closing its window is not enough: on macOS choose **Claude → Quit Claude**, and on Windows quit it from its icon in the notification area.
4. In Claude Desktop open **Settings → Developer** and check that `placekeeper` is listed and running. In a chat, open the tools menu and check that `placekeeper` is enabled and lists `open_pdf_file`, `open_placekeeper`, `inspect_review`, `search_document`, `navigate_page`, `reveal_search_result`, `reveal_annotation` and `read_document_text`.
5. Ask Claude to open a local PDF by its full path, for example "Open /Users/me/paper.pdf in Placekeeper", or open a PDF in Placekeeper and choose **File → Open in Claude**. The first time, Claude asks you to allow the Placekeeper tool. If the view reports that Placekeeper is unavailable, start Placekeeper and try again.

Setup adds one `placekeeper` server under `mcpServers` in Claude Desktop's `claude_desktop_config.json`:

| Platform | Configuration file |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

The entry runs the installation's bundled Node with its `codex-mcp/server.js` and sets `PLACEKEEPER_MCP_HOST=claude-desktop`. It looks like this on macOS:

```json
"placekeeper": {
  "command": "~/Applications/Placekeeper.app/Contents/Resources/desktop/node/bin/node",
  "args": ["~/Applications/Placekeeper.app/Contents/Resources/desktop/codex-mcp/server.js"],
  "env": { "PLACEKEEPER_MCP_HOST": "claude-desktop", "PLACEKEEPER_APP_RESOURCES": "…", "PLACEKEEPER_LAUNCHER": "…" }
}
```

Setup writes absolute paths in place of `~`. Every other server and setting in the file is kept. Setup records what it wrote in `claude.receipt.json` in the support root's `integrations` directory.

Setup reports one of these outcomes:

- **pending, written or current:** the entry was added or is already up to date. Restart Claude Desktop as in step 3 and check it as in step 4.
- **pending, Claude Desktop was not found:** Claude Desktop's folder does not exist yet, and nothing was changed. Open Claude Desktop once, quit it, then rerun **Help → Set Up Integrations**.
- **failed:** the file is not valid JSON, its `mcpServers` is not an object, or it already has a `placekeeper` entry that Placekeeper did not write or that was edited after setup wrote it. The file is left unchanged. Fix the file or rename your own entry, then rerun setup.

Rerunning setup repairs the entry. Placekeeper also checks it each time it starts and repairs it after an upgrade or a move; when the entry changes, Placekeeper tells you to restart Claude Desktop. If Claude Desktop rewrote the entry's formatting or key order, setup still recognizes it as its own.

To remove the entry, quit Claude Desktop and run the installed command-line tool with the receipt:

```sh
# macOS
~/Applications/Placekeeper.app/Contents/MacOS/placekeeper integration-registration remove --receipt "$HOME/Library/Application Support/Placekeeper/integrations/claude.receipt.json"
```

On Windows run `resources\desktop\bin\placekeeper.exe` in the installation folder with `--receipt "%LOCALAPPDATA%\Placekeeper\integrations\claude.receipt.json"`. On Linux run `/usr/bin/placekeeper` (Debian package) or `resources/desktop/bin/placekeeper` in the installation folder (source install) with `--receipt "${XDG_STATE_HOME:-$HOME/.local/state}/placekeeper/integrations/claude.receipt.json"`. The command removes only an unchanged entry that this installation wrote, keeps every other server and setting, and deletes the receipt. If it reports the file as retained, the entry was edited or the file is not valid JSON: delete the `placekeeper` key under `mcpServers` yourself, then delete the receipt. Then choose **Skip** for Claude Desktop in **Help → Set Up Integrations**, so that the next launch does not add it again, and reopen Claude Desktop.

If Claude Desktop does not list `placekeeper` or a tool reports an error, see [Claude Desktop troubleshooting](support.md#claude-desktop).

## Open Chrome PDFs automatically (experimental)

Chrome 151+ is required. After optional setup and loading the extension, pin **Placekeeper** and turn on **Open PDFs automatically** in its popup. Fresh installations begin paused; updates preserve Chrome's choice. An eligible PDF retains its original tab URL. **Use Chrome viewer** bypasses Placekeeper before activation. A later service failure keeps the PDF visible read-only with explicit reopen/recovery. Pause automatic opening from the popup; other PDF extensions may conflict.

The installed CLI's `doctor --json --chrome` checks registration. `pnpm test:chrome-handoff` and the isolated `pnpm test:chrome-installed` matrix do not replace real-host qualification of the latest artifact.

## Uninstall

Close open documents and end bound tasks first. On Windows use the installed **Uninstall.exe** (also registered with Windows Apps). On macOS, open **Install Placekeeper.app** in the mounted DMG and choose **Uninstall existing installation** when offered. See [Manual upgrades and recovery](desktop-upgrades.md) for custom destinations. Removing the Mac/source app directory through the file manager removes that app, but does not perform integration cleanup. The source scripts have no `--uninstall` flag. On Debian use the package manager to remove `placekeeper`; both removal and purge retain potentially active runtime/recovery resources.

Remove optional extensions/plugins through their hosts. Only owned unchanged registrations can be removed automatically; inspect any retained-registration report. Uninstalling does not edit Claude Desktop's configuration: remove the `placekeeper` entry first as described in [Claude Desktop](#claude-desktop-experimental), otherwise Claude Desktop reports that the server failed to start. PDFs, exports, settings and Protected Recovery are preserved. See [Privacy and recovery](privacy-and-recovery.md) before deleting user data. Retained app versions and Debian runtimes are recovery resources; cleanup is an explicit later action after all sessions are closed, never a traversal of user-state directories.
