---
title: Skip sparse PDFium glyph holes when merging glyphs into lines
date: 2026-09-23
category: ui-bugs
module: PDF destination navigation and viewer framing
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Link menus for equation references showed the snippet as unavailable, with no \"Eq. N\" tab name and no destination band, and no visible error."
  - "The shared glyph-line merge threw TypeError reading 'isEmpty' on pages where PDFium generates a character, such as the space before a right-aligned equation number, without a glyph entry."
  - "Reliability checks built on Array.prototype.every passed because every skips holes in a sparse array, so the page reached the crashing loop."
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - "PDFium text extraction"
  - "PDF search"
  - "testing_framework"
tags:
  - "pdfium"
  - "glyph-geometry"
  - "sparse-array"
  - "link-destinations"
  - "pdf-search"
  - "regression-tests"
---

# PDFium glyph arrays are sparse: indexed loops over `getPageGlyphs` must skip holes

## Problem

PDFium, reached through the `@embedpdf` engine's `getPageGlyphs`, returns a **sparse** glyph array. Some characters that `extractText` reports have no glyph entry at all. These are characters PDFium generates itself, such as the space it inserts before a right-aligned equation number like `(1)`. At those indices `glyphs[i]` is `undefined`, not an empty-glyph object. Everywhere else, the code assumes the glyph index equals the character index: search slices glyphs by text offsets (`apps/web/src/pdf/pdf-search-controller.ts:258-263`), and the destination resolver merges glyphs between extracted-line breaks (`apps/web/src/pdf/destination-description.ts:184-197`).

On this branch, the search controller's private `glyphRects` helper was moved into a shared module, `apps/web/src/pdf/glyph-lines.ts`, as `mergeGlyphLineSegments`. The old helper used `glyphs.slice(start, end).flatMap(...)`. `slice` keeps holes and `flatMap` skips them, so the old code tolerated sparse arrays without saying so. The new function uses an indexed `for` loop that read `glyphs[index]` and passed it directly to `drawableGlyph`, which reads `glyph.isEmpty` (`apps/web/src/pdf/glyph-lines.ts:19-21`). The read was written as `glyphs[index]!`, and that non-null assertion kept TypeScript from flagging the possible `undefined`. On any page with a hole, that threw `TypeError: Cannot read properties of undefined (reading 'isEmpty')`.

## Symptoms

- Link menus for equation references showed "snippet unavailable" instead of a preview of the destination.
- Tabs opened from those links had no "Eq. N" name.
- No destination highlight band appeared in the References viewer.
- There was no error in the UI and nothing obvious in the console. Two catch sites hid the throw:
  - `createDestinationDescriptionResolver(...).resolve` calls `describePdfDestination` (`apps/web/src/pdf/destination-description.ts:668-677`), which reaches `pageLines` → `mergeGlyphLineSegments`. The throw rejects the promise.
  - `NavigationCoordinator.startLinkDescription` maps any rejection to `null` (`apps/web/src/review/navigation-coordinator.ts:707-716`, the `() => null` rejection handler). A `null` description is the same as "nothing to describe", so the menu fell back to its unavailable state.
- The failure only happened on real PDFs whose text layer includes generated characters. Equation lines with a far-right `(N)` are the usual case.

## What Didn't Work

- **Unit tests with dense synthetic glyphs.** The `destination-description` fixtures built one glyph object per character, so every index was filled. The resolver's equation tests passed, including "keeps a far-right equation number on the same line as its equation" (`apps/web/test/destination-description.test.ts:219-232`), "finds a centered equation when the XYZ left sits at the text margin" (`:254`), and "Covers AE3. names an equation reference \"Eq. 1\"..." (`:426`), even though the real engine would have thrown on the same text.
- **The reliability gate.** `reliablePageText` requires `hasReliableGlyphGeometry(page.glyphs)` (`apps/web/src/pdf/destination-description.ts:166-171`), and search checks the same gate (`apps/web/src/pdf/pdf-search-controller.ts:409-410`). `hasReliableGlyphGeometry` uses `glyphs.every(...)` (`apps/web/src/pdf/glyph-lines.ts:111-124`), and `Array.prototype.every` skips holes. The gate therefore passed a sparse array as "reliable". It neither rejected the page nor warned, and the page went straight into the loop that crashed.
- **Reading the extraction diff.** Changing `slice().flatMap()` to an indexed loop looks like a behavior-preserving refactor. The hole-skipping came from the array methods and was never written down, so the change removed it without anyone noticing.

Only the real-PDFium Playwright acceptance test exposed the bug: "Covers AE3. an equation reference without an outline is named by its kind" (`test/acceptance/legible-link-destinations.spec.ts:260-268`). It waits for the snippet, expects the menu entry "Eq. 1, Page 3", and expects one destination band.

