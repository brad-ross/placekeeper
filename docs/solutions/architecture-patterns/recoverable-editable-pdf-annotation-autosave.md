---
title: Recoverable autosave for editable PDF annotations
date: 2026-08-11
last_updated: 2026-08-21
category: architecture-patterns
module: PDF annotation persistence
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - Adding automatic PDF annotation persistence without a manual export step
  - Restoring app-created annotations as editable Review Items after reopening a PDF
  - Preserving foreign PDF annotations while replacing app-owned annotations
  - Allowing a Save Destination to change while a save may be in flight
  - Keeping accepted annotation changes recoverable after save or location failures
related_components:
  - portable annotation codec
  - EmbedPDF backend
  - recovery snapshot store
  - save destination UI
tags:
  - pdf-annotations
  - autosave
  - portable-annotations
  - protected-recovery
  - destination-generation
  - foreign-annotation-preservation
  - atomic-save
  - crop-relative-geometry
---

# Recoverable autosave for editable PDF annotations

## Context

Routine PDF annotation is ongoing document editing, not a terminal export event. A one-shot Finish flow can protect a private draft while leaving the PDF itself unchanged, and an EmbedPDF commit changes only the in-memory document until the application writes the resulting bytes to a filesystem target.

The implementation merged in PR #19 therefore separates three authorities:

1. `ReviewState` is the semantic truth for app-created annotations. It holds the current Review Items, revision, and history without owning a save path (`packages/core/src/review-model.ts:26-37`).
2. Protected Recovery is the acknowledgement boundary for an accepted mutation. The session broker writes the complete next state and synchronization metadata before publishing the new state in memory (`apps/service/src/sessions/session-broker.ts:1115-1163`).
3. The PDF save coordinator freezes the semantic state, projects it into a complete candidate PDF, verifies it, and independently commits it to the selected Save Destination (`apps/service/src/sessions/session-broker.ts:1084-1113`, `apps/service/src/saving/pdf-save-coordinator.ts:269-380`).

Earlier design and validation work exposed several insufficient shortcuts (session history):

- Asking about saving when a PDF opens interrupts view-only use, while asking only at a terminal Finish step leaves the working PDF stale.
- Revision numbers alone do not fence saves when the destination can change during an in-flight write.
- A visible annotation identifier alone is not ownership evidence because PDFium may synthesize an ID when `/NM` is absent (`packages/pdf-backends/src/embedpdf-adapter.ts:258-266`).
- Reloading the mounted viewer from each saved target would create a second semantic state path and disturb reading position; the viewer remains a projection of `ReviewState` instead (`apps/web/src/app/ProductionReviewApp.tsx:372-375`, `apps/web/src/app/ProductionReviewApp.tsx:876-901`).
- Immediate full rewrites for every command are correct but unnecessarily expensive. Save requests need coalescing because each physical write includes PDF generation, verification, file synchronization, and replacement.
- A first-annotation dialog can race with cancellation or a newer attempt unless every asynchronous completion is revalidated before the pending command is submitted.

## Guidance

### Keep semantic state, recovery durability, and PDF durability separate

Treat `ReviewState.items` as the only editable annotation model. Add, edit, remove, undo, and redo commands pass through the reducer, which validates the expected revision and replaces the complete item set (`packages/core/src/review-reducer.ts:21-27`, `packages/core/src/review-reducer.ts:91-178`). Keep Save Destination and Save Sync beside that model in the durable session envelope rather than embedding filesystem state in Review Items (`apps/service/src/recovery/draft-snapshot.ts:33-43`, `packages/core/src/save-status.ts:9-28`).

The command path must finish its recovery write before acknowledging success. The slower PDF rewrite follows afterward: the HTTP route requests autosave only after `acceptMutation` succeeds and only when a destination is active (`apps/service/src/server/http-server.ts:549-561`). A target failure moves save health to `not-saved`; it does not roll back an accepted Review Item (`apps/service/src/sessions/session-broker.ts:930-952`).

This produces two deliberately different guarantees:

- Protected means the accepted Review Items can be recovered.
- Saved means the selected PDF contains the verified current item set.

