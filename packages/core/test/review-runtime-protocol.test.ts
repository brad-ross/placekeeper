import { describe, expect, it } from "vitest";

import {
  REVIEW_RUNTIME_METHODS,
  REVIEW_RUNTIME_PROTOCOL,
  REVIEW_RUNTIME_VERSION,
  isReviewPanelKey,
  isReviewRuntimeMethod,
} from "../src/review-runtime-protocol.js";

describe("shared review runtime protocol", () => {
  it("defines the complete versioned method vocabulary for both hosts", () => {
    expect(REVIEW_RUNTIME_PROTOCOL).toBe("placekeeper.review-runtime");
    expect(REVIEW_RUNTIME_VERSION).toBe(1);
    expect(REVIEW_RUNTIME_METHODS).toEqual([
      "bootstrap",
      "presence",
      "detach",
      "command",
      "saveStatus",
      "saveProposal",
      "chooseCopy",
      "chooseFolder",
      "chooseOriginal",
      "retrySave",
      "locateSave",
      "scope",
      "forwardSyncTex",
      "reverseSyncTex",
      "exportReviewedCopy",
    ]);
  });

  it("accepts only methods in the shared vocabulary", () => {
    for (const method of REVIEW_RUNTIME_METHODS) expect(isReviewRuntimeMethod(method)).toBe(true);
    expect(isReviewRuntimeMethod("unknown")).toBe(false);
    expect(isReviewRuntimeMethod(1)).toBe(false);
  });

  it("recognizes opaque review panel keys without accepting arbitrary strings", () => {
    expect(isReviewPanelKey("opaque-panel-key")).toBe(true);
    expect(isReviewPanelKey("short")).toBe(false);
    expect(isReviewPanelKey("unsafe/panel/key")).toBe(false);
    expect(isReviewPanelKey(undefined)).toBe(false);
  });
});
