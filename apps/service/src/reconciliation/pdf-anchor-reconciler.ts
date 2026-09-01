import type {
  PendingReviewDraftV1,
  ReviewAnchorDisposition,
  ReviewAnchorEvidenceV1,
  ReviewItem,
  ReviewState,
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
