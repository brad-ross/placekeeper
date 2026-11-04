---
title: Landing Download Split Button - Plan
type: feat
date: 2026-11-04
topic: landing-download-split-button
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Landing Download Split Button - Plan

## Goal Capsule

**Objective:** Visitors can get the appropriate Placekeeper desktop download directly from the landing page and find alternative platforms or source builds without a long installation dialog.

**Means:** A platform-aware split download button with a compact alternatives menu.

**Product authority:** The landing-page design confirmed by the user on November 4, 2026. This plan covers that design change; the existing desktop installer and manual-upgrade plan remains separate.

**Execution profile:** Three bounded units, delivered together in the existing PR #145. The coordinating implementer owns integration, verification and publication; unit owners remain within the file boundaries below.

**Stop conditions:** Report evidence that invalidates the confirmed Product Contract before changing its behavior. No launch blockers remain.

## Product Contract

### Summary

Replace the landing page's installation-dialog entry point with one split download button. Its main area offers the visitor's platform download; its chevron exposes the other platforms, source installation and releases. Keep the existing landing-page styling and adjacent GitHub action.

### Problem Frame

Visitors currently pass through a long installation dialog to reach a desktop artifact. Its source prerequisites and upgrade guidance obscure the download action.

### Key Decisions

- **One combined control.** Governs R1, R5. (session-settled: user-directed — chosen over separate secondary platform links: keep the main action and alternatives together.)
- **Platform-aware default with an explicit Mac fallback.** Governs R2–R4. (session-settled: user-approved — chosen over requiring every visitor to select a platform: simplify downloading while retaining manual alternatives.)
- **Minimal landing-page copy.** Governs R6. (session-settled: user-directed — chosen over installation steps and existing-installation notes: the installer should explain its own flow.)

### Requirements

**Download action**

- R1. Present the primary download action and a separately operable chevron as one visually joined split button, with GitHub beside it.
- R2. Detect the visitor's operating system and, where reliable, architecture; the main action downloads the matching published installer and names its platform.
- R3. For macOS when architecture cannot be determined reliably, default to Apple Silicon and keep Intel available in the alternatives menu.
- R4. For an unidentified or unsupported device, the main action opens the alternatives menu rather than guessing an installer.

**Alternatives and presentation**

- R5. The chevron opens a compact menu containing macOS Apple Silicon, macOS Intel, Windows, Linux Debian / Ubuntu, Build from source, and All releases.
- R6. Omit installation instructions, unsigned-app approval instructions, and existing-installation or upgrade notes from the landing-page download flow.
- R7. Match the landing page's existing typography, colors, spacing and restrained styling, keeping the split button and menu usable on narrow screens.
- R8. Both button segments and menu choices must be keyboard accessible, with an accessible name for the chevron, visible focus, and dismissal that returns focus appropriately.
- R9. Offer direct downloads only for published artifacts; an unavailable platform must remain understandable without a broken link or a source archive presented as a desktop installer.

### Layout and Key Flows

The closed state shows the platform download label in the wide left segment and a narrow chevron segment on its right. GitHub remains a separate adjacent action. The open menu sits below the split button, with platform downloads above a divider and the two source/release links below it.

- F1. **Direct download — covers R1–R3, R9.** A visitor arrives on a supported desktop platform, sees the matching label, and activates the main segment to download the available installer.
- F2. **Alternative download — covers R4, R5, R8.** A visitor opens the chevron, or activates the main segment on an unknown device, then chooses a platform, source instructions or releases.
- F3. **Dismissal — covers R7, R8.** A visitor closes the menu without navigating and can continue using the landing page with focus retained or restored to the invoking control.

### Acceptance Examples

- AE1. **Covers R2, R9.** Given a detected supported Windows device and a published matching installer, activating the Windows-labelled main segment downloads that installer directly.
- AE2. **Covers R3, R5.** Given a Mac with unknown architecture, the main action defaults to Apple Silicon; the menu still offers Intel. This default is a product choice, not a claim that browser detection established the chip type.
- AE3. **Covers R4, R5.** Given a mobile, unidentified or unsupported device, activating the main segment opens the same platform menu used by the chevron.
- AE4. **Covers R5, R6.** Opening the menu exposes Build from source and All releases without adding compiler prerequisites, installation steps or upgrade guidance beside the primary action.
- AE5. **Covers R8.** A keyboard user can open the menu, reach its choices, dismiss it with Escape and return focus to the invoking control.
- AE6. **Covers R9.** Given no published installer for the selected platform, the flow offers no dead download and retains access to source instructions and releases.
- AE7. **Covers R1, R7.** At a narrow viewport, both split-button segments, GitHub and the open menu remain readable and operable without horizontal page overflow.

