import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RestartReconnectStore } from "../src/context/restart-reconnect-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-reconnect-"));
  roots.push(root);
  let now = 1_000;
  const store = new RestartReconnectStore(join(root, "tickets"), {
    now: () => new Date(now),
    ttlMs: 100,
  });
  await store.initialize();
  return {
    store,
    advance(milliseconds: number) { now += milliseconds; },
  };
}

const ticket = {
  taskSessionId: "task-a",
  reviewSessionId: "review-a",
  browserToken: "browser-secret-a",
  canonicalSourcePath: "/private/tmp/paper.pdf",
  sourceDigest: "a".repeat(64),
};

describe("restart reconnect tickets", () => {
  it("requires both the browser secret and task identity, then consumes once", async () => {
    const { store } = await fixture();
    await store.issue(ticket);

    await expect(store.matchBrowser({
      browserToken: "wrong-browser-secret",
      canonicalSourcePath: ticket.canonicalSourcePath,
      sourceDigest: ticket.sourceDigest,
    })).resolves.toBeUndefined();
    const matched = await store.matchBrowser({
      browserToken: ticket.browserToken,
      canonicalSourcePath: ticket.canonicalSourcePath,
      sourceDigest: ticket.sourceDigest,
    });
    expect(matched).toBeDefined();
    expect(store.matchesTask(matched!, "task-b")).toBe(false);
    expect(store.matchesTask(matched!, ticket.taskSessionId)).toBe(true);

    await expect(store.consumeForTask(matched!, ticket.taskSessionId)).resolves.toBe(true);
    await expect(store.matchBrowser({
      browserToken: ticket.browserToken,
      canonicalSourcePath: ticket.canonicalSourcePath,
      sourceDigest: ticket.sourceDigest,
    })).resolves.toBeUndefined();
  });

  it("fails closed for another document, expiry, and task revocation", async () => {
    const { store, advance } = await fixture();
    await store.issue(ticket);
    await expect(store.matchBrowser({
      browserToken: ticket.browserToken,
      canonicalSourcePath: "/private/tmp/other.pdf",
      sourceDigest: ticket.sourceDigest,
    })).resolves.toBeUndefined();
    await expect(store.matchBrowser({
      browserToken: ticket.browserToken,
      canonicalSourcePath: ticket.canonicalSourcePath,
      sourceDigest: "b".repeat(64),
    })).resolves.toBeUndefined();

    await store.revokeTask(ticket.taskSessionId);
    await expect(store.matchBrowser({
      browserToken: ticket.browserToken,
      canonicalSourcePath: ticket.canonicalSourcePath,
      sourceDigest: ticket.sourceDigest,
    })).resolves.toBeUndefined();

    await store.issue(ticket);
    advance(100);
    await expect(store.matchBrowser({
      browserToken: ticket.browserToken,
      canonicalSourcePath: ticket.canonicalSourcePath,
      sourceDigest: ticket.sourceDigest,
    })).resolves.toBeUndefined();
  });

  it("renews the active ticket and replaces older tickets for the same task", async () => {
    const { store, advance } = await fixture();
    await store.issue(ticket);
    advance(75);
    await store.issue(ticket);
    advance(75);
    await expect(store.matchBrowser({
      browserToken: ticket.browserToken,
      canonicalSourcePath: ticket.canonicalSourcePath,
      sourceDigest: ticket.sourceDigest,
    })).resolves.toBeDefined();

    await store.issue({ ...ticket, browserToken: "browser-secret-b" });
    await expect(store.matchBrowser({
      browserToken: ticket.browserToken,
      canonicalSourcePath: ticket.canonicalSourcePath,
      sourceDigest: ticket.sourceDigest,
    })).resolves.toBeUndefined();
  });

  it("avoids rewriting an unchanged ticket until its renewal window", async () => {
    const { store, advance } = await fixture();
    await store.issue(ticket);
    const initial = await store.matchBrowser({
      browserToken: ticket.browserToken,
      canonicalSourcePath: ticket.canonicalSourcePath,
      sourceDigest: ticket.sourceDigest,
    });
    advance(25);
    await store.issue(ticket);
    const stillFresh = await store.matchBrowser({
      browserToken: ticket.browserToken,
      canonicalSourcePath: ticket.canonicalSourcePath,
      sourceDigest: ticket.sourceDigest,
    });
    expect(stillFresh?.expiresAtMs).toBe(initial?.expiresAtMs);

    advance(30);
    await store.issue(ticket);
    const renewed = await store.matchBrowser({
      browserToken: ticket.browserToken,
      canonicalSourcePath: ticket.canonicalSourcePath,
      sourceDigest: ticket.sourceDigest,
    });
    expect(renewed!.expiresAtMs).toBeGreaterThan(stillFresh!.expiresAtMs);
  });

  it("does not consume a revoked, replaced, or already consumed staged ticket", async () => {
    const { store, advance } = await fixture();
    await store.issue(ticket);
    const staged = await store.matchBrowser({
      browserToken: ticket.browserToken,
      canonicalSourcePath: ticket.canonicalSourcePath,
      sourceDigest: ticket.sourceDigest,
    });
    expect(staged).toBeDefined();
    await store.revokeTask(ticket.taskSessionId);
    await expect(store.consumeForTask(staged!, ticket.taskSessionId)).resolves.toBe(false);

    await store.issue(ticket);
    const first = await store.matchBrowser({
      browserToken: ticket.browserToken,
      canonicalSourcePath: ticket.canonicalSourcePath,
      sourceDigest: ticket.sourceDigest,
    });
    await expect(store.consumeForTask(first!, ticket.taskSessionId)).resolves.toBe(true);
    await expect(store.consumeForTask(first!, ticket.taskSessionId)).resolves.toBe(false);

    await store.issue(ticket);
    const replacementCandidate = await store.matchBrowser({
      browserToken: ticket.browserToken,
      canonicalSourcePath: ticket.canonicalSourcePath,
      sourceDigest: ticket.sourceDigest,
    });
    advance(75);
    await store.issue(ticket);
    await expect(store.consumeForTask(replacementCandidate!, ticket.taskSessionId)).resolves.toBe(false);
  });
});
