---
title: Hide Empty External Annotations Section - Plan
type: fix
date: 2026-08-12
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Hide Empty External Annotations Section - Plan

## Goal Capsule

- **Objective:** Remove the External Annotations section from the Annotations workspace when discovery confirms that the current PDF has no Existing PDF Annotations.
- **Authority:** GitHub issue #25 and the Product Contract below define behavior. Existing annotation discovery and read-only annotation semantics remain authoritative outside this presentation change.
- **Execution profile:** One localized React rendering change with focused component and browser regression coverage.
- **Stop conditions:** Stop if confirmed absence cannot be distinguished from loading or discovery failure without changing the discovery contract.
- **Tail ownership:** Implement, verify, review, and ship through the current LFG run.

## Product Contract

### Summary

The Annotations workspace will omit the complete External Annotations section when the current PDF has a confirmed-empty external annotation inventory. Populated, loading, and error states retain their current presentation.

### Problem Frame

The workspace currently renders an External Annotations heading and “No existing annotations.” copy even after discovery confirms that the PDF contains none. This empty section adds visual structure without useful content and competes with the editable annotation list.

### Requirements

- R1. When external annotation discovery has confirmed an empty inventory, the Annotations workspace shall not render the External Annotations region, heading, empty-state copy, or section spacing.
- R2. When at least one Existing PDF Annotation is available, the External Annotations region shall retain its heading, read-only rows, metadata, and navigation behavior.
- R3. Loading and error states shall retain their current status and retry presentation because neither state confirms absence.
- R4. Review Items and all other Annotations workspace content and behavior shall remain unchanged.

### Acceptance Examples

- AE1. **Confirmed empty inventory**
  - **Covers:** R1, R4
  - **Given:** The current PDF's external annotation discovery state is `empty`.
  - **When:** The Annotations workspace renders.
  - **Then:** The owned Annotations content remains present and no External Annotations region, heading, empty copy, or section state marker exists.
- AE2. **Populated inventory**
  - **Covers:** R2, R4
  - **Given:** External annotation discovery is `ready` with at least one item.
  - **When:** The Annotations workspace renders.
  - **Then:** The read-only external region and its annotation row remain available and navigable.
- AE3. **Inventory unresolved or unavailable**
  - **Covers:** R3
  - **Given:** External annotation discovery is loading or has failed.
  - **When:** The Annotations workspace renders.
  - **Then:** The existing status or retry interface remains visible.

### Scope Boundaries

- Do not change external annotation discovery, merging, ownership, navigation, or persistence.
- Do not redesign the Annotations workspace or the standalone annotation display in `apps/web/src/app/App.tsx`.
- Do not alter populated, loading, or error copy and styling beyond changes mechanically caused by removing the confirmed-empty section.

## Planning Contract

### Key Technical Decisions

- KTD1. **Branch at the presentation boundary.** Conditionally omit the complete external annotation section in `ReviewShell` when `ExistingAnnotationsDiscovery.status` is `empty`. The existing discovery authority already distinguishes confirmed absence from loading, error, and populated results, so no upstream state change is needed.
- KTD2. **Protect both structure and appearance.** Add focused static-render assertions for the empty and populated branches, then update the existing empty-state visual snapshot. This proves that semantic content and the intended tray layout change together.

### Assumptions

- “No external annotations” in issue #25 means a confirmed-empty discovery result. Loading and error states remain visible because they do not establish absence.

### Sources and Research

- `apps/web/src/app/ReviewShell.tsx` owns the external section inside the Annotations workspace.
- `apps/web/src/pdf/existing-annotations.ts` defines `empty` as a successful zero-item discovery result.
- `docs/solutions/design-patterns/outline-aware-annotation-workspace-presentation.md` establishes the project rule that document-dependent UI disappears only after confirmed absence.
- `apps/web/test/review-layout.test.tsx` and `test/acceptance/review-visual.spec.ts` provide existing component and visual verification seams.

## Implementation Units

### U1. Conditionally render and verify the external annotation section

- **Goal:** Hide the complete External Annotations section only for confirmed-empty discovery and preserve every other discovery state.
- **Requirements:** R1-R4; covers AE1-AE3.
- **Dependencies:** None.
- **Files:**
  - `apps/web/src/app/ReviewShell.tsx`
  - `apps/web/test/review-layout.test.tsx`
  - `test/acceptance/review-visual.spec.ts-snapshots/exceptional-annotation-empty-darwin.png`
- **Approach:**
  1. Gate the complete external annotation section on the established non-empty discovery states, following KTD1.
  2. Add focused static-render assertions for the confirmed-empty branch and retain populated-state assertions.
  3. Regenerate the existing exceptional empty-state visual snapshot and verify that loading and error snapshots remain unchanged.
- **Patterns to follow:** Mirror the confirmed-absence presentation rule documented in `docs/solutions/design-patterns/outline-aware-annotation-workspace-presentation.md` and the existing state-specific assertions in `apps/web/test/review-layout.test.tsx`.
- **Test scenarios:**
  1. Covers AE1. Render `ReviewShell` with `status: 'empty'`; verify owned Annotations content remains and the external region, heading, empty copy, and discovery-state marker are absent.
  2. Covers AE2. Render with `status: 'ready'` and one Existing PDF Annotation; verify the external region, read-only row, metadata, and navigation control remain present.
  3. Covers AE3. Preserve the existing loading and error rendering assertions so status and retry behavior do not regress.
  4. Capture the established exceptional empty visual scenario; verify the tray contains no empty external section or residual spacing.
- **Verification:** Focused component tests pass, the intentional visual snapshot changes only for confirmed empty state, type checking passes, and the broader review suite remains green.

## Verification Contract

| Gate | Command | Proves |
|---|---|---|
| Focused rendering | `pnpm exec vitest run apps/web/test/review-layout.test.tsx` | AE1-AE3 and the structural rendering contract |
| Type safety | `pnpm typecheck` | The conditional rendering change preserves TypeScript contracts |
| Visual regression | `pnpm test:visual` | The confirmed-empty tray layout matches the approved snapshot and other visual states remain stable |
| Review regression | `pnpm test:review` | Existing annotation navigation, read-only behavior, and review interactions remain intact |

## Definition of Done

- U1 satisfies R1-R4 and AE1-AE3.
- The External Annotations section is absent only for confirmed-empty discovery.
- Populated, loading, and error behavior remains intact.
- Focused rendering, type-check, visual, and review regression gates pass.
- The diff contains no unrelated annotation-state or workspace redesign and no abandoned experimental code.
