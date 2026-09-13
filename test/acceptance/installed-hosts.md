# Source install and host acceptance evidence

The required v1 distribution is a source-first Apple-silicon install for a personal/friends app. Developer ID signing, notarization, stapling, Intel/x64, DMG/PKG packaging, and auto-update are optional future distribution work rather than blockers.

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

## Installed VS Code LaTeX workflow release gate

Automated distribution checks prove that the app and extension carry identical integrity-pinned `app.js`, `app.css`, `pdfium.wasm`, and inline-worker declarations; missing, duplicated, externally hosted, stale, or unexpected assets fail validation. They also prove that the macOS bundle contains the executable `Contents/MacOS/placekeeper-vscode` wrapper and its bounded `vscode://placekeeper-local.placekeeper-vscode/placekeeper/external` route. These checks are scaffolding, not Electron webview evidence.

Before U8 is called complete, run the copied fixture in `test/fixtures/latex` and record both rows below. Do not record PDF/source paths, registration IDs, capabilities, review text, or credentials. A result is Pass only when the extension log and generated webview HTML contain none of that material and the network log has zero external requests.

| Date | Build | VS Code / LaTeX Workshop | Route | Direct boot + first page | Two rebuilds + same panel | Forward / reverse SyncTeX | Mixed + stale continuity | Distinct export | Hide/show + restart presentation | Zero iframe/browser/network | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-08-28 | U8 source candidate | 1.135.0 / 10.18.0 | Placekeeper commands with LaTeX Workshop retaining build authority | Pass: embedded first page rendered beside source | Pass: two `latexmk` rebuilds changed the PDF in one panel | Pass: forward returned `ok`; reverse opened the mapped source line | Pass in generation, stale-sidecar, and reconciliation automation | Pass in broker/export automation | Pending release-presentation move + restart repetition | Pass: direct webview, no iframe/browser launch, empty network log | Partial: functional source-PDF loop passes; release-presentation repetition remains |
| Pending | Pending | 1.95 / absent or incompatible | Supported Placekeeper-only fallback | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

For the current-host row, also move the panel, repeat view and SyncTeX, hide/show it, and reload VS Code. The restored serializer state may contain only the opaque panel key plus bounded page index and zoom. The service must rebind current semantic state; no session credential, source path, review text, or capability may be serialized. Exercise a partial candidate, source-save-without-successor, sidecar skew, ambiguous reconciliation, and export race; each must fail closed while protected work remains.

If the LaTeX Workshop probe fails, record that failure as the compatibility result and complete the same loop with **Placekeeper: View PDF** and **Placekeeper: Forward SyncTeX**. Do not mark the release blocked merely because the unsupported compatibility path is unavailable; do mark it blocked if the supported fallback fails.

## Chrome PDF handoff evidence

`pnpm test:chrome-handoff` is the deterministic gate. It uses a disposable persistent Chromium profile and a private loopback fixture; the profile directory is removed after the run. The fixture counts only named outcome categories. It does not retain request URLs, cookies, form bodies, local PDF paths, capabilities, or native-host messages. The focused unit portion proves exact-once stream consumption and drain-before-fallback, local-path reuse, origin and quota enforcement, temporary-source ownership and cleanup, remote save restrictions, Protected Recovery, and the absence of new Codex authority.

Playwright support for unpacked extensions does not guarantee that its managed Chromium exposes or can drive Google Chrome's public PDF MIME-handler integration. The acceptance spec detects the four required `chrome.mimeHandler` methods and reports an explicit skip when they are unavailable. A skip is expected infrastructure evidence, not a release pass. Claiming validated Chrome support still requires one fresh-profile check in the actual installed Google Chrome stable 151+ binary; do not use the everyday Chrome profile and do not install over active Placekeeper work.

| Date | App build identity | Chrome version | Extension ID | MIME API | Host manifest hash/path verified | Starts paused | Enabled same-tab + Back | Bypass + unavailable-host fallback | Authenticated one-use response | No Downloads copy / authority secret | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Pending | Pending | Pending | `cgegjjjhbhnfgcoipeffhogoojfoekgg` | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

