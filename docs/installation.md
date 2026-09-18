# Install and uninstall

Placekeeper is a focused, local-only PDF reader and annotator for Apple-silicon macOS, distributed from source. It does not require an Apple Developer account, Developer ID certificate, notarization profile, Homebrew, or a global Node installation.

## Install a tested source release

Requirements are an Apple-silicon Mac, macOS 13 or newer, internet access during installation, standard macOS tools (`curl`, `tar`, `shasum`, and `ditto`), and [Apple Command Line Tools](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools) with a working Swift 6-or-newer compiler and macOS SDK. macOS 13 is the app runtime floor; installing a compatible source-build toolchain may require a newer macOS version. The installer checks the compiler and SDK before toolchain downloads.

Use **Install** on the landing page to copy the complete command. It downloads the latest published stable release's bootstrap completely before running it. That bootstrap pins one version and commit, verifies its source archive's SHA-256, paths, and release descriptor, then runs that archive's installer. A newer release appearing during the run cannot change the selected source. GitHub and repository publication permissions are the trust root; the digest checks consistency, not independent publisher authentication.

If no stable source release is available, the command fails rather than falling back to main. Connection errors, partial downloads, invalid archives, missing prerequisites, and build failures stop with an actionable error.

For a development checkout, run `./install.sh` in the repository folder. Preview it without downloads or mutations with `./install.sh --dry-run`. The installer downloads checksum-pinned Node 24.14.0, installs pnpm 11.16.0 dependencies from the frozen lockfile, builds locally, and checks the packaged PDF writer offline before transactionally installing `~/Applications/Placekeeper.app`.

After the Mac app is installed or confirmed current, Chrome, VS Code, and Codex setup are offered separately. Each can be skipped. Rerun the landing command to update or add skipped integrations; a current Mac app still offers host setup. With no terminal, optional setup is skipped and rerun guidance is printed. From a source checkout, explicit choices are available:

```sh
./install.sh --chrome=setup --vscode=skip --codex=ask
```

Each host accepts `setup`, `skip`, or `ask`. A host failure does not undo the Mac installation or prevent the remaining hosts from being offered. The summary distinguishes completed, skipped, pending manual actions, and failed setup. Exit 2 means the core install was deferred; exit 3 means the Mac succeeded but optional setup failed. Pending manual actions alone are not failures.

Placekeeper checks its shared service before replacing the app or mutating a selected integration. Active reviews or bound Codex tasks defer the change without discarding work: close the indicated work, allow its lease to expire, and retry. Busy or unreadable service state also leaves the existing installation intact. A distinct candidate must report its exact build before replacement commits; failed readiness restores the previous app. Exact app reuse does not waive the independent host safety check.

Chrome preparation is a separate transaction after Mac success. Skipping it does not create or remove registration. Failed preparation restores previous Chrome artifacts and leaves the successful Mac installation in place. Chrome preferences, unrelated host registration, user settings, PDFs, exports, and Protected Recovery are preserved. A narrow legacy-ownership receipt may persist until an older managed Chrome folder can be safely adopted; it stores no integration choices or enablement state.

The packaged service reuses one fixed numeric-loopback origin so a browser tab can reach the replacement service at the same literal URL. A still-live service resumes the exact in-memory review on refresh. In Codex, **Copy Link** uses that credential-free readable URL so it can be pasted back into the built-in browser without becoming a web search. A replacement service instead shows a compact **Reopen review** screen carrying only the PDF identity and page/saved-item location. That single explicit click is the confirmation boundary: an ordinary review reopens immediately in the same browser tab, while a protected draft offers **Resume draft**, **Discard draft**, and **Open separate copy** before anything is changed. The secondary **Copy Placekeeper link** action copies the canonical `placekeeper:///` link for opening in another Placekeeper or Codex context. A successor can reattach the original Codex task only through the scoped reconnect handshake; the stale URL itself never restores credentials or task authority. If Placekeeper is stopped, the tab may show the browser's connection error until the app is started and the tab is refreshed again.

