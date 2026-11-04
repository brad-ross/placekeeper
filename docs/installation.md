# Install and uninstall

Placekeeper's desktop application uses Electron on macOS, Windows, and Linux. Desktop installers include the review client, service, PDFium assets and pinned Node runtime. Running an installed app requires no Node.js, pnpm or compiler. Installation leaves your default PDF reader alone.

## Download availability

Use [all releases](https://github.com/brad-ross/placekeeper/releases/latest) for available files and release notes. The website offers desktop links only when the published stable release includes all four installers and `SHA256SUMS`. An unavailable check is not evidence that your app is current.

As of November 3, 2026, the published **0.2.4** release is the older **AppKit source-only release for Apple Silicon macOS**, not an Electron installer. New desktop installer publication remains gated on platform qualification; do not construct download links for an unpublished version. A locally built macOS DMG fresh install has passed in an isolated environment. Actual browser-downloaded unsigned OS approval, Windows/Linux native lifecycle checks, and migration from the real public 0.2.4 remain unqualified. [Historical qualification](testing/electron-migration-qualification.md) applies only to its recorded revisions.

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

These are platform-vendor instructions, **not a claim that downloaded Placekeeper artifacts have passed approval testing**. Exact-artifact approval qualification remains required before publication. Keep browser download security metadata intact. Check the downloaded file against the release's `SHA256SUMS` before proceeding; matching a checksum establishes file consistency, not publisher identity or safety.

On macOS, open **Install Placekeeper.app** once. If macOS blocks an unidentified or unnotarized app and you trust this download, open **System Settings → Privacy & Security**, find that app's blocked notice, and choose **Open Anyway** if offered. Confirm the named app and any authentication request. The installed Placekeeper app may require its own approval. If macOS reports malware, damage, or offers no permitted exception, stop and investigate. Follow [Apple's per-app approval guidance](https://support.apple.com/en-us/102445); do not disable Gatekeeper or remove quarantine metadata.

On Windows, if the normal **Windows protected your PC** SmartScreen warning appears, inspect **More info** and use **Run anyway** only if offered and you trust the exact download. See [Microsoft's SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app). Smart App Control and organizational application policies can block unsigned apps with no individual exception. [Microsoft documents that Smart App Control has no per-app bypass](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions). Stop and contact your administrator when approval is denied; do not turn off security protections to install Placekeeper.

On Ubuntu/Debian, the package manager may ask for administrator authentication and report dependencies or package errors. Review those messages. A successful package extraction alone does not establish sandbox operation or per-user activation.

### When installation is blocked

Source installation is an alternative only where local builds and execution are permitted. It is not a policy bypass. Ask your administrator if unsigned or locally built software is prohibited. Where neither desktop route is allowed, the web reader offers one local PDF or a compatible public HTTPS PDF, annotations, and reviewed-copy export. It has **no autosave or reload recovery**: export before closing or reloading. It does not supply desktop integrations or shared-service recovery. Use non-confidential PDFs; remote URLs and normal request metadata reach the remote host. The [web beta runbook](web-beta.md) still governs publication and browser qualification.

## Install from a checkout

Obtain the intended repository revision or source archive and read its own prerequisites. The website's short source bootstrap follows the latest stable release. As of November 3, 2026, that is legacy 0.2.4, not the new Electron app; check the release's own notes before running it. For the current Electron checkout, install **Node.js 24+**, **pnpm 11.16.0**, and a native C compiler: clang on macOS, a C toolchain on Linux, or Visual Studio C++ build tools in Developer PowerShell on Windows. macOS 13+ is required by Electron 45; minimum-version execution remains unqualified. Linux also needs Electron's runtime libraries. SyncTeX separately requires a native TeX `synctex` executable and matching mapping file; ordinary PDF reading does not.

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

First launch offers independent, default-off **VS Code**, **Chrome**, and **Codex** setup choices. Choose **Skip** to read PDFs immediately, or return through **Help → Set Up Integrations**. Failure of an integration does not prevent ordinary reading. Setup reports skipped, prepared/registered with host action pending, or failed outcomes. Registration is not completed interactive verification.

Source installation offers the same portable operations through prompts or explicit choices:

```sh
./install.sh --chrome=setup --vscode=skip --codex=ask --zed=skip
```

Chrome, VS Code and Codex accept `ask`, `setup`, or `skip`; prompts default to skip. The older Mac source-compatible Zed option also accepts `manual` and `preview`. It remains available on macOS through the source installer; use the [editor guide](guides/editor-synctex.md) for other editors and SyncTeX. Setup grants no source-folder access.

VS Code setup prepares the launcher setting and may submit the VSIX to its CLI. Apply the reported setting, install the bundled VSIX through **Extensions: Install from VSIX** if needed, reload, check extension enablement and workspace trust, and verify a PDF handoff. Windows setup reports the manual VSIX step.

Chrome setup registers the native host. In `chrome://extensions`, enable **Developer mode** and **Load unpacked** from the reported runtime's `integrations/chrome-extension` folder. Approve permissions, reload Chrome and verify a PDF handoff. A legacy 0.2.4 extension must be loaded again from the new folder.

Codex setup prepares a complete local marketplace in the support root's `integrations/codex` directory. In Codex Plugins add that marketplace, install/update `codex-plugin`, review trust and enablement, fully restart Codex and use a new chat. Verify the Placekeeper skill, display tool and trusted hooks. Existing plugin caches may require reinstall/update; never edit caches to force enablement.

Owned registration receipts and choices live under the support root's `integrations` directory. Edited/unowned registrations are preserved for inspection. Retry setup after resolving a reported issue or moving an installation. Real-host trust and end-to-end verification remain separate qualification steps.

## Open Chrome PDFs automatically (experimental)

Chrome 151+ is required. After optional setup and loading the extension, pin **Placekeeper PDF Viewer** and turn on **Open PDFs automatically** in its popup. Fresh installations begin paused; updates preserve Chrome's choice. An eligible PDF retains its original tab URL. **Use Chrome viewer** bypasses Placekeeper before activation. A later service failure keeps the PDF visible read-only with explicit reopen/recovery. Pause automatic opening from the popup; other PDF extensions may conflict.

The installed CLI's `doctor --json --chrome` checks registration. `pnpm test:chrome-handoff` and the isolated `pnpm test:chrome-installed` matrix do not replace real-host qualification of the latest artifact.

## Uninstall

Close reviews and end bound tasks first. On Windows use the installed **Uninstall.exe** (also registered with Windows Apps). On macOS, open **Install Placekeeper.app** in the mounted DMG and choose **Uninstall existing installation** when offered. See [Manual upgrades and recovery](desktop-upgrades.md) for custom destinations. Removing the Mac/source app directory through the file manager removes that app, but does not perform integration cleanup. The source scripts have no `--uninstall` flag. On Debian use the package manager to remove `placekeeper`; both removal and purge retain potentially active runtime/recovery resources.

Remove optional extensions/plugins through their hosts. Only owned unchanged registrations can be removed automatically; inspect any retained-registration report. PDFs, exports, settings and Protected Recovery are preserved. See [Privacy and recovery](privacy-and-recovery.md) before deleting user data. Retained app versions and Debian runtimes are recovery resources; cleanup is an explicit later action after all sessions are closed, never a traversal of user-state directories.
