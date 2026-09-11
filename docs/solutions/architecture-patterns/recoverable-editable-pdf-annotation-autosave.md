---
title: Recoverable autosave for editable PDF annotations
date: 2026-08-11
last_updated: 2026-09-10
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

1. `ReviewState` is the semantic truth for app-created annotations. It holds the current Review Items, revision, and history without owning a save path (`packages/core/src/review-model.ts`).
2. Protected Recovery is the acknowledgement boundary for an accepted mutation. The session broker writes the complete next state and synchronization metadata before publishing the new state in memory (`apps/service/src/sessions/session-broker.ts`).
3. The PDF save coordinator freezes the semantic state, projects it into a complete candidate PDF, verifies it, and independently commits it to the selected Save Destination (`apps/service/src/sessions/session-broker.ts`, `apps/service/src/saving/pdf-save-coordinator.ts`).

Earlier design and validation work exposed several insufficient shortcuts (session history):

- Asking about saving when a PDF opens interrupts view-only use, while asking only at a terminal Finish step leaves the working PDF stale.
- Revision numbers alone do not fence saves when the destination can change during an in-flight write.
- A visible annotation identifier alone is not ownership evidence because PDFium may synthesize an ID when `/NM` is absent (`packages/pdf-backends/src/embedpdf-adapter.ts`).
- Reloading the mounted viewer from each saved target would create a second semantic state path and disturb reading position; the viewer remains a projection of `ReviewState` instead (`apps/web/src/app/ProductionReviewApp.tsx`).
- Immediate full rewrites for every command are correct but unnecessarily expensive. Save requests need coalescing because each physical write includes PDF generation, verification, file synchronization, and replacement.
- A first-annotation dialog can race with cancellation or a newer attempt unless every asynchronous completion is revalidated before the pending command is submitted.

Current preparation owners are `apps/service/src/sessions/approved-open-preparation.ts` for source import, initial state, destination, and sync candidates, and `recovered-review-preparation.ts` for integrity checks, geometry migration, and native import across undo history. The broker retains destination reauthorization, persistence, and activation. On the client, `apps/web/src/save/use-save-destination.ts` owns pending local commands and destination attempts. Generated-output and ephemeral reviews submit directly; remote-temporary reviews submit first and then ask for a destination (`save-state-controller.ts`).

## Guidance

### Keep semantic state, recovery durability, and PDF durability separate

Treat `ReviewState.items` as the only editable annotation model. Add, edit, remove, undo, and redo commands pass through the reducer, which validates the expected revision and replaces the complete item set (`packages/core/src/review-reducer.ts`). Keep Save Destination and Save Sync beside that model in the durable session envelope rather than embedding filesystem state in Review Items (`apps/service/src/recovery/draft-snapshot.ts`, `packages/core/src/save-status.ts`).

The command path must finish its recovery write before acknowledging success. `acceptMutation` reduces the command, validates portable annotations, records the desired revision/digest and save state, and persists the recoverable draft; it does not itself schedule a PDF rewrite (`apps/service/src/sessions/session-broker.ts`). Each service-backed transport must request that slower work after successful acceptance and only when the destination is active. Both the HTTP route and the shared Chrome/Mac backend now call `requestSave` without awaiting PDF completion (`apps/service/src/server/http-server.ts`, `apps/service/src/browser/chrome-runtime-backend.ts`). Protection of accepted Review Items and successful persistence into the selected PDF remain distinct guarantees.

This produces two deliberately different guarantees:

- Protected means the accepted Review Items can be recovered.
- Saved means the selected PDF contains the verified current item set.

### Carry persistence obligations across transport seams

An accepted annotation followed by a save indicator stuck at `saving` can mean that no save was scheduled, rather than that the PDF writer is slow. In this failure, the HTTP route requested autosave after accepting a mutation, but the shared native backend omitted that step. The broker correctly persisted the accepted review and marked an active destination as needing a newer revision; nothing then asked the PDF coordinator to deliver it (`apps/service/src/sessions/session-broker.ts`, `apps/service/src/server/http-server.ts`). The backend named for Chrome also serves Mac, so the omission affected native Mac commands despite the HTTP implementation being correct (`apps/service/src/host/placekeeper-host.ts`).

