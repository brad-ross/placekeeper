# Install and uninstall

Placekeeper is a focused, local-only PDF reader and annotator for Apple-silicon macOS, distributed from source. It does not require an Apple Developer account, Developer ID certificate, notarization profile, Homebrew, or a global Node installation.

## Install from source

Requirements are macOS 13 or newer, an Apple-silicon Mac, internet access during installation, and the standard macOS command-line tools (`curl`, `tar`, `shasum`, and `ditto`). Download or clone the repository, open Terminal in the repository folder, and run:

```sh
./install.sh
```

The installer downloads the checksum-pinned Node 24.14.0 arm64 toolchain into the checkout, runs the exact pnpm 11.16.0 dependency graph from the lockfile, builds the app, and checks the packaged writer with networking disabled. It then transactionally installs `~/Applications/Placekeeper.app`, its exact-origin Chrome native-host registration, and the native document bridge. Placekeeper remains an alternate macOS PDF viewer. The installer does not modify the system Node installation, make Placekeeper the macOS default PDF handler, or enable Chrome interception.

Preview the actions without downloading or changing anything:

```sh
./install.sh --dry-run
```

To update, pull or download newer source and run `./install.sh` again. Placekeeper uses one shared local service for every open PDF, so the installer checks that service before it changes the app:

- If the installed bundle and running service are already exact, reinstall is a no-op.
- If no review or Codex task is active, the service finishes accepted saves, exits cleanly, and the installer replaces it. The new service must start and report its exact build before installation commits; otherwise the previous app is restored.
- If a Placekeeper tab/window or a bound Codex task is active, installation is deferred. The installed app and every live review remain unchanged. Close the indicated work, wait a few seconds for its lease to expire, and run `./install.sh` again.
- If Placekeeper is briefly finishing a save or another lifecycle operation, wait a moment and retry. A timeout or unreadable response also leaves the previous app untouched.

The installer replaces the app and Placekeeper's one Chrome native-host manifest as a unit; if candidate validation, registration, replacement, or readiness fails, it restores both previous endpoints. Unrelated native-host manifests, Chrome profiles, extension preferences, recovery data, and user-owned exports are left alone.

The packaged service reuses one fixed numeric-loopback origin so a browser tab can reach the replacement service at the same literal URL. A still-live service resumes the exact in-memory review on refresh. In Codex, **Copy Link** uses that credential-free readable URL so it can be pasted back into the built-in browser without becoming a web search. A replacement service instead shows a compact **Reopen review** screen carrying only the PDF identity and page/saved-item location. That single explicit click is the confirmation boundary: an ordinary review reopens immediately in the same browser tab, while a protected draft offers **Resume draft**, **Discard draft**, and **Open separate copy** before anything is changed. The secondary **Copy Placekeeper link** action copies the canonical `placekeeper:///` link for opening in another Placekeeper or Codex context. A successor can reattach the original Codex task only through the scoped reconnect handshake; the stale URL itself never restores credentials or task authority. If Placekeeper is stopped, the tab may show the browser's connection error until the app is started and the tab is refreshed again.

Because the source build is intentionally not Developer ID-signed or notarized (it receives only a local ad-hoc signature), macOS may warn on first launch. In Finder, Control-click `~/Applications/Placekeeper.app`, choose **Open**, and confirm once. Do not disable Gatekeeper globally and do not recursively remove quarantine attributes.

After installation, select one local PDF in Finder and use **Open With -> Placekeeper**. Alternatively, open Placekeeper from `~/Applications` and choose a PDF. No terminal is needed for ordinary use.

## Open Chrome PDFs automatically

Chrome 151 or newer is required. Installation intentionally leaves this feature paused.

1. In Chrome, open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**.
2. Select `~/Applications/Placekeeper.app/Contents/Resources/integrations/chrome-extension`.
3. Pin **Placekeeper PDF Viewer** if you want its control readily available, open its toolbar menu, and turn on automatic PDF opening.

The checked-in extension key keeps the ID `cgegjjjhbhnfgcoipeffhogoojfoekgg` stable. The user-level native host accepts only that exact extension origin. Because this is source-first, unpacked distribution, Chrome trusts code at the loaded path as your macOS user; do not replace it with a symlink or make it group/world writable. An update preserves the extension's existing on/off choice because that choice lives in Chrome, not the installer.

