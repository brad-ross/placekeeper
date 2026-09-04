import { describe, expect, it } from "vitest";

import {
  MACOS_HELPER_MAX_FRAME_BYTES,
  decodeMacosHelperFrame,
  encodeMacosHelperFrame,
  parseMacosLifecycleMessage,
  parseMacosReviewHelperMessage,
} from "../src/macos-helper-protocol.js";

const base = {
  protocolVersion: 1,
  windowId: "window_12345678",
  attemptId: "attempt_12345678",
  requestId: "request_12345678",
} as const;

describe("macOS helper protocols", () => {
  it("round-trips a bounded framed review message", () => {
    const value = { ...base, type: "admit", sourcePath: "/private/tmp/Paper.pdf" };
    const frame = encodeMacosHelperFrame(value);
    expect(frame.readUInt32BE(0)).toBe(frame.byteLength - 4);
    expect(decodeMacosHelperFrame(frame)).toEqual(value);
  });

  it("keeps the review lane closed and generation-bound", () => {
    expect(parseMacosReviewHelperMessage({
      ...base,
      type: "read-resource",
      resourceId: "resource_12345678",
      generation: 3,
      role: "document",
      offset: 0,
      length: 65_536,
    })).toMatchObject({ type: "read-resource", generation: 3 });
    expect(parseMacosReviewHelperMessage({
      ...base,
      type: "register-app",
      processId: 12,
    })).toBeUndefined();
  });

  it("keeps app lifecycle capability-minimal and disjoint", () => {
    expect(parseMacosLifecycleMessage({
      protocolVersion: 1,
      type: "register-app",
      processId: 123,
      startIdentity: "start_12345678",
      buildIdentity: "build_12345678",
    })).toMatchObject({ type: "register-app", processId: 123 });
    expect(parseMacosLifecycleMessage({
      protocolVersion: 1,
      type: "register-app",
      processId: 123,
      startIdentity: "start_12345678",
      buildIdentity: "build_12345678",
      resourceId: "resource_12345678",
    })).toBeUndefined();
  });

  it("rejects trailing, truncated, and oversized frames", () => {
    const valid = encodeMacosHelperFrame({ ...base, type: "release" });
    expect(() => decodeMacosHelperFrame(Buffer.concat([valid, Buffer.of(0)]))).toThrow(/frame length/iu);
    expect(() => decodeMacosHelperFrame(valid.subarray(0, valid.length - 1))).toThrow(/frame length/iu);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(MACOS_HELPER_MAX_FRAME_BYTES + 1);
    expect(() => decodeMacosHelperFrame(oversized)).toThrow(/too large/iu);
  });
});
