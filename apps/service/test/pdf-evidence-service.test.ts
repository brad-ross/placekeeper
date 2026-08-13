import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { ExistingPdfAnnotation, LiveObservationIdentity } from "../../../packages/core/src/live-context.js";
import { PdfEvidenceService } from "../src/context/pdf-evidence-service.js";
import { inspectPdfPageEvidence } from "../src/pdf/inspect-pdf.js";
import { TaskBindingRegistry } from "../src/context/task-binding-registry.js";

const existing = (suffix: number): ExistingPdfAnnotation => ({
  id: `existing-${suffix}`,
  origin: "source-pdf",
  readOnly: true,
  pageIndex: 0,
  subtype: "highlight",
  contents: `note ${suffix}`,
});

function fixture(options: {
  readonly maxRetainedPayloadBytes?: number;
  readonly maxInspectionCacheBytes?: number;
} = {}) {
  let now = 1_000;
  let generation = 1;
  let sourceLoads = 0;
  let pageInspections = 0;
  let handleSequence = 0;
  const bytes = Buffer.from("%PDF-1.7\nprivate evidence\n%%EOF");
  const bindings = new TaskBindingRegistry({
    now: () => new Date(now),
    activeLeaseTtlMs: 10_000,
    pendingTtlMs: 1_000,
  });
  const capability = "browser-capability-evidence-aaaaaaaaaaaaaaaa";
  const proof = bindings.issueBindProof({
    reviewSessionId: "review-a",
    documentGeneration: 1,
    browserCapability: capability,
  });
  bindings.claim({ bindProof: proof, taskSessionId: "task-a", reviewSessionId: "review-a", documentGeneration: 1 });
  bindings.activateBrowser({ reviewSessionId: "review-a", documentGeneration: 1, browserCapability: capability });
  const identity: LiveObservationIdentity = {
    placekeeperSessionId: "review-a",
    documentGeneration: 1,
    source: { fileId: "opaque-file-id", digest: "a".repeat(64), byteLength: bytes.byteLength },
    reviewRevision: 2,
    stateDigest: "b".repeat(64),
  };
  bindings.markVerified("task-a", identity);
  const service = new PdfEvidenceService({
    bindings,
    now: () => new Date(now),
    handleTtlMs: 500,
    maxResponseBytes: 2_048,
    ...options,
    randomHandle: () => `evidence_handle_${String(++handleSequence).padStart(10, "0")}`,
    loadSource: async () => {
      sourceLoads += 1;
      return { documentGeneration: generation, bytes };
    },
    inspectPage: async (_bytes, request) => {
      pageInspections += 1;
      return {
        mediaType: request.kind === "page-text" ? "text/plain" : "application/json",
        bytes: Buffer.from(JSON.stringify(request)),
      };
    },
  });
  return {
    service,
    bindings,
    identity,
    bytes,
    advance(milliseconds: number) { now += milliseconds; },
    setGeneration(value: number) { generation = value; },
    sourceLoads() { return sourceLoads; },
    pageInspections() { return pageInspections; },
  };
}

