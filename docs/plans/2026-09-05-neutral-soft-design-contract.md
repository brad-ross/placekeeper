# Placekeeper: neutral, soft design and interaction contract

Status: implemented and verified, September 5, 2026. The complete interface and host-surface update is implemented. Automated behavior, visual, build, and packaging checks passed; see the [verification record](2026-09-05-neutral-soft-design-verification.md) for evidence and remaining platform-specific release checks.

## Direction and authority

The chosen direction is the soft, spacious Codex-inspired treatment in neutral gray. Warm gray and the Obsidian-inspired layout are rejected alternatives. The sketches establish surface relationships and tone; they are not authoritative descriptions of the product's commands or state transitions.

The design should make serious reading comfortable and preserve the reader's place through annotation, search, and reference excursions. Its personality comes from predictable behavior and carefully managed attention.

User-confirmed requirements:

- Neutral gray; soft controls and subtle depth; enough space to read comfortably.
- Icon-forward controls with accessible names and tooltips.
- In the workspace mode strip, show the active mode's icon and title; inactive modes show icons.
- Annotation creation starts from interacting with the PDF. There is no generic compose button.
- Page metadata uses bare numerals or ranges, without `p.` or `Page` prefixes. Accessible descriptions retain the full meaning.

Source baseline inspected: `WorkspaceModeStrip`, `ReviewChrome`, `ReviewShell`, `WorkspaceEdgeRail`, `ContextActionPalette`, `PageActionMenu`, `CommentComposer`, `LinkActionPopover`, `AnnotationMetadata`, `RowActionGroup`, and reference navigation state. Before implementation, reconcile this checkout with the target app revision; preserve intervening product behavior.

## 1. Where each action lives

| Scope | Location | Commands and information |
| --- | --- | --- |
| Document | Main toolbar | Filename/save or document actions, copy location link where supported, Undo/Redo, document Back/Forward, previous/next page, editable page position, zoom controls, host-specific context status |
| Workspace visibility | Hide control inside each open tray; reveal control at its edge when hidden | Show/hide the right workspace or bottom References surface; restore the existing remembered mode and state |
| Workspace mode | Tray header | Outline, Search, Annotations, References, filtered by actual availability and docking configuration |
| Selected text | Contextual PDF palette | Replace, Delete, Highlight, Copy |
| Insertion or page anchor | Existing PDF gestures/page menu | Insert or Page Note; source navigation only in hosts/documents that support it |
| Existing annotation | Its PDF mark, row, peek, or reader | Navigate, inspect, edit/remove if supported, copy item link |
| PDF link | Existing link-action popover | Open in References, Open in main document, Copy destination; Follow in this tab when invoked in References |
| Reference tab | Reference tab/header | Activate, close, send to main; return to its original destination when appropriate |
| Data persistence | Filename/document menu and existing save dialog | Save destination, export, replace-original, or recovery actions as supported by the current workflow |

No top-level compose button, redundant toolbar Search button, new command rail, document tab bar, or persistent app-wide status footer is introduced.

### Search

Search belongs to the workspace alongside Outline and Annotations. The toolbar search icon in the sketches was an unnecessary second entry point and is removed.

- Pointer: open the tray if closed, then select its Search icon.
- Keyboard/menu: existing Find command opens the appropriate tools surface, selects Search, and focuses the query. Use the existing Cmd/Ctrl+F binding and native menu routing.
- The empty query shows “Search this document.” Show Clear search only while the field contains text; reserve its target width while hidden, remove it from focus/accessibility order, and retain focus in the query after clearing. Preserve equal top/right/bottom clear-button insets.
- There is one query, one result list, and one retained Search state. No separate toolbar popover or second search controller.
- Keep the current rules that prevent Find from interrupting an active authoring session or modal layer.
- Switching modes preserves the query, results, scroll, and focus memory. Reopening the tray restores its previous mode; invoking Find explicitly selects Search.
- Selecting a result uses the current navigation/history behavior. Searching alone does not move the main PDF.
- If References is docked below while the tools pane is on the right, Find opens the right tools pane and preserves the reference tabs.

The pointer tradeoff is deliberate: with the tray closed, Search takes an extra click. A future quick-access strip would be a separate usability experiment, not part of this restyle.

### Workspace header and reveal controls

Keep the current `WorkspaceModeStrip` contract. Inactive icons occupy stable slots; the active slot expands to include its title. The active segment gets a soft neutral fill and slight elevation. Remove no mode solely to achieve an illustrative composition.

- Do not repeat the active title immediately below it. Counts, filters, or substantive section headings may occupy the content header when needed.
- Use “Annotations,” not the sketch's renamed “Notes”: replacements, deletions, insertions, and highlights are also present.
- Preserve actual mode availability: for example, no Outline when the document lacks an outline.

- Show the dock-below action only in the active References workspace mode while not already docked below. Its accessible name states its destination; it changes docking, not mode selection. While docked below, keep dock-right beside the References hide control.
- Keep directional reveal/hide chevrons with reliable hit targets: hide inside the open tray header and reveal at the matching edge when hidden. Do not add a second sidebar toggle in the toolbar.
- Use “Show workspace” / “Hide workspace” and “Show References” / “Hide References” in tooltips and accessible names. Reserve “Close” for removing a reference tab or dismissing a transient surface. Hiding a tray preserves its tabs, query, annotations, mode, and focus memory.

### Outline expansion

- Preserve the Outline header’s compact icon-only **Collapse all outline entries / Restore previous outline expansion** toggle. This is reversible collapse: snapshot the expanded branch IDs, collapse all, and restore that exact snapshot on the next toggle. Do not replace Restore with Expand all. Preserve a pending restore snapshot even when individual branches are changed while collapsed; disable Collapse when nothing is expanded and no snapshot is pending.
- Show a separate disclosure chevron for every section with children, including nested subsections; leaf entries have an alignment spacer. The chevron toggles only that branch. Closing a parent retains its descendants’ expansion choices for reopening. The title and bare page number remain the navigation target; disclosure clicks never navigate the PDF.
- Retain expansion and pending restoration across mode switches and tray hide/reopen. Use native buttons, accurate accessible names and expanded/controls state, hidden descendants outside keyboard navigation, and restore focus to the invoked disclosure after an update.
- Preserve the existing outline destination actions and availability rules, including Open in References and destination-link copying where supported. The visual example demonstrates hierarchy and expansion; it does not replace the existing outline controller or its destination logic.

