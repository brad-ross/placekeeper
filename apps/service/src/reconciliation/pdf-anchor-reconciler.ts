import {
  normalizeReviewSelectionAnchor,
  type ReviewSelectionPageEvidenceV1,
  type PendingReviewDraftV1,
  type ReviewAnchorDisposition,
  type ReviewAnchorEvidenceV1,
  type ReviewItem,
  type ReviewState,
} from "../../../../packages/core/src/review-model.js";

export interface PdfAnchorPage {
  readonly pageIndex: number;
  readonly text: string;
  readonly geometry?: readonly {
    readonly charStart: number;
    readonly glyphs: readonly {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }[];
  }[];
}

interface AnchorResolution {
  readonly anchor: ReviewAnchorEvidenceV1;
  readonly disposition: ReviewAnchorDisposition;
}

interface SemanticMatch {
  readonly page: PdfAnchorPage;
  readonly offset: number;
}

interface DocumentPageSpan {
  readonly page: PdfAnchorPage;
  readonly start: number;
  readonly end: number;
}

interface PassageMatch {
  readonly start: number;
  readonly end: number;
  readonly pages: readonly DocumentPageSpan[];
}

function candidateMatches(anchor: ReviewAnchorEvidenceV1, pages: readonly PdfAnchorPage[]) {
  const candidates: SemanticMatch[] = [];
  if (anchor.kind === "page" && anchor.nearbyText === undefined) return candidates;
  for (const page of pages) {
    const needle = anchor.kind === "selection"
      ? anchor.quote
      : anchor.kind === "caret"
        ? `${anchor.leftContext}${anchor.rightContext}`
        : anchor.nearbyText!;
    if (needle.length === 0) continue;
    let offset = 0;
    while (offset <= page.text.length - needle.length) {
      const found = page.text.indexOf(needle, offset);
      if (found < 0) break;
      const contextMatches = anchor.kind !== "selection" || (
        found >= anchor.prefix.length &&
        page.text.startsWith(anchor.prefix, found - anchor.prefix.length) &&
        page.text.startsWith(anchor.suffix, found + anchor.quote.length)
      );
      if (contextMatches) {
        candidates.push({ page, offset: found });
        if (candidates.length === 2) return candidates;
      }
      offset = found + 1;
    }
  }
  return candidates;
}

type Rect = ReviewAnchorEvidenceV1["rect"];

