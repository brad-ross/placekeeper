---
title: Clean-break application identity migration
date: 2026-08-13
category: architecture-patterns
module: Application identity migration
problem_type: architecture_pattern
component: development_workflow
severity: high
applies_when:
  - A desktop application is renamed across runtime, packaging, integration, persistence, and release surfaces
  - The retired identity must be removed instead of preserved through aliases or compatibility migration
  - Repository-only search is insufficient because generated artifacts and installed state can retain the old identity
  - A reinstall must prove that the retired app, support data, and integration registration are no longer active
resolution_type: migration
related_components:
  - macOS application bundle
  - packaged service runtime
  - VS Code extension
  - Codex plugin
  - PDF annotation identity
  - release and installation workflow
tags:
  - application-identity
  - clean-break-migration
  - rebranding
  - compatibility-removal
  - artifact-verification
  - macos-packaging
  - integration-identity
  - clean-reinstall
---

# Clean-break application identity migration

## Context

A strict application rename is an identity migration, not a copy edit. Identity is repeated across the bundle manifest, runtime storage, launch commands, environment variables, transport identifiers, integrations, portable document metadata, release assets, tests, and operator documentation. If compatibility is explicitly forbidden, leaving any reader, alias, or legacy fixture behind creates two supported identities even when the visible interface shows only the new name.