When automatic opening is on, a top-level PDF replaces its Chrome tab with Placekeeper. The pending page offers **Use Chrome viewer** for a one-PDF bypass. To pause all automatic opening, use the extension's toolbar menu. Other installed PDF-handler extensions can conflict because Chrome chooses the most recently installed eligible handler; pause or remove the other handler, then reload Placekeeper's packaged extension.

If Chrome falls back unexpectedly, first confirm that Placekeeper is installed at the same path shown above and reload the packaged extension from `chrome://extensions`. Then run:

```sh
"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper" doctor --json --chrome
```

`healthy` means the packaged extension path, stable ID, protocol, and native registration agree. `load-packaged-extension`, `reload-packaged-extension`, or `reinstall-placekeeper` is the recommended corrective action; the report deliberately omits private paths and browser capabilities. An older extension or host with an incompatible protocol safely falls back to Chrome without changing the automatic-open toggle.

### Verify the Chrome integration from source

Run the deterministic handoff gate before an installed release check:

```sh
pnpm test:chrome-handoff
```

This uses a newly created temporary Chromium profile and an in-process loopback fixture. It covers authenticated suffixless PDFs, a redirect that preserves a one-use POST response, slow/chunked delivery, invalid content, interrupted delivery, the transfer limit, exact-once stream handling, paused/bypass and host-failure fallback, local-file identity, temporary-source cleanup and recovery, remote/local save policy, and the browser/Codex authority boundary. It never opens or modifies the everyday Chrome profile. If Playwright's managed Chromium cannot expose Chrome 151's public `mimeHandler` API, that one automation probe is reported as skipped with a reason; the protocol and lifecycle checks still run.

That skip does not waive the release check. Before approving an installed build, use a fresh Google Chrome 151+ profile, load the extension from the installed app, and record the checklist in [`test/acceptance/installed-hosts.md`](../test/acceptance/installed-hosts.md). Confirm the initially paused state, one enabled same-tab success, Back to the preceding page, **Use Chrome viewer**, one unavailable-host fallback, and an authenticated one-use response. Record only build and registration identities—never a PDF path, response URL, cookie, capability, or browser-history entry.

## Optional integrations

The app bundles two optional technical-user integrations:

- Codex plugin: `~/Applications/Placekeeper.app/Contents/Resources/integrations/codex-plugin`
- VS Code extension: `~/Applications/Placekeeper.app/Contents/Resources/integrations/vscode`

Install either directory through that application's local extension/plugin workflow. These adapters open the same local service; they do not upload PDFs or submit Codex tasks automatically. The Codex plugin includes `PostToolUse`, `UserPromptSubmit`, and `SessionEnd` hooks that resolve the installed app executable at `~/Applications/Placekeeper.app/Contents/MacOS/placekeeper`. After Codex opens an explicit PDF and its in-app browser authenticates, the same task receives fresh annotation and PDF context on each prompt. If the plugin is disabled, untrusted, installed elsewhere, or its hook cannot run, context remains explicitly unavailable; reopen after restoring the installed plugin rather than copying a browser URL or guessing the active document. VS Code remains desktop-local and refuses Remote SSH, containers, Codespaces, web, virtual, and non-file workspaces.

## Uninstall

Quit Placekeeper, end any bound Codex tasks, and run:

```sh
./install.sh --uninstall
```

This idempotently removes only Placekeeper's Chrome native-host registration and moves the app to the Trash. It does not delete PDFs, exports, Chrome preferences, or Protected Recovery data. Remove **Placekeeper PDF Viewer** from `chrome://extensions` (or leave it unloaded), uninstall any optional Codex or VS Code integration, and optionally remove the source checkout's `.local/` toolchain cache. Reinstalling produces the same extension ID; load the packaged extension again if Chrome no longer tracks the prior path.

Removing the app does not remove recoverable drafts under `~/Library/Application Support/Placekeeper` or user-owned reviewed and revised PDFs. See [Privacy and recovery](privacy-and-recovery.md) before deleting recovery data.
