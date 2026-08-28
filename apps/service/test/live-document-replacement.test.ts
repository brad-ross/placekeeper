import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionBroker } from "../src/sessions/session-broker.js";
import type { SessionBrokerOptions } from "../src/sessions/session-broker.js";
import type { ReviewItem } from "../../../packages/core/src/review-model.js";
import { reviewSemanticDigest } from "../../../packages/core/src/live-context.js";
import { DraftSnapshotStore } from "../src/recovery/draft-snapshot.js";
import { PdfEvidenceService } from "../src/context/pdf-evidence-service.js";
import { SessionControlRegistry } from "../src/sessions/control-socket.js";

const temporaryDirectories: string[] = [];
const ITEM_IDS = {
  stable: "00000000-0000-4000-8000-000000000001",
  ambiguous: "00000000-0000-4000-8000-000000000002",
  missing: "00000000-0000-4000-8000-000000000003",
  protected: "00000000-0000-4000-8000-000000000004",
  racing: "00000000-0000-4000-8000-000000000005",
  retained: "00000000-0000-4000-8000-000000000006",
} as const;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(options: Partial<SessionBrokerOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "placekeeper-live-replacement-"));
  temporaryDirectories.push(directory);
  const pdfPath = join(directory, "paper.pdf");
  const pdf = async (text: string) => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    document.addPage([320, 240]).drawText(text, { x: 24, y: 180, font, size: 12 });
    return Buffer.from(await document.save({ useObjectStreams: false }));
  };
  const original = await pdf("Original generated output");
  const successor = await pdf("Validated successor output");
  await writeFile(pdfPath, original);
  const broker = new SessionBroker({ recoveryRoot: join(directory, "recovery"), ...options });
  const opened = await broker.openReview({
    pdfPath,
    surface: "vscode",
    workflowMode: "generated-output",
  });
  if (opened.kind !== "opened") throw new Error("Expected a new generated-output review");
  return { broker, directory, pdfPath, original, successor, launch: opened.launch };
}

function selectionItem(id: string, quote: string, prefix = "", suffix = ""): ReviewItem {
  return {
    id,
    kind: "highlight",
    pageIndex: 0,
    createdAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
    payload: {
      quote,
      prefix,
      suffix,
      reliable: true,
      rect: { x: 10, y: 20, width: 30, height: 8 },
      segmentRects: [{ x: 10, y: 20, width: 30, height: 8 }],
      comment: "",
    },
  };
}

