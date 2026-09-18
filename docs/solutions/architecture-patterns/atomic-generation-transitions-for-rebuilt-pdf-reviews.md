---
title: Atomic generation transitions for local PDF replacement
date: 2026-09-02
last_updated: 2026-09-18
category: architecture-patterns
module: Automatic local PDF replacement lifecycle
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - An owned local PDF may be replaced, truncated, or rewritten while a live review remains open
  - Canonical review intent must survive document replacement without inheriting stale geometry
  - Browser and embedded-editor surfaces must converge on one successor document identity
  - Concurrent review mutations or newer file observations can race candidate validation
  - Recovery must contain either the complete predecessor or complete successor generation after interruption
resolution_type: code_fix
related_components:
  - Rebuild Reconciliation
  - Review Host Runtime
  - Review Runtime Protocol
  - Save Sync
  - Protected Recovery
tags: [local-pdf, document-replacement, document-generation, rebuild-reconciliation, observation-epoch, generation-fencing, cross-surface-continuity, protected-recovery]
---

# Atomic generation transitions for local PDF replacement

## Context

An owned local PDF may be replaced by any same-path writer. Generated outputs can additionally pass through partial or noisy states during a compile. Treating every file event as a new document can expose truncated bytes, fork the review session, lose Review Items, or let a slow candidate overwrite newer review work. The open review must remain continuous across replacements.

The service owns local-file observation and the generation transition. Host notifications are hints; they do not independently order or commit replacements. A changed candidate must pass stable-byte, Document Generation/source-digest, and observation fences, and all active interaction holds must clear. An admitted observation separately blocks physical save publication until it settles. The broker reconciles the latest durable review state, including annotations completed while candidate inspection was running.

This broadens the original generated-output design to ordinary owned local PDFs. A build system is only one possible external writer. The distinction between live authoring authority and durable recovery is essential: a disconnected editor must not block refresh forever, but its accepted draft must remain recoverable.

`apps/service/src/sessions/document-replacement-preparation.ts` owns private-byte inspection and successor-state construction. State preparation remains synchronous within the broker’s fenced tail; the helper cannot independently commit or publish.

## Guidance

### Treat filesystem events as hints

Observe the owned local PDF through the service's `LocalDocumentObserver`. Its per-session sequence, coalesced queue, retries, and last-hold-release wake-up select the newest candidate for inspection (`apps/service/src/sessions/local-document-observer.ts:358`, `apps/service/src/sessions/session-broker.ts:307`). Host-specific source/sidecar signals remain useful, but ordering and replacement policy belong to the service.

A source save can mark generated output possibly stale without proving that a successor PDF exists. A file event, same-path replacement, or reconnect must lead to validation rather than a blind viewer reload. The broker rechecks the observation epoch and current source bytes under its serialized session tail before committing (`apps/service/src/sessions/session-broker.ts:2473`).

### Validate a stable private copy

Prove that one complete regular file was observed. Candidate staging rejects symlinks, non-files, empty files, and files beyond the generation limit; captures device, inode, size, and modification time; opens without following symlinks; and compares file identity around the complete read (`apps/service/src/recovery/source-snapshot.ts`). It rejects partial reads, hashes the copied bytes, and writes and syncs them in a private generation directory before interpretation (`apps/service/src/recovery/source-snapshot.ts`).

The broker re-reads the staged copy, verifies length and digest, and structurally inspects the PDF before admitting it (`apps/service/src/sessions/session-broker.ts`). Same-digest candidates do not advance Document Generation; they refresh current source and observation metadata and, when needed, restore freshness (`apps/service/src/sessions/session-broker.ts`). Staged or structurally invalid candidates preserve predecessor bytes, Document Generation, and Review Items and mark freshness `possibly-stale`. A temporarily missing ordinary-PDF path preserves current freshness while retaining retryability (`apps/service/src/sessions/session-broker.ts`).

### Fence every independent race axis

Capture the expected Document Generation and source digest before expensive inspection. Recheck them, current source bytes, and the latest observation under the session tail immediately before changing canonical state (`apps/service/src/sessions/session-broker.ts:2473`). These identities answer different questions:

- Document Generation identifies the immutable PDF whose geometry is authoritative.
- Source digest identifies its exact bytes.
- Review revision orders semantic annotation changes, including edits made while PDF inspection runs.
- Observation epoch orders competing file observations.

