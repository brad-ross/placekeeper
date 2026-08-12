---
title: Portable PDF annotations invisible in external viewers
date: 2026-08-12
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

Saved PDFs retained enough private metadata for PDF Proofreader to reconstruct its Review Items, but their visible annotation projections were not reliably self-rendering outside the app. Highlights, strikeouts, insert notes, and page notes could therefore look correct in the app's overlay yet disappear or land outside the visible page in macOS Preview and other PDF viewers.

The writer already required standards-visible normal appearances. PR #21 completed the interoperability fix by moving capture, overlay rendering, document ordering, portable metadata, and PDF writing to crop-relative page geometry, with a migration for legacy offset coordinates.

## Symptoms

- Reopening a saved PDF in the app recovered the expected annotation records, while generic PDF viewers painted some or none of the annotations.
- Marks on cropped or rotated pages could be offset because legacy review-state schema v1 included an erroneous CropBox origin; schema v2 defines crop-relative geometry (`packages/core/src/review-model.ts:26-29`).
- The in-app Owned Annotation overlay could mask the persistence defect because it is a separate viewer projection. It now consumes crop-relative rectangles and applies only rotation and scale (`apps/web/src/pdf/owned-overlay.ts:9-29`).

## What Didn't Work

No isolated failed patch was preserved. The investigation instead ruled out several insufficient approaches:

- **Relying on the app overlay.** An HTML/viewer overlay can look correct locally, but it is not part of the PDF and cannot help a recipient using Preview.
- **Treating an annotation dictionary as sufficient without a normal appearance.** Subtype, rectangle, color, and contents describe semantics, but viewers do not necessarily synthesize the same visual result. The writer now reopens the saved bytes, checks normal-appearance evidence, and rejects any requested annotation that lacks it (`packages/pdf-backends/src/embedpdf-adapter.ts:238-256`, `packages/pdf-backends/src/embedpdf-adapter.ts:628-640`).
- **Mixing canonical user space with crop-relative coordinates.** Compensating CropBox offsets could make the local overlay look plausible while the saved annotation landed in the wrong place. Capture now stores natural page coordinates directly, and the writer validates the enclosing rectangle and every text segment against the crop-relative page canvas (`apps/web/src/pdf/selection-anchor.ts:64-103`, `packages/pdf-backends/src/embedpdf-adapter.ts:493-529`).
- **Checking only the first highlight segment.** A malformed later quad could escape a shallow geometry test. Review feedback therefore added a case whose outer rectangle and first evidence remain valid while a later segment is off-page, proving that validation covers every segment (session history; `test/conformance/pdf-writer.conformance.test.ts:286-317`).

## Solution

### Project each Review Item to a standard PDF annotation

`projectReviewItem` derives visible geometry, text segments, contents, author, timestamps, and portable identity from the canonical Review Item (`packages/core/src/annotation-projection.ts:32-70`). The backend maps the five review kinds to restrained, printable PDF annotations (`packages/pdf-backends/src/embedpdf-adapter.ts:110-160`):

| Review kind | PDF annotation | Visual treatment |
| --- | --- | --- |
| Replace, Delete | `StrikeOut` | Red, fully opaque |
| Insert | `Text` with `Insert` icon | Blue, fully opaque |
| Highlight | `Highlight` | Warm yellow at 45% opacity |
| Page Note | `Text` with `Note` icon | Amber, fully opaque |

The clean palette makes annotation meaning obvious without obscuring the document.

### Require a normal appearance after serialization

The backend creates the mapped annotations through PDFium, saves a new PDF, and reopens the result. Reopen inspection checks the normal appearance bit; the save fails closed if any requested annotation is missing or has no normal appearance (`packages/pdf-backends/src/embedpdf-adapter.ts:619-640`). The generated golden PDF was also manually rendered through Poppler and macOS PDFKit, where its marks were visible without PDF Proofreader interpreting the private metadata (session history).

### Use one crop-relative geometry vocabulary

