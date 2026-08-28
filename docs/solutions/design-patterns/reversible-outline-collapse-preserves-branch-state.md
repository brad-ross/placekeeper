---
title: Reversible Outline collapse preserves branch state
date: 2026-08-28
category: design-patterns
module: PDF review Outline expansion
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "A hierarchical document view needs one action to reduce every branch to its top-level entries"
  - "The inverse action must restore the exact disclosure state that existed before the bulk operation"
  - "Reviewers may continue using individual branch controls while a bulk restore snapshot is pending"
  - "The hierarchy is document-scoped and stale expansion state must not cross a document-generation boundary"
  - "One contextual action must follow the same workspace across shared, split, right-docked, and bottom presentations"
related_components:
  - "Outline Discovery"
  - "OutlineNavigator"
  - "OutlineAnnotationsWorkspace"
  - "ReferenceWorkspace"
  - "ReviewShell"
  - "Warm Neutral"
tags:
  - "pdf-outline"
  - "outline-navigation"
  - "bulk-collapse"
  - "state-restoration"
  - "document-generation"
  - "adaptive-workspace"
  - "contextual-actions"
  - "visual-calibration"
---

# Reversible Outline collapse preserves branch state

## Context

A bulk **Collapse all** command in a document outline looks like a boolean toggle, but the outline itself is not binary state. The reader may have opened an arbitrary subset of branches to establish a working context. Reconstructing that context by expanding every branch, expanding only top-level branches, or inferring a complement after collapse changes what the reader chose.

