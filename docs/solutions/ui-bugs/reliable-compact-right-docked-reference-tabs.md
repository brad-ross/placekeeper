---
title: "Reliable compact right-docked Reference Tabs"
date: "2026-08-11"
last_updated: "2026-09-07"
category: "ui-bugs"
module: "reference_workspace"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "high"
symptoms:
  - "Switching Reference Tabs after reflow could leave the prior tab selected and report reference unavailable"
  - "Send to main and Close stretched into full-height tab partitions"
  - "Reference tabs expanded around actions instead of respecting bounded title and action geometry"
  - "Search actions stretched with multiline result cards"
root_cause: "logic_error"
resolution_type: "code_fix"
related_components:
  - "ReferenceWorkspace"
  - "NavigationCoordinator"
  - "Search Result"
  - "ReviewTooltipButton"
tags:
  - "reference-tabs"
  - "pdf-navigation"
  - "saved-location"
  - "reference-fit-width"
  - "right-dock"
  - "text-ellipsis"
  - "compact-actions"
  - "pdf-search"
---

# Reliable compact right-docked Reference Tabs

## Problem

After two Reference Tabs were open and the workspace reflowed, selecting an inactive tab could focus its control without completing the switch. Separately, actions and tab widths lacked clear sizing ownership: selected tabs expanded around their controls, and Search actions stretched with multiline result cards.