Because the source build is intentionally not Developer ID-signed or notarized (it receives only a local ad-hoc signature), macOS may warn on first launch. In Finder, Control-click `~/Applications/Placekeeper.app`, choose **Open**, and confirm once. Do not disable Gatekeeper globally and do not recursively remove quarantine attributes.

After installation, select one local PDF in Finder and use **Open With -> Placekeeper**. Alternatively, open Placekeeper from `~/Applications` and choose a PDF. The PDF opens in Placekeeper’s own Mac window. Opening a PDF through the Codex plugin continues to use the Codex in-app browser. No terminal is needed for ordinary use.

## Open Chrome PDFs automatically (experimental)

The Chrome integration is optional and experimental. Chrome 151 or newer is required. Select Chrome setup in the installer first; only that stage prepares the persistent folder and native-host registration. New installations start paused; updates preserve the existing on/off choice. Prepared files and a healthy doctor report do not prove Chrome has loaded or enabled the extension. The installer reports these manual steps as pending.

1. In Chrome, open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**.
2. Select `~/Applications/Placekeeper Chrome Extension`. This ordinary folder is the transactionally installed copy intended for Chrome's folder picker; do not select the copy inside `Placekeeper.app`.
3. Pin **Placekeeper PDF Viewer** if you want its control readily available, open its toolbar menu, and turn on automatic PDF opening.

The checked-in extension key keeps the ID `cgegjjjhbhnfgcoipeffhogoojfoekgg` stable. The user-level native host accepts only that exact extension origin. Because this is source-first, unpacked distribution, Chrome trusts code at the loaded path as your macOS user; do not replace it with a symlink or make it group/world writable. An update preserves the extension's existing on/off choice because that choice lives in Chrome, not the installer.

When automatic opening is on, an eligible top-level PDF renders the complete Placekeeper client inside its existing Chrome tab. The address bar keeps the original PDF URL. The tab title uses PDF metadata when it contains a usable title and otherwise uses the sanitized filename. Placekeeper's own Back and Forward controls traverse document locations without changing browser history, so Chrome Back returns to the page before the PDF.

Before the PDF is activated, the pending page offers **Use Chrome viewer** for a one-PDF bypass. A native-host or validation failure at this stage falls back to Chrome once. After activation, Placekeeper never invokes Chrome fallback: if the local service disconnects or an update is required, the PDF stays visible and read-only with an explicit **Reopen PDF** action. Protected work is retained and may offer **Resume draft**, **Discard draft**, or **Fork review**. To pause all automatic opening, use the extension's toolbar popup. Other installed PDF-handler extensions can conflict because Chrome chooses the most recently installed eligible handler; pause or remove the other handler, then reload Placekeeper's packaged extension.

If Chrome falls back unexpectedly, first confirm that Placekeeper is installed at the same path shown above and reload the packaged extension from `chrome://extensions`. Then run:

```sh
"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper" doctor --json --chrome
```

`healthy` means the packaged extension path, stable ID, protocol, and native registration agree. `load-packaged-extension`, `reload-packaged-extension`, or `reinstall-placekeeper` is the recommended corrective action; the report deliberately omits private paths and browser capabilities. If a failure occurs before Placekeeper activates, an incompatible extension or host safely falls back to Chrome without changing the automatic-open toggle. If the PDF is already visible in Placekeeper, reload the packaged extension and choose **Reopen PDF**; do not discard a protected draft unless that is intentional.

### Verify the Chrome integration from source

Run the deterministic handoff gate before an installed release check:

```sh
pnpm test:chrome-handoff
```

