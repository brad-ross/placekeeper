---
title: Refresh independently installed VS Code payloads after app installation
date: 2026-09-10
last_updated: 2026-09-10
category: integration-issues
module: Application installation and VS Code integration
problem_type: integration_issue
component: development_workflow
severity: medium
symptoms:
  - "VS Code showed an older review interface after the native application was updated."
  - "Installed and bundled extensions reported the same version despite different UI payloads."
root_cause: missing_workflow_step
resolution_type: code_fix
tags: [vscode, installation, asset-freshness, same-version, smoke-isolation]
---

# Refresh independently installed VS Code payloads after app installation

## Problem

A current Placekeeper app did not imply a current VS Code interface. During the PR #92 investigation, both installations reported extension version `0.1.1`, yet the installed VS Code consumer still carried a schema-2 web manifest while the app carried schema 3. The important diagnostic was disagreement between installed payloads, not the nominal version. Source installations can replace assets without a release-version bump.

## Symptoms

VS Code continued to show the old interface after the app had been updated. Comparing the app's bundled integration against VS Code's installed extension exposed the stale copy. This distinction matters because the extension packages its own shared-web assets: the copy stage reads the root production output and writes the extension's `dist/web` (`apps/vscode/copy-web-assets.mjs`). Updating the app does not itself replace the copy registered with VS Code.

## What Didn't Work

Matching `0.1.1` version strings did not establish freshness. The installed payload comparison contradicted that inference. Likewise, a valid manifest and matching integrity hashes only establish that a particular asset set is internally consistent; an older complete set can still pass its own integrity checks.

## Solution

The source installer now runs an extension updater after successful app-install coordination (`install.sh`, `install.sh`). It executes even when coordination decides the app is already current, allowing an installer retry to repair an independently stale extension. The updater checks whether Placekeeper is already registered with VS Code, builds a temporary VSIX from the installed app's bundled integration, and uses the editor's CLI with `--install-extension ... --force` (`packaging/macos/update-vscode.mjs`). It preserves opt-in by skipping an absent extension.

The standalone extension build also rebuilds shared web output before bundling (`apps/vscode/package.json`). This closes the upstream case where copying a coherent but outdated root build would produce a newly built extension with yesterday's UI.

The updater belongs outside the app replacement helper. That helper is also used by isolated installed-app smoke and rollback workflows; putting editor-profile mutation there would let an isolated app operation change the user's real VS Code installation (`install.sh`, `install.sh`).

## Why This Works

There are two freshness boundaries: producing the extension's assets and installing them into the editor's registered copy. Both must be crossed. `--force` handles equal-version source builds through VS Code's installer instead of direct directory replacement, preserving the editor's registration machinery (`packaging/macos/update-vscode.mjs`). The session verified a same-version CLI installation and then compared the installed distribution against the intended payload; the repair was therefore checked beyond mocked command invocation. A VS Code window reload is still required to load the refreshed interface (`packaging/macos/update-vscode.mjs`).

The PR #92 implementation is present in the current tree. Installed-consumer freshness still requires inspecting the actual registered extension payload.

## Prevention

For an interface that differs across hosts, inspect the actual registered consumer's manifest and asset payload before changing UI code or trusting a version label. Trace the full source-to-root-build-to-extension-bundle-to-installed-extension chain. Verify both build freshness and installed payload equality after repair. Keep user-profile integration updates at the outer installation boundary so retries can repair drift without coupling isolated app replacement tests to the user's editor.

## Related Issues

- [PR #92](https://github.com/brad-ross/placekeeper/pull/92)
- [Shared production review client with host-specific runtime boundaries](../architecture-patterns/shared-production-review-client-host-runtime-boundaries.md)
- [Upgrade-safe shared per-user daemon lifecycle](../architecture-patterns/upgrade-safe-shared-per-user-daemon-lifecycle.md)
