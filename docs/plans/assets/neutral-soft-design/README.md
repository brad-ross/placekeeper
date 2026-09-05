# Neutral soft visual reference

Open [index.html](index.html) in a browser. It includes a review-only state selector and width selector above the depicted app. These are not Placekeeper controls. Soft fade is now the selected edge treatment. The in-conversation Document zoom control or editable toolbar percentage lets you inspect overflow. The same app surface appears in the conversation, where the host's design controls select the reference state.

This is the canonical visual companion to [the design contract](../../2026-09-05-neutral-soft-design-contract.md). It supersedes the earlier exploratory sketches. It specifies the neutral light appearance, control ownership, hierarchy, and representative surface arrangements. The written contract and existing production behavior govern lifecycle details that a scene does not demonstrate.

The latest refinement restores the original neutral study's inset, fully rounded supporting trays and borderless toolbar. References below the document has vertical tabs on the left of the preview, with no duplicate raised title. Show/hide controls use matching unfilled chevrons. The workspace hide button sits first in its fixed navigation bar; hidden-tray reveal controls sit in solid bottom/right overlay margins with inward soft fades. While open, its hide and dock-right controls sit inside the top of the left tab column, eliminating the former inter-pane control row and leaving a 12 px gap that matches outside tray spacing. The move-to-bottom button appears only in the active References workspace mode and is absent while already docked below. Annotation actions share the compact type/page line and appear on selection, hover, or keyboard focus, remaining directly visible for touch. Whole-row/tab hover includes metadata and action regions. Every type has a small header icon; struck-through source with or without alternative text distinguishes replacement and deletion. Peeks reuse the same row with a close action. Clicking a mark while the workspace is open selects its Annotations row without a peek.

Undo, Redo, Back, and Forward are individually absent when unavailable, including their unused group spacing. Apply an annotation to reveal Undo; undo it to reveal Redo. Promote a reference to reveal Back; return to the initial main location to show Forward alone. These are explicit user-requested visibility changes. Production availability must come from the actual action controllers, not the mockup's simplified local history or dirty state.

Zoom uses an editable numeric value, a fixed noneditable % suffix, and a closely spaced disclosure for minus, plus, and fit; the popover has no repeated percentage. The page and zoom groups retain the ordinary button hover fill, while their inputs have no focus frame; the caret indicates editing. Search is slimmer, and save-copy naming is a soft borderless field. Button content is centered within symmetric hit targets. The combined current / total surface has no down-chevron glyph: click the input to edit or anywhere else in the group to open Previous/Next. Unavailable directions disappear at page boundaries. History shares this group. Compact charcoal tooltips use readable white text and softly rounded corners. The filename button hugs its content up to 280 px, with a separate flexible spacer.

## Review scenes

| State | What to review | Contract |
| --- | --- | --- |
| Reading | Quiet document chrome; distinct annotation history, reading history, page navigation, zoom, fit, and location link; workspace reveal at the edge | §§1, 5 |
| Annotations | Only the active mode has a visible title; rounded selected row; bare page numerals; direct actions; imported provenance | §§1, 3 |
| Full annotation | Full owned comment in a scrolling reader with fixed Back/type/page/Edit and a conditional PDF-anchor action; also reachable by clicking the truncated annotation itself | §3 |
| Outline | Same mode strip and selection treatment, with nested disclosure chevrons, reversible Collapse/Restore header toggle, and aligned locations | §1 |
| Search | One workspace query and result list; the toolbar does not gain a second search control | §1 |
| Text selection | One floating, icon-forward Replace / Delete / Highlight / Copy palette | §2 |
| Passage editor | Replacement attached below the selected passage at this width; the workspace remains present | §2 |
| Editor offscreen | Persistent draft with original page cue and Back to passage; staged state, not a live scroll simulation | §2 |
| Annotation peek | Compact existing-annotation inspection with a separate edit action | §3 |
| Split references | One full-size PDF viewport behind the right workspace and full-width bottom References overlays | §4 |
| Reference link | Original tab destination 12 versus current reference location 13; nested-link action palette | §4 |
| Save setup | Local-PDF destination choice above an intact composer; explicit copy name, folder, location control, and confirmation | §5 |
| Save failure | Actionable failure near the document commands; no misleading permanent “Saved” footer | §§5, 7 |
| Narrow editor | The same draft and explicit actions in a bottom sheet, with the source passage visible | §§2, 7 |

Useful interaction checks:

- Switch workspace modes, close and reopen the workspace, and invoke Cmd/Ctrl+F with focus inside the mockup.
- Select **Text selection**, then Replace. Type a draft; Cancel and Apply remain explicit. The illustrated highlighted mark selects its Annotations row while the workspace is open and opens the matching peek while it is closed.
- In **Reference link**, use Follow in this reference tab, Return to reference, and Open in main document. The main page stays 4 until actual main navigation; Back then restores that main location. Promoting or closing a reference consumes that tab while retaining its siblings.
- In **Save setup**, Cancel returns to the same draft. Changing between original and copy reveals only the applicable copy details.
- Select widths 1024, 736, 360, and 320 in the standalone review. Use **Narrow editor** to inspect the bottom sheet even in a large window.

