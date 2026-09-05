import { describe, expect, it } from "vitest";

import {
  MACOS_HELPER_MAX_FRAME_BYTES,
  decodeMacosHelperFrame,
  encodeMacosHelperFrame,
  parseMacosReviewHelperMessage,
  validMacosReviewHelperResponse,
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

  it("admits only confirmed canonical Placekeeper links", () => {
    const link = "placekeeper:///private/tmp/Paper.pdf#v=1&page=7";
    expect(parseMacosReviewHelperMessage({
      ...base,
      type: "admit-link",
      link,
      confirmed: true,
    })).toMatchObject({ type: "admit-link", link, confirmed: true });
    expect(parseMacosReviewHelperMessage({
      ...base,
      type: "admit-link",
      link,
      confirmed: false,
    })).toBeUndefined();
    expect(parseMacosReviewHelperMessage({
      ...base,
      type: "admit-link",
      link: "placekeeper://host/private/tmp/Paper.pdf#v=1&page=7",
      confirmed: true,
    })).toBeUndefined();
  });

  it("admits only bound recovery choices and typed invalidations", () => {
    const offer = { id: "recovery_offer_1234", expiresAt: "2026-09-05T00:00:00.000Z" };
    expect(parseMacosReviewHelperMessage({
      ...base,
      type: "recover",
      decision: "resume",
      offer,
      idempotencyKey: "operation_recover_1234",
    })).toMatchObject({ type: "recover", decision: "resume", offer });
    expect(parseMacosReviewHelperMessage({
      ...base,
      type: "recover",
      decision: "resume",
      offer: { ...offer, sourcePath: "/private/forbidden.pdf" },
      idempotencyKey: "operation_recover_1234",
    })).toBeUndefined();
    expect(validMacosReviewHelperResponse({
      ...base,
      type: "invalidation",
      generation: 2,
      revision: 7,
      reason: "generation",
    })).toBe(true);
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
