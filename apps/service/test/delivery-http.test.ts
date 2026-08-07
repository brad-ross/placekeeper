import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionDeliveryActions } from "../src/server/http-server.js";
import { startHttpServer, type LocalHttpServer } from "../src/server/http-server.js";
import { SessionBroker } from "../src/sessions/session-broker.js";

const roots: string[] = [];
const servers: LocalHttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function authenticatedFixture(delivery: SessionDeliveryActions) {
  const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-delivery-http-"));
  roots.push(root);
  const pdf = join(root, "paper.pdf");
  await writeFile(pdf, "%PDF-1.7\nfixture\n%%EOF");
  const broker = new SessionBroker({ recoveryRoot: join(root, "recovery") });
  const opened = await broker.openReview({ pdfPath: pdf });
  if (opened.kind !== "opened") throw new Error("Expected opened review");
  const server = await startHttpServer(broker, { delivery });
  servers.push(server);
  const capability = opened.launch.fragment.slice("#cap=".length);
  const exchange = await fetch(`${server.origin}/s/${opened.launch.sessionId}/exchange`, {
    method: "POST",
    headers: { origin: server.origin, "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ capability }),
  });
  const { credential } = await exchange.json() as { credential: string };
  return { server, sessionId: opened.launch.sessionId, credential };
}

function actions(): SessionDeliveryActions {
  return {
    saveReviewedCopy: vi.fn(async () => ({ path: "/tmp/reviewed.pdf" })),
    replaceOriginal: vi.fn(async () => ({ path: "/tmp/paper.pdf", warning: "Reopen" })),
    prepareCodex: vi.fn(async () => ({
      receiptId: "receipt-a", prompt: "Prompt", handoffPath: "/tmp/handoff.json",
      handoffSha256: "a".repeat(64), reviewedPdfPath: "/tmp/reviewed.pdf",
      reviewedPdfSha256: "b".repeat(64), resultDirectory: "/tmp/result",
    })),
    saveInstruction: vi.fn(async () => "/tmp/result/codex-instruction.txt"),
    checkCodex: vi.fn(async () => ({ status: "Partial" as const, message: "Build failed" })),
  };
}

describe("authenticated production delivery routes", () => {
  it("reaches Human and Codex projections through the same scoped session", async () => {
    const delivery = actions();
    const { server, sessionId, credential } = await authenticatedFixture(delivery);
    const post = (suffix: string, body: unknown, auth = true) => fetch(
      `${server.origin}/s/${sessionId}/delivery/${suffix}`,
      {
        method: "POST",
        headers: {
          ...(auth ? { authorization: `Bearer ${credential}` } : {}),
          origin: server.origin,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify(body),
      },
    );

    expect((await post("human/save", {}, false)).status).toBe(401);
    expect(await (await post("human/save", {})).json()).toEqual({ path: "/tmp/reviewed.pdf" });
    expect(await (await post("human/replace", {})).json()).toEqual({ path: "/tmp/paper.pdf", warning: "Reopen" });
    const prepared = await (await post("codex/prepare", {})).json() as { receiptId: string };
    expect(prepared.receiptId).toBe("receipt-a");
    expect(await (await post("codex/instruction", { receiptId: "receipt-a" })).json())
      .toEqual({ path: "/tmp/result/codex-instruction.txt" });
    expect(await (await post("codex/result", {
      receiptId: "receipt-a", dispositionText: "{}\n", revisedPdfSelected: false,
    })).json()).toEqual({ status: "Partial", message: "Build failed" });
    expect(delivery.checkCodex).toHaveBeenCalledWith(sessionId, {
      receiptId: "receipt-a", dispositionText: "{}\n", revisedPdfSelected: false,
    });
  });
});
