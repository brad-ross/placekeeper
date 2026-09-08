---
title: "Validate PDF navigation against mounted geometry and attainable native scroll"
date: "2026-09-07"
category: "ui-bugs"
module: "PDF destination navigation and viewer framing"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "high"
symptoms:
  - "Outline or search activation briefly reaches its PDF destination and then restores the previous location."
  - "A valid destination can fail alignment checks because plugin offsets differ from host CSS padding."
  - "Horizontal navigation can roll back when stable gutters overstate attainable scroll range."
root_cause: "logic_error"
resolution_type: "code_fix"
tags:
  - "pdf-navigation"
  - "outline"
  - "pdf-search"
  - "viewer-framing"
  - "native-scroll"
  - "geometry-settlement"
  - "rollback"
---

# Validate PDF navigation against mounted geometry and attainable native scroll

## Problem

PDF navigation could reach a useful destination and then roll back because the adapter required coordinates predicted by the scrolling plugin, or a nominal scroll boundary that the native scrollport could not reach. The navigation transaction treated that geometric mismatch as failure and restored its earlier location (`apps/web/src/pdf/viewer-navigation-adapter.ts:1084`). [PR #87](https://github.com/brad-ross/placekeeper/pull/87) contains the correction and remains open as of September 7, 2026.

## Symptoms

During the native investigation, the plugin's 10-pixel gap and the host's 24-pixel padding produced a 14-pixel vertical discrepancy, including with the workspace closed. The target was near the intended location, but strict postcondition checking rejected it. A second observation involved a stable native scrollbar gutter: the reported horizontal extent overstated the achievable scroll limit by 12 pixels. An instant scroll stopped short of `scrollWidth - clientWidth` while the intended anchor remained visible.

Those measurements describe the observed session, not constants to subtract globally. Current navigation takes live scroll offsets and dimensions from the mounted framing viewport when available (`apps/web/src/pdf/viewer-navigation-adapter.ts:815`). The durable question is whether the requested semantic destination is visible and aligned as far as the real scrollport permits.

## What Didn't Work

An early correction scoped to overlay/workspace geometry missed the same vertical mismatch with no workspace open. Host padding can differ from plugin configuration independently of an overlay, so reconciliation must follow ordinary navigation too.

Correcting both axes together also risked disturbing a valid horizontal position merely to repair vertical placement. A fully visible fitted page already satisfied the horizontal requirement; moving it toward an exact anchor coordinate could make the result worse.

Removing custom scrollbar styling was insufficient by itself. Native gutter behavior could still leave the nominal horizontal maximum unreachable. Increasing a global tolerance or assuming every clamped scroll succeeded would hide failures where the destination remained outside the readable area.

## Solution

After plugin navigation and settling, compare the actual mounted geometry with the intended location on each axis. If either axis fails, perform DOM-based reconciliation even without a workspace. Preserve horizontal position when that axis already satisfies its postcondition (`apps/web/src/pdf/viewer-navigation-adapter.ts:1058`).

An axis can succeed through exact alignment or a justified constraint. A page fully visible on that axis satisfies a stronger reading condition than exact anchor alignment. Horizontal boundary acceptance additionally requires the anchor to be visible; the final result retains the unobscured-anchor check when the viewport has occlusion (`apps/web/src/pdf/viewer-navigation-adapter.ts:824`, `apps/web/src/pdf/viewer-navigation-adapter.ts:851`, `apps/web/src/pdf/viewer-navigation-adapter.ts:894`).

Positioning computes corrections from the actual page and readable viewport rectangles. It issues instant scrolling through the viewer and DOM scrollport. If the DOM stops short of the requested horizontal position, the function records the achieved offset together with that attempt's scroll and client widths (`apps/web/src/pdf/viewer-navigation-adapter.ts:1094`). Subsequent checking accepts that measured boundary only while those widths and the achieved offset still match, with the anchor visible and on the constrained side of its requested alignment (`apps/web/src/pdf/viewer-navigation-adapter.ts:860`). The observation is passed through the current positioning attempt, not cached as a universal scroll limit.

The reference-fit-width path also uses measured positioning and boundary evidence after resolving against settled viewport dimensions. It still verifies the expected page width rather than treating any visible destination as a successful fit (`apps/web/src/pdf/viewer-navigation-adapter.ts:1492`).

## Why This Works

The adapter now reconciles prediction with observation before deciding a transaction failed. Plugin gap arithmetic remains useful for requesting navigation, but mounted page geometry determines whether correction is needed. Native scroll behavior supplies evidence of an achievable boundary when nominal extent arithmetic is insufficient.

This is a constrained success rule, not removal of failure detection. The operation must remain current, target scale must agree when required, both axes must satisfy their conditions, and occluded or invisible anchors are not accepted merely because scrolling stopped (`apps/web/src/pdf/viewer-navigation-adapter.ts:1102`, `apps/web/src/pdf/viewer-navigation-adapter.ts:902`). Failed mutated operations retain rollback.

## Prevention

The regression suite models the 14-pixel plugin offset and verifies both correction without rollback and preservation of an already-valid horizontal position (`apps/web/test/viewer-navigation.test.ts:829`). Parameterized clamping tests cover visible and invisible anchors with both zero and 12-pixel extent overstatement; only visible destinations succeed (`apps/web/test/viewer-navigation.test.ts:821`). Separate cases cover stale plugin metrics, scrollbar-aware fit width, and fully visible pages with artificial remaining scroll range (`apps/web/test/viewer-navigation.test.ts:782`, `apps/web/test/viewer-navigation.test.ts:1028`).

These tests prove the adapter's modeled geometry rules. The native observations motivated the cases, but the harness does not itself prove every WKWebView gutter or compositor behavior. Recheck the actual native host when changing viewport padding, scrollbar policy, or the mounted reading frame. Diagnose failed navigation by recording requested alignment, actual page/viewport rectangles, achieved offsets, and anchor visibility before changing tolerances.

## Related Issues

[Send-to-main viewport rebound](send-to-main-viewport-rebound.md) concerns a different framing lifecycle. A later owner restoring an old viewport is distinct from this adapter falsely rejecting its own navigation postcondition.

See also [pointer-anchored zoom across custom geometry](pointer-anchored-zoom-across-custom-viewer-geometry.md) for the related measured-layout principle during zoom gestures.
