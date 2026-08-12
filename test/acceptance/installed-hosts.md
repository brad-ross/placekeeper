# Source install and host acceptance evidence

The required v1 distribution is a source-first Apple-silicon install for a personal/friends app. Developer ID signing, notarization, stapling, Intel/x64, DMG/PKG packaging, auto-update, and release CI are optional future distribution work rather than blockers.

## Required automated evidence

- `packaging/macos/packaging.test.ts`: the manifests accept only `arm64` / `darwin-arm64`, signing is optional, `./install.sh --dry-run` is content-free and non-mutating, the native Finder document bridge is present, and a partial replacement restores the previous app.
- `pnpm validate:distribution`: the selected runtime manifest and pinned local PDFium asset agree.
- `./install.sh`: downloads a SHA-256-pinned Node 24.14.0 arm64 toolchain with bounded network waits, invokes pnpm 11.16.0 with the frozen lockfile, builds the app, runs the packaged writer doctor offline with a deadline and output bound, and transactionally installs the app with its native Finder document bridge for the current user.
- `apps/service/test/launch-host.test.ts` and `apps/service/test/open-command.test.ts`: one persistent broker, open-or-focus, explicit fork/recovery choices, two shared error classes, ordinary and VS Code embedding policy, and capability-safe launch results.
- `test/acceptance/launch-surfaces.spec.ts`: Finder, Codex plugin, and VS Code manifests target the same launcher without automatic task submission.
- `test/acceptance/production-flow.spec.ts`: the installed-style ordinary-browser tree reaches the shared viewer, responsive state, Human Save, and Codex preparation through the real host.

## Required source-first acceptance

- [x] From a dependency-free Apple-silicon source copy, `./install.sh --dry-run` reports the pinned toolchain and user-local destinations without changing files.
- [x] From that dependency-free source copy, `./install.sh` downloads Node 24.14.0, installs pnpm 11.16.0 dependencies from the frozen lockfile, and succeeds without Apple signing credentials.
- [x] The isolated acceptance install creates the app at the configured user-local destination; the default is `~/Applications/PDF Proofreader.app`.
- [x] The installer finishes only after the packaged Node/PDFium writer opens the generated fixture offline.
- [x] After the intentional unsigned-app first-open confirmation, Finder Open With opens one PDF without Terminal; duplicate launch focuses the same recoverable review and explicit fork creates a separate review.
- [x] Re-running the installer replaces the app without deleting recovery data or user-owned review artifacts; the transaction test proves a partial replacement restores the prior app. It also removes the obsolete beta Quick Action if found.

Observed on 2026-08-07: the acceptance run began from an isolated source copy with no `node_modules`, `.local`, or `dist`; downloaded and verified the pinned 48.6 MB Node archive; installed 129 locked packages with pnpm 11.16.0; built the service, web app, and VS Code adapter; installed into an isolated user directory; and passed the packaged offline writer doctor. A separate repeat-install run passed against an existing app destination. The updated installer then replaced the real `~/Applications/PDF Proofreader.app`, removed the obsolete Quick Action, and produced a valid ad-hoc-signed bundle whose Finder executable is `droplet` and whose PDF handler rank is `Alternate`. Finder **Open With -> PDF Proofreader** opened `text-native.pdf` in the complete loopback review UI without Terminal; invoking it again retained the same broker session URL. The automated launch-host suite covers the explicit independent-fork branch.

## Optional integration evidence

- Codex plugin and VS Code extension contract tests remain required because the artifacts ship in the app.
- Manual installation and UI smoke tests for Codex desktop and VS Code desktop are recommended for users who choose those integrations, but do not block the core Finder/ordinary-browser source release.
- VS Code Remote SSH, containers, Codespaces, web, virtual, and non-file workspaces remain intentionally refused.

## Reading-first interface evidence

Automated release-candidate coverage added on 2026-08-08 exercises the same production review tree in an ordinary Chromium launch and a narrow 320-CSS-pixel `vscode` embed launch. The checks record one mounted viewer, one compact chrome, page `1 / 1`, unchanged page bounds and viewer mount identity through disclosure, preserved review state through breakpoint changes, visible drawer close controls, and deterministic focus restoration. The WebKit gate runs both the joined review workflow and installed-style production flow. Capability URLs are deliberately excluded from test output and this record.

The implementation was visually compared at 1280×900 and narrow widths with the plan-linked `reading-first-core-states.html` and `reading-first-drawer-states.html` mockups. The resulting hierarchy keeps the PDF full-bleed within the content area, exposes annotation and Finish drawers only on request, uses a side peek for mark correspondence, and removes spatial transitions under reduced-motion preferences.

Installed Codex and VS Code desktop UI evidence still requires a release-candidate install and is not claimed by this source-tree run. For that release check, append one row per host without recording the capability URL:

## Warm Neutral reference review (2026-08-09)

The deterministic production-root scenes were compared in the source harness with `docs/plans/assets/2026-08-09-warm-neutral-design-language/warm-neutral-synthesis.html`. The source comparison covers the shared production review tree only; it does not claim an installed Codex or VS Code desktop inspection.

| R2 dimension | Source-scene finding |
|---|---|
| Warmth | Pass: warm-gray canvas and ivory panels retain the reference's environmental temperature. |
| Neutrality | Pass: routine chrome remains neutral; blue, green, amber, and red are reserved for state meaning. |
| Contrast hierarchy | Pass: primary, muted, and quiet text roles remain visibly ordered without hard black outlines. |
| Corner softness | Pass: controls, palettes, drawers, cards, and composers share the soft-radius family. |
| Border subtlety | Pass: panel and control edges use the semantic subtle/standard border roles. |
| Typography density | Pass: compact chrome and annotation metadata remain subordinate to document content. |
| Control treatment | Pass: Lucide-plus-label actions, hover, focus, active, and disabled treatments remain distinct. |
| Elevation | Pass: page, contextual palette, peek, composer, and drawers retain increasing semantic elevation. |

Accepted R3 deviations: production keeps the settled adaptive Annotation Tray geometry (24rem maximum right tray and 43% bottom sheet) rather than the synthesis's literal drawer dimensions, and intentionally has no tray close control because the Annotations disclosure owns dismissal. Real PDF/fixture content and the production Lucide subset differ from the synthesis's sample copy and placeholder glyphs; these are non-normative differences, not R3 deviations.

The committed visual suite captures only `[data-production-review]`, uses fixed 1280×900 and 320×720 scenes, and includes long deterministic titles, paths, messages, counts, focus, hover, loading, empty, success, warning, and error states. CI compares Linux goldens with Playwright-managed Chromium at device scale factor 1 on `ubuntu-24.04`; CI does not use an update flag. Matching macOS goldens remain committed for local Mac development.

Host status remains honest: the ordinary-browser installed-style production flow is automated and verifies one mounted viewer, local-only assets, real PDF rendering, responsive framing, and browser errors. Actual Codex desktop and VS Code desktop visual inspection was not performed in this source-tree run and remains pending below.

| Date | Build | Surface | Viewport width | Initial page / zoom / scroll | Open surface | Final page / zoom / scroll | Final focus | Screenshot or checklist |
|---|---|---|---:|---|---|---|---|---|
| Pending | Pending | Codex desktop | — | — | — | — | — | Pending |
| Pending | Pending | VS Code desktop | — | — | — | — | — | Pending |

## Optional future prebuilt release

If the project later distributes a prebuilt download, reinstate Developer ID signing, notarization, stapling, quarantine/Gatekeeper testing, and a clean Apple-silicon download smoke before calling that artifact easy to install. Do not claim those properties from the source-first build.
