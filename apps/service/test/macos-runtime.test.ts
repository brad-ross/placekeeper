import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  MacosRuntimeManager,
  type MacosRuntimeBackend,
  type MacosRuntimeTrustedProjection,
} from "../src/macos/macos-runtime.js";

const sourceBytes = Buffer.from("%PDF-1.7\nmacos-runtime\n%%EOF");
const digest = createHash("sha256").update(sourceBytes).digest("hex");
const envelope = {
  protocolVersion: 1,
  windowId: "window_12345678",
  attemptId: "attempt_12345678",
} as const;

function projection(revision = 0): MacosRuntimeTrustedProjection {
  const sessionId = "779e1d9d-58c1-4b12-8dc2-3449dad132c1";
  return {
    sessionId,
    generation: 1,
    revision,
    state: {
      schemaVersion: 2,
      sessionId,
      source: {
        fileId: "c0e41526-1320-4dec-b802-3c17617c0320",
        digest,
        byteLength: sourceBytes.byteLength,
      },
      revision,
      lifecycle: "active",
      items: [],
      workflow: {
        schemaVersion: 1,
        mode: "standard",
        documentRole: "source-pdf",
        documentGeneration: 1,
        freshness: "current",
        historyBoundary: 0,
      },
      pendingDrafts: [],
      discardAudit: [],
      history: [],
      historyCursor: 0,
    },
    scope: {
      documentTitle: "Paper.pdf",
      sourceDisposition: "local",
      sourceDisplayName: "Paper.pdf",
      launchSurface: "macos",
      sourceRootPath: "/must/not/cross",
    },
    saveStatus: {
      destination: { phase: "none", generation: 0 },
      sync: { phase: "clean", desiredRevision: revision, savedRevision: revision },
    },
    canonicalLinkBase: "placekeeper:///Papers/Paper.pdf",
    protected: false,
    location: { kind: "page", page: 1 },
    document: { sha256: digest, byteLength: sourceBytes.byteLength, generation: 1 },
  };
}

function generationProjection(generation: number, bytes: Buffer): MacosRuntimeTrustedProjection {
  const nextDigest = createHash("sha256").update(bytes).digest("hex");
  const current = projection(generation);
  return {
    ...current,
    generation,
    revision: generation,
    state: {
      ...(current.state as Record<string, unknown>),
      revision: generation,
      source: {
        ...(current.state as { source: Record<string, unknown> }).source,
        fileId: `c0e41526-1320-4dec-b802-3c17617c032${generation}`,
        digest: nextDigest,
        byteLength: bytes.byteLength,
      },
      workflow: {
        ...(current.state as { workflow: Record<string, unknown> }).workflow,
        documentGeneration: generation,
      },
    },
    document: { sha256: nextDigest, byteLength: bytes.byteLength, generation },
  };
}

function backend(): MacosRuntimeBackend {
  const attachment = {
    sessionId: "session_review_1234", attachmentId: "attachment_native_1234",
    incarnationId: "incarnation_native_1234", capability: "c".repeat(43),
    protocolVersion: 1 as const,
    capabilities: ["session-wide-holds", "durable-finalize-receipts", "connection-incarnations"] as const,
  };
  return {
    begin: vi.fn(async () => ({
      append: vi.fn(async () => { throw new Error("local source rejects chunks"); }),
      finish: vi.fn(async () => ({ canonicalKey: "canonical_review_1234", projection: projection() })),
      cancel: vi.fn(async () => undefined),
    })),
    activate: vi.fn(async () => projection()),
    current: vi.fn(async () => projection()),
    invoke: vi.fn(async (_key, method) => method === "command" ? projection(1).state : {}),
    readDocument: vi.fn(async (_key, _generation, offset, length) => sourceBytes.subarray(offset, offset + length)),
    detach: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    interaction: vi.fn(async (_key, _attachment, action) => ({ status: action === "begin" ? "accepted" : "released" })),
    registerInteraction: vi.fn(() => attachment),
    disconnectInteraction: vi.fn(),
  };
}

