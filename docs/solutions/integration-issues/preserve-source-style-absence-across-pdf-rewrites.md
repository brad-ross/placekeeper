---
title: "Preserve source style absence across PDF rewrites"
date: "2026-09-08"
last_updated: 2026-09-10
category: "integration-issues"
module: "PDF annotation persistence"
problem_type: "integration_issue"
component: "service_object"
severity: "medium"
symptoms:
  - "Imported annotations used synthesized engine styling instead of reader defaults despite absent source style fields"
  - "Reader-default annotation styling disappeared after export and reopen because PDFium synthesized an appearance stream"
  - "Restyling every source appearance risked replacing intentionally customized drawings"
root_cause: "logic_error"
resolution_type: "code_fix"
tags:
  - "pdf-annotations"
  - "source-style"
  - "appearance-streams"
  - "pdfium"
  - "reader-defaults"
  - "explicit-overrides"
  - "roundtrip-preservation"
---

# Preserve source style absence across PDF rewrites

## Problem

An imported PDF annotation with no saved style can use Placekeeper's reader defaults, while an explicitly styled annotation should retain the source's choices. Engine annotation objects alone cannot reliably distinguish these cases: normalized color and opacity may contain engine defaults even when `/C` and `/CA` were absent in the source. A second trap appears on save: PDFium can synthesize `/AP`, converting an originally appearance-less mark into one that the next open correctly treats as source-drawn. Without preserving absence, a no-op save changes the reader's classification.

## Symptoms

Default imported marks can inherit the engine's normalized default colors instead of the shared reader palette. Explicit opacity zero or one can be mistaken for a default if the implementation uses truthiness or compares against normalized values. A mark can use reader styling on first open and lose it after save/reopen despite no intentional appearance edit. These failures share a cause: interpreting a renderer's completed representation as evidence of which instructions the PDF author actually supplied.

## What Didn’t Work

Initial-render checks missed the save/reopen failure: a generated appearance caused the next open to stop using reader defaults. Treating engine-normalized color or opacity as an explicit override also erased the missing-versus-supplied distinction. Applying Placekeeper styling to every embedded drawing would satisfy visual consistency at the cost of the user’s custom styling; the PDF supplied no reliable provenance to justify that choice.

## Solution

Read optional style evidence from the original PDF dictionaries. The source-style inventory records explicit color presence and raw opacity separately; absence remains an empty style record rather than a normalized default (`apps/web/src/pdf/source-annotation-style.ts`). The renderer uses the engine-converted color only when raw source evidence establishes that `/C` exists (`apps/web/src/pdf/SourceAnnotationMark.tsx`). This preserves useful engine color conversion without granting engine defaults authority over the reader palette.

Be conservative about custom appearance intent. An `/AP` dictionary does not reveal whether its author used a stock tool or drew manually. Preserve native rendering for embedded appearances, richer border/rotation instructions, custom icons, unsupported subtypes, and invalid explicit values (`apps/web/src/pdf/source-annotation-style.ts`). A failed optional style read returns no style overrides, allowing native discovery to continue (`apps/web/src/pdf/source-annotation-style.ts`). The raw dictionary index is only joined to engine enumeration when the page annotation counts match; a mismatch suppresses the reader-style override rather than guessing which annotation the evidence describes (`apps/web/src/pdf/existing-annotations.ts`).

Preserve source absence across the durable save boundary. During native preparation, record the page and stable `/NM` of each retained source annotation that had no `/AP` (`packages/pdf-backends/src/native-annotations.ts`). After PDFium writes the candidate, remove generated `/AP` only for those recorded page/name pairs (`packages/pdf-backends/src/native-annotations.ts`). Matching page plus persistent name avoids applying source array positions to an output inventory changed by deletion or addition. Do not remove all appearances or classify them by how they look: an appearance present in the source is outside this cleanup's authority.

Postprocessing changes the verified artifact. Reinspect the final candidate, recompute `outputSha256` from its bytes, and invalidate the earlier cached inspection when cleanup produced a new byte array (`packages/pdf-backends/src/native-annotations.ts`). Otherwise verification could attest to the pre-cleanup PDF rather than the actual saved result.

## Why This Works

The absence of a PDF field is evidence, not missing data to fill permanently. Source inspection answers what the author specified; engine conversion answers how to render a supplied value; the optional reader policy supplies defaults only where the source permits it. Save cleanup preserves that distinction across sessions instead of baking an engine's incidental synthesis into the document's apparent authorship.

This is deliberately a display policy with a narrowly scoped preservation repair. It does not write the reader palette into imported dictionaries. Source `/C`, `/CA`, and pre-existing appearance streams remain source data, while originally absent appearances remain absent on reopen.

## Prevention

Test the lifecycle, not just the initial screen. `test/acceptance/static-web.spec.ts` creates supported default marks, an explicitly green translucent highlight, and a highlight with an embedded custom appearance. It checks default and explicit rendering, desktop and narrow layouts, and a rotated/cropped variant. After export it asserts missing `/C`, `/CA`, and `/AP` remain missing, explicit style values survive, and the original appearance content is unchanged; reopening the export must restore the same count of reader-styled marks.

`test/conformance/reviewed-pdf.test.ts` exercises a source highlight without an appearance through the selected writer. It asserts `/AP` remains absent, the output digest matches the returned bytes, the stale inspection is unavailable, and final reviewed-PDF verification succeeds. `apps/web/test/source-annotation-style.test.ts` and `apps/web/test/existing-annotations.test.ts` provide the focused source inventory and engine-join coverage.

When adding another supported subtype or source style field, preserve three distinctions: absent versus explicit, source-defined versus engine-generated, and certain identity versus ambiguous inventory. A native fallback is the correct outcome when optional style evidence cannot support an override.

## Related Issues

- [Portable PDF appearances](portable-pdf-annotations-invisible-in-external-viewers.md) covers the complementary invariant: new app-authored marks require an appearance, while native source marks that lacked one preserve that absence.
- [Recoverable editable annotation autosave](../architecture-patterns/recoverable-editable-pdf-annotation-autosave.md) explains native mutation authority and source-import evidence.
