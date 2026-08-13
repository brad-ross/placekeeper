import { createHash, randomBytes } from "node:crypto";

import {
  createPdfEvidenceCatalog,
  type ExistingPdfAnnotation,
  type LiveObservationIdentity,
  type PdfEvidenceCatalog,
  type ReviewItemChanges,
} from "../../../../packages/core/src/live-context.js";
import type { StructuredReviewItem } from "../../../../packages/core/src/structured-review-item.js";
import type { TaskBindingRegistry } from "./task-binding-registry.js";
import {
  inspectPdfPageEvidence,
  type InspectedPdfPageEvidence,
  type PdfPageEvidenceRequest,
} from "../pdf/inspect-pdf.js";

const DEFAULT_HANDLE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ANNOTATION_PAGE_SIZE = 1_000;
const MAX_REVIEW_ITEM_PAGE_SIZE = 256;
const MAX_EVIDENCE_RECORDS = 256;
const DEFAULT_MAX_RETAINED_PAYLOAD_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_INSPECTION_CACHE_BYTES = 64 * 1024 * 1024;

export type PdfEvidenceRequest =
  | { readonly kind: "document"; readonly maxBytes?: number }
  | ({ readonly maxBytes?: number } & PdfPageEvidenceRequest)
  | {
      readonly kind: "raw-annotations";
      readonly offset?: number;
      readonly limit?: number;
      readonly maxBytes?: number;
    };

export type PdfEvidenceUnavailableReason =
  | "unauthorized"
  | "expired"
  | "stale_generation"
  | "invalid_request"
  | "too_large"
  | "unavailable";

type EvidenceUnavailable = {
  readonly status: "unavailable";
  readonly reason: PdfEvidenceUnavailableReason;
};

export type PdfEvidenceRetrievalResult =
  | {
      readonly status: "ok";
      readonly kind: PdfEvidenceRequest["kind"];
      readonly mediaType: string;
      readonly bytes: Buffer;
    }
  | EvidenceUnavailable;

export type ReviewItemRetrievalResult =
  | {
      readonly status: "ok";
      readonly kind: "review-items";
      readonly mediaType: "application/json";
      readonly bytes: Buffer;
    }
  | EvidenceUnavailable;

export type ReviewChangeRetrievalResult =
  | {
      readonly status: "ok";
      readonly kind: "review-changes";
      readonly mediaType: "application/json";
      readonly bytes: Buffer;
    }
  | EvidenceUnavailable;

export interface PdfEvidenceSource {
  readonly documentGeneration: number;
  readonly bytes: Buffer;
}

interface EvidenceRecord {
  readonly taskSessionId: string;
  readonly identity: LiveObservationIdentity;
  readonly pageCount: number;
  readonly expiresAtMs: number;
  readonly maxBytes: number;
  readonly payloadKey: string;
}

interface EvidencePayload {
  references: number;
  readonly byteLength: number;
  readonly existingAnnotations: readonly ExistingPdfAnnotation[];
  readonly reviewItems: readonly StructuredReviewItem[];
  readonly reviewChanges: ReviewItemChanges;
}

interface EvidenceCacheEntry {
  promise: Promise<unknown>;
  byteLength: number;
}

export type EvidenceHandleAuthorization =
  | { readonly status: "ok"; readonly taskSessionId: string }
  | { readonly status: "unavailable"; readonly reason: PdfEvidenceUnavailableReason };

