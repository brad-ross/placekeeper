import { afterEach, describe, expect, it, vi } from "vitest";

import { createReviewState } from "../../../packages/core/src/review-model.js";
import { loadProductionSession, reopenProductionSession } from "../src/app/session-api.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stale production-session reopen", () => {
  const viewId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("returns an exact recovery offer and sends the bound selected decision", async () => {
    vi.stubGlobal("location", new URL("http://127.0.0.1:43179/r/stale/Paper.pdf"));
    const recoveryOffer = {
      id: "opaque_recovery_offer_1234",
      expiresAt: "2026-08-21T20:00:00.000Z",
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        kind: "recovery-offered",
        choices: ["fork", "resume", "discard"],
        recoveryOffer,
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        kind: "opened",
        url: "http://127.0.0.1:43179/s/session/bootstrap#cap=token",
      }));
    vi.stubGlobal("fetch", fetch);

    await expect(reopenProductionSession(viewId, "placekeeper:///tmp/Paper.pdf#v=1&page=3"))
      .resolves.toEqual({
        kind: "recovery-offered",
        choices: ["resume", "discard", "fork"],
        recoveryOffer,
      });
    await expect(reopenProductionSession(
      viewId,
      "placekeeper:///tmp/Paper.pdf#v=1&page=3",
      {
        confirmed: true,
        recovery: "resume",
        recoveryOffer,
        recoveryOperationId: "operation_1234567890",
      },
    )).resolves.toEqual({
      kind: "opened",
      url: "http://127.0.0.1:43179/s/session/bootstrap#cap=token",
    });
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({
      link: "placekeeper:///tmp/Paper.pdf#v=1&page=3",
      confirmed: true,
      recovery: "resume",
      recoveryOffer,
      recoveryOperationId: "operation_1234567890",
    });
    expect(fetch).toHaveBeenCalledWith(`/r/${viewId}/reopen`, expect.any(Object));
  });

  it("rejects malformed and non-loopback reopen responses", async () => {
    vi.stubGlobal("location", new URL("http://127.0.0.1:43179/r/stale/Paper.pdf"));
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        kind: "recovery-offered",
        choices: ["resume", "invalid", "fork"],
        recoveryOffer: {
          id: "opaque_recovery_offer_1234",
          expiresAt: "2026-08-21T20:00:00.000Z",
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        kind: "opened",
        url: "https://example.com/s/session/bootstrap#cap=token",
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: false }, 409));
    vi.stubGlobal("fetch", fetch);

    await expect(reopenProductionSession(viewId, "placekeeper:///tmp/Paper.pdf#v=1&page=1"))
      .rejects.toThrow("could not be reopened");
    await expect(reopenProductionSession(viewId, "placekeeper:///tmp/Paper.pdf#v=1&page=1"))
      .rejects.toThrow("reopen address is invalid");
    await expect(reopenProductionSession(viewId, "placekeeper:///tmp/Paper.pdf#v=1&page=1"))
      .rejects.toThrow("reopen request was rejected");
  });

  it("returns a typed refresh result for a stale recovery offer", async () => {
    vi.stubGlobal("location", new URL("http://127.0.0.1:43179/r/stale/Paper.pdf"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      ok: false,
      error: { kind: "recovery-offer-unavailable" },
    }, 409)));

    await expect(reopenProductionSession(
      viewId,
      "placekeeper:///tmp/Paper.pdf#v=1&page=1",
    )).resolves.toEqual({ kind: "recovery-refresh-required" });
  });

  it.each([
    ["alternate port", "http://127.0.0.1:43180/s/session/bootstrap#cap=token"],
    ["localhost alias", "http://localhost:43179/s/session/bootstrap#cap=token"],
    ["credentials", "http://user@127.0.0.1:43179/s/session/bootstrap#cap=token"],
    ["query", "http://127.0.0.1:43179/s/session/bootstrap?x=1#cap=token"],
    ["noncanonical path", "http://127.0.0.1:43179/s/session/other#cap=token"],
    ["normalized path", "http://127.0.0.1:43179/s/other/../session/bootstrap#cap=token"],
    ["multiple fragment fields", "http://127.0.0.1:43179/s/session/bootstrap#cap=token&cap=other"],
  ])("rejects a bootstrap URL with %s", async (_label, url) => {
    vi.stubGlobal("location", new URL("http://127.0.0.1:43179/r/stale/Paper.pdf"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      kind: "opened",
      url,
    })));

    await expect(reopenProductionSession(
      viewId,
      "placekeeper:///tmp/Paper.pdf#v=1&page=1",
    )).rejects.toThrow("reopen address is invalid");
  });
});

