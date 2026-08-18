---
title: Preserve document history for Annotation Tray navigation
date: 2026-08-14
last_updated: 2026-08-17
category: ui-bugs
module: Annotation Tray navigation
problem_type: ui_bug
component: frontend_stimulus
severity: medium
symptoms:
  - "Activating an Owned Annotation or Existing PDF Annotation moved the Main Reading Thread, but Back did not restore the reader's prior location."
  - "A rapid second annotation activation could record the first in-flight destination as the history origin instead of preserving the original reading place."
  - "Repeating a boundary-clamped annotation could create an adjacent duplicate history stop, making the first Back action appear ineffective."
  - "A target jump superseding an in-flight annotation could capture the annotation's transient viewport before rollback completed."
root_cause: logic_error
resolution_type: code_fix
related_components:
  - "NavigationCoordinator"
  - "Main Reading Thread"
  - "Meaningful Jump"
  - "viewer-navigation-adapter"
  - "BrowserReviewLocationHistory"
  - "testing_framework"
tags:
  - "annotation-tray"
  - "pdf-navigation"
  - "document-history"
  - "meaningful-jump"
  - "navigation-coordinator"
  - "back-forward"
  - "async-cancellation"
  - "settled-no-op"
  - "browser-fragment-history"
---

# Preserve document history for Annotation Tray navigation

## Problem

Annotation rows in the workspace tray owned PDF scrolling directly. Selecting a row moved the Main Reading Thread to the annotation, but bypassed the document-navigation transaction that records a Meaningful Jump. The PDF moved while Back still had no origin to restore.