export interface PdfEvidenceServiceOptions {
  readonly bindings: TaskBindingRegistry;
  readonly loadSource: (
    reviewSessionId: string,
    expected: { readonly documentGeneration: number; readonly sourceDigest: string },
  ) => Promise<PdfEvidenceSource | undefined>;
  readonly inspectPage?: (
    bytes: Uint8Array,
    request: PdfPageEvidenceRequest,
  ) => Promise<InspectedPdfPageEvidence>;
  readonly now?: () => Date;
  readonly handleTtlMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRetainedPayloadBytes?: number;
  readonly maxInspectionCacheBytes?: number;
  readonly randomHandle?: () => string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function unavailable(reason: PdfEvidenceUnavailableReason): EvidenceUnavailable {
  return { status: "unavailable", reason };
}

export class PdfEvidenceService {
  readonly #bindings: TaskBindingRegistry;
  readonly #loadSource: PdfEvidenceServiceOptions["loadSource"];
  readonly #inspectPage: NonNullable<PdfEvidenceServiceOptions["inspectPage"]>;
  readonly #now: () => Date;
  readonly #handleTtlMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxRetainedPayloadBytes: number;
  readonly #maxInspectionCacheBytes: number;
  readonly #randomHandle: () => string;
  readonly #records = new Map<string, EvidenceRecord>();
  readonly #payloads = new Map<string, EvidencePayload>();
  readonly #inspectionCache = new Map<string, EvidenceCacheEntry>();
  #retainedPayloadBytes = 0;
  #inspectionCacheBytes = 0;

