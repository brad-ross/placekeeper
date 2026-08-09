---
title: Adaptive annotation tray framing without resizing the PDF viewer
date: 2026-08-08
category: architecture-patterns
module: PDF review annotation tray framing
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - An overlay can occlude a mounted, scrollable document or canvas
  - The available reading area changes with a stage-local responsive threshold
  - Automatic reveal must yield to user pan, scroll, or zoom intent
  - An external viewer API must remain isolated from shell presentation state
related_components:
  - PdfWorkspace
  - ReviewShell
  - ViewerFramingControls
  - annotation drawer
tags:
  - pdf-review
  - annotation-tray
  - adaptive-layout
  - viewer-framing
  - scroll-runway
  - responsive-overlay
  - user-intent
---

# Adaptive annotation tray framing without resizing the PDF viewer

## Context

An annotation surface over a PDF is not an ordinary drawer. It shares space with a stateful, zoomable document whose reading position is itself user state. Opening the surface must expose annotations without remounting or resizing the viewer, cover as little of the current reading context as possible, and distinguish movement performed by the interface from movement the reviewer performs while the surface is open.

The implementation keeps the PDF full-stage and mounts the annotation `<aside>` continuously. Open state and presentation are independent: the same aside uses `data-list-open` for disclosure and `data-annotation-presentation` for right-drawer versus bottom-sheet geometry (`apps/web/src/app/ReviewShell.tsx:688-753`). CSS hides and reshapes that same element rather than replacing the review tree (`apps/web/src/app/review-layout.css:270-314`). The production test carries a mount probe and zoom value through right-to-bottom-to-right transitions (`test/acceptance/production-flow.spec.ts:427-438`).

Earlier design and validation sessions exposed several tempting approaches that violated that contract (session history):

- A permanent annotation rail taxed the reading surface even when annotations were not in use.
- A pure overlay kept the viewer stable but left part of a zoomed page covered and awkward to reach.
- Resizing the viewer, changing its grid column, or adding layout padding risked invoking fit/recenter behavior and changing the apparent page geometry.
- Revealing the whole page on general open over-corrected when much of the page was already outside the pre-open viewport.
- A latest-delta-only restore model lost the original reading baseline after target or presentation changes.
- A distance-only click-away rule confused scrollbar movement, panning, selection drags, and pointer sequences with dismissal taps.

## Guidance

### Separate geometry policy, viewer capabilities, and orchestration

Keep geometry decisions in pure functions. `chooseAnnotationPresentation` evaluates the width remaining after a prospective drawer and applies hysteresis before returning from bottom sheet to right drawer (`apps/web/src/pdf/viewer-framing.ts:118-134`). `revealDelta` returns the smallest signed correction that exposes a target interval, including nearer-edge behavior when the target is larger than the visible interval (`apps/web/src/pdf/viewer-framing.ts:94-116`). `restoreViewportPosition` resolves horizontal and vertical ownership independently and clamps to natural scroll limits (`apps/web/src/pdf/viewer-framing.ts:136-159`).

Keep viewer-library access behind a project-owned adapter. `ViewerFramingControls` exposes only snapshots, temporary runway, scrolling, zoom-event subscription, and disposal (`apps/web/src/pdf/viewer-framing.ts:25-43`). The EmbedPDF adapter obtains scoped viewport, scroll, and zoom capabilities from the registry (`apps/web/src/pdf/viewer-framing-adapter.ts:33-55`) and performs movement through the public viewport API (`apps/web/src/pdf/viewer-framing-adapter.ts:129-132`). Shell code should consume this contract rather than query EmbedPDF internals.

Keep the lifecycle in one framing owner. `useAnnotationTrayFraming` owns stage and drawer refs, responsive presentation, open-source requests, user-intent transfer, asynchronous authority, and close restoration behind a small shell-facing contract (`apps/web/src/review/use-annotation-tray-framing.ts:38-51`, `apps/web/src/review/use-annotation-tray-framing.ts:249-256`).

### Choose the presentation from the actual stage

Observe the review stage rather than the browser window. The hook attaches a `ResizeObserver` to the stage, measures its current bounds, computes the prospective drawer width, and feeds the measured width into the hysteretic presentation decision (`apps/web/src/review/use-annotation-tray-framing.ts:63-90`). This gives browser, Codex, VS Code, and split-pane embeds the same policy even when the window width is not the usable reader width.

Track height even though it does not choose right versus bottom. A bottom sheet's occlusion changes after a height-only resize, so `stageSize.height` retriggers framing (`apps/web/src/review/use-annotation-tray-framing.ts:57-83`, `apps/web/src/review/use-annotation-tray-framing.ts:247`). Mark-triggered openings are re-revealed against the sheet's new top edge; general bottom-sheet openings remain vertically neutral because vertical correction is limited to mark requests (`apps/web/src/review/use-annotation-tray-framing.ts:222-231`).

