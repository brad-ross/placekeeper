import { randomUUID } from "node:crypto";

import {
  createAtomicLiveContextObservation,
  createReviewSnapshot,
  createReviewStateSummary,
  createUnavailableLiveContextObservation,
  diffReviewSnapshots,
  type ExistingPdfAnnotation,
  type LiveContextRefreshResult,
  type LiveSaveStatus,
  type ReviewSnapshot,
} from "../../../../packages/core/src/live-context.js";
import type { SourceHint } from "../../../../packages/core/src/structured-review-item.js";
import {
  anchorEvidenceFromReviewItem,
  normalizeReviewSelectionAnchor,
  type JsonValue,
  type ReviewItem,
} from "../../../../packages/core/src/review-model.js";
import { portableAnnotationProjectionId } from "../../../../packages/core/src/grouped-annotation-envelope.js";
import { isNavigationalPdfAnnotationSubtype } from "../../../../packages/core/src/pdf-annotation-classification.js";
import { inspectPdfAnnotationCatalogWithEmbedPdf } from "../../../../packages/pdf-backends/src/embedpdf-adapter.js";
import {
  SessionBroker,
  type AtomicSessionProjection,
} from "../sessions/session-broker.js";
import { querySyncTexHintsForItems } from "../synctex/query.js";
import { PdfEvidenceService } from "./pdf-evidence-service.js";

export interface LivePdfInspection {
  readonly pageCount: number;
  readonly existingAnnotations: readonly ExistingPdfAnnotation[];
  readonly warnings: readonly string[];
  readonly sourceHints: ReadonlyMap<string, SourceHint>;
}

export interface LiveContextServiceOptions {
  readonly broker: SessionBroker;
  readonly evidence?: PdfEvidenceService;
  readonly inspectPdf?: (
    snapshot: AtomicSessionProjection & { readonly sourceBytes: Buffer },
  ) => Promise<LivePdfInspection>;
  readonly now?: () => Date;
  readonly cursor?: () => string;
  readonly querySourceHints?: typeof querySyncTexHintsForItems;
  readonly sourceHintBudgetMs?: number;
}

type AtomicRefreshProjection =
  | { readonly status: "stale-generation" }
  | {
      readonly status: "projected";
      readonly observation: Extract<LiveContextRefreshResult, { status: "current" }>;
      readonly snapshot: ReviewSnapshot;
    };

interface TaskObservationCursor {
  readonly reviewSessionId: string;
  readonly documentGeneration: number;
  readonly snapshot: ReviewSnapshot;
}

interface CachedPdfInspection {
  readonly key: string;
  readonly inspection: LivePdfInspection;
}

interface CachedSourceHint {
  readonly reviewSessionId: string;
  readonly hint: SourceHint | undefined;
}

const MAX_REFRESH_ATTEMPTS = 2;
const MAX_TASK_OBSERVATIONS = 128;
const MAX_PDF_INSPECTIONS = 32;
const MAX_SOURCE_HINTS = 2_048;
const SOURCE_HINT_CONCURRENCY = 2;
const SOURCE_HINT_BUDGET_MS = 1_000;
const MAX_PENDING_DELIVERIES_PER_TASK = 8;

async function forEachConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const value = values[next++];
        if (value !== undefined) await operation(value);
      }
    },
  ));
}

async function within<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function toRect(rect: {
  readonly origin: { readonly x: number; readonly y: number };
  readonly size: { readonly width: number; readonly height: number };
}) {
  return {
    x: rect.origin.x,
    y: rect.origin.y,
    width: rect.size.width,
    height: rect.size.height,
  };
}

function metadataValue(value: unknown): JsonValue | undefined {
  if (
    value === null || typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (Array.isArray(value)) {
    const entries = value.map(metadataValue);
    return entries.every((entry) => entry !== undefined)
      ? entries as JsonValue[]
      : undefined;
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const projected = metadataValue(entry);
      if (projected !== undefined) result[key] = projected;
    }
    return result;
  }
  return undefined;
}

