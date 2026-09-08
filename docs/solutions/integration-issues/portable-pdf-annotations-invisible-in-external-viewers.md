---
title: Portable PDF annotations invisible in external viewers
date: 2026-08-12
last_updated: 2026-09-08
category: integration-issues
module: PDF annotation persistence
problem_type: integration_issue
component: service_object
severity: high
symptoms:
  - PDFs saved by the app did not visibly render app-authored annotations in external viewers such as macOS Preview
  - Highlights, strikeouts, insert-note icons, and page-note icons disappeared when the saved PDF was shared outside the app
  - Annotation geometry could be displaced on cropped or rotated pages because persisted coordinates included the CropBox offset
root_cause: logic_error
resolution_type: code_fix
related_components:
  - EmbedPDF backend
  - portable annotation codec
  - PDF save coordinator
  - testing framework
tags:
  - pdf-annotations
  - appearance-streams
  - external-viewers
  - macos-preview
  - crop-relative-geometry
  - embedpdf
  - pdfium
---

# Portable PDF annotations invisible in external viewers

## Problem

Saved PDFs retained enough private metadata for Placekeeper to reconstruct its Review Items, but their visible annotation projections were not reliably self-rendering outside the app. Highlights, strikeouts, insert notes, and page notes could therefore look correct in the app's overlay yet disappear or land outside the visible page in macOS Preview and other PDF viewers.

The writer already required standards-visible normal appearances. PR #21 completed the interoperability fix by moving capture, overlay rendering, document ordering, portable metadata, and PDF writing to crop-relative page geometry, with a migration for legacy offset coordinates.

## Symptoms

- Reopening a saved PDF in the app recovered the expected annotation records, while generic PDF viewers painted some or none of the annotations.
- Marks on cropped or rotated pages could be offset because legacy review-state schema v1 included an erroneous CropBox origin; schema v2 defines crop-relative geometry (`packages/core/src/review-model.ts:26-29`).
- The in-app Owned Annotation overlay could mask the persistence defect because it is a separate viewer projection. It now consumes crop-relative rectangles and applies only rotation and scale (`apps/web/src/pdf/owned-overlay.ts:9-29`).

## What Didn't Work

No isolated failed patch was preserved. The investigation instead ruled out several insufficient approaches:

- **Relying on the app overlay.** An HTML/viewer overlay can look correct locally, but it is not part of the PDF and cannot help a recipient using Preview.
- **Treating an annotation dictionary as sufficient without a normal appearance.** Subtype, rectangle, color, and contents describe semantics, but viewers do not necessarily synthesize the same visual result. The writer now reopens the saved bytes, checks normal-appearance evidence, and rejects requested app-authored annotations that lack it (`packages/pdf-backends/src/embedpdf-adapter.ts:238-256`, `packages/pdf-backends/src/embedpdf-adapter.ts:628-640`).
- **Mixing canonical user space with crop-relative coordinates.** Compensating CropBox offsets could make the local overlay look plausible while the saved annotation landed in the wrong place. Capture now stores natural page coordinates directly, and the writer validates the enclosing rectangle and every text segment against the crop-relative page canvas (`apps/web/src/pdf/selection-anchor.ts:64-103`, `packages/pdf-backends/src/embedpdf-adapter.ts:493-529`).
- **Checking only the first highlight segment.** A malformed later quad could escape a shallow geometry test. Review feedback therefore added a case whose outer rectangle and first evidence remain valid while a later segment is off-page, proving that validation covers every segment (session history; `test/conformance/pdf-writer.conformance.test.ts:286-317`).

## Solution

### Project each Review Item to a standard PDF annotation

`projectReviewItem` derives visible geometry, text segments, contents, author, timestamps, and portable identity from the canonical Review Item (`packages/core/src/annotation-projection.ts:32-70`). The backend maps the five app-authored review kinds to restrained, printable PDF annotations (`packages/pdf-backends/src/embedpdf-annotation.ts:197`):

| Review kind | PDF annotation | Visual treatment |
| --- | --- | --- |
| Replace, Delete | `StrikeOut` | Muted correction ink; attached replacement text adds an underline |
| Insert | `Text` with `Insert` icon | Slate caret in a normal appearance |
| Highlight | `Highlight` | Gold wash; attached comment reduces fill opacity and adds an underline |
| Page Note | `Text` with `Note` icon | Gold folded-note outline |

The shared resting-mark palette is defined in `packages/core/src/annotation-appearance.ts:6`; hover, selection, and reader chrome remain UI state. The public subtype stays editable while its normal appearance supplies the custom drawing.

