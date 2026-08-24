---
title: Adaptive annotation tray framing without resizing the PDF viewer
date: 2026-08-08
last_updated: 2026-08-24
category: architecture-patterns
module: PDF review annotation tray framing
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - An overlay can occlude a mounted, scrollable document or canvas
  - The available reading area changes with a stage-local responsive threshold
  - Automatic reveal must yield to user pan, scroll, or zoom intent
  - An animated overlay must reserve its resting extent without publishing transformed transition-frame geometry
  - An external viewer API must remain isolated from shell presentation state
root_cause: logic_error
resolution_type: code_fix
related_components:
  - PdfWorkspace
  - ReviewShell
  - ViewerFramingControls
  - ReferenceWorkspace
  - OutlineAnnotationsWorkspace
tags:
  - pdf-review
  - annotation-tray
  - adaptive-layout
  - viewer-framing
  - scroll-runway
  - responsive-overlay
  - transition-geometry
  - reduced-motion
  - user-intent
---

# Adaptive annotation tray framing without resizing the PDF viewer

## Context

An annotation surface over a PDF is not an ordinary drawer. It shares space with a stateful, zoomable document whose reading position is itself user state. Opening the surface must expose annotations without remounting or resizing the viewer, cover as little of the current reading context as possible, and distinguish movement performed by the interface from movement the reviewer performs while the surface is open.

The implementation keeps the PDF full-stage while coordinating two persistent workspace surfaces: `ReferenceWorkspace` owns References and `OutlineAnnotationsWorkspace` owns Outline, Search, and Annotations (`apps/web/src/app/ReviewShell.tsx:1631-1649`, `apps/web/src/app/ReviewShell.tsx:1706-1827`, `apps/web/src/review/OutlineAnnotationsWorkspace.tsx:113-200`). Disclosure and presentation remain independent, so right-drawer and bottom-sheet geometry can change without rebuilding the PDF viewer or its review state. Production coverage carries mount probes and zoom state through responsive transitions (`test/acceptance/production-flow.spec.ts:3488-3831`).

Annotation authoring now adds a temporary presentation to that same edge host without becoming another framing owner. The Contextual Annotation Composer takes over the visible edge while the underlying workspaces remain mounted and inert; its rectangle is published as occlusion for frozen-anchor visibility and Return to annotation, not as animated PDF runway input (`apps/web/src/app/ReviewShell.tsx:416-452`, `apps/web/src/app/ReviewShell.tsx:1496-1532`, `apps/web/src/app/ReviewShell.tsx:1706-1827`, `apps/web/src/app/ProductionReviewApp.tsx:748-788`). Closing authoring restores the displaced workspace snapshot rather than reconstructing or reframing it (`apps/web/src/app/ReviewShell.tsx:931-960`, `apps/web/src/app/ReviewShell.tsx:1010-1095`).

Earlier design and validation sessions exposed several tempting approaches that violated that contract (session history):

- A permanent annotation rail taxed the reading surface even when annotations were not in use.
- A pure overlay kept the viewer stable but left part of a zoomed page covered and awkward to reach.
- Resizing the viewer, changing its grid column, or adding layout padding risked invoking fit/recenter behavior and changing the apparent page geometry.
- Revealing the whole page on general open over-corrected when much of the page was already outside the pre-open viewport.
- A latest-delta-only restore model lost the original reading baseline after target or presentation changes.
- Click-away dismissal made ordinary PDF clicks, panning, selection drags, and pointer sequences compete with workspace closure.
- Reading a transformed tray's `getBoundingClientRect()` on every transition frame made visual interpolation a stream of PDF runway inputs. Stabilizing only the tray was also insufficient: installed-build profiling then exposed a stationary edge toggle and a visible gap during motion.
- Reusing the right drawer's horizontal closed transform for the bottom sheet moved the sheet along the wrong axis. Resting-state checks missed this class of failure because the intermediate frames still converged to the correct final geometry.

## Guidance

### Separate geometry policy, viewer capabilities, and orchestration

Keep geometry decisions in pure functions. `chooseAnnotationPresentation` evaluates the width remaining after a prospective drawer and applies hysteresis before returning from bottom sheet to right drawer (`apps/web/src/pdf/viewer-framing.ts:233-249`). `revealDelta` returns the smallest signed correction that exposes a target interval, including nearer-edge behavior when the target is larger than the visible interval (`apps/web/src/pdf/viewer-framing.ts:210-230`). `restoreViewportPosition` resolves horizontal and vertical ownership independently and clamps to natural scroll limits (`apps/web/src/pdf/viewer-framing.ts:251-274`).

