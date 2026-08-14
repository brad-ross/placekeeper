---
title: Preserve document history for Annotation Tray navigation
date: 2026-08-14
category: ui-bugs
module: Annotation Tray navigation
problem_type: ui_bug
component: frontend_stimulus
severity: medium
symptoms:
  - "Activating an Owned Annotation or Existing PDF Annotation moved the Main Reading Thread, but Back did not restore the reader's prior location."
  - "A rapid second annotation activation could record the first in-flight destination as the history origin instead of preserving the original reading place."
root_cause: logic_error
resolution_type: code_fix
related_components:
  - "NavigationCoordinator"
  - "Main Reading Thread"
  - "Meaningful Jump"
  - "viewer-navigation-adapter"
  - "testing_framework"
tags:
  - "annotation-tray"
  - "pdf-navigation"
  - "document-history"
  - "meaningful-jump"
  - "navigation-coordinator"
  - "back-forward"
  - "async-cancellation"
---

# Preserve document history for Annotation Tray navigation

## Problem

Annotation rows in the workspace tray owned PDF scrolling directly. Selecting a row moved the Main Reading Thread to the annotation, but bypassed the document-navigation transaction that records a Meaningful Jump. The PDF moved while Back still had no origin to restore.

Pending, unmerged [PR #34](https://github.com/brad-ross/placekeeper/pull/34) moves that responsibility into `NavigationCoordinator`. Both application-owned Review Items and read-only Existing PDF Annotations now send semantic page and point data through the same coordinated navigation path (`apps/web/src/app/ProductionReviewApp.tsx:990-1001`).

## Symptoms

- Selecting a source annotation could move from page 1 to page 3 while leaving **Back in document history** disabled.
- After an annotation jump, the reader could not reliably return to the exact location occupied before opening the annotation.
- A second annotation click while the first jump was settling could record the first annotation's transient viewport as the new history origin.

The acceptance regression captures the visible contract: select a page-3 source annotation from page 1, observe Back become enabled, return to page 1, and then use Forward to revisit page 3 (`test/acceptance/production-flow.spec.ts:1293-1318`).

## What Didn't Work

The former implementation treated annotation activation as a presentation concern:

```ts
// Historical shape removed by PR #34.
scrollToPage({ pageNumber, pageCoordinates, alignX: 50, alignY: 35 });
```

That changed the viewport but never entered the coordinator's `request-main-jump` / `complete-main-jump` protocol. The reducer appends history only after a pending jump completes successfully, retaining both the captured origin and the settled destination (`apps/web/src/review/reference-navigation-state.ts:430-457`). A direct scroll cannot make Back and Forward truthful.

Routing clicks through a coordinator method was necessary but not sufficient for rapid clicks. `begin()` supersedes pending work by initiating cancellation (`apps/web/src/review/navigation-coordinator.ts:1058-1080`). If the cancelled viewer operation already changed the viewport, the adapter schedules an asynchronous rollback to its origin and exposes that rollback as a promise (`apps/web/src/pdf/viewer-navigation-adapter.ts:381-401`). Capturing the next origin before that promise settles can observe the transient first destination.

## Solution

Treat annotation activation as a first-class Meaningful Jump owned by `NavigationCoordinator`.

The UI forwards semantic inputs only:

```ts
void navigationCoordinator.navigateMainAnnotation({
  pageIndex: item.pageIndex,
  point: reviewItemPoint(item),
});
```

Owned Review Items use their derived point. Existing PDF Annotations use the top-left of their rectangle. Both routes enter `navigateMainAnnotation` (`apps/web/src/app/ProductionReviewApp.tsx:990-1001`).

The coordinator then:

1. Begins a document-scoped operation and obtains the Main viewer (`apps/web/src/review/navigation-coordinator.ts:759-769`).
2. Awaits `cancelPendingNavigation`, re-checks operation currency, and only then captures the origin (`apps/web/src/review/navigation-coordinator.ts:770-775`).
3. Builds and validates a `PdfViewerLocation`, preserving current zoom and the established annotation alignment (`apps/web/src/review/navigation-coordinator.ts:777-793`).
4. Treats a semantic no-op as success without duplicate history; otherwise it applies the destination through the shared Main-jump transaction (`apps/web/src/review/navigation-coordinator.ts:794-806`).
5. On success, focuses the destination, announces it, and refreshes outline context (`apps/web/src/review/navigation-coordinator.ts:807-815`).

The shared transaction records the origin and requested destination, applies the movement, captures the settled location, and completes the reducer transaction (`apps/web/src/review/navigation-coordinator.ts:1020-1045`).

## Why This Works

Back and Forward need two authoritative locations: the stable origin before a jump and the settled destination after it. `NavigationCoordinator` already owns this transaction for other Meaningful Jumps, so placing annotation activation behind the same boundary keeps viewport movement and history state atomic. The ordinary unit regression proves that a jump creates `[origin, annotation]`, Back reapplies the origin, and Forward reapplies the annotation (`apps/web/test/navigation-coordinator.test.ts:739-755`).

Waiting for cancellation protects the origin under concurrency. The viewer adapter itself waits for its rollback barrier before starting a new operation (`apps/web/src/pdf/viewer-navigation-adapter.ts:435-450`). Annotation navigation now follows the same rule before calling `captureLocation` (`apps/web/src/review/navigation-coordinator.ts:770-772`). The rapid-click regression delays the first apply and its rollback, verifies the second apply does not start early, and then confirms history contains the original location and the second annotation—not the transient first destination (`apps/web/test/navigation-coordinator.test.ts:757-805`).

Operation-token checks complete the guarantee: a stale first click cannot complete its history transaction after a newer click supersedes it (`apps/web/src/review/navigation-coordinator.ts:1035-1044`; `apps/web/src/review/navigation-coordinator.ts:1064-1068`).

## Prevention

1. Route every Meaningful Jump through `NavigationCoordinator`. UI components should provide semantic page and anchor data instead of calling viewer scrolling capabilities directly.
2. Record navigation history as a request/completion transaction. Capture the origin before applying, and append the destination only after a current operation produces a settled location.
3. Await rollback before capturing a superseding origin. Initiating cancellation is not the same as completing cancellation when the viewport must be restored.
4. Test both ordinary traversal and interruption. Keep one regression for Back/Forward semantics and another with deferred promises for rapid supersession (`apps/web/test/navigation-coordinator.test.ts:739-805`).
5. Keep a browser-level assertion on both button state and page movement so a visually correct direct-scroll shortcut cannot silently bypass history (`test/acceptance/production-flow.spec.ts:1293-1318`).

## Related Issues

- [Prevent Send-to-Main viewport rebound during Reference workspace reflow](send-to-main-viewport-rebound.md) — companion guidance for coordinated Main Reading Thread navigation and asynchronous viewport ownership.
- [Reliable compact right-docked Reference Tabs](reliable-compact-right-docked-reference-tabs.md) — transaction safety when physical viewport state must settle before capture.
- [Adaptive Annotation Tray framing](../architecture-patterns/adaptive-annotation-tray-framing.md) — distinguishes automatic tray framing from explicit annotation selection; only the latter is a Meaningful Jump.
- [Outline-aware annotation workspace presentation](../design-patterns/outline-aware-annotation-workspace-presentation.md) — defines the owned and Existing PDF Annotation populations governed by this navigation rule.

This solution is pending in unmerged [PR #34](https://github.com/brad-ross/placekeeper/pull/34) as of 2026-08-14.