Merged [PR #34](https://github.com/brad-ross/placekeeper/pull/34) moved that responsibility into `NavigationCoordinator`. Both application-owned Review Items and read-only Existing PDF Annotations now send semantic page and point data through the same coordinated navigation path (`apps/web/src/app/ProductionReviewApp.tsx:990-1001`). The edge-case refinements documented below landed with that change.

The apparently simple change exposed three transaction edge cases. A repeated annotation request can differ from the captured viewport but still settle at that viewport because the viewer clamps coordinates near a page boundary. A successor started while an annotation jump is being cancelled can capture the annotation's transient viewport unless rollback completes first. Conversely, two distinct search occurrences may intentionally be separate history destinations even when viewer tolerances or boundary clamping give them identical settled coordinates.

## Symptoms

- Selecting a source annotation could move from page 1 to page 3 while leaving **Back in document history** disabled.
- After an annotation jump, the reader could not reliably return to the exact location occupied before opening the annotation.
- Repeating a boundary-clamped annotation could create an adjacent duplicate history stop, so Back appeared to do nothing before returning to the real origin.
- A second annotation click while the first jump was settling could record the first annotation's transient viewport as the new history origin.
- An outline/search-style target that superseded an in-flight annotation could likewise record the transient annotation viewport as its origin.
- A blanket “settled destination equals origin” filter would erase intentional history between distinct search occurrences.

The acceptance regression captures the visible contract: select a page-3 source annotation from page 1, observe Back become enabled, return to page 1, and then use Forward to revisit page 3 (`test/acceptance/production-flow.spec.ts:1293-1318`).

## What Didn't Work

The former implementation treated annotation activation as a presentation concern:

```ts
// Historical shape removed by PR #34.
scrollToPage({ pageNumber, pageCoordinates, alignX: 50, alignY: 35 });
```

That changed the viewport but never entered the coordinator's `request-main-jump` / `complete-main-jump` protocol. The reducer appends history only after a pending jump completes successfully, retaining both the captured origin and the settled destination (`apps/web/src/review/reference-navigation-state.ts:430-457`). A direct scroll cannot make Back and Forward truthful.

Routing clicks through a coordinator method was necessary but not sufficient for rapid clicks. `begin()` supersedes pending work by initiating cancellation (`apps/web/src/review/navigation-coordinator.ts:1058-1080`). If the cancelled viewer operation already changed the viewport, the adapter schedules an asynchronous rollback to its origin and exposes that rollback as a promise (`apps/web/src/pdf/viewer-navigation-adapter.ts:381-401`). Capturing the next origin before that promise settles can observe the transient first destination.

Session-history review exposed the remaining cross-entrypoint gap: annotation-to-annotation supersession honored the rollback barrier, while a target-style successor could capture immediately after merely initiating cancellation. (session history) Suppressing every completion whose settled coordinates equal its origin would also have been too broad. Ordinary annotation, direct, and outline jumps should not create an adjacent `[settled, settled]` entry after clamping, but distinct search identities carry semantic occurrence information that physical viewer coordinates cannot represent.

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

1. Begins a document-scoped operation and obtains the Main viewer (`apps/web/src/review/navigation-coordinator.ts:765-775`).
2. Awaits `cancelPendingNavigation`, re-checks operation currency, and only then captures the origin (`apps/web/src/review/navigation-coordinator.ts:776-782`).
3. Builds and validates a `PdfViewerLocation`, preserving current zoom and the established annotation alignment (`apps/web/src/review/navigation-coordinator.ts:783-799`).
4. Treats a semantic no-op as success without duplicate history; otherwise it applies the destination through the shared Main-jump transaction (`apps/web/src/review/navigation-coordinator.ts:800-812`).
5. On success, focuses the destination, announces it, and refreshes outline context (`apps/web/src/review/navigation-coordinator.ts:813-820`).

The shared transaction records the origin and requested destination, applies the movement, captures the settled location, and completes the reducer transaction (`apps/web/src/review/navigation-coordinator.ts:1026-1051`). The reducer applies the final history policy in two stages: non-forced requests that are already identical are ignored, and a non-forced completion that settles back at its captured origin clears the pending transaction without appending history (`apps/web/src/review/reference-navigation-state.ts:431-463`). The second check is essential because boundary clamping is only observable after the viewer applies the request.

Distinct search occurrences remain forced because their semantic identity is richer than physical viewer geometry. `navigateMainTarget` passes the force flag for search jumps, preserving separate occurrences even when the viewer settles in place (`apps/web/src/review/navigation-coordinator.ts:724-745`).

### Project semantic history into readable browser URLs

The reducer/viewer transaction remains the authority for whether a Main jump succeeded, but a top-level readable review uses browser session history as its traversal owner and projects each settled semantic destination there. After a successful explicit annotation, outline, search, or promoted-reference jump, the coordinator calls one shared projection seam that pushes a canonical page or portable-item fragment (`apps/web/src/review/navigation-coordinator.ts:880-903`, `apps/web/src/review/navigation-coordinator.ts:1191-1205`). Ordinary settled reading updates the current fragment with `replaceState`, avoiding a Back stop for every scroll or sequential page change (`apps/web/src/review/navigation-coordinator.ts:931-953`, `apps/web/src/review/review-location-history.ts:89-105`).

Back and Forward in that surface traverse native browser history. A `popstate` re-enters the coordinator, restores the page or portable item without pushing a second entry, and falls back to the page or page 1 when the semantic fragment is no longer valid (`apps/web/src/review/review-location-history.ts:63-81`, `apps/web/src/review/navigation-coordinator.ts:254-293`). Embedded surfaces without this adapter retain the reducer-backed traversal. Jump validation stays centralized while each mounted surface has one traversal owner.

## Why This Works

Back and Forward need two authoritative locations: the stable origin before a jump and the settled destination after it. `NavigationCoordinator` already owns this transaction for other Meaningful Jumps, so placing annotation activation behind the same boundary keeps viewport movement and history state atomic. The ordinary unit regression proves that a jump creates `[origin, annotation]`, Back reapplies the origin, and Forward reapplies the annotation (`apps/web/test/navigation-coordinator.test.ts:740-755`). A second regression proves that repeating a boundary-clamped annotation does not add `[settled, settled]` to history (`apps/web/test/navigation-coordinator.test.ts:758-785`).

The pre-apply and post-apply no-op checks protect different moments. The coordinator avoids work when the requested annotation already equals the captured location (`apps/web/src/review/navigation-coordinator.ts:800-805`); the reducer catches a request that looked different beforehand but was clamped back to the origin afterward (`apps/web/src/review/reference-navigation-state.ts:451-462`). Force remains a semantic exception: regressions preserve separate history entries for distinct search identities and for a distinct search occurrence that clamps to its origin (`apps/web/test/navigation-coordinator.test.ts:900-924`).

Waiting for cancellation protects the origin under concurrency. The viewer adapter itself waits for its rollback barrier before starting a new operation (`apps/web/src/pdf/viewer-navigation-adapter.ts:435-450`). Annotation and target navigation now follow the same rule before calling `captureLocation` (`apps/web/src/review/navigation-coordinator.ts:705-719`; `apps/web/src/review/navigation-coordinator.ts:765-778`). The rapid-click regression delays the first apply and its rollback, verifies the second annotation does not start early, and then confirms history contains the original location and the second annotation—not the transient first destination (`apps/web/test/navigation-coordinator.test.ts:787-835`). A mixed-operation regression proves that a succeeding outline/search-style target also waits for annotation rollback before capturing its origin (`apps/web/test/navigation-coordinator.test.ts:837-882`).

Operation-token checks complete the guarantee: a stale first click cannot complete its history transaction after a newer click supersedes it (`apps/web/src/review/navigation-coordinator.ts:1041-1050`; `apps/web/src/review/navigation-coordinator.ts:1064-1074`).

## Prevention

1. Route every Meaningful Jump through `NavigationCoordinator`. UI components should provide semantic page and anchor data instead of calling viewer scrolling capabilities directly.
2. Record navigation history as a request/completion transaction. Capture the origin before applying, and append the destination only after a current operation produces a settled location.
3. Await rollback before capturing a superseding origin. Initiating cancellation is not the same as completing cancellation when the viewport must be restored.
4. Apply no-op suppression at the correct layer. Use pre-apply location equivalence for already-current non-forced jumps and post-apply equivalence for clamped physical no-ops.
5. Keep a narrow semantic escape hatch for destinations whose identity is richer than viewer geometry. Search occurrences require forced history semantics; ordinary annotation, direct, and outline jumps do not.
6. Test the transaction matrix: ordinary Back/Forward traversal, repeated boundary-clamped destinations, rapid same-kind supersession, mixed-kind supersession, stale completion, and forced distinct occurrences (`apps/web/test/navigation-coordinator.test.ts:740-924`).
7. Keep a browser-level assertion on both button state and page movement so a visually correct direct-scroll shortcut cannot silently bypass history (`test/acceptance/production-flow.spec.ts:1293-1318`).
8. For readable browser reviews, assert URL-view convergence as well: ordinary reading replaces the fragment, each successful Meaningful Jump pushes once, and Back/Forward restoration does not recursively create entries (`apps/web/test/review-location-history.test.ts:64-121`, `test/acceptance/reloadable-links.spec.ts:31-111`).

## Related Issues

- [Prevent Send-to-Main viewport rebound during Reference workspace reflow](send-to-main-viewport-rebound.md) — companion guidance for coordinated Main Reading Thread navigation and asynchronous viewport ownership.
- [Reliable compact right-docked Reference Tabs](reliable-compact-right-docked-reference-tabs.md) — transaction safety when physical viewport state must settle before capture.
- [Adaptive Annotation Tray framing](../architecture-patterns/adaptive-annotation-tray-framing.md) — distinguishes automatic tray framing from explicit annotation selection; only the latter is a Meaningful Jump.
- [Outline-aware annotation workspace presentation](../design-patterns/outline-aware-annotation-workspace-presentation.md) — defines the owned and Existing PDF Annotation populations governed by this navigation rule.
- [Authority boundaries for reloadable local-review URLs](../architecture-patterns/reloadable-local-review-url-authority-boundaries.md) — defines the canonical fragment and refresh/reopen lifecycle that browser history projects.

The base annotation-history change and these edge-case refinements merged in [PR #34](https://github.com/brad-ross/placekeeper/pull/34) on 2026-08-15 UTC.
