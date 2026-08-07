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

## Boundaries

- Keep all review state in the installed local service. Do not upload the PDF or request network access.
- Do not submit, create, or monitor a Codex task. Codex delivery remains an explicit action inside the proofreader.
- Do not bypass ordinary permission prompts or retry an unsupported remote or virtual path through copying or port forwarding.
- If the desktop built-in browser is unavailable, report that PDF Proofreader requires Codex desktop; do not substitute an undocumented URL scheme.
