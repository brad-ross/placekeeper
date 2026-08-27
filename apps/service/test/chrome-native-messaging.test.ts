import { describe, expect, it } from "vitest";

import {
  encodeNativeMessage,
  NativeMessageDecoder,
  NativeMessagingProtocolError,
  parseExtensionMessage,
} from "../src/browser/native-messaging.js";

describe("Chrome native-message framing", () => {
  it("decodes fragmented and coalesced little-endian frames", () => {
    const first = encodeNativeMessage({ type: "cancel", transferId: "transfer-1", reason: "bypassed" });
    const second = encodeNativeMessage({
      type: "finish",
      transferId: "transfer-2",
      sequence: 3,
    });
    const decoder = new NativeMessageDecoder();

    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
      { type: "cancel", transferId: "transfer-1", reason: "bypassed" },
      { type: "finish", transferId: "transfer-2", sequence: 3 },
    ]);
    expect(() => decoder.end()).not.toThrow();
  });

  it("rejects oversized, truncated, malformed, and schema-expanded input", () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(2 * 1024 * 1024, 0);
    expect(() => new NativeMessageDecoder().push(oversized)).toThrow(NativeMessagingProtocolError);

    const truncated = new NativeMessageDecoder();
    truncated.push(Buffer.from([10, 0, 0, 0, 123]));
    expect(() => truncated.end()).toThrow("truncated");

    expect(parseExtensionMessage({
      type: "start",
      protocolVersion: 1,
      transferId: "transfer-1",
      disposition: "local",
      fileUrl: "file:///tmp/paper.pdf",
      operation: "shutdown-if-idle",
    })).toBeUndefined();
    expect(parseExtensionMessage({ kind: "launch", request: { pdfPath: "/tmp/paper.pdf" } }))
      .toBeUndefined();
  });
});
