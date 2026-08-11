---
title: Reference Link Fit-to-Width Default - Plan
type: feat
date: 2026-08-11
topic: reference-link-fit-width-default
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Reference Link Fit-to-Width Default - Plan

## Goal Capsule

- **Objective:** Open new internal-link destinations in Reference Tabs at a readable fit-to-width zoom with a small symmetric margin.
- **Product authority:** This contract owns only the initial framing of a newly opened or retried Reference Tab destination. The existing reference-navigation contracts remain authoritative for target identity, tab deduplication, saved tab state, main-view navigation, docking, resizing, and user-owned scroll and zoom.
- **Open blockers:** None.
- **Execution profile:** Lightweight code change with pure navigation-math tests, coordinator lifecycle coverage, and real-browser geometry verification.
- **Tail ownership:** `ce-work` implements the units and returns control to LFG; LFG owns simplification, independent review, PR creation, and CI follow-through.

## Product Contract

### Summary

Make the linked PDF page fill the width of the Reference PDF viewer when a destination first opens, while leaving the viewer's normal small margin and preserving the link's vertical reading context.

### Problem Frame

Reference Tabs exist to read nearby referenced material without moving the Main Reading Thread. Author-encoded destinations can currently request full-page or vertical fitting, which makes text unnecessarily small in the shallow bottom References tray and other constrained viewer shapes. A width-fitted initial view makes the referenced text readable while retaining independent scrolling and zooming.

### Key Decisions