## What the mockup does not implement

This is a visual reference, not a replacement viewer or a production interaction implementation. The sample paper is invented, and its prose reflows to keep the sketch legible. The real PDF must retain its pixels, typography, zoom, and scroll ownership. The zoom field and popover scale the sample paper to demonstrate overflow and fixed viewer margins; this is still HTML sample content, not real PDF rendering. Its base size is retained across tray toggles and reset when selecting a new review scene/preview width. The split scene keeps the main PDF viewport full size behind both overlays; only the workspace shortens to end above bottom References. Its move-right action sits beside the hide control inside the top-left tab column. Right-docked References uses a horizontal tab strip; bottom-docked References uses vertical tabs. Closing the last reference removes the tray, toggle, and References mode; hiding a nonempty tray preserves its tabs.

The Editor offscreen scene stages a different page behind the retained draft. Back to passage restores the source scene and draft. It does not test scrolling, anchoring, or PDF zoom. The plan records the accepted overlay arrangement and the specified explicit Fit width behavior.

The selection is a prepared sample, rather than arbitrary native PDF text selection. Annotation mutations, history, and reference tabs are small local demonstrations, not substitutes for the existing state machines. Copy does not write the clipboard. Save/Retry/Confirm do not write a file; location selection ends at the native-picker boundary. No network requests, external messages, or persistence are performed by the mockup script. The standalone renderer loads its shared icon support from the renderer's approved CDNs.

At the illustrated desktop width there is insufficient free margin for a 326 px editor beside the paper, so the editor is placed below the selection. When actual unused margin can accommodate it, the implementation should place it beside the passage as specified in the contract. Do not shrink, reposition, or reflow the PDF merely to reproduce a preferred sketch arrangement. The editor uses one white surface with a borderless text area and compact explicit actions; placement still comes from actual selection geometry.

The narrow toolbar wraps its command groups to expose all available actions for review. The production toolbar must preserve its existing measured grouping/overflow behavior. The sketch's breakpoints are not approved replacements for that logic. Virtual-keyboard occlusion, long-input scrolling, IME, focus restoration/trapping, stale anchors, multi-page selections, host-specific save/export paths, busy/recovery states, and every existing command remain implementation acceptance requirements; this visual reference alone does not validate them.

## Files

- `canonical.html`: editable app-only fragment, identical to the conversation reference.
- `index.html`: generated standalone review, ready to open without the repository build.
- `review-controls.html`: standalone review controls outside the depicted product.
- `build-reference.py`: rebuilds the standalone review using an installed Visualize renderer; takes the skill directory as its argument.

Do not import the mockup CSS or JavaScript into the product. Apply the visual system to the existing components and implement the passage-attached editor against the contract. Changes to this reference should update both the source and generated review, and remain consistent with the written plan.

The accepted soft fades appear along the right and lower viewport edges when sample content overflows and disappear at the corresponding scroll extent. Hidden-tray reveal chevrons sit in full bottom/right neutral overlay bands that reach their inner edges and fade into the paper; the PDF viewport remains full size underneath. The toolbar percentage now scales the illustrative paper so these margins can be inspected at 150% or 200%. This does not validate production PDF coordinates, zoom anchoring, or text selection. The edge-treatment alternatives have been removed from the review controls.

The page number stays directly editable. Its adjacent `/ total` and the rest of the page group open a compact Previous/Next popover, with unavailable boundary actions omitted. It follows the zoom popover’s appearance, dismissal, and keyboard behavior; Back/Forward remain directly in the toolbar.

In Outline, collapse individual branches or use the header toggle to collapse everything and restore the exact prior expansion. Nested choices survive parent closure and workspace mode changes. Existing outline reference/copy destination actions remain required by the contract; the mock demonstrates expansion and navigation.

The main PDF now fills the whole content window behind both trays, with its scrollbars at the outside edges. Tray toggles preserve its viewport geometry and zoom. The right workspace shortens only to avoid overlapping bottom References. Its modebar stays fixed while the active content pane scrolls inside matching side, header-gap, and bottom insets. The hidden References reveal button has a 12 px bottom inset, matching the tray margins. The workspace hide toggle sits inside the navigation bar before the mode buttons. Outline disclosures use balanced 28 px targets with breathing room before the title and symmetric row-edge insets. This supersedes earlier reserved-pane and control-gutter arrangements.

The hidden References bottom band and hidden workspace right band are 40 px deep for 28 px controls at a 12 px outer inset, with 18 px fades into the document (56 px bands for 44 px touch targets). The bands leave outer scrollbars usable and do not resize the PDF viewport.

