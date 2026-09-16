import { EventEmitter } from "node:events";
import { mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
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
  await Promise.all(brokers.splice(0).map((broker) => broker.quiesceForShutdown()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
  const observer = new LocalDocumentObserver({
    watchDirectory: () => {
      const watch = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() });
      watches.push(watch);
      return watch;
    },
    admitCandidate: (candidate) => admitted.push(candidate),
    inspectCandidate: async (candidate) => {
      candidates.push(candidate);
      return { status: "current" };
    },
  });
  return { observer, sourcePath, watches, candidates, admitted };
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