- **Default new Reference Tab destinations to fit-to-width.** (session-settled: user-directed — chosen over author-encoded vertical or full-page fitting: the linked page should fill the Reference PDF viewer's width at a useful reading size.) Governs R1-R3.
- **Treat fitting as initial framing only.** Existing tabs restore their saved semantic locations and user-selected zoom rather than reapplying the default. Governs R4-R5.
- **Keep main-view target semantics unchanged.** Direct main navigation, outline navigation, Send to main, Back, and Forward continue using their existing encoded destinations or saved locations. Governs R6.

### Requirements

- R1. Opening a new internal-link destination in References shall wait for the Reference workspace layout to settle, then fit the rotated PDF page width to the committed Reference PDF viewer width.
- R2. The fitted page shall retain the viewer's existing small symmetric horizontal gap instead of touching the viewport edges.
- R3. Width fitting shall preserve a coordinate-bearing destination's vertical reading anchor and shall use a readable top-of-page start when the destination carries only page-level or vertical-fit intent.
- R4. Retrying the same pending new destination shall use the same width-fit policy after the Reference workspace layout and viewer metrics are ready.
- R5. Focusing, switching to, reopening, docking, resizing, or responsively reflowing an existing Reference Tab shall preserve its saved page position and zoom without refitting.
- R6. Main-view and history navigation shall retain their current target and location semantics.

### Acceptance Examples

- AE1. Width-fitted reference in a bottom tray
  - **Covers:** R1-R3.
  - **Given:** A same-document link encodes full-page or vertical fitting and References is docked at the bottom.
  - **When:** The reviewer chooses Open in References.
  - **Then:** The linked page nearly fills the Reference PDF viewer width with a small balanced gap, and the page can scroll vertically from a useful reading start.
- AE2. User zoom survives tab restoration
  - **Covers:** R4-R5.
  - **Given:** The reviewer changes zoom in one Reference Tab and opens another destination.
  - **When:** The reviewer switches back and moves References among supported presentations.
  - **Then:** The first tab restores its saved zoom and reading position instead of returning to fit-to-width.
- AE3. Main navigation remains author-directed
  - **Covers:** R6.
  - **Given:** The same internal target can open in References or in the main view.
  - **When:** The reviewer chooses Open in main or navigates through the outline.
  - **Then:** The main viewer applies the existing author-encoded destination behavior and records history exactly as before.

### Scope Boundaries

- Do not add a persistent fit mode, auto-refit on resize, or a new zoom control.
- Do not change canonical target identity, Reference Tab deduplication, saved location shape, or history semantics.
- Do not add CSS padding or resize/remount either PDF viewer to create the margin.
- Do not change external-link safety, reference document loading, annotation behavior, or delivery flows.

## Planning Contract

### Key Technical Decisions

- KTD1. **Add an explicit reference target-application policy at the project-owned navigation adapter boundary.** (session-settled: user-directed — chosen over honoring vertical or full-page target fitting in Reference Tabs: R1-R3 require the reference region's width to set the initial numeric zoom.) Keep author semantics as the default so only the coordinator's new-reference and retry paths opt into width fitting.
- KTD2. **Resolve width fitting only after the Reference workspace layout has settled.** Make the coordinator await its existing layout-settlement boundary on first-open and retry paths, then reuse rotated page dimensions and the existing EmbedPDF viewport gap in `apps/web/src/pdf/viewer-navigation-adapter.ts`; do not calculate zoom in shell code or from transient portaled-viewer dimensions.
- KTD3. **Override initial framing without mutating the canonical target.** Preserve `PdfNavigationTarget.identity` and the original target stored by reference state, while deriving a neutral `PdfViewerLocation` whose zoom and alignment follow R1-R3.
- KTD4. **Preserve lifecycle separation in the coordinator.** `applyTarget` initializes a new or retried reference, while `applyLocation` continues to restore verified tab snapshots and power Send/history flows.

### Assumptions

- The adapter's existing `viewportGap` is the tasteful symmetric margin required by R2; adding a second hard-coded margin would double-count established viewer spacing.
- Page-only, FitPage, and vertical-fit targets contain no useful vertical reading coordinate, so width-fit initialization starts them at the page top. XYZ, horizontal-fit, and rectangle targets retain their meaningful vertical anchor while changing initial zoom.
- The coordinator's existing layout-settlement boundary, followed by the adapter's target-application readiness wait, is required to distinguish a usable page tree from final Reference viewer dimensions. Both first-open and retry paths recalculate only after that sequence.

### Sources and Research

- `apps/web/src/pdf/viewer-navigation-adapter.ts` owns rotated/cropped target math, committed viewer metrics, viewport gap, bounded readiness waits, and verified semantic location application.
- `apps/web/src/review/navigation-coordinator.ts` separates first-open and retry `applyTarget` calls from existing-tab `applyLocation` restoration.
- `apps/web/src/review/reference-navigation-state.ts` stores each Reference Tab's verified numeric zoom, anchor, and alignment.
- `docs/solutions/architecture-patterns/adaptive-annotation-tray-framing.md` requires programmatic framing to use actual viewer geometry, stay behind project-owned adapters, reject stale async work, and yield to later user navigation.
- `docs/plans/2026-08-09-002-feat-reference-navigation-workspace-plan.md` remains authoritative for independently scrollable and zoomable Reference Tabs and saved tab context.

## Implementation Units

### U1. Add reference-only fit-to-width target application

- **Goal:** Derive and apply a width-fitted initial semantic location for new Reference Tab destinations without changing other navigation paths.
- **Requirements:** R1-R6; AE1-AE3; KTD1-KTD4.
- **Dependencies:** None.
- **Files:**
  - `apps/web/src/pdf/viewer-navigation-adapter.ts`
  - `apps/web/src/review/navigation-coordinator.ts`
  - `apps/web/test/viewer-navigation.test.ts`
  - `apps/web/test/navigation-coordinator.test.ts`
- **Approach:**
  1. Make first-open and retry coordinator paths await the existing Reference workspace layout-settlement boundary before target application.
  2. Add a typed target-application policy whose default preserves author-encoded target semantics and whose reference variant resolves the same target at fit-to-width.
  3. Build the reference variant from the adapter's final committed viewport, rotated page size, crop origin, and viewport gap while applying R3's anchor rules.
  4. Pass the reference policy only from first-open and retry coordinator paths; leave existing-tab restoration and all main navigation unchanged.
  5. Keep cancellation, document-generation checks, rollback, verification, target identity, and stored original target behavior intact.
- **Execution note:** Add failing pure-math and coordinator policy-routing tests before changing production behavior.
- **Patterns to follow:** `createPdfTargetLocation` and bounded `waitForTargetLocation` in `apps/web/src/pdf/viewer-navigation-adapter.ts`; new-reference versus snapshot-restore paths in `apps/web/src/review/navigation-coordinator.ts`.
- **Test scenarios:**
  1. Covers AE1. A full-page target in a shallow viewport resolves to rotated page width divided into viewport width minus twice the existing gap, not the smaller vertical-fit zoom.
  2. A rotated or cropped page uses its rotated full-page width and leaves the established symmetric gap.
  3. XYZ, horizontal-fit, and rectangle destinations keep their meaningful vertical anchor while adopting width-fit zoom.
  4. Page-only, FitPage, and vertical-fit destinations begin at the top of the linked page at width-fit zoom.
  5. Invalid or unready viewer metrics continue to fail closed, and the settled-width retry recalculates rather than reusing stale geometry.
  6. If the page tree becomes usable before the Reference viewport reaches its final width, first open and retry wait for layout settlement and calculate from the final width.
  7. First open and retry opt into reference width fitting; existing-tab focus and switch call `applyLocation` with the saved snapshot.
  8. Direct main and outline navigation call target application with default author semantics.
  9. Rapid superseding reference operations cannot commit an obsolete width-fit location.
- **Verification:** Focused navigation math and coordinator tests pass, and every successful reference opening stores the verified width-fitted numeric location.

### U2. Prove real-viewer geometry and navigation ownership

- **Goal:** Verify the reference default against real EmbedPDF geometry while protecting saved zoom, dock continuity, and main-view behavior.
- **Requirements:** R1-R6; AE1-AE3.
- **Dependencies:** U1.
- **Files:**
  - `test/acceptance/production-flow.spec.ts`
- **Approach:**
  1. Extend the existing real reference-chain scenario to measure the active linked page and actual Reference viewer viewport immediately after opening.
  2. Assert a small balanced horizontal gap and prove the width-fit zoom differs from vertical page fitting in the shallow bottom presentation.
  3. Manually change or observe saved reference zoom, open another destination, switch back, and move through supported dock and responsive presentations without refitting.
  4. Retain the scenario's main-view anchor, mount identity, Send/history, and request-safety assertions.
- **Execution note:** Use the existing deterministic `reference-navigation.pdf` fixture and add behavior assertions before changing any visual baselines.
- **Patterns to follow:** Reference-chain geometry and stable-mount probes in `test/acceptance/production-flow.spec.ts`.
- **Test scenarios:**
  1. Covers AE1. The page-only detail destination opens with page width equal to the usable Reference viewer width within geometry tolerance and with nonzero symmetric edge gaps.
  2. Covers AE2. Manual zoom and scroll in the first tab survive opening a second reference, switching back, right/bottom docking, and narrow reflow.
  3. Covers AE3. Opening the same class of destination in main keeps the existing encoded framing and meaningful-history behavior.
  4. Chromium and WebKit produce equivalent initial fitting and ownership outcomes.
- **Verification:** The focused production scenario passes in Chromium and WebKit using real viewer bounds, and the main and reference mount probes remain stable.

## Verification Contract

| Gate | Command | Proves | Units |
|---|---|---|---|
| Navigation behavior | `pnpm exec vitest run apps/web/test/viewer-navigation.test.ts apps/web/test/navigation-coordinator.test.ts` | Fit math, target policy routing, stale-operation safety, and saved-tab restoration | U1 |
| Type integrity | `pnpm typecheck` | Public navigation contracts and coordinator calls remain consistent | U1 |
| Fixture generation | `pnpm fixtures:pdf` | Deterministic page-only and linked-destination PDF inputs are current | U2 |
| Production build | `pnpm build:web` | The fitted navigation path bundles in the production viewer | U1-U2 |
| Chromium geometry | Focused `test/acceptance/production-flow.spec.ts` reference-chain scenario | Real width fit, margin, tab continuity, and main-view stability | U2 |
| WebKit parity | The same focused scenario with `playwright.webkit.config.ts` | Equivalent geometry and lifecycle behavior in WebKit | U2 |
| Diff hygiene | `git diff --check` | No patch-format defects | U1-U2 |

## Definition of Done

- R1-R6 and AE1-AE3 are satisfied with no launch-blocking question or deliberate test exception.
- New and retried Reference Tab destinations use the committed Reference viewer width and existing gap to set initial zoom.
- Coordinate-bearing destinations retain vertical context, while page-only or vertical-fit targets begin at a readable page-top position.
- Existing Reference Tabs preserve saved zoom and position across switching, reopening, docking, resizing, and responsive reflow.
- Main, outline, Send, Back, and Forward behavior remains unchanged.
- Focused unit tests, typecheck, web build, and Chromium/WebKit production geometry checks pass.
- Experimental or abandoned policy branches, duplicate margin constants, fixture edits, and test helpers are removed from the final diff.