This uses a newly created temporary Chromium profile and an in-process loopback fixture. It covers authenticated suffixless PDFs, a redirect that preserves a one-use POST response, slow/chunked delivery, invalid content, interrupted delivery, the transfer limit, exact-once stream handling, paused/bypass and host-failure fallback, local-file identity, temporary-source cleanup and recovery, remote/local save policy, and the browser/Codex authority boundary. It never opens or modifies the everyday Chrome profile. If Playwright's managed Chromium cannot expose Chrome 151's public `mimeHandler` API, that one automation probe is reported as skipped with a reason; the protocol and lifecycle checks still run.

That skip does not establish real Chrome compatibility. The installed Chrome matrix is a separate validation of the experimental integration, not a gate for publishing the Mac source installer. After installing the candidate app, run:

```sh
pnpm test:chrome-installed
```

The runner validates the distributable extension and exact native-host registration, launches a fresh Google Chrome 151+ profile, and displays the exact **Load unpacked** path. After you enable Developer Mode, load that directory, and turn on **Open PDFs automatically**, it verifies the initially paused state, loaded runtime identity, outer-tab metadata and filename titles, original URL retention, shared-client mount, browser Back, and the packaged PDFium worker's privilege boundary. It leaves the disposable window open for the remaining recovery, keyboard, lifecycle, and performance matrix in [`test/acceptance/installed-hosts.md`](../test/acceptance/installed-hosts.md), then erases the profile when you confirm completion. That exploratory run exits nonzero while its matrix is pending. Record the aggregate evidence described there—never a fixture URL, cookie, capability, task identifier, staging path, or PDF content—then rerun with `--manual-evidence <input.json>` to produce build-bound Chrome evidence. A pending, stale, partial, or over-budget record cannot establish a passing Chrome validation. Source publication does not accept this report as an input; the separate signed/prebuilt release workflow retains its stricter evidence gate.

## Optional integrations

Select VS Code or Codex setup when the installer offers it, or rerun later. VS Code uses its supported CLI to install or refresh the bundled VSIX and checks the installed extension list; reload the editor afterward. If the CLI is unavailable, use **Extensions: Install from VSIX** with `~/Applications/Placekeeper.app/Contents/Resources/integrations/placekeeper.vsix`.

Codex uses supported marketplace/plugin commands when available. Otherwise, add the local marketplace rooted at `~/Applications/Placekeeper.app/Contents/Resources/integrations` through Codex's plugin workflow (`.agents/plugins/marketplace.json`, marketplace `placekeeper-installed`), then select `codex-plugin`. The bundled plugin lives in that directory's `codex-plugin` folder. These installed paths survive deletion of the downloaded source. Trust, enablement, and starting a new task remain explicit host steps and are reported pending until verifiable.

These adapters open the same local service; they do not upload PDFs or submit Codex tasks automatically. The Codex plugin includes `PostToolUse`, `UserPromptSubmit`, and `SessionEnd` hooks that resolve the installed app executable at `~/Applications/Placekeeper.app/Contents/MacOS/placekeeper`. After Codex opens an explicit PDF and its in-app browser authenticates, the same task receives fresh annotation and PDF context on each prompt. If the plugin is disabled, untrusted, installed elsewhere, or its hook cannot run, context remains explicitly unavailable; reopen after restoring the installed plugin rather than copying a browser URL or guessing the active document.

Open local PDFs refresh automatically when another process writes or replaces the file at the same path. This works for ordinary PDFs and generated LaTeX output in the Mac app, Chrome, Codex browser, and VS Code. During an interrupted write, Placekeeper continues showing the last valid PDF and retries when the file becomes valid. It does not visibly refresh when only file metadata changes and the PDF bytes are identical.

An unfinished annotation in any window pauses the shared review on its current PDF, even when that window is in the background. Saving, cancelling, closing, or disconnecting the last active editor releases the pause and applies the newest valid replacement. Protected drafts remain recoverable if their window or the service disappears. If an annotation passage is missing, ambiguous, or unsupported in the replacement, Placekeeper preserves the annotation for manual reattachment instead of choosing an uncertain location.

