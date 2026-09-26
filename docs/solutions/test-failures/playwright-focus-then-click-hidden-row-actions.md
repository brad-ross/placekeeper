---
title: Press Enter or hover the row, not focus-then-click, for hidden row actions
date: 2026-09-26
category: test-failures
module: workspace row-action acceptance tests
problem_type: test_failure
component: testing_framework
symptoms:
  - "A test that calls focus() on a row action and then click() times out after 30s"
  - "Playwright reports that the row-action-group wrapper div intercepts pointer events"
  - The failure repeats identically for outline, search-result, and annotation rows
  - A hover-preview test that expects zero row-action-group elements finds one
root_cause: logic_error
resolution_type: test_fix
severity: medium
related_components:
  - RowActionGroup
  - OutlineNavigator
  - AnnotationPeek
tags: [playwright, actionability, focus-visible, row-actions, hover-reveal, acceptance-tests]
---

# Press Enter or hover the row, not focus-then-click, for hidden row actions

## Problem

Acceptance tests that focus a workspace row action (an outline copy-link, "Open … in References", an annotation "Discard …") and then call `.click()` never click. Playwright retries until the 30s test timeout.

## Symptoms

- `await action.focus(); await action.click();` times out.
- The log names the wrapper, not an unrelated overlay: `<div class="row-action-group" data-row-action-count="2">…</div> intercepts pointer events`.
- Outline, search-result, and annotation rows all fail the same way.
- Hover-preview tests that assert `.row-action-group` has count 0 fail, because the group is always mounted.

## What Didn't Work

- Treating these as unrelated pre-existing flakes. The failure is deterministic for any hidden row action reached through `focus()` + `click()`.
- Counting `.row-action-group` to prove actions are hidden. Visibility is carried by the inner `.row-action-group__direct` opacity and pointer-events, not by the wrapper's presence.

## Solution

When the test is about activating the action, activate it from the keyboard:

```ts
// Before: loops on "row-action-group intercepts pointer events"
await outlineCopy.focus();
await outlineCopy.click();

// After
await outlineCopy.focus();
await outlineCopy.press('Enter');
```

This is applied in `test/acceptance/reloadable-links.spec.ts:293` and `:307` (outline copy-link), `test/acceptance/production-flow.spec.ts:3394-3395` (Open in References from an outline row), and `test/acceptance/review-workflow.spec.ts:373-374` (annotation Discard).

When the test is about pointer behaviour, hover the row first so the real reveal happens, then click (`test/acceptance/workspace-row-interactions.spec.ts` hovers rows before touching their actions).

To assert that a preview's actions are hidden, check the inner group's opacity instead of counting the wrapper:

```ts
await expect(peek.locator('.row-action-group__direct')).toHaveCSS('opacity', '0');
```

(`test/acceptance/pdf-mark-design.spec.ts`, `test/acceptance/annotation-behavior-followup.spec.ts`).

## Why This Works

Workspace row actions stay mounted but hidden until intent. `.row-action-group__direct` is `opacity: 0; pointer-events: none` by default and is revealed when its row is hovered or contains a `:focus-visible` element (`apps/web/src/app/review-outline-row-actions.css:147-153`, `:188-199`); annotation and search rows add the same fine-pointer gate plus a corresponding-mark reveal (`apps/web/src/app/neutral-workspace-interactions.css:3-30`). The outline's `.row-action-group` wrapper is absolutely positioned over the row and does not disable pointer events (`apps/web/src/app/review-outline-row-actions.css:112-116`), so at the hidden button's centre the wrapper is the hit target.

In Chromium, a programmatic `focus()` from a test does not match `:focus-visible` here, so it never reveals the actions. Playwright's click checks that the target receives the pointer before it moves the mouse, so the hover that would reveal them never happens either, and every retry fails the same check (behaviour observed in this session's runs, per Playwright's actionability checks). A probe during this work confirmed it: after `focus()`, the direct group computed `opacity: 0` and `pointer-events: none`, and `document.elementFromPoint` at the button centre returned the wrapper.

`press('Enter')` dispatches to the focused button without a pointer hit test. `hover()` on the row triggers the same CSS reveal a user's pointer does.

## Prevention

- For any control revealed by `:hover` or `:focus-visible` inside an interactive positioned ancestor, never chain `focus()` into `click()`. Use `press('Enter')` after focusing, or hover the owning row first.
- Assert hidden state on the element that toggles (opacity, pointer-events), not on the presence of an always-mounted wrapper.
- If an action must stay visible after a pointer click moves focus into its row, model that state in CSS deliberately. On this branch, a clicked search result keeps its actions while its navigation button has focus (`li[data-search-result][data-active="true"]:has(.annotation-item__navigation:focus)` in `apps/web/src/app/neutral-workspace-interactions.css`), matching annotation rows that stay revealed while their mark is highlighted.

## Related Issues

- [Native control tooltip contract](../conventions/native-control-tooltip-contract.md): the same modality rule (programmatic focus is not keyboard focus) from the tooltip side.
- [Separate outline interaction states across branch boundaries](../ui-bugs/separate-outline-interaction-states-across-branch-boundaries.md)
- [Wait for committed wheel zoom before pointer selection](./wait-for-committed-wheel-zoom-before-pointer-selection.md)
- Found while bringing the acceptance suite up to date on PR #130 (open as of this writing).
