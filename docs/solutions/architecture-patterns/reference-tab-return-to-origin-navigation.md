---
title: Return-to-origin navigation for stateful PDF Reference Tabs
date: 2026-08-18
last_updated: 2026-09-10
category: architecture-patterns
module: PDF reference navigation and viewer framing
problem_type: architecture_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "A Reference Tab must retain an immutable semantic origin while its settled viewport changes through exploration"
  - "A return control should appear only after manual scrolling moves the semantic target outside the usable PDF viewport"
  - "Reference navigation must remain isolated from the Main Reading Thread and browser URL history"
  - "Asynchronous return work can be superseded by tab switches, document replacement, or newer navigation"
  - "A compact icon-only viewer overlay must remain discoverable to assistive technology and pointer users"
related_components:
  - "NavigationCoordinator"
  - "ReferenceWorkspace"
  - "viewer-navigation-adapter"
  - "Main Reading Thread"
  - "testing_framework"
tags:
  - "reference-tabs"
  - "return-to-origin"
  - "pdf-navigation"
  - "navigation-coordinator"
  - "semantic-visibility"
  - "manual-scroll-intent"
  - "main-history-isolation"
  - "accessible-overlays"
---

# Return-to-origin navigation for stateful PDF Reference Tabs

## Context

A Reference Tab has two legitimate meanings of “where it belongs.” Its origin is the semantic PDF target that created the tab, while its settled view is the latest physical location at which the viewer successfully landed. The model keeps these meanings separate as immutable `originalTarget` and mutable `settledLocation` (`apps/web/src/review/reference-navigation-state.ts`). Opening a tab initializes both; later refreshes replace only `settledLocation` (`apps/web/src/review/reference-navigation-state.ts`).

