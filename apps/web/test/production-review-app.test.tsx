import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createReviewState } from "../../../packages/core/src/review-model.js";
import { ProductionReviewApp } from "../src/app/ProductionReviewApp.js";

describe("one production review tree", () => {
  it("makes viewer, automatic save identity, review commands, and Codex reachable together", () => {
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
        command: vi.fn(),
        saveStatus: vi.fn(), saveProposal: vi.fn(), chooseCopy: vi.fn(),
        chooseFolder: vi.fn(), chooseOriginal: vi.fn(), retrySave: vi.fn(), locateSave: vi.fn(),
        prepareCodex: vi.fn(), saveInstruction: vi.fn(), checkCodex: vi.fn(),
      }}
      viewer={<div role="application">Real shared PDF viewer</div>}
    />);
    expect(html).toContain("Real shared PDF viewer");
    expect(html).toContain("aria-label=\"Actions\"");
    expect(html).toContain('aria-label="Back in document history"');
    expect(html).toContain('aria-label="Forward in document history"');
    expect(html).toContain('aria-label="Undo"');
    expect(html).toContain('aria-label="Redo"');
    expect(html).toContain("Save options for paper.pdf");
    expect(html).toContain("Not saved");
    expect(html).toContain("Codex delivery");
    expect(html).toContain('data-delivery-kind="codex"');
    expect(html).toContain('data-review-status="phase"');
    expect(html).toContain("Optional handoff");
    expect(html).toContain("1 annotation");
    expect(html).toContain("Codex handoff");
    expect(html).toContain("Close Codex options");
    expect(html).toContain("Work with Codex");
    expect(html).not.toContain("Finish review");
    expect(html).not.toContain("Discard review");
    expect(html).not.toContain("Human delivery");
    expect(html).toContain('data-annotation-drawer');
    expect(html).toContain('Existing annotations are loading');
    expect(html).toContain("data-surface-open=\"false\"");
    expect(html).toContain('data-reference-layout="wide-closed"');
    expect(html).toContain('data-workspace-edge-rail="right"');
    expect(html).toContain('data-workspace-edge-rail="bottom"');
    expect(html).not.toContain('>Workspace</button>');
    expect(html).not.toContain("delivery-layout");
    expect(html.match(/Real shared PDF viewer/g)).toHaveLength(1);
    expect(html).not.toContain("Submit task");
    expect(html).not.toContain('aria-modal="true" aria-labelledby="finish-review-heading"');
  });
});
