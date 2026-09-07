import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/runtime/canonical-json.js";

describe("runtime fingerprint encoding", () => {
  it("orders nested object keys while preserving array order", () => {
    expect(canonicalJson({ z: [2, { b: false, a: null }], a: "quoted\"" }))
      .toBe('{"a":"quoted\\\"","z":[2,{"a":null,"b":false}]}');
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("retains the existing non-JSON undefined and nonfinite encodings", () => {
    expect(canonicalJson(undefined)).toBeUndefined();
    expect(canonicalJson({ b: undefined, a: NaN })).toBe('{"a":null,"b":undefined}');
    expect(canonicalJson([undefined, Infinity, -Infinity])).toBe('[,null,null]');
    expect(() => canonicalJson(1n)).toThrow(TypeError);
  });
});
