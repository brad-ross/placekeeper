import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  chromePdfDisplayName,
  createNativeEmbeddedReview,
  type NativeEmbeddedReviewSession,
} from "../src/chrome-runtime.js";
import type { NativePort } from "../src/native-handoff.js";

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
    location: { kind: "page", page: 1 },
    document: { sha256, byteLength, generation: 1 },
  };
}

function runtimePort(options: {
  readonly projection?: ReturnType<typeof projection>;
  readonly local?: boolean;
  readonly resultThenInvalidation?: boolean;
} = {}): NativePort & { readonly sent: Record<string, unknown>[] } {
  const onMessage = new ReplyEvent<unknown>();
  const onDisconnect = new ReplyEvent<void>();
  const sent: Record<string, unknown>[] = [];
  const reply = (message: Record<string, unknown>) => queueMicrotask(() => onMessage.emit({
    protocolVersion: 2,
    connectionId,
    ...message,
  }));
  return {
    sent,
    onMessage,
    onDisconnect,
    disconnect: vi.fn(),
    postMessage(value) {
      const message = value as unknown as Record<string, unknown>;
      sent.push(message);
      if (message.type === "hello") {
        reply({ type: "hello-ack", protocol: "placekeeper.chrome-runtime", leaseMs: 90_000 });
      } else if (message.type === "begin" || message.type === "chunk") {
        reply({
          type: "ack",
          lane: "acquisition",
          requestId: message.requestId,
          ...(message.type === "chunk" ? { sequence: message.sequence } : {}),
        });
      } else if (message.type === "finish") {
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
        reply({
          type: "active",
          lane: "lifecycle",
          requestId: message.requestId,
          payload: options.projection ?? projection(),
        });
      } else if (message.type === "invoke") {
        reply({
          type: "result",
          lane: "runtime",
          requestId: message.requestId,
          method: message.method,
          payload: message.method === "scope" ? projection().scope : {},
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
      } else if (message.type === "keepalive" || message.type === "detach") {
        reply({ type: "ack", lane: "lifecycle", requestId: message.requestId });
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
  it("sanitizes the filename used while PDF metadata is still pending", () => {
    expect(chromePdfDisplayName("https://papers.example.test/Quarterly%20Results.pdf?token=secret"))
      .toBe("Quarterly Results.pdf");
    expect(chromePdfDisplayName("https://papers.example.test/%E2%80%AE%00paper.pdf"))
      .toBe("paper.pdf");
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
      version: 1,
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
            type: "hello-ack",
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
    const port = runtimePort({ resultThenInvalidation: true });
    const session: NativeEmbeddedReviewSession = await opener(port)({
      originalUrl: "https://papers.example.test/Review.pdf",
      streamUrl: "blob:chrome-authorized-stream",
    });
    await session.activate();
    const messages: Array<Record<string, unknown>> = [];
    session.runtimePort.subscribe((message) => messages.push(message as Record<string, unknown>));
    session.runtimePort.postMessage({
      protocol: "placekeeper.review-runtime",
      version: 1,
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

  it("fails closed on protocol skew before consuming the one-shot stream", async () => {
    const onMessage = new ReplyEvent<unknown>();
    const port: NativePort = {
      onMessage,
      onDisconnect: new ReplyEvent<void>(),
      disconnect: vi.fn(),
      postMessage() {
        queueMicrotask(() => onMessage.emit({
          type: "hello-ack",
          protocol: "placekeeper.chrome-runtime",
          protocolVersion: 1,
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
