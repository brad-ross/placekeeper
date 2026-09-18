---
title: "Adaptive annotation tray framing without resizing the PDF viewer"
date: "2026-08-08"
last_updated: 2026-09-18
category: "architecture-patterns"
module: "PDF review annotation tray framing"
problem_type: "architecture_pattern"
component: "frontend_stimulus"
severity: "medium"
applies_when: ["An inset review surface overlays a mounted zoomable document", "Covered content must remain reachable without resizing the viewer", "Passive layout changes must preserve reading position", "Explicit navigation must supersede remembered manual position", "Animated overlays must publish committed rather than transformed occupancy"]
root_cause: "logic_error"
resolution_type: "code_fix"
related_components: ["PdfWorkspace", "ReviewShell", "ViewerFramingControls", "ViewerPositionAuthority", "ReferenceWorkspace", "OutlineAnnotationsWorkspace"]
tags: ["pdf-review", "annotation-tray", "viewer-framing", "scroll-runway", "responsive-overlay", "user-intent", "position-authority", "geometry-settlement"]
---

# Adaptive annotation tray framing without resizing the PDF viewer

## Context

The right workspace now reserves actual layout space beside the stateful PDF reader. Its left edge bounds the reading frame, and Fit width leaves a 24 px margin on each side of that frame, matching the right tray’s 12 px solid backing plus 12 px fade. This September 7 revision supersedes the right-overlay portion of the [earlier layout contract](../../plans/2026-09-05-neutral-soft-design-contract.md#accepted-overlay-layout-and-zoom-behavior). Bottom surfaces still overlay the full-height viewport and use runway; the collapsed rail reserves 40 px of layout width, with its 12 px fade inside the remaining viewport. Fit width uses 52 px on the left and 12 px on the right of that viewport, keeping the page centered across the full stage without synthetic horizontal runway. Horizontal scrolling is available only when the page content exceeds the scrollport. Opening bottom References alone does not refit the main document.

Workspace opening re-fits only when the PDF already matches Fit width in the closed reading frame. Other zoom levels remain unchanged as the workspace opens; closing, resizing, and docking remain passive. This September 8 policy supersedes both the September 7 always-fit-on-opening rule and the earlier no-fit-on-opening rule. The change is present in this checkout through [PR #90](https://github.com/brad-ross/placekeeper/pull/90), open and unmerged as of September 8, 2026. An eligible opening still waits for committed geometry and runway settlement; it does not establish continuous automatic fitting.

Changing scroll extent can provoke native anchoring or clamping. The implementation may therefore write the preserved offset back after layout; this correction does not reveal newly covered content.

## Guidance

### Separate reachability from page layout

Keep one native scrollport mounted at full stage width, including the rightmost scrollbar. The narrower `.review-document` supplies explicit `readingViewport` bounds to navigation and framing. Reserve the dock inside the scrollport with padding, subtracting the scrollbar width already included in that reservation; native padding also owns horizontal centering. Clip only the decorative overlay frame away from the scrollbar strip, so the thumb stays visible and interactive. Do not introduce a proxy scrollbar or a second scroll position.

For bottom overlays, add runway with an invisible, pointer-transparent, absolutely positioned element that extends scroll extent without entering page layout (`apps/web/src/pdf/PdfWorkspace.tsx`).

### Capture fit eligibility before disclosure

Checking whether the page is fitted after opening asks the wrong question: the narrower reading frame has already changed the fit target. Capture the predicate at the layout-action boundary before dispatch, then consume it once in the opening effect (`apps/web/src/app/ReviewShell.tsx`). Use the current geometric fit predicate, not the rounded toolbar percentage or a sticky “last command was Fit width” mode. The adapter compares numeric scale with the width target for the visible page and its rotation, allowing one rendered page-width pixel of difference (`apps/web/src/pdf/viewer-navigation-adapter.ts`).

The animation investigation originally exercised automatic opening fits from low manual zoom. That policy was subsequently rejected: ordinary opening must preserve manual scale. The underlying fit-transaction protections still matter for explicit Fit width. Do not restore the discarded policy while reusing those regression scenarios.

### Commit resting occupancy, not animation frames

A right dock contributes zero horizontal runway because CSS already reserves its width and outside inset. Derive remaining overlay runway from each logically open surface's untransformed offset geometry. The collapsed right rail also uses actual layout space and contributes no horizontal runway. Share these constants with the painted overlay geometry so Fit width and the visible boundary agree. Current occupancy includes the outer backing and fade: the clear boundary is the surface's resting start minus the framing policy's backing and fade allowances, and the runway extends from that boundary to the stage edge. Combine same-edge surfaces by maximum extent, not sum (`apps/web/src/review/use-annotation-tray-framing.ts`). This is more precise than treating runway as the tray width alone, especially for inset overlays.

Record the requested runway before awaiting its DOM settlement. Otherwise a superseding effect can encounter already-mutated DOM with an old committed-runway reference and begin another transition from a stale position. Retain a matching transition's original position across replacement effects (`apps/web/src/review/use-annotation-tray-framing.ts`, `apps/web/src/pdf/viewer-framing.ts`).

### Keep hidden tray dimensions ready for motion

A hidden mounted tray still needs its eventual dimensions. Preserve the configured reference width and bottom height independently of open state; logical visibility determines occupancy, not whether those sizes exist (`apps/web/src/review/reference-workspace-layout.ts`). When bottom References is open, apply the shorter right-workspace bottom inset in `wide-bottom` as well as `wide-split`, so the workspace already has the correct height before it slides in (`apps/web/src/app/review-layout-annotations.css`). Animating `bottom` alone merely animates an unnecessary resize if the hidden starting dimensions are wrong.

### Preserve user intent through temporary clamps

`ViewerPositionAuthority` stores the desired user position per axis separately from a passive transition's sampled position. Its returned position clamps either the remembered user value or the transition baseline to the current measured maximum (`apps/web/src/pdf/viewer-framing.ts`). Shrinking runway may make a position temporarily impossible; growing it can make the remembered position reachable again, unless a new fit or navigation request supersedes that position. This is not restoration of an old automatic reveal.

Native wheel inertia and keyboard scrolling can continue after the initiating event. Renew the quiet-frame capture on each scroll event; reject older capture tokens so an early sample cannot replace the final offset (`apps/web/src/review/use-annotation-tray-framing.ts`, `apps/web/src/pdf/viewer-framing.ts`). Identify automatic-scroll targets separately so their intermediate events do not become user-owned movement (`apps/web/src/review/use-annotation-tray-framing.ts`).

A control click that changes layout commits current position and invalidates passive work that sampled before the interaction. Merely incrementing the user revision is insufficient if a replacement effect starts afterward with an older transition baseline. The hook also advances the layout operation generation; the authority clears pending captures and transitions without erasing an unclamped desired value merely because its current clamped value matches (`apps/web/src/review/use-annotation-tray-framing.ts`, `apps/web/src/pdf/viewer-framing.ts`). Workspace mode selection performs this commit before dispatching its layout change (`apps/web/src/app/ReviewShell.tsx`).

### Give explicit navigation its own authority

Ordinary reading requests and presentation changes are not reveal requests. The hook reveals only an open-workspace mark request with a token that has not already been consumed; after user interruption it consumes that request without executing its reveal (`apps/web/src/review/use-annotation-tray-framing.ts`). Explicit mark preparation clears remembered position and cancels the previous smooth reveal at its current offset (`apps/web/src/review/use-annotation-tray-framing.ts`). Document replacement also clears old position authority, whereas a same-document controls handoff settles pending user axes and invalidates stale captures (`apps/web/src/pdf/viewer-framing.ts`).

### Await both geometry and runway settlement

Transition settlement alone does not prove the scroll limits are ready. `waitForSettledGeometry` waits for current surface geometry and the current runway promise, and checks both identities before returning an authority token (`apps/web/src/review/use-annotation-tray-framing.ts`). The layout effect checks cancellation and operation generation after asynchronous boundaries, and suppresses stale correction when the user revision changes (`apps/web/src/review/use-annotation-tray-framing.ts`). Zoom advances user authority without republishing unchanged runway geometry, which would invalidate Fit width's own settlement token (`apps/web/src/review/use-annotation-tray-framing.ts`).

Two unchanged frames and an empty transition-event ledger do not establish settlement: a CSS transition can be pending before `transitionrun` arrives. Inspect pending or running animations on both trays and the reading viewport while waiting, and recheck them when validating the returned token (`apps/web/src/review/use-annotation-tray-framing.ts`, `apps/web/src/pdf/viewer-framing.ts`). Event-end handling and quiet-frame counting alone admitted a fit against intermediate geometry.

### Withhold dependent overlays until their geometry is ready

[PR #121](https://github.com/brad-ross/placekeeper/pull/121), open as of 2026-09-18, applies settlement to annotation cards and editors as well as PDF navigation. Correct final coordinates do not excuse a visible frame at the fallback position. An overlay needs its own measured size and current passage bounds before it can be positioned, so conditional mounting or `display: none` can make measurement depend on the very visibility decision it is meant to establish.

Keep the surface mounted for measurement, but choose its hidden state according to its interaction needs. A passive Reference inspection can remain `visibility: hidden` and pointer-inert until placement exists. A composer must accept keyboard input immediately: it stays at `opacity: 0` with pointer events disabled, while its textarea receives layout-effect focus using `preventScroll`. The same editor becomes visible after placement resolves. Deferring focus or mounting would weaken keyboard readiness; ordinary focus at provisional coordinates can scroll the PDF before the editor appears (`apps/web/src/app/ReviewShell.tsx`, `apps/web/src/review/CommentComposer.tsx`).

Placement is valid for a request and a coordinate scope, not merely for an annotation ID. The placement snapshot carries the anchor key and Main/Reference scope; a mismatch makes it unavailable. The shell supplies the authoring token and surface-specific target selectors, and layout changes trigger fresh measurement. This prevents a prior Main placement from becoming the first visible position of a Reference editor (`apps/web/src/review/use-passage-editor-placement.ts`, `apps/web/src/app/ReviewShell.tsx`). Derive visible anchors from rendered fragments and intersect them with the usable viewport. Durable PDF coordinates identify a passage; they do not replace client geometry when placing its popup or selection toolbar.

Closing the last workspace has an additional boundary. Logical closure starts an animation; it does not mean that the PDF reading frame and runway have settled. Derive the close edge during render so the first closing commit already suppresses Main cards, then maintain that gate until `waitForSettledGeometry` returns current authority. Abort the waiter on reopen or cleanup, and do not let an obsolete close expose a card over the reopened tray. Preserve the selected annotation during the close control's outside-click handling so the final card can be reconstructed after settlement (`apps/web/src/app/ReviewShell.tsx`, `workspaceCloseAllowsMainPeek` and `activeAnnotationShouldDismissForClick`).

These gates solve different races. A resolved overlay measurement cannot make a still-moving PDF anchor final, and a settled workspace cannot make an unmeasured editor positioned. Reuse the framing settlement primitive rather than adding an arbitrary delay to either path. The [composer guide](../design-patterns/contextual-annotation-composer-preserves-document-context-during-authoring.md) separately owns the draft and recovery lifetime.

### Verify the first visible frame and the input lifetime

Start frame probes before the triggering click. Record computed visibility and opacity, placement kind, origin relationship, bounds, and pending or running workspace animations. Reject an unresolved or wrong-surface first position, not just an incorrect endpoint. For editors, start the probe before the click, enter text before stopping and reading it, and verify focus, value, and PDF/window scroll survive the first positioned paint. For tray close, require no visible card during motion and no card from an interrupted close (`test/acceptance/annotation-behavior-followup.spec.ts`, `test/acceptance/reference-annotations.spec.ts`).

Cover normal motion, immediate reopen, resize during close, and reduced motion. Reduced motion removes transitions on the relevant workspace and viewport surfaces, but the correctness gate must still hold without relying on an observed animation. Reference text fragments may also settle after glyph alignment, so do not mistake every later subpixel adjustment for an unresolved first placement. These browser probes measure browser-visible layout, not a separate native compositor's pixels; use native-surface evidence when investigating a native paint failure.

### Commit scale and anchor together; validate the captured page

A correct final fit does not prove a flash-free fit. The investigation exposed a new page width painted with the old scroll offset before the correct anchor arrived. The adapter synchronously commits the zoom request, immediately positions the fitted page, and only then awaits completion; it retains the ResizeObserver and unchanged-scale fallback (`apps/web/src/pdf/viewer-navigation-adapter.ts`). Waiting longer after zoom can conceal this frame from an endpoint assertion but cannot stop it painting.

A later rollback can look like the same flash. In a tall window with bottom References, the native current-page indicator can change during zoom because it considers content behind the tray. Fit acceptance therefore verifies the captured page's width, clear-frame edges, and anchor under the current operation, rather than requiring the native indicator to stay on that page (`apps/web/src/pdf/viewer-navigation-adapter.ts`). Substituting a fresh most-visible-page check would retain the same mistaken assumption: page proportions can legitimately change during zoom. Preserve cancellation and real geometry-failure rollback.

## Why This Matters

Several plausible fixes address only one layer. Removing the old automatic reveal does not prevent native anchoring. Remembering only the currently clamped offset loses the user's desired pan. Sampling only the initiating gesture misses inertia. Waiting for tray transitions misses runway settlement. Updating the committed extent after the awaited DOM mutation allows replacement effects to recreate stale baselines. Treating every scroll event as user intent lets automatic correction contaminate position memory.

The solution therefore separates three authorities: committed occupancy controls reachability, explicit navigation owns a new target, and user motion owns durable position. Passive layout corrects native side effects against those authorities rather than inventing another target. This reasoning is embodied in the authority tests and the real-viewer overlay scenario, not in the legacy open/restore helpers that still exist in the geometry module (`apps/web/test/viewer-framing.test.ts`, `test/acceptance/production-flow.spec.ts`).

## When to Apply

Use this pattern when an inspector overlays a stateful, zoomable document or canvas, covered content must remain reachable, and responsive changes or transitions can overlap navigation. Keep committed extent, painted geometry, asynchronous settlement, and navigation intent separate. For a docked surface that intentionally resizes the content, establish that different contract explicitly rather than importing this overlay policy accidentally.

## Examples

An ordinary right workspace reduces the reading-frame width. If the PDF was fitted to the closed frame, opening performs one Fit width after settlement. At 60% or 200% manual zoom, the same opening preserves scale throughout the animation. Closing and reopening does not discard manual zoom, including when bottom References is already open.

A reviewer pans to horizontal offset 40 while runway is available. A passive layout change can reduce the natural maximum to zero, so the visible offset becomes zero while the desired offset remains 40. A later passive expansion restores 40 if reachable. An eligible workspace-opening fit or explicit navigation clears that memory and establishes a new position instead.

A mark target is explicitly revealed above a bottom sheet. A later height-only resize may cover it again, but it does not reissue the consumed mark request: the current reading offset is preserved. Another explicit target request may reveal again (`test/acceptance/production-flow.spec.ts`).

For animation regressions, sample intermediate page and tray bounds rather than checking only final screenshots. Cover normal motion and reduced motion, References open and closed, standard and tall viewports, already-fitted opening, and manual opening below and above normal scale (`test/acceptance/host-interface.spec.ts`, `test/acceptance/production-flow.spec.ts`). Standard-height checks missed the native-indicator rollback; reproducing the user's taller viewport exposed it. The adapter unit regression retains that acceptance rule even though manual low-zoom opening no longer invokes a fit (`apps/web/test/viewer-navigation.test.ts`).

Related: [Pointer-anchored zoom](../ui-bugs/pointer-anchored-zoom-across-custom-viewer-geometry.md) covers ownership across zoom commits. [Prevent Send-to-Main viewport rebound](../ui-bugs/send-to-main-viewport-rebound.md) addresses explicit navigation authority. The [earlier adaptive reflow plan](../../plans/2026-08-08-001-fix-adaptive-annotation-tray-reflow-plan.md) is historical; its automatic opening reveal and reversal are not current acceptance requirements.
