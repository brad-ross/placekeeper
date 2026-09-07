---
title: "Adaptive annotation tray framing without resizing the PDF viewer"
date: "2026-08-08"
last_updated: "2026-09-07"
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

Workspace opening is a one-shot zoom request that waits for committed geometry and runway settlement. Closing, resizing, and docking remain passive changes that preserve scale and reading position subject to actual scroll limits. This September 7 policy supersedes the earlier no-fit-on-opening rule; it does not restore close-time zoom reversal or repeated fitting during resize.

Changing scroll extent can provoke native anchoring or clamping. The implementation may therefore write the preserved offset back after layout; this correction does not reveal newly covered content.

## Guidance

### Separate reachability from page layout

Keep one native scrollport mounted at full stage width, including the rightmost scrollbar. The narrower `.review-document` supplies explicit `readingViewport` bounds to navigation and framing. Reserve the dock inside the scrollport with padding, subtracting the scrollbar width already included in that reservation; native padding also owns horizontal centering. Clip only the decorative overlay frame away from the scrollbar strip, so the thumb stays visible and interactive. Do not introduce a proxy scrollbar or a second scroll position.

For bottom overlays, add runway with an invisible, pointer-transparent, absolutely positioned element that extends scroll extent without entering page layout (`apps/web/src/pdf/PdfWorkspace.tsx:550`).

### Commit resting occupancy, not animation frames

A right dock contributes zero horizontal runway because CSS already reserves its width and outside inset. Derive remaining overlay runway from each logically open surface's untransformed offset geometry. The collapsed right rail also uses actual layout space and contributes no horizontal runway. Share these constants with the painted overlay geometry so Fit width and the visible boundary agree. Current occupancy includes the outer backing and fade: the clear boundary is the surface's resting start minus the framing policy's backing and fade allowances, and the runway extends from that boundary to the stage edge. Combine same-edge surfaces by maximum extent, not sum (`apps/web/src/review/use-annotation-tray-framing.ts:47`). This is more precise than treating runway as the tray width alone, especially for inset overlays.

Record the requested runway before awaiting its DOM settlement. Otherwise a superseding effect can encounter already-mutated DOM with an old committed-runway reference and begin another transition from a stale position. Retain a matching transition's original position across replacement effects (`apps/web/src/review/use-annotation-tray-framing.ts:423`, `apps/web/src/pdf/viewer-framing.ts:252`).

### Preserve user intent through temporary clamps

`ViewerPositionAuthority` stores the desired user position per axis separately from a passive transition's sampled position. Its returned position clamps either the remembered user value or the transition baseline to the current measured maximum (`apps/web/src/pdf/viewer-framing.ts:166`, `apps/web/src/pdf/viewer-framing.ts:262`). Shrinking runway may make a position temporarily impossible; growing it can make the remembered position reachable again, unless a new fit or navigation request supersedes that position. This is not restoration of an old automatic reveal.

Native wheel inertia and keyboard scrolling can continue after the initiating event. Renew the quiet-frame capture on each scroll event; reject older capture tokens so an early sample cannot replace the final offset (`apps/web/src/review/use-annotation-tray-framing.ts:282`, `apps/web/src/review/use-annotation-tray-framing.ts:374`, `apps/web/src/pdf/viewer-framing.ts:202`). Identify automatic-scroll targets separately so their intermediate events do not become user-owned movement (`apps/web/src/review/use-annotation-tray-framing.ts:363`).

A control click that changes layout commits current position and invalidates passive work that sampled before the interaction. Merely incrementing the user revision is insufficient if a replacement effect starts afterward with an older transition baseline. The hook also advances the layout operation generation; the authority clears pending captures and transitions without erasing an unclamped desired value merely because its current clamped value matches (`apps/web/src/review/use-annotation-tray-framing.ts:327`, `apps/web/src/pdf/viewer-framing.ts:209`). Workspace mode selection performs this commit before dispatching its layout change (`apps/web/src/app/ReviewShell.tsx:1207`).

