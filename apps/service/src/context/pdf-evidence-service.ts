import { createHash, randomBytes } from "node:crypto";

import {
  createPdfEvidenceCatalog,
  type ExistingPdfAnnotation,
  type LiveObservationIdentity,
  type PdfEvidenceCatalog,
} from "../../../../packages/core/src/live-context.js";
import type { StructuredReviewItem } from "../../../../packages/core/src/handoff.js";
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

export type PdfEvidenceRetrievalResult =
  | {
      readonly status: "ok";
      readonly kind: PdfEvidenceRequest["kind"];
      readonly mediaType: string;
      readonly bytes: Buffer;
    }
  | {
      readonly status: "unavailable";
      readonly reason: PdfEvidenceUnavailableReason;
    };

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
  readonly existingAnnotations: readonly ExistingPdfAnnotation[];
  readonly reviewItems: readonly StructuredReviewItem[];
}

export interface PdfEvidenceServiceOptions {
  readonly bindings: TaskBindingRegistry;
  readonly loadSource: (reviewSessionId: string) => Promise<PdfEvidenceSource | undefined>;
  readonly inspectPage?: (
    bytes: Uint8Array,
    request: PdfPageEvidenceRequest,
  ) => Promise<InspectedPdfPageEvidence>;
  readonly now?: () => Date;
  readonly handleTtlMs?: number;
  readonly maxResponseBytes?: number;
  readonly randomHandle?: () => string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function unavailable(reason: PdfEvidenceUnavailableReason): PdfEvidenceRetrievalResult {
  return { status: "unavailable", reason };
}

export class PdfEvidenceService {
  readonly #bindings: TaskBindingRegistry;
  readonly #loadSource: PdfEvidenceServiceOptions["loadSource"];
  readonly #inspectPage: NonNullable<PdfEvidenceServiceOptions["inspectPage"]>;
  readonly #now: () => Date;
  readonly #handleTtlMs: number;
  readonly #maxResponseBytes: number;
  readonly #randomHandle: () => string;
  readonly #records = new Map<string, EvidenceRecord>();