function unionRects(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  const left = Math.min(...rects.map(({ x }) => x));
  const top = Math.min(...rects.map(({ y }) => y));
  const right = Math.max(...rects.map(({ x, width }) => x + width));
  const bottom = Math.max(...rects.map(({ y, height }) => y + height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function geometryForRange(
  page: PdfAnchorPage,
  start: number,
  length: number,
): readonly Rect[] | undefined {
  if (page.geometry === undefined) return undefined;
  const end = start + length;
  const segments: Rect[] = [];
  for (const run of page.geometry) {
    const glyphs = run.glyphs.flatMap((glyph, index) => {
      const charIndex = run.charStart + index;
      return charIndex >= start && charIndex < end && glyph.width > 0 && glyph.height > 0
        ? [{ x: glyph.x, y: glyph.y, width: glyph.width, height: glyph.height }]
        : [];
    });
    const rect = unionRects(glyphs);
    if (rect !== undefined) segments.push(rect);
  }
  return segments.length === 0 ? undefined : segments;
}

function caretGeometry(page: PdfAnchorPage, offset: number): Rect | undefined {
  if (page.geometry === undefined) return undefined;
  let before: { readonly index: number; readonly rect: Rect } | undefined;
  let after: { readonly index: number; readonly rect: Rect } | undefined;
  for (const run of page.geometry) {
    run.glyphs.forEach((glyph, glyphIndex) => {
      if (glyph.width <= 0 || glyph.height <= 0) return;
      const index = run.charStart + glyphIndex;
      const rect = { x: glyph.x, y: glyph.y, width: glyph.width, height: glyph.height };
      if (index < offset && (before === undefined || index > before.index)) before = { index, rect };
      if (index >= offset && (after === undefined || index < after.index)) after = { index, rect };
    });
  }
  if (after !== undefined) return { x: after.rect.x, y: after.rect.y, width: 1, height: after.rect.height };
  if (before !== undefined) {
    return {
      x: before.rect.x + before.rect.width,
      y: before.rect.y,
      width: 1,
      height: before.rect.height,
    };
  }
  return undefined;
}

function anchorForMatch(
  anchor: ReviewAnchorEvidenceV1,
  match: SemanticMatch,
): ReviewAnchorEvidenceV1 | undefined {
  if (anchor.kind === "caret") {
    const rect = caretGeometry(match.page, match.offset + anchor.leftContext.length);
    return rect === undefined ? undefined : { ...anchor, pageIndex: match.page.pageIndex, rect };
  }
  const needle = anchor.kind === "selection" ? anchor.quote : anchor.nearbyText!;
  const segmentRects = geometryForRange(match.page, match.offset, needle.length);
  if (segmentRects === undefined) return undefined;
  const rect = unionRects(segmentRects);
  if (rect === undefined) return undefined;
  return anchor.kind === "selection"
    ? { ...anchor, pageIndex: match.page.pageIndex, rect, segmentRects }
    : { ...anchor, pageIndex: match.page.pageIndex, rect };
}

function documentPageSpans(pages: readonly PdfAnchorPage[]): {
  readonly text: string;
  readonly pages: readonly DocumentPageSpan[];
} {
  let offset = 0;
  const ordered = pages.toSorted((left, right) => left.pageIndex - right.pageIndex);
  const spans = ordered.map((page) => {
    const span = { page, start: offset, end: offset + page.text.length };
    offset = span.end;
    return span;
  });
  return { text: ordered.map(({ text }) => text).join(""), pages: spans };
}

function crossPagePassageMatches(
  anchor: Extract<ReviewAnchorEvidenceV1, { readonly kind: "selection" }>,
  pages: readonly PdfAnchorPage[],
): readonly PassageMatch[] {
  const canonical = normalizeReviewSelectionAnchor(anchor);
  const needle = canonical.pages.map(({ quote }) => quote).join("");
  if (needle.length === 0) return [];
  const document = documentPageSpans(pages);
  const matches: PassageMatch[] = [];
  let offset = 0;
  while (offset <= document.text.length - needle.length) {
    const found = document.text.indexOf(needle, offset);
    if (found < 0) break;
    const contextMatches = found >= canonical.prefix.length &&
      document.text.startsWith(canonical.prefix, found - canonical.prefix.length) &&
      document.text.startsWith(canonical.suffix, found + needle.length);
    if (contextMatches) {
      matches.push({ start: found, end: found + needle.length, pages: document.pages });
      if (matches.length === 2) return matches;
    }
    offset = found + 1;
  }
  return matches;
}

function crossPageAnchorForMatch(
  anchor: Extract<ReviewAnchorEvidenceV1, { readonly kind: "selection" }>,
  match: PassageMatch,
): Extract<ReviewAnchorEvidenceV1, { readonly kind: "selection" }> | undefined {
  const canonical = normalizeReviewSelectionAnchor(anchor);
  const pages: ReviewSelectionPageEvidenceV1[] = [];
  for (const span of match.pages) {
    const overlapStart = Math.max(match.start, span.start);
    const overlapEnd = Math.min(match.end, span.end);
    if (overlapStart >= overlapEnd) continue;
    const localStart = overlapStart - span.start;
    const length = overlapEnd - overlapStart;
    const segmentRects = geometryForRange(span.page, localStart, length);
    if (segmentRects === undefined) return undefined;
    const rect = unionRects(segmentRects);
    if (rect === undefined) return undefined;
    pages.push({
      pageIndex: span.page.pageIndex,
      quote: span.page.text.slice(localStart, localStart + length),
      prefix: "",
      suffix: "",
      rect,
      segmentRects,
    });
  }
  const first = pages[0];
  const last = pages.at(-1);
  if (first === undefined || last === undefined) return undefined;
  pages[0] = { ...first, prefix: canonical.prefix };
  pages[pages.length - 1] = { ...last, suffix: canonical.suffix };
  const separator = canonical.pageBoundaries[0]?.separator ?? "\n";
  const pageBoundaries = pages.slice(0, -1).map(({ pageIndex }) => ({
    afterPageIndex: pageIndex,
    separator,
  }));
  return {
    kind: "selection",
    pageIndex: first.pageIndex,
    quote: pages.map((page, index) => page.quote + (pageBoundaries[index]?.separator ?? "")).join(""),
    prefix: canonical.prefix,
    suffix: canonical.suffix,
    rect: first.rect,
    segmentRects: first.segmentRects,
    pages,
    pageBoundaries,
  };
}

export function reconcilePdfAnchor(
  anchor: ReviewAnchorEvidenceV1,
  pages: readonly PdfAnchorPage[],
  generation: number,
): AnchorResolution {
  if (anchor.kind === "page" && anchor.nearbyText === undefined) {
    return {
      anchor,
      disposition: {
        kind: "unsupported",
        reason: "page-anchor-has-no-semantic-text-evidence",
      },
    };
  }
  if (anchor.kind === "selection" && normalizeReviewSelectionAnchor(anchor).pages.length > 1) {
    const matches = crossPagePassageMatches(anchor, pages);
    if (matches.length === 1) {
      const resolvedAnchor = crossPageAnchorForMatch(anchor, matches[0]!);
      if (resolvedAnchor === undefined) {
        return {
          anchor,
          disposition: {
            kind: "unsupported",
            reason: "current-generation-anchor-geometry-unavailable",
          },
        };
      }
      return {
        anchor: resolvedAnchor,
        disposition: { kind: "resolved", generation },
      };
    }
    if (matches.length > 1) {
      return {
        anchor,
        disposition: { kind: "ambiguous", reason: "semantic-anchor-matched-more-than-once" },
      };
    }
    return {
      anchor,
      disposition: { kind: "missing", reason: "semantic-anchor-not-found" },
    };
  }
  const candidates = candidateMatches(anchor, pages);
  if (candidates.length === 1) {
    const resolvedAnchor = anchorForMatch(anchor, candidates[0]!);
    if (resolvedAnchor === undefined) {
      return {
        anchor,
        disposition: {
          kind: "unsupported",
          reason: "current-generation-anchor-geometry-unavailable",
        },
      };
    }
    return {
      anchor: resolvedAnchor,
      disposition: { kind: "resolved", generation },
    };
  }
  if (candidates.length > 1) {
    return {
      anchor,
      disposition: { kind: "ambiguous", reason: "semantic-anchor-matched-more-than-once" },
    };
  }
  return {
    anchor,
    disposition: { kind: "missing", reason: "semantic-anchor-not-found" },
  };
}

function reconcileItem(
  item: ReviewItem,
  pages: readonly PdfAnchorPage[],
  generation: number,
): ReviewItem {
  if (item.reconciliation === undefined) {
    throw new Error(`Generated-output Review Item ${item.id} lacks canonical anchor state`);
  }
  const resolved = reconcilePdfAnchor(item.reconciliation.anchor, pages, generation);
  return {
    ...item,
    pageIndex: resolved.anchor.pageIndex,
    reconciliation: {
      ...item.reconciliation,
      anchor: resolved.anchor,
      disposition: resolved.disposition,
    },
  };
}

function reconcileDraft(
  draft: PendingReviewDraftV1,
  pages: readonly PdfAnchorPage[],
  generation: number,
): PendingReviewDraftV1 {
  const resolved = reconcilePdfAnchor(draft.anchor, pages, generation);
  return {
    ...draft,
    ...(resolved.disposition.kind === "resolved" ? { baseGeneration: generation } : {}),
    pageIndex: resolved.anchor.pageIndex,
    anchor: resolved.anchor,
    disposition: resolved.disposition,
    status: resolved.disposition.kind === "resolved" ? "protected" : "frozen",
  };
}

/** Reconciles every protected semantic object exactly once. Missing and
 * ambiguous anchors preserve predecessor evidence and never inherit geometry
 * from an unrelated match. */
export function reconcilePdfAnchorState(
  state: ReviewState,
  input: { readonly pages: readonly PdfAnchorPage[]; readonly generation: number },
): ReviewState {
  const items = state.items.map((item) => reconcileItem(item, input.pages, input.generation));
  const pendingDrafts = state.pendingDrafts.map((draft) =>
    reconcileDraft(draft, input.pages, input.generation)
  );
  return { ...state, items, pendingDrafts };
}
