import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setAnnotationName } from "../../../packages/core/src/review-commands.js";
import { PdfWriterError, type PdfWriter } from "../../../packages/core/src/pdf-writer.js";
import { inspectProjectedPortableAnnotations } from "../../../packages/core/src/portable-annotation.js";
import type { ReviewCommand, ReviewItem, ReviewState } from "../../../packages/core/src/review-model.js";
import { PdfSaveCoordinator } from "../src/saving/pdf-save-coordinator.js";
import { SessionBroker } from "../src/sessions/session-broker.js";
import { BrowserSourceStore } from "../src/browser/browser-source-store.js";
import type { DestinationPicker } from "../src/host/destination-picker.js";
import { PdfVerificationError, type PdfExportVerifier } from "../src/export/pdf-verifier.js";
import { DraftSnapshotStore, reviewStateDigest } from "../src/recovery/draft-snapshot.js";

const roots: string[] = [];
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function fakeWriter(beforeWrite: (writeNumber: number) => Promise<void> = async () => {}): PdfWriter {
  let writeNumber = 0;
  return {
    assess: async () => ({ eligible: true }),
    write: async (request) => {
      await beforeWrite(writeNumber++);
      const pdfBytes = new TextEncoder().encode(
        `%PDF-1.7\nitems:${request.annotations.map(({ id }) => id).join(",")}\n%%EOF`,
      );
      return {
        pdfBytes,
        evidence: {
          backend: "embedpdf",
          backendVersion: "test",
          originalSha256: request.sourceSha256,
          outputSha256: sha(pdfBytes),
          pageCount: 1,
          structurallyValid: true,
          preexistingAnnotationIds: [],
          annotations: request.annotations.map((annotation) => ({
            id: annotation.id,
            subtype: "highlight",
            contents: annotation.contents,
            author: annotation.author,
            flags: ["print"],
            hasNormalAppearance: true,
          })),
        },
      };
    },
  };
}

const verifyIds: PdfExportVerifier = async ({ annotations }) => ({
  pageCount: 1,
  annotationIds: annotations.map(({ id }) => id),
});

