---
title: "Verify the public installer through publication and host setup"
date: "2026-09-14"
category: "workflow-issues"
module: "Public source installer and optional integrations"
problem_type: "workflow_issue"
component: "development_workflow"
severity: "medium"
applies_when: ["Shipping or changing the public source-release installer", "Deciding whether CI, publication, and optional host setup establish an installable release"]
tags: ["installer", "github-releases", "publication", "host-activation", "ci", "isolated-profiles"]
---

# Verify the public installer through publication and host setup

## Context

The landing-page installer work crossed three different delivery systems: GitHub Pages serves the short entry command, GitHub Releases holds the selected installer and source, and the installed Mac app carries optional host payloads. A successful PR or accessible landing page established only part of this chain. The repository had to be public for an unauthenticated visitor to fetch the release assets. Testing with the maintainer's authenticated GitHub tools could conceal that gap.

The investigation also exposed an evidence mismatch. Initially a full, manually completed Chrome installed-host matrix blocked source publication, even though Chrome was an optional integration and its browser activation could not be completed by unattended CI. The user chose to make Chrome experimental and separate its physical-host validation from publication of the core source installer. [PR #110](https://github.com/brad-ross/placekeeper/pull/110) implements that policy and is merged. This was a product-scope decision, not a claim that browser fixtures had proved real Chrome activation.

## Guidance

Treat the public installation path as a chain of separate claims. Verify each claim using the identity and access conditions its consumer actually has:

1. Prove the PR's exact head passed the intended CI workflow. The current general CI workflow is manual-only (`.github/workflows/ci.yml:3`); a push or a green subset of PR checks does not prove that workflow ran. Dispatch it on the intended branch and associate the resulting run with the current head before reporting success. Recheck after a corrective push.
2. Separate Pages deployment from release publication. Pages responds to main pushes (`.github/workflows/deploy-pages.yml:3`), whereas source publication requires an explicit version/notes dispatch (`.github/workflows/release-source.yml:3`). The landing command is defined in `scripts/package-source-release.ts:8`; its Pages entrypoint fetches the latest stable release bootstrap (`scripts/install-latest.sh:9`). Deployment can therefore succeed while the usable release is missing or older than the source tree.
3. Verify the exact public URLs without GitHub credentials. Downloading through authenticated `gh` proves maintainer access, not visitor access. Follow the complete redirect chain from the public Pages entrypoint through the release bootstrap to its pinned source archive. Do not substitute a local checkout or a direct known-good asset for this check. Source selection and checksum/descriptor verification live in `scripts/install-release.sh:10`, `scripts/install-release.sh:21`, and `scripts/install-release.sh:35`; they prove selected-asset consistency, not that the public URLs are reachable.
4. Run a fresh installation and a rerun in disposable destinations, then inspect the actual installed bundle. `install.sh:14` supplies separate user-home and installation-root overrides. Keep browser/editor profiles disposable too: changing the app destination alone does not isolate every host's profile. Record app installation, host payload preparation, host registration, and host activation separately.
5. Report pending host work as pending, even after a successful core installation. Chrome preparation returns pending and prints manual loading/activation steps (`packaging/macos/setup-chrome.mjs:199`). Codex verifies payload installation but still returns pending for trust and enablement (`packaging/macos/setup-integrations.mjs:103`). A healthy native registration, files on disk, or a CLI installation response does not establish that the host has loaded the new UI or granted its permissions.

Keep the experimental boundary explicit. Current source publication runs automated Chrome handoff checks plus an installed Mac smoke, and does not take a manual Chrome evidence input (`.github/workflows/release-source.yml:5`, `.github/workflows/release-source.yml:69`). This permits publishing the core installer without falsely presenting the optional integration as physically verified. Do not relax the real Chrome matrix when claiming that Chrome itself is supported or fully tested.

The earlier planning investigation also distinguished runtime compatibility from source-build prerequisites (session history). A macOS deployment target does not prove that the visitor has a usable compiler and SDK. The installer checks Swift and typechecks an AppKit probe before proceeding (`install.sh:51`, `install.sh:62`); avoid turning an unverified standalone Command Line Tools operating-system minimum into a promise.

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
