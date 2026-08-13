---
title: Native control tooltip contract for the PDF review interface
date: 2026-08-12
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
related_components:
  - "frontend-stimulus"
tags:
  - "accessibility"
  - "native-controls"
  - "tooltips"
  - "icon-buttons"
  - "typescript-ast"
  - "ui-consistency"
---

# Native control tooltip contract for the PDF review interface

## Context

The PDF review interface uses compact, icon-heavy controls in its viewer chrome, workspace rails, annotation actions, and link interactions. Icons conserve reading space, but unfamiliar symbols need short explanations. During the interface-polish work proposed in [PR #29](https://github.com/brad-ross/pdf-markup/pull/29), an early direction made more controls visibly labeled; the settled direction restored icon-only presentation while adding matching hover explanations (session history). As of 2026-08-12, PR #29 is open and unmerged, so this convention is pending rather than behavior already on `main`.

The convention is intentionally mechanical: every literal native `button`, `input`, `select`, and `textarea` in TSX under `apps/web/src` carries an explicit `title` attribute. A TypeScript-AST test recursively discovers `.tsx` files, inspects native JSX opening elements, records the source location of every covered control without `title`, and requires that list to be empty (`apps/web/test/control-tooltips.test.ts:8-15`, `apps/web/test/control-tooltips.test.ts:18-48`).

This source-wide presence check complements—not replaces—targeted interaction and accessibility coverage. A testing review found that the PDF-link control still needed state-specific assertions for its available and unavailable tooltip wording; an attribute-presence test cannot prove that conditional copy is correct (session history).

## Guidance

### Give every native control explicit, action-oriented hover text

Add `title` to every native `button`, `input`, `select`, and `textarea` in `apps/web/src/**/*.tsx`. Describe the immediate action rather than the surrounding feature. Navigation titles say where activation goes, mutation titles name the mutation, and disclosure controls say what they open.

For example, the PDF link overlay has a target-specific accessible name, but its normal tooltip says `Open link actions` because activating the button opens a menu rather than immediately following the link. When no safe target is available, both channels expose that unavailability (`apps/web/src/pdf/PdfLinkControl.tsx:118-132`). Likewise, the Reference workspace distinguishes selecting a workspace mode from moving the workspace: the tab title says `Show References`, while the adjacent docking action has its own action-specific label and tooltip (`apps/web/src/review/ReferenceWorkspace.tsx:293-305`, `apps/web/src/review/ReferenceWorkspace.tsx:328-339`).

### Keep hover text and accessible naming semantically aligned

`title` is supplementary pointer-hover text, not the accessible name. An icon-only button still needs `aria-label`, visible text, or another valid accessible-naming mechanism. When both channels describe the same action, derive them from the same label or use matching wording.

`ContextActionButton` demonstrates the intended split: icon-only variants receive `aria-label={action.label}`, every variant receives `title={action.label}`, and visible-label variants render the same action label as text (`apps/web/src/review/ContextActionPalette.tsx:14-30`). The workspace edge rail similarly derives `aria-label` and `title` from the same state-aware function, preventing the two strings from drifting as the rail changes between open and closed states (`apps/web/src/review/WorkspaceEdgeRail.tsx:20-40`).

Exact string duplication is not required when the channels serve different levels of detail. The page trigger includes current and total pages in its accessible name but uses the concise hover instruction `Enter a page number`; its resulting numeric input keeps a field-specific `aria-label` and the same instructional tooltip (`apps/web/src/review/ReviewChrome.tsx:287-346`). The zoom trigger and input follow the same pattern (`apps/web/src/review/ReviewChrome.tsx:362-425`). The invariant is semantic truthfulness: each string accurately describes its role and immediate action.

### Treat the AST test as a coverage floor

The test's literal covered set is `button`, `input`, `select`, and `textarea` (`apps/web/test/control-tooltips.test.ts:8`). It verifies only that an explicit JSX `title` attribute exists. It does not verify that the value is nonempty, accurate, state-correct, or aligned with the accessible name (`apps/web/test/control-tooltips.test.ts:31-47`). It also does not cover custom components, non-native elements with widget roles, or keyboard, focus, expanded-state, error-description, and screen-reader behavior.

Use focused tests when the tooltip depends on state or when activation semantics are easy to misname. `PdfLinkControl` is one example: its available state says `Open link actions`, while its unavailable state says `PDF link target unavailable` (`apps/web/src/pdf/PdfLinkControl.tsx:123-127`). The focused unit test asserts both states (`apps/web/test/pdf-link-control.test.tsx:63-92`).

The full local Vitest run in this polish pass included `control-tooltips.test.ts` (session history), but the repository's narrowed CI unit configuration uses an explicit include list and does not currently name this test (`vitest.ci.config.ts:3-41`). Until that list is updated or CI runs the broader suite, describe the AST test as a local/source-wide guard rather than claiming that required CI enforces it.

## Why This Matters

A single source-wide rule prevents the common drift where neighboring compact controls look equally important but only some explain themselves on hover. That consistency is especially useful in a dense PDF workspace, where several actions are symbol-only and similar features appear in the main viewer, side workspace, bottom tray, popovers, and row actions.

Separating `title` from accessible naming serves different needs without conflating the mechanisms. Pointer users receive a native hover hint, while accessibility APIs receive a purposeful name from `aria-label`, visible text, or the applicable labeling relationship. Reusing a single action label when meanings are identical reduces copy drift; allowing concise hover instructions when accessible names carry extra state prevents tooltips from becoming noisy.

The convention also preserves the product's reading-first visual language. Icon-only buttons can remain compact without relying on icon recognition alone. Focused workflow and visual tests verified that the compact controls stayed understandable in the rendered PDF Proofreader rather than treating tooltip additions as copy-only cleanup (session history).

## When to Apply

- Apply this convention whenever adding or editing a native `button`, `input`, `select`, or `textarea` in `apps/web/src` while PR #29's changes are present.
- Prioritize exact action wording for icon-only toolbar buttons, compact item actions, navigation controls, workspace docking controls, and inputs whose purpose is not obvious from their current value.
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

That shape matches the top-chrome zoom action (`apps/web/src/review/ReviewChrome.tsx:354-356`). When shared action metadata already exists, reuse it instead of maintaining two literals:

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

The alignment requirement is semantic: both strings tell the truth about the control, even when they are not identical (`apps/web/src/review/ReviewChrome.tsx:337-346`).

## Related

- [Truthful compact agent-context status](../design-patterns/truthful-compact-agent-context-status.md) — the corresponding custom hover/focus disclosure pattern for a passive state indicator rather than a native actionable control.
- [Outline-aware annotation workspace presentation](../design-patterns/outline-aware-annotation-workspace-presentation.md) — related guidance on accessible labeling and capability-driven workspace composition.
- [Reliable compact right-docked Reference Tabs](../ui-bugs/reliable-compact-right-docked-reference-tabs.md) — complementary geometry and interaction guidance for compact Reference controls.
- [PR #29: unify interface interactions and accessibility](https://github.com/brad-ross/pdf-markup/pull/29) — open implementation source as of 2026-08-12.
