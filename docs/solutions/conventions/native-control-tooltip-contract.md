---
title: "Shared control tooltip policy separates custom hints from accessible names"
date: "2026-08-12"
last_updated: 2026-09-10
category: "conventions"
module: "web-review-interface"
problem_type: "convention"
component: "frontend_stimulus"
severity: "medium"
applies_when:
  - "Adding compact review actions through shared tooltip controls"
  - "Separating accessible action names from supplementary hover descriptions"
  - "Preserving deliberate title policy for literal native TSX controls"
  - "Handling keyboard and pointer focus without accidental tooltip flashes"
  - "Verifying state-specific tooltip behavior beyond source attribute coverage"
related_components:
  - "ReviewTooltipButton"
  - "CopyLinkControl"
  - "PdfLinkControl"
  - "control-tooltips.test.ts"
tags:
  - "accessibility"
  - "native-controls"
  - "tooltips"
  - "icon-buttons"
  - "typescript-ast"
  - "input-modality"
  - "conditional-tooltips"
  - "ui-consistency"
---

# Shared control tooltip policy separates custom hints from accessible names

## Context

Compact review controls need explanations without making every action permanently text-labeled. The original convention from [PR #29](https://github.com/brad-ross/placekeeper/pull/29) required an explicit native `title` policy. [PR #41](https://github.com/brad-ross/placekeeper/pull/41) added a Copy Link exception because transient native hover feedback interacted poorly with command completion.

The current shared button uses a custom tooltip. `ReviewTooltipButton` still renders a named native button, but enabled controls omit native `title`, show delayed pointer-hover feedback, and show immediate feedback for eligible keyboard focus. Disabled controls retain a native-title fallback (`apps/web/src/review/ReviewTooltipButton.tsx`). Copy Link now uses this shared tooltip too; “no enabled native title” does not mean “no tooltip.” Inputs and other literal native controls remain in the codebase, so this is not a claim that every control has migrated.

## Guidance

### Keep naming independent from tooltip presentation

Use `ReviewTooltipButton` for compact actions that need the shared interaction. Its required `label` supplies `aria-label` unless explicitly overridden; `tooltip` defaults to that label. A longer accessible name may contain target or state information while a shorter tooltip describes the immediate action (`apps/web/src/review/ReviewTooltipButton.tsx`).

The custom tooltip has `role="tooltip"`, a unique ID, and an `aria-describedby` relationship while visible. Existing descriptions are retained. Neither tooltip presence nor native `title` replaces the accessible-name requirement (`apps/web/src/review/ReviewTooltipButton.tsx`). Supply truthful disabled-state explanation through `tooltip`; the shared button uses that value as its disabled native-title fallback.

### Track the input that caused focus

Pointer hover waits 600 ms. Eligible focus opens immediately only when it is not pointer-originated and the button matches `:focus-visible` (`apps/web/src/review/ReviewTooltipButton.tsx`).

Checking only local pointer state or `:focus-visible` is insufficient. Opening a menu by pointer may programmatically focus a different button, and WebKit can report that focus as visible. The shared component therefore observes document-level pointer and keyboard modality in a reference-counted `WeakMap`. Non-modifier key input clears pointer modality; programmatic focus inherits the input that opened the surface (`apps/web/src/review/ReviewTooltipButton.tsx`). This prevents a pointer click from impersonating an intentional tooltip hover.

### Bound and dismiss the portaled surface

Portal the tooltip into `document.body` and promote a manual popover to the top layer: a portal alone cannot paint above native popovers. Ordinary controls prefer above; controls within a top-bar menu prefer below the entire menu when it fits, then use clamped fallback placement against the visual viewport (`apps/web/src/review/ReviewTooltipButton.tsx`).

Dismiss on mouse leave, blur, click, pointer down, and completed Escape; do not treat Escape during IME composition as dismissal. Also dismiss visible tooltips on document scroll, window resize, and visual-viewport changes. Clean up timers and listeners (`apps/web/src/review/ReviewTooltipButton.tsx`). Tooltip lifetime belongs to the interaction that exposed it, not to a stale location after the reader scrolls.

### Keep Copy Link status separate from hover feedback

Copy Link passes its target-specific accessible name and concise tooltip to the shared component (`apps/web/src/review/CopyLinkControl.tsx`). Enabled native-title suppression is now the shared policy, not a Copy Link prohibition on hover explanations.

The command has its own pending/success/failure lifecycle and coalesces concurrent invocations. Success announces “Link copied” through a screen-reader status; failure exposes a selectable link and Retry action (`apps/web/src/review/CopyLinkControl.tsx`). Do not encode command success by changing tooltip meaning or relying on the browser's hover cache.

Successful pointer activation of row/annotation Copy Link releases trigger focus so contextual row actions do not remain disclosed. Keyboard activation retains focus. Failure preserves a recoverable focus target (`apps/web/src/review/CopyLinkControl.tsx`). This is command-specific focus behavior, not a reason to blur every tooltip button.

### Treat the AST guard as a declaration floor

Every literal `button`, `input`, `select`, and `textarea` in source TSX still declares an explicit `title` attribute. The AST test inspects syntax only: a conditional attribute resolving to `undefined` satisfies it (`apps/web/test/control-tooltips.test.ts`). The shared native button deliberately declares that conditional policy.

The guard cannot prove runtime wording, enabled/disabled behavior, custom-component coverage, focus modality, viewport containment, or accessibility. Focused component and browser tests provide those checks. The narrowed CI include list names the Copy Link test, but does not name the AST guard or shared-tooltip test; do not claim this source-wide convention is necessarily enforced by that CI configuration (`scripts/testing/suites.ts`, consumed by `scripts/testing/config/vitest.ci.config.ts`).

## Why This Matters

The durable distinction is between action naming, tooltip exposure, and command feedback. Conflating them causes duplicate native/custom hints, pointer-triggered focus flashes, or misleading success messages. The shared component makes exposure and dismissal consistent while leaving each caller responsible for truthful labels and command state.

## When to Apply

Apply this convention when adding compact review actions or changing native-control tooltip policy. Keep literal-control declarations deliberate, but validate dynamic behavior separately. Unit coverage checks delay, Escape composition, naming, and disabled fallback (`apps/web/test/review-tooltip-button.test.tsx`); browser coverage checks pointer-opened menu focus versus actual hover and keyboard focus (`test/acceptance/neutral-interface-regressions.spec.ts`). Copy Link retains dedicated command and row-interaction coverage (`apps/web/test/copy-link-control.test.ts`, `test/acceptance/production-flow.spec.ts`).

## Examples

```tsx
<ReviewTooltipButton type="button" label="Zoom in" onClick={zoomIn}>
  <ReviewIcon name="plus" />
</ReviewTooltipButton>
```

Use separate wording when a disabled explanation adds information:

```tsx
<ReviewTooltipButton
  type="button"
  label="Open in References"
  tooltip="Unavailable while loading"
  disabled
>
  <span>Open in References</span>
</ReviewTooltipButton>
```

A pointer-opened menu may focus its first action without showing a tooltip. Hovering that action for the delay or reaching it through eligible keyboard focus reveals the explanation. Neither event executes the command.

Related: [Truthful compact agent-context status](../design-patterns/truthful-compact-agent-context-status.md) concerns passive status disclosure; [reloadable local-review URL authority](../architecture-patterns/reloadable-local-review-url-authority-boundaries.md) owns Copy Link's durable-location semantics.
