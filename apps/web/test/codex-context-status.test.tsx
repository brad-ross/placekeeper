import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CodexContextStatus } from "../src/review/CodexContextStatus.js";

describe("Codex live context status", () => {
  it("renders a quiet current state only from verified context", () => {
    const html = renderToStaticMarkup(<CodexContextStatus status={{
      status: "current",
      identity: {
        proofreaderSessionId: "review-a",
        documentGeneration: 1,
        source: { fileId: "file-a", digest: "a".repeat(64), byteLength: 12 },
        reviewRevision: 3,
        stateDigest: "b".repeat(64),
      },
      leaseExpiresAt: "2026-08-12T12:00:00.000Z",
    }} />);

    expect(html).toContain('data-codex-context="current"');
    expect(html).toContain("Context current");
    expect(html).not.toContain('aria-live="polite"');
    expect(html).not.toContain("reopen");
  });

  it.each([
    { status: "pending" as const, proofreaderSessionId: "review-a", documentGeneration: 1, expiresAt: "2026-08-12T12:00:00.000Z" },
    { status: "refreshing" as const, proofreaderSessionId: "review-a", documentGeneration: 1 },
  ])("announces connecting state atomically", (status) => {
    const html = renderToStaticMarkup(<CodexContextStatus status={status} />);
    expect(html).toContain('data-codex-context="connecting"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain("Context connecting");
  });

  it.each([
    { status: "unbound" as const },
    { status: "unavailable" as const, reason: "expired" as const },
  ])("fails closed with recovery guidance", (status) => {
    const html = renderToStaticMarkup(<CodexContextStatus status={status} />);
    expect(html).toContain('data-codex-context="unavailable"');
    expect(html).toContain("Live PDF context is unavailable");
    expect(html).toContain("Ask Codex to reopen this PDF");
    expect(html).not.toContain("button");
  });
});