The backend command path now awaits acceptance, checks the active destination, and schedules `void this.#saving.requestSave(record.sessionId)` before returning the accepted result (`apps/service/src/browser/chrome-runtime-backend.ts`). This ordering preserves the fast recovery-backed edit response: it does not wait for PDF generation, verification, or replacement. It also prevents a rejected mutation from reaching the scheduling call and avoids scheduling for an unconfigured destination. The coordinator owns batching: requests set one per-session requested bit, share the running drain, and allow a later pass over the newest state instead of launching a new writer for each command (`apps/service/src/saving/pdf-save-coordinator.ts`). The drain independently checks the active destination before freezing delivery (`apps/service/src/saving/pdf-save-coordinator.ts`).

Keep scheduling inside the journaled mutation effect, not after every replayed response. The service authority wraps side-effecting delegate invocation in the operation journal (`apps/service/src/browser/chrome-runtime.ts`). The journal returns a matching cached or persisted outcome before invoking the effect; a new operation persists pending evidence, invokes the backend, and then persists its completed result (`apps/service/src/browser/runtime-operation-journal.ts`). Within that effect, the backend establishes the recovery protection boundary before acceptance and schedules only after acceptance succeeds (`apps/service/src/browser/chrome-runtime-backend.ts`). Thus an identical operation replay neither reapplies the command nor schedules an extra save. PDF completion is not part of the journaled command result: it remains the coordinator's separate asynchronous obligation.

The focused regression holds the save promise unresolved while invoking an annotation command and verifies that revision 1 returns anyway. Repeating the same operation identity returns revision 1 with only one save request; a distinct undo command returns revision 2 and schedules the second request (`apps/service/test/runtime-retention.test.ts`). This proves nonblocking scheduling, replay suppression, and coverage beyond creation. It does not exercise an actual PDF write: the coordinator is deliberately spied on, so physical writing, coalescing, verification, and failure handling still require their existing coordinator coverage. The active-destination and acceptance ordering are code guards; add explicit negative scheduling assertions when changing those branches rather than claiming this test already covers them.

When adding another service-backed transport, review the whole command boundary: generation/revision validation, durable acceptance, idempotent effect ownership, active-destination scheduling, and a response that does not await PDF work. Calling the same reducer or broker method is insufficient if the surrounding persistence obligation is dropped.

### Ask only when editing begins, then persist complete state

A view-only open has no destination decision. In a local annotation review without a destination, the first attempted annotation stays outside canonical state while the UI opens the destination dialog (`apps/web/src/save/save-state-controller.ts`, `apps/web/src/app/ProductionReviewApp.tsx`). Only after destination establishment succeeds does the UI submit that pending command (`apps/web/src/app/ProductionReviewApp.tsx`).

Destination selection is itself durable state. Establishing or relocating one increments its generation and persists the new destination plus `saving` status on the session's serialized write tail (`apps/service/src/sessions/session-broker.ts`). Selecting the original does not rewrite an untouched zero-item PDF; selecting a copy immediately requests a save and creates the copy when that save succeeds (`apps/service/src/saving/pdf-save-coordinator.ts`).

Each physical save is a full-state projection. The coordinator reads the private immutable source snapshot and writes that canonical base plus all current projected annotations (`apps/service/src/saving/pdf-save-coordinator.ts`, `apps/service/src/recovery/source-snapshot.ts`). It does not incrementally patch the previous target. Edit, delete, undo, retry, and destination switching therefore converge to exactly the latest Review Item set rather than accumulating rewrite history.

### Make ownership annotation-local and fail closed

Every app annotation carries ordinary visible PDF properties plus a namespaced, versioned `placekeeper` envelope containing the stable item ID, the semantic Review Item, and redundant visible projection evidence (`packages/core/src/annotation-projection.ts`, `packages/core/src/portable-annotation.ts`). The pinned EmbedPDF path persists the annotation ID through `/NM` and custom metadata through `/EPDFCustom`; the checked-in engine patch bounds custom metadata before parsing (`packages/pdf-backends/src/embedpdf-adapter.ts`, `patches/@embedpdf__engines@2.14.4.patch:7-32`).

