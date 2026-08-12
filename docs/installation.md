# Install and uninstall

PDF Proofreader is a personal, local-only Apple-silicon macOS app distributed from source. It does not require an Apple Developer account, Developer ID certificate, notarization profile, Homebrew, or a global Node installation.

## Install from source

Requirements are macOS 13 or newer, an Apple-silicon Mac, internet access during installation, and the standard macOS command-line tools (`curl`, `tar`, `shasum`, and `ditto`). Download or clone the repository, open Terminal in the repository folder, and run:

```sh
./install.sh
```

The installer downloads the checksum-pinned Node 24.14.0 arm64 toolchain into the checkout, runs the exact pnpm 11.16.0 dependency graph from the lockfile, builds the app, and checks the packaged writer with networking disabled. It then transactionally installs the app at `~/Applications/PDF Proofreader.app` and asks macOS to register its native document bridge as an alternate PDF viewer. It does not modify the system Node installation or make PDF Proofreader the default PDF handler. Reinstalling removes the obsolete beta Quick Action if present.

Preview the actions without downloading or changing anything:

```sh
./install.sh --dry-run
```

To update, pull or download newer source and run `./install.sh` again. PDF Proofreader uses one shared local service for every open PDF, so the installer checks that service before it changes the app:

- If the installed bundle and running service are already exact, reinstall is a no-op.
- If no review or Codex task is active, the service finishes accepted saves, exits cleanly, and the installer replaces it. The new service must start and report its exact build before installation commits; otherwise the previous app is restored.
- If a PDF Proofreader tab/window or a bound Codex task is active, installation is deferred. The installed app and every live review remain unchanged. Close the indicated work, wait a few seconds for its lease to expire, and run `./install.sh` again.
- If PDF Proofreader is briefly finishing a save or another lifecycle operation, wait a moment and retry. A timeout or unreadable response also leaves the previous app untouched.

The first update from a version that predates the safe management handshake cannot prove whether reviews are active. Close all PDF Proofreader tabs/windows and end bound Codex tasks, then explicitly run:

```sh
~/Applications/PDF\ Proofreader.app/Contents/MacOS/pdf-proofreader daemon stop-legacy
```

Then rerun `./install.sh`. `pdf-proofreader daemon stop-legacy` is never run automatically: it validates that the private socket belongs to the current user and that its listener is a PDF Proofreader daemon before requesting termination. Do not use `kill`, `pkill`, or `killall` as an upgrade workaround.

The installer replaces only its installed app; if replacement or candidate readiness fails, it restores the previous app. It leaves recovery data and user-owned exports alone.

Because the source build is intentionally not Developer ID-signed or notarized (it receives only a local ad-hoc signature), macOS may warn on first launch. In Finder, Control-click `~/Applications/PDF Proofreader.app`, choose **Open**, and confirm once. Do not disable Gatekeeper globally and do not recursively remove quarantine attributes.

After installation, select one local PDF in Finder and use **Open With -> PDF Proofreader**. Alternatively, open PDF Proofreader from `~/Applications` and choose a PDF. No terminal is needed for ordinary use.

## Optional integrations

The app bundles two optional technical-user integrations:

- Codex plugin: `~/Applications/PDF Proofreader.app/Contents/Resources/integrations/codex-plugin`
- VS Code extension: `~/Applications/PDF Proofreader.app/Contents/Resources/integrations/vscode`

Install either directory through that application's local extension/plugin workflow. These adapters open the same local service; they do not upload PDFs or submit Codex tasks automatically. The Codex plugin includes `PostToolUse`, `UserPromptSubmit`, and `SessionEnd` hooks that resolve the installed app executable at `~/Applications/PDF Proofreader.app/Contents/MacOS/pdf-proofreader`. After Codex opens an explicit PDF and its in-app browser authenticates, the same task receives fresh annotation and PDF context on each prompt. If the plugin is disabled, untrusted, installed elsewhere, or its hook cannot run, context remains explicitly unavailable; reopen after restoring the installed plugin rather than copying a browser URL or guessing the active document. VS Code remains desktop-local and refuses Remote SSH, containers, Codespaces, web, virtual, and non-file workspaces.

## Uninstall

Quit PDF Proofreader, move `~/Applications/PDF Proofreader.app` and `~/Library/Services/PDF Proofreader.workflow` to the Trash, and uninstall any optional Codex or VS Code integration. Then optionally remove the local toolchain cache in the source checkout at `.local/`.

Removing the app does not remove recoverable drafts under `~/Library/Application Support/PDF Proofreader` or user-owned reviewed and revised PDFs. See [Privacy and recovery](privacy-and-recovery.md) before deleting recovery data.
