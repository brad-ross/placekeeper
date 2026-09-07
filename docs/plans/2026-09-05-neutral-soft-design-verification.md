# Neutral Soft Design Verification

Status: the September 5 completion claim was premature. The September 6 audit below records the subsequent corrections against the rendered canonical mockup. Platform-specific release checks remain listed below.

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

The original real-PDF Fit Width flow ran in Chromium. The September 6 production audit also exercises WebKit; the final results below distinguish automated engine coverage from the remaining native platform checks.

## Historical September 5 integration evidence

- Full web unit suite: 59 files, 785 tests passed after the final source changes.
- Chromium and WebKit workflow coverage passed, including reader position preservation, editor focus/IME, direct page/zoom validation, draft retention, and responsive geometry. Newly added geometry cases and the corrected selector/gating cases passed their focused reruns.
- Chromium visual suite: 49/49 passed against reviewed Darwin baselines. WebKit visual behavior: 49/49 passed with snapshot comparison disabled; no claim of pixel-identical cross-engine rendering.
- Numeric toolbar cases: 8/8 in each engine. Reloadable-link production flow passed in each engine.
- Production web, VS Code, and Chrome builds passed and share the same generated asset manifest. Packaging passed 37/37; host/static/VS Code/Chrome tests passed 145/145.
- Direct TypeScript checking and `git diff --check` passed.
- The selected B icon is synchronized across the macOS master/iconset, VS Code, and Codex plugin assets. ICNS compilation and reverse expansion validate representations from 16 through 1024 px.
- Native macOS application sources compiled. Native unit tests could not run because the installed command-line toolchain lacks XCTest. The installed Finder/Dock appearance was not manually checked.

These are historical results. The subsequent audits below supersede the original interface-completion claim.


## September 6 correction audit

The earlier verification missed inherited CSS overrides and interaction states. This pass compared rendered mockup controls with product controls, inspected real-PDF screenshots, and measured computed styles and geometry.

| Requested correction | Verified behavior |
| --- | --- |
| 1. Agent status position | Filename then agent indicator, both left aligned with the shared 8px toolbar gap. |
| 2. Page and zoom spacing | The complete numeric controls, including their buttons, use canonical widths, padding, and 8px group spacing. |
| 3. Numeric-control hover and focus | The whole numeric group fills only on hover. An open dropdown alone adds no fill; keyboard focus outlines the individual button. A second opener click closes the dropdown. Pointer opening retains opener focus; keyboard opening focuses the first menu control. |
| 4. Workspace interiors | Neutral gray trays, transparent resting rows, and white current rows follow the mockup. Shared empty tool shells remain transparent so they cannot cover References. |
| 5. Link tooltip | Pointer opening a link menu does not create a tooltip; actual hover and keyboard focus do. |
| 6. Reference action insets | Bottom split rows use equal 5px top, bottom, and right insets; horizontal rows use equal 3px insets. |
| 7. Search field | Borderless 36px field, canonical focus treatment, fixed 28px clear button with equal 4px insets. Result spacing, typography, and match fills also follow the mockup. |
| 8. Return to reference | The return action sits inside the reference row. Completing the return preserves destination focus. |
| 9. PDF selection visibility | Main and Reference selections retain the visible blue PDF overlay independently of neutral workspace selection colors. |
| 10. Filename button | Normalized product and canonical captures are pixel-identical, including 32px height, 7px gap, 6px/8px padding, 13px/15.6px text, radius, and ellipsis. |
| 11. Header alignment | Mode controls align left; Outline collapse and dock actions align right. The bottom dock control ends one 12px gap before the reference viewer. |
| 12. Reference viewer margins | One 12px inset at each outer viewer edge, including wide split and narrow unified layouts. Removed nested duplicate margins. |
| Outline design | Canonical indentation, disclosure controls, regular text, inline page numbers, wrapping, row fills, subtle current-row shadow, and control-level keyboard focus. Touch controls remain at least 44px. |
| Save destination dialog | Canonical 414px dialog, 23px content inset, 41.5px radio rows, 36px filename input, and 32px text actions. Normal, recovery, pending, and narrow states checked in both engines. |

