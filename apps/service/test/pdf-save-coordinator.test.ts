import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { PdfWriter } from "../../../packages/core/src/pdf-writer.js";
import type { ReviewCommand } from "../../../packages/core/src/review-model.js";
import { PdfSaveCoordinator } from "../src/saving/pdf-save-coordinator.js";
import { SessionBroker } from "../src/sessions/session-broker.js";
import type { DestinationPicker } from "../src/host/destination-picker.js";

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
  const root = await mkdtemp(join(tmpdir(), "pdf-markup-save-"));
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
    verify: async ({ annotations }) => ({
      pageCount: 1,
      annotationIds: annotations.map(({ id }) => id),
    }),
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

describe("coalescing PDF autosave", () => {
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
    await broker.acceptMutation(sessionId, add(1));
    const latestSave = coordinator.requestSave(sessionId);
    release.resolve();
    await Promise.all([firstSave, latestSave]);

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
});
