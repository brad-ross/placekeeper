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

The implementation keeps the PDF full-stage and mounts the review workspace `<aside>` continuously. Open state and presentation are independent: the same aside uses `data-workspace-open` for disclosure and `data-workspace-presentation` for right-drawer versus bottom-sheet geometry (`apps/web/src/review/ReferenceWorkspace.tsx:236-251`). CSS hides and reshapes that same element rather than replacing the review tree (`apps/web/src/app/review-layout-annotations.css:158-256`). The production test carries mount probes and zoom state through right-to-bottom-to-right transitions (`test/acceptance/production-flow.spec.ts:1848-2055`).

Earlier design and validation sessions exposed several tempting approaches that violated that contract (session history):

- A permanent annotation rail taxed the reading surface even when annotations were not in use.
- A pure overlay kept the viewer stable but left part of a zoomed page covered and awkward to reach.
- Resizing the viewer, changing its grid column, or adding layout padding risked invoking fit/recenter behavior and changing the apparent page geometry.
- Revealing the whole page on general open over-corrected when much of the page was already outside the pre-open viewport.
- A latest-delta-only restore model lost the original reading baseline after target or presentation changes.
- Click-away dismissal made ordinary PDF clicks, panning, selection drags, and pointer sequences compete with workspace closure.

## Guidance

### Separate geometry policy, viewer capabilities, and orchestration

Keep geometry decisions in pure functions. `chooseAnnotationPresentation` evaluates the width remaining after a prospective drawer and applies hysteresis before returning from bottom sheet to right drawer (`apps/web/src/pdf/viewer-framing.ts:233-249`). `revealDelta` returns the smallest signed correction that exposes a target interval, including nearer-edge behavior when the target is larger than the visible interval (`apps/web/src/pdf/viewer-framing.ts:210-230`). `restoreViewportPosition` resolves horizontal and vertical ownership independently and clamps to natural scroll limits (`apps/web/src/pdf/viewer-framing.ts:251-274`).

Keep viewer-library access behind a project-owned adapter. `ViewerFramingControls` exposes only snapshots, temporary runway, scrolling, zoom-event subscription, and disposal (`apps/web/src/pdf/viewer-framing.ts:135-158`). The EmbedPDF adapter obtains scoped viewport, scroll, and zoom capabilities from the registry (`apps/web/src/pdf/viewer-framing-adapter.ts:33-55`) and performs movement through the public viewport API (`apps/web/src/pdf/viewer-framing-adapter.ts:129-143`). Shell code should consume this contract rather than query EmbedPDF internals.

Keep the lifecycle in one framing owner. `useWorkspaceFraming` owns stage and surface refs, responsive presentation, open-source requests, user-intent transfer, asynchronous authority, and close restoration behind a small shell-facing contract (`apps/web/src/review/use-annotation-tray-framing.ts:66-88`, `apps/web/src/review/use-annotation-tray-framing.ts:285-501`).

### Choose the presentation from the actual stage

Observe the review stage rather than the browser window. The hook attaches a `ResizeObserver` to the stage, measures its current bounds, computes the prospective drawer width, and feeds the measured width into the hysteretic presentation decision (`apps/web/src/review/use-annotation-tray-framing.ts:100-132`). This gives browser, Codex, VS Code, and split-pane embeds the same policy even when the window width is not the usable reader width.

Track height even though it does not choose right versus bottom. A bottom sheet's occlusion changes after a height-only resize, so `stageSize.height` retriggers framing (`apps/web/src/review/use-annotation-tray-framing.ts:105-132`, `apps/web/src/review/use-annotation-tray-framing.ts:476-488`). Mark-triggered openings are re-revealed against the sheet's new top edge; general bottom-sheet openings remain vertically neutral because vertical correction is limited to mark requests (`apps/web/src/review/use-annotation-tray-framing.ts:433-443`).

### Add overflow runway without participating in layout

Expose stable semantic hooks for the framing viewport, content root, and runway. The runway is an invisible, noninteractive, absolutely positioned child that extends beyond content by the requested right or bottom amount (`apps/web/src/pdf/PdfWorkspace.tsx:408-420`). Because it is absolute, it increases scroll extent without entering the centered page layout or shrinking the viewer's client box.

The adapter updates the runway, waits for layout to settle, and then snapshots geometry for correction and clamping (`apps/web/src/pdf/viewer-framing-adapter.ts:117-127`). It scopes page and owned-mark queries to the viewer root, computes maximum scroll from scroll extent minus client extent, and removes runway on disposal (`apps/web/src/pdf/viewer-framing-adapter.ts:70-113`, `apps/web/src/pdf/viewer-framing-adapter.ts:148-154`).

