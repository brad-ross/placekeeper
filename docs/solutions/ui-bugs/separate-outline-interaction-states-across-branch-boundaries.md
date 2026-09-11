---
title: Separate Outline interaction states across branch boundaries
date: 2026-08-21
last_updated: 2026-09-10
category: ui-bugs
module: PDF review Outline navigation
problem_type: ui_bug
component: frontend_stimulus
severity: low
symptoms:
  - "Hover, focus, active, and current styling on adjacent Outline entries could visually touch."
  - "The first subsection below a section and the next section after an expanded subtree lacked enough clearance for the focus ring."
root_cause: logic_error
resolution_type: code_fix
related_components:
  - "OutlineNavigator"
  - "Outline Discovery"
  - "testing_framework"
tags:
  - "pdf-outline"
  - "outline-navigation"
  - "focus-ring"
  - "interaction-states"
  - "tree-spacing"
  - "branch-boundaries"
  - "visual-regression"
---

# Separate Outline interaction states across branch boundaries

## Problem

Outline rows were packed more tightly than their interaction styling allowed. The tree used 4px separation while a focused row painted 5px beyond its border: a 3px outline separated from the row by a 2px offset (`apps/web/src/app/review-layout-annotations.css`). Focus, hover, active, and current-row treatments could therefore appear to touch adjacent entries.

The problem was most noticeable where tree depth changes: between a section and its first subsection, and between the final subsection of an expanded branch and the following section. The fix was merged in [PR #44](https://github.com/brad-ross/placekeeper/pull/44) on 2026-08-21.

## Symptoms

- Hovering one Outline entry while an adjacent entry retained focus made the two state treatments appear to overlap.
- The first subsection below an expanded section sat too close to the section row above it.
- The final subsection in an expanded branch sat too close to the next top-level section.
- Increasing ordinary row spacing could improve peer rows without fixing both branch boundaries because nested lists produce entry and exit spacing differently.

## What Didn't Work

### Treating every adjacent row as the same relationship

Increasing only the ordinary list gap was incomplete. Every list uses a grid gap, but an expanded child-list container introduces a separate margin above itself. Ordinary siblings and a change in depth need distinct spacing contracts (`apps/web/src/app/review-layout-annotations.css`). A uniform 8px gap everywhere would prevent collisions, but it would also make ordinary peers unnecessarily loose and flatten the hierarchy's rhythm.

### Fixing only branch entry

Adding space before the child-list container fixed the section-to-first-subsection boundary but not the reverse boundary. The next top-level section follows the expanded parent `<li>` rather than the final nested row, so branch-exit spacing has to target that following sibling (`apps/web/src/app/review-layout-annotations.css`). The first pass missed this symmetric boundary; rendered inspection exposed it (session history).

## Historical solution

Use two semantic spacing tokens: 6px between ordinary rows and 8px at branch entry and exit. Apply the row token to every Outline list, apply the branch token above child-list containers, and add only the difference between the two tokens to a sibling following an expanded subtree. The parent list's normal 6px grid gap is already present, so the exit rule adds 2px rather than another full 8px (`apps/web/src/app/review-layout-annotations.css`).

```css
.outline-navigator {
  --outline-tree-row-gap: 6px;
  --outline-tree-branch-gap: 8px;
}

.outline-navigator ul {
  gap: var(--outline-tree-row-gap);
}

.outline-navigator__children {
  margin-top: var(--outline-tree-branch-gap);
}

.outline-navigator li:has(> .outline-navigator__children:not([hidden])) + li {
  margin-top: calc(var(--outline-tree-branch-gap) - var(--outline-tree-row-gap));
}
```

The exit selector applies only when the direct child-list container is visible. Collapsed branches therefore retain ordinary peer spacing instead of reserving empty branch space.

## Why the original fix worked

The root cause was a mismatch between layout geometry and interaction geometry. The old 4px gap described only the distance between row boxes, but the focus indicator extends 5px outside those boxes. A 6px ordinary gap contains that painted footprint and leaves one pixel of visible clearance while preserving a compact tree (`apps/web/src/app/review-layout-annotations.css`).

Nested branches introduce a second geometry problem. The child-list container owns entry spacing, so its 8px top margin separates the section from its first subsection. On exit, the next section is a sibling of the expanded parent item, not a sibling of its final child. The expanded-subtree selector adds 2px to the existing 6px parent-list gap, producing the same 8px boundary without double-counting (`apps/web/src/app/review-layout-annotations.css`).

The distinction is structural rather than cosmetic: sibling rhythm remains compact, while changes in depth receive stronger separation in both directions.

## Current presentation and prevention

The later Soft Neutral cascade supersedes the historical 6px/8px calibration. Current base row and branch tokens are both `0px`, rows use `margin: 2px 0`, and neutral focus paints a 2px outline with a 3px offset. Preserve the historical distinction between branch entry and exit when assessing changes; do not restore the old spacing snippet as the current implementation (`apps/web/src/app/review-outline-row-actions.css`, `apps/web/src/app/neutral-workspace-navigation.css`).

1. Measure effective painted controls, row margins, and branch relationships under the complete cascade, including focus, hover, and selected states.
2. Model branch entry and exit independently; their DOM relationships still differ.
3. The source contract pins current zero-valued tokens. Browser coverage requires at least 4px between all adjacent visible rows, including nested and wrapped rows (`apps/web/test/review-layout.test.tsx`, `test/acceptance/review-visual.spec.ts`).
4. Inspect focus visually after numeric geometry checks. A 4px row-spacing assertion does not itself establish clearance for a focus treatment that extends 5px beyond the control.

## Related Issues

- [PR #44: refine workspace tray navigation](https://github.com/brad-ross/placekeeper/pull/44) — merged on 2026-08-21.
- [Content-aware annotation workspace presentation](../design-patterns/outline-aware-annotation-workspace-presentation.md) — capability-driven Outline composition and workspace interaction coverage.
- [Reliable compact right-docked Reference Tabs](reliable-compact-right-docked-reference-tabs.md) — companion guidance for semantic control geometry and rendered browser measurements.