### Give explicit navigation its own authority

Ordinary reading requests and presentation changes are not reveal requests. The hook reveals only an open-workspace mark request with a token that has not already been consumed; after user interruption it consumes that request without executing its reveal (`apps/web/src/review/use-annotation-tray-framing.ts:408`, `apps/web/src/review/use-annotation-tray-framing.ts:455`). Explicit mark preparation clears remembered position and cancels the previous smooth reveal at its current offset (`apps/web/src/review/use-annotation-tray-framing.ts:293`). Document replacement also clears old position authority, whereas a same-document controls handoff settles pending user axes and invalidates stale captures (`apps/web/src/pdf/viewer-framing.ts:238`).

### Await both geometry and runway settlement

Transition settlement alone does not prove the scroll limits are ready. `waitForSettledGeometry` waits for current surface geometry and the current runway promise, and checks both identities before returning an authority token (`apps/web/src/review/use-annotation-tray-framing.ts:235`). The layout effect checks cancellation and operation generation after asynchronous boundaries, and suppresses stale correction when the user revision changes (`apps/web/src/review/use-annotation-tray-framing.ts:403`, `apps/web/src/review/use-annotation-tray-framing.ts:438`). Zoom advances user authority without republishing unchanged runway geometry, which would invalidate Fit width's own settlement token (`apps/web/src/review/use-annotation-tray-framing.ts:355`).

## Why This Matters

Several plausible fixes address only one layer. Removing the old automatic reveal does not prevent native anchoring. Remembering only the currently clamped offset loses the user's desired pan. Sampling only the initiating gesture misses inertia. Waiting for tray transitions misses runway settlement. Updating the committed extent after the awaited DOM mutation allows replacement effects to recreate stale baselines. Treating every scroll event as user intent lets automatic correction contaminate position memory.

The solution therefore separates three authorities: committed occupancy controls reachability, explicit navigation owns a new target, and user motion owns durable position. Passive layout corrects native side effects against those authorities rather than inventing another target. This reasoning is embodied in the authority tests and the real-viewer overlay scenario, not in the legacy open/restore helpers that still exist in the geometry module (`apps/web/test/viewer-framing.test.ts:191`, `apps/web/test/viewer-framing.test.ts:225`, `apps/web/test/viewer-framing.test.ts:258`, `test/acceptance/production-flow.spec.ts:4305`).

## When to Apply

Use this pattern when an inspector overlays a stateful, zoomable document or canvas, covered content must remain reachable, and responsive changes or transitions can overlap navigation. Keep committed extent, painted geometry, asynchronous settlement, and navigation intent separate. For a docked surface that intentionally resizes the content, establish that different contract explicitly rather than importing this overlay policy accidentally.

## Examples

An ordinary right workspace reduces the main viewport width and performs one Fit width with the 24 px margin after settlement. A later manual zoom remains unchanged through tray resizing or closing. Reopening requests a new fit.

A reviewer pans to horizontal offset 40 while runway is available. A passive layout change can reduce the natural maximum to zero, so the visible offset becomes zero while the desired offset remains 40. A later passive expansion restores 40 if reachable. A workspace-opening fit or explicit navigation clears that memory and establishes a new position instead.

A mark target is explicitly revealed above a bottom sheet. A later height-only resize may cover it again, but it does not reissue the consumed mark request: the current reading offset is preserved. Another explicit target request may reveal again (`test/acceptance/production-flow.spec.ts:4499`).

Related: [Prevent Send-to-Main viewport rebound](../ui-bugs/send-to-main-viewport-rebound.md) addresses explicit navigation authority. The [earlier adaptive reflow plan](../../plans/2026-08-08-001-fix-adaptive-annotation-tray-reflow-plan.md) is historical; its automatic opening reveal and reversal are not current acceptance requirements.
