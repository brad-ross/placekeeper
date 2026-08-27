import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReviewState,
  type ReviewCommand,
  type ReviewState,
} from "../../../packages/core/src/review-model.js";
import {
  DraftSnapshotStore,
  reviewStateDigest,
  type RecoverableDraft,
} from "../src/recovery/draft-snapshot.js";
import { enforceRetention } from "../src/recovery/retention.js";
import { createSourceSnapshot } from "../src/recovery/source-snapshot.js";
import { SessionBroker } from "../src/sessions/session-broker.js";
import { hashFile } from "../src/files/file-capabilities.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "placekeeper-recovery-"));
  temporaryDirectories.push(path);
  return path;
}

function addCommand(expectedRevision: number, comment = "remember this"): ReviewCommand {
  const timestamp = new Date().toISOString();
  return {
    type: "add",
    expectedRevision,
    item: {
      id: randomUUID(),
      kind: "highlight",
      pageIndex: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      payload: {
        quote: "remember",
        prefix: "please ",
        suffix: " this",
        rect: { x: 72, y: 92, width: 80, height: 14 },
        segmentRects: [{ x: 72, y: 92, width: 80, height: 14 }],
        reliable: true,
        comment,
      },
    },
  };
}

describe("source snapshot creation", () => {
  it("uses collision-resistant temporary files for concurrent snapshots", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "paper.pdf");
    const sessionDirectory = join(directory, "recovery", randomUUID());
    const bytes = "%PDF-1.7\nconcurrent snapshot\n%%EOF";
    await writeFile(source, bytes);
    vi.spyOn(Date, "now").mockReturnValue(1_777_777_777_777);

    const snapshots = await Promise.all([
      createSourceSnapshot(source, sessionDirectory),
      createSourceSnapshot(source, sessionDirectory),
    ]);

    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(await readFile(snapshots[0]!.path, "utf8")).toBe(bytes);
  });
});

function draft(revision: number): RecoverableDraft {
  const base = createReviewState({
    sessionId: "a011ee5d-5e5c-4f34-929d-41f49256f427",
    source: {
      fileId: "6d257008-2bf5-4768-89dd-304233697051",
      digest: "a".repeat(64),
      byteLength: 12,
    },
  });
  const state: ReviewState = { ...base, revision };
  return {
    schemaVersion: 1,
    canonicalSourcePath: "/private/example/paper.pdf",
    sourceSnapshotPath: "/private/example/source.pdf",
    state,
    acknowledgedAt: new Date(revision * 1_000).toISOString(),
  };
}

