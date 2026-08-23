---
title: Restore insertion annotations on complex PDF pages
date: 2026-08-23
category: ui-bugs
module: PDF caret anchor selection
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Clicking ordinary prose on a complex PDF page did not create an insertion annotation."
  - "Unrelated mathematical overlaps or unsupported-script text elsewhere could disable insertion for the clicked prose."
  - "Distant missing, zero-area, or malformed glyph records could invalidate otherwise exact nearby caret geometry."
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - "createCaretAnchorAtPoint"
  - "Contextual Annotation Composer"
  - "testing_framework"
tags:
  - "pdf-caret"
  - "insertion-annotations"
  - "pointer-hit-testing"
  - "glyph-geometry"
  - "complex-pdfs"
  - "whitespace-glyphs"
  - "local-reliability"
  - "regression-tests"
---

# Restore insertion annotations on complex PDF pages

## Problem

Insertion annotations could not be created on otherwise ordinary prose in complex PDFs. The caret path maps page text rectangles back to extracted-text offsets and resolves a pointer to an exact text edge, but several reliability checks treated the whole page as one unit of trust (`apps/web/src/pdf/selection-anchor.ts:523-528`).

That scope was too broad. A technical page can combine prose with overlapping subscript or superscript rectangles, right-to-left text, omitted whitespace glyphs, and malformed glyph metadata. Those artifacts should reject a caret only when their geometry can own or alter the clicked text edge. The correction is proposed in [PR #53](https://github.com/brad-ross/placekeeper/pull/53), which was open and unmerged as of 2026-08-23.

## Symptoms

- Clicking prose produced no insertion caret when distant mathematical layout or unsupported-script text appeared on the same page. The mixed-page regression now requires a reliable caret and exact left/right context (`apps/web/test/selection-anchor.test.ts:254-301`).
- Missing or zero-area whitespace glyphs and malformed indexed glyphs elsewhere could prevent exact glyph alignment, even though they could not own the pointer.
- A blanket relaxation would have been unsafe: malformed local indexed geometry, incomplete local coverage, local reading-order problems, and tied candidates must still fail closed (`apps/web/test/selection-anchor.test.ts:326-355`, `apps/web/test/selection-anchor.test.ts:389-402`, `apps/web/test/selection-anchor.test.ts:490-500`).

## What Didn't Work

The original reliability model checked all mapped rectangles for overlap and reading order, all text runs for unsupported scripts, and all indexed glyphs for alignment. That made the entire page veto one local click. The model was conservative, but it produced false negatives without improving the fidelity of the selected caret.

Existing tests made the design look safer than it was. They covered exact glyph hit testing inside one multi-character run and rejection of genuinely ambiguous local cases (`apps/web/test/selection-anchor.test.ts:229-252`, `apps/web/test/selection-anchor.test.ts:452-488`), but they did not combine a valid clickable run with unrelated hostile geometry elsewhere on the page.

The incorrect invariant was:

```ts
// Too broad: any unreliable artifact on the page vetoes the caret.
for (const item of mapped) {
  validateForCaret(item);
}
```

The correct boundary is whether an artifact can own or change the pointer's text edge.

## Solution

Introduce one proximity predicate in natural page space and reuse it for caret-specific reliability decisions. `caretPointNearRect` applies the same vertical-center tolerance used by candidate hit testing and includes a small horizontal tolerance around the rectangle (`apps/web/src/pdf/selection-anchor.ts:397-405`). Rotation and scale are removed before those decisions (`apps/web/src/pdf/selection-anchor.ts:531-540`).

```ts
if (!caretPointNearRect(item.rect, point)) continue;
```

That guard scopes four decisions:

1. Adjacent text runs participate in reading-order validation only when at least one is near the pointer (`apps/web/src/pdf/selection-anchor.ts:409-422`).
2. Overlapping rectangles reject only when both can own the pointer, and unsupported-script content rejects only when its rectangle is near the pointer (`apps/web/src/pdf/selection-anchor.ts:543-563`).
3. Indexed-glyph owners and required offsets come only from nearby mapped text. Local non-whitespace offsets require exact coverage; whitespace remains usable when valid geometry is present but is not required when PDF extraction omits it (`apps/web/src/pdf/selection-anchor.ts:430-447`).
4. Invalid, out-of-range, or ownerless glyphs are ignored when distant. Comparable geometry near the pointer prevents exact glyph alignment, while invalid or duplicate required local glyphs remain ambiguous (`apps/web/src/pdf/selection-anchor.ts:448-476`).

If exact local glyph alignment cannot be established, the existing fallback remains conservative: single-character runs and exact run edges are usable, but the interior of a multi-character rectangle never receives a fabricated proportional offset (`apps/web/src/pdf/selection-anchor.ts:569-611`).

## Why This Works

An Insertion Caret Anchor ultimately consists of an exact extracted-text boundary, left/right context around that boundary, and a thin page-space position (`apps/web/src/pdf/selection-anchor.ts:51-57`, `apps/web/src/pdf/selection-anchor.ts:264-280`). Geometry too far away to become a candidate cannot change any of those values. Letting it veto the click therefore added false negatives rather than safety.

Pointer-local scoping removes those false negatives while preserving the fail-closed contract:

- Distant overlaps and unsupported scripts cannot veto ordinary prose (`apps/web/test/selection-anchor.test.ts:254-301`).
- Valid whitespace geometry is still used when present (`apps/web/test/selection-anchor.test.ts:303-324`).
- Malformed or incomplete local glyph coverage does not authorize a guessed interior offset (`apps/web/test/selection-anchor.test.ts:326-355`).
- Local unsupported reading order still returns `caret-reading-order-unsupported` (`apps/web/test/selection-anchor.test.ts:389-402`).

This does not make every reliability rule local. Extracted page text and text rectangles must still pass the page-level availability check before caret resolution begins (`apps/web/src/pdf/selection-anchor.ts:528-544`, `apps/web/src/pdf/text-reliability.ts:73-90`). The durable distinction is: validate the page as a usable text source globally, then validate click-specific ambiguity only where geometry can influence that click.

## Prevention

- Treat reliability scope as part of the API contract. Page-level checks answer whether text extraction is fundamentally usable; click-level checks answer whether one exact pointer location is unambiguous.
- Pair every fail-closed local geometry test with a distant-noninterference test. The suite now includes both complex distant geometry that must not veto prose and local overlap or reading-order failures that must reject (`apps/web/test/selection-anchor.test.ts:254-301`, `apps/web/test/selection-anchor.test.ts:452-488`).
- Keep extraction artifacts in the regression matrix: omitted or zero-area whitespace, out-of-range offsets, incomplete local coverage, mixed scripts, and mathematical overlaps.
- Never infer an interior character offset by proportionally dividing a multi-character text rectangle. Without exact local glyph geometry, preserve atomic run edges and reject the interior (`apps/web/src/pdf/selection-anchor.ts:523-527`, `apps/web/test/selection-anchor.test.ts:214-227`).
- Reduce future production failures to a mixed-page fixture containing one known-good clickable run and the smallest distant artifact that previously vetoed it. This protects the locality invariant directly.

## Related Issues

- [Contextual Annotation Composer preserves document context during authoring](../design-patterns/contextual-annotation-composer-preserves-document-context-during-authoring.md) describes the downstream authoring lifecycle after a reliable caret exists.
- [Portable PDF annotations invisible in external viewers](../integration-issues/portable-pdf-annotations-invisible-in-external-viewers.md) documents the complementary fail-closed geometry boundary for durable PDF writing.
- [Wait for committed wheel zoom before pointer-selection assertions](../test-failures/wait-for-committed-wheel-zoom-before-pointer-selection.md) covers adjacent real-browser coordinate timing.
- [PR #47](https://github.com/brad-ross/placekeeper/pull/47) introduced exact indexed-glyph caret alignment; PR #53 narrows its caret-specific reliability scope without weakening local ambiguity checks.