/** Inspects only the immutable source snapshot supplied by the broker. */
export async function inspectLivePdf(
  snapshot: AtomicSessionProjection & { readonly sourceBytes: Buffer },
): Promise<LivePdfInspection> {
  const inspected = await inspectPdfAnnotationCatalogWithEmbedPdf(snapshot.sourceBytes);
  const ownedIds = new Set(inspected.portableItems.flatMap((item) => {
    const anchor = anchorEvidenceFromReviewItem(item);
    const projectionCount = anchor.kind === "selection"
      ? normalizeReviewSelectionAnchor(anchor).pages.length
      : 1;
    return Array.from({ length: projectionCount }, (_, projectionIndex) =>
      portableAnnotationProjectionId(item.id, projectionIndex, projectionCount));
  }));
  for (const { annotationId } of inspected.nativeAnnotations ?? []) ownedIds.add(annotationId);
  const reviewerAnnotations = inspected.annotations.filter(
    ({ id, subtype }) => !ownedIds.has(id) && !isNavigationalPdfAnnotationSubtype(subtype) && !["popup", "widget", "xfawidget"].includes(subtype.toLowerCase()),
  );
  const existingAnnotations = reviewerAnnotations
    .map((annotation): ExistingPdfAnnotation => {
      const segmentRects = annotation.segmentRects?.map(toRect);
      const metadata = metadataValue({
        preservationFingerprint: annotation.preservationFingerprint,
        ...(segmentRects === undefined ? {} : { segmentRects }),
      });
      return {
        id: annotation.id,
        origin: "source-pdf",
        readOnly: true,
        pageIndex: annotation.pageIndex,
        subtype: annotation.subtype,
        ...(annotation.contents.length === 0 ? {} : { contents: annotation.contents }),
        ...(annotation.author === undefined ? {} : { author: annotation.author }),
        rect: toRect(annotation.rect),
        flags: annotation.flags,
        appearanceModes: annotation.hasNormalAppearance ? ["normal"] : [],
        supportedAppearance: annotation.hasNormalAppearance,
        ...(metadata === undefined || metadata === null || typeof metadata !== "object" || Array.isArray(metadata)
          ? {}
          : { metadata }),
      };
    });
  return {
    pageCount: inspected.pageCount,
    existingAnnotations,
    warnings: reviewerAnnotations.some(({ hasNormalAppearance }) => !hasNormalAppearance)
      ? ["Some Existing PDF Annotations do not define a normal appearance stream."]
      : [],
    sourceHints: new Map(),
  };
}

function liveSaveStatus(snapshot: AtomicSessionProjection): LiveSaveStatus {
  const destination: LiveSaveStatus["destination"] = snapshot.destination.phase === "none"
    ? { phase: "none", generation: 0 }
    : snapshot.destination.phase === "establishing"
      ? { phase: "establishing", generation: snapshot.destination.generation }
      : {
          phase: "active",
          generation: snapshot.destination.generation,
          kind: snapshot.destination.kind,
        };
  return {
    destination,
    sync: {
      phase: snapshot.sync.phase,
      desiredRevision: snapshot.sync.desiredRevision,
      savedRevision: snapshot.sync.savedRevision,
      ...(snapshot.sync.failure === undefined ? {} : { failure: snapshot.sync.failure }),
    },
  };
}

export class LiveContextService {
  readonly evidence: PdfEvidenceService;
  readonly #broker: SessionBroker;
  readonly #inspectPdf: NonNullable<LiveContextServiceOptions["inspectPdf"]>;
  readonly #now: () => Date;
  readonly #cursor: () => string;
  readonly #querySourceHints: typeof querySyncTexHintsForItems;
  readonly #sourceHintBudgetMs: number;
  readonly #observedByTask = new Map<string, TaskObservationCursor>();
  readonly #pendingDeliveriesByTask = new Map<string, Map<string, TaskObservationCursor>>();
  readonly #pdfInspectionBySession = new Map<string, CachedPdfInspection>();
  readonly #sourceHints = new Map<string, CachedSourceHint>();
  readonly #taskTails = new Map<string, Promise<void>>();

  constructor(options: LiveContextServiceOptions) {
    this.#broker = options.broker;
    this.#inspectPdf = options.inspectPdf ?? inspectLivePdf;
    this.#now = options.now ?? (() => new Date());
    this.#cursor = options.cursor ?? randomUUID;
    this.#querySourceHints = options.querySourceHints ?? querySyncTexHintsForItems;
    this.#sourceHintBudgetMs = options.sourceHintBudgetMs ?? SOURCE_HINT_BUDGET_MS;
    this.evidence = options.evidence ?? new PdfEvidenceService({
      bindings: options.broker.taskBindings,
      now: this.#now,
      loadSource: async (reviewSessionId, expected) =>
        options.broker.loadVerifiedSourceSnapshot(reviewSessionId, expected),
    });
    options.broker.onSessionEnd((sessionId) => this.discardSession(sessionId));
  }

