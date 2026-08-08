import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createReviewState } from "../../../packages/core/src/review-model.js";
import { ProductionReviewApp } from "../src/app/ProductionReviewApp.js";

describe("one production review tree", () => {
  it("makes viewer, review commands, Human delivery, and Codex delivery reachable together", () => {
    const state = {
      ...createReviewState({
        sessionId: "00000000-0000-4000-8000-000000000001",
        source: { fileId: "00000000-0000-4000-8000-000000000002", digest: "a".repeat(64), byteLength: 12 },
        sourceRootId: "00000000-0000-4000-8000-000000000003",
      }),
      revision: 1,
      items: [{
        id: "00000000-0000-4000-8000-000000000004", kind: "pageNote" as const, pageIndex: 0,
        createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z",
        payload: { position: { x: 1, y: 2, width: 3, height: 4 }, comment: "Fix" },
      }],
    };
    const html = renderToStaticMarkup(<ProductionReviewApp
      session={{ sessionId: state.sessionId, credential: "secret" }}
      initialState={state}
      scope={{ documentTitle: "paper.pdf", sourceRootPath: "/tmp/source" }}
      api={{
        command: vi.fn(), saveReviewedCopy: vi.fn(), replaceOriginal: vi.fn(),
        prepareCodex: vi.fn(), saveInstruction: vi.fn(), checkCodex: vi.fn(),
        finish: vi.fn(), discard: vi.fn(),
      }}
      viewer={<div role="application">Real shared PDF viewer</div>}
    />);
    expect(html).toContain("Real shared PDF viewer");
    expect(html).toContain("aria-label=\"Review views\"");
    expect(html).toContain("Human delivery");
    expect(html).toContain("Codex delivery");
    expect(html).toContain("Review summary");
    expect(html).toContain("1 review item");
    expect(html).toContain("Reviewed PDF");
    expect(html).toContain("Codex handoff");
    expect(html).toContain("Close finish options");
    expect(html).toContain("Finish review");
    expect(html).toContain("Discard review");
    expect(html).toContain("data-review-finish-slot");
    expect(html).toContain('data-annotation-drawer');
    expect(html).toContain('Existing annotations are loading');
    expect(html).toContain("data-surface-open=\"false\"");
    expect(html).not.toContain("delivery-layout");
    expect(html.match(/Real shared PDF viewer/g)).toHaveLength(1);
    expect(html).not.toContain("Submit task");
    expect(html).not.toContain('aria-modal="true" aria-labelledby="finish-review-heading"');
  });
});
