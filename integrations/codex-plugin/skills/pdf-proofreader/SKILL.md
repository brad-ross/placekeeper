---
name: pdf-proofreader
description: Open one explicitly referenced local PDF in the installed PDF Proofreader and navigate the Codex desktop built-in browser to its scoped loopback review session. Use when the user asks to proofread, annotate, mark up, or review a local .pdf file in PDF Proofreader. Reject missing, multiple, remote, or non-PDF inputs through the launcher's shared errors.
---

# PDF Proofreader

## Launch workflow

1. Resolve exactly one user-referenced local `.pdf` path. Do not infer a file from unrelated workspace content.
2. Run the installed launch client with an argument array, never a shell-built command:

   `pdf-proofreader open --json --surface codex --pdf <absolute-local-pdf-path>`

   Add `--source-root <absolute-local-directory>` only when the user explicitly identifies the associated source tree. Add `--fork` only when the user explicitly requests an independent review.
3. Parse the single JSON response. Accept only `ok: true`, `kind: "opened"` or `"focused"`, and an `http://127.0.0.1:<port>/s/<session>/bootstrap#cap=<token>` URL.
4. If the result is `kind: "recovery-offered"`, ask the user to choose exactly one returned option: resume, discard, or fork. Do not display the opaque recovery session ID. Rerun the same command with `--recovery <choice>`; `--fork` remains an explicit alias when the user asked for an independent review initially.
5. Pass an opened or focused URL directly to the Codex desktop built-in browser. Do not print, summarize, save, or copy the capability URL elsewhere.
6. For `ok: false`, present only the returned shared error and its one recovery action. Do not expose filesystem details that are absent from the error.
7. The packaged lifecycle hook automatically binds the successful launch to this task and refreshes current Review Items before each later prompt. Never copy or repeat the returned bind proof, document generation, browser capability, or task identity.

## Live context and PDF evidence

- Treat each `pdf-proofreader-live-context` developer-context envelope as the only freshness authority. `currentness: "current"` describes the accepted Review State at its exact revision; `currentness: "unavailable"` means cached state must not be presented as current.
- Review Items are the semantic authority for app-authored annotations. Preserve each item's stable ID, intent, page, geometry, payload, anchor/context, and relative source hint. Existing PDF Annotations are a separate read-only population.
- An unchanged envelope confirms that the previously observed Review Items remain current. A delta contains all additions, edits, and removals since this task's previous successful observation. Never infer an active PDF from tabs, recent files, another task, or ambient UI state.
- Retrieve the complete canonical Review Item set, including large first observations, with `pdf-proofreader context items --handle <opaque-handle>`. Use `--page`, `--offset`, and `--limit` to paginate, and continue from `nextOffset` until absent. This structured operation returns type, location, geometry, content/payload, anchor context, and source hints without placing every item in every prompt.
- Retrieve page or document evidence only through the opaque handle in the current envelope:

  `pdf-proofreader context evidence --handle <opaque-handle> --kind page-text --page <zero-based-page>`

  Supported kinds are `page-text`, `page-layout`, `page-render`, `raw-annotations`, and `document`. Use `--offset`/`--limit` for raw annotations and `--max-bytes` to narrow large responses. `document` and `page-render` require `--output <new-absolute-local-path>`; then use the generic PDF skill to inspect the resulting artifact. Never print or retain the handle beyond the current task.
- Evidence handles are short-lived and bound to the current task, document generation, and verified state digest. On `expired`, `stale_generation`, or `unauthorized`, wait for the next prompt refresh or ask the user to reopen the PDF; do not search for another session.

## Discussion and source work in this task

- For questions, summaries, or discussion, use the live context and evidence above. Do not capture a source-work baseline and do not write source merely because annotations exist.
- Begin source work only when the user asks for source changes or a clean rebuild. Use the opaque handle from the current context; the service resolves its task binding internally and never asks for a task id:

  `pdf-proofreader context source begin --handle <current-handle> [--path <source-root-relative-path> ...]`

  The returned execution baseline fixes the Review Item identities, semantics, review digest, and source fingerprints for this run. Use the newly returned `freshness.evidenceHandle` for the next operation.
- Register at most one idempotent proposal per baseline item before editing. Write versioned proposal JSON containing `idempotencyKey`, `baselineItemId`, relative `path`, exact `expectedText`, `replacementText`, and optional `prefix`/`suffix` to a new private temporary file, then pass the absolute path (this avoids shell quoting or argument disclosure of source text):

  `pdf-proofreader context source propose --handle <current-handle> --execution <execution-id> --proposal-file <absolute-private-json-path>`

- Reconcile before editing:

  `pdf-proofreader context source reconcile --handle <current-handle> --execution <execution-id>`

  `equivalent` means do not duplicate the edit. `conflict`, `ambiguous`, or `removed` means preserve the manual state and adapt or skip. Only `independent` may be applied.
- Immediately before each ordinary source edit, re-run reconciliation with the proposal-key-to-`applyGuardSha256` map returned by the first check:

  `pdf-proofreader context source reconcile --handle <current-handle> --execution <execution-id> --guards-file <absolute-private-json-path>`

  Apply only a still-`independent` result. Make the edit with ordinary Codex source tools; the proofreader provider never writes source and never bypasses sandbox or approval gates. If the guarded recheck changes classification or fails, do not write.
- For a user-requested clean rebuild, ask the service to fence the intended output and exact user-specified build command:

  `pdf-proofreader context source rebuild-plan --handle <current-handle> --execution <execution-id> --command <command> --output <source-root-relative-pdf>`

  Run the returned command exactly once with ordinary Codex shell tooling in the returned working directory, keeping stdout, stderr, permissions, and approvals visible. Then call:

  `pdf-proofreader context source rebuild-verify --handle <current-handle> --execution <execution-id> --plan <plan-id>`

  Do not claim a clean rebuild unless verification reports a newly observable regular PDF, successful structural inspection, and `reviewAnnotationsPresent: false`.
- Finish only after another live refresh and reconciliation by writing exactly one disposition for every baseline item to a new private JSON file:

  `pdf-proofreader context source complete --handle <current-handle> --execution <execution-id> --items-file <absolute-private-json-path> [--rebuild-verification <verification-id>]`

  Use `applied` only after a guarded ordinary Codex edit and include its relative changed path. Use `already-satisfied` for deduplicated equivalent work, `skipped-conflict` or `skipped-ambiguous` when manual work wins, `removed-before-processing` for removed feedback, and `not-applied` for independent work intentionally left undone. Report the returned complete disposition, including every `preserved-unprocessed` later Review Item. A failed refresh blocks completion.
- Never create or copy a handoff bundle, save a Codex instruction, ask the user to confirm a prepared delivery, open a fresh task, or select a returned result. Discussion, source work, rebuild verification, and disposition all stay in this bound task.

## Boundaries

- Keep all review state in the installed local service. Do not upload the PDF or request network access.
- Do not submit, create, or monitor another Codex task. Continue discussion and user-requested source work in this hosting task under ordinary Codex permissions.
- Do not bypass ordinary permission prompts or retry an unsupported remote or virtual path through copying or port forwarding.
- If the desktop built-in browser is unavailable, report that PDF Proofreader requires Codex desktop; do not substitute an undocumented URL scheme.
