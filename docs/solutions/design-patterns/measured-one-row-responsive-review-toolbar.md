---
title: Measured semantic collapse for one-row PDF review toolbars
date: 2026-09-02
last_updated: 2026-09-26
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
  - Soft Neutral
  - Compact Editorial
  - testing_framework
tags: [responsive-toolbar, progressive-collapse, content-measurement, focus-continuity, single-row-layout, embedded-viewer, coarse-pointer, warm-neutral]
---

# Measured semantic collapse for one-row PDF review toolbars

## Context

A dense PDF toolbar must keep the document identifiable, preserve high-frequency controls, and remain one stable row inside both browser windows and narrow editor columns. Fixed viewport breakpoints cannot reliably decide what fits because required width changes with filename length, page-count digits, zoom value, optional status, font metrics, pointer mode, and host chrome.

The earlier narrow layout wrapped into a second row. Product iteration settled on moving complete semantic groups into compact menus instead, then refined the details: a generic ellipsis did not explain Undo/Redo, rearranged popup controls felt like a second interface, squeezing the filename first destroyed document identity, and stretching the title button across its reserved track made hover styling cover empty space (session history).

The durable pattern is a Responsive Toolbar Presentation chosen from measured intrinsic candidates. The current toolbar defines four ordered states—`expanded`, `historyCompact`, `zoomCompact`, and `navigationCompact`—and keeps a fixed-height, non-wrapping row (`apps/web/src/review/review-chrome-layout.ts`, `apps/web/src/app/review-layout-foundation.css`). The least-collapsed fitting state preserves a useful filename allocation while moving Edit history first, Zoom second, and Document navigation last.

## Guidance

### Model responsiveness as ordered semantic presentations

Represent every valid toolbar composition explicitly and order it from richest to most compact:

1. `expanded`: history, navigation, and zoom are direct.
2. `historyCompact`: Undo/Redo moves behind one combined trigger.
3. `zoomCompact`: Zoom also moves behind its current-value trigger.
4. `navigationCompact`: Navigation moves behind a trigger that still shows current and total pages.

The renderer encodes this progression, and unit tests lock the order and exact fit edges (`apps/web/src/review/ReviewChrome.tsx`, `apps/web/test/review-chrome-layout.test.ts`). Missing or invalid measurements fail safely to the most compact supported presentation (`apps/web/src/review/review-chrome-layout.ts`, `apps/web/test/review-chrome-layout.test.ts`).

This order expresses product priority. Undo/Redo gives up direct access first while retaining a recognizable paired-icon trigger. Zoom collapses next but retains current percentage. Navigation lasts because page position is core reading context, and even its compact trigger keeps `current / total` visible (`apps/web/src/review/ReviewChrome.tsx`).

### Measure complete rendered candidates

Render an inert, hidden sizing rack containing every complete presentation. Each candidate includes the same identity footprint, controls, optional document state, and trailing status as the visible row (`apps/web/src/review/ReviewChrome.tsx`). The one deliberate exception is availability-dependent history: the rack includes only the history actions that are currently available, matching the narrow row that drops unavailable ones (see *Keep availability-dependent controls in fixed slots* below). It is `aria-hidden` and inert, so measurement does not create duplicate interaction surfaces (`apps/web/src/review/ReviewChrome.tsx`).

Measure the candidates and actual toolbar after layout, feed those widths to a pure chooser, and observe both live and sizing elements with `ResizeObserver` (`apps/web/src/review/ReviewChrome.tsx`). Coalesce reads through one animation frame and remeasure after fonts settle (`apps/web/src/review/ReviewChrome.tsx`). The decision then reacts to real container and content changes rather than guessed global breakpoints.

Use CSS breakpoints only for genuine policy changes—smaller gaps, yielding low-priority status, staged title floors, or touch sizing—not to select the semantic presentation (`apps/web/src/app/review-layout-responsive.css`).

### Collapse immediately, expand with runway

Collapse when the current composition no longer fits, but require extra space before restoring a richer one. The chooser applies expansion margin only when moving to a less compact presentation (`apps/web/src/review/review-chrome-layout.ts`). This asymmetry prevents font, scrollbar, and split-pane jitter without leaving controls clipped after a shrink.

Test both directions and multi-level jumps. Exact fits remain in the least-collapsed fitting presentation; shrinking below that width collapses deterministically; expansion should wait for the configured runway, and sufficient space should restore directly without stepping through intermediate states (`apps/web/test/review-chrome-layout.test.ts`).

### Relocate control groups without redesigning them

A compact popup is the same group in another place:

- History uses a paired Undo/Redo trigger, then shows Undo followed by Redo (`apps/web/src/review/ReviewChrome.tsx`).
- Navigation preserves Back, Forward, Previous, page value, Next (`apps/web/src/review/ReviewChrome.tsx`).
- Zoom preserves Zoom out, Zoom in, current value, Fit Width (`apps/web/src/review/ReviewChrome.tsx`).

