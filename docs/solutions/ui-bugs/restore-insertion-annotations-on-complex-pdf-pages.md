---
title: Restore insertion annotations on complex PDF pages
date: 2026-08-23
last_updated: 2026-08-23
category: ui-bugs
module: PDF caret anchor selection
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "In the reproduced 24-page PDF, clicking valid prose on complex or later pages did not create an insertion caret."
  - "Repeated extracted text could make page-wide rectangle alignment nonunique even when exact glyph offsets identified the occurrence under the pointer."
  - "Baseline-shifted adjacent runs could be rejected as different visual lines even when their rectangles overlapped vertically."
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - "createCaretAnchorAtPoint"
  - "PDFium text extraction"
  - "testing_framework"
tags:
  - "pdf-caret"
  - "insertion-annotations"
  - "pointer-hit-testing"
  - "glyph-geometry"
  - "complex-pdfs"
  - "multipage-pdfs"
  - "repeated-text"
  - "reading-order"
  - "regression-tests"
---

# Restore insertion annotations on complex PDF pages

## Problem

Insertion annotations could not be created on otherwise valid prose in complex PDFs. The caret path maps PDFium text rectangles to extracted-text offsets, resolves the pointer to an exact text edge, and emits a crop-relative insertion anchor. Several reliability decisions nevertheless treated the entire page as one unit of trust.

