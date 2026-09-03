---
title: Measured semantic collapse for one-row PDF review toolbars
date: 2026-09-02
category: design-patterns
module: PDF review responsive toolbar
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - A single-row toolbar must preserve document identity and live reading context across browser, split-pane, or embedded-host widths
  - Semantic control groups can move into menus without creating a second page, zoom, history, or readiness state path
  - The width budget depends on rendered filenames, page totals, zoom values, fonts, and pointer-specific control sizing rather than viewport width alone
  - Responsive recomposition must preserve keyboard focus, mounted viewer state, scroll position, and in-progress review work
  - One production review client must present the same compact toolbar behavior in standalone web and embedded VS Code hosts
related_components:
  - ReviewChrome
  - TopBarMenu
  - ReviewShell
  - ViewerControlsSnapshot
  - DocumentActionsMenu
  - Warm Neutral
  - Compact Editorial
  - testing_framework
tags: [responsive-toolbar, progressive-collapse, content-measurement, focus-continuity, single-row-layout, embedded-viewer, coarse-pointer, warm-neutral]
---

# Measured semantic collapse for one-row PDF review toolbars

## Context

A dense PDF toolbar must keep the document identifiable, preserve high-frequency controls, and remain one stable row inside both browser windows and narrow editor columns. Fixed viewport breakpoints cannot reliably decide what fits because required width changes with filename length, page-count digits, zoom value, optional status, font metrics, pointer mode, and host chrome.

The earlier narrow layout wrapped into a second row. Product iteration settled on moving complete semantic groups into compact menus instead, then refined the details: a generic ellipsis did not explain Undo/Redo, rearranged popup controls felt like a second interface, squeezing the filename first destroyed document identity, and stretching the title button across its reserved track made hover styling cover empty space (session history).

The durable pattern is a Responsive Toolbar Presentation chosen from measured intrinsic candidates. The current toolbar defines four ordered states—`expanded`, `historyCompact`, `zoomCompact`, and `navigationCompact`—and keeps a fixed-height, non-wrapping row (`apps/web/src/review/review-chrome-layout.ts:1`, `apps/web/src/app/review-layout-foundation.css:100`, `apps/web/src/app/review-layout-foundation.css:156`). The least-collapsed fitting state preserves a useful filename allocation while moving Edit history first, Zoom second, and Document navigation last.

## Guidance

### Model responsiveness as ordered semantic presentations

Represent every valid toolbar composition explicitly and order it from richest to most compact:

1. `expanded`: history, navigation, and zoom are direct.
2. `historyCompact`: Undo/Redo moves behind one combined trigger.
3. `zoomCompact`: Zoom also moves behind its current-value trigger.
4. `navigationCompact`: Navigation moves behind a trigger that still shows current and total pages.

The renderer encodes this progression, and unit tests lock the order and exact fit edges (`apps/web/src/review/ReviewChrome.tsx:694`, `apps/web/test/review-chrome-layout.test.ts:16`). Missing or invalid measurements fail safely to the most compact supported presentation (`apps/web/src/review/review-chrome-layout.ts:18`, `apps/web/src/review/review-chrome-layout.ts:44`, `apps/web/test/review-chrome-layout.test.ts:109`).

This order expresses product priority. Undo/Redo gives up direct access first while retaining a recognizable paired-icon trigger. Zoom collapses next but retains current percentage. Navigation lasts because page position is core reading context, and even its compact trigger keeps `current / total` visible (`apps/web/src/review/ReviewChrome.tsx:621`, `apps/web/src/review/ReviewChrome.tsx:645`, `apps/web/src/review/ReviewChrome.tsx:670`).

### Measure complete rendered candidates

Render an inert, hidden sizing rack containing every complete presentation. Each candidate includes the same identity footprint, controls, optional document state, and trailing status as the visible row (`apps/web/src/review/ReviewChrome.tsx:700`, `apps/web/src/review/ReviewChrome.tsx:748`). It is `aria-hidden` and inert, so measurement does not create duplicate interaction surfaces (`apps/web/src/review/ReviewChrome.tsx:748`).

Measure the candidates and actual toolbar after layout, feed those widths to a pure chooser, and observe both live and sizing elements with `ResizeObserver` (`apps/web/src/review/ReviewChrome.tsx:225`, `apps/web/src/review/ReviewChrome.tsx:270`). Coalesce reads through one animation frame and remeasure after fonts settle (`apps/web/src/review/ReviewChrome.tsx:270`, `apps/web/src/review/ReviewChrome.tsx:280`). The decision then reacts to real container and content changes rather than guessed global breakpoints.