Selection and caret capture remove viewer scale and rotation, then store page-relative rectangles without adding a CropBox origin (`apps/web/src/pdf/selection-anchor.ts:64-103`, `apps/web/src/pdf/selection-anchor.ts:204-270`). In-app rendering applies page/document rotation and zoom to those same coordinates exactly once (`apps/web/src/pdf/owned-overlay.ts:5-29`). The durable writer rejects non-finite, non-positive, or off-page annotation and segment rectangles (`packages/pdf-backends/src/embedpdf-adapter.ts:506-529`).

### Migrate legacy geometry once

New Review States and portable envelopes use schema v2 (`packages/core/src/review-model.ts:72-89`, `packages/core/src/portable-annotation.ts:257-269`). When v1 state is encountered, migration subtracts the page CropBox origin from note positions, mark rectangles, and segment rectangles, including undo/redo history (`packages/pdf-backends/src/embedpdf-adapter.ts:290-345`). Session resume runs that migration before continuing and marks the migrated state as needing another durable save (`apps/service/src/sessions/session-broker.ts:229-261`).

### Keep private identity coupled to public evidence

The `pdfMarkup` envelope stores the Review Item and a redundant visible projection. Import accepts ownership only when the embedded ID, page, subtype, contents, author, rectangle, and segment rectangles match the actual visible annotation (`packages/core/src/portable-annotation.ts:23-43`, `packages/core/src/portable-annotation.ts:181-205`, `packages/core/src/portable-annotation.ts:272-306`). The writer removes only annotations recognized as app-owned, writes the current Owned Annotation set, and verifies that Existing PDF Annotations remain unchanged (`packages/pdf-backends/src/embedpdf-adapter.ts:599-669`).

## Why This Works

External viewers receive a standard subtype, visible geometry, color and opacity, printable flag, contents, and a normal appearance. PDF Proofreader's Portable Annotation Identity remains embedded beside that public representation. Manual cross-viewer rendering confirmed that the saved file remains visible without the app, while the portable envelope makes the same annotations editable when reopened in PDF Proofreader (session history).

The geometry correction also removes a compensating-error loop. Capture, overlay rendering, document ordering, portable metadata, and PDF writing now speak crop-relative page coordinates; rotation and zoom are presentation transforms applied only at the viewer boundary. Legacy v1 data is translated once during migration instead of forcing every downstream consumer to remember the old offset convention.

Finally, verification happens on the serialized artifact rather than the create call. The writer reopens the bytes, confirms every requested annotation exists and has a normal appearance, validates portable metadata, and confirms that foreign annotations are unchanged (`packages/pdf-backends/src/embedpdf-adapter.ts:624-669`). A broken interoperability invariant becomes a typed save failure rather than a shareable-but-invisible PDF.

## Prevention

- Keep the five-kind conformance test as the primary portability gate. It writes a golden PDF, reopens it, and verifies subtype mapping, contents, author, print flag, and normal appearance for every annotation (`test/conformance/pdf-writer.conformance.test.ts:218-261`).
- Render the generated `output/pdf/u1-all-annotations-golden.pdf` through at least one viewer outside the app. Structural assertions and correct in-app overlays are necessary but not sufficient evidence of cross-viewer appearance (session history).
- Exercise crop and rotation independently. The conformance matrix covers 0, 90, 180, and 270 degrees on cropped pages and requires geometry plus normal appearance to survive reopen (`test/conformance/pdf-writer.conformance.test.ts:264-283`).
- Reject geometry again at the durable-write boundary even when UI capture has already validated it. Dedicated tests cover an off-page annotation rectangle and an off-page quad inside an otherwise valid rectangle (`test/conformance/pdf-writer.conformance.test.ts:286-317`).
- Preserve schema-versioned migration coverage for both live items and history so v1 CropBox-offset rectangles become v2 crop-relative rectangles without losing undo state (`test/conformance/pdf-writer.conformance.test.ts:319-361`).
- For each future annotation kind, extend the standard subtype mapping and golden PDF, then require a normal appearance after reopen. Never treat correct in-app rendering as proof that the saved PDF is portable.

## Related Issues

- [Recoverable autosave for editable PDF annotations](../architecture-patterns/recoverable-editable-pdf-annotation-autosave.md) describes the broader full-state projection, ownership, verification, and cross-reader persistence architecture. This learning covers the narrower external-rendering failure and geometry correction.
- PR #21 contains the fix and merged into `main` on 2026-08-12 (America/New_York).
