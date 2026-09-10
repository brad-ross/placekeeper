---
title: Exclude Navigation and Owned PDF Annotations from External Inventories
date: 2026-08-14
last_updated: 2026-09-10
category: integration-issues
module: pdf_annotation_inventory
problem_type: integration_issue
component: service_object
symptoms:
  - PDF Link annotations appeared as read-only Existing PDF Annotations in the web annotation tray and Live PDF Context.
  - Placekeeper annotations reopened from a saved copy appeared once as editable Review Items and again as read-only Existing PDF Annotations.
  - The Annotation Tray could present duplicate entries with different editability for the same visible PDF mark.
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - frontend_stimulus
  - portable annotation codec
  - testing_framework
tags:
  - pdf-annotations
  - navigation-links
  - existing-annotations
  - portable-annotations
  - owned-annotations
  - annotation-inventory
  - async-discovery
  - regression-tests
---

# Exclude Navigation and Owned PDF Annotations from External Inventories

## Problem

A PDF annotation catalog answers what physically exists in a document; an Existing PDF Annotation inventory answers what should be presented as foreign, read-only reviewer feedback. Treating the broad catalog as presentation-ready caused two related classification bugs:

- Navigational Link annotations appeared as external reviewer annotations. [PR #33](https://github.com/brad-ross/placekeeper/pull/33), merged on 2026-08-14, established that navigation affordances stay in the PDF catalog but outside reviewer inventories.
- Placekeeper-owned annotations in a saved copy were correctly reconstructed as editable Review Items and independently rediscovered as read-only Existing PDF Annotations. [PR #59](https://github.com/brad-ross/placekeeper/pull/59), merged on 2026-08-24, corrected that second classification path.

The second bug was not a duplicate portable import. On open, validated portable metadata reconstructs Review Items (packages/pdf-backends/src/embedpdf-adapter.ts), while the web viewer independently discovers reviewer-facing annotation candidates (apps/web/src/pdf/existing-annotations.ts). Before PR #59, that web path did not subtract the already-owned identities, so the same visible PDF object acquired both editable and external/read-only meanings.

## Symptoms

- Link-heavy PDFs populated reviewer-facing inventories with navigation objects rather than comments, highlights, or other review markup.
- Reopening a Placekeeper-authored copy populated both the editable annotation list and the Existing PDF Annotations list with the same marks.
- The duplicate external entry was deliberately display-only because the Existing Annotation DTO has no conversion to canonical Review Items (apps/web/src/pdf/existing-annotations.ts).
- Existing focused tests exercised portable import and annotation inventory independently without asserting that their resulting populations were disjoint, so the pre-fix suites passed despite the duplicate presentation (session history).

## What Didn't Work

Filtering excluded annotations out of the low-level catalog would conflate “not external reviewer feedback” with “not part of the PDF.” Links remain necessary for navigation. Owned annotations remain necessary for rendering, preservation checks, replacement, and portable reopen verification: the writer identifies validated owned records, preserves foreign records, replaces only changed owned records, and reopens the saved bytes to verify the result (packages/pdf-backends/src/embedpdf-adapter.ts).

Fixing or deduplicating the imported Review State would target the correct editable entry rather than the erroneous external projection. Portable import occurs once; the duplicate came from a separate viewer inventory path (session history).

Visible fields are also insufficient ownership evidence:

- Author text alone is not ownership evidence: a visible Placekeeper author without a valid portable envelope is classified as foreign.
- A visible annotation ID alone can collide across pages.
- Missing private metadata is explicitly foreign, while malformed or mismatched metadata is invalid (packages/core/src/portable-annotation.ts).

Foreign origin does not itself imply read-only status. Supported native annotations now enter Review State through a separate import-and-writeback contract, with comment and deletion permissions and dictionary-preserving saves. Other reviewer-relevant records that can be inventoried remain read-only Existing PDF Annotations. This does not loosen portable ownership validation (`packages/pdf-backends/src/native-annotations.ts`; `packages/core/src/portable-annotation.ts`).

Finally, recomputing ownership from the latest editable state on every asynchronous retry would be temporally wrong. Editing or deleting an imported Review Item does not retroactively remove its original visible annotation from the already-open source document. A retry that used later application state could reclassify that source-owned mark as foreign.

## Solution

### Keep the raw catalog broad and narrow each reviewer projection

Navigation classification remains centralized and representation-tolerant:

~~~ts
export function isNavigationalPdfAnnotationSubtype(subtype: string): boolean {
  return subtype.trim().toLowerCase() === 'link';
}
~~~

The web inventory maps engine annotations, then excludes navigation and auxiliary Popup/Widget/XFAWidget records before producing reviewer records; merging rechecks navigation and exact managed identities (apps/web/src/pdf/existing-annotations.ts). The service likewise inspects the complete catalog, then excludes portable-owned projection IDs (including grouped children), native source annotation IDs, navigation subtypes, and auxiliary records before it creates Live PDF Context records or warnings (apps/service/src/context/live-context-service.ts).

### Subtract exact owned identities at the external merge boundary

PR #59 extended the web merge with the owned projection. The boundary uses the same composite key as inventory deduplication:

~~~ts
export function existingAnnotationKey(
  annotation: Pick<ExistingAnnotation, 'id' | 'pageIndex'>,
): string {
  return annotation.pageIndex + ':' + annotation.id;
}

const ownedKeys = new Set(owned.map(existingAnnotationKey));
~~~

Discovered and explicitly supplied annotations must both pass navigation and owned-key checks (apps/web/src/pdf/existing-annotations.ts). Filtering both inputs prevents an embedding surface or test harness from bypassing the normal engine-discovery invariant.

~~~ts
for (const annotation of discovered) {
  if (
    !ownedKeys.has(existingAnnotationKey(annotation)) &&
    !isNavigationalPdfAnnotationSubtype(annotation.subtype)
  ) {
    merged.set(existingAnnotationKey(annotation), annotation);
  }
}

for (const annotation of explicit) {
  if (isNavigationalPdfAnnotationSubtype(annotation.subtype)) continue;
  const key = existingAnnotationKey(annotation);
  if (!ownedKeys.has(key) && !merged.has(key)) merged.set(key, annotation);
}
~~~

ExistingAnnotationDiscoveryAuthority.ready carries the same owned set across asynchronous completion (apps/web/src/pdf/existing-annotations.ts), and the standalone renderer supplies owned annotations when it assembles the displayed list (apps/web/src/app/App.tsx).

### Freeze ownership for the source document across retries

The viewer stores the source-owned (id, pageIndex) pairs in a WeakMap keyed by the concrete PDF document object. The first inventory read snapshots them; later retries for the same object reuse that snapshot (apps/web/src/app/App.tsx).

~~~ts
let owned = sourceOwnedAnnotations.current.get(document);
if (owned === undefined) {
  owned = ownedAnnotationsRef.current.map(({ id, pageIndex }) => ({ id, pageIndex }));
  sourceOwnedAnnotations.current.set(document, owned);
}
~~~

This binds classification to the source being inventoried rather than to later React state. A genuinely new document object establishes a new snapshot.

### Test the semantic exclusions, not just raw deduplication

The web Link regression checks Link, link, and LINK string forms, while a service fixture covers engine-backed catalog filtering (apps/web/test/existing-annotations.test.ts, apps/service/test/live-context-service.test.ts). The owned regression supplies an owned annotation on page 0 and a foreign annotation with the same ID on page 1 and author Placekeeper; only the exact owned key is removed, while 1:owned remains (apps/web/test/existing-annotations.test.ts).

Local validation for PR #59 passed TypeScript typechecking, 244 Vitest tests, and 33 Playwright review workflows. GitHub Actions did not execute any steps because the repository account's billing or spending-limit setting blocked the job, so remote CI was not green at documentation time.

## Why This Works

The classification preserves distinct authorities:

~~~text
raw PDF catalog
  - navigation objects -> navigation and preservation only
  - validated portable identity -> editable Review Item / Owned Annotation
  - supported native import -> editable native Review Item
  - remaining reviewer-relevant objects -> read-only Existing PDF Annotation
~~~

Portable validation remains the sole authority for recognizing app-authored portable ownership; native editing authority is established separately. It requires supported private metadata, a valid Review Item and projection, an unambiguous visible ID, and agreement with visible page and projection evidence (packages/core/src/portable-annotation.ts). The web layer does not attempt to rediscover ownership from author, subtype, appearance, or ID alone; it subtracts exact managed identities established by portable or native import.

The source annotation set stays intact for rendering, navigation, preservation, and serialized-artifact verification. Product semantics are applied only as records cross into reviewer-facing DTOs. Rechecking every aggregation input keeps the invariant independent of the source path.

The per-document snapshot makes asynchronous classification stable: it answers whether a visible annotation was owned in the source PDF when that document object was opened, not whether the latest editable state still contains the item. This mirrors the broader rule that values spanning asynchronous document work must be captured as one semantic snapshot rather than recombined from different moments.

## Prevention

- Treat low-level PDF catalogs as preservation-oriented structures, never presentation-ready reviewer inventories.
- Keep portable-envelope validation as the sole authority for recognizing an annotation recovered from a source PDF as Placekeeper-owned. Do not infer ownership from author text, subtype, appearance, or ID alone.
- Apply product semantics at every reviewer-facing projection: remove navigation-only annotations and exact managed (pageIndex, id) identities.
- Filter as early as practical, then enforce the invariant again for every aggregation input and for derived warnings or counts.
- Bind asynchronous classification inputs to the document object being read. Retries reuse the source ownership snapshot; a new source establishes a new snapshot.
- Test representation variance and identity scope: Link casing/whitespace, the same ID on different pages, and a foreign annotation claiming the Placekeeper author.
- Retain an end-to-end reopen assertion in addition to focused inventory tests: a saved copy should reopen with one editable entry and no duplicate external entry.
- For each extension to native editing, retain explicit supported subtypes, canonical Review Item reconstruction, unsupported-field preservation, edit/delete writeback, and external-reader round-trip evidence.

### Native imports extend the managed population

Native source objects receive the same canonical item identities used by the editable tray, while `sourceId` preserves their engine identity for rendering (`apps/web/src/pdf/existing-annotations.ts`). The service also subtracts inspected native annotations from residual Live PDF Context records (`apps/service/src/context/live-context-service.ts`). Keep the raw catalog broad and both reviewer-facing populations disjoint. The [autosave learning](../architecture-patterns/recoverable-editable-pdf-annotation-autosave.md) describes the successful-source-import evidence required before a missing native item can authorize deletion.

## Related Issues

- [PR #59](https://github.com/brad-ross/placekeeper/pull/59) — merged implementation of owned-annotation exclusion and source-scoped retry ownership.
- [PR #33](https://github.com/brad-ross/placekeeper/pull/33) — merged implementation of navigation-link exclusion.
- [Recoverable, editable PDF annotation autosave](../architecture-patterns/recoverable-editable-pdf-annotation-autosave.md) — portable ownership, fail-closed import, and foreign-annotation preservation.
- [Portable PDF annotations invisible in external viewers](portable-pdf-annotations-invisible-in-external-viewers.md) — public PDF representation enables external rendering while private portable identity enables Placekeeper editing.
- [Valid long highlights rejected by the portable annotation shape limit](valid-long-highlights-rejected-by-portable-shape-limit.md) — independent portable resource budgets and exact geometry preservation at the authoring boundary.
- [Reject stale viewer selection snapshots](../ui-bugs/reject-stale-viewer-selection-snapshots.md) — the related async-snapshot rule for text and geometry capture.
- [Outline-aware annotation workspace presentation](../design-patterns/outline-aware-annotation-workspace-presentation.md) — user-facing separation of editable annotations and external PDF annotations.