### Ask only when editing begins, then persist complete state

A view-only open has no destination decision. The first attempted annotation stays outside canonical state while the UI opens the destination dialog (`apps/web/src/save/save-state-controller.ts:8-16`, `apps/web/src/app/ProductionReviewApp.tsx:1246-1255`). Only after destination establishment succeeds does the UI submit that pending command (`apps/web/src/app/ProductionReviewApp.tsx:1342-1382`).

Destination selection is itself durable state. Establishing or relocating one increments its generation and persists the new destination plus `saving` status on the session's serialized write tail (`apps/service/src/sessions/session-broker.ts:750-763`, `apps/service/src/sessions/session-broker.ts:808-885`). Selecting the original does not rewrite an untouched zero-item PDF; selecting a copy immediately requests a save and creates the copy when that save succeeds (`apps/service/src/saving/pdf-save-coordinator.ts:238-249`).

Each physical save is a full-state projection. The coordinator reads the private immutable source snapshot and writes that canonical base plus all current projected annotations (`apps/service/src/saving/pdf-save-coordinator.ts:256-265`, `apps/service/src/recovery/source-snapshot.ts:16-42`). It does not incrementally patch the previous target. Edit, delete, undo, retry, and destination switching therefore converge to exactly the latest Review Item set rather than accumulating rewrite history.

### Make ownership annotation-local and fail closed

Every app annotation carries ordinary visible PDF properties plus a namespaced, versioned `placekeeper` envelope containing the stable item ID, the semantic Review Item, and redundant visible projection evidence (`packages/core/src/annotation-projection.ts:47-70`, `packages/core/src/portable-annotation.ts:25-45`, `packages/core/src/portable-annotation.ts:261-273`). The pinned EmbedPDF path persists the annotation ID through `/NM` and custom metadata through `/EPDFCustom`; the checked-in engine patch bounds custom metadata before parsing (`packages/pdf-backends/src/embedpdf-adapter.ts:110-122`, `patches/@embedpdf__engines@2.14.4.patch:7-32`).

Ownership requires redundant agreement. Import accepts an annotation only when its envelope has the supported owner and schema, contains a valid item and projection, has a unique visible ID, and matches the visible page, subtype, contents, author, and geometry (`packages/core/src/portable-annotation.ts:276-312`). Missing metadata is foreign. Malformed or mismatched metadata is invalid, never owned. Size, depth, key-count, string-length, and prototype-key limits bound untrusted metadata (`packages/core/src/portable-annotation.ts:10-16`, `packages/core/src/portable-annotation.ts:78-90`, `packages/core/src/portable-annotation.ts:331-344`).

On rewrite, the backend removes only annotations that pass this ownership test, creates the complete current owned set, and leaves Existing PDF Annotations in place (`packages/pdf-backends/src/embedpdf-adapter.ts:641-680`). It then reopens the candidate and rejects it if foreign annotations changed, requested marks are missing, normal appearances are absent, or portable metadata does not reconstruct the requested items (`packages/pdf-backends/src/embedpdf-adapter.ts:681-718`). The independent verifier also checks page fingerprints, foreign inventory, owned identities, geometry, appearances, and writer evidence before a filesystem commit (`apps/service/src/export/pdf-verifier.ts:114-221`).

Identity is not appearance. Generic PDF viewers depend on the standard annotation subtype, crop-relative geometry, and explicit normal appearance; the private envelope exists so Placekeeper can recognize and edit the same mark later. Capture, overlay rendering, ordering, portable metadata, and the writer now use crop-relative page coordinates, while schema-v1 CropBox-offset state is migrated once on import or recovery (`packages/core/src/review-model.ts:26-29`, `packages/pdf-backends/src/embedpdf-adapter.ts:290-418`, `apps/service/src/sessions/session-broker.ts:348-445`). The writer rejects an annotation when its enclosing rectangle or any text segment falls outside that crop-relative page canvas (`packages/pdf-backends/src/embedpdf-adapter.ts:535-571`).

### Serialize, coalesce, verify, and fence every commit

