---
title: Contain main PDF link hit targets below the References viewer
date: 2026-08-11
category: ui-bugs
module: pdf-viewer
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - Clicking at the left boundary of an open References PDF viewer activates a link in the underlying main PDF.
  - The main PDF link action popup appears even though the References viewer visually covers the link hit target.
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags:
  - pdf-links
  - stacking-context
  - hit-testing
  - reference-tabs
  - playwright
---

# Contain main PDF link hit targets below the References viewer

## Problem

When a Reference Tab was open over the Main Reading Thread, a click at or just beyond the Reference PDF viewer's left edge could reach a link annotation in the underlying main PDF. Instead of remaining within the visible References surface, the click opened the Main Reading Thread's link-action popup.

The application keeps the main and reference PDF workspaces mounted as distinct surfaces. Their internal annotation layers therefore must remain inside their respective workspace stacking boundaries.

## Symptoms

- Clicking near the left boundary of an open Reference Tab could show the ordinary main-viewer link menu.
- At the overlap point, browser hit testing selected an element from the underlying main workspace instead of the visible References surface.
- The reproduced failure depended on real layout geometry: the main-PDF link annotation physically overlapped the bottom-docked reference viewport in the regression setup.

## What Didn't Work

### Reproducing at a narrow viewport

The first regression attempt used a narrow layout and passed before the fix because the main link and Reference PDF viewer did not share a true hit-test area. The corrected test uses a wide `1367 x 1324` viewport, selects the bottom References presentation, and waits for its transform to settle before measuring the overlap (`test/acceptance/production-flow.spec.ts:843-861`). (session history)

### Relying on source-level z-index assertions

The CSS values suggested a layering problem, but source inspection alone could not establish which element the browser would choose after transforms, scrolling, portals, and PDF annotation rendering were combined. The regression had to compute rendered rectangles, prove that their intersection was non-empty, and call `document.elementFromPoint` inside that intersection (`test/acceptance/production-flow.spec.ts:881-905`).

### Retuning individual layer values

Lowering the link renderer's `zIndex: 10` would undermine its intended role above the PDF render and selection layers (`apps/web/src/pdf/PdfLinkControl.tsx:150-160`). Raising each drawer or contextual layer would spread knowledge of viewer internals through unrelated outer layers. The durable boundary is between independently mounted workspaces, not between every descendant's numeric z-index.

### Testing a stale production bundle

One early post-fix run still served the older built web bundle, so it continued to reproduce the old behavior. Rebuilding the production output before rerunning the focused acceptance test ensured that the served CSS contained the source change. (session history)

## Solution

Make the Main Reading Thread's document container a stacking context by assigning `z-index: 0` to its already positioned root:

```css
.review-document {
  position: absolute;
  z-index: 0;
  inset: 0;
  overflow: hidden;
}
```

This rule lives at `apps/web/src/app/review-layout-foundation.css:353-360`. The outer drawer and contextual hosts remain at z-index 2 and 3 (`apps/web/src/app/review-layout-foundation.css:427-438`), while the project-owned PDF link renderer keeps its internal z-index 10 (`apps/web/src/pdf/PdfLinkControl.tsx:150-160`).

The browser regression then reproduces the actual geometry:

1. Open a real main-PDF link in a Reference Tab (`test/acceptance/production-flow.spec.ts:849-852`).
2. Place References in the bottom presentation and wait for its transform to settle (`test/acceptance/production-flow.spec.ts:854-861`).
3. Scroll a second main-PDF link beneath the reference viewport (`test/acceptance/production-flow.spec.ts:862-879`).
4. Compute the intersection and assert both that overlap exists and that the main viewer is not the topmost hit target (`test/acceptance/production-flow.spec.ts:881-905`).

The fix and regression were merged in [PR #9](https://github.com/brad-ross/pdf-markup/pull/9). During PR #9 verification, the focused regression was reported passing in Chromium and WebKit. The same verification session reported TypeScript and the Chromium acceptance suite passing locally after the then-current `main` was merged into the PR branch. (session history)

## Why This Works

A positioned element with a non-auto z-index establishes a stacking context. Giving `.review-document` z-index 0 orders all descendants inside that context before the browser compares the document root with sibling workspace layers (`apps/web/src/app/review-layout-foundation.css:353-360`).

The link renderer's z-index 10 still places links above render and selection layers within the main PDF (`apps/web/src/pdf/PdfLinkControl.tsx:153-160`), but it can no longer outrank the outer References host at z-index 2 (`apps/web/src/app/review-layout-foundation.css:427-434`). This preserves both invariants:

- Link annotations remain interactive above the main PDF's internal visual layers.
- The Main Reading Thread remains below independently mounted References and contextual surfaces.

The acceptance test validates the user-visible consequence rather than the implementation detail: at a proven overlap point, browser hit testing must not resolve to the main workspace (`test/acceptance/production-flow.spec.ts:892-905`).

## Prevention

- Give each independently mounted viewer or overlay an explicit stacking root. Internal z-index values should order descendants within that component; outer workspace hosts should order components relative to one another.
- For overlap bugs, assert real browser hit testing rather than screenshots or CSS values alone. First prove that rectangles intersect, then use `document.elementFromPoint` inside the intersection.
- Reproduce the presentation mode where the geometry occurs. A valid narrow layout is not a valid regression setup if it removes the overlap.
- Keep the served production bundle synchronized with source while verifying CSS changes. A stale bundle can make a correct source fix appear ineffective. (session history)
- Run geometry-sensitive coverage in Chromium and WebKit because stacking and pointer hit testing are browser behaviors.

## Related Issues

- [PR #9: follow links in the active reference tab](https://github.com/brad-ross/pdf-markup/pull/9)
- [Adaptive annotation tray framing](../architecture-patterns/adaptive-annotation-tray-framing.md) documents the complementary interaction contract: PDF clicks, selection, panning, and scrolling remain document gestures while workspace closure stays explicit. Stacking containment ensures those gestures reach the visible workspace instead of an underlying viewer.
