---
title: Compact document undo with independent protected drafts
date: 2026-10-16
category: architecture-patterns
module: PDF annotation persistence
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - Persisting unfinished annotation text while keeping document undo meaningful
  - Replacing whole-review snapshots with bounded reversible changes
  - Migrating recovery history without losing drafts or misclassifying saved work
tags: [undo-history, protected-recovery, semantic-deltas, save-sync, document-generation, migration, native-annotations]
---

# Compact document undo with independent protected drafts

## Context

The transport correction in [PR #134](https://github.com/brad-ross/placekeeper/pull/134) made long reviews reopenable, but did not by itself fix their stored history. Before compaction, the reducer appended before/after copies of all items, pending drafts, and discard records for protected typing updates as well as annotation edits. JSON persistence expanded those snapshots even when their in-memory arrays shared objects. A count limit alone would still permit a large record and would spend meaningful undo capacity on keystrokes. (Session investigation.)

The important design decision was to separate **durable acceptance** from **document undo**. Throttling or dropping draft persistence would reduce writes by weakening recovery. Keeping whole-state undo while excluding only typing entries would still restore stale drafts when a later item action was undone. The correction therefore changes both entry creation and replay scope. The implementation is in PR #134, open and unmerged as of 2026-10-16.

## Guidance

### Keep the current protected state authoritative

Draft updates and explicit draft discard advance the canonical revision but leave document history and its redo branch intact (`packages/core/src/review-reducer.ts:175`, `packages/core/src/review-reducer.ts:432`). This does not change the requirement to persist accepted state before acknowledgment; that durability contract belongs to [recoverable autosave](recoverable-editable-pdf-annotation-autosave.md).

Applying an annotation produces an item action. Undo restores or removes the affected item without reopening its consumed draft, and without restoring an old snapshot of other editors. The reducer's tests cover application after many draft updates, later drafts surviving undo, and draft discard preserving redo (`packages/core/test/review-commands.test.ts:100`).

Keep text undo owned by the editor. Document undo remains disabled while an authoring session is active, and the shared command surface blocks undo/redo for an editable target (`apps/web/src/app/ReviewShell.tsx:1597`; `apps/web/src/review/review-command-surface.ts:61`). Persisting text frequently does not require routing each keystroke through document history.

### Replay the entities an action changed

Versioned entries hold before/after values and positions for changed items, plus changes to item-discard audit records. Replay removes and reinserts only the named identities; the spread of the current state preserves pending drafts and other fields (`packages/core/src/review-history.ts:51`, `packages/core/src/review-history.ts:66`). Item-audit identity includes target, item ID, generation, revision, owner, and timestamp rather than mutable reason text (`packages/core/src/review-history.ts:33`).

This isolation matters during recovery as well as interactive editing. An imported native PDF mark may not have existed when an old history entry was recorded. Whole-state replay would erase it unless every old snapshot were patched. Compact replay leaves unrelated current items alone, so recovery adds native marks to current items and legacy snapshots while leaving compact entries unchanged (`apps/service/src/sessions/recovered-review-preparation.ts:41`).

Geometry conversion must cover both sides of every retained delta. Recovery can normalize old history before PDF-page geometry migration; a mapper that handles only legacy `beforeItems`/`afterItems` would leave compact undo values in the old coordinate system. The adapter preserves entry metadata and migrates both compact sides as well as legacy snapshots (`packages/pdf-backends/src/embedpdf-adapter.ts:222`). The cropped-page recovery regression exercises this actual ordering (`apps/service/test/recovery.test.ts:220`).

### Bound undo without treating it as the recovery checkpoint

The current state is already the checkpoint. History is an optional reversible trail around it, not the only copy of accepted annotations or drafts. Retention therefore changes only history bookkeeping; it must not replay entries or discard current work to meet a budget.

The policy is at most 200 entries and 4 MiB of serialized UTF-8 history. Remove oldest applied entries first, then farthest redo entries if necessary. Rebase the cursor and boundary as entries disappear (`packages/core/src/review-history.ts:18`, `packages/core/src/review-history.ts:146`). Removing from the ends preserves a contiguous sequence around current state; deleting an arbitrary large entry in the middle could leave later actions depending on an unavailable predecessor.

An oversized action may leave no retained undo entry, but its accepted current state remains. Count and byte limits cover different workloads: many small actions versus a few large ones. The tests cover Unicode byte accounting, a single oversized entry, and several individually retainable entries that collectively exceed the budget with the cursor inside history (`packages/core/test/review-history.test.ts:68`).

Legacy conversion compares item and item-audit content, drops draft-only/no-op steps, maps the old cursor and generation boundary through the surviving entries, and then removes unreachable history (`packages/core/src/review-history.ts:121`). A new document generation clears history while retaining current items and freezing pending drafts under the existing reconciliation rules (`packages/core/src/review-model.ts:599`). Retaining predecessor entries merely because they remain serializable would waste the budget on actions that must not replay against successor geometry.

### Translate save evidence only when its old identity matched

The subtle migration risk is outside the history array. `reviewStateDigest` omits history entries and cursor, but includes the whole workflow, including `historyBoundary`, as well as items, pending drafts, discard audit, and annotation name (`apps/service/src/recovery/draft-snapshot.ts:182`). Pruning history can therefore change this digest even when current annotations do not change.

Compute the old digest before normalization. Translate each saved or desired digest independently only if it equaled that exact old digest:

```text
oldDigest = digest(oldState)
newState = normalize(oldState)
newDigest = digest(newState)
for each of desiredDigest and savedDigest:
  if its value equals oldDigest, replace it with newDigest
  otherwise retain its value
```

The implementation retains phase and revision watermarks while doing these conditional replacements (`apps/service/src/recovery/draft-snapshot.ts:195`). Blindly assigning both digests to the new value could declare genuinely unsaved work clean. Translating neither could make a previously matching save look stale merely because migration changed bookkeeping. Tests distinguish clean records, dirty records, and unmatched identities (`apps/service/test/recovery.test.ts:173`).

## Why This Matters

Recovery revisions, document actions, and PDF save evidence answer different questions. Conflating them creates storage amplification, surprising undo, or false saved status. A compact delta format alone is insufficient unless replay and migration respect those distinctions.

In the synthetic fixture with 500 annotations, 100 draft updates, and 100 item edits, the session measured 57,233,873 bytes of full snapshots versus 58,991 bytes of compact history. This is a serialized-size comparison, not a latency benchmark or a guarantee for all documents. The regression asserts that compact history is less than one hundredth the snapshot representation (`packages/core/test/review-history.test.ts:123`).

## When to Apply

- An editor durably protects unfinished text independently of applying it to a document.
- Other views or recovery import can introduce state after an undo entry was recorded.
- Undo must survive restart while remaining bounded in both count and bytes.
- Migration changes bookkeeping that participates in a saved-state identity.

Do not use this change as permission to weaken owner/generation checks, delay draft durability, or increase runtime-response budgets. Those are separate contracts.

## Examples

An author types, applies item A, starts draft B, and then undoes A after leaving active authoring. The latest draft B remains; A is removed; the draft consumed by Apply A does not reappear. Redo restores A. A subsequent draft update does not cut off that redo branch; a subsequent item edit branches document history normally (`packages/core/test/review-commands.test.ts:100`; `packages/core/src/review-history.ts:163`).

A recovered review has a nonzero generation boundary and matching saved/desired digests. Normalization removes unreachable entries and rebases that boundary. Both matching digests translate to the new identity. If savedDigest instead described an older state, it stays unchanged and migration preserves the existing unsaved evidence (`apps/service/test/recovery.test.ts:173`).

Validation combines core replay/retention cases, recovery migration and checksum cases, cropped-page PDF conformance, authoring command routing, and a native runtime regression that persists draft updates, restarts, applies, and undoes. The runtime regression uses the real reducer and snapshot store with a backend test double; packaged native smoke separately checks activation and offline writing. No single one of those checks proves the entire contract.

## Related

- [Long review history exhausts the native response budget](../integration-issues/long-review-history-exhausts-native-response-budget.md) owns the independent transport projection correction.
- [Recoverable autosave for editable PDF annotations](recoverable-editable-pdf-annotation-autosave.md) owns durable acknowledgment and verified PDF delivery.
- [Atomic generation transitions for local PDF replacement](atomic-generation-transitions-for-rebuilt-pdf-reviews.md) owns successor admission and the reason predecessor geometry cannot remain undoable.