The audit also corrected loading-reference cancellation during workspace reveal, prevents rehosting a still-loading viewer through the dock action, and prevents a removed return button from stealing focus back from the PDF.

Validation for this correction pass: 786 web unit tests; 67 Chromium workflow tests; 13 targeted WebKit toolbar/workflow tests; six real-PDF regression scenarios in each engine; seven Outline/save-dialog visual and interaction tests; focused save-dialog checks in Chromium and WebKit; production search/reference-chain, reference return, narrow keyboard order, and coarse-pointer checks. TypeScript and the production web build pass. The historical full-suite counts above describe the earlier integration run and are not claimed as a new complete release run.


## Exhaustive rendered-mockup audit, September 6

The source of truth is the final rendered canonical iframe in `docs/plans/assets/neutral-soft-design/index.html`. Early CSS declarations in the artifact are overridden later; measurements use the final computed style. Each of its 14 scenes was captured and inspected. Product PDF page sizes and document text remain real document data; the illustrative paper is not a prescribed PDF layout.

| Canonical scene | Product surface and checked details |
| --- | --- |
| Reading | Filename, agent status, page and zoom inputs, popovers, copy link, tooltips; resting, hover, disabled, pointer-open, keyboard-open, Escape and second-click behavior. |
| Annotations | Transparent resting rows, white current rows with the subtle canonical shadow, hover/focus fills, 9/12/11px content padding, 13px text, inline page numbers, 26px actions in edit/copy/remove order with zero padding, comments and their quoted source. |
| Full annotation | Whole-row three-line truncation with ellipsis opens the full reader; 12px metadata, read-only provenance, 32px actions, 13px/1.6 full text, paragraph spacing, independently scrolling text and preserved return position. |
| Outline | Indentation, disclosures, regular-weight text, page labels, current and hover fills, row controls, focus outlines, unavailable and long branches. |
| Search | Borderless input, clear action, result typography, padding, match fill, current result and shared tray geometry. |
| Text selection | Five-pixel palette inset, two-pixel action gaps, 32px controls, border, radius, shadow and keyboard focus; visible PDF selection retained. |
| Passage editor | 340px surface, 12px padding, 16px radius, canonical shadow, 32px header, 12px metadata, 14px/1.65 input, 94px minimum input height and 30px text actions. Add and edit flows share this surface. |
| Editor offscreen | Inline page cue in the header, labeled 32px-high Back to passage action above the field, 16px icon, canonical text styling, preserved draft and explicit return behavior. |
| Annotation peek | 340px surface, 16px radius, one border, shared annotation row content/actions, comment and quoted source, full-text access. |
| Split references | Current-tab fill/shadow, regular typography, muted 26px actions, canonical insets, row-level return action, one 12px viewer margin and coordinated tools. |
| Reference link | Popover dimensions, action styling, actual hover versus pointer opening, nested reference navigation and focus restoration. |
| Save setup | 414px dialog, 23px inset, radio rows, filename field, hover state, action typography and pending state. |
| Save failure | Canonical inline pale-red notice, Retry and Save a copy actions; pending, failed retry and successful recovery exercised against production UI. |
| Narrow editor | Adaptive passage placement, viewport containment, unchanged draft and focus, compact actions; narrow Page Notes and modal overlap checked separately. |

Product states absent from the illustrative scenes use the same shared design rules: imported/read-only annotations, empty/loading/error trays, generated-document export menus, reattachment, symbol suggestions, terminal recovery and the browser PDF launcher. Their behavior remains covered by workflow and production checks. Coarse-pointer controls preserve 44px targets and reduced-motion settings suppress movement.

`test/acceptance/neutral-design-conformance.spec.ts` compares rendered product components directly with the rendered approved artifact. It checks typography, padding, radius, colors, shadows, control sizes and interaction states; it does not merely compare the application with its own regenerated screenshots. Visual baselines were updated only after inspecting the changed product captures.

