import { afterEach, describe, expect, it, vi } from "vitest";

import { reopenProductionSession } from "../src/app/session-api.js";

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