The compact trigger should retain the group's essential state: current/total page for Navigation and current percentage for Zoom (`apps/web/src/review/ReviewChrome.tsx`). Page and zoom editing still use the same state, validation, callbacks, and viewer-published values; the responsive presentation must not create a shadow interaction model (`apps/web/src/review/ReviewChrome.tsx`).

### Keep availability-dependent controls in fixed slots

Width is not the only thing that can change the row. Undo/Redo, Back/Forward, the page menu's Previous/Next, and Fit Width become available or unavailable as the reader edits, navigates, or reaches the first or last page. Mounting them only when available made the toolbar rearrange itself even though the window never resized. With the fixed-slot change (PR #130, open as of this writing) they always keep their slot and are disabled, not removed, when unavailable (`apps/web/src/review/ReviewChrome.tsx`; Fit Width marks the already-fitted state with `data-fit-width-current`).

Four details make fixed slots work with the measured row:

- **The rack measures only available history.** The sizing rack includes an Undo/Redo cluster only when `canUndo || canRedo`, and Back/Forward only when navigable (`apps/web/src/review/ReviewChrome.tsx:747-749`), while CSS below 760px hides disabled history controls (`apps/web/src/app/neutral-controls.css:429-435`). A first attempt measured every slot; every candidate grew, the chooser collapsed early, and a 320px VS Code embed stopped choosing `expanded` while the filename fell below its floor. The rack must match what the row actually occupies at the widths where the chooser is tight. At wider widths the visible row carries a few disabled slots the rack does not count; that slack was acceptable in the full acceptance suite, but it is the edge to recheck if the gaps or button sizes grow.
- **Scope disabled styling explicitly.** The shared `button:disabled { opacity: .35 }` under `.review-shell` (`apps/web/src/app/review-shell-chrome.css:61-66`) out-ranked the hover-reveal rule that hides Back/Forward at rest, so a disabled Back showed at 35% on an idle bar. Explicit rules set disabled history to `opacity: 0` at rest and `.35` only while the bar is revealed, inside the fine-pointer hover block (`apps/web/src/app/neutral-controls.css:169-177`).
- **Pairs touch; groups keep their gap.** Undo/Redo and Back/Forward sit flush (`gap: 0`, and a negative margin that cancels the toolbar gap between the two history buttons) while groups keep `--pk-toolbar-gap` (`apps/web/src/app/neutral-controls.css:197-207`).
- **Focus and hosts follow the slot, not the enabled state.** When the page step just used becomes disabled at the first or last page, focus moves to the remaining enabled step (`apps/web/src/review/ReviewChrome.tsx:424-438`). On macOS, `[data-review-chrome-group]` is part of the title-bar interactive selector, so the seam between two paired buttons is not a window-drag region (`apps/web/src/macos-entry.tsx:136-150`).

Fixed slots also steady the popups: the page menu keeps its width as steps enable and disable, and only the zoom menu's Horizontal lock, which depends on horizontal overflow, still comes and goes (`test/acceptance/production-flow.spec.ts`, *keeps page and zoom popups aligned on every painted frame as actions change*).

### Reserve title meaning without inflating its hit area

Include a deliberate filename floor in every measured candidate so the chooser collapses lower-priority controls before reducing document identity. The current sizing rack reserves 9rem normally, then responsive policy stages narrower fallbacks below 480px and 360px (`apps/web/src/app/review-layout-foundation.css`, `apps/web/src/app/review-layout-responsive.css`). The visible title can ellipsize within that allocation (`apps/web/src/app/review-layout.css`).

Separate layout reservation from interaction geometry. The title's parent track may flex to keep neighboring groups aligned, but the document-action button uses content width capped by the track (`apps/web/src/app/review-layout.css`). Its hover, focus, and click target therefore follow the visible filename rather than unused reserved space. Geometry tests verify that the title trigger is materially narrower than its slot and that moving just past it clears hover without moving other controls (`test/acceptance/review-workflow.spec.ts`).

### Transfer focus across recomposition

When measurement replaces a focused direct group with a compact trigger, identify the semantic group before changing presentation, close transient editors or menus, and remember the group that should regain focus (`apps/web/src/review/ReviewChrome.tsx`). After render, resolve the group's current anchor and focus it without scrolling (`apps/web/src/review/ReviewChrome.tsx`). Version deferred focus work so an old callback cannot dismiss or steal focus from a newer menu (`apps/web/src/review/ReviewChrome.tsx`, `test/acceptance/review-workflow.spec.ts`).

Use one popup primitive. `TopBarMenu` handles initial enabled-item focus, all-disabled fallback, Escape, roving focus, opener restoration, Tab exit, and geometry tracking for portaled placement (`apps/web/src/review/TopBarMenu.tsx`).

### Test geometry as a contract

Across representative and boundary widths, assert fixed row height, no horizontal overflow, non-overlapping ordered rectangles, vertical containment, and the correct title floor (`test/acceptance/review-workflow.spec.ts`). Repeat under coarse-pointer rules with touch-sized direct and popup controls (`test/acceptance/review-workflow.spec.ts`). Visual coverage should capture the narrowest presentation with a menu open (`test/acceptance/review-visual.spec.ts`).

