---
title: Deterministic standards-derived mathematical symbol catalogs
date: 2026-08-23
category: architecture-patterns
module: PDF mathematical symbol search catalog
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "A hand-maintained domain dictionary cannot establish coverage, provenance, or update completeness"
  - "Standardized code-point relationships should broaden named lookup without changing exact literal matching"
  - "Ordinary builds and offline installs must consume frozen generated data without fetching or rewriting it"
  - "A full provenance audit is valuable for maintainers but too large to keep in version control or ship at runtime"
  - "Generated runtime data and update reports need deterministic drift checks and distribution size gates"
related_components:
  - "Mathematical Symbol Catalog"
  - "PDF Search"
  - "UnicodeData compiler"
  - "catalog maintainer update workflow"
  - "distribution validation"
  - "GitHub Actions artifacts"
tags:
  - "unicode-catalog"
  - "mathematical-symbols"
  - "deterministic-generation"
  - "semantic-families"
  - "exact-literal-search"
  - "pinned-snapshots"
  - "derived-audit"
  - "distribution-boundary"
---

# Deterministic standards-derived mathematical symbol catalogs

## Context

Placekeeper needed a systematic way to search mathematical glyphs extracted from PDFs without maintaining an ever-growing handwritten symbol dictionary. The implementation opened in [PR #55](https://github.com/brad-ross/placekeeper/pull/55) is pending rather than present on current `main`.

The catalog compiler uses pinned, checked-in Unicode 17 and W3C snapshots. The manifest records the exact Unicode version, W3C revision, local compressed files, source hashes, compressed hashes, URLs, and licenses (`scripts/pdf-symbol-catalog/source-manifest.json:1-45`). Generation reads those local files and rejects a compressed snapshot whose checksum differs from the manifest before compiling it (`scripts/pdf-symbol-catalog/generate.ts:265-288`). This makes ordinary generation deterministic and offline; network access is isolated to the explicit maintainer update command, which downloads each declared source and verifies its uncompressed hash (`scripts/pdf-symbol-catalog/update.ts:73-99`).

The important artifact boundary is asymmetric. The generator names three outputs—an exhaustive audit, a compact web runtime catalog, and a concise update report—but declares only the runtime catalog and report as committed artifacts (`scripts/pdf-symbol-catalog/generate.ts:17-24`). The exhaustive audit is ignored by Git (`.gitignore:12`). The checked-in report summarizes exhaustive collections by count, digest, and a five-item sample instead of embedding them wholesale (`scripts/pdf-symbol-catalog/generate.ts:56-79`, `scripts/pdf-symbol-catalog/generate.ts:335-389`). Its reviewed baseline is 3,060 records, a 400,389-byte runtime catalog, and a 7,181-byte report (`packaging/macos/validate-manifest.ts:13-30`).

The design evolved through three instructive failures (session history). Broad alias import attached `\varepsilon` to IPA U+025B rather than Greek U+03F5. Treating exhaustive evidence as the committed report produced roughly 343 KB and 15,000 lines of review noise. Finally, relying on an ignored prior audit as the update baseline made a fresh checkout classify every record as newly added. The final architecture addresses these as semantic-policy, artifact-retention, and baseline-reconstruction problems rather than adding more dictionary entries.

## Guidance

Treat standards snapshots, compilation logic, the compact runtime projection, the concise report, and the exhaustive audit as different layers with different retention needs.

### Pin authoritative inputs and compile offline

Keep exact source versions and hashes in the manifest, and require the local compressed bytes to match before parsing (`scripts/pdf-symbol-catalog/source-manifest.json:1-45`, `scripts/pdf-symbol-catalog/generate.ts:265-288`). Fetch only in the maintainer-only update workflow, verify downloads before publication, and stage all outputs before changing repository files (`scripts/pdf-symbol-catalog/update.ts:73-118`).

### Derive controlled semantic families

Do not substitute broad Unicode normalization or visual-confusable equivalence for a product relation policy. The compiler reads only singleton Unicode decompositions; multi-scalar decompositions do not become edges (`scripts/pdf-symbol-catalog/compile.ts:440-479`). It accepts canonical edges, a reviewed compatibility subset, and mathematical-alphanumeric `font` mappings whose targets are approved Greek scalars; every other decomposition is ignored (`scripts/pdf-symbol-catalog/compile.ts:482-510`). It then builds connected families from those accepted edges (`scripts/pdf-symbol-catalog/compile.ts:526-572`).

This is a deliberately narrow graph. It does not claim that visually similar characters or algebraically equivalent expressions are interchangeable.

### Expand generic aliases while keeping exact queries exact

A font-mapped source is deliberately excluded from the family's query members, while its semantic target is included (`scripts/pdf-symbol-catalog/compile.ts:543-548`). The runtime projection attaches family members only to those query members (`scripts/pdf-symbol-catalog/generate.ts:170-202`). A generic command attached to the semantic target can therefore find detected styled forms, but a command attached specifically to a styled scalar does not fan out through the family.

One-scalar user input never enters alias resolution (`apps/web/src/pdf/pdf-symbol-catalog.ts:87-99`); the search controller uses that literal scalar itself as the effective query (`apps/web/src/pdf/pdf-search-controller.ts:533-545`). Literal aliases are also forbidden in overrides because they could redirect code points (`scripts/pdf-symbol-catalog/compile.ts:869-890`).

### Ground expansion in the current PDF

Extracted text incrementally records catalog IDs by exact glyph (`apps/web/src/pdf/pdf-symbol-catalog.ts:101-115`). Alias resolution may expand a controlled family, but it filters the resulting IDs through `detectedRecordIds` before returning search terms (`apps/web/src/pdf/pdf-symbol-catalog.ts:123-147`). Suggestions and query expansion therefore remain grounded in the open document rather than exposing thousands of irrelevant catalog entries.

### Rebuild the old baseline before updating sources

Because the audit is intentionally untracked, an absent or stale local audit cannot define the semantic delta. The update command first compiles the currently pinned snapshot and writes that fresh audit into its staging tree, then downloads and compiles the candidate snapshot against it (`scripts/pdf-symbol-catalog/update.ts:30-63`, `scripts/pdf-symbol-catalog/update.ts:73-116`). Only after downloads, checksums, schema validation, compilation, and artifact construction succeed does atomic publication begin (`scripts/pdf-symbol-catalog/update.ts:118-169`).

### Separate drift checking from exhaustive evidence generation

`catalog:check` rebuilds everything in memory but compares only the committed runtime catalog and report (`scripts/pdf-symbol-catalog/generate.ts:432-448`). `catalog:audit` writes only the full audit (`scripts/pdf-symbol-catalog/generate.ts:421-430`, `package.json:15-18`). CI runs the non-mutating committed-artifact check first, generates the full audit second, and uploads it as a 14-day downloadable artifact (`.github/workflows/ci.yml:33-43`). Maintainers retain complete evidence without imposing its multi-megabyte churn on every clone and review.

### Keep generation out of install and ordinary build paths

The web prebuild runs `catalog:check`, not an updating command (`package.json:10-18`). Distribution validation enforces that `build`, `build:web`, `package:macos`, and `install:local` do not call `catalog:audit`, `catalog:generate`, or `catalog:update` (`packaging/macos/validate-manifest.ts:765-775`). It also rejects compiler sources, source snapshots, reports, and audits from shipped runtime assets (`packaging/macos/validate-manifest.ts:123-135`).

Install-time generation would add network and upstream-availability failure modes, make installed bytes depend on installation date, require shipping maintainer tooling and source data, and bypass review of the committed runtime projection.

## Why This Matters

The generated-data boundary preserves both auditability and repository usability. The compact catalog is the only behavior-bearing projection the app needs, and the concise report makes version, cardinality, hashes, exclusions, and equivalence changes reviewable (`scripts/pdf-symbol-catalog/generated/update-report.json:1-14`, `scripts/pdf-symbol-catalog/generated/update-report.json:145-152`). The exhaustive audit remains reproducible from the same pinned inputs and compiler (`scripts/pdf-symbol-catalog/generate.ts:291-321`) without becoming a source-control liability.

The search boundary protects mathematical meaning. Exact literals are not silently normalized, so compatibility characters can remain distinct when the user types the glyph itself (`apps/web/src/review/PdfSearchWorkspace.tsx:53-69`). Generic aliases can still bridge standards-defined base, variant, and styled forms when useful, but only for family members that the current document actually contains (`apps/web/src/pdf/pdf-symbol-catalog.ts:123-147`). Audited exceptions remain explicit: `\varepsilon` redirects the erroneous upstream IPA open-e mapping to Greek lunate epsilon while leaving the IPA scalar exact-only (`scripts/pdf-symbol-catalog/overrides.json:37`).

The update process prevents a subtle reporting failure identified during review (session history). If a missing ignored audit were interpreted as an empty old catalog, every update would appear to add every record. Recompiling the checked-in old inputs first creates a trustworthy comparison baseline regardless of a maintainer's local ignored files (`scripts/pdf-symbol-catalog/update.ts:46-63`).

## When to Apply

Use this pattern when a repository has large deterministic evidence that can be regenerated from small, pinned, reviewed inputs, while the product needs only a compact projection. It is especially appropriate when:

- standards data is versioned and hashable, and application behavior must not vary with live upstream data (`scripts/pdf-symbol-catalog/source-manifest.json:1-45`);
- a full audit is valuable for maintainers or CI investigation but unnecessary at runtime (`scripts/pdf-symbol-catalog/generate.ts:291-390`);
- committed generated output must be drift-checked during normal builds without mutating the worktree (`scripts/pdf-symbol-catalog/generate.ts:432-448`); or
- query equivalence must be narrower than global normalization and grounded in document-local evidence (`scripts/pdf-symbol-catalog/compile.ts:482-510`, `apps/web/src/pdf/pdf-symbol-catalog.ts:123-147`).

Do not apply the family mechanism to visual confusables, mathematical expressions that are merely algebraically equivalent, or arbitrary compatibility normalization. Also do not omit the exhaustive artifact when it is the only canonical input. This pattern works because the audit is derived from pinned snapshots, overrides, and deterministic compiler behavior (`scripts/pdf-symbol-catalog/generate.ts:265-321`).

## Examples

### Search variant epsilon safely

The override documents that W3C's `\varepsilon` binding points at U+025B LATIN SMALL LETTER OPEN E and redirects the command to U+03F5 GREEK LUNATE EPSILON SYMBOL, explicitly leaving the IPA character exact-only (`scripts/pdf-symbol-catalog/overrides.json:37`). A `\varepsilon` query resolves through the catalog alias and any controlled family attached to the Greek target, then retains only family records detected in the PDF (`apps/web/src/pdf/pdf-symbol-catalog.ts:123-147`). Typing `ϵ` or `ɛ` directly bypasses alias expansion and searches that one scalar (`apps/web/src/pdf/pdf-symbol-catalog.ts:87-99`, `apps/web/src/pdf/pdf-search-controller.ts:533-545`).

### Keep style-specific commands narrow

Suppose UnicodeData provides a `<font>` decomposition from a mathematical styled Greek scalar to its base Greek letter. The compiler admits that edge only inside the mathematical-alphanumeric block with an approved Greek target (`scripts/pdf-symbol-catalog/compile.ts:493-503`). It makes the base target query-expandable but does not make the styled source query-expandable solely because of that font edge (`scripts/pdf-symbol-catalog/compile.ts:543-548`). Thus a generic base-letter alias can search detected styled presentations, while a style-specific command remains attached to its own scalar through the runtime command index (`apps/web/src/pdf/pdf-symbol-catalog.ts:65-74`, `scripts/pdf-symbol-catalog/generate.ts:175-202`).

### Update pinned sources without committing the audit

Run the explicit maintainer update command with a candidate manifest. It compiles the old pinned inputs first, stages the resulting old audit, downloads and verifies the candidate inputs, compiles the new artifacts, and publishes the sources, manifest, local audit, runtime catalog, and report only after validation succeeds (`scripts/pdf-symbol-catalog/update.ts:30-63`, `scripts/pdf-symbol-catalog/update.ts:73-169`). Commit the updated source snapshots, manifest, compact runtime catalog, and concise report; leave `catalog.audit.json` ignored (`.gitignore:12`). Locally, `pnpm catalog:audit` recreates the full file, and CI recreates and uploads it independently (`package.json:15-18`, `.github/workflows/ci.yml:33-43`).

## Related

- [Issue #52: Symbol recognition improvements](https://github.com/brad-ross/placekeeper/issues/52) — the reported search failure that motivated the catalog.
- [PR #55: derive searchable math symbol catalog](https://github.com/brad-ross/placekeeper/pull/55) — the pending implementation documented here.
- [Exclude navigation links from existing PDF annotations](../integration-issues/exclude-navigation-links-from-existing-pdf-annotations.md) — a related abstraction-boundary example: a broad low-level catalog is projected into a narrower consumer-facing inventory.
