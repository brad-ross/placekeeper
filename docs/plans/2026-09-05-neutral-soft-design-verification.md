# Neutral Soft Design Verification

Status: implementation complete; automated verification passed on September 5, 2026. Platform-specific release checks are listed below.

This note records the automated evidence for the neutral soft design contract and the platform checks that still require a real operating-system session. The acceptance coverage measures rendered geometry and focus in the browser; it does not treat the illustrative HTML reference as product evidence.

## Automated coverage

| Contract area | Evidence | Result |
| --- | --- | --- |
| Overlay-scrollbar baseline | The canonical workflow keeps the PDF viewport mounted and at the same scroll location while right and bottom trays open, close, and reflow. It checks the existing overlay-scrollbar geometry path without replacing browser metrics. | Chromium and WebKit workflow suites pass. |
| Classic scrollbar wider than 12 px | A Chromium-only acceptance case installs a real overflowing scrollport with a 20 px WebKit scrollbar, reads `offsetWidth - clientWidth`, and requires the measured vertical track to exceed 12 px. It checks that `--review-overlay-inset` and all three bottom-tray outside margins use the common measured inset, the scrollbar viewport is not shrunk or hidden, the PDF canvas bounds stay fixed, and the hide action remains focusable. | Passes in Chromium. The macOS headless browser reserves the 20 px vertical track but reports the horizontal track as overlay width 0; the assertion records those runtime values and uses the common 20 px outside inset. |
| Enlarged text | A workflow case raises review controls, inputs, tabs, and menu items to 20 px at 320 px, 736 px, and 1280 px widths. At each width it checks for stage overflow, explicitly reopens the responsive workspace when needed, scrolls the inner annotation viewport, verifies the workspace header remains fixed, and focuses the visible hide action inside the viewport. | Passes in Chromium and WebKit. |
| Explicit Fit Width | The real-PDF production flow uses the current zoom textbox and zoom menu's `Fit width` action. It measures the main viewport client box, the viewer's rendered right runway, the current page, and the open tray boundary. Closed, bottom References, right References, resized right References, viewport resize, and right Annotations cases require the page to fit inside the measured unobscured interval with standard margins. It also checks one-shot zoom preservation, stable mounts, page preservation, and no tray overlap during the fit transition. | Passes in Chromium. |
| Cross-page and offscreen editor placement | The harness publishes the real authoring-preview identity into test marks. The acceptance case supplies a two-page target with page 1 offscreen and page 2 visible, checks that the editor is placed 12 px from the visible endpoint, moves both mounted targets offscreen, and verifies that the last visible placement is preserved. It then resizes through 736 px and 320 px and requires the editor and draft to remain reachable and focused. | Passes in Chromium and WebKit. |

The offscreen acceptance case found a precedence defect in `usePassageEditorPlacement`: once matching target marks existed but all were offscreen, the stale fallback client point replaced them. The placement hook now uses the mounted target union before the fallback, so offscreen marks preserve and reclamp the last visible placement.

## Commands

```text
playwright test test/acceptance/review-workflow.spec.ts --grep "actual wide classic|enlarged review text|cross-page editor"
playwright test --config playwright.webkit.config.ts test/acceptance/review-workflow.spec.ts --grep "enlarged review text|cross-page editor"
playwright test test/acceptance/production-flow.spec.ts --grep "defaults a real PDF to fit width"
```

## Platform limits and manual checks

The enlarged-text automation is a deterministic 20 px user-style simulation. It does not claim to exercise macOS Accessibility Display settings, Windows text scaling, browser page zoom, or every system font metric. Before release, repeat the 320 px, 736 px, and desktop checks with the supported operating systems' enlarged-text settings and keyboard-only navigation.

The automated classic-scrollbar case validates an actual 20 px Chromium vertical track. The macOS headless runtime retains an overlay horizontal scrollbar, and WebKit does not expose a deterministic forced-classic metric in this setup. Before release, enable always-visible scrollbars in a real macOS session and repeat on a Windows session. Confirm both main scrollbar tracks remain usable, neither tray covers a thumb, the common left/right/bottom outside inset expands when either track exceeds 12 px, workspace content stays symmetric, and header actions retain an unclipped focus ring.

The real-PDF Fit Width flow runs in Chromium because the production host fixture is configured there. A manual second-engine check should activate Fit Width after opening and resizing both References and Annotations, then confirm the current page remains wholly inside the usable PDF area with both edge margins visible.

## Final integration evidence

- Full web unit suite: 59 files, 785 tests passed after the final source changes.
- Chromium and WebKit workflow coverage passed, including reader position preservation, editor focus/IME, direct page/zoom validation, draft retention, and responsive geometry. Newly added geometry cases and the corrected selector/gating cases passed their focused reruns.
- Chromium visual suite: 49/49 passed against reviewed Darwin baselines. WebKit visual behavior: 49/49 passed with snapshot comparison disabled; no claim of pixel-identical cross-engine rendering.
- Numeric toolbar cases: 8/8 in each engine. Reloadable-link production flow passed in each engine.
- Production web, VS Code, and Chrome builds passed and share the same generated asset manifest. Packaging passed 37/37; host/static/VS Code/Chrome tests passed 145/145.
- Direct TypeScript checking and `git diff --check` passed.
- The selected B icon is synchronized across the macOS master/iconset, VS Code, and Codex plugin assets. ICNS compilation and reverse expansion validate representations from 16 through 1024 px.
- Native macOS application sources compiled. Native unit tests could not run because the installed command-line toolchain lacks XCTest. The installed Finder/Dock appearance was not manually checked.

All plan implementation work is complete. The operating-system checks above are release validation limits, not unimplemented interface features. The implementation is organized into separate commits for icon assets, host styling, the shared review interface with its tests, and this completion record.
