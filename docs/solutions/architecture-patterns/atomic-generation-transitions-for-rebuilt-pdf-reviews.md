---
title: Atomic generation transitions for rebuilt PDF reviews
date: 2026-09-02
last_updated: 2026-09-10
category: architecture-patterns
module: Generated PDF rebuild lifecycle
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - A watched build output may be replaced, truncated, or rewritten while a live review remains open
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
tags: [generated-pdf, atomic-rebuild, document-generation, rebuild-reconciliation, observation-epoch, generation-fencing, cross-surface-continuity, protected-recovery]
---

# Atomic generation transitions for rebuilt PDF reviews

## Context

A generated LaTeX PDF can pass through several partial or noisy filesystem states during one compile. Treating every file event as a new document can expose truncated bytes, fork the review session, lose Review Items, or let a slow candidate overwrite newer review work. The embedded workflow instead needed one continuous Placekeeper panel across repeated edits and builds; real VS Code testing confirmed that this continuity, rather than compilation alone, was the user-visible completion condition (session history).

The durable architecture treats the canonical output path as one Generated Output Lineage whose bytes advance through immutable Document Generations. VS Code observes only the bound PDF and its SyncTeX sidecars, coalesces event noise, and sends a monotonically increasing Observation Epoch to the service (`apps/vscode/src/rebuild-observer.ts`). The observer is only a trigger: it delegates candidate validity to the broker and ignores a completed validation when a newer local epoch has appeared (`apps/vscode/src/rebuild-observer.ts`).

The service owns the transition. It stages stable private bytes, fences the candidate against the current generation, digest, review revision, and newest epoch, carries semantic Review Items through Rebuild Reconciliation, persists the successor generation and Save Sync together, and only then publishes an invalidation. Invalid, unchanged, superseded, racing, or over-budget candidates leave the last successful generation active.

`apps/service/src/sessions/document-replacement-preparation.ts` owns private-byte inspection and successor-state construction. State preparation remains synchronous within the broker’s fenced tail; the helper cannot independently commit or publish.

## Guidance

### Treat filesystem events as hints

Watch the exact output lineage, not an entire project tree. The extension observer accepts only the canonical PDF and its supported sidecars, advances an epoch for each relevant event, and validates only the latest coalesced epoch (`apps/vscode/src/rebuild-observer.ts`). A source save is a different signal: it marks the last successful generation `possibly-stale` without claiming that a successor PDF exists (`apps/vscode/src/rebuild-observer.ts`, `apps/vscode/src/extension.ts`). Reveal, activation, and bounded interval checks can later revalidate the panel (`apps/vscode/src/rebuild-observer.ts`).

The broker must enforce ordering independently. `replaceLiveDocument` requires a positive epoch, records it in its serialized session tail, and returns `superseded` when the epoch is not newer than the latest epoch recorded in the serialized session; successful transitions persist that epoch with the generation (`apps/service/src/sessions/session-broker.ts`). It compares the epoch again immediately before commit so slow validation cannot publish after a newer observation (`apps/service/src/sessions/session-broker.ts`).

### Validate a stable private copy

Prove that one complete regular file was observed. Candidate staging rejects symlinks, non-files, empty files, and files beyond the generation limit; captures device, inode, size, and modification time; opens without following symlinks; and compares file identity around the complete read (`apps/service/src/recovery/source-snapshot.ts`). It rejects partial reads, hashes the copied bytes, and writes and syncs them in a private generation directory before interpretation (`apps/service/src/recovery/source-snapshot.ts`).

The broker re-reads the staged copy, verifies length and digest, and structurally inspects the PDF before admitting it (`apps/service/src/sessions/session-broker.ts`). Same-digest candidates do not create a Document Generation; after the fences are rechecked, they may only restore freshness to current (`apps/service/src/sessions/session-broker.ts`). Invalid candidates preserve predecessor bytes and state and persist `possibly-stale` freshness instead (`apps/service/src/sessions/session-broker.ts`).

### Fence every independent race axis

Capture the expected generation, source digest, and review revision before expensive validation, then recheck all three under the session tail immediately before changing canonical state (`apps/service/src/sessions/session-broker.ts`). These identities answer different questions:

- The Document Generation identifies which immutable PDF geometry is current and advances monotonically (`packages/core/src/review-model.ts`).
- The source digest identifies the exact bytes within that generation (`packages/core/src/review-model.ts`).
- The review revision orders semantic Review Item changes even when the PDF is unchanged (`packages/core/src/review-reducer.ts`, `apps/service/src/sessions/session-broker.ts`).
- The Observation Epoch orders competing filesystem observations (`apps/service/src/sessions/session-broker.ts`).

If any fence changed, reject the candidate and leave current state intact (`apps/service/src/sessions/session-broker.ts`). Do not collapse these axes into one generic “current” flag.

### Advance PDF and review state together

For a new digest, start the new review generation before publishing anything. Generation start records predecessor anchors and dispositions, marks items pending reconciliation, freezes pending drafts, advances the generation, and establishes an undo boundary (`packages/core/src/review-model.ts`, `packages/core/src/review-reducer.ts`).

Run Rebuild Reconciliation against the inspected successor. Preserve Review Item identity and semantic payload, but update anchor evidence only for one unique semantic match. Ambiguous, missing, and unsupported anchors retain predecessor evidence and explicit unresolved dispositions (`apps/service/src/reconciliation/pdf-anchor-reconciler.ts`). Geometry alone must never silently retarget an item.

