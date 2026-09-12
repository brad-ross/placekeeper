---
title: "Pointer-anchored zoom across custom viewer geometry"
date: "2026-09-07"
last_updated: 2026-09-11
category: "ui-bugs"
module: "PDF viewer zoom and framing"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "PDF zoom moves the page point beneath the pointer when custom viewer padding changes."
  - "Committing PDF layout on every gesture event makes continuous zoom visibly coarse."
root_cause: "logic_error"
resolution_type: "code_fix"
tags:
  - "pdf-review"
  - "embedpdf"
  - "pointer-anchor"
  - "wheel-zoom"
  - "gesture-preview"
  - "viewer-framing"
  - "geometry-settlement"
---

# Pointer-anchored zoom across custom viewer geometry

## Problem

Smooth pointer-anchored zoom must reconcile two geometries: the page actually painted inside Placekeeper's dock-aware reading area, and the PDF library's numeric layout. Inspection of the installed zoom dependency during this session found a native gesture preview based on uniform viewport gaps and blending toward centering near fit size. Placekeeper overrides that arrangement with asymmetric workspace padding and reserved dock space. Correcting only the final scale cannot make an incompatible preview trustworthy.

## Symptoms

The initial pointer anchoring correction restored the measured page point but committed PDF layout repeatedly while zooming. The measured baseline used 30 wheel events on successive animation frames in Chromium at 1280×900: 30 page-width changes, p95 frame interval 21 ms, and maximum pointer drift 10.43 px. The successful candidate retained scale 1.3498 with one page-width change per gesture; three Chromium confirmations recorded p95 intervals 16.7/16.8/16.8 ms, negligible preview drift, and final drift 0.4323 px. These are experiment observations, not portable frame-time guarantees; an initial WebKit run had a 25 ms p95 despite the same one-layout result.

## What Didn't Work

- Keeping the library's native gesture geometry would preserve its uniform-gap and near-fit centering assumptions, which conflict with Placekeeper's custom reading frame. Investigation of installed `@embedpdf/plugin-zoom` 2.14.4 found both preview blending and numeric commit assumptions; the current integration therefore disables native wheel/pinch handling while retaining its content wrapper (`apps/web/src/pdf/AnchoredZoomGestureWrapper.tsx`).
- An initial direct anchored zoom per gesture update fixed anchoring but produced the measured 30 layout changes. Fewer events via animation-frame batching did not remove the per-frame layout cost; a preview needs to keep numeric layout unchanged through the gesture.
- The earlier implementation's unforced React request followed by animation-frame-only restoration did not reliably restore geometry. The current final commit uses `flushSync` before immediate correction (`apps/web/src/pdf/anchored-zoom.ts`).
- Capturing a fresh `useZoom().provides` scoped object as an effect dependency tore down listeners and canceled gesture state on rerenders. The stable capability is now the dependency, and document scope is obtained inside the effect (`apps/web/src/pdf/AnchoredZoomGestureWrapper.tsx`, `:13`, `:103`).

## Solution

Own gesture preview and commit together. Preview scales/translates the existing content without requesting PDF zoom (`apps/web/src/pdf/AnchoredZoomGestureWrapper.tsx`). At commit, capture the page point from the still-visible transform, clear that transform inside the synchronous numeric zoom update, and restore the normalized page point using the newly committed DOM geometry (`apps/web/src/pdf/AnchoredZoomGestureWrapper.tsx`; `apps/web/src/pdf/anchored-zoom.ts`). This ordering avoids measuring the old untransformed layout as though it were the user's visible anchor.

Wheel gestures commit after 120 ms idle; touch gestures commit when the two-touch gesture ends. Non-touch pointer presses, keys other than Control or Meta, ordinary wheel scrolling in the viewport, explicit zoom requests, window blur, and resize also finish a pending preview before proceeding. Capture-phase document pointer/key handlers matter because the next interaction can originate outside the PDF viewport. Unmount clears temporary visual state without issuing a delayed zoom (`apps/web/src/pdf/AnchoredZoomGestureWrapper.tsx`).