async function setup(
  picker?: DestinationPicker,
  options: {
    readonly writer?: PdfWriter;
    readonly rewriteAssessor?: () => Promise<
      | { readonly eligible: true }
      | { readonly eligible: false; readonly code: "permission-denied"; readonly message: string }
    >;
    readonly workflowMode?: "standard" | "generated-output";
    readonly verify?: PdfExportVerifier;
    readonly inspectGeneration?: () => Promise<{
      readonly pageCount: number;
      readonly pages: readonly [];
    }>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-save-"));
  roots.push(root);
  const source = join(root, "paper.pdf");
  const original = new TextEncoder().encode("%PDF-1.7\nsource\n%%EOF");
  await writeFile(source, original);
  const broker = new SessionBroker({
    recoveryRoot: join(root, "recovery"),
    portableReader: async () => [],
    ...(options.rewriteAssessor === undefined ? {} : { rewriteAssessor: options.rewriteAssessor }),
    ...(options.inspectGeneration === undefined ? {} : { inspectGeneration: options.inspectGeneration }),
  });
  const opened = await broker.openReview({
    pdfPath: source,
    ...(options.workflowMode === undefined ? {} : { workflowMode: options.workflowMode }),
  });
  if (opened.kind !== "opened") throw new Error("expected opened session");
  const coordinator = new PdfSaveCoordinator({
    broker,
    writer: options.writer ?? fakeWriter(),
    verify: options.verify ?? verifyIds,
    ...(picker === undefined ? {} : { picker }),
  });
  return { root, source, original, broker, coordinator, sessionId: opened.launch.sessionId };
}

async function setupRemote(picker?: DestinationPicker) {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-remote-save-"));
  roots.push(root);
  const browserRoot = join(root, "browser-sources");
  const recoveryRoot = join(root, "recovery");
  const durableRoot = join(root, "documents");
  await mkdir(durableRoot);
  const bytes = Buffer.from("%PDF-1.7\nremote source\n%%EOF");
  const sourceHandle = randomBytes(24).toString("base64url");
  await mkdir(browserRoot);
  await writeFile(join(browserRoot, `${sourceHandle}.pdf`), bytes, { mode: 0o600 });
  const browserSources = await BrowserSourceStore.create(browserRoot);
  const broker = new SessionBroker({ recoveryRoot, portableReader: async () => [] });
  const opened = await broker.openChromeBrowserSource({
    protocolVersion: 1,
    sourceHandle,
    byteLength: bytes.byteLength,
    sha256: sha(bytes),
    displayName: "Private paper.pdf",
  }, browserSources);
  if (opened.kind !== "opened") throw new Error("expected opened remote session");
  const coordinator = new PdfSaveCoordinator({
    broker,
    writer: fakeWriter(),
    verify: verifyIds,
    ...(picker === undefined ? {} : { picker }),
  });
  return {
    root,
    browserRoot,
    recoveryRoot,
    durableRoot,
    broker,
    coordinator,
    sessionId: opened.launch.sessionId,
  };
}

function add(expectedRevision: number): ReviewCommand {
  const now = "2026-08-11T12:00:00.000Z";
  return {
    type: "add",
    expectedRevision,
    item: {
      id: randomUUID(),
      kind: "highlight",
      pageIndex: 0,
      createdAt: now,
      updatedAt: now,
      payload: {
        quote: "source",
        prefix: "",
        suffix: "",
        rect: { x: 1, y: 1, width: 2, height: 2 },
        segmentRects: [{ x: 1, y: 1, width: 2, height: 2 }],
        reliable: true,
        comment: "note",
      },
    },
  };
}

function addLongHighlight(expectedRevision: number): ReviewCommand {
  const command = add(expectedRevision);
  if (command.type !== "add") throw new Error("Expected an add command");
  return {
    ...command,
    item: {
      ...command.item,
      payload: {
        ...command.item.payload,
        rect: { x: 1, y: 1, width: 2, height: 264 },
        segmentRects: Array.from({ length: 33 }, (_, index) => ({
          x: 1,
          y: 1 + index * 8,
          width: 2,
          height: 8,
        })),
      },
    },
  };
}

function addCrossPage(expectedRevision: number): ReviewCommand {
  const command = add(expectedRevision);
  if (command.type !== "add") throw new Error("Expected an add command");
  const pages = [0, 1, 2].map((pageIndex) => ({
    pageIndex,
    quote: `page ${pageIndex + 1}`,
    prefix: pageIndex === 0 ? "before " : "",
    suffix: pageIndex === 2 ? " after" : "",
    rect: { x: 1, y: 1 + pageIndex * 4, width: 2, height: 2 },
    segmentRects: [{ x: 1, y: 1 + pageIndex * 4, width: 2, height: 2 }],
  }));
  return {
    ...command,
    item: {
      ...command.item,
      payload: {
        ...command.item.payload,
        quote: pages.map(({ quote }) => quote).join("\n"),
        prefix: pages[0]!.prefix,
        suffix: pages[2]!.suffix,
        rect: pages[0]!.rect,
        segmentRects: pages[0]!.segmentRects,
        pages,
        pageBoundaries: [
          { afterPageIndex: 0, separator: "\n" },
          { afterPageIndex: 1, separator: "\n" },
        ],
      },
    },
  };
}

function withSegmentCount(item: ReviewItem, count: number): ReviewItem {
  const { reconciliation: _runtimeReconciliation, ...legacyItem } = item;
  const { pages: _runtimePages, ...legacyPayload } = item.payload;
  return {
    ...legacyItem,
    payload: {
      ...legacyPayload,
      rect: { x: 1, y: 1, width: 2, height: count * 8 },
      segmentRects: Array.from({ length: count }, (_, index) => ({
        x: 1,
        y: 1 + index * 8,
        width: 2,
        height: 8,
      })),
    },
  };
}

async function persistRecoveredState(root: string, sessionId: string, state: ReviewState): Promise<void> {
  const store = new DraftSnapshotStore(join(root, "recovery", sessionId));
  const recovered = await store.recover();
  if (recovered === undefined) throw new Error("Expected persisted recovery draft");
  await store.persist({
    ...recovered,
    state,
    sync: {
      ...recovered.sync,
      desiredRevision: state.revision,
      desiredDigest: reviewStateDigest(state),
    },
  });
}

function portableCheckingWriter(): PdfWriter {
  const delegate = fakeWriter();
  return {
    ...delegate,
    write: async (request) => {
      expect(inspectProjectedPortableAnnotations(request.annotations))
        .toMatchObject(request.annotations.length === 0 ? { status: "foreign" } : { status: "owned" });
      return delegate.write(request);
    },
  };
}

describe("coalescing PDF autosave", () => {
  it("fails portable reopen without activating an empty replacement state", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-portable-import-"));
    roots.push(root);
    const source = join(root, "paper.pdf");
    await writeFile(source, "%PDF-1.7\ncorrupt grouped metadata\n%%EOF");
    const broker = new SessionBroker({
      recoveryRoot: join(root, "recovery"),
      portableReader: async () => {
        throw Object.assign(new Error("Incomplete portable group"), {
          code: "invalid-portable-annotation",
        });
      },
    });

    await expect(broker.openReview({ pdfPath: source }))
      .rejects.toMatchObject({ code: "invalid-portable-annotation" });
    expect(broker.activity()).toEqual({
      reviewPresence: 0,
      codexTasks: 0,
      transientWork: 0,
    });
  });

  it("rejects an invalid destination name before creating a copy and permits the same folder retry", async () => {
    let writes = 0;
    const { root, broker, coordinator, sessionId } = await setup({
      chooseFolder: async () => root,
      locatePdf: async () => undefined,
    }, { writer: fakeWriter(async () => { writes += 1; }) });
    await broker.acceptMutation(sessionId, addCrossPage(0));
    const before = broker.state(sessionId)!;
    const folder = await coordinator.chooseFolder(sessionId);
    if (folder.cancelled) throw new Error("expected folder");
    const confirmation = {
      command: setAnnotationName(before, "x".repeat(100_000)),
      expectedGeneration: before.workflow.documentGeneration,
    };
    await expect(coordinator.chooseCopyFilename(sessionId, "named.pdf", folder.selectionId, confirmation))
      .rejects.toThrow();
    expect(writes).toBe(0);
    expect(broker.state(sessionId)).toEqual(before);
    expect(broker.saveStatus(sessionId)?.destination.phase).toBe("none");
    await expect(stat(join(root, "named.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
    await coordinator.chooseCopyFilename(sessionId, "named.pdf", folder.selectionId, {
      ...confirmation, command: setAnnotationName(before, "Brad Ross"),
    });
    expect(writes).toBe(1);
    expect(broker.state(sessionId)?.annotationName).toBe("Brad Ross");
  });

  it.each(["copy", "original"] as const)("writes the confirmed name in the first %s snapshot", async (kind) => {
    const authors: string[][] = [];
    const delegate = fakeWriter();
    const { root, broker, coordinator, sessionId } = await setup(undefined, { writer: {
      ...delegate, write: async (request) => {
        authors.push(request.annotations.map(({ author }) => author));
        return delegate.write(request);
      },
    } });
    await broker.acceptMutation(sessionId, addCrossPage(0));
    const state = broker.state(sessionId)!;
    const confirmation = { command: setAnnotationName(state, "Brad Ross"), expectedGeneration: state.workflow.documentGeneration };
    if (kind === "copy") await coordinator.chooseCopy(sessionId, join(root, "named.pdf"), confirmation);
    else await coordinator.chooseOriginal(sessionId, confirmation);
    expect(authors).toEqual([["Brad Ross", "Brad Ross", "Brad Ross"]]);
  });

  it.each(["revision", "generation"] as const)("rejects stale %s destination confirmation without creating output", async (fence) => {
    let writes = 0;
    const { root, broker, coordinator, sessionId } = await setup(undefined, { writer: fakeWriter(async () => { writes += 1; }) });
    const before = broker.state(sessionId)!;
    const confirmation = { command: { ...setAnnotationName(before, "Brad Ross"), expectedRevision: fence === "revision" ? 9 : before.revision },
      expectedGeneration: fence === "generation" ? 9 : before.workflow.documentGeneration };
    await expect(coordinator.chooseCopy(sessionId, join(root, "stale.pdf"), confirmation)).rejects.toThrow();
    expect(writes).toBe(0);
    expect(broker.state(sessionId)).toEqual(before);
    expect(broker.saveStatus(sessionId)?.destination.phase).toBe("none");
    await expect(stat(join(root, "stale.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not commit a name when the copy destination already exists", async () => {
    const { root, broker, coordinator, sessionId } = await setup();
    const before = broker.state(sessionId)!;
    const target = join(root, "existing.pdf");
    await writeFile(target, "Existing content");
    await expect(coordinator.chooseCopy(sessionId, target, { command: setAnnotationName(before, "Brad Ross"),
      expectedGeneration: before.workflow.documentGeneration })).rejects.toThrow();
    expect(broker.state(sessionId)).toEqual(before);
    expect(broker.saveStatus(sessionId)?.destination.phase).toBe("none");
    expect(await readFile(target, "utf8")).toBe("Existing content");
  });

  it("keeps both name and destination unchanged when recovery persistence fails, then retries", async () => {
    let writes = 0;
    const { root, broker, coordinator, sessionId } = await setup(undefined, { writer: fakeWriter(async () => { writes += 1; }) });
    const before = broker.state(sessionId)!;
    const confirmation = { command: setAnnotationName(before, "Brad Ross"), expectedGeneration: before.workflow.documentGeneration };
    const persist = vi.spyOn(DraftSnapshotStore.prototype, "persist").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(coordinator.chooseCopy(sessionId, join(root, "retry.pdf"), confirmation)).rejects.toThrow("disk unavailable");
    expect(broker.state(sessionId)).toEqual(before);
    expect(broker.saveStatus(sessionId)?.destination.phase).toBe("none");
    expect(writes).toBe(0);
    persist.mockRestore();
    await coordinator.chooseCopy(sessionId, join(root, "retry.pdf"), confirmation);
    expect(writes).toBe(1);
    expect(broker.state(sessionId)?.annotationName).toBe("Brad Ross");
  });

  it("returns the accepted name revision even if another mutation arrives during output", async () => {
    let mutate: (() => Promise<void>) | undefined;
    const { root, broker, coordinator, sessionId } = await setup(undefined, { writer: fakeWriter(async (write) => {
      if (write === 0) await mutate?.();
    }) });
    const before = broker.state(sessionId)!;
    mutate = async () => { await broker.acceptMutation(sessionId, setAnnotationName(broker.state(sessionId)!, "Later name")); };
    const accepted = await coordinator.chooseCopy(sessionId, join(root, "revision.pdf"), {
      command: setAnnotationName(before, "Brad Ross"), expectedGeneration: before.workflow.documentGeneration,
    });
    expect(accepted).toMatchObject({ revision: 1, annotationName: "Brad Ross" });
    expect(broker.state(sessionId)).toMatchObject({ revision: 2, annotationName: "Later name" });
  });

  it("saves a name-only revision to the active destination without changing item dates", async () => {
    const authors: string[][] = [];
    const delegate = fakeWriter();
    const writer: PdfWriter = { ...delegate, write: async (request) => {
      authors.push(request.annotations.map(({ author }) => author));
      return delegate.write(request);
    } };
    const { root, broker, coordinator, sessionId } = await setup(undefined, { writer });
    await coordinator.chooseCopy(sessionId, join(root, "named.pdf"));
    await broker.acceptMutation(sessionId, addCrossPage(0));
    await coordinator.requestSave(sessionId);
    const before = broker.state(sessionId)!;
    await broker.acceptMutation(sessionId, setAnnotationName(before, "Brad Ross"));
    expect(broker.saveStatus(sessionId)?.sync).toMatchObject({ desiredRevision: 2, savedRevision: 1 });
    expect(broker.saveStatus(sessionId)?.sync.desiredDigest).not.toBe(broker.saveStatus(sessionId)?.sync.savedDigest);
    await coordinator.requestSave(sessionId);
    expect(authors.at(-1)).toEqual(["Brad Ross", "Brad Ross", "Brad Ross"]);
    expect(broker.state(sessionId)?.items).toEqual(before.items);
    expect(broker.saveStatus(sessionId)?.sync).toMatchObject({ phase: "clean", savedRevision: 2 });
  });

  it.each(["copy", "original"] as const)(
    "persists one cross-page item as a complete three-child group to the %s destination",
    async (destination) => {
      const { root, source, broker, coordinator, sessionId } = await setup(undefined, {
        writer: portableCheckingWriter(),
      });
      const copy = join(root, "paper-annotated.pdf");
      if (destination === "copy") await coordinator.chooseCopy(sessionId, copy);
      else await coordinator.chooseOriginal(sessionId);

      await broker.acceptMutation(sessionId, addCrossPage(0));
      await coordinator.requestSave(sessionId);

      const itemId = broker.state(sessionId)!.items[0]!.id;
      const contents = await readFile(destination === "copy" ? copy : source, "utf8");
      expect(contents).toContain(`${itemId}:projection:1`);
      expect(contents).toContain(`${itemId}:projection:2`);
      expect(contents).toContain(`${itemId}:projection:3`);
      expect((await broker.freezeDelivery(sessionId)).items).toHaveLength(1);
      expect(broker.saveStatus(sessionId)?.sync).toMatchObject({
        phase: "clean",
        savedRevision: 1,
      });
    },
  );

  it("keeps the prior saved PDF and complete semantic item when group verification fails", async () => {
    const verify: PdfExportVerifier = async (input) => {
      if (input.annotations.length > 0) {
        throw new PdfVerificationError("Portable projection group is incomplete.");
      }
      return verifyIds(input);
    };
    const { root, broker, coordinator, sessionId } = await setup(undefined, {
      writer: portableCheckingWriter(),
      verify,
    });
    const copy = join(root, "paper-annotated.pdf");
    await coordinator.chooseCopy(sessionId, copy);
    const before = await readFile(copy);

    await broker.acceptMutation(sessionId, addCrossPage(0));
    await coordinator.requestSave(sessionId);

    expect(await readFile(copy)).toEqual(before);
    expect(broker.state(sessionId)?.items).toHaveLength(1);
    expect(broker.state(sessionId)?.items[0]?.payload.pages).toHaveLength(3);
    expect(broker.saveStatus(sessionId)?.sync).toMatchObject({
      phase: "not-saved",
      failure: "verification-failed",
    });
  });

  it("keeps generated output outside autosave and Replace Original paths", async () => {
    const { root, source, original, broker, coordinator, sessionId } = await setup(undefined, {
      workflowMode: "generated-output",
    });
    await expect(coordinator.chooseOriginal(sessionId)).rejects.toThrow(/generated output/iu);
    await expect(coordinator.chooseCopy(sessionId, join(root, "paper-annotated.pdf")))
      .rejects.toThrow(/explicit export/iu);
    await broker.acceptMutation(sessionId, add(0));
    await coordinator.requestSave(sessionId);
    const recovered = await new DraftSnapshotStore(join(root, "recovery", sessionId)).recover();
    expect(recovered?.state.items).toEqual(broker.state(sessionId)?.items);
    expect(await readFile(source)).toEqual(Buffer.from(original));
    expect(broker.saveStatus(sessionId)?.destination.phase).toBe("none");
  });

  it("rejects original, implicit-source, and private recovery destinations for remote sources", async () => {
    const { browserRoot, durableRoot, recoveryRoot, broker, coordinator, sessionId } = await setupRemote();

    expect(coordinator.proposal(sessionId)).toEqual({
      sourceDisposition: "remote-temporary",
    });
    await expect(coordinator.chooseOriginal(sessionId)).rejects.toThrow(/remote browser PDF/u);
    await expect(coordinator.chooseCopyFilename(sessionId, "private-annotated.pdf"))
      .rejects.toThrow(/new location/u);
    await expect(coordinator.chooseCopy(sessionId, join(recoveryRoot, "private.pdf")))
      .rejects.toThrow(/private temporary source/u);
    await expect(coordinator.chooseCopy(sessionId, join(browserRoot, "private.pdf")))
      .rejects.toThrow(/private temporary source/u);
    const forged = await broker.capabilities.preauthorizeDestination(
      join(durableRoot, "forged-original.pdf"),
    );
    await expect(broker.establishSaveDestination(sessionId, {
      kind: "original",
      targetPath: join(forged.parentPath, forged.filename),
      capabilityId: forged.id,
    })).rejects.toThrow(/remote browser PDF/u);
    broker.capabilities.revokeDestination(forged.id);
    expect(broker.saveStatus(sessionId)?.destination).toMatchObject({ phase: "none" });
  });

  it("requires a fresh remote filename and location, then resumes protected autosave", async () => {
    let defaultFolder: string | undefined = "not-called";
    const { durableRoot, broker, coordinator, sessionId } = await setupRemote({
      chooseFolder: async (folder) => {
        defaultFolder = folder;
        return durableRoot;
      },
      locatePdf: async () => undefined,
    });
    await broker.acceptMutation(sessionId, add(0));
    expect(broker.saveStatus(sessionId)?.sync).toMatchObject({
      phase: "not-saved",
      failure: "destination-unconfigured",
    });

    const selected = await coordinator.chooseFolder(sessionId);
    expect(defaultFolder).toBeUndefined();
    if (selected.cancelled) throw new Error("expected remote folder selection");
    await expect(coordinator.chooseCopyFilename(sessionId, "", selected.selectionId))
      .rejects.toThrow(/filename/u);
    await coordinator.chooseCopyFilename(sessionId, "Browser notes.pdf", selected.selectionId);

    expect(await readFile(join(durableRoot, "Browser notes.pdf"), "utf8"))
      .toContain(broker.state(sessionId)!.items[0]!.id);
    expect(broker.saveStatus(sessionId)).toMatchObject({
      destination: { phase: "active", kind: "copy" },
      sync: { phase: "clean", savedRevision: 1 },
    });
  });

  it("retains the existing source-folder proposal and original option for local PDFs", async () => {
    const { root, source, coordinator, sessionId } = await setup();
    expect(coordinator.proposal(sessionId)).toEqual({
      sourceDisposition: "local",
      filename: "paper-annotated.pdf",
      folder: await realpath(dirname(source)),
    });
    await expect(coordinator.chooseOriginal(sessionId)).resolves.toBeUndefined();
    expect(source).toBe(join(root, "paper.pdf"));
  });
  it.each(["copy", "original"] as const)(
    "saves a 33-segment editable highlight to the %s destination",
    async (destination) => {
      const { root, source, broker, coordinator, sessionId } = await setup(undefined, {
        writer: portableCheckingWriter(),
      });
      const copy = join(root, "paper-annotated.pdf");
      if (destination === "copy") await coordinator.chooseCopy(sessionId, copy);
      else await coordinator.chooseOriginal(sessionId);

      await broker.acceptMutation(sessionId, addLongHighlight(0));
      await coordinator.requestSave(sessionId);

      const item = broker.state(sessionId)!.items[0]!;
      expect(await readFile(destination === "copy" ? copy : source, "utf8")).toContain(item.id);
      expect(item.payload.segmentRects).toHaveLength(33);
      expect(broker.saveStatus(sessionId)?.sync).toMatchObject({
        phase: "clean",
        savedRevision: 1,
      });
    },
  );

  it("resumes and saves a recovery draft that already contains a 33-segment highlight", async () => {
    const { root, source, broker, coordinator, sessionId } = await setup(undefined, {
      writer: portableCheckingWriter(),
    });
    const copy = join(root, "paper-annotated.pdf");
    await coordinator.chooseCopy(sessionId, copy);
    await broker.acceptMutation(sessionId, addLongHighlight(0));

    const restarted = new SessionBroker({
      recoveryRoot: join(root, "recovery"),
      portableReader: async () => [],
    });
    const offered = await restarted.openReview({ pdfPath: source });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const resumed = await restarted.openReview({
      pdfPath: source,
      recoveryDecision: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    if (resumed.kind !== "opened") throw new Error("Expected resumed review");
    const resumedCoordinator = new PdfSaveCoordinator({
      broker: restarted,
      writer: portableCheckingWriter(),
      verify: verifyIds,
    });

    expect(restarted.state(resumed.launch.sessionId)?.items[0]?.payload.segmentRects)
      .toHaveLength(33);
    await resumedCoordinator.requestSave(resumed.launch.sessionId);

    const item = restarted.state(resumed.launch.sessionId)!.items[0]!;
    expect(await readFile(copy, "utf8")).toContain(item.id);
    expect(restarted.saveStatus(resumed.launch.sessionId)?.sync).toMatchObject({
      phase: "clean",
      savedRevision: 1,
    });
  });

  it("resumes and saves a recovery draft at the shared segment limit", async () => {
    const { root, source, broker, coordinator, sessionId } = await setup(undefined, {
      writer: portableCheckingWriter(),
    });
    const copy = join(root, "paper-annotated.pdf");
    await coordinator.chooseCopy(sessionId, copy);
    await broker.acceptMutation(sessionId, addLongHighlight(0));
    const current = broker.state(sessionId)!;
    const legacyItem = withSegmentCount(current.items[0]!, 256);
    const legacyState: ReviewState = {
      ...current,
      revision: 7,
      items: [legacyItem],
      history: [{ beforeItems: [], afterItems: [legacyItem] }],
      historyCursor: 1,
    };
    await persistRecoveredState(root, sessionId, legacyState);

    const restarted = new SessionBroker({
      recoveryRoot: join(root, "recovery"),
      portableReader: async () => [],
    });
    const offered = await restarted.openReview({ pdfPath: source });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const resumed = await restarted.openReview({
      pdfPath: source,
      recoveryDecision: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    if (resumed.kind !== "opened") throw new Error("Expected resumed review");
    const resumedCoordinator = new PdfSaveCoordinator({
      broker: restarted,
      writer: portableCheckingWriter(),
      verify: verifyIds,
    });

    expect(restarted.state(sessionId)?.items[0]?.payload.segmentRects).toHaveLength(256);
    expect(restarted.state(sessionId)?.workflow.mode).toBe("standard");
    expect((await restarted.freezeDelivery(sessionId)).annotations).toHaveLength(1);
    await resumedCoordinator.requestSave(sessionId);

    expect(await readFile(copy, "utf8")).toContain(legacyItem.id);
    expect(restarted.saveStatus(sessionId)?.sync).toMatchObject({
      phase: "clean",
      savedRevision: 7,
    });
  });

  it("rejects redo when recovered history would restore unsupported editable metadata", async () => {
    const { root, source, broker, sessionId } = await setup();
    await broker.acceptMutation(sessionId, addLongHighlight(0));
    const current = broker.state(sessionId)!;
    const unsupportedItem = withSegmentCount(current.items[0]!, 257);
    const recoveredState: ReviewState = {
      ...current,
      revision: 7,
      items: [],
      history: [{ beforeItems: [], afterItems: [unsupportedItem] }],
      historyCursor: 0,
    };
    await persistRecoveredState(root, sessionId, recoveredState);

    const restarted = new SessionBroker({
      recoveryRoot: join(root, "recovery"),
      portableReader: async () => [],
    });
    const offered = await restarted.openReview({ pdfPath: source });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const resumed = await restarted.openReview({
      pdfPath: source,
      recoveryDecision: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    if (resumed.kind !== "opened") throw new Error("Expected resumed review");

    await expect(restarted.acceptMutation(sessionId, {
      type: "redo",
      expectedRevision: 7,
    })).rejects.toThrow(
      "This annotation is too complex to preserve as editable metadata. Shorten the selection and try again.",
    );
    expect(restarted.state(sessionId)).toMatchObject({ revision: 7, items: [], historyCursor: 0 });
  });

  it("creates a proactive copy, then persists the complete accepted state", async () => {
    const { root, broker, coordinator, sessionId } = await setup();
    const target = join(root, "paper-annotated.pdf");
    await coordinator.chooseCopy(sessionId, target);
    expect(await readFile(target, "utf8")).toContain("items:");

    await broker.acceptMutation(sessionId, add(0));
    await coordinator.requestSave(sessionId);
    expect(await readFile(target, "utf8")).toContain(broker.state(sessionId)!.items[0]!.id);
    expect(broker.saveStatus(sessionId)?.sync.phase).toBe("clean");
  });

  it("does not rewrite the original until the first accepted annotation", async () => {
    const { source, original, broker, coordinator, sessionId } = await setup();
    await coordinator.chooseOriginal(sessionId);
    expect(await readFile(source)).toEqual(Buffer.from(original));

    await broker.acceptMutation(sessionId, add(0));
    await coordinator.requestSave(sessionId);
    expect(await readFile(source, "utf8")).toContain(broker.state(sessionId)!.items[0]!.id);
    expect(broker.saveStatus(sessionId)?.sync).toMatchObject({ phase: "clean", savedRevision: 1 });
  });

  it("uses opaque native-picker selections and locates a moved save target", async () => {
    let located: string | undefined;
    const picker: DestinationPicker = {
      chooseFolder: async (folder) => folder,
      locatePdf: async () => located,
    };
    const { root, broker, coordinator, sessionId } = await setup(picker);
    const selected = await coordinator.chooseFolder(sessionId);
    if (selected.cancelled) throw new Error("expected selection");
    await expect(
      coordinator.chooseCopyFilename(sessionId, "../escape.pdf", selected.selectionId),
    ).rejects.toThrow("filename");

    const target = join(root, "paper-annotated.pdf");
    await coordinator.chooseCopyFilename(sessionId);
    const moved = join(root, "moved.pdf");
    await rename(target, moved);
    await broker.acceptMutation(sessionId, add(0));
    await coordinator.requestSave(sessionId);
    expect(broker.saveStatus(sessionId)?.sync.phase).toBe("not-saved");
    located = moved;
    await coordinator.locate(sessionId);
    expect(await readFile(moved, "utf8")).toContain(broker.state(sessionId)!.items[0]!.id);
    expect(broker.saveStatus(sessionId)?.sync.phase).toBe("clean");
  });

  it("drains mutations accepted during an in-flight save into the latest complete PDF", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = fakeWriter(async (writeNumber) => {
      if (writeNumber === 1) {
        started.resolve();
        await release.promise;
      }
    });
    const { root, broker, coordinator, sessionId } = await setup(undefined, { writer });
    const target = join(root, "paper-annotated.pdf");
    await coordinator.chooseCopy(sessionId, target);
    await broker.acceptMutation(sessionId, add(0));
    const firstSave = coordinator.requestSave(sessionId);
    await started.promise;
    expect(coordinator.activityCount()).toBe(1);
    const drained = coordinator.drain();
    await broker.acceptMutation(sessionId, add(1));
    const latestSave = coordinator.requestSave(sessionId);
    release.resolve();
    await Promise.all([firstSave, latestSave, drained]);
    expect(coordinator.activityCount()).toBe(0);

    const contents = await readFile(target, "utf8");
    for (const item of broker.state(sessionId)!.items) expect(contents).toContain(item.id);
    expect(broker.saveStatus(sessionId)?.sync).toMatchObject({ phase: "clean", savedRevision: 2 });
  });

  it("lets an in-flight committed save settle clean across draft-only revisions", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = fakeWriter(async (writeNumber) => {
      if (writeNumber === 1) {
        started.resolve();
        await release.promise;
      }
    });
    const { root, broker, coordinator, sessionId } = await setup(undefined, { writer });
    const target = join(root, "paper-annotated.pdf");
    await coordinator.chooseCopy(sessionId, target);
    await broker.acceptMutation(sessionId, add(0));
    const save = coordinator.requestSave(sessionId);
    await started.promise;

    const attachment = broker.replaceInteractionAttachment(sessionId, "attachment-a");
    const interactionToken = "interaction_draft_only_save";
    await broker.beginReviewInteraction({
      sessionId, attachment, generation: 1, interactionToken, order: 1,
    });
    const draftId = randomUUID();
    await broker.acceptMutation(sessionId, {
      type: "put-draft", expectedRevision: 1, expectedDraftRevision: -1,
      draft: {
        id: draftId,
        ownerViewId: attachment.attachmentId,
        baseGeneration: 1,
        revision: 0,
        kind: "pageNote",
        pageIndex: 0,
        text: "temporary draft",
        anchor: {
          kind: "page", pageIndex: 0, nearbyText: "source",
          rect: { x: 1, y: 1, width: 1, height: 1 },
        },
        disposition: { kind: "resolved", generation: 1 },
        status: "protected",
        createdAt: "2026-09-16T09:00:00.000Z",
        updatedAt: "2026-09-16T09:00:00.000Z",
      },
    });
    expect(broker.saveStatus(sessionId)?.sync).toMatchObject({
      phase: "saving", desiredRevision: 1, savedRevision: 0,
    });
    release.resolve();
    await save;
    expect(broker.state(sessionId)).toMatchObject({ revision: 2 });
    expect(broker.saveStatus(sessionId)?.sync).toMatchObject({
      phase: "clean", desiredRevision: 1, savedRevision: 1,
    });
    const receipt = await broker.finalizeReviewInteraction({
      sessionId, attachment, interactionToken, order: 2,
      outcome: "discarded", draftId, expectedDraftRevision: 0,
    });
    expect(receipt).toMatchObject({ status: "finalized", outcome: "discarded", reviewRevision: 3 });
    expect(broker.state(sessionId)).toMatchObject({ revision: 3, pendingDrafts: [] });
    expect(broker.saveStatus(sessionId)?.sync).toMatchObject({
      phase: "clean", desiredRevision: 3, savedRevision: 3,
    });
    await expect(broker.acknowledgeReviewInteraction({
      sessionId, attachment, interactionToken, order: 3,
    })).resolves.toMatchObject({ status: "released" });

    await broker.acceptMutation(sessionId, add(3));
    await coordinator.requestSave(sessionId);
    expect(broker.saveStatus(sessionId)?.sync).toMatchObject({
      phase: "clean", desiredRevision: 4, savedRevision: 4,
    });
    const contents = await readFile(target, "utf8");
    for (const item of broker.state(sessionId)!.items) expect(contents).toContain(item.id);
  }, 15_000);

  it("freezes the committed save target when a draft already advanced review state", async () => {
    let writes = 0;
    const { root, broker, coordinator, sessionId } = await setup(undefined, {
      writer: fakeWriter(async () => { writes += 1; }),
    });
    await coordinator.chooseCopy(sessionId, join(root, "paper-annotated.pdf"));
    expect(writes).toBe(1);
    await broker.acceptMutation(sessionId, add(0));
    const draftId = randomUUID();
    await broker.acceptMutation(sessionId, {
      type: "put-draft", expectedRevision: 1, expectedDraftRevision: -1,
      draft: {
        id: draftId,
        ownerViewId: "attachment-a",
        baseGeneration: 1,
        revision: 0,
        kind: "pageNote",
        pageIndex: 0,
        text: "draft before snapshot capture",
        anchor: {
          kind: "page", pageIndex: 0, nearbyText: "source",
          rect: { x: 1, y: 1, width: 1, height: 1 },
        },
        disposition: { kind: "resolved", generation: 1 },
        status: "protected",
        createdAt: "2026-09-16T09:00:00.000Z",
        updatedAt: "2026-09-16T09:00:00.000Z",
      },
    });

    expect(broker.state(sessionId)?.revision).toBe(2);
    expect(broker.saveStatus(sessionId)?.sync).toMatchObject({
      phase: "saving", desiredRevision: 1, savedRevision: 0,
    });
    await coordinator.requestSave(sessionId);
    expect(writes).toBe(2);
    expect(broker.saveStatus(sessionId)?.sync).toMatchObject({
      phase: "clean", desiredRevision: 1, savedRevision: 1,
    });
    const exportDelivery = await broker.freezeDelivery(sessionId);
    const saveDelivery = await broker.freezeSaveDelivery(sessionId);
    expect(exportDelivery.revision).toBe(2);
    expect(saveDelivery.revision).toBe(1);
    expect(broker.isFrozenDeliveryCurrent(exportDelivery)).toBe(true);
    expect(broker.isFrozenDeliveryCurrent(saveDelivery)).toBe(false);
  });

  it("never lets an old-target completion bless a newly selected destination", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = fakeWriter(async (writeNumber) => {
      if (writeNumber === 1) {
        started.resolve();
        await release.promise;
      }
    });
    const { root, source, broker, coordinator, sessionId } = await setup(undefined, { writer });
    const copy = join(root, "paper-annotated.pdf");
    await coordinator.chooseCopy(sessionId, copy);
    await broker.acceptMutation(sessionId, add(0));
    const oldSave = coordinator.requestSave(sessionId);
    await started.promise;
    const switchTarget = coordinator.chooseOriginal(sessionId);
    release.resolve();
    await Promise.all([oldSave, switchTarget]);

    const id = broker.state(sessionId)!.items[0]!.id;
    expect(await readFile(source, "utf8")).toContain(id);
    expect(await readFile(copy, "utf8")).not.toContain(id);
    expect(broker.saveStatus(sessionId)?.destination).toMatchObject({ kind: "original" });
    expect(broker.saveStatus(sessionId)?.sync.phase).toBe("clean");
  });

  it("does not let a frozen predecessor save overwrite an observed successor", async () => {
    const writerStarted = Promise.withResolvers<void>();
    const releaseWriter = Promise.withResolvers<void>();
    const inspectionStarted = Promise.withResolvers<void>();
    const releaseInspection = Promise.withResolvers<void>();
    const writer = fakeWriter(async (writeNumber) => {
      if (writeNumber === 1) {
        writerStarted.resolve();
        await releaseWriter.promise;
      }
    });
    const { root, source, broker, coordinator, sessionId } = await setup(undefined, {
      writer,
      inspectGeneration: async () => {
        inspectionStarted.resolve();
        await releaseInspection.promise;
        return { pageCount: 1, pages: [] };
      },
    });
    const copy = join(root, "paper-annotated.pdf");
    await coordinator.chooseCopy(sessionId, copy);
    const predecessorCopy = await readFile(copy);
    await broker.acceptMutation(sessionId, add(0));
    const save = coordinator.requestSave(sessionId);
    await writerStarted.promise;

    const successor = Buffer.from("%PDF-1.7\nsuccessor\n%%EOF");
    await writeFile(source, successor);
    const replacement = broker.replaceLiveDocument({
      sessionId,
      outputPath: source,
      observationEpoch: 1,
    });
    await inspectionStarted.promise;
    releaseWriter.resolve();
    await save;
    expect(await readFile(copy)).toEqual(predecessorCopy);
    expect(await readFile(source)).toEqual(successor);

    releaseInspection.resolve();
    await expect(replacement).resolves.toMatchObject({ status: "committed", documentGeneration: 2 });
    await coordinator.drain();
    expect(broker.state(sessionId)?.workflow.documentGeneration).toBe(2);
  });

  it("suppresses only the exact current original self-save digest", async () => {
    const { source, original, broker, coordinator, sessionId } = await setup(undefined, {
      inspectGeneration: async () => ({ pageCount: 1, pages: [] }),
    });
    await coordinator.chooseOriginal(sessionId);
    await broker.acceptMutation(sessionId, add(0));
    await coordinator.requestSave(sessionId);
    const selfSaved = await readFile(source);
    expect(selfSaved).not.toEqual(Buffer.from(original));

    await expect(broker.replaceLiveDocument({
      sessionId,
      outputPath: source,
      observationEpoch: 1,
    })).resolves.toMatchObject({ status: "same-digest", documentGeneration: 1 });

    await writeFile(source, original);
    await expect(broker.replaceLiveDocument({
      sessionId,
      outputPath: source,
      observationEpoch: 2,
    })).resolves.toMatchObject({ status: "committed", documentGeneration: 2 });
    await coordinator.drain();
  });

  it("rewrites an empty later revision and preserves the original file mode", async () => {
    const { root, source, broker, coordinator, sessionId } = await setup();
    await chmod(source, 0o640);
    await coordinator.chooseOriginal(sessionId);
    await broker.acceptMutation(sessionId, add(0));
    await coordinator.requestSave(sessionId);
    const id = broker.state(sessionId)!.items[0]!.id;
    await coordinator.chooseCopy(sessionId, join(root, "paper-annotated.pdf"));
    await broker.acceptMutation(sessionId, { type: "remove", expectedRevision: 1, id });
    await coordinator.requestSave(sessionId);
    await coordinator.chooseOriginal(sessionId);

    expect(await readFile(source, "utf8")).not.toContain(id);
    expect((await stat(source)).mode & 0o777).toBe(0o640);
    expect(broker.saveStatus(sessionId)?.sync.phase).toBe("clean");
  });

  it("rejects every destination before accepting work when the PDF is restricted", async () => {
    const { root, broker, coordinator, sessionId } = await setup(undefined, {
      rewriteAssessor: async () => ({
        eligible: false,
        code: "permission-denied",
        message: "This PDF does not permit annotations.",
      }),
    });
    await expect(coordinator.chooseCopy(sessionId, join(root, "copy.pdf")))
      .rejects.toThrow("does not permit annotations");
    await expect(coordinator.chooseOriginal(sessionId)).rejects.toThrow("does not permit annotations");
    expect(broker.saveStatus(sessionId)).toMatchObject({
      destination: { phase: "none" },
      rewriteEligibility: { eligible: false },
      sync: { phase: "clean" },
    });
  });

  it("classifies invalid annotation geometry as an actionable non-retryable save failure", async () => {
    const writer: PdfWriter = {
      assess: async () => ({ eligible: true }),
      write: async () => {
        throw new PdfWriterError(
          "invalid-annotation-geometry",
          "Annotation is outside the page canvas.",
        );
      },
    };
    const { root, broker, coordinator, sessionId } = await setup(undefined, { writer });
    await coordinator.chooseCopy(sessionId, join(root, "paper-annotated.pdf"));
    await broker.acceptMutation(sessionId, add(0));

    await coordinator.requestSave(sessionId);

    expect(broker.saveStatus(sessionId)?.sync).toMatchObject({
      phase: "not-saved",
      failure: "invalid-annotation-geometry",
    });
  });
});
