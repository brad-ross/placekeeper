# Install and uninstall

Placekeeper's sole desktop application is Electron, with the production name **Placekeeper** on macOS, Windows, and Linux. The Swift/AppKit app is retired. Desktop packages contain the shared review client, service, PDFium assets, and an independent pinned Node runtime. The installed app does not require system Node or a source checkout.

The final local macOS arm64 package passed all 12 installed acceptance checks. All 2,184 canonical unit/integration tests and final typechecking passed. Current browser regressions, native Windows/Linux execution, and full qualification remain pending. Earlier candidate evidence is preserved in the [qualification record](testing/electron-migration-qualification.md). Building a package does not establish full release qualification.

## Install from a checkout

Install Node.js 24 or newer, pnpm 11.16.0, and a native C compiler. Use clang on macOS, a C toolchain on Linux, and Visual Studio C++ build tools from Developer PowerShell on Windows. Electron 45 requires macOS 13 or newer; execution on that minimum version remains unqualified. Linux also needs the runtime libraries required by Electron and a working Chromium sandbox.

From the repository folder:

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

On Linux, the per-user source route requires working unprivileged user namespaces. Both `--dry-run` and installation check sandbox prerequisites before dependency, build, or app changes: they reject root, restricted AppArmor/user-namespace settings, malformed or unreadable controls, and a missing or failed `unshare --user --map-root-user -- /usr/bin/true` probe. A user-owned `chrome-sandbox` helper does not supply the root-owned setuid sandbox required by a system package.

If that check fails, build the deb instead:

```sh
pnpm install --frozen-lockfile
pnpm package:desktop
```

Select the exact generated `.deb` under `dist/desktop-artifacts/make/deb/<arch>/` and install it explicitly with the OS package manager. The source installer never runs `sudo`, weakens security controls, or falls back to an unsandboxed app. The Linux per-user destination below applies only when its sandbox preflight passes; a system-installed deb uses package-managed locations.

On Windows, the installer uses `pnpm.exe`; if your installation supplies only a command shim, set `PLACEKEEPER_PNPM_CLI` to pnpm's JavaScript entry file. The installer invokes that file through Node without a shell.

The installer uses the frozen lockfile, stages the desktop runtime with `pnpm build:desktop`, packages Electron, and coordinates replacement through the shared daemon. Build a distributable ZIP, Windows Setup.exe, or Linux deb with:

```sh
pnpm install --frozen-lockfile
pnpm package:desktop
```

The staged app is under `dist/desktop-artifacts/Placekeeper-<platform>-<arch>/`; macOS contains `Placekeeper.app` within that folder. Forge distribution artifacts are under `dist/desktop-artifacts/make/`. Supported source-build targets are macOS arm64/x64, Windows x64, and Linux x64. Cross-platform source code and a produced artifact do not prove native execution.

## Installed paths and launchers

| Platform | Default app location | Installed CLI |
| --- | --- | --- |
| macOS | `~/Applications/Placekeeper.app` | `~/Applications/Placekeeper.app/Contents/MacOS/placekeeper` |
| Windows | `%LOCALAPPDATA%\Placekeeper` | `%LOCALAPPDATA%\Placekeeper\resources\desktop\bin\placekeeper.exe` |
| Linux | `~/.local/share/placekeeper` | `~/.local/share/placekeeper/resources/desktop/bin/placekeeper` |

The macOS GUI bundle is `Placekeeper.app`; Windows and Linux packages also use the product name Placekeeper. The internal GUI executable is `PlacekeeperDesktop.exe` on Windows and `PlacekeeperDesktop` on macOS/Linux. The common CLI lives in `resources/desktop/bin` (`Contents/Resources/desktop/bin` on macOS). macOS retains the external `Contents/MacOS/placekeeper` compatibility path for integrations. Set `PLACEKEEPER_INSTALL_ROOT` to override the destination's parent directory; `PLACEKEEPER_USER_HOME` overrides the home used by the source installer.

Open the installed app and choose a PDF. On macOS, Finder's **Open With → Placekeeper** can also open a PDF. Installation does not automatically make Placekeeper the OS default PDF handler. Unsigned or unnotarized local builds may require the platform's explicit first-launch approval; on macOS use Finder's Control-click → **Open** without disabling Gatekeeper globally.

## Updates and recovery

Rerun the source installer from the desired checkout. It inspects the shared daemon, defers while reviews or tasks remain active, and preserves recovery before switching the writer. Close the indicated Placekeeper work, allow its leases to expire, and retry. Closing a Codex panel may leave an inline presentation active; quit Codex if its participation remains. An unreadable or incompatible service cannot be assumed idle, and the installer does not kill unknown processes.

Replacement requires exact candidate readiness. A failed or ambiguous transition must preserve the installation transaction and recovery; follow the reported action rather than deleting state or force-killing broadly matched processes. See [shared-daemon lifecycle](solutions/architecture-patterns/upgrade-safe-shared-per-user-daemon-lifecycle.md).

The fixed loopback origin permits readable browser URLs to reach a successor service. It does not transfer credentials or task authority. A successor offers explicit reopen/recovery; protected drafts remain subject to resume, discard, or separate-copy choices. See [Privacy and recovery](privacy-and-recovery.md) before removing recovery data.

