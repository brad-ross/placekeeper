---
title: Same-Reference Link Navigation - Plan
type: feat
date: 2026-08-11
topic: same-reference-link-navigation
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Same-Reference Link Navigation - Plan

## Goal Capsule

- **Objective:** Add a third action to the PDF-link popup in a Reference Tab so the active reference viewport follows the link without opening another tab or moving the Main Reading Thread.
- **Product authority:** This plan extends the reference-navigation contract in `docs/plans/2026-08-09-002-feat-reference-navigation-workspace-plan.md` and preserves the Reference Tab, Main Reading Thread, and Meaningful Jump definitions in `CONCEPTS.md`.
- **Open blockers:** None.
- **Execution profile:** Localized React, coordinator, unit-test, and installed-browser behavior change.
- **Tail ownership:** `ce-work` implements and verifies the units, then returns control to LFG for simplification, independent review, PR creation, and CI follow-through.

## Product Contract

### Summary

An internal PDF link opened from an active Reference Tab gains a third popup action that navigates the same tab to the destination. The existing Open in References and Open in main actions remain available and unchanged.

### Problem Frame

A reviewer following a chain of references must currently choose between creating another Reference Tab and moving the Main Reading Thread. Neither choice supports continuing within the temporary reference view that already contains the clicked link.

### Requirements

**Conditional action**

- R1. A valid internal PDF link activated inside the active Reference Tab shall show a third popup action after the existing Open in References and Open in main actions.
- R2. A link activated in the Main Reading Thread shall retain the existing two-action popup and shall not expose the same-Reference-Tab action.
- R3. The third action shall be an icon-only menu item named and titled "Follow in this Reference Tab," with visible focus treatment and the popup's existing pointer target size.
- R4. The three-item popup shall retain first-item autofocus and Arrow Up, Arrow Down, Home, End, Escape, Tab, and outside-click behavior. Escape, Tab, and outside-click dismissal retain the existing source-focus outcome, while successful same-tab selection focuses the reference destination.

**Same-tab navigation**

- R5. Choosing the third action shall apply the clicked semantic PDF destination to the active Reference Tab's viewer and persist the verified settled location for later tab restoration.
- R6. The operation shall preserve the Reference Tab's identity, original target metadata, label, active selection, and total tab count.
- R7. The operation shall not move the Main Reading Thread, mutate Back or Forward history, reveal or hide workspaces, or create, consume, or switch a Reference Tab.
- R8. A stale, main-origin, changed-active-tab, missing-active-tab, unavailable-viewer, or failed destination request shall not commit reference or main navigation state.

### Key Flow

- F1. Follow a link within the current Reference Tab
  - **Trigger:** A reviewer activates a valid internal PDF link rendered in the active Reference Tab.
  - **Actors:** Reviewer.
  - **Steps:** The popup exposes three actions; the reviewer selects the third; the reference viewer applies and verifies the destination; the active tab stores the settled view.
  - **Outcome:** The same Reference Tab displays the destination while the Main Reading Thread and its history remain unchanged.
  - **Covers:** R1-R8.

### Acceptance Examples

- AE1. Same-tab follow succeeds
  - **Given:** One Reference Tab is active and its PDF contains a valid internal link to another page.
  - **When:** The reviewer chooses the third popup action.
  - **Then:** The same tab remains active, its viewport reaches the target, the tab count remains one, and the Main Reading Thread retains its page, scroll, zoom, and history.
  - **Covers:** R1, R3-R7.
- AE2. Main-view popup remains unchanged
  - **Given:** A valid internal link is activated in the Main Reading Thread.
  - **When:** The popup opens.
  - **Then:** It contains only Open in References and Open in main.
  - **Covers:** R2.
- AE3. Same-tab follow fails safely
  - **Given:** A Reference Tab link request becomes stale or its destination cannot settle.
  - **When:** The reviewer chooses the third action.
  - **Then:** No tab or main-history mutation commits, the coordinator restores and verifies the pre-action reference view after a post-apply settlement failure, and the interface announces any destination or restoration failure.
  - **Covers:** R8.

### Scope Boundaries

- Do not change PDF-link classification, destination identity, document loading, Reference Tab creation or deduplication, Send-to-main behavior, or Main Reading Thread history semantics.
- Do not rename or reorder the existing two popup actions.
- Do not change a Reference Tab's title or canonical identity when its live viewport follows an in-body link.
- Do not introduce raw scroll offsets, global viewer selectors, direct EmbedPDF navigation calls, or a new reducer action.

## Planning Contract

### Key Technical Decisions

