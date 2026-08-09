import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createReviewState } from "../../../packages/core/src/review-model.js";
import { FinishReviewDrawer } from "../src/app/FinishReviewDrawer.js";

const reviewedState = {
  ...createReviewState({
    sessionId: "00000000-0000-4000-8000-000000000101",
    source: { fileId: "paper", digest: "a".repeat(64), byteLength: 10 },
  }),
  revision: 3,
  items: [{
    id: "00000000-0000-4000-8000-000000000102",
    kind: "pageNote" as const,
    pageIndex: 0,
    createdAt: "2026-08-08T12:00:00.000Z",
    updatedAt: "2026-08-08T12:00:00.000Z",
    payload: { position: { x: 1, y: 1, width: 10, height: 10 }, comment: "Review" },
  }],
};

describe("FinishReviewDrawer", () => {
  it("is a labelled nonmodal overlay with a concise review summary and lifecycle actions", () => {
    const html = renderToStaticMarkup(
      <FinishReviewDrawer
        state={reviewedState}
        open
        onClose={vi.fn()}
        onFinish={vi.fn()}
        onDiscard={vi.fn()}
      >
        <div>Reviewed PDF and Codex handoff paths</div>
      </FinishReviewDrawer>,
    );

    expect(html).toContain('data-review-finish-slot');
    expect(html).toContain('aria-labelledby="finish-review-heading"');
    expect(html).not.toContain('aria-modal="true"');
    expect(html).toContain("1 review item");
    expect(html).toContain("Revision 3");
    expect(html).toContain("Reviewed PDF and Codex handoff paths");
    expect(html).toContain("Close finish options");
    expect(html).toContain('class="lucide lucide-x review-icon"');
    expect(html).not.toContain("×");
    expect(html).toContain('data-lifecycle-state="idle"');
    expect(html).toContain('review-button review-button--primary');
    expect(html).toContain('review-button review-button--destructive');
    expect(html).toContain("Finish review");
    expect(html).toContain("Discard review");
  });

  it("stays mounted but becomes hidden and inert when closed", () => {
    const html = renderToStaticMarkup(
      <FinishReviewDrawer
        state={reviewedState}
        open={false}
        onClose={vi.fn()}
        onFinish={vi.fn()}
        onDiscard={vi.fn()}
      >
        <div>Persistent delivery state</div>
      </FinishReviewDrawer>,
    );

    expect(html).toContain('data-surface-open="false"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("inert");
    expect(html).toContain("Persistent delivery state");
  });
});
