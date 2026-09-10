---
title: Generation-bound bidirectional SyncTeX across embedded VS Code reviews
date: 2026-09-02
last_updated: 2026-09-10
category: architecture-patterns
module: Embedded LaTeX source navigation
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - A generated document and its navigation sidecar can be replaced independently during rebuilds
  - An embedded viewer must support both source-to-document and document-to-source navigation
  - Source paths cross an untrusted document or webview boundary before a privileged editor action
  - Late navigation results can outlive a cursor move, panel request, sidecar replacement, or document generation
  - A source save should follow the saved cursor only after the rebuilt output becomes current
resolution_type: code_fix
related_components:
  - Document Generation
  - Generated Output Lineage
  - Review Host Runtime
  - Review Runtime Protocol
  - VS Code webview bridge
tags: [synctex, vscode-webview, document-generation, generation-fencing, source-navigation, workspace-trust, sidecar-snapshot, editor-reuse]
---

# Generation-bound bidirectional SyncTeX across embedded VS Code reviews

## Context

Bidirectional SyncTeX inside an embedded VS Code viewer exposed failures that looked unrelated: reverse navigation could reject a legitimate source as out of scope, open a new source tab beside the PDF instead of reusing the left editor, or land on only the right line; forward navigation could race a rebuild and fail to reveal the successor PDF location. Together they showed that navigation intent, document identity, source authority, editor placement, and retry state needed explicit owners.

The final workflow was tested with a real multi-page SyncTeX-enabled LaTeX fixture because a trivial PDF could not prove page transitions or rebuild-follow behavior. Installed-host tests were also necessary: stale packaged assets repeatedly made corrected source navigation appear broken until the current bundle and a fresh VS Code process were verified (session history).

The durable design is a generation-bound navigation transaction. The extension owns trusted editor context and placement; the service owns the immutable PDF/sidecar pair, source-root confinement, bounded process execution, and generation fences; the shared viewer captures PDF points and applies only forward targets that match its current ready generation (`apps/vscode/src/extension.ts:185`, `apps/service/src/synctex/query.ts:221`, `apps/service/src/sessions/session-broker.ts:2486`, `apps/web/src/app/ProductionReviewApp.tsx:211`).

## Guidance

### Bind queries to one private PDF/sidecar pair

Never query a mutable build-directory PDF and whichever sidecar happens to be next to it. When a Document Generation is accepted, stage the one supported `.synctex` or `.synctex.gz` sidecar beside the private PDF snapshot (`apps/service/src/recovery/source-snapshot.ts:232`, `apps/service/src/recovery/source-snapshot.ts:247`, `apps/service/src/recovery/source-snapshot.ts:312`). Reject missing or simultaneous formats distinctly, require a bounded regular non-symlink file, and prove the mutable PDF still matches the accepted output identity before and after copying (`apps/service/src/recovery/source-snapshot.ts:255`, `apps/service/src/recovery/source-snapshot.ts:261`, `apps/service/src/recovery/source-snapshot.ts:288`). A sidecar fingerprint matching the predecessor is stale evidence, not a map for the successor (`apps/service/src/recovery/source-snapshot.ts:295`, `apps/service/src/recovery/source-snapshot.ts:304`).

A SyncTeX Binding should include output identity, Document Generation, PDF digest, private PDF path, private sidecar and fingerprint, approved source root, and operation token (`apps/service/src/synctex/query.ts:221`). Before invoking SyncTeX, verify that PDF and sidecar are the expected sibling files and that stable private hashes match the binding (`apps/service/src/synctex/query.ts:321`, `apps/service/src/synctex/query.ts:335`, `apps/service/src/synctex/query.ts:352`). The broker prepares a binding only from the lineage record matching canonical generation and digest (`apps/service/src/sessions/session-broker.ts:2494`, `apps/service/src/sessions/session-broker.ts:2498`). If a PDF commits before its sidecar, report `pending` for the successor rather than borrowing predecessor metadata (`apps/service/src/sessions/session-broker.ts:2524`, `apps/service/src/sessions/session-broker.ts:2542`).

### Fence before and after external work

The broker records the newest operation token and validates the complete binding whenever a result is about to become observable. Currentness includes token, generation, PDF digest and path, observed output identity, sidecar path and digest, and source root (`apps/service/src/sessions/session-broker.ts:2561`, `apps/service/src/sessions/session-broker.ts:2574`, `apps/service/src/sessions/session-broker.ts:2584`). Both directions receive that predicate (`apps/service/src/sessions/session-broker.ts:2598`, `apps/service/src/sessions/session-broker.ts:2620`).