Keep viewer-library access behind a project-owned adapter. `ViewerFramingControls` exposes only snapshots, temporary runway, scrolling, zoom-event subscription, and disposal (`apps/web/src/pdf/viewer-framing.ts:135-158`). The EmbedPDF adapter obtains scoped viewport, scroll, and zoom capabilities from the registry (`apps/web/src/pdf/viewer-framing-adapter.ts:33-55`) and performs movement through the public viewport API (`apps/web/src/pdf/viewer-framing-adapter.ts:129-143`). Shell code should consume this contract rather than query EmbedPDF internals.

Keep the lifecycle in one framing owner. `useWorkspaceFraming` owns the stage plus both workspace-surface refs, responsive presentation, open-source requests, user-intent transfer, asynchronous authority, and close restoration behind a small shell-facing contract (`apps/web/src/review/use-annotation-tray-framing.ts:89-103`, `apps/web/src/review/use-annotation-tray-framing.ts:105-234`, `apps/web/src/review/use-annotation-tray-framing.ts:241-303`, `apps/web/src/review/use-annotation-tray-framing.ts:305-511`). The shell feeds it the combined occupied geometry instead of asking either workspace to frame the viewer alone (`apps/web/src/app/ReviewShell.tsx:1631-1649`, `apps/web/src/app/ReviewShell.tsx:1706-1827`, `apps/web/src/review/use-annotation-tray-framing.ts:417-424`).

Keep session validity distinct from geometry settlement. `LatestFrameRequest` coalesces resize, mutation, and transition signals; `ViewerGeometrySettlementAuthority` waits until active surface transitions finish; and geometry revisions plus the shell's `layoutGeneration` retrigger only current framing work (`apps/web/src/pdf/viewer-framing.ts:34-132`, `apps/web/src/review/use-annotation-tray-framing.ts:157-234`, `apps/web/src/review/use-annotation-tray-framing.ts:494-511`). A session token alone cannot prove that the rectangles it is about to consume have settled.

### Choose the presentation from the actual stage

Observe the review stage rather than the browser window. The hook measures the stable stage bounds, computes the prospective side width, and feeds that width into the hysteretic presentation decision (`apps/web/src/review/use-annotation-tray-framing.ts:128-155`). This gives browser, Codex, VS Code, and split-pane embeds the same policy even when the window width is not the usable reader width.

Track height even though it does not choose right versus bottom. A bottom sheet's occlusion changes after a height-only resize, so stage height remains a framing dependency (`apps/web/src/review/use-annotation-tray-framing.ts:499-511`). Mark-triggered openings are re-revealed against the sheet's new top edge; general bottom-sheet openings remain vertically neutral because vertical correction is limited to mark requests (`apps/web/src/review/use-annotation-tray-framing.ts:442-467`).

### Add overflow runway without participating in layout

Expose stable semantic hooks for the framing viewport, content root, and runway. The runway is an invisible, noninteractive, absolutely positioned child that extends beyond content by the requested right or bottom amount (`apps/web/src/pdf/PdfWorkspace.tsx:457-469`). Because it is absolute, it increases scroll extent without entering the centered page layout or shrinking the viewer's client box.

The adapter updates the runway, waits for layout to settle, and then snapshots geometry for correction and clamping (`apps/web/src/pdf/viewer-framing-adapter.ts:70-154`). It scopes page and owned-mark queries to the viewer root, computes maximum scroll from scroll extent minus client extent, and removes runway on disposal.

This is the central pattern: create reachability with temporary overflow capacity, not with a new layout constraint on the stateful viewer.

### Separate committed occupancy from animated geometry

An animated tray has two valid coordinate systems with different consumers. Its transformed rectangle describes what is currently painted; its layout box describes the space the open state has committed to occupy. Viewer runway is layout state, so derive it from logical open state plus the surface's untransformed `offsetWidth` or `offsetHeight`, clamp it to the stage, and take the maximum when multiple surfaces share an edge (`apps/web/src/review/use-annotation-tray-framing.ts:44-65`). The stage itself may still use `getBoundingClientRect()` because it is the stable containing frame.