describe("atomic live document replacement", () => {
  it("shares one canonical lineage across concurrent opens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "placekeeper-concurrent-open-"));
    temporaryDirectories.push(directory);
    const pdfPath = join(directory, "paper.pdf");
    await writeFile(pdfPath, "%PDF-1.7\ngenerated\n%%EOF");
    const broker = new SessionBroker({
      recoveryRoot: join(directory, "recovery"),
      portableReader: async () => [],
      rewriteAssessor: async () => ({ eligible: true }),
    });

    const [first, second] = await Promise.all([
      broker.openReview({ pdfPath, surface: "vscode", workflowMode: "generated-output" }),
      broker.openReview({ pdfPath, surface: "browser", workflowMode: "generated-output" }),
    ]);

    if (first.kind === "recovery-offered" || second.kind === "recovery-offered") {
      throw new Error("Concurrent clean opens must not offer recovery");
    }
    expect(new Set([first.launch.sessionId, second.launch.sessionId]).size).toBe(1);
    expect([first.kind, second.kind].toSorted()).toEqual(["focused", "opened"]);
  });

  it("marks a bound source save possibly stale without replacing the last successful PDF", async () => {
    const controls = new SessionControlRegistry({ heartbeat: false });
    const invalidated = vi.spyOn(controls, "publishStateInvalidation");
    const value = await fixture({ controls });
    await expect(value.broker.markLiveDocumentPossiblyStale(value.launch.sessionId))
      .resolves.toMatchObject({ status: "possibly-stale", documentGeneration: 1 });
    expect(value.broker.state(value.launch.sessionId)?.workflow.freshness).toBe("possibly-stale");
    expect(value.broker.state(value.launch.sessionId)?.revision).toBe(0);
    await expect(value.broker.documentBytes(value.launch.sessionId)).resolves.toEqual(value.original);
    expect(invalidated).toHaveBeenCalledWith(value.launch.sessionId, {
      documentGeneration: 1,
      reviewRevision: 0,
      reason: "freshness",
    });
  });

  it("lets a newer source-save epoch supersede an older rebuild candidate", async () => {
    const inspection = Promise.withResolvers<{
      pageCount: number;
      pages: readonly { pageIndex: number; text: string }[];
    }>();
    const inspectGeneration = vi.fn(() => inspection.promise);
    const value = await fixture({ inspectGeneration });
    await writeFile(value.pdfPath, value.successor);

    const replacement = value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    });
    await vi.waitFor(() => expect(inspectGeneration).toHaveBeenCalledOnce());
    await value.broker.markLiveDocumentPossiblyStale(value.launch.sessionId, 2);
    inspection.resolve({ pageCount: 1, pages: [{ pageIndex: 0, text: "new" }] });

    await expect(replacement).resolves.toMatchObject({ status: "superseded" });
    expect(value.broker.state(value.launch.sessionId)?.workflow).toMatchObject({
      documentGeneration: 1,
      freshness: "possibly-stale",
    });
    await expect(value.broker.documentBytes(value.launch.sessionId)).resolves.toEqual(value.original);
  });

  it("publishes a bounded same-generation revision invalidation after a human review command", async () => {
    const controls = new SessionControlRegistry({ heartbeat: false });
    const invalidated = vi.spyOn(controls, "publishStateInvalidation");
    const value = await fixture({ controls });

    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: selectionItem(ITEM_IDS.stable, "Original generated output"),
    }, { expectedGeneration: 1 });

    expect(invalidated).toHaveBeenCalledWith(value.launch.sessionId, {
      documentGeneration: 1,
      reviewRevision: 1,
      reason: "revision",
    });
  });

  it("advances the existing output-path lineage instead of reopening by digest", async () => {
    const value = await fixture();
    await writeFile(value.pdfPath, value.successor);

    const transition = await value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    });

    expect(transition).toMatchObject({
      status: "committed",
      sessionId: value.launch.sessionId,
      previousGeneration: 1,
      documentGeneration: 2,
    });
    const joined = await value.broker.openReview({ pdfPath: value.pdfPath, surface: "browser" });
    expect(joined).toMatchObject({
      kind: "focused",
      launch: { sessionId: value.launch.sessionId, documentGeneration: 2 },
    });
    expect(value.broker.exchangeBootstrap(
      value.launch.sessionId,
      value.launch.fragment.slice("#cap=".length),
    )).toBeUndefined();
    await expect(value.broker.documentBytes(value.launch.sessionId)).resolves.toEqual(value.successor);
    await expect(value.broker.documentBytes(value.launch.sessionId, 1)).resolves.toEqual(value.original);
    await expect(value.broker.documentBytes(value.launch.sessionId, 2)).resolves.toEqual(value.successor);
    await expect(value.broker.documentBytes(value.launch.sessionId, 3)).resolves.toBeUndefined();
    await expect(readFile(value.pdfPath)).resolves.toEqual(value.successor);
  });

  it("reconciles every item without changing identity or silently retargeting uncertain anchors", async () => {
    const value = await fixture({
      inspectGeneration: async () => ({
        pageCount: 2,
        pages: [
          {
            pageIndex: 0,
            text: "before stable claim after; repeated claim repeated claim",
            geometry: [{
              charStart: 0,
              glyphs: Array.from(
                "before stable claim after; repeated claim repeated claim",
                (_, index) => ({ x: 40 + index * 5, y: 72, width: 5, height: 9 }),
              ),
            }],
          },
          {
            pageIndex: 1,
            text: "other content",
            geometry: [{
              charStart: 0,
              glyphs: Array.from(
                "other content",
                (_, index) => ({ x: 40 + index * 5, y: 72, width: 5, height: 9 }),
              ),
            }],
          },
        ],
      }),
    });
    let revision = 0;
    for (const item of [
      selectionItem(ITEM_IDS.stable, "stable claim", "before ", " after"),
      selectionItem(ITEM_IDS.ambiguous, "repeated claim"),
      selectionItem(ITEM_IDS.missing, "removed claim"),
    ]) {
      const state = await value.broker.acceptMutation(value.launch.sessionId, {
        type: "add",
        expectedRevision: revision,
        item,
        authoring: { ownerViewId: "panel-a", baseGeneration: 1 },
      });
      revision = state.revision;
    }
    await writeFile(value.pdfPath, value.successor);
    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    })).resolves.toMatchObject({ status: "committed", documentGeneration: 2 });

    const items = value.broker.state(value.launch.sessionId)!.items;
    expect(items.map(({ id }) => id)).toEqual([ITEM_IDS.stable, ITEM_IDS.ambiguous, ITEM_IDS.missing]);
    expect(items.map((item) => item.reconciliation?.disposition.kind)).toEqual([
      "resolved", "ambiguous", "missing",
    ]);
    expect(items[0]?.reconciliation).toMatchObject({
      disposition: { kind: "resolved", generation: 2 },
      anchor: {
        rect: { x: 75, y: 72, width: 60, height: 9 },
        segmentRects: [{ x: 75, y: 72, width: 60, height: 9 }],
      },
      previousAnchors: [{ generation: 1, disposition: { kind: "resolved", generation: 1 } }],
    });
    expect(items[1]?.reconciliation?.anchor).toMatchObject({ quote: "repeated claim", pageIndex: 0 });
    expect(items[2]?.reconciliation?.anchor).toMatchObject({ quote: "removed claim", pageIndex: 0 });
  });

  it("retains the last successful generation and protected state for an invalid candidate", async () => {
    const value = await fixture({ inspectGeneration: async () => { throw new Error("truncated PDF"); } });
    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: selectionItem(ITEM_IDS.protected, "Original"),
      authoring: { ownerViewId: "panel-a", baseGeneration: 1 },
    });
    await writeFile(value.pdfPath, "%PDF-1.7\ntruncated");

    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    })).resolves.toMatchObject({ status: "invalid", documentGeneration: 1 });
    await expect(value.broker.documentBytes(value.launch.sessionId)).resolves.toEqual(value.original);
    expect(value.broker.state(value.launch.sessionId)).toMatchObject({
      workflow: { documentGeneration: 1, freshness: "possibly-stale" },
      items: [{ id: ITEM_IDS.protected }],
    });
  });

  it("lets only the newest rapid candidate publish and fences a racing review mutation", async () => {
    const firstInspection = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    let inspections = 0;
    const value = await fixture({
      inspectGeneration: async () => {
        inspections += 1;
        if (inspections === 1) {
          firstInspection.resolve();
          await releaseFirst.promise;
        }
        return { pageCount: 1, pages: [{ pageIndex: 0, text: "successor" }] };
      },
    });
    await writeFile(value.pdfPath, value.successor);
    const older = value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    });
    await firstInspection.promise;

    const newerBytes = Buffer.concat([value.successor, Buffer.from("\n% newer stable candidate")]);
    await writeFile(value.pdfPath, newerBytes);
    const newer = await value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 2,
    });
    releaseFirst.resolve();
    await expect(older).resolves.toMatchObject({ status: "superseded", documentGeneration: 2 });
    expect(newer).toMatchObject({ status: "committed", documentGeneration: 2 });
    await expect(value.broker.documentBytes(value.launch.sessionId)).resolves.toEqual(newerBytes);

    const thirdBytes = Buffer.concat([newerBytes, Buffer.from("\n% third candidate")]);
    await writeFile(value.pdfPath, thirdBytes);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const guarded = await fixture({
      inspectGeneration: async () => {
        entered.resolve();
        await release.promise;
        return { pageCount: 1, pages: [{ pageIndex: 0, text: "late" }] };
      },
    });
    await writeFile(guarded.pdfPath, guarded.successor);
    const candidate = guarded.broker.replaceLiveDocument({
      sessionId: guarded.launch.sessionId,
      outputPath: guarded.pdfPath,
      observationEpoch: 1,
    });
    await entered.promise;
    await guarded.broker.acceptMutation(guarded.launch.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: selectionItem(ITEM_IDS.racing, "late"),
      authoring: { ownerViewId: "panel-a", baseGeneration: 1 },
    });
    release.resolve();
    await expect(candidate).resolves.toMatchObject({ status: "generation-conflict", documentGeneration: 1 });
    expect(guarded.broker.state(guarded.launch.sessionId)).toMatchObject({
      workflow: { documentGeneration: 1 }, items: [{ id: ITEM_IDS.racing }],
    });
  });

  it("rejects an over-budget successor without evicting the referenced predecessor and recovers it", async () => {
    const value = await fixture({
      maxGenerationCount: 1,
      inspectGeneration: async () => ({ pageCount: 1, pages: [{ pageIndex: 0, text: "new" }] }),
    });
    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "add", expectedRevision: 0, item: selectionItem(ITEM_IDS.retained, "Original"),
      authoring: { ownerViewId: "panel-a", baseGeneration: 1 },
    });
    await writeFile(value.pdfPath, value.successor);
    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    })).resolves.toMatchObject({ status: "retention-rejected", documentGeneration: 1 });
    await value.broker.quiesceForShutdown();

    const restarted = new SessionBroker({ recoveryRoot: join(value.directory, "recovery") });
    const offered = await restarted.openReview({
      pdfPath: value.pdfPath,
      workflowMode: "generated-output",
    });
    expect(offered).toMatchObject({ kind: "recovery-offered", recoverySessionId: value.launch.sessionId });
  });

  it("recovers wholly old when the atomic recovery rename fails and wholly new after commit", async () => {
    let failRename = false;
    const value = await fixture({
      snapshotHooks: {
        beforeFinalRename: () => {
          if (failRename) {
            failRename = false;
            throw new Error("simulated crash before recovery rename");
          }
        },
      },
      inspectGeneration: async () => ({ pageCount: 1, pages: [{ pageIndex: 0, text: "new" }] }),
    });
    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "add", expectedRevision: 0, item: selectionItem(ITEM_IDS.retained, "Original"),
      authoring: { ownerViewId: "panel-a", baseGeneration: 1 },
    });
    await writeFile(value.pdfPath, value.successor);
    failRename = true;
    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId, outputPath: value.pdfPath, observationEpoch: 1,
    })).resolves.toMatchObject({ status: "invalid", documentGeneration: 1 });
    expect((await new DraftSnapshotStore(
      join(value.directory, "recovery", value.launch.sessionId),
    ).recover())?.state.workflow.documentGeneration).toBe(1);

    const newer = Buffer.concat([value.successor, Buffer.from("\n% committed after retry")]);
    await writeFile(value.pdfPath, newer);
    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId, outputPath: value.pdfPath, observationEpoch: 2,
    })).resolves.toMatchObject({ status: "committed", documentGeneration: 2 });
    expect((await new DraftSnapshotStore(
      join(value.directory, "recovery", value.launch.sessionId),
    ).recover())?.state.workflow.documentGeneration).toBe(2);
  });

  it("migrates only the exact active same-output task lease and revokes authority on retarget", async () => {
    const value = await fixture({
      inspectGeneration: async () => ({ pageCount: 1, pages: [{ pageIndex: 0, text: "new" }] }),
    });
    const codex = await value.broker.openReview({ pdfPath: value.pdfPath, surface: "codex" });
    if (codex.kind !== "focused" || codex.launch.bindProof === undefined) throw new Error("Expected Codex focus");
    const capability = codex.launch.fragment.slice("#cap=".length);
    expect(value.broker.taskBindings.claim({
      bindProof: codex.launch.bindProof,
      taskSessionId: "task-a",
      reviewSessionId: value.launch.sessionId,
      documentGeneration: 1,
    }).status).toBe("pending");
    const credential = value.broker.exchangeBootstrap(value.launch.sessionId, capability);
    expect(credential).toBeTypeOf("string");
    const before = value.broker.state(value.launch.sessionId)!;
    expect(value.broker.taskBindings.markVerified("task-a", {
      placekeeperSessionId: value.launch.sessionId,
      documentGeneration: 1,
      source: before.source,
      reviewRevision: before.revision,
      stateDigest: reviewSemanticDigest(before.items),
    })).toBe(true);
    const evidence = new PdfEvidenceService({
      bindings: value.broker.taskBindings,
      loadSource: async () => undefined,
    });
    const oldHandle = evidence.mint({
      taskSessionId: "task-a",
      identity: {
        placekeeperSessionId: value.launch.sessionId,
        documentGeneration: 1,
        source: before.source,
        reviewRevision: before.revision,
        stateDigest: reviewSemanticDigest(before.items),
      },
      pageCount: 1,
      sourceByteLength: before.source.byteLength,
      existingAnnotations: [],
      reviewItems: [],
    }).handle.value;
    await writeFile(value.pdfPath, value.successor);
    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    })).resolves.toMatchObject({ status: "committed", migratedTaskSessionId: "task-a" });
    expect(value.broker.taskBindings.bindingForTask("task-a")).toMatchObject({
      reviewSessionId: value.launch.sessionId,
      documentGeneration: 2,
    });
    expect(value.broker.taskBindings.bindingForTask("task-a")?.lastVerified).toBeUndefined();
    expect(evidence.authorizeHandle(oldHandle)).toMatchObject({ status: "unavailable" });
    expect(value.broker.authenticate(value.launch.sessionId, credential!)).toBe(true);
    await expect(new DraftSnapshotStore(
      join(value.directory, "recovery", value.launch.sessionId),
    ).recover()).resolves.toMatchObject({
      sourceWorkInterruptions: [{
        taskSessionId: "task-a",
        previousGeneration: 1,
        successorGeneration: 2,
        disposition: "interrupted-by-generation",
      }],
    });

    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: join(value.directory, "other.pdf"),
      observationEpoch: 2,
    })).rejects.toThrow(/cannot retarget/iu);
    expect(value.broker.taskBindings.bindingForTask("task-a")).toBeUndefined();
  });
});
