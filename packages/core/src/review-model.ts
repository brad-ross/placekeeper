export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const DEFAULT_ANNOTATION_NAME = "Placekeeper";

export type ReviewItemKind =
  | "replace"
  | "delete"
  | "insert"
  | "highlight"
  | "pageNote"
  | "pdfAnnotation";

export interface ReviewItem {
  /** Author recovered only after portable ownership and visible projection validation. */
  readonly importedAnnotationAuthor?: string;
  readonly id: string;
  readonly kind: ReviewItemKind;
  readonly pageIndex: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
  /** Generation-bound anchor state lives outside kind-specific semantics. */
  readonly reconciliation?: ReviewItemReconciliationV1;
}

export type ReviewWorkflowMode = "standard" | "generated-output";
export type ReviewDocumentFreshness = "current" | "possibly-stale";

export interface ReviewRectEvidence {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const PDF_SELECTION_PAGE_LIMIT = 12;

export interface ReviewSelectionPageEvidenceV1 {
  readonly pageIndex: number;
  readonly quote: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly rect: ReviewRectEvidence;
  readonly segmentRects: readonly ReviewRectEvidence[];
}

export interface ReviewSelectionPageBoundaryV1 {
  /** The source page immediately before this synthetic clipboard separator. */
  readonly afterPageIndex: number;
  readonly separator: string;
}

export interface ReviewSelectionAnchorV1 {
  readonly pageIndex: number;
  /** Complete selected plain text in document order, including declared synthetic separators. */
  readonly quote: string;
  /** Compatibility aliases for the lead page and trailing context. */
  readonly prefix: string;
  readonly suffix: string;
  readonly rect: ReviewRectEvidence;
  readonly segmentRects: readonly ReviewRectEvidence[];
  /** Absent only on legacy one-page payloads at a compatibility boundary. */
  readonly pages?: readonly ReviewSelectionPageEvidenceV1[];
  /** Synthetic separators are metadata, never page-source text. */
  readonly pageBoundaries?: readonly ReviewSelectionPageBoundaryV1[];
}

export type CanonicalReviewSelectionAnchorV1 = ReviewSelectionAnchorV1 & {
  readonly pages: readonly ReviewSelectionPageEvidenceV1[];
  readonly pageBoundaries: readonly ReviewSelectionPageBoundaryV1[];
};

/** Normalize legacy one-page selection evidence without changing its compatibility aliases. */
export function normalizeReviewSelectionAnchor<T extends ReviewSelectionAnchorV1>(
  anchor: T,
): T & CanonicalReviewSelectionAnchorV1 {
  const legacyPage = {
    pageIndex: anchor.pageIndex,
    quote: anchor.quote,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
    rect: anchor.rect,
    segmentRects: anchor.segmentRects,
  };
  const pages = anchor.pages ?? [legacyPage];
  return {
    ...anchor,
    pages,
    pageBoundaries: anchor.pageBoundaries ?? [],
  };
}

export function canonicalReviewSelectionEvidence(
  anchor: ReviewSelectionAnchorV1,
): CanonicalReviewSelectionAnchorV1 {
  const canonical = normalizeReviewSelectionAnchor(anchor);
  return {
    pageIndex: canonical.pageIndex,
    quote: canonical.quote,
    prefix: canonical.prefix,
    suffix: canonical.suffix,
    rect: { ...canonical.rect },
    segmentRects: canonical.segmentRects.map((rect) => ({ ...rect })),
    pages: canonical.pages.map((page) => ({
      ...page,
      rect: { ...page.rect },
      segmentRects: page.segmentRects.map((rect) => ({ ...rect })),
    })),
    pageBoundaries: canonical.pageBoundaries.map((boundary) => ({ ...boundary })),
  };
}

export function reviewSelectionPayload(
  anchor: ReviewSelectionAnchorV1,
  options: { readonly canonical?: boolean } = {},
): Readonly<Record<string, JsonValue>> {
  const evidence = canonicalReviewSelectionEvidence(anchor);
  const includeCanonical = options.canonical === true
    || anchor.pages !== undefined || anchor.pageBoundaries !== undefined;
  return {
    quote: evidence.quote,
    prefix: evidence.prefix,
    suffix: evidence.suffix,
    rect: { ...evidence.rect },
    segmentRects: evidence.segmentRects.map((rect) => ({ ...rect })),
    ...(includeCanonical ? {
      pages: evidence.pages.map((page) => ({
        ...page,
        rect: { ...page.rect },
        segmentRects: page.segmentRects.map((rect) => ({ ...rect })),
      })),
      pageBoundaries: evidence.pageBoundaries.map((boundary) => ({ ...boundary })),
    } : {}),
    reliable: true,
  };
}

export type ReviewAnchorEvidenceV1 =
  | (ReviewSelectionAnchorV1 & {
      readonly kind: "selection";
    })
  | {
      readonly kind: "caret";
      readonly pageIndex: number;
      readonly leftContext: string;
      readonly rightContext: string;
      readonly rect: ReviewRectEvidence;
    }
  | {
      readonly kind: "page";
      readonly pageIndex: number;
      readonly nearbyText?: string;
      readonly rect: ReviewRectEvidence;
    };

/** Keep a Review Item's compatibility payload and canonical reconciliation
 * anchor in lockstep when semantic evidence moves to a new document layout. */
export function synchronizeReviewItemAnchor(
  item: ReviewItem,
  anchor: ReviewAnchorEvidenceV1,
): ReviewItem {
  let payload: Readonly<Record<string, JsonValue>>;
  if (anchor.kind === "selection") {
    if (item.kind !== "replace" && item.kind !== "delete" && item.kind !== "highlight") {
      throw new Error(`Review item ${item.kind} cannot use a selection anchor`);
    }
    const selection = reviewSelectionPayload(anchor, { canonical: true });
    if (item.kind === "replace") {
      const proposedText = item.payload.proposedText;
      if (typeof proposedText !== "string") throw new Error("Replace item is missing proposed text");
      payload = { ...selection, proposedText };
    } else if (item.kind === "highlight") {
      const comment = item.payload.comment;
      payload = {
        ...selection,
        ...(typeof comment === "string" ? { comment } : {}),
      };
    } else {
      payload = selection;
    }
  } else if (anchor.kind === "caret") {
    if (item.kind !== "insert") throw new Error(`Review item ${item.kind} cannot use a caret anchor`);
    const proposedText = item.payload.proposedText;
    if (typeof proposedText !== "string") throw new Error("Insert item is missing proposed text");
    payload = {
      position: { ...anchor.rect },
      leftContext: anchor.leftContext,
      rightContext: anchor.rightContext,
      reliable: true,
      proposedText,
    };
  } else {
    if (item.kind !== "pageNote" && item.kind !== "pdfAnnotation") throw new Error(`Review item ${item.kind} cannot use a page anchor`);
    const comment = item.payload.comment;
    if (typeof comment !== "string") throw new Error("Page note is missing its comment");
    payload = {
      ...(item.kind === "pdfAnnotation" ? item.payload : {}),
      position: { ...anchor.rect },
      comment,
      ...(anchor.nearbyText === undefined ? {} : { nearbyText: anchor.nearbyText }),
    };
  }

  return {
    ...item,
    pageIndex: anchor.pageIndex,
    payload,
    ...(item.reconciliation === undefined ? {} : {
      reconciliation: { ...item.reconciliation, anchor },
    }),
  };
}

export type ReviewAnchorDisposition =
  | { readonly kind: "resolved"; readonly generation: number }
  | { readonly kind: "ambiguous"; readonly reason: string }
  | { readonly kind: "missing"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly reason: string };

export interface ReviewPredecessorAnchorV1 {
  readonly generation: number;
  readonly anchor: ReviewAnchorEvidenceV1;
  readonly disposition: ReviewAnchorDisposition;
}

export interface ReviewItemReconciliationV1 {
  readonly schemaVersion: 1;
  readonly ownerViewId: string;
  readonly baseGeneration: number;
  readonly revision: number;
  readonly anchor: ReviewAnchorEvidenceV1;
  readonly disposition: ReviewAnchorDisposition;
  readonly previousAnchors: readonly ReviewPredecessorAnchorV1[];
}

export interface PendingReviewDraftV1 {
  readonly id: string;
  readonly ownerViewId: string;
  readonly baseGeneration: number;
  readonly revision: number;
  readonly kind: ReviewItemKind;
  /** Present when the draft edits an existing Review Item instead of creating one. */
  readonly targetItemId?: string;
  readonly pageIndex: number;
  readonly text: string;
  readonly anchor: ReviewAnchorEvidenceV1;
  readonly disposition: ReviewAnchorDisposition;
  readonly status: "protected" | "frozen";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewDiscardAuditV1 {
  readonly target: "item" | "draft";
  readonly id: string;
  readonly generation: number;
  readonly revision: number;
  readonly ownerViewId: string;
  readonly reason: string;
  readonly discardedAt: string;
}

export interface ReviewWorkflowStateV1 {
  readonly schemaVersion: 1;
  readonly mode: ReviewWorkflowMode;
  readonly documentRole: "source-pdf" | "generated-output";
  readonly documentGeneration: number;
  readonly freshness: ReviewDocumentFreshness;
  /** Entries before this cursor belong to predecessor document geometry. */
  readonly historyBoundary: number;
}

export interface ReviewSourceIdentity {
  readonly fileId: string;
  readonly digest: string;
  readonly byteLength: number;
}

export interface ReviewState {
  /** Undefined preserves imported authors; a confirmed blank is explicitly Placekeeper. */
  readonly annotationName?: string;
  /** Durable import boundary: absence identifies recovery state from before standard-PDF editing. */
  readonly nativeAnnotationImportDigest?: string;
  /** v1 stored page geometry with an erroneous CropBox offset; v2 is crop-relative. */
  readonly schemaVersion: 1 | 2;
  readonly sessionId: string;
  readonly source: ReviewSourceIdentity;
  readonly sourceRootId?: string;
  readonly revision: number;
  readonly lifecycle: "active" | "finished" | "discarded";
  readonly items: readonly ReviewItem[];
  readonly workflow: ReviewWorkflowStateV1;
  readonly pendingDrafts: readonly PendingReviewDraftV1[];
  readonly discardAudit: readonly ReviewDiscardAuditV1[];
  /** Canonical semantic history. The cursor points just after the last applied entry. */
  readonly history: readonly ReviewHistoryEntry[];
  readonly historyCursor: number;
}

export interface ReviewHistoryEntry {
  readonly beforeItems: readonly ReviewItem[];
  readonly afterItems: readonly ReviewItem[];
  readonly generation?: number;
  readonly beforePendingDrafts?: readonly PendingReviewDraftV1[];
  readonly afterPendingDrafts?: readonly PendingReviewDraftV1[];
  readonly beforeDiscardAudit?: readonly ReviewDiscardAuditV1[];
  readonly afterDiscardAudit?: readonly ReviewDiscardAuditV1[];
}

export type ReviewCommand =
  | { readonly type: "set-annotation-name"; readonly expectedRevision: number; readonly annotationName: string }
  | {
      readonly type: "add";
      readonly expectedRevision: number;
      readonly item: ReviewItem;
      readonly authoring?: {
        readonly ownerViewId: string;
        readonly baseGeneration: number;
      };
    }
  | {
      readonly type: "edit";
      readonly expectedRevision: number;
      readonly id: string;
      readonly updatedAt: string;
      readonly payload: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly type: "remove";
      readonly expectedRevision: number;
      readonly id: string;
    }
  | {
      readonly type: "undo";
      readonly expectedRevision: number;
    }
  | {
      readonly type: "redo";
      readonly expectedRevision: number;
    }
  | {
      readonly type: "put-draft";
      readonly expectedRevision: number;
      readonly expectedDraftRevision: number;
      readonly draft: PendingReviewDraftV1;
    }
  | {
      readonly type: "reattach";
      readonly expectedRevision: number;
      readonly id: string;
      readonly expectedReconciliationRevision: number;
      readonly ownerViewId: string;
      readonly anchor: ReviewAnchorEvidenceV1;
      readonly updatedAt: string;
    }
  | {
      readonly type: "apply-draft";
      readonly expectedRevision: number;
      readonly id: string;
      readonly expectedDraftRevision: number;
      readonly ownerViewId: string;
      readonly updatedAt: string;
    }
  | {
      readonly type: "discard-reconciliation";
      readonly expectedRevision: number;
      readonly target: "item" | "draft";
      readonly id: string;
      readonly expectedTargetRevision: number;
      readonly ownerViewId: string;
      readonly reason: string;
      readonly discardedAt: string;
    };

function record(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Review anchor geometry is missing");
  }
  return value;
}

function rectEvidence(value: JsonValue | undefined): ReviewRectEvidence {
  const valueRecord = record(value);
  const { x, y, width, height } = valueRecord;
  if (![x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part))) {
    throw new Error("Review anchor geometry is malformed");
  }
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

function selectionPages(value: JsonValue | undefined): readonly ReviewSelectionPageEvidenceV1[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Review selection pages are malformed");
  return value.map((entry) => {
    const page = record(entry);
    if (
      !Number.isSafeInteger(page.pageIndex) ||
      typeof page.quote !== "string" ||
      typeof page.prefix !== "string" ||
      typeof page.suffix !== "string" ||
      !Array.isArray(page.segmentRects)
    ) throw new Error("Review selection page evidence is malformed");
    return {
      pageIndex: page.pageIndex as number,
      quote: page.quote,
      prefix: page.prefix,
      suffix: page.suffix,
      rect: rectEvidence(page.rect),
      segmentRects: page.segmentRects.map((rect) => rectEvidence(rect)),
    };
  });
}

function selectionBoundaries(value: JsonValue | undefined): readonly ReviewSelectionPageBoundaryV1[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Review selection boundaries are malformed");
  return value.map((entry) => {
    const boundary = record(entry);
    if (!Number.isSafeInteger(boundary.afterPageIndex) || typeof boundary.separator !== "string") {
      throw new Error("Review selection boundary is malformed");
    }
    return {
      afterPageIndex: boundary.afterPageIndex as number,
      separator: boundary.separator,
    };
  });
}

function payloadText(item: ReviewItem, key: string): string {
  const value = item.payload[key];
  if (typeof value !== "string") throw new Error(`Review item ${item.id} is missing ${key}`);
  return value;
}

export function anchorEvidenceFromReviewItem(item: ReviewItem): ReviewAnchorEvidenceV1 {
  if (item.reconciliation !== undefined) return structuredClone(item.reconciliation.anchor);
  if (item.kind === "insert") {
    return {
      kind: "caret",
      pageIndex: item.pageIndex,
      leftContext: payloadText(item, "leftContext"),
      rightContext: payloadText(item, "rightContext"),
      rect: rectEvidence(item.payload.position),
    };
  }
  if (item.kind === "pageNote" || item.kind === "pdfAnnotation") {
    return {
      kind: "page",
      pageIndex: item.pageIndex,
      ...(typeof item.payload.nearbyText === "string" ? { nearbyText: item.payload.nearbyText } : {}),
      rect: rectEvidence(item.payload.position),
    };
  }
  const pages = selectionPages(item.payload.pages);
  const pageBoundaries = selectionBoundaries(item.payload.pageBoundaries);
  return {
    kind: "selection",
    pageIndex: item.pageIndex,
    quote: payloadText(item, "quote"),
    prefix: payloadText(item, "prefix"),
    suffix: payloadText(item, "suffix"),
    rect: rectEvidence(item.payload.rect),
    segmentRects: Array.isArray(item.payload.segmentRects)
      ? item.payload.segmentRects.map((value) => rectEvidence(value))
      : [],
    ...(pages === undefined ? {} : { pages }),
    ...(pageBoundaries === undefined ? {} : { pageBoundaries }),
  };
}

export function canonicalizeReviewItem(
  item: ReviewItem,
  input: { readonly ownerViewId: string; readonly baseGeneration: number },
): ReviewItem {
  return item.reconciliation !== undefined
    ? item
    : {
        ...item,
        reconciliation: {
          schemaVersion: 1,
          ownerViewId: input.ownerViewId,
          baseGeneration: input.baseGeneration,
          revision: 0,
          anchor: anchorEvidenceFromReviewItem(item),
          disposition: { kind: "resolved", generation: input.baseGeneration },
          previousAnchors: [],
        },
      };
}

export function createReviewState(input: {
  sessionId: string;
  source: ReviewSourceIdentity;
  sourceRootId?: string;
  workflowMode?: ReviewWorkflowMode;
  documentGeneration?: number;
}): ReviewState {
  const mode = input.workflowMode ?? "standard";
  const documentGeneration = input.documentGeneration ?? 1;
  return {
    schemaVersion: 2,
    sessionId: input.sessionId,
    source: input.source,
    ...(input.sourceRootId === undefined
      ? {}
      : { sourceRootId: input.sourceRootId }),
    revision: 0,
    lifecycle: "active",
    items: [],
    workflow: {
      schemaVersion: 1,
      mode,
      documentRole: mode === "generated-output" ? "generated-output" : "source-pdf",
      documentGeneration,
      freshness: "current",
      historyBoundary: 0,
    },
    pendingDrafts: [],
    discardAudit: [],
    history: [],
    historyCursor: 0,
  };
}

export function normalizeAnnotationName(value: string): string {
  return value.trim() || DEFAULT_ANNOTATION_NAME;
}

export function normalizeReviewState(state: ReviewState): ReviewState {
  const workflow = state.workflow ?? {
    schemaVersion: 1 as const,
    mode: "standard" as const,
    documentRole: "source-pdf" as const,
    documentGeneration: 1,
    freshness: "current" as const,
    historyBoundary: 0,
  };
  return {
    ...state,
    ...(state.annotationName === undefined ? {} : { annotationName: normalizeAnnotationName(state.annotationName) }),
    workflow,
    items: workflow.mode === "generated-output"
      ? state.items.map((item) => canonicalizeReviewItem(item, {
          ownerViewId: item.reconciliation?.ownerViewId ?? "legacy-view",
          baseGeneration: item.reconciliation?.baseGeneration ?? workflow.documentGeneration,
        }))
      : [...state.items],
    pendingDrafts: state.pendingDrafts ?? [],
    discardAudit: state.discardAudit ?? [],
  };
}

export function startReviewGeneration(
  state: ReviewState,
  input: {
    readonly documentGeneration: number;
    readonly freshness?: ReviewDocumentFreshness;
  },
): ReviewState {
  if (!Number.isSafeInteger(input.documentGeneration) || input.documentGeneration <= state.workflow.documentGeneration) {
    throw new Error("Review document generation must advance monotonically");
  }
  const items = state.items.map((item) => {
    const canonical = canonicalizeReviewItem(item, {
      ownerViewId: "legacy-view",
      baseGeneration: state.workflow.documentGeneration,
    });
    const reconciliation = canonical.reconciliation!;
    return {
      ...canonical,
      reconciliation: {
        ...reconciliation,
        revision: reconciliation.revision + 1,
        previousAnchors: [
          ...reconciliation.previousAnchors,
          {
            generation: state.workflow.documentGeneration,
            anchor: reconciliation.anchor,
            disposition: reconciliation.disposition,
          },
        ],
        disposition: {
          kind: "missing" as const,
          reason: "not-yet-reconciled-to-generation",
        },
      },
    };
  });
  const history = state.history.slice(0, state.historyCursor);
  return {
    ...state,
    revision: state.revision + 1,
    items,
    pendingDrafts: state.pendingDrafts.map((draft) => ({
      ...draft,
      revision: draft.revision + 1,
      status: "frozen" as const,
      disposition: { kind: "missing" as const, reason: "draft-frozen-on-predecessor-generation" },
    })),
    workflow: {
      ...state.workflow,
      documentGeneration: input.documentGeneration,
      freshness: input.freshness ?? "current",
      historyBoundary: history.length,
    },
    history,
    historyCursor: history.length,
  };
}