### Add overflow runway without participating in layout

Expose stable semantic hooks for the framing viewport, content root, and runway. The runway is an invisible, noninteractive, absolutely positioned child that extends beyond content by the requested right or bottom amount (`apps/web/src/pdf/PdfWorkspace.tsx:315-327`). Because it is absolute, it increases scroll extent without entering the centered page layout or shrinking the viewer's client box.

The adapter updates the runway, waits for layout to settle, and then snapshots geometry for correction and clamping (`apps/web/src/pdf/viewer-framing-adapter.ts:117-127`). It scopes page and owned-mark queries to the viewer root, computes maximum scroll from scroll extent minus client extent, and removes runway on disposal (`apps/web/src/pdf/viewer-framing-adapter.ts:70-113`, `apps/web/src/pdf/viewer-framing-adapter.ts:137-143`).

This is the central pattern: create reachability with temporary overflow capacity, not with a new layout constraint on the stateful viewer.

### Frame according to why the tray opened

Do not center universally.

- On a general Annotations-button open, snapshot before adding runway and intersect the current page rectangle with the pre-open viewport. Reveal only the portion of that already-visible reading context that the right drawer would cover (`apps/web/src/review/use-annotation-tray-framing.ts:127-133`, `apps/web/src/review/use-annotation-tray-framing.ts:201-221`). A general bottom-sheet open makes no vertical correction (`apps/web/src/review/use-annotation-tray-framing.ts:222-231`).
- On a mark-triggered open, carry the canonical review ID and page index in the request (`apps/web/src/review/use-annotation-tray-framing.ts:25-27`). Measure every rendered segment with that ID, union the rectangles, and reveal the union with a small gutter (`apps/web/src/pdf/viewer-framing-adapter.ts:70-83`, `apps/web/src/review/use-annotation-tray-framing.ts:213-230`).

Clamp each destination to measured limits and skip automatic movement on axes already owned by the user (`apps/web/src/review/use-annotation-tray-framing.ts:233-241`). The production test derives the exact horizontal overlap and requires that only this amount moves while page width, vertical position, and zoom remain unchanged (`test/acceptance/production-flow.spec.ts:298-328`).

### Treat each open interval as a framing session

At the first valid open, capture document identity, baseline scroll, zero automatic displacement, unowned axes, presentation, and request token (`apps/web/src/review/use-annotation-tray-framing.ts:160-172`). When presentation or target changes, remove the prior automatic component before adopting a new baseline (`apps/web/src/review/use-annotation-tray-framing.ts:173-190`). Record automatic displacement per axis relative to that baseline (`apps/web/src/review/use-annotation-tray-framing.ts:233-238`).

User navigation transfers ownership component by component. The hook marks only newly owned axes, supersedes in-flight automatic work, and stops native smooth scrolling at the current position (`apps/web/src/review/use-annotation-tray-framing.ts:97-112`). Zoom claims both axes because it can reframe both dimensions (`apps/web/src/review/use-annotation-tray-framing.ts:114-119`).

Every asynchronous operation carries document and session generations. `FramingSessionAuthority` invalidates stale work on new sessions, user navigation, cleanup, or document changes (`apps/web/src/pdf/viewer-framing.ts:165-223`). The hook checks authority after awaited runway layout and during close (`apps/web/src/review/use-annotation-tray-framing.ts:135-158`, `apps/web/src/review/use-annotation-tray-framing.ts:192-200`, `apps/web/src/review/use-annotation-tray-framing.ts:245-247`).

On close, restore the baseline only on untouched axes that received automatic movement. Preserve current positions on user-owned axes. Calculate restoration, remove runway, then clamp against the natural no-runway maximum (`apps/web/src/review/use-annotation-tray-framing.ts:135-158`). The rule is simple to explain: undo only what the interface did.

### Make light dismissal coexist with document gestures

Click-away semantics need a gesture classifier, not a bare document click handler. Track only a primary left-button pointer outside the drawer and review chrome (`apps/web/src/app/ReviewShell.tsx:500-515`). Disqualify dismissal permanently when travel exceeds tap slop or viewer scroll changes; transfer ownership for any scrolled axes (`apps/web/src/app/ReviewShell.tsx:516-546`).

For a genuine short tap, dispatch `pointercancel` to the original target before closing and suppress the following click so the underlying PDF action cannot fire (`apps/web/src/app/ReviewShell.tsx:548-588`). Keep nested annotation editors and review chrome exempt. Record the actual mark or toolbar opener and restore focus with scroll prevention when the tray closes.

