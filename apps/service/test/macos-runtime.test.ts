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

function backend(): MacosRuntimeBackend {
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
});