The VS Code extension is desktop-local and refuses Remote SSH, containers, Codespaces, web, virtual, and non-file workspaces. In a trusted local LaTeX workspace, run **Placekeeper: View PDF** or **Placekeeper: Forward SyncTeX**. The embedded review uses only the extension's integrity-checked shared JavaScript, CSS, inline worker, and PDFium WASM. It does not use a review iframe, open an external browser, or ask LaTeX Workshop to build through a private API.

For LaTeX Workshop 10.18.x, first open the generated PDF in Placekeeper and then run **Placekeeper: Configure LaTeX Workshop**. Review the preview before applying its workspace-only settings. The installed command is `~/Applications/Placekeeper.app/Contents/MacOS/placekeeper-vscode`; each invocation is bound to the one panel, VS Code window, and canonical output that created it. **Placekeeper: Restore LaTeX Workshop Settings** restores only unchanged values previously written by Placekeeper. The registration is intentionally short-lived, so reopen the output and reapply the preview after a VS Code restart if ordinary LaTeX Workshop routing is still wanted.

This external-viewer setup is an opt-in compatibility path, not a supported LaTeX Workshop extension API. If LaTeX Workshop is missing, outside the tested 10.18.x line, routes the request to a different window, or changes its placeholders, Placekeeper fails closed and leaves the prior PDF and review work untouched. The supported fallback is always **Placekeeper: View PDF** plus **Placekeeper: Forward SyncTeX**; it is also the documented workflow on the VS Code 1.95 minimum.

## Uninstall

Quit Placekeeper, end any bound Codex tasks, and run:

```sh
./install.sh --uninstall
```

This idempotently removes only Placekeeper's Chrome native-host registration and moves the app to the Trash. It does not delete PDFs, exports, Chrome preferences, or Protected Recovery data. Remove **Placekeeper PDF Viewer** from `chrome://extensions` (or leave it unloaded), uninstall any optional Codex or VS Code integration, and optionally remove the source checkout's `.local/` toolchain cache. Reinstalling produces the same extension ID; load the packaged extension again if Chrome no longer tracks the prior path.

Removing the app does not remove recoverable drafts under `~/Library/Application Support/Placekeeper` or user-owned reviewed and revised PDFs. See [Privacy and recovery](privacy-and-recovery.md) before deleting recovery data.

## Publish a source release (maintainers)

Publication is a separate action after merge; implementing the installer does not publish a release. The manually dispatched **Release source** workflow (`.github/workflows/release-source.yml`) accepts only trusted `main` in `brad-ross/placekeeper`. Select a stable numeric version equal to `packaging/macos/app-bundle.json`, without the `v` prefix, and brief release notes. Bump and merge the canonical version before subsequent releases. An existing tag or release, including a draft, blocks publication.

Dispatch with only `version` and `notes`. The optional Chrome integration is experimental; its installed-host matrix is collected separately and does not block source publication. Automated Chrome handoff checks remain required. A successful source release does not prove Chrome activation or Codex trust/enablement, and must not be presented as a completed physical-host validation.

Read-only validation runs typechecking, source/bootstrap fixtures, packaging and host tests, upgrade lifecycle tests, Chrome handoff checks, an unsigned candidate build, and the offline installed smoke. Source packaging includes only the exact checked-out commit. Only the dependent publication job receives `contents: write`; it regenerates deterministic assets from that same commit, repeats the duplicate checks, creates a draft with notes, uploads the source archive and `install-placekeeper.sh`, verifies completeness, and then promotes it to stable/latest. Publication is serialized. It requires no Apple signing secrets; the separate signed macOS workflow remains available.

Published assets are never replaced. If an upload fails, the incomplete draft stays unpublished and blocks reruns for that version; inspect it before any manual cleanup. For a published regression, merge a correction with a new higher canonical version and publish that corrected release. Do not overwrite the old bootstrap or archive. Existing installs preserve active work and require the same close-and-retry protections when updating.