Commit that final runway before taking the snapshot used for reveal and clamping. The hook applies the stable extent, waits one guarded layout frame for WebKit scroll limits, then measures the viewer (`apps/web/src/review/use-annotation-tray-framing.ts:417-434`). Do not republish just because a transition is between frames: transition start and settlement remain geometry boundaries, while the transformed intermediate bounds never become runway dimensions (`apps/web/src/review/use-annotation-tray-framing.ts:157-225`). Once closing begins, geometry revisions are excluded from the effect dependency so they cannot supersede restoration of the reading anchor (`apps/web/src/review/use-annotation-tray-framing.ts:494-511`).

This distinction prevents a feedback loop in which each painted frame changes scroll extent, the viewer reacts, and the next frame is measured against a moving document system. Use transformed bounds only when the consumer truly needs the instantaneous painted rectangle, such as hit testing or collision detection.

### Move the workspace and edge toggle as one surface

Anchor the edge rail once and animate it with the same duration, easing, and axis as the workspace. The rail travels by the exact configured workspace extent, while the workspace travels 102% so it fully clears the stage edge: horizontal for the right presentation and vertical for the bottom presentation (`apps/web/src/app/review-layout-annotations.css:69-101`, `apps/web/src/app/review-layout-annotations.css:259-266`). The bottom tools workspace therefore needs its own vertical hidden transform instead of inheriting the generic horizontal one. Opening makes visibility available at the start of the transform so the initial frames render rather than remain hidden (`apps/web/src/app/review-layout-annotations.css:241-244`).

Judge resting spacing against the visible glyph, not the larger transparent hit target. With the rail anchored at the stage edge and the 22px glyph centered inside it, the right presentation has equal top/right glyph margins and the bottom presentation has equal left/bottom margins, whether the reference edge is the stage or the open workspace (`apps/web/src/app/review-layout-annotations.css:69-112`).

Reduced Motion removes both halves of the coordinated disclosure. The responsive stylesheet disables transitions and animations for the rail and workspace surfaces, while the framing hook changes automatic viewer scrolling from smooth to immediate (`apps/web/src/app/review-layout-responsive.css:215-237`, `apps/web/src/review/use-annotation-tray-framing.ts:469-490`). Occupancy still commits correctly; only spatial interpolation disappears.

### Frame according to why the tray opened

Do not center universally.

- On a general Annotations-button open, snapshot before adding runway and intersect the current page rectangle with the pre-open viewport. Reveal only the portion of that already-visible reading context that the occupied right workspace would cover (`apps/web/src/review/use-annotation-tray-framing.ts:305-499`). A general bottom-sheet open makes no vertical correction.
- On a mark-triggered open, carry the canonical review ID and page index in the request. Measure every rendered segment with that ID, union the rectangles, and reveal the union with a small gutter (`apps/web/src/pdf/viewer-framing-adapter.ts:70-154`, `apps/web/src/review/use-annotation-tray-framing.ts:412-455`).

Clamp each destination to measured limits and skip automatic movement on axes already owned by the user. The production tests derive the exact overlap and require that only this amount moves while page width, vertical position, and zoom remain unchanged (`test/acceptance/production-flow.spec.ts:3337-3427`).

### Treat each open interval as a framing session

At the first valid open, capture document identity, baseline scroll, zero automatic displacement, unowned axes, presentation, and request token (`apps/web/src/review/use-annotation-tray-framing.ts:372-384`). When presentation or target changes, remove the prior automatic component before adopting a new baseline. Record automatic displacement per axis relative to that baseline (`apps/web/src/review/use-annotation-tray-framing.ts:474-487`).

User navigation transfers ownership component by component. The hook marks only the axes implicated by the current user intent, supersedes in-flight automatic work, and stops native smooth scrolling at the current position (`apps/web/src/review/use-annotation-tray-framing.ts:241-289`). Zoom claims both axes because it can reframe both dimensions (`apps/web/src/review/use-annotation-tray-framing.ts:298-303`).

Every asynchronous operation carries document and session generations. `FramingSessionAuthority` invalidates stale work on new sessions, user navigation, cleanup, or document changes (`apps/web/src/pdf/viewer-framing.ts:299-369`). The hook checks authority after awaited runway layout and during close (`apps/web/src/review/use-annotation-tray-framing.ts:353-370`, `apps/web/src/review/use-annotation-tray-framing.ts:417-430`, `apps/web/src/review/use-annotation-tray-framing.ts:494-498`).

