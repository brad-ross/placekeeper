---
title: "Calibrate virtualized PDF navigation before the destination first paints"
date: "2026-09-11"
category: "ui-bugs"
module: "PDF destination navigation and viewer framing"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms: ["Distant virtualized Search Results first paint about 14 pixels right and 2 pixels down before correcting.", "Correct final destination assertions pass despite visible movement between the initial painted frame and settlement.", "Synchronous correction limited to mounted destination pages leaves distant unmounted results visibly misaligned."]
root_cause: "logic_error"
resolution_type: "code_fix"
tags: ["pdf-navigation", "pdf-search", "viewer-framing", "virtualization", "first-paint", "geometry-settlement", "committed-zoom"]
---

# Calibrate virtualized PDF navigation before the destination first paints

## Problem

Search navigation could reach the correct final PDF bounds while still flashing an incorrect position on the first visible frame. The useful distinction is between a destination postcondition and the sequence of positions exposed while reaching it. Returning to the first `2.8` search result on page 6 of the Norris PDF from distant results made that distinction visible.

## Symptoms

The session's frame probe recorded the destination at x=38.25 before it settled at x=24.25: a 14-pixel movement that a final screenshot would miss. The problem persisted after removing a much larger horizontal jump. Far-result returns were especially revealing because the destination was outside the viewer's mounted page window. A separate attempt left roughly 1–2 pixels of vertical drift when returning from page 73.

## What Didn't Work

Correcting the destination after a frame made final bounds pass without preventing the flash. Precomputing horizontal alignment for fitting pages removed the large jump, but did not reconcile the plugin's virtual origin with the host's actual layout. Synchronous React reconciliation improved mounted-page navigation; it could not by itself make a delayed native scroll use corrected coordinates, or measure a destination that virtualization had not mounted. The final implementation still distinguishes adjacent initialization from distant navigation and only waits for far-page geometry after requesting the scroll (`apps/web/src/pdf/viewer-navigation-adapter.ts:979`, `apps/web/src/pdf/viewer-navigation-adapter.ts:1017`).

Using a DOM-derived scale in the plugin's virtual rectangle calculation was also insufficient. Page width is a rendered measurement; dividing it by the PDF width introduces layout quantization into the scale (`apps/web/src/pdf/viewer-navigation-adapter.ts:664`). Applying that tiny scale error to a virtual position dozens of pages down the document amplified it into visible vertical error. A plausible scale and a correct authoritative zoom are not interchangeable for cumulative document coordinates.

## Solution

Calibrate the plugin's virtual coordinates against a page that is already mounted before requesting the destination scroll. `scrollAlignment` compares that page's actual DOM origin, adjusted for current scroll and scrollport origin, with `getRectPositionForPage` and the plugin viewport gap. It then incorporates the resulting layout offset into the requested alignment (`apps/web/src/pdf/viewer-navigation-adapter.ts:597`). Crucially, the virtual rectangle request uses `location.zoom`; the measured scale only checks that the mounted geometry is consistent with that zoom (`apps/web/src/pdf/viewer-navigation-adapter.ts:620`). This makes the first plugin scroll account for the host layout even when the destination is absent.

Retain fitting-page alignment resolution before the scroll (`apps/web/src/pdf/viewer-navigation-adapter.ts:1048`) and synchronous reconciliation when destination geometry exists (`apps/web/src/pdf/viewer-navigation-adapter.ts:995`). Retain the one-time reapplication after an initially unmounted page appears, since engines can accept a far-page request before retaining its coordinates (`apps/web/src/pdf/viewer-navigation-adapter.ts:1027`). These mechanisms address different stages; the mounted-page calibration closes the first-visible-frame gap.

## Why This Works

The current visible page supplies the missing translation between the plugin's model and the host DOM without requiring the destination to exist. Using authoritative zoom keeps that translation independent of distance through the document. In the session's final Norris probe, all four returns from result pages 73, 77, 106, and 73 exposed one position, x=24.25 and y=-189.34375. The targeted verification reported 188 passing unit tests and three passing browser checks. These are session observations, not new executions by this documentation pass.

## Prevention

Keep a regression that observes every visible destination frame, not merely its eventual bounds. The browser test inserts 16 blank pages between search hits, adds a wider page to preserve horizontal scroll range, and explicitly verifies the first page is unmounted before returning (`test/acceptance/production-flow.spec.ts:779`). Its requestAnimationFrame sampler records both axes while the destination intersects the viewport, then requires their spread to remain under two pixels (`test/acceptance/production-flow.spec.ts:805`, `test/acceptance/production-flow.spec.ts:834`). In this session that fixture failed against the baseline with a 14-pixel spread and passed with the correction. Preserve both long-distance real-document probes and this small reproducible fixture: the former exposed accumulated scale error that a short document could conceal.

## Related Issues

- [Validate navigation against mounted geometry](pdf-navigation-rollback-from-predicted-scroll-geometry.md) covers settled destination acceptance and rollback; those checks remain necessary after first-frame calibration.
- [Pointer-anchored zoom across custom geometry](pointer-anchored-zoom-across-custom-viewer-geometry.md) covers transient gesture geometry and commit ownership.