describe("task-scoped PDF evidence service", () => {
  it("retrieves the immutable document and bounded page evidence without source paths", async () => {
    const { service, identity, bytes, sourceLoads, pageInspections } = fixture();
    const catalog = service.mint({
      reviewItems: [],
      taskSessionId: "task-a",
      identity,
      pageCount: 2,
      sourceByteLength: bytes.byteLength,
      existingAnnotations: [existing(1), existing(2)],
    });
    expect(catalog.descriptors.map(({ kind }) => kind)).toEqual([
      "document", "page-text", "page-layout", "page-render", "raw-annotations",
    ]);
    expect(JSON.stringify(catalog)).not.toContain("/tmp/");

    const document = await service.retrieve({
      taskSessionId: "task-a",
      handle: catalog.handle.value,
      request: { kind: "document" },
    });
    expect(document).toMatchObject({ status: "ok", mediaType: "application/pdf" });
    if (document.status !== "ok") throw new Error("Expected document evidence");
    expect(document.bytes).toEqual(bytes);

    const text = await service.retrieve({
      taskSessionId: "task-a",
      handle: catalog.handle.value,
      request: { kind: "page-text", pageIndex: 1 },
    });
    expect(text).toMatchObject({ status: "ok", mediaType: "text/plain" });
    if (text.status !== "ok") throw new Error("Expected text evidence");
    expect(text.bytes.toString()).toContain('"pageIndex":1');
    const repeated = await Promise.all([
      service.retrieve({
        taskSessionId: "task-a",
        handle: catalog.handle.value,
        request: { kind: "page-text", pageIndex: 1 },
      }),
      service.retrieve({
        taskSessionId: "task-a",
        handle: catalog.handle.value,
        request: { kind: "page-text", pageIndex: 1 },
      }),
    ]);
    expect(repeated.every(({ status }) => status === "ok")).toBe(true);
    expect(sourceLoads()).toBe(1);
    expect(pageInspections()).toBe(1);
  });

  it("prunes stale payload handles as soon as a task mints a new observation identity", async () => {
    const { service, bindings, identity, bytes } = fixture();
    const stale = service.mint({
      reviewItems: [], taskSessionId: "task-a", identity, pageCount: 1,
      sourceByteLength: bytes.byteLength, existingAnnotations: [existing(1)],
    });
    const nextIdentity = { ...identity, reviewRevision: 3, stateDigest: "c".repeat(64) };
    bindings.markVerified("task-a", nextIdentity);
    const current = service.mint({
      reviewItems: [], taskSessionId: "task-a", identity: nextIdentity, pageCount: 1,
      sourceByteLength: bytes.byteLength, existingAnnotations: [existing(2)],
    });

    expect(service.authorizeHandle(stale.handle.value)).toEqual({
      status: "unavailable", reason: "unauthorized",
    });
    expect(service.authorizeHandle(current.handle.value)).toMatchObject({ status: "ok" });
  });

  it("deduplicates concurrent cold source loads and page inspections", async () => {
    const { service, identity, bytes, sourceLoads, pageInspections } = fixture();
    const catalog = service.mint({
      reviewItems: [], taskSessionId: "task-a", identity, pageCount: 1,
      sourceByteLength: bytes.byteLength, existingAnnotations: [],
    });
    const request = () => service.retrieve({
      taskSessionId: "task-a",
      handle: catalog.handle.value,
      request: { kind: "page-layout" as const, pageIndex: 0 },
    });

    const results = await Promise.all([request(), request(), request()]);
    expect(results.every(({ status }) => status === "ok")).toBe(true);
    expect(sourceLoads()).toBe(1);
    expect(pageInspections()).toBe(1);
  });

  it("evicts completed PDF inspection data that exceeds the cache byte budget", async () => {
    const { service, identity, bytes, sourceLoads } = fixture({ maxInspectionCacheBytes: 1 });
    const catalog = service.mint({
      reviewItems: [], taskSessionId: "task-a", identity, pageCount: 1,
      sourceByteLength: bytes.byteLength, existingAnnotations: [],
    });
    const request = () => service.retrieve({
      taskSessionId: "task-a",
      handle: catalog.handle.value,
      request: { kind: "document" as const },
    });

    expect((await request()).status).toBe("ok");
    expect((await request()).status).toBe("ok");
    expect(sourceLoads()).toBe(2);
  });

  it("rejects a single retained annotation payload that exceeds its byte budget", () => {
    const { service, identity, bytes } = fixture({ maxRetainedPayloadBytes: 64 });
    expect(() => service.mint({
      reviewItems: [], taskSessionId: "task-a", identity, pageCount: 1,
      sourceByteLength: bytes.byteLength,
      existingAnnotations: [{ ...existing(1), contents: "x".repeat(256) }],
    })).toThrow(/retained evidence byte limit/i);
  });

  it("paginates raw annotations and enforces item, page, and byte bounds", async () => {
    const { service, identity, bytes, sourceLoads } = fixture();
    const catalog = service.mint({
      reviewItems: [],
      taskSessionId: "task-a",
      identity,
      pageCount: 1,
      sourceByteLength: bytes.byteLength,
      existingAnnotations: Array.from({ length: 5 }, (_, index) => existing(index)),
    });
    const page = await service.retrieve({
      taskSessionId: "task-a",
      handle: catalog.handle.value,
      request: { kind: "raw-annotations", offset: 2, limit: 2 },
    });
    expect(page).toMatchObject({ status: "ok", mediaType: "application/json" });
    if (page.status !== "ok") throw new Error("Expected annotation evidence");
    expect(JSON.parse(page.bytes.toString())).toEqual({
      offset: 2,
      limit: 2,
      total: 5,
      nextOffset: 4,
      items: [existing(2), existing(3)],
    });
    expect(sourceLoads()).toBe(0);

    expect(await service.retrieve({
      taskSessionId: "task-a",
      handle: catalog.handle.value,
      request: { kind: "page-text", pageIndex: 1 },
    })).toMatchObject({ status: "unavailable", reason: "invalid_request" });
    expect(await service.retrieve({
      taskSessionId: "task-a",
      handle: catalog.handle.value,
      request: { kind: "raw-annotations", offset: 0, limit: 10_001 },
    })).toMatchObject({ status: "unavailable", reason: "invalid_request" });
    expect(await service.retrieve({
      taskSessionId: "task-a",
      handle: catalog.handle.value,
      request: { kind: "document", maxBytes: 8 },
    })).toMatchObject({ status: "unavailable", reason: "too_large" });
  });

  it("paginates complete canonical Review Items through the current opaque handle", async () => {
    const { service, identity, bytes } = fixture();
    const reviewItems = [0, 1, 2].map((pageIndex) => ({
      id: `item-${pageIndex}`,
      intent: "pageNote" as const,
      pageIndex,
      coordinates: { rect: { x: 1, y: 2, width: 3, height: 4 } },
      anchor: { kind: "page" as const, nearbyText: `page ${pageIndex}` },
      payload: { comment: `comment ${pageIndex}` },
    }));
    const catalog = service.mint({
      reviewItems,
      taskSessionId: "task-a",
      identity,
      pageCount: 3,
      sourceByteLength: bytes.byteLength,
      existingAnnotations: [],
    });
    const result = service.retrieveReviewItemsWithHandle({
      handle: catalog.handle.value,
      pageIndex: 1,
      offset: 0,
      limit: 1,
    });
    expect(result).toMatchObject({
      status: "ok",
      kind: "review-items",
      mediaType: "application/json",
    });
    if (result.status !== "ok") throw new Error("Expected Review Item evidence");
    expect(JSON.parse(result.bytes.toString())).toEqual({
      offset: 0,
      limit: 1,
      total: 1,
      pageIndex: 1,
      items: [reviewItems[1]],
    });
  });

  it("rejects wrong-task, expired, revoked, and stale-generation handles", async () => {
    const { service, bindings, identity, bytes, setGeneration } = fixture();
    const catalog = service.mint({
      reviewItems: [],
      taskSessionId: "task-a",
      identity,
      pageCount: 1,
      sourceByteLength: bytes.byteLength,
      existingAnnotations: [],
    });
    expect(await service.retrieve({
      taskSessionId: "task-other",
      handle: catalog.handle.value,
      request: { kind: "document" },
    })).toMatchObject({ status: "unavailable", reason: "unauthorized" });

    setGeneration(2);
    expect(await service.retrieve({
      taskSessionId: "task-a",
      handle: catalog.handle.value,
      request: { kind: "document" },
    })).toMatchObject({ status: "unavailable", reason: "stale_generation" });
    setGeneration(1);

    bindings.markVerified("task-a", { ...identity, stateDigest: "c".repeat(64), reviewRevision: 3 });
    expect(await service.retrieve({
      taskSessionId: "task-a",
      handle: catalog.handle.value,
      request: { kind: "raw-annotations" },
    })).toMatchObject({ status: "unavailable", reason: "unauthorized" });
    bindings.markVerified("task-a", identity);

    bindings.revokeTask("task-a");
    expect(await service.retrieve({
      taskSessionId: "task-a",
      handle: catalog.handle.value,
      request: { kind: "document" },
    })).toMatchObject({ status: "unavailable", reason: "unauthorized" });

    const fresh = fixture();
    const expiring = fresh.service.mint({
      reviewItems: [],
      taskSessionId: "task-a",
      identity: fresh.identity,
      pageCount: 1,
      sourceByteLength: fresh.bytes.byteLength,
      existingAnnotations: [],
    });
    fresh.advance(501);
    expect(await fresh.service.retrieve({
      taskSessionId: "task-a",
      handle: expiring.handle.value,
      request: { kind: "document" },
    })).toMatchObject({ status: "unavailable", reason: "expired" });
  });

  it("extracts truthful text, layout, and visual page evidence from a real PDF", async () => {
    const pdf = new Uint8Array(await readFile(resolve("test/fixtures/pdfs/text-native.pdf")));
    const text = await inspectPdfPageEvidence(pdf, { kind: "page-text", pageIndex: 0 });
    expect(text.mediaType).toBe("text/plain; charset=utf-8");
    expect(text.bytes.toString()).toContain("Selectable placekeeper text");

    const layout = await inspectPdfPageEvidence(pdf, { kind: "page-layout", pageIndex: 0 });
    expect(layout.mediaType).toBe("application/json");
    expect(JSON.parse(layout.bytes.toString())).toMatchObject({ pageIndex: 0 });

    const render = await inspectPdfPageEvidence(pdf, { kind: "page-render", pageIndex: 0 });
    expect(render.mediaType).toBe("application/vnd.placekeeper.rgba+json");
    expect(JSON.parse(render.bytes.toString())).toMatchObject({ pageIndex: 0, width: 612, height: 792 });
  });
});