## Solution

Skip missing entries explicitly in the shared merge loop (`apps/web/src/pdf/glyph-lines.ts:47-51`).

Before:

```ts
for (let index = from; index < to; index += 1) {
  const glyph = glyphs[index]!;          // non-null assertion hides the hole from the type checker
  if (!drawableGlyph(glyph)) continue;   // throws when glyph is undefined
  ...
}
```

After:

```ts
for (let index = from; index < to; index += 1) {
  // The engine leaves holes for characters it generates without a glyph
  // (for example the space it inserts before a far-right equation number).
  const glyph = glyphs[index];
  if (glyph === undefined || !drawableGlyph(glyph)) continue;
  ...
}
```

A hole is handled like a space or empty glyph. It adds no rectangle and does not break the current line segment. Segment `start`/`end` values stay character indices, because the loop still advances by `index`.

Regression test (`apps/web/test/destination-description.test.ts:234-253`). It builds the equation line `Y = P X + E (1)`, deletes the glyph for the generated space just before `(`, asserts that the index really is a hole (`expect(holeIndex in glyphs).toBe(false)`), and checks that the description still has one extent line and the name `Eq. 1`.

## Why This Works

The engine's contract is "glyph index = character index, but some characters have no glyph", not "every character has a glyph". A hole marks a character with no drawn geometry, which is the same as an `isSpace`/`isEmpty` glyph for the purpose of building line rectangles. Skipping it keeps the index alignment that callers depend on and restores what the old `flatMap` did implicitly. Now that the check is an explicit `=== undefined` with a comment, a later refactor can't lose it without noticing.

## Prevention

1. **Type engine glyph arrays as possibly sparse at the point of use.** In any indexed access (`glyphs[i]`, `glyphs.at(i)`, `glyphs[sourceStart]`), check for `undefined` before reading fields. `pdf-search-controller.ts:266-270` already does this for `firstGlyph`. Treat that as the pattern. Don't rely on `noUncheckedIndexedAccess` alone. The broken loop silenced it with `glyphs[index]!`, and a local `const glyph: PdfGlyphObject = ...` annotation or a helper parameter type removes the `undefined`.

2. **Know which array operations skip holes.** `every`, `some`, `map`, `filter`, `flatMap`, `forEach`, and `reduce` skip holes. `for` loops, `for...of`, spread `[...a]`, `Array.from`, and `.at()` return `undefined` for them. When a refactor moves from one group to the other, behavior changes. That applies to gates too: an `every`-based validity check says nothing about holes.

3. **Put a sparse fixture in every glyph-consuming unit test suite.** Dense synthetic arrays can't catch this bug. Ways to build one:

   ```ts
   // Explicit hole at a known index; length stays aligned with the text.
   const glyphs = Object.assign([], { 0: g('Y'), 1: g(' '), 3: g('P'), length: 4 });

   // Literal hole.
   const glyphs = [g('('), , g('1'), g(')')];

   // Or punch a hole into a realistic fixture, as the regression test does:
   const copy = [...page.glyphs];
   delete copy[holeIndex];
   expect(holeIndex in copy).toBe(false); // prove it is a hole, not an undefined value
   ```

   Assert `index in array` is `false`. A fixture that stores `undefined` explicitly (`[a, undefined, b]`) is not the engine's shape. `every` visits that slot, so `hasReliableGlyphGeometry` throws instead of passing, and the test would fail at the gate rather than reproducing the silent path.

4. **Keep a real-engine acceptance test for each glyph-geometry feature.** The AE3 Playwright test (`test/acceptance/legible-link-destinations.spec.ts:260-268`) was the only check that ran real PDFium output. Any new consumer of `getPageGlyphs` (snippets, bands, search highlights) needs at least one acceptance path over a real PDF with generated characters, such as an equation with a right-aligned number.

5. **Don't let fallback-to-null catch sites hide programmer errors.** Returning `null` from the resolver chain (`navigation-coordinator.ts:716`) is right for aborted or unreadable pages, but it also turned a `TypeError` into "snippet unavailable". When a new feature goes through such a path, log unexpected exceptions in development builds, or test that the happy path gives a non-null result on real input.

## Related Issues

- `docs/solutions/ui-bugs/restore-insertion-annotations-on-complex-pdf-pages.md`: another glyph-geometry failure on real PDFium text (page-wide alignment ambiguity, not sparse arrays) that dense synthetic fixtures also missed.
- `docs/solutions/ui-bugs/reject-stale-viewer-selection-snapshots.md`: shares the text-reliability gate; different root cause (async snapshot drift).
- Plan: `docs/plans/2026-09-23-1058-feat-legible-link-destinations-plan.md` (U1, AE3).