  constructor(options: PdfEvidenceServiceOptions) {
    this.#bindings = options.bindings;
    this.#loadSource = options.loadSource;
    this.#inspectPage = options.inspectPage ?? inspectPdfPageEvidence;
    this.#now = options.now ?? (() => new Date());
    this.#handleTtlMs = options.handleTtlMs ?? DEFAULT_HANDLE_TTL_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#maxRetainedPayloadBytes = options.maxRetainedPayloadBytes ?? DEFAULT_MAX_RETAINED_PAYLOAD_BYTES;
    this.#maxInspectionCacheBytes = options.maxInspectionCacheBytes ?? DEFAULT_MAX_INSPECTION_CACHE_BYTES;
    this.#randomHandle = options.randomHandle ??
      (() => `evidence_${randomBytes(32).toString("base64url")}`);
    if (!validPositiveInteger(this.#handleTtlMs)) {
      throw new RangeError("handleTtlMs must be a positive safe integer");
    }
    if (!validPositiveInteger(this.#maxResponseBytes)) {
      throw new RangeError("maxResponseBytes must be a positive safe integer");
    }
    if (!validPositiveInteger(this.#maxRetainedPayloadBytes)) {
      throw new RangeError("maxRetainedPayloadBytes must be a positive safe integer");
    }
    if (!validPositiveInteger(this.#maxInspectionCacheBytes)) {
      throw new RangeError("maxInspectionCacheBytes must be a positive safe integer");
    }
  }

  mint(input: {
    readonly taskSessionId: string;
    readonly identity: LiveObservationIdentity;
    readonly pageCount: number;
    readonly sourceByteLength: number;
    readonly existingAnnotations: readonly ExistingPdfAnnotation[];
    readonly reviewItems: readonly StructuredReviewItem[];
    readonly reviewChanges?: ReviewItemChanges;
  }): PdfEvidenceCatalog {
    this.#sweep();
    const binding = this.#bindings.bindingForTask(input.taskSessionId);
    if (
      binding === undefined ||
      binding.reviewSessionId !== input.identity.placekeeperSessionId ||
      binding.documentGeneration !== input.identity.documentGeneration
    ) {
      throw new Error("The task does not own this PDF evidence scope");
    }
    if (!Number.isSafeInteger(input.pageCount) || input.pageCount < 0) {
      throw new RangeError("pageCount must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(input.sourceByteLength) || input.sourceByteLength < 0) {
      throw new RangeError("sourceByteLength must be a non-negative safe integer");
    }
    this.#pruneTaskIdentity(input.taskSessionId, input.identity);
    const value = this.#randomHandle();
    const recordKey = digest(value);
    const expiresAtMs = this.#now().getTime() + this.#handleTtlMs;
    const reviewChanges: ReviewItemChanges = input.reviewChanges ?? {
      mode: "full",
      reason: "initial",
      cursor: "evidence-only",
      revision: input.identity.reviewRevision,
      semanticDigest: input.identity.stateDigest,
      itemCount: input.reviewItems.length,
      items: input.reviewItems,
    };
    const payloadKey = [
      input.taskSessionId,
      input.identity.placekeeperSessionId,
      input.identity.documentGeneration,
      input.identity.stateDigest,
      digest(JSON.stringify([input.existingAnnotations, input.reviewItems, reviewChanges])),
    ].join("\0");
    let payload = this.#payloads.get(payloadKey);
    if (payload === undefined) {
      const byteLength = Buffer.byteLength(JSON.stringify([
        input.existingAnnotations,
        input.reviewItems,
        reviewChanges,
      ]));
      if (byteLength > this.#maxRetainedPayloadBytes) {
        throw new RangeError("PDF evidence payload exceeds the retained evidence byte limit");
      }
      payload = {
        references: 0,
        byteLength,
        existingAnnotations: structuredClone(input.existingAnnotations),
        reviewItems: structuredClone(input.reviewItems),
        reviewChanges: structuredClone(reviewChanges),
      };
      this.#payloads.set(payloadKey, payload);
      this.#retainedPayloadBytes += byteLength;
    }
    payload.references += 1;
    const record: EvidenceRecord = {
      taskSessionId: input.taskSessionId,
      identity: structuredClone(input.identity),
      pageCount: input.pageCount,
      expiresAtMs,
      maxBytes: this.#maxResponseBytes,
      payloadKey,
    };
    this.#deleteRecord(recordKey);
    this.#records.set(recordKey, record);
    this.#trimRecords();
    const pages = input.pageCount === 0
      ? undefined
      : { start: 0, end: input.pageCount - 1 };
    return createPdfEvidenceCatalog({
      handle: {
        schemaVersion: 1,
        value,
        documentGeneration: input.identity.documentGeneration,
        observationDigest: input.identity.stateDigest,
        expiresAt: new Date(expiresAtMs).toISOString(),
        maxBytes: this.#maxResponseBytes,
      },
      descriptors: [
        { id: "document", kind: "document", mediaType: "application/pdf" },
        ...(pages === undefined ? [] : [
          { id: "page-text", kind: "page-text" as const, mediaType: "text/plain; charset=utf-8", pages },
          { id: "page-layout", kind: "page-layout" as const, mediaType: "application/json", pages },
          {
            id: "page-render",
            kind: "page-render" as const,
            mediaType: "application/vnd.placekeeper.rgba+json",
            pages,
          },
        ]),
        { id: "raw-annotations", kind: "raw-annotations", mediaType: "application/json" },
      ],
    });
  }

  revoke(handle: string): void {
    this.#deleteRecord(digest(handle));
  }

  revokeTask(taskSessionId: string): void {
    for (const [key, record] of this.#records) {
      if (record.taskSessionId === taskSessionId) this.#deleteRecord(key);
    }
  }

  revokeSession(reviewSessionId: string): void {
    for (const [key, record] of this.#records) {
      if (record.identity.placekeeperSessionId === reviewSessionId) this.#deleteRecord(key);
    }
  }

  revokeAll(): void {
    for (const key of [...this.#records.keys()]) this.#deleteRecord(key);
  }

  /** Resolve the bound task behind a prompt-scoped handle without exposing the
   * task id in model context. Source-work commands use this as their bearer
   * boundary, then perform their own fresh observation before doing any work. */
  authorizeHandle(handle: string): EvidenceHandleAuthorization {
    const key = digest(handle);
    const record = this.#record(key);
    if (record === undefined) return { status: "unavailable", reason: "unauthorized" };
    if (record.expiresAtMs <= this.#now().getTime()) {
      this.#deleteRecord(key);
      return { status: "unavailable", reason: "expired" };
    }
    const binding = this.#bindings.bindingForTask(record.taskSessionId);
    if (
      binding === undefined ||
      binding.reviewSessionId !== record.identity.placekeeperSessionId ||
      binding.documentGeneration !== record.identity.documentGeneration ||
      binding.lastVerified?.stateDigest !== record.identity.stateDigest
    ) {
      this.#deleteRecord(key);
      return { status: "unavailable", reason: "unauthorized" };
    }
    return { status: "ok", taskSessionId: record.taskSessionId };
  }

  /** The opaque handle is delivered only inside the bound task's trusted
   * prompt context. This installed-CLI entry point resolves its task scope
   * without exposing the Codex task id to the model. All normal lease,
   * generation, digest, expiry, and byte checks still run in retrieve(). */
  retrieveWithHandle(input: {
    readonly handle: string;
    readonly request: PdfEvidenceRequest;
  }): Promise<PdfEvidenceRetrievalResult> {
    const authorization = this.authorizeHandle(input.handle);
    if (authorization.status === "unavailable") return Promise.resolve(authorization);
    return this.retrieve({
      taskSessionId: authorization.taskSessionId,
      handle: input.handle,
      request: input.request,
    });
  }

  retrieveReviewItemsWithHandle(input: {
    readonly handle: string;
    readonly offset?: number;
    readonly limit?: number;
    readonly pageIndex?: number;
    readonly maxBytes?: number;
  }): ReviewItemRetrievalResult {
    const authorization = this.authorizeHandle(input.handle);
    if (authorization.status === "unavailable") return authorization;
    const record = this.#records.get(digest(input.handle))!;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    const maxBytes = input.maxBytes ?? Math.min(record.maxBytes, 1024 * 1024);
    if (
      !Number.isSafeInteger(offset) || offset < 0 ||
      !validPositiveInteger(limit) || limit > MAX_REVIEW_ITEM_PAGE_SIZE ||
      !validPositiveInteger(maxBytes) || maxBytes > record.maxBytes ||
      (input.pageIndex !== undefined && (!Number.isSafeInteger(input.pageIndex) || input.pageIndex < 0))
    ) return unavailable("invalid_request");
    const reviewItems = this.#payload(record).reviewItems;
    const filtered = input.pageIndex === undefined
      ? reviewItems
      : reviewItems.filter(({ pageIndex }) => pageIndex === input.pageIndex);
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length < filtered.length ? offset + items.length : undefined;
    const bytes = Buffer.from(JSON.stringify({
      offset,
      limit,
      total: filtered.length,
      ...(input.pageIndex === undefined ? {} : { pageIndex: input.pageIndex }),
      ...(nextOffset === undefined ? {} : { nextOffset }),
      items,
    }));
    if (bytes.byteLength > maxBytes) return unavailable("too_large");
    return { status: "ok", kind: "review-items", mediaType: "application/json", bytes };
  }

  retrieveReviewChangesWithHandle(input: {
    readonly handle: string;
    readonly offset?: number;
    readonly limit?: number;
    readonly maxBytes?: number;
  }): ReviewChangeRetrievalResult {
    const authorization = this.authorizeHandle(input.handle);
    if (authorization.status === "unavailable") return authorization;
    const record = this.#records.get(digest(input.handle))!;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    const maxBytes = input.maxBytes ?? Math.min(record.maxBytes, 1024 * 1024);
    if (
      !Number.isSafeInteger(offset) || offset < 0 ||
      !validPositiveInteger(limit) || limit > MAX_REVIEW_ITEM_PAGE_SIZE ||
      !validPositiveInteger(maxBytes) || maxBytes > record.maxBytes
    ) return unavailable("invalid_request");
    const changes = this.#payload(record).reviewChanges;
    const entries = changes.mode === "delta"
      ? [
          ...changes.added.map((item) => ({ change: "added" as const, item })),
          ...changes.edited.map((item) => ({ change: "edited" as const, item })),
          ...changes.removed.map((id) => ({ change: "removed" as const, id })),
        ]
      : changes.mode === "full"
        ? changes.items.map((item) => ({ change: "current" as const, item }))
        : [];
    const page = entries.slice(offset, offset + limit);
    const nextOffset = offset + page.length < entries.length ? offset + page.length : undefined;
    const bytes = Buffer.from(JSON.stringify({
      mode: changes.mode,
      cursor: changes.cursor,
      offset,
      limit,
      total: entries.length,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      changes: page,
    }));
    if (bytes.byteLength > maxBytes) return unavailable("too_large");
    return { status: "ok", kind: "review-changes", mediaType: "application/json", bytes };
  }

  async retrieve(input: {
    readonly taskSessionId: string;
    readonly handle: string;
    readonly request: PdfEvidenceRequest;
  }): Promise<PdfEvidenceRetrievalResult> {
    const recordKey = digest(input.handle);
    const record = this.#record(recordKey);
    if (record === undefined || record.taskSessionId !== input.taskSessionId) {
      return unavailable("unauthorized");
    }
    if (record.expiresAtMs <= this.#now().getTime()) {
      this.#deleteRecord(recordKey);
      return unavailable("expired");
    }
    const binding = this.#bindings.bindingForTask(input.taskSessionId);
    if (
      binding === undefined ||
      binding.reviewSessionId !== record.identity.placekeeperSessionId ||
      binding.documentGeneration !== record.identity.documentGeneration ||
      binding.lastVerified?.stateDigest !== record.identity.stateDigest
    ) {
      this.#deleteRecord(recordKey);
      return unavailable("unauthorized");
    }

    const maxBytes = input.request.maxBytes ?? record.maxBytes;
    if (!validPositiveInteger(maxBytes) || maxBytes > record.maxBytes) {
      return unavailable("invalid_request");
    }
    if (input.request.kind !== "document" && input.request.kind !== "raw-annotations" && (
      !Number.isSafeInteger(input.request.pageIndex) ||
      input.request.pageIndex < 0 ||
      input.request.pageIndex >= record.pageCount
    )) return unavailable("invalid_request");

    if (input.request.kind === "raw-annotations") {
      return this.#rawAnnotations(record, input.request, maxBytes);
    }

    let source: PdfEvidenceSource | undefined;
    const sourceCacheKey = [
      "source",
      record.identity.placekeeperSessionId,
      record.identity.documentGeneration,
      record.identity.source.digest,
    ].join("\0");
    try {
      source = await this.#cached(
        sourceCacheKey,
        () => this.#loadSource(record.identity.placekeeperSessionId, {
          documentGeneration: record.identity.documentGeneration,
          sourceDigest: record.identity.source.digest,
        }),
        (value) => value?.bytes.byteLength ?? 0,
      );
    } catch {
      return unavailable("unavailable");
    }
    const currentBinding = this.#bindings.bindingForTask(input.taskSessionId);
    if (
      source === undefined ||
      source.documentGeneration !== record.identity.documentGeneration ||
      currentBinding?.reviewSessionId !== record.identity.placekeeperSessionId ||
      currentBinding.documentGeneration !== record.identity.documentGeneration ||
      currentBinding.lastVerified?.stateDigest !== record.identity.stateDigest
    ) return unavailable("stale_generation");

    if (input.request.kind === "document") {
      if (source.bytes.byteLength > maxBytes) return unavailable("too_large");
      return {
        status: "ok",
        kind: "document",
        mediaType: "application/pdf",
        bytes: Buffer.from(source.bytes),
      };
    }
    const pageRequest = input.request;
    try {
      const evidence = await this.#cached(
        [sourceCacheKey, pageRequest.kind, pageRequest.pageIndex].join("\0"),
        () => this.#inspectPage(source.bytes, pageRequest),
        (value) => value.bytes.byteLength,
      );
      if (evidence.bytes.byteLength > maxBytes) return unavailable("too_large");
      return {
        status: "ok",
        kind: pageRequest.kind,
        mediaType: evidence.mediaType,
        bytes: evidence.bytes,
      };
    } catch (error) {
      return error instanceof RangeError
        ? unavailable("invalid_request")
        : unavailable("unavailable");
    }
  }

  #rawAnnotations(
    record: EvidenceRecord,
    request: Extract<PdfEvidenceRequest, { kind: "raw-annotations" }>,
    maxBytes: number,
  ): PdfEvidenceRetrievalResult {
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 100;
    if (
      !Number.isSafeInteger(offset) || offset < 0 ||
      !validPositiveInteger(limit) || limit > MAX_ANNOTATION_PAGE_SIZE
    ) return unavailable("invalid_request");
    const annotations = this.#payload(record).existingAnnotations;
    const items = annotations.slice(offset, offset + limit);
    const nextOffset = offset + items.length < annotations.length
      ? offset + items.length
      : undefined;
    const bytes = Buffer.from(JSON.stringify({
      offset,
      limit,
      total: annotations.length,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      items,
    }));
    if (bytes.byteLength > maxBytes) return unavailable("too_large");
    return { status: "ok", kind: "raw-annotations", mediaType: "application/json", bytes };
  }

  #sweep(): void {
    const now = this.#now().getTime();
    for (const [key, record] of this.#records) {
      if (record.expiresAtMs <= now) this.#deleteRecord(key);
    }
  }

  #record(key: string): EvidenceRecord | undefined {
    const record = this.#records.get(key);
    if (record === undefined) return undefined;
    this.#records.delete(key);
    this.#records.set(key, record);
    return record;
  }

