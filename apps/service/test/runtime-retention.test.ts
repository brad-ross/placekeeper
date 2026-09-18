import { addPageNote, setAnnotationName } from "../../../packages/core/src/review-commands.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeRuntimeOperationJournal } from "../src/browser/chrome-runtime.js";
import { ChromeServiceRuntimeBackend } from "../src/browser/chrome-runtime-backend.js";
import { BrowserSourceStore } from "../src/browser/browser-source-store.js";
import { ChromeTransferStore } from "../src/browser/chrome-handoff.js";
import { SessionBroker } from "../src/sessions/session-broker.js";
import { PdfSaveCoordinator } from "../src/saving/pdf-save-coordinator.js";
import { ExportCoordinator } from "../src/export/export-coordinator.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-canonical-retention-"));
  directories.push(root);
  const pdfPath = join(root, "paper.pdf");
  await writeFile(pdfPath, "%PDF-1.7\nretention fixture\n%%EOF");
  const browserSources = await BrowserSourceStore.create(join(root, "browser-sources"));
  const transferStore = await ChromeTransferStore.create({ root: browserSources.root, validate: async () => {} });
  const chooseFolder = vi.fn(async () => root);
  const create = () => {
    const broker = new SessionBroker({ recoveryRoot: join(root, "recovery"), portableReader: async () => [] });
    const writer = { write: async (): Promise<never> => { throw new Error("Unexpected PDF write"); } };
    const saving = new PdfSaveCoordinator({
      broker, writer, picker: { chooseFolder, locatePdf: async () => undefined },
    });
    const exporting = new ExportCoordinator({ writer, capabilities: broker.capabilities });
    const backend = new ChromeServiceRuntimeBackend({ broker, browserSources, transferStore, saving, exporting, downloadFolder: async () => join(root, "downloads") });
    const authority = backend.authority();
    const stage = async (remote = false) => {
      const sink = await authority.begin({
        sourceIdentity: "a".repeat(64),
        ...(remote ? { disposition: "remote-temporary" as const } : { disposition: "local" as const, fileUrl: pathToFileURL(pdfPath).href }),
      });
      if (remote) await sink.append(await readFile(pdfPath));
      if (remote) {
        const bytes = await readFile(pdfPath);
        return sink.finish({ sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength });
      }
      return sink.finish();
    };
    return { broker, backend, authority, stage, saving };
  };
  return { root, create, chooseFolder, ...create() };
}

