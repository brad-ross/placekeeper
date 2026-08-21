---
title: Reliable compact right-docked Reference Tabs
date: 2026-08-11
last_updated: 2026-08-21
category: ui-bugs
module: reference_workspace
problem_type: ui_bug
component: frontend_stimulus
severity: high
symptoms:
  - "Switching between two open Reference Tabs could leave the previously active tab selected and report that the requested reference was unavailable."
  - "Send to main and Close appeared as full-height tab partitions instead of compact inset actions."
  - "Right-docked Reference Tabs grew around their actions instead of keeping a bounded width and ellipsizing long titles."
root_cause: logic_error
resolution_type: code_fix
related_components:
  - "testing_framework"
tags:
  - "reference-tabs"
  - "pdf-navigation"
  - "saved-location"
  - "reference-fit-width"
  - "right-dock"
  - "text-ellipsis"
  - "compact-actions"
---

# Reliable compact right-docked Reference Tabs

## Problem

After two Reference Tabs were open and the References workspace reflowed, selecting the inactive tab could focus the clicked control without completing the navigation transaction. The same surface also lacked a stable visual contract: Send-to-main and Close looked like full-height capsule segments, and right-docked tabs grew to accommodate their actions.

The fix, merged in [PR #4](https://github.com/brad-ross/placekeeper/pull/4), makes tab activation recover from stale saved geometry and gives the selector, compact actions, and right-docked rail an explicit sizing contract.

## Symptoms

- The first click on an inactive Reference Tab could leave the previous tab selected and announce `Reference unavailable. Retry when ready.` The click handler itself was intact: the tab button invokes the activation callback directly (`apps/web/src/review/ReferenceWorkspace.tsx:436-454`).
- A rejected restore caused the coordinator to complete the pending switch with `success: false`, retaining the prior active tab (`apps/web/src/review/navigation-coordinator.ts:1247-1269`).
- Only the selected tab renders Send-to-main and Close controls (`apps/web/src/review/ReferenceWorkspace.tsx:421-483`), so full-height action styling made selection change the entire tab's silhouette.
- Selected right-docked tabs expanded around their actions instead of preserving a stable width and truncating their metadata.

## What Didn't Work

### Treating the failure as a pointer-routing bug

The click reached and focused the requested selector, but active state did not change. The failure happened after activation entered the navigation coordinator, so hit-area or event-propagation changes could not fix it (session history).

### Retrying the click in acceptance coverage

A helper that clicked twice made the flow eventually pass while encoding the broken first-click experience as expected behavior. The durable contract is one click followed immediately by the active announcement and selected state in each direction (`test/acceptance/production-flow.spec.ts:1857-1862`).

### Treating a saved physical location as the only destination

A tab's saved zoom, anchor, and alignment are useful only while the viewer geometry remains compatible. Reflow can make `applyLocation` reject that snapshot even though the tab's original PDF target remains valid. Ending the operation at that rejection made a recoverable switch fail.

### Reasoning from the wrong orientation

An early CSS pass reasoned from the vertical tab rules even though right-docked References use a horizontal tab orientation (`apps/web/src/review/ReferenceWorkspace.tsx:193-196`). The vertical `width: 100%` and grid-track rules apply to the bottom presentation, while right presentation owns its width directly on the segment. Geometry fixes and tests must follow the active presentation and orientation rather than a nearby selector that is not rendered in that state.

### Testing production flow against stale assets

The production acceptance host serves `dist/web`, not source CSS (`test/acceptance/production-flow.spec.ts:278-281`). A source-only CSS change therefore appeared ineffective until the web bundle was rebuilt. Repository E2E and visual scripts prevent this by running `pnpm build:web` first (`package.json:27-29`).

### Treating intentional snapshot drift as a product failure

Compact action framing and narrower tabs necessarily changed the Reference scenes. After behavior and measured geometry passed, the affected screenshots were reviewed and updated rather than bending product CSS back toward obsolete baselines (session history). The visual harness disables animation and permits only a small pixel difference (`test/acceptance/review-visual.spec.ts:45-49`).

## Solution

### Recover from stale saved geometry with the canonical target

Reference switching now attempts the saved physical location first. If that fails, it reapplies the tab's immutable original link target with the `reference-fit-width` policy, checking operation currency after each asynchronous step and capturing the new settled location only after success (`apps/web/src/review/navigation-coordinator.ts:1286-1301`). Programmatic applications reset manual-scroll intent before and after each call so the restore itself is not mistaken for user navigation.

```ts
this.dependencies.resetReferenceManualScrollIntent();
let applied = await navigation.applyLocation(tab.settledLocation);
this.dependencies.resetReferenceManualScrollIntent();
if (!this.isCurrent(operation)) return null;
if (!applied) {
  this.dependencies.resetReferenceManualScrollIntent();
  applied = await navigation.applyTarget(tab.originalTarget, 'reference-fit-width');
  this.dependencies.resetReferenceManualScrollIntent();
  if (!this.isCurrent(operation)) return null;
}
return applied ? navigation.captureLocation() : null;
```

The same manual-intent fencing is used when a Reference target is first applied after layout settlement (`apps/web/src/review/navigation-coordinator.ts:1197-1209`). It computes zoom from the usable framing viewport and preserves a vertical author anchor only for destination modes where that anchor is meaningful (`apps/web/src/pdf/viewer-navigation-adapter.ts:157-203`, `apps/web/src/pdf/viewer-navigation-adapter.ts:1193-1235`).

### Reuse the compact action primitive

The selected segment is a padded flex row (`apps/web/src/app/review-layout-annotations.css:740-762`). Reference and annotation actions share one exact compact geometry, border radius, hover surface, and pressed treatment (`apps/web/src/app/review-layout-annotations.css:809-835`). Outline and search row actions use their own selector group with the same compact tokens and interaction geometry (`apps/web/src/app/review-layout-annotations.css:1172-1199`). Close adds danger color without changing shape (`apps/web/src/app/review-layout-annotations.css:837-843`).

```css
.reference-tabs .reference-tab-segment__action,
.annotation-item__action {
  width: var(--review-control-compact);
  min-height: var(--review-control-compact);
  border: 1px solid transparent;
  border-radius: var(--review-radius-control);
  background: transparent;
}
```

Coarse pointers still receive the larger touch target through the responsive override (`apps/web/src/app/review-layout-responsive.css:198-207`).

### Bound right-docked segments and preserve selector shrinkage

Right-docked References use horizontal tabs. The right-presentation segment rule directly owns an `11.5rem` width, maximum width, and flex basis (`apps/web/src/app/review-layout-annotations.css:775-779`). The selector is allowed to shrink within that bounded segment, while title and page-context text own hidden overflow, ellipsis, and no wrapping (`apps/web/src/app/review-layout-annotations.css:791-795`). Vertical grid-track rules belong to the bottom presentation and do not define right-docked width.

The browser contract measures the result rather than inferring it from selector precedence: both rendered tabs must be approximately 184px wide, the selected tab must retain room for its actions, and the two desktop actions must remain approximately 31×31px with visible inset and rounded corners (`test/acceptance/production-flow.spec.ts:1824-1855`).

## Why This Works

A Reference Tab carries two different forms of position:

1. `settledLocation` is a precise physical snapshot for the geometry in which it was captured.
2. `originalTarget` is the durable semantic destination encoded by the PDF link.

Reflow changes the coordinate system but not the destination. Trying `settledLocation` first preserves user scroll and zoom whenever possible; falling back to `originalTarget` reconstructs a valid width-fitted view when the saved coordinates no longer apply. Capturing after either successful path converts the result back into settled state for the new geometry (`apps/web/src/review/navigation-coordinator.ts:1286-1301`). State is not committed until that capture succeeds (`apps/web/src/review/navigation-coordinator.ts:1256-1277`).

The CSS fix follows the same ownership principle. The right-presentation segment rule owns bounded tab width, the selector owns truncation, and the compact action rules own button shape. Each presentation is tested against the orientation the component actually renders.

The tests protect user contracts rather than implementation proxies. The coordinator unit test forces saved-location rejection and requires the canonical fit-width fallback, active identity, and announcement (`apps/web/test/navigation-coordinator.test.ts:890-904`). The production browser flow verifies fixed equal widths, inset action geometry, and successful single-click switching in both directions (`test/acceptance/production-flow.spec.ts:1824-1862`). A dedicated visual scene protects the right-docked composition (`test/acceptance/review-visual.spec.ts:426-434`).

## Prevention

1. **Treat saved viewport state as opportunistic.** Any restore after docking, resizing, responsive recomposition, or viewer remount needs a semantic fallback. For Reference Tabs, retain both `settledLocation` and `originalTarget` and route restoration through the shared helper (`apps/web/src/review/navigation-coordinator.ts:1286-1301`).
2. **Guard every asynchronous geometry step.** Check operation currency after each awaited layout or location-application step, reset manual-scroll intent around programmatic applications, and capture only after the current apply succeeds, so rapid clicks cannot let stale asynchronous work commit (`apps/web/src/review/navigation-coordinator.ts:1286-1301`).
3. **Test one click, not eventual success.** Assert the active announcement and selected state immediately after each click (`test/acceptance/production-flow.spec.ts:1857-1862`).
4. **Measure rendered CSS contracts.** Assert equal row widths, selector shrinkage, action dimensions, inset, and radius. This catches later orientation and padding rules that class-level tests miss (`test/acceptance/production-flow.spec.ts:1824-1855`).
5. **Match tests to active presentation and orientation.** Verify the component's orientation policy before reasoning from vertical or horizontal selectors (`apps/web/src/review/ReferenceWorkspace.tsx:193-196`).
6. **Reuse established action primitives.** Keep shared geometry and interaction styling together; layer contextual danger color or visibility separately (`apps/web/src/app/review-layout-annotations.css:809-843`).
7. **Build before installed-style verification.** Use the repository scripts that rebuild `dist/web` before Playwright (`package.json:27-29`).
8. **Review visual drift after behavioral proof.** First require unit and real-browser geometry/interaction coverage. Then inspect and update only the intentionally changed Reference baselines.

## Related Issues

- [PR #4: fit linked PDFs to the Reference viewer width](https://github.com/brad-ross/placekeeper/pull/4)
- [Reference fit-width plan](../../plans/2026-08-11-001-feat-reference-fit-width-plan.md)
- [Compact Reference Tab actions plan](../../plans/2026-08-10-002-feat-compact-reference-tab-actions-plan.md)
- [Dockable Reference tray plan](../../plans/2026-08-10-001-feat-dockable-reference-tray-plan.md)
- [Reference navigation workspace plan](../../plans/2026-08-09-002-feat-reference-navigation-workspace-plan.md)
- [Adaptive annotation tray framing](../architecture-patterns/adaptive-annotation-tray-framing.md) — complementary guidance for protecting user-owned viewer state while surrounding UI changes.
- [Reference Tab return-to-origin navigation](../architecture-patterns/reference-tab-return-to-origin-navigation.md) — extends the same immutable-target model to an explicit user-triggered return transaction and manual-intent fencing.
- [Prevent Send-to-Main viewport rebound](send-to-main-viewport-rebound.md) — the corrected final-Reference teardown transaction and its viewport-motion proof.
