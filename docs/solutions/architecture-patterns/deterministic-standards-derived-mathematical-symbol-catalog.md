---
title: Deterministic standards-derived mathematical symbol catalogs
date: 2026-08-23
last_updated: 2026-09-10
category: architecture-patterns
module: PDF mathematical symbol search catalog
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "A hand-maintained domain dictionary cannot establish coverage, provenance, or update completeness"
  - "Authoritative record metadata should drive both searchable repertoire and deterministic presentation priority"
  - "Reviewer-visible ordering must improve without changing record identity, exact matching, or semantic expansion"
  - "A full provenance audit is useful to maintainers but too large to commit or ship at runtime"
  - "Generated runtime data and concise reports need deterministic drift checks and distribution size gates"
related_components:
  - "Mathematical Symbol Catalog"
  - "PDF Search"
  - "Controlled Symbol Family"
  - "symbol suggestion ranking"
  - "UnicodeData compiler"
  - "catalog maintainer update workflow"
  - "distribution validation"
  - "GitHub Actions artifacts"
tags:
  - "unicode-catalog"
  - "mathematical-symbols"
  - "standards-derived-ranking"
  - "deterministic-generation"
  - "presentation-projection"
  - "stable-record-identity"
  - "derived-audit"
  - "distribution-boundary"
---

# Deterministic standards-derived mathematical symbol catalogs

## Context

Placekeeper's mathematical-symbol search cannot be made comprehensive or maintainable by extending a handwritten dictionary one glyph at a time. The durable boundary is to treat Unicode and W3C data as authoritative inputs, compile a product-specific repertoire and presentation projection, and reserve handwritten overrides for reviewed semantic exceptions. The catalog implementation landed in [PR #55](https://github.com/brad-ross/placekeeper/pull/55); its standards-derived suggestion-ranking extension from [PR #58](https://github.com/brad-ross/placekeeper/pull/58) is also present in the current tree.

The source manifest pins Unicode 17.0.0 and an exact W3C `xml-entities` revision, with local compressed snapshot paths plus compressed and uncompressed SHA-256 values (`scripts/pdf-symbol-catalog/source-manifest.json`). Ordinary artifact generation reads those local snapshots, verifies each compressed checksum, and then decompresses them, so a normal build does not depend on the network or on whatever upstream publishes that day (`scripts/pdf-symbol-catalog/generate.ts`).

The compiler admits assigned, named scalars from systematic mathematical evidence: Unicode's Math property and W3C math class, application markers, direct TeX commands, or corroborating math/mixed mode (`scripts/pdf-symbol-catalog/compile.ts`). The current generated report records 3,060 admitted symbols and the provenance counts behind that repertoire (`scripts/pdf-symbol-catalog/generated/update-report.json`).

Several failed approaches define the architecture's boundaries (session history). A hand-maintained ordinary-symbol dictionary offered no credible exhaustiveness story. Treating upstream aliases as unquestioned truth exposed collisions and the `\varepsilon` mapping to IPA open e. Committing the exhaustive audit added roughly 5 MB of deterministic review noise. Validating a previously built web bundle could also give stale packaging evidence after catalog changes. The final design treats these as separate coverage, exception-policy, artifact-retention, and validation concerns rather than adding more handwritten entries.

## Guidance

### Keep standards snapshots and the compiler as the ordinary-symbol source of truth

Pin source versions, URLs, licenses, and hashes in the repository manifest, and make the compiler validate source shape and provenance before emitting a catalog (`scripts/pdf-symbol-catalog/source-manifest.json`, `scripts/pdf-symbol-catalog/compile.ts`). Do not add an ordinary per-code-point symbol dictionary beside this pipeline. When a new standards version is adopted, update the pinned inputs and regenerate the projections; when product semantics intentionally differ from upstream, use the narrow audited override mechanism.

The exception file is not a second catalog. Its entries must identify a command, entity, or natural-language alias; literal aliases are forbidden, and every entry must include rationale and upstream documentation (`scripts/pdf-symbol-catalog/compile.ts`). Overrides also fail compilation if they name unadmitted scalars or if the upstream mapping no longer matches the recorded expectation (`scripts/pdf-symbol-catalog/compile.ts`). This makes exceptional policy visible and self-invalidating when standards data changes. For example, the `\varepsilon` exception redirects W3C's IPA open-e mapping to Greek lunate epsilon and explicitly leaves the IPA scalar exact-only (`scripts/pdf-symbol-catalog/overrides.json`).

### Derive equivalence narrowly; preserve literal identity

Only singleton Unicode decompositions are candidates for equivalence; multi-scalar decompositions are not compiled into edges (`scripts/pdf-symbol-catalog/compile.ts`). The accepted graph is deliberately limited to canonical mappings, a checked compatibility set, and mathematical-alphanumeric font mappings whose targets are approved Greek scalars (`scripts/pdf-symbol-catalog/compile.ts`). Font-source scalars are family members but are not made generic query members solely by their style mapping, so a base command can find a detected styled form without making a style-specific command fan out indiscriminately (`scripts/pdf-symbol-catalog/compile.ts`).

