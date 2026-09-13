# Live context and PDF evidence

Read for questions or review work that need current Review Items or PDF evidence. Retrieve only the pages and items needed for the request; paginate the full set when completeness is required.

- Review Items are the semantic authority for app-authored annotations. Preserve each item's stable ID, intent, page, geometry, payload, anchor/context, and relative source hint. Existing PDF Annotations are a separate read-only population.
- An unchanged envelope confirms that the previously observed Review Items remain current. A delta contains all additions, edits, and removals since this task's previous successful observation. Never infer an active PDF from tabs, recent files, another task, or ambient UI state.
- Retrieve the complete canonical Review Item set, including large first observations, with `"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper" context items --handle <opaque-handle>`. Use `--page`, `--offset`, and `--limit` to paginate, and continue from `nextOffset` until absent. For a compacted change set, use `"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper" context changes --handle <opaque-handle>` and paginate it so added, edited, and removed entries remain recoverable. This structured operation returns type, location, geometry, content/payload, anchor context, and source hints without placing every item in every prompt.
- Retrieve page or document evidence only through the opaque handle in the current envelope:

  `"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper" context evidence --handle <opaque-handle> --kind page-text --page <zero-based-page>`

  Supported kinds are `page-text`, `page-layout`, `page-render`, `raw-annotations`, and `document`. Use `--offset`/`--limit` for raw annotations and `--max-bytes` to narrow large responses. `document` and `page-render` require `--output <new-absolute-local-path>`; then use the generic PDF skill to inspect the resulting artifact. Never print or retain the handle beyond the current task.
- Evidence handles are short-lived and bound to the current task, document generation, and verified state digest. On `expired`, `stale_generation`, or `unauthorized`, wait for the next prompt refresh or ask the user to reopen the PDF; do not search for another session.