## 2. PDF interaction and annotation authoring

### Entry points

Keep the existing selection, insertion, and page-note gestures and shortcuts. Selecting text reveals the existing four-action icon palette in its current order. The palette is a single floating surface, not four individually framed buttons. Tooltips and accessible names describe Replace, Delete, Highlight, and Copy.

Clicking an existing annotation remains inspection/navigation according to the current mark interaction. It must not silently become “create a replacement,” as the illustrative sketch did. The existing annotation's edit action enters editing.

Preserve differences among actions:

- Delete is the current anchored deletion operation, not deletion of the source text in the viewer.
- Highlight retains its current optional-comment semantics, including keeping a highlight without a comment.
- Replacement and insertion retain their required-input and whitespace rules.
- Page Note retains an explicit page anchor; no floating unanchored note is created from the toolbar.

### Editor placement — passage-attached editor

Decision: a compact contextual editor attached to the passage. The user delegated this choice on design merit and explicitly said implementation difficulty should not determine it. This replaces the initial tray recommendation.

A short replacement or comment is a local act. The editor should keep the passage and proposed change in the same area of attention, without opening or taking over a distant pane. Use one softly elevated white surface with a small muted type/icon heading, open borderless text area, and compact explicit Cancel/Apply actions. Eliminate the nested gray input box, heavy border, resize handle, and permanent shortcut instruction. Keep long-text scrolling and bounded auto-growth; retain shortcuts in accessible help/tooltips. Existing tray state remains retained behind the authoring flow.

Placement contract:

- One editor, one draft, one anchor. The same editor owns creation and supported editing regardless of how it is presented.
- Prefer unused space beside the anchored passage, within the PDF stage. Start around 300–340 px wide, capped by available space. Never change the PDF zoom or reflow its width just to create a margin.
- If there is no side space, place the editor below the visible selection, or above when that gives more room. Keep the selected passage visible; do not cover the text being changed.
- Anchor to the actual visible selection/mark geometry. For cross-page or large selections, use the active visible endpoint and retain the complete semantic anchor; a concise source cue communicates the larger selection.
- Clamp the editor to the usable viewport with comfortable edge clearance. On screens where the adjacent editor cannot coexist with the passage and usable input controls, use a bottom sheet. Reveal the anchor only as much as needed, respecting explicit user scroll/zoom ownership.
- Auto-grow input to a bounded comfortable height, then scroll the editor body. Commit/cancel actions remain reachable. Account for the virtual keyboard and large text. Do not grow the editor across the entire document or shrink the text to fit.
- Scrolling or zooming must not dismiss or lose a draft. Reposition only to maintain the relationship while the anchor is visible, with stable placement and no oscillation between sides. Once the user scrolls the anchor out of view, keep the editor at its last usable clamped position and show a quiet original-page cue plus a visible “Back to passage” action. The editor remains tied to the original annotation, never to the new page underneath it. Preserve focus/caret while typing; do not auto-collapse or switch to another annotation. Applying or cancelling while away leaves the current reading location unchanged. Returning explicitly reveals the source and reattaches the editor without losing the draft. Do not chase the scrolling passage offscreen or snap the reader back automatically.
- Clicking outside does not silently save or discard. Apply/Cancel and the existing explicit dismissal lifecycle govern completion. Preserve the current guards against starting a second conflicting authoring session.
- Editing from an annotation row first reveals that annotation using the existing navigation contract, then attaches the editor to its mark. A page note uses its page anchor. If an anchor is unavailable, retain the draft and use the existing unavailable/reattachment flow rather than guessing a position.
- Switching between adjacent and bottom presentations retains the same draft, focus, caret/selection, and semantic anchor. Background workspace modes and reference tabs retain their state.
- Nested save setup remains a separate modal decision above the composer; returning restores the same draft and cursor. Document-generation or source changes retain the existing stale-anchor safeguards.
- Use a concise header, small anchor-return icon, borderless text area, and explicit commit/cancel labels. The popover's gentle shadow expresses its temporary elevation. Avoid a large decorative title or duplicated metadata.

This is a material interaction change alongside the overlay layout, toolbar availability, and page/zoom control changes; implement and test its geometry, focus, and draft lifecycle explicitly. It is not achievable by changing only CSS tokens.

Authoring behavior:

- Use a concise header such as “Replacement” and the existing anchor-return action.
- Focus the editor on entry. Preserve the user's text while a nested save-destination dialog is open.
- Keep visible action labels for commit/cancel/keep controls. Icon-forward does not require icon-only forms or ambiguous confirmation buttons.
- Preserve the current primary labels and Cmd/Ctrl+Enter submission semantics. Enter inserts a newline where it does today.
- Required input prevents an empty commit; optional highlight comments retain their special behavior.
- Preserve cancellation, dismissal, IME, and focus-restoration behavior. Do not silently convert clicking outside into saving or discarding.
- Restore the previous tray mode and its retained state after the current authoring flow completes.
- A source excerpt may be shown only if it helps disambiguate the anchor. It must be bounded and come from the actual anchor, not duplicate a long selected passage in every editor.

## 3. Annotation list, peek, and reader

Preserve navigation and editing capabilities while reducing visual noise.