**A changed review revision is not a reason to discard an otherwise valid candidate.** The previous version of this guide recommended that fence. That would repeatedly reject replacements during legitimate editing and omit the just-finished annotation from the intended transition. Instead, live interaction holds defer publication; once they clear, `prepareReplacementReview(session.state, ...)` uses the latest canonical state under the same serialized tail (`apps/service/src/sessions/session-broker.ts:2523`, `apps/service/src/sessions/session-broker.ts:2543`).

### Separate live authority, durable recovery, and shared presentation

| State | Purpose | End of lifetime |
| --- | --- | --- |
| Interaction hold | Prevent a generation change during an admitted source-dependent interaction | Explicit release, durable finalization, or connection-incarnation revocation |
| Protected draft | Preserve accepted work before final resolution | Durable application or discard |
| Terminal receipt | Resolve an uncertain Apply/Cancel result after finalization | Separate durable acknowledgement |
| Active-authoring draft presence | Keep a live draft from appearing as a second recovery card in another viewer | Live claim ends or bounded reconnect presence expires |

A background editor has no inactivity timeout. Conversely, durable draft existence is not evidence that an editor remains alive. Reconnect must authenticate a new incarnation and reacquire authority; it cannot inherit authority merely by presenting a public view identifier (`apps/service/src/sessions/review-interactions.ts:209`, `apps/service/src/sessions/review-interactions.ts:334`).

Finalization persists canonical review state and its idempotent receipt before removing the hold. If persistence fails, the hold and retry identity remain intact (`apps/service/src/sessions/review-interactions.ts:268`). Physical PDF saving is a separate transaction; its source-publication fences must protect the successor without forcing editor completion to wait for file delivery. See the autosave learning below.

Presence suppression must match an **exact draft**, not every draft owned by an attachment. The broker intersects active claims with canonical owner, generation, protected status, and resolved disposition, then returns review state and active IDs atomically (`apps/service/src/sessions/session-broker.ts:3284`). Owner-wide suppression would hide unrelated abandoned work. Persisting active presence would resurrect stale editors after restart; dropping durable drafts with presence would lose recoverable content.

### Advance PDF and review state together

For a new digest, start the new review generation before publishing anything. Generation start records predecessor anchors and dispositions, marks items pending reconciliation, freezes pending drafts, advances the generation, and establishes an undo boundary (`packages/core/src/review-model.ts`, `packages/core/src/review-reducer.ts`).

Run Rebuild Reconciliation against the inspected successor. Preserve Review Item identity and semantic payload, but update anchor evidence only for one unique semantic match. Ambiguous, missing, and unsupported anchors retain predecessor evidence and explicit unresolved dispositions (`apps/service/src/reconciliation/pdf-anchor-reconciler.ts`). Geometry alone must never silently retarget an item.

Within one broker-owned transition, commit the private PDF snapshot and persist source ownership, reconciled review state, reset Save Sync, lineage, latest epoch, and any source-work interruption before changing in-memory indexes or notifying clients (`apps/service/src/sessions/session-broker.ts`). Durable snapshot persistence writes and syncs a temporary state, rotates the prior snapshot, atomically renames the replacement, and syncs the directory (`apps/service/src/recovery/draft-snapshot.ts`). Recovery can therefore choose a complete current or previous state rather than a mixture (`apps/service/src/recovery/draft-snapshot.ts`).

### Publish a wake-up, then rebootstrap canonical state

Publish only after durable successor state is proven. The normal path publishes after the session-tail commit; recovery resolution may publish immediately when it proves the durable successor (`apps/service/src/sessions/session-broker.ts`). The bounded event carries predecessor generation, successor generation, and review revision (`apps/service/src/sessions/control-socket.ts`). It is notification, not state transfer.

The shared document-source coordinator ignores older invalidations, aborts stale bootstraps, and accepts a refreshed bootstrap only when session, generation, and revision satisfy the newest event (`apps/web/src/host/runtime-document-source.ts`). Browser, native, and extension hosts therefore converge on the same canonical successor rather than locally applying event fragments.

### Preserve the panel without making presentation canonical

Key the open surface by canonical output path. The panel controller reuses one existing panel for that path and coalesces concurrent opens, so a new digest does not imply a new editor tab (`apps/vscode/src/review-panel-controller.ts`). Its opaque panel key restores the binding after reload (`apps/vscode/src/review-panel-controller.ts`).

