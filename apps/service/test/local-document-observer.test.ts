import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

import {
  LocalDocumentObserver,
  type LocalDocumentCandidate,
  type LocalDocumentWatch,
} from "../src/sessions/local-document-observer.js";
import { SessionBroker } from "../src/sessions/session-broker.js";

const temporaryDirectories: string[] = [];
const brokers: SessionBroker[] = [];

afterEach(async () => {
  vi.useRealTimers();
  try {
    await Promise.all(brokers.splice(0).map((broker) => broker.quiesceForShutdown()));
  } finally {
    vi.restoreAllMocks();
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  }
});

async function pdf(title: string): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.setTitle(title);
  document.addPage([320, 240]);
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "placekeeper-local-observer-"));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, "paper.pdf");
  await writeFile(sourcePath, "%PDF-1.7\noriginal");
  const watches: Array<EventEmitter & LocalDocumentWatch> = [];
  const candidates: LocalDocumentCandidate[] = [];
  const admitted: Array<Omit<LocalDocumentCandidate, "identity">> = [];
  const settled: Array<Omit<LocalDocumentCandidate, "identity">> = [];
  const observer = new LocalDocumentObserver({
    watchDirectory: () => {
      const watch = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() });
      watches.push(watch);
      return watch;
    },
    admitCandidate: (candidate) => admitted.push(candidate),
    settleUnchangedCandidate: (candidate) => settled.push(candidate),
    inspectCandidate: async (candidate) => {
      candidates.push(candidate);
      return { status: "current" };
    },
  });
  return { observer, sourcePath, watches, candidates, admitted, settled };
}

