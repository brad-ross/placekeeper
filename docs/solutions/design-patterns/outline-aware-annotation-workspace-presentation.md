---
title: Content-aware annotation workspace presentation
date: 2026-08-11
last_updated: 2026-09-10
category: design-patterns
module: PDF review workspace presentation
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - Optional workspace destinations follow current content; core Annotations retains an informative empty state
  - A selected optional mode may disappear after the final reference is removed or Outline absence is confirmed
  - Responsive presentations share one workspace mode model while docking controls remain contextual
  - Annotation metadata is derived from optional document structure
  - A compact activity strip must adapt cleanly to a variable number of destinations
related_components:
  - ReviewShell
  - OutlineAnnotationsWorkspace
  - ReferenceWorkspace
  - WorkspaceModeStrip
  - annotation outline context
tags:
  - pdf-review
  - annotation-workspace
  - progressive-disclosure
  - responsive-tabs
  - focus-management
  - reference-tabs
  - content-availability
  - compact-navigation
---

# Content-aware annotation workspace presentation

## Context

The workspace selector represents capabilities that are usable now, not four permanent product slots. A fixed Outline and References bar becomes misleading when a PDF has no outline or the final Reference Tab closes. Search and Annotations remain core capabilities, including the empty annotation state. The problem becomes especially visible in a compact selector: blank or inert destinations make the control look structurally incomplete.

PR #11 originally established outline-aware composition and outline-derived annotation labels. [PR #35](https://github.com/brad-ross/placekeeper/pull/35), merged on 2026-08-17, generalized the rule across all workspace modes and replaced the centered, flex-filling selector with an intrinsic activity strip. The durable pattern is to derive one ordered visible-mode projection from core capabilities and current optional content, use it for tabs and panels, and revalidate selection and focus whenever the projection changes.

This is primarily a state-and-interaction rule. Intrinsic width, icon treatment, selected labels, and inactive-only hover feedback express that rule visually; CSS does not decide whether a capability exists.

## Guidance

### Project one current mode list at the composition boundary

Keep the canonical vocabulary and ordering in one constant, then filter it once from authoritative state (`apps/web/src/review/reference-navigation-state.ts`):

- **References** is available while a Reference Tab exists or a reference load is pending. Pending work still needs a loading, failure, or retry surface; the final settled close removes the capability.
- **Outline** is absent only for a current-generation `loaded-empty` discovery result. `loading` and `unavailable` are meaningful states, and a stale result is normalized to `loading` for the newly mounted document.
- **Annotations** is always available, including an empty review state.
- **Search** is unconditional, so the tools workspace always has a valid fallback.

`ReviewShell` owns these predicates and derives `visibleRightWorkspaceModes` from the same projected list rather than recomputing document capabilities (`apps/web/src/app/ReviewShell.tsx`). The projected list feeds the shared right or narrow workspace and the tools-only workspace; the same `referencesAvailable` predicate supplies `['references']` to the independent bottom workspace (`apps/web/src/app/ReviewShell.tsx`).

Do not reserve placeholders for filtered modes. `WorkspaceModeStrip` maps exactly the supplied array and preserves its order (`apps/web/src/review/WorkspaceModeStrip.tsx`). When the input shrinks, the visual strip, keyboard sequence, and accessible tablist shrink together.

### Keep tabs, panels, rails, and contextual actions under the same predicate

Removing only a tab leaves an unreachable panel and broken `aria-controls` relationships. Removing only a panel leaves a control that points nowhere. Availability must govern the entire capability:

- `OutlineAnnotationsWorkspace` always mounts Search, and mounts Outline and Annotations only when each appears in `modes`. Its panel visibility uses the same effective mode as the selected tab (`apps/web/src/review/OutlineAnnotationsWorkspace.tsx`).
- `ReferenceWorkspace` omits its header when it has no modes and mounts the References panel only when `references` is present (`apps/web/src/review/ReferenceWorkspace.tsx`).
- The bottom References edge rail exists only while References is available, and the right rail stops claiming the References surface after the capability disappears (`apps/web/src/app/ReviewShell.tsx`).
- The move-References action exists only while References is selected and a real docking destination is available. It remains outside the tablist so arrow-key navigation stays mode-only (`apps/web/src/review/ReferenceWorkspace.tsx`, `apps/web/src/review/WorkspaceModeStrip.tsx`).
- The reversible Outline-collapse action exists only while the tools surface is open in Outline mode. Its slot renders outside the tablist in whichever shared or split header owns Outline, suppresses itself when there are no branches, and disables collapse when nothing is expanded and no restore snapshot is pending (`apps/web/src/app/ReviewShell.tsx`, `apps/web/src/review/OutlineExpansionController.tsx`).

Closing the final Reference Tab should not create a separate empty-mode cleanup path. The navigation reducer removes the tab, cancels operations that no longer have a source, and records the return-focus token (`apps/web/src/review/reference-navigation-state.ts`). On the next render, the normal availability projection removes the References tab, panel, docking action, and References-only rail together.

### Revalidate selection without erasing durable workspace memory

Remembered navigation may name a mode that is no longer renderable. Preserve that memory for a future return, but derive a safe selection for the current frame.

The shell accepts a requested mode only when it remains in the projected list; otherwise it chooses the first visible tools mode, with Search as the nonempty final fallback. It revalidates again after responsive layout selects the physical surface (`apps/web/src/app/ReviewShell.tsx`). `OutlineAnnotationsWorkspace` performs the same defensive membership check so a stale selection cannot leave every panel hidden (`apps/web/src/review/OutlineAnnotationsWorkspace.tsx`).

Workspace memory can still retain focus and scroll tokens for all canonical modes (`apps/web/src/review/reference-navigation-state.ts`). Falling back for this render must not destroy useful state merely because a capability is temporarily absent.

### Preserve one logical workspace across right, bottom, and narrow presentations

Availability and docking are separate concerns:

- A shared right or narrow workspace receives every visible mode.
- An independently bottom-docked References workspace receives only `['references']`, and only while References is available.
- The tools workspace receives the projected non-References modes whether it owns its header or shares one rendered by `ReferenceWorkspace`.

Moving References between right and bottom keeps References selected and restores focus after the new layout settles (`apps/web/src/app/ReviewShell.tsx`). Presentation changes should preserve the same mounted workspace and PDF reading state; they rearrange capability ownership rather than recreate navigation or viewer models. See [Adaptive annotation tray framing](../architecture-patterns/adaptive-annotation-tray-framing.md) for the mounted-state contract.

### Repair focus when dynamic removal disconnects a control

Filtering a mode can disconnect the focused tab. After reconciliation, focus a connected selected tab or a meaningful fallback within the selected panel rather than letting focus fall to the document body.

`ReferenceWorkspace` detects when the previously focused mode tab is no longer connected and schedules focus to the remaining selected tab or its panel fallback (`apps/web/src/review/ReferenceWorkspace.tsx`). It similarly repairs focus when a contextual docking action disappears. The tools workspace rejects disconnected focus memory and falls back to the selected panel (`apps/web/src/review/OutlineAnnotationsWorkspace.tsx`).

Arrow-key movement must also use the rendered mode list, not the four-mode constant (`apps/web/src/review/OutlineAnnotationsWorkspace.tsx`). Removing a mode then closes both the visual and keyboard gaps.

### Let the compact strip express the projection

The activity strip flexes within the header; individual tab segments retain content-based sizing. Inactive modes remain compact icon targets; only the selected mode expands to show a label, which can ellipsize. Hover feedback applies only to unselected modes because the selected mode already has a persistent surface treatment (`apps/web/src/app/review-layout-annotations.css`).

