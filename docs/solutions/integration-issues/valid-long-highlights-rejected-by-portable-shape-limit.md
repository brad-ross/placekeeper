---
title: Valid long highlights rejected by the portable annotation shape limit
date: 2026-08-26
category: integration-issues
module: PDF annotation persistence
problem_type: integration_issue
component: service_object
symptoms:
  - A legitimate highlight with 33 segmentRects was accepted as a Review Item but every Save Destination failed while preserving revision 7 in Protected Recovery.
  - Saving to the original PDF and saving to a copy both surfaced a generic write-failed result, and no target copy was created.
  - The Portable Annotation Identity could not round-trip as editable metadata even though the visible geometry and previously saved annotations were structurally valid.
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - Portable Annotation Identity
  - Protected Recovery
  - Save Sync
  - PDF save coordinator
tags:
  - pdf-annotations
  - portable-annotations
  - editable-metadata
  - protected-recovery
  - save-sync
  - segment-rects
  - resource-limits
  - command-validation
---

# Valid long highlights rejected by the portable annotation shape limit

## Problem

Placekeeper could accept a semantically valid highlight and protect it in recovery, yet later fail to save it as editable PDF metadata. In the reproduced incident, revision 7 of a real review contained a page-25 highlight with 33 `segmentRects`; reproduction instrumentation counted 149 object keys in the item and 366 in the portable annotation envelope. (session evidence) The envelope stores both the editable Review Item and a visible projection. The old portable-safety check imposed one 128-key budget over the entire recursive value, so normal repeated geometry exhausted the budget even though the review model accepted the selection. The resulting metadata inspection failure occurred in the save path and fell through to generic `write-failed` classification (`apps/service/src/saving/pdf-save-coordinator.ts:40-54`; `packages/core/src/save-status.ts:1-8`). The historical failure and fix are recorded in [PR #65](https://github.com/brad-ross/placekeeper/pull/65), merged on 2026-08-26.

Two validation domains had been conflated:

- Semantic command validation decides whether a Review Item is a valid highlight: supported payload fields, valid finite positive rectangles, required text fields, and a bounded segment count (`packages/core/src/review-reducer.ts:36-107`).
- Portable envelope safety decides whether the projected editable metadata is safe to parse, traverse, serialize, and round-trip. The envelope includes the item and a second projection of its geometry (`packages/core/src/portable-annotation.ts:31-50`; `packages/core/src/portable-annotation.ts:164-175`; `packages/core/src/annotation-projection.ts:35-73`).

A global recursive key counter scales with representation size, not semantic complexity. Every legitimate selection line adds a rectangle to the item and a corresponding engine rectangle to the projection, so the count grows several keys per segment. That makes a low global key budget an accidental geometry ceiling and makes the same semantic annotation appear more dangerous merely because the backward-compatible envelope duplicates evidence needed to verify editability.

## Symptoms

- In the reproduced incident, a legitimate 33-segment highlight on page 25 was accepted into revision 7 but every save route failed: replace original, locate the PDF, save a copy, and retry after restarting the daemon. (session evidence)
- The same reproduction created no copy, even though the source PDF, its links, and seven previously saved highlights were structurally valid. (session evidence)
- The UI reported generic `write-failed` rather than identifying unsupported editable metadata, because unknown save errors fall through to that classification (`apps/service/src/saving/pdf-save-coordinator.ts:40-54`).
- The old check could return `unsafe-shape` for a semantically valid annotation, and the reproduced incident did so. (session evidence) The regression fixture now captures the same 33-segment, page-25 shape and requires an owned editable round-trip (`packages/core/test/portable-annotation.test.ts:142-167`).
- A recovery draft could therefore contain protected work that could be resumed but not saved without deleting or recreating the new annotation.

## What Didn't Work

Merely raising the old recursive-key constant would have moved the failure without fixing the model. The envelope repeats geometry by design, so a global key threshold would remain coupled to segment count, future schema fields, and representation details. A value large enough for today's longest annotation could also weaken protection for unrelated deeply or broadly structured input.

Removing shape limits entirely would be worse. Portable metadata comes from PDFs and recovery state and must remain bounded before recursive traversal or JSON use. The codec intentionally rejects excessive nesting, aggregate nodes, array width, per-object width, long strings, forbidden prototype-related keys, and oversized UTF-8 JSON (`packages/core/src/portable-annotation.ts:14-22`; `packages/core/src/portable-annotation.ts:84-100`; `packages/core/src/portable-annotation.ts:287-300`; `packages/core/src/portable-annotation.ts:358-369`).

Discarding `segmentRects`, compacting them lossily, or omitting the editable envelope would make the PDF save appear successful while losing precise highlight geometry or Placekeeper editability. The reader verifies that item geometry, portable projection, and visible PDF annotation agree segment-for-segment (`packages/core/src/portable-annotation.ts:229-251`; `packages/core/src/portable-annotation.ts:303-339`). That invariant should not be weakened to conceal an encoding-limit failure.

Relying on the writer to reject the annotation was also too late. Once a command has been acknowledged and persisted as the next recovery revision, a subsequent write failure leaves protected state that cannot reach its destination. The validation must happen before acknowledgment, not only during PDF export.

Boundary measurements also ruled out a 512-segment ceiling. Representative envelopes were about 3.9 KiB at 33 segments, 26.0 KiB at 256, and 51.6 KiB at 512; the existing 32 KiB byte budget therefore rejects 512 before other optional metadata is considered. Choosing 256 preserves useful headroom instead of advertising a semantic limit that the portable representation cannot meet. (session history)

An early dependency-patch generation attempt produced malformed generated JavaScript and a syntax error. Regenerating the patch and syntax-checking the result before rerunning the writer regression prevented that tooling failure from obscuring the application fix. (session history)

## Solution

Replace the representation-sensitive recursive key budget with independent resource budgets and one shared semantic geometry ceiling.

The portable codec now bounds separate dimensions:

```ts
export const PORTABLE_ANNOTATION_MAX_BYTES = 32 * 1024;
const MAX_DEPTH = 12;
const MAX_PORTABLE_ARRAY_ENTRIES = MAX_REVIEW_SELECTION_SEGMENTS;
const MAX_OBJECT_ENTRIES = 128;
const MAX_NODES = 4_096;
const MAX_STRING_LENGTH = 16 * 1024;
```

These limits are defined in `packages/core/src/portable-annotation.ts:14-22`. `hasSafeShape()` charges one node per visited value, caps each array and object independently, rejects forbidden keys, and retains depth and string limits (`packages/core/src/portable-annotation.ts:84-100`). The 32 KiB UTF-8 envelope limit remains a separate serialization bound (`packages/core/src/portable-annotation.ts:287-300`). This permits repeated legitimate rectangle objects without granting an unbounded aggregate structure.

Authoring and portable/recovery interpretation share a 256-segment ceiling through `MAX_REVIEW_SELECTION_SEGMENTS` (`packages/core/src/review-reducer.ts:3`; `packages/core/src/portable-annotation.ts:8-18`). Semantic validation rejects 257 segments with: `Selections can contain at most 256 text segments. Shorten the selection and try again.` (`packages/core/src/review-reducer.ts:68-76`). Portable decoding calls the same Review Item validator with that shared ceiling, preserving existing editable annotations and recovery drafts that were too large for the former accidental recursive-key budget but remain at or below 256 segments (`packages/core/src/portable-annotation.ts:120-141`). Schema version 2 and the envelope layout remain unchanged, so no metadata migration or lossy conversion is required (`packages/core/src/portable-annotation.ts:41-50`; `packages/core/src/portable-annotation.ts:272-285`).

The broker now projects and checks every candidate annotation immediately after reducing a command but before calculating the next digest, persisting the draft, updating in-memory state, or returning acknowledgment:

```ts
const nextState = reduceReview(session.state, command);
projectReviewItems(nextState.items).forEach(assertPortableAnnotationWritable);
```

That ordering is visible in `apps/service/src/sessions/session-broker.ts:1632-1659`. An unsupported command raises `InvalidReviewCommandError`; the service returns HTTP 422 with `kind: "invalid-review-command"` and the specific message (`apps/service/src/server/http-server.ts:653-674`), and the web client surfaces bounded server messages to the author rather than substituting a save failure (`apps/web/src/app/session-api.ts:220-237`). A 257-segment command is proven to leave the revision at zero and return the specific 256-segment guidance (`apps/service/test/session-security.test.ts:711-749`). Envelopes that fit the semantic segment count but exceed the byte budget are likewise rejected before acknowledgment with `This annotation contains too much text or geometry to preserve as editable metadata. Shorten it and try again.` (`apps/service/test/session-security.test.ts:751-789`).

Regression coverage spans each layer:

- The original 33-segment page-25 highlight projects and inspects as owned editable metadata (`packages/core/test/portable-annotation.test.ts:142-167`).
- A 256-segment highlight passes semantic validation, portable inspection, and writable-envelope validation; 257 fails both the portable shape check and writable assertion (`packages/core/test/review-commands.test.ts:163-180`; `packages/core/test/portable-annotation.test.ts:169-207`).
- The real PDF backend writes and reopens editable metadata at 256 segments without losing any geometry (`test/conformance/pdf-writer.conformance.test.ts:285-321`).
- The 33-segment flow saves successfully to both copy and original destinations (`apps/service/test/pdf-save-coordinator.test.ts:181-203`).
- A recovery draft containing the 33-segment annotation resumes and saves, and a revision-7 recovery draft at the shared 256-segment limit retains all 256 rectangles and saves cleanly (`apps/service/test/pdf-save-coordinator.test.ts:205-289`). A recovered redo that would restore 257 segments is rejected before changing revision or history cursor (`apps/service/test/pdf-save-coordinator.test.ts:291-326`).
- A real writer round-trip preserves the new 33-segment highlight, the prior Placekeeper highlight, the source link, both editable items, and the exact visible segment geometry (`test/conformance/pdf-writer.conformance.test.ts:219-283`).

## Why This Works

The design makes each limit correspond to the resource or invariant it protects. The 256-segment ceiling expresses a product-level upper bound on authored highlight complexity. The 256-entry array ceiling prevents wide containers, the 128-entry object ceiling prevents a single pathological map, the 4,096-node ceiling bounds total traversal, depth 12 bounds recursion, 16 KiB bounds individual strings, forbidden-key checks prevent prototype-shaped data, and 32 KiB bounds the serialized portable payload (`packages/core/src/portable-annotation.ts:14-22`; `packages/core/src/portable-annotation.ts:84-100`; `packages/core/src/portable-annotation.ts:287-300`). No one limit has to stand in for all the others.

The shared constant prevents authoring from creating geometry that the portable reader categorically refuses, while the independent byte and node budgets still reject pathological text or metadata even at fewer than 256 segments. Conversely, legacy annotations and recovery drafts between the old accidental boundary and 256 are accepted without changing schema or dropping geometry. The reader continues to require agreement among the stored item, stored projection, and visible annotation, so backward compatibility does not weaken integrity checks (`packages/core/src/portable-annotation.ts:303-339`).

Checking projected portability inside `acceptMutation()` closes the acknowledgment gap. A command either produces a state whose editable annotations can be serialized within supported bounds, or it is rejected while the prior revision remains authoritative (`apps/service/src/sessions/session-broker.ts:1615-1660`). Save Destination choice no longer affects this result, which is why original and copy coverage use the same accepted 33-segment mutation (`apps/service/test/pdf-save-coordinator.test.ts:181-203`).

Finally, the conformance tests verify more than “the write did not throw.” They reopen the generated PDF, recover the editable Review Item, compare all 256 visible rectangles at the maximum, and prove unrelated source links and earlier Placekeeper marks survive the 33-segment write (`test/conformance/pdf-writer.conformance.test.ts:219-321`). That protects both the portable metadata contract and the visible PDF preservation contract.

## Prevention

- Keep semantic limits named and shared. If the authoring ceiling changes, update `MAX_REVIEW_SELECTION_SEGMENTS` and require boundary tests for exactly the maximum and maximum plus one; do not introduce a second portable-only segment constant (`packages/core/src/review-reducer.ts:3`; `packages/core/src/portable-annotation.ts:18`).
- Keep resource dimensions independent. Do not replace node, per-container, depth, string, forbidden-key, and byte checks with a recursive key total. Repeated legitimate collections are expected to grow linearly and should be governed by their semantic or array limit (`packages/core/src/portable-annotation.ts:84-100`).
- Validate the final projected representation before acknowledging any command, including `undo` and `redo`, because recovery history can reintroduce metadata not present in the current item list (`apps/service/src/sessions/session-broker.ts:1632-1659`; `apps/service/test/pdf-save-coordinator.test.ts:291-326`).
- Preserve the editable envelope and exact `segmentRects`; never recover from an envelope-limit bug by silently removing geometry or custom metadata. Keep item/projection/visible-annotation matching tests intact (`packages/core/src/portable-annotation.ts:229-251`; `test/conformance/pdf-writer.conformance.test.ts:267-282`).
- Test three levels for future changes: the real-world regression shape (33), the supported boundary (256), and the first unsupported value (257). Cover core validation, authenticated command error mapping, recovery resume, original and copy destinations, and real PDF reopen (`packages/core/test/portable-annotation.test.ts:142-207`; `apps/service/test/session-security.test.ts:711-789`; `apps/service/test/pdf-save-coordinator.test.ts:181-315`; `test/conformance/pdf-writer.conformance.test.ts:219-321`).
- Treat changes to the portable envelope as compatibility work. Preserve schema version 2 unless a migration and dual-reader plan is intentional, and continue verifying existing source annotations and prior Placekeeper items during round-trip (`packages/core/src/portable-annotation.ts:272-285`; `test/conformance/pdf-writer.conformance.test.ts:219-283`).

## Related Issues

- [Recoverable autosave for editable PDF annotations](../architecture-patterns/recoverable-editable-pdf-annotation-autosave.md) describes the broader recovery-first persistence architecture that this resource-accounting fix must preserve.
- [Portable PDF annotations invisible in external viewers](portable-pdf-annotations-invisible-in-external-viewers.md) covers a sibling portability failure in visible appearances and crop-relative geometry.
- [Exclude Navigation and Owned PDF Annotations from External Inventories](exclude-navigation-links-from-existing-pdf-annotations.md) defines the ownership and foreign-annotation boundary preserved by the long-highlight round trips.