The top bar is approximately 50 px tall, with page/current-total and zoom matched at 13 px and vertically centered in equal 32 px controls. Scrolling the main PDF activates a soft fade just below the toolbar. Workspace header controls use consistent 32 × 34 px targets and 2 px gaps, without selectively compressed icons; the desktop workspace is approximately 304 px wide. References positioning appears only while its workspace mode is active.

The workspace meets the toolbar directly with no outside top gap. Tray spacing uses one 12 px token: workspace outer right/bottom clearances, internal side and navbar top/bottom gaps, and equivalent References outer/inner gaps. Extra first-content top margins are removed. Zoom edits only the numeric value; the fixed % suffix sits close to the caret without a wide blank input tail.

The outer right and bottom margins include the main scrollbar tracks within the same 12 px total as the left margin. Workspace contents likewise include the measured inner scrollbar width within their 12 px right inset, keeping the visible content symmetric with the left; scrollbar tracks blend into the existing neutral surface.

Search starts empty with “Search this document” as its placeholder; type “signal” for the sample results. The clear target has equal 4 px top, bottom, and right insets. In Save setup, the clickable “Documents / Reading” path above the filename replaces both “Copy name” and the separate Change location control. Annotation editors use equal 12 px outer padding and 12 px internal section gaps.

The final polish keeps the approved button dimensions. Search reserves the clear-button slot but hides and disables it while empty. Tray controls consistently say Show/Hide. Document and reference tooltips expose full names on hover and keyboard focus. Page and zoom edits share strict whole-number validation for Enter and focus loss; malformed/blank values restore the previous value, whole numbers clamp to the example bounds, and Escape cancels the edit. The workspace scrollbar compensation is capped so unusually wide tracks cannot extend beyond the tray; the opposite content inset grows to preserve symmetry. The contract requires product validation with classic/overlay scrollbars and enlarged system text, including adjusting common outside margins if real main tracks exceed 12 px. This illustrative reference does not certify every OS scrollbar or text-scaling setting.

Open trays now sit above a solid neutral backing that covers rounded-corner cutouts, the workspace’s left gutter, the inter-tray gap, and outside margins. A continuous 18 px inward fade frames the remaining exposed PDF area. The backing follows actual tray bounds, including stacked sheets at narrow widths, without changing the document viewport, zoom, or scrolling.

Icon/type audit: one rounded Lucide outline family now uses a shared 2-unit viewBox stroke; primary glyphs remain 16 px and secondary type glyphs 14 px. Outline uses list-tree, Collapse/Restore use fold-vertical/unfold-vertical, Fit width uses move-horizontal, reference promotion/main navigation uses the export-style square-arrow-out-up-right; main-PDF link navigation uses chevron-right. All main-navigation/promotion tooltips say Open in main document. UI surfaces and annotation excerpts share the native system sans-serif token; illustrative PDF prose keeps its serif typography. The design contract contains the complete semantic mapping, rationale, and typography/host validation requirements.

Annotation type refinement replaces the detailed replacement glyph with two clean opposing arrows throughout rows, peeks, the selection palette, and editor headings. Highlight keeps its highlighter while deletion uses a single clean minus stroke; deletion source text remains struck through. Metadata glyphs share a 14 px box, neutral color, and stroke weight without badges or tiny added markers. The plan also specifies a plain insertion caret and simple page-note glyph for those production-only types.

The Annotations scene contains full multi-paragraph owned and imported comments, clamped only in the list. Click the truncated annotation itself to open the full reader; there is no separate More/read-full button. Back restores the list selection, focus, and scroll; Edit is available for the owned comment and omitted for the imported read-only comment. Full annotation opens the reader directly for design review. Truncated peeks use the same direct-click reader and return to the peek. Editing from the reader retains its context on Cancel and updates its text on Apply.

Reference tabs show an anchor-shaped Return to reference only when the original destination is outside the reference viewport. Scroll the reference body downward on the same page, or use Reference link to stage page 13, to reveal it; returning to the page-12 target hides it. Tabs stay fixed while the body scrolls in either docking position. The mock measures the example heading’s visibility and remembers body scroll within the scene; the product must use its existing original-destination availability controller, including actual PDF coordinates and pending states.

The full reader uses the same small type icon and bare page cue as annotation rows. Imported annotations add “Read only” on this same header line, with no separate “From this PDF” line. In **Full annotation**, scroll the main paper away or enter another page: **Back to annotation in PDF** appears beside Edit. It reveals the source and disappears when visible, while the full comment stays open at its reading position. The prototype measures its illustrated passage and covering trays; production must use the actual annotation geometry and existing navigation guards.

## App icon proposals

The [app icon comparison](app-icons/index.html) extends this plan to the native app identity. It retains the two-page reference-and-return metaphor with the user-selected muted blue path and amber dot. The user selected B — Soft pages, with borderless layers and subtle depth. Production artwork refinement and iconset regeneration remain pending. See the [candidate guide](app-icons/README.md).
