import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExistingPdfAnnotation } from "../../../packages/core/src/live-context.js";
import type { ReviewItem } from "../../../packages/core/src/review-model.js";
import { LiveContextService } from "../src/context/live-context-service.js";
import { SessionBroker, type SessionLaunch } from "../src/sessions/session-broker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true }),
  ));
});

const id = (suffix: number) =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;

function item(suffix: number, proposedText = `replacement ${suffix}`): ReviewItem {
  const rect = { x: 72, y: 100 + suffix * 20, width: 100, height: 14 };
  return {
    id: id(suffix),
    kind: "replace",
    pageIndex: 0,
    createdAt: `2026-08-12T12:00:${String(suffix).padStart(2, "0")}.000Z`,
    updatedAt: `2026-08-12T12:00:${String(suffix).padStart(2, "0")}.000Z`,
    payload: {
      quote: `claim ${suffix}`,
      prefix: "before ",
      suffix: " after",
      rect,
      segmentRects: [rect],
      reliable: true,
      proposedText,
    },
  };
}

const existing: ExistingPdfAnnotation = {
  id: "foreign-highlight",
  origin: "source-pdf",
  readOnly: true,
  pageIndex: 0,
  subtype: "highlight",
  contents: "Existing reviewer note",
  author: "Reviewer",
  rect: { x: 20, y: 30, width: 40, height: 10 },
};

async function fixture(options: {
  inspect?: ConstructorParameters<typeof LiveContextService>[0]["inspectPdf"];
  querySourceHints?: ConstructorParameters<typeof LiveContextService>[0]["querySourceHints"];
  sourceRoot?: boolean;
} = {}): Promise<{
  broker: SessionBroker;
  launch: SessionLaunch;
  service: LiveContextService;
}> {
  const directory = await mkdtemp(join(tmpdir(), "pdf-proofreader-live-context-"));
  temporaryDirectories.push(directory);
  const pdfPath = join(directory, "paper.pdf");
  await writeFile(pdfPath, "%PDF-1.7\nimmutable source\n%%EOF");
  const broker = new SessionBroker({
    recoveryRoot: join(directory, "recovery"),
    portableReader: async () => [],
    rewriteAssessor: async () => ({ eligible: true }),
  });
  const opened = await broker.openReview({
    pdfPath,
    surface: "codex",
    ...(options.sourceRoot === true ? { sourceRootPath: directory } : {}),
  });
  if (opened.kind !== "opened" || opened.launch.bindProof === undefined) {
    throw new Error("Expected a bindable Codex launch");
  }
  const capability = opened.launch.fragment.slice("#cap=".length);
  expect(broker.taskBindings.claim({
    bindProof: opened.launch.bindProof,
    taskSessionId: "task-a",
    reviewSessionId: opened.launch.sessionId,
    documentGeneration: opened.launch.documentGeneration,
  }).status).toBe("pending");
  expect(broker.exchangeBootstrap(opened.launch.sessionId, capability)).toBeTypeOf("string");

  const service = new LiveContextService({
    broker,
    now: () => new Date("2026-08-12T12:00:00.000Z"),
    cursor: (() => {
      let cursor = 0;
      return () => `cursor-${++cursor}`;
    })(),
    inspectPdf: options.inspect ?? (async () => ({
      pageCount: 1,
      existingAnnotations: [existing],
      warnings: [],
      sourceHints: new Map([
        [id(1), { path: "paper.tex", line: 12, confidence: "high", provenance: "synctex" }],
      ]),
    })),
    ...(options.querySourceHints === undefined ? {} : { querySourceHints: options.querySourceHints }),
  });
  return { broker, launch: opened.launch, service };
}