The final audit also corrected production defects found while exercising the design: same-page layout settling no longer resets a moved keyboard Page Note cursor; Reference return restores focus to its original target page after reflow; editing an overflowing annotation opened from a peek resumes the full reader; and the editor restores its intended width after a desktop–narrow–desktop resize instead of reusing its previously clamped width. Each correction has an actual production-PDF regression check. Initial Fit Width is converted to its settled numeric zoom after location restoration, so a delayed automatic resize cannot change the main PDF scale when References opens.

Current validation:

The scroll audit also found that WebKit retained obsolete horizontal overflow after the tray runway closed. The adapter now invalidates that stale overflow after the closed geometry settles. Manual pan coordinates survive temporary clamps, but explicit page/search/annotation navigation and zoom changes supersede them; pending captures reset on document replacement, and scrolling updates the remembered position through its final settled offset.

Fit Width now waits for the current asynchronous runway operation as well as the visible tray geometry. Its own zoom notification does not invalidate that settlement. Native scroll changes supersede stale passive restores, while the framing hook distinguishes its own automatic scrolling from user movement. The three previously failing framing cases passed together in both engines and passed a repeated Chromium run.

| Check | Result |
| --- | --- |
| Direct computed-style comparisons against the rendered canonical artifact | 8 passed in Chromium; 8 passed in WebKit. |
| Visual scenarios | 49 Chromium screenshot comparisons passed after the design corrections; all 49 WebKit behavior/layout scenarios passed (Chromium owns the pixel baselines). Later framing fixes also passed focused browser regressions. |
| Canonical workflows | 67 passed in Chromium; 66 passed in WebKit, with one explicit forced-classic-scrollbar skip. |
| Targeted real-PDF interface regressions | 8 passed in Chromium and WebKit, including save recovery and narrow terminal recovery. |
| Web-client unit suite | 795 passed across 59 test files. |
| Production workflows | All 67 cases passed across full runs and focused reruns in each engine. Chromium: 62 passed initially; all five failures passed in the final eight-case batch. WebKit: 66 passed in the final full run; the reference-loading timeout passed on isolated rerun. |
| Build/type checks | Repository TypeScript check and service, web, VS Code, and Chrome extension bundles passed. |
| Distribution checks | Shared app/VS Code/Chrome manifests, static distribution, and catalog checks passed; 37 packaging tests passed. Host/static tests: 130 passed, one skipped. Static and macOS web bundles also built successfully. |

The production JavaScript bundle measures 2,576,473 bytes, 24,379 bytes above the previous reviewed bundle. The distribution baseline records that exact measured output without extra headroom. Catalog record counts, runtime payload, attribution, and hashes are unchanged.

The preview was refreshed from the final bundle and visually inspected with Annotations at the right and References at the bottom. No annotation draft was left behind. One Chromium tray-scroll check and one WebKit Page Note placement precondition also passed after isolated reruns during the audit; the full-run reference-loading timeout above remains a recorded intermittent test failure rather than a claim of a clean uninterrupted run.

The Page Note selection-clear regression uses actual pointer input in Chromium. In this headless WebKit case, native input stopped delivering DOM events after the context-menu gesture and left hover latched. WebKit uses semantic pointer-move/click events at the verified unobscured PDF point, the preview's Close action to release that hover, and a semantic zoom action, while retaining the active-selection and zoom assertions. This case does not certify native WebKit pointer delivery.

The platform-specific manual release checks above remain explicit limits; this audit does not claim a new native Windows or always-visible macOS scrollbar certification.

## Host interface completion — September 6

This follow-up audited the VS Code, Chrome, static-browser, and native macOS interfaces against the shared design. VS Code export now enters the shared document-action flow; host reattachment provides focused recovery or a transient neutral no-work status. Chrome recovery, popup controls, VS Code recovery/fallback, and native recovery/error sheets were updated. CI entrypoints now include the new host and macOS interface regressions.

Native testing found an additional fullscreen defect beyond the browser geometry checks: the empty AppKit toolbar covered the shared controls, and retained offscreen traffic-light frames could collapse the web toolbar. Fullscreen now hides the empty native toolbar, publishes no traffic-light bounds, and restores native toolbar geometry when returning to windowed mode. Control–Command–F is reserved for the native fullscreen action instead of entering PDF Find.