### Installed embedded-review release gate

Install the release-candidate app first and explicitly select Chrome setup to prepare its persistent folder and native-host registration, then run `pnpm test:chrome-installed`. Mac-only installation no longer prepares Chrome.
The runner validates the distributable extension tree and exact user-level native
host manifest before launching Google Chrome with a newly created disposable
profile and remote-debugging endpoint. It never passes `--load-extension` and
never touches the everyday profile: the person performing the release check must
enable Developer Mode, select the exact packaged directory printed by the runner,
verify extension ID `cgegjjjhbhnfgcoipeffhogoojfoekgg`, and enable **Open PDFs
automatically** through the Placekeeper popup. The runner then records the
initially paused state and automates outer-tab URL retention, metadata title,
filename fallback, shared production-client mount, and browser Back.

The generated JSON is prerequisite evidence, not the whole release pass. Keep
the disposable window open and complete every row below before pressing Enter.
That first run deliberately exits nonzero while `manualMatrix` is `pending`; an
Enter keypress can never turn pending observations into a release pass. Record
the completed checks in a private JSON file and rerun with
`--manual-evidence <input.json>`. The file must bind the exact app build, Chrome
version, and extension runtime identity printed by the automated run; every
scenario key (`ae3PreActivationFallback` through `ae8ProtectedSuccessor`, plus
`ordinaryReview`, `updateSkew`, `hostileCanaries`, `keyboardAccessibility`, and
`crossSurfaceRegression`) must be `true`. Its `ktd8` object must record corpus
`chrome-native-v1`, 5 cold and 10 warm runs per fixture, both local and
authenticated-remote dispositions, passing latency/memory/responsiveness
assessments, measured `cancellationReleaseMs` no greater than 2000, and one
`measurements` entry per fixture/disposition. Each entry records redirect p50,
native p50/p95, and peak extension/native-host/service/aggregate RSS; the runner
recomputes the committed relative latency formula. A stale,
partial, or over-budget record fails closed.
Record only the build identity, Chrome and extension versions, literal native-host
manifest path and SHA-256, aggregate timings/memory, and pass/fail results. Never
record a PDF URL or path, cookie, capability, task identifier, presentation lease,
credential, command payload, source locator, annotation text, or PDF bytes.

| Scenario | Required installed evidence | Result |
|---|---|---|
| AE1 metadata title | Original authenticated PDF URL remains in the omnibox; the outer tab title becomes `Quarterly Results`; full Placekeeper UI is usable. | Pending |
| AE2 filename title | Blank-title PDF uses its decoded, sanitized filename; title remains stable through Placekeeper navigation. | Pending |
| AE3 pre-activation fallback | With native registration temporarily moved aside, one new PDF falls back to Chrome exactly once; restoring the manifest does not leave claimable transfer state. | Pending |
| AE4 active disconnect | Stop the service after a clean activation: PDF remains visible/read-only with keyboard-operable **Reopen PDF** and no Chrome fallback. Repeat after an accepted annotation or save and verify protected recovery survives restart. | Pending |
| AE5 canonical presentations | Reload, duplicate, restore the browser session, and open the same PDF in a fresh tab. Identical source plus digest shares mutations; each tab keeps an independent viewport and remains usable when another closes. | Pending |
| AE6 navigation | Make several Placekeeper page/location jumps. Placekeeper Back/Forward traverses them without changing the omnibox; Chrome Back returns to the fixture landing page. | Pending |
| AE7 native link surface | The Chrome top bar omits the document-level **Copy Link** because the PDF URL remains in the omnibox. A precise item-level **Copy Link** contains no source URL, task/bind data, credential, or presentation identity; opening it through Finder or Codex produces an ordinary unbound Placekeeper view. | Pending |
| AE8 protected successor | Replace/restart the service after protected work. **Reopen PDF** presents resume/discard/fork; choose each against a fresh seeded case and verify exactly one idempotent outcome. | Pending |
| Ordinary review | Search, create/edit/delete an annotation, reconcile a Review Item, save a copy, and export. Inject one service rejection and one disconnect during mutation. | Pending |
| Update skew | Exercise older extension/new host and new extension/older host. Before activation: cleanup plus one Chrome fallback. After activation: read-only update-required state, retained protected work, no fallback. | Pending |
| Hostile canaries | Seed canaries in query/fragment, local path, filename/title, locator, credential, command payload, and PDF bytes. Chrome UI, links, logs, diagnostics, crash output, and recovery artifacts contain only role-authorized fields. | Pending |
| Keyboard/accessibility | Complete loading, fallback, disconnect, update, reconnect, reopen, and resume/discard/fork without a pointer; verify visible focus, live announcements, transition focus, and accessible labels. | Pending |
| Cross-surface regression | Finder Open With, app picker, canonical link, Codex in-app browser, and VS Code embedded review retain their existing behavior. | Pending |

