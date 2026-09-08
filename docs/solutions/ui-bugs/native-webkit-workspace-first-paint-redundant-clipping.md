---
title: "Avoid redundant clipping of native WebKit workspace layers on first paint"
date: "2026-09-07"
category: "ui-bugs"
module: "PDF viewer framing and native document window"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "Opening a PDF through the Mac file picker leaves the workspace toggle and tray unpainted until the native window is resized."
  - "Show workspace remains present in the accessibility tree with valid geometry despite its missing painted control."
root_cause: "logic_error"
resolution_type: "code_fix"
tags:
  - "macos"
  - "webkit"
  - "first-paint"
  - "workspace"
  - "overflow-clip"
  - "viewer-framing"
---

# Avoid redundant clipping of native WebKit workspace layers on first paint

## Problem

The installed Mac app could open a large PDF through the native NSOpenPanel and leave its workspace toggle and tray unpainted. The controls were present in the accessibility tree and had valid layout. A native Window > Zoom resize made them appear, obscuring the original failure if verification began after changing the window size.

This learning concerns the native first-paint path. The fix is included in [PR #87](https://github.com/brad-ross/placekeeper/pull/87), open as of 2026-09-07.

## Symptoms

On the failing initial open, accessibility inspection found the workspace controls, and computed styles indicated that they were visible. The toggle had valid bounds at x=1156, y=64, width=32, height=34. Screenshots nevertheless showed a blank area where the controls should have painted. Resizing through the native window command caused the missing UI to appear.

The discrepancy was the useful diagnostic signal: accessibility presence and nonzero bounds established that the controls existed, not that the native web view had drawn their pixels. Treating those checks as visual confirmation would have missed the user-visible defect.

## What Didn't Work

Browser WebKit and a minimal CSS/native fixture did not reproduce the failure. Their success could not clear the actual installed-app path, which included opening the PDF through the native picker.

A temporary `translateZ(0)` promotion made the rail paint but left the tray blank. That partial improvement was insufficient and the promotion attempt was removed. Resizing the native window also restored painting, but was a diagnostic clue rather than an acceptable fix: the user should not have to resize a window to discover available controls.

## Solution

Remove the redundant clipping boundary from the drawer host on the Mac launch surface. The general drawer host retains `overflow: clip`, while the Mac-specific override uses `overflow: visible`; see `apps/web/src/app/review-layout-foundation.css:795` and `apps/web/src/app/review-layout-foundation.css:803`. The outer `.review-layout` already has `overflow: hidden` in `apps/web/src/app/review-layout-foundation.css:501`, so the surrounding layout remains the clipping boundary.

Verification used the actual native picker workflow again. After opening the PDF in the installed Mac app, both the workspace rail and the opened tray painted before any resize. That native visual observation was the decisive evidence for this fix.

The browser regression at `test/acceptance/annotation-behavior-followup.spec.ts:453` provides complementary coverage. It sets the Mac launch-surface attribute, checks that the rail is visible and inside the viewport, checks center-point hit ownership, opens the workspace, and closes it again. These assertions protect layout and interaction, but they do not reproduce NSOpenPanel or prove native compositor painting.

## Why This Works

Removing the inner clip eliminated the observed first-paint failure while leaving the existing outer clip in place. The result is consistent with redundant clipping interfering with paint or compositing in this native WKWebView lifecycle. The investigation did not establish a universal WebKit bug or identify a specific internal compositor defect, so the explanation should remain scoped to the observed behavior.

The stronger conclusion is methodological: valid accessibility and layout state can coexist with missing pixels, and a resize can conceal that distinction. A change that repaints one affected surface must still be checked against every surface that originally failed.

## Prevention

When native controls exist but look absent, compare accessibility and layout evidence with a screenshot before triggering resize, Window > Zoom, or another action that can invalidate painting. Reproduce through the same installed-app entry path as the report; browser WebKit and reduced fixtures are useful controls, not substitutes when they cannot reproduce the failure.

Inspect redundant ancestor clipping before adding promotion transforms. Prefer removing an unnecessary clipping boundary when an outer container already provides the required containment, and verify the rail and expanded tray independently on the first native open. Keep the browser viewport and hit-target regression, while recording native pre-resize visual verification separately so its stronger and narrower evidence is not lost.

## Related Issues

- [Shared production review host boundaries](../architecture-patterns/shared-production-review-client-host-runtime-boundaries.md) explains native readiness and activation.
- [Adaptive annotation tray framing](../architecture-patterns/adaptive-annotation-tray-framing.md) owns overlay reachability and reading-position preservation.