Within one broker-owned transition, commit the private PDF snapshot and persist source ownership, reconciled review state, reset Save Sync, lineage, latest epoch, and any source-work interruption before changing in-memory indexes or notifying clients (`apps/service/src/sessions/session-broker.ts`). Durable snapshot persistence writes and syncs a temporary state, rotates the prior snapshot, atomically renames the replacement, and syncs the directory (`apps/service/src/recovery/draft-snapshot.ts`). Recovery can therefore choose a complete current or previous state rather than a mixture (`apps/service/src/recovery/draft-snapshot.ts`).

### Publish a wake-up, then rebootstrap canonical state

Construct the successor event only after durable state exists and publish it after leaving the commit block (`apps/service/src/sessions/session-broker.ts`). The bounded event carries predecessor generation, successor generation, and review revision (`apps/service/src/sessions/control-socket.ts`). It is notification, not state transfer.

The shared document-source coordinator ignores older invalidations, aborts stale bootstraps, and accepts a refreshed bootstrap only when session, generation, and revision satisfy the newest event (`apps/web/src/host/runtime-document-source.ts`). Browser and VS Code therefore converge on the same canonical successor rather than locally applying event fragments.

### Preserve the panel without making presentation canonical

Key the open surface by canonical output path. The panel controller reuses one existing panel for that path and coalesces concurrent opens, so a new digest does not imply a new editor tab (`apps/vscode/src/review-panel-controller.ts`). Its opaque panel key restores the binding after reload (`apps/vscode/src/review-panel-controller.ts`).

The shared viewer separately captures its semantic presentation location before replacing the document and restores it only after the successor document and navigation are ready (`apps/web/src/app/ProductionReviewApp.tsx`). Page and zoom remain bounded view-local state, never canonical review authority (`apps/web/src/production-entry.tsx`, `packages/core/src/review-model.ts`).

## Why This Matters

The transaction preserves four intentionally distinct state axes: semantic review state, immutable PDF generation, service revision, and disposable viewer presentation. Mixing them causes characteristic failures—stale geometry can become canonical, a viewer preference can accidentally authorize state, or an old candidate can overwrite a new annotation.

Publishing only after persistence and rehydrating through generation/revision fences lets every Review Host Runtime observe the same successor without duplicating reconciliation logic. Keeping panel identity and presentation local lets that successor appear in place instead of reconstructing the user's workspace.

Installed-host testing matters here. During implementation, stale extension assets repeatedly looked like rebuild regressions even after source tests passed; matching build/install hashes and using a fresh VS Code process was necessary before interpreting the live edit-build-refresh loop (session history).

## When to Apply

- A generated file must update a stateful session without losing semantic work.
- Filesystem notifications may be duplicated, reordered, or emitted while a producer is still writing.
- Users can mutate canonical review data while candidate validation is in flight.
- Anchors or drafts must cross changed document geometry with explicit uncertainty.
- Several clients must converge on one successor while an embedded surface stays in place.

Do not use pathname, modification time, or a file event alone as document identity. Do not advance generation for an unchanged digest. Do not copy predecessor coordinates forward as valid successor geometry. Do not put page, zoom, tray selection, or editor placement into canonical review state.

## Examples

### Successful rebuild

1. VS Code coalesces changes for the PDF and sidecar and submits only the newest Observation Epoch (`apps/vscode/test/rebuild-observer.test.ts`).
2. The broker snapshots private bytes, verifies and inspects them, then proves the epoch, generation, digest, and review revision are still current (`apps/service/src/sessions/session-broker.ts`).
3. It advances the generation, carries stable Review Item IDs through reconciliation, and persists the new lineage and state (`apps/service/test/live-document-replacement.test.ts`).
4. Each host rebootstraps the same successor; the open panel remains bound to the output path and restores its reading location (`apps/web/test/host-runtime.test.ts`, `apps/vscode/src/review-panel-controller.ts`, `apps/web/src/app/ProductionReviewApp.tsx`).

### Incomplete, unchanged, or racing candidate

A source save marks the current generation possibly stale without replacing it (`apps/service/test/live-document-replacement.test.ts`). An unchanged candidate restores freshness without incrementing generation (`apps/service/test/live-document-replacement.test.ts`). A structurally invalid candidate preserves the last successful bytes and Review Items (`apps/service/test/live-document-replacement.test.ts`). If review revision changes during inspection, the final fence rejects the candidate; if two candidates overlap, only the newest epoch can commit (`apps/service/test/live-document-replacement.test.ts`).

### Crash at the commit boundary

The recovery test injects failure before the final durable-state rename and observes generation 1; a later successful retry observes generation 2 (`apps/service/test/live-document-replacement.test.ts`). The surrounding persistence invariant is stronger: recovery must never combine successor bytes with predecessor reconciliation state or vice versa.

## Related

- [Recoverable autosave for editable PDF annotations](./recoverable-editable-pdf-annotation-autosave.md)
- [Manual-precedence reconciliation for agent source work](./manual-precedence-agent-source-reconciliation.md)
- [Task-scoped, prompt-refreshed live PDF context](./task-scoped-prompt-refreshed-live-pdf-context.md)
- [Shared production review client with host-specific runtime boundaries](./shared-production-review-client-host-runtime-boundaries.md)
- [Reject stale viewer selection snapshots before creating annotation anchors](../ui-bugs/reject-stale-viewer-selection-snapshots.md)
- [PR #68: Fully embedded VS Code LaTeX review](https://github.com/brad-ross/placekeeper/pull/68)