describe("atomic live-context service", () => {
  it("returns a full observation, unchanged state, then complete add/edit/remove deltas", async () => {
    const { broker, launch, service } = await fixture();

    const initial = await service.refresh({ taskSessionId: "task-a" });
    expect(initial).toMatchObject({
      status: "current",
      identity: { reviewRevision: 0, documentGeneration: 1 },
      reviewItems: { mode: "full", reason: "initial", itemCount: 0 },
      existingPdfAnnotations: { count: 1, items: [{ readOnly: true, origin: "source-pdf" }] },
    });

    if (initial.status !== "current") throw new Error("Expected initial context");
    const unchanged = await service.refresh({
      taskSessionId: "task-a",
      cursor: initial.reviewItems.cursor,
    });
    expect(unchanged).toMatchObject({
      status: "current",
      reviewItems: { mode: "unchanged", baseCursor: "cursor-1", cursor: "cursor-2" },
    });

    await broker.acceptMutation(launch.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: item(1),
    });
    if (unchanged.status !== "current") throw new Error("Expected unchanged context");
    const added = await service.refresh({
      taskSessionId: "task-a",
      cursor: unchanged.reviewItems.cursor,
    });
    expect(added).toMatchObject({
      status: "current",
      saveStatus: { sync: { phase: "not-saved", desiredRevision: 1 } },
      reviewItems: { mode: "delta", added: [{ id: id(1), sourceHint: { path: "paper.tex" } }] },
    });

    await broker.acceptMutation(launch.sessionId, {
      type: "edit",
      expectedRevision: 1,
      id: id(1),
      updatedAt: "2026-08-12T12:01:00.000Z",
      payload: { proposedText: "manual edit wins" },
    });
    if (added.status !== "current") throw new Error("Expected added context");
    const edited = await service.refresh({
      taskSessionId: "task-a",
      cursor: added.reviewItems.cursor,
    });
    expect(edited).toMatchObject({
      status: "current",
      reviewItems: { mode: "delta", edited: [{ id: id(1), payload: { proposedText: "manual edit wins" } }] },
    });

    await broker.acceptMutation(launch.sessionId, {
      type: "remove",
      expectedRevision: 2,
      id: id(1),
    });
    if (edited.status !== "current") throw new Error("Expected edited context");
    const removed = await service.refresh({
      taskSessionId: "task-a",
      cursor: edited.reviewItems.cursor,
    });
    expect(removed).toMatchObject({
      status: "current",
      reviewItems: { mode: "delta", removed: [id(1)] },
    });
  });

  it("falls back to full for an unknown caller cursor", async () => {
    const { service } = await fixture();
    await service.refresh({ taskSessionId: "task-a" });
    const refresh = await service.refresh({ taskSessionId: "task-a", cursor: "not-owned" });
    expect(refresh).toMatchObject({
      status: "current",
      reviewItems: { mode: "full", reason: "unknown-cursor", cursor: "cursor-2" },
    });
  });

  it("self-heals with a full baseline when the prior response was not acknowledged", async () => {
    const { broker, launch, service } = await fixture();
    const lost = await service.refresh({ taskSessionId: "task-a" });
    expect(lost).toMatchObject({ status: "current", reviewItems: { mode: "full" } });
    await broker.acceptMutation(launch.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: item(1),
    });

    const recovered = await service.refresh({ taskSessionId: "task-a" });
    expect(recovered).toMatchObject({
      status: "current",
      reviewItems: {
        mode: "full",
        reason: "unknown-cursor",
        itemCount: 1,
        items: [{ id: id(1) }],
      },
    });
  });

  it("discards task observations, evidence, and session caches together", async () => {
    let inspections = 0;
    const { service } = await fixture({
      inspect: async () => {
        inspections += 1;
        return { pageCount: 1, existingAnnotations: [], warnings: [], sourceHints: new Map() };
      },
    });
    const initial = await service.refresh({ taskSessionId: "task-a" });
    if (initial.status !== "current") throw new Error("Expected current context");
    const handle = initial.evidence.handle.value;

    service.discardTask("task-a");
    expect(service.evidence.authorizeHandle(handle)).toEqual({
      status: "unavailable",
      reason: "unauthorized",
    });
    expect(await service.refresh({ taskSessionId: "task-a" })).toMatchObject({
      status: "current",
      reviewItems: { mode: "full", reason: "initial" },
    });
    expect(inspections).toBe(2);
  });

  it("invalidates live-context caches when the broker ends a session", async () => {
    const { broker, launch, service } = await fixture();
    await service.refresh({ taskSessionId: "task-a" });
    const discard = vi.spyOn(service, "discardSession");

    await broker.finish(launch.sessionId);

    expect(discard).toHaveBeenCalledWith(launch.sessionId);
  });

  it("queries SyncTeX only for new items and reuses unchanged geometry", async () => {
    const queriedIds: string[] = [];
    const { broker, launch, service } = await fixture({
      sourceRoot: true,
      querySourceHints: async ({ items }) => {
        queriedIds.push(...items.map(({ id: itemId }) => itemId));
        return new Map(items.map(({ id: itemId }) => [
          itemId,
          { path: "paper.tex", line: 12, confidence: "high" as const, provenance: "synctex" as const },
        ]));
      },
    });
    await broker.acceptMutation(launch.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: item(1),
    });
    const first = await service.refresh({ taskSessionId: "task-a" });
    if (first.status !== "current") throw new Error("Expected current context");
    const unchanged = await service.refresh({
      taskSessionId: "task-a",
      cursor: first.reviewItems.cursor,
    });
    expect(unchanged).toMatchObject({ status: "current", reviewItems: { mode: "unchanged" } });
    await broker.acceptMutation(launch.sessionId, {
      type: "edit",
      expectedRevision: 1,
      id: id(1),
      updatedAt: "2026-08-12T12:01:00.000Z",
      payload: { proposedText: "geometry stayed put" },
    });
    if (unchanged.status !== "current") throw new Error("Expected unchanged context");
    await service.refresh({ taskSessionId: "task-a", cursor: unchanged.reviewItems.cursor });
    await broker.acceptMutation(launch.sessionId, {
      type: "add",
      expectedRevision: 2,
      item: item(2),
    });
    await service.refresh({ taskSessionId: "task-a" });

    expect(queriedIds).toEqual([id(1), id(2)]);
  });

  it("keeps accepted Review Items current when PDF persistence reports a write failure", async () => {
    const { broker, launch, service } = await fixture();
    await broker.establishSaveDestination(launch.sessionId, {
      kind: "copy",
      targetPath: "/private/never-expose/reviewed.pdf",
      capabilityId: "opaque-destination-capability",
    });
    await broker.acceptMutation(launch.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: item(1),
    });
    await broker.markSaveFailed(launch.sessionId, 1, "write-failed");

    const observation = await service.refresh({ taskSessionId: "task-a" });
    expect(observation).toMatchObject({
      status: "current",
      identity: { reviewRevision: 1 },
      saveStatus: {
        destination: { phase: "active", generation: 1, kind: "copy" },
        sync: { phase: "not-saved", failure: "write-failed" },
      },
      reviewItems: { mode: "full", items: [{ id: id(1) }] },
    });
    expect(JSON.stringify(observation)).not.toContain("/private/never-expose");
    expect(JSON.stringify(observation)).not.toContain("opaque-destination-capability");
  });

  it("does not advance the cursor or claim current when inspection fails", async () => {
    const { broker, launch, service: verifier } = await fixture();
    expect((await verifier.refresh({ taskSessionId: "task-a" })).status).toBe("current");
    let fail = true;
    const service = new LiveContextService({
      broker,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
      cursor: () => "cursor-after-recovery",
      inspectPdf: async () => {
        if (fail) throw new Error("inspection failed");
        return { pageCount: 1, existingAnnotations: [], warnings: [], sourceHints: new Map() };
      },
    });
    await broker.acceptMutation(launch.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: item(1),
    });

    fail = true;
    const unavailable = await service.refresh({ taskSessionId: "task-a" });
    expect(unavailable).toMatchObject({
      status: "unavailable",
      reason: "unavailable",
      lastVerified: { reviewRevision: 0 },
    });
    expect(unavailable).not.toHaveProperty("reviewItems");

    fail = false;
    const recovered = await service.refresh({ taskSessionId: "task-a" });
    expect(recovered).toMatchObject({
      status: "current",
      reviewItems: { mode: "full", cursor: "cursor-after-recovery", items: [{ id: id(1) }] },
    });
  });

  it("does not block mutation during delayed inspection and reuses the immutable catalog", async () => {
    let releaseInspection!: () => void;
    let inspectionStarted!: () => void;
    let inspectionCount = 0;
    const started = new Promise<void>((resolve) => { inspectionStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseInspection = resolve; });
    const { broker, launch, service } = await fixture({
      inspect: async () => {
        inspectionCount += 1;
        inspectionStarted();
        await release;
        return { pageCount: 1, existingAnnotations: [], warnings: [], sourceHints: new Map() };
      },
    });

    const refresh = service.refresh({ taskSessionId: "task-a" });
    await started;
    let mutationSettled = false;
    const mutation = broker.acceptMutation(launch.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: item(1),
    }).then(() => { mutationSettled = true; });
    await Promise.resolve();
    await mutation;
    expect(mutationSettled).toBe(true);
    releaseInspection();

    expect(await refresh).toMatchObject({ status: "current", identity: { reviewRevision: 1 } });
    expect(await service.refresh({ taskSessionId: "task-a" })).toMatchObject({
      status: "current",
      identity: { reviewRevision: 1 },
    });
    expect(inspectionCount).toBe(1);
  });

  it("fails closed for unbound, stale-generation, and ended sessions", async () => {
    const unbound = await fixture();
    expect(await unbound.service.refresh({ taskSessionId: "other-task" })).toMatchObject({
      status: "unavailable",
      reason: "unbound",
    });

    const stale = await fixture();
    stale.broker.taskBindings.revokeTask("task-a");
    const proof = stale.broker.taskBindings.issueBindProof({
      reviewSessionId: stale.launch.sessionId,
      documentGeneration: 2,
      browserCapability: "browser-capability-stale-generation-aaaaaaaa",
    });
    stale.broker.taskBindings.claim({
      bindProof: proof,
      taskSessionId: "task-stale",
      reviewSessionId: stale.launch.sessionId,
      documentGeneration: 2,
    });
    stale.broker.taskBindings.activateBrowser({
      reviewSessionId: stale.launch.sessionId,
      documentGeneration: 2,
      browserCapability: "browser-capability-stale-generation-aaaaaaaa",
    });
    expect(await stale.service.refresh({ taskSessionId: "task-stale" })).toMatchObject({
      status: "unavailable",
      reason: "stale_generation",
    });

    await stale.broker.finish(stale.launch.sessionId);
    expect(await stale.service.refresh({ taskSessionId: "task-stale" })).toMatchObject({
      status: "unavailable",
      reason: "unbound",
    });
  });

  it("discovers foreign source-PDF annotations server-side as a separate read-only population", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pdf-proofreader-existing-context-"));
    temporaryDirectories.push(directory);
    const pdfPath = join(directory, "annotated.pdf");
    await writeFile(
      pdfPath,
      await readFile(resolve("test/fixtures/pdfs/text-native-with-annotations.pdf")),
    );
    const broker = new SessionBroker({ recoveryRoot: join(directory, "recovery") });
    const opened = await broker.openReview({ pdfPath, surface: "codex" });
    if (opened.kind !== "opened" || opened.launch.bindProof === undefined) {
      throw new Error("Expected a bindable annotated PDF");
    }
    const capability = opened.launch.fragment.slice("#cap=".length);
    broker.taskBindings.claim({
      bindProof: opened.launch.bindProof,
      taskSessionId: "task-existing",
      reviewSessionId: opened.launch.sessionId,
      documentGeneration: 1,
    });
    broker.exchangeBootstrap(opened.launch.sessionId, capability);

    const observation = await new LiveContextService({ broker }).refresh({
      taskSessionId: "task-existing",
    });
    expect(observation).toMatchObject({
      status: "current",
      reviewItems: { mode: "full", itemCount: 0 },
      existingPdfAnnotations: { count: 2 },
    });
    if (observation.status !== "current") throw new Error("Expected current context");
    expect(observation.existingPdfAnnotations.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "existing-highlight", subtype: "highlight", readOnly: true, origin: "source-pdf" }),
      expect.objectContaining({ id: "existing-stamp", subtype: "stamp", readOnly: true, origin: "source-pdf" }),
    ]));
  });
});
