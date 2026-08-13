# Source install and host acceptance evidence

The required v1 distribution is a source-first Apple-silicon install for a personal/friends app. Developer ID signing, notarization, stapling, Intel/x64, DMG/PKG packaging, auto-update, and release CI are optional future distribution work rather than blockers.

## Required automated evidence

- `packaging/macos/packaging.test.ts`: the manifests accept only `arm64` / `darwin-arm64`, signing is optional, `./install.sh --dry-run` is content-free and non-mutating, the native Finder document bridge is present, the Codex skill and all three lifecycle hooks resolve the installed executable, and a partial replacement restores the previous app.
- `pnpm validate:distribution`: the selected runtime manifest and pinned local PDFium asset agree.
- `./install.sh`: downloads a SHA-256-pinned Node 24.14.0 arm64 toolchain with bounded network waits, invokes pnpm 11.16.0 with the frozen lockfile, builds the app, runs the packaged writer doctor offline with a deadline and output bound, and transactionally installs the app with its native Finder document bridge for the current user.
- `packaging/macos/smoke-installed.ts`: in an isolated short `HOME`, a real packaged launcher and daemon prove exact-bundle no-op reuse, two simultaneously authenticated PDFs, task-current Codex context, byte-preserving active-upgrade deferral, `SessionEnd` revocation, browser-presence lease expiry, distinct-build idle replacement, candidate readiness, and a post-upgrade PDF launch. The distinct candidate is a physical clone with a deterministic extra served-asset byte and freshly recomputed daemon/artifact identities; it does not fake the running daemon's identity.
- `apps/service/test/launch-host.test.ts`, `apps/service/test/open-command.test.ts`, and `apps/service/test/codex-live-context.integration.test.ts`: one persistent broker, open-or-focus, explicit fork/recovery choices, capability-safe launch results, and the exact successful Codex hook claim through browser activation, prompt refresh, annotation delta, bounded evidence retrieval, cross-task denial, and task-end revocation.
- `test/acceptance/launch-surfaces.spec.ts`: Finder, Codex plugin, and VS Code manifests target the same launcher without automatic task submission; only Codex requests the bound launch surface and packages live-context hooks.
- `test/acceptance/production-flow.spec.ts`: the installed-style ordinary-browser tree reaches the shared viewer, responsive state, Human Save, autosave/recovery, and no Codex action or context status.

## Required source-first acceptance

- [x] From a dependency-free Apple-silicon source copy, `./install.sh --dry-run` reports the pinned toolchain and user-local destinations without changing files.
- [x] From that dependency-free source copy, `./install.sh` downloads Node 24.14.0, installs pnpm 11.16.0 dependencies from the frozen lockfile, and succeeds without Apple signing credentials.
- [x] The isolated acceptance install creates the app at the configured user-local destination; the default is `~/Applications/Placekeeper.app`.
- [x] The installer finishes only after the packaged Node/PDFium writer opens the generated fixture offline.
- [x] After the intentional unsigned-app first-open confirmation, Finder Open With opens one PDF without Terminal; duplicate launch focuses the same recoverable review and explicit fork creates a separate review.
- [x] Re-running the installer replaces the app without deleting recovery data or user-owned review artifacts; the transaction test proves a partial replacement restores the prior app.
- [x] Candidate readiness runs before the replacement transaction commits. A failing readiness executable restores the prior bundle; a successful installed smoke observes the exact candidate management identity in `accepting` state before continuing.

## Upgrade lifecycle evidence

The production installed smoke executes the current packaged candidate and transaction. This clean-break identity does not provide an old-name fixture, alias, state migration, or integration bridge.

| State | Automated result | Recovery shown to the user |
|---|---|---|
| Exact daemon and identical bundle | Existing daemon is reused; no shutdown request or bundle move. | None. |
| Distinct candidate, two active PDFs | Replacement exits before touching the installed identity; both authenticated review state endpoints remain usable. | Close Placekeeper tabs/windows, wait for the five-second grace lease, and retry. |
| Active Codex binding | Deferred install retains current prompt context; `SessionEnd` revokes it without stopping unrelated reviews. | End the bound Codex task or wait for its lease, then retry. |
| Accepted save or lifecycle work | Coordinator retries for at most five seconds, then preserves the app if work is still active. | Wait a moment, then retry. |
| Malformed or timed-out daemon | Socket-level acceptance classifies it as uninspectable and the transaction helper is never invoked. | Close reviews and retry from the current Placekeeper installation. |
| Closed pages plus ended task | Presence grace expires, conditional shutdown completes, candidate replacement/readiness succeeds, and the new launcher opens the fixture. | Retry the install. |