On close, restore the baseline only on untouched axes that received automatic movement. Preserve current positions on user-owned axes. Calculate restoration, remove runway, then clamp against the natural no-runway maximum (`apps/web/src/review/use-annotation-tray-framing.ts:322-370`). The rule is simple to explain: undo only what the interface did.

### Keep document gestures independent from workspace dismissal

Do not make ordinary interaction with the PDF a workspace-dismiss gesture. The current shell keeps the workspace open across PDF clicks, text selection, panning, wheel scrolling, and multi-pointer sequences. Pointer capture records scroll movement only to transfer framing ownership to the reviewer; it does not cancel the target event or close the workspace (`apps/web/src/app/ReviewShell.tsx:1545-1576`). Closure remains an explicit edge-rail or keyboard action (`apps/web/src/app/ReviewShell.tsx:1204-1238`, `apps/web/src/app/ReviewShell.tsx:1414-1432`).

This policy removes an ambiguous gesture classifier from the document surface and preserves native PDF interaction. The installed-viewer tests assert that clicking and dragging in the PDF leave the workspace open, that no synthetic `pointercancel` is dispatched, and that explicit workspace controls close it (`test/acceptance/production-flow.spec.ts:3429-3498`).

### Contain viewer layers before assigning component order

Gesture policy cannot correct a hit-test target that has already escaped its visual workspace. Give the Main Reading Thread an explicit stacking root, then order drawer and contextual hosts as sibling surfaces. Internal PDF z-index values should order render, selection, and link layers only inside that root; they must not compete numerically with outer workspace hosts (`apps/web/src/app/review-layout-foundation.css:509-607`, `apps/web/src/pdf/PdfLinkControl.tsx:150-160`).

For overlap regressions, create real intersecting geometry and verify the browser's target with `document.elementFromPoint`. A screenshot or a comparison of declared z-index values cannot prove pointer routing after transforms, portals, and viewer annotation layers are combined (`test/acceptance/production-flow.spec.ts:1553-1616`).

### Test the pattern in layers

Use three complementary levels:

1. Pure unit tests for minimum reveal, rectangle intersection/union, hysteresis, per-axis restoration, clamping, and stale-token invalidation (`apps/web/test/viewer-framing.test.ts:22-220`).
2. Shell-level acceptance tests for toggle behavior, mounted drafts, mark activation, list correspondence, explicit dismissal, and focus restoration (`test/acceptance/review-workflow.spec.ts`).
3. Installed-style browser tests against real EmbedPDF geometry for zoomed oversized pages, temporary runway, right/bottom presentation changes, height-only resizing, user-owned close behavior, document-gesture preservation, stacking and hit testing, and stable mount/zoom state (`test/acceptance/production-flow.spec.ts:3103-3831`). Run the geometry-sensitive scenarios in both Chromium and WebKit.

For animation regressions, sample the whole transition rather than asserting only the endpoints. The right-drawer test records intermediate frames, requires the rail to follow the tray, and rejects every runway width between the closed and committed-open widths (`test/acceptance/production-flow.spec.ts:3103-3199`). The bottom-sheet test also keeps the tray's left edge fixed to the stage so vertical disclosure cannot drift sideways (`test/acceptance/production-flow.spec.ts:3201-3294`). Static CSS checks protect the orientation-specific transforms, and Reduced Motion coverage requires zero-duration disclosure for both the tray and rail (`apps/web/test/review-layout.test.tsx:659-675`, `test/acceptance/review-workflow.spec.ts:989-1002`).

## Why This Matters

The pattern preserves three independent invariants: the annotation surface stays anchored to a predictable edge, the PDF remains the same mounted and zoomed viewer, and user navigation stays authoritative. Temporary runway solves reachability without changing fit geometry. Minimal reveal spends existing margin before introducing movement. Source-specific framing makes mark activation precise without making ordinary tray opening disruptive. Per-axis ownership makes close behavior intelligible and prevents the interface from rewinding user navigation.

It also keeps responsive behavior in one application tree. The coordinated workspaces and viewer transition between right drawer and bottom sheet while retaining active annotation, draft, zoom, and mount state. Smoothness is therefore more than polish: it is evidence that animated presentation state is no longer being relayed into document geometry. Reduced-motion preference removes spatial interpolation without changing the committed occupancy or framing contract.

## When to Apply