At runtime, one-scalar input bypasses the alias indexes, while command, entity, and natural-name lookup remains namespace-aware (`apps/web/src/pdf/pdf-symbol-catalog.ts`). Family-expanded aliases are filtered against the record IDs actually detected in the open PDF (`apps/web/src/pdf/pdf-symbol-catalog.ts`). This keeps exact glyph search exact and prevents a comprehensive global catalog from flooding a document with symbols that are not present.

### Compile search-likelihood ranking as a projection, not as identity

Suggestion ranking belongs in generated runtime metadata, not in the source record model or a handwritten priority table. The pure classifier uses Unicode General Category and W3C `type`/`mathClass` in a fixed precedence to assign five ranks: identifier-like, number-like, operator/relation, delimiter/diacritic, and punctuation/format (`scripts/pdf-symbol-catalog/generate.ts`). The generator appends that small ordinal to each runtime tuple while leaving tuples in compiler code-point order (`scripts/pdf-symbol-catalog/generate.ts`, `scripts/pdf-symbol-catalog/compile.ts`).

Sort only the reviewer-facing detected-symbol projection by rank and then code point (`apps/web/src/pdf/pdf-symbol-catalog.ts`). The runtime record ID remains the tuple index, and alias resolution retains its record-ID ordering and does not consult suggestion rank (`apps/web/src/pdf/pdf-symbol-catalog.ts`). Search Results separately remain ordered by page, character, and matched form (`apps/web/src/pdf/pdf-search-controller.ts`).

This single projection point supplies both the full current-PDF catalog and the no-match alternatives; alternatives are filtered before the existing eight-item cap (`apps/web/src/pdf/pdf-search-controller.ts`). UI filtering uses order-preserving `Array.filter`, so filtered lists inherit the compiled order without maintaining another ranking implementation (`apps/web/src/review/PdfSearchWorkspace.tsx`). The report records the full rank distribution—1,298 identifier-like, 88 number-like, 1,437 operator/relation, 206 delimiter/diacritic, and 31 punctuation/format records—and these counts sum to all 3,060 records (`scripts/pdf-symbol-catalog/generated/update-report.json`).

### Commit behavior, not exhaustive evidence

Generate three artifacts but commit only the two needed for review and runtime: the compact TypeScript catalog and the concise update report. The generator explicitly identifies those as the committed artifacts (`scripts/pdf-symbol-catalog/generate.ts`). The full audit remains reproducible derived data and is ignored by Git (`.gitignore:12`). In the current baseline it is 5,037,243 bytes, versus 406,546 bytes for the runtime catalog and 7,361 bytes for the report (`scripts/pdf-symbol-catalog/generated/update-report.json`).

`catalog:check` rebuilds all artifacts but drift-checks only the committed runtime catalog and report (`scripts/pdf-symbol-catalog/generate.ts`). `catalog:audit` regenerates only the full audit locally (`scripts/pdf-symbol-catalog/generate.ts`, `package.json`). CI performs the committed-artifact check, regenerates the audit, and uploads it for 14 days instead of storing it in the repository (`.github/workflows/ci.yml`).

Keep generation out of install and ordinary application build paths. `prebuild:web` runs the non-mutating check, while generation, auditing, and source updates remain explicit maintainer commands (`package.json`). Distribution validation rejects source snapshots, audits, reports, manifests, and compiler/update modules from runtime assets, and it rejects ordinary build/package/install scripts that invoke generation or updates (`packaging/macos/validate-manifest.ts`).

### Make source updates transactional and baseline-aware

Do not compare a candidate source release with whatever ignored audit happens to exist locally. The updater first recompiles the currently pinned repository inputs to reconstruct the prior baseline (`scripts/pdf-symbol-catalog/update.ts`). It then downloads declared sources, verifies their uncompressed hashes, preserves identical compressed bytes when possible, and compiles the candidate in a staging tree (`scripts/pdf-symbol-catalog/update.ts`). Publication begins only after all downloads, checksums, schemas, compilation, and artifact construction succeed, with rollback of already-published files on failure (`scripts/pdf-symbol-catalog/update.ts`).

The maintainer workflow is therefore:

1. Change or supply the candidate pinned manifest and run `pnpm catalog:update`; the updater stages and verifies sources before publishing (`scripts/pdf-symbol-catalog/update.ts`).
2. Review and commit the pinned snapshots, manifest, compact runtime catalog, and concise report; do not commit `catalog.audit.json` (`scripts/pdf-symbol-catalog/generate.ts`, `.gitignore:12`).
3. Review rank counts, alias decisions, suppressed-name summaries, equivalence counts, and artifact sizes in the report (`scripts/pdf-symbol-catalog/generated/update-report.json`).
4. Run `pnpm catalog:check`, the relevant tests, and distribution validation. The distribution baseline locks record/index cardinalities, artifact sizes, hashes, and the production JavaScript ceiling to reviewed outputs (`packaging/macos/validate-manifest.ts`).