async function admit(manager: MacosRuntimeManager): Promise<void> {
  await expect(manager.handle("helper_12345678", {
    ...envelope,
    requestId: "request_admit_1",
    type: "admit",
    sourcePath: "/private/tmp/Paper.pdf",
  })).resolves.toMatchObject({
    type: "admitted",
    displayName: "Paper.pdf",
    resourceId: expect.stringMatching(/^resource_/u),
    projection: { scope: { launchSurface: "macos" } },
  });
}

describe("macOS canonical review runtime", () => {
  it("validates a confirmed Placekeeper link and projects only its safe location", async () => {
    const service = backend();
    const manager = new MacosRuntimeManager(service);
    await expect(manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_link_admit_1",
      type: "admit-link",
      link: "placekeeper:///private/tmp/Paper.pdf#v=1&page=8",
      confirmed: true,
    })).resolves.toMatchObject({
      type: "admitted",
      displayName: "Paper.pdf",
      projection: { location: { kind: "page", page: 8 } },
    });
    expect(service.begin).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "local",
      fileUrl: "file:///private/tmp/Paper.pdf",
    }), expect.any(AbortSignal));
  });

  it("admits, activates, mutates, reads, builds a link, and detaches one window", async () => {
    const service = backend();
    const manager = new MacosRuntimeManager(service);
    await admit(manager);
    await expect(manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_activate_1",
      type: "activate",
      documentValidated: true,
    })).resolves.toMatchObject({ type: "active", projection: { sessionId: projection().sessionId } });
    await expect(manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_invoke_1",
      type: "invoke",
      generation: 1,
      revision: 0,
      method: "command",
      payload: { type: "undo", expectedRevision: 0 },
      idempotencyKey: "operation_command_1",
    })).resolves.toMatchObject({ type: "result", method: "command" });
    const resourceId = manager.resourceId("helper_12345678");
    if (resourceId === undefined) throw new Error("Expected a document resource");
    const resource = await manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_resource_1",
      type: "read-resource",
      resourceId,
      generation: 1,
      role: "document",
      offset: 0,
      length: sourceBytes.byteLength,
    });
    expect(resource).toMatchObject({ type: "resource-bytes", data: sourceBytes.toString("base64") });
    await expect(manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_link_1",
      type: "copy-link",
      location: { kind: "page", page: 3 },
    })).resolves.toEqual(expect.objectContaining({
      type: "placekeeper-link",
      link: "placekeeper:///Papers/Paper.pdf#v=1&page=3",
    }));
    await manager.detach("helper_12345678");
    expect(service.detach).toHaveBeenCalledOnce();
    expect(manager.activity()).toEqual({ helpers: 0, activeHelpers: 0, resources: 0 });
  });

  it("binds interaction operations to the native helper incarnation and revokes it on detach", async () => {
    const service = backend();
    const manager = new MacosRuntimeManager(service);
    await admit(manager);
    await manager.handle("helper_12345678", {
      ...envelope, requestId: "request_activate_interaction", type: "activate", documentValidated: true,
    });
    await expect(manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_begin_interaction",
      type: "invoke",
      generation: 1,
      revision: 0,
      method: "beginInteraction",
      payload: { interactionToken: "interaction_native_1234", order: 1, generation: 1 },
      idempotencyKey: "operation_interaction_1234",
    })).resolves.toMatchObject({ type: "result", payload: { status: "accepted" } });
    expect(service.interaction).toHaveBeenCalledWith(
      "canonical_review_1234",
      expect.objectContaining({ attachmentId: "attachment_native_1234" }),
      "begin",
      expect.any(Object),
    );
    await manager.detach("helper_12345678");
    expect(service.disconnectInteraction).toHaveBeenCalledWith(
      "canonical_review_1234",
      expect.objectContaining({ attachmentId: "attachment_native_1234" }),
    );
  });

  it("rejects stale, cross-window, path-bearing, and non-idempotent replay shapes", async () => {
    const manager = new MacosRuntimeManager(backend());
    await admit(manager);
    await expect(manager.handle("helper_12345678", {
      ...envelope,
      windowId: "window_abcdefgh",
      requestId: "request_cross_1",
      type: "activate",
      documentValidated: true,
    })).resolves.toMatchObject({ type: "failure", code: "invalid" });
    await manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_activate_2",
      type: "activate",
      documentValidated: true,
    });
    await expect(manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_invoke_2",
      type: "invoke",
      generation: 2,
      revision: 0,
      method: "command",
      payload: { type: "undo", expectedRevision: 0 },
    })).resolves.toMatchObject({ type: "failure", code: "stale" });
    expect(JSON.stringify(await manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_refresh_1",
      type: "refresh",
    }))).not.toContain("/must/not/cross");
  });

  it("isolates helper death and enforces aggregate helper limits", async () => {
    const service = backend();
    const manager = new MacosRuntimeManager(service, { maxHelpers: 1 });
    await admit(manager);
    await expect(manager.handle("helper_abcdefgh", {
      ...envelope,
      windowId: "window_abcdefgh",
      attemptId: "attempt_abcdefgh",
      requestId: "request_admit_2",
      type: "admit",
      sourcePath: "/private/tmp/Other.pdf",
    })).resolves.toMatchObject({ type: "failure", code: "budget" });
    await manager.helperDied("helper_12345678");
    expect(manager.activity()).toEqual({ helpers: 0, activeHelpers: 0, resources: 0 });
  });

  it("keeps protected recovery service-owned until an exact idempotent choice", async () => {
    const service = backend();
    const offer = { id: "recovery_offer_1234", expiresAt: "2026-09-05T00:00:00.000Z" };
    const choose = vi.fn(async () => ({ canonicalKey: "canonical_recovered_1", projection: projection(4) }));
    vi.mocked(service.begin).mockResolvedValue({
      append: vi.fn(async () => { throw new Error("local source rejects chunks"); }),
      finish: vi.fn(async () => ({ choices: ["resume", "discard", "fork"] as const, offer, choose })),
      cancel: vi.fn(async () => undefined),
    });
    const manager = new MacosRuntimeManager(service);
    await expect(manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_admit_3",
      type: "admit",
      sourcePath: "/private/tmp/Paper.pdf",
    })).resolves.toMatchObject({ type: "recovery-offered", offer });
    expect(manager.resourceId("helper_12345678")).toBeUndefined();
    await expect(manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_recover_1",
      type: "recover",
      decision: "resume",
      offer: { ...offer, id: "recovery_wrong_1234" },
      idempotencyKey: "operation_recover_1234",
    })).resolves.toMatchObject({ type: "failure", code: "invalid" });
    await expect(manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_recover_2",
      type: "recover",
      decision: "resume",
      offer,
      idempotencyKey: "operation_recover_1234",
    })).resolves.toMatchObject({ type: "admitted", projection: { revision: 4 } });
    expect(choose).toHaveBeenCalledWith("resume", "operation_recover_1234");
  });

  it("returns ordered generation and revision invalidations without exposing authority", async () => {
    const service = backend();
    vi.mocked(service.current).mockResolvedValue(projection(2));
    const manager = new MacosRuntimeManager(service);
    await admit(manager);
    await manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_activate_3",
      type: "activate",
      documentValidated: true,
    });
    const invalidation = await manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_keepalive_1",
      type: "keepalive",
    });
    expect(invalidation).toMatchObject({ type: "invalidation", generation: 1, revision: 2, reason: "revision" });
    expect(JSON.stringify(invalidation)).not.toMatch(/sourceRootPath|canonicalLinkBase|credential|capability/u);
    await expect(manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_keepalive_2",
      type: "keepalive",
    })).resolves.toMatchObject({ type: "refreshed", projection: { revision: 2 } });
  });

  it("retains the predecessor native resource through successor adoption and bounds older generations", async () => {
    const service = backend();
    const bytes = new Map([
      [1, sourceBytes],
      [2, Buffer.from("%PDF-1.7\ngeneration two\n%%EOF")],
      [3, Buffer.from("%PDF-1.7\ngeneration three\n%%EOF")],
    ]);
    let current = projection();
    vi.mocked(service.current).mockImplementation(async () => current);
    vi.mocked(service.readDocument).mockImplementation(async (_key, generation, offset, length) =>
      bytes.get(generation)!.subarray(offset, offset + length));
    const manager = new MacosRuntimeManager(service);
    await admit(manager);
    await manager.handle("helper_12345678", {
      ...envelope, requestId: "request_activate_resources", type: "activate", documentValidated: true,
    });
    const resourceId = manager.resourceId("helper_12345678")!;
    current = generationProjection(2, bytes.get(2)!);
    await manager.handle("helper_12345678", {
      ...envelope, requestId: "request_refresh_resources_2", type: "refresh",
    });
    await expect(manager.handle("helper_12345678", {
      ...envelope, requestId: "request_read_predecessor", type: "read-resource", resourceId,
      generation: 1, role: "document", offset: 0, length: sourceBytes.byteLength,
    })).resolves.toMatchObject({ type: "resource-bytes", data: sourceBytes.toString("base64") });
    current = generationProjection(3, bytes.get(3)!);
    await manager.handle("helper_12345678", {
      ...envelope, requestId: "request_refresh_resources_3", type: "refresh",
    });
    await expect(manager.handle("helper_12345678", {
      ...envelope, requestId: "request_read_adopted_3", type: "read-resource", resourceId,
      generation: 3, role: "document", offset: 0, length: bytes.get(3)!.byteLength,
    })).resolves.toMatchObject({ type: "resource-bytes", data: bytes.get(3)!.toString("base64") });
    await expect(manager.handle("helper_12345678", {
      ...envelope, requestId: "request_read_predecessor_after_bytes", type: "read-resource", resourceId,
      generation: 1, role: "document", offset: 0, length: sourceBytes.byteLength,
    })).resolves.toMatchObject({ type: "resource-bytes" });
    await expect(manager.handle("helper_12345678", {
      ...envelope, requestId: "request_reject_bad_adoption", type: "adopt-resource", resourceId,
      generation: 3, byteLength: bytes.get(3)!.byteLength, digest: "f".repeat(64),
    })).resolves.toMatchObject({ type: "failure", code: "stale" });
    await expect(manager.handle("helper_12345678", {
      ...envelope, requestId: "request_adopt_resource_3", type: "adopt-resource", resourceId,
      generation: 3, byteLength: bytes.get(3)!.byteLength,
      digest: createHash("sha256").update(bytes.get(3)!).digest("hex"),
    })).resolves.toMatchObject({ type: "resource-adopted", generation: 3 });
    await expect(manager.handle("helper_12345678", {
      ...envelope, requestId: "request_read_retired", type: "read-resource", resourceId,
      generation: 1, role: "document", offset: 0, length: sourceBytes.byteLength,
    })).resolves.toMatchObject({ type: "failure", code: "stale" });
  });

  it("contains a stalled helper without starving another window", async () => {
    const service = backend();
    const blocked = Promise.withResolvers<MacosRuntimeTrustedProjection>();
    let currentCalls = 0;
    vi.mocked(service.current).mockImplementation(async () => {
      currentCalls += 1;
      return currentCalls === 1 ? blocked.promise : projection();
    });
    const manager = new MacosRuntimeManager(service, {
      maxHelpers: 2,
      maxConcurrentRequests: 2,
      maxConcurrentRequestsPerHelper: 1,
    });
    await admit(manager);
    const secondEnvelope = {
      protocolVersion: 1 as const,
      windowId: "window_abcdefgh",
      attemptId: "attempt_abcdefgh",
    };
    await manager.handle("helper_abcdefgh", {
      ...secondEnvelope,
      requestId: "request_admit_4",
      type: "admit",
      sourcePath: "/private/tmp/Other.pdf",
    });

    const stalled = manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_refresh_2",
      type: "refresh",
    });
    await vi.waitFor(() => expect(currentCalls).toBe(1));
    await expect(manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_refresh_3",
      type: "refresh",
    })).resolves.toMatchObject({ type: "failure", code: "budget" });
    await expect(manager.handle("helper_abcdefgh", {
      ...secondEnvelope,
      requestId: "request_refresh_4",
      type: "refresh",
    })).resolves.toMatchObject({ type: "refreshed" });
    blocked.resolve(projection());
    await expect(stalled).resolves.toMatchObject({ type: "refreshed" });
  });

  it("bounds completed replay responses without imposing a helper request lifetime", async () => {
    const service = backend();
    const manager = new MacosRuntimeManager(service, { maxRetainedRequestsPerHelper: 2 });
    await admit(manager);

    for (let index = 0; index < 8; index += 1) {
      await expect(manager.handle("helper_12345678", {
        ...envelope,
        requestId: `request_refresh_lifetime_${index}`,
        type: "refresh",
      })).resolves.toMatchObject({ type: "refreshed" });
    }
    expect(service.current).toHaveBeenCalledTimes(8);

    await manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_refresh_lifetime_7",
      type: "refresh",
    });
    expect(service.current).toHaveBeenCalledTimes(8);

    await manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_refresh_lifetime_0",
      type: "refresh",
    });
    expect(service.current).toHaveBeenCalledTimes(9);
  });

  it("reuses backend idempotency coordinates after a mutation replay is evicted", async () => {
    const service = backend();
    const durable = new Map<string, { readonly digest: string; readonly result: unknown }>();
    let effects = 0;
    vi.mocked(service.invoke).mockImplementation(async (_key, _method, _payload, operation) => {
      const idempotencyKey = operation.idempotencyKey;
      if (idempotencyKey === undefined) throw new Error("missing-idempotency-key");
      const previous = durable.get(idempotencyKey);
      if (previous !== undefined) {
        if (previous.digest !== operation.payloadDigest) throw new Error("idempotency-conflict");
        return previous.result;
      }
      effects += 1;
      const result = projection(1).state;
      durable.set(idempotencyKey, { digest: operation.payloadDigest, result });
      return result;
    });
    const manager = new MacosRuntimeManager(service, { maxRetainedRequestsPerHelper: 1 });
    await admit(manager);
    await manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_activate_replay_1",
      type: "activate",
      documentValidated: true,
    });
    const mutation = {
      ...envelope,
      requestId: "request_mutation_replay_1",
      type: "invoke" as const,
      generation: 1,
      revision: 0,
      method: "command" as const,
      payload: { type: "undo", expectedRevision: 0 },
      idempotencyKey: "operation_mutation_replay_1",
    };

    await expect(manager.handle("helper_12345678", mutation)).resolves.toMatchObject({ type: "result" });
    await manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_refresh_evict_1",
      type: "refresh",
    });
    await expect(manager.handle("helper_12345678", mutation)).resolves.toMatchObject({ type: "result" });

    expect(service.invoke).toHaveBeenCalledTimes(2);
    expect(service.invoke).toHaveBeenNthCalledWith(
      2,
      "canonical_review_1234",
      "command",
      mutation.payload,
      expect.objectContaining({ idempotencyKey: mutation.idempotencyKey }),
      expect.any(AbortSignal),
    );
    expect(effects).toBe(1);
  });

  it("releases stalled request capacity when its helper detaches", async () => {
    const service = backend();
    const blocked = Promise.withResolvers<MacosRuntimeTrustedProjection>();
    const signals: AbortSignal[] = [];
    let currentCalls = 0;
    vi.mocked(service.current).mockImplementation(async (_key, signal) => {
      if (signal !== undefined) signals.push(signal);
      currentCalls += 1;
      return currentCalls === 1 ? blocked.promise : projection();
    });
    const manager = new MacosRuntimeManager(service, {
      maxHelpers: 2,
      maxConcurrentRequests: 1,
      maxConcurrentRequestsPerHelper: 1,
    });
    await admit(manager);
    const secondEnvelope = {
      protocolVersion: 1 as const,
      windowId: "window_abcdefgh",
      attemptId: "attempt_abcdefgh",
    };
    await manager.handle("helper_abcdefgh", {
      ...secondEnvelope,
      requestId: "request_admit_stall_2",
      type: "admit",
      sourcePath: "/private/tmp/Other.pdf",
    });

    const stalled = manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_refresh_detach_1",
      type: "refresh",
    });
    await vi.waitFor(() => expect(currentCalls).toBe(1));
    await manager.detach("helper_12345678");
    expect(signals[0]?.aborted).toBe(true);
    await expect(manager.handle("helper_abcdefgh", {
      ...secondEnvelope,
      requestId: "request_refresh_after_detach_1",
      type: "refresh",
    })).resolves.toMatchObject({ type: "refreshed" });

    blocked.resolve(projection());
    await expect(stalled).resolves.toMatchObject({ type: "failure", code: "unavailable" });
    await expect(manager.handle("helper_abcdefgh", {
      ...secondEnvelope,
      requestId: "request_refresh_after_late_settle_1",
      type: "refresh",
    })).resolves.toMatchObject({ type: "refreshed" });
  });

  it("releases stalled resource capacity when its helper detaches", async () => {
    const service = backend();
    const blocked = Promise.withResolvers<Buffer>();
    const signals: AbortSignal[] = [];
    let readCalls = 0;
    vi.mocked(service.readDocument).mockImplementation(async (_key, _generation, offset, length, signal) => {
      if (signal !== undefined) signals.push(signal);
      readCalls += 1;
      return readCalls === 1 ? blocked.promise : sourceBytes.subarray(offset, offset + length);
    });
    const manager = new MacosRuntimeManager(service, {
      maxHelpers: 2,
      maxConcurrentRequests: 2,
      maxResources: 1,
      maxResourcesPerHelper: 1,
    });
    await admit(manager);
    const firstResourceId = manager.resourceId("helper_12345678");
    if (firstResourceId === undefined) throw new Error("Expected a document resource");
    const secondEnvelope = {
      protocolVersion: 1 as const,
      windowId: "window_abcdefgh",
      attemptId: "attempt_abcdefgh",
    };
    await manager.handle("helper_abcdefgh", {
      ...secondEnvelope,
      requestId: "request_admit_resource_2",
      type: "admit",
      sourcePath: "/private/tmp/Other.pdf",
    });
    const secondResourceId = manager.resourceId("helper_abcdefgh");
    if (secondResourceId === undefined) throw new Error("Expected a second document resource");

    const stalled = manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_resource_detach_1",
      type: "read-resource",
      resourceId: firstResourceId,
      generation: 1,
      role: "document",
      offset: 0,
      length: sourceBytes.byteLength,
    });
    await vi.waitFor(() => expect(readCalls).toBe(1));
    await manager.detach("helper_12345678");
    expect(signals[0]?.aborted).toBe(true);
    expect(manager.activity().resources).toBe(0);
    await expect(manager.handle("helper_abcdefgh", {
      ...secondEnvelope,
      requestId: "request_resource_after_detach_1",
      type: "read-resource",
      resourceId: secondResourceId,
      generation: 1,
      role: "document",
      offset: 0,
      length: sourceBytes.byteLength,
    })).resolves.toMatchObject({ type: "resource-bytes" });

    blocked.resolve(sourceBytes);
    await expect(stalled).resolves.toMatchObject({ type: "failure", code: "unavailable" });
    expect(manager.activity().resources).toBe(0);
  });

  it("does not retain completed document chunks in the replay budget", async () => {
    const service = backend();
    const manager = new MacosRuntimeManager(service, { maxRetainedRequestsPerHelper: 3 });
    await admit(manager);
    await manager.handle("helper_12345678", {
      ...envelope,
      requestId: "request_activate_4",
      type: "activate",
      documentValidated: true,
    });
    const resourceId = manager.resourceId("helper_12345678");
    if (resourceId === undefined) throw new Error("Expected a document resource");

    for (let index = 0; index < 8; index += 1) {
      await expect(manager.handle("helper_12345678", {
        ...envelope,
        requestId: `request_chunk_${index}`,
        type: "read-resource",
        resourceId,
        generation: 1,
        role: "document",
        offset: 0,
        length: sourceBytes.byteLength,
      })).resolves.toMatchObject({ type: "resource-bytes" });
    }
    expect(service.readDocument).toHaveBeenCalledTimes(8);
  });
});