Use CSS breakpoints only for genuine policy changes—smaller gaps, yielding low-priority status, staged title floors, or touch sizing—not to select the semantic presentation (`apps/web/src/app/review-layout-responsive.css:75`).

### Collapse immediately, expand with runway

Collapse when the current composition no longer fits, but require extra space before restoring a richer one. The chooser applies expansion margin only when moving to a less compact presentation (`apps/web/src/review/review-chrome-layout.ts:14`, `apps/web/src/review/review-chrome-layout.ts:36`). This asymmetry prevents font, scrollbar, and split-pane jitter without leaving controls clipped after a shrink.

Test both directions and multi-level jumps. Exact-fit cases should collapse deterministically; expansion should wait for the configured runway, and sufficient space should restore directly without stepping through intermediate states (`apps/web/test/review-chrome-layout.test.ts:43`, `apps/web/test/review-chrome-layout.test.ts:56`, `apps/web/test/review-chrome-layout.test.ts:95`).

### Relocate control groups without redesigning them

A compact popup is the same group in another place:

- History uses a paired Undo/Redo trigger, then shows Undo followed by Redo (`apps/web/src/review/ReviewChrome.tsx:580`, `apps/web/src/review/ReviewChrome.tsx:621`).
- Navigation preserves Back, Forward, Previous, page value, Next (`apps/web/src/review/ReviewChrome.tsx:592`, `apps/web/src/review/ReviewChrome.tsx:645`).
- Zoom preserves Zoom out, Zoom in, current value, Fit Width (`apps/web/src/review/ReviewChrome.tsx:607`, `apps/web/src/review/ReviewChrome.tsx:670`).

The compact trigger should retain the group's essential state: current/total page for Navigation and current percentage for Zoom (`apps/web/src/review/ReviewChrome.tsx:645`, `apps/web/src/review/ReviewChrome.tsx:670`). Page and zoom editing still use the same state, validation, callbacks, and viewer-published values; the responsive presentation must not create a shadow interaction model (`apps/web/src/review/ReviewChrome.tsx:331`, `apps/web/src/review/ReviewChrome.tsx:435`).

### Reserve title meaning without inflating its hit area

Include a deliberate filename floor in every measured candidate so the chooser collapses lower-priority controls before reducing document identity. The current sizing rack reserves 9rem normally, then responsive policy stages narrower fallbacks below 480px and 360px (`apps/web/src/app/review-layout-foundation.css:30`, `apps/web/src/app/review-layout-foundation.css:189`, `apps/web/src/app/review-layout-responsive.css:96`). The visible title can ellipsize within that allocation (`apps/web/src/app/review-layout.css:248`).

Separate layout reservation from interaction geometry. The title's parent track may flex to keep neighboring groups aligned, but the document-action button uses content width capped by the track (`apps/web/src/app/review-layout.css:264`). Its hover, focus, and click target therefore follow the visible filename rather than unused reserved space. Geometry tests verify that the title trigger is materially narrower than its slot and that moving just past it clears hover without moving other controls (`test/acceptance/review-workflow.spec.ts:282`).

### Transfer focus across recomposition

When measurement replaces a focused direct group with a compact trigger, identify the semantic group before changing presentation, close transient editors or menus, and remember the group that should regain focus (`apps/web/src/review/ReviewChrome.tsx:253`). After render, resolve the group's current anchor and focus it without scrolling (`apps/web/src/review/ReviewChrome.tsx:288`). Version deferred focus work so an old callback cannot dismiss or steal focus from a newer menu (`apps/web/src/review/ReviewChrome.tsx:203`, `test/acceptance/review-workflow.spec.ts:866`).

Use one popup primitive. `TopBarMenu` handles initial enabled-item focus, all-disabled fallback, Escape, roving focus, opener restoration, Tab exit, and geometry tracking for portaled placement (`apps/web/src/review/TopBarMenu.tsx:50`, `apps/web/src/review/TopBarMenu.tsx:65`, `apps/web/src/review/TopBarMenu.tsx:105`, `apps/web/src/review/TopBarMenu.tsx:160`).

### Test geometry as a contract

Across representative and boundary widths, assert fixed row height, no horizontal overflow, non-overlapping ordered rectangles, vertical containment, and the correct title floor (`test/acceptance/review-workflow.spec.ts:966`). Repeat under coarse-pointer rules with touch-sized direct and popup controls (`test/acceptance/review-workflow.spec.ts:1027`). Visual coverage should capture the narrowest presentation with a menu open (`test/acceptance/review-visual.spec.ts:480`).