The durable model is to treat bulk collapse as a temporary overlay on the ordinary expansion set: capture the exact set before collapse, display the tree with no expanded branches, and restore the captured set on the next bulk action. The implementation is open in [PR #71](https://github.com/brad-ross/placekeeper/pull/71) and remains pending merge as of 2026-08-28.

The feature also crosses presentation boundaries. `ReviewShell` can place the action in either the shared `ReferenceWorkspace` header or the separate `OutlineAnnotationsWorkspace` header, depending on the active layout (`apps/web/src/app/ReviewShell.tsx:1761-1845`). The expansion state therefore cannot belong to the button or to one header. It must live above the tree and every possible command slot.

A visual-first pass established that the new control should float opposite the workspace navbar rather than introduce a divided or underlined header region. Testing the built bundle with an outline-capable PDF then showed that geometric centering alone did not make the asymmetric glyph look centered, so the final polish added a narrow optical correction after layout centering (session history).

## Guidance

### Model collapse as an overlay with an exact restore snapshot

Represent the interaction with two sets:

- `expandedItemIds` is the live tree state.
- `restoreItemIds` is either `null` or the snapshot captured by the most recent bulk collapse (`apps/web/src/review/outline-expansion-state.ts:3-6`).

The bulk transition has only two meaningful paths. When no restore is pending, an empty live set is a no-op; otherwise the transition stores a copy of the current set and clears the live set. When a restore is pending, the transition replaces the live set with a copy of that snapshot and clears restore mode (`apps/web/src/review/outline-expansion-state.ts:41-54`). Copy both sets rather than retaining a caller-owned mutable `Set`.

```ts
function toggleOutlineExpansionState(
  current: OutlineExpansionState,
): OutlineExpansionState {
  if (current.restoreItemIds !== null) {
    return {
      expandedItemIds: new Set(current.restoreItemIds),
      restoreItemIds: null,
    };
  }
  if (current.expandedItemIds.size === 0) return current;
  return {
    expandedItemIds: new Set(),
    restoreItemIds: new Set(current.expandedItemIds),
  };
}
```

Do not derive the restore target from the post-collapse tree. The snapshot is the reader's intent; the empty tree is only its temporary presentation.

### Preserve the snapshot while ordinary branch controls remain active

Bulk collapse should not disable the outline. A reader may open one branch to inspect it before deciding whether to restore the earlier context. The ordinary setter updates only `expandedItemIds`, so a pending `restoreItemIds` snapshot survives those local edits (`apps/web/src/review/outline-expansion-state.ts:31-39`). The tree's disclosure button clones the controlled set, adds or removes one branch ID, and publishes the new set to its owner (`apps/web/src/review/OutlineNavigator.tsx:40-45`, `apps/web/src/review/OutlineNavigator.tsx:88-100`).

Local branch changes affect what is visible now, while the next bulk action still means “return to the context captured before collapse.” Tests should cover that interleaving, not only a collapse/restore round trip. The regression suite verifies that opening `methods` after collapse leaves the captured `intro` and `results` snapshot unchanged and that restore returns to those original branches (`apps/web/test/reference-workspace.test.tsx:930-940`).

### Centralize state above the tree and every layout-specific command slot

Make the outline a controlled component. `OutlineNavigator` receives both `expandedItemIds` and `onExpandedItemIdsChange`; it derives each branch's expanded state and child visibility from that external set (`apps/web/src/review/OutlineNavigator.tsx:9-16`, `apps/web/src/review/OutlineNavigator.tsx:46-51`, `apps/web/src/review/OutlineNavigator.tsx:129-137`). `OutlineAnnotationsWorkspace` obtains the shared controller and passes its live set and setter into the navigator instead of maintaining a second expansion state (`apps/web/src/review/OutlineAnnotationsWorkspace.tsx:70-71`, `apps/web/src/review/OutlineAnnotationsWorkspace.tsx:187-195`).

Place one provider above both workspace surfaces. Here `OutlineExpansionProvider` wraps `ReferenceWorkspace` and `OutlineAnnotationsWorkspace`, allowing either header to receive a controller-backed slot while the tree consumes the same state (`apps/web/src/app/ReviewShell.tsx:1761-1763`, `apps/web/src/app/ReviewShell.tsx:1827-1845`, `apps/web/src/app/ReviewShell.tsx:1991-1992`). The shell computes visibility from the open tools surface and effective Outline mode, so the command does not appear merely because an outline exists offscreen (`apps/web/src/app/ReviewShell.tsx:537-550`). The slot separately suppresses itself when the outline has no branches and disables collapse when nothing is expanded and no restore is pending (`apps/web/src/review/OutlineExpansionController.tsx:83-96`).

This provider-and-slot split prevents layout variants from becoming state owners. Headers decide where the command is rendered; the provider decides what the command means.

### Reset live and restore state at document identity boundaries

A restore snapshot is meaningful only for the document that produced its branch IDs. Compute branch IDs from the loaded outline tree, retain the associated document generation, and recreate expansion state when that generation changes (`apps/web/src/review/OutlineExpansionController.tsx:38-59`). A loaded tree begins with every branch ID expanded because `outlineBranchIds` collects only items that have children (`apps/web/src/review/outline-expansion-state.ts:8-20`). A non-tree state for a new generation resets to an empty expansion state, which also clears the restore snapshot (`apps/web/src/review/OutlineExpansionController.tsx:48-53`, `apps/web/src/review/outline-expansion-state.ts:22-28`).

Do not carry a restore set across PDF reloads or document generations even if some item IDs happen to match. Generation is the authority boundary; string equality is not document identity.

### Let command semantics and accessibility expose the same state

The button derives its label, pressed state, data marker, and icon from `restorePending`. Collapse mode announces “Collapse all outline entries”; restore mode announces “Restore previous outline expansion,” sets `aria-pressed`, and reverses the paired-chevron icon (`apps/web/src/review/OutlineExpansionToggle.tsx:9-28`). This makes restore mode observable to assistive technology and stable browser tests without coupling either one to internal set contents.

Test both semantic modes. Component tests require the matching accessible labels and inward/outward icon states (`apps/web/test/reference-workspace.test.tsx:943-954`), while the shell contract requires exactly one rendered command in the active header (`apps/web/test/review-layout.test.tsx:77-119`).

### Calibrate the floating control against its neighboring surface

Treat visual alignment as part of the component contract. The workspace header owns a fixed height, centered children, and shared inset padding (`apps/web/src/app/review-layout-annotations.css:278-286`). Its existing activity strip is a floating surface with a two-pixel inset, rounded control radius, and subtle background (`apps/web/src/app/review-layout-annotations.css:319-329`). The outline command uses a token-derived square footprint four pixels larger than the compact control size, auto margin for right alignment, the shared radius and colors, and a subtle border and shadow rather than an underline (`apps/web/src/app/review-layout-annotations.css:288-302`). On coarse pointers, the same four-pixel footprint rule applies to the touch-control token (`apps/web/src/app/review-layout-responsive.css:129-142`).

Geometric centering of an asymmetric glyph may still look off. Center the icon through layout first, then use the smallest explicit optical correction. Here the grid uses `place-items: center`, the icon uses auto margins, and a `.5px` horizontal plus `1px` vertical translation corrects the paired-chevron glyph (`apps/web/src/app/review-layout-annotations.css:288-307`). The layout regression test pins both the floating-surface treatment and the optical offset so a later generic button refactor cannot silently undo the alignment (`apps/web/test/review-layout.test.tsx:114-119`).

## Why This Matters

Reversibility preserves reader-authored interface state. Collapse becomes a temporary focus aid rather than a destructive reset, and the reader can safely inspect individual branches before restoring the earlier context. Keeping the snapshot independent from the live set makes that behavior deterministic even when local and bulk actions interleave.

Centralizing state also prevents responsive layout from changing semantics. A shared bottom workspace, a right-docked workspace, and a split tools header may render the action in different places, but they operate on one expansion controller. The tree remains a controlled view, and document-generation changes invalidate all state through one boundary.

Matching the neighboring floating surface makes the command read as part of the workspace's existing control language. Token-derived sizing handles compact and touch contexts, while a narrowly tested optical correction handles the icon's actual visual mass.

## When to Apply

Use this pattern when a bulk command temporarily simplifies a stateful hierarchy and users reasonably expect to recover the exact working state they had before invoking it. It is especially useful when:

- branch state is sparse or user-selected rather than a fixed “all open” preset;
- local branch actions must remain available during the collapsed interval;
- responsive layouts can relocate the action without relocating the content it controls; or
- document or dataset identity can change while the component remains mounted.

Do not use the snapshot as a general undo stack. It represents one reversible overlay with one restore target. If the product needs multiple historical states, cross-session persistence, or command-by-command undo, introduce an explicit history model instead. If collapse is intentionally a destructive preference reset, communicate that behavior rather than presenting a restore-mode toggle.

## Examples

### Restore the exact sparse expansion set

Suppose `Introduction` and `Results` are expanded while `Methods` is collapsed. The bulk action stores `{Introduction, Results}` and presents an empty expanded set. If the reader then opens `Methods`, the live set becomes `{Methods}` while the restore set remains `{Introduction, Results}`. Invoking the bulk action again restores exactly `{Introduction, Results}`. The pure transition and its interleaving regression test encode this behavior (`apps/web/src/review/outline-expansion-state.ts:31-54`, `apps/web/test/reference-workspace.test.tsx:912-940`).

### Render one command across shared and split workspace headers

When the current layout shares the workspace header, `ReviewShell` injects the slot into `ReferenceWorkspace`; otherwise it injects the slot into `OutlineAnnotationsWorkspace` (`apps/web/src/app/ReviewShell.tsx:1827-1845`). Both slots are descendants of the same provider (`apps/web/src/app/ReviewShell.tsx:1761-1763`, `apps/web/src/app/ReviewShell.tsx:1991-1992`), and the server-rendered shell test requires only one outline expansion command (`apps/web/test/review-layout.test.tsx:107-113`).

### Reset on a newly loaded PDF

When the document generation changes, the provider rebuilds state from the new outline's branch IDs instead of retaining the old live set or restore snapshot (`apps/web/src/review/OutlineExpansionController.tsx:44-59`). The same component instance can therefore survive a document change without allowing a restore action to apply branch IDs from the prior PDF.

### Match a floating navbar without sharing its markup

The activity strip and outline command remain separate components, but both derive their geometry and color language from workspace control tokens. The command's compact outer size is `var(--review-control-compact) + 4px`, matching the activity strip's two-pixel inset on both sides, and its right-aligned floating border/shadow treatment avoids introducing a header underline (`apps/web/src/app/review-layout-annotations.css:288-329`). The icon then receives a scoped optical correction that does not perturb other `ReviewIcon` instances (`apps/web/src/app/review-layout-annotations.css:304-307`).

## Related

- [Outline-aware annotation workspace presentation](outline-aware-annotation-workspace-presentation.md) — capability-driven shared and split workspace composition.
- [Native control tooltip contract](../conventions/native-control-tooltip-contract.md) — state-aware accessible naming and tooltip policy for compact native controls.
- [Reliable compact right-docked Reference Tabs](../ui-bugs/reliable-compact-right-docked-reference-tabs.md) — compact floating-control geometry, responsive touch sizing, and build-before-preview validation.
- [Separate Outline interaction states across branch boundaries](../ui-bugs/separate-outline-interaction-states-across-branch-boundaries.md) — Outline branch geometry and rendered visual checks.
- [Adaptive annotation tray framing](../architecture-patterns/adaptive-annotation-tray-framing.md) — mounted workspace and framing-ownership boundaries.
- [PR #71](https://github.com/brad-ross/placekeeper/pull/71) — open implementation; pending merge as of 2026-08-28.
