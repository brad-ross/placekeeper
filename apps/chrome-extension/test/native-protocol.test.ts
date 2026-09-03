import { describe, expect, it } from "vitest";
import {
  CHROME_RUNTIME_PROTOCOL,
  CHROME_RUNTIME_PROTOCOL_VERSION,
  createChunkMessage,
  parseHostMessage,
  parseRuntimeHostMessage,
  validateRuntimeExtensionMessage,
  validatePlacekeeperDestination,
} from "../src/native-protocol.js";

describe("Chrome native protocol codec", () => {
  it("encodes bounded chunks with immutable transfer coordinates", () => {
    expect(createChunkMessage("transfer-1", 3, new Uint8Array([0, 127, 255]))).toEqual({
      type: "chunk",
      transferId: "transfer-1",
      sequence: 3,
      data: "AH//",
    });
  });

  it("accepts only exact phase-closed host replies", () => {
    expect(parseHostMessage({ type: "ack", transferId: "transfer-1", phase: "chunk", sequence: 0 }))
      .toEqual({ type: "ack", transferId: "transfer-1", phase: "chunk", sequence: 0 });
    expect(parseHostMessage({ type: "success", transferId: "transfer-1", destination: 42 }))
      .toBeUndefined();
    expect(parseHostMessage({ type: "failure", transferId: "transfer-1", reason: "host-unavailable", extra: true }))
      .toBeUndefined();
  });

  it("accepts only the production fragment-only bootstrap destination", () => {
    const good =
      "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123";
    expect(validatePlacekeeperDestination(good)).toBe(good);
    expect(validatePlacekeeperDestination(good.replace("127.0.0.1", "localhost"))).toBeUndefined();
    expect(validatePlacekeeperDestination(good.replace("#cap=", "?cap="))).toBeUndefined();
  });
});

describe("Chrome runtime protocol v2", () => {
  const connectionId = "connection-runtime-1";

  it("keeps v2 negotiation and envelopes separate from the legacy redirect protocol", () => {
    expect(validateRuntimeExtensionMessage({
      type: "hello",
      protocol: CHROME_RUNTIME_PROTOCOL,
      protocolVersion: CHROME_RUNTIME_PROTOCOL_VERSION,
      connectionId,
    })).toEqual({
      type: "hello",
      protocol: CHROME_RUNTIME_PROTOCOL,
      protocolVersion: 2,
      connectionId,
    });
    expect(validateRuntimeExtensionMessage({
      type: "start", protocolVersion: 1, transferId: "transfer-1",
      disposition: "remote-temporary",
    })).toBeUndefined();
    expect(validateRuntimeExtensionMessage({
      type: "hello", protocol: CHROME_RUNTIME_PROTOCOL, protocolVersion: 1, connectionId,
    })).toBeUndefined();
  });

  it("accepts only closed, lane-specific v2 messages", () => {
    expect(validateRuntimeExtensionMessage({
      type: "begin", lane: "acquisition", protocolVersion: 2, connectionId,
      requestId: "request-acquire-1", transferId: "transfer-runtime-1",
      disposition: "remote-temporary", sourceUrl: "https://papers.example.test/paper.pdf",
      displayName: "Paper.pdf",
    })).toBeDefined();
    expect(validateRuntimeExtensionMessage({
      type: "invoke", lane: "runtime", protocolVersion: 2, connectionId,
      requestId: "request-runtime-1", generation: 1, revision: 0,
      method: "forwardSyncTex", payload: {},
    })).toBeUndefined();
    expect(validateRuntimeExtensionMessage({
      type: "recover", lane: "lifecycle", protocolVersion: 2, connectionId,
      requestId: "request-recover-1", decision: "resume",
      offer: { id: "recovery-offer-0001", expiresAt: "2030-01-01T00:00:00.000Z" },
      idempotencyKey: "recovery-operation-0001",
    })).toBeDefined();
    expect(validateRuntimeExtensionMessage({
      type: "recover", lane: "lifecycle", protocolVersion: 2, connectionId,
      requestId: "request-recover-1", decision: "resume",
      offer: { id: "recovery-offer-0001", expiresAt: "2030-01-01T00:00:00.000Z", sourceUrl: "https://private.test" },
      idempotencyKey: "recovery-operation-0001",
    })).toBeUndefined();
    expect(validateRuntimeExtensionMessage({
      type: "detach", lane: "lifecycle", protocolVersion: 2, connectionId,
      requestId: "request-detach-1", taskId: "must-not-cross",
    })).toBeUndefined();
  });

  it("returns the sanitized runtime payload rather than the untrusted input object", () => {
    expect(validateRuntimeExtensionMessage({
      type: "invoke", lane: "runtime", protocolVersion: 2, connectionId,
      requestId: "request-runtime-1", generation: 1, revision: 0, method: "chooseCopy",
      payload: { filename: "Review\u202e copy.pdf" },
      idempotencyKey: "operation-key-0001",
    })).toMatchObject({
      payload: { filename: "Review copy.pdf" },
    });
  });

  it("requires acknowledged resource chunks and rejects capability-bearing host payloads", () => {
    expect(parseRuntimeHostMessage({
      type: "resource-chunk", lane: "resource", protocolVersion: 2, connectionId,
      requestId: "request-resource-1", sequence: 0, data: "JVBERi0=", done: false,
    })).toBeDefined();
    expect(parseRuntimeHostMessage({
      type: "projection", lane: "lifecycle", protocolVersion: 2, connectionId,
      requestId: "request-acquire-1", payload: { credential: "must-not-cross" },
    })).toBeUndefined();
  });
});
