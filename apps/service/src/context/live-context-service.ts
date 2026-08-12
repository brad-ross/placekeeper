import { randomUUID } from "node:crypto";

import {
  createAtomicLiveContextObservation,
  createReviewSnapshot,
  createUnavailableLiveContextObservation,
  diffReviewSnapshots,
  type ExistingPdfAnnotation,
  type LiveContextRefreshResult,
  type LiveSaveStatus,
  type ReviewSnapshot,
} from "../../../../packages/core/src/live-context.js";
import type { SourceHint } from "../../../../packages/core/src/handoff.js";
import type { JsonValue } from "../../../../packages/core/src/review-model.js";
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
  readonly inspectPdf?: (snapshot: AtomicSessionProjection) => Promise<LivePdfInspection>;
  readonly now?: () => Date;
  readonly cursor?: () => string;
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
  snapshot: AtomicSessionProjection,
): Promise<LivePdfInspection> {
  const inspected = await inspectPdfAnnotationCatalogWithEmbedPdf(snapshot.sourceBytes);
  const ownedIds = new Set(inspected.portableItems.map(({ id }) => id));
  const existingAnnotations = inspected.annotations
    .filter(({ id }) => !ownedIds.has(id))
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
  const sourceHints = snapshot.sourceRootPath === undefined || snapshot.state.items.length === 0
    ? new Map<string, SourceHint>()
    : await querySyncTexHintsForItems({
        items: snapshot.state.items,
        sourceRoot: snapshot.sourceRootPath,
        pdfPath: snapshot.sourcePdfPath,
      });
  return {
    pageCount: inspected.pageCount,
    existingAnnotations,
    warnings: inspected.annotations.some(({ hasNormalAppearance }) => !hasNormalAppearance)
      ? ["Some Existing PDF Annotations do not define a normal appearance stream."]
      : [],
    sourceHints,
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
  readonly #observedByTask = new Map<string, TaskObservationCursor>();
  readonly #taskTails = new Map<string, Promise<void>>();

  constructor(options: LiveContextServiceOptions) {
    this.#broker = options.broker;
    this.#inspectPdf = options.inspectPdf ?? inspectLivePdf;
    this.#now = options.now ?? (() => new Date());
    this.#cursor = options.cursor ?? randomUUID;
    this.evidence = options.evidence ?? new PdfEvidenceService({
      bindings: options.broker.taskBindings,
      now: this.#now,
      loadSource: async (reviewSessionId) =>
        options.broker.projectAtomicSession(reviewSessionId, async (snapshot) => ({
          documentGeneration: snapshot.documentGeneration,
          bytes: snapshot.sourceBytes,
        })),
    });
  }

  refresh(input: {
    readonly taskSessionId: string;
    readonly cursor?: string;
  }): Promise<LiveContextRefreshResult> {
    return this.#serializeTask(input.taskSessionId, () => this.#refresh(input));
  }

  async #refresh(input: {
    readonly taskSessionId: string;
    readonly cursor?: string;
  }): Promise<LiveContextRefreshResult> {
    const checkedAt = this.#now().toISOString();
    const binding = this.#broker.taskBindings.bindingForTask(input.taskSessionId);
    if (binding === undefined) {
      this.#observedByTask.delete(input.taskSessionId);
      return createUnavailableLiveContextObservation({ checkedAt, reason: "unbound" });
    }
    const previousRecord = this.#observedByTask.get(input.taskSessionId);
    const previous = previousRecord?.reviewSessionId === binding.reviewSessionId &&
      previousRecord.documentGeneration === binding.documentGeneration
      ? previousRecord.snapshot
      : undefined;
    let projected: AtomicRefreshProjection | undefined;
    try {
      projected = await this.#broker.projectAtomicSession(
        binding.reviewSessionId,
        async (snapshot): Promise<AtomicRefreshProjection> => {
          if (snapshot.documentGeneration !== binding.documentGeneration) {
            return { status: "stale-generation" };
          }
          const inspection = await this.#inspectPdf(snapshot);
          const current = createReviewSnapshot({
            cursor: this.#cursor(),
            revision: snapshot.state.revision,
            items: snapshot.state.items,
            sourceHints: inspection.sourceHints,
          });
          const identity = {
            proofreaderSessionId: snapshot.sessionId,
            documentGeneration: snapshot.documentGeneration,
            source: { ...snapshot.state.source },
            reviewRevision: current.revision,
            stateDigest: current.semanticDigest,
          };
          const catalog = this.evidence.mint({
            taskSessionId: input.taskSessionId,
            identity,
            pageCount: inspection.pageCount,
            sourceByteLength: snapshot.sourceBytes.byteLength,
            existingAnnotations: inspection.existingAnnotations,
            reviewItems: current.items,
          });
          const cursorStatus = previous !== undefined && input.cursor !== undefined &&
            input.cursor !== previous.cursor
            ? "unknown"
            : "known";
          const observation = createAtomicLiveContextObservation({
            observedAt: checkedAt,
            identity,
            saveStatus: liveSaveStatus(snapshot),
            reviewItems: diffReviewSnapshots({
              current,
              ...(previous === undefined ? {} : { previous }),
              cursorStatus,
            }),
            existingPdfAnnotations: {
              items: inspection.existingAnnotations,
              warnings: inspection.warnings,
            },
            evidence: catalog,
          });
          return { status: "projected", observation, snapshot: current };
        },
      );
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
      this.#observedByTask.delete(input.taskSessionId);
      return createUnavailableLiveContextObservation({
        checkedAt,
        reason: "stale_generation",
        ...(binding.lastVerified === undefined ? {} : { lastVerified: binding.lastVerified }),
      });
    }
    if (!this.#broker.taskBindings.markVerified(input.taskSessionId, projected.observation.identity)) {
      this.evidence.revoke(projected.observation.evidence.handle.value);
      this.#observedByTask.delete(input.taskSessionId);
      return createUnavailableLiveContextObservation({
        checkedAt,
        reason: "unavailable",
        ...(binding.lastVerified === undefined ? {} : { lastVerified: binding.lastVerified }),
      });
    }
    this.#observedByTask.set(input.taskSessionId, {
      reviewSessionId: projected.observation.identity.proofreaderSessionId,
      documentGeneration: projected.observation.identity.documentGeneration,
      snapshot: projected.snapshot,
    });
    return projected.observation;
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