Ownership requires redundant agreement. Import accepts an annotation only when its envelope has the supported owner and schema, contains a valid item and projection, has a unique visible ID, and matches the visible page, subtype, contents, author, and geometry (`packages/core/src/portable-annotation.ts`). Missing metadata is foreign. Malformed or mismatched metadata never grants portable ownership; editable import can recover independent valid groups and import the remaining standard annotations through the native path below. Independent byte, depth, aggregate-node, per-array, per-object, string-length, and prototype-key limits bound untrusted metadata without treating repeated legitimate highlight geometry as one flat key budget (`packages/core/src/portable-annotation.ts`).

Validate that final portable projection before acknowledging a mutation. The shared 256-segment authoring and portable ceiling rejects an unsupported highlight as a specific invalid command, while the writable-envelope check catches byte or shape excess before the next recovery revision becomes authoritative (`packages/core/src/review-reducer.ts`, `packages/core/src/portable-annotation.ts`, `apps/service/src/sessions/session-broker.ts`). This preserves the recovery-first contract: accepted work must be representable as editable metadata, not merely semantically valid in memory.

For the portable-owned portion of a rewrite, the backend preserves semantically unchanged owned annotations, replaces changed ones, and preserves the unmanaged source remainder; managed native edits use the separate dictionary-preserving path below (`packages/pdf-backends/src/embedpdf-adapter.ts`). It then reopens the candidate and rejects it if unmanaged source annotations changed, requested marks are missing, required app-authored normal appearances are absent, or portable metadata does not reconstruct the requested items (`packages/pdf-backends/src/embedpdf-adapter.ts`). The independent verifier also checks page fingerprints, foreign inventory, owned identities, geometry, appearances, and writer evidence before a filesystem commit (`apps/service/src/export/pdf-verifier.ts`).

Identity is not appearance. Generic PDF viewers depend on the standard annotation subtype, crop-relative geometry, and explicit normal appearance; the private envelope exists so Placekeeper can recognize and edit the same mark later. Capture, overlay rendering, ordering, portable metadata, and the writer now use crop-relative page coordinates, while schema-v1 CropBox-offset state is migrated once on import or recovery (`packages/core/src/review-model.ts`, `packages/pdf-backends/src/embedpdf-adapter.ts`, `apps/service/src/sessions/session-broker.ts`). The writer rejects an annotation when its enclosing rectangle or any text segment falls outside that crop-relative page canvas (`packages/pdf-backends/src/embedpdf-adapter.ts`).

### Editing authority does not transfer drawing ownership

A normalized native Review Item is a narrow editing interface, not a complete serialization of its source dictionary. Treating every editable item as a drawing to recreate would lose information that Placekeeper never imported. Treating import failure as an empty desired inventory would instead turn uncertainty into delete-all.

For native annotations, change the original PDF dictionaries in place. Keep geometry, author, appearance streams, colors, opacity, attachment data, and other subtype-specific material outside the comment-edit contract. The implementation rejects changes to page, subtype, author, or rectangle before changing `/Contents` and `/M`; when the comment changes it removes `/RC` so rich-text readers cannot display the previous comment (`packages/pdf-backends/src/native-annotations.ts`). This path deliberately supports comment edits and deletion rather than promising to recreate arbitrary foreign drawings.

Use the visible annotation as the fallback when private portable metadata no longer validates. Import recovers independently valid portable groups and treats the remainder as foreign, then imports supported native marks (`packages/core/src/portable-annotation.ts`; `packages/pdf-backends/src/embedpdf-adapter.ts`). An external edit must not disappear or revert merely because it invalidates an older Placekeeper projection. When saving such a native annotation, remove only the stale `placekeeper` member of `/EPDFCustom`, retaining other applications' custom data (`packages/pdf-backends/src/native-annotations.ts`). Strict portable-only reading remains a separate mode; do not weaken validation globally to accommodate external edits.

Treat an empty imported inventory and an unsuccessful import as different states. Absence from the requested list authorizes deletion only after a successful native import of these exact source bytes. The broker records `nativeAnnotationImportDigest`, and enables native inventory management only when it matches `state.source.digest` (`apps/service/src/sessions/session-broker.ts`). Recovery retries an unproven import; on failure it preserves source annotations. On success it adds newly imported marks to both current items and every undo snapshot so an unrelated undo cannot silently turn them into deletions (`apps/service/src/sessions/session-broker.ts`).