Placekeeper therefore treats its name and machine-facing identifiers as one contract. The canonical manifest names the product and physical bundle `Placekeeper`, uses bundle ID `local.placekeeper`, executable `placekeeper`, runtime data directory `Library/Application Support/Placekeeper`, and Placekeeper icon resources (`packaging/macos/app-bundle.json:3-16`). Distribution validation rejects drift from these values (`packaging/macos/validate-manifest.ts:260-323`). The clean-break implementation is pending in [PR #31](https://github.com/brad-ross/placekeeper/pull/31), which was open and unmerged when this learning was written.

An earlier compatibility-first rebrand changed visible branding while retaining the former bundle, filesystem, command, plugin, and annotation identities. That preserved upgrades and state but did not satisfy a one-identity product. Repository-only cleanup also missed live machine state: an already loaded Codex hook could continue emitting the former context envelope after source and packaged-bundle scans were clean. Plugin removal cleared its enabled registration but left cache and trust records, and a guessed `doctor` shorthand initially looked like a writer failure until the exact supported invocation was used (session history).

## Guidance

### Inventory identity surfaces before editing

Create an identity ledger that covers at least:

- Human-facing names, browser titles, messages, documentation, icons, and screenshots.
- Package and platform identity: repository and package names, app bundle name, bundle ID, executables, document registrations, signing inputs, notarization profiles, and release artifacts.
- Runtime identity: application-support directories, sockets, lifecycle locks, recovery roots, environment variables, temporary-file prefixes, protocol tokens, media types, and serialized fields.
- Host integrations: editor extension names, commands, configuration namespaces, panel IDs, plugin metadata, skill names, hook commands, and context envelopes.
- Persistent document identity: annotation author, private metadata namespace, owner, and schema versions.
- Compatibility mechanisms: fallback readers, aliases, alternate paths, migration fixtures, upgrade tests, and documentation that still teaches the retired contract.

These are identity surfaces even when users never see them. Placekeeper's daemon variables use `PLACEKEEPER_*` (`apps/service/src/host/service-daemon.ts:30-34`), temporary export and save files use `.placekeeper-…` (`apps/service/src/export/export-coordinator.ts:108-110`, `apps/service/src/saving/pdf-save-coordinator.ts:319-321`), WebSocket negotiation requires `placekeeper` and a `placekeeper-auth.` credential (`apps/service/src/server/http-server.ts:469-480`), and rendered-page evidence uses `application/vnd.placekeeper.rgba+json` (`apps/service/src/pdf/inspect-pdf.ts:96-103`).

### Define one canonical identity contract

Put authoritative values in a small manifest or typed constants, then make validation reject drift. Do not let each subsystem independently choose spelling, casing, paths, or identifiers. Here, the bundle manifest is the distribution authority, and the validator hard-fails changes to the product, bundle, identifier, executable, runtime data root, or icon (`packaging/macos/validate-manifest.ts:260-323`). A focused contract test mutates each identity field and expects rejection (`packaging/macos/packaging.test.ts:154-168`).

Generate platform metadata from that contract. The macOS builder writes bundle name, identifier, executable, icon, document-handler metadata, and localized display-name metadata from the validated manifest (`packaging/macos/build-app.ts:158-204`). This prevents a complete-looking interface rename from shipping an old physical identity.

### Remove compatibility when the decision forbids it

Do not retain fallback reads, dual writes, old command aliases, alternate plugin skills, old-schema acceptance, or pre-migration fixtures “just in case.” Delete them and change tests from compatibility assertions to exclusivity assertions. A clean break has one accepted current form.

Portable annotations illustrate the difference. New annotations use author `Placekeeper`, owner `placekeeper`, and schema version 2 (`packages/core/src/portable-annotation.ts:10-12`, `packages/core/src/portable-annotation.ts:261-273`). Ingestion accepts the exact author and rejects an envelope whose schema or owner differs (`packages/core/src/portable-annotation.ts:257-292`). Tests prove that a lookalike author is rejected and that visible author text cannot claim an annotation without owned metadata (`packages/core/test/portable-annotation.test.ts:69-84`). This is stronger than merely preferring the new identity on write.

Apply the same rule to integrations. The VS Code extension uses package `placekeeper-vscode`, command `placekeeper.open`, configuration key `placekeeper.launcherPath`, and Placekeeper titles (`apps/vscode/package.json:2-30`). The distribution validator requires the canonical `placekeeper` Codex skill, exact plugin identity, and canonical installed launcher (`packaging/macos/validate-manifest.ts:334-450`). The live-context envelope is exactly `placekeeper-live-context` (`apps/service/src/cli/hook-command.ts:268-288`).

### Migrate all layers in one change set

Change runtime code, packaging, filesystem paths, environment variables, protocols, temporary and media identifiers, editor and agent integrations, annotation metadata, release and signing automation, documentation, tests, and fixtures together. Splitting these layers across releases creates intermediate builds that install under one identity while launching or persisting under another.

Release automation must consume the same identity as local packaging. The release workflow builds and smoke-tests `Placekeeper.app`, creates `Placekeeper-<arch>` archives, uses `PLACEKEEPER_NOTARY_PROFILE`, and uploads a Placekeeper-named artifact (`.github/workflows/release-macos.yml:42-61`). The source installer selects `~/Applications/Placekeeper.app`, builds that bundle, checks its `placekeeper` executable, smoke-tests it offline, and coordinates replacement through that executable (`install.sh:11-15`, `install.sh:108-131`).

### Verify absence as well as presence

Positive tests show that the new identity works; they do not show that the retired identity is gone. Add case-insensitive, separator-tolerant scans over tracked source and the packaged app. Search file contents, filenames, generated manifests, bundle contents, command registries, fixtures, and integration metadata. Under a strict clean break, the approved exception list should normally be empty.

Then run the normal validation ladder. This repository exposes typecheck, distribution validation, builds, full tests, macOS packaging, and installed smoke commands (`package.json:10-15`, `package.json:34-44`). The installed smoke invokes the packaged `placekeeper` executable in offline writer mode, testing the assembled bundle rather than only source modules (`packaging/macos/smoke-installed.ts:437-454`). Identity contract tests pin the app destination, environment namespace, state path, context kind, media type, temporary prefix, VS Code identifiers, and integration launcher (`packaging/macos/packaging.test.ts:171-214`).

Environmental failures need separate adjudication. During this migration, sandbox socket restrictions and a shell that lost the bundled Node runtime path initially blocked verification; neither represented a product regression. Re-run the exact contract under the required environment before changing code (session history).

### Treat machine cleanup as a separate operation

A correct repository migration does not remove an already installed retired app, its application-support data, or previously installed integrations. After code validation passes, inventory the machine separately, stop only relevant processes, and move stale bundles, state directories, plugin caches, and configuration records to a dated Trash or quarantine directory before installing the new app. Recoverable moves preserve drafts and make rollback possible.

Use the repository installer for the new app rather than manually copying build output. It builds in a private temporary directory, smoke-tests before replacement, and delegates to a transactional helper (`install.sh:53-66`, `install.sh:108-131`). The installer path stages the candidate, preserves the previous bundle, requires candidate readiness, and restores the previous app after a pre-commit failure when candidate retirement is safe; otherwise it preserves the transaction and installed candidate for recovery (`packaging/macos/install-built-app.sh:23-93`, `apps/service/src/cli/daemon-command.ts:230-245`). That protects Placekeeper-to-Placekeeper updates; it does not locate artifacts left by a differently named retired product.

Finally, restart hosts that load integrations into process memory. A clean filesystem cannot unload an already attached hook, extension, or daemon. The running Codex process in this migration required a restart to stop the legacy hook that had been loaded before the reinstall (session history).

## Why This Matters

Identity strings are coordination keys. A stale bundle ID affects application registration; a stale state path forks recovery; a stale executable or hook breaks launch; a stale protocol or media type breaks clients; and a compatibility annotation reader continues to claim data under a retired contract. Partial renames produce failures that look unrelated even though they share one cause: the system no longer agrees on who it is.

A canonical, validated contract turns identity drift into a build-time failure. Exclusivity tests and zero-reference scans catch the opposite error: code that still works only because an obsolete name remains quietly supported. Installed smoke testing closes the final gap for the assembled bundle and embedded Codex hook lifecycle; VS Code runtime validation remains a separate host check.

Separating repository migration from machine cleanup keeps the evidence clear. Source validation answers “does this version have one identity?” Machine inventory answers “is this computer still carrying artifacts from the retired product?” Mixing the questions encourages destructive cleanup during code work or false confidence after a clean build.

## When to Apply

- A product rename must also replace technical identifiers, storage, integrations, and persisted metadata.
- Legal, security, protocol, or product requirements explicitly prohibit compatibility aliases.
- An internal prototype becomes a differently named supported application.
- Multiple installed versions or plugin caches make it unclear which identity is active.
- Visible branding changed earlier but old identifiers remain in code, built artifacts, or machine state.

Do not apply the destructive half when compatibility is required. Instead, design an explicit versioned migration with bounded read-old/write-new behavior and a removal date. “Keep every old identifier forever” and “delete every old identifier immediately” are different contracts; choose one before editing.

## Examples

### Identity ledger

| Surface | Canonical Placekeeper value | Verification |
| --- | --- | --- |
| macOS bundle | `Placekeeper.app`, `local.placekeeper` | Manifest validator and built `Info.plist` |
| Launcher | `Contents/MacOS/placekeeper` | Package test and installed smoke |
| Mutable state | `~/Library/Application Support/Placekeeper` | Runtime source and isolated smoke home |
| Environment | `PLACEKEEPER_*` | Source scan and package contract test |
| Transport/evidence | `placekeeper`, `placekeeper-auth.`, `application/vnd.placekeeper.rgba+json` | Server and evidence tests |
| VS Code | `placekeeper-vscode`, `placekeeper.open`, `placekeeper.launcherPath` | Extension manifest and activation test |
| Codex | `$placekeeper`, installed hook command, `placekeeper-live-context` | Distribution validation and hook tests |
| PDF ownership | Author `Placekeeper`, `custom.placekeeper`, owner `placekeeper`, schema v2 | Codec tests and PDF round trip |
| Release | `Placekeeper-<arch>.zip`, `PLACEKEEPER_NOTARY_PROFILE` | Release workflow inspection |

### Zero-reference gate

Use a pattern that catches spaces, hyphens, underscores, and case variants, then scan both tracked files and packaged output:

```sh
git grep -Ini -E '<retired>[[:space:]_-]*<identity>|<retired-alias>'
rg -i '<retired>[ _-]*<identity>|<retired-alias>' '/path/to/Placekeeper.app'
```

Success is no output. Do not exclude tests or fixtures; they often preserve the last compatibility path.

### Verification ladder

```sh
pnpm typecheck
pnpm validate:distribution
pnpm test:ci:unit
pnpm build
pnpm test
pnpm package:macos
pnpm smoke:installed -- '<built>/Placekeeper.app' test/fixtures/pdfs/text-native.pdf
```

After these pass, use a separate machine checklist: inventory installed bundles and plugins, stop live processes, move retired artifacts to a dated recoverable location, install Placekeeper, verify bundle identity and signature, run the installed offline doctor or smoke path, restart integration hosts, and confirm only the new app and integrations are active.

## Related

- [Upgrade-safe shared per-user daemon lifecycle](upgrade-safe-shared-per-user-daemon-lifecycle.md) — transactional install, readiness, rollback, and installed smoke testing.
- [Recoverable editable PDF annotation autosave](recoverable-editable-pdf-annotation-autosave.md) — portable annotation identity as a persisted application contract.
- [Portable PDF annotations invisible in external viewers](../integration-issues/portable-pdf-annotations-invisible-in-external-viewers.md) — private ownership plus standards-visible artifact validation.
- [Task-scoped prompt-refreshed live PDF context](task-scoped-prompt-refreshed-live-pdf-context.md) — the skill, hook, and context-protocol surfaces included in the identity ledger.
- [Issue #28](https://github.com/brad-ross/placekeeper/issues/28) — historical compatibility-first rebrand requirements superseded by the clean-break decision.
- [PR #31](https://github.com/brad-ross/placekeeper/pull/31) — pending clean-break implementation and verification evidence.