This is the central pattern: create reachability with temporary overflow capacity, not with a new layout constraint on the stateful viewer.

### Frame according to why the tray opened

Do not center universally.

- On a general Annotations-button open, snapshot before adding runway and intersect the current page rectangle with the pre-open viewport. Reveal only the portion of that already-visible reading context that the right drawer would cover (`apps/web/src/review/use-annotation-tray-framing.ts:292-300`, `apps/web/src/review/use-annotation-tray-framing.ts:409-431`). A general bottom-sheet open makes no vertical correction (`apps/web/src/review/use-annotation-tray-framing.ts:433-443`).
- On a mark-triggered open, carry the canonical review ID and page index in the request (`apps/web/src/review/use-annotation-tray-framing.ts:44-46`). Measure every rendered segment with that ID, union the rectangles, and reveal the union with a small gutter (`apps/web/src/pdf/viewer-framing-adapter.ts:70-83`, `apps/web/src/review/use-annotation-tray-framing.ts:409-443`).

Clamp each destination to measured limits and skip automatic movement on axes already owned by the user (`apps/web/src/review/use-annotation-tray-framing.ts:446-467`). The production test derives the exact horizontal overlap and requires that only this amount moves while page width, vertical position, and zoom remain unchanged (`test/acceptance/production-flow.spec.ts:1885-1919`).

### Treat each open interval as a framing session

At the first valid open, capture document identity, baseline scroll, zero automatic displacement, unowned axes, presentation, and request token (`apps/web/src/review/use-annotation-tray-framing.ts:343-355`). When presentation or target changes, remove the prior automatic component before adopting a new baseline (`apps/web/src/review/use-annotation-tray-framing.ts:356-385`). Record automatic displacement per axis relative to that baseline (`apps/web/src/review/use-annotation-tray-framing.ts:446-464`).

User navigation transfers ownership component by component. The hook marks only newly owned axes, supersedes in-flight automatic work, and stops native smooth scrolling at the current position (`apps/web/src/review/use-annotation-tray-framing.ts:223-269`). Zoom claims both axes because it can reframe both dimensions (`apps/web/src/review/use-annotation-tray-framing.ts:278-283`).

Every asynchronous operation carries document and session generations. `FramingSessionAuthority` invalidates stale work on new sessions, user navigation, cleanup, or document changes (`apps/web/src/pdf/viewer-framing.ts:299-369`). The hook checks authority after awaited runway layout and during close (`apps/web/src/review/use-annotation-tray-framing.ts:298-341`, `apps/web/src/review/use-annotation-tray-framing.ts:401-407`, `apps/web/src/review/use-annotation-tray-framing.ts:471-475`).

On close, restore the baseline only on untouched axes that received automatic movement. Preserve current positions on user-owned axes. Calculate restoration, remove runway, then clamp against the natural no-runway maximum (`apps/web/src/review/use-annotation-tray-framing.ts:302-341`). The rule is simple to explain: undo only what the interface did.

### Keep document gestures independent from workspace dismissal

Do not make ordinary interaction with the PDF a workspace-dismiss gesture. The current shell keeps the workspace open across PDF clicks, text selection, panning, wheel scrolling, and multi-pointer sequences. Pointer capture records scroll movement only to transfer framing ownership to the reviewer; it does not cancel the target event or close the workspace (`apps/web/src/app/ReviewShell.tsx:796-860`). Closure remains an explicit edge-rail or keyboard action (`apps/web/src/app/ReviewShell.tsx:616-620`, `apps/web/src/app/ReviewShell.tsx:755-770`).

This policy removes an ambiguous gesture classifier from the document surface and preserves native PDF interaction. The installed-viewer tests assert that clicking and dragging in the PDF leave the workspace open, that no synthetic `pointercancel` is dispatched, and that the explicit References control closes it (`test/acceptance/production-flow.spec.ts:2057-2205`).

### Contain viewer layers before assigning component order

Gesture policy cannot correct a hit-test target that has already escaped its visual workspace. Give the Main Reading Thread an explicit stacking root, then order drawer and contextual hosts as sibling surfaces. Internal PDF z-index values should order render, selection, and link layers only inside that root; they must not compete numerically with outer workspace hosts (`apps/web/src/app/review-layout-foundation.css:346-438`, `apps/web/src/pdf/PdfLinkControl.tsx:150-160`).

For overlap regressions, create real intersecting geometry and verify the browser's target with `document.elementFromPoint`. A screenshot or a comparison of declared z-index values cannot prove pointer routing after transforms, portals, and viewer annotation layers are combined (`test/acceptance/production-flow.spec.ts:843-905`).

### Test the pattern in layers

Use three complementary levels:

1. Pure unit tests for minimum reveal, rectangle intersection/union, hysteresis, per-axis restoration, clamping, and stale-token invalidation (`apps/web/test/viewer-framing.test.ts:22-220`).
2. Shell-level acceptance tests for toggle behavior, mounted drafts, mark activation, list correspondence, explicit dismissal, and focus restoration (`test/acceptance/review-workflow.spec.ts`).
3. Installed-style browser tests against real EmbedPDF geometry for zoomed oversized pages, temporary runway, right/bottom presentation changes, height-only resizing, user-owned close behavior, document-gesture preservation, stacking and hit testing, and stable mount/zoom state (`test/acceptance/production-flow.spec.ts:843-905`, `test/acceptance/production-flow.spec.ts:1848-2205`). Run the geometry-sensitive scenarios in both Chromium and WebKit.

## Why This Matters

The pattern preserves three independent invariants: the annotation surface stays anchored to a predictable edge, the PDF remains the same mounted and zoomed viewer, and user navigation stays authoritative. Temporary runway solves reachability without changing fit geometry. Minimal reveal spends existing margin before introducing movement. Source-specific framing makes mark activation precise without making ordinary tray opening disruptive. Per-axis ownership makes close behavior intelligible and prevents the interface from rewinding user navigation.

It also keeps responsive behavior in one application tree. The same aside and viewer transition between right drawer and bottom sheet while retaining active annotation, draft, zoom, and mount state (`test/acceptance/production-flow.spec.ts:2034-2045`). Reduced-motion preference changes automatic scrolling from smooth to immediate (`apps/web/src/review/use-annotation-tray-framing.ts:465-467`) without changing the state contract.

## When to Apply

- A side or bottom inspector overlaps a zoomable, pannable, or otherwise stateful canvas and must open without replacing it.
- The feature runs in embeds or split panes where usable stage dimensions differ from the browser viewport.
- Covered content must remain reachable, while resizing the underlying viewer would alter fit, centering, zoom, or mount state.
- General inspection and object-triggered inspection need different framing targets.
- Automatic layout measurements and smooth scrolling can overlap live pan, scroll, zoom, or responsive transitions.

Prefer a simpler overlay when obscured content never needs to remain reachable. Prefer a genuinely docked layout when the inspector is persistently open by design and resizing the content is harmless.

## Examples

### General right-drawer open

If the pre-open viewport spans `x = 0..900`, the visible part of the current page spans `x = 100..820`, and the drawer begins at `x = 700`, frame the visible intersection and scroll right by only `120`. Do not center the page or reserve a permanent rail. The pure helper and production geometry tests encode this smallest-correction rule (`apps/web/test/viewer-framing.test.ts:109-112`, `test/acceptance/production-flow.spec.ts:1885-1919`).

### Multi-segment mark above a bottom sheet

One logical annotation may render as several line fragments. Union every fragment sharing its canonical review ID, then compare that union with the unobscured viewport ending at the sheet's top. Add a small gutter for clarity. Do not reveal only the activated fragment, and do not vertically move a general bottom-sheet opening (`apps/web/test/viewer-framing.test.ts:114-135`, `test/acceptance/production-flow.spec.ts:1987-2024`).

### Mixed automatic and user movement

If opening automatically moves `left` but not `top`, and the user then scrolls vertically, closing restores the original `left` and keeps the user's current `top`. If the user also pans horizontally, close keeps the current `left`, clamped after runway disappears. The restoration tests cover untouched, globally owned, and per-axis owned cases (`apps/web/test/viewer-framing.test.ts:144-188`).

### PDF interaction versus explicit close

A click, drag selection, scrollbar movement, wheel or touch scroll, secondary pointer, or zoom interaction belongs to the viewer and leaves the workspace open. The edge-rail control or Escape closes the workspace. Keeping those intents separate avoids suppressing native document events merely to infer whether a pointer sequence was a dismissal (`apps/web/src/app/ReviewShell.tsx:562-620`, `apps/web/src/app/ReviewShell.tsx:796-860`).

## Related

- [Contain main PDF link hit targets below the References viewer](../ui-bugs/pdf-link-hit-target-escapes-reference-viewer-stacking-context.md)
- [Adaptive annotation tray reflow plan](../../plans/2026-08-08-001-fix-adaptive-annotation-tray-reflow-plan.md)
- [Selected behavior visual reference](../../plans/assets/2026-08-08-adaptive-annotation-tray/selected-behavior.html)
- [Behavior alternatives visual reference](../../plans/assets/2026-08-08-adaptive-annotation-tray/behavior-options.html)
- [Reading-first PDF review interface plan](../../plans/2026-08-07-002-feat-reading-first-pdf-review-interface-plan.md)
