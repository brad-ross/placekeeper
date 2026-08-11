---
title: Passive Viewer Warning Popups - Plan
type: fix
date: 2026-08-11
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Passive Viewer Warning Popups - Plan

## Goal Capsule

- **Objective:** Remove passive PDF selection and caret reliability messages from the red top-right viewer alert while preserving safe anchor gating and actionable command feedback.
- **Authority:** The Product Contract defines user-visible behavior. The Planning Contract defines the notification boundary. Existing typed reliability contracts remain authoritative for anchor safety.
- **Execution profile:** One bounded web-app unit with focused component and production-browser regression coverage.
- **Stop conditions:** Stop if suppressing the alert would require weakening selection reliability checks, permitting an unreliable Review Item, or removing recovery feedback after an explicit user command.
- **Tail ownership:** The LFG pipeline owns implementation, review, browser validation, commit, PR creation, and CI.

## Product Contract

### Summary

The production PDF viewer will treat selection and caret reliability results as internal capability state instead of global user-facing errors. The red viewer alert remains available only for actionable command failures.

### Problem Frame

`ProductionReviewApp` currently merges passive selection readiness, caret reliability diagnostics, and actual command rejection messages into one `toolError` prop. `App` renders that prop as a red, top-right `role="alert"` popup. This makes normal reliability gating look like an application failure even though the app has safely declined to create a Review Item.

### Key Decision

- **Hide passive reliability diagnostics from the global viewer alert.** (session-settled: user-directed — chosen over keeping red warning popups visible: these diagnostics are unfriendly and do not give the reviewer a useful action.) Governs R1-R3.

### Requirements

**Viewer feedback**

- R1. Pending or unreliable text selection shall not render the red top-right viewer alert.
- R2. Caret reliability diagnostics shall not render the red top-right viewer alert.
- R3. An explicit Replace, Delete, Insert, or Highlight request without reliable anchor authority shall keep the existing nonvisual recovery announcement and shall create no Review Item.
- R4. A rejected review command that requires reviewer action shall remain user-visible and shall clear after a later command succeeds.

**Diagnostic and safety contracts**

- R5. Pending and unreliable selection states shall remain non-authoritative for mutations, including generation-bound pending keyboard input.
- R6. Typed reliability diagnostic codes shall remain available in selection and viewer-event contracts for development and test evidence without introducing a new logging subsystem.

### Acceptance Examples

- AE1. Passive pending selection
  - **Covers:** R1, R5.
  - **Given:** Selection capture is held in its pending state.
  - **When:** The reviewer drags across PDF text and immediately types or presses Delete.
  - **Then:** No viewer alert appears, and the generation-bound command completes exactly once only if the same selection resolves reliably.
- AE2. Unreliable selection or caret
  - **Covers:** R1-R3, R5-R6.
  - **Given:** Selection or caret capture returns a typed reliability diagnostic without an anchor.
  - **When:** The capture completes and the reviewer invokes an anchor-dependent command.
  - **Then:** No red popup or malformed Review Item appears, while the explicit command receives the existing recovery announcement.
- AE3. Actionable command rejection
  - **Covers:** R4.
  - **Given:** The service rejects a review command because another review window changed the saved revision.
  - **When:** The rejection returns to the production review tree and the reviewer later retries successfully.
  - **Then:** The conflict message is user-visible until the successful retry clears it.

### Scope Boundaries

- Keep the existing viewer alert component and danger styling for actionable command failures.
- Keep delivery, existing-annotation, page-number validation, reference-navigation, and launch errors unchanged.
- Do not change selection reliability algorithms, PDF geometry, Page Note placement, Review Item schemas, or command reducer semantics.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Separate capability diagnostics from command errors at the production boundary.** `ProductionReviewApp` will stop translating selection readiness and caret diagnostics into `App.toolError`. It will pass only the command-rejection state to the existing viewer alert. This is the smallest boundary that preserves the shared alert for R4 while satisfying R1-R3.
- KTD2. **Preserve typed diagnostics without adding logging infrastructure.** `SelectionUpdate` and `ViewerInteractionEvent` already retain stable diagnostic codes used by focused tests. The repository has no application logger convention, so console logging would add noise rather than durable development observability. Governs R5-R6.
- KTD3. **Synchronize browser tests through their existing capture gate.** Production acceptance tests will observe the test-local selection-capture gate instead of waiting for the popup that is being removed. This keeps pending-input tests deterministic without adding a production DOM hook. Governs R1 and R5.

### Assumptions

- The request targets passive readiness and reliability popups. Actionable command conflicts remain visible because the reviewer can recover by retrying.
- The existing screen-reader announcement after an explicit unavailable command is useful recovery feedback and is not the top-right popup the request removes.

### Existing Patterns and Research

