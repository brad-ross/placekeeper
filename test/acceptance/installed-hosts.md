# Source install and host acceptance evidence

The required v1 distribution is a source-first Apple-silicon install for a personal/friends app. Developer ID signing, notarization, stapling, Intel/x64, DMG/PKG packaging, auto-update, and release CI are optional future distribution work rather than blockers.

## Required automated evidence

- `packaging/macos/packaging.test.ts`: the manifests accept only `arm64` / `darwin-arm64`, signing is optional, `./install.sh --dry-run` is content-free and non-mutating, and a partial replacement restores the previous app and Finder action.
- `pnpm validate:distribution`: the selected runtime manifest and pinned local PDFium asset agree.
- `./install.sh`: downloads a SHA-256-pinned Node 24.14.0 arm64 toolchain with bounded network waits, invokes pnpm 11.16.0 with the frozen lockfile, builds the app, runs the packaged writer doctor offline with a deadline and output bound, and transactionally installs the app and Finder action for the current user.
- `apps/service/test/launch-host.test.ts` and `apps/service/test/open-command.test.ts`: one persistent broker, open-or-focus, explicit fork/recovery choices, two shared error classes, ordinary and VS Code embedding policy, and capability-safe launch results.
- `test/acceptance/launch-surfaces.spec.ts`: Finder, Codex plugin, and VS Code manifests target the same launcher without automatic task submission.
- `test/acceptance/production-flow.spec.ts`: the installed-style ordinary-browser tree reaches the shared viewer, responsive state, Human Save, and Codex preparation through the real host.

## Required source-first acceptance

- [x] From a dependency-free Apple-silicon source copy, `./install.sh --dry-run` reports the pinned toolchain and user-local destinations without changing files.
- [x] From that dependency-free source copy, `./install.sh` downloads Node 24.14.0, installs pnpm 11.16.0 dependencies from the frozen lockfile, and succeeds without Apple signing credentials.
- [x] The isolated acceptance install creates the app and Finder action at the configured user-local destinations; the default destinations are `~/Applications/PDF Proofreader.app` and `~/Library/Services/PDF Proofreader.workflow`.
- [x] The installer finishes only after the packaged Node/PDFium writer opens the generated fixture offline.
- [ ] After the intentional unsigned-app first-open confirmation, Finder Open With and Quick Actions open one PDF without Terminal; duplicate launch focuses the same recoverable review and explicit fork creates a separate review.
- [x] Re-running the installer replaces the app and Quick Action without deleting recovery data or user-owned review artifacts; the transaction test proves a partial replacement restores both prior artifacts.

Observed on 2026-08-07: the acceptance run began from an isolated source copy with no `node_modules`, `.local`, or `dist`; downloaded and verified the pinned 48.6 MB Node archive; installed 129 locked packages with pnpm 11.16.0; built the service, web app, and VS Code adapter; installed into isolated user directories; and passed the packaged offline writer doctor. A separate repeat-install run passed against existing app and workflow destinations. The Finder first-open row remains a deliberate manual check because the implementation run did not install into the user's real home directory or drive Finder UI.

## Optional integration evidence

- Codex plugin and VS Code extension contract tests remain required because the artifacts ship in the app.
- Manual installation and UI smoke tests for Codex desktop and VS Code desktop are recommended for users who choose those integrations, but do not block the core Finder/ordinary-browser source release.
- VS Code Remote SSH, containers, Codespaces, web, virtual, and non-file workspaces remain intentionally refused.

## Optional future prebuilt release

If the project later distributes a prebuilt download, reinstate Developer ID signing, notarization, stapling, quarantine/Gatekeeper testing, and a clean Apple-silicon download smoke before calling that artifact easy to install. Do not claim those properties from the source-first build.