The shared viewer separately captures its semantic presentation location before replacing the document and restores it only after the successor document and navigation are ready (`apps/web/src/app/ProductionReviewApp.tsx`). Page and zoom remain bounded view-local state, never canonical review authority (`apps/web/src/production-entry.tsx`, `packages/core/src/review-model.ts`).

## Why This Matters

The transaction separates semantic review state, immutable PDF generation, Review Revision, and disposable viewer presentation. Observation order and Save Sync provide additional independent coordination axes. Mixing them causes characteristic failures—stale geometry can become canonical, a viewer preference can accidentally authorize state, or an old candidate can overwrite a new annotation.

Publishing only after persistence and rehydrating through generation/revision fences lets every Review Host Runtime observe the same successor without duplicating reconciliation logic. Keeping panel identity and presentation local lets that successor appear in place instead of reconstructing the user's workspace.


## When to Apply

- An owned local file must update a stateful session without losing semantic work.
- Filesystem notifications may be duplicated, reordered, or emitted while a producer is still writing.
- Users can mutate canonical review data while candidate validation is in flight.
- Anchors or drafts must cross changed document geometry with explicit uncertainty.
- Several clients must converge on one successor while an embedded surface stays in place.

Do not use pathname, modification time, or a file event alone as document identity. Do not advance generation for an unchanged digest. Do not copy predecessor coordinates forward as valid successor geometry. Do not put page, zoom, tray selection, or editor placement into canonical review state.

## Examples

### Successful rebuild

1. The service coalesces local-file observations and inspects the newest candidate (`apps/service/src/sessions/local-document-observer.ts`).
2. The broker snapshots private bytes, verifies and inspects them, then proves the epoch, generation, and digest are still current and no interaction hold remains (`apps/service/src/sessions/session-broker.ts`).
3. It advances the generation, carries stable Review Item IDs through reconciliation, and persists the new lineage and state (`apps/service/test/live-document-replacement.test.ts`).
4. Each host rebootstraps the same successor; the open panel remains bound to the output path and restores its reading location (`apps/web/test/host-runtime.test.ts`, `apps/vscode/src/review-panel-controller.ts`, `apps/web/src/app/ProductionReviewApp.tsx`).

### Incomplete, unchanged, or racing candidate

A source save marks the current generation possibly stale without replacing it (`apps/service/test/live-document-replacement.test.ts`). An unchanged candidate restores freshness without incrementing generation (`apps/service/test/live-document-replacement.test.ts`). A structurally invalid candidate preserves the last successful bytes and Review Items (`apps/service/test/live-document-replacement.test.ts`). If review revision changes during inspection, final admission reconciles the latest durable state after active holds clear; if two candidates overlap, only the newest current observation can commit (`apps/service/test/live-document-replacement.test.ts`).

### A build arrives during annotation editing

The candidate is inspected but deferred while any participating viewer has an active hold. Apply durably finalizes the annotation and receipt before release. The last release wakes observation again rather than blindly committing old staged bytes. The newest valid PDF is revalidated and reconciled against the just-updated review state. Disconnect instead revokes live authority while preserving the protected draft for recovery.


### Crash at the commit boundary

The recovery test injects failure before the final durable-state rename and observes generation 1; a later successful retry observes generation 2 (`apps/service/test/live-document-replacement.test.ts`). The surrounding persistence invariant is stronger: recovery must never combine successor bytes with predecessor reconciliation state or vice versa.

## Related

- [Recoverable autosave for editable PDF annotations](./recoverable-editable-pdf-annotation-autosave.md)
- [Manual-precedence reconciliation for agent source work](./manual-precedence-agent-source-reconciliation.md)
- [Task-scoped, prompt-refreshed live PDF context](./task-scoped-prompt-refreshed-live-pdf-context.md)
- [Shared production review client with host-specific runtime boundaries](./shared-production-review-client-host-runtime-boundaries.md)
- [Reject stale viewer selection snapshots before creating annotation anchors](../ui-bugs/reject-stale-viewer-selection-snapshots.md)
- [PR #68: Fully embedded VS Code LaTeX review](https://github.com/brad-ross/placekeeper/pull/68)

- [PR #117: Automatic local PDF refresh](https://github.com/brad-ross/placekeeper/pull/117) — implementation and follow-up fixes; open at documentation time, 2026-09-18.
