import { describe, expect, it } from "vitest";

import { renderedPdfPageIsUsable } from "../src/app/document-readiness.js";

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

describe("document readiness", () => {
  it("requires a decoded, nonzero page intersecting the visible viewer", () => {
    const ready = {
      complete: true,
      naturalWidth: 800,
      naturalHeight: 1_000,
      pageRect: rect(20, 20, 800, 1_000),
      viewportRect: rect(0, 0, 900, 700),
      display: "block",
      visibility: "visible",
    };
    expect(renderedPdfPageIsUsable(ready)).toBe(true);
    expect(renderedPdfPageIsUsable({ ...ready, naturalWidth: 0 })).toBe(false);
    expect(renderedPdfPageIsUsable({ ...ready, pageRect: rect(20, 900, 800, 1_000) })).toBe(false);
    expect(renderedPdfPageIsUsable({ ...ready, visibility: "hidden" })).toBe(false);
  });
});