- Unselected rows sit quietly in the tray. The selected row gets a rounded, slightly raised neutral surface. Avoid a card border around every item.
- Content is primary; annotation type, location, and origin are secondary. Use sentence case and ordinary weight for metadata; eliminate spaced uppercase labels.
- Use compact type cues rather than a type-label row on every annotation. Replacement is struck-through source plus proposed text; deletion is struck-through source alone. Every annotation type, including replacement and deletion, keeps its own small recognizable icon in the shared header line. Avoid redundant visible type labels. Preserve full type names in accessible row names, tooltips where helpful, and detail views. Bare page numerals/ranges share the compact metadata/action line, without badges by default.
- Preserve the existing row navigation target. Page metadata need not become a separate button: the sketches' page-only navigation would make a smaller target and alter the current interaction unnecessarily.
- Full accessible row names retain kind, “Page 4” or “Pages 4–5,” section, and excerpt. Visual shorthand must not erase semantics.
- Put direct row actions on the same compact line as the type cue and page metadata, removing the separate action footer. Preserve overflow when width requires it; do not shrink hit targets to force everything onto one line. All actions remain available on keyboard focus and touch, not only hover. Keep navigation and action buttons as sibling controls, never nested buttons.
- Show selected, hovered, keyboard-focused, and corresponding states differently. A soft raised row is selection; a visible focus outline is keyboard focus. Correspondence with a PDF mark needs a second cue, such as a small marker or restrained edge accent.
- “From this PDF” remains a meaningful provenance/read-only distinction where the current model requires it. Do not make imported annotations appear editable by restyling them identically without their state cues.
- Preserve the full-annotation reader, copy-link actions, and supported editing/removal capabilities. When an annotation’s actual text overflows the list excerpt, clicking or keyboard-activating that annotation’s content opens the full reader directly. Do not add a separate More, expand, ellipsis, or read-full action for this purpose. Detect actual rendered overflow after width/font changes; short rows retain their ordinary navigation behavior. Action buttons remain siblings and do not accidentally open the reader. No arbitrary shortening of stored text for screenshot aesthetics.
- The full reader replaces the list body inside Annotations, keeping the workspace mode header fixed. Its own compact, borderless header contains Back, a muted type icon and bare page/range grouped together, and Edit only when the record is editable; avoid a repeated annotation title. Show a `locate-fixed` action with tooltip “Back to annotation in PDF” only while the original source is outside the usable main-PDF viewport, accounting for same-page scrolling, zoom, and covering trays. Use actual annotation geometry and the existing availability controller in production. Reveal the original source without closing the reader, changing zoom, or resetting its text scroll; remove the action once the source is visible and restore focus to Back. Keep this source-reveal action distinct from Back to the list/peek; paragraphs scroll below that fixed header. For imported annotations, show only “Read only” beside the type/page cue on this same header line; the PDF source is already clear, so omit “From this PDF” and a separate provenance row in the full reader. Show the complete text with the same system typography and neutral tray material. Returning restores the selected row, list scroll, and keyboard focus. Opening/closing the reader does not change the main reading location or zoom. Apply the same direct-content activation to a truncated peek, with Back returning to that peek. A nested editor preserves the reader context and text on Cancel; Apply returns to the updated reader. Preserve existing stale-record and modal/keyboard lifecycle guards.
- Clicking a PDF annotation while the workspace is open selects Annotations and the corresponding item, revealing it as needed, without opening a redundant peek. With the workspace closed, show a passage-attached peek using exactly the same annotation row content, type/page/action header, spacing, and provenance as the list, adding a close button to that header. Opening the workspace transfers inspection to its corresponding row and dismisses the peek. Preserve long-text expansion and supported actions in both contexts.

## 4. References and navigation

Retain the current distinction between the main reading location, a reference tab's original target, and its current scrolled location.

| Action | Meaning |
| --- | --- |
| Open in References | Open/focus a reference destination while keeping the main reading location |
| Follow in this tab | Navigate within the active reference tab using its existing lifecycle |
| Open in main document (link popup) | Navigate the main viewer using its existing history and workspace behavior |
| Open in main document (reference-tab action; internally send/promote) | Promote the active reference location using current tab-consumption, history, and focus semantics |
| Return to reference | Reveal that tab’s original destination; available only while the original target is out of view, using the existing app’s visibility/availability controller |
| Back/Forward in toolbar | Traverse main-document history, not reference tabs and not adjacent pages |
| Close tray | Hide supporting content while retaining its state |
| Close reference tab | Close that tab using existing successor/last-tab rules |

Use “Open in main document” consistently as the visible tooltip and concise accessible action name for reference-tab promotion and link-popup main navigation; keep the different behaviors above in their controllers. The reference-tab promotion action and the main-navigation action inside a reference-link popup use the export-style `square-arrow-out-up-right`. In a main-PDF link popup, Open in main document uses `chevron-right`, matching the forward/follow chevron inside a reference-link popup: both follow a link in the viewport where it was clicked. This context-specific glyph distinction is deliberate. None of these operations exports a file or opens an external browser window.

The sketches' generic “Back to reading · 4” button is removed from the implementation proposal. Closing the tray already reveals the main reading view; the main document's Back command serves a different purpose after a real navigation.

Reference tabs use a small title, bare destination numeral, rounded active fill, and subtle separation. Do not frame every tab as a card. Preserve active-tab promotion and close actions, and show Return to reference only while that active tab’s original target is out of view. Use the same `locate-fixed` anchor glyph as return-to-passage. Hide it entirely when the original target is visible, including its empty slot; appearing/disappearing must not disturb the tab’s current viewport. Preserve the existing pending/availability guard and restore focus to the active tab when a successful return removes the button. Determine visibility from the original destination geometry in its actual reference viewport, not merely a different page number; scrolling away on the same page also makes it available. Retain the tab strip while only the reference body scrolls. Expose full titles/destinations through accessible labels and tooltips. Long names truncate without displacing actions. When docked right, use a horizontal tab strip above the reference PDF, with horizontal overflow and keyboard access when needed. Keep the active tab and its actions reachable without wrapping into a vertical list. When References is docked below, preserve a vertical tab list on the left of its PDF viewport; do not replace it with a horizontal header merely for screenshot symmetry. Keep title, destination numeral, and active-tab actions on the same line, with no action footer. Target approximately 240 px for the tab rail at illustrated desktop widths, subject to the existing measured layout rules. At genuinely narrow widths, preserve readable vertical items above the viewport rather than compressing tab labels/actions into unusable columns.

Keep the existing icon-forward link-action popover and action order. This supersedes the earlier suggestion to label every action visibly. The popover's softer material, consistent icon weight, hover states, and reliable tooltips provide the refinement.

Preserve the existing split layout: References can live below while Outline/Search/Annotations occupy the right, or share the right/unified workspace where appropriate. Switching modes, docking, resizing, and reopening must retain per-surface state. Both trays overlay one main PDF viewport that fills the window below the toolbar. Bottom References spans the full width as an inset overlay; the right workspace ends 12 px above it when both are open. Only the workspace surface shortens, not the main PDF viewport. Hiding References restores the workspace height while leaving PDF geometry and scale unchanged. The main PDF scrollbars stay at the outer window edges. Each tray has independent scrolling and retained state. This user decision supersedes the earlier reserved-pane proposal. Closing or promoting the last reference closes the References tray, removes its bottom toggle and References mode, and leaves no empty References surface; opening a new reference restores the applicable controls. Hiding a nonempty tray instead retains its tabs.

