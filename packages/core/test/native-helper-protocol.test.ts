import { describe, expect, it } from "vitest";

import {
  ELECTRON_HELPER_MAX_FRAME_BYTES,
  decodeElectronHelperFrame,
  encodeElectronHelperFrame,
  parseElectronReviewHelperMessage,
  validElectronReviewHelperResponse,
} from "../src/electron-helper-protocol.js";

const base = {
  protocolVersion: 1,
  windowId: "window_12345678",
  attemptId: "attempt_12345678",
  requestId: "request_12345678",
} as const;

describe("Electron helper protocols", () => {
  it("round-trips a bounded framed review message", () => {
    const value = { ...base, type: "admit", sourcePath: "/private/tmp/Paper.pdf" };
    const frame = encodeElectronHelperFrame(value);
    expect(frame.readUInt32BE(0)).toBe(frame.byteLength - 4);
    expect(decodeElectronHelperFrame(frame)).toEqual(value);
  });

  it("round-trips a projection larger than the former 256 KiB ceiling", () => {
    const value = { projection: "x".repeat(300 * 1024) };
    const frame = encodeElectronHelperFrame(value);
    expect(frame.byteLength).toBeGreaterThan(256 * 1024);
    expect(decodeElectronHelperFrame(frame)).toEqual(value);
  });

  it("keeps the review lane closed and generation-bound", () => {
    expect(parseElectronReviewHelperMessage({
      ...base,
      type: "read-resource",
      resourceId: "resource_12345678",
      generation: 3,
      role: "document",
      offset: 0,
      length: 65_536,
    })).toMatchObject({ type: "read-resource", generation: 3 });
    expect(parseElectronReviewHelperMessage({
      ...base,
      type: "register-app",
      processId: 12,
    })).toBeUndefined();
  });

  it("admits only confirmed canonical Placekeeper links", () => {
    const link = "placekeeper:///private/tmp/Paper.pdf#v=1&page=7";
    expect(parseElectronReviewHelperMessage({
      ...base,
      type: "admit-link",
      link,
      confirmed: true,
    })).toMatchObject({ type: "admit-link", link, confirmed: true });
    expect(parseElectronReviewHelperMessage({
      ...base,
      type: "admit-link",
      link,
      confirmed: false,
    })).toBeUndefined();
    expect(parseElectronReviewHelperMessage({
      ...base,
      type: "admit-link",
      link: "placekeeper://host/private/tmp/Paper.pdf#v=1&page=7",
      confirmed: true,
    })).toBeUndefined();
  });

  it("admits only bound recovery choices and typed invalidations", () => {
    const offer = { id: "recovery_offer_1234", expiresAt: "2026-09-05T00:00:00.000Z" };
    expect(parseElectronReviewHelperMessage({
      ...base,
      type: "recover",
      decision: "resume",
      offer,
      idempotencyKey: "operation_recover_1234",
    })).toMatchObject({ type: "recover", decision: "resume", offer });
    expect(parseElectronReviewHelperMessage({
      ...base,
      type: "recover",
      decision: "resume",
      offer: { ...offer, sourcePath: "/private/forbidden.pdf" },
      idempotencyKey: "operation_recover_1234",
    })).toBeUndefined();
    expect(validElectronReviewHelperResponse({
      ...base,
      type: "invalidation",
      generation: 2,
      revision: 7,
      reason: "generation",
    })).toBe(true);
  });

  it("rejects trailing, truncated, and oversized frames", () => {
    const valid = encodeElectronHelperFrame({ ...base, type: "release" });
    expect(() => decodeElectronHelperFrame(Buffer.concat([valid, Buffer.of(0)]))).toThrow(/frame length/iu);
    expect(() => decodeElectronHelperFrame(valid.subarray(0, valid.length - 1))).toThrow(/frame length/iu);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(ELECTRON_HELPER_MAX_FRAME_BYTES + 1);
    expect(() => decodeElectronHelperFrame(oversized)).toThrow(/too large/iu);
  });
});
