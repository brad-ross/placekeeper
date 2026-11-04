import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { RestartReconnectStore } from "../src/context/restart-reconnect-store.js";
import { establishPrivateDirectory, verifyPrivatePath } from "../src/platform/private-storage.js";
import { closeWindowsNativeWorker } from "../src/platform/windows-native-worker.js";
import { digestSecretHex } from "../../../packages/core/src/session-security.js";
import * as publication from "../src/platform/file-publication.js";

const roots: string[] = [];
afterAll(() => closeWindowsNativeWorker());

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-reconnect-"));
  roots.push(root);
  await establishPrivateDirectory(root);
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

describe("native reconnect ticket purpose and peer scope", () => {
  it("durably reopens private tickets with idempotent issuance and preserves native scope through rejection and one-shot consumption", async () => {
    const { store, advance } = await fixture();
    const native = { runtimeId: "runtime_a", attemptId: "attempt_a", documentGeneration: 3 };
    const issued = { ...ticket, browserToken: "native-persisted", native };
    await store.issue(issued);
    const path = join(store.directory, `${digestSecretHex(issued.browserToken)}.json`);
    await verifyPrivatePath(path, "file");
    const bytes = await readFile(path);
    const restarted = new RestartReconnectStore(store.directory, { now: () => new Date(1_000), ttlMs: 100 });
    await restarted.initialize();
    await restarted.issue(issued);
    expect(await readFile(path)).toEqual(bytes);
    const matched = await restarted.matchNative({ ...native, ticket: issued.browserToken });
    expect(matched).toMatchObject({ native, sourceDigest: ticket.sourceDigest });
    for (const wrong of [
      { ...native, runtimeId: "other-runtime" },
      { ...native, attemptId: "other-attempt" },
      { ...native, documentGeneration: 4 },
    ]) {
      expect(await restarted.matchNative({ ...wrong, ticket: issued.browserToken })).toBeUndefined();
    }
    expect(await restarted.matchNative({ ...native, ticket: "other-ticket" })).toBeUndefined();
    expect(await restarted.consumeForTask(matched!, "other-task")).toBe(false);
    expect(await readFile(path)).toEqual(bytes);
    expect(await restarted.consumeForTask(matched!, ticket.taskSessionId)).toBe(true);
    expect(await restarted.consumeForTask(matched!, ticket.taskSessionId)).toBe(false);
    expect(await restarted.matchNative({ ...native, ticket: issued.browserToken })).toBeUndefined();
    await store.issue(issued);
    const staged = await store.matchNative({ ...native, ticket: issued.browserToken });
    advance(100);
    expect(await store.matchNative({ ...native, ticket: issued.browserToken })).toBeUndefined();
    expect(await store.consumeForTask(staged!, ticket.taskSessionId)).toBe(false);
    await store.initialize();
    expect(await readdir(store.directory)).toEqual([]);
  });

  it("cleans failed publication staging, preserves a peer ticket and recovers the serialized writer for retry", async () => {
    const { store } = await fixture();
    await store.issue(ticket);
    const originalPath = join(store.directory, `${digestSecretHex(ticket.browserToken)}.json`);
    const original = await readFile(originalPath);
    const blocked = { ...ticket, browserToken: "blocked-ticket", native: { runtimeId: "runtime", attemptId: "attempt", documentGeneration: 1 } };
    const blockedPath = join(store.directory, `${digestSecretHex(blocked.browserToken)}.json`);
    // Establish the collision after the ticket lookup, immediately before the
    // actual OS publication. The real native publisher must reject it.
    const publish = publication.publishFile;
    const racingPublication = vi.spyOn(publication, "publishFile").mockImplementationOnce(async (candidate, target, options) => {
      await mkdir(target);
      return publish(candidate, target, options);
    });
    await expect(store.issue(blocked)).rejects.toThrow();
    expect(racingPublication).toHaveBeenCalledOnce();
    racingPublication.mockRestore();
    expect(await readFile(originalPath)).toEqual(original);
    expect((await readdir(store.directory)).filter(name => name.endsWith(".tmp"))).toEqual([]);
    await rm(blockedPath, { recursive: true });
    await store.issue(blocked);
    await verifyPrivatePath(blockedPath, "file");
    expect(await store.matchNative({ ...blocked.native, ticket: blocked.browserToken })).toBeDefined();
    expect(await store.matchBrowser(ticket)).toBeDefined();
  });

  it("retains both native peer tickets while preserving browser single-ticket replacement", async () => {
    const { store } = await fixture();
    const native = { runtimeId: "runtime_a", attemptId: "attempt_a", documentGeneration: 1 };
    await store.issue({ ...ticket, browserToken: "native-a", native });
    await store.issue({ ...ticket, browserToken: "native-b", native: { ...native, runtimeId: "runtime_b" } });
    await store.issue(ticket);
    await store.issue({ ...ticket, browserToken: "browser-b" });
    expect(await store.matchBrowser(ticket)).toBeUndefined();
    expect(await store.matchBrowser({ ...ticket, browserToken: "native-a" })).toBeUndefined();
    const first = await store.matchNative({ ...native, ticket: "native-a" });
    const second = await store.matchNative({ ...native, runtimeId: "runtime_b", ticket: "native-b" });
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(await store.matchNative({ ...native, attemptId: "wrong_attempt", ticket: "native-a" })).toBeUndefined();
    expect(await store.matchNative({ ...native, documentGeneration: 2, ticket: "native-a" })).toBeUndefined();
    await store.revokeSession(ticket.reviewSessionId);
    expect(await store.consumeForTask(first!, ticket.taskSessionId)).toBe(false);
    expect(await store.consumeForTask(second!, ticket.taskSessionId)).toBe(false);
  });

  it("prunes expired native ticket files while retaining live peer tickets", async () => {
    const { store, advance } = await fixture();
    const native = { runtimeId: "runtime_a", attemptId: "attempt_a", documentGeneration: 1 };
    await store.issue({ ...ticket, browserToken: "expired-native", native });
    advance(100);
    await store.issue({ ...ticket, browserToken: "live-native", native: { ...native, runtimeId: "runtime_b" } });
    expect((await readdir(store.directory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });
});