describe("production review commands", () => {
  it("surfaces an actionable invalid-command response without advancing local state", async () => {
    const state = createReviewState({
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      source: { fileId: "source", digest: "a".repeat(64), byteLength: 100 },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith("/state")) return jsonResponse(state);
      if (path.endsWith("/scope")) return jsonResponse({ documentTitle: "Paper.pdf" });
      if (path.endsWith("/save/status")) {
        return jsonResponse({
          destination: { phase: "none", generation: 0 },
          sync: {
            phase: "clean",
            desiredRevision: 0,
            desiredDigest: "b".repeat(64),
            savedRevision: 0,
            savedDigest: "b".repeat(64),
          },
        });
      }
      if (path.endsWith("/commands")) {
        return jsonResponse({
          ok: false,
          error: {
            kind: "invalid-review-command",
            message: "Selections can contain at most 256 text segments. Shorten the selection and try again.",
          },
        }, 422);
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    const loaded = await loadProductionSession({
      sessionId: state.sessionId,
      credential: "credential",
    });

    await expect(loaded.api.command({ type: "undo", expectedRevision: 0 })).resolves.toEqual({
      accepted: false,
      state,
      message: "Selections can contain at most 256 text segments. Shorten the selection and try again.",
      reason: "rejected",
    });
  });

  it("rehydrates a generation conflict without replaying the rejected mutation", async () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const predecessor = createReviewState({
      sessionId,
      source: { fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", digest: "a".repeat(64), byteLength: 10 },
      workflowMode: "generated-output",
      documentGeneration: 1,
    });
    const successor = {
      ...predecessor,
      source: { ...predecessor.source, digest: "b".repeat(64) },
      workflow: { ...predecessor.workflow, documentGeneration: 2 },
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith("/state")) {
        return jsonResponse(requests.filter(({ url: seen }) => seen.endsWith("/state")).length === 1
          ? predecessor
          : successor);
      }
      if (url.endsWith("/scope")) return jsonResponse({ documentTitle: "paper.pdf" });
      if (url.endsWith("/save/status")) {
        return jsonResponse({
          destination: { phase: "none", generation: 0 },
          sync: { phase: "clean", desiredRevision: 0, savedRevision: 0 },
        });
      }
      if (url.endsWith("/commands")) {
        return requests.filter(({ url: seen }) => seen.endsWith("/commands")).length === 1
          ? jsonResponse({ ok: false, error: { kind: "generation-conflict" } }, 409)
          : jsonResponse(successor);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const loaded = await loadProductionSession({ sessionId, credential: "memory-only" });
    const result = await loaded.api.command({ type: "undo", expectedRevision: 0 });
    expect(result).toMatchObject({
      accepted: false,
      state: { workflow: { documentGeneration: 2 } },
      reason: "generation-conflict",
    });
    const commandRequests = requests.filter(({ url }) => url.endsWith("/commands"));
    expect(commandRequests).toHaveLength(1);
    expect(commandRequests[0]?.init?.headers).toMatchObject({ "x-placekeeper-generation": "1" });
    await expect(loaded.api.command({ type: "undo", expectedRevision: 0 }))
      .resolves.toMatchObject({ workflow: { documentGeneration: 2 } });
    const retriedRequests = requests.filter(({ url }) => url.endsWith("/commands"));
    expect(retriedRequests).toHaveLength(2);
    expect(retriedRequests[1]?.init?.headers).toMatchObject({ "x-placekeeper-generation": "2" });
  });
});