Check currentness after validating inputs and before spawning, then again after parsing. Forward navigation returns `stale` when the binding changes before or during the query (`apps/service/src/synctex/query.ts:406`, `apps/service/src/synctex/query.ts:433`); reverse navigation applies the same pair of fences (`apps/service/src/synctex/query.ts:467`, `apps/service/src/synctex/query.ts:517`). An operation token orders cursor requests within one generation; generation, digest, and sidecar checks prevent predecessor evidence from navigating a successor.

### Confine source paths at both trusted boundaries

Treat every source path emitted by SyncTeX as untrusted. The service canonicalizes the approved root, accepts only physical regular-file targets within it, rejects traversal and symlink escapes, and returns a normalized root-relative path (`apps/service/src/files/source-scope.ts:75`, `apps/service/src/files/source-scope.ts:108`, `apps/service/src/files/source-scope.ts:121`, `apps/service/src/files/source-scope.ts:137`). Reverse candidates are individually resolved and deduplicated, and exactly one contained target must remain (`apps/service/src/synctex/query.ts:481`, `apps/service/src/synctex/query.ts:492`, `apps/service/src/synctex/query.ts:516`). Forward input paths pass through the same resolver (`apps/service/src/synctex/query.ts:390`).

The extension independently resolves that relative result against its own approved source binding, requires Workspace Trust, and constructs the editor URI itself (`apps/vscode/src/latex-project.ts:12`, `apps/vscode/src/extension.ts:214`, `apps/vscode/src/extension.ts:220`). It opens the source, then strips the path before returning the result to the webview (`apps/vscode/src/webview-bridge.ts:476`, `apps/vscode/src/webview-bridge.ts:486`). The sandboxed viewer never receives an arbitrary file-open capability.

### Preserve a saved cursor until its rebuild is navigable

Capture the cursor from a trusted `.tex` or `.ltx` document inside the approved root (`apps/vscode/src/extension.ts:185`, `apps/vscode/src/extension.ts:192`). On save, locate the editor that owns the saved document rather than assuming the active editor still does; prefer the active matching editor, then a visible match (`apps/vscode/src/rebuild-navigation.ts:14`, `apps/vscode/src/extension.ts:203`).

Store this as a Source Navigation Intent rather than navigating immediately. The coordinator keeps the latest saved cursor pending, exposes it only while a matching reveal is active, and retains it for retryable outcomes (`apps/vscode/src/rebuild-navigation.ts:40`, `apps/vscode/src/rebuild-navigation.ts:54`, `apps/vscode/src/rebuild-navigation.ts:76`, `apps/vscode/src/rebuild-navigation.ts:84`). A committed rebuild or same-digest confirmation may activate it; an invalid observation does not (`apps/vscode/src/rebuild-navigation.ts:25`, `apps/vscode/src/rebuild-navigation.ts:30`).

The trusted host substitutes its saved source location and a fresh token for the webview's empty forward request (`apps/vscode/src/webview-bridge.ts:422`, `apps/vscode/src/webview-bridge.ts:431`). The successful result carries its Document Generation, and the shared client waits until that generation is canonical and viewer-ready; it then rechecks request token and navigation instance after applying the target (`apps/vscode/src/extension.ts:267`, `apps/vscode/src/extension.ts:281`, `apps/web/src/app/ProductionReviewApp.tsx:683`, `apps/web/src/app/ProductionReviewApp.tsx:699`).

### Resolve one PDF point and reuse the source editor

A modifier-click without a drag becomes a page index and page-local PDF point, and only that geometry crosses the Review Host Runtime (`apps/web/src/pdf/viewer-interaction-events.ts:162`, `apps/web/src/pdf/PdfWorkspace.tsx:290`, `apps/web/src/pdf/PdfWorkspace.tsx:307`). The trusted host mints an operation token and the service runs reverse SyncTeX against the current private pair (`apps/vscode/src/webview-bridge.ts:439`, `apps/service/src/synctex/query.ts:445`).

When exactly one safe target returns, reuse its existing VS Code editor group. First reuse a visible matching editor; otherwise find the matching hidden tab group, preferring one other than the PDF group, and reopen it there (`apps/vscode/src/source-navigation.ts:10`, `apps/vscode/src/source-navigation.ts:41`, `apps/vscode/src/source-navigation.ts:45`, `apps/vscode/src/source-navigation.ts:50`). This preserves the source-left/PDF-right arrangement.

Validate the returned one-based line and optional column against the current document rather than clamping stale coordinates (`apps/vscode/src/source-navigation.ts:67`, `apps/vscode/src/source-navigation.ts:73`). With an exact column, place the caret there and highlight the character; without one, place the caret at the first non-whitespace character and highlight the complete line (`apps/vscode/src/source-navigation.ts:76`, `apps/vscode/src/source-navigation.ts:82`). The extension reveals that selection and applies a short-lived decoration so correspondence is visible (`apps/vscode/src/extension.ts:236`, `apps/vscode/src/extension.ts:251`, `apps/vscode/src/extension.ts:260`).

