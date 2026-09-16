import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ChromeRuntimeAggregateQuota,
  ChromeRuntimeConnection,
  ChromeRuntimeOperationJournal,
  ChromeRuntimeServiceAuthority,
  ChromeCanonicalReviewIndex,
  ChromeRuntimeManager,
  type ChromeRuntimeBackend,
  type ChromeRuntimeProjection,
} from "../src/browser/chrome-runtime.js";
import { ReviewInteractions } from "../src/sessions/review-interactions.js";

const origin = "chrome-extension://cgegjjjhbhnfgcoipeffhogoojfoekgg/";
const connectionId = "connection-runtime-1";
const sourceBytes = Buffer.from("%PDF-1.7\nruntime\n%%EOF");
const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");

function projection(): ChromeRuntimeProjection {
  const sessionId = "779e1d9d-58c1-4b12-8dc2-3449dad132c1";
  return {
    sessionId, generation: 1, revision: 0,
    state: {
      schemaVersion: 2, sessionId,
      source: { fileId: "c0e41526-1320-4dec-b802-3c17617c0320", digest: sourceDigest, byteLength: sourceBytes.byteLength },
      revision: 0, lifecycle: "active", items: [],
      workflow: { schemaVersion: 1, mode: "standard", documentRole: "source-pdf", documentGeneration: 1, freshness: "current", historyBoundary: 0 },
      pendingDrafts: [], discardAudit: [], history: [], historyCursor: 0,
    },
    scope: { documentTitle: "Runtime paper", sourceDisposition: "remote-temporary", sourceDisplayName: "Runtime paper.pdf", launchSurface: "chrome" },
    saveStatus: { destination: { phase: "none", generation: 0 }, sync: { phase: "clean", desiredRevision: 0, savedRevision: 0 } },
    canonicalLinkBase: "placekeeper:///Placekeeper%20Browser/runtime/Runtime%20paper.pdf",
    protected: false,
    location: { kind: "page", page: 1 },
    document: { sha256: sourceDigest, byteLength: sourceBytes.byteLength, generation: 1 },
  };
}

