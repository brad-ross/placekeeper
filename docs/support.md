# Support and diagnostics

Placekeeper is a focused everyday PDF reader and annotator for serious readers, built to preserve your place and train of thought while working through references. It accepts one readable local PDF. Signed PDFs may be viewed and privately annotated, but are never replaced in place. Password-protected editing is unsupported. Annotated-copy export is available only when declared permissions and the selected writer allow it. Non-text pages remain usable for page notes but do not fabricate text anchors.

SyncTeX is optional. When `synctex` or a usable sidecar is missing, stale, ambiguous, oversized, or outside the approved source root, structured live context omits the hint and retains page, coordinate, quote, caret, or page-note evidence. Run the document's checked-in build instructions to regenerate SyncTeX; never move an untrusted sidecar across roots to force a match.

Launch errors are deliberately limited to two classes: **Input unavailable** asks for one readable local PDF; **Unsupported context** asks for a local desktop workspace. If either persists, open the PDF from Finder and confirm the source-installed app launches offline. Viewer compatibility evidence lives in `docs/pdf-conformance-matrix.md`.

For installation failures, run `./install.sh --dry-run` and confirm the host reports Apple-silicon macOS. The normal installer verifies the downloaded Node archive before extraction, bounds its network and writer checks, and stops on dependency, build, install, or offline-doctor failure. Failed replacement restores the prior app. A successful run prints the installed path; a LaunchServices warning means Open With may require reopening Finder, while opening the app directly still presents the PDF chooser.

Finder displays the Placekeeper name and its production [two-page reference-and-return icon](../packaging/macos/icon/Placekeeper.svg). Diagnostics use the app path `~/Applications/Placekeeper.app` and recovery state path `~/Library/Application Support/Placekeeper`.

If an upgrade is deferred, close open Placekeeper documents or end the bound Codex task and retry. Replacement and readiness failures restore the previous app without moving the recovery root. LaunchServices refresh happens only after a healthy replacement commits; a warning affects Finder/Open With registration but does not roll back the usable app.

If a readable document tab stops loading, start Placekeeper and refresh it. A reachable ended or pre-update tab should show **Reopen this PDF** with a selectable `placekeeper:` link; it must not reopen the file or invoke macOS before you click. If startup reports that Placekeeper's fixed loopback port is occupied, stop the unrelated local listener rather than expecting Placekeeper to choose a different port.

Manual downgrade after using Placekeeper is unsupported. The installer can roll back a candidate only before transaction commit and before the candidate opens or autosaves a user document; the rebrand does not add a backward reader for state produced after use.

Public distribution under the Placekeeper name is blocked until trademark, marketplace, and domain clearance is recorded. The implementation can be built and merged for validation before that external publication decision.

Developer ID signing, notarization, stapling, Intel/x64 packages, DMGs, auto-updates, and release CI are deliberately deferred for this personal/friends source distribution. The optional notarization scripts remain available if a future prebuilt download is desired; they are not source-install acceptance gates.

Detailed source-install, live-context, and host evidence lives in `test/acceptance/installed-hosts.md`.

## Claude Desktop

Claude Desktop support is experimental. Set it up as described in [Installation](installation.md#claude-desktop-experimental).

- **`placekeeper` is not listed in Settings → Developer.** Rerun **Help → Set Up Integrations** and read the Claude Desktop outcome. If it says Claude Desktop was not found, open Claude Desktop once, quit it and rerun setup. If setup succeeded, Claude Desktop has not reloaded its configuration: fully quit it (closing the window is not enough) and reopen it.
- **The server is listed but failed to start.** Placekeeper may have been moved, upgraded without being opened since, or uninstalled. Open Placekeeper once so that it repairs the entry, or rerun setup, then restart Claude Desktop. If you uninstalled Placekeeper, remove the entry as described in [Installation](installation.md#claude-desktop-experimental).
- **Setup reports that the configuration is not valid JSON or is not an object.** Setup leaves the file unchanged. Open it through **Settings → Developer → Edit Config** in Claude Desktop, fix the error, then rerun setup.
- **Setup reports a different `placekeeper` server.** The file already has a `placekeeper` entry that Placekeeper did not write, or that was edited after setup wrote it. Setup preserves it. Remove or rename that entry if you no longer need it, then rerun setup.
- **"No Placekeeper reader is open".** Reader tools such as search and navigation act on the most recently opened Placekeeper view. Ask Claude to open the PDF in Placekeeper, or use **File → Open in Claude**, then retry.
- **A tool says the reader is unavailable.** Choose **Open reader** in the view, then retry. Claude expands the view only after a click in it.
- **The view reports that Placekeeper is unavailable.** Start Placekeeper, then ask Claude to open the PDF again.
- **Claude says it cannot read an attached PDF.** Attaching or dropping a PDF uploads it to Claude and does not give it to Placekeeper. Ask Claude to open the file by its full local path instead.

Claude Desktop writes a log for each local server. On macOS it is `~/Library/Logs/Claude/mcp-server-placekeeper.log`, beside `mcp.log`; on Windows look in `%APPDATA%\Claude\logs`. Include the relevant lines, without document paths you consider private, when you ask for help. **Help → Troubleshooting → Enable Developer Mode** in Claude Desktop also lets you open DevTools on the Placekeeper view.

VS Code follows the official guidance for [UI extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host), [remote refusal](https://code.visualstudio.com/api/advanced-topics/remote-extensions), and [restricted webviews](https://code.visualstudio.com/api/extension-guides/webview).

## Web beta

The front-end-only beta is an export-only companion, not the recoverable installed app. It accepts exactly one PDF up to 64 MiB. Current desktop Chromium and Firefox are the advertised browser targets. Automated Playwright WebKit coverage is a regression signal, not proof of branded Safari behavior; real desktop Safari must complete the live upload-export-reopen qualification before Safari is promoted as supported. Mobile browsers and PDF-content screen-reader access are best effort.

If a local file is rejected, confirm that it is no larger than 67,108,864 bytes, begins as a PDF, and is not encrypted, signed, permission-restricted, malformed, or otherwise ineligible for safe rewrite. Because authoring starts only after export eligibility is established, there is no view-only fallback in this beta for an unexportable document. Use the installed Placekeeper app or another reader when viewing alone is sufficient.

If a remote URL fails, it must be a direct HTTPS response that permits cross-origin browser access, identifies PDF content, does not redirect, completes within the time bound, and fits the same size limit. CORS failure does not mean no request was sent. Placekeeper deliberately refuses credentials in the URL and obvious local or private targets, but client-side checks cannot prove public DNS resolution. Download the document through a trusted browser route and upload the local copy instead.

If an export reports failure, the in-memory document and its annotations remain available for another attempt as long as the tab stays open. If export reports success, verify that the browser actually retained the download and reopen that file independently. The success check is structural and does not certify every source object, preserve every unsupported foreign annotation, or sanitize active PDF content. Edits made after an export snapshot remain unexported until another successful export.

Reloading or closing a document with unexported annotations discards it after the browser warning is accepted. There is no autosave, crash recovery, account, server copy, or browser-storage recovery path. See [Web beta operation and release](web-beta.md) for compatibility details, security boundaries, and the dormant publication checklist.
