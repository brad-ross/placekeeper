---
title: Measured semantic collapse for one-row PDF review toolbars
date: 2026-09-02
last_updated: 2026-11-07
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

The durable requirement is a stable Toolbar Presentation whose measurements describe the controls it actually renders. The original four-state collapse design and its chooser remain useful historical context, but they do not describe the current menu-placement policy.

## Current policy and verified corrections

[PR #165](https://github.com/brad-ross/placekeeper/pull/165) replaced the fine-pointer gap squeeze with a measured fallback. The filename ellipsizes as room shrinks and yields to the file icon below 56px of text room. If even the icon and direct controls cannot fit at normal spacing, Undo/Redo move into Edit history and Back/Forward move into Page navigation, on any pointer type. Coarse-pointer viewports at 480px or less also retain their explicit touch composition (`apps/web/src/review/review-chrome-layout.ts:78`, `apps/web/src/review/ReviewChrome.tsx:217`, `apps/web/src/review/ReviewChrome.tsx:346`).

The earlier below-760px rule omitted disabled history actions. Preserve those actions in their direct slots or compact menu entries so availability alone does not rearrange the row.

Electron must mark whole `[data-review-chrome-group]` elements as `no-drag`, including gaps between controls. Before this correction, a real native drag in the 8px Copy-to-Back seam moved the window by 60px horizontally and 40px vertically. The fresh packaged app stayed stationary for that seam drag while blank toolbar space still moved it by 60px and 40px. This was a native CGEvent check, separate from DOM geometry; the focused installed check also passed.

The earlier native and touch correction passed 82 unit checks, typechecking, 11 Chromium checks, seven WebKit checks, and all 12 installed checks against the freshly packaged macOS app (1.0 minute), including three SyncTeX checks and the group `no-drag` assertion. Back/Forward remain reachable for one-page or page-unready documents, and keyboard focus follows the natural Undo/Redo or Back/Forward order when an action becomes disabled. Focused correctness and independent adversarial reviews found no actionable issues. This is focused evidence, not a new full-suite pass.

## Guidance

### Historical design: ordered semantic presentations

Represent every valid toolbar composition explicitly and order it from richest to most compact:

1. `expanded`: history, navigation, and zoom are direct.
2. `historyCompact`: Undo/Redo moves behind one combined trigger.
3. `zoomCompact`: Zoom also moves behind its current-value trigger.
4. `navigationCompact`: Navigation moves behind a trigger that still shows current and total pages.

The chooser still encodes this progression, and unit tests lock its order and fit edges (`apps/web/src/review/review-chrome-layout.ts`, `apps/web/test/review-chrome-layout.test.ts`). The current renderer's `controlsForPresentation` and `sizingCluster` do not branch on those candidate labels; menu relocation follows the measured history fallback and the compact-touch policy (`apps/web/src/review/ReviewChrome.tsx:217`). A passing chooser test therefore does not prove that a narrower label renders a smaller toolbar.

That order expressed the earlier design's priorities. Do not infer current Zoom or Navigation collapse behavior from the retained names.

### Measure complete rendered candidates

Keep the hidden sizing rack consistent with the rendered controls. The current rack uses simplified identity and control proxies, not a second copy of the visible toolbar; its measurements cannot substitute for checking actual layout (`apps/web/src/review/ReviewChrome.tsx:1066`). History measurement must include every direct slot reserved by the current pointer/width composition, regardless of availability (see *Keep availability-dependent controls in fixed slots* below). The rack is `aria-hidden` and inert, so it does not create duplicate interaction surfaces.

The toolbar measures candidates after layout, observes live and sizing elements with `ResizeObserver`, coalesces reads through an animation frame, and remeasures after fonts settle (`apps/web/src/review/ReviewChrome.tsx:427`). Keep these measurements consistent with the rendered composition; the retained chooser alone cannot correct a layout that exceeds its viewport.

### Subtract the width compaction freed before expanding

Measure room from the live row after reserving the control clusters, normal gaps, context status, and document trigger chrome. Exclude the currently rendered filename width so showing or hiding it does not change the budget for that same decision (`apps/web/src/review/ReviewChrome.tsx:37`).

After combining history, the live row has more free space because those controls moved. Comparing that space directly with the expanded threshold can restore the controls immediately, recreate overflow, and collapse the row again. Measure the room freed across the transition, subtract it from compact room when deciding whether to expand, and require extra runway. Keep the title icon-only while the measured history fallback is active so the saved space cannot bring the title back prematurely (`apps/web/src/review/ReviewChrome.tsx:461`, `apps/web/src/review/review-chrome-layout.ts:104`).

The chooser test models a collapse that frees 70px. A compact row with 75px free stays compact because the expanded row would have only 5px of runway. With the default 16px runway it expands at 86px free (`apps/web/test/review-chrome-layout.test.ts`). Keep rendered geometry checks alongside this arithmetic check to catch drift between measured and painted controls.

### Historical chooser: collapse immediately, expand with runway

For distinct rendered candidates, collapse when the current composition no longer fits, but require extra space before restoring a richer one. The retained chooser applies expansion margin only when moving to a less compact label (`apps/web/src/review/review-chrome-layout.ts`). This is a chooser property, not evidence that current controls relocate at each label transition.

Test both directions and multi-level jumps. Exact fits remain in the least-collapsed fitting presentation; shrinking below that width collapses deterministically; expansion should wait for the configured runway, and sufficient space should restore directly without stepping through intermediate states (`apps/web/test/review-chrome-layout.test.ts`).

### Relocate control groups without redesigning them

A compact popup is the same group in another place:

- Compact Edit history opens Undo followed by Redo.
- Compact Page navigation adds Back and Forward before Previous and Next; the current page remains in the toolbar.
- Page and zoom values remain directly editable. This correction does not introduce a new zoom-collapse mode (`apps/web/src/review/ReviewChrome.tsx`).

The compact trigger should retain the group's essential state: current/total page for Navigation and current percentage for Zoom (`apps/web/src/review/ReviewChrome.tsx`). Page and zoom editing still use the same state, validation, callbacks, and viewer-published values; the responsive presentation must not create a shadow interaction model (`apps/web/src/review/ReviewChrome.tsx`).

### Keep availability-dependent controls in fixed slots

Width is not the only thing that can change the row. Undo/Redo, Back/Forward, the page menu's Previous/Next, and Fit Width become available or unavailable as the reader edits, navigates, or reaches the first or last page. Keep them present and disabled when unavailable so state changes do not rearrange the row or menu. In the compact composition, this requirement applies inside the history and navigation menus as well as to their stable triggers. The below-760px exception was a confirmed regression and has been removed. Fit Width marks the already-fitted state with `data-fit-width-current` (`apps/web/src/review/ReviewChrome.tsx`).

Four details make fixed slots work with the measured row:

- **The rack measures the complete composition.** Direct layouts reserve all four Undo/Redo and Back/Forward slots. Compact measurement instead matches its one history trigger and page-navigation trigger. Availability never changes that reserved space (`apps/web/src/review/ReviewChrome.tsx`).
- **Scope disabled styling explicitly.** The shared `button:disabled { opacity: .35 }` under `.review-shell` (`apps/web/src/app/review-shell-chrome.css:61-66`) out-ranked the hover-reveal rule that hides Back/Forward at rest, so a disabled Back showed at 35% on an idle bar. Explicit rules set disabled history to `opacity: 0` at rest and `.35` only while the bar is revealed, inside the fine-pointer hover block (`apps/web/src/app/neutral-controls.css:169-177`).
- **Pairs touch; groups keep their gap.** Undo/Redo and Back/Forward sit flush (`gap: 0`, and a negative margin that cancels the toolbar gap between the two history buttons) while groups keep `--pk-toolbar-gap` (`apps/web/src/app/neutral-controls.css:197-207`).
- **Focus and hosts follow the slot, not the enabled state.** When the page step just used becomes disabled, focus moves to the remaining enabled step (`apps/web/src/review/ReviewChrome.tsx`). Electron's `no-drag` selector includes whole `[data-review-chrome-group]` elements as well as individual interactive controls, protecting paired-button seams (`apps/web/src/app/review-shell-chrome.css`). Verify seam protection and blank-space dragging on the actual native window.

Native drag regions suppress DOM pointer events, so CSS `:hover` alone cannot reveal controls across the blank draggable toolbar. Electron samples the OS cursor against the native content bounds, scales the toolbar boundary with interface zoom, and publishes changes while the window is focused and visible (`apps/electron/src/titlebar.ts`). The renderer projects that signal into the existing reveal rules (`apps/web/src/electron-entry.tsx`, `apps/web/src/app/neutral-controls.css`). Keep native hover evidence separate from DOM hit testing, and stop sampling when the window is inactive. Browser geometry and CDP hover checks do not establish native dragging; the [qualification record](../../testing/electron-migration-qualification.md) records their separate evidence.

Fixed slots also steady the popups: the page menu keeps its width as steps enable and disable, and only the zoom menu's Horizontal lock, which depends on horizontal overflow, still comes and goes (`test/acceptance/production-flow.spec.ts`, *keeps page and zoom popups aligned on every painted frame as actions change*).

### Reserve title meaning without inflating its hit area

Treat filename space and the document action's usable target as separate requirements. The measured title policy hides filename text below its readability threshold while retaining its full accessible name and document action. With more room, the text ellipsizes (`apps/web/src/app/neutral-controls.css`, `apps/web/src/review/ReviewChrome.tsx`). Do not claim that the retained chooser guarantees a filename floor before controls collapse.

Keep the title's layout and interaction geometry consistent. The neutral toolbar uses a content-sized identity track and caps both the identity and its trigger, so truncation does not leave a large empty gap before the page controls (`apps/web/src/app/neutral-controls.css:76`). The geometry test checks title truncation and limits trailing identity space to one pixel; it does not establish a wider reserved slot around the trigger (`test/acceptance/review-workflow.spec.ts:1264`).

### Transfer focus across recomposition

When a width or input policy moves a focused action, capture its semantic group before recomposition and restore focus to a visible anchor afterward. The coarse-pointer media transition implements that capture and restore. The measured history fallback closes open menus and preserves a pending document menu, but uses a separate resize path (`apps/web/src/review/ReviewChrome.tsx:345`, `apps/web/src/review/ReviewChrome.tsx:467`). Test natural keyboard continuation after an action disables its own menu item, since programmatically focusing the next item can mask lost focus (`test/acceptance/review-workflow.spec.ts`).

Use one popup primitive. `TopBarMenu` handles initial enabled-item focus, all-disabled fallback, Escape, roving focus, opener restoration, Tab exit, and geometry tracking for portaled placement (`apps/web/src/review/TopBarMenu.tsx`).

### Test geometry as a contract

Across representative and boundary widths, assert fixed row height, no horizontal overflow, non-overlapping ordered rectangles, vertical containment, and the correct title floor (`test/acceptance/review-workflow.spec.ts`). Repeat under coarse-pointer rules with touch-sized direct and popup controls (`test/acceptance/review-workflow.spec.ts`). Visual coverage should capture the narrowest presentation with a menu open (`test/acceptance/review-visual.spec.ts`).

Compare the toolbar's bounds with the viewport as well as checking `scrollWidth <= clientWidth`. During this fix, the touch toolbar expanded beyond the viewport while those two internal widths still agreed, so the older overflow assertion passed. The corrected test also checks the toolbar's left and right edges against the viewport (`test/acceptance/review-workflow.spec.ts:1755`). This is why an element-relative overflow check alone is insufficient (session history).

Tests for availability-dependent controls should assert *present and disabled* rather than absent, and should cover 759px/760px availability changes plus the actual 320px fine- and coarse-pointer viewports (`test/acceptance/production-flow.spec.ts`, `test/acceptance/review-workflow.spec.ts`, `apps/web/test/neutral-chrome-contract.test.tsx`).

Run the interaction flows in Chromium and WebKit because popup focus transitions differ (`scripts/testing/config/playwright.config.ts`, `scripts/testing/config/playwright.webkit.config.ts`, `apps/web/src/review/TopBarMenu.tsx`). Verify packaged-host behavior separately: browser tests do not establish which assets a host loaded or whether an OS drag region consumes input. The native check needs both a protected control-group gap and draggable blank toolbar space as its comparison.

## Why This Matters

Intrinsic measurement makes responsiveness correspond to the content users actually see. A breakpoint-only toolbar can wrap with a long filename, collapse too early with a short one, or change after fonts load. Measuring complete candidates includes those variables directly.

A compact composition must preserve access to every relocated action. A page-only availability rule cannot guard a menu that now also holds document history: single-page or page-unready documents can still have Back/Forward history. Keep menu availability tied to all of its contents, and test both states (`apps/web/src/review/ReviewChrome.tsx`, `test/acceptance/review-workflow.spec.ts`).

Availability is a second source of movement, independent of width. Fixed disabled slots remove it only when the sizing rack reserves those same slots. Measuring only enabled actions undercounts the row and changes its measured width as history becomes available.

Focus transfer and complete geometry checks keep recomposition usable. Separating the title's layout allocation from its interactive box preserves a usable action even when text yields space. Cross-browser, touch, and native-host checks cover different failure modes; none substitutes for the others.

## When to Apply

- A toolbar must stay on one row and has multiple groups with a meaningful collapse priority.
- Content-dependent widths make fixed viewport breakpoints unreliable.
- Compact triggers can preserve essential state while detailed controls move into a menu.
- The same client runs in resizable browser, webview, split-pane, or editor containers.
- Focus, touch targets, and popup placement must survive recomposition.
- A control's availability depends on document or history state rather than width; give it a fixed, disabled slot or menu entry and keep the sizing rack consistent with the complete composition.

Prefer simpler CSS when wrapping is acceptable, the toolbar has only one fixed group, or every item can shrink without losing meaning. Measurement adds hidden candidates, observers, transition state, and focus bookkeeping; it earns that complexity only when the one-row constraint and semantic priorities are real.

## Examples

### Retained chooser selection, not rendered composition

Given measured widths of 800, 700, 600, and 500 pixels for the ordered presentations, available widths of 800, 799, 699, and 599 select `expanded`, `historyCompact`, `zoomCompact`, and `navigationCompact` respectively (`apps/web/test/review-chrome-layout.test.ts`). When expanding, the configured runway keeps the current compact state until the richer candidate has enough extra space (`apps/web/test/review-chrome-layout.test.ts`).

### Historical four-state wide-to-narrow mapping

- Wide: `Undo | Redo` · `Back | Forward | Previous | 3 / 12 | Next` · `Zoom out | Zoom in | 110% | Fit Width` (every slot present; unavailable ones are disabled).
- First collapse: paired Undo/Redo trigger; popup still shows `Undo | Redo` (`apps/web/src/review/ReviewChrome.tsx`).
- Second collapse: `110%` trigger; popup keeps `Zoom out | Zoom in | 110% | Fit Width` (`apps/web/src/review/ReviewChrome.tsx`).
- Last collapse: `3 / 12` trigger; popup keeps `Back | Forward | Previous | 3 / 12 | Next` (`apps/web/src/review/ReviewChrome.tsx`).

### Filename reservation without an oversized target

Keep the title action content-fitting where text is shown. Where the narrow policy hides text, retain the full accessible name and verify the action's target independently of the identity track. An internally non-overflowing toolbar can still extend past the viewport or squeeze that action below its minimum (`apps/web/src/app/neutral-controls.css`, `test/acceptance/review-workflow.spec.ts`).

## Related

- [Adaptive annotation tray framing without resizing the PDF viewer](../architecture-patterns/adaptive-annotation-tray-framing.md)
- [Reliable compact right-docked Reference Tabs](../ui-bugs/reliable-compact-right-docked-reference-tabs.md)
- [Native control tooltip contract](../conventions/native-control-tooltip-contract.md)
- [Truthful compact status for live agent context](./truthful-compact-agent-context-status.md)
- [Compact Editorial language for review task and recovery surfaces](./compact-editorial-language-for-annotation-modals.md)
- [Shared production review client with host-specific runtime boundaries](../architecture-patterns/shared-production-review-client-host-runtime-boundaries.md)
- [PR #165](https://github.com/brad-ross/placekeeper/pull/165)
- [PR #68: Fully embedded VS Code LaTeX review](https://github.com/brad-ross/placekeeper/pull/68)
