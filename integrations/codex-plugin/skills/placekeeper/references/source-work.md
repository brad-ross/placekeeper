# Source changes and clean rebuilds

Read when the user requests changes to the reviewed source or a clean rebuild. Use [live-evidence.md](live-evidence.md) for required Review Items and evidence. Continue through the requested edits, relevant validation, and final disposition without a separate prepared-delivery approval. Stop dependent writes when freshness or reconciliation fails; report the unresolved work.

The ordering below protects concurrent manual edits and is required by the service protocol.

- Begin source work only when the user asks for source changes or a clean rebuild. Use the opaque handle from the current context; the service resolves its task binding internally and never asks for a task id:

  If the current review has no approved source root, rerun the exact installed launch command for the same PDF with the user-identified `--source-root <absolute-local-directory>`. The focused review keeps its existing Review Items and task binding while attaching that approved root; do not open a second task or infer a root.

  `"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper" context source begin --handle <current-handle> [--path <source-root-relative-path> ...]`

  The returned execution baseline fixes the Review Item identities, semantics, review digest, and source fingerprints for this run. Use the newly returned `freshness.evidenceHandle` for the next operation.
- Register at most one idempotent proposal per baseline item before editing. Write versioned proposal JSON containing `idempotencyKey`, `baselineItemId`, relative `path`, exact `expectedText`, `replacementText`, and optional `prefix`/`suffix` to a new private temporary file, then pass the absolute path (this avoids shell quoting or argument disclosure of source text):

  `"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper" context source propose --handle <current-handle> --execution <execution-id> --proposal-file <absolute-private-json-path>`

- Reconcile before editing:

  `"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper" context source reconcile --handle <current-handle> --execution <execution-id>`

  `equivalent` means do not duplicate the edit. `conflict`, `ambiguous`, or `removed` means preserve the manual state and adapt or skip. Only `independent` may be applied.
- Immediately before each ordinary source edit, re-run reconciliation with the proposal-key-to-`applyGuardSha256` map returned by the first check:

  `"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper" context source reconcile --handle <current-handle> --execution <execution-id> --guards-file <absolute-private-json-path>`

  Apply only a still-`independent` result. Make the edit with ordinary Codex source tools; the Placekeeper provider never writes source and never bypasses sandbox or approval gates. If the guarded recheck changes classification or fails, do not write.
- For a user-requested clean rebuild, ask the service to fence the intended output and exact user-specified build command:

  `"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper" context source rebuild-plan --handle <current-handle> --execution <execution-id> --command <command> --output <source-root-relative-pdf>`

  Run the returned command exactly once with ordinary Codex shell tooling in the returned working directory, keeping stdout, stderr, permissions, and approvals visible. Then call:

  `"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper" context source rebuild-verify --handle <current-handle> --execution <execution-id> --plan <plan-id>`

  Do not claim a clean rebuild unless verification reports a newly observable regular PDF, successful structural inspection, and `reviewAnnotationsPresent: false`.
- Finish only after another live refresh and reconciliation by writing exactly one disposition for every baseline item to a new private JSON file:

  `"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper" context source complete --handle <current-handle> --execution <execution-id> --items-file <absolute-private-json-path> [--rebuild-verification <verification-id>]`

  Use `applied` only after a guarded ordinary Codex edit and include its relative changed path. Use `already-satisfied` for deduplicated equivalent work, `skipped-conflict` or `skipped-ambiguous` when manual work wins, `removed-before-processing` for removed feedback, and `not-applied` for independent work intentionally left undone. Report the returned complete disposition, including every `preserved-unprocessed` later Review Item. A failed refresh blocks completion.
