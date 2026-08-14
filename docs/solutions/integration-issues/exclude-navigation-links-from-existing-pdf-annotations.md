---
title: Exclude Navigation Links from Existing PDF Annotation Inventories
date: 2026-08-14
category: integration-issues
module: pdf_annotation_inventory
problem_type: integration_issue
component: service_object
symptoms:
  - PDF Link annotations appeared as read-only Existing PDF Annotations in the web annotation tray.
  - PDF Link annotations appeared in Live PDF Context as external reviewer annotations.
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - frontend_stimulus
tags:
  - pdf-annotations
  - navigation-links
  - existing-annotations
  - live-context
  - embedpdf
---

# Exclude Navigation Links from Existing PDF Annotation Inventories

## Problem

PDF Link annotations crossed a semantic boundary they do not belong to. They are navigation affordances, but the web viewer and Live PDF Context treated them like foreign reviewer feedback and surfaced them as read-only Existing PDF Annotations. The correction is pending in [PR #33](https://github.com/brad-ross/placekeeper/pull/33).

The low-level annotation catalog and reviewer-facing inventories have different contracts. The catalog is intentionally broad: `inspectPdfAnnotationCatalogWithEmbedPdf` returns every inspected annotation alongside portable Review Items (`packages/pdf-backends/src/embedpdf-adapter.ts:505`). Reviewer-facing inventories are narrower and must exclude navigation-only subtypes.

## Symptoms

- Link-heavy PDFs populated the Existing PDF Annotations tray with entries that were links rather than comments, highlights, or other review markup.
- The service exposed the same links through `existingPdfAnnotations`, allowing downstream live-context consumers to mistake document navigation for external feedback.
- Link annotations without normal appearance streams could influence reviewer-facing warnings even though those warnings concern displayed external annotations.
- In the verified 56-page manuscript, the raw catalog retained 461 links and one highlight while the external-annotation inventory correctly contained no items after the fix (verified in the implementation session).

## What Didn't Work

There was no discarded implementation attempt. Investigation instead confirmed that the same classification error occurred independently at both reviewer-facing boundaries: the web inventory and the service projection.

Filtering links out of the low-level catalog would have been the wrong remedy. The adapter deliberately collects all page annotations (`packages/pdf-backends/src/embedpdf-adapter.ts:505`), and the write path treats non-owned annotations as preexisting PDF content whose survival is verified after saving (`packages/pdf-backends/src/embedpdf-adapter.ts:641`, `packages/pdf-backends/src/embedpdf-adapter.ts:686`). Removing links there would conflate “not reviewer feedback” with “not part of the PDF” and weaken preservation checks. The web viewer also renders engine annotations whose type is `LINK` as navigation controls (`apps/web/src/pdf/PdfLinkControl.tsx:151`), so those annotations must remain available outside the review inventory.

## Solution

### Centralize subtype classification

The core package provides a small predicate that normalizes subtype strings (`packages/core/src/pdf-annotation-classification.ts:1`):

```ts
export function isNavigationalPdfAnnotationSubtype(subtype: string): boolean {
  return subtype.trim().toLowerCase() === "link";
}
```

This handles `Link`, `link`, `LINK`, and incidental whitespace consistently across application surfaces.

### Filter at web ingestion and merge boundaries

The web inventory rejects navigational subtype strings before constructing `ExistingAnnotation` records (`apps/web/src/pdf/existing-annotations.ts:46`). Engine-backed discovery rejects `PdfAnnotationSubtype.LINK` before mapping engine objects into source DTOs (`apps/web/src/pdf/existing-annotations.ts:149`).

The merge path defensively applies the same rule to both discovered and explicitly supplied records (`apps/web/src/pdf/existing-annotations.ts:70`):

```ts
for (const annotation of discovered) {
  if (!isNavigationalPdfAnnotationSubtype(annotation.subtype)) {
    merged.set(existingAnnotationKey(annotation), annotation);
  }
}
for (const annotation of explicit) {
  if (isNavigationalPdfAnnotationSubtype(annotation.subtype)) continue;
  // Deduplicate and merge reviewer-facing annotations.
}
```

The second check protects the invariant when a caller bypasses normal engine discovery or supplies already-mapped records.

### Filter before service projection and warnings

`inspectLivePdf` still inspects the complete catalog and identifies app-owned portable annotations by ID. It then creates a reviewer-facing subset that excludes both owned records and navigational links before mapping `ExistingPdfAnnotation` objects (`apps/service/src/context/live-context-service.ts:141`). The missing-normal-appearance warning is computed from that filtered subset (`apps/service/src/context/live-context-service.ts:174`), preventing excluded links from affecting reviewer-facing state indirectly.

### Cover both boundaries with regression tests

The web regression mixes `Link`, `link`, and `LINK` values and verifies that neither discovery nor merging can reintroduce them while an ordinary annotation remains (`apps/web/test/existing-annotations.test.ts:19`). The service regression inspects the hostile-actions PDF fixture and verifies that its navigation links produce no Existing PDF Annotations (`apps/service/test/live-context-service.test.ts:110`).

The implementation session verified 16 focused tests, all 201 service tests, and TypeScript typechecking. The supplied manuscript retained its links in the raw catalog while excluding them from the external inventory.

## Why This Works

The fix encodes the product rule at the correct abstraction boundary: annotation catalogs describe what exists in the PDF, while reviewer inventories describe what should be presented as feedback. A Link belongs in the former but not the latter.

Keeping the catalog complete preserves navigation handling and structural save verification. Filtering immediately before reviewer-facing DTO construction prevents links from acquiring misleading reviewer-facing semantics such as `origin: "source-pdf"` and `readOnly: true` (`apps/service/src/context/live-context-service.ts:157`). Rechecking during web merging preserves the same invariant for alternate inputs, not only the normal engine-discovery path.

The shared predicate prevents the web and service surfaces from drifting in their interpretation of subtype strings. Where the engine exposes a numeric subtype, the web can filter even earlier with `PdfAnnotationSubtype.LINK`; where only a string remains, every consumer uses the same trimmed, case-insensitive rule.

## Prevention

- Treat low-level PDF catalogs as preservation-oriented structures, not presentation-ready inventories. Apply product semantics while projecting catalog records into user-facing models.
- Keep navigation subtype recognition centralized. New reviewer-facing inventory surfaces should call `isNavigationalPdfAnnotationSubtype` rather than add local string comparisons.
- Filter as early as practical, then enforce the invariant again at aggregation boundaries. Early filtering avoids needless mapping; defensive filtering protects callers that supply preconstructed records.
- Compute warnings, counts, and other derived state from the filtered reviewer subset so excluded navigation objects cannot affect the UI indirectly.
- Test representation variance: engine enum values plus normalized string forms such as `Link`, `LINK`, and ` LINK `.
- Retain a link-heavy real-PDF regression with a two-sided assertion: links remain in the raw catalog for navigation and preservation, while reviewer-facing inventories exclude them.

## Related Issues

- [PR #33](https://github.com/brad-ross/placekeeper/pull/33) — pending implementation of this fix.
- [Task-scoped, prompt-refreshed Live PDF Context](../architecture-patterns/task-scoped-prompt-refreshed-live-pdf-context.md) — the service observation boundary affected by the bug.
- [Recoverable, editable PDF annotation autosave](../architecture-patterns/recoverable-editable-pdf-annotation-autosave.md) — why foreign annotations remain in the preservation catalog.
- [Outline-aware annotation workspace presentation](../design-patterns/outline-aware-annotation-workspace-presentation.md) — presentation of reviewer-relevant PDF-sourced annotations.
- [PDF link hit targets and Reference viewer stacking](../ui-bugs/pdf-link-hit-target-escapes-reference-viewer-stacking-context.md) — adjacent Link-annotation behavior with a distinct interaction-layer cause.