## Why This Matters

The architecture separates four concerns that fail when collapsed into a dictionary: authoritative coverage, semantic exception policy, user-facing ranking, and artifact retention. Upstream snapshots can expand the ordinary repertoire systematically; the compiler can reject malformed or semantically unsafe relationships; small overrides can document genuine product choices; and ranking can evolve without changing symbol identity or search matching.

The committed runtime projection is the behavior-bearing artifact and the report is the review surface. The multi-megabyte audit remains available whenever maintainers or CI need exhaustive provenance, but it creates no routine clone or review cost. Because normal builds verify rather than regenerate committed behavior, installed application bytes are reproducible and do not vary with installation date, network availability, or upstream drift (`package.json`, `scripts/pdf-symbol-catalog/generate.ts`).

The tests enforce the boundaries rather than just examples. Generator tests cover classifier precedence, rank completeness, code-point tuple order, concise report summaries, byte-identical output across locale/time-zone settings, and drift checking that is independent of the ignored audit (`scripts/pdf-symbol-catalog/generate.test.ts`). Runtime tests prove likely-search ordering, deterministic tie-breaking, progressive re-ranking, detected-only alias resolution, epsilon-family handling, and separation of dangerous lookalikes (`apps/web/test/pdf-symbol-catalog.test.ts`).

## When to Apply

Use this pattern when:

- an application needs broad coverage from versioned, hashable standards data;
- exhaustive provenance is useful for auditing but too large or irrelevant for runtime distribution;
- a small number of upstream ambiguities or compatibility inputs require explicit product policy;
- display priority can be derived from source metadata without mutating stable runtime identity; or
- ordinary builds and installs must remain offline, deterministic, and non-mutating.

Do not use controlled families for merely visual confusables or mathematically related expressions without a standards-backed scalar relationship. Do not put ordinary per-symbol ranks or aliases in overrides; exceptions are appropriate only when their rationale and expected upstream state can be reviewed and validated. Do not leave the audit uncommitted if it is itself an irreplaceable input; this pattern assumes the audit can be reconstructed from pinned snapshots, overrides, and compiler code (`scripts/pdf-symbol-catalog/generate.ts`).

## Examples

### Greek epsilon variants and IPA open e

`\epsilon` and `\varepsilon` can expand across detected base, variant, and mathematical styled Greek epsilon forms, while the IPA character `ɛ` remains searchable only through its own identity or name. The exception redirects only the erroneous command mapping (`scripts/pdf-symbol-catalog/overrides.json`), and the runtime regression test checks both the Greek family and the independent IPA lookup (`apps/web/test/pdf-symbol-catalog.test.ts`).

### Search-likelihood order without changing record IDs

For the detected set `, ( + 𝟘 α`, the runtime presents `α, 𝟘, +, (, ,`; two identifier-like symbols such as `β` and `λ` are tied by code point (`apps/web/test/pdf-symbol-catalog.test.ts`). The classifier handles misleading mixed metadata through precedence—for example, number category before alphabetic metadata and format category before operator metadata—and the corpus test verifies representative scalars without per-code-point production overrides (`scripts/pdf-symbol-catalog/generate.test.ts`).

### Audit locally, commit compact artifacts

Running `pnpm catalog:generate` writes all three artifacts, including the ignored audit (`scripts/pdf-symbol-catalog/generate.ts`). Running `pnpm catalog:check` verifies only the committed runtime and report, even if the local audit is stale or missing; the generator test covers all three cases (`scripts/pdf-symbol-catalog/generate.test.ts`). CI separately creates an audit-only artifact for download (`scripts/pdf-symbol-catalog/generate.test.ts`, `.github/workflows/ci.yml`).

## Related

- [Issue #52: Symbol recognition improvements](https://github.com/brad-ross/placekeeper/issues/52) — the original report that motivated the catalog work.
- [PR #55: derive searchable math symbol catalog](https://github.com/brad-ross/placekeeper/pull/55) — merged implementation of the standards-derived catalog.
- [PR #58: rank mathematical symbol suggestions](https://github.com/brad-ross/placekeeper/pull/58) — presentation-order extension implemented in the current tree.
- [Generated Mathematical Symbol Catalog plan](../../plans/2026-08-23-1220-fix-generated-math-symbol-catalog-plan.md) — the requirements source for repertoire compilation and artifact retention.
- [Standards-Derived Symbol Suggestion Ranking plan](../../plans/2026-08-23-2006-feat-symbol-suggestion-ranking-plan.md) — the requirements source for ranking without semantic changes.