The first correction, merged in [PR #53](https://github.com/brad-ross/placekeeper/pull/53), localized overlap, reading-order, unsupported-script, and malformed-glyph checks. It established the right click-specific invariant: after global page reliability passes, only geometry that can own or change the pointer's text edge participates in click-specific ambiguity checks. Later-page and baseline-shifted failures exposed two remaining violations of that invariant:

1. Caret creation still required one unique sequential alignment for every text rectangle on the page before applying pointer-local checks. Repeated text or complex extraction elsewhere could make that global mapping absent or nonunique even when the clicked glyphs identified one exact occurrence (`apps/web/src/pdf/selection-anchor.ts:335-385`).
2. Reading order used rectangle origins as a proxy for visual lines. Inline subscript or superscript runs may have shifted origins while their vertical spans still overlap, so origin ordering could reject ordinary same-line text.

The follow-up correction merged in [PR #54](https://github.com/brad-ross/placekeeper/pull/54) on 2026-08-23.

## Symptoms

- In the reproduced 24-page PDF, a caret worked on some first-page prose but disappeared on later text pages, including ordinary prose.
- Repeating the same sentence in more than one run could make content-only alignment ambiguous even though PDFium glyph offsets and geometry uniquely identified the run under the pointer.
- Adjacent runs with different heights or baselines could return `caret-reading-order-unsupported` despite belonging to the same visible line.
- A blanket relaxation would be unsafe: malformed local geometry, incomplete local glyph coverage, local overlap, unsupported local reading order, and tied candidates must still fail closed (`apps/web/test/selection-anchor.test.ts:372-400`, `apps/web/test/selection-anchor.test.ts:435-447`, `apps/web/test/selection-anchor.test.ts:498-529`).

## What Didn't Work

Localizing reliability checks after a global prerequisite did not make the prerequisite local. Before PR #54, every page rectangle still had to participate in exactly one complete content alignment:

```ts
const mapped = alignTextRects(input.page);
if (mapped === null) {
  return caretFailure('caret-text-rect-alignment-nonunique');
}
```

That solver remains an appropriate fallback when glyph offsets are unavailable: it preserves rectangle order, trims a stale trailing PDFium control unit when necessary, and fails closed unless there is one complete mapping. It is too strong when exact indexed glyphs already provide better local identity.

Increasing a fixed tolerance around `origin.y` was also the wrong abstraction. It could accept two distinct lines with nearby origins or reject a same-line pair with different font metrics. Visual-line membership depends on vertical-span overlap and center proximity, not identical rectangle origins.

The investigation reached these conclusions incrementally (session history). Relaxing one page-wide veto repeatedly exposed another: distant overlap was followed by unsupported reading order, then page-wide glyph-to-rectangle validation, then a zero-area trailing whitespace slot. The earlier real-document proof covered one first-page click, so calling the page-wide assumption fully resolved was premature; later-page and baseline-shifted probes were necessary to expose the residual failures.

The fix must never invent a character boundary. If exact glyph alignment is unavailable, a multi-character rectangle remains atomic: its outer edges may be candidates, but an interior click is rejected instead of being proportionally divided into a guessed text offset (`apps/web/src/pdf/selection-anchor.ts:587-590`, `apps/web/src/pdf/selection-anchor.ts:631-677`).

## Solution

### Align only pointer-relevant rectangles when glyph offsets exist

Caret creation now selects a glyph-aware, pointer-local mapper when indexed glyphs are available and retains the page-wide solver only as the no-glyph fallback (`apps/web/src/pdf/selection-anchor.ts:607-610`):

```ts
const mapped = input.page.glyphs && input.page.glyphs.length > 0
  ? alignPointerTextRectsWithGlyphs(input.page, naturalPoint)
  : alignTextRects(input.page);
```

`alignPointerTextRectsWithGlyphs` limits the mapping set to nonempty text rectangles close enough to own the click and indexes only in-range glyph offsets with valid rectangles (`apps/web/src/pdf/selection-anchor.ts:388-415`). For each local rectangle, it finds all exact occurrences of its content in extracted text while retaining the trailing-control-unit fallback (`apps/web/src/pdf/selection-anchor.ts:417-428`).

When content repeats, an occurrence survives only if every non-whitespace offset has glyph geometry overlapping the local text rectangle. Exactly one surviving occurrence is required; zero or multiple compatible occurrences still fail closed (`apps/web/src/pdf/selection-anchor.ts:429-440`). The repeated-text unit regression proves that offsets for the second `same` occurrence produce the context `same x sa|me`, instead of being rejected as globally nonunique (`apps/web/test/selection-anchor.test.ts:280-298`).

### Classify visual lines from their spans

Reading-order validation now compares vertical spans and centers for adjacent pointer-relevant rectangles. Runs count as the same visual line when the spans overlap or the centers are sufficiently close relative to their heights; horizontal reversal is rejected only within such a line. Genuine line transitions still enforce vertical order (`apps/web/src/pdf/selection-anchor.ts:464-484`).

```ts
const sameLine = verticalOverlap > 0
  || Math.abs(currentCenter - previousCenter)
     <= Math.min(6, Math.max(previous.size.height, current.size.height) / 2);
```

The baseline-shifted unit regression places a short, lower-height `ij ` run beside a taller `minutes` run with different origins and requires exact left/right caret context (`apps/web/test/selection-anchor.test.ts:254-278`).

### Exercise real page transitions

The acceptance harness now makes text-geometry readiness page-specific and records the emitted caret's page index and left context (`test/acceptance/viewer-harness/main.tsx:24-32`, `test/acceptance/viewer-harness/main.tsx:69-74`, `test/acceptance/viewer-harness/main.tsx:123-149`). Its generated two-page fixture repeats the same sentence twice on each page and adds page-specific prose (`test/fixtures/pdfs/generate.ts:117-129`). The browser regression clicks repeated text on page 1, navigates to page 2, waits for page-2 geometry, and verifies the correct page and semantic context after both clicks (`test/acceptance/viewer.spec.ts:240-260`).

## Why This Works

An Insertion Caret Anchor couples one exact extracted-text boundary with left/right context and a thin crop-relative page position (`apps/web/src/pdf/selection-anchor.ts:264-280`). With indexed glyph geometry, content equality proposes possible occurrences, exact engine offsets identify characters, and rectangle overlap proves which occurrence belongs to the visible run near the pointer. A unique full-page parse is neither necessary nor more authoritative for one click.

The two corrections preserve the fail-closed boundary:

- Distant or repeated page content cannot veto an exact local caret.
- Local overlapping owners and unsupported local reading order still reject (`apps/web/src/pdf/selection-anchor.ts:611-629`).
- Required non-whitespace offsets still need exact, valid local glyph coverage (`apps/web/src/pdf/selection-anchor.ts:494-540`).
- Candidate ties with different text offsets still reject (`apps/web/src/pdf/selection-anchor.ts:674-687`).
- Pages without usable extracted text or valid text rectangles still fail the global page-reliability check (`apps/web/src/pdf/text-reliability.ts:73-90`).

The durable boundary is therefore two-tiered: validate globally that the page is a usable text source, then validate click-specific identity and ambiguity only where geometry can affect the pointer's text edge.

## Prevention

- Treat reliability scope as part of the API contract. A global page check answers whether text extraction is usable; a caret check answers whether one pointer location determines one exact boundary.
- Pair every fail-closed local-geometry regression with distant-noninterference and repeated-content success cases. Localizing one gate does not prove that earlier prerequisites are local.
- Keep repeated identical content on multiple pages in the real-browser fixture, and assert semantic output such as `pageIndex` and text context rather than only the presence of an event.
- Make asynchronous viewer readiness page-specific. First-page extraction says nothing about later-page geometry.
- Keep baseline-shifted same-line runs in unit coverage; compare visual spans and centers rather than raw origins.
- Preserve the two-tier mapping contract: use exact pointer-local glyph offsets when present, retain exact global alignment as the no-glyph fallback, and never guess an interior offset.
- After relaxing any reliability gate, probe the exact production document again (session history). This investigation found successive independent vetoes only after the preceding one was removed.
- Targeted verification for PR #54 covered the exact 24-page model PDF at the formerly failing first-page line and later-page prose, all 73 web unit tests, all 9 viewer browser tests, five repeated runs of the multi-page regression, typecheck, build, and the packaged offline writer smoke (session history). This is evidence for the caret change, not a claim that unrelated failures in the broader current base suite are resolved.

## Related Issues

- [Contextual Annotation Composer preserves document context during authoring](../design-patterns/contextual-annotation-composer-preserves-document-context-during-authoring.md) describes the downstream authoring lifecycle after a reliable caret exists.
- [Portable PDF annotations invisible in external viewers](../integration-issues/portable-pdf-annotations-invisible-in-external-viewers.md) documents the complementary fail-closed geometry boundary for durable PDF writing.
- [Wait for committed wheel zoom before pointer-selection assertions](../test-failures/wait-for-committed-wheel-zoom-before-pointer-selection.md) covers adjacent real-browser coordinate timing.
- [Reject stale viewer selection snapshots before creating annotation anchors](reject-stale-viewer-selection-snapshots.md) covers the complementary equation and inline-equation failure caused by text/geometry drift during asynchronous selection capture.
- [Issue #51](https://github.com/brad-ross/placekeeper/issues/51) tracks equation and inline-equation annotation failures; [PR #56](https://github.com/brad-ross/placekeeper/pull/56) addresses selection capture, while [PR #53](https://github.com/brad-ross/placekeeper/pull/53) addresses caret-local reliability scope.
- [PR #47](https://github.com/brad-ross/placekeeper/pull/47) introduced exact indexed-glyph caret alignment.
- [PR #53](https://github.com/brad-ross/placekeeper/pull/53) localized click-specific reliability checks and is merged.
- [PR #54](https://github.com/brad-ross/placekeeper/pull/54) added pointer-local rectangle mapping, repeated-text glyph disambiguation, baseline-aware reading order, and multi-page browser coverage; it merged on 2026-08-23.