| Verification | Result |
| --- | --- |
| Integrated web, VS Code, Chrome, and host-protocol unit checks | 948 passed, one existing skip. |
| Chromium host and complete shared workflow acceptance run | 73 passed, including real production-component no-work reattachment feedback, protected Chrome recovery, host export, and macOS geometry. |
| WebKit host acceptance checks | Five passed; Chrome-specific Tab traversal is explicitly skipped outside Chromium. |
| Shared visual comparisons | All 49 passed without baseline updates in this follow-up. |
| Final Find/fullscreen shortcut and real-PDF search workflow | Passed. Stale test expectations were aligned with the already-approved 12px search row radius, 26px actions, and separate metadata heading. |
| Final targeted unit/distribution checks | 97 passed; the subsequent native toolbar lifecycle assertion also passed (six native packaging checks). |
| Build and distribution | TypeScript, service, shared web, macOS web, static web, VS Code, and Chrome bundles passed. Shared/static asset validation passed. Reviewed web bundle: 2,580,973 bytes; catalog data/hashes unchanged. |
| Native app verification | Isolated signed candidate compiled and launched with a disposable PDF. Visually verified traffic-light/title alignment, title/save and zoom controls, corrected fullscreen toolbar, and return to windowed mode through Control–Command–F. Blank-title-bar drag was exercised; automated geometry checks verify exclusion of controls and popup areas. |
| Native recovery and fatal-sheet layout | Standalone AppKit assertions passed for button semantics, layout, and Return defaults. |

The installed application and extensions were not updated by these checks. Native compilation used the installed macOS 15.4 SDK because the default SDK and compiler versions differ. XCTest could not run in this Command Line Tools environment (XCTest module unavailable); standalone native assertions, browser geometry tests, and the actual app checks above provide the recorded validation instead.

## Thirteen reported interface defects — September 6

This follow-up covers compact native page/zoom popovers and blank-title-bar dismissal, consistent adaptive workspace surfaces and row actions, neutral search pointer feedback, removal of annotation correspondence stripes, full-reader deletion and long-mark activation, stable annotation editing, standard Mac icon sizing, inset reference resize handles, Chrome popup focus/icons, and annotation hover cards. Validation results are recorded below as the combined audit completes.

Annotation saves now preserve semantically unchanged viewer asset and resource-policy objects, which prevents the PDF engine from remounting during a review update. Real-PDF tests sample 45 animation frames across saves and verify renderer continuity, wide and narrow tray bounds, full-reader actions, long-mark activation, and hover-card retention in Chromium and WebKit. Both trays remain in their existing positions during editing, with mutations temporarily disabled.

The Mac icon uses the standard tile contour and shadow proportions, with the page artwork scaled to 78% to provide approximately 15% interior margins. The final isolated native candidate was rebuilt and its page/zoom dismissal and title-bar drag behavior checked in the actual app.

TypeScript, all host bundles, and shared/static/Chrome distribution validation passed. Integrated unit checks passed 942 tests with one existing skip; packaging checks passed 46 tests. The reviewed shared JavaScript bundle is 2,584,128 bytes, with unchanged catalog data and hashes. Ten corrected hover-action regression cases passed in each browser engine; selected rows retain their selection while hiding actions after pointer and keyboard focus leave the row.

The combined 156-case browser audit and focused reruns resolved every failure: 156 Chromium cases passed; WebKit passed 154 with two deliberate Chrome-specific skips. Test corrections make hover-only controls visible before pointer activation, settle offscreen PDF-link scrolling before opening a popover, verify physical PDF position instead of comparing offsets from different layout coordinates, and check clipboard interception directly after Reference transitions. These corrections retain the underlying interaction and clipboard assertions without depending on transient status UI.

The final visual gate passed all 49 cases after refreshing the approved appearance and lowering the pixel-comparison threshold to 0.05 (100 differing pixels maximum). Fresh image review and live computed styles confirm matching `rgb(240, 240, 240)` tray surfaces, removal of the annotation stripe, full-reader Delete, reference actions, and trays retained behind the editor. The default 0.2 comparison threshold had tolerated some of the subtle neutral-color changes, so unchanged old baseline images were explicitly refreshed.