The matrix also fixes the expected boundaries for offline-smoke failure, active-review deferral, active-Codex deferral, replacement failure, changed-hash readiness, readiness rollback, the physical destination, and warning-only LaunchServices failure. Candidate readiness is document-free: no user PDF is opened or autosaved before `install-built-app.sh` commits. A successful replacement preserves current recovery bytes. A failed replacement restores the prior current-identity app while leaving that recovery material untouched.

## Placekeeper release-candidate record

Automated evidence does not stand in for Finder, Dock, or Open With rendering. Before a public artifact is approved, record a real Apple-silicon release-candidate check below. Use an isolated test account or temporary home; do not install over live work.

| Date | Build digest | Finder + Open With name/icon | 16px / 32px / large / Dock | One Placekeeper bundle | Bundle-ID launch | Recovery + integrations | Result |
|---|---|---|---|---|---|---|---|
| Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

The check must confirm `Placekeeper` is visible, `/usr/bin/open -b local.placekeeper` resolves `Placekeeper.app`, recovery uses `Library/Application Support/Placekeeper`, `$placekeeper` launches, and `placekeeper.open` plus `placekeeper.launcherPath` work.

Manual downgrade after Placekeeper has been used to create or save new state is unsupported. Transaction rollback is guaranteed only before commit and before candidate document writes; this rebrand intentionally adds no backward reader. Public distribution under the Placekeeper name remains blocked until trademark, marketplace, and domain clearance is recorded, although the implementation may merge before that decision.

All upgrade acceptance uses temporary app-support roots and process groups. It records only aggregate outcome categories and build digests—never PDF paths, capabilities, task identifiers, bind proofs, credentials, or evidence handles—and does not address the user's real daemon.

The 2026-08-07 acceptance record predates the clean-break identity and no longer describes a supported installed artifact. A new Placekeeper-only release-candidate record is required before distribution.

## Integration evidence and remaining manual UI evidence

- Codex plugin and VS Code extension contract tests remain required because the artifacts ship in the app. Source automation proves hook discovery, task isolation, lifecycle transitions, prompt-safe output, and host parity without recording a capability URL.
- Manual installation and visual smoke tests for Codex desktop and VS Code desktop are still recommended for users who choose those integrations. This source-tree run does not claim that the current Codex desktop rendered or trusted the plugin; disabled or untrusted hooks are represented by the provider's explicit `unavailable` behavior.
- VS Code Remote SSH, containers, Codespaces, web, virtual, and non-file workspaces remain intentionally refused.

## Reading-first interface evidence

Automated release-candidate coverage exercises the same production review tree in an ordinary Chromium launch and a narrow 320-CSS-pixel `vscode` embed launch. The checks record one mounted viewer, one compact chrome, page `1 / 1`, unchanged page bounds and viewer mount identity through disclosure, preserved review state through breakpoint changes, visible workspace close controls, and deterministic focus restoration. The WebKit gate runs both the joined review workflow and installed-style production flow. The Codex lifecycle fixture exercises the private control socket rather than an installed Codex UI. Capability URLs, proofs, task IDs, and local paths are deliberately excluded from prompt-output assertions and this record.

The implementation was visually compared at 1280×900 and narrow widths with the plan-linked reading-first mockups. The resulting hierarchy keeps the PDF full-bleed within the content area, exposes the annotation workspace and Finish save flow only on request, uses a side peek for mark correspondence, and removes spatial transitions under reduced-motion preferences.

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

The committed visual suite captures only `[data-production-review]`, uses fixed 1280×900 and 320×720 scenes, and includes long deterministic titles, paths, messages, counts, focus, hover, loading, empty, success, warning, and error states. CI compares Linux goldens with the Playwright 1.61.1 managed Chromium build at device scale factor 1 on `ubuntu-24.04`; CI does not use an update flag. Matching macOS goldens remain committed for local Mac development.

Host status remains honest: the ordinary-browser installed-style production flow is automated and verifies one mounted viewer, local-only assets, real PDF rendering, responsive framing, and browser errors. Actual Codex desktop and VS Code desktop visual inspection was not performed in this source-tree run and remains pending below.

| Date | Build | Surface | Viewport width | Initial page / zoom / scroll | Open surface | Final page / zoom / scroll | Final focus | Screenshot or checklist |
|---|---|---|---:|---|---|---|---|---|
| Pending | Pending | Codex desktop | — | — | — | — | — | Pending |
| Pending | Pending | VS Code desktop | — | — | — | — | — | Pending |

## Optional future prebuilt release

If the project later distributes a prebuilt download, reinstate Developer ID signing, notarization, stapling, quarantine/Gatekeeper testing, and a clean Apple-silicon download smoke before calling that artifact easy to install. Do not claim those properties from the source-first build.