Maintain one draining save loop per session. A request sets a `requested` bit; mutations arriving while a save runs collapse into a later pass over the newest frozen state (`apps/service/src/saving/pdf-save-coordinator.ts:238-249`). Different sessions that target the same path are serialized with a target lock (`apps/service/src/saving/pdf-save-coordinator.ts:25-38`, `apps/service/src/saving/pdf-save-coordinator.ts:269-380`).

The effective save identity is:

```text
(sessionId, targetGeneration, reviewRevision, stateDigest)
```

The commit sequence is:

```text
freeze current ReviewState
write immutable source + complete current annotations
reopen and verify candidate
write and fsync a same-directory temporary file
under the session write tail:
  reject if targetGeneration is no longer current
  revalidate target capability and fingerprint
  atomically rename temporary -> target
  sync the containing directory
  mark clean only if reviewRevision and stateDigest are still desired
otherwise queue the newest desired state again
```

The coordinator synchronizes the temporary file before calling `commitSaveCandidate`. Its commit callback revalidates original or copy authority, atomically renames the candidate, synchronizes the directory, and refreshes the target digest (`apps/service/src/saving/pdf-save-coordinator.ts:269-380`). The broker checks the destination generation while holding the same serialized session tail, then records whether revision and digest are still current (`apps/service/src/sessions/session-broker.ts:906-927`). A stale generation discards the temporary file; a valid commit of an older state immediately schedules another pass.

### Let recovery converge through evidence

Recovery stores checksummed current and previous generations with temporary-file synchronization, atomic rename, directory synchronization, and fallback to the highest valid revision (`apps/service/src/recovery/draft-snapshot.ts:47-69`, `apps/service/src/recovery/draft-snapshot.ts:117-195`). Its record contains complete semantic state, the canonical source snapshot path, destination, target fingerprint, and desired/saved synchronization watermarks (`apps/service/src/recovery/draft-snapshot.ts:33-43`).

On restart, only non-clean drafts matching an approved source or target identity are recovery candidates (`apps/service/src/sessions/session-broker.ts:283-335`). Resume validates the immutable source, migrates legacy annotation geometry, rebinds an original to a newly approved file capability, and reauthorizes a copy only when its fingerprint still matches (`apps/service/src/sessions/session-broker.ts:348-445`). A missing or changed target keeps the semantic work protected but becomes visibly `not-saved` until the user retries, locates the PDF, or selects a new destination; invalid annotation geometry instead offers a return to annotations so the item can be repaired (`apps/web/src/save/SaveDestinationDialog.tsx:76-123`). Clean desired/saved evidence suppresses a later recovery prompt without relying on browser unload or a Finish action (`apps/service/src/sessions/session-broker.ts:1279-1291`).

## Why This Matters

This architecture makes save status meaningful without making annotation entry block on a full PDF rewrite. Recovery-first acknowledgement protects work quickly; the coalesced writer lets the visible PDF catch up. A red or missing target does not masquerade as saved, and a slow prior save cannot bless or overwrite a newly selected destination.

Full-state projection from an immutable source avoids cumulative rewrite drift and makes deletion deterministic. Removing the final Owned Annotation produces a PDF with no app-owned metadata while foreign highlights and stamps remain intact (`test/conformance/pdf-writer.conformance.test.ts:166-215`).

Annotation-local, redundantly validated identity preserves editability, while the public annotation representation preserves interoperability. Other PDF readers receive ordinary annotations with crop-relative geometry and normal appearances without understanding the private envelope; Placekeeper can still reconstruct the semantic Review Items after a move, rename, or transfer. Tests cover each supported kind, reject mismatched or duplicate evidence, recreate imported state with fresh local history, and exercise cropped pages at all four rotations (`packages/core/test/portable-annotation.test.ts:42-80`, `packages/core/test/portable-annotation.test.ts:124-147`, `test/conformance/pdf-writer.conformance.test.ts:105-164`, `test/conformance/pdf-writer.conformance.test.ts:218-283`).