describe("local document observer", () => {
  it("detects generated and ordinary local replacements without a VS Code panel", async () => {
    const directory = await mkdtemp(join(tmpdir(), "placekeeper-service-observer-"));
    temporaryDirectories.push(directory);
    const ordinaryPath = join(directory, "ordinary.pdf");
    const generatedPath = join(directory, "generated.pdf");
    await Promise.all([writeFile(ordinaryPath, await pdf("ordinary-1")), writeFile(generatedPath, await pdf("generated-1"))]);
    const broker = new SessionBroker({
      recoveryRoot: join(directory, "recovery"),
      inspectGeneration: async () => ({ pageCount: 1, pages: [{ pageIndex: 0, text: "successor" }] }),
    });
    brokers.push(broker);
    const observed: Array<{ sessionId: string; changed: boolean }> = [];
    broker.onLocalDocumentObservation((event) => observed.push(event));
    const ordinary = await broker.openReview({ pdfPath: ordinaryPath, surface: "browser" });
    const generated = await broker.openReview({
      pdfPath: generatedPath,
      surface: "browser",
      workflowMode: "generated-output",
    });
    if (ordinary.kind !== "opened" || generated.kind !== "opened") throw new Error("Expected open reviews");
    await Promise.all([writeFile(ordinaryPath, await pdf("ordinary-2")), writeFile(generatedPath, await pdf("generated-2"))]);

    await vi.waitFor(() => {
      expect(observed.some((event) => event.sessionId === ordinary.launch.sessionId && event.changed)).toBe(true);
      expect(observed.some((event) => event.sessionId === generated.launch.sessionId && event.changed)).toBe(true);
      expect(broker.state(ordinary.launch.sessionId)?.workflow.documentGeneration).toBe(2);
      expect(broker.state(generated.launch.sessionId)?.workflow.documentGeneration).toBe(2);
    }, { timeout: 3_000 });
  });

  it("forces startup checks and filters directory events by exact basename", async () => {
    const value = await fixture();
    value.observer.observe({ sessionId: "ordinary", sourcePath: value.sourcePath });
    await value.observer.flush("ordinary");
    expect(value.candidates.map(({ reason }) => reason)).toEqual(["startup"]);

    value.watches[0]!.emit("change", "rename", "unrelated.pdf");
    await value.observer.flush("ordinary");
    expect(value.candidates).toHaveLength(1);

    value.watches[0]!.emit("change", "rename", basename(value.sourcePath));
    await value.observer.flush("ordinary");
    expect(value.candidates.at(-1)).toMatchObject({ sessionId: "ordinary", reason: "watcher" });
  });

  it("admits a matching filesystem observation before its debounce and staging work", async () => {
    vi.useFakeTimers();
    const value = await fixture();
    const admitted: LocalDocumentCandidate[] = [];
    const watch = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() });
    const observer = new LocalDocumentObserver({
      watchDirectory: () => watch,
      admitCandidate: (candidate) => admitted.push(candidate),
      inspectCandidate: async () => ({ status: "current" }),
    });
    observer.observe({ sessionId: "session", sourcePath: value.sourcePath });
    await observer.flush("session");
    admitted.length = 0;
    watch.emit("change", "rename", "paper.pdf");
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ sessionId: "session", reason: "watcher" });
    observer.dispose();
  });

  it("orders missing-name events and unrelated host counters with one service sequence", async () => {
    const value = await fixture();
    value.observer.observe({ sessionId: "generated", sourcePath: value.sourcePath });
    await value.observer.flush("generated");
    const firstHint = value.observer.hint("generated", { token: "host-a:9000000" });
    const secondHint = value.observer.hint("generated", { token: "host-b:1" });
    await Promise.all([firstHint, secondHint]);
    value.watches[0]!.emit("change", "rename", undefined);
    await value.observer.flush("generated");

    expect(value.candidates.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    expect(value.admitted.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
    expect(value.admitted.at(-1)?.reason).toBe("identity");
    expect(value.candidates.slice(1, 3).map(({ hostHintToken }) => hostHintToken))
      .toEqual(["host-a:9000000", "host-b:1"]);
  });

  it("discards a deferred watcher candidate after a newer direct hint", async () => {
    vi.useFakeTimers();
    const value = await fixture();
    value.observer.observe({ sessionId: "generated", sourcePath: value.sourcePath });
    await value.observer.flush("generated");

    value.watches[0]!.emit("change", "rename", basename(value.sourcePath));
    const hinted = value.observer.hint("generated", { token: "newest" });
    await hinted;
    expect(value.observer.isCurrent("generated", 3)).toBe(true);

    await value.observer.flush("generated");
    expect(value.observer.isCurrent("generated", 3)).toBe(true);
    expect(value.candidates.map(({ reason }) => reason)).toEqual(["startup", "host-hint"]);
    expect(value.candidates.at(-1)).toMatchObject({ sequence: 3, hostHintToken: "newest" });
  });

  it("does not let a redundant watcher delivery supersede an explicitly reserved identity", async () => {
    const value = await fixture();
    value.observer.observe({ sessionId: "ordinary", sourcePath: value.sourcePath });
    await value.observer.flush("ordinary");
    const reserved = await value.observer.reserveExplicitHint("ordinary");
    expect(reserved).toBe(2);

    value.watches[0]!.emit("change", "rename", basename(value.sourcePath));
    expect(value.admitted.at(-1)).toMatchObject({ reason: "watcher" });
    await vi.waitFor(() => expect(value.settled.at(-1)).toMatchObject({ reason: "watcher" }));
    await value.observer.flush("ordinary");
    expect(value.observer.isCurrent("ordinary", reserved!)).toBe(true);
    expect(value.settled.at(-1)).toMatchObject({ reason: "watcher" });
    expect(value.candidates.map(({ reason }) => reason)).toEqual(["startup"]);

    value.observer.completeExplicitHint("ordinary", reserved!);
    await writeFile(value.sourcePath, "%PDF-1.7\nnewer identity");
    value.watches[0]!.emit("change", "rename", basename(value.sourcePath));
    await vi.waitFor(() => expect(value.observer.isCurrent("ordinary", reserved!)).toBe(false));
    await value.observer.flush("ordinary");
    expect(value.candidates.at(-1)?.reason).toBe("watcher");
    expect(value.observer.isCurrent("ordinary", reserved!)).toBe(false);
  });

  it("settles flush after an explicit reservation covers a pending watcher", async () => {
    const value = await fixture();
    value.observer.observe({ sessionId: "ordinary", sourcePath: value.sourcePath });
    await value.observer.flush("ordinary");
    value.watches[0]!.emit("change", "rename", basename(value.sourcePath));
    const reserved = await value.observer.reserveExplicitHint("ordinary");
    await expect(value.observer.flush("ordinary")).resolves.toBeDefined();
    expect(value.observer.isCurrent("ordinary", reserved!)).toBe(true);
  });

  it("admits the explicit save barrier before identity inspection completes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "placekeeper-explicit-barrier-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "paper.pdf");
    await writeFile(sourcePath, "%PDF-1.7\noriginal");
    const identityGate = Promise.withResolvers<void>();
    let identityCalls = 0;
    const admitted: Array<Omit<LocalDocumentCandidate, "identity">> = [];
    let watch: (EventEmitter & LocalDocumentWatch) | undefined;
    const observer = new LocalDocumentObserver({
      watchDirectory: () => watch = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() }),
      inspectIdentity: async (path) => {
        identityCalls += 1;
        if (identityCalls > 1) await identityGate.promise;
        return lstat(path);
      },
      admitCandidate: (candidate) => admitted.push(candidate),
      inspectCandidate: async () => ({ status: "current" as const }),
    });
    observer.observe({ sessionId: "ordinary", sourcePath });
    await observer.flush("ordinary");
    admitted.length = 0;
    const reservation = observer.reserveExplicitHint("ordinary");
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ reason: "host-hint" });
    watch!.emit("change", "rename", basename(sourcePath));
    expect(admitted).toHaveLength(2);
    expect(admitted[1]).toMatchObject({ reason: "watcher" });
    identityGate.resolve();
    const sequence = await reservation;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await observer.flush("ordinary");
    expect(observer.isCurrent("ordinary", sequence!)).toBe(true);
    observer.dispose();
  });

  it("does not settle an identity shortcut while a watcher change remains unvalidated", async () => {
    vi.useFakeTimers();
    const value = await fixture();
    const settled: LocalDocumentCandidate[] = [];
    const inspected: LocalDocumentCandidate[] = [];
    const watch = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() });
    const observer = new LocalDocumentObserver({
      watchDirectory: () => watch,
      settleUnchangedCandidate: (candidate) => settled.push(candidate),
      inspectCandidate: async (candidate) => {
        inspected.push(candidate);
        return { status: "current" };
      },
    });
    observer.observe({ sessionId: "session", sourcePath: value.sourcePath });
    await observer.flush("session");

    watch.emit("change", "rename", basename(value.sourcePath));
    watch.emit("change", "rename", undefined);
    await observer.flush("session");

    expect(settled).toEqual([]);
    expect(inspected.map(({ reason }) => reason)).toEqual(["startup", "identity"]);
    observer.dispose();
  });

  it("coalesces rename/delete/recreate bursts and retries invalid candidates", async () => {
    vi.useFakeTimers();
    const value = await fixture();
    const inspect = vi.fn()
      .mockResolvedValueOnce({ status: "retry" })
      .mockResolvedValue({ status: "current" });
    const watch = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() });
    const observer = new LocalDocumentObserver({
      watchDirectory: () => watch,
      inspectCandidate: inspect,
    });
    observer.observe({ sessionId: "session", sourcePath: value.sourcePath });
    await observer.flush("session");
    expect(inspect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(inspect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await observer.flush("session");
    expect(inspect).toHaveBeenCalledTimes(2);
    observer.dispose();
  });

  it("bounds slow inspection to one active and one newest queued candidate per session", async () => {
    const value = await fixture();
    const first = Promise.withResolvers<{ readonly status: "current" }>();
    const inspected: LocalDocumentCandidate[] = [];
    const watch = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() });
    const observer = new LocalDocumentObserver({
      watchDirectory: () => watch,
      inspectCandidate: vi.fn(async (candidate: LocalDocumentCandidate) => {
        inspected.push(candidate);
        if (inspected.length === 1) return first.promise;
        return { status: "current" as const };
      }),
    });
    observer.observe({ sessionId: "session", sourcePath: value.sourcePath });
    const startup = observer.flush("session");
    await vi.waitFor(() => expect(inspected).toHaveLength(1));
    const hints = Array.from({ length: 100 }, (_, index) =>
      observer.hint("session", { token: `panel:${index}` }));
    expect(new Set(hints).size).toBe(1);
    expect(observer.isCurrent("session", 101)).toBe(true);
    first.resolve({ status: "current" });
    await Promise.all([startup, ...hints]);

    expect(inspected).toHaveLength(2);
    expect(inspected[1]).toMatchObject({ sequence: 101, hostHintToken: "panel:99" });
    observer.dispose();
  });

  it("checks metadata identity cheaply and audits unchanged identities at the bounded cadence", async () => {
    vi.useFakeTimers();
    const value = await fixture();
    value.observer.observe({ sessionId: "session", sourcePath: value.sourcePath });
    await value.observer.flush("session");
    expect(value.candidates).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await value.observer.flush("session");
    expect(value.candidates).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(55_000);
    await value.observer.flush("session");
    expect(value.candidates.at(-1)?.reason).toBe("audit");
  });

  it("settles an identical broker audit without staging or persisting the PDF again", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "placekeeper-broker-audit-"));
    temporaryDirectories.push(directory);
    const sourceDirectory = join(directory, "source");
    const recoveryDirectory = join(directory, "recovery");
    await Promise.all([mkdir(sourceDirectory), mkdir(recoveryDirectory)]);
    const sourcePath = join(sourceDirectory, "paper.pdf");
    await writeFile(sourcePath, await pdf("unchanged"));
    const inspectGeneration = vi.fn(async () => ({ pageCount: 1, pages: [] }));
    let countPersists = false;
    let persistCount = 0;
    const realSetInterval = globalThis.setInterval;
    const interval = vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay) =>
      realSetInterval(callback, delay === 5_000 ? 120_000 : delay));
    const broker = new SessionBroker({
      recoveryRoot: recoveryDirectory,
      inspectGeneration,
      snapshotHooks: {
        beforeFinalRename: () => {
          if (countPersists) persistCount += 1;
        },
      },
    });
    brokers.push(broker);
    const observations: Array<{ reason: string; changed: boolean }> = [];
    broker.onLocalDocumentObservation(({ reason, changed }) => observations.push({ reason, changed }));
    const opened = await broker.openReview({
      pdfPath: sourcePath,
      surface: "browser",
      workflowMode: "generated-output",
    });
    if (opened.kind !== "opened") throw new Error("Expected open review");
    interval.mockRestore();
    await broker.observeLiveDocumentHint({
      sessionId: opened.launch.sessionId,
      outputPath: sourcePath,
      hostReason: "activation",
    });
    await vi.advanceTimersByTimeAsync(59_999);
    await broker.observeLiveDocumentHint({
      sessionId: opened.launch.sessionId,
      outputPath: sourcePath,
      hostReason: "activation",
    });
    expect(await broker.settlePhysicalSaveBarrier(opened.launch.sessionId)).toBe(true);
    persistCount = 0;
    countPersists = true;
    await vi.advanceTimersByTimeAsync(1);
    expect(broker.physicalSaveBarrierPending(opened.launch.sessionId)).toBe(true);
    await broker.settlePhysicalSaveBarrier(opened.launch.sessionId);
    countPersists = false;

    expect(observations).toContainEqual({ reason: "audit", changed: false });
    expect(inspectGeneration).not.toHaveBeenCalled();
    expect(persistCount).toBe(0);
    expect(broker.state(opened.launch.sessionId)?.workflow.documentGeneration).toBe(1);
  });

  it("cancels watchers, timers, and late completions when a session ends", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<{ readonly status: "retry" }>();
    const value = await fixture();
    const watch = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() });
    const observer = new LocalDocumentObserver({
      watchDirectory: () => watch,
      inspectCandidate: () => pending.promise,
    });
    observer.observe({ sessionId: "session", sourcePath: value.sourcePath });
    const startup = observer.flush("session");
    observer.stop("session");
    pending.resolve({ status: "retry" });
    await startup;
    await vi.runAllTimersAsync();
    expect(watch.close).toHaveBeenCalled();
    expect(observer.has("session")).toBe(false);
  });

  it("recovers across an atomic replacement after a missing interval", async () => {
    const value = await fixture();
    value.observer.observe({ sessionId: "session", sourcePath: value.sourcePath });
    await value.observer.flush("session");
    await unlink(value.sourcePath);
    value.watches[0]!.emit("change", "rename", "paper.pdf");
    await value.observer.flush("session");
    const replacement = join(dirname(value.sourcePath), ".paper.next");
    await writeFile(replacement, "%PDF-1.7\nreplacement");
    await rename(replacement, value.sourcePath);
    value.watches[0]!.emit("change", "rename", "paper.pdf");
    await value.observer.flush("session");
    expect(value.candidates.at(-1)?.identity?.byteLength).toBeGreaterThan(0);
  });
});