- `apps/web/src/app/ProductionReviewApp.tsx` owns the accidental merge of `selectionReadinessMessage`, caret diagnostics, and command rejection state.
- `apps/web/src/app/App.tsx` and `apps/web/src/app/review-layout-foundation.css` own the shared viewer alert and should remain unchanged unless implementation reveals an unused prop after the boundary split.
- `apps/web/src/pdf/selection-state.ts`, `apps/web/src/pdf/text-reliability.ts`, and `apps/web/src/pdf/viewer-interaction-events.ts` already preserve typed diagnostics independently of presentation.
- `docs/plans/2026-08-07-001-fix-pdf-text-selection-commands-plan.md` requires visible recovery only when a requested command cannot run, not on every passive reliability transition.
- `docs/solutions/architecture-patterns/adaptive-annotation-tray-framing.md` favors quiet, source-specific viewer behavior and layered browser validation without disturbing the mounted reading surface.

---

## Implementation Units

### U1. Split passive diagnostics from actionable viewer errors

- **Goal:** Remove passive selection and caret popups while retaining safe selection behavior and actionable command-rejection feedback.
- **Requirements:** R1-R6; AE1-AE3; KTD1-KTD3.
- **Dependencies:** None.
- **Files:**
  - `apps/web/src/app/ProductionReviewApp.tsx`
  - `apps/web/test/selection-state.test.ts`
  - `apps/web/test/app-interactions.test.ts`
  - `test/acceptance/production-flow.spec.ts`
  - `test/acceptance/review-workflow.spec.ts`
- **Approach:**
  1. Remove the selection-readiness-to-error mapping and stop caret diagnostic events from mutating user-facing error state.
  2. Rename the remaining state to reflect command rejection ownership, pass only that state to the viewer, and clear it after a successful command.
  3. Keep the typed selection and caret diagnostic contracts unchanged.
  4. Extend the test-local capture gate with an observable pending signal and replace alert-based synchronization in production acceptance tests.
  5. Assert that passive selection transitions produce no viewer alert while pending command buffering, explicit recovery announcements, and conflict feedback retain their behavior.
- **Patterns to follow:** Keep reliability authority in `selection-state.ts`, explicit unavailable-command announcements in `ReviewShell.tsx`, and test-only synchronization inside the existing Playwright capture gate.
- **Test scenarios:**
  1. Covers AE1. Hold a real selection capture pending, verify `[data-viewer-status]` is absent, type a replacement, release the same generation, and verify one replacement draft receives the buffered text.
  2. Covers AE1. Hold a real selection capture pending, verify no viewer alert, press Delete or Backspace, release the same generation, and verify one Delete Review Item is created.
  3. Clear or supersede a pending selection after buffered input and verify no popup, draft, or Review Item appears.
  4. Covers AE2. Feed the existing typed unreliable selection and caret diagnostic paths and verify they retain their diagnostic code without creating a user-facing viewer error or Review Item.
  5. Focus the review canvas without anchor authority, invoke Replace, Delete, Insert, and Highlight shortcuts, and verify each command makes the screen-reader status announce the existing reliable-selection recovery guidance with no mutation.
  6. Covers AE3. Reject a command with the session conflict response, verify the actionable viewer alert remains, then accept a retry and verify the alert clears.
- **Verification:** The production tree never displays the global viewer alert for selection readiness or reliability, selection authority remains fail-closed, pending gestures remain deterministic, and command conflicts retain a recoverable visible message.

---

## Verification Contract

| Gate | Command | Coverage |
|---|---|---|
| Type safety | `pnpm typecheck` | Production boundary and test-gate types compile. |
| Diagnostic contracts | `pnpm vitest run apps/web/test/selection-state.test.ts apps/web/test/app-interactions.test.ts apps/web/test/text-reliability.test.ts apps/web/test/selection-anchor.test.ts` | Typed selection and caret failure codes remain intact. |
| Web build | `pnpm build:web` | The production review bundle builds after removing the presentation coupling. |
| Focused production behavior | `pnpm playwright test test/acceptance/production-flow.spec.ts --grep "pending selection|pending-clear|newest pending"` | Pending command buffering no longer depends on a visible alert. |
| Review interaction behavior | `pnpm playwright test test/acceptance/review-workflow.spec.ts --grep "anchor recovery"` | Explicit unavailable commands retain accessible recovery feedback. |
| Full browser regression | `pnpm test:e2e` | The shared PDF viewer, Review Items, delivery, references, and production flow remain stable. |

---

## Definition of Done

- Passive selection pending, unreliable selection, and caret diagnostic states never create the red top-right viewer alert.
- Selection and caret reliability gates still prevent unreliable Review Items.
- Explicit unavailable commands retain their existing accessible recovery announcement.
- Actionable command conflicts remain visible and clear after a successful retry.
- Browser synchronization uses the existing test-local capture gate instead of removed UI text.
- Focused type, unit, build, and browser gates pass, and no abandoned diagnostic UI or test scaffolding remains in the diff.
