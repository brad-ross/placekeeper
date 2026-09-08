# PDF conformance matrix

Last updated: 2026-09-08

The U1 decision gate records viewer and writer outcomes separately. `PASS` means the stated evidence was observed. `PENDING` is a required check that could not run in this environment.

| Surface | Case | Result | Evidence |
| --- | --- | --- | --- |
| EmbedPDF browser viewer 2.14.4 | Native text, reliable geometry, existing Highlight and Stamp inventory | PASS | Playwright `pdf-viewer.conformance.spec.ts`; Chrome; worker-hosted local WASM |
| EmbedPDF browser viewer 2.14.4 | Image-only page refuses semantic anchoring | PASS | Empty canonical text and `reliableTextGeometry: false` |
| EmbedPDF browser viewer 2.14.4 | JavaScript, Launch, URI, and embedded-file content remain inert; no remote requests | PASS | Same-origin CSP harness plus Playwright request/action assertions |
| EmbedPDF browser viewer 2.14.4 | Malformed input fails within the test bound | PASS | Playwright rejects malformed fixture within 1 second |
| EmbedPDF writer 2.14.4 | Replace, Delete, Insert, Highlight with/without comment, and Page Note reopen with stable metadata and appearances | PASS | Vitest structural inspection; Insert uses Text `/Name /Insert` after Preview rejected Caret comment discoverability |
| EmbedPDF writer 2.14.4 | Existing supported Highlight and unsupported Stamp remain unchanged | PASS | Before/after annotation object inventory and equality |
| EmbedPDF writer 2.14.4 | 0/90/180/270-degree cropped-page text-markup geometry | PASS | Reopened segment rectangles equal requested viewer-space rectangles |
| EmbedPDF writer 2.14.4 | CJK, RTL, ligature, soft-hyphen, and combining-character comments | PASS | Exact Unicode `Contents` round trip |
| EmbedPDF writer 2.14.4 | AES-256 encrypted PDF with annotation permission disabled | PASS | Real `/Encrypt` fixture reports print allowed, add-notes denied; writer returns typed `encrypted` failure and no output |
| EmbedPDF writer 2.14.4 | DocMDP certification structure | PASS | AcroForm signature field plus catalog `/Perms /DocMDP`; writer returns typed `signature-restricted` failure and no output |
| Backend host | Original immutability, reopen, digest evidence, source/output limits, cancellation, timeout, malformed input | PASS | Vitest conformance suite |
| Apple Preview 11.0 / macOS 26.5.2 | All intended marks at expected locations | PASS | Manual golden-output inspection on 2026-08-07 |
| Apple Preview 11.0 / macOS 26.5.2 | Every non-empty comment visible in Highlights and Notes | PASS | Manual sidebar inspection on 2026-08-07, including Insert `however` and Page Note comment |
| Adobe Acrobat 26.001.21771 / macOS 26.5.2 | All intended marks at expected locations | PASS | Manual golden-output inspection on 2026-08-07; Insert note, Replace/Delete strikeouts, commented and bare Highlights, Page Note, and pre-existing Highlight/Stamp were visible on page 1 |
| Adobe Acrobat 26.001.21771 / macOS 26.5.2 | Every non-empty comment readable and source annotations present | PASS | Acrobat Comments pane reported 8 entries, including `however`, `locally unique equilibrium`, `Check this argument.`, `Page-level comment.`, existing supported Highlight, and existing unsupported Stamp |

## Automated command

```sh
pnpm test:pdf-conformance
```

The selected writer is EmbedPDF. Both current Acrobat and Apple Preview rows pass, so the external-viewer portion of U1 is complete without a PDFBox adapter.

## Standard annotation interoperability (2026-09-07)

Standard reviewer annotations are imported into the editable annotation tray. Comment edits and deletion preserve the original drawing dictionaries and appearance streams; they do not reconstruct geometry. Unsupported or unparseable annotations remain in “From the PDF.” PDF annotation locks still apply. Form widgets and navigation links retain their existing specialized handling.

| Case | Result | Evidence |
| --- | --- | --- |
| Import, edit, save, reopen, and delete standard annotations | PASS | `reviewed-pdf.test.ts`, `native-annotations.test.ts`, and the imported-annotation production-flow browser test |
| External changes override stale Placekeeper metadata | PASS | Regression edits standard `/Contents` and `/T`, then imports and saves again |
| Original appearance, color, opacity, and author survive comment edits | PASS | Original `/AP` stream equality and annotation dictionary assertions |
| Deleting a note removes its auxiliary popup and preserves replies | PASS | Saved PDF inventory and surviving reply dictionary assertions |
| Apple PDFKit reads Placekeeper comments and writes changes that Placekeeper reimports | PASS | Local macOS PDFKit round trip of Highlight and Stamp; edited Highlight comment reimported and saved by Placekeeper |
| Apple Preview application UI round trip | PASS | On 2026-09-07, opened the golden fixture, edited its Page Note, created a native note, saved, imported both changes into Placekeeper, edited the new note there, and reopened Preview to read the returned comment. All 9 annotations imported into the main tray. |
| Adobe Acrobat application UI round trip | PASS | On 2026-09-07, edited the golden fixture's Page Note and created a native note in Acrobat, saved, imported both changes into Placekeeper, edited the new note there, and reopened Acrobat. Its Comments pane showed both the Acrobat edit and `Created in Acrobat; edited and saved back by Placekeeper`, with 9 entries and the original Stamp still present. |
| Paperpile in Chrome: view, edit, add, reload | PASS with limitation | On 2026-09-07, uploaded a dedicated test reference, read the supported annotations, edited the Page Note, and added a note. Both changes survived a viewer reload. Paperpile did not display the original Stamp on the page or in its comment list. |
| Paperpile ↔ Placekeeper through the synced `papers` folder | PASS | On 2026-09-08, opened the actual synced PDF under `Paperpile/all_papers/Other` in Placekeeper. All 9 annotations imported into the main tray, including both Paperpile edits and the Stamp. Changed the Paperpile-created note to `Created in Paperpile; edited and saved back by Placekeeper — 2026-09-08`, verified Saved, then reloaded Paperpile in Chrome and read that exact comment in its sidebar and comment pane. The earlier Paperpile edit also remained present. |