Tests for availability-dependent controls should assert *present and disabled* rather than absent, and should cover a narrow host where disabled history is dropped (`test/acceptance/production-flow.spec.ts`, `test/acceptance/review-workflow.spec.ts`, `apps/web/test/neutral-chrome-contract.test.tsx`).

Run the interaction flows in Chromium and WebKit because popup focus transitions differ (`scripts/testing/config/playwright.config.ts`, `scripts/testing/config/playwright.webkit.config.ts`, `apps/web/src/review/TopBarMenu.tsx`). Finally, exercise the shared production client through the embedded VS Code launch: the production test opens a narrow VS Code surface, checks the compact presentation, uses every group menu, verifies containment, and verifies focus return (`test/acceptance/production-flow.spec.ts`). Browser success alone does not prove that the packaged extension loaded current assets; manual verification should compare the built and installed bundle and use a fresh host process (session history).

## Why This Matters

Intrinsic measurement makes responsiveness correspond to the content users actually see. A breakpoint-only toolbar can wrap with a long filename, collapse too early with a short one, or change after fonts load. Measuring complete candidates includes those variables directly.

Ordered collapse preserves information hierarchy. Lower-priority immediacy yields before document identity and reading orientation. Keeping popup order identical to the direct group reduces relearning and prevents wide and narrow behavior from drifting.

Availability is a second source of movement, independent of width. Fixed, disabled-when-unavailable slots remove it, but only if the sizing rack still describes the space the row really uses; otherwise the chooser sees inflated candidates and collapses hardest exactly in the narrow embedded hosts it exists to serve.

Hysteresis and focus transfer make recomposition stable rather than twitchy. Separating the title's layout allocation from its interactive box makes the visual affordance truthful without disturbing the carefully balanced row. Cross-browser, touch, and embedded-host tests cover the environments where geometry and focus assumptions are most likely to fail.

## When to Apply

- A toolbar must stay on one row and has multiple groups with a meaningful collapse priority.
- Content-dependent widths make fixed viewport breakpoints unreliable.
- Compact triggers can preserve essential state while detailed controls move into a menu.
- The same client runs in resizable browser, webview, split-pane, or editor containers.
- Focus, touch targets, and popup placement must survive recomposition.
- A control's availability depends on document or history state rather than width; give it a fixed, disabled slot and keep the sizing rack consistent with any width policy that hides it.

Prefer simpler CSS when wrapping is acceptable, the toolbar has only one fixed group, or every item can shrink without losing meaning. Measurement adds hidden candidates, observers, transition state, and focus bookkeeping; it earns that complexity only when the one-row constraint and semantic priorities are real.

## Examples

### Presentation selection

Given measured widths of 800, 700, 600, and 500 pixels for the ordered presentations, available widths of 800, 799, 699, and 599 select `expanded`, `historyCompact`, `zoomCompact`, and `navigationCompact` respectively (`apps/web/test/review-chrome-layout.test.ts`). When expanding, the configured runway keeps the current compact state until the richer candidate has enough extra space (`apps/web/test/review-chrome-layout.test.ts`).

### Wide-to-narrow mapping

- Wide: `Undo | Redo` · `Back | Forward | Previous | 3 / 12 | Next` · `Zoom out | Zoom in | 110% | Fit Width` (every slot present; unavailable ones are disabled, and below 760px unavailable history is dropped).
- First collapse: paired Undo/Redo trigger; popup still shows `Undo | Redo` (`apps/web/src/review/ReviewChrome.tsx`).
- Second collapse: `110%` trigger; popup keeps `Zoom out | Zoom in | 110% | Fit Width` (`apps/web/src/review/ReviewChrome.tsx`).
- Last collapse: `3 / 12` trigger; popup keeps `Back | Forward | Previous | 3 / 12 | Next` (`apps/web/src/review/ReviewChrome.tsx`).

### Filename reservation without an oversized target

Avoid stretching the title button across its whole identity slot or shrinking the filename first so every control remains direct. Reserve the title floor during candidate measurement, collapse groups as needed, reduce the floor only at intentional narrow policies, and keep the actual trigger content-fitting while its parent retains layout space (`apps/web/src/app/review-layout-foundation.css`, `apps/web/src/app/review-layout-responsive.css`, `apps/web/src/app/review-layout.css`).

## Related

- [Adaptive annotation tray framing without resizing the PDF viewer](../architecture-patterns/adaptive-annotation-tray-framing.md)
- [Reliable compact right-docked Reference Tabs](../ui-bugs/reliable-compact-right-docked-reference-tabs.md)
- [Native control tooltip contract](../conventions/native-control-tooltip-contract.md)
- [Truthful compact status for live agent context](./truthful-compact-agent-context-status.md)
- [Compact Editorial language for review task and recovery surfaces](./compact-editorial-language-for-annotation-modals.md)
- [Shared production review client with host-specific runtime boundaries](../architecture-patterns/shared-production-review-client-host-runtime-boundaries.md)
- [PR #68: Fully embedded VS Code LaTeX review](https://github.com/brad-ross/placekeeper/pull/68)