No single test layer proves this contract. Core tests prove identity validation, service tests prove save/recovery state transitions, PDF conformance tests prove write/reopen behavior, and browser tests prove the first-command gate and visible status. A manual render in a viewer outside the app is also necessary: a Saved label and a successful PDFium reopen do not by themselves prove that another viewer paints the expected appearance. The generated five-annotation golden PDF was checked through Poppler and macOS PDFKit during PR #21 verification (session history).

## When to Apply

Use this pattern when:

- A responsive semantic editor materializes changes into a comparatively slow document format.
- Users can redirect persistence between durable targets while writes are in flight.
- App-created objects must remain editable after reopen while foreign objects remain untouched.
- Output must stay interoperable with tools that ignore application-specific metadata.
- Crash recovery must retain accepted work without claiming that the user-visible file is current.
- Retrying after a moved, missing, changed, or unwritable target should converge idempotently to the newest complete state.

Do not substitute a revision-only marker, an in-memory viewer commit event, the prior output bytes, or a visible object ID for this design. Each signal covers only one dimension of truth. Durable correctness requires semantic digest, target generation and identity, verified bytes, atomic replacement, and recovery evidence to agree.

## Examples

### First annotation saved to a copy

1. The user opens and reads the PDF without a save prompt.
2. The first annotation command is held pending and the dialog proposes an annotated-copy filename (`apps/web/src/save/save-state-controller.ts:8-16`, `apps/service/src/saving/save-destination.ts:5-15`).
3. After destination capability and generation are persisted, the pending command is submitted once (`apps/web/src/app/ProductionReviewApp.tsx:1342-1382`).
4. Recovery records the new ReviewState before autosave writes, verifies, and atomically commits the copy (`apps/service/src/sessions/session-broker.ts:1115-1163`, `apps/service/src/server/http-server.ts:549-561`).

### Rapid edits during an in-flight save

If revision 4 is being rendered when revisions 5 and 6 are accepted, both later commands are already protected in recovery. Their requests set the same queue's `requested` bit rather than creating parallel writers. Revision 4 may commit to the current target, but it cannot make synchronization clean because its revision and digest are no longer desired. The next pass freezes revision 6; revision 5 need never exist as physical PDF bytes (`apps/service/src/saving/pdf-save-coordinator.ts:238-249`, `apps/service/src/sessions/session-broker.ts:906-927`).

### Destination switch during an old save

If a generation-2 copy save is in flight when the user selects the original, destination establishment persists generation 3. The generation-2 candidate fails its commit fence under the session tail and its temporary file is removed. The generation-3 request writes the complete latest state to the original (`apps/service/src/sessions/session-broker.ts:906-927`, `apps/service/src/saving/pdf-save-coordinator.ts:269-380`).

### Reopen, edit, delete, and recover

When an annotated PDF is reopened without private recovery data, valid portable envelopes become a fresh revision-0 ReviewState. If rewriting is allowed, that PDF becomes the active original destination already marked clean (`apps/service/src/sessions/session-broker.ts:325-390`, `apps/service/test/recovery.test.ts:513-539`). Later edits and deletes follow the same complete-state autosave path. If the target moves while work is pending, restart recovery restores the semantic state, reports `not-saved`, and lets the user locate or replace the destination (`apps/service/test/recovery.test.ts:368-403`, `apps/service/test/recovery.test.ts:446-511`).

## Related

- [Adaptive annotation tray framing](adaptive-annotation-tray-framing.md) applies the sibling pattern of coalescing latest work and invalidating stale asynchronous completions to viewer geometry rather than file persistence.
- [Content-aware annotation workspace presentation](../design-patterns/outline-aware-annotation-workspace-presentation.md) shows the same fail-closed generation principle for document-derived UI state.
- [Compact Editorial language for review task surfaces](../design-patterns/compact-editorial-language-for-annotation-modals.md) defines the recovery dialog's presentation and action language while preserving these persistence transitions.
- [Portable PDF annotations invisible in external viewers](../integration-issues/portable-pdf-annotations-invisible-in-external-viewers.md) documents the narrower appearance and crop-relative geometry failure that PR #21 corrected without changing this broader autosave architecture.
- PR #19 contains the implementation described here and merged into `main` on 2026-08-11 (America/New_York).