## Why This Works

Measured page geometry is the common coordinate system across custom padding, dock placement, and numeric PDF scale. Transform preview preserves the anchor while avoiding repeated PDF layout commits; one synchronous transition then transfers ownership back to numeric layout. The additional next-frame restoration accommodates subsequent geometry settlement within the same host presentation (`apps/web/src/pdf/anchored-zoom.ts`). The architecture's critical property is exclusive ownership of the visible transform and the commit boundary, not the precise idle delay.

### Native app zoom ends the old coordinate system

Native menu handling can bypass the DOM key events that normally finish a gesture. [PR #103](https://github.com/brad-ross/placekeeper/pull/103), open as of 2026-09-11, adds explicit native-to-web preparation before changing `WKWebView.pageZoom` for ready content. A successful synchronous JavaScript return acknowledges preparation; the native controller then validates the transition ticket before applying the scale (`apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift`; `apps/web/src/macos-entry.tsx`).

For each mounted viewer, preparation marks the presentation transition and synchronously dispatches the finish-gesture event, committing any preview against the old layout. **After finishing**, it cancels the pending anchor-restoration frame and any zoom animation (`apps/web/src/pdf/anchored-zoom.ts`). The order matters: committing a preview can itself schedule a restoration frame, so canceling only before the commit would leave a stale correction alive. That delayed correction captures old focus coordinates and must not combine them with page geometry measured after the host changes scale.

The gesture wrapper blocks new wheel/touch zoom previews while the marker is present. Geometry publication invokes resume only when it is no longer transitioning, and resume clears the marker only when the published geometry identity differs from the one recorded at preparation. Republishing the old layout therefore does not reopen gesture input (`apps/web/src/pdf/AnchoredZoomGestureWrapper.tsx`; `apps/web/src/macos-entry.tsx`; `apps/web/src/pdf/anchored-zoom.ts`). Finish the old presentation's work, revoke its delayed effects, then admit gestures under the changed presentation.

## Prevention

Verify both transient and settled geometry. A test that checks only the final zoom percentage can pass while all intermediate frames jump or rebuild layout. The production acceptance test samples 30 animation frames, measures the same normalized point, uses a MutationObserver to count distinct inline page-width values, and requires meaningful retained scale (`test/acceptance/production-flow.spec.ts`). It requires at most two additional distinct widths, <3 px preview drift, <2 px final drift, and scale >1.25. Test interruptions separately (`test/acceptance/production-flow.spec.ts`) so delayed commits cannot undo page navigation. The counter is the number of distinct sampled widths minus one. Treat it as a proxy for layout commits during monotonic zoom, not as a general browser layout profiler or a count of repeated transitions between the same widths.

The native app-zoom handoff has separate coverage in `apps/web/test/macos-app-zoom-transition.test.ts`: synchronous finish dispatch to mounted viewers, cancellation of deferred correction, stale runtime/attempt/geometry rejection, and retaining the marker when the old identity republishes. All six tests passed during the September 11 documentation review. These isolated checks do not establish physical trackpad-pinch behavior; that verification remains unconfirmed in PR #103's recorded acceptance evidence.

The original pointer-zoom implementation and performance measurements describe verified local work submitted in [PR #84](https://github.com/brad-ross/placekeeper/pull/84), merged on 2026-09-07. The measurements above are retained from the local performance experiment on 2026-09-07.

## Related Issues

- [Wait for committed wheel zoom before pointer-selection assertions](../test-failures/wait-for-committed-wheel-zoom-before-pointer-selection.md) explains the complementary acceptance-test synchronization boundary. Its dependency-preview investigation describes the earlier harness; production now owns its preview locally.
- [Adaptive annotation tray framing](../architecture-patterns/adaptive-annotation-tray-framing.md) explains the custom reading area and scrollport geometry that zoom must respect.
- [Shared production host boundaries](../architecture-patterns/shared-production-review-client-host-runtime-boundaries.md) explains the native geometry identity and host command boundary used by the presentation handoff.