## 5. Toolbar, saving, and host differences

The toolbar remains a compact document command surface. Restore controls omitted by the sketches: Undo/Redo, separate history and page navigation, editable zoom/page controls, fit width, location links, and applicable context status.

- **Updated user decision:** show Undo, Redo, Back, and Forward individually only when that action is available. Omit unavailable actions rather than rendering disabled icons or empty reserved slots; remove an empty group and its spacing. Availability comes from the corresponding annotation/history controller, not saved/dirty status. This supersedes any earlier requirement to keep these four controls permanently visible.
- Group Back/Forward with previous/next page and the editable page number as one document-navigation group. Keep their distinct accessible names and semantics; a small internal gap may separate history from page stepping without creating a separate toolbar group. Use the same 13 px font, weight, tabular numerals, 20 px line height, and vertically centered 32 px control height for current page, / total, and zoom. Keep page and zoom controls aligned as history actions appear/disappear; let a separate flexible spacer outside the filename button absorb the width change. Keep one compact page-position group containing the editable current page and a noneditable / total, without a down-chevron glyph. Clicking the current-page input edits it; clicking anywhere else in the page-position group opens a compact Previous/Next popover matching the zoom popover. Keep Back/Forward directly in the toolbar. Repeated page steps keep the popover open, with focus retained on the invoked action or moved to the remaining action at a boundary. Page and zoom popovers are mutually exclusive; Escape closes and returns focus to the corresponding disclosure, and clicking elsewhere dismisses without swallowing that click. Omit Previous at the first page and Next at the last page; preserve the distinct history actions. Preserve keyboard/menu routing and sensible focus restoration when the invoked action removes itself. Other disabled controls are not automatically hidden by this rule.

- Present Zoom as one compact percentage/disclosure surface at all widths. Only the numeric zoom value is editable in the toolbar; % is a fixed, noneditable suffix outside the input with matching typography and baseline. Keep the disclosure close to that suffix, with about 4 px of visible glyph clearance and no trailing input whitespace; preserve a usable touch target. The adjacent disclosure opens only Zoom out, Zoom in, and Fit width. Do not duplicate the percentage in the popover. Page and zoom inputs remain transparent without persistent fills, focus frames, or input outlines; the containing page/zoom group still gets the ordinary button hover fill; the caret indicates editing. Preserve ordinary text-selection rendering. Preserve zoom behavior and shortcuts, expanded state, keyboard access, repeated adjustments, outside/Escape dismissal, and focus restoration. Opening the popover must not resize, pan, or zoom the PDF.
- Keep measured responsive grouping/overflow rather than hiding commands at arbitrary mockup widths.
- Use small gaps between semantic groups instead of many vertical dividers. Controls remain in predictable order.
- Keep the filename as the existing save/document-actions entry point. Its hover/click surface hugs its icon and actual title, up to an approximately 280 px maximum with ellipsis; the flexible toolbar spacer is outside the button. Preserve the full filename through accessible text and a tooltip when truncated. Saved state is quiet, but pending destination, write failure, protected recovery, and export-required states must be visible when actionable.
- No permanently visible duplicate “Saved” footer or repeated section breadcrumb is introduced.
- Preserve the current first-annotation save setup timing. It can be visually simplified, but changing durability policy or automatic destination choice is outside this design pass.
- Native local-PDF saving, generated-output export, and web export-only flows retain their differences. Never label an in-memory or export-only change “Saved” because a mockup did.
- Search starts empty with “Search this document” as its placeholder. Use a compact approximately 36 px field at desktop pointer sizes, without an inner input focus frame. Give the 28 px clear-button target equal 4 px top, bottom, and right insets; retain a 44 px touch target within a correspondingly taller field. Clearing returns focus to the search input. Save-copy naming uses a soft borderless neutral field, without a focus outline or heavy inset box. The caret and editable text remain clear.
- Save dialogs keep explicit options, filename/location controls, and concrete action labels. In copy mode, replace the redundant visible “Copy name” label with the current folder path, such as “Documents / Reading”, directly above the filename. That path is the keyboard-accessible Change location action; remove the duplicate path row and separate Change location button. Keep an accessible name on the filename input independent of the clickable path; long paths may wrap, and location-picker cancellation preserves the filename and draft. Replace-original confirmations and recovery decisions retain their existing requirements.
- Show integration/context controls only in hosts where they apply. Do not add a decorative agent status to ordinary reading windows.
- Mac window controls are provided by the native host, not painted into the shared web client. Browser/VS Code/Codex surfaces should not get fake traffic lights or duplicate titlebars.

### Accepted overlay layout and zoom behavior

The main PDF viewport fills the window below the toolbar. The workspace and bottom References are opaque inset overlays above that viewport; zoomed document content continues behind them. Opening, closing, or docking trays does not shrink the PDF viewport, move its scrollbars into the middle of the window, reset scale, or recenter the paper. Preserve the reading anchor. The workspace ends above the full-width bottom References overlay with the same 12 px spacing as the outer tray margins. At narrow widths the supporting surfaces become vertically arranged overlay sheets with reachable headers and independently scrolling bodies.

Overlay occlusion is distinct from document bounds. Allow sufficient scroll reach to bring text out from under a tray, including the last/rightmost content. Explicit navigation, search results, focused items, and return-to-passage should reveal their target in the unobscured reading area without changing zoom. Merely toggling a tray does not trigger automatic fitting or navigation. PDF scrolling and zoom gestures belong to the main viewport; wheel/trackpad activity over tray content scrolls that tray, with no accidental chaining into the document.

The design specifies Fit width as an explicit command using the unobscured reading width, not a persistent mode that re-fits after each tray change. Initial placement may fit the clear reading area; zooming from there can extend the paper underneath the overlays. Validate exact anchoring and scroll reach with a real PDF during implementation; the reference scales illustrative paper content.

The main toolbar zoom controls target the main document. Reference viewports retain their own zoom/scroll state per tab; gestures within them affect only that viewport. A newly opened reference can initially fit its own available width. Moving its tray or switching tabs does not reset an existing scale or scroll position. Explicit pinch/wheel zoom anchors at the gesture point; toolbar zoom preserves the current reading anchor. Annotation Undo/Redo does not own zoom changes.

## 6. Visual system

