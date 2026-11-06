---
title: "Verify the public installer through publication and host setup"
date: "2026-09-14"
last_updated: 2026-11-06
category: "workflow-issues"
module: "Public source installer and optional integrations"
problem_type: "workflow_issue"
component: "development_workflow"
severity: "medium"
applies_when: ["Shipping or changing the public source-release installer", "Deciding whether CI, publication, and optional host setup establish an installable release", "Qualifying a native extension after rebuilding, restarting, or changing source routes"]
tags: ["installer", "github-releases", "publication", "host-activation", "ci", "isolated-profiles"]
---

# Verify the public installer through publication and host setup

## Context

The landing-page installer work crossed three different delivery systems: GitHub Pages serves the short entry command, GitHub Releases holds the selected installer and source, and the installed Mac app carries optional host payloads. A successful PR or accessible landing page established only part of this chain. The repository had to be public for an unauthenticated visitor to fetch the release assets. Testing with the maintainer's authenticated GitHub tools could conceal that gap.

The investigation also exposed an evidence mismatch. Initially a full, manually completed Chrome installed-host matrix blocked source publication, even though Chrome was an optional integration and its browser activation could not be completed by unattended CI. The user chose to make Chrome experimental and separate its physical-host validation from publication of the core source installer. [PR #110](https://github.com/brad-ross/placekeeper/pull/110) implements that policy and is merged. This was a product-scope decision, not a claim that browser fixtures had proved real Chrome activation.

## Guidance

Treat the public installation path as a chain of separate claims. Verify each claim using the identity and access conditions its consumer actually has:

1. Prove the PR's exact head passed the intended CI workflow. The current general CI workflow is manual-only (`.github/workflows/ci.yml:3`); a push or a green subset of PR checks does not prove that workflow ran. Dispatch it on the intended branch and associate the resulting run with the current head before reporting success. Recheck after a corrective push.
2. Separate Pages deployment from release publication. Pages responds to main pushes (`.github/workflows/deploy-pages.yml:3`), whereas the complete desktop candidate is assembled with its source fallback by `.github/workflows/build-desktop.yml:177` and published separately after exact-run provenance checks by `.github/workflows/publish-desktop.yml:65`. The version/notes dispatch in `release-source.yml` validates and retains source artifacts; it does not publish a release. The landing command is defined in `scripts/package-source-release.ts:8`; its Pages entrypoint fetches the latest stable release bootstrap (`scripts/install-latest.sh:9`). Deployment can therefore succeed while the usable release is missing or older than the source tree.
3. Verify the exact public URLs without GitHub credentials. Downloading through authenticated `gh` proves maintainer access, not visitor access. Follow the complete redirect chain from the public Pages entrypoint through the release bootstrap to its pinned source archive. Do not substitute a local checkout or a direct known-good asset for this check. Source selection and checksum/descriptor verification live in `scripts/install-release.sh:10`, `scripts/install-release.sh:21`, and `scripts/install-release.sh:35`; they prove selected-asset consistency, not that the public URLs are reachable.
4. Run a fresh installation and a rerun in disposable destinations, then inspect the actual installed bundle. `packaging/desktop/source-install.mjs` reads the separate `PLACEKEEPER_USER_HOME` and `PLACEKEEPER_INSTALL_ROOT` overrides. Keep browser/editor profiles disposable too: changing the app destination alone does not isolate every host's profile. Record app installation, host payload preparation, host registration, and host activation separately.
5. Report pending host work as pending, even after a successful core installation. Chrome preparation returns pending and prints manual loading/activation steps (`packaging/macos/setup-chrome.mjs:199`). Codex verifies payload installation but still returns pending for trust and enablement (`packaging/macos/setup-integrations.mjs:114`). A healthy native registration, files on disk, or a CLI installation response does not establish that the host has loaded the new UI or granted its permissions.

Keep the experimental boundary explicit. The source-fallback validation workflow builds the Electron desktop package and runs automated Chrome handoff, upgrade-lifecycle, and installed-desktop checks on its macOS runner; it does not take a manual Chrome evidence input or publish a release (`.github/workflows/release-source.yml:59`). Complete-candidate publication is a separate workflow. These automated checks do not establish physical verification of the optional integration. Do not relax the real Chrome matrix when claiming that Chrome itself is supported or fully tested.

The earlier planning investigation also distinguished runtime compatibility from source-build prerequisites (session history). A deployment target does not establish that a visitor has the required build tools. The current cross-platform source installer requires Node.js 24 or newer and a native C compiler; Windows builds require the Visual Studio developer environment, and Linux user-local installation verifies unprivileged user namespaces (`packaging/desktop/source-install.mjs`). The former Swift/AppKit prerequisite probe is retired.

### Separate the installed Codex payload from the process using it

Treat the app's bundled marketplace, Codex's installed plugin, discovered tools and hooks, and running host/MCP processes as separate evidence. Updating one layer does not prove that the next consumed it. During historical native qualification, a direct MCP handshake worked while the exact packaged invocation failed because a plugin-root placeholder was passed literally to a shell (session history). Current portable registration materializes `.mcp.json` with the selected installation's absolute launcher and `codex-mcp` argument; hooks are separate shell commands with platform-specific quoting (`packaging/desktop/integration-registration.ts`). Qualification must execute the registered entrypoint rather than an easier source-tree equivalent.

The installer first probes every required supported CLI interface, verifies that the marketplace name refers to the expected local source, and preserves an existing plugin whose enablement is false or unknown. It then installs through the supported CLI and compares the reported installed version with the bundled manifest. A mismatch remains pending, and even a match remains pending actual discovery, trust, enablement, and reload (`packaging/macos/setup-integrations.mjs:81`, `packaging/macos/setup-integrations.mjs:99`, `packaging/macos/setup-integrations.mjs:110`). The stale-version and disabled-plugin regressions protect those distinctions (`packaging/macos/setup-integrations.test.mjs:90`, `packaging/macos/setup-integrations.test.mjs:134`). Do not borrow the VS Code updater's flags or infer an undocumented Codex refresh command.

After refresh, follow the supported full quit/restart and fresh-task flow, then check current skill/tool discovery and trusted hook delivery. Reopening an old card or finding new files on disk is not this proof. The installer prints that sequence rather than reporting activation as completed (`packaging/macos/setup-integrations.mjs:64`).

For evidence, record candidate and installed artifact identity, the observed running executable and process start times, host version/build, and observation time. State how each was obtained. A running executable path plus on-disk bundle metadata is weaker than an in-memory executable hash; do not relabel it. The dated [native qualification closeout](../../testing/codex-native-u8-qualification.md) preserves the earlier stale-MCP failure, the later scoped resolution, and the limits of the running-build evidence. Keep inherited results tied to their original build and unchanged-boundary rationale instead of rewriting them as fresh observations.

### Prove the mounted extension artifact, not just the installed bytes

The extension qualification found a stronger stale-artifact case than an old process: installed HTML hashes matched the new build, MCP processes had restarted from those files, and the user reopened through the file menu, yet direct panel inspection still found the old inline script. A fresh process and successful reopen were therefore insufficient evidence of uptake. The dated [extension qualification record](../../testing/chatgpt-extension-qualification.md) retains the failed observation and subsequent loaded-code confirmation; do not replace that evidence with a general instruction to restart again.

The server now derives the advertised HTML resource URI from the shell bytes and uses it consistently in opening-tool metadata and the resource catalogue. The fixed URI is accepted only as a compatibility read alias (`apps/codex-mcp/src/server.ts:66`). Qualification should record both packaged identity and what the mounted panel actually loaded. This is why a content-derived resource address belongs to the cache boundary, while a build timestamp or on-disk hash alone does not settle that boundary.

### Qualify the boundary that the evidence actually exercised

A fixture may use the real broker, PDF writer, and production reader while still controlling the trusted launch and display events itself. That establishes composed implementation behavior, not genuine Codex hook delivery, private invocation routing, trust, or process lifecycle. The retired AppKit installed smoke explicitly selected a synthetic launcher hook; validating its native display declaration did not exercise that declaration. Current packaged desktop checks likewise need their exercised boundary stated explicitly (`test/acceptance/electron-installed.spec.ts`, `test/acceptance/electron-launcher.spec.ts`).

The qualification verifier requires actual-host evidence for the transport gate and distinguishes automated cross-host regressions from actual-host product checks in the parity report (`scripts/qualify-codex-native.ts:22`, `scripts/qualify-codex-native.ts:63`). Its success message still requires human review: valid report shape cannot establish that the described event occurred (`scripts/qualify-codex-native.ts:111`). See the [native qualification procedure](../../testing/codex-native.md) for the operator matrix.

An actual native panel can still exercise the wrong persistence route. In the extension session, ordinary file-menu activation supplied trusted local-path metadata and used local persistence; it did not establish opaque host reads, conditional writes, or conflict handling. The isolated opaque candidate removes optional entrypoint metadata while retaining the real resource arguments and production entrypoint implementation (`scripts/extension-candidate/opaque-extension-server.ts:6`). Its packaging records the route and wrapper digest alongside bundle identity (`scripts/extension-candidate/package.ts:66`). Use the [candidate procedure](../../../scripts/extension-candidate/README.md) and record route-specific outcomes rather than transferring a local-file save pass to the opaque path.

Keep lifecycle checkpoints independent too. During qualification, `registerTool` was present while `unregisterTool` was absent; requiring both had hidden working registration support. The current bridge records actual registration progress and disables retained callbacks on disposal even if unregister is missing or throws (`apps/codex-mcp/src/live-reader-tools.ts:45`, `apps/codex-mcp/src/live-reader-tools.ts:78`). API presence, successful registration, callable current-reader actions, and cleanup are separate claims.

Likewise, a disappeared panel did not prove released review ownership: historical host logs showed teardown requests cancelled after the host removed the app route. The current shell attempts release on teardown and non-persisted pagehide (`apps/codex-mcp/src/extension-shell.ts:54`, `apps/codex-mcp/src/extension-shell.ts:792`), but the native result must still be observed at the service/recovery boundary. The qualification record contains a historical explicit Close control that has since been removed; its result must not become a current operator instruction or a claim about every close path. Scope each pass to the mounted artifact, source route, and lifecycle checkpoint actually observed.

Retain failed observations and later scoped resolutions together. If a requirement is deferred, preserve its gate and report the narrower completed result. The October 6 functional closeout leaves full parity unqualified because performance and OS-memory evidence were explicitly deferred; functional checks and resource cleanup counts do not substitute for those measurements ([qualification closeout](../../testing/codex-native-u8-qualification.md)).

## Why This Matters

The final scripts show how an asset is selected and installed, but they do not preserve why a green local run, public landing page, or prepared host directory was insufficient evidence. Losing that distinction would encourage two recurring mistakes: announcing a working public install based on authenticated checks, and announcing working integrations based only on prepared files.

The alternative mistake is to gate the whole product on manual evidence for an explicitly optional experimental feature. Correcting that requires an explicit scope decision and truthful pending states, not manufacturing a passing report or relabeling a skipped physical check as success. The release gate and user-facing maturity label must agree.

## When to Apply

Use this reasoning when publishing the first release, changing repository visibility or asset hosting, adding a short installation entrypoint, repairing a release after users report failures, or changing optional-integration maturity. It also applies when general CI is manually dispatched or an installed interface appears older than the app bundle. Use the existing installation guide for operator commands and the separate installed-payload freshness learning for VS Code internals; this learning records what those checks do and do not prove.

## Examples and Verified Outcome

The session's isolated public install and rerun of [v0.1.1](https://github.com/brad-ross/placekeeper/releases/tag/v0.1.1) exited successfully and the installed bundle reported 0.1.1. A real VS Code CLI confirmed the extension in a temporary profile. Chrome preparation and native registration were verified in a disposable home, while Chrome UI activation and Codex GUI trust/enablement were not performed. Those limits are part of the result, not unfinished core-install failures. The temporary local logs supported this result but are not durable dependencies of this learning.

[PR #113](https://github.com/brad-ross/placekeeper/pull/113), merged as of 2026-09-14, made pending Chrome and Codex actions numbered and concrete: the folder to load, the activation control, and the distinction between manually installing a missing Codex payload and enabling one already installed. Its merge alone does not change an existing immutable release asset; the wording reaches public installers through a subsequent release.

### Keep release instructions aligned with the maturity decision

The grounding pass found that the installation guide and original release plan still required a manual Chrome evidence input after PR #110 removed it. Both documents were corrected on 2026-09-14 to distinguish automated source-publication gates from independent experimental Chrome validation. The guide now points to the canonical version manifest rather than hardcoding a current version. When changing a release gate, review the operator guide and plan's verification table together; updating only the workflow leaves a plausible but unusable procedure behind.

## Related learnings

- [Refresh real app surface screenshots](refresh-real-app-surface-screenshots.md) for clean host profiles and capture staging.
- [Refresh the independent VS Code payload](../integration-issues/refresh-independent-vscode-payload-after-app-install.md) for app-versus-extension freshness.
- [Diagnose unbound agent context](../integration-issues/diagnose-open-pdf-with-unbound-agent-context.md) for the distinction between opening a PDF and verifying task binding.
