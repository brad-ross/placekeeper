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

## Boundaries

- Keep all review state in the installed local service. Do not upload the PDF or request network access.
- Do not submit, create, or monitor another Codex task. Continue discussion and user-requested source work in this hosting task under ordinary Codex permissions.
- Do not bypass ordinary permission prompts or retry an unsupported remote or virtual path through copying or port forwarding.
- If the desktop built-in browser is unavailable, report that PDF Proofreader requires Codex desktop; do not substitute an undocumented URL scheme.
