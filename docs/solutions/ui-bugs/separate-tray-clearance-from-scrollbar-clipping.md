---
title: "Separate tray clearance from occupied scrollbar tracks"
date: "2026-09-11"
last_updated: "2026-09-11"
category: "ui-bugs"
module: "PDF viewer framing and workspace trays"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "The gap between right workspace and bottom References shrinks or disappears as app zoom changes."
  - "Gray tray backing is missing along bottom and right margins."
root_cause: "logic_error"
resolution_type: "code_fix"
tags: ["workspace", "references", "scrollbars", "app-zoom", "viewer-framing"]
---

# Separate tray clearance from occupied scrollbar tracks

## Problem

Testing [PR #103](https://github.com/brad-ross/placekeeper/pull/103) exposed two related framing failures: the inter-tray gap did not scale with outside margins, and the decorative backing left unpainted strips beside the trays. The fixes are pending merge in that PR as of 2026-09-11.

## Root cause

Two measurements happened to agree in some layouts but serve different purposes. The outside inset gives controls breathing room and keeps them clear of scrollbars. Actual scrollbar width and height describe occupied tracks that backing must not cover. The outside inset remains nonzero even when overlay scrollbars occupy no layout space.

The original inter-tray offset used a fixed 24 pixels, effectively assuming two 12-pixel insets. The user reported this during native zoom changes. The browser reproduction used a 20-pixel occupied track: with a 20-pixel outside inset, that offset leaves only a `24 - 20 = 4` pixel gap. This fixture establishes the failed arithmetic without assuming a universal conversion from app scale to scrollbar width. Separately, clipping backing by the outside inset removed decorative paint even where no scrollbar existed. Removing clipping entirely would hide the distinction in the other direction by allowing backing over actual tracks.

## Solution

`apps/web/src/review/use-review-overlay-geometry.ts` measures each scrollbar dimension from the scrollport's offset and client dimensions and chooses the outside inset as the maximum of the base inset and those measurements. Use that shared inset for spacing. In `apps/web/src/app/review-workspace-surfaces.css`, the right workspace above bottom References uses:

```css
bottom: calc(var(--reference-bottom-height) + 2 * var(--review-overlay-inset, 12px));
```

One inset positions the bottom reference tray above the outside edge; the other supplies the gap above it. Thus the visible gap matches the outside margin even when scrollbar geometry changes.

Backing has a different boundary. In `apps/web/src/app/review-viewer-framing.css`:

```css
clip-path: inset(0 var(--review-main-scrollbar-width, 0px) var(--review-main-scrollbar-height, 0px) 0);
```

Only occupied tracks are excluded. These offset/client measurements apply to this viewer scrollport; copying the formula to a bordered element without accounting for its borders would measure more than the track. A zero-height horizontal track must not inherit the nonzero vertical clearance or the minimum decorative margin.

## Why overflow is not enough

An earlier backing fix excluded bottom space only when horizontal scrolling was available. That still confused overflow with occupied track space: content can overflow while an overlay scrollbar consumes no layout height. The final regression preserves wide content while setting `scrollbarWidth = 'none'`, requiring zero clipping despite continued overflow.

The acceptance test also records a platform asymmetry: headless Chromium on macOS reserved the styled vertical track while retaining an overlay horizontal track. Thus a styled 20-pixel vertical track did not establish a 20-pixel horizontal track. Expected clipping must come from each axis's observed geometry, not the stylesheet declaration.

Prior layout-review history confirms that preserving the actual scrollbar was an explicit requirement of the earlier backing fix (session history). This is why filling the margin by deleting every clipping boundary would lose an existing constraint.

## Verification and prevention

The browser regressions in `test/acceptance/review-workflow.spec.ts` compare the measured inter-tray gap with the current outside inset and exercise backing with vertical overflow, horizontal overflow, and no occupied tracks. The gap regression failed before the spacing fix. Native candidate inspection also confirmed the missing backing symptom; browser geometry checks alone are not proof of native compositor behavior.

When reproducing this class of bug, use a real scrollport and inspect offset/client dimensions on both axes. Do not infer occupied tracks from scrollbar styling or overflow declarations alone. The acceptance fixture uses `scrollbarWidth = 'none'` for the zero-track case because changing custom scrollbar CSS width during the investigation did not reliably trigger remeasurement. Keep layout clearance and paint exclusion separate even when their values coincide at the default zoom.

## Related guidance

- [Adaptive annotation tray framing](../architecture-patterns/adaptive-annotation-tray-framing.md) covers reachability and reading-position preservation around these overlays.
- [Native WebKit first-paint clipping](native-webkit-workspace-first-paint-redundant-clipping.md) concerns a redundant ancestor overflow clip. Its removal does not imply that decorative backing should paint over scrollbar tracks.
