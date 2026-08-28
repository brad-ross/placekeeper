import { describe, expect, it } from "vitest";
import {
  createChunkMessage,
  parseHostMessage,
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
