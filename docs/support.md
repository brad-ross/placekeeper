# Support and diagnostics

PDF Proofreader accepts one readable local PDF. Signed PDFs may be viewed and privately reviewed, but are never replaced in place. Password-protected editing is unsupported. Annotated-copy export is available only when declared permissions and the selected writer allow it. Non-text pages remain usable for page notes but do not fabricate text anchors.

SyncTeX is optional. When `synctex` or a usable sidecar is missing, stale, ambiguous, oversized, or outside the approved source root, the handoff omits the hint and retains page, coordinate, quote, caret, or page-note evidence. Run the document's checked-in build instructions to regenerate SyncTeX; never move an untrusted sidecar across roots to force a match.

Launch errors are deliberately limited to two classes: **Input unavailable** asks for one readable local PDF; **Unsupported context** asks for a local desktop workspace. If either persists, open the PDF from Finder and confirm the installed app launches offline. Viewer compatibility evidence lives in `docs/pdf-conformance-matrix.md`.

Release evidence not yet available in this development environment:

- Developer ID signing identity: unavailable.
- Apple notarization keychain profile: unavailable.
- Stapling and Gatekeeper assessment of a distributed artifact: pending.
- Clean Intel/x64 installation and offline smoke test: pending.
- Adobe Acrobat Reader compatibility sign-off: pending in the conformance matrix.

Do not mark those rows passed from unit tests or an unsigned development bundle.

Release implementation follows [Apple's notarization guidance](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) and VS Code's official guidance for [UI extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host), [remote refusal](https://code.visualstudio.com/api/advanced-topics/remote-extensions), and [restricted webviews](https://code.visualstudio.com/api/extension-guides/webview).