Do not derive capability from CSS position, mode count, or viewport. If a destination is unavailable, omit its element. The prior equal-width `repeat(count, 1fr)` grid was useful when tabs filled the entire header, but it is obsolete for an intrinsic activity strip.

### Keep outline-derived annotation metadata generation-safe

Mode availability and row metadata share the same rule: only current, authoritative document structure may affect presentation. Outline discovery distinguishes `loading`, `loaded-empty`, `loaded-tree`, and `unavailable` (`apps/web/src/pdf/pdf-outline.ts`). Discovery with no bookmarks produces `loaded-empty` (`apps/web/src/pdf/pdf-outline.ts`).

Subsection labels are derived only from a matching-generation `loaded-tree` result (`apps/web/src/review/annotation-outline-context.ts`). Loading, confirmed absence, discovery failure, stale generations, unsafe targets, and invalid geometry omit the subsection rather than guess.

Generation agreement must begin at discovery's producer, not only at the consumer guard. A restored native review remained at Loading even though session measurements showed outline parsing finishing in roughly 4–35 milliseconds. The callback had captured generation 0 from mirrored navigation state while canonical bootstrap had already supplied generation 1 and mounted its document assets. The parent correctly rejected the generation-0 result; faster parsing or repeated loading indicators could not repair the identity mismatch.

Pass the canonical workflow generation alongside the document being mounted (`apps/web/src/app/ProductionReviewApp.tsx`). Discovery deduplicates by engine and document generation, starts an authority token for that generation, and publishes loading, loaded, or unavailable only through that token (`apps/web/src/app/App.tsx`). Keep the parent's matching-generation guard intact (`apps/web/src/app/ProductionReviewApp.tsx`). Removing it would make this symptom disappear by allowing stale document structure into the current review. The correction aligns producer and consumer identity; it does not weaken stale-result rejection or turn retries into a substitute for correct bootstrap wiring.