- KTD1. **Make the third action source-scoped.** `ViewerPdfLinkInvocation.sourceScope` already distinguishes main and reference links, so the popup shall conditionally add the third item without changing the viewer event shape. When the coordinator accepts a reference-origin request, it shall snapshot the active Reference Tab identity beside that transient request. Implements R1-R4, R8.
- KTD2. **Route same-tab movement through NavigationCoordinator.** The coordinator shall require the snapshotted source tab to remain active and present, start a generation-guarded operation, and use the reference `PdfViewerNavigation` adapter. React components shall emit intent only. Implements R5-R8.
- KTD3. **Persist the verified view through the existing reducer seam.** After `applyTarget` succeeds and `captureLocation` returns a settled view, dispatch `refresh-active-reference`. This updates only the active tab's location and preserves its canonical identity and metadata. Implements R5-R7.
- KTD4. **Close both reference-viewer failure windows.** `applyTarget` already restores a mutated viewer when target application fails, while `begin` cancels stale work. The coordinator shall capture the origin before applying and restore it with `applyLocation` if post-apply settlement capture fails. Implements R8.

### High-Level Technical Design

```mermaid
sequenceDiagram
  participant Link as Reference PDF link
  participant Menu as Link action popup
  participant Coordinator as NavigationCoordinator
  participant Reference as Reference viewer adapter
  participant State as Reference navigation state
  Link->>Menu: sourceScope reference + semantic target
  Menu->>Coordinator: choose same Reference Tab + source tab identity
  Coordinator->>Reference: capture origin
  Coordinator->>Reference: applyTarget(target)
  Reference-->>Coordinator: target applied
  Coordinator->>Reference: captureLocation()
  Reference-->>Coordinator: verified settled location
  Coordinator->>State: refresh active reference
  Coordinator->>Reference: focus destination
```

The Main Reading Thread adapter and history reducer are outside this sequence. Failure or supersession ends the operation before the state refresh.

### Assumptions

- The third action appears only for `sourceScope: 'reference'`; the user's request does not change popups opened from the Main Reading Thread.
- Following a link in the same Reference Tab changes its restorable live location but retains the tab's original destination identity and visible label.
- The popup uses a distinct icon from the existing References and main actions, selected from the established `ReviewIcon` vocabulary unless implementation shows that one small vocabulary addition is clearer.

### Implementation Constraints

- Keep menu-item refs and keyboard cycling aligned with the conditionally rendered item count.
- Snapshot the active Reference Tab identity when a reference-origin popup request is accepted; clear that identity whenever the request is dismissed, chosen, superseded, or the document is replaced.
- Reject the same-tab choice unless the request came from a reference link and its snapshotted source tab is still present and active.
- Do not dispatch `open-reference`, call `openReference`, or call the main navigation adapter from the new route.
- Commit reducer state only after the reference destination applies and its settled location is captured.
- Capture the origin before target application; if post-apply capture fails, restore and verify the origin before reporting failure.
- Preserve current popover dismissal, focus restoration, and polite announcement patterns.

### Sequencing

U1 establishes the conditional three-item popup contract. U2 adds the coordinator transaction and proves the cross-view invariants in unit and installed-browser tests.

## Implementation Units

### U1. Add the conditional third popup action

- **Goal:** Expose an accessible third menu item only for links activated inside a Reference Tab.
- **Requirements:** R1-R4; AE2; KTD1.
- **Dependencies:** None.
- **Files:**
  - `apps/web/src/review/LinkActionPopover.tsx`
  - `apps/web/test/reference-workspace.test.tsx`
- **Approach:**
  1. Extend the typed popup choice set with a same-Reference-Tab intent.
  2. Let the menu content receive source scope and append the third icon-only item for reference-origin requests.
  3. Add the third ref to keyboard navigation only when the item is rendered.
  4. Preserve the first item's autofocus and the existing two-item order for every source.
- **Execution note:** Add the component-contract assertions first so the conditional count, order, accessible names, and three-item keyboard wrap have explicit red proof.
- **Patterns to follow:** Existing menu rendering, ref management, and focus helpers in `apps/web/src/review/LinkActionPopover.tsx`; icon-only action conventions in `apps/web/src/review/ReferenceWorkspace.tsx`.
- **Test scenarios:**
  1. Covers AE2. A main-origin request renders exactly the two existing menu items in their current order.
  2. A reference-origin request renders exactly three icon-only menu items, with Follow in this Reference Tab third and identically named by its accessible label and title.
  3. Arrow Down and Arrow Up wrap across all three reference-origin items, while Home and End focus the first and third items.
  4. Escape, Tab, outside dismissal, and first-item autofocus retain their existing behavior with the third item present.
- **Verification:** Static markup and focus-index tests prove the conditional semantic structure without nested or text-bearing menu controls.

### U2. Navigate and persist the active Reference Tab destination