### Distinguish retryable lag from terminal failure

Run SyncTeX without a shell, under controlled environment and bounded time/output (`apps/service/src/synctex/query.ts:55`, `apps/service/src/synctex/query.ts:61`, `apps/service/src/synctex/query.ts:409`). Preserve distinct statuses for missing, pending, stale, ambiguous, out-of-root, unavailable tool, timeout, oversized output, malformed output, and generic failure (`apps/service/src/synctex/query.ts:231`, `apps/service/src/synctex/query.ts:284`).

Only `pending` and `stale` are retryable for forward navigation (`apps/vscode/src/webview-bridge.ts:74`). Bounded retries let a lagging sidecar catch up, and the saved intent remains available when a later sidecar event may succeed (`apps/vscode/src/extension.ts:271`, `apps/vscode/src/extension.ts:285`, `apps/vscode/src/rebuild-navigation.ts:85`). Terminal outcomes retire the intent (`apps/vscode/src/rebuild-navigation.ts:86`). Reverse navigation maps each status to an actionable message, and request coordination prevents an older completion from overwriting the newest result (`apps/web/src/app/ProductionReviewApp.tsx:280`, `apps/web/src/app/ProductionReviewApp.tsx:311`, `apps/web/src/app/ProductionReviewApp.tsx:323`).

### Treat ordered forward results differently from reverse ambiguity

PR #92 exposed a distinction the generation-bound SyncTeX design needs to preserve. Beamer can map one source position to several rectangles on one page or across overlay pages. Treating those forward results as ambiguous rejected valid presentation output. The forward query now filters records to the bound private PDF, checks that the binding is still current, and selects the last surviving record in tool-output order (`apps/service/src/synctex/query.ts:427`, `apps/service/src/synctex/query.ts:436`). “Last” means the final bound record returned by this query: it does not mean the highest page number, newest compilation, or a different generation.

This is a presentation-choice policy within an already authorized PDF. It must not be copied to reverse navigation, where different source targets would change which file or position the editor opens. Reverse results continue to resolve contained source paths and deduplicate by path, line, and column before requiring a unique target (`apps/service/src/synctex/query.ts:482`, `apps/service/src/synctex/query.ts:502`). Multiple forward rectangles and multiple reverse source targets therefore require different policies despite looking superficially similar.

The same real-world output invalidated the shared 64 KiB assumption: Beamer overlays can return hundreds of forward rectangles for a single line. Forward output now has a bounded 1 MiB allowance while retaining the two-second timeout (`apps/service/src/synctex/query.ts:409`). Reverse output retains its 64 KiB bound (`apps/service/src/synctex/query.ts:468`). Increasing the byte budget is not justification for relaxing generation checks, output-path filtering, or subprocess runtime limits.

### Check an exact sibling before bounded workspace discovery

A workspace-wide PDF search capped at 64 results can omit the obvious generated output next to the active source. The source-binding helper now checks the exact same-stem sibling directly before invoking that bounded fallback (`apps/vscode/src/local-workspace.ts:152`). This is a narrow filesystem heuristic, not LaTeX recipe, root-document, or compiler-output-directory inference. If fallback discovery yields unresolved alternatives, the user still chooses a PDF and the review tab keeps that binding (`apps/vscode/src/extension.ts:168`, `apps/vscode/src/extension.ts:174`).

For future changes, use rich SyncTeX fixtures with repeated rectangles, overlay pages, and output above the old byte cap; a trivial one-page PDF cannot exercise these failure modes. Also exercise discovery in a workspace with enough PDFs to exceed its cap. Preserve the semantic distinction between deterministic selection inside one bound artifact and ambiguity over source authority. These cases are covered by the overlay, large-output, reverse-ambiguity, and sibling-discovery regressions (`apps/service/test/synctex.test.ts:253`, `apps/service/test/synctex.test.ts:282`, `apps/service/test/synctex.test.ts:299`, `apps/vscode/test/extension.test.ts:621`). The changes are locally verified in PR #92, pending merge as of September 10, 2026.

## Why This Matters

SyncTeX combines mutable build artifacts, subprocess output, local paths, editor state, and asynchronous viewer work. Treating the result as a timeless line number can mix generations, expose an out-of-root file, duplicate the source editor beside the PDF, or apply a late cursor after another rebuild.

