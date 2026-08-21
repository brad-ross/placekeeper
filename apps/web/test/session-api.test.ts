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

  it("returns validated recovery choices and sends the selected decision", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        kind: "recovery-offered",
        choices: ["resume", "invalid", "fork"],
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        kind: "opened",
        url: "http://127.0.0.1:43179/s/session/bootstrap#cap=token",
      }));
    vi.stubGlobal("fetch", fetch);

    await expect(reopenProductionSession(viewId, "placekeeper:///tmp/Paper.pdf#v=1&page=3"))
      .resolves.toEqual({ kind: "recovery-offered", choices: ["resume", "fork"] });
    await expect(reopenProductionSession(
      viewId,
      "placekeeper:///tmp/Paper.pdf#v=1&page=3",
      { confirmed: true, recovery: "resume" },
    )).resolves.toEqual({
      kind: "opened",
      url: "http://127.0.0.1:43179/s/session/bootstrap#cap=token",
    });
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({
      link: "placekeeper:///tmp/Paper.pdf#v=1&page=3",
      confirmed: true,
      recovery: "resume",
    });
    expect(fetch).toHaveBeenCalledWith(`/r/${viewId}/reopen`, expect.any(Object));
  });

  it("rejects malformed and non-loopback reopen responses", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, kind: "recovery-offered", choices: [] }))
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
});
