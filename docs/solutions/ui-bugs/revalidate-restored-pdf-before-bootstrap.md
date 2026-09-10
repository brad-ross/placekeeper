---
title: Revalidate restored PDF output before viewer bootstrap
date: 2026-09-10
category: ui-bugs
module: Restored VS Code PDF review
problem_type: ui_bug
component: frontend_stimulus
severity: high
symptoms:
  - "A restored PDF panel stayed on Loading local PDF even though the live output was valid."
  - "An old empty private recovery snapshot was mistaken for slow parsing of the current document."
root_cause: async_timing
resolution_type: code_fix
tags: [vscode, pdf-recovery, bootstrap, observation-epoch, loading-state]
---

# Revalidate restored PDF output before viewer bootstrap

## Problem

A restored VS Code PDF panel appeared to remain loading even though the live PDF was valid. The incident's recovery snapshot was zero bytes and dated from an earlier day; the live source was roughly 29 MB with 111 pages. Recovery identity, current source identity, and accepted document generation were different facts. Inspecting only the live source concealed the artifact the viewer had actually been given.

## Symptoms

The interface showed persistent loading or a stale-output message. A gap of about 90 seconds between an initial observation epoch seeded from `Date.now()` and acceptance initially looked like expensive processing. It was not a measurement of native inspection: direct inspection took roughly 2.3 seconds in this incident. These are incident observations, not a performance benchmark. Ordering timestamps must not be read as task-duration telemetry without tracing when and why each is recorded.

## What Didn't Work

A valid current PDF did not disprove a corrupt private recovery snapshot. The old loading branch also did not distinguish an engine error from a document that was still arriving. A restored panel could already be active before its focus listener was attached; relying on a future activation edge therefore left startup repair dependent on another focus or watcher event. Repeatedly reopening or treating the apparent elapsed time as PDF parsing cost would not explain those state boundaries.

## Solution

Reject empty source bytes before creating the private snapshot (`apps/service/src/recovery/source-snapshot.ts:54`). At panel startup, explicitly await output revalidation before assigning the webview bootstrap HTML, rather than waiting for an activation event that may already have happened (`apps/vscode/src/extension.ts:482`). The observer tags validations with epochs and suppresses the local completion callback for superseded results (`apps/vscode/src/rebuild-observer.ts:71`, `apps/vscode/src/rebuild-observer.ts:97`).

The renderer now returns an alert for a document error before considering its ordinary loading branch (`apps/web/src/pdf/PdfWorkspace.tsx:180`). The shell separately represents waiting for an updated PDF and active generation reconciliation or location restoration; merely being possibly stale does not make its busy indicator true (`apps/web/src/app/ReviewShell.tsx:605`).

## Why This Works

The guard prevents a transient empty build output from becoming a newly trusted private source. Explicit startup validation closes the missed-focus-edge case and gives existing restored sessions a chance to compare their recovery state with the current output before rendering. Error presentation makes a bad input actionable instead of suggesting indefinite useful work.

Awaiting validation is not a global freeze of the broker. A later generation or freshness change can still occur around bootstrap. The bridge therefore reconciles canonical `/state` when the control socket connects, comparing generation, revision, and freshness before emitting an invalidation (`apps/vscode/src/webview-bridge.ts:512`, `apps/vscode/src/webview-bridge.ts:549`). Startup validation and eventual reconciliation solve different races; neither should be used as a reason to remove the other.

The fix is implemented and locally verified in PR #92, pending merge as of September 10, 2026. The restored-panel regression emits no focus event and checks that output validation precedes webview creation (`apps/vscode/test/extension.test.ts:66`).

## Prevention

For restored-document failures, first identify the exact bytes supplied to the renderer, then compare the live source, private recovery snapshot, and accepted generation. Record actual operation start/end measurements if investigating latency; observation epochs establish ordering, not processing duration. Audit restored UI listeners for events that may have fired before registration, and initialize from current state explicitly. Keep failed loading, waiting for an external build, and active reconciliation visually distinct so a passive stale state is not mistaken for a slow parser.

## Related Issues

- [PR #92](https://github.com/brad-ross/placekeeper/pull/92)
- [Atomic generation transitions for rebuilt PDF reviews](../architecture-patterns/atomic-generation-transitions-for-rebuilt-pdf-reviews.md)
- [Shared production review client with host-specific runtime boundaries](../architecture-patterns/shared-production-review-client-host-runtime-boundaries.md)
- [Refresh independently installed VS Code payloads after app installation](../integration-issues/refresh-independent-vscode-payload-after-app-install.md)