The separate fences have separate jobs. A SyncTeX Binding proves artifact identity, an operation token orders overlapping intent, source containment preserves authority, viewer-generation checks protect application timing, and editor-group reuse preserves workspace layout. Typed failures allow temporary sidecar lag to recover without turning ambiguity or unsafe paths into polling loops.

This yields a source/PDF loop whose correctness is based on current identity rather than timing: source-to-PDF follows the next qualifying current build observed after the saved cursor, while PDF-to-source opens the exact contained location in the user's existing editor arrangement.

## When to Apply

- Generated outputs and mapping sidecars can arrive at different times.
- A viewer can reload across Document Generations.
- Mapping-tool paths are untrusted and a privileged host owns editor actions.
- Navigation requests can overlap or finish after a rebuild.
- Existing editor placement is part of the user workflow.

Do not query a mutable PDF/sidecar pair, send paths or arbitrary open-file capabilities into a webview, apply a forward point before its generation is ready, clamp stale source coordinates, or retry terminal ambiguity and safety failures indefinitely.

## Examples

### Source save followed by rebuild

1. Saving `paper.tex` captures the cursor from the editor that owns the document and records a pending intent (`apps/vscode/src/extension.ts:436`, `apps/vscode/src/extension.ts:440`).
2. A committed successor activates that saved intent (`apps/vscode/src/extension.ts:401`, `apps/vscode/src/extension.ts:407`).
3. If the sidecar lags, `pending` triggers bounded retries and preserves the intent (`apps/service/src/sessions/session-broker.ts:2542`, `apps/vscode/src/extension.ts:285`, `apps/vscode/src/rebuild-navigation.ts:85`).
4. The shared client waits for the returned generation before centering and focusing the PDF (`apps/vscode/src/extension.ts:281`, `apps/web/src/app/ProductionReviewApp.tsx:691`, `apps/web/src/app/ProductionReviewApp.tsx:236`).

Tests prove that a saved cursor follows its rebuild, an external rebuild invents no navigation, newer intent wins over an older in-flight reveal, retryable lag retains intent, and terminal results retire it (`apps/vscode/test/rebuild-navigation.test.ts:36`, `apps/vscode/test/rebuild-navigation.test.ts:53`, `apps/vscode/test/rebuild-navigation.test.ts:61`, `apps/vscode/test/rebuild-navigation.test.ts:80`, `apps/vscode/test/rebuild-navigation.test.ts:118`).

### Modifier-click from PDF to source

1. The viewer produces only a page index and point (`apps/web/src/pdf/PdfWorkspace.tsx:290`, `apps/web/src/pdf/PdfWorkspace.tsx:307`).
2. The service queries the private generation pair and retains one contained target (`apps/service/src/synctex/query.ts:472`, `apps/service/src/synctex/query.ts:516`).
3. The extension reuses the visible or hidden source editor group and avoids the PDF group (`apps/vscode/src/source-navigation.ts:45`, `apps/vscode/src/source-navigation.ts:50`).
4. It validates and reveals the exact character or line (`apps/vscode/src/source-navigation.ts:67`, `apps/vscode/src/extension.ts:251`).

Tests cover left-group reuse, hidden-tab restoration, duplicate avoidance, exact-character highlighting, line fallback, and rejection rather than clamping (`apps/vscode/test/extension.test.ts:60`, `apps/vscode/test/extension.test.ts:68`, `apps/vscode/test/extension.test.ts:98`, `apps/vscode/test/extension.test.ts:122`, `apps/vscode/test/extension.test.ts:130`, `apps/vscode/test/extension.test.ts:138`).

## Related

- [Atomic generation transitions for rebuilt PDF reviews](./atomic-generation-transitions-for-rebuilt-pdf-reviews.md)
- [Shared production review client with host-specific runtime boundaries](./shared-production-review-client-host-runtime-boundaries.md)
- [Manual-precedence reconciliation for agent source work](./manual-precedence-agent-source-reconciliation.md)
- [Return-to-origin navigation for stateful PDF Reference Tabs](./reference-tab-return-to-origin-navigation.md)
- [Reject stale viewer selection snapshots before creating annotation anchors](../ui-bugs/reject-stale-viewer-selection-snapshots.md)
- [PR #68: Fully embedded VS Code LaTeX review](https://github.com/brad-ross/placekeeper/pull/68)

- [PR #92: Current PDF reviews and predictable navigation](https://github.com/brad-ross/placekeeper/pull/92)
- [Refresh independently installed VS Code payloads after app installation](../integration-issues/refresh-independent-vscode-payload-after-app-install.md)
- [Revalidate restored PDF output before viewer bootstrap](../ui-bugs/revalidate-restored-pdf-before-bootstrap.md)