### Require a normal appearance after serialization

The backend creates the mapped dictionaries through PDFium, then installs normal appearance streams for newly created marks with the shared service/browser appearance writer before reopening the result (`packages/pdf-backends/src/annotation-appearance.ts:60`). Reopen inspection checks the normal appearance bit; the save fails closed if a requested app-authored annotation is missing or has no normal appearance (`packages/pdf-backends/src/embedpdf-adapter.ts:619-640`). The generated golden PDF was also manually rendered through Poppler and macOS PDFKit, where its marks were visible without Placekeeper interpreting the private metadata (session history).

### Distinguish semantic geometry, paint geometry, and reader behavior

Keep standard editable annotation dictionaries and custom normal appearances together. The writer attaches `/AP /N` Form XObjects instead of flattening marks into page contents. Standard `/C` and highlight `/CA` remain populated because some readers regenerate text markup from those fields. Within the appearance, opaque ink and translucent fill use separate ExtGState resources (`packages/pdf-backends/src/annotation-appearance.ts:101`). Thus normal-appearance evidence and standard dictionary evidence answer different questions; neither alone proves the recipient's visual result.

Separate semantic anchors from paint bounds after engine persistence. PDFium expands `Text` icon rectangles. Painting a 1.5-point caret stroke inside the original 2-point insertion-anchor coordinate system and then mapping it into the persisted icon rectangle can magnify the stroke into a solid block. Read the saved `/Rect` and use its width and height for insertion/page-note paint geometry and the appearance `/BBox`, while retaining semantic anchor data (`packages/pdf-backends/src/annotation-appearance.ts:90`). Do not fix this by enlarging the user's logical insertion anchor or by compensating with a global stroke-width reduction; the defect is a coordinate-space mismatch. Text markup uses glyph-derived text centering with the same midpoint fallback as the reader, and the underline is clipped within the annotation rectangle (`packages/pdf-backends/src/annotation-appearance.ts:39`, `packages/pdf-backends/src/annotation-appearance.ts:67`).

Appearance updates require narrower authority than portable ownership. New marks receive the current appearance; unchanged and imported marks keep theirs (`packages/pdf-backends/src/annotation-appearance.ts:60`). A validated Placekeeper-owned highlight or replacement is redrawn when attached text changes between empty and nonempty only if its normal appearance stream carries the current reader-appearance marker. In that case the preparation step leaves the previous projection for the writer to recognize the changed item. Ordinary text changes update the comment and metadata in place (`packages/pdf-backends/src/native-annotations.ts:186`). The marker identifies drawings whose wash/underline semantics the current renderer understands; it is not permission to restyle every old export or every private-metadata-bearing mark.

### Use one crop-relative geometry vocabulary

Selection and caret capture remove viewer scale and rotation, then store page-relative rectangles without adding a CropBox origin (`apps/web/src/pdf/selection-anchor.ts:64-103`, `apps/web/src/pdf/selection-anchor.ts:204-270`). In-app rendering applies page/document rotation and zoom to those same coordinates exactly once (`apps/web/src/pdf/owned-overlay.ts:5-29`). The durable writer rejects non-finite, non-positive, or off-page annotation and segment rectangles (`packages/pdf-backends/src/embedpdf-adapter.ts:506-529`).

### Migrate legacy geometry once

New Review States and portable envelopes use schema v2 (`packages/core/src/review-model.ts:72-89`, `packages/core/src/portable-annotation.ts:257-269`). When v1 state is encountered, migration subtracts the page CropBox origin from note positions, mark rectangles, and segment rectangles, including undo/redo history (`packages/pdf-backends/src/embedpdf-adapter.ts:290-345`). Session resume runs that migration before continuing and marks the migrated state as needing another durable save (`apps/service/src/sessions/session-broker.ts:229-261`).

### Keep private identity coupled to public evidence

The `placekeeper` envelope stores the Review Item and a redundant visible projection. Import accepts ownership only when the embedded ID, page, subtype, contents, author, rectangle, and segment rectangles match the actual visible annotation (`packages/core/src/portable-annotation.ts:23-43`, `packages/core/src/portable-annotation.ts:181-205`, `packages/core/src/portable-annotation.ts:272-306`). The portable writer preserves unchanged owned marks and replaces changed ones. Native comment edits and deletion use the separate dictionary-preserving contract in the [autosave learning](../architecture-patterns/recoverable-editable-pdf-annotation-autosave.md); unmanaged source records remain protected (`packages/pdf-backends/src/embedpdf-adapter.ts:599-669`).