- **Goal:** Apply the third action through the reference viewer transaction while preserving tab identity and all main-view state.
- **Requirements:** R5-R8; F1; AE1, AE3; KTD2-KTD4.
- **Dependencies:** U1.
- **Files:**
  - `apps/web/src/review/navigation-coordinator.ts`
  - `apps/web/test/navigation-coordinator.test.ts`
  - `test/acceptance/production-flow.spec.ts`
- **Approach:**
  1. Snapshot the active tab identity when accepting a reference-origin popup request and route the typed choice to a coordinator method that requires that same tab to remain active.
  2. Capture the reference origin, then run the target through the coordinator's generation guard and the adapter's semantic `applyTarget` flow.
  3. Capture the verified destination, refresh only the active tab snapshot, focus the destination, and announce success.
  4. If target application fails, rely on adapter rollback. If destination capture fails after application, restore and verify the captured origin before reporting failure.
  5. On invalid, stale, changed-tab, superseded, or failed work, leave reducer and Main Reading Thread state unchanged and use the established failure-announcement posture.
  6. Extend the installed reference-chain fixture flow to exercise the third action before the existing create-another-reference path.
- **Execution note:** Start with coordinator tests that snapshot both viewer locations, tab metadata, tab count, and main history before the choice. Add the real-browser scenario after the transaction contract passes.
- **Patterns to follow:** `openReference`, `navigateMainTarget`, and `restoreReferenceTab` in `apps/web/src/review/navigation-coordinator.ts`; `refresh-active-reference` in `apps/web/src/review/reference-navigation-state.ts`; `applyTarget` rollback in `apps/web/src/pdf/viewer-navigation-adapter.ts`.
- **Test scenarios:**
  1. Covers AE1. A current reference-origin request applies the target through the reference adapter, stores the captured location, focuses the destination, and preserves active identity, original target metadata, and tab count.
  2. The successful route never calls the main adapter and leaves the Main Reading Thread location and history unchanged.
  3. Covers AE3. Main-origin, stale-generation, changed-active-tab, missing-active-tab, and apply-failure cases commit no same-tab state change.
  4. A post-apply capture failure restores and verifies the origin, while a failed origin restore commits no tab snapshot and announces that the reference view is unavailable.
  5. A newer navigation operation supersedes deferred same-tab work before it can refresh the active tab.
  6. The installed PDF fixture follows the target-to-target link with the third action, keeps one tab active, reaches the target page in the reference viewport, and preserves main page, scroll, zoom, and history.
  7. The existing Open in References action still creates or activates a separate Reference Tab from the same reference-origin popup.
- **Verification:** Coordinator tests prove adapter isolation and transaction safety; Chromium and WebKit acceptance runs prove real EmbedPDF scrolling, virtualization, focus, and cross-view independence.

## Verification Contract

| Gate | Command | Covers | Done signal |
|---|---|---|---|
| Focused unit behavior | `pnpm vitest run apps/web/test/reference-workspace.test.tsx apps/web/test/navigation-coordinator.test.ts` | U1-U2 | Conditional menu and coordinator invariants pass. |
| Type safety | `pnpm typecheck` | U1-U2 | The expanded choice union and callback chain compile without errors. |
| Chromium installed flow | `pnpm build:web && pnpm playwright test test/acceptance/production-flow.spec.ts --grep "reference"` | U2 | The real fixture follows the link in place and preserves main state. |
| WebKit installed flow | `pnpm build:web && pnpm playwright test --config playwright.webkit.config.ts test/acceptance/production-flow.spec.ts --grep "reference"` | U2 | Portal, focus, and virtualized destination behavior match Chromium. |

## Definition of Done

- A Reference Tab link popup exposes the third action in the requested third position, while a main-view popup remains unchanged.
- Choosing the action moves and focuses only the active reference viewer and stores its verified settled location.
- Tab identity, metadata, selection, count, workspace presentation, Main Reading Thread location, and main history remain unchanged.
- Invalid, failed, stale, changed-tab, and superseded requests do not commit navigation state; post-apply settlement failure restores and verifies the pre-action reference location.
- Focused unit tests, typecheck, and Chromium and WebKit reference acceptance coverage pass.
- No abandoned code, duplicate navigation path, direct viewer scroll manipulation, or unrelated refactor remains in the diff.

## Sources / Research

- `CONCEPTS.md` defines the Reference Tab, Main Reading Thread, and Meaningful Jump invariants.
- `docs/plans/2026-08-09-002-feat-reference-navigation-workspace-plan.md` defines the existing link chooser, coordinator, viewer, and tab contracts.
- `docs/plans/2026-08-10-002-feat-compact-reference-tab-actions-plan.md` preserves current Reference Tab action and focus behavior.
- `docs/solutions/architecture-patterns/adaptive-annotation-tray-framing.md` establishes the viewer-adapter, centralized-orchestration, stale-work, and real-browser verification patterns used here.
