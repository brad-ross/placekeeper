# Support and diagnostics

Placekeeper is a focused everyday PDF reader and annotator for serious readers, built to preserve your place and train of thought while working through references. It accepts one readable local PDF. Signed PDFs may be viewed and privately reviewed, but are never replaced in place. Password-protected editing is unsupported. Annotated-copy export is available only when declared permissions and the selected writer allow it. Non-text pages remain usable for page notes but do not fabricate text anchors.

SyncTeX is optional. When `synctex` or a usable sidecar is missing, stale, ambiguous, oversized, or outside the approved source root, structured live context omits the hint and retains page, coordinate, quote, caret, or page-note evidence. Run the document's checked-in build instructions to regenerate SyncTeX; never move an untrusted sidecar across roots to force a match.

Launch errors are deliberately limited to two classes: **Input unavailable** asks for one readable local PDF; **Unsupported context** asks for a local desktop workspace. If either persists, open the PDF from Finder and confirm the source-installed app launches offline. Viewer compatibility evidence lives in `docs/pdf-conformance-matrix.md`.

For installation failures, run `./install.sh --dry-run` and confirm the host reports Apple-silicon macOS. The normal installer verifies the downloaded Node archive before extraction, bounds its network and writer checks, and stops on dependency, build, install, or offline-doctor failure. Failed replacement restores the prior app. A successful run prints the installed path; a LaunchServices warning means Open With may require reopening Finder, while opening the app directly still presents the PDF chooser.

Finder displays the Placekeeper name and its production [two-page reference-and-return icon](../packaging/macos/icon/Placekeeper.svg). For upgrade compatibility, diagnostics still use the physical bundle path `~/Applications/PDF Proofreader.app` and recovery state path `~/Library/Application Support/PDF Proofreader`; those legacy technical names do not indicate a second installation.

Developer ID signing, notarization, stapling, Intel/x64 packages, DMGs, auto-updates, and release CI are deliberately deferred for this personal/friends source distribution. The optional notarization scripts remain available if a future prebuilt download is desired; they are not source-install acceptance gates.

Detailed source-install, live-context, and host evidence lives in `test/acceptance/installed-hosts.md`.

VS Code follows the official guidance for [UI extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host), [remote refusal](https://code.visualstudio.com/api/advanced-topics/remote-extensions), and [restricted webviews](https://code.visualstudio.com/api/extension-guides/webview).