  constructor(options: PdfEvidenceServiceOptions) {
    this.#bindings = options.bindings;
    this.#loadSource = options.loadSource;
    this.#inspectPage = options.inspectPage ?? inspectPdfPageEvidence;
    this.#now = options.now ?? (() => new Date());
    this.#handleTtlMs = options.handleTtlMs ?? DEFAULT_HANDLE_TTL_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#randomHandle = options.randomHandle ??
      (() => `evidence_${randomBytes(32).toString("base64url")}`);
    if (!validPositiveInteger(this.#handleTtlMs)) {
      throw new RangeError("handleTtlMs must be a positive safe integer");
    }
    if (!validPositiveInteger(this.#maxResponseBytes)) {
      throw new RangeError("maxResponseBytes must be a positive safe integer");
    }
  }

  mint(input: {
    readonly taskSessionId: string;
    readonly identity: LiveObservationIdentity;
    readonly pageCount: number;
    readonly sourceByteLength: number;
    readonly existingAnnotations: readonly ExistingPdfAnnotation[];
    readonly reviewItems: readonly StructuredReviewItem[];
  }): PdfEvidenceCatalog {
    this.#sweep();
    const binding = this.#bindings.bindingForTask(input.taskSessionId);
    if (
      binding === undefined ||
      binding.reviewSessionId !== input.identity.proofreaderSessionId ||
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
    const value = this.#randomHandle();
    const expiresAtMs = this.#now().getTime() + this.#handleTtlMs;
    const record: EvidenceRecord = {
      taskSessionId: input.taskSessionId,
      identity: structuredClone(input.identity),
      pageCount: input.pageCount,
      expiresAtMs,
      maxBytes: this.#maxResponseBytes,
      existingAnnotations: structuredClone(input.existingAnnotations),
      reviewItems: structuredClone(input.reviewItems),
    };
    this.#records.set(digest(value), record);
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
            mediaType: "application/vnd.pdf-proofreader.rgba+json",
            pages,
          },
        ]),
        { id: "raw-annotations", kind: "raw-annotations", mediaType: "application/json" },
      ],
    });
  }

  revoke(handle: string): void {
    this.#records.delete(digest(handle));
  }

  /** The opaque handle is delivered only inside the bound task's trusted
   * prompt context. This installed-CLI entry point resolves its task scope
   * without exposing the Codex task id to the model. All normal lease,
   * generation, digest, expiry, and byte checks still run in retrieve(). */
  retrieveWithHandle(input: {
    readonly handle: string;
    readonly request: PdfEvidenceRequest;
  }): Promise<PdfEvidenceRetrievalResult> {
    const record = this.#records.get(digest(input.handle));
    if (record === undefined) return Promise.resolve(unavailable("unauthorized"));
    return this.retrieve({
      taskSessionId: record.taskSessionId,
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
  }): PdfEvidenceRetrievalResult {
    const record = this.#records.get(digest(input.handle));
    if (record === undefined) return unavailable("unauthorized");
    if (record.expiresAtMs <= this.#now().getTime()) {
      this.#records.delete(digest(input.handle));
      return unavailable("expired");
    }
    const binding = this.#bindings.bindingForTask(record.taskSessionId);
    if (
      binding === undefined ||
      binding.reviewSessionId !== record.identity.proofreaderSessionId ||
      binding.documentGeneration !== record.identity.documentGeneration ||
      binding.lastVerified?.stateDigest !== record.identity.stateDigest
    ) return unavailable("unauthorized");
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    const maxBytes = input.maxBytes ?? Math.min(record.maxBytes, 1024 * 1024);
    if (
      !Number.isSafeInteger(offset) || offset < 0 ||
      !validPositiveInteger(limit) || limit > MAX_REVIEW_ITEM_PAGE_SIZE ||
      !validPositiveInteger(maxBytes) || maxBytes > record.maxBytes ||
      (input.pageIndex !== undefined && (!Number.isSafeInteger(input.pageIndex) || input.pageIndex < 0))
    ) return unavailable("invalid_request");
    const filtered = input.pageIndex === undefined
      ? record.reviewItems
      : record.reviewItems.filter(({ pageIndex }) => pageIndex === input.pageIndex);
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
    return { status: "ok", kind: "raw-annotations", mediaType: "application/json", bytes };
  }

  async retrieve(input: {
    readonly taskSessionId: string;
    readonly handle: string;
    readonly request: PdfEvidenceRequest;
  }): Promise<PdfEvidenceRetrievalResult> {
    const record = this.#records.get(digest(input.handle));
    if (record === undefined || record.taskSessionId !== input.taskSessionId) {
      return unavailable("unauthorized");
    }
    if (record.expiresAtMs <= this.#now().getTime()) {
      this.#records.delete(digest(input.handle));
      return unavailable("expired");
    }
    const binding = this.#bindings.bindingForTask(input.taskSessionId);
    if (
      binding === undefined ||
      binding.reviewSessionId !== record.identity.proofreaderSessionId ||
      binding.documentGeneration !== record.identity.documentGeneration ||
      binding.lastVerified?.stateDigest !== record.identity.stateDigest
    ) return unavailable("unauthorized");

    const maxBytes = input.request.maxBytes ?? record.maxBytes;
    if (!validPositiveInteger(maxBytes) || maxBytes > record.maxBytes) {
      return unavailable("invalid_request");
    }
    if (input.request.kind !== "document" && input.request.kind !== "raw-annotations" && (
      !Number.isSafeInteger(input.request.pageIndex) ||
      input.request.pageIndex < 0 ||
      input.request.pageIndex >= record.pageCount
    )) return unavailable("invalid_request");

    let source: PdfEvidenceSource | undefined;
    try {
      source = await this.#loadSource(record.identity.proofreaderSessionId);
    } catch {
      return unavailable("unavailable");
    }
    const currentBinding = this.#bindings.bindingForTask(input.taskSessionId);
    if (
      source === undefined ||
      source.documentGeneration !== record.identity.documentGeneration ||
      currentBinding?.reviewSessionId !== record.identity.proofreaderSessionId ||
      currentBinding.documentGeneration !== record.identity.documentGeneration ||
      currentBinding.lastVerified?.stateDigest !== record.identity.stateDigest
    ) return unavailable("stale_generation");

    if (input.request.kind === "raw-annotations") {
      return this.#rawAnnotations(record, input.request, maxBytes);
    }

    if (input.request.kind === "document") {
      if (source.bytes.byteLength > maxBytes) return unavailable("too_large");
      return {
        status: "ok",
        kind: "document",
        mediaType: "application/pdf",
        bytes: Buffer.from(source.bytes),
      };
    }
    try {
      const evidence = await this.#inspectPage(source.bytes, input.request);
      if (evidence.bytes.byteLength > maxBytes) return unavailable("too_large");
      return {
        status: "ok",
        kind: input.request.kind,
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
    const items = record.existingAnnotations.slice(offset, offset + limit);
    const nextOffset = offset + items.length < record.existingAnnotations.length
      ? offset + items.length
      : undefined;
    const bytes = Buffer.from(JSON.stringify({
      offset,
      limit,
      total: record.existingAnnotations.length,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      items,
    }));
    if (bytes.byteLength > maxBytes) return unavailable("too_large");
    return { status: "ok", kind: "raw-annotations", mediaType: "application/json", bytes };
  }

  #sweep(): void {
    const now = this.#now().getTime();
    for (const [key, record] of this.#records) {
      if (record.expiresAtMs <= now) this.#records.delete(key);
    }
  }
}
