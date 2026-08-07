# Codex handoff acceptance evidence

This checklist separates deterministic automated coverage from tests that genuinely require a fresh external Codex task. Automated checks do not claim to audit every external read; that boundary belongs to the external Codex sandbox.

## Automated fixture evidence

- `packages/core/test/handoff-schema.test.ts`: JSON Schema 2020-12 validation through Ajv, bounded envelopes, every review kind, mandatory selection/caret/page anchors, source hints, unsupported versions, duplicate stable IDs, and disposition status shape.
- `apps/service/test/synctex.test.ts`: fixed `synctex` argv contract, canonical working directory, timeout/output caps, matching and missing results, malformed/multiple/absolute/traversal/symlink-escaping results, and fallback preservation.
- `apps/service/test/handoff-export.test.ts`: same-revision reviewed-PDF/handoff binding, immutable collision-safe artifacts, source/review/output hashes, exact stable-ID accounting, contained observable changed paths, build success/failure, distinct revised PDF, and rejection of inherited Proofreader annotations while permitting generated links.
- `apps/web/test/codex-delivery.test.tsx` and `test/acceptance/codex-delivery.spec.ts`: empty-review disablement, Setup/Ready/Result phases, first/scope-change confirmation, unchanged-scope reuse, full selectable and saveable instruction after clipboard denial, no external request/task submission, and explicit returned-file selection followed by Check Result.
- `test/fixtures/latex/`: representative checked-in build guidance, repeated text, a legitimate generated link, and hostile-looking source comments treated as fixture data.

Run focused automated evidence with `pnpm test:u6`.

## Explicit U7 integration seam

U6 supplies and tests the frozen semantic delivery object, SyncTeX runner/parser and batch hint query, reviewed-PDF/handoff exporter, prompt, result checker, and Setup/Ready/Result UI. U7 still must wire the installed broker route from `freezeDelivery()` through the selected PDF export, real `synctex` executable, handoff persistence, UI callbacks, observable changed-path collection, default EmbedPDF result inspection, and host file pickers. The automated U6 harness uses those production interfaces but does not claim an installed end-to-end broker route or a real external shell/task.

## Pending fresh-Codex manual rows

These rows are intentionally pending until a human starts a fresh Codex task from only the copied instruction and generated local artifacts:

- [ ] AE8: build `paper.tex` with real SyncTeX output and confirm each mappable item gains a relative file/approximate line hint while retaining its mandatory fallback anchor.
- [ ] AE9: remove the SyncTeX artifact and confirm every item remains actionable; repeated text produces `Ambiguous` rather than a guessed edit.
- [ ] AE13: return mixed Applied, Already satisfied, Ambiguous, and Not applied statuses exactly once per input ID; a successful build yields a distinct clean revised PDF while reviewed evidence remains byte-identical.
- [ ] Force a build failure after source edits and confirm an atomic explicit partial disposition, no revised-PDF claim, and complete ID accounting.
- [ ] Deny requested network/install/elevated permission and confirm no bypass, command substitution, automatic task submission, or out-of-root write occurs despite hostile PDF text, annotations, filenames, source comments, SyncTeX output, build configuration, and logs.
- [ ] Select the returned disposition and revised PDF in the Result phase; confirm the app—not the task narrative—reports Complete, Partial, or Invalid from observable paths, exact IDs, evidence/output hashes, and clean-PDF inspection.