describe("canonical review retention", () => {
  it.each([false, true])("returns usable download defaults through Chrome (remote: %s)", async (remote) => {
    const data = await runtimeFixture();
    await mkdir(join(data.root, "downloads"));
    const staged = await data.stage(remote);
    if ("choose" in staged) throw new Error("Expected initial review");
    await data.authority.activate(staged.canonicalKey, "presentation");
    const proposal = await data.authority.invoke(staged.canonicalKey, "saveProposal", undefined,
      { payloadDigest: "a".repeat(64) }) as { filename: string; folderSelectionId: string };
    expect(proposal).toMatchObject({ filename: remote ? "Browser PDF.pdf" : "paper.pdf",
      folder: join(data.root, "downloads"), folderSelectionId: expect.any(String) });
    const save = vi.spyOn(data.saving, "requestSave").mockResolvedValue(undefined);
    await data.authority.invoke(staged.canonicalKey, "chooseCopy", {
      filename: proposal.filename, folderSelectionId: proposal.folderSelectionId,
    }, { idempotencyKey: "default-save", payloadDigest: "b".repeat(64) });
    expect(data.broker.saveStatus(staged.projection.sessionId)?.destination).toMatchObject({
      phase: "active", kind: "copy", targetPath: join(await realpath(join(data.root, "downloads")), proposal.filename),
    });
    save.mockRestore();
  });

  it.each(["chooseCopy", "chooseOriginal"] as const)("returns accepted and rejected name confirmations through Chrome %s", async (method) => {
    const data = await runtimeFixture();
    const staged = await data.stage();
    if ("choose" in staged) throw new Error("Expected initial review");
    await data.authority.activate(staged.canonicalKey, "presentation");
    const sessionId = staged.projection.sessionId;
    const before = data.broker.state(sessionId)!;
    // Serialization is covered by writer conformance; this fixture owns the
    // real Chrome authority, destination transaction, and response path.
    const save = vi.spyOn(data.saving, "requestSave").mockResolvedValue(undefined);
    const folder = await data.saving.chooseFolder(sessionId);
    if (folder.cancelled) throw new Error("Expected selected folder");
    const destination = method === "chooseCopy"
      ? { filename: "named.pdf", folderSelectionId: folder.selectionId } : {};
    const invoke = (annotationName: string, operation: string) => data.authority.invoke(staged.canonicalKey, method, {
      ...destination,
      confirmation: { command: setAnnotationName(before, annotationName), expectedGeneration: before.workflow.documentGeneration },
    }, { idempotencyKey: operation, payloadDigest: createHash("sha256").update(operation).digest("hex") });
    const rejected = await invoke("x".repeat(100_000), "reject-name");
    expect(rejected).toMatchObject({ destination: { phase: "none" }, nameResult: { accepted: false, state: before } });
    expect(data.broker.state(sessionId)).toEqual(before);
    expect(save).not.toHaveBeenCalled();
    await expect(readFile(join(data.root, "named.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
    const accepted = await invoke("Brad Ross", "accept-name");
    expect(accepted).toMatchObject({ destination: { phase: "active" }, nameResult: { revision: 1, annotationName: "Brad Ross" } });
    expect(data.broker.state(sessionId)).toMatchObject({ revision: 1, annotationName: "Brad Ross" });
    expect(save).toHaveBeenCalledExactlyOnceWith(sessionId);
    // Durable operation replay must preserve the accepted response without
    // consuming the folder capability or applying the confirmation twice.
    await expect(invoke("Brad Ross", "accept-name")).resolves.toEqual(accepted);
    expect(save).toHaveBeenCalledTimes(1);
    save.mockRestore();
  });

  it("starts automatic PDF saving after native commands without blocking the edit response", async () => {
    const data = await runtimeFixture();
    const staged = await data.stage();
    if ("choose" in staged) throw new Error("Expected initial review");
    await data.authority.activate(staged.canonicalKey, "presentation");
    const sessionId = staged.projection.sessionId;
    const state = data.broker.state(sessionId)!;
    await data.broker.establishSaveDestination(sessionId, {
      kind: "original", targetPath: join(data.root, "paper.pdf"),
      capabilityId: state.source.fileId, fingerprint: state.source.digest,
    });
    const save = Promise.withResolvers<void>();
    const requestSave = vi.spyOn(data.saving, "requestSave").mockReturnValue(save.promise);
    try {
      const command = addPageNote(state, 0, { x: 10, y: 10, width: 10, height: 10 }, "Review this page");
      await expect(data.authority.invoke(staged.canonicalKey, "command", command, {
        idempotencyKey: "add-note-operation", payloadDigest: "a".repeat(64),
      })).resolves.toMatchObject({ revision: 1 });
      await expect(data.authority.invoke(staged.canonicalKey, "command", command, {
        idempotencyKey: "add-note-operation", payloadDigest: "a".repeat(64),
      })).resolves.toMatchObject({ revision: 1 });
      expect(requestSave).toHaveBeenCalledExactlyOnceWith(sessionId);
      await expect(data.authority.invoke(staged.canonicalKey, "command", {
        type: "undo", expectedRevision: 1,
      }, { idempotencyKey: "undo-note-operation", payloadDigest: "b".repeat(64) }))
        .resolves.toMatchObject({ revision: 2 });
      expect(requestSave).toHaveBeenCalledTimes(2);
    } finally { save.resolve(); }
  });

  it("retains detached reviews for replay and clears all canonical state on explicit finish", async () => {
    const data = await runtimeFixture();
    const staged = await data.stage();
    if ("choose" in staged) throw new Error("Expected initial review");
    await data.authority.activate(staged.canonicalKey, "presentation-one");
    await data.authority.activate(staged.canonicalKey, "presentation-two");
    const operation = { idempotencyKey: "choose-folder-operation", payloadDigest: "d".repeat(64) };
    const first = await data.authority.invoke(staged.canonicalKey, "chooseFolder", {}, operation);
    await data.authority.detach(staged.canonicalKey, "presentation-one");
    await data.authority.detach(staged.canonicalKey, "presentation-two");
    await expect(data.authority.invoke(staged.canonicalKey, "chooseFolder", {}, operation)).resolves.toEqual(first);
    expect(data.chooseFolder).toHaveBeenCalledOnce();
    const directory = join(data.broker.recoveryRoot, staged.projection.sessionId);
    expect((await readdir(directory)).filter((name) => name.startsWith(".chrome-operation-"))).toHaveLength(1);

    await data.broker.finish(staged.projection.sessionId);
    expect(data.backend.retentionStatus()).toEqual({ records: 0, indexedReviews: 0, activated: 0, presentations: 0, provisionals: 0, cachedOperations: 0 });
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(data.authority.invoke(staged.canonicalKey, "chooseFolder", {}, operation)).rejects.toThrow("canonical-review-unavailable");

    const reopened = await data.stage();
    if ("choose" in reopened) throw new Error("Expected new review");
    expect(reopened.canonicalKey).not.toBe(staged.canonicalKey);
    await data.authority.activate(reopened.canonicalKey, "new-presentation");
    await expect(data.authority.invoke(staged.canonicalKey, "chooseFolder", {}, operation)).rejects.toThrow("canonical-review-unavailable");
    await data.broker.discard(reopened.projection.sessionId);
  });

  it("keeps protected retry evidence across shutdown and explicit recovery", async () => {
    const data = await runtimeFixture();
    const staged = await data.stage();
    if ("choose" in staged) throw new Error("Expected initial review");
    await data.authority.activate(staged.canonicalKey, "presentation");
    const operation = { idempotencyKey: "choose-folder-operation", payloadDigest: "d".repeat(64) };
    const result = await data.authority.invoke(staged.canonicalKey, "chooseFolder", {}, operation);
    await data.broker.quiesceForShutdown();
    expect(data.backend.retentionStatus().records).toBe(0);
    const restarted = data.create();
    const offer = await restarted.stage();
    if (!("choose" in offer)) throw new Error("Expected protected recovery offer");
    const resumed = await offer.choose("resume", "recovery-operation-12345");
    expect(resumed.projection.sessionId).toBe(staged.projection.sessionId);
    await restarted.authority.activate(resumed.canonicalKey, "resumed-presentation");
    await expect(restarted.authority.invoke(resumed.canonicalKey, "chooseFolder", {}, operation)).resolves.toEqual(result);
    expect(data.chooseFolder).toHaveBeenCalledOnce();
    await restarted.broker.discard(resumed.projection.sessionId);
  });

  it("clears the remote canonical index across repeated activate/detach/discard cycles", async () => {
    const data = await runtimeFixture();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const staged = await data.stage(true);
      if ("choose" in staged) throw new Error("Expected initial remote review");
      await data.authority.activate(staged.canonicalKey, "presentation");
      expect(data.backend.retentionStatus().indexedReviews).toBe(1);
      await data.authority.detach(staged.canonicalKey, "presentation");
      expect(data.backend.retentionStatus().records).toBe(1);
      await data.broker.discard(staged.projection.sessionId);
      expect(data.backend.retentionStatus()).toEqual({ records: 0, indexedReviews: 0, activated: 0, presentations: 0, provisionals: 0, cachedOperations: 0 });
    }
  });

  it("does not restore activation leases after the broker ends a review during projection", async () => {
    const data = await runtimeFixture();
    const staged = await data.stage();
    if ("choose" in staged) throw new Error("Expected initial review");
    const scope = await data.broker.sessionScope(staged.projection.sessionId);
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    vi.spyOn(data.broker, "sessionScope").mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return scope;
    });
    const activation = data.authority.activate(staged.canonicalKey, "late-presentation");
    const rejected = expect(activation).rejects.toThrow("canonical-review-unavailable");
    await started.promise;
    await data.broker.discard(staged.projection.sessionId);
    release.resolve();
    await rejected;
    expect(data.backend.retentionStatus()).toEqual({ records: 0, indexedReviews: 0, activated: 0, presentations: 0, provisionals: 0, cachedOperations: 0 });
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-operation-retention-"));
  directories.push(root);
  const directory = join(root, "review-session");
  await mkdir(directory);
  let active = true;
  const scope = () => {
    if (!active) throw new Error("canonical-review-unavailable");
    return { directory, prefix: "chrome" as const, legacyCanonicalKey: "legacy-canonical" };
  };
  return {
    root, directory, scope,
    end: () => { active = false; },
    journal: () => new ChromeRuntimeOperationJournal({ root: join(root, "legacy"), scope, maxCachedOperations: 2 }),
  };
}

describe("runtime journal retention", () => {
  it("bounds memory using durable replay while retaining the complete retry history", async () => {
    const data = await fixture();
    const journal = data.journal();
    const effect = vi.fn(async () => ({ revision: 1 }));
    for (let index = 0; index < 6; index += 1) {
      await journal.commit("canonical:session", `operation-${index}`, { index }, effect);
    }
    expect(journal.retentionStatus()).toEqual({ cachedOperations: 2, admissions: 0 });
    expect(await readdir(data.directory)).toHaveLength(6);
    await expect(journal.commit("canonical:session", "operation-0", { index: 0 }, effect))
      .resolves.toEqual({ revision: 1 });
    expect(effect).toHaveBeenCalledTimes(6);
    await expect(journal.commit("canonical:session", "operation-0", { index: 1 }, effect))
      .rejects.toThrow("idempotency-conflict");
    expect(journal.retentionStatus().cachedOperations).toBe(2);
  });

  it.each(["completed", "pending", "conflict"] as const)("preserves %s replay evidence when pending work fills the cache", async (status) => {
    const data = await fixture();
    const journal = new ChromeRuntimeOperationJournal({ scope: data.scope, maxCachedOperations: 1 });
    const stem = createHash("sha256").update("canonical:session\0replay").digest("hex");
    await writeFile(join(data.directory, `.chrome-operation-${stem}.json`), JSON.stringify({
      schemaVersion: 1,
      fingerprint: createHash("sha256").update(status === "conflict" ? "null" : "{}").digest("hex"),
      status: status === "pending" ? "pending" : "completed",
      result: { revision: 1 },
    }));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = journal.commit("canonical:session", "active", {}, async () => {
      started.resolve();
      await release.promise;
      return { accepted: true };
    });
    await started.promise;
    const effect = vi.fn(async () => ({ revision: 2 }));
    try {
      const replay = journal.commit("canonical:session", "replay", {}, effect);
      if (status === "completed") await expect(replay).resolves.toEqual({ revision: 1 });
      else await expect(replay).rejects.toThrow(status === "pending" ? "operation-outcome-unknown" : "idempotency-conflict");
      expect(effect).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending;
    }
  });

  it("replays after shutdown but rejects terminal sessions and never recreates their directories", async () => {
    const data = await fixture();
    const effect = vi.fn(async () => ({ accepted: true }));
    const journal = data.journal();
    await journal.commit("canonical:session", "operation", {}, effect);
    journal.releaseCanonical("canonical:session");
    expect(journal.retentionStatus()).toEqual({ cachedOperations: 0, admissions: 0 });
    const restarted = data.journal();
    await expect(restarted.commit("canonical:session", "operation", {}, effect)).resolves.toEqual({ accepted: true });
    expect(effect).toHaveBeenCalledOnce();

    data.end();
    restarted.releaseCanonical("canonical:session");
    await rm(data.directory, { recursive: true });
    await expect(restarted.commit("canonical:session", "operation", {}, effect)).rejects.toThrow("canonical-review-unavailable");
    await expect(readdir(data.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(effect).toHaveBeenCalledOnce();
  });

  it("does not restore records after session end while an operation is in flight", async () => {
    const data = await fixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const journal = data.journal();
    const pending = journal.commit("canonical:session", "operation", {}, async () => {
      started.resolve();
      await release.promise;
      return { accepted: true };
    });
    const rejected = expect(pending).rejects.toThrow("canonical-review-unavailable");
    await started.promise;
    data.end();
    journal.releaseCanonical("canonical:session");
    await rm(data.directory, { recursive: true });
    release.resolve();
    await rejected;
    expect(journal.retentionStatus()).toEqual({ cachedOperations: 0, admissions: 0 });
    await expect(readdir(data.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["completed", "pending"] as const)("migrates legacy %s evidence without repeating a side effect", async (status) => {
    const data = await fixture();
    const root = join(data.root, "legacy");
    await mkdir(root);
    const key = "legacy-canonical\0operation";
    const legacyPath = join(root, `${createHash("sha256").update(key).digest("hex")}.json`);
    await writeFile(legacyPath, JSON.stringify({
      schemaVersion: 1, fingerprint: createHash("sha256").update("{}").digest("hex"),
      status, ...(status === "completed" ? { result: { revision: 1 } } : {}),
    }));
    const effect = vi.fn(async () => ({ revision: 2 }));
    const result = data.journal().commit("canonical:session", "operation", {}, effect);
    if (status === "completed") await expect(result).resolves.toEqual({ revision: 1 });
    else await expect(result).rejects.toThrow("operation-outcome-unknown");
    expect(effect).not.toHaveBeenCalled();
    expect(await readdir(data.directory)).toHaveLength(1);
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    const replay = data.journal().commit("canonical:session", "operation", {}, effect);
    if (status === "completed") await expect(replay).resolves.toEqual({ revision: 1 });
    else await expect(replay).rejects.toThrow("operation-outcome-unknown");
    expect(effect).not.toHaveBeenCalled();
  });
});