### Test the pattern in layers

Use three complementary levels:

1. Pure unit tests for minimum reveal, rectangle intersection/union, hysteresis, per-axis restoration, clamping, and stale-token invalidation (`apps/web/test/viewer-framing.test.ts:12-85`).
2. Shell-level acceptance tests for toggle behavior, no persistent close button, mounted drafts, mark activation, list correspondence, light dismissal, and focus restoration (`test/acceptance/review-workflow.spec.ts`).
3. Installed-style browser tests against real EmbedPDF geometry for zoomed oversized pages, temporary runway, right/bottom presentation changes, height-only resizing, user-owned close behavior, gesture arbitration, and stable mount/zoom state (`test/acceptance/production-flow.spec.ts:260-444`, `test/acceptance/production-flow.spec.ts:446-533`). Run the geometry-sensitive scenarios in both Chromium and WebKit.

## Why This Matters

The pattern preserves three independent invariants: the annotation surface stays anchored to a predictable edge, the PDF remains the same mounted and zoomed viewer, and user navigation stays authoritative. Temporary runway solves reachability without changing fit geometry. Minimal reveal spends existing margin before introducing movement. Source-specific framing makes mark activation precise without making ordinary tray opening disruptive. Per-axis ownership makes close behavior intelligible and prevents the interface from rewinding user navigation.

It also keeps responsive behavior in one application tree. The same aside and viewer transition between right drawer and bottom sheet while retaining active annotation, draft, zoom, and mount state (`test/acceptance/production-flow.spec.ts:427-438`). Reduced-motion preference changes automatic scrolling from smooth to immediate (`apps/web/src/review/use-annotation-tray-framing.ts:239-242`) without changing the state contract.

## When to Apply

- A side or bottom inspector overlaps a zoomable, pannable, or otherwise stateful canvas and must open without replacing it.
- The feature runs in embeds or split panes where usable stage dimensions differ from the browser viewport.
- Covered content must remain reachable, while resizing the underlying viewer would alter fit, centering, zoom, or mount state.
- General inspection and object-triggered inspection need different framing targets.
- Automatic layout measurements and smooth scrolling can overlap live pan, scroll, zoom, or responsive transitions.

Prefer a simpler overlay when obscured content never needs to remain reachable. Prefer a genuinely docked layout when the inspector is persistently open by design and resizing the content is harmless.

## Examples

### General right-drawer open

If the pre-open viewport spans `x = 0..900`, the visible part of the current page spans `x = 100..820`, and the drawer begins at `x = 700`, frame the visible intersection and scroll right by only `120`. Do not center the page or reserve a permanent rail. The pure helper and production geometry tests encode this smallest-correction rule (`apps/web/test/viewer-framing.test.ts:13-16`, `test/acceptance/production-flow.spec.ts:314-328`).

### Multi-segment mark above a bottom sheet

One logical annotation may render as several line fragments. Union every fragment sharing its canonical review ID, then compare that union with the unobscured viewport ending at the sheet's top. Add a small gutter for clarity. Do not reveal only the activated fragment, and do not vertically move a general bottom-sheet opening (`apps/web/test/viewer-framing.test.ts:18-23`, `test/acceptance/production-flow.spec.ts:380-425`).

### Mixed automatic and user movement

If opening automatically moves `left` but not `top`, and the user then scrolls vertically, closing restores the original `left` and keeps the user's current `top`. If the user also pans horizontally, close keeps the current `left`, clamped after runway disappears. The restoration tests cover untouched, globally owned, and per-axis owned cases (`apps/web/test/viewer-framing.test.ts:48-70`).

### Tap outside versus pan outside

A primary down/up pair within tap slop and with no scroll change is a light-dismiss tap. A drag beyond slop, scrollbar movement, wheel or touch scroll, secondary pointer, or zoom interaction belongs to the viewer and leaves the tray open. Pointer travel alone is insufficient because a scroll container can move while the pointer remains nearly stationary (`apps/web/src/app/ReviewShell.tsx:500-588`).

## Related

- [Adaptive annotation tray reflow plan](../../plans/2026-08-08-001-fix-adaptive-annotation-tray-reflow-plan.md)
- [Selected behavior visual reference](../../plans/assets/2026-08-08-adaptive-annotation-tray/selected-behavior.html)
- [Behavior alternatives visual reference](../../plans/assets/2026-08-08-adaptive-annotation-tray/behavior-options.html)
- [Reading-first PDF review interface plan](../../plans/2026-08-07-002-feat-reading-first-pdf-review-interface-plan.md)