it("lets long inspection finish across unchanged timer wakeups, then performs a full digest audit", async () => {
  vi.useFakeTimers();
  const f = await fixture(); f.observer.dispose();
  const initialStats = await lstat(f.sourcePath);
  const gate = Promise.withResolvers<void>();
  const seen: LocalDocumentCandidate[] = [];
  const observer = new LocalDocumentObserver({ watchDirectory: () => Object.assign(new EventEmitter(), { close() {} }),
    inspectIdentity: async () => initialStats, coalesceMs: 1, identityIntervalMs: 20, auditIntervalMs: 30,
    inspectCandidate: async candidate => { seen.push(candidate); if (seen.length === 1) await gate.promise; return { status: "current" }; },
  });
  try {
    observer.observe({ sessionId: "long", sourcePath: f.sourcePath });
    await vi.advanceTimersByTimeAsync(1); await vi.waitFor(() => expect(seen).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(100);
    expect(observer.isCurrent("long", seen[0]!.sequence)).toBe(true);
    gate.resolve(); await observer.settle(); await vi.advanceTimersByTimeAsync(2); await observer.settle();
    expect(seen.some(candidate => candidate.reason === "audit")).toBe(true);
  } finally { gate.resolve(); observer.dispose(); await observer.settle(); }
});

it("supersedes long inspection when a later actual identity changes and immediately fences named watcher events", async () => {
  vi.useFakeTimers();
  const f = await fixture(); f.observer.dispose();
  const watch = Object.assign(new EventEmitter(), { close() {} });
  let currentStats = await lstat(f.sourcePath);
  const gate = Promise.withResolvers<void>(); const seen: LocalDocumentCandidate[] = [];
  const admitted: Array<Omit<LocalDocumentCandidate, "identity">> = [];
  const observer = new LocalDocumentObserver({ watchDirectory: () => watch, admitCandidate: c => admitted.push(c),
    inspectIdentity: async () => currentStats, coalesceMs: 1, identityIntervalMs: 20, auditIntervalMs: 60_000,
    inspectCandidate: async candidate => { seen.push(candidate); if (seen.length === 1) await gate.promise; return { status: "current" }; },
  });
  try {
    observer.observe({ sessionId: "long", sourcePath: f.sourcePath });
    await vi.advanceTimersByTimeAsync(1); await vi.waitFor(() => expect(seen).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(50);
    expect(observer.isCurrent("long", seen[0]!.sequence)).toBe(true);
    await writeFile(f.sourcePath, "%PDF-1.7\nnew real identity with longer bytes");
    currentStats = await lstat(f.sourcePath);
    await vi.advanceTimersByTimeAsync(20); await vi.waitFor(() => expect(observer.isCurrent("long", seen[0]!.sequence)).toBe(false));
    const count = admitted.length; watch.emit("change", "rename", basename(f.sourcePath));
    expect(admitted).toHaveLength(count + 1); expect(admitted.at(-1)?.reason).toBe("watcher");
    gate.resolve(); await vi.advanceTimersByTimeAsync(2); await observer.settle();
    expect(seen.at(-1)?.identity?.byteLength).toBeGreaterThan(seen[0]!.identity!.byteLength);
    expect(observer.isCurrent("long", seen.at(-1)!.sequence)).toBe(true);
  } finally { gate.resolve(); observer.dispose(); await observer.settle(); }
});

it("retains bounded retry after an unreadable long candidate across timer wakeups", async () => {
  vi.useFakeTimers();
  const f = await fixture(); f.observer.dispose();
  const gate = Promise.withResolvers<void>(); let calls = 0;
  const observer = new LocalDocumentObserver({ watchDirectory: () => Object.assign(new EventEmitter(), { close() {} }),
    inspectIdentity: async () => { throw new Error("unreadable"); }, coalesceMs: 10, identityIntervalMs: 20, auditIntervalMs: 60_000,
    inspectCandidate: async candidate => { calls++; expect(candidate.identity).toBeUndefined(); if (calls === 1) await gate.promise; return { status: "retry" }; },
  });
  try {
    observer.observe({ sessionId: "unreadable", sourcePath: f.sourcePath }); await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(100); expect(calls).toBe(1);
    gate.resolve(); await observer.settle(); await vi.advanceTimersByTimeAsync(11); await observer.settle();
    expect(calls).toBeGreaterThan(1);
  } finally { gate.resolve(); observer.dispose(); await observer.settle(); }
});

it("keeps explicit replacement authority through unchanged identity timers and anonymous directory noise", async () => {
  vi.useFakeTimers(); const f = await fixture(); f.observer.dispose();
  let currentStats = await lstat(f.sourcePath); const watch = Object.assign(new EventEmitter(), { close() {} });
  const seen: LocalDocumentCandidate[] = [];
  const observer = new LocalDocumentObserver({ watchDirectory: () => watch, inspectIdentity: async () => currentStats,
    coalesceMs: 1, identityIntervalMs: 20, auditIntervalMs: 30, inspectCandidate: async c => { seen.push(c); return { status: "current" }; } });
  try {
    observer.observe({ sessionId: "explicit", sourcePath: f.sourcePath }); await vi.advanceTimersByTimeAsync(1); await observer.settle();
    const sequence = (await observer.reserveExplicitHint("explicit"))!;
    for (let i = 0; i < 5; i++) { watch.emit("change", "rename", undefined); await vi.advanceTimersByTimeAsync(20); }
    expect(observer.isCurrent("explicit", sequence)).toBe(true);
    await writeFile(f.sourcePath, "%PDF-1.7\nactual later successor identity"); currentStats = await lstat(f.sourcePath);
    await vi.advanceTimersByTimeAsync(20); expect(observer.isCurrent("explicit", sequence)).toBe(false);
    observer.completeExplicitHint("explicit", sequence); await vi.advanceTimersByTimeAsync(2); await observer.settle();
    expect(seen.some(c => c.reason === "audit")).toBe(true);
  } finally { observer.dispose(); await observer.settle(); }
});

it("does not let a stale inspection's deferred audit revoke its real watcher successor", async () => {
  vi.useFakeTimers(); const f = await fixture(); f.observer.dispose(); let stats = await lstat(f.sourcePath);
  const watch = Object.assign(new EventEmitter(), { close() {} }); const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>();
  const seen: LocalDocumentCandidate[] = [];
  const observer = new LocalDocumentObserver({ watchDirectory: () => watch, inspectIdentity: async () => stats, coalesceMs: 1, identityIntervalMs: 20, auditIntervalMs: 30,
    inspectCandidate: async c => { seen.push(c); if (seen.length === 1) await first.promise; if (seen.length === 2) await second.promise; return { status: "current" }; } });
  try {
    observer.observe({ sessionId: "successor", sourcePath: f.sourcePath }); await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(35); await writeFile(f.sourcePath, "%PDF-1.7\nreal watcher successor"); stats = await lstat(f.sourcePath); watch.emit("change", "rename", basename(f.sourcePath));
    await vi.advanceTimersByTimeAsync(2); first.resolve(); await vi.advanceTimersByTimeAsync(1);
    expect(seen[1]?.reason).toBe("watcher"); expect(observer.isCurrent("successor", seen[1]!.sequence)).toBe(true);
    second.resolve(); await observer.settle(); await vi.advanceTimersByTimeAsync(2); await observer.flush("successor"); await observer.settle();
    expect(seen.at(-1)?.reason).toBe("audit");
  } finally { first.resolve(); second.resolve(); observer.dispose(); await observer.settle(); }
});

it("does not revoke a candidate while its initial identity read spans timer intervals", async () => {
  vi.useFakeTimers(); const f = await fixture(); f.observer.dispose(); const stats = await lstat(f.sourcePath);
  const identityGate = Promise.withResolvers<typeof stats>(); const seen: LocalDocumentCandidate[] = [];
  const observer = new LocalDocumentObserver({ watchDirectory: () => Object.assign(new EventEmitter(), { close() {} }),
    inspectIdentity: async () => identityGate.promise, coalesceMs: 1, identityIntervalMs: 20, auditIntervalMs: 60_000,
    inspectCandidate: async c => { seen.push(c); return { status: "current" }; } });
  try {
    observer.observe({ sessionId: "slow-stat", sourcePath: f.sourcePath }); await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(100); identityGate.resolve(stats); await observer.settle();
    expect(seen).toHaveLength(1); expect(observer.isCurrent("slow-stat", seen[0]!.sequence)).toBe(true);
  } finally { identityGate.resolve(stats); observer.dispose(); await observer.settle(); }
});

it("runs a deferred full audit after a slow unchanged identity shortcut", async () => {
  vi.useFakeTimers(); const f = await fixture(); f.observer.dispose(); const stats = await lstat(f.sourcePath);
  const gate = Promise.withResolvers<typeof stats>(); let reads = 0; const seen: LocalDocumentCandidate[] = [];
  const observer = new LocalDocumentObserver({ watchDirectory: () => Object.assign(new EventEmitter(), { close() {} }),
    inspectIdentity: async () => ++reads === 2 ? gate.promise : stats, coalesceMs: 1, identityIntervalMs: 20, auditIntervalMs: 30,
    inspectCandidate: async c => { seen.push(c); return { status: "current" }; } });
  try {
    observer.observe({ sessionId: "slow-unchanged", sourcePath: f.sourcePath }); await vi.advanceTimersByTimeAsync(1); await observer.settle();
    await vi.advanceTimersByTimeAsync(100); gate.resolve(stats); await observer.settle(); await vi.advanceTimersByTimeAsync(2); await observer.flush("slow-unchanged");
    expect(seen.some(c => c.reason === "audit")).toBe(true);
  } finally { gate.resolve(stats); observer.dispose(); await observer.settle(); }
});