function backend(overrides: Partial<ChromeRuntimeBackend> = {}): ChromeRuntimeBackend {
  return {
    begin: vi.fn(async () => {
      const chunks: Buffer[] = [];
      return {
        async append(bytes: Uint8Array) { chunks.push(Buffer.from(bytes)); },
        async finish(claim?: { readonly sha256: string; readonly byteLength: number }) {
          const bytes = chunks.length === 0 ? sourceBytes : Buffer.concat(chunks);
          expect(claim).toEqual({ sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength });
          return { canonicalKey: `source-identity-1:${sourceDigest}:1`, projection: projection() };
        },
        async cancel() { chunks.length = 0; },
      };
    }),
    activate: vi.fn(async () => projection()),
    current: vi.fn(async () => projection()),
    invoke: vi.fn(async (_key, method) => method === "command"
      ? { ...(projection().state as Record<string, unknown>), revision: 1 }
      : {}),
    readDocument: vi.fn(async (_key, _generation, offset, length) => sourceBytes.subarray(offset, offset + length)),
    detach: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function negotiate(connection: ChromeRuntimeConnection): Promise<void> {
  await expect(connection.handle({ type: "hello", reviewRuntimeVersion: 3, protocol: "placekeeper.chrome-runtime", protocolVersion: 2, connectionId }))
    .resolves.toMatchObject({ type: "hello-ack", reviewRuntimeVersion: 3, protocolVersion: 2, connectionId });
}

async function acquire(connection: ChromeRuntimeConnection): Promise<void> {
  await connection.handle({ type: "begin", lane: "acquisition", protocolVersion: 2, connectionId, requestId: "request-acquire-1", transferId: "transfer-runtime-1", disposition: "remote-temporary", sourceUrl: "https://papers.example.test/paper.pdf", displayName: "Runtime paper.pdf" });
  await connection.handle({ type: "chunk", lane: "acquisition", protocolVersion: 2, connectionId, requestId: "request-chunk-1", transferId: "transfer-runtime-1", sequence: 0, data: sourceBytes.toString("base64") });
  await expect(connection.handle({ type: "finish", lane: "acquisition", protocolVersion: 2, connectionId, requestId: "request-finish-1", transferId: "transfer-runtime-1", sequence: 1 }))
    .resolves.toMatchObject({ type: "projection", requestId: "request-finish-1" });
}

describe("Chrome least-authority native runtime", () => {
  it("rejects malformed interaction owner proofs before acquisition", async () => {
    for (const interactionOwnerSecret of ["short", "x".repeat(42), "x".repeat(44), `${"x".repeat(42)}!`]) {
      const connection = new ChromeRuntimeConnection({ callerOrigin: origin, backend: backend() });
      await negotiate(connection);
      await expect(connection.handle({
        type: "claim-owner", lane: "lifecycle", requestId: "request-claim-owner",
        protocolVersion: 2, connectionId, interactionOwnerSecret,
      })).resolves.toMatchObject({ type: "failure", reason: "invalid-message" });
      await connection.disconnect();
    }
  });

  it("accepts an old extension's field-free v2 hello without owner negotiation", async () => {
    const registerInteraction = vi.fn(() => ({
      sessionId: projection().sessionId,
      attachmentId: "attachment_legacy_extension",
      incarnationId: "incarnation_legacy_extension",
      capability: "c".repeat(43),
      protocolVersion: 1 as const,
      capabilities: ["session-wide-holds", "durable-finalize-receipts", "connection-incarnations"] as const,
    }));
    const connection = new ChromeRuntimeConnection({
      callerOrigin: origin,
      backend: backend({ registerInteraction }),
      authenticatedOwnerKey: "legacy-extension-owner",
    });
    await negotiate(connection);
    await acquire(connection);
    await connection.handle({ type: "activate", lane: "lifecycle", protocolVersion: 2,
      connectionId, requestId: "request-activate-legacy", documentValidated: true });
    expect(registerInteraction).toHaveBeenCalledWith(expect.any(String), "legacy-extension-owner");
    await connection.disconnect();
  });

  it("derives stable session-scoped owner authority without retaining the recovery secret", async () => {
    const ownerKeys: string[] = [];
    const commits = vi.fn(async () => 2);
    const interactions = new ReviewInteractions({ currentGeneration: () => 1 });
    let draftOwnerViewId: string | undefined;
    const service = backend({
      registerInteraction: vi.fn((_canonicalKey, ownerKey) => {
        ownerKeys.push(ownerKey);
        return interactions.register(projection().sessionId, ownerKey);
      }),
      disconnectInteraction: vi.fn((_canonicalKey, attachment) => {
        interactions.disconnect(attachment.attachmentId, attachment.incarnationId);
      }),
      interaction: vi.fn(async (_canonicalKey, attachment, action, payload) => {
        const input = payload as {
          readonly interactionToken: string; readonly order: number; readonly generation?: number;
          readonly outcome?: "applied" | "discarded";
        };
        if (action === "begin") {
          const result = await interactions.begin({
            ...attachment, interactionToken: input.interactionToken,
            order: input.order, generation: input.generation!,
          });
          if (draftOwnerViewId === undefined && result.status === "accepted") {
            draftOwnerViewId = attachment.attachmentId;
          }
          return result;
        }
        if (action === "finalize") {
          if (attachment.attachmentId !== draftOwnerViewId) return { status: "unauthorized" };
          return interactions.finalize({
            ...attachment, interactionToken: input.interactionToken,
            order: input.order, outcome: input.outcome!, commit: commits,
          });
        }
        if (action === "acknowledge") {
          return interactions.acknowledge({ ...attachment, interactionToken: input.interactionToken, order: input.order });
        }
        return interactions.release({ ...attachment, interactionToken: input.interactionToken, order: input.order });
      }),
    });
    const activateOwner = async (id: string, secret: string) => {
      const connection = new ChromeRuntimeConnection({ callerOrigin: origin, backend: service });
      await connection.handle({
        type: "hello", reviewRuntimeVersion: 3, protocol: "placekeeper.chrome-runtime",
        protocolVersion: 2, connectionId: id,
      });
      await connection.handle({
        type: "claim-owner", lane: "lifecycle", requestId: `claim-${id}`,
        protocolVersion: 2, connectionId: id, interactionOwnerSecret: secret,
      });
      for (const message of [
        { type: "begin", lane: "acquisition", requestId: `acquire-${id}`, transferId: `transfer-${id}`, disposition: "remote-temporary", sourceUrl: "https://papers.example.test/paper.pdf" },
        { type: "chunk", lane: "acquisition", requestId: `chunk-${id}`, transferId: `transfer-${id}`, sequence: 0, data: sourceBytes.toString("base64") },
        { type: "finish", lane: "acquisition", requestId: `finish-${id}`, transferId: `transfer-${id}`, sequence: 1 },
        { type: "activate", lane: "lifecycle", requestId: `activate-${id}`, documentValidated: true },
      ] as const) {
        await connection.handle({ ...message, protocolVersion: 2, connectionId: id });
      }
      return connection;
    };
    const invoke = (connection: ChromeRuntimeConnection, id: string, method: "beginInteraction" | "finalizeInteraction" | "acknowledgeInteraction", payload: Record<string, unknown>) =>
      connection.handle({
        type: "invoke", lane: "runtime", protocolVersion: 2,
        connectionId: id, requestId: `request-${method}-${id}`,
        generation: 1, revision: 0, method, payload,
        idempotencyKey: `operation-${method}-${id}`,
      });

    const first = await activateOwner("owner-connection-1", "a".repeat(43));
    await expect(invoke(first, "owner-connection-1", "beginInteraction", {
      interactionToken: "interaction-owner-recovery", order: 1, generation: 1,
    })).resolves.toMatchObject({ type: "result", payload: { status: "accepted" } });
    await first.disconnect();
    expect(interactions.held(projection().sessionId)).toBe(false);
    expect(draftOwnerViewId).toMatch(/^attachment_/u);
    const unrelated = await activateOwner("owner-connection-3", "b".repeat(43));
    await invoke(unrelated, "owner-connection-3", "beginInteraction", {
      interactionToken: "interaction-unrelated-owner", order: 1, generation: 1,
    });
    await expect(invoke(unrelated, "owner-connection-3", "finalizeInteraction", {
      interactionToken: "interaction-unrelated-owner", order: 2, outcome: "applied",
      draftId: "draft-owner-recovery", expectedDraftRevision: 0,
    })).resolves.toMatchObject({ type: "result", payload: { status: "unauthorized" } });

    const resumed = await activateOwner("owner-connection-2", "a".repeat(43));
    await invoke(resumed, "owner-connection-2", "beginInteraction", {
      interactionToken: "interaction-owner-recovery", order: 1, generation: 1,
    });
    expect(interactions.held(projection().sessionId)).toBe(true);
    const finalized = await invoke(resumed, "owner-connection-2", "finalizeInteraction", {
      interactionToken: "interaction-owner-recovery", order: 2, outcome: "applied",
      draftId: "draft-owner-recovery", expectedDraftRevision: 0,
    });
    expect(finalized).toMatchObject({ type: "result", payload: { status: "finalized", reviewRevision: 2 } });
    await expect(invoke(resumed, "owner-connection-2", "finalizeInteraction", {
      interactionToken: "interaction-owner-recovery", order: 3, outcome: "applied",
      draftId: "draft-owner-recovery", expectedDraftRevision: 0,
    })).resolves.toMatchObject({
      type: "result",
      payload: { status: "finalized", outcome: "applied", reviewRevision: 2 },
    });

    expect(ownerKeys[2]).toBe(ownerKeys[0]);
    expect(ownerKeys[1]).not.toBe(ownerKeys[0]);
    const forkOwnerKey = `chrome-recovery:${createHash("sha256")
      .update("placekeeper.chrome-owner\0")
      .update("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .update("\0")
      .update("a".repeat(43))
      .digest("base64url")}`;
    expect(ownerKeys[0]).not.toBe(forkOwnerKey);
    expect(ownerKeys.every((key) => !key.includes("a".repeat(43)) && !key.includes("b".repeat(43)))).toBe(true);
    expect(commits).toHaveBeenCalledOnce();
    expect(service.begin).toHaveBeenCalledWith(expect.objectContaining({ disposition: "remote-temporary" }));
    await resumed.disconnect();
    await unrelated.disconnect();
  });

  it("keeps protected recovery service-owned until one bound resume/discard/fork choice", async () => {
    const choose = vi.fn(async () => ({
      canonicalKey: `source-identity-1:${sourceDigest}:1`,
      projection: projection(),
    }));
    const service = backend({
      begin: vi.fn(async () => ({
        append: vi.fn(async () => undefined),
        finish: vi.fn(async () => ({
          choices: ["resume", "discard", "fork"] as const,
          offer: { id: "recovery-offer-0001", expiresAt: "2030-01-01T00:00:00.000Z" },
          choose,
        })),
        cancel: vi.fn(async () => undefined),
      })),
    });
    const connection = new ChromeRuntimeConnection({ callerOrigin: origin, backend: service });
    await negotiate(connection);
    await connection.handle({ type: "begin", lane: "acquisition", protocolVersion: 2, connectionId, requestId: "request-acquire-1", transferId: "transfer-runtime-1", disposition: "remote-temporary", sourceUrl: "https://papers.example.test/paper.pdf" });
    await connection.handle({ type: "chunk", lane: "acquisition", protocolVersion: 2, connectionId, requestId: "request-chunk-1", transferId: "transfer-runtime-1", sequence: 0, data: sourceBytes.toString("base64") });
    await expect(connection.handle({ type: "finish", lane: "acquisition", protocolVersion: 2, connectionId, requestId: "request-finish-recovery", transferId: "transfer-runtime-1", sequence: 1 }))
      .resolves.toMatchObject({ type: "recovery-offered", choices: ["resume", "discard", "fork"] });
    await expect(connection.handle({
      type: "recover", lane: "lifecycle", protocolVersion: 2, connectionId,
      requestId: "request-recover-1", decision: "resume",
      offer: { id: "recovery-offer-0001", expiresAt: "2030-01-01T00:00:00.000Z" },
      idempotencyKey: "recovery-operation-0001",
    })).resolves.toMatchObject({ type: "projection", payload: { sessionId: projection().sessionId } });
    expect(choose).toHaveBeenCalledExactlyOnceWith("resume", "recovery-operation-0001");
  });

  it("streams only the generation-matching document while the lease is provisional", async () => {
    const service = backend();
    const connection = new ChromeRuntimeConnection({
      callerOrigin: origin,
      backend: service,
    });
    await negotiate(connection);
    await acquire(connection);

    await expect(connection.handle({
      type: "read", lane: "resource", protocolVersion: 2, connectionId,
      requestId: "request-resource-provisional", resource: "document",
      generation: 1, offset: 0, length: sourceBytes.byteLength,
    })).resolves.toMatchObject({
      type: "resource-chunk", lane: "resource",
      requestId: "request-resource-provisional", sequence: 0, done: true,
    });
    expect(service.readDocument).toHaveBeenCalledOnce();
  });

  it("stages verified bytes, activates an internal presentation lease, and detaches", async () => {
    const service = backend();
    const connection = new ChromeRuntimeConnection({ callerOrigin: origin, backend: service });
    await negotiate(connection);
    await acquire(connection);
    await expect(connection.handle({ type: "activate", lane: "lifecycle", protocolVersion: 2, connectionId, requestId: "request-activate-1", documentValidated: true }))
      .resolves.toMatchObject({ type: "active", requestId: "request-activate-1" });
    await connection.handle({ type: "detach", lane: "lifecycle", protocolVersion: 2, connectionId, requestId: "request-detach-1" });

    expect(service.begin).toHaveBeenCalledWith(expect.objectContaining({ sourceIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u), disposition: "remote-temporary" }));
    expect(service.activate).toHaveBeenCalledWith(`source-identity-1:${sourceDigest}:1`, expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u));
    expect(service.detach).toHaveBeenCalledOnce();
    expect(JSON.stringify(connection.diagnostics())).not.toMatch(/credential|sourceUrl|presentation/i);
  });

  it("binds interaction operations to the authenticated Chrome connection and revokes it on detach", async () => {
    const attachment = {
      sessionId: projection().sessionId,
      attachmentId: "attachment_chrome_1234",
      incarnationId: "incarnation_chrome_1234",
      capability: "c".repeat(43),
      protocolVersion: 1 as const,
      capabilities: ["session-wide-holds", "durable-finalize-receipts", "connection-incarnations"] as const,
    };
    const registerInteraction = vi.fn(() => attachment);
    const interaction = vi.fn(async () => ({ status: "accepted", generation: 1, ownerViewId: "chrome-view" }));
    const disconnectInteraction = vi.fn();
    const service = backend({ registerInteraction, interaction, disconnectInteraction });
    const authority = new ChromeRuntimeServiceAuthority(service);
    const connection = new ChromeRuntimeConnection({
      callerOrigin: origin,
      backend: authority,
      authenticatedOwnerKey: "chrome:authenticated-port-1234",
    });
    await negotiate(connection);
    await acquire(connection);
    await connection.handle({
      type: "activate", lane: "lifecycle", protocolVersion: 2, connectionId,
      requestId: "request-activate-interaction", documentValidated: true,
    });

    const operations = [
      ["beginInteraction", "begin", { interactionToken: "interaction_chrome_1234", order: 1, generation: 1 }],
      ["finalizeInteraction", "finalize", { interactionToken: "interaction_chrome_1234", order: 2, outcome: "discarded", draftId: "draft_chrome_1234", expectedDraftRevision: 0 }],
      ["releaseInteraction", "release", { interactionToken: "interaction_chrome_1234", order: 3 }],
      ["acknowledgeInteraction", "acknowledge", { interactionToken: "interaction_chrome_1234", order: 4 }],
    ] as const;
    for (const [method, _action, payload] of operations) {
      await expect(connection.handle({
        type: "invoke", lane: "runtime", protocolVersion: 2, connectionId,
        requestId: `request-${method}`, generation: 1, revision: 0, method, payload,
        idempotencyKey: `operation-${method}`,
      })).resolves.toMatchObject({ type: "result", method, payload: { status: "accepted" } });
    }

    expect(registerInteraction).toHaveBeenCalledExactlyOnceWith(
      `source-identity-1:${sourceDigest}:1`,
      "chrome:authenticated-port-1234",
    );
    expect(interaction.mock.calls.map((call) => call.slice(1, 3))).toEqual(
      operations.map(([, action]) => [attachment, action]),
    );
    expect(service.invoke).not.toHaveBeenCalled();

    await connection.disconnect();
    expect(disconnectInteraction).toHaveBeenCalledExactlyOnceWith(
      `source-identity-1:${sourceDigest}:1`,
      attachment,
    );
    await connection.disconnect();
    expect(disconnectInteraction).toHaveBeenCalledOnce();
  });

  it("strips internal source authority before returning a service projection to Chrome", async () => {
    const release = vi.fn(async () => undefined);
    const unsafeProjection = {
      ...projection(),
      state: {
        ...(projection().state as Record<string, unknown>),
        sourceRootId: "internal-source-root",
      },
      scope: {
        ...(projection().scope as Record<string, unknown>),
        sourceRootPath: "/Users/reader/private",
        sourceUrl: "https://private.example.test/paper.pdf",
      },
    };
    const service = backend({
      begin: vi.fn(async () => ({
        append: vi.fn(async () => undefined),
        finish: vi.fn(async () => ({ canonicalKey: "canonical-unsafe-1", projection: unsafeProjection })),
        cancel: vi.fn(async () => undefined),
      })),
      release,
    });
    const connection = new ChromeRuntimeConnection({ callerOrigin: origin, backend: service });
    await negotiate(connection);
    await connection.handle({ type: "begin", lane: "acquisition", protocolVersion: 2, connectionId, requestId: "request-acquire-1", transferId: "transfer-runtime-1", disposition: "remote-temporary", sourceUrl: "https://papers.example.test/paper.pdf" });
    await connection.handle({ type: "chunk", lane: "acquisition", protocolVersion: 2, connectionId, requestId: "request-chunk-1", transferId: "transfer-runtime-1", sequence: 0, data: sourceBytes.toString("base64") });
    const result = await connection.handle({ type: "finish", lane: "acquisition", protocolVersion: 2, connectionId, requestId: "request-finish-1", transferId: "transfer-runtime-1", sequence: 1 });
    expect(result).toMatchObject({ type: "projection" });
    expect(JSON.stringify(result)).not.toMatch(/sourceRoot|sourceUrl|private|internal-source-root/u);
    expect(release).not.toHaveBeenCalled();
  });

  it("fails closed on skew, mid-port version changes, v1 smuggling, and agent-only methods", async () => {
    const preflight = new ChromeRuntimeConnection({ callerOrigin: origin, backend: backend() });
    await expect(preflight.handle({ type: "hello", reviewRuntimeVersion: 3, protocol: "placekeeper.chrome-runtime", protocolVersion: 1, connectionId }))
      .resolves.toMatchObject({ type: "failure", reason: "protocol-mismatch" });

    for (const reviewRuntimeVersion of [undefined, 1, 2]) {
      const mixed = new ChromeRuntimeConnection({ callerOrigin: origin, backend: backend() });
      await expect(mixed.handle({ type: "hello", protocol: "placekeeper.chrome-runtime", protocolVersion: 2,
        connectionId, ...(reviewRuntimeVersion === undefined ? {} : { reviewRuntimeVersion }) }))
        .resolves.toMatchObject({ type: "failure", reason: "protocol-mismatch" });
      expect(mixed.diagnostics().negotiated).toBe(false);
      await mixed.disconnect();
    }

    const active = new ChromeRuntimeConnection({ callerOrigin: origin, backend: backend() });
    await negotiate(active); await acquire(active);
    await active.handle({ type: "activate", lane: "lifecycle", protocolVersion: 2, connectionId, requestId: "request-activate-1", documentValidated: true });
    await expect(active.handle({ type: "invoke", lane: "runtime", protocolVersion: 1, connectionId, requestId: "request-runtime-1", method: "command", payload: {} }))
      .resolves.toMatchObject({ type: "update-required" });
    await expect(active.handle({ type: "invoke", lane: "runtime", protocolVersion: 2, connectionId, requestId: "request-runtime-2", method: "forwardSyncTex", payload: {} }))
      .resolves.toMatchObject({ type: "failure", reason: "invalid-message" });
  });

  it("returns one idempotent result and rejects changed-payload key reuse", async () => {
    const operation = vi.fn(async () => ({ accepted: true, revision: 1 }));
    const journal = new ChromeRuntimeOperationJournal();
    const first = await journal.commit("canonical-1", "operation-key-0001", { type: "add", value: 1 }, operation);
    const replay = await journal.commit("canonical-1", "operation-key-0001", { type: "add", value: 1 }, operation);
    expect(first).toEqual(replay);
    expect(operation).toHaveBeenCalledOnce();
    await expect(journal.commit("canonical-1", "operation-key-0001", { type: "add", value: 2 }, operation)).rejects.toThrow("idempotency-conflict");
  });

  it("serializes concurrent first use of one operation key before the effect", async () => {
    const release = Promise.withResolvers<void>();
    const operation = vi.fn(async () => {
      await release.promise;
      return { accepted: true, revision: 1 };
    });
    const journal = new ChromeRuntimeOperationJournal();
    const first = journal.commit("canonical-1", "operation-key-concurrent", { type: "add" }, operation);
    const second = journal.commit("canonical-1", "operation-key-concurrent", { type: "add" }, operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { accepted: true, revision: 1 },
      { accepted: true, revision: 1 },
    ]);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("replays a completed operation from the durable service journal after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-runtime-journal-"));
    try {
      const operation = vi.fn(async () => ({ accepted: true, revision: 1 }));
      const first = new ChromeRuntimeOperationJournal({ root });
      await first.commit("canonical-1", "operation-key-0001", { type: "add", value: 1 }, operation);
      const restarted = new ChromeRuntimeOperationJournal({ root });
      await expect(restarted.commit("canonical-1", "operation-key-0001", { type: "add", value: 1 }, operation))
        .resolves.toEqual({ accepted: true, revision: 1 });
      expect(operation).toHaveBeenCalledOnce();
      await expect(restarted.commit("canonical-1", "operation-key-0001", { type: "add", value: 2 }, operation))
        .rejects.toThrow("idempotency-conflict");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never replays an effect whose durable outcome is unknown after interruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-runtime-pending-"));
    try {
      const interrupted = new ChromeRuntimeOperationJournal({ root });
      await expect(interrupted.commit(
        "canonical-1", "operation-key-pending", { type: "save" },
        async () => { throw new Error("process-interrupted"); },
      )).rejects.toThrow("process-interrupted");
      const repeatedEffect = vi.fn(async () => ({ accepted: true }));
      const restarted = new ChromeRuntimeOperationJournal({ root });
      await expect(restarted.commit(
        "canonical-1", "operation-key-pending", { type: "save" }, repeatedEffect,
      )).rejects.toThrow("operation-outcome-unknown");
      expect(repeatedEffect).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps canonical source identity conjunctive with verified digest and generation", async () => {
    const index = new ChromeCanonicalReviewIndex<{ readonly id: string }>();
    const sourceIdentity = createHash("sha256").update("https://papers.example.test/paper.pdf").digest("hex");
    const same = vi.fn(async () => ({ id: "canonical-1" }));
    const first = await index.resolve({ sourceIdentity, sha256: sourceDigest, generation: 1 }, same);
    const joined = await index.resolve({ sourceIdentity, sha256: sourceDigest, generation: 1 }, same);
    const changedDigest = createHash("sha256").update("changed bytes").digest("hex");
    const changed = await index.resolve(
      { sourceIdentity, sha256: changedDigest, generation: 1 },
      async () => ({ id: "canonical-2" }),
    );
    const changedGeneration = await index.resolve(
      { sourceIdentity, sha256: sourceDigest, generation: 2 },
      async () => ({ id: "canonical-3" }),
    );

    expect(first).toMatchObject({ joined: false, review: { id: "canonical-1" } });
    expect(joined).toMatchObject({ joined: true, review: { id: "canonical-1" } });
    expect(changed.review.id).toBe("canonical-2");
    expect(changedGeneration.review.id).toBe("canonical-3");
    expect(same).toHaveBeenCalledOnce();
  });

  it("deduplicates a dropped non-idempotent response across fresh native connections", async () => {
    const effect = vi.fn(async () => projection().saveStatus);
    const delegate = backend({ invoke: vi.fn(async () => effect()) });
    const authority = new ChromeRuntimeServiceAuthority(delegate);
    const invokeThroughFreshConnection = async (id: string) => {
      const connection = new ChromeRuntimeConnection({ callerOrigin: origin, backend: authority });
      await connection.handle({ type: "hello", reviewRuntimeVersion: 3, protocol: "placekeeper.chrome-runtime", protocolVersion: 2, connectionId: id });
      await connection.handle({ type: "begin", lane: "acquisition", protocolVersion: 2, connectionId: id, requestId: `request-acquire-${id}`, transferId: `transfer-${id}`, disposition: "remote-temporary", sourceUrl: "https://papers.example.test/paper.pdf" });
      await connection.handle({ type: "chunk", lane: "acquisition", protocolVersion: 2, connectionId: id, requestId: `request-chunk-${id}`, transferId: `transfer-${id}`, sequence: 0, data: sourceBytes.toString("base64") });
      await connection.handle({ type: "finish", lane: "acquisition", protocolVersion: 2, connectionId: id, requestId: `request-finish-${id}`, transferId: `transfer-${id}`, sequence: 1 });
      await connection.handle({ type: "activate", lane: "lifecycle", protocolVersion: 2, connectionId: id, requestId: `request-activate-${id}`, documentValidated: true });
      const result = await connection.handle({ type: "invoke", lane: "runtime", protocolVersion: 2, connectionId: id, requestId: `request-runtime-${id}`, generation: 1, revision: 0, method: "retrySave", payload: {}, idempotencyKey: "operation-key-shared" });
      await connection.disconnect();
      return result;
    };

    await expect(invokeThroughFreshConnection("connection-fresh-1")).resolves.toMatchObject({ type: "result" });
    await expect(invokeThroughFreshConnection("connection-fresh-2")).resolves.toMatchObject({ type: "result" });
    expect(effect).toHaveBeenCalledOnce();
  });

  it("enforces aggregate port and byte quotas and releases them on disconnect", async () => {
    const quota = new ChromeRuntimeAggregateQuota({ maxPorts: 1, maxRequests: 1, maxBufferedBytes: 8, maxResources: 1 });
    const first = new ChromeRuntimeConnection({ callerOrigin: origin, backend: backend(), quota });
    expect(() => new ChromeRuntimeConnection({ callerOrigin: origin, backend: backend(), quota })).toThrow("host-busy");
    await negotiate(first);
    await first.handle({ type: "begin", lane: "acquisition", protocolVersion: 2, connectionId, requestId: "request-acquire-1", transferId: "transfer-runtime-1", disposition: "remote-temporary", sourceUrl: "https://papers.example.test/paper.pdf" });
    await expect(first.handle({ type: "chunk", lane: "acquisition", protocolVersion: 2, connectionId, requestId: "request-chunk-1", transferId: "transfer-runtime-1", sequence: 0, data: Buffer.alloc(9).toString("base64") }))
      .resolves.toMatchObject({ type: "failure", reason: "host-byte-budget" });
    await first.disconnect();
    expect(quota.snapshot()).toEqual({ ports: 0, requests: 0, bufferedBytes: 0, resources: 0 });
  });

  it("streams document frames with ack backpressure and rejects wrong roles and generations", async () => {
    const connection = new ChromeRuntimeConnection({ callerOrigin: origin, backend: backend() });
    await negotiate(connection); await acquire(connection);
    await connection.handle({ type: "activate", lane: "lifecycle", protocolVersion: 2, connectionId, requestId: "request-activate-1", documentValidated: true });
    await expect(connection.handle({ type: "read", lane: "resource", protocolVersion: 2, connectionId, requestId: "request-resource-1", resource: "document", generation: 1, offset: 0, length: 8 }))
      .resolves.toMatchObject({ type: "resource-chunk", sequence: 0, done: false });
    await expect(connection.handle({ type: "ack", lane: "resource", protocolVersion: 2, connectionId, requestId: "request-resource-1", sequence: 0 }))
      .resolves.toMatchObject({ type: "resource-chunk", sequence: 1 });
    await expect(connection.handle({ type: "read", lane: "resource", protocolVersion: 2, connectionId, requestId: "request-resource-2", resource: "worker", generation: 1, offset: 0, length: 8 }))
      .resolves.toMatchObject({ type: "failure", reason: "invalid-message" });
    await expect(connection.handle({ type: "read", lane: "resource", protocolVersion: 2, connectionId, requestId: "request-resource-3", resource: "document", generation: 2, offset: 0, length: 8 }))
      .resolves.toMatchObject({ type: "failure", reason: "stale-generation" });
  });

  it("invalidates freshness-only projection changes without a revision bump", async () => {
    const initial = projection();
    const stale = {
      ...initial,
      state: {
        ...(initial.state as Record<string, unknown>),
        workflow: {
          ...((initial.state as Record<string, unknown>).workflow as Record<string, unknown>),
          freshness: "possibly-stale",
        },
      },
    };
    const lifecycleChanged = {
      ...stale,
      state: {
        ...(stale.state as Record<string, unknown>),
        lifecycle: "recovery",
      },
    };
    const current = vi.fn()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(lifecycleChanged);
    const connection = new ChromeRuntimeConnection({
      callerOrigin: origin,
      backend: backend({ current }),
    });
    await negotiate(connection);
    await acquire(connection);
    await connection.handle({
      type: "activate", lane: "lifecycle", protocolVersion: 2, connectionId,
      requestId: "request-activate-freshness", documentValidated: true,
    });

    await expect(connection.handle({
      type: "keepalive", lane: "lifecycle", protocolVersion: 2, connectionId,
      requestId: "request-keepalive-freshness",
    })).resolves.toMatchObject({
      type: "invalidation",
      generation: initial.generation,
      revision: initial.revision,
      reason: "recovery",
    });
    await expect(connection.handle({
      type: "keepalive", lane: "lifecycle", protocolVersion: 2, connectionId,
      requestId: "request-keepalive-lifecycle",
    })).resolves.toMatchObject({
      type: "invalidation",
      generation: initial.generation,
      revision: initial.revision,
      reason: "recovery",
    });
  });

  it("polls service-owned invalidations on a bounded lifecycle heartbeat", async () => {
    const changed = { ...projection(), revision: 1, state: { ...(projection().state as Record<string, unknown>), revision: 1 } };
    const service = backend({ current: vi.fn(async () => changed) });
    const connection = new ChromeRuntimeConnection({ callerOrigin: origin, backend: service });
    await negotiate(connection); await acquire(connection);
    await connection.handle({ type: "activate", lane: "lifecycle", protocolVersion: 2, connectionId, requestId: "request-activate-1", documentValidated: true });
    await expect(connection.handle({ type: "keepalive", lane: "lifecycle", protocolVersion: 2, connectionId, requestId: "request-keepalive-1" }))
      .resolves.toMatchObject({ type: "invalidation", lane: "runtime", revision: 1, generation: 1, reason: "revision" });
  });

  it("polls service-owned save changes even when revision is unchanged", async () => {
    const changed = {
      ...projection(),
      saveStatus: {
        destination: { phase: "active", generation: 1, kind: "copy", targetPath: "Reviewed.pdf" },
        sync: { phase: "clean", desiredRevision: 0, savedRevision: 0 },
      },
    };
    const service = backend({ current: vi.fn(async () => changed) });
    const connection = new ChromeRuntimeConnection({ callerOrigin: origin, backend: service });
    await negotiate(connection); await acquire(connection);
    await connection.handle({ type: "activate", lane: "lifecycle", protocolVersion: 2, connectionId, requestId: "request-activate-1", documentValidated: true });
    await expect(connection.handle({ type: "keepalive", lane: "lifecycle", protocolVersion: 2, connectionId, requestId: "request-keepalive-save" }))
      .resolves.toMatchObject({ type: "invalidation", lane: "runtime", revision: 0, generation: 1, reason: "save" });
  });

  it("returns a fresh projection before a presentation reads successor bytes", async () => {
    const successor = {
      ...projection(),
      generation: 2,
      revision: 1,
      state: {
        ...(projection().state as Record<string, unknown>),
        revision: 1,
        workflow: {
          ...((projection().state as Record<string, unknown>).workflow as Record<string, unknown>),
          documentGeneration: 2,
        },
      },
      document: { ...projection().document, generation: 2 },
    };
    const service = backend({ current: vi.fn(async () => successor) });
    const connection = new ChromeRuntimeConnection({ callerOrigin: origin, backend: service });
    await negotiate(connection); await acquire(connection);
    await connection.handle({ type: "activate", lane: "lifecycle", protocolVersion: 2, connectionId, requestId: "request-activate-1", documentValidated: true });

    await expect(connection.handle({
      type: "refresh", lane: "lifecycle", protocolVersion: 2, connectionId,
      requestId: "request-refresh-1",
    })).resolves.toMatchObject({
      type: "projection",
      requestId: "request-refresh-1",
      payload: { generation: 2, revision: 1, document: { generation: 2 } },
    });
    await expect(connection.handle({
      type: "read", lane: "resource", protocolVersion: 2, connectionId,
      requestId: "request-resource-successor", resource: "document",
      generation: 2, offset: 0, length: sourceBytes.byteLength,
    })).resolves.toMatchObject({ type: "resource-chunk", requestId: "request-resource-successor" });
    expect(service.readDocument).toHaveBeenCalledWith(
      `source-identity-1:${sourceDigest}:1`, 2, 0, sourceBytes.byteLength,
    );
  });

  it("fences stale non-idempotent work and publishes the current canonical revision", async () => {
    const current = {
      ...projection(),
      revision: 1,
      state: { ...(projection().state as Record<string, unknown>), revision: 1 },
    };
    const events: unknown[] = [];
    const service = backend({ current: vi.fn(async () => current) });
    const connection = new ChromeRuntimeConnection({
      callerOrigin: origin,
      backend: service,
      onAsyncMessage: (message) => events.push(message),
    });
    await negotiate(connection); await acquire(connection);
    await connection.handle({ type: "activate", lane: "lifecycle", protocolVersion: 2, connectionId, requestId: "request-activate-1", documentValidated: true });

    await expect(connection.handle({
      type: "invoke", lane: "runtime", protocolVersion: 2, connectionId,
      requestId: "request-stale-save", generation: 1, revision: 0,
      method: "retrySave", payload: {}, idempotencyKey: "operation-key-stale-save",
    })).resolves.toMatchObject({ type: "failure", reason: "stale-presentation" });
    expect(service.invoke).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({
      type: "invalidation", generation: 1, revision: 1, reason: "revision",
    })]);
  });

  it("does not expire an active presentation while a runtime request is in flight", async () => {
    vi.useFakeTimers();
    try {
      const operation = Promise.withResolvers<unknown>();
      const quota = new ChromeRuntimeAggregateQuota();
      const messages: unknown[] = [];
      const service = backend({ invoke: vi.fn(async () => operation.promise) });
      const connection = new ChromeRuntimeConnection({
        callerOrigin: origin, backend: service, quota, idleLeaseMs: 25,
        onAsyncMessage: (message) => messages.push(message),
      });
      await negotiate(connection); await acquire(connection);
      await connection.handle({ type: "activate", lane: "lifecycle", protocolVersion: 2, connectionId, requestId: "request-activate-1", documentValidated: true });

      const pending = connection.handle({
        type: "invoke", lane: "runtime", protocolVersion: 2, connectionId,
        requestId: "request-runtime-long-1", generation: 1, revision: 0,
        method: "retrySave", payload: {},
        idempotencyKey: "operation-key-long-request",
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(quota.snapshot().ports).toBe(1);
      expect(messages).not.toContainEqual(expect.objectContaining({ reason: "idle-timeout" }));

      operation.resolve(projection().saveStatus);
      await expect(pending).resolves.toMatchObject({ type: "result", requestId: "request-runtime-long-1" });
      await vi.advanceTimersByTimeAsync(25);
      expect(quota.snapshot().ports).toBe(0);
      expect(messages).toContainEqual(expect.objectContaining({ reason: "idle-timeout" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("grants an active presentation one fresh lease after a suspended idle deadline resumes", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const quota = new ChromeRuntimeAggregateQuota();
      const messages: unknown[] = [];
      const connection = new ChromeRuntimeConnection({
        callerOrigin: origin,
        backend: backend(),
        quota,
        idleLeaseMs: 25,
        now: () => now,
        onAsyncMessage: (message) => messages.push(message),
      });
      await negotiate(connection);
      await acquire(connection);
      await connection.handle({
        type: "activate", lane: "lifecycle", protocolVersion: 2, connectionId,
        requestId: "request-activate-sleep-1", documentValidated: true,
      });

      now = 10_000;
      await vi.advanceTimersByTimeAsync(25);
      expect(quota.snapshot().ports).toBe(1);
      expect(messages).not.toContainEqual(expect.objectContaining({ reason: "idle-timeout" }));

      now = 10_025;
      await vi.advanceTimersByTimeAsync(25);
      expect(quota.snapshot().ports).toBe(0);
      expect(messages).toContainEqual(expect.objectContaining({ reason: "idle-timeout" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("actively reclaims a stalled acquisition, withheld resource ack, and idle presentation", async () => {
    vi.useFakeTimers();
    try {
      const cancelled = vi.fn(async () => undefined);
      const messages: unknown[] = [];
      const service = backend({
        begin: vi.fn(async () => ({
          append: vi.fn(async () => undefined),
          finish: vi.fn(async () => ({ canonicalKey: `source-identity-1:${sourceDigest}:1`, projection: projection() })),
          cancel: cancelled,
        })),
      });
      const acquiring = new ChromeRuntimeConnection({ callerOrigin: origin, backend: service, requestTimeoutMs: 25, idleLeaseMs: 1_000, onAsyncMessage: (message) => messages.push(message) });
      await negotiate(acquiring);
      await acquiring.handle({ type: "begin", lane: "acquisition", protocolVersion: 2, connectionId, requestId: "request-acquire-1", transferId: "transfer-runtime-1", disposition: "remote-temporary", sourceUrl: "https://papers.example.test/paper.pdf" });
      await vi.advanceTimersByTimeAsync(25);
      expect(cancelled).toHaveBeenCalledOnce();
      expect(messages).toContainEqual(expect.objectContaining({ type: "failure", reason: "request-timeout", lane: "acquisition" }));
      await acquiring.disconnect();

      const quota = new ChromeRuntimeAggregateQuota();
      const activeMessages: unknown[] = [];
      const active = new ChromeRuntimeConnection({ callerOrigin: origin, backend: backend(), quota, requestTimeoutMs: 25, idleLeaseMs: 50, onAsyncMessage: (message) => activeMessages.push(message) });
      await negotiate(active); await acquire(active);
      await active.handle({ type: "activate", lane: "lifecycle", protocolVersion: 2, connectionId, requestId: "request-activate-1", documentValidated: true });
      await active.handle({ type: "read", lane: "resource", protocolVersion: 2, connectionId, requestId: "request-resource-1", resource: "document", generation: 1, offset: 0, length: 8 });
      expect(quota.snapshot().resources).toBe(1);
      await vi.advanceTimersByTimeAsync(25);
      expect(quota.snapshot().resources).toBe(0);
      expect(activeMessages).toContainEqual(expect.objectContaining({ type: "failure", reason: "request-timeout", lane: "resource" }));
      await vi.advanceTimersByTimeAsync(25);
      expect(quota.snapshot().ports).toBe(0);
      expect(activeMessages).toContainEqual(expect.objectContaining({ type: "failure", reason: "idle-timeout", lane: "lifecycle" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes idle daemon connections and queued events without a follow-up request", async () => {
    vi.useFakeTimers();
    try {
      const manager = new ChromeRuntimeManager(new ChromeRuntimeServiceAuthority(backend()), { idleLeaseMs: 25 });
      await manager.handle("manager-port-id-0001", {
        type: "hello", reviewRuntimeVersion: 3, protocol: "placekeeper.chrome-runtime", protocolVersion: 2,
        connectionId: "manager-connection-1",
      });
      expect(manager.activity()).toEqual({ connections: 1, queuedEvents: 0 });
      await vi.advanceTimersByTimeAsync(25);
      expect(manager.activity()).toEqual({ connections: 0, queuedEvents: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a bounded busy response when the daemon-owned port quota is full", async () => {
    const quota = new ChromeRuntimeAggregateQuota({ maxPorts: 1 });
    const authority = new ChromeRuntimeServiceAuthority(backend(), { quota });
    const manager = new ChromeRuntimeManager(authority);
    await manager.handle("manager-port-id-0001", {
      type: "hello", reviewRuntimeVersion: 3, protocol: "placekeeper.chrome-runtime", protocolVersion: 2,
      connectionId: "manager-connection-1",
    });
    await expect(manager.handle("manager-port-id-0002", {
      type: "hello", reviewRuntimeVersion: 3, protocol: "placekeeper.chrome-runtime", protocolVersion: 2,
      connectionId: "manager-connection-2",
    })).resolves.toMatchObject([{ type: "failure", reason: "host-busy" }]);
    await manager.close();
  });
});
