# Install and uninstall

Placekeeper is a focused, local-only PDF reader and annotator for Apple-silicon macOS, distributed from source. It does not require an Apple Developer account, Developer ID certificate, notarization profile, Homebrew, or a global Node installation.

## Install from source

Requirements are macOS 13 or newer, an Apple-silicon Mac, internet access during installation, and the standard macOS command-line tools (`curl`, `tar`, `shasum`, and `ditto`). Download or clone the repository, open Terminal in the repository folder, and run:

```sh
./install.sh
```

The installer downloads the checksum-pinned Node 24.14.0 arm64 toolchain into the checkout, runs the exact pnpm 11.16.0 dependency graph from the lockfile, builds the app, and checks the packaged writer with networking disabled. It then transactionally installs `~/Applications/Placekeeper.app` and asks macOS to register its native document bridge as an alternate PDF viewer. The installer does not modify the system Node installation or make Placekeeper the default PDF handler.

Preview the actions without downloading or changing anything:

```sh
./install.sh --dry-run
```

To update, pull or download newer source and run `./install.sh` again. Placekeeper uses one shared local service for every open PDF, so the installer checks that service before it changes the app:

- If the installed bundle and running service are already exact, reinstall is a no-op.
- If no review or Codex task is active, the service finishes accepted saves, exits cleanly, and the installer replaces it. The new service must start and report its exact build before installation commits; otherwise the previous app is restored.
- If a Placekeeper tab/window or a bound Codex task is active, installation is deferred. The installed app and every live review remain unchanged. Close the indicated work, wait a few seconds for its lease to expire, and run `./install.sh` again.
- If Placekeeper is briefly finishing a save or another lifecycle operation, wait a moment and retry. A timeout or unreadable response also leaves the previous app untouched.

The installer replaces only its installed app; if replacement or candidate readiness fails, it restores the previous app. It leaves recovery data and user-owned exports alone.

The packaged service reuses one fixed numeric-loopback origin so a browser tab can reach the replacement service at the same literal URL. A still-live service resumes the exact in-memory review on refresh. In Codex, **Copy Link** uses that credential-free readable URL so it can be pasted back into the built-in browser without becoming a web search. A replacement service instead shows a terminal **Reopen in Placekeeper** screen carrying only the PDF path and page/saved-item location; choosing it follows the normal confirmation flow and opens a fresh non-Codex review in the same browser tab. Paste the displayed canonical `placekeeper:///` link into Codex chat when the fresh review also needs to be bound to that task. If Placekeeper is stopped, the tab may show the browser's connection error until the app is started and the tab is refreshed again.

Because the source build is intentionally not Developer ID-signed or notarized (it receives only a local ad-hoc signature), macOS may warn on first launch. In Finder, Control-click `~/Applications/Placekeeper.app`, choose **Open**, and confirm once. Do not disable Gatekeeper globally and do not recursively remove quarantine attributes.

After installation, select one local PDF in Finder and use **Open With -> Placekeeper**. Alternatively, open Placekeeper from `~/Applications` and choose a PDF. No terminal is needed for ordinary use.

## Optional integrations

The app bundles two optional technical-user integrations:

- Codex plugin: `~/Applications/Placekeeper.app/Contents/Resources/integrations/codex-plugin`
- VS Code extension: `~/Applications/Placekeeper.app/Contents/Resources/integrations/vscode`

Install either directory through that application's local extension/plugin workflow. These adapters open the same local service; they do not upload PDFs or submit Codex tasks automatically. The Codex plugin includes `PostToolUse`, `UserPromptSubmit`, and `SessionEnd` hooks that resolve the installed app executable at `~/Applications/Placekeeper.app/Contents/MacOS/placekeeper`. After Codex opens an explicit PDF and its in-app browser authenticates, the same task receives fresh annotation and PDF context on each prompt. If the plugin is disabled, untrusted, installed elsewhere, or its hook cannot run, context remains explicitly unavailable; reopen after restoring the installed plugin rather than copying a browser URL or guessing the active document. VS Code remains desktop-local and refuses Remote SSH, containers, Codespaces, web, virtual, and non-file workspaces.

## Uninstall

Quit Placekeeper, end any bound Codex tasks, move `~/Applications/Placekeeper.app` to the Trash, and uninstall any optional Codex or VS Code integration. Then optionally remove the local toolchain cache in the source checkout at `.local/`.

Removing the app does not remove recoverable drafts under `~/Library/Application Support/Placekeeper` or user-owned reviewed and revised PDFs. See [Privacy and recovery](privacy-and-recovery.md) before deleting recovery data.