That split supports a local return-to-origin affordance without introducing another navigation stack. The implementation merged in [PR #39](https://github.com/brad-ross/placekeeper/pull/39) on 2026-08-18. The durable lesson is broader: secondary-viewer recovery should restore a semantic destination through the application's navigation authority while keeping transient visibility, input intent, and focus state out of durable routing.

Cross-engine iteration showed that timing adjustments and synthetic viewport movement were not enough to prove user-caused scrolling. Native Reference scroll observation paired with real wheel input made the causal contract testable instead (session history).

## Guidance

### Keep the origin immutable and the restorable view mutable

Treat the target that opened a Reference Tab as immutable for that tab's lifetime. Continue updating its settled snapshot after verified navigation. The reducer does this by copying the tab with a new `settledLocation`, leaving `originalTarget` and identity unchanged (`apps/web/src/review/reference-navigation-state.ts`).

Do not store whether the return control is visible, pending, or retryable in `ReferenceTab`. Those are properties of the current mounted viewer. Keep them in transient presentation state keyed by tab identity and document generation (`apps/web/src/review/navigation-coordinator.ts`).

### Route the return through the navigation transaction authority

The return action is a guarded navigation transaction, not a React callback that changes `scrollTop`. `NavigationCoordinator` is the sole authority for current-document viewer navigation, reducer mutations, focus, visibility, and announcements (`apps/web/src/review/navigation-coordinator.ts`).

The transaction validates active tab identity, document generation, availability, and pending state; settles layout; reapplies `originalTarget` using `reference-fit-width`; captures the verified result; and dispatches one `refresh-active-reference` update (`apps/web/src/review/navigation-coordinator.ts`). It does not invoke Main navigation or browser-location history, so the Main Reading Thread's page, zoom, scroll, URL, and Back/Forward entries remain unchanged.

### Ask the viewer adapter whether the semantic target is visible

React should not reconstruct PDF geometry from page elements. The viewer adapter already owns target resolution, rotation, crop coordinates, viewport geometry, runway, and virtualization, so it exposes a semantic `targetVisibility` query (`apps/web/src/pdf/viewer-navigation-adapter.ts`).

Use three outcomes:

- `visible`: the resolved semantic anchor is inside the usable viewport.
- `outside`: the target is valid but its page is unmounted or its anchor is offscreen.
- `unavailable`: the target, page tree, or geometry cannot be trusted.

The adapter resolves the author target before transforming its anchor into client space and applying the configured tolerance (`apps/web/src/pdf/viewer-navigation-adapter.ts`). An unmounted valid page is `outside`, not invalid, which is essential for virtualized PDFs.

### Establish drift only from Reference-scoped manual intent

A scroll notification does not prove the user scrolled. Opens, restores, zoom, layout reflow, and target application can all move the viewport. Arm a Reference-only observer from inputs capable of scrolling that portaled viewport, capture the baseline position, and consume the intent only when the Reference document emits its next scroll notification (`apps/web/src/pdf/reference-manual-scroll.ts`). Read the committed position on the next frame and publish only when it changed (`apps/web/src/pdf/reference-manual-scroll.ts`).

Keep that observation channel separate from the generic viewer interaction stream. Generic `scroll` events refresh the Main location, while Reference manual scrolling calls the coordinator through a dedicated callback (`apps/web/src/app/ProductionReviewApp.tsx`). Forwarding Reference scrolling through the Main channel would violate URL and history ownership.

Programmatic Reference movement clears manual intent before and after target application (`apps/web/src/review/navigation-coordinator.ts`). `clear()` must also invalidate callbacks already scheduled for a later frame; the observer uses a separate cancellation generation so disposed-viewer observations cannot publish into a replacement lifecycle (`apps/web/src/pdf/reference-manual-scroll.ts`).

### Guard asynchronous completion and define focus outcomes

Operation token, document generation, tab identity, and adapter identity protect different race axes. The coordinator checks the exact adapter after the awaited apply because a viewer can be disposed and replaced without changing the active tab (`apps/web/src/review/navigation-coordinator.ts`). Do not collapse these checks into one generic “current” flag.

On success, commit the new settled view, remove the transient control, announce completion, and focus the returned page (`apps/web/src/review/navigation-coordinator.ts`). On failure, leave durable tab state unchanged, clear pending state, and keep the retry path available (`apps/web/src/review/navigation-coordinator.ts`).

The viewer-local control can remain icon-only while retaining `Return to reference` as its accessible name and the custom tooltip supplied by `ReviewTooltipButton` (`apps/web/src/review/ReferenceWorkspace.tsx`). Use `aria-disabled` rather than native `disabled` when pending work must preserve focus for a failed retry; guard repeat activation explicitly and restore focus only when it otherwise fell back to no connected target (`apps/web/src/review/ReferenceWorkspace.tsx`).

## Why This Matters

This partition prevents three forms of corruption:

1. Exploration cannot overwrite the canonical destination because only `settledLocation` changes.
2. Reference recovery cannot create a Main Meaningful Jump or mutate browser history because the coordinator commits only Reference state.
3. Reflow and programmatic restoration cannot manufacture a return control because availability requires both scoped manual movement and semantic target visibility.

It also makes lifecycle behavior explicit. A tab can remain selected while its adapter changes, a document can be replaced while layout settles, and a deferred scroll observation can outlive the viewer that produced it. Each boundary needs its own cancellation evidence.

Accessibility is part of the transaction contract rather than decoration: pending remains understandable and non-activating, success moves focus to the restored content, and failure leaves a usable retry control.

## When to Apply

Use this pattern when a secondary virtualized document viewer has a durable semantic origin but permits local exploration. It is especially useful when the surface can dock or reflow and shares a global router or history owner with a primary workspace.

Use a physical scroll bookmark only when offsets themselves are the product contract and the viewport cannot be recreated. Use global browser history only when returning from the secondary view is intentionally a global navigation event.

## Examples

### Manual-drift sequence

1. Capture a scroll-capable input inside the Reference portal with the current Reference viewport position.
2. Consume it only for a Reference-document scroll notification.
3. On the next frame, require an actual position change and a still-current observation.
4. Ask whether the immutable origin is `visible`, `outside`, or `unavailable`.
5. Show the affordance only for `outside`; clear it whenever the origin becomes visible again (`apps/web/src/review/navigation-coordinator.ts`).

### Return transaction

1. Validate tab identity, document generation, availability, and pending state.
2. Mark transient presentation pending without changing durable tab or Main state.
3. Settle layout and apply `originalTarget` with Reference Fit Width.
4. Reject completion if the operation, document, tab, origin identity, or adapter changed.
5. Capture the applied view and refresh only `settledLocation`.
6. Clear the overlay, announce success, and focus the destination page.

## Related

- [Reliable compact right-docked Reference Tabs](../ui-bugs/reliable-compact-right-docked-reference-tabs.md) — establishes the semantic-origin versus physical-snapshot split used by ordinary tab restoration.
- [Prevent Send-to-Main viewport rebound](../ui-bugs/send-to-main-viewport-rebound.md) — companion guidance for ordered coordinator transactions across Reference teardown and Main navigation.
- [Preserve document history for Annotation Tray navigation](../ui-bugs/preserve-document-history-for-annotation-tray-navigation.md) — contrasting case where an explicit Main destination should become a Meaningful Jump.
- [Adaptive Annotation Tray framing](adaptive-annotation-tray-framing.md) — separates interface-driven reflow from user-owned viewer movement.
- [Reloadable local review URL authority boundaries](reloadable-local-review-url-authority-boundaries.md) — defines Main URL and browser-history ownership.
- [WebKit recoverable Reference flow acceptance test](../test-failures/webkit-recoverable-reference-flow-acceptance-test.md) — cross-engine guidance for portal, focus, and recoverable Reference flows.
- [Contextual Annotation Composer preserves document context during authoring](../design-patterns/contextual-annotation-composer-preserves-document-context-during-authoring.md) — adapts the immutable-origin, semantic-visibility, and outside-only target-control pattern to a frozen draft anchor in the Main viewer.
- [Reference destination return plan](../../plans/2026-08-17-1129-feat-reference-destination-return-plan.md)