Initial implementation targets the chosen neutral light appearance. The sketches also explore dark appearance; shipping dark mode requires an explicit scope decision and full state/host validation. Do not accidentally add host theme inheritance to the current light-only client.

Starting values to calibrate in real screenshots:

| Role | Proposed treatment |
| --- | --- |
| Canvas/chrome | Neutral near-white, approximately `#f7f7f7` |
| Supporting tray | Slightly deeper neutral, approximately `#f0f0f0` |
| Raised selection/popover | White or nearly white; shallow shadow |
| Main text | Approximately `#333333` |
| Secondary text | Approximately `#707070`, validated against its actual surface |
| Subtle boundaries | Approximately `#e5e5e5`; not a substitute for necessary focus contrast |
| Control/selected-tab radius | 9–10 px |
| Selected annotation radius | 11–12 px |
| Floating editor/dialog radius | 14–16 px, proportionate to surface size |
| Persistent trays | Inset supporting surfaces with 16 px corners and approximately 12 px outer clearance; no hard vertical rule or full-width bottom seam |
| Toolbar | Soft, borderless band around 50 px at desktop pointer sizes, with balanced vertical padding; wrap naturally at narrow widths |
| Fine-pointer controls | Approximately 32–34 px hit area, 15–16 px icons |
| Touch controls | At least approximately 44 px effective targets without overlap |
| UI typography | System font, primarily regular/medium weights; body 13–14 px, secondary 11–12 px |
| Motion | Approximately 120–160 ms for state/surface changes; respect reduced motion |

The annotation editor uses equal 12 px padding on all four sides, matching the supporting boxes’ spacing token, with 12 px header-to-field and field-to-action gaps. Avoid compounded textarea padding inside the already padded white surface. Keep annotation peeks on their shared annotation-row spacing and preserve the editor’s positioning and draft behavior.

Use one semantic token system across chrome, menus, tabs, rows, composer, search, outline, reference panes, dialogs, recovery and errors. Shadows express actual elevation, not decoration on every surface.

The refined reference restores the original neutral sketch's inset tray structure. The right workspace and bottom References use the same quiet gray material and rounded container geometry. Bottom References has a vertical tab rail beside its preview, without an extra raised heading. This supersedes the interim single horizontal header proposal.

Use one consistent show/hide control treatment: small unfilled directional chevrons, the same stroke weight, radius, hover surface, and target size, with direction reflecting the relevant edge. Place the workspace hide chevron first in its fixed navigation bar, to the left of the mode buttons; do not retain a duplicate outside hide button. Keep bottom References controls inside the top-left of its tab column while open. Retain a 12 px natural gap between the upper workspace and bottom References tray, preserving non-overlapping targets. The bottom control remains available when a nonempty tray is hidden and disappears when its last reference closes. Hiding References preserves its docking, active tab, and sibling tabs and does not close the tools workspace. Show the move-to-bottom control only while the workspace’s References mode is active and References is not already docked below; omit it from Outline, Search, and Annotations; while below and open, place the move-to-right action beside the show/hide control at the top of the reference tab column. These controls occupy space inside the tray, not a separate full-width row between panes. When hidden, its reveal button’s lower edge sits exactly 12 px above the window bottom, matching the trays’ outside margins; the right workspace extends to its normal 12 px bottom inset. Retain accessible names, expanded state, and actual surface state ownership.

Hover/focus-within should illuminate the whole annotation row or reference-tab container, including metadata and its action region. Remove the nested background highlight on annotation content and on the reference title alone; include the page number in the tab-selection target. Distinct action buttons may still show a restrained local hover cue because they invoke a different operation. Hover, selected state, correspondence, and keyboard focus remain distinguishable; a whole-item background does not turn action clicks into row navigation.

Secondary annotation actions remain visible on the selected row, on row hover, and while keyboard focus is anywhere in the row. Touch layouts expose them directly. Unselected rows do not need a permanently visible action strip on fine-pointer devices. Keep all existing actions accessible; reduce incidental framing and repeated count labels before shrinking typography or removing capabilities.

PDF rendering is unchanged. Do not round the PDF into a card, tint its pixels, alter document typography, or modify annotation meaning to match the illustrative paper. Preserve semantic mark colors and correspondence; UI selections can be neutral without making every document mark gray.

### Icon and typography audit

Use one Lucide outline family throughout the shared client: rounded caps and joins, no filled variants or added circular containers, and one 2-unit stroke on the standard 24-unit viewBox. At a 16 px rendered size this is approximately 1.33 px; do not confuse the viewBox stroke with a fixed 2 CSS-pixel outline. This replaces the mockup’s 1.6-unit stroke, which became very fine on small metadata and disclosure icons. Use 16 px primary glyphs, 14 px secondary/type/disclosure glyphs, and the established 12 px zoom caret; preserve the approved button hit targets. Selected and hovered states change the surrounding surface, not icon family, weight, or dimensions. Check optical centering and recognizability at actual size. Native host-owned chrome may retain its platform icons.

| Meaning | Lucide glyph | Audit decision |
| --- | --- | --- |
| Outline | `list-tree` | Shows document hierarchy instead of a generic flat list |
| Search / Annotations / References | `search` / `message-square` / `panels-top-left` | Retain familiar search, review/comment, and supporting-pane metaphors; names remain available on focus/hover |
| Show/hide tray; disclose branch | Directional `chevron-*` | Retain direction tied to the surface edge or branch state |
| Collapse / restore outline | `fold-vertical` / `unfold-vertical` | Separate collapse from the × used to close; Restore still restores the saved expansion snapshot |
| Zoom out / in / Fit width | `minus` / `plus` / `move-horizontal` | Replace the old insertion/layout glyph for Fit width with a horizontal extent cue; keep the “Fit width” tooltip |
| Back / forward; previous / next page | Left/right and up/down chevrons | Retain grouping and distinct names; these are reading navigation, not annotation history |
| Annotation Undo / Redo | `undo-2` / `redo-2` | Retain curved arrows as a distinct history family |
| Dock below / dock right | `panel-bottom` / `panel-right` | Show destination geometry; do not reuse these for hiding a tray |
| Open in main document | `square-arrow-out-up-right` for reference promotion and reference-popup main navigation; `chevron-right` for main-PDF link navigation | Use the user-selected export-style transfer symbol for references; keep the current-viewport follow chevron in the main PDF. Tooltip is always “Open in main document”; retain distinct controllers |
| Return to reference / source passage | `locate-fixed` | Both reveal an anchor; tooltips identify which. Reference return appears only while its original target is out of view |
| Replace / deletion annotation / highlight / insertion | `arrow-right-left` / `minus` / `highlighter` / `text-cursor` | Use the simplest distinct operation cue: exchange, deletion stroke, highlight, or insertion caret. Avoid tiny dashed boxes; source text carries strikethrough while trash removes the annotation itself |
| Edit / remove annotation / copy / copy link | `pencil` / `trash-2` / `copy` / `link` | Retain familiar direct-action glyphs |
| Close / more / document actions | `x` / `ellipsis` / `file-text` | Reserve × for closing/dismissing and ellipsis for additional actions; filename remains the save/document entry point |

