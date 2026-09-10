---
title: Keep the insertion caret anchored while scrolling the PDF
date: 2026-08-24
last_updated: 2026-09-10
category: ui-bugs
module: PDF insertion caret projection
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Before the fix, scrolling after an insertion click left the caret at its old browser position while the PDF page moved beneath it."
  - "The regression manifested as visual caret drift even though the reviewer had not selected a new insertion location."
  - "The initial projection was correct, but the former implementation did not update it after viewport movement."
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - "Insertion Caret Anchor"
  - "Crop-relative Geometry"
  - "ViewerClientPlacement"
  - "LatestFrameRequest"
  - "testing_framework"
tags:
  - "pdf-caret"
  - "insertion-annotations"
  - "caret-projection"
  - "viewport-scroll"
  - "client-coordinates"
  - "crop-relative-geometry"
  - "animation-frame"
  - "regression-tests"
---

# Keep the insertion caret anchored while scrolling the PDF

## Problem

The PDF insertion caret mixed two coordinate systems with different lifetimes. A click produced a durable `CaretAnchor` containing a page index and PDF-space rectangle (`apps/web/src/pdf/selection-anchor.ts`), but the visual caret consumes client-space `left` and `top` values (`apps/web/src/review/ContextActionPalette.tsx`).

Those client coordinates depend on the page element's current DOM bounds. `caretClientPlacement` transforms the PDF rectangle and adds `pageBounds.left` and `pageBounds.top` (`apps/web/src/app/App.tsx`). Because the visual caret is `position: fixed` (`apps/web/src/app/review-layout-foundation.css`), retaining one client projection while the page scrolls changes the caret's apparent PDF location.

## Symptoms

- Before the fix, scrolling after a click between PDF glyphs left the caret at its old window position while the page moved underneath it.
- The durable Insertion Caret Anchor remained PDF-relative; the defect was visual projection drift rather than mutation of the underlying anchor.
- The failure could also depend on timing because `captureViewerCaret` awaits a page read before creating the anchor (`apps/web/src/pdf/viewer-selection-adapter.ts`).

## What Didn't Work

A one-time conversion from PDF space to client space was not sufficient. The conversion deliberately incorporates the page element's bounding rectangle, so its result is a snapshot of viewport geometry rather than durable document state. Feeding that snapshot to a fixed-position element cannot keep the caret attached to content after scrolling or relayout.

Refreshing only on scroll, page-change, and layout events also left an ordering hole. A refresh that ran while the asynchronous caret read was pending had no retained anchor to project. The successful publication itself needed to request one post-read refresh so the new anchor would be observed even when no later geometry event occurred.

## Solution

Retain the durable anchor and its latest client projection together. `publishCaret` updates `currentCaret` and `currentCaretPlacement` before it emits the interaction event (`apps/web/src/app/App.tsx`). This makes later geometry work start from PDF-space authority rather than from an old screen point.

Centralize reprojection in `caretPlacement`. It reads the current page element bounds and calls `caretClientPlacement` with the same anchor and current document geometry (`apps/web/src/app/App.tsx`). `refreshCaretPlacement` republishes only when the projected placement changed (`apps/web/src/app/App.tsx`).

Page, scroll, and layout events schedule that refresh through `LatestFrameRequest` (`apps/web/src/app/App.tsx`). The scheduler retains the latest request while one animation-frame callback is pending and clears pending work on cancellation (`apps/web/src/pdf/viewer-framing.ts`). This coalesces frequent scroll events and prevents a callback from surviving viewer teardown.

The asynchronous publication path schedules another refresh immediately after it retains a non-null caret (`apps/web/src/app/App.tsx`). Starting a text selection invalidates the pending caret read and clears the retained anchor and placement through the same publication path (`apps/web/src/app/App.tsx`), so a queued frame cannot restore stale insertion state.

The production acceptance test records the caret's coordinates relative to the PDF page, scrolls the framing viewport by 120 pixels, and requires the same page-relative offsets afterward (`test/acceptance/production-flow.spec.ts`). It then types and applies an insertion, proving that authoring remains usable after the geometry refresh (`test/acceptance/production-flow.spec.ts`).

## Why This Works

The anchor and placement now have appropriately different lifetimes. `CaretAnchor.position` remains in PDF space, while the browser coordinates are a disposable projection through current DOM geometry. Any event that can invalidate that projection requests recalculation, and animation-frame coalescing prevents scroll-event frequency from becoming render-event frequency.

The sequencing also covers deferred reads. A successful asynchronous result first becomes retained state and then requests a frame refresh, so the callback sees the newly available anchor. Conversely, selection clears retained state before a queued callback runs, and the null-anchor guard exits without restoring the caret (`apps/web/src/app/App.tsx`).

At the original 2026-08-24 documentation checkpoint, [PR #60](https://github.com/brad-ross/placekeeper/pull/60) was open.

## Prevention

- Treat PDF-space anchors as source-of-truth state and client coordinates as derived viewport state. Recompute fixed-position geometry from current page bounds instead of incrementally adjusting an old client point.
- When asynchronous work creates the durable state needed by an earlier event-driven refresh, schedule a refresh after publication as well as on the geometry event.
- Route high-frequency geometry invalidations through a cancellable latest-frame scheduler and cancel pending work during lifecycle teardown.
- Clear retained semantic state through the same publication path that creates it so queued projection work cannot resurrect a suppressed caret.
- Assert geometry in content-relative coordinates. Comparing `caret - page` before and after scrolling detects a caret fixed to the viewport even when absolute positions vary across browsers.
- Continue the user action after the geometry assertion. The regression should prove both stable placement and working insertion input.

## Related Issues

- [Restore insertion annotations on complex PDF pages](restore-insertion-annotations-on-complex-pdf-pages.md) covers the upstream problem of creating a trustworthy crop-relative caret anchor.
- [Contextual Annotation Composer preserves document context during authoring](../design-patterns/contextual-annotation-composer-preserves-document-context-during-authoring.md) covers the downstream authoring lifecycle after the caret exists.
- [Adaptive annotation tray framing without resizing the PDF viewer](../architecture-patterns/adaptive-annotation-tray-framing.md) documents the broader durable-state-versus-presentation-geometry pattern and the shared latest-frame scheduler.
- [Reject stale viewer selection snapshots before creating annotation anchors](reject-stale-viewer-selection-snapshots.md) covers the complementary asynchronous snapshot boundary for text selections.
- [Prevent Send-to-Main viewport rebound during Reference workspace reflow](send-to-main-viewport-rebound.md) covers a distinct viewer-motion defect caused by competing navigation and framing ownership.
- [PR #47](https://github.com/brad-ross/placekeeper/pull/47) introduced accurate initial PDF-to-client caret projection.
- [PR #60](https://github.com/brad-ross/placekeeper/pull/60) contains this projection-lifecycle fix.