Do not move the real native-host manifest while any non-disposable Placekeeper
review is active. Copy it to a private temporary directory, move only the exact
`com.placekeeper.chrome.json` file for AE3, and restore it immediately after that
case. Removing or reinstalling registration must not remove Protected Recovery or
the disposable source. Upgrade/rollback transaction suites remain deterministic
prerequisites; this installed check confirms presentation behavior.

The versioned KTD8 contract is `chrome-performance-budget.json`. Run every listed
local and authenticated-remote disposition five cold and ten warm times. Record
p50 and p95 navigation-to-first-page latency, peak extension/native-host/service
and aggregate RSS, visible progress responsiveness, and cancellation cleanup.
Cancellation must release within two seconds. Compare native p50 with the matching
redirect baseline using the committed formula; a missing baseline or failed budget
blocks release and must not be converted into a wider host permission.

| Date | Build / Chrome | Corpus + repetitions | p50 / p95 latency | Peak extension / native / service / aggregate | Cancellation | Redirect comparison | Result |
|---|---|---|---|---|---|---|---|
| Pending | Pending | `chrome-native-v1`; 5 cold + 10 warm per local/remote fixture | Pending | Pending | Pending | Pending | Pending |

The installed runner now injects a non-authorizing observer into the actual
packaged PDFium worker and records worker startup, PDFium readiness, packaged
asset access, and forbidden privilege results in the automated evidence. The
earlier Chrome 152 proof established the same boundary and showed that
handler-local reload identity is unavailable, which is why canonical review
identity is service-owned. The temporary proof page and successful-path
localhost redirect are not part of the release extension.

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

## Release install-flow verification (2026-09-13)

Source publication remains a separate maintainer action. Source releases require automated installer, packaging, lifecycle, and installed-app smoke checks. The optional Chrome integration is experimental until the independent exact-build Chrome validation and physical matrices above pass; that report does not block publishing the Mac source installer. Earlier checked source-install observations do not establish that this new candidate passed Finder, Chrome enablement, or desktop host UI checks.

For the new flow, use disposable host profiles and a temporary installation root. Install Mac plus Chrome while skipping VS Code and Codex; confirm loading/enablement is pending until performed in Chrome. Rerun with the app current and select the skipped integrations. Confirm the supported VS Code installer recognizes the VSIX, reload the editor, and inspect its review. Confirm the local Codex marketplace resolves from the installed app after temporary source deletion; complete trust/enablement and start a new task. Preserve Chrome's previous on/off choice. Exercise one optional-host failure and confirm later hosts are offered and Mac success is retained. Finally, keep PDFs and a task binding active while requesting an update and selected host repair: both must defer without losing review or recovery state.

These physical UI observations remain pending until recorded against the candidate. Fixture tests establish setup control flow and transaction safety; they cannot establish host approval, enablement, or Finder rendering.

### Source release and experimental Chrome status

The short installer publishes the Mac app with independently skippable integrations. Chrome setup is explicitly experimental. Continue running the deterministic Chrome handoff tests in source-release CI, but collect the installed Chrome report separately with `pnpm test:chrome-installed` and validate it with `test/acceptance/validate-installed-chrome-evidence.ts`. A missing report must not be described as passing Chrome validation. The optional signed/prebuilt release workflow retains its existing stricter gate.
