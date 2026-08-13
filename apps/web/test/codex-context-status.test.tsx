import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CodexContextStatus } from "../src/review/CodexContextStatus.js";

describe("Codex live context status", () => {
  it("renders a quiet current state only from verified context", () => {
    const html = renderToStaticMarkup(<CodexContextStatus status={{
      status: "current",
      identity: {
        placekeeperSessionId: "review-a",
        documentGeneration: 1,
        source: { fileId: "file-a", digest: "a".repeat(64), byteLength: 12 },
        reviewRevision: 3,
        stateDigest: "b".repeat(64),
      },
      leaseExpiresAt: "2026-08-12T12:00:00.000Z",
    }} />);

    expect(html).toContain('data-codex-context="current"');
    expect(html).toContain('aria-label="Agent context current at review revision 3"');
    expect(html).toContain("lucide-bot");
    expect(html).toContain("PDF content and annotations are synced with the connected agent");
    expect(html).not.toContain("Codex");
    expect(html).not.toContain('aria-live="polite"');
    expect(html).not.toContain("reopen");
  });

  it("uses the same robot with an amber updating state", () => {
    const html = renderToStaticMarkup(<CodexContextStatus status={{
      status: "refreshing",
      placekeeperSessionId: "review-a",
      documentGeneration: 1,
    }} />);

    expect(html).toContain('data-codex-context="connecting"');
    expect(html).toContain("codex-context-status--connecting");
    expect(html).toContain("lucide-bot");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain("Agent context updating");
    expect(html).toContain("Syncing your latest annotation changes with the connected agent");
    expect(html).not.toContain("Codex");
  });

  it.each([
    { status: "unbound" as const },
    { status: "unavailable" as const, reason: "expired" as const },
  ])("fails closed with recovery guidance", (status) => {
    const html = renderToStaticMarkup(<CodexContextStatus status={status} />);
    expect(html).toContain('data-codex-context="unavailable"');
    expect(html).toContain("codex-context-status--unavailable");
    expect(html).toContain("lucide-bot");
    expect(html).toContain("Agent context unavailable");
    expect(html).toContain("Reopen this PDF from your agent");
    expect(html).not.toContain("Codex");
    expect(html).not.toContain("button");
  });
});