Use standard `/NM` for identity across readers, including readers that strip private metadata. Unnamed marks initially receive deterministic page/enumeration identities; first save records the persistent native name. Duplicate persistent identities are excluded because ambiguity cannot authorize an edit or deletion (`packages/core/src/native-pdf-annotation.ts`; `packages/pdf-backends/src/native-annotations.ts`). Distinguish comment locks from deletion locks; the importer records both and the writer enforces each operation (`packages/pdf-backends/src/native-annotations.ts`).

Deleting a parent also removes its popup, but surviving replies are detached into standalone comments rather than discarded (`packages/pdf-backends/src/native-annotations.ts`). Finally, reopen the result and verify the requested native inventory, comments, authors, subtypes, pages, and geometry before reporting export success (`packages/pdf-backends/src/native-annotations.ts`).

The native preservation regression in `packages/pdf-backends/test/native-annotations.test.ts` edits a foreign highlight while checking its original appearance, color, opacity, and author. The application round trips and their limits are recorded in [the PDF conformance matrix](../../pdf-conformance-matrix.md).

### Serialize, coalesce, verify, and fence every commit

Maintain one draining save loop per session. A request sets a `requested` bit; mutations arriving while a save runs collapse into a later pass over the newest frozen state (`apps/service/src/saving/pdf-save-coordinator.ts`). Different sessions that target the same path are serialized with a target lock (`apps/service/src/saving/pdf-save-coordinator.ts`).

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

The coordinator synchronizes the temporary file before calling `commitSaveCandidate`. Its commit callback revalidates original or copy authority, atomically renames the candidate, synchronizes the directory, and refreshes the target digest (`apps/service/src/saving/pdf-save-coordinator.ts`). The broker checks the destination generation while holding the same serialized session tail, then records whether revision and digest are still current (`apps/service/src/sessions/session-broker.ts`). A stale generation discards the temporary file; a valid commit of an older state immediately schedules another pass.

### Let recovery converge through evidence

Recovery stores checksummed current and previous generations with temporary-file synchronization, atomic rename, directory synchronization, and fallback to the highest valid revision (`apps/service/src/recovery/draft-snapshot.ts`). Its record contains complete semantic state, the canonical source snapshot path, destination, target fingerprint, and desired/saved synchronization watermarks (`apps/service/src/recovery/draft-snapshot.ts`).

On restart, non-clean drafts and explicitly protected Chrome/native drafts matching an approved source or target identity are recovery candidates (`apps/service/src/sessions/session-broker.ts`). Resume validates the immutable source, migrates legacy annotation geometry, rebinds an original to a newly approved file capability, and reauthorizes a copy only when its fingerprint still matches (`apps/service/src/sessions/session-broker.ts`). A missing or changed target keeps the semantic work protected but becomes visibly `not-saved` until the user retries, locates the PDF, or selects a new destination; invalid annotation geometry instead offers a return to annotations so the item can be repaired (`apps/web/src/save/SaveDestinationDialog.tsx`). For an unprotected draft, clean desired/saved evidence suppresses a later recovery prompt without relying on browser unload or a Finish action (`apps/service/src/sessions/session-broker.ts`).

## Why This Matters

This architecture makes save status meaningful without making annotation entry block on a full PDF rewrite. Recovery-first acknowledgement protects work quickly; the coalesced writer lets the visible PDF catch up. A red or missing target does not masquerade as saved, and a slow prior save cannot bless or overwrite a newly selected destination.

Full-state projection from an immutable source avoids cumulative rewrite drift and makes deletion deterministic. Removing the final Owned Annotation produces a PDF with no app-owned metadata while foreign highlights and stamps remain intact (`test/conformance/pdf-writer.conformance.test.ts`).

Annotation-local, redundantly validated identity preserves editability, while the public annotation representation preserves interoperability. Other PDF readers receive ordinary annotations with crop-relative geometry and normal appearances without understanding the private envelope; Placekeeper can still reconstruct the semantic Review Items after a move, rename, or transfer. Tests cover each supported kind, reject mismatched or duplicate evidence, recreate imported state with fresh local history, and exercise cropped pages at all four rotations (`packages/core/test/portable-annotation.test.ts`, `test/conformance/pdf-writer.conformance.test.ts`).