## Compact workspace spacing — September 6

Search and annotation rows now use 2px vertical margins and 8px vertical content padding, replacing 5px/6px margins and 9px/11px padding. Vertical Reference tabs use a 4px gap. Text line height, horizontal padding, and action sizes are unchanged; annotation hover cards retain their existing padding. The shared viewer and host web bundles were rebuilt, and the existing search/annotation style-equivalence check passed. Visual baselines were refreshed for the denser layout.

Chrome popup pointer and keyboard verification passed against the real extension entrypoint. The actual packaged popup in isolated Chrome for Testing 152.0.7977.82 focuses its title on opening, leaves the toggle without a focus ring, and loads the Placekeeper favicon. The extension's toolbar and management icons now ship at 16, 32, 48, and 128 pixels; distribution validation checks PNG dimensions and equality with the generated source assets.

The owning PDF tab's favicon remains a Chrome limitation. An isolated Chrome 152 run rendered a real four-page PDF through the MIME handler and confirmed that `handler.html` loaded the Placekeeper favicon. The enclosing PDF tab still exposed no `favIconUrl`, while the popup tab exposed the correct Placekeeper PNG. Tab metadata was inspected using a disposable diagnostic copy with `tabs` permission; that permission is absent from the source and shipping extension. Chromium's MIME-handler guest implementation forwards title notifications but does not forward favicon notifications, and the public [mimeHandler API](https://developer.chrome.com/docs/extensions/reference/api/mimeHandler) provides no tab-favicon setter. The handler favicon declaration is present, but this report does not count the enclosing-tab request as fixed.

## Workspace interaction and history fixes — September 6

Search results and annotation rows now share the outline's hover, focus, selected, and action-disclosure behavior. Actions occupy the page-number position without moving the row body. Touch layouts retain visible actions; immutable source-PDF rows retain their page numbers. Source and owned annotations use the same row component in one document-ordered list, with no editing or deletion controls on source entries. Deleting an owned entry restores focus to the adjacent entry in the combined list.

Search restores query focus only when the query was the last focused search control. Returning from the PDF or changing tabs no longer replays an old Find request. Back/Forward navigation preserves the primary button node and its hover appearance during pending navigation, eliminating the transient disabled/mount animation flash.

TypeScript, rebuilt viewer/host web bundles, Chrome manifest checks, and static distribution validation passed. Scoped unit verification passed 974 tests with one skip (the VS Code extension suite required an unsandboxed rerun for its local server). Browser verification and focused reruns passed 148 Chromium cases and 147 WebKit cases with one intentional skip. The full production-flow runs had timing-sensitive context, geometry, and pointer failures that passed in isolated reruns. All 49 visual cases passed. Fresh macOS snapshot review and computed geometry confirm that both annotation origins align their page numbers at the right edge; the interaction regression suite now checks that alignment explicitly. The existing in-app preview was refreshed; installed host applications were not reinstalled.

## Annotation return and search retention — September 6

Pointer Back from a full annotation now focuses the annotation panel instead of an inner row control, releasing the row's focus-driven hover state. Keyboard Back still restores the Read full control (or its navigation fallback), and selection/scroll restoration remains intact. Search suppresses a sole suggestion whose query already exactly matches the trimmed search key. Search-result navigation preserves the workspace for both new destinations and repeated clicks on the current result.

TypeScript and 167 focused unit/packaging tests passed. Chromium and WebKit each passed five row-interaction cases, two real-PDF search cases covering wide/narrow layouts, and nine reader restoration/editing cases. Shared, Mac, static, Chrome, and VS Code web assets were rebuilt; distribution validation passed. The in-app PDF preview was refreshed and its open Outline workspace restored.

## PDF interaction marks — September 6

Implemented the settled warm-note / cool-edit styles, attached-text underlines, replacement strikethrough, steady below-line insertion caret, sticky-note icon, and fill-preserving active outlines. Mark geometry and transient caret orientation follow all four page rotations. The native I-beam remains the text cursor, and proposed text stays in annotation detail.

TypeScript and all 848 web/packaging unit tests passed. Seven new real-PDF cases passed in both Chromium and WebKit, covering all four rotations, zoom, attached-comment changes, hover/active appearance, insertion hit targets, replacement detail, and selection styling. Three existing insertion and repeated-click cases also passed in each engine. Shared, macOS, static, Chrome, and VS Code web assets were rebuilt, and distribution validation passed. The existing in-app PDF preview was refreshed.

Visual review identified three expected baseline changes: the removed proxy focus circle and the previously approved narrow bottom fade. Their screenshots were inspected and updated. The narrow reader test now checks the already-approved pointer return to the annotation panel; keyboard return remains covered by the reader interaction suite.

The final complete visual regression run passed all 49 cases. `git diff --check` passed.

PDF mark polish: corrected the cursor boundary offset and centered adjacent glyph gaps; fixed the placement line at 1.25 screen pixels and removed its halo. Strengthened semantic fills, added hover darkening, and increased underline/strikethrough strokes to 2px. All 101 focused unit tests, TypeScript, and nine real-PDF cases in each of Chromium and WebKit passed. Inspected the rendered mark sheet, rebuilt all viewer distributions, and validated manifests.

Stroke calibration: six overlay unit tests, TypeScript, and ten real-PDF cases per engine (Chromium and WebKit) passed. Browser assertions cover 50%, 100%, and 200% zoom, proportional stroke thickness, a 2px inset hover outline, and the underline at the mark bottom. Reviewed the 200% hover screenshot.

Hover-border refinement passed ten browser cases per engine, including semantic border/underline color equality, 4px rounding, zero outside outline offset, and zoom scaling. Reviewed the 200% screenshot; rebuilt host assets and validated manifests.

Rounded underline clipping and glyph-centered strikes passed TypeScript, seven geometry unit tests (including padded highlight bounds), and ten cases per browser engine. Four rotated real-PDF cases confirm that glyph positioning replaces the old 50% midpoint. Inspected the rendered PDF mark sheet and rebuilt/validated viewer distributions.

Centered fills passed TypeScript and ten browser cases per engine, including rotated marks, proportional strokes, hover, and comment changes. Reviewed the rendered PDF, rebuilt host assets, and validated distribution manifests.

Tight-ink centering and taller fills passed TypeScript, eight geometry unit tests, and twenty browser cases. Inspected the rendered result; rebuilt and validated host viewer bundles.

Optical centering passed nine geometry unit tests and twenty browser cases. Inspected the actual user preview: the details replacement now shifts 1.24px at 124% zoom, matching the deletion center on that line; the heading highlight shifts upward relative to its prior position. Rebuilt and validated host bundles.

Unified text-mark geometry passed TypeScript, ten unit tests, and twenty Chromium/WebKit cases. Comment-removal coverage explicitly asserts identical height and transform before/after. Viewer bundles were rebuilt and distribution manifests validated.

Shared optical balance passed ten unit tests and ten Chromium cases. Geometry tests explicitly verify that the box adjustment leaves the strikethrough at the original text center at multiple zoom levels; comment-removal tests preserve box geometry. Rebuilt and validated viewer distributions.

Popup persistence and stroke refinement passed TypeScript and 90 unit tests. Chromium and WebKit coverage checks resting/active underline thickness, thinner outlines, persistent clicked popups, hover-only action/page-number swapping, edit/cancel focus restoration, and Escape dismissal. Existing long-reader hover behavior also passes both engines. The visual suite passed 48 unchanged cases; the remaining popup snapshot was inspected and updated for the intentional removal of hover-preview actions, and its targeted rerun passed. All viewer bundles were rebuilt and distribution manifests validated.

Corner, cursor, and popup-close refinements passed TypeScript, 51 layout unit tests, and 11 real-PDF tests each in Chromium and WebKit. Tests verify the new radius, pointer on marked text, text cursor on unmarked text, and absence of the popup close action. Viewer bundles rebuilt and distribution manifests validated.

Brighter gold/red palette passed all 11 Chromium PDF-mark cases. Visually inspected the rendered PDF mark sheet, including gold highlight/comment and red deletion/replacement. Rebuilt viewer distributions and validated all manifests.
