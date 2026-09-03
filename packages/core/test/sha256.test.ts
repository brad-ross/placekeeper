import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/sha256.js";

describe("shared SHA-256", () => {
  it.each(["", "abc", "Placekeeper ✓", "x".repeat(1_000)])(
    "matches Node for %j",
    (value) => {
      expect(sha256Hex(value)).toBe(createHash("sha256").update(value).digest("hex"));
    },
  );

  it("hashes binary input without string coercion", () => {
    const bytes = Uint8Array.from({ length: 257 }, (_, index) => index & 0xff);
    expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});