  discardTask(taskSessionId: string, reviewSessionId?: string): void {
    const observed = this.#observedByTask.get(taskSessionId);
    const pending = this.#pendingDeliveriesByTask.get(taskSessionId)?.values().next().value as
      | TaskObservationCursor
      | undefined;
    this.#observedByTask.delete(taskSessionId);
    this.#pendingDeliveriesByTask.delete(taskSessionId);
    this.evidence.revokeTask(taskSessionId);
    const sessionId = observed?.reviewSessionId ?? pending?.reviewSessionId ?? reviewSessionId;
    if (sessionId !== undefined) this.#discardSessionCaches(sessionId);
  }

  discardSession(reviewSessionId: string): void {
    for (const [taskSessionId, observed] of this.#observedByTask) {
      if (observed.reviewSessionId === reviewSessionId) {
        this.#observedByTask.delete(taskSessionId);
        this.#pendingDeliveriesByTask.delete(taskSessionId);
      }
    }
    for (const [taskSessionId, deliveries] of this.#pendingDeliveriesByTask) {
      if ([...deliveries.values()].some((delivery) => delivery.reviewSessionId === reviewSessionId)) {
        this.#pendingDeliveriesByTask.delete(taskSessionId);
      }
    }
    this.evidence.revokeSession(reviewSessionId);
    this.#discardSessionCaches(reviewSessionId);
  }

  discardAll(): void {
    this.#observedByTask.clear();
    this.#pendingDeliveriesByTask.clear();
    this.#pdfInspectionBySession.clear();
    this.#sourceHints.clear();
    this.evidence.revokeAll();
  }

  refresh(input: {
    readonly taskSessionId: string;
    readonly cursor?: string;
  }): Promise<LiveContextRefreshResult> {
    return this.#serializeTask(input.taskSessionId, () => this.#refresh(input));
  }