The regression begins with deferred host bootstrap and a resumed generation of 1, then verifies that Overview, Page 2 appears, its click navigates to page 2, and the loading state disappears (`test/acceptance/host-interface.spec.ts`). The harness explicitly supplies generation 1 for `host-resumed` and uses it in the returned bootstrap (`test/acceptance/review-harness/main.tsx`). This catches a race that a fresh generation-0 fixture would mask. It verifies the resumed host bootstrap path and usable outline navigation; the parsing timings are diagnostic session observations, not performance assertions in this test. The correction is part of [PR #87](https://github.com/brad-ross/placekeeper/pull/87), which remains open as of September 7, 2026.

When a current document mounts asynchronously, test with a nonzero generation and ensure its assets, discovery callback, and result consumer receive the same canonical identity before investigating parsing speed or adding retries.

Owned and reviewer-relevant external annotations remain peer sections in the tray. User-owned Review Items stay “Annotations”; PDF-sourced, non-editable marks are “External Annotations (read only).” Navigation-only PDF Links remain document navigation and do not enter this review population. This is presentation of existing domain concepts, not a new entity.

### Test behavior before geometry

Protect the projection at several boundaries:

1. Verify authoritative absence omits both the corresponding tab and panel. Include current `loaded-empty` Outline, final Reference close, pending References, and stale-generation Outline results. Separately require a usable empty Annotations tab and panel.
2. Render a selected mode absent from the supplied array and assert Search is selected, visible, and labelled by a real tab.
3. Remove a focused mode live and assert focus moves to a connected destination. Repeat while References is selected to prove an unrelated mode removal does not change the active capability.
4. Close or send the final reference and assert its tab, panel, docking action, and edge rail disappear together.
5. Click both workspace modes and individual Reference Tab selectors; assert `aria-selected` changes. Static screenshots cannot detect an overlay or pointer regression.
6. Measure individual tab-segment sizing, compact inactive targets, selected-label expansion, and contextual-action placement in a real browser. Keep stylesheet-shape assertions as a fast warning, not a substitute for behavior.
7. Run responsive and focus-sensitive coverage in Chromium and WebKit.

For negative annotation-label tests, begin with a valid annotation, page geometry, and resolvable outline destination, then change exactly one condition. Otherwise an empty fixture can make the test pass without exercising the intended guard.

## Why This Matters

A navigation control is a promise that a meaningful destination exists. Content-aware projection keeps that promise: no Outline tab for a definitively outline-free PDF, an informative Annotations empty state before any review or discovered annotation exists, and no References tab or rail after the final reference closes. Loading, failure, retry, and pending states remain available when they are themselves informative.

Central projection also prevents responsive drift. Right, bottom, and narrow presentations arrange capabilities differently, but they do not invent separate availability rules. Selection fallback, roving tab order, panel mounting, docking actions, focus restoration, and edge rails all consume the same current set.

Finally, separating state from polish keeps the design maintainable. The compact strip looks balanced with one, two, three, or four modes because unavailable elements do not exist. Icons, labels, hover, and compound References styling can evolve without reopening document-capability semantics.

## When to Apply

- A workspace mode depends on asynchronous document discovery, user-created data, or an open-resource collection.
- Responsive layouts move the same modes among shared, split, right-docked, and bottom-docked surfaces.
- A selected tab or contextual action may disappear while the workspace remains open.
- Derived labels depend on both current document identity and optional document structure.
- Keyboard and assistive-technology relationships must remain exact while the visible mode count changes.

Do not hide a capability merely because its content collection is empty when its empty state is actionable or informative. Here, pending References and Outline loading or failure remain available; only authoritative absence removes a mode. Annotations remains available as a stable core capability.

## Examples

### PDF with no optional workspace content

If Outline is current `loaded-empty`, there are no owned or discovered annotations, and no reference is open or pending, project `['search', 'annotations']`. Render Search and Annotations, including its empty state. Omit Outline, References, the docking action, and the bottom References rail. A remembered removed mode falls back to Search for this render without deleting its memory.

### Outline and References, but no annotations

The shared list is `['outline', 'search', 'annotations', 'references']`; the tools-only list is `['outline', 'search', 'annotations']`. Attach the move action only when References is selected. When References is independently bottom-docked, its strip contains only References while the right tools tray retains Outline, Search, and Annotations.

### Final Reference Tab closes while References is selected

Remove the tab from navigation state, record the return-focus token, and let the next projection remove References everywhere. Revalidate the selected mode and focus a connected tab or panel. Do not leave a reopen rail leading to an empty workspace or manufacture an empty Reference Tab to preserve selection.

### Outline disappears during discovery refresh

A current `loaded-tree` changing to current `loaded-empty` removes the Outline tab and panel in one render. If Outline held focus, redirect focus to the effective remaining mode. If the empty result belongs to an old document generation, normalize it away and retain Outline until current discovery resolves.

### External annotation context

For a current `loaded-tree`, owned and reviewer-relevant external annotations may show their containing subsection. Residual Existing PDF Annotation rows remain read-only; native annotations imported as Review Items use the managed item path. Navigation-only PDF annotations stay out of the review list (`apps/web/src/pdf/existing-annotations.ts`; `apps/web/src/review/AnnotationList.tsx`). For loading, unavailable, stale, or confirmed-empty outline state, omit subsection labels.

## Related

- [Adaptive annotation tray framing without resizing the PDF viewer](../architecture-patterns/adaptive-annotation-tray-framing.md)
- [Reliable compact right-docked Reference Tabs](../ui-bugs/reliable-compact-right-docked-reference-tabs.md)
- [Prevent Send-to-Main viewport rebound](../ui-bugs/send-to-main-viewport-rebound.md)
- [Native control tooltip contract](../conventions/native-control-tooltip-contract.md)
- [PR #11: compact outline and annotation context](https://github.com/brad-ross/placekeeper/pull/11)
- [PR #35: compact workspace tray navigation](https://github.com/brad-ross/placekeeper/pull/35)
