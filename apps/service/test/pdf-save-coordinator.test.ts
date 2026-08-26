import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PdfWriterError, type PdfWriter } from "../../../packages/core/src/pdf-writer.js";
import { inspectProjectedPortableAnnotation } from "../../../packages/core/src/portable-annotation.js";
import type { ReviewCommand, ReviewItem, ReviewState } from "../../../packages/core/src/review-model.js";
import { PdfSaveCoordinator } from "../src/saving/pdf-save-coordinator.js";
import { SessionBroker } from "../src/sessions/session-broker.js";
import type { DestinationPicker } from "../src/host/destination-picker.js";
import type { PdfExportVerifier } from "../src/export/pdf-verifier.js";
import { DraftSnapshotStore, reviewStateDigest } from "../src/recovery/draft-snapshot.js";

const roots: string[] = [];
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

afterEach(async () => {
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
  });
  const opened = await broker.openReview({ pdfPath: source });
  if (opened.kind !== "opened") throw new Error("expected opened session");
  const coordinator = new PdfSaveCoordinator({
    broker,
    writer: options.writer ?? fakeWriter(),
    verify: verifyIds,
    ...(picker === undefined ? {} : { picker }),
  });
  return { root, source, original, broker, coordinator, sessionId: opened.launch.sessionId };
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

function withSegmentCount(item: ReviewItem, count: number): ReviewItem {
  return {
    ...item,
    payload: {
      ...item.payload,
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
      for (const annotation of request.annotations) {
        expect(inspectProjectedPortableAnnotation(annotation)).toMatchObject({ status: "owned" });
      }
      return delegate.write(request);
    },
  };
}

describe("coalescing PDF autosave", () => {
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

  it("resumes and saves a legacy recovery draft above the new-authoring segment limit", async () => {
    const { root, source, broker, coordinator, sessionId } = await setup(undefined, {
      writer: portableCheckingWriter(),
    });
    const copy = join(root, "paper-annotated.pdf");
    await coordinator.chooseCopy(sessionId, copy);
    await broker.acceptMutation(sessionId, addLongHighlight(0));
    const current = broker.state(sessionId)!;
    const legacyItem = withSegmentCount(current.items[0]!, 129);
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

    expect(restarted.state(sessionId)?.items[0]?.payload.segmentRects).toHaveLength(129);
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
