import { describe, expect, it } from "vitest";
import { parseCodexAppRequest, parseCodexDisplayRequest, parseCodexDisplayReceipt, CODEX_RESOURCE_CHUNK_BYTES, parseCodexAppResponse, parseCodexResourceChunk, parseCodexResourceDescriptor } from "../src/codex-mcp-protocol.js";
const id = "abcdefgh_1234";
const capability = "c".repeat(43);
const base = { protocolVersion: 1, runtimeId: id, attemptId: id, requestId: id, generation: 1 };
describe("closed Codex MCP contracts", () => {
  it("accepts only the service handoff as display input; never a model task identity", () => {
    expect(parseCodexDisplayRequest({ handoff: capability })).toEqual({ handoff: capability });
    expect(parseCodexDisplayRequest({ handoff: capability, taskSessionId: "forged" })).toBeUndefined();
  });
  it("keeps the model receipt credential-free", () => {
    const receipt = { protocolVersion: 1, status: "pending", receiptId: id, attemptId: id, generation: 1 };
    expect(parseCodexDisplayReceipt(receipt)).toEqual(receipt);
    for (const key of ["capability", "taskId", "pendingCapability", "url"]) expect(parseCodexDisplayReceipt({ ...receipt, [key]: capability })).toBeUndefined();
  });
  it("restricts pending authority to readiness/status, denying resources and commands", () => {
    for (const method of ["ready", "status"]) expect(parseCodexAppRequest({ ...base, authority: "pending", capability, method, payload: {} })).toBeDefined();
    for (const method of ["resource", "command", "bootstrap"]) expect(parseCodexAppRequest({ ...base, authority: "pending", capability, method, payload: {} })).toBeUndefined();
  });
  it("validates active identity, closed method payloads and bounded resource chunks", () => {
    const request = { ...base, authority: "presentation", capability, method: "resource", payload: { handle: id, offset: 0, length: CODEX_RESOURCE_CHUNK_BYTES } };
    expect(parseCodexAppRequest(request)).toEqual(request);
    expect(parseCodexAppRequest({ ...request, payload: { ...request.payload, length: CODEX_RESOURCE_CHUNK_BYTES + 1 } })).toBeUndefined();
    expect(parseCodexAppRequest({ ...request, taskId: "forged" })).toBeUndefined();
    expect(parseCodexAppRequest({ ...request, runtimeId: "bad" })).toBeUndefined();
    expect(parseCodexAppRequest({ ...request, method: "forwardSyncTex" })).toBeUndefined();
    expect(parseCodexAppRequest({ ...request, method: "scope", payload: { capability } })).toBeUndefined();
  });
});

 describe("private native responses and immutable resources", () => {
  it("requires active capabilities only in the private promotion response", () => {
    const response = { status: "active", runtimeId: id, attemptId: id, generation: 1, presentationCapability: capability, reconnectTicket: "r".repeat(43) };
    expect(parseCodexAppResponse(response)).toEqual(response);
    expect(parseCodexAppResponse({ status: "pending", presentationCapability: capability })).toBeUndefined();
    expect(parseCodexAppResponse({ ...response, taskId: "forged" })).toBeUndefined();
  });
  it("bounds binary chunks precisely and requires complete immutable descriptors", () => {
    const chunk = { offset: 0, dataBase64: Buffer.alloc(CODEX_RESOURCE_CHUNK_BYTES).toString("base64"), done: false };
    expect(parseCodexResourceChunk(chunk)).toEqual(chunk);
    expect(parseCodexResourceChunk({ ...chunk, dataBase64: Buffer.alloc(CODEX_RESOURCE_CHUNK_BYTES + 1).toString("base64") })).toBeUndefined();
    const descriptor = { handle: id, byteLength: 100, sha256: "a".repeat(64), mediaType: "application/pdf" };
    expect(parseCodexResourceDescriptor(descriptor)).toEqual(descriptor);
    expect(parseCodexResourceDescriptor({ ...descriptor, path: "/private/paper.pdf" })).toBeUndefined();
  });
});