## Why This Works

External viewers receive a standard subtype, visible geometry, color and opacity, printable flag, contents, and a normal appearance. Placekeeper's Portable Annotation Identity remains embedded beside that public representation. Manual cross-viewer rendering confirmed that the saved file remains visible without the app, while the portable envelope makes the same annotations editable when reopened in Placekeeper (session history).

The geometry correction also removes a compensating-error loop. Capture, overlay rendering, document ordering, portable metadata, and PDF writing now speak crop-relative page coordinates; rotation and zoom are presentation transforms applied only at the viewer boundary. Legacy v1 data is translated once during migration instead of forcing every downstream consumer to remember the old offset convention.

Finally, verification happens on the serialized artifact rather than the create call. The writer reopens the bytes, confirms every requested app-authored annotation exists and has a normal appearance, validates portable metadata, and confirms that unmanaged source annotations are unchanged (`packages/pdf-backends/src/embedpdf-adapter.ts:624-669`). A broken interoperability invariant becomes a typed save failure rather than a shareable-but-invisible PDF.

### Observed external-reader limits

The same boundary applies to comment discovery. The repository's dated conformance record reports that Preview displayed the new caret/note icons but regenerated some text markup with a more saturated fill and omitted the custom underline (`docs/pdf-conformance-matrix.md:61`). It also reports that the tested Highlight and Replace comments were readable through **View → Highlights and Notes**, while clicking did not open comments and double-clicking selected text. Adding explicit `/Popup` objects with `/Parent` links did not change that observed behavior (`docs/pdf-conformance-matrix.md:63`). These are fixture-specific observations, not proof of universal Preview behavior. The empty Delete fixture does not establish how deletion comments behave.

Use these distinctions when adding a new appearance, changing icon geometry, implementing attachment-sensitive styling, or interpreting cross-reader test failures. Keep reader-owned interaction behavior out of the PDF drawing contract. Retain dated, application-specific conformance evidence: the previous Acrobat/Paperpile round trips used an earlier fixture, and the new appearance fixture had no fresh successful Acrobat/Paperpile GUI round trip in the recorded check (`docs/pdf-conformance-matrix.md:61`).

## Prevention

- Keep the five-kind conformance test as the primary portability gate. It writes a golden PDF, reopens it, and verifies subtype mapping, contents, author, print flag, and normal appearance for every annotation (`test/conformance/pdf-writer.conformance.test.ts:218-261`).
- Render the generated `output/pdf/u1-all-annotations-golden.pdf` through at least one viewer outside the app. Structural assertions and correct in-app overlays are necessary but not sufficient evidence of cross-viewer appearance (session history).
- Exercise crop and rotation independently. The conformance matrix covers 0, 90, 180, and 270 degrees on cropped pages and requires geometry plus normal appearance to survive reopen (`test/conformance/pdf-writer.conformance.test.ts:264-283`).
- Reject geometry again at the durable-write boundary even when UI capture has already validated it. Dedicated tests cover an off-page annotation rectangle and an off-page quad inside an otherwise valid rectangle (`test/conformance/pdf-writer.conformance.test.ts:286-317`).
- Preserve schema-versioned migration coverage for both live items and history so v1 CropBox-offset rectangles become v2 crop-relative rectangles without losing undo state (`test/conformance/pdf-writer.conformance.test.ts:319-361`).
- For each future annotation kind, extend the standard subtype mapping and golden PDF, then require a normal appearance after reopen. Also rasterize it: the narrow-caret and annotation-hidden blank-page checks in `test/conformance/pdf-writer.conformance.test.ts:136` and `test/conformance/pdf-writer.conformance.test.ts:216` distinguish paint correctness from metadata presence and flattening. Never treat correct in-app rendering as proof that the saved PDF is portable.

- Exercise the browser-worker export/reimport boundary separately (`test/conformance/pdf-appearance.conformance.spec.ts:11`). Preserve older and custom drawings on ordinary saves; test attachment transitions only for the owned appearance marker.

## Related Issues

- [Recoverable autosave for editable PDF annotations](../architecture-patterns/recoverable-editable-pdf-annotation-autosave.md) describes the broader full-state projection, ownership, verification, and cross-reader persistence architecture. This learning covers the narrower external-rendering failure and geometry correction.
- PR #21 contains the fix and merged into `main` on 2026-08-12 (America/New_York).
