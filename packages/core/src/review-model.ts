export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ReviewItemKind =
  | "replace"
  | "delete"
  | "insert"
  | "highlight"
  | "pageNote";

export interface ReviewItem {
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

export type ReviewAnchorEvidenceV1 =
  | {
      readonly kind: "selection";
      readonly pageIndex: number;
      readonly quote: string;
      readonly prefix: string;
      readonly suffix: string;
      readonly rect: ReviewRectEvidence;
      readonly segmentRects: readonly ReviewRectEvidence[];
    }
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
  if (item.kind === "pageNote") {
    return {
      kind: "page",
      pageIndex: item.pageIndex,
      ...(typeof item.payload.nearbyText === "string" ? { nearbyText: item.payload.nearbyText } : {}),
      rect: rectEvidence(item.payload.position),
    };
  }
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
      historyBoundary: state.historyCursor,
    },
  };
}
