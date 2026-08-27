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
}

interface AnchorResolution {
  readonly anchor: ReviewAnchorEvidenceV1;
  readonly disposition: ReviewAnchorDisposition;
}

function candidateAnchors(anchor: ReviewAnchorEvidenceV1, pages: readonly PdfAnchorPage[]) {
  const candidates: ReviewAnchorEvidenceV1[] = [];
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
        candidates.push({ ...anchor, pageIndex: page.pageIndex });
        if (candidates.length === 2) return candidates;
      }
      offset = found + Math.max(1, needle.length);
    }
  }
  return candidates;
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
  const candidates = candidateAnchors(anchor, pages);
  if (candidates.length === 1) {
    return {
      anchor: candidates[0]!,
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