Annotation type icons are plain glyphs with no badge, enclosing box, extra dot, or provenance overlay. Use the same shape in the type row, peek, selection action, and editor heading: 14 px in metadata and 16 px in action/header contexts, with the shared stroke weight and neutral color. Replacement uses two simple opposing arrows instead of the detailed dashed-box replacement glyph. Deletion uses one clean horizontal minus stroke, reinforced by struck-through source text; Highlight keeps the recognizable highlighter; a comment does not require another tiny symbol attached to the highlighter. Insertion uses the plain text caret; page notes should use a simple `sticky-note` when that production-only type is shown. Accessible names and existing source/alternative text carry the exact meaning; do not try to encode every distinction in a miniature composite icon.

The source map may retain unused helper aliases; those do not authorize adding new controls. Every rendered icon must resolve in the supplied Lucide runtime, remain decorative to assistive technology, and belong to a named button or labeled type/context. Validate all actual product icons against this mapping during implementation; the mockup does not exercise every production-only command.

Keep the native system sans-serif as the UI face. Its familiar proportions and restrained appearance suit the reading-first neutral design. Use a shared `--pk-font-ui` stack of `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`; do not download a display face or mix system and custom faces across trays. Use regular 400 for ordinary controls/body and medium 500 for compact headings or deliberate emphasis. Keep 13 px controls and body, 14 px editing text, 12 px secondary/tooltips, and 11 px only for short metadata; retain 16 px editable text on coarse pointers. Do not use lighter weights, compressed tracking, or all-caps labels to make the UI feel quiet. Preserve the established page/zoom alignment and tabular numerals; prose keeps proportional figures and approximately 1.5–1.65 line height.

Annotation excerpts are UI text and use the same system face as annotation comments. Distinguish source text through spacing, muted color, or strikethrough according to meaning. Georgia remains only a stand-in for the sample PDF’s own typography, including the reference preview; production PDFs retain their embedded fonts and rendering. Ensure popovers/editors above a PDF cannot accidentally inherit the document’s serif face. Validate fallback-font metrics, long filenames, enlarged system text, and translated labels in actual supported hosts; the mockup’s macOS review does not establish identical rendering on Windows or Linux.