describe("atomic recovery generations", () => {
  it("protects generated-output pending authoring and hashes it as canonical state", async () => {
    const directory = await temporaryDirectory();
    const store = new DraftSnapshotStore(directory);
    const state = createReviewState({
      sessionId: randomUUID(),
      source: { fileId: randomUUID(), digest: "a".repeat(64), byteLength: 10 },
      workflowMode: "generated-output",
      documentGeneration: 2,
    });
    const protectedState: ReviewState = {
      ...state,
      revision: 1,
      pendingDrafts: [{
        id: randomUUID(), ownerViewId: "panel-a", baseGeneration: 2, revision: 0,
        kind: "pageNote", pageIndex: 0, text: "finish this note",
        anchor: { kind: "page", pageIndex: 0, rect: { x: 1, y: 2, width: 3, height: 4 } },
        disposition: { kind: "resolved", generation: 2 }, status: "protected",
        createdAt: "2026-08-27T12:00:00.000Z", updatedAt: "2026-08-27T12:00:00.000Z",
      }],
    };
    await store.persist({ ...draft(0), state: protectedState });

    const recovered = await store.recover();
    expect(recovered?.state.pendingDrafts).toEqual(protectedState.pendingDrafts);
    expect(reviewStateDigest(protectedState)).not.toBe(reviewStateDigest(state));
  });
  it("recovers the previous complete generation after failure between rotation and final rename", async () => {
    const directory = await temporaryDirectory();
    const stable = new DraftSnapshotStore(directory);
    await stable.persist(draft(1));
    const failing = new DraftSnapshotStore(directory, {
      beforeFinalRename: () => {
        throw new Error("simulated ENOSPC/rename failure");
      },
    });
    await expect(failing.persist(draft(2))).rejects.toThrow("simulated");
    await expect(stable.recover()).resolves.toMatchObject({ state: { revision: 1 } });
  });

  it("preserves the current generation when persistence stops after syncing the temporary file", async () => {
    const directory = await temporaryDirectory();
    const stable = new DraftSnapshotStore(directory);
    await stable.persist(draft(1));
    const failing = new DraftSnapshotStore(directory, {
      afterTemporarySync: () => {
        throw new Error("simulated crash after temporary sync");
      },
    });
    await expect(failing.persist(draft(2))).rejects.toThrow("temporary sync");
    await expect(stable.recover()).resolves.toMatchObject({ state: { revision: 1 } });
  });

  it("does not clean an in-flight draft temporary file owned by another store", async () => {
    const directory = await temporaryDirectory();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = new DraftSnapshotStore(directory, {
      afterTemporarySync: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const persistence = writer.persist(draft(1));
    await entered.promise;

    try {
      await new DraftSnapshotStore(directory).initialize();
    } finally {
      release.resolve();
    }

    await expect(persistence).resolves.toBeUndefined();
    await expect(writer.recover()).resolves.toMatchObject({ state: { revision: 1 } });
  });

  it("ignores a torn current file, retains the previous checksum-valid generation, and cleans staging files", async () => {
    const directory = await temporaryDirectory();
    const store = new DraftSnapshotStore(directory);
    await store.persist(draft(1));
    await store.persist(draft(2));
    await writeFile(store.currentPath, '{"checksum":"torn"');
    await writeFile(join(directory, ".draft-abandoned.tmp"), "sensitive staging");
    await writeFile(join(directory, ".source-abandoned.tmp"), "source staging");
    await expect(store.recover()).resolves.toMatchObject({ state: { revision: 1 } });
    await expect(access(join(directory, ".draft-abandoned.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(directory, ".source-abandoned.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("forces 0700 directories and 0600 snapshots independent of umask", async () => {
    const directory = await temporaryDirectory();
    const originalUmask = process.umask(0o000);
    try {
      const store = new DraftSnapshotStore(join(directory, "session"));
      await store.persist(draft(0));
      expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(store.currentPath)).mode & 0o777).toBe(0o600);
      process.umask(0o777);
      await store.persist(draft(1));
      expect((await stat(store.currentPath)).mode & 0o777).toBe(0o600);
      expect((await stat(store.previousPath)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(originalUmask);
    }
  });
});

describe("broker acknowledgement and restart recovery", () => {
  it("keeps generated-output mode canonical across browser, VS Code, and Codex joins", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\ngenerated\n%%EOF");
    const broker = new SessionBroker({ recoveryRoot: join(directory, "recovery") });
    const opened = await broker.openReview({
      pdfPath: pdf,
      surface: "vscode",
      workflowMode: "generated-output",
    });
    if (opened.kind !== "opened") throw new Error("Expected opened review");

    for (const surface of ["browser", "codex"] as const) {
      const joined = await broker.openReview({ pdfPath: pdf, surface });
      expect(joined.kind).toBe("focused");
      expect(broker.state(opened.launch.sessionId)?.workflow.mode).toBe("generated-output");
    }
    await expect(broker.openReview({
      pdfPath: pdf,
      surface: "browser",
      workflowMode: "standard",
    })).rejects.toThrow(/cannot be downgraded/iu);
  });

  it("removes verified-clean recovery at shutdown but retains dirty protected recovery", async () => {
    const directory = await temporaryDirectory();
    const cleanPdf = join(directory, "clean.pdf");
    const dirtyPdf = join(directory, "dirty.pdf");
    await writeFile(cleanPdf, "%PDF-1.7\nclean\n%%EOF");
    await writeFile(dirtyPdf, "%PDF-1.7\ndirty\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    const broker = new SessionBroker({ recoveryRoot });
    const clean = await broker.openReview({ pdfPath: cleanPdf });
    const dirty = await broker.openReview({ pdfPath: dirtyPdf });
    if (clean.kind !== "opened" || dirty.kind !== "opened") throw new Error("Expected new reviews");
    await broker.acceptMutation(dirty.launch.sessionId, addCommand(0));

    await broker.quiesceForShutdown();

    await expect(access(join(recoveryRoot, clean.launch.sessionId))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(recoveryRoot, dirty.launch.sessionId))).resolves.toBeUndefined();
    const recovered = await new DraftSnapshotStore(
      join(recoveryRoot, dirty.launch.sessionId),
    ).recover();
    expect(recovered).toMatchObject({ state: { revision: 1 }, sync: { phase: "not-saved" } });
  });

  it("finishes shutdown when clean recovery deletion fails and preserves dirty recovery", async () => {
    const directory = await temporaryDirectory();
    const cleanPdf = join(directory, "clean-remove-failure.pdf");
    const dirtyPdf = join(directory, "dirty-remove-failure.pdf");
    await writeFile(cleanPdf, "%PDF-1.7\nclean\n%%EOF");
    await writeFile(dirtyPdf, "%PDF-1.7\ndirty\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    const broker = new SessionBroker({ recoveryRoot });
    const clean = await broker.openReview({ pdfPath: cleanPdf });
    const dirty = await broker.openReview({ pdfPath: dirtyPdf });
    if (clean.kind !== "opened" || dirty.kind !== "opened") throw new Error("Expected new reviews");
    await broker.acceptMutation(dirty.launch.sessionId, addCommand(0));
    vi.spyOn(DraftSnapshotStore.prototype, "remove").mockRejectedValueOnce(new Error("disk unavailable"));

    await expect(broker.quiesceForShutdown()).resolves.toBeUndefined();

    expect(broker.activity()).toEqual({ reviewPresence: 0, codexTasks: 0, transientWork: 0 });
    await expect(access(join(recoveryRoot, clean.launch.sessionId))).resolves.toBeUndefined();
    await expect(access(join(recoveryRoot, dirty.launch.sessionId))).resolves.toBeUndefined();
    await expect(new DraftSnapshotStore(
      join(recoveryRoot, dirty.launch.sessionId),
    ).recover()).resolves.toMatchObject({ state: { revision: 1 }, sync: { phase: "not-saved" } });
  });
  it("recovers exactly the last acknowledged revision while leaving original bytes unchanged", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    const original = Buffer.from("%PDF-1.7\noriginal immutable bytes\n%%EOF");
    await writeFile(pdf, original);
    const recoveryRoot = join(directory, "recovery");
    const firstBroker = new SessionBroker({ recoveryRoot });
    const opened = await firstBroker.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected a new review");
    const acknowledged = await firstBroker.acceptMutation(
      opened.launch.sessionId,
      addCommand(0),
    );
    expect(acknowledged.revision).toBe(1);
    expect(await readFile(pdf)).toEqual(original);

    const restarted = new SessionBroker({ recoveryRoot });
    const offered = await restarted.openReview({ pdfPath: pdf });
    expect(offered).toMatchObject({
      kind: "recovery-offered",
      recoverySessionId: opened.launch.sessionId,
      choices: ["resume", "discard", "fork"],
      recoveryOffer: {
        id: expect.any(String),
        expiresAt: expect.any(String),
      },
    });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const resumed = await restarted.openReview({
      pdfPath: pdf,
      recoveryDecision: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: "resume_operation_1234",
    });
    if (resumed.kind !== "opened") throw new Error("Expected resumed review");
    expect(restarted.state(resumed.launch.sessionId)).toMatchObject({
      revision: 1,
      items: [{ payload: { comment: "remember this" } }],
    });
    expect(await restarted.documentBytes(resumed.launch.sessionId)).toEqual(original);
  });

  it("binds recovery decisions to one exact offer and replays only the same operation", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\nversion one\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    const first = new SessionBroker({ recoveryRoot });
    const opened = await first.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected a new review");
    await first.acceptMutation(opened.launch.sessionId, addCommand(0));

    const restarted = new SessionBroker({ recoveryRoot });
    const offered = await restarted.openReview({ pdfPath: pdf });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const request = {
      pdfPath: pdf,
      recoveryDecision: "fork" as const,
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: "fork_operation_123456",
    };
    const committed = await restarted.openReview(request);
    const replayed = await restarted.openReview(request);
    expect(replayed).toEqual(committed);
    await expect(restarted.openReview({
      ...request,
      recoveryDecision: "discard",
    })).rejects.toThrow(/operation|choice|offer/iu);
    await expect(restarted.openReview({
      ...request,
      recoveryOperationId: "different_operation_1234",
    })).rejects.toThrow(/offer|recovery/iu);
  });

  it("shares one offer per protected draft and permits only one competing operation", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\nversion one\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    const first = new SessionBroker({ recoveryRoot });
    const opened = await first.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected a new review");
    await first.acceptMutation(opened.launch.sessionId, addCommand(0));

    const restarted = new SessionBroker({ recoveryRoot });
    const firstOffer = await restarted.openReview({ pdfPath: pdf });
    const secondOffer = await restarted.openReview({ pdfPath: pdf });
    if (firstOffer.kind !== "recovery-offered" || secondOffer.kind !== "recovery-offered") {
      throw new Error("Expected recovery offers");
    }
    expect(secondOffer.recoveryOffer).toEqual(firstOffer.recoveryOffer);

    const outcomes = await Promise.allSettled([
      restarted.openReview({
        pdfPath: pdf,
        recoveryDecision: "fork",
        recoveryOffer: firstOffer.recoveryOffer,
        recoveryOperationId: "first_competing_operation",
      }),
      restarted.openReview({
        pdfPath: pdf,
        recoveryDecision: "discard",
        recoveryOffer: secondOffer.recoveryOffer,
        recoveryOperationId: "second_competing_operation",
      }),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(restarted.activity().reviewPresence).toBe(1);
  });

  it("expires an unused offer without changing protected work", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\nversion one\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    let now = new Date("2026-08-21T18:00:00.000Z");
    const first = new SessionBroker({ recoveryRoot, now: () => now });
    const opened = await first.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected a new review");
    await first.acceptMutation(opened.launch.sessionId, addCommand(0));

    const restarted = new SessionBroker({ recoveryRoot, now: () => now });
    const offered = await restarted.openReview({ pdfPath: pdf });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    now = new Date("2026-08-21T18:06:00.000Z");
    await expect(restarted.openReview({
      pdfPath: pdf,
      recoveryDecision: "discard",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    })).rejects.toThrow(/stale|expired/iu);
    await expect(new DraftSnapshotStore(
      join(recoveryRoot, opened.launch.sessionId),
    ).recover()).resolves.toMatchObject({ state: { revision: 1 } });
  });

  it("fails closed when more than one protected draft matches the same source", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\nversion one\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    const first = new SessionBroker({ recoveryRoot });
    const opened = await first.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected a new review");
    await first.acceptMutation(opened.launch.sessionId, addCommand(0));
    const original = await new DraftSnapshotStore(
      join(recoveryRoot, opened.launch.sessionId),
    ).recover();
    if (original === undefined) throw new Error("Expected protected draft");
    const duplicateId = randomUUID();
    await new DraftSnapshotStore(join(recoveryRoot, duplicateId)).persist({
      ...original,
      state: { ...original.state, sessionId: duplicateId },
    });

    const restarted = new SessionBroker({ recoveryRoot });
    await expect(restarted.openReview({ pdfPath: pdf })).rejects.toThrow(/ambiguous/iu);
    await expect(new DraftSnapshotStore(
      join(recoveryRoot, opened.launch.sessionId),
    ).recover()).resolves.toBeDefined();
    await expect(new DraftSnapshotStore(
      join(recoveryRoot, duplicateId),
    ).recover()).resolves.toBeDefined();
  });

  it("keeps a discarded draft until its replacement is durably active", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\nversion one\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    const first = new SessionBroker({ recoveryRoot });
    const opened = await first.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected a new review");
    await first.acceptMutation(opened.launch.sessionId, addCommand(0));

    let failReplacement = false;
    const restarted = new SessionBroker({
      recoveryRoot,
      snapshotHooks: {
        beforeFinalRename: () => {
          if (failReplacement) throw new Error("replacement persistence failed");
        },
      },
    });
    const offered = await restarted.openReview({ pdfPath: pdf });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    failReplacement = true;
    await expect(restarted.openReview({
      pdfPath: pdf,
      recoveryDecision: "discard",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    })).rejects.toThrow("replacement persistence failed");
    await expect(new DraftSnapshotStore(
      join(recoveryRoot, opened.launch.sessionId),
    ).recover()).resolves.toMatchObject({ state: { revision: 1 } });
  });

  it("keeps the durable replacement active when old draft cleanup fails", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\nversion one\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    const first = new SessionBroker({ recoveryRoot });
    const opened = await first.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected a new review");
    await first.acceptMutation(opened.launch.sessionId, addCommand(0));

    const restarted = new SessionBroker({ recoveryRoot });
    const offered = await restarted.openReview({ pdfPath: pdf });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    vi.spyOn(DraftSnapshotStore.prototype, "remove").mockRejectedValueOnce(
      new Error("old draft cleanup failed"),
    );
    const replacement = await restarted.openReview({
      pdfPath: pdf,
      recoveryDecision: "discard",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    if (replacement.kind !== "opened") throw new Error("Expected durable replacement");
    expect(restarted.state(replacement.launch.sessionId)).toBeDefined();
    await expect(new DraftSnapshotStore(
      join(recoveryRoot, opened.launch.sessionId),
    ).recover()).resolves.toBeDefined();
  });

  it("never acknowledges a mutation whose atomic persistence fails", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\noriginal\n%%EOF");
    let renameBoundary = 0;
    const broker = new SessionBroker({
      recoveryRoot: join(directory, "recovery"),
      snapshotHooks: {
        beforeFinalRename: () => {
          renameBoundary += 1;
          if (renameBoundary === 2) throw new Error("disk full");
        },
      },
    });
    const opened = await broker.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected a new review");
    await expect(
      broker.acceptMutation(opened.launch.sessionId, addCommand(0)),
    ).rejects.toThrow("disk full");
    expect(broker.state(opened.launch.sessionId)?.revision).toBe(0);
    const store = new DraftSnapshotStore(
      join(directory, "recovery", opened.launch.sessionId),
    );
    await expect(store.recover()).resolves.toMatchObject({ state: { revision: 0 } });
  });

  it("cancels and awaits in-flight persistence before Finish removes private recovery", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\noriginal\n%%EOF");
    let boundary = 0;
    let release!: () => void;
    let entered!: () => void;
    const enteredBoundary = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const broker = new SessionBroker({
      recoveryRoot: join(directory, "recovery"),
      snapshotHooks: {
        beforeFinalRename: async () => {
          boundary += 1;
          if (boundary === 2) {
            entered();
            await blocked;
          }
        },
      },
    });
    const opened = await broker.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected a new review");
    const mutation = broker.acceptMutation(opened.launch.sessionId, addCommand(0));
    await enteredBoundary;
    const finishing = broker.finish(opened.launch.sessionId);
    let finished = false;
    void finishing.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await expect(mutation).rejects.toThrow();
    await finishing;
    await expect(
      access(join(directory, "recovery", opened.launch.sessionId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not apply a draft after source bytes change", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\nversion one\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    const first = new SessionBroker({ recoveryRoot });
    const opened = await first.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected a new review");
    await first.acceptMutation(opened.launch.sessionId, addCommand(0));
    await writeFile(pdf, "%PDF-1.7\nversion two rebuilt\n%%EOF");

    const restarted = new SessionBroker({ recoveryRoot });
    const changed = await restarted.openReview({ pdfPath: pdf });
    if (changed.kind !== "opened") throw new Error("Changed bytes must open independently");
    expect(changed.launch.sessionId).not.toBe(opened.launch.sessionId);
    expect(restarted.state(changed.launch.sessionId)?.revision).toBe(0);
  });

  it("refuses recovery when the private immutable source snapshot fails integrity", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\nversion one\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    const first = new SessionBroker({ recoveryRoot });
    const opened = await first.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected a new review");
    await first.acceptMutation(opened.launch.sessionId, addCommand(0));
    await writeFile(
      join(recoveryRoot, opened.launch.sessionId, "source.pdf"),
      "tampered bytes",
    );
    const restart = new SessionBroker({ recoveryRoot });
    const offered = await restart.openReview({ pdfPath: pdf });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    await expect(
      restart.openReview({
        pdfPath: pdf,
        recoveryDecision: "resume",
        recoveryOffer: offered.recoveryOffer,
        recoveryOperationId: randomUUID(),
      }),
    ).rejects.toThrow("integrity");
  });

  it("focuses an active identity, supports explicit forks, and implements all recovery choices", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\nversion one\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    const rewriteAssessor = vi.fn(async () => ({ eligible: true as const }));
    const broker = new SessionBroker({ recoveryRoot, rewriteAssessor });
    const first = await broker.openReview({ pdfPath: pdf });
    if (first.kind !== "opened") throw new Error("Expected a new review");
    expect(rewriteAssessor).toHaveBeenCalledOnce();
    const focused = await broker.openReview({ pdfPath: pdf });
    expect(focused).toMatchObject({
      kind: "focused",
      launch: { sessionId: first.launch.sessionId },
    });
    expect(rewriteAssessor).toHaveBeenCalledOnce();
    const forked = await broker.openReview({ pdfPath: pdf, recoveryDecision: "fork" });
    if (forked.kind !== "opened") throw new Error("Expected independent fork");
    expect(rewriteAssessor).toHaveBeenCalledTimes(2);
    expect(forked.launch.sessionId).not.toBe(first.launch.sessionId);
    await broker.finish(forked.launch.sessionId);
    const refocused = await broker.openReview({ pdfPath: pdf });
    expect(refocused).toMatchObject({
      kind: "focused",
      launch: { sessionId: first.launch.sessionId },
    });
    expect(rewriteAssessor).toHaveBeenCalledTimes(2);
    await broker.acceptMutation(first.launch.sessionId, addCommand(0));

    const restart = new SessionBroker({ recoveryRoot });
    const offered = await restart.openReview({ pdfPath: pdf });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const discarded = await restart.openReview({
      pdfPath: pdf,
      recoveryDecision: "discard",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    expect(discarded.kind).toBe("opened");
  });

  it("keeps recovery and access after export, but Finish and Discard revoke and remove them", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\nversion one\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    const broker = new SessionBroker({ recoveryRoot });
    const first = await broker.openReview({ pdfPath: pdf });
    if (first.kind !== "opened") throw new Error("Expected a new review");
    const firstCapability = first.launch.fragment.slice("#cap=".length);
    const firstCredential = broker.exchangeBootstrap(first.launch.sessionId, firstCapability)!;
    await broker.recordSuccessfulExport(first.launch.sessionId);
    expect(broker.authenticate(first.launch.sessionId, firstCredential)).toBe(true);
    await expect(access(join(recoveryRoot, first.launch.sessionId))).resolves.toBeUndefined();
    await broker.finish(first.launch.sessionId);
    expect(broker.authenticate(first.launch.sessionId, firstCredential)).toBe(false);
    await expect(access(join(recoveryRoot, first.launch.sessionId))).rejects.toMatchObject({ code: "ENOENT" });

    const second = await broker.openReview({ pdfPath: pdf, recoveryDecision: "fork" });
    if (second.kind !== "opened") throw new Error("Expected a new review");
    const secondCredential = broker.exchangeBootstrap(
      second.launch.sessionId,
      second.launch.fragment.slice("#cap=".length),
    )!;
    await broker.discard(second.launch.sessionId);
    expect(broker.authenticate(second.launch.sessionId, secondCredential)).toBe(false);
    await expect(access(join(recoveryRoot, second.launch.sessionId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("drops a stale source-root capability unless the root is explicitly reapproved on resume", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    const sourceRoot = join(directory, "source");
    await mkdir(sourceRoot);
    await writeFile(pdf, "%PDF-1.7\nversion one\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    const first = new SessionBroker({ recoveryRoot });
    const opened = await first.openReview({ pdfPath: pdf, sourceRootPath: sourceRoot });
    if (opened.kind !== "opened") throw new Error("Expected a new review");
    expect(first.state(opened.launch.sessionId)?.sourceRootId).toBeDefined();
    await first.acceptMutation(opened.launch.sessionId, addCommand(0));

    const restart = new SessionBroker({ recoveryRoot });
    const offered = await restart.openReview({ pdfPath: pdf });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const resumed = await restart.openReview({
      pdfPath: pdf,
      recoveryDecision: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    if (resumed.kind !== "opened") throw new Error("Expected a resumed review");
    expect(restart.state(resumed.launch.sessionId)?.sourceRootId).toBeUndefined();
    expect(resumed.launch.rootId).toBeUndefined();
  });
});

describe("save-aware recovery migration", () => {
  it("offers protected recovery after the original PDF moves", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    const moved = join(directory, "moved-paper.pdf");
    await writeFile(pdf, "%PDF-1.7\noriginal\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    const first = new SessionBroker({ recoveryRoot, portableReader: async () => [] });
    const opened = await first.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected opened review");
    await first.establishSaveDestination(opened.launch.sessionId, {
      kind: "original",
      targetPath: pdf,
      capabilityId: opened.launch.fileId,
      fingerprint: await hashFile(pdf),
    });
    await first.acceptMutation(opened.launch.sessionId, addCommand(0));
    await rename(pdf, moved);

    const restarted = new SessionBroker({ recoveryRoot, portableReader: async () => [] });
    const offered = await restarted.openReview({ pdfPath: moved });
    expect(offered).toMatchObject({
      kind: "recovery-offered",
      recoverySessionId: opened.launch.sessionId,
    });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const resumed = await restarted.openReview({
      pdfPath: moved,
      recoveryDecision: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    if (resumed.kind !== "opened") throw new Error("Expected resumed review");
    expect((await restarted.sessionScope(resumed.launch.sessionId))?.documentTitle).toBe("moved-paper.pdf");
    expect(restarted.saveStatus(resumed.launch.sessionId)).toMatchObject({
      destination: { phase: "active", kind: "original" },
      sync: { phase: "not-saved" },
    });
    const destination = restarted.saveStatus(resumed.launch.sessionId)?.destination;
    expect(destination?.phase === "active" ? destination.targetPath : "")
      .toMatch(/\/moved-paper\.pdf$/u);
  });

  it("re-authorizes an original save destination when recovery resumes", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    await writeFile(pdf, "%PDF-1.7\noriginal\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    const first = new SessionBroker({ recoveryRoot, portableReader: async () => [] });
    const opened = await first.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected opened review");
    await first.establishSaveDestination(opened.launch.sessionId, {
      kind: "original",
      targetPath: pdf,
      capabilityId: opened.launch.fileId,
      fingerprint: await hashFile(pdf),
    });
    await first.acceptMutation(opened.launch.sessionId, addCommand(0));

    const restarted = new SessionBroker({ recoveryRoot, portableReader: async () => [] });
    const offered = await restarted.openReview({ pdfPath: pdf });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const resumed = await restarted.openReview({
      pdfPath: pdf,
      recoveryDecision: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    if (resumed.kind !== "opened") throw new Error("Expected resumed review");
    const status = restarted.saveStatus(resumed.launch.sessionId);
    expect(status).toMatchObject({
      destination: {
        phase: "active",
        kind: "original",
        capabilityId: resumed.launch.fileId,
      },
      sync: { phase: "not-saved" },
    });
    await expect(
      restarted.capabilities.validateOriginalForReplacement(
        resumed.launch.fileId,
        await hashFile(pdf),
      ),
    ).resolves.toBe(status?.destination.phase === "active"
      ? status.destination.targetPath
      : undefined);
  });

  it("re-authorizes an unchanged copy and protects recovery when it is missing", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "paper.pdf");
    const copy = join(directory, "paper-annotated.pdf");
    await writeFile(pdf, "%PDF-1.7\noriginal\n%%EOF");
    await writeFile(copy, "%PDF-1.7\nsaved copy\n%%EOF");
    const recoveryRoot = join(directory, "recovery");
    const first = new SessionBroker({ recoveryRoot, portableReader: async () => [] });
    const opened = await first.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected opened review");
    const oldCapability = await first.capabilities.preauthorizeDestination(copy);
    const copyDigest = await hashFile(copy);
    await first.capabilities.refreshDestination(oldCapability.id, copyDigest);
    await first.establishSaveDestination(opened.launch.sessionId, {
      kind: "copy",
      targetPath: copy,
      capabilityId: oldCapability.id,
      fingerprint: copyDigest,
    });
    await first.acceptMutation(opened.launch.sessionId, addCommand(0));

    const restarted = new SessionBroker({ recoveryRoot, portableReader: async () => [] });
    const offered = await restarted.openReview({ pdfPath: pdf });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const resumed = await restarted.openReview({
      pdfPath: pdf,
      recoveryDecision: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    if (resumed.kind !== "opened") throw new Error("Expected resumed review");
    const active = restarted.saveStatus(resumed.launch.sessionId)?.destination;
    if (active?.phase !== "active") throw new Error("Expected active destination");
    expect(active.capabilityId).toBeDefined();
    expect(active.capabilityId).not.toBe(oldCapability.id);
    await expect(
      restarted.capabilities.validateDestination(active.capabilityId!),
    ).resolves.toBe(active.targetPath);

    await first.discard(opened.launch.sessionId);
    await restarted.discard(resumed.launch.sessionId);

    const second = new SessionBroker({ recoveryRoot, portableReader: async () => [] });
    const secondOpened = await second.openReview({ pdfPath: pdf });
    if (secondOpened.kind !== "opened") throw new Error("Expected second review");
    const secondCapability = await second.capabilities.preauthorizeDestination(copy);
    await second.capabilities.refreshDestination(secondCapability.id, copyDigest);
    await second.establishSaveDestination(secondOpened.launch.sessionId, {
      kind: "copy",
      targetPath: copy,
      capabilityId: secondCapability.id,
      fingerprint: copyDigest,
    });
    await second.acceptMutation(secondOpened.launch.sessionId, addCommand(0));
    await rm(copy);

    const missingRestart = new SessionBroker({ recoveryRoot, portableReader: async () => [] });
    const missingOffer = await missingRestart.openReview({ pdfPath: pdf });
    if (missingOffer.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const missing = await missingRestart.openReview({
      pdfPath: pdf,
      recoveryDecision: "resume",
      recoveryOffer: missingOffer.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    if (missing.kind !== "opened") throw new Error("Expected missing-copy recovery");
    expect(missingRestart.saveStatus(missing.launch.sessionId)).toMatchObject({
      destination: { phase: "active", kind: "copy" },
      sync: { phase: "not-saved", failure: "missing" },
    });
    expect(
      missingRestart.saveStatus(missing.launch.sessionId)?.destination,
    ).not.toHaveProperty("capabilityId");
  });

  it("opens portable app annotations as a clean editable original-backed session", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "portable.pdf");
    await writeFile(pdf, "%PDF-1.7\nportable\n%%EOF");
    const command = addCommand(0, "Editable after reopen");
    if (command.type !== "add") throw new Error("Expected add command");
    const broker = new SessionBroker({
      recoveryRoot: join(directory, "recovery"),
      portableReader: async () => [command.item],
    });

    const opened = await broker.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected portable PDF to open");
    expect(broker.state(opened.launch.sessionId)).toMatchObject({
      revision: 0,
      history: [],
      historyCursor: 0,
      items: [command.item],
    });
    expect(broker.saveStatus(opened.launch.sessionId)).toMatchObject({
      destination: {
        phase: "active",
        kind: "original",
        capabilityId: opened.launch.fileId,
      },
      sync: { phase: "clean", savedRevision: 0 },
    });
  });

  it("keeps portable marks visible but offers no destination for a restricted PDF", async () => {
    const directory = await temporaryDirectory();
    const pdf = join(directory, "restricted.pdf");
    await writeFile(pdf, "%PDF-1.7\nrestricted\n%%EOF");
    const command = addCommand(0, "Already embedded");
    if (command.type !== "add") throw new Error("Expected add command");
    const broker = new SessionBroker({
      recoveryRoot: join(directory, "recovery"),
      portableReader: async () => [command.item],
      rewriteAssessor: async () => ({
        eligible: false,
        code: "permission-denied",
        message: "This PDF does not permit annotations.",
      }),
    });
    const opened = await broker.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected restricted PDF to open");
    expect(broker.state(opened.launch.sessionId)?.items).toEqual([command.item]);
    expect(broker.saveStatus(opened.launch.sessionId)).toMatchObject({
      destination: { phase: "none" },
      rewriteEligibility: { eligible: false, code: "permission-denied" },
      sync: { phase: "clean" },
    });
  });

  it("migrates v1 drafts idempotently and suppresses clean viewer-only sessions", async () => {
    const directory = await temporaryDirectory();
    const store = new DraftSnapshotStore(join(directory, "legacy"));
    await store.persist(draft(1));
    const migrated = await store.recover();
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      destination: { phase: "none", generation: 0 },
      sync: { phase: "not-saved", desiredRevision: 1, failure: "destination-unconfigured" },
    });
    await store.persist(migrated!);
    await expect(store.recover()).resolves.toEqual(migrated);

    const pdf = join(directory, "viewer.pdf");
    await writeFile(pdf, "%PDF-1.7\nviewer only\n%%EOF");
    const recoveryRoot = join(directory, "viewer-recovery");
    const first = new SessionBroker({ recoveryRoot, portableReader: async () => [] });
    const opened = await first.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected opened viewer");
    const restarted = new SessionBroker({ recoveryRoot, portableReader: async () => [] });
    const reopened = await restarted.openReview({ pdfPath: pdf });
    expect(reopened.kind).toBe("opened");
  });
});

describe("retention", () => {
  it("never age- or storage-evicts active drafts and deterministically removes oldest inactive data", async () => {
    const root = await temporaryDirectory();
    const activeId = "active";
    const inactiveId = "inactive";
    const activeStore = new DraftSnapshotStore(join(root, activeId));
    const inactiveStore = new DraftSnapshotStore(join(root, inactiveId));
    await activeStore.persist(draft(10));
    await inactiveStore.persist(draft(1));
    await writeFile(join(activeStore.directory, "source.pdf"), Buffer.alloc(4_096));
    await writeFile(join(inactiveStore.directory, "source.pdf"), Buffer.alloc(8_192));
    expect(await activeStore.allocatedBytes()).toBeGreaterThan(4_096);
    expect(await inactiveStore.allocatedBytes()).toBeGreaterThan(8_192);
    const old = new Date(0);
    await utimes(activeStore.directory, old, old);
    await utimes(inactiveStore.directory, old, old);
    await chmod(activeStore.directory, 0o700);

    const result = await enforceRetention(
      root,
      new Set([activeId]),
      { maxBytes: 1, maxInactiveAgeMs: 1 },
      Date.now(),
    );
    expect(result.retainedActiveSessionIds).toContain(activeId);
    expect(result.removedSessionIds).toContain(inactiveId);
    expect(result.overLimit).toBe(true);
    await expect(access(activeStore.currentPath)).resolves.toBeUndefined();
    await expect(access(inactiveStore.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