The GUI tests used dedicated copies under `output/pdf/interop-2026-09-07/` and the current worktree's production web build. The Paperpile reference is named **Placekeeper PDF interoperability test — 2026-09-07**. Existing research PDFs were not edited. These are add/comment-edit round trips; deletion is covered by the automated and Placekeeper browser tests above, not by these external application checks.

Google Drive desktop sync delayed the test on September 7; the local file was available when work resumed September 8. The completed return edit reached the cloud PDF at 14:19:33 UTC (17,313 bytes) and was visible in Paperpile after reloading. Independent PDF inspection confirmed the edited note, earlier Paperpile comment, and Stamp remained in the returned file. Inspection snapshots are `output/pdf/interop-2026-09-07/Paperpile-cloud-check.pdf` and `Paperpile-return-cloud.pdf`; the GUI save used the actual synced file. The waiting heartbeat remains paused because the round trip is complete.

## Editable annotation appearance (2026-09-08)

Newly created marks now use shared reader colors and text-ink centering with custom normal PDF appearance streams in both service and browser exports. Highlights distinguish plain and commented washes, corrections have muted red strikes (and replacement underlines), insertions have a slate caret, and page notes have a folded-note outline. The semantic Highlight, StrikeOut, and Text dictionaries, comments, author, geometry, and portable review metadata remain editable; page contents are not flattened. PDFium's expanded Text-icon bounds are used for painting so narrow insertion anchors do not magnify line widths.

Imported and unchanged owned annotations keep their existing appearances. Adding or removing attached text redraws only a validated Placekeeper-owned highlight/replacement with the current appearance marker; ordinary comment changes preserve the original drawing. Existing exports are not globally restyled on a no-op save.

Verification: 69 focused writer/import/geometry tests pass, including actual PDFium raster checks for both highlight opacities and visible strikes, underlines, caret, and note outline; hiding annotations leaves the blank test page blank. A real browser-worker test exports/reimports all five kinds. Narrow insertion anchors round-trip on all four cropped-page rotations, and highlight comment attachment/removal updates the appearance. TypeScript and production web/static builds pass. The 14 mark-design browser cases passed across the initial run and targeted rerun (two hover cases required a rerun). The broader static all-kinds authoring test subsequently passed after correcting stale assumptions: imported native annotations now count as editable tray items, and caret placement must target unmarked text rather than an existing annotation hit target. The direct browser export conformance test also passes. No production gesture changes were made as part of appearance work.

Fidelity limits: Preview was visually checked with the new export. It displays the custom caret/note icon but regenerates some text markup, giving highlights a more saturated native fill and omitting the custom underline. Standard `/C` and highlight `/CA` remain populated alongside `/AP`; matching every reader's regenerated markup is not guaranteed. Optical padding is clipped to semantic annotation bounds, and other readers own their comment panes, hover/selection states, and subsequent appearance regeneration. The new appearance streams have not completed a fresh Acrobat/Paperpile GUI round trip; the interoperability results above concern the prior fixture. Acrobat's Open button remained disabled for the new fixture during this check, so no new Acrobat appearance pass is claimed.

Preview comment discovery (2026-09-08): the current appearance fixture exposes its non-empty Highlight and Replace contents in **View → Highlights and Notes**. Clicking those text marks did not open a comment; double-click selected underlying text. A comparison PDF with explicit `/Popup` objects and `/Parent` links behaved the same. The Delete fixture has empty contents, so it does not establish deletion-comment behavior. This is an observed compatibility limit, not a claim that all Preview-created text markup behaves identically. Apple documents the sidebar workflow in its [Preview text-markup guide](https://support.apple.com/guide/preview/highlight-underline-and-strike-out-text-prvw757d4d5b/mac).


Imported annotation reader styling: supported Highlight, StrikeOut, Underline, Squiggly, Caret, and Text annotations without an embedded appearance use the shared Placekeeper mark styling. Original `/C` and `/CA` fields override reader defaults, including opacity zero and one; engine-synthesized defaults do not. Embedded appearances, custom icons, richer border/rotation instructions, and unsupported types keep native rendering because the PDF does not reliably distinguish a stock drawing from a manually customized one. A failed style read or disagreement between source and engine annotation counts also keeps native rendering. This is a display policy: source style fields and appearance streams remain unchanged on export. The static browser acceptance test `imported annotations use reader defaults and preserve explicit PDF styling` covers the mixed default/custom fixture, desktop/narrow layouts, and a rotated/cropped page, alongside raw PDF export assertions.