### Scope Boundaries

This change covers the landing-page download control and its alternatives. It does not redesign the rest of the landing page, change installers or their consent behavior, publish releases, or expand the native CI matrix. The historical source release remains distinct from a packaged desktop download.

### Dependencies and Planning Questions

The existing download catalog remains the authority for artifact availability. Browser detection is a convenience; users can always choose another platform through R5.

Deferred to planning: select the browser signals and supported architecture mapping that implement R2–R4; specify concise labels and the unavailable-artifact state under R9; reuse the existing source/release destinations and accessibility patterns where suitable. These details must preserve the confirmed defaults and the copy exclusions in R6.

### Sources

- `apps/web/src/landing/InstallDialog.tsx` and `apps/web/src/landing/downloads.ts`: current installation flow and download catalog.
- `docs/plans/2026-11-03-1654-feat-desktop-downloads-manual-upgrades-plan.md`: separate installer and distribution requirements.
- Confirmed visual probe, machine-local and best effort: `/tmp/compound-engineering-503/ce-brainstorm-visual/landing-download-20261104/screens/002-split-download.html`, showing closed and open states. It is a display-only sketch; no decisions.md was produced. Its footer predates the confirmed Mac fallback in R3. A missing sketch is not a blocker, and this plan governs any disagreement.


## Planning Contract

**Product Contract preservation:** Product Contract unchanged. The added Problem Frame explains the existing motivation; R1–R9, F1–F3 and AE1–AE7 retain their meanings and IDs.

### Key Technical Decisions

- KTD1. **Keep catalog validation authoritative.** Reuse `loadDownloads` and `parseDesktopRelease` unchanged for R9. The catalog is all-or-none: a missing required installer or checksum makes the entire release unavailable. Do not synthesize URLs, relax validation, scan older releases or present source archives as installers.
- KTD2. **Separate browser selection from release loading.** Extend the pure selector in `apps/web/src/landing/downloads.ts` with optional platform and touch signals, supplied safely by the browser adapter in `StaticLauncher`. Retain the existing explicit Windows/Linux x64 recognition and reject explicit unsupported architectures. Treat Mac UA `Intel` as ambiguous, per R3. This implements the approved default without claiming hardware certainty. (session-settled: user-approved — chosen over requiring every visitor to select a platform: simplify downloading while retaining manual alternatives.)
- KTD3. **Use one reusable split-control component at both entry points.** Add `apps/web/src/landing/DownloadButton.tsx` and replace both the hero and lower `#install` actions in `StaticLauncher`. The parent still owns the single catalog request. Each instance owns its disclosure and trigger refs, with unique IDs. An available main action is a real artifact anchor; otherwise it is a button opening alternatives. GitHub remains adjacent. This implements R1 and R5. (session-settled: user-directed — chosen over separate secondary platform links: keep the main action and alternatives together.)
- KTD4. **Use a nonmodal disclosure containing native links.** The chevron is a named button with `aria-expanded` and `aria-controls`; the panel is a labelled navigation/list surface, not an ARIA application menu. Native Tab order reaches available choices without a focus trap or invented arrow-key contract. Escape closes and restores the actual invoking segment. Outside pointer activation closes without stealing focus from the clicked control; leaving the control by Tab closes without restoring focus. These distinctions implement R8 while preserving ordinary page navigation.
- KTD5. **Remove the obsolete dialog completely.** Delete `InstallDialog.tsx`, its CSS, dialog refs and handlers, and clipboard-only landing tests. Do not preserve its exported command solely to keep obsolete tests passing. Keep the source-release packaging command and installer documentation intact. R6 governs the visible content. (session-settled: user-directed — chosen over installation steps and existing-installation notes: the installer should explain its own flow.)

### Browser target mapping

These are selection heuristics, not hardware certification. Use only synchronous signals already available from `navigator`; do not add asynchronous high-entropy requests, fingerprinting or a new detection dependency. The pure helper must accept plain data and remain safe without browser globals.

| Browser evidence, in precedence order | Selected target |
|---|---|
| Android, iPhone, iPad or Mobile UA; Mac-like platform/UA with more than one touch point | Unknown; alternatives |
| Explicit Windows ARM/aarch64, Linux ARM/aarch64, or ChromeOS | Unknown; alternatives |
| Windows UA with Win64, WOW64 or x86_64 and no unsupported-architecture evidence | `win32-x64` |
| Linux UA with x86_64 and no excluded device evidence | `linux-x64` |
| Remaining Macintosh/Mac OS UA or Mac platform | `darwin-arm64` under R3 |
| Missing signals, unrecognized OS or unsupported 32-bit desktop | Unknown; alternatives |