No single test layer proves this contract. Core tests prove identity validation, service tests prove save/recovery state transitions, PDF conformance tests prove write/reopen behavior, and browser tests prove the first-command gate and visible status. A manual render in a viewer outside the app is also necessary: a Saved label and a successful PDFium reopen do not by themselves prove that another viewer paints the expected appearance. The generated five-annotation golden PDF was checked through Poppler and macOS PDFKit during PR #21 verification (session history).

## When to Apply

Use this pattern when:

- A responsive semantic editor materializes changes into a comparatively slow document format.
- Users can redirect persistence between durable targets while writes are in flight.
- App-created objects must remain editable after reopen while imported native objects retain the source representation outside authorized comment edits and deletion.
- Output must stay interoperable with tools that ignore application-specific metadata.
- Crash recovery must retain accepted work without claiming that the user-visible file is current.
- Retrying after a moved, missing, changed, or unwritable target should converge idempotently to the newest complete state.

Do not substitute a revision-only marker, an in-memory viewer commit event, the prior output bytes, or a visible object ID for this design. Each signal covers only one dimension of truth. Durable correctness requires semantic digest, target generation and identity, verified bytes, atomic replacement, and recovery evidence to agree.

## Examples

### First annotation saved to a copy

1. The user opens and reads the PDF without a save prompt.
2. The first annotation command is held pending and the dialog proposes an annotated-copy filename (`apps/web/src/save/save-state-controller.ts`, `apps/service/src/saving/save-destination.ts`).
3. After destination capability and generation are persisted, the pending command is submitted once (`apps/web/src/app/ProductionReviewApp.tsx`).
4. Recovery records the new ReviewState before autosave writes, verifies, and atomically commits the copy (`apps/service/src/sessions/session-broker.ts`, `apps/service/src/server/http-server.ts`).

### Rapid edits during an in-flight save

If revision 4 is being rendered when revisions 5 and 6 are accepted, both later commands are already protected in recovery. Their requests set the same queue's `requested` bit rather than creating parallel writers. Revision 4 may commit to the current target, but it cannot make synchronization clean because its revision and digest are no longer desired. The next pass freezes revision 6; revision 5 need never exist as physical PDF bytes (`apps/service/src/saving/pdf-save-coordinator.ts`, `apps/service/src/sessions/session-broker.ts`).

### Destination switch during an old save

If a generation-2 copy save is in flight when the user selects the original, destination establishment persists generation 3. The generation-2 candidate fails its commit fence under the session tail and its temporary file is removed. The generation-3 request writes the complete latest state to the original (`apps/service/src/sessions/session-broker.ts`, `apps/service/src/saving/pdf-save-coordinator.ts`).

### Reopen, edit, delete, and recover

When an annotated PDF is reopened without private recovery data, valid portable envelopes become a fresh revision-0 ReviewState. If rewriting is allowed and the review is not generated-output, that PDF becomes the active original destination already marked clean (`apps/service/src/sessions/session-broker.ts`, `apps/service/test/recovery.test.ts`). Later edits and deletes follow the same complete-state autosave path. If the target moves while work is pending, restart recovery restores the semantic state, reports `not-saved`, and lets the user locate or replace the destination (`apps/service/test/recovery.test.ts`).

## Related

- [Adaptive annotation tray framing](adaptive-annotation-tray-framing.md) applies the sibling pattern of coalescing latest work and invalidating stale asynchronous completions to viewer geometry rather than file persistence.
- [Content-aware annotation workspace presentation](../design-patterns/outline-aware-annotation-workspace-presentation.md) shows the same fail-closed generation principle for document-derived UI state.
- [Compact Editorial language for review task surfaces](../design-patterns/compact-editorial-language-for-annotation-modals.md) defines the recovery dialog's presentation and action language while preserving these persistence transitions.
- [Portable PDF annotations invisible in external viewers](../integration-issues/portable-pdf-annotations-invisible-in-external-viewers.md) documents the narrower appearance and crop-relative geometry failure that PR #21 corrected without changing this broader autosave architecture.
- [Valid long highlights rejected by the portable annotation shape limit](../integration-issues/valid-long-highlights-rejected-by-portable-shape-limit.md) documents why portable resource accounting is dimensional, why authoring and decoding share the 256-segment ceiling, and why portability is checked before mutation acknowledgement.
- PR #19 contains the implementation described here and merged into `main` on 2026-08-11 (America/New_York).
