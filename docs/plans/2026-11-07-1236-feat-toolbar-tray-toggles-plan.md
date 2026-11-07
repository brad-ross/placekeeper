---
title: Move PDF tray toggles to the toolbar
type: feat
date: 2026-11-07
topic: toolbar-tray-toggles
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Move PDF tray toggles to the toolbar

## Goal Capsule

- **Objective:** Give readers more unobstructed PDF space while keeping each available tray one click away.
- **Means:** Move visibility controls to the existing toolbar and remove the closed rails (KTD1 and KTD2).
- **Product authority:** The approved chat proposal governs visibility controls and closed-tray framing. The existing dockable References and compact workspace contracts govern docking and mode navigation.
- **Execution profile:** One pull request, with local behavior and layout verification before review and publication.
- **Stop conditions:** The controls must fit the existing toolbar and keep all supported tray modes accessible.
- **Tail ownership:** The orchestrator owns integration, verification, review fixes, publication, and CI follow-up.
- **Open blockers:** None.

## Product Contract

### Summary

Readers use the right and bottom panel icons in the top-right toolbar to open and hide the corresponding trays. The PDF gets the space formerly occupied or obscured by the closed rails.

### Problem Frame

Closed tray controls reserve space on the right and cover the bottom of the viewer with gray backing and fades. That uses reading space even when the reader has dismissed the trays.

### Requirements

- **R1.** On wide layouts, show the right Workspace toggle and, when References is available and separately docked below, the bottom References toggle. On narrow layouts show a single bottom toggle for the combined Workspace. During authoring, follow the existing References-only target and availability.
- **R2.** Reuse the existing right and bottom panel icons and toolbar control styling. Each toggle stays visible while its tray is open, visually shows the open state, and exposes the correct show/hide label and expanded state.
- **R3.** Keep each existing in-tray hide control and the contextual Move References action. Preserve focus handoff, tray state, dock placement, and reference reading position.
- **R4.** Remove closed-rail backing, fades, and layout reservation. Preserve the open-tray clearance, native scrollbar access, and PDF reachability.
- **R5.** Keep the toolbar at its existing height, with usable targets at supported compact widths.

## Planning Contract

### Key Technical Decisions

- **KTD1.** Render a trailing group in `ReviewChrome`, including its controls in responsive width measurement. `ReviewShell` supplies the effective surface, visibility, actions, and focus refs from the existing layout state. Keep visibility and docking commands distinct. Keep tray visibility separate from the hover-revealed toolbar tools and transient toolbar popovers.
- **KTD2.** Delete the closed-rail CSS paths and shell flags. Keep the existing open-tray framing and scroll cues, which have separate conditions. Use the normal closed-viewer margins.
- **KTD3.** Keep the in-tray hide actions and return keyboard focus to the corresponding toolbar button (session-settled: user-approved — chosen over toolbar-only hiding for this pass so readers can dismiss a tray from where they are working).

### Assumptions

- Existing toolbar styling and compact behavior supply the visual language. State uses the toolbar's existing active-control treatment.
- The scope covers the shared review viewer and its existing host variants, including desktop window controls and the landing demo where applicable.

## Implementation Units

### U1. Put visibility controls in the toolbar

- **Goal:** Connect persistent tray toggles to the existing tray and focus behavior.
- **Requirements:** R1, R2, R3, R5.
- **Files:** `apps/web/src/app/ReviewShell.tsx`, `apps/web/src/app/ProductionReviewApp.tsx`, `apps/web/src/review/ReviewChrome.tsx`, `apps/web/src/review/WorkspaceEdgeRail.tsx` or its replacement, toolbar CSS, and affected SSR/component tests under `apps/web/test/`.
- **Approach:** Reuse the existing icon and tooltip components, consolidate show/hide around the same surface actions, and keep the existing opening and closing focus paths. Ensure the two hide controls have distinct accessible names where needed.
- **Test scenarios:** Wide split toggles act independently. Docking References right leaves one right control. Narrow recomposition leaves one bottom control. An available authoring toggle targets References. Keyboard opening and dismissal reach the correct tray and trigger. Touch/compact controls fit beside existing tools. An expanded tray leaves the other hover-revealed tools quiet while reading.
- **Verification:** Run the affected review layout, production app, and reference workspace unit tests, then typecheck.

### U2. Return closed rail space to the PDF

- **Goal:** Remove the right and bottom rail reservation and paint.
- **Requirements:** R4.
- **Files:** `apps/web/src/app/review-viewer-framing.css`, closed-rail rules in workspace/responsive CSS, and framing assertions in `test/acceptance/workspace-row-interactions.spec.ts`. U1 owns shell attributes and toolbar CSS.
- **Approach:** Remove only rail-specific layout and paint rules. Check the existing scrollbar backing and overlay geometry separately from the rail styling.
- **Test scenarios:** Closed desktop framing returns to ordinary reading margins and displays no rail backing. An open tray retains its needed clearance. The native scrollbar remains available.
- **Verification:** Run the affected framing browser tests in Chromium and WebKit.

### U3. Verify the integrated reader interaction

- **Goal:** Exercise the real toolbar and PDF surface together.
- **Requirements:** R1–R5.
- **Files:** `test/acceptance/review-workflow.spec.ts` and affected acceptance selectors and visual baselines under `test/acceptance/`.
- **Approach:** Update existing tests that identify the former edge controls. Use toolbar-scoped selectors when both hide actions are visible. Check geometry and behavior on wide and compact windows, and inspect representative visual evidence before accepting baseline changes.
- **Test scenarios:** Open and hide each tray, switch the dock, narrow and widen the window, and verify the closed viewer's framing and toolbar height. Check in-tray close focus return.
- **Verification:** Run the affected Playwright cases and inspect desktop visual evidence where available.

## Verification Contract

Run `pnpm typecheck`, the targeted Vitest review suites, and targeted Playwright cases through the repository's Chromium and WebKit configurations. Inspect the resulting toolbar and viewer at representative widths. Follow `CONTRIBUTING.md` for desktop evidence and report each unavailable host or baseline separately.

## Definition of Done

The adaptive controls, local hide actions, focus, and PDF framing match R1–R5. The focused tests and visual checks have evidence. The final diff excludes abandoned code, and a pull request records the change and check results.