- A side or bottom inspector overlaps a zoomable, pannable, or otherwise stateful canvas and must open without replacing it.
- The feature runs in embeds or split panes where usable stage dimensions differ from the browser viewport.
- Covered content must remain reachable, while resizing the underlying viewer would alter fit, centering, zoom, or mount state.
- A transformed drawer or sheet must reserve its final resting extent before its visual transition finishes.
- A toggle or handle should remain visually attached to a moving surface across orientation changes.
- General inspection and object-triggered inspection need different framing targets.
- Automatic layout measurements and smooth scrolling can overlap live pan, scroll, zoom, or responsive transitions.

Prefer a simpler overlay when obscured content never needs to remain reachable. Prefer a genuinely docked layout when the inspector is persistently open by design and resizing the content is harmless.

## Examples

### General right-drawer open

If the pre-open viewport spans `x = 0..900`, the visible part of the current page spans `x = 100..820`, and the drawer begins at `x = 700`, frame the visible intersection and scroll right by only `120`. Do not center the page or reserve a permanent rail. The pure helper and production geometry tests encode this smallest-correction rule (`apps/web/test/viewer-framing.test.ts:109-112`, `test/acceptance/production-flow.spec.ts:2005-2028`).

### Animated drawer with stable runway

If a right drawer is logically open and has a 384px layout width, set the PDF runway to 384px immediately, even while the drawer's transform paints it at an apparent width of 40px, 160px, or 300px. Animate the drawer and its edge rail through those visual positions, but never publish the intermediate painted widths to the viewer. For a bottom sheet, apply the same rule to height and move both elements on the vertical axis.

### Multi-segment mark above a bottom sheet

One logical annotation may render as several line fragments. Union every fragment sharing its canonical review ID, then compare that union with the unobscured viewport ending at the sheet's top. Add a small gutter for clarity. Do not reveal only the activated fragment, and do not vertically move a general bottom-sheet opening (`apps/web/test/viewer-framing.test.ts:114-135`, `test/acceptance/production-flow.spec.ts:2096-2133`).

### Mixed automatic and user movement

If opening automatically moves `left` but not `top`, and the user then scrolls vertically, closing restores the original `left` and keeps the user's current `top`. If the user also pans horizontally, close keeps the current `left`, clamped after runway disappears. The restoration tests cover untouched, globally owned, and per-axis owned cases (`apps/web/test/viewer-framing.test.ts:144-188`).

### PDF interaction versus explicit close

A click, drag selection, scrollbar movement, wheel or touch scroll, secondary pointer, or zoom interaction belongs to the viewer and leaves the workspace open. The edge-rail control or Escape closes the workspace. Keeping those intents separate avoids suppressing native document events merely to infer whether a pointer sequence was a dismissal (`apps/web/src/app/ReviewShell.tsx:1414-1432`, `apps/web/src/app/ReviewShell.tsx:1545-1576`).

## Related

- [Contain main PDF link hit targets below the References viewer](../ui-bugs/pdf-link-hit-target-escapes-reference-viewer-stacking-context.md)
- [Prevent Send-to-Main viewport rebound](../ui-bugs/send-to-main-viewport-rebound.md) — a related motion failure caused by stale navigation and framing ownership rather than transition-frame geometry.
- [Adaptive annotation tray reflow plan](../../plans/2026-08-08-001-fix-adaptive-annotation-tray-reflow-plan.md) — historical design exploration; its outside-tap dismissal rule was superseded by the explicit-close contract documented here.
- [Content-aware annotation workspace presentation](../design-patterns/outline-aware-annotation-workspace-presentation.md)
- [Contextual Annotation Composer preserves document context during authoring](../design-patterns/contextual-annotation-composer-preserves-document-context-during-authoring.md) — reuses the edge host without making its provisional preview or composer occlusion part of the runway authority.
- [Full Annotation Reader preserves Annotation Tray context](../design-patterns/full-annotation-reader-preserves-tray-context.md) — swaps list content inside this mounted tray and owns reader-specific overflow, identity, and restoration rather than viewer framing.
- [Selected behavior visual reference](../../plans/assets/2026-08-08-adaptive-annotation-tray/selected-behavior.html)
- [Behavior alternatives visual reference](../../plans/assets/2026-08-08-adaptive-annotation-tray/behavior-options.html)
- [Reading-first PDF review interface plan](../../plans/2026-08-07-002-feat-reading-first-pdf-review-interface-plan.md)
