import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CodexDelivery, scopeConfirmationRequired } from "../src/export/CodexDelivery.js";
import { createReviewState } from "../../../packages/core/src/review-model.js";

const state = {
  ...createReviewState({ sessionId: "00000000-0000-4000-8000-000000000099", source: { fileId: "file", digest: "a".repeat(64), byteLength: 10 } }),
  revision: 1,
  items: [{
    id: "00000000-0000-4000-8000-000000000001", kind: "pageNote" as const, pageIndex: 0,
    createdAt: "2026-08-07T12:00:00.000Z", updatedAt: "2026-08-07T12:00:00.000Z",
    payload: { position: { x: 1, y: 1, width: 10, height: 10 }, comment: "Review" },
  }],
};

describe("Codex delivery UI", () => {
  it("renders a local data-flow summary and one Setup action without creating a task", () => {
    const html = renderToStaticMarkup(<CodexDelivery
      state={state}
      sourceRoot="/tmp/source"
      provider="Codex"
      revisedPdfDestination="/tmp/result/paper-revised.pdf"
      retention="Keep until I delete it"
      confirmedScopeSignature={null}
      onConfirmScope={() => undefined}
      onPrepare={async () => ({ prompt: "instruction", handoffPath: "/tmp/result/handoff.json", handoffSha256: "b".repeat(64), reviewedPdfPath: "/tmp/paper-reviewed.pdf", reviewedPdfSha256: "c".repeat(64) })}
      onSaveInstruction={() => undefined}
      onCheckResult={async () => ({ status: "Complete", message: "Checked" })}
    />);
    expect(html).toContain("Setup");
    expect(html).toContain('data-delivery-phase="setup"');
    expect(html).toContain('data-review-status="phase"');
    expect(html).toContain('class="review-delivery__metadata"');
    expect(html).toContain('class="review-delivery__phase-panel" data-phase-panel="setup"');
    expect(html).toContain('class="lucide lucide-clipboard review-icon"');
    expect(html).toContain("Prepare Codex handoff");
    expect(html).toContain("automatically saved PDF remains separate");
    expect(html).toContain("read containment depends on the external Codex sandbox");
    expect(html).not.toContain("Submit task");
  });

  it("requires confirmation only on first use or when a scope field changes", () => {
    const scope = { sourceRoot: "/tmp/source", provider: "Codex", revisedPdfDestination: "/tmp/result/paper.pdf", retention: "Keep" };
    const signature = JSON.stringify(scope);
    expect(scopeConfirmationRequired(null, scope)).toBe(true);
    expect(scopeConfirmationRequired(signature, scope)).toBe(false);
    expect(scopeConfirmationRequired(signature, { ...scope, retention: "Delete after check" })).toBe(true);
  });
});