The glyph meanings were checked against Lucide’s catalog: [Fit width’s previous insertion/layout glyph](https://lucide.dev/icons/between-horizontal-start), [horizontal extent](https://lucide.dev/icons/move-horizontal), [outline hierarchy](https://lucide.dev/icons/list-tree), and [vertical fold](https://lucide.dev/icons/fold-vertical). The choices above are design judgments for Placekeeper, not requirements imposed by the icon library.

### Accepted PDF margins and soft fades

Back every open tray with a solid neutral canvas layer independent of its rounded surface. This backing covers the workspace’s rounded upper-left corner, a 12 px strip to its left, the full gap to bottom References, and all outside tray gutters. Extend the right backing from the toolbar to the usable viewport bottom, and the bottom backing across the usable viewport width beginning 12 px above References. At narrow widths, begin the bottom backing 12 px above the uppermost open sheet. Paint the same approximately 18 px soft fade inward from the resulting exposed PDF boundary; the fade meets fully opaque material before the gutter begins. The visible reading area has one continuous boundary around the workspace and References, with no PDF islands, transparent corner cutouts, or seams between independently rounded trays. Recompute from actual tray bounds on resize, docking, and visibility changes. Keep backing and fades beneath trays/editors, above document pixels, clear of main scrollbar tracks, and pointer-transparent. These are paint layers: they do not resize the PDF viewport or reset zoom, scroll, or the reading anchor. Verify with enlarged PDF content beneath each corner and gutter, both trays together, either tray hidden, and narrow stacked sheets.

As the PDF scrolls upward beneath the top bar, show the same approximately 18 px pointer-transparent fade immediately below the toolbar, neutral at its top and transparent below; remove it when the document is back at its top. Keep this fade beneath tray headers and authoring surfaces. Use the selected soft fade treatment at the outer lower/right PDF edges and where overflowing document content passes under the inset tray boundaries. A short approximately 18 px gradient blends overflowing document content into the solid neutral margins, so the page appears to continue underneath them. Keep the fades fixed to the viewport, pointer-transparent, below editors and controls, and clear of usable scrollbars. At the outer document edges, show a fade only while content continues beyond that edge and remove it at the true extent. Tray-boundary fades express overlay occlusion and do not imply a smaller PDF viewport. Reveal search hits, focused content, and editing anchors into the unobscured area above/left of the fade.

When a tray is hidden, its reveal chevron sits in a solid neutral edge margin, rather than a small isolated patch over text. Bottom References uses a full-width bottom band reaching to the top of its reveal button (40 px deep for a 28 px button with 12 px bottom inset), with an approximately 18 px fade above that band. The hidden workspace uses the analogous right band reaching to the left edge of its reveal button, with a fade to the left. Enlarge the bands to 56 px for 44 px touch targets. Keep the buttons’ outside insets at 12 px and keep usable outer scrollbars clear. These are painted overlay margins: they do not reduce the PDF viewport or change its scale/anchor. Pointer-transparent fades and margins must not swallow document scrolling. When open, each tray owns its hide chevron inside its header; the workspace hide control appears before the mode-button array and remains fixed during content scrolling. Restore focus to the matching show/hide control after toggling.

Workspace header buttons share consistent 32 px icon-target widths, 34 px heights, 2 px gaps, and 8 px horizontal padding around active icon-plus-title groups. Hide, modes, and mode-specific actions use the same vertical alignment and spacing; do not compress selected controls to 28 px to make the row fit. Allow approximately 304 px workspace width at the illustrated desktop sizes, and preserve full targets with measured responsive wrapping when needed.

The workspace shell and mode/navigation header never scroll. Place the modebar in a fixed header region and only the active pane in a bounded inner scroll area. The desktop workspace begins directly at the toolbar’s lower edge, with no outside top gap. Keep 12 px internal clearance above its navigation buttons. Use one 12 px spacing token for outer left/right/bottom tray margins, internal content-side margins, and space below the navigation buttons before the content scroller. Apply that same token to equivalent References tray outer and inner margins and the gap from its controls to its tabs. Measure outer left/right/bottom insets against the full unscrolled window content rectangle, including scrollbar tracks: the total gap is 12 px, not 12 px plus scrollbar width. The main scrollbars occupy part of the outside right/bottom margin. Inside the workspace, content-to-tray-edge spacing is 12 px on both sides including the scrollbar: subtract the measured scrollbar width from the blank right gutter, instead of adding a full padding gutter beside it. Use transparent tracks over the existing neutral surface. Recalculate for scrollbar appearance, mode changes, viewport changes, and overlay versus classic scrollbar settings. Never extend the content scroller beyond the tray when a scrollbar is wider than 12 px: cap the negative right-margin compensation at 12 px and enlarge the left content inset to match the full right inset. During product implementation, if a main scrollbar exceeds the outside margin budget, enlarge the common outside left/right/bottom inset together to clear it; retain the normal 12 px baseline otherwise. Keep thumb targets usable and do not hide scrollbars to fake symmetry. Remove extra first-child top margins so they do not silently enlarge the header-to-content gap; do not switch compact widths to a separate 10 px spacing rule. Clip overflowing rows inside that area; retain the bottom inset even at the end of the list. Keep header actions, including outline collapse/restore, reachable throughout scrolling. Retain per-mode scroll positions and focus state.

Outline disclosure targets use approximately 28 px columns with 14 px chevrons and about 4 px additional breathing room before the entry text. Use balanced row insets so the disclosure glyph and right-aligned page numeral feel equally inset from their respective edges; do not compress the disclosure into a 20 px column. Leaf spacers use the same column width. Preserve usable larger touch targets without overlapping navigation targets.
When bottom References is open, its hide and dock-right actions remain inside the top of the reference tab column. Use the same 12 px token for inter-tray separation and outside tray margins, including the lower tray's sides/bottom and workspace's outer right clearance. The toolbar keeps its own command height; the 12 px rule applies to supporting-surface spacing, not every distance in the app. Closing the final reference still removes its bottom reveal control rather than retaining an empty References state.

## 7. State and accessibility contract

- Center each button’s complete content group visually in its hit target. Use context-specific target dimensions: workspace icons are 32 × 34 px, outline disclosures are 28 px wide, and the desktop zoom disclosure is 20 px wide within its group; retain approximately 44 px touch targets. Use block-level SVGs without baseline offsets and balanced insets; check the glyph’s optical bounds as well as its SVG box. Text-plus-icon groups must also be centered as a unit, except content-aligned filename and reference-title navigation surfaces. Preserve visible keyboard focus on buttons.
- Every icon action has a concise accessible name and a tooltip available on hover/focus; shortcuts appear where actually supported. Tooltips use a compact charcoal-gray surface with high-contrast white 12 px text, approximately 7 px corners, no heavy border, and a restrained shallow shadow. Avoid the large dark pill treatment, exaggerated pointer, and decorative shortcut badges. Use a modest hover delay (about 600 ms), immediate keyboard-focus availability, viewport clamping, and dismissal on interaction/Escape. Tooltips supplement accessible names rather than replacing them.
- Tab roles, selected state, roving focus, arrow-key behavior, and panel association remain correct. Only the active workspace title is visually shown.
- Buttons and navigation targets retain a clear keyboard-focus ring independent of neutral selection styling. The explicitly approved borderless page/zoom, search, save-copy, and editor inputs use their caret and ordinary text selection without an added input focus frame; preserve their accessible labels and predictable keyboard order. No information depends on hue alone.
- Preserve current Escape ordering: dismiss the nearest active transient/editor/dialog according to its lifecycle before closing workspace surfaces. Do not clear the search query or close every layer in one keypress.
- Preserve IME and editable-field shortcut guards, including the Find guard during authoring.
- Disabled controls remain identifiable. Busy states prevent duplicate actions and avoid distracting looping animation.
- Empty states contain one short useful instruction, not large illustrations or promotional copy. Missing outline differs from loading or failed outline.
- Errors appear near the failed operation with its existing recovery action. Persistence failures get enough prominence to prevent false confidence.
- Full document and reference names are available in the existing tooltip on hover and keyboard focus, including when visually truncated. Include the short action separately where needed (for example, filename followed by “Save options”); retain the full accessible name. Wrap long tooltip text and clamp it within the viewport.
- Long paths, titles, translated system labels, multi-page anchors, long annotations, narrow widths, text scaling, and keyboard occlusion remain usable.

### App icon

Include the app icon in this visual refresh. Preserve the established two-page reference-and-return metaphor: a main reading sheet, a tucked reference sheet, one smooth detour that returns to the reading position, and a small destination dot. The user selected a muted blue path and small amber dot; the neutral interface does not require a grayscale app identity. Replace the current warm field and ivory paper with neutral grays and near-white paper, softer corners, and restrained page detail.

The user selected **B — Soft pages** from the [app-icon proposals](assets/neutral-soft-design/app-icons/index.html). Preserve its borderless layered sheets and subtle depth as the design direction. The [refined B comparison](assets/neutral-soft-design/app-icons/refinement-review.html) keeps the pages closely tucked with a modestly wider fan than the original B, places the amber dot near the middle of the exposed reference-page area, and recenters the complete stack. Avoid separating the sheets into a broadly spread pair. Raise the reference sheet slightly while keeping its upper corner concealed behind the front sheet, and extend its lower edge diagonally until it disappears behind the front sheet before the bottom-right corner begins to round. Preserve the selected fan, path, dot, and stack centering. This centered stack replaces the prior rebrand’s slight leftward placement. The alternatives remain documented for comparison:

- **A — Familiar:** retain outlined fanned pages and the existing path geometry; primarily update palette and corner softness.
- **B — Soft pages (selected):** use borderless layered sheets, a very shallow page shadow, and fewer text marks. This most closely reflects the new supporting trays while preserving the recognizable path.
- **C — Simple mark:** reduce page detail further and strengthen the path for a clearer small silhouette. Review whether the heavier path feels too prominent beside the quiet interface.

B is the approved design direction; these proposal files are not yet production masters. The comparison uses the same icon field, palette, and display sizes to isolate the treatment differences. Its rounded display crop is illustrative; confirm actual platform presentation in the built app. Refine B for production while preserving its selected geometry and restrained depth; review the final artwork at actual icon sizes before replacing assets. This section supersedes the prior rebrand's warm-palette requirement for the forthcoming refresh; its reference-and-return meaning remains authoritative.

During implementation, update `packaging/macos/icon/Placekeeper.svg`, regenerate every required PNG in `Placekeeper.iconset`, and build the `.icns` through the existing packaging pipeline. Check 16, 32, 48, 128, 256, 512, and 1024 px presentations, including Retina variants required by the current iconset, on light and dark desktop backgrounds. Inspect actual Finder and Dock rendering. At small sizes, optically adjust or remove subordinate text marks as needed while retaining two distinguishable pages, a continuous return path, and the destination dot. Do not assume a scaled master is sufficient. Run the existing iconset validation and packaging checks, including reverse expansion of the built `.icns`. Keep app identity, bundle identifiers, and installation behavior unchanged.

## 8. Implementation sequence and review gates

1. Confirm the implementation target revision and the passage-attached editor contract. Record any additional behavior change explicitly rather than deriving it from a sketch.
2. Establish neutral semantic tokens and shared control/surface treatments. Apply to existing components; do not rebuild the viewer or its state machines.
3. Restyle the actual reading toolbar and workspace header first. Review a real dense paper with the workspace closed and open before spreading the system.
4. Restyle annotations, search, outline, reference tabs/popovers, authoring, save/export dialogs, and exceptional states with the same vocabulary.
5. Review the full split-reference layout and narrow/unified layout, including every supported host. Inspect actual app screens, not only isolated component scenes.
   Finish the selected B app icon alongside this review; inspect the regenerated iconset and packaged Finder/Dock result before final visual sign-off.
6. Run relevant existing component, interaction, Chromium/WebKit, host, and visual tests. Add focused tests only where a real changed behavior or accessibility risk requires them. Baseline changes require visual review and must not conceal regressions.

Required acceptance walkthrough:

- Read, scroll and zoom; step pages and navigate history; edit page/zoom values. Enter and focus loss use the same strict whole-number validation: blank, malformed, fractional, or unsafe values restore the previous valid value; valid whole numbers clamp to actual page/zoom bounds. Invalid or unchanged page values add no history entry. Escape restores the current value without dismissing another layer; IME composition is not committed. Keep the next clicked control actionable.
- Inspect empty/nonempty Search and keyboard clearing, show/hide labels, and full-name tooltips on hover and focus.
- Validate 320 px, 736 px, and desktop layouts with overlay and always-visible classic scrollbars, including tracks wider than 12 px, plus enlarged system text. Check equal outside insets inclusive of tracks, symmetric workspace content insets, usable thumbs, unclipped focus, and reachable header/actions. Do not force narrower scrollbars or hide them to pass the check.
- Open tray; switch all available modes; close/reopen with state preserved; invoke Find while closed and while References is below.
- Select, copy, replace, delete, highlight with/without comment, insert, and place a page note. Edit an existing item; cancel; undo/redo; handle long and cross-page anchors.
- Open a reference; follow a nested destination; scroll away; return to original reference target; switch tabs; promote to main; use main Back; close/reopen and redock.
- Inspect owned/imported annotations with short and overflowing text: content activation opens the full reader with no separate read-full action; Back restores selection/scroll/focus, Edit is omitted for read-only records, and complete paragraphs remain reachable at narrow widths. Check peeks, copy-link, and correspondence/focus states.
- Verify reference return is absent at the original target, appears after same-page scrolling or nested navigation takes it out of view, and disappears after reveal. Check the shared “Open in main document” tooltip and context-specific export/forward glyphs without changing promotion versus link-navigation behavior.
- Exercise initial save setup, nested save dialog during authoring, busy/success/error, export-only and generated-output cases, and recovery.
- Check ordinary browser, Codex, native Mac and VS Code with their real available commands and insets.

Completion requires coherent appearance and retained behavior. A beautiful screen with missing controls, changed persistence semantics, lost reading state, or inaccessible actions does not satisfy this contract.

## 9. Canonical visual reference

The [interactive visual reference](assets/neutral-soft-design/index.html) and its [scene guide](assets/neutral-soft-design/README.md) accompany this contract. They supersede the earlier exploratory mockups, including their speculative toolbar search/compose controls and generic return-to-reading button. Open the reference in a browser and select a review state above the app; those selectors are review controls, not proposed product UI.

The fourteen scenes cover Reading, Annotations, Full annotation, Outline, Search, Text selection, Passage editor, Editor offscreen, Annotation peek, Split references, Reference link, Save setup, Save failure, and Narrow editor. The fixed light palette, active-title mode strip, surface treatments, control ownership, and representative arrangements are the visual target. The document content and interaction controller are illustrative. The scene guide identifies simulation boundaries and maps each scene to the relevant sections above.

Where a lifecycle or host condition is not fully simulated, this contract and existing app behavior govern. In particular, do not copy the mockup's PDF prose reflow, toolbar wrapping, fixed example dimensions, or simplified local state into the product. Use actual PDF geometry, existing responsive toolbar rules, and existing save/navigation state machines. The passage-attached editor remains the explicitly approved design recommendation, subject to implementation validation.

## 10. Decision status

The interface direction is settled: the user chose soft, spacious neutral gray, retained icon-forward navigation, and delegated editor placement on design merit. The recommendation is the passage-attached editor specified above. The app icon is explicitly in scope: B — Soft pages is selected, including borderless layered pages, subtle depth, a muted blue path, and a small amber dot. Production artwork, regenerated 16–1024 px icon representations, and distributed host/plugin assets are complete and validated. Dark-mode interface delivery is explicitly outside the first implementation scope; testing the icon against a dark desktop background does not expand that scope. The user subsequently authorized complete product implementation across all app surfaces, following this contract and the canonical visual reference.
