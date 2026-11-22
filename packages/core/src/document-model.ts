import type { CompactDocumentHistoryEntry } from './document-history.js';
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const DEFAULT_ANNOTATION_NAME = "Placekeeper";

export type AnnotationKind =
  | "replace"
  | "delete"
  | "insert"
  | "highlight"
  | "pageNote"
  | "pdfAnnotation";

export interface Annotation {
  /** Author recovered only after portable ownership and visible projection validation. */
  readonly importedAnnotationAuthor?: string;
  readonly id: string;
  readonly kind: AnnotationKind;
  readonly pageIndex: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
  /** Generation-bound anchor state lives outside kind-specific semantics. */
  readonly reconciliation?: AnnotationReconciliationV1;
}

export type DocumentWorkflowMode = "standard" | "generated-output";
export type DocumentFreshness = "current" | "possibly-stale";

export interface DocumentRectEvidence {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const PDF_SELECTION_PAGE_LIMIT = 12;

export interface DocumentSelectionPageEvidenceV1 {
  readonly pageIndex: number;
  readonly quote: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly rect: DocumentRectEvidence;
  readonly segmentRects: readonly DocumentRectEvidence[];
}

export interface DocumentSelectionPageBoundaryV1 {
  /** The source page immediately before this synthetic clipboard separator. */
  readonly afterPageIndex: number;
  readonly separator: string;
}

export interface DocumentSelectionAnchorV1 {
  readonly pageIndex: number;
  /** Complete selected plain text in document order, including declared synthetic separators. */
  readonly quote: string;
  /** Compatibility aliases for the lead page and trailing context. */
  readonly prefix: string;
  readonly suffix: string;
  readonly rect: DocumentRectEvidence;
  readonly segmentRects: readonly DocumentRectEvidence[];
  /** Absent only on legacy one-page payloads at a compatibility boundary. */
  readonly pages?: readonly DocumentSelectionPageEvidenceV1[];
  /** Synthetic separators are metadata, never page-source text. */
  readonly pageBoundaries?: readonly DocumentSelectionPageBoundaryV1[];
}

export type CanonicalDocumentSelectionAnchorV1 = DocumentSelectionAnchorV1 & {
  readonly pages: readonly DocumentSelectionPageEvidenceV1[];
  readonly pageBoundaries: readonly DocumentSelectionPageBoundaryV1[];
};

/** Normalize legacy one-page selection evidence without changing its compatibility aliases. */
export function normalizeDocumentSelectionAnchor<T extends DocumentSelectionAnchorV1>(
  anchor: T,
): T & CanonicalDocumentSelectionAnchorV1 {
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

export function canonicalDocumentSelectionEvidence(
  anchor: DocumentSelectionAnchorV1,
): CanonicalDocumentSelectionAnchorV1 {
  const canonical = normalizeDocumentSelectionAnchor(anchor);
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

export function documentSelectionPayload(
  anchor: DocumentSelectionAnchorV1,
  options: { readonly canonical?: boolean } = {},
): Readonly<Record<string, JsonValue>> {
  const evidence = canonicalDocumentSelectionEvidence(anchor);
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

export type DocumentAnchorEvidenceV1 =
  | (DocumentSelectionAnchorV1 & {
      readonly kind: "selection";
    })
  | {
      readonly kind: "caret";
      readonly pageIndex: number;
      readonly leftContext: string;
      readonly rightContext: string;
      readonly rect: DocumentRectEvidence;
    }
  | {
      readonly kind: "page";
      readonly pageIndex: number;
      readonly nearbyText?: string;
      readonly rect: DocumentRectEvidence;
    };

/** Keep a Review Item's compatibility payload and canonical reconciliation
 * anchor in lockstep when semantic evidence moves to a new document layout. */
export function synchronizeAnnotationAnchor(
  item: Annotation,
  anchor: DocumentAnchorEvidenceV1,
): Annotation {
  let payload: Readonly<Record<string, JsonValue>>;
  if (anchor.kind === "selection") {
    if (item.kind !== "replace" && item.kind !== "delete" && item.kind !== "highlight") {
      throw new Error(`Review item ${item.kind} cannot use a selection anchor`);
    }
    const selection = documentSelectionPayload(anchor, { canonical: true });
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

export type DocumentAnchorDisposition =
  | { readonly kind: "resolved"; readonly generation: number }
  | { readonly kind: "ambiguous"; readonly reason: string }
  | { readonly kind: "missing"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly reason: string };

export interface DocumentPredecessorAnchorV1 {
  readonly generation: number;
  readonly anchor: DocumentAnchorEvidenceV1;
  readonly disposition: DocumentAnchorDisposition;
}

export interface AnnotationReconciliationV1 {
  readonly schemaVersion: 1;
  readonly ownerViewId: string;
  readonly baseGeneration: number;
  readonly revision: number;
  readonly anchor: DocumentAnchorEvidenceV1;
  readonly disposition: DocumentAnchorDisposition;
  readonly previousAnchors: readonly DocumentPredecessorAnchorV1[];
}

export interface PendingDocumentDraftV1 {
  readonly id: string;
  readonly ownerViewId: string;
  readonly baseGeneration: number;
  readonly revision: number;
  readonly kind: AnnotationKind;
  /** Present when the draft edits an existing Review Item instead of creating one. */
  readonly targetItemId?: string;
  readonly pageIndex: number;
  readonly text: string;
  readonly anchor: DocumentAnchorEvidenceV1;
  readonly disposition: DocumentAnchorDisposition;
  readonly status: "protected" | "frozen";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocumentDiscardAuditV1 {
  readonly target: "item" | "draft";
  readonly id: string;
  readonly generation: number;
  readonly revision: number;
  readonly ownerViewId: string;
  readonly reason: string;
  readonly discardedAt: string;
}

export interface DocumentWorkflowStateV1 {
  readonly schemaVersion: 1;
  readonly mode: DocumentWorkflowMode;
  readonly documentRole: "source-pdf" | "generated-output";
  readonly documentGeneration: number;
  readonly freshness: DocumentFreshness;
  /** Entries before this cursor belong to predecessor document geometry. */
  readonly historyBoundary: number;
}

export interface DocumentSourceIdentity {
  readonly fileId: string;
  readonly digest: string;
  readonly byteLength: number;
}

export interface DocumentState {
  /** Undefined preserves imported authors; a confirmed blank is explicitly Placekeeper. */
  readonly annotationName?: string;
  /** Durable import boundary: absence identifies recovery state from before standard-PDF editing. */
  readonly nativeAnnotationImportDigest?: string;
  /** v1 stored page geometry with an erroneous CropBox offset; v2 is crop-relative. */
  readonly schemaVersion: 1 | 2;
  readonly sessionId: string;
  readonly source: DocumentSourceIdentity;
  readonly sourceRootId?: string;
  readonly revision: number;
  readonly lifecycle: "active" | "finished" | "discarded";
  readonly items: readonly Annotation[];
  readonly workflow: DocumentWorkflowStateV1;
  readonly pendingDrafts: readonly PendingDocumentDraftV1[];
  readonly discardAudit: readonly DocumentDiscardAuditV1[];
  /** Canonical semantic history. The cursor points just after the last applied entry. */
  readonly history: readonly DocumentHistoryEntry[];
  readonly historyCursor: number;
}

/** Read-only client state. Undo snapshots remain with the canonical state owner;
 * a renderer only needs the history length and cursor to enable Undo and Redo.
 * Full ReviewState is also a valid view (for browser/static hosts).
 */
export type DocumentStateView = Omit<DocumentState, "history"> & {
  readonly history: { readonly length: number };
};

export type DocumentHistoryEntry = LegacyDocumentHistoryEntry | CompactDocumentHistoryEntry;

export interface LegacyDocumentHistoryEntry {
  readonly beforeItems: readonly Annotation[];
  readonly afterItems: readonly Annotation[];
  readonly generation?: number;
  readonly beforePendingDrafts?: readonly PendingDocumentDraftV1[];
  readonly afterPendingDrafts?: readonly PendingDocumentDraftV1[];
  readonly beforeDiscardAudit?: readonly DocumentDiscardAuditV1[];
  readonly afterDiscardAudit?: readonly DocumentDiscardAuditV1[];
}

export type DocumentCommand =
  | { readonly type: "set-annotation-name"; readonly expectedRevision: number; readonly annotationName: string }
  | {
      readonly type: "add";
      readonly expectedRevision: number;
      readonly item: Annotation;
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
      readonly draft: PendingDocumentDraftV1;
    }
  | {
      readonly type: "reattach";
      readonly expectedRevision: number;
      readonly id: string;
      readonly expectedReconciliationRevision: number;
      readonly ownerViewId: string;
      readonly anchor: DocumentAnchorEvidenceV1;
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

function rectEvidence(value: JsonValue | undefined): DocumentRectEvidence {
  const valueRecord = record(value);
  const { x, y, width, height } = valueRecord;
  if (![x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part))) {
    throw new Error("Review anchor geometry is malformed");
  }
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

function selectionPages(value: JsonValue | undefined): readonly DocumentSelectionPageEvidenceV1[] | undefined {
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

function selectionBoundaries(value: JsonValue | undefined): readonly DocumentSelectionPageBoundaryV1[] | undefined {
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

function payloadText(item: Annotation, key: string): string {
  const value = item.payload[key];
  if (typeof value !== "string") throw new Error(`Review item ${item.id} is missing ${key}`);
  return value;
}

export function anchorEvidenceFromAnnotation(item: Annotation): DocumentAnchorEvidenceV1 {
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

export function canonicalizeAnnotation(
  item: Annotation,
  input: { readonly ownerViewId: string; readonly baseGeneration: number },
): Annotation {
  return item.reconciliation !== undefined
    ? item
    : {
        ...item,
        reconciliation: {
          schemaVersion: 1,
          ownerViewId: input.ownerViewId,
          baseGeneration: input.baseGeneration,
          revision: 0,
          anchor: anchorEvidenceFromAnnotation(item),
          disposition: { kind: "resolved", generation: input.baseGeneration },
          previousAnchors: [],
        },
      };
}

export function createDocumentState(input: {
  sessionId: string;
  source: DocumentSourceIdentity;
  sourceRootId?: string;
  workflowMode?: DocumentWorkflowMode;
  documentGeneration?: number;
}): DocumentState {
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

export function normalizeDocumentState(state: DocumentState): DocumentState {
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
    items: state.items.map((item) => canonicalizeAnnotation(item, {
      ownerViewId: item.reconciliation?.ownerViewId ?? "legacy-view",
      baseGeneration: item.reconciliation?.baseGeneration ?? workflow.documentGeneration,
    })),
    pendingDrafts: state.pendingDrafts ?? [],
    discardAudit: state.discardAudit ?? [],
  };
}

export function startDocumentGeneration(
  state: DocumentState,
  input: {
    readonly documentGeneration: number;
    readonly freshness?: DocumentFreshness;
  },
): DocumentState {
  if (!Number.isSafeInteger(input.documentGeneration) || input.documentGeneration <= state.workflow.documentGeneration) {
    throw new Error("Review document generation must advance monotonically");
  }
  const items = state.items.map((item) => {
    const canonical = canonicalizeAnnotation(item, {
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
      historyBoundary: 0,
    },
    history: [],
    historyCursor: 0,
  };
}

/** Revision- and generation-fenced name intent accepted with a destination. */
export interface SaveDestinationConfirmation {
  readonly command: Extract<DocumentCommand, { readonly type: 'set-annotation-name' }>;
  readonly expectedGeneration: number;
}
