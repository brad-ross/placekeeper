import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createChromeInteractionOwnerClaimStore,
  chromePdfDisplayName,
  createNativeEmbeddedReview,
  type NativeEmbeddedReviewSession,
} from "../src/chrome-runtime.js";
import type { NativePort } from "../src/chrome-api.js";

class ReplyEvent<T> {
  readonly #listeners = new Set<(value: T) => void>();
  addListener(listener: (value: T) => void): void { this.#listeners.add(listener); }
  removeListener(listener: (value: T) => void): void { this.#listeners.delete(listener); }
  emit(value: T): void { for (const listener of this.#listeners) listener(value); }
}

const sessionId = "779e1d9d-58c1-4b12-8dc2-3449dad132c1";
const fileId = "c0e41526-1320-4dec-b802-3c17617c0320";
const connectionId = "connection-runtime-1";
const extensionOrigin = "chrome-extension://cgegjjjhbhnfgcoipeffhogoojfoekgg";
const pdf = new TextEncoder().encode("%PDF-1.7\nreview\n%%EOF");
const digest = createHash("sha256").update(pdf).digest("hex");
const successorPdf = new TextEncoder().encode("%PDF-1.7\nsuccessor review\n%%EOF");
const successorDigest = createHash("sha256").update(successorPdf).digest("hex");
const newestPdf = new TextEncoder().encode("%PDF-1.7\nnewest review\n%%EOF");
const newestDigest = createHash("sha256").update(newestPdf).digest("hex");

function projection(sha256 = digest, byteLength = pdf.byteLength) {
  return {
    sessionId,
    generation: 1,
    revision: 0,
    state: {
      schemaVersion: 2,
      sessionId,
      source: { fileId, digest: sha256, byteLength },
      revision: 0,
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
      documentTitle: "Review.pdf",
      sourceDisposition: "remote-temporary",
      sourceDisplayName: "Review.pdf",
      launchSurface: "chrome",
    },
    saveStatus: {
      destination: { phase: "none", generation: 0 },
      sync: { phase: "clean", desiredRevision: 0, savedRevision: 0 },
    },
    canonicalLinkBase: "placekeeper:///Placekeeper%20Browser/review/Review.pdf",
    protected: false,
    location: { kind: "page", page: 1 },
    document: { sha256, byteLength, generation: 1 },
  };
}

function successorProjection() {
  const initial = projection(successorDigest, successorPdf.byteLength);
  return {
    ...initial,
    generation: 2,
    revision: 1,
    state: {
      ...initial.state,
      revision: 1,
      source: { ...initial.state.source, digest: successorDigest, byteLength: successorPdf.byteLength },
      workflow: { ...initial.state.workflow, documentGeneration: 2 },
    },
    document: { sha256: successorDigest, byteLength: successorPdf.byteLength, generation: 2 },
  };
}

function newestProjection() {
  const second = successorProjection();
  return {
    ...second,
    generation: 3,
    revision: 2,
    state: {
      ...second.state,
      revision: 2,
      source: { ...second.state.source, digest: newestDigest, byteLength: newestPdf.byteLength },
      workflow: { ...second.state.workflow, documentGeneration: 3 },
    },
    document: { sha256: newestDigest, byteLength: newestPdf.byteLength, generation: 3 },
  };
}

function revisionProjection() {
  const initial = projection();
  return {
    ...initial,
    revision: 1,
    state: { ...initial.state, revision: 1 },
  };
}

function savedProjection() {
  const initial = projection();
  return {
    ...initial,
    saveStatus: {
      ...initial.saveStatus,
      sync: { phase: "not-saved", desiredRevision: 0, savedRevision: 0, failure: "write-failed" },
    },
  };
}

function runtimePort(options: {
  readonly projection?: ReturnType<typeof projection>;
  readonly activeProjection?: ReturnType<typeof projection>;
  readonly local?: boolean;
  readonly resultThenInvalidation?: boolean;
  readonly successor?: ReturnType<typeof successorProjection>;
  readonly recovery?: boolean;
  readonly dropFirstInvoke?: boolean;
  readonly dropKeepalive?: boolean;
  readonly keepaliveFailure?: string;
  readonly ownerProofUnsupported?: boolean;
  readonly refreshes?: readonly (ReturnType<typeof projection> | { readonly failure: string })[];
  readonly failFirstSuccessorRead?: boolean;
  readonly refreshDelayMs?: number;
  readonly readDelayMs?: number;
  readonly activationDelayMs?: number;
  readonly detachDelayMs?: number;
  readonly throwFirstSuccessorRead?: boolean;
  readonly onSuccessorRead?: () => void;
  readonly onActivateRequest?: () => void;
} = {}): NativePort & {
  readonly sent: Record<string, unknown>[];
  invalidate(message: { readonly generation: number; readonly revision: number; readonly reason: "revision" | "generation" | "save" | "recovery" }): void;
  acknowledgeLatestKeepalive(): void;
  requireUpdate(): void;
} {
  const onMessage = new ReplyEvent<unknown>();
  const onDisconnect = new ReplyEvent<void>();
  const sent: Record<string, unknown>[] = [];
  let droppedInvoke = false;
  let refreshIndex = 0;
  let failedSuccessorRead = false;
  let threwSuccessorRead = false;
  const reply = (message: Record<string, unknown>) => queueMicrotask(() => onMessage.emit({
    protocolVersion: 2,
    connectionId,
    ...message,
  }));
  return {
    sent,
    invalidate(message) {
      reply({ type: "invalidation", lane: "runtime", ...message });
    },
    acknowledgeLatestKeepalive() {
      const request = sent.findLast(({ type }) => type === "keepalive");
      if (typeof request?.requestId !== "string") throw new Error("No keepalive request is pending.");
      reply({ type: "ack", lane: "lifecycle", requestId: request.requestId });
    },
    requireUpdate() {
      reply({ type: "update-required", lane: "lifecycle" });
    },
    onMessage,
    onDisconnect,
    disconnect: vi.fn(),
    postMessage(value) {
      const message = value as unknown as Record<string, unknown>;
      sent.push(message);
      if (message.type === "hello") {
        reply({ type: "hello-ack", reviewRuntimeVersion: 3, protocol: "placekeeper.chrome-runtime", leaseMs: 90_000 });
      } else if (message.type === "claim-owner") {
        reply(options.ownerProofUnsupported === true
          ? { type: "failure", lane: "lifecycle", requestId: message.requestId, reason: "invalid-message" }
          : { type: "ack", lane: "lifecycle", requestId: message.requestId });
      } else if (message.type === "begin" || message.type === "chunk") {
        reply({
          type: "ack",
          lane: "acquisition",
          requestId: message.requestId,
          ...(message.type === "chunk" ? { sequence: message.sequence } : {}),
        });
      } else if (message.type === "finish") {
        reply(options.recovery === true ? {
          type: "recovery-offered",
          lane: "lifecycle",
          requestId: message.requestId,
          choices: ["resume", "discard", "fork"],
          offer: { id: "recovery-offer-0001", expiresAt: "2030-01-01T00:00:00.000Z" },
        } : {
          type: "projection",
          lane: "lifecycle",
          requestId: message.requestId,
          payload: options.projection ?? projection(),
        });
      } else if (message.type === "recover") {
        reply({
          type: "projection",
          lane: "lifecycle",
          requestId: message.requestId,
          payload: options.projection ?? projection(),
        });
      } else if (message.type === "read" && options.local === true) {
        reply({
          type: "resource-chunk",
          lane: "resource",
          requestId: message.requestId,
          sequence: 0,
          data: Buffer.from(pdf).toString("base64"),
          done: true,
        });
      } else if (message.type === "activate") {
        options.onActivateRequest?.();
        const respond = () => reply({
          type: "active",
          lane: "lifecycle",
          requestId: message.requestId,
          payload: options.activeProjection ?? options.projection ?? projection(),
        });
        if (options.activationDelayMs === undefined) respond();
        else setTimeout(respond, options.activationDelayMs);
      } else if (message.type === "refresh") {
        const candidate = options.refreshes?.[Math.min(refreshIndex++, options.refreshes.length - 1)];
        const respond = () => candidate !== undefined && "failure" in candidate
          ? reply({ type: "failure", lane: "lifecycle", requestId: message.requestId, reason: candidate.failure })
          : reply({
            type: "projection",
            lane: "lifecycle",
            requestId: message.requestId,
            payload: candidate ?? options.successor ?? options.projection ?? projection(),
          });
        if (options.refreshDelayMs === undefined) respond();
        else setTimeout(respond, options.refreshDelayMs);
      } else if (message.type === "read" && (options.successor !== undefined || options.refreshes !== undefined)) {
        options.onSuccessorRead?.();
        if (options.throwFirstSuccessorRead === true && !threwSuccessorRead) {
          threwSuccessorRead = true;
          throw new Error("native transport temporarily unavailable");
        }
        if (options.failFirstSuccessorRead === true && !failedSuccessorRead) {
          failedSuccessorRead = true;
          reply({ type: "failure", lane: "resource", requestId: message.requestId, reason: "service-unavailable" });
          return;
        }
        const bytes = message.generation === 3 ? newestPdf : successorPdf;
        const respond = () => reply({
          type: "resource-chunk",
          lane: "resource",
          requestId: message.requestId,
          sequence: 0,
          data: Buffer.from(bytes).toString("base64"),
          done: true,
        });
        if (options.readDelayMs === undefined) respond();
        else setTimeout(respond, options.readDelayMs);
      } else if (message.type === "invoke") {
        if (options.dropFirstInvoke === true && !droppedInvoke) {
          droppedInvoke = true;
          return;
        }
        reply({
          type: "result",
          lane: "runtime",
          requestId: message.requestId,
          method: message.method,
          payload: message.method === "scope"
            ? projection().scope
            : message.method === "beginInteraction"
              ? { status: "accepted", interactionToken: "interaction_chrome_1234", generation: 1,
                  ownerViewId: "attachment_chrome_1234" }
            : message.method === "finalizeInteraction"
              ? { status: "finalized" }
            : message.method === "releaseInteraction" || message.method === "acknowledgeInteraction"
              ? { status: "released" }
            : message.method === "exportReviewedCopy"
              ? { kind: "reviewed-copy", path: "/private/result.pdf", revision: 0, digest }
              : {},
        });
        if (options.resultThenInvalidation === true) {
          reply({
            type: "invalidation",
            lane: "runtime",
            revision: 1,
            generation: 1,
            reason: "revision",
          });
        }
      } else if (message.type === "keepalive" && options.dropKeepalive === true) {
        return;
      } else if (message.type === "keepalive" && options.keepaliveFailure !== undefined) {
        reply({ type: "failure", lane: "lifecycle", requestId: message.requestId, reason: options.keepaliveFailure });
      } else if (message.type === "keepalive" || message.type === "detach") {
        const respond = () => reply({ type: "ack", lane: "lifecycle", requestId: message.requestId });
        if (message.type === "detach" && options.detachDelayMs !== undefined) {
          setTimeout(respond, options.detachDelayMs);
        } else respond();
      }
    },
  };
}

function opener(port: NativePort, overrides: Partial<Parameters<typeof createNativeEmbeddedReview>[0]> = {}) {
  return createNativeEmbeddedReview({
    connectNative: () => port,
    fetchStream: vi.fn(async () => new Response(pdf)),
    createId: () => connectionId,
    createObjectURL: vi.fn(() => `blob:${extensionOrigin}/document-1`),
    revokeObjectURL: vi.fn(),
    getExtensionURL: (path) => `${extensionOrigin}/${path}`,
    timeoutMs: 100,
    ...overrides,
  });
}

describe("embedded Chrome review runtime", () => {
  it("keeps one 256-bit owner secret only for the same tab navigation entry", () => {
    const storage = new Map<string, string>();
    let historyState: unknown = null;
    let navigationType = "navigate";
    let next = 0;
    const environment = (tabId: number) => ({
      tabId,
      navigationType: () => navigationType,
      readHistoryState: () => historyState,
      replaceHistoryState: (state: unknown) => { historyState = state; },
      readSession: (key: string) => storage.get(key) ?? null,
      writeSession: (key: string, value: string) => { storage.set(key, value); },
      createSecret: () => `${String(++next).padStart(2, "0")}${"s".repeat(41)}`,
      createClaimId: () => `claim_${String(++next).padStart(16, "0")}`,
    });

    const firstDocument = createChromeInteractionOwnerClaimStore(environment(41));
    const first = firstDocument.ownerSecret();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(firstDocument.ownerSecret()).toBe(first);

    navigationType = "reload";
    const reloaded = createChromeInteractionOwnerClaimStore(environment(41));
    expect(reloaded.ownerSecret()).toBe(first);
    navigationType = "back_forward";
    expect(createChromeInteractionOwnerClaimStore(environment(41)).ownerSecret()).toBe(first);

    const duplicatedHistory = historyState;
    const duplicatedStorage = new Map(storage);
    const duplicate = createChromeInteractionOwnerClaimStore({
      ...environment(99),
      readHistoryState: () => duplicatedHistory,
      readSession: (key) => duplicatedStorage.get(key) ?? null,
      writeSession: (key, value) => { duplicatedStorage.set(key, value); },
    });
    expect(duplicate.ownerSecret()).not.toBe(first);

    navigationType = "navigate";
    historyState = null;
    expect(createChromeInteractionOwnerClaimStore(environment(41)).ownerSecret()).not.toBe(first);
  });

  it("negotiates tab owner proof after a field-free v2 hello", async () => {
    const port = runtimePort();
    const ownerSecret = "o".repeat(43);
    const session = await opener(port, { interactionOwnerSecret: () => ownerSecret })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });

    expect(port.sent[0]).toEqual(expect.objectContaining({ type: "hello" }));
    expect(port.sent[0]).not.toHaveProperty("interactionOwnerSecret");
    expect(port.sent[1]).toMatchObject({ type: "claim-owner", interactionOwnerSecret: ownerSecret });
    expect(JSON.stringify(port.sent.slice(2))).not.toContain(ownerSecret);
    await session.release();
    session.dispose();
  });

  it("uses an old v2 host for an unprotected review after owner-proof probing", async () => {
    const port = runtimePort({ ownerProofUnsupported: true });
    const session = await opener(port, { interactionOwnerSecret: () => "o".repeat(43) })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });

    expect(port.sent.slice(0, 3).map(({ type }) => type)).toEqual(["hello", "claim-owner", "begin"]);
    await session.activate();
    session.dispose();
  });

  it("does not replay protected recovery through an old host without owner authority", async () => {
    const port = runtimePort({ ownerProofUnsupported: true, recovery: true });
    const chooseRecovery = vi.fn(async () => "resume" as const);
    await expect(opener(port, {
      interactionOwnerSecret: () => "o".repeat(43),
      chooseRecovery,
    })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    })).rejects.toThrow(/update.*reopen/iu);
    expect(chooseRecovery).not.toHaveBeenCalled();
    expect(port.sent.some(({ type }) => type === "recover")).toBe(false);
  });

  it("sanitizes the filename used while PDF metadata is still pending", () => {
    expect(chromePdfDisplayName("https://papers.example.test/Quarterly%20Results.pdf?token=secret"))
      .toBe("Quarterly Results.pdf");
    expect(chromePdfDisplayName("https://papers.example.test/%E2%80%AE%00paper.pdf"))
      .toBe("paper.pdf");
  });

  it("does not disconnect an active review when a pending keepalive resumes after system sleep", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const port = runtimePort({ dropKeepalive: true });
      const session = await opener(port, { timeoutMs: 25, now: () => now })({
        originalUrl: "https://papers.example.test/Review.pdf",
        streamUrl: "blob:chrome-authorized-stream",
      });
      const lifecycle: unknown[] = [];
      session.subscribeLifecycle((event) => lifecycle.push(event));
      await session.activate();

      await vi.advanceTimersByTimeAsync(45_000);
      expect(port.sent.some(({ type }) => type === "keepalive")).toBe(true);
      now = 10_000;
      await vi.advanceTimersByTimeAsync(25);
      expect(lifecycle).toEqual([]);

      port.acknowledgeLatestKeepalive();
      await vi.runAllTicks();
      expect(lifecycle).toEqual([]);
      await session.release();
      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes the remote MIME stream once and exposes only a verified runtime bootstrap", async () => {
    const port = runtimePort();
    const fetchStream = vi.fn(async () => new Response(pdf));
    const createObjectURL = vi.fn(() => `blob:${extensionOrigin}/document-1`);
    const open = opener(port, { fetchStream, createObjectURL });

    const session = await open({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });

    expect(fetchStream).toHaveBeenCalledExactlyOnceWith("blob:chrome-authorized-stream", undefined);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(port.sent.filter(({ type }) => type === "chunk").length).toBe(1);
    const responses: unknown[] = [];
    session.runtimePort.subscribe((message) => responses.push(message));
    session.runtimePort.postMessage({
      protocol: "placekeeper.review-runtime",
      version: 3,
      kind: "request",
      runtimeId: connectionId,
      requestId: "review-bootstrap-1",
      method: "bootstrap",
      payload: {},
    });
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]).toMatchObject({
      kind: "response",
      ok: true,
      payload: {
        resources: {
          document: `blob:${extensionOrigin}/document-1`,
          pdfiumWasm: `${extensionOrigin}/shared/pdfium.wasm`,
          worker: `${extensionOrigin}/shared/pdfium-worker.js`,
        },
      },
    });

    await session.activate();
    expect(port.sent.some(({ type }) => type === "activate")).toBe(true);
  });

  it("continues acquisition only after one explicit protected recovery choice", async () => {
    const port = runtimePort({ recovery: true });
    const chooseRecovery = vi.fn(async () => "resume" as const);
    const session = await opener(port, { chooseRecovery, interactionOwnerSecret: () => "o".repeat(43) })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });

    expect(chooseRecovery).toHaveBeenCalledWith({
      choices: ["resume", "discard", "fork"],
      offer: { id: "recovery-offer-0001", expiresAt: "2030-01-01T00:00:00.000Z" },
    }, undefined);
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: "recover",
      decision: "resume",
      offer: { id: "recovery-offer-0001", expiresAt: "2030-01-01T00:00:00.000Z" },
    }));
    await session.activate();
  });

  it("streams and verifies a local service snapshot before creating its Blob", async () => {
    const port = runtimePort({ local: true });
    const fetchStream = vi.fn();
    const createObjectURL = vi.fn(() => `blob:${extensionOrigin}/document-local`);
    const revokeObjectURL = vi.fn();
    const session = await opener(port, { fetchStream, createObjectURL, revokeObjectURL })({
      originalUrl: "file:///Users/reader/Review.pdf",
      streamUrl: "blob:unused",
    });

    expect(fetchStream).not.toHaveBeenCalled();
    expect(port.sent.some(({ type }) => type === "read")).toBe(true);
    expect(port.sent.find(({ type }) => type === "read")).toMatchObject({ generation: 1, offset: 0 });
    expect(createObjectURL).toHaveBeenCalledOnce();
    await session.release();
    session.dispose();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
      `blob:${extensionOrigin}/document-local`,
    );
  });

  it("rejects mismatched service identity before any document Blob enters the viewer", async () => {
    const port = runtimePort({ projection: projection("a".repeat(64)) });
    const createObjectURL = vi.fn(() => `blob:${extensionOrigin}/should-not-exist`);

    await expect(opener(port, { createObjectURL })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    })).rejects.toThrow(/integrity/iu);

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(port.sent.some(({ type }) => type === "cancel" || type === "detach")).toBe(true);
  });

  it("rejects structurally invalid PDF bytes before creating a document Blob", async () => {
    const invalidPdf = new TextEncoder().encode("not-a-pdf");
    const invalidDigest = createHash("sha256").update(invalidPdf).digest("hex");
    const port = runtimePort({ projection: projection(invalidDigest, invalidPdf.byteLength) });
    const createObjectURL = vi.fn(() => `blob:${extensionOrigin}/should-not-exist`);

    await expect(opener(port, {
      fetchStream: vi.fn(async () => new Response(invalidPdf)),
      createObjectURL,
    })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    })).rejects.toThrow(/validation/iu);

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(port.sent.some(({ type }) => type === "cancel")).toBe(true);
  });

  it("cancels a possibly staged acquisition when the begin acknowledgement times out", async () => {
    const onMessage = new ReplyEvent<unknown>();
    const sent: Record<string, unknown>[] = [];
    const port: NativePort = {
      onMessage,
      onDisconnect: new ReplyEvent<void>(),
      disconnect: vi.fn(),
      postMessage(value) {
        const message = value as unknown as Record<string, unknown>;
        sent.push(message);
        if (message.type === "hello") {
          queueMicrotask(() => onMessage.emit({
            type: "hello-ack", reviewRuntimeVersion: 3,
            protocol: "placekeeper.chrome-runtime",
            protocolVersion: 2,
            connectionId,
            leaseMs: 90_000,
          }));
        } else if (message.type === "cancel") {
          queueMicrotask(() => onMessage.emit({
            type: "ack",
            lane: "acquisition",
            protocolVersion: 2,
            connectionId,
            requestId: message.requestId,
          }));
        }
      },
    };

    await expect(opener(port, { timeoutMs: 5 })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    })).rejects.toThrow(/request-timeout/iu);

    expect(sent.some(({ type }) => type === "begin")).toBe(true);
    expect(sent.some(({ type }) => type === "cancel")).toBe(true);
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it("times out native negotiation before consuming the one-shot stream", async () => {
    const port: NativePort = {
      onMessage: new ReplyEvent<unknown>(),
      onDisconnect: new ReplyEvent<void>(),
      disconnect: vi.fn(),
      postMessage: vi.fn(),
    };
    const fetchStream = vi.fn(async () => new Response(pdf));

    await expect(opener(port, { fetchStream, timeoutMs: 5 })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    })).rejects.toThrow(/request-timeout/iu);

    expect(fetchStream).not.toHaveBeenCalled();
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it("delivers a runtime response before its related invalidation", async () => {
    const port = runtimePort({ resultThenInvalidation: true, refreshes: [revisionProjection()] });
    const session: NativeEmbeddedReviewSession = await opener(port)({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    await session.activate();
    const messages: Array<Record<string, unknown>> = [];
    session.runtimePort.subscribe((message) => messages.push(message as Record<string, unknown>));
    session.runtimePort.postMessage({
      protocol: "placekeeper.review-runtime",
      version: 3,
      kind: "request",
      runtimeId: connectionId,
      requestId: "review-scope-1",
      sessionId,
      generation: 1,
      revision: 0,
      method: "scope",
      payload: {},
    });

    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages.map(({ kind }) => kind)).toEqual(["response", "event"]);
  });

  it("materializes and verifies successor bytes before publishing a generation invalidation", async () => {
    const port = runtimePort({ successor: successorProjection() });
    const createObjectURL = vi.fn()
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-1`)
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-2`);
    const revokeObjectURL = vi.fn();
    const session = await opener(port, { createObjectURL, revokeObjectURL })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    await session.activate();
    const messages: Array<Record<string, unknown>> = [];
    session.runtimePort.subscribe((message) => messages.push(message as Record<string, unknown>));

    port.invalidate({ generation: 2, revision: 1, reason: "generation" });
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
      kind: "event",
      event: "session-invalidated",
      payload: expect.objectContaining({ generation: 2, previousGeneration: 1 }),
    })));
    expect(revokeObjectURL).not.toHaveBeenCalled();

    session.runtimePort.postMessage({
      protocol: "placekeeper.review-runtime",
      version: 3,
      kind: "request",
      runtimeId: connectionId,
      requestId: "review-bootstrap-successor",
      method: "bootstrap",
      payload: {},
    });
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
      kind: "response",
      requestId: "review-bootstrap-successor",
      generation: 2,
      payload: expect.objectContaining({
        generation: 2,
        resources: expect.objectContaining({ document: `blob:${extensionOrigin}/document-2` }),
      }),
    })));
    expect(port.sent.some(({ type }) => type === "refresh")).toBe(true);
    expect(port.sent.some(({ type, generation }) => type === "read" && generation === 2)).toBe(true);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    session.confirmDocumentReady(2);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(`blob:${extensionOrigin}/document-1`);
  });

  it("materializes an activation successor and retains the predecessor until viewer readiness", async () => {
    const port = runtimePort({ activeProjection: successorProjection(), successor: successorProjection() });
    const createObjectURL = vi.fn()
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-1`)
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-2`);
    const revokeObjectURL = vi.fn();
    const session = await opener(port, { createObjectURL, revokeObjectURL })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    const messages: Array<Record<string, unknown>> = [];
    session.runtimePort.subscribe((message) => messages.push(message as Record<string, unknown>));

    await session.activate();

    expect(port.sent).toContainEqual(expect.objectContaining({ type: "read", generation: 2 }));
    expect(messages).toContainEqual(expect.objectContaining({
      event: "session-invalidated",
      payload: expect.objectContaining({ generation: 2, previousGeneration: 1 }),
    }));
    expect(revokeObjectURL).not.toHaveBeenCalled();
    session.confirmDocumentReady(2);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(`blob:${extensionOrigin}/document-1`);
  });

  it.each(["dispose", "release"] as const)(
    "does not install an activation successor or start timers after %s during its resource read",
    async (action) => {
      const readStarted = Promise.withResolvers<void>();
      const port = runtimePort({
        activeProjection: successorProjection(), successor: successorProjection(),
        readDelayMs: 30, detachDelayMs: 80,
        onSuccessorRead: () => readStarted.resolve(),
      });
      const createObjectURL = vi.fn()
        .mockReturnValueOnce(`blob:${extensionOrigin}/document-1`)
        .mockReturnValueOnce(`blob:${extensionOrigin}/document-2`);
      const revokeObjectURL = vi.fn();
      const session = await opener(port, { createObjectURL, revokeObjectURL, timeoutMs: 500 })({
        originalUrl: "https://papers.example.test/Review.pdf",
        streamUrl: "blob:chrome-authorized-stream",
      });
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      try {
        const activation = session.activate().then(() => "resolved", () => "rejected");
        await readStarted.promise;
        const release = action === "release" ? session.release() : undefined;
        if (action === "dispose") session.dispose();
        await release;
        await activation;
        expect(createObjectURL).toHaveBeenCalledOnce();
        expect(setIntervalSpy).not.toHaveBeenCalled();
        if (action === "release") {
          expect(revokeObjectURL).not.toHaveBeenCalled();
          session.dispose();
        }
        expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(`blob:${extensionOrigin}/document-1`);
      } finally {
        setIntervalSpy.mockRestore();
      }
    },
  );

  it.each(["dispose", "release"] as const)(
    "does not continue activation after %s while the activation response is pending",
    async (action) => {
      const activationStarted = Promise.withResolvers<void>();
      const port = runtimePort({
        activeProjection: successorProjection(), successor: successorProjection(),
        activationDelayMs: 30, detachDelayMs: 80,
        onActivateRequest: () => activationStarted.resolve(),
      });
      const createObjectURL = vi.fn(() => `blob:${extensionOrigin}/document-1`);
      const session = await opener(port, { createObjectURL, timeoutMs: 500 })({
        originalUrl: "https://papers.example.test/Review.pdf",
        streamUrl: "blob:chrome-authorized-stream",
      });
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      try {
        const activation = session.activate().then(() => "resolved", () => "rejected");
        await activationStarted.promise;
        const release = action === "release" ? session.release() : undefined;
        if (action === "dispose") session.dispose();
        await release;
        await activation;
        expect(port.sent.some(({ type }) => type === "read")).toBe(false);
        expect(setIntervalSpy).not.toHaveBeenCalled();
        if (action === "release") session.dispose();
      } finally {
        setIntervalSpy.mockRestore();
      }
    },
  );

  it("polls promptly without overlapping refreshes and retries a transient resource read", async () => {
    const port = runtimePort({
      refreshes: [successorProjection(), successorProjection()],
      failFirstSuccessorRead: true,
    });
    const createObjectURL = vi.fn()
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-1`)
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-2`);
    const revokeObjectURL = vi.fn();
    const session = await opener(port, { createObjectURL, revokeObjectURL })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    vi.useFakeTimers();
    try {
      const lifecycle = vi.fn();
      session.subscribeLifecycle(lifecycle);
      const messages: Array<Record<string, unknown>> = [];
      session.runtimePort.subscribe((message) => messages.push(message as Record<string, unknown>));
      await session.activate();

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(port.sent.filter(({ type }) => type === "refresh")).toHaveLength(1));
      expect(messages.some(({ event }) => event === "session-invalidated")).toBe(false);
      expect(revokeObjectURL).not.toHaveBeenCalled();
      expect(lifecycle).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
        event: "session-invalidated",
        payload: expect.objectContaining({ generation: 2 }),
      })));
      expect(port.sent.filter(({ type }) => type === "refresh")).toHaveLength(2);
      expect(createObjectURL).toHaveBeenCalledTimes(2);
      expect(revokeObjectURL).not.toHaveBeenCalled();
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it("retries an unexpected transient resource transport exception", async () => {
    const port = runtimePort({
      refreshes: [successorProjection(), successorProjection()],
      throwFirstSuccessorRead: true,
    });
    const createObjectURL = vi.fn()
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-1`)
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-2`);
    const session = await opener(port, { createObjectURL })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    const lifecycle = vi.fn();
    session.subscribeLifecycle(lifecycle);
    vi.useFakeTimers();
    try {
      await session.activate();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
      expect(port.sent.filter(({ type }) => type === "refresh")).toHaveLength(2);
      expect(lifecycle).not.toHaveBeenCalled();
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps only one prompt refresh request in flight", async () => {
    const port = runtimePort({
      refreshes: [successorProjection(), successorProjection()],
      refreshDelayMs: 1_500,
    });
    const createObjectURL = vi.fn()
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-1`)
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-2`);
    const session = await opener(port, { timeoutMs: 5_000, createObjectURL })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    vi.useFakeTimers();
    try {
      const messages: Array<Record<string, unknown>> = [];
      session.runtimePort.subscribe((message) => messages.push(message as Record<string, unknown>));
      await session.activate();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(port.sent.filter(({ type }) => type === "refresh")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
        event: "session-invalidated",
        payload: expect.objectContaining({ generation: 2 }),
      })));
      expect(port.sent.filter(({ type }) => type === "refresh")).toHaveLength(1);
      session.confirmDocumentReady(2);
      await vi.waitFor(() => expect(port.sent.filter(({ type }) => type === "refresh")).toHaveLength(2));
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it("queues finalize behind a slow projection refresh without dropping its receipt", async () => {
    const port = runtimePort({ refreshes: [projection()], refreshDelayMs: 1_500 });
    const session = await opener(port, { timeoutMs: 5_000 })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    vi.useFakeTimers();
    try {
      const messages: Array<Record<string, unknown>> = [];
      session.runtimePort.subscribe((message) => messages.push(message as Record<string, unknown>));
      await session.activate();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(port.sent.filter(({ type }) => type === "refresh")).toHaveLength(1);

      session.runtimePort.postMessage({
        protocol: "placekeeper.review-runtime", version: 3, kind: "request",
        runtimeId: connectionId, requestId: "review-finalize-queued", sessionId,
        generation: 1, revision: 0, method: "finalizeInteraction",
        payload: {
          interactionToken: "interaction_chrome_1234", order: 2,
          outcome: "discarded", draftId: "draft_chrome_1234", expectedDraftRevision: 0,
        },
      });
      expect(port.sent.filter(({ type }) => type === "invoke")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1_500);
      await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
        requestId: "review-finalize-queued",
        ok: true,
        payload: { status: "finalized" },
      })));
      expect(port.sent.filter(({ type }) => type === "invoke")).toHaveLength(1);
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["dispose", "release"] as const)("cannot publish or leak a successor after %s during its resource read", async (action) => {
    const port = runtimePort({ refreshes: [successorProjection()], readDelayMs: 1_500 });
    const createObjectURL = vi.fn()
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-1`)
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-2`);
    const revokeObjectURL = vi.fn();
    const session = await opener(port, { createObjectURL, revokeObjectURL, timeoutMs: 5_000 })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    const messages: Array<Record<string, unknown>> = [];
    session.runtimePort.subscribe((message) => messages.push(message as Record<string, unknown>));
    await session.activate();
    vi.useFakeTimers();
    try {
      port.invalidate({ generation: 2, revision: 1, reason: "generation" });
      await vi.waitFor(() => expect(port.sent.some(({ type, generation }) =>
        type === "read" && generation === 2)).toBe(true));
      if (action === "dispose") session.dispose();
      else await session.release();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(createObjectURL).toHaveBeenCalledOnce();
      if (action === "dispose") {
        expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(`blob:${extensionOrigin}/document-1`);
      } else {
        expect(revokeObjectURL).not.toHaveBeenCalled();
        session.dispose();
        expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(`blob:${extensionOrigin}/document-1`);
      }
      expect(messages.some(({ event }) => event === "session-invalidated")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns an unready successor viewer failure into the explicit reopen lifecycle", async () => {
    const port = runtimePort({ refreshes: [successorProjection(), newestProjection()] });
    const createObjectURL = vi.fn()
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-1`)
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-2`);
    const revokeObjectURL = vi.fn();
    const session = await opener(port, { createObjectURL, revokeObjectURL })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    const lifecycle = vi.fn();
    session.subscribeLifecycle(lifecycle);
    await session.activate();
    port.invalidate({ generation: 2, revision: 1, reason: "generation" });
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));

    session.reportViewerFailure();
    expect(lifecycle).toHaveBeenCalledExactlyOnceWith({ type: "disconnected", protected: true });
    session.confirmDocumentReady(2);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(port.sent.filter(({ type }) => type === "refresh")).toHaveLength(1);

    session.dispose();
    expect(new Set(revokeObjectURL.mock.calls.map(([url]) => url))).toEqual(new Set([
      `blob:${extensionOrigin}/document-1`,
      `blob:${extensionOrigin}/document-2`,
    ]));
  });

  it("stops prompt polling when the native service requires an update", async () => {
    const port = runtimePort();
    const session = await opener(port)({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    const lifecycle = vi.fn();
    session.subscribeLifecycle(lifecycle);
    vi.useFakeTimers();
    try {
      await session.activate();
      port.requireUpdate();
      await vi.waitFor(() => expect(lifecycle).toHaveBeenCalledExactlyOnceWith({
        type: "update-required",
        protected: false,
      }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(port.sent.filter(({ type }) => type === "refresh")).toHaveLength(0);
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it("cancels a scheduled refresh retry on disposal", async () => {
    const port = runtimePort({ refreshes: [{ failure: "service-unavailable" }] });
    const revokeObjectURL = vi.fn();
    const session = await opener(port, { revokeObjectURL })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    vi.useFakeTimers();
    try {
      await session.activate();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(port.sent.filter(({ type }) => type === "refresh")).toHaveLength(1));
      session.dispose();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(port.sent.filter(({ type }) => type === "refresh")).toHaveLength(1);
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
        `blob:${extensionOrigin}/document-1`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["invalid-service-response", "invalid-state", "connection-closed"])(
    "publishes one reopen event for terminal refresh failure %s",
    async (failure) => {
      const port = runtimePort({ refreshes: [{ failure }] });
      const session = await opener(port)({
        originalUrl: "https://papers.example.test/Review.pdf",
        streamUrl: "blob:chrome-authorized-stream",
      });
      const lifecycle = vi.fn();
      session.subscribeLifecycle(lifecycle);
      vi.useFakeTimers();
      try {
        await session.activate();
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.waitFor(() => expect(lifecycle).toHaveBeenCalledExactlyOnceWith({
          type: "disconnected", protected: false,
        }));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(port.sent.filter(({ type }) => type === "refresh")).toHaveLength(1);
      } finally {
        session.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("treats a locally detected stale refresh projection as terminal", async () => {
    const port = runtimePort({ refreshes: [{ ...projection(), revision: -1 }] });
    const session = await opener(port)({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    const lifecycle = vi.fn();
    session.subscribeLifecycle(lifecycle);
    vi.useFakeTimers();
    try {
      await session.activate();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(lifecycle).toHaveBeenCalledExactlyOnceWith({
        type: "disconnected", protected: false,
      }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(port.sent.filter(({ type }) => type === "refresh")).toHaveLength(1);
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it("recovers a transient keepalive failure through refresh backoff", async () => {
    const port = runtimePort({ keepaliveFailure: "service-unavailable", refreshes: [projection()] });
    const session = await opener(port)({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    const lifecycle = vi.fn();
    session.subscribeLifecycle(lifecycle);
    vi.useFakeTimers();
    try {
      await session.activate();
      await vi.advanceTimersByTimeAsync(45_000);
      await vi.waitFor(() => expect(port.sent.some(({ type }) => type === "keepalive")).toBe(true));
      await vi.waitFor(() => expect(port.sent.some(({ type }) => type === "refresh")).toBe(true));
      expect(lifecycle).not.toHaveBeenCalled();
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps the adopted predecessor while coalescing unadopted generation races", async () => {
    const port = runtimePort({ refreshes: [successorProjection(), newestProjection()] });
    const createObjectURL = vi.fn()
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-1`)
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-2`)
      .mockReturnValueOnce(`blob:${extensionOrigin}/document-3`);
    const revokeObjectURL = vi.fn();
    const session = await opener(port, { createObjectURL, revokeObjectURL })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    await session.activate();
    const messages: Array<Record<string, unknown>> = [];
    session.runtimePort.subscribe((message) => messages.push(message as Record<string, unknown>));

    port.invalidate({ generation: 2, revision: 1, reason: "generation" });
    await vi.waitFor(() => expect(messages.filter(({ event }) => event === "session-invalidated")).toHaveLength(1));
    port.invalidate({ generation: 3, revision: 2, reason: "generation" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(port.sent.filter(({ type }) => type === "refresh")).toHaveLength(1);
    expect(messages.filter(({ event }) => event === "session-invalidated")).toHaveLength(1);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    session.confirmDocumentReady(2);
    await vi.waitFor(() => expect(messages.filter(({ event }) => event === "session-invalidated")).toHaveLength(2));
    expect(createObjectURL).toHaveBeenCalledTimes(3);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(`blob:${extensionOrigin}/document-1`);

    session.runtimePort.postMessage({
      protocol: "placekeeper.review-runtime", version: 3, kind: "request",
      runtimeId: connectionId, requestId: "review-bootstrap-generation-3",
      method: "bootstrap", payload: {},
    });
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
      requestId: "review-bootstrap-generation-3",
      generation: 3,
    })));
    expect(revokeObjectURL).not.toHaveBeenCalledWith(`blob:${extensionOrigin}/document-2`);
    session.confirmDocumentReady(2);
    expect(revokeObjectURL).not.toHaveBeenCalledWith(`blob:${extensionOrigin}/document-2`);
    session.confirmDocumentReady(3);
    expect(revokeObjectURL).toHaveBeenCalledWith(`blob:${extensionOrigin}/document-2`);

    session.dispose();
    expect(revokeObjectURL).toHaveBeenCalledWith(`blob:${extensionOrigin}/document-3`);
    expect(new Set(revokeObjectURL.mock.calls.map(([url]) => url))).toEqual(new Set([
      `blob:${extensionOrigin}/document-1`,
      `blob:${extensionOrigin}/document-2`,
      `blob:${extensionOrigin}/document-3`,
    ]));
  });

  it("publishes same-revision authoring presence without rematerializing identical document bytes", async () => {
    const initial = projection();
    const stale = {
      ...initial,
      activeAuthoringDraftIds: ["draft_chrome_live_1234"],
    };
    const port = runtimePort({ refreshes: [stale] });
    const createObjectURL = vi.fn(() => `blob:${extensionOrigin}/document-1`);
    const session = await opener(port, { createObjectURL })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    await session.activate();
    const messages: Array<Record<string, unknown>> = [];
    session.runtimePort.subscribe((message) => messages.push(message as Record<string, unknown>));

    port.invalidate({ generation: 1, revision: 0, reason: "recovery" });
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
      event: "session-invalidated",
      payload: expect.objectContaining({ reason: "presence", generation: 1, revision: 0 }),
    })));
    expect(createObjectURL).toHaveBeenCalledOnce();
    session.runtimePort.postMessage({
      protocol: "placekeeper.review-runtime", version: 3, kind: "request",
      runtimeId: connectionId, requestId: "review-bootstrap-presence",
      method: "bootstrap", payload: {},
    });
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
      requestId: "review-bootstrap-presence",
      payload: expect.objectContaining({ activeAuthoringDraftIds: ["draft_chrome_live_1234"] }),
    })));
  });

  it("crosses the protected recovery boundary after an accepted export", async () => {
    const port = runtimePort();
    const session = await opener(port)({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    await session.activate();
    const responses: Array<Record<string, unknown>> = [];
    session.runtimePort.subscribe((message) => responses.push(message as Record<string, unknown>));
    session.runtimePort.postMessage({
      protocol: "placekeeper.review-runtime",
      version: 3,
      kind: "request",
      runtimeId: connectionId,
      requestId: "review-export-protected",
      sessionId,
      generation: 1,
      revision: 0,
      method: "exportReviewedCopy",
      payload: {},
    });
    await vi.waitFor(() => expect(responses).toContainEqual(expect.objectContaining({
      requestId: "review-export-protected",
      ok: true,
    })));
    expect(session.protected).toBe(true);
  });

  it("reuses a logical operation key after a lost reply and rotates it after success", async () => {
    const port = runtimePort({ dropFirstInvoke: true });
    const session = await opener(port, { timeoutMs: 10 })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    await session.activate();
    const responses: Array<Record<string, unknown>> = [];
    session.runtimePort.subscribe((message) => responses.push(message as Record<string, unknown>));
    const send = (requestId: string) => session.runtimePort.postMessage({
      protocol: "placekeeper.review-runtime", version: 3, kind: "request",
      runtimeId: connectionId, requestId, sessionId, generation: 1, revision: 0,
      method: "exportReviewedCopy", payload: {},
    });

    send("logical-export-1");
    await vi.waitFor(() => expect(responses).toContainEqual(expect.objectContaining({
      requestId: "logical-export-1", ok: false,
    })));
    expect(session.protected).toBe(true);
    send("logical-export-2");
    await vi.waitFor(() => expect(responses).toContainEqual(expect.objectContaining({
      requestId: "logical-export-2", ok: true,
    })));
    send("logical-export-3");
    await vi.waitFor(() => expect(responses).toContainEqual(expect.objectContaining({
      requestId: "logical-export-3", ok: true,
    })));

    const invokes = port.sent.filter(({ type }) => type === "invoke");
    expect(invokes.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      "logical-export-1", "logical-export-1", "logical-export-3",
    ]);
  });

  it.each([
    ["beginInteraction", { interactionToken: "interaction_chrome_1234", order: 1, generation: 1 }],
    ["finalizeInteraction", {
      interactionToken: "interaction_chrome_1234", order: 2, outcome: "discarded",
      draftId: "draft_chrome_1234", expectedDraftRevision: 0,
    }],
    ["releaseInteraction", { interactionToken: "interaction_chrome_1234", order: 2 }],
    ["acknowledgeInteraction", { interactionToken: "interaction_chrome_1234", order: 3 }],
  ] as const)("sends an idempotency key for %s", async (method, payload) => {
    const port = runtimePort();
    const session = await opener(port)({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    await session.activate();
    const messages: Array<Record<string, unknown>> = [];
    session.runtimePort.subscribe((message) => messages.push(message as Record<string, unknown>));
    session.runtimePort.postMessage({
      protocol: "placekeeper.review-runtime", version: 3, kind: "request",
      runtimeId: connectionId, requestId: `review-${method}`, sessionId,
      generation: 1, revision: 0, method, payload,
    });
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
      requestId: `review-${method}`, ok: true,
    })));
    expect(port.sent.findLast(({ type }) => type === "invoke")).toMatchObject({
      method, idempotencyKey: `review-${method}`,
    });
    session.dispose();
  });

  it("starts protected when the recovered service projection says so", async () => {
    const port = runtimePort({ projection: { ...projection(), protected: true } });
    const session = await opener(port)({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    expect(session.protected).toBe(true);
  });

  it("publishes same-version freshness discovered during activation", async () => {
    const initial = projection();
    const activeProjection = {
      ...initial,
      protected: true,
      state: {
        ...initial.state,
        workflow: { ...initial.state.workflow, freshness: "possibly-stale" },
      },
    };
    const port = runtimePort({ projection: initial, activeProjection });
    const session = await opener(port)({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    const messages: Array<Record<string, unknown>> = [];
    session.runtimePort.subscribe((message) => messages.push(message as Record<string, unknown>));

    await session.activate();

    expect(messages).toContainEqual(expect.objectContaining({
      kind: "event",
      event: "session-invalidated",
      payload: expect.objectContaining({ reason: "freshness", generation: 1, revision: 0 }),
    }));
    expect(session.protected).toBe(true);
  });

  it("crosses the protected boundary when another presentation saves", async () => {
    const port = runtimePort({ refreshes: [savedProjection()] });
    const session = await opener(port)({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    await session.activate();
    const messages: Array<Record<string, unknown>> = [];
    session.runtimePort.subscribe((message) => messages.push(message as Record<string, unknown>));

    port.invalidate({ generation: 1, revision: 0, reason: "save" });
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
      kind: "event",
      event: "session-invalidated",
      payload: expect.objectContaining({ reason: "freshness" }),
    })));
    expect(session.protected).toBe(true);
  });

  it.each([undefined, 1])("rejects review runtime version %s before consuming the one-shot stream", async (reviewRuntimeVersion) => {
    const onMessage = new ReplyEvent<unknown>();
    const port: NativePort = {
      onMessage,
      onDisconnect: new ReplyEvent<void>(),
      disconnect: vi.fn(),
      postMessage() {
        queueMicrotask(() => onMessage.emit({
          type: "hello-ack",
          ...(reviewRuntimeVersion === undefined ? {} : { reviewRuntimeVersion }),
          protocol: "placekeeper.chrome-runtime",
          protocolVersion: 2,
          connectionId,
          leaseMs: 90_000,
        }));
      },
    };
    const fetchStream = vi.fn(async () => new Response(pdf));

    await expect(opener(port, { fetchStream })({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    })).rejects.toThrow(/protocol-mismatch/iu);

    expect(fetchStream).not.toHaveBeenCalled();
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it("does not consume the MIME stream when the registered native host is absent", async () => {
    const fetchStream = vi.fn(async () => new Response(pdf));
    const open = createNativeEmbeddedReview({
      connectNative: () => { throw new Error("native-host-missing"); },
      fetchStream,
      createId: () => connectionId,
      createObjectURL: vi.fn(() => "blob:never"),
      revokeObjectURL: vi.fn(),
      getExtensionURL: (path) => `${extensionOrigin}/${path}`,
    });

    await expect(open({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    })).rejects.toThrow("native-host-missing");
    expect(fetchStream).not.toHaveBeenCalled();
  });
});
