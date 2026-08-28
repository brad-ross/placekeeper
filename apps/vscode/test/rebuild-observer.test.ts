import { describe, expect, it, vi } from "vitest";
import { RebuildObserver } from "../src/rebuild-observer.js";

describe("rebuild observer", () => {
  it("coalesces output event varieties into latest-only candidate epochs", async () => {
    const validate = vi.fn(async () => ({ status: "committed" as const }));
    const observer = new RebuildObserver({
      outputPath: "/work/paper.pdf",
      validate,
      markPossiblyStale: vi.fn(async () => undefined),
    });
    expect(observer.noteFileEvent("/work/unrelated.pdf")).toBeUndefined();
    expect(observer.noteFileEvent("/work/paper.pdf")).toBe(1);
    expect(observer.noteFileEvent("/work/paper.pdf")).toBe(2);
    expect(observer.noteFileEvent("/work/paper.synctex.gz")).toBe(3);
    await observer.flush();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith({ outputPath: "/work/paper.pdf", observationEpoch: 3, reason: "watcher" });
  });

  it("starts after a persisted broker epoch on a fresh extension host", async () => {
    const validate = vi.fn(async (_input: { readonly reason: string }) => ({ status: "same-digest" as const }));
    const observer = new RebuildObserver({
      outputPath: "/work/paper.pdf",
      initialEpoch: 2_000_000,
      validate,
      markPossiblyStale: vi.fn(async () => undefined),
    });
    expect(observer.noteFileEvent("/work/paper.pdf")).toBe(2_000_001);
    await observer.flush();
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ observationEpoch: 2_000_001 }));
  });

  it("drops superseded validation replies and never asks to reveal the panel", async () => {
    const first = Promise.withResolvers<{ status: "committed" }>();
    const results: unknown[] = [];
    const validate = vi.fn()
      .mockImplementationOnce(async () => first.promise)
      .mockResolvedValueOnce({ status: "same-digest" });
    const observer = new RebuildObserver({
      outputPath: "/work/paper.pdf",
      validate,
      markPossiblyStale: vi.fn(async () => undefined),
      onCurrentResult: (result) => results.push(result),
    });
    observer.noteFileEvent("/work/paper.pdf");
    const pending = observer.flush();
    observer.noteFileEvent("/work/paper.pdf");
    first.resolve({ status: "committed" });
    await pending;
    await observer.flush();
    expect(results).toEqual([{ status: "same-digest" }]);
  });

  it("marks source saves stale and revalidates stale panels on reveal and bounded ticks", async () => {
    const validate = vi.fn(async (_input: { readonly reason: string }) => ({ status: "same-digest" as const }));
    const markPossiblyStale = vi.fn(async () => undefined);
    const observer = new RebuildObserver({ outputPath: "/work/paper.pdf", validate, markPossiblyStale });
    await observer.noteSourceSaved();
    await observer.revalidate("reveal");
    await observer.tick();
    observer.noteCurrent();
    await observer.tick();
    expect(markPossiblyStale).toHaveBeenCalledTimes(1);
    expect(markPossiblyStale).toHaveBeenCalledWith({ observationEpoch: 1 });
    expect(validate.mock.calls.map(([input]) => input.reason)).toEqual(["reveal", "interval"]);
  });

  it("keeps an older output observation from clearing a newer source save", async () => {
    const pending = Promise.withResolvers<{ status: "committed" }>();
    const results: unknown[] = [];
    const markPossiblyStale = vi.fn(async () => undefined);
    const observer = new RebuildObserver({
      outputPath: "/work/paper.pdf",
      validate: vi.fn(() => pending.promise),
      markPossiblyStale,
      onCurrentResult: (result) => results.push(result),
    });
    observer.noteFileEvent("/work/paper.pdf");
    const validation = observer.flush();
    await observer.noteSourceSaved();
    pending.resolve({ status: "committed" });
    await validation;

    expect(observer.possiblyStale).toBe(true);
    expect(results).toEqual([]);
    expect(markPossiblyStale).toHaveBeenCalledWith({ observationEpoch: 2 });
  });

  it("contains validation and stale-marking failures while remaining stale", async () => {
    const observer = new RebuildObserver({
      outputPath: "/work/paper.pdf",
      validate: vi.fn(async () => { throw new Error("broker unavailable"); }),
      markPossiblyStale: vi.fn(async () => { throw new Error("broker unavailable"); }),
    });
    observer.noteFileEvent("/work/paper.pdf");
    await expect(observer.flush()).resolves.toBeUndefined();
    expect(observer.possiblyStale).toBe(true);
    await expect(observer.tick()).resolves.toBeUndefined();
  });
});
