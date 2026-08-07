# Installed host and release acceptance evidence

This checklist separates deterministic adapter/package coverage from checks that require signed artifacts, installed host applications, or a second architecture.

## Automated local evidence

- `apps/service/test/launch-host.test.ts` and `apps/service/test/open-command.test.ts`: one persistent broker, open-or-focus, explicit fork/recovery choices, two shared error classes, ordinary and VS Code embedding policy, and capability-safe structured launch results.
- `apps/vscode/test/extension.test.ts`: desktop-local extension kind, selected/active PDF handling, workspace source-root selection, remote/virtual refusal, restricted webview, in-memory capability delivery, and recovery choice handling.
- `test/acceptance/launch-surfaces.spec.ts`: Finder, Codex plugin, and VS Code manifests all target the shared launcher without Terminal use or automatic task submission.
- `test/acceptance/production-flow.spec.ts`: the installed-style ordinary-browser tree reaches the shared viewer, all delivery controls, responsive state, verified Human Save, and Codex preparation through the real host.
- `packaging/macos/packaging.test.ts`, `pnpm validate:distribution`, and `pnpm smoke:installed`: pinned offline runtime, arm64/x64 manifests, self-contained service bundle, local assets, and an unsigned arm64 app whose packaged Node/PDFium writer opens a fixture offline.

Run the automated host evidence with `pnpm test:u7-host`, then run `pnpm build`, `pnpm validate:distribution`, and the installed smoke against a temporary unsigned bundle.

Local environment audit on 2026-08-07: the arm64 host built `/var/folders/.../pdf-proofreader-package-arm64-HJfewe/PDF Proofreader.app` through the argument-free `pnpm package:macos` command, and `pnpm smoke:installed` passed its one-page offline EmbedPDF/PDFium writer doctor. VS Code is installed, but PDF Proofreader is not installed in `/Applications`. The keychain reports zero valid code-signing identities, the configured notary profile is unavailable, and no x64 host is available. These facts support the automated unsigned row only; they cannot satisfy the installed/release rows below.

## Pending installed/release evidence

- [ ] Import a Developer ID Application identity, build the arm64 package with hardened runtime and secure timestamp, notarize it, staple it, and pass `spctl` on a clean Apple-silicon Mac.
- [ ] Repeat the signed, notarized, stapled, offline installed smoke on a clean Intel/x64 Mac using the x64 Node runtime and package.
- [ ] From Finder Open With and the bundled Quick Action, open one PDF without Terminal and verify duplicate launch focuses the same recoverable review while explicit fork creates a separate review.
- [ ] Install the bundled Codex plugin, invoke it with a referenced PDF, choose any offered recovery action natively, and verify Codex's built-in browser reaches the same scoped production UI without automatic task submission.
- [ ] Install the bundled VS Code extension locally, open selected and active PDFs in a desktop workspace, dispose/reopen the panel without finishing the draft, and verify Remote SSH, container, Codespaces, web, virtual, and non-file workspaces are refused without forwarding or copying files.
- [ ] On each installed host surface, exercise one side of the shared 1024px breakpoint and verify review state, active item, zoom/selection, and delivery controls match the ordinary-browser workflow.

Do not mark these rows passed from unit tests, an unsigned local bundle, or an adapter manifest inspection.
