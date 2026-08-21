---
title: Native control tooltip contract for the PDF review interface
date: 2026-08-12
last_updated: 2026-08-20
category: conventions
module: web-review-interface
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Adding or changing native controls in apps/web/src"
  - "Using icon-only actions in the PDF review interface"
  - "Reviewing hover text and accessible action labels"
  - "Preventing tooltip coverage regressions across TSX components"
  - "Suppressing a native tooltip when visible hover feedback would conflict with a transient utility action"
related_components:
  - "frontend-stimulus"
  - "copy-link-control"
tags:
  - "accessibility"
  - "native-controls"
  - "tooltips"
  - "icon-buttons"
  - "typescript-ast"
  - "ui-consistency"
  - "copy-link"
  - "conditional-tooltips"
---

# Native control tooltip contract for the PDF review interface

## Context

The PDF review interface uses compact, icon-heavy controls in its viewer chrome, workspace rails, annotation actions, and link interactions. Icons conserve reading space, but unfamiliar symbols usually need short explanations. During the interface polish merged in [PR #29](https://github.com/brad-ross/placekeeper/pull/29), an early direction made more controls visibly labeled; the settled direction restored icon-only presentation while adding matching hover explanations (session history).

The convention is intentionally mechanical: every literal native `button`, `input`, `select`, and `textarea` in TSX under `apps/web/src` declares an explicit `title` attribute. A TypeScript-AST test recursively discovers `.tsx` files, inspects native JSX opening elements, records the source location of every covered control without that attribute, and requires that list to be empty (`apps/web/test/control-tooltips.test.ts:8-15`, `apps/web/test/control-tooltips.test.ts:18-48`). Declaring the attribute means the component owns a deliberate tooltip policy; it does not require every runtime state to produce visible native hover text.

This distinction became necessary in [PR #41](https://github.com/brad-ross/placekeeper/pull/41). Enabled Copy Link controls deliberately render no native `title`, because transient success feedback and retained browser tooltip state produced awkward or misleading flashes around dense row actions. Disabled Copy Link controls still expose a truthful reason through `title`, and every state retains a target-specific accessible name (`apps/web/src/review/CopyLinkControl.tsx:149-168`).

The source-wide presence check therefore complements—not replaces—targeted interaction and accessibility coverage. It can prove that the component declares a tooltip policy, but not what value reaches the DOM in each state or whether suppressing hover text is the correct interaction. `PdfLinkControl` still uses ordinary state-specific tooltips, while `CopyLinkControl` uses a deliberate enabled-state exception; both require focused semantic assertions.

## Guidance

### Give every native control an explicit tooltip policy

Add an explicit `title` attribute to every literal native `button`, `input`, `select`, and `textarea` in `apps/web/src/**/*.tsx`. In the normal case, its runtime value should describe the immediate action rather than the surrounding feature. Navigation titles say where activation goes, mutation titles name the mutation, and disclosure controls say what they open.

For example, the PDF link overlay has a target-specific accessible name, but its normal tooltip says `Open link actions` because activating the button opens a menu rather than immediately following the link. When no safe target is available, both channels expose that unavailability (`apps/web/src/pdf/PdfLinkControl.tsx:118-132`). Likewise, the workspace mode strip distinguishes selecting References from moving the workspace: the tab title says `Show References`, while the adjacent docking action has its own action-specific label and tooltip (`apps/web/src/review/WorkspaceModeStrip.tsx:75-113`).

### Keep hover text and accessible naming semantically aligned

`title` is supplementary pointer-hover text, not the accessible name. An icon-only button still needs `aria-label`, visible text, or another valid accessible-naming mechanism. When both channels describe the same action, derive them from the same label or use matching wording.

`ContextActionButton` demonstrates the intended split: icon-only variants receive `aria-label={action.label}`, every variant receives `title={action.label}`, and visible-label variants render the same action label as text (`apps/web/src/review/ContextActionPalette.tsx:14-30`). The workspace edge rail similarly derives `aria-label` and `title` from the same state-aware function, preventing the two strings from drifting as the rail changes between open and closed states (`apps/web/src/review/WorkspaceEdgeRail.tsx:20-40`).

Exact string duplication is not required when the channels serve different levels of detail. The page trigger includes current and total pages in its accessible name but uses the concise hover instruction `Enter a page number`; its resulting numeric input keeps a field-specific `aria-label` and the same instructional tooltip (`apps/web/src/review/ReviewChrome.tsx:287-346`). The zoom trigger and input follow the same pattern (`apps/web/src/review/ReviewChrome.tsx:362-425`). The invariant is semantic truthfulness: each string accurately describes its role and immediate action.

### Make exceptions state-specific, accessible, and tested

Suppress native hover text only when the tooltip itself would make the interaction less truthful or less stable. Keep the exception inside a shared control instead of asking every caller to omit `title` independently, preserve a purposeful accessible name, and test the runtime markup for both the exception and its fallback states.

`CopyLinkControl` follows that shape. Its button always declares `title`, but resolves it to `undefined` while enabled and to the supplied reason while disabled (`apps/web/src/review/CopyLinkControl.tsx:149-159`). The enabled state keeps its target-specific `aria-label`; successful copy is announced only through a screen-reader status, while clipboard failure exposes a visible selectable link and Retry action (`apps/web/src/review/CopyLinkControl.tsx:155-186`). Focused unit coverage asserts both the missing enabled tooltip and the present disabled explanation (`apps/web/test/copy-link-control.test.ts:36-69`).

Do not use an absent tooltip as transient success feedback. Copy completion belongs to the command's status lifecycle, not the browser's hover cache. Real-browser acceptance verifies that tray Copy Link actions settle without selecting an inactive row, flashing its border, or leaving contextual actions disclosed (`test/acceptance/production-flow.spec.ts:1671-1790`).

### Treat the AST test as a coverage floor

The test's literal covered set is `button`, `input`, `select`, and `textarea` (`apps/web/test/control-tooltips.test.ts:8`). It verifies only that an explicit JSX `title` attribute exists. It does not evaluate whether the runtime value is absent, nonempty, accurate, state-correct, or aligned with the accessible name (`apps/web/test/control-tooltips.test.ts:31-47`). It also does not cover custom components, non-native elements with widget roles, or keyboard, focus, expanded-state, error-description, and screen-reader behavior.

Use focused tests when the tooltip depends on state or when activation semantics are easy to misname. `PdfLinkControl` is one example: its available state says `Open link actions`, while its unavailable state says `PDF link target unavailable` (`apps/web/src/pdf/PdfLinkControl.tsx:123-127`). The focused unit test asserts both states (`apps/web/test/pdf-link-control.test.tsx:63-114`).

The repository's narrowed CI unit configuration still uses an explicit include list and does not name `control-tooltips.test.ts`, but it does include the focused Copy Link semantic test (`vitest.ci.config.ts:3-47`). Describe the AST test as a local/source-wide guard rather than claiming that required CI enforces it; describe the enabled/disabled Copy Link exception as CI-covered through `copy-link-control.test.ts`.

## Why This Matters

A single source-wide policy prevents the common drift where neighboring compact controls look equally important but only some have considered hover behavior. Most controls explain themselves on hover; narrowly justified exceptions remain explicit in source and focused tests. That consistency is especially useful in a dense PDF workspace, where several actions are symbol-only and similar features appear in the main viewer, side workspace, bottom tray, popovers, and row actions.

Separating `title` from accessible naming serves different needs without conflating the mechanisms. Pointer users usually receive a native hover hint, while accessibility APIs receive a purposeful name from `aria-label`, visible text, or the applicable labeling relationship. Reusing a single action label when meanings are identical reduces copy drift; allowing concise hover instructions when accessible names carry extra state prevents tooltips from becoming noisy. A deliberately absent native tooltip never removes the accessible-name requirement.

The convention also preserves the product's reading-first visual language. Icon-only buttons can remain compact without relying on icon recognition alone. Focused workflow and visual tests verified that the compact controls stayed understandable in the rendered Placekeeper rather than treating tooltip additions as copy-only cleanup (session history).

## When to Apply

- Apply this convention whenever adding or editing a native `button`, `input`, `select`, or `textarea` in `apps/web/src`.
- Prioritize exact action wording for icon-only toolbar buttons, compact item actions, navigation controls, workspace docking controls, and inputs whose purpose is not obvious from their current value.
- Keep a no-tooltip exception inside a shared component, preserve its accessible name, define which states suppress or restore hover text, and add focused semantic coverage.
- Add focused semantic tests when the tooltip changes by state, when one compound control contains several distinct actions, or when the accessible name and hover instruction intentionally carry different detail.
- Use separate accessibility and interaction coverage for custom widgets, keyboard behavior, focus management, disclosure state, error communication, and screen-reader semantics.
- Keep responsive reachability separate from naming: a correctly labeled action can still become physically clipped or unreachable in a narrow tray (session history).

## Examples

An icon-only action should normally name the action consistently in both channels:

```tsx
<button
  type="button"
  aria-label="Zoom in"
  title="Zoom in"
  onClick={zoomIn}
>
  <ReviewIcon name="plus" />
</button>
```

That shape matches the top-chrome zoom action (`apps/web/src/review/ReviewChrome.tsx:363-364`). When shared action metadata already exists, reuse it instead of maintaining two literals:

```tsx
<button
  type="button"
  aria-label={action.label}
  title={action.label}
>
  <ReviewIcon name={action.kind} />
</button>
```

Not every tooltip should duplicate a longer accessible name. A trigger may expose state and intent to assistive technology while keeping the hover instruction concise:

```tsx
<button
  aria-label={`Current page ${currentPage} of ${totalPages}. Enter a page number`}
  title="Enter a page number"
  onClick={startPageEdit}
>
  {currentPage} / {totalPages}
</button>
```

The alignment requirement is semantic: both strings tell the truth about the control, even when they are not identical (`apps/web/src/review/ReviewChrome.tsx:345-354`).

An enabled utility action may intentionally suppress native hover text while retaining an accessible name and a disabled-state explanation:

```tsx
<button
  type="button"
  aria-label={ariaLabel}
  title={disabled ? disabledReason : undefined}
  disabled={disabled}
  onClick={copyLink}
>
  <ReviewIcon name="link" />
</button>
```

This is an explicit state policy, not a missing attribute. The focused test should prove that enabled markup omits `title`, disabled markup contains the truthful reason, and success remains accessible without adding a visible hover popup.

## Related

- [Truthful compact agent-context status](../design-patterns/truthful-compact-agent-context-status.md) — the corresponding custom hover/focus disclosure pattern for a passive state indicator rather than a native actionable control.
- [Outline-aware annotation workspace presentation](../design-patterns/outline-aware-annotation-workspace-presentation.md) — related guidance on accessible labeling and capability-driven workspace composition.
- [Reliable compact right-docked Reference Tabs](../ui-bugs/reliable-compact-right-docked-reference-tabs.md) — complementary geometry and interaction guidance for compact Reference controls.
- [Authority boundaries for reloadable local-review URLs](../architecture-patterns/reloadable-local-review-url-authority-boundaries.md) — the durable-location and non-navigating Copy Link contract that motivates the enabled-tooltip exception.
- [PR #29: unify interface interactions and accessibility](https://github.com/brad-ross/placekeeper/pull/29) — merged source of the general native-control tooltip convention.
- [PR #41: add durable links and compact action controls](https://github.com/brad-ross/placekeeper/pull/41) — merged source of the enabled Copy Link exception and focused interaction coverage.
