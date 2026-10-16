---
title: Long review history exhausts the native response budget
date: 2026-10-16
category: integration-issues
module: Embedded review runtime
problem_type: integration_issue
component: tooling
symptoms:
  - Long annotation sessions appear stuck while saving and cannot reopen in the native app.
  - The same PDFs open in Preview with their saved annotations intact.
  - Native staging rejects the review projection even though current annotations remain valid.
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [host-runtime, protected-recovery, undo-history, response-projection, resource-limits, macos-native-shell]
---

# Long review history exhausts the native response budget

## Problem

A native review can become impossible to reopen because its private editing history exceeds a response-validation budget, while the PDF and current annotations remain healthy. The correction in [PR #134](https://github.com/brad-ross/placekeeper/pull/134), open and unmerged as of 2026-10-16, separates the client projection from canonical history before bounded traversal.

## Symptoms

In the investigated incident, two reviews appeared stuck during save and failed to reopen in Placekeeper. Both PDFs opened in Preview with saved annotations intact. Retrying did not restore the native review. These observations established that PDF corruption was not a sufficient explanation; they did not prove that the latest protected edits had reached the PDF. (Session evidence.)

Disposable copies of the recovery records reproduced the projection failure at 100,003 and 100,199 visited JSON values. The response clone rejects traversal beyond 100,000 nodes or depth 32 (`packages/core/src/review-runtime-protocol.ts:175`). Native staging throws `invalid-projection` when the sanitized projection is undefined (`apps/service/src/macos/macos-runtime.ts:308`). A small current annotation set can therefore coexist with a failed bootstrap when repeated before/after snapshots amplify the response.

## What Didn't Work

Retrying the same review could not change its stored response shape. Preview's success ruled out one class of failure but could not validate Placekeeper's recovery or native transport. Treating the UI symptom as proof of a PDF-writer bug would have sent the investigation into the wrong subsystem.

Raising the clone budget was not the chosen remedy: it would allow more private history across a boundary whose consumers do not need it, and merely move the failure threshold. Clearing recovery or undo history would sacrifice work to make the response smaller. Neither is necessary to repair transport.

Summarizing history **after** cloning the full state would also be too late. The rejected traversal is the work to avoid, not an oversized result that can be trimmed afterward.

## Solution

Project the canonical state before recursive cloning. The renderer receives current state plus history length and cursor; the canonical owner retains the entries required to execute undo and redo. `ReviewStateView` makes this distinction explicit without requiring browser/static owners to throw away their full state (`packages/core/src/review-model.ts:302`).

The decisive ordering is:

```ts
return closedJsonClone({ ...candidate, history: { length: historyLength } });
```

The sanitizer accepts either a canonical history array or an already summarized `{ length }`, checks the cursor against that length, and then clones the projection (`packages/core/src/review-runtime-protocol.ts:275`). This allows service-side and client-side validation to run in sequence without restoring or requesting private history. The response change does not enlarge incoming-command budgets or bypass forbidden-key checks (`packages/core/test/review-runtime-protocol.test.ts:25`).

The shared runtime protocol advances to version 4, with the native bridge validating and emitting that version (`packages/core/src/review-runtime-protocol.ts:3`; `apps/macos/Sources/PlacekeeperMac/ReviewBridge.swift:14`). Deploy the matching service and native client together.

## Why This Works

There are separate questions: is the PDF readable, is accepted work durable, can the native host receive the current view, and can the canonical owner undo an action? A failure in the third does not imply failure in the first two. Keeping these questions separate prevented a destructive recovery reset and preserved evidence for the real boundary failure.

Transport projection and history compaction are independent protections. The former removes unnecessary state from responses; it must work even with large legacy history. Compaction separately reduces retained recovery storage. Relying only on the new history format would leave older records or future private fields able to break bootstrap again.

## Prevention

- When a valid PDF will not reopen, reproduce source loading, recovery decoding, and response projection separately on copies. Measure the resource the failing guard actually counts; file bytes and annotation counts are not JSON traversal counts.
- Keep the response clone bounded. Project private history out before traversal rather than increasing limits or deleting durable state.
- Test both initial and repeated sanitization, revision-conflict responses, unchanged canonical history, rejection of forbidden fields, and unchanged request limits. The 300-entry legacy-history fixture exercises these boundaries (`packages/core/test/review-runtime-protocol.test.ts:25`).
- Exercise the persisted session through the native runtime as well as the pure sanitizer. The long-session regression uses accepted draft updates, application, restart, and undo against the recovery store (`apps/service/test/macos-runtime.test.ts:138`).
- Verify recovery and actual PDF output separately. In this session, cloned recovery tests checked undo/redo and saved annotation readback; the installed transport fix reopened both affected reviews, and a recovered copy saved. Those checks support the incident correction, not a promise that every possible current annotation set fits the response budget.

## Related Issues

- [Shared production review client with host-specific runtime boundaries](../architecture-patterns/shared-production-review-client-host-runtime-boundaries.md) defines the canonical owner and closed projection boundaries.
- [Valid long highlights rejected by the portable annotation shape limit](valid-long-highlights-rejected-by-portable-shape-limit.md) is a related representation-budget failure in a different codec; its annotation-envelope limits are not the runtime-response limits.
- [Recoverable autosave for editable PDF annotations](../architecture-patterns/recoverable-editable-pdf-annotation-autosave.md) distinguishes recovery acknowledgment from verified delivery into the PDF.