No synchronous Mac signal in this plan establishes Intel reliably. Intel remains a manual menu choice. Linux detection does not establish distribution; label the artifact explicitly as Debian / Ubuntu x64 so users can judge compatibility.

### Action states

| Catalog state | Browser target | Main action | Panel platform rows |
|---|---|---|---|
| Available | Known | Platform-labelled artifact link | Four validated download links |
| Available | Unknown | “Download Placekeeper” opens alternatives | Four validated download links |
| Loading | Any | “Download Placekeeper” opens alternatives | Four noninteractive rows, “Checking downloads…” status |
| Unavailable | Any | “Download Placekeeper” opens alternatives | Four noninteractive rows, “Downloads unavailable” status |

Rows remain understandable in all states, with no href or activation handler on unavailable platform rows. The panel always retains Build from source and All releases after a divider. Build from source goes to the existing installation document (`RELEASE_REPOSITORY` + `/blob/main/docs/installation.md`); All releases goes to the repository `/releases` index. Do not reuse `ALL_DOWNLOADS_URL` for the latter: it currently points to `/releases/latest`, not the index. This is a landing-local destination; leave the shared constant unchanged.

### Assumptions

The compact unavailable presentation and nonmodal disclosure are bounded implementation choices made without another product checkpoint. Status copy belongs inside the open panel, keeping the closed control uncluttered. Showing the same reusable control at both existing download entry points preserves the page's established structure. The browser mapping intentionally retains current Windows/Linux heuristics rather than widening the supported desktop matrix.

### Evidence and boundaries

`apps/web/src/static-entry.tsx` currently owns one catalog request, two dialog triggers, the demo and pending PDF opening state. Preserve those latter states when replacing only download wiring. `apps/web/src/landing/downloads.test.ts` already checks incomplete/source-only catalogs and fetch failure. `test/acceptance/static-web.spec.ts` already proves demo identity and pending-open preservation across download UI interaction. Those behavioral checks remain valuable after their dialog assertions change.

No new release API, release publishing, platform build, installer flow or distribution qualification is required. No retry/cache mechanism is added: existing bounded loading and its unavailable result suffice. Actual download presentation and narrow-screen layout are execution-time browser checks, not claims established by this plan.

## Implementation Units

### U1. Select supported browser download targets

**Goal:** Supply a testable target decision for R2–R4 without changing release validation.

**Requirements:** R2–R4, R9; F1–F2; AE1–AE3.

**Dependencies:** None.

**Files owned:** `apps/web/src/landing/downloads.ts`, `apps/web/src/landing/downloads.test.ts`.

**Approach:** Apply KTD2 and the browser mapping. Preserve the existing `Downloads` states and fetching/parser boundary under KTD1. Expose the optional hints in a small plain-data input that U2 can supply without reading globals inside the helper.

**Patterns:** Existing pure `browserDownloadTarget` tests and release fixtures in the same module.

**Test scenarios:**

1. Covers AE1. A Windows x64 UA selects `win32-x64`; Linux x86_64 selects `linux-x64`.
2. Covers AE2. A Mac UA containing Intel selects Apple Silicon as the declared fallback, not Intel.
3. Covers AE3. Android/iPhone/iPad, Mac-like iPad desktop identity with touch points, ChromeOS, Windows/Linux ARM, 32-bit or empty/unknown identity select no target.
4. Existing unavailable, incomplete, source-only and oversized catalog tests continue to pass unchanged in meaning.

**Test seam:** Pure unit tests prove mapping and catalog behavior; they cannot prove browser focus, download activation or layout.

**Verification:** Target decisions match the table, and no parser or supported-release contract changes appear in the diff.

### U2. Integrate the split download control and remove the dialog

**Goal:** Deliver the same direct-download and alternatives behavior at both landing actions.

**Requirements:** R1–R9; F1–F3; AE1–AE7.

**Dependencies:** U1's selector input contract.

**Files owned:** New `apps/web/src/landing/DownloadButton.tsx`; modify `apps/web/src/static-entry.tsx`, `apps/web/src/static-entry.css`, `apps/web/test/static-entry.test.ts`; delete `apps/web/src/landing/InstallDialog.tsx`.

**Approach:**

1. Implement KTD3–KTD4 and the action-state table in the reusable control, with native anchors, concise platform labels and the two footer destinations.
2. Wire both existing locations to the shared catalog state and browser signals; remove obsolete dialog imports, state and callbacks under KTD5.
3. Style joined segments, visible focus, panel position and narrow-screen wrapping with existing landing variables. Keep the panel within the viewport and above adjacent content without moving the demo.
4. Replace the old SSR dialog/command contract test with browser-free rendering coverage for the new controls and no installation-flow copy.