## Optional integrations

Automatic optional integration setup currently runs on macOS. Select Chrome, VS Code, Codex, or Zed when prompted, or skip and rerun later:

```sh
./install.sh --chrome=setup --vscode=skip --codex=ask --zed=manual
```

Chrome, VS Code, and Codex accept `ask`, `setup`, or `skip`; Zed also accepts `manual` and `preview`. Zed manual navigation jumps on demand; preview requests a jump after successful builds. Installation grants no source-folder access. See the [editor guide](guides/editor-synctex.md) for profiles, forward search, inverse setup, and native TeX requirements.

On Windows/Linux, the installer prints the bundled integration directory and CLI. Install `integrations/placekeeper.vsix` through VS Code's **Extensions: Install from VSIX**, then set `placekeeper.launcherPath` to the installed CLI. Chrome registration uses the bundled CLI's `integration-registration` command; invoke it for usage. Codex uses the setup helper below to generate the complete plugin. Registration is separate from host trust, enablement, reload, and interactive qualification.

### Codex plugin setup

Codex needs a materialized plugin containing its MCP definition, hooks, skill, and marketplace metadata, all bound to the exact installed native launcher. The bundled `integrations/codex-plugin-template` is a template and cannot be installed directly. macOS `--codex=setup` uses the same portable helper available on every platform.

Set `RESOURCES` to the installed desktop runtime root: `~/Applications/Placekeeper.app/Contents/Resources/desktop` on macOS, `~/.local/share/placekeeper/resources/desktop` for the Linux per-user install, or `%LOCALAPPDATA%\Placekeeper\resources\desktop` on Windows. Run:

```sh
"$RESOURCES/node/bin/node" "$RESOURCES/installer/setup-codex.mjs"
```

```powershell
& "$RESOURCES/node/bin/node.exe" "$RESOURCES/installer/setup-codex.mjs"
```

An optional final argument selects an absolute marketplace directory. By default the helper creates `~/.placekeeper/codex/<installArtifactIdentity>` and a sibling `.receipt.json` ownership receipt. It preserves edited or incomplete registrations for inspection rather than overwriting them. It attempts supported Codex plugin installation when available and prints manual Plugins steps. Review trust and enablement, fully quit and restart Codex, and use a new chat; setup always leaves those host actions pending.

Windows plugin hooks supply the CMD form `"C:/absolute/path/placekeeper.exe" hook --event` through `commandWindows`. Generated skill commands use PowerShell's direct call form, `& 'C:/absolute/path/placekeeper.exe' ...`, doubling any single quote inside a literal argument. Keep the native launcher as the direct executable; wrapping it in another runtime or script prevents trusted launch recognition. The generated plugin records your selected installation's exact path, so rerun setup after moving or replacing that installation.

On macOS, the integration assets remain under `Placekeeper.app/Contents/Resources/integrations`. After a Codex plugin update, review trust and enablement, fully quit and restart Codex, and use a new chat. Plugin installation does not establish trusted hooks, tool discovery, or native panel activation. Never edit the plugin cache to force enablement.

## Open Chrome PDFs automatically (experimental)

Chrome 151+ is required. On macOS, select Chrome setup, open `chrome://extensions`, enable **Developer mode**, and **Load unpacked** from `~/Applications/Placekeeper Chrome Extension`. Pin **Placekeeper PDF Viewer**, then turn on **Open PDFs automatically** in its popup. Fresh installations begin paused; updates preserve Chrome's existing choice. Prepared files do not prove that Chrome loaded the extension.

An eligible PDF stays at its original tab URL. Before activation, **Use Chrome viewer** bypasses Placekeeper for that PDF. After activation, a service failure keeps the PDF visible and read-only with explicit reopen/recovery. Pause automatic opening from the popup. Other PDF-handler extensions may conflict.

On macOS, diagnose registration with:

```sh
"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper" doctor --json --chrome
```

`pnpm test:chrome-handoff` checks deterministic handoff behavior. `pnpm test:chrome-installed` runs the separate installed Chrome matrix with a disposable profile and manual host setup. Neither historical Chrome evidence nor registration proves the latest desktop replacement's complete host qualification.

## Uninstall

Quit Placekeeper and end bound tasks. Remove the installed app directory listed above using the OS file manager. Remove optional Chrome, VS Code, and Codex integrations through their host interfaces, including any local Codex marketplace and Chrome native-host registration you explicitly installed. The source installer has no `--uninstall` option.

Removing the app does not remove your PDFs, exports, or Protected Recovery. macOS recovery is under `~/Library/Application Support/Placekeeper`; inspect [Privacy and recovery](privacy-and-recovery.md) before deleting user data. You may separately remove the checkout and its build artifacts.

## Releases

`pnpm package:desktop` is the current production packaging entry point. Source-release publication is a separate maintainer action and does not establish signing, notarization, automatic updates, host trust, or physical Windows/Linux qualification. Historical AppKit release commands and candidate reports describe their recorded revisions rather than the current application.