The historical fixes in [PR #4](https://github.com/brad-ross/placekeeper/pull/4) and [PR #69](https://github.com/brad-ross/placekeeper/pull/69) established semantic navigation fallback and explicit control sizing. Current neutral styling retains those principles while replacing the old universal 184 px tab width and 31 px action measurements with content-fitting horizontal tabs under width caps, full-rail vertical tabs, and 26 px desktop actions.

## Symptoms

The original failure looked like an ignored click: the requested selector received focus, the previous tab stayed active, and the workspace reported Reference unavailable. The coordinator's failed restore path completes the switch with `success: false`, which explains why changing pointer hit areas alone cannot resolve this failure (`apps/web/src/review/navigation-coordinator.ts:1353`).

Visual symptoms arose from a different boundary. Tab selectors, metadata, and actions competed for width, while variable-height Search result grids could stretch a group whose controls had only a minimum height (`apps/web/src/app/review-layout-annotations.css:1185`, `apps/web/src/app/review-layout-annotations.css:1440`).

## What Didn't Work

**Treating the switch as pointer routing.** Focusing the requested selector proved that activation reached the UI. The rejected navigation transaction, not the click target, owned the failure. Diagnose the state transition after the click before changing event propagation.

**Retrying clicks in tests.** A helper that clicked twice concealed the first-click failure. The installed-viewer scenario uses one click in each direction and then checks the active announcement and selected state (`test/acceptance/production-flow.spec.ts:2452`). Keep that contract rather than accepting eventual success after repeated input.

**Treating saved geometry as the only destination.** A precise viewport snapshot may become inapplicable after reflow while the original PDF destination remains valid. Rejecting the whole switch when `applyLocation` fails discards that recoverable semantic authority.

**Reasoning from the wrong orientation or an earlier CSS declaration.** Bottom References with the dedicated References header use vertical tabs; right-docked References use horizontal tabs (`apps/web/src/review/ReferenceWorkspace.tsx:205`). Vertical track sizing therefore cannot explain right-docked width. Likewise, the older right-presentation rule still declares a fixed width, but the later neutral rule overrides width and flex basis. Read the effective cascade before documenting geometry (`apps/web/src/app/review-layout-annotations.css:788`, `apps/web/src/app/neutral-chrome.css:1898`).

**Testing stale or unstyled assets.** Installed-style acceptance serves `dist/web`, not live source CSS (`test/acceptance/production-flow.spec.ts:484`). Earlier investigation mistook stale bundles and a wrongly opened development page for ineffective CSS. Rebuild first and verify the expected stylesheet is loaded; repository E2E and visual scripts already rebuild (`package.json:54`).

**Equating minimum height with fixed height.** `min-height` is a floor. A grid row can still stretch the action group to match a tall result. The fix needs cross-axis alignment and explicit action height, not another minimum.

**Restoring obsolete screenshots.** Intentional compact styling changes alter baselines. Review visual differences after navigation and geometry checks pass rather than changing product CSS solely to reproduce an older silhouette.

## Solution

### Restore exact position first, then the immutable target

`restoreReferenceLocation` tries `tab.settledLocation`. If the viewer rejects it, the coordinator applies `tab.originalTarget` using `reference-fit-width`. It resets manual-scroll intent around each programmatic application, checks operation currency after each await, and captures the resulting location only after successful application (`apps/web/src/review/navigation-coordinator.ts:1383`).

This fallback preserves the precise saved pan and zoom when possible without making them the only route to the document. The caller commits a successful switch only after receiving a settled location; otherwise it completes the failure path and reports unavailability (`apps/web/src/review/navigation-coordinator.ts:1353`). The focused unit test forces saved-location rejection and checks canonical-target recovery (`apps/web/test/navigation-coordinator.test.ts:960`).

### Let tabs fit content within the right cap

Horizontal tabs use `width: max-content`, `min-width: min(112px, 100%)`, and `flex-basis: auto`. The right-presentation `max-width: 11.5rem` remains the cap. Vertical tabs use `width: 100%` and fill their rail regardless of title length (`apps/web/src/app/neutral-chrome.css:1898`, `apps/web/src/app/review-layout-annotations.css:788`, `apps/web/src/app/review-layout-annotations.css:910`). Restrict the content-fitting override by tab orientation: both right-docked References and the unified bottom workspace use horizontal tabs, while dedicated bottom References uses a vertical list.

Allow the selector to shrink with `min-width: 0`, and retain hidden overflow, ellipsis, and no wrapping on metadata (`apps/web/src/app/neutral-chrome.css:713`, `apps/web/src/app/review-layout-annotations.css:804`). This assigns bounded width to the segment and truncation to its text instead of expanding the tab around actions.

### Keep actions compact independently of content

Current Reference actions use explicit 26 px width, height, minimums, and flex basis with rounded transparent surfaces. Coarse pointers receive 44 px geometry (`apps/web/src/app/neutral-chrome.css:744`, `apps/web/src/app/neutral-chrome.css:1767`). The older 31 px measurement is not current acceptance guidance.

Search retains its separate anti-stretch rule: center the action group in the result grid and assign explicit compact height to direct, Copy Link, and overflow controls (`apps/web/src/app/review-layout-annotations.css:1235`). Preserve this relationship when tokens or visual styling change. A taller card should not redefine action height.

## Why This Works

A tab has two forms of position authority: `settledLocation` describes a precise captured viewport, while `originalTarget` describes the immutable destination. Reflow can invalidate the former without invalidating the latter. Fallback reconstructs a valid view and captures a new physical snapshot; generation checks prevent obsolete asynchronous work from owning the switch.

The sizing fix uses the same separation. Segments own bounded content width, text owns truncation, controls own their dimensions, and Search cards own variable content height. Explicit ownership avoids relying on incidental grid stretching or declarations overridden later in the stylesheet.

## Prevention

Keep one-click switching assertions and the rejected-location fallback unit test. Measure the rendered active orientation, including selector shrinkage and compact/touch actions, after rebuilding installed assets. Current production coverage measures 26 px actions and successful switching (`test/acceptance/production-flow.spec.ts:2445`). Its two fixture tabs reach the 184 px cap (`test/acceptance/production-flow.spec.ts:2441`); that does not establish a universal equal-width requirement for short titles. The browser regression separately requires full-rail vertical rows and short-title shrinking with the 112 px minimum in both horizontal layouts (`test/acceptance/workspace-row-interactions.spec.ts:228`). The earlier test mistakenly encoded shrinking for the vertical layout; measuring the rail relationship prevents that regression.

When changing sizing, inspect late neutral overrides and verify both direct and overflow action presentations. When changing navigation, guard each awaited operation and preserve both exact viewport state and the canonical target. Review intentional screenshots only after behavioral and geometry evidence is coherent.

Related: [Reference return-to-origin navigation](../architecture-patterns/reference-tab-return-to-origin-navigation.md) extends immutable-target authority to explicit return; [adaptive overlay framing](../architecture-patterns/adaptive-annotation-tray-framing.md) protects reading state during passive layout; [Send-to-Main rebound](send-to-main-viewport-rebound.md) covers final-Reference teardown.