  #trimRecords(): void {
    while (
      this.#records.size > MAX_EVIDENCE_RECORDS ||
      this.#retainedPayloadBytes > this.#maxRetainedPayloadBytes
    ) {
      const oldest = this.#records.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#deleteRecord(oldest);
    }
  }

  #payload(record: EvidenceRecord): EvidencePayload {
    const payload = this.#payloads.get(record.payloadKey);
    if (payload === undefined) throw new Error("PDF evidence payload is unavailable");
    return payload;
  }

  #deleteRecord(key: string): void {
    const record = this.#records.get(key);
    if (record === undefined) return;
    this.#records.delete(key);
    const payload = this.#payloads.get(record.payloadKey);
    if (payload === undefined) return;
    payload.references -= 1;
    if (payload.references === 0) {
      this.#payloads.delete(record.payloadKey);
      this.#retainedPayloadBytes -= payload.byteLength;
    }
  }

  #pruneTaskIdentity(taskSessionId: string, identity: LiveObservationIdentity): void {
    for (const [key, record] of this.#records) {
      if (
        record.taskSessionId === taskSessionId &&
        (
          record.identity.placekeeperSessionId !== identity.placekeeperSessionId ||
          record.identity.documentGeneration !== identity.documentGeneration ||
          record.identity.source.digest !== identity.source.digest ||
          record.identity.reviewRevision !== identity.reviewRevision ||
          record.identity.stateDigest !== identity.stateDigest
        )
      ) this.#deleteRecord(key);
    }
  }

  #cached<T>(
    key: string,
    load: () => Promise<T>,
    byteLength: (value: T) => number,
  ): Promise<T> {
    const existing = this.#inspectionCache.get(key);
    if (existing !== undefined) {
      this.#inspectionCache.delete(key);
      this.#inspectionCache.set(key, existing);
      return existing.promise as Promise<T>;
    }
    const entry: EvidenceCacheEntry = { promise: Promise.resolve(undefined), byteLength: 0 };
    entry.promise = load().then((value) => {
      if (this.#inspectionCache.get(key) === entry) {
        entry.byteLength = byteLength(value);
        this.#inspectionCacheBytes += entry.byteLength;
        this.#trimInspectionCache();
      }
      return value;
    }, (error: unknown) => {
      if (this.#inspectionCache.get(key) === entry) this.#inspectionCache.delete(key);
      throw error;
    });
    this.#inspectionCache.set(key, entry);
    return entry.promise as Promise<T>;
  }

  #trimInspectionCache(): void {
    while (this.#inspectionCacheBytes > this.#maxInspectionCacheBytes) {
      const oldestKey = this.#inspectionCache.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      const oldest = this.#inspectionCache.get(oldestKey);
      this.#inspectionCache.delete(oldestKey);
      this.#inspectionCacheBytes -= oldest?.byteLength ?? 0;
    }
  }
}