**Patterns:** Existing landing button styles in `static-entry.css`; `StaticLauncher` catalog lifecycle and its SSR test harness. Do not import the review application's menu machinery for a native-link disclosure.

**Test scenarios:**

1. SSR with no `navigator` renders both controls without throwing and without a dialog or source install command.
2. Available known-target component markup exposes the correct primary artifact href; unknown and unavailable variants expose a main button with no fabricated artifact URL.
3. Covers AE4 and AE6. The open panel presents four platform choices plus source/release destinations; unavailable rows have no active download link and excluded instructions never appear.

**Test seam:** `apps/web/test/static-entry.test.ts` catches SSR/wiring and link semantics; U3 owns real interaction, state-preservation and layout proof.

**Verification:** Both entry points use the new component. There are no remaining landing imports, CSS selectors or tests requiring `InstallDialog` or its clipboard command.

### U3. Prove download and page interaction behavior in the browser

**Goal:** Verify the new flow and retain meaningful regressions from the old dialog tests.

**Requirements:** R1–R9; F1–F3; AE1–AE7.

**Dependencies:** U1 and U2.

**Files owned:** `test/acceptance/desktop-downloads.spec.ts`, `test/acceptance/static-web.spec.ts`.

**Approach:** Rewrite existing dialog-focused acceptance cases around the split control. Remove clipboard-only cases. Reuse intercepted GitHub metadata and published-artifact fixtures so tests never depend on live releases. Preserve the existing real demo and pending document-open scenarios.

**Test scenarios:**

1. Covers AE1. Windows x64 main action follows the validated installer URL directly without a dialog. Intercept the fixture artifact to prove activation/download behavior without fetching a real binary.
2. Covers AE2. Mac Intel-text UA defaults to the ARM artifact; the chevron exposes a distinct Intel artifact link. Test Linux's labelled Debian / Ubuntu artifact and the source/release destinations.
3. Covers AE3. Unknown/mobile and iPad desktop identities open alternatives from the main segment; the chevron opens the same choices.
4. Covers AE4 and AE6. Delayed metadata keeps both footer links usable. After a complete fixture arrives, download links become available; failed/incomplete/source-only metadata produces no installer href. No installation, upgrade, OS-approval or clipboard UI survives.
5. Covers AE5 / F3. Enter/Space opens from each button segment where applicable, Tab reaches links, Escape restores the invoking segment, outside click preserves focus on its destination, and Tab exit does not trap focus. With two instances, IDs are unique and opening the other control does not leave overlapping panels.
6. Covers AE7. Inspect closed/open controls at 1440px and 390px, plus a 320px narrow check: joined borders, focus visibility, readable labels, adjacent GitHub, no clipping or horizontal page overflow. Capture representative screenshots.
7. At both entry points, opening/dismissing alternatives retains demo frame identity, selected demo tab and annotations; existing divider spacing remains equal.
8. A pending PDF URL request remains pending through opening and Escape dismissal, and its eventual error still completes the original operation.

**Patterns:** Existing fixtures and viewport loops in `desktop-downloads.spec.ts`; retained demo and pending-request tests in `static-web.spec.ts`. Use actual keyboard activation rather than focus-then-click for keyboard assertions, following `docs/solutions/test-failures/playwright-focus-then-click-hidden-row-actions.md`.

**Test seam:** These browser cases prove DOM behavior, download activation, layout and existing page-state isolation. They do not qualify a native installer.

**Verification:** Focused browser tests pass against the built static artifact with deterministic metadata, and screenshots show the approved joined control and compact alternatives.

## Verification Contract

Run the existing focused Vitest files for U1 and U2, then the changed Playwright cases for U3 against the Pages-base static build. `pnpm test:static:unit` does not currently list `apps/web/src/landing/downloads.test.ts`, so run that file explicitly as well. Use the repository's `pnpm typecheck`, `pnpm build:static:pages` and `pnpm validate:static` gates. The existing `pnpm test:static:pr` gate includes the critical browser coverage and distribution checks; run it before publication under the repository's current workflow.

Do not add native packaging or downloaded-installer qualification to this UI change. Inspect the focused screenshots and exercise keyboard dismissal in a real browser. Existing wider PR requirements remain the coordinating implementer's responsibility. No tests or builds were run during planning.

## Definition of Done

- U1's mapping implements the approved Mac fallback and excludes unsupported/mobile identities under R2–R4.
- U2 replaces both landing actions, removes the installation dialog and its dead assets, and keeps catalog validation authoritative.
- U3 proves AE1–AE7, correct destinations and page-state preservation with the focused checks above.
- All required checks pass or a concrete environmental blocker is reported; no experiment, abandoned code or obsolete test remains in the diff.
- The coordinated change is incorporated into existing PR #145 without expanding the installer or publishing scope.
