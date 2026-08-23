---
title: Reject stale viewer selection snapshots before creating annotation anchors
date: 2026-08-23
category: ui-bugs
module: PDF text selection anchoring
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Selecting a displayed equation could produce an unavailable or unreliable annotation anchor."
  - "A prose line containing inline equations could associate selected text with geometry from a different selection."
  - "A selection that changed during page or text retrieval could pass through capture as a mixed snapshot."
root_cause: async_timing
resolution_type: code_fix
severity: high
tags: [pdf-selection, equation-annotations, selection-snapshot, async-timing, crop-relative-geometry, fail-closed, review-items, regression-tests]
---

# Reject stale viewer selection snapshots before creating annotation anchors

## Problem

PDF text selection is exposed through separate viewer reads for formatted rectangles, selection state, selected text, and extracted page data (`apps/web/src/pdf/viewer-selection-adapter.ts:22-29`). Creating a Review Item from those values is safe only when they describe one [Selection Snapshot](../../../CONCEPTS.md#selection-snapshot). If the selection changes while asynchronous page or text work is pending, otherwise plausible text, offsets, and geometry can come from different selections.

Equations made both failure modes visible. Their superscripts, subscripts, and fractions produce legitimate nonmonotone segment rectangles, while a nearby selection change can produce a temporally inconsistent but superficially valid anchor.

## Symptoms

- Before the fix, exact indexed selections containing displayed equations were rejected solely because their segment rectangles were not monotone (session history). The current rule recognizes that exact viewer offsets establish their semantic text order (`apps/web/src/pdf/text-reliability.ts:168-195`).
- During the initial equation fix, lines containing inline equations could still fail because selection capture awaited page and text reads while relying on separately sampled viewer state (session history).
- A mixed snapshot could survive downstream checks when its quote, offset count, and rectangles were each individually plausible. The result was a low-confidence residual rather than a consistently reproducible failure (session history).

## What Didn't Work

- Treating all nonmonotone selection rectangles as unsupported reading order was too strict for TeX layout. It conflated semantic order with visual placement; the current rule keeps the geometry-order fallback only when exact viewer offsets are unavailable (`apps/web/src/pdf/text-reliability.ts:168-200`).
- Relaxing that rule fixed the direct equation case but did not make selection capture atomic. The initial implementation read formatted geometry, awaited the page, awaited selected text, and only then sampled selection state, so each value could belong to a different moment (session history).
- The outer generation guard is necessary but not sufficient. It prevents an obsolete capture from publishing after a newer document-level selection generation wins, but repeated same-document events can share a generation (`apps/web/src/pdf/selection-state.ts:24-31`, `apps/web/src/app/App.tsx:785-793`).

## Solution

Capture the viewer's semantic selection state before awaiting document work, then verify that the same state still exists afterward:

1. Read formatted selection rectangles and selection state together and serialize their meaning into a stable signature. The signature includes page indexes, union and segment rectangles, range endpoints, per-page slices, and active/selecting flags; page-keyed records are numerically sorted before serialization (`apps/web/src/pdf/viewer-selection-adapter.ts:39-65`).
2. Start selected-text retrieval immediately and await it in parallel with the page read, reducing the interval in which selection state can drift (`apps/web/src/pdf/viewer-selection-adapter.ts:72-80`).
3. Re-read formatted selection and state after both asynchronous reads complete. If the signature changed, return `selection-text-geometry-mismatch` with the normal unavailable-selection message instead of building an anchor (`apps/web/src/pdf/viewer-selection-adapter.ts:81-89`).
4. When the signatures match, build the anchor from the original snapshot. Exact viewer offsets validate the selected quote and authorize nonmonotone equation geometry; page-space segment rectangles remain unchanged in this viewer path (`apps/web/src/pdf/viewer-selection-adapter.ts:90-108`, `apps/web/src/pdf/text-reliability.ts:168-200`).

The implementation is optimistic rather than lock-based: document reads proceed normally, and a semantic comparison determines whether their result still belongs to the selection that initiated them.

## Why This Works

The signature is a temporal-consistency boundary. It does not try to infer whether a later selection is “close enough”; it proves that every synchronous viewer value capable of changing the anchor retained the same meaning across the asynchronous gap. A mismatch fails closed before text and geometry can be combined.

This is distinct from the equation-order rule. Exact indexed text answers “what characters, and in what semantic order?” Nonmonotone rectangles answer “where are those characters painted?” Stable snapshot verification answers “did those answers come from the same selection?” All three conditions are required for a reliable equation annotation.

The outer generation check still prevents late results from mutating newer application state, and terminal capture failures become an explicit unreliable selection update (`apps/web/src/app/App.tsx:785-793`, `apps/web/src/pdf/selection-state.ts:63-74`). The inner signature check covers drift that happens within a still-current generation.

## Prevention

- Treat any API that exposes text, offsets, and geometry through separate reads as a snapshot protocol, even when the API does not provide a literal snapshot object.
- Sample synchronous semantic state on both sides of every awaited operation that contributes to an anchor. Compare stable values, not object identity or undocumented revision counters.
- Keep semantic ordering and temporal consistency as separate reliability gates. Exact offsets may authorize visually nonmonotone equation segments, but they do not authorize stale geometry.
- Use deferred-promise regression tests to mutate selection state during capture. The suite independently covers state drift and formatted-geometry drift (`apps/web/test/selection-anchor.test.ts:538-620`).
- Preserve a positive equation fixture with indexed text and nonmonotone geometry so the fail-closed guard does not regress into rejecting valid mathematics (`apps/web/test/selection-anchor.test.ts:622-678`, `apps/web/test/text-reliability.test.ts:120-147`).

## Related Issues

- [GitHub issue #51: Cannot annotate equations or lines with inline equations](https://github.com/brad-ross/placekeeper/issues/51) records the user-facing failure.
- [PR #56: Fix equation and inline-math annotations](https://github.com/brad-ross/placekeeper/pull/56) contains this fix and is pending merge as of 2026-08-23.
- [Restore insertion annotations on complex PDF pages](restore-insertion-annotations-on-complex-pdf-pages.md) applies the same fail-closed principle to caret-local geometry rather than temporal selection consistency.
- [Wait for committed wheel zoom before pointer selection](../test-failures/wait-for-committed-wheel-zoom-before-pointer-selection.md) documents another viewer timing boundary where transient presentation state must not drive coordinate-based actions.
- [Contextual Annotation Composer preserves document context during authoring](../design-patterns/contextual-annotation-composer-preserves-document-context-during-authoring.md) describes the downstream authoring lifecycle once a reliable anchor exists.
- [Portable PDF annotations invisible in external viewers](../integration-issues/portable-pdf-annotations-invisible-in-external-viewers.md) defines the crop-relative geometry contract used by durable annotations.