  acknowledge(input: { readonly taskSessionId: string; readonly cursor: string }): boolean {
    const deliveries = this.#pendingDeliveriesByTask.get(input.taskSessionId);
    const delivered = deliveries?.get(input.cursor);
    if (delivered === undefined) return false;
    const binding = this.#broker.taskBindings.bindingForTask(input.taskSessionId);
    if (
      binding === undefined ||
      binding.reviewSessionId !== delivered.reviewSessionId ||
      binding.documentGeneration !== delivered.documentGeneration
    ) return false;
    this.#observedByTask.set(input.taskSessionId, delivered);
    this.#pendingDeliveriesByTask.delete(input.taskSessionId);
    this.#trim(this.#observedByTask, MAX_TASK_OBSERVATIONS, (taskSessionId) => {
      this.evidence.revokeTask(taskSessionId);
    });
    return true;
  }

  async #refresh(input: {
    readonly taskSessionId: string;
    readonly cursor?: string;
  }): Promise<LiveContextRefreshResult> {
    const checkedAt = this.#now().toISOString();
    if (input.cursor !== undefined) {
      // Non-hook clients may explicitly acknowledge the prior cursor in their
      // next refresh request. Packaged prompt hooks use ack-context after the
      // stdout delivery succeeds.
      this.acknowledge({ taskSessionId: input.taskSessionId, cursor: input.cursor });
    }
    const previousRecord = this.#touch(this.#observedByTask, input.taskSessionId);
    const binding = this.#broker.taskBindings.bindingForTask(input.taskSessionId);
    if (binding === undefined) {
      const reason = this.#broker.taskBindings.unavailableReasonForTask(input.taskSessionId);
      this.discardTask(input.taskSessionId);
      return createUnavailableLiveContextObservation({ checkedAt, reason });
    }
    const previous = previousRecord?.reviewSessionId === binding.reviewSessionId &&
      previousRecord.documentGeneration === binding.documentGeneration
      ? previousRecord.snapshot
      : undefined;
    let projected: AtomicRefreshProjection | undefined;
    try {
      for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt += 1) {
        const snapshot = await this.#broker.snapshotAtomicSession(binding.reviewSessionId);
        if (snapshot === undefined) break;
        if (snapshot.documentGeneration !== binding.documentGeneration) {
          projected = { status: "stale-generation" };
          break;
        }
        const inspection = await this.#inspectionFor(snapshot);
        const sourceHints = await this.#sourceHintsFor(snapshot, inspection.sourceHints);
        const currentSnapshot = await this.#broker.snapshotAtomicSession(binding.reviewSessionId);
        if (currentSnapshot === undefined) break;
        if (!this.#samePublishableState(snapshot, currentSnapshot)) continue;
        const current = createReviewSnapshot({
          cursor: this.#cursor(),
          revision: snapshot.state.revision,
          items: snapshot.state.items,
          sourceHints,
        });
        const identity = {
          placekeeperSessionId: snapshot.sessionId,
          documentGeneration: snapshot.documentGeneration,
          source: { ...snapshot.state.source },
          reviewRevision: current.revision,
          stateDigest: current.semanticDigest,
        };
        const cursorStatus = previous !== undefined &&
          (input.cursor === undefined || input.cursor === previous.cursor)
          ? "known"
          : "unknown";
        const diffPrevious = previous ?? (input.cursor === undefined
          ? undefined
          : { ...current, cursor: input.cursor });
        const reviewItems = diffReviewSnapshots({
          current,
          ...(diffPrevious === undefined ? {} : { previous: diffPrevious }),
          cursorStatus,
        });
        const catalog = this.evidence.mint({
          taskSessionId: input.taskSessionId,
          identity,
          pageCount: inspection.pageCount,
          sourceByteLength: snapshot.sourceByteLength,
          existingAnnotations: inspection.existingAnnotations,
          reviewItems: current.items,
          reviewChanges: reviewItems,
        });
        const observation = createAtomicLiveContextObservation({
          observedAt: checkedAt,
          identity,
          saveStatus: liveSaveStatus(snapshot),
          reviewItems,
          existingPdfAnnotations: {
            items: inspection.existingAnnotations,
            warnings: inspection.warnings,
          },
          evidence: catalog,
          reviewState: createReviewStateSummary(snapshot.state),
        });
        projected = { status: "projected", observation, snapshot: current };
        break;
      }
    } catch {
      return createUnavailableLiveContextObservation({
        checkedAt,
        reason: "unavailable",
        ...(binding.lastVerified === undefined ? {} : { lastVerified: binding.lastVerified }),
      });
    }

    if (projected === undefined) {
      return createUnavailableLiveContextObservation({
        checkedAt,
        reason: "unavailable",
        ...(binding.lastVerified === undefined ? {} : { lastVerified: binding.lastVerified }),
      });
    }
    if (projected.status === "stale-generation") {
      this.discardTask(input.taskSessionId, binding.reviewSessionId);
      return createUnavailableLiveContextObservation({
        checkedAt,
        reason: "stale_generation",
        ...(binding.lastVerified === undefined ? {} : { lastVerified: binding.lastVerified }),
      });
    }
    if (!this.#broker.taskBindings.markVerified(input.taskSessionId, projected.observation.identity)) {
      this.evidence.revoke(projected.observation.evidence.handle.value);
      this.discardTask(input.taskSessionId, binding.reviewSessionId);
      return createUnavailableLiveContextObservation({
        checkedAt,
        reason: "unavailable",
        ...(binding.lastVerified === undefined ? {} : { lastVerified: binding.lastVerified }),
      });
    }
    const delivery = {
      reviewSessionId: projected.observation.identity.placekeeperSessionId,
      documentGeneration: projected.observation.identity.documentGeneration,
      snapshot: projected.snapshot,
    };
    const deliveries = this.#pendingDeliveriesByTask.get(input.taskSessionId) ?? new Map();
    deliveries.set(projected.snapshot.cursor, delivery);
    while (deliveries.size > MAX_PENDING_DELIVERIES_PER_TASK) {
      const oldest = deliveries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      deliveries.delete(oldest);
    }
    this.#pendingDeliveriesByTask.set(input.taskSessionId, deliveries);
    return projected.observation;
  }

  async #inspectionFor(snapshot: AtomicSessionProjection): Promise<LivePdfInspection> {
    const key = [snapshot.sessionId, snapshot.documentGeneration, snapshot.state.source.digest].join("\0");
    const cached = this.#touch(this.#pdfInspectionBySession, snapshot.sessionId);
    if (cached?.key === key) return cached.inspection;
    const source = await this.#broker.loadVerifiedSourceSnapshot(snapshot.sessionId, {
      documentGeneration: snapshot.documentGeneration,
      sourceDigest: snapshot.state.source.digest,
    });
    if (source === undefined) throw new Error("The immutable PDF source changed during inspection");
    const inspection = await this.#inspectPdf({ ...snapshot, sourceBytes: source.bytes });
    this.#pdfInspectionBySession.set(snapshot.sessionId, { key, inspection });
    this.#trim(this.#pdfInspectionBySession, MAX_PDF_INSPECTIONS);
    return inspection;
  }

  async #sourceHintsFor(
    snapshot: AtomicSessionProjection,
    staticHints: ReadonlyMap<string, SourceHint>,
  ): Promise<ReadonlyMap<string, SourceHint>> {
    if (snapshot.sourceRootPath === undefined || snapshot.state.items.length === 0) {
      this.#discardSourceHints(snapshot.sessionId);
      return staticHints;
    }
    const hints = new Map(staticHints);
    const currentKeys = new Set<string>();
    const missing: Array<{ readonly item: ReviewItem; readonly key: string }> = [];
    for (const item of snapshot.state.items) {
      const key = this.#sourceHintKey(snapshot, item);
      currentKeys.add(key);
      const cached = this.#touch(this.#sourceHints, key);
      if (cached === undefined) missing.push({ item, key });
      else if (cached.hint !== undefined) hints.set(item.id, cached.hint);
    }
    const deadlineMs = Date.now() + this.#sourceHintBudgetMs;
    await forEachConcurrent(missing, SOURCE_HINT_CONCURRENCY, async ({ item, key }) => {
      const timeoutMs = deadlineMs - Date.now();
      if (timeoutMs <= 0) return;
      const queried = await within(this.#querySourceHints({
        items: [item],
        sourceRoot: snapshot.sourceRootPath!,
        pdfPath: snapshot.sourcePdfPath,
        timeoutMs,
      }), timeoutMs, new Map<string, SourceHint>());
      const hint = queried.get(item.id);
      this.#sourceHints.set(key, { reviewSessionId: snapshot.sessionId, hint });
      if (hint !== undefined) hints.set(item.id, hint);
    });
    for (const [key, cached] of this.#sourceHints) {
      if (cached.reviewSessionId === snapshot.sessionId && !currentKeys.has(key)) {
        this.#sourceHints.delete(key);
      }
    }
    this.#trim(this.#sourceHints, MAX_SOURCE_HINTS);
    return hints;
  }

  #sourceHintKey(snapshot: AtomicSessionProjection, item: ReviewItem): string {
    const geometry = item.payload[
      item.kind === "insert" || item.kind === "pageNote" || item.kind === "pdfAnnotation" ? "position" : "rect"
    ];
    return JSON.stringify([
      snapshot.sessionId,
      snapshot.documentGeneration,
      snapshot.state.source.digest,
      snapshot.sourceRootPath,
      snapshot.sourcePdfPath,
      item.id,
      item.pageIndex,
      geometry,
    ]);
  }

  #discardSessionCaches(reviewSessionId: string): void {
    this.#pdfInspectionBySession.delete(reviewSessionId);
    this.#discardSourceHints(reviewSessionId);
  }

  #discardSourceHints(reviewSessionId: string): void {
    for (const [key, cached] of this.#sourceHints) {
      if (cached.reviewSessionId === reviewSessionId) this.#sourceHints.delete(key);
    }
  }

  #touch<K, V>(values: Map<K, V>, key: K): V | undefined {
    const value = values.get(key);
    if (value === undefined) return undefined;
    values.delete(key);
    values.set(key, value);
    return value;
  }

  #trim<K, V>(values: Map<K, V>, maximum: number, onEvict?: (key: K, value: V) => void): void {
    while (values.size > maximum) {
      const oldest = values.entries().next().value as [K, V] | undefined;
      if (oldest === undefined) return;
      values.delete(oldest[0]);
      onEvict?.(oldest[0], oldest[1]);
    }
  }

  #samePublishableState(
    before: AtomicSessionProjection,
    after: AtomicSessionProjection,
  ): boolean {
    const beforeSummary = createReviewStateSummary(before.state);
    const afterSummary = createReviewStateSummary(after.state);
    return before.sessionId === after.sessionId &&
      before.documentGeneration === after.documentGeneration &&
      before.state.revision === after.state.revision &&
      before.state.source.digest === after.state.source.digest &&
      beforeSummary.reconciliation.dispositionDigest === afterSummary.reconciliation.dispositionDigest &&
      before.destination.phase === after.destination.phase &&
      before.destination.generation === after.destination.generation &&
      before.sync.phase === after.sync.phase &&
      before.sync.desiredRevision === after.sync.desiredRevision &&
      before.sync.savedRevision === after.sync.savedRevision &&
      before.sync.failure === after.sync.failure;
  }

  async #serializeTask<T>(taskSessionId: string, work: () => Promise<T>): Promise<T> {
    const predecessor = this.#taskTails.get(taskSessionId) ?? Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#taskTails.set(taskSessionId, promise);
    await predecessor;
    try {
      return await work();
    } finally {
      resolve();
      if (this.#taskTails.get(taskSessionId) === promise) {
        this.#taskTails.delete(taskSessionId);
      }
    }
  }
}