Run the interaction flows in Chromium and WebKit because popup focus transitions differ (`playwright.config.ts:15`, `playwright.webkit.config.ts:14`, `apps/web/src/review/TopBarMenu.tsx:178`). Finally, exercise the shared production client through the embedded VS Code launch: the production test opens a narrow VS Code surface, checks the compact presentation, uses every group menu, verifies containment, and verifies focus return (`test/acceptance/production-flow.spec.ts:3978`, `test/acceptance/production-flow.spec.ts:4004`, `test/acceptance/production-flow.spec.ts:4016`). Browser success alone does not prove that the packaged extension loaded current assets; manual verification should compare the built and installed bundle and use a fresh host process (session history).

## Why This Matters

Intrinsic measurement makes responsiveness correspond to the content users actually see. A breakpoint-only toolbar can wrap with a long filename, collapse too early with a short one, or change after fonts load. Measuring complete candidates includes those variables directly.

Ordered collapse preserves information hierarchy. Lower-priority immediacy yields before document identity and reading orientation. Keeping popup order identical to the direct group reduces relearning and prevents wide and narrow behavior from drifting.

Hysteresis and focus transfer make recomposition stable rather than twitchy. Separating the title's layout allocation from its interactive box makes the visual affordance truthful without disturbing the carefully balanced row. Cross-browser, touch, and embedded-host tests cover the environments where geometry and focus assumptions are most likely to fail.

## When to Apply

- A toolbar must stay on one row and has multiple groups with a meaningful collapse priority.
- Content-dependent widths make fixed viewport breakpoints unreliable.
- Compact triggers can preserve essential state while detailed controls move into a menu.
- The same client runs in resizable browser, webview, split-pane, or editor containers.
- Focus, touch targets, and popup placement must survive recomposition.

Prefer simpler CSS when wrapping is acceptable, the toolbar has only one fixed group, or every item can shrink without losing meaning. Measurement adds hidden candidates, observers, transition state, and focus bookkeeping; it earns that complexity only when the one-row constraint and semantic priorities are real.

## Examples

### Presentation selection

Given measured widths of 800, 700, 600, and 500 pixels for the ordered presentations, available widths of 800, 799, 699, and 599 select `expanded`, `historyCompact`, `zoomCompact`, and `navigationCompact` respectively (`apps/web/test/review-chrome-layout.test.ts:9`). When expanding, the configured runway keeps the current compact state until the richer candidate has enough extra space (`apps/web/test/review-chrome-layout.test.ts:56`).

### Wide-to-narrow mapping

- Wide: `Undo | Redo` · `Back | Forward | Previous | 3 / 12 | Next` · `Zoom out | Zoom in | 110% | Fit Width`.
- First collapse: paired Undo/Redo trigger; popup still shows `Undo | Redo` (`apps/web/src/review/ReviewChrome.tsx:580`, `apps/web/src/review/ReviewChrome.tsx:621`).
- Second collapse: `110%` trigger; popup keeps `Zoom out | Zoom in | 110% | Fit Width` (`apps/web/src/review/ReviewChrome.tsx:670`).
- Last collapse: `3 / 12` trigger; popup keeps `Back | Forward | Previous | 3 / 12 | Next` (`apps/web/src/review/ReviewChrome.tsx:645`).

### Filename reservation without an oversized target

Avoid stretching the title button across its whole identity slot or shrinking the filename first so every control remains direct. Reserve the title floor during candidate measurement, collapse groups as needed, reduce the floor only at intentional narrow policies, and keep the actual trigger content-fitting while its parent retains layout space (`apps/web/src/app/review-layout-foundation.css:189`, `apps/web/src/app/review-layout-responsive.css:96`, `apps/web/src/app/review-layout.css:264`).

## Related

- [Adaptive annotation tray framing without resizing the PDF viewer](../architecture-patterns/adaptive-annotation-tray-framing.md)
- [Reliable compact right-docked Reference Tabs](../ui-bugs/reliable-compact-right-docked-reference-tabs.md)
- [Native control tooltip contract](../conventions/native-control-tooltip-contract.md)
- [Truthful compact status for live agent context](./truthful-compact-agent-context-status.md)
- [Compact Editorial language for review task and recovery surfaces](./compact-editorial-language-for-annotation-modals.md)
- [Shared production review client with host-specific runtime boundaries](../architecture-patterns/shared-production-review-client-host-runtime-boundaries.md)
- [PR #68: Fully embedded VS Code LaTeX review](https://github.com/brad-ross/placekeeper/pull/68)
