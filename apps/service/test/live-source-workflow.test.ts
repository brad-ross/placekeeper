import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { LiveDispositionItemV1 } from "../../../packages/core/src/disposition.js";
import type { ReviewItem } from "../../../packages/core/src/review-model.js";
import { LiveContextService } from "../src/context/live-context-service.js";
import { LiveSourceWorkflowService } from "../src/context/live-source-workflow-service.js";
import {
  SourceReconciliationService,
  type SourceReplacementProposalV1,
} from "../src/context/source-reconciliation-service.js";
import { SessionBroker, type SessionLaunch } from "../src/sessions/session-broker.js";

const roots: string[] = [];
const taskSessionId = "task-source-work";
const id = (suffix: number) =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function item(suffix: number): ReviewItem {
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
      proposedText: `replacement ${suffix}`,
    },
  };
}

interface Fixture {
  readonly root: string;
  readonly sourcePath: string;
  readonly broker: SessionBroker;
  readonly launch: SessionLaunch;
  readonly context: LiveContextService;
  readonly workflow: LiveSourceWorkflowService;
  readonly handle: string;
}

async function fixture(options: {
  inspectRebuild?: ConstructorParameters<typeof LiveSourceWorkflowService>[0]["inspectPdf"];
  executionId?: () => string;
} = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-live-source-"));
  roots.push(root);
  const pdfPath = join(root, "paper.pdf");
  const sourcePath = join(root, "paper.tex");
  await Promise.all([
    writeFile(pdfPath, await readFile(resolve("test/fixtures/pdfs/text-native.pdf"))),
    writeFile(sourcePath, "prefix old suffix\n"),
  ]);
  const broker = new SessionBroker({
    recoveryRoot: join(root, "recovery"),
    portableReader: async () => [],
    rewriteAssessor: async () => ({ eligible: true }),
  });
  const opened = await broker.openReview({ pdfPath, sourceRootPath: root, surface: "codex" });
  if (opened.kind !== "opened" || opened.launch.bindProof === undefined) throw new Error("Expected Codex launch");
  const launch = opened.launch;
  const bindProof = opened.launch.bindProof;
  expect(broker.taskBindings.claim({
    bindProof,
    taskSessionId,
    reviewSessionId: launch.sessionId,
    documentGeneration: launch.documentGeneration,
  }).status).toBe("pending");
  expect(broker.exchangeBootstrap(launch.sessionId, launch.fragment.slice("#cap=".length))).toBeTypeOf("string");
  await broker.acceptMutation(launch.sessionId, { type: "add", expectedRevision: 0, item: item(1) });
  const inspectPdf = async () => ({
    pageCount: 1,
    existingAnnotations: [],
    warnings: [],
    sourceHints: new Map([
      [id(1), { path: "paper.tex", line: 1, confidence: "high" as const, provenance: "synctex" as const }],
    ]),
  });
  const context = new LiveContextService({ broker, inspectPdf });
  let nextId = 0;
  const reconciliation = new SourceReconciliationService({
    broker,
    executionId: options.executionId ?? (() => "execution-1"),
    queryHints: async ({ items }) => new Map(items.map(({ id: itemId }) => [
      itemId,
      { path: "paper.tex", line: 1, confidence: "high" as const, provenance: "synctex" as const },
    ])),
  });
  const workflow = new LiveSourceWorkflowService({
    broker,
    context,
    reconciliation,
    id: () => `workflow-${++nextId}`,
    ...(options.inspectRebuild === undefined ? {} : { inspectPdf: options.inspectRebuild }),
  });
  const observation = await context.refresh({ taskSessionId });
  if (observation.status !== "current") throw new Error("Expected current context");
  return { root, sourcePath, broker, launch, context, workflow, handle: observation.evidence.handle.value };
}

function proposal(): SourceReplacementProposalV1 {
  return {
    schemaVersion: 1,
    idempotencyKey: "proposal-1",
    baselineItemId: id(1),
    path: "paper.tex",
    expectedText: "old",
    replacementText: "new",
    prefix: "prefix ",
    suffix: " suffix",
  };
}

describe("same-task live source workflow", () => {
  it("requires a baseline only for requested source work, performs a guarded ordinary edit, and reports later items", async () => {
    const value = await fixture();
    const begun = await value.workflow.begin({ handle: value.handle, sourcePaths: ["paper.tex"] });
    const proposed = await value.workflow.propose({
      handle: begun.freshness.evidenceHandle,
      executionId: begun.result.executionId,
      proposal: proposal(),
    });
    const first = await value.workflow.reconcile({
      handle: proposed.freshness.evidenceHandle,
      executionId: begun.result.executionId,
    });
    const guard = first.result.outcomes[0]?.applyGuardSha256;
    expect(guard).toMatch(/^[0-9a-f]{64}$/u);
    const guarded = await value.workflow.reconcile({
      handle: first.freshness.evidenceHandle,
      executionId: begun.result.executionId,
      expectedSourceSha256ByProposal: { "proposal-1": guard! },
    });
    expect(guarded.result.outcomes[0]?.outcome.classification).toBe("independent");

    // The provider never writes source. This is the ordinary Codex-tool write
    // that occurs only after the immediately-before-edit guard check.
    await writeFile(value.sourcePath, "prefix new suffix\n");
    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "add", expectedRevision: 1, item: item(2),
    });
    const disposition: readonly LiveDispositionItemV1[] = [{
      itemId: id(1),
      status: "applied",
      explanation: "Applied after the guarded source check.",
      changedPaths: ["paper.tex"],
    }];
    const completed = await value.workflow.complete({
      handle: guarded.freshness.evidenceHandle,
      executionId: begun.result.executionId,
      items: disposition,
    });
    expect(completed.result.items).toEqual(disposition);
    expect(completed.result.laterItems).toMatchObject([{
      item: { id: id(2) },
      status: "preserved-unprocessed",
    }]);
  });

  it("deduplicates equivalent manual work and preserves a conflicting manual edit", async () => {
    const equivalent = await fixture();
    const begun = await equivalent.workflow.begin({ handle: equivalent.handle, sourcePaths: ["paper.tex"] });
    const proposed = await equivalent.workflow.propose({
      handle: begun.freshness.evidenceHandle, executionId: begun.result.executionId, proposal: proposal(),
    });
    await writeFile(equivalent.sourcePath, "prefix new suffix\n");
    const deduplicated = await equivalent.workflow.reconcile({
      handle: proposed.freshness.evidenceHandle, executionId: begun.result.executionId,
    });
    expect(deduplicated.result.outcomes[0]?.outcome).toMatchObject({
      classification: "equivalent", action: "deduplicate", authority: "manual",
    });

    const conflict = await fixture();
    const conflictBaseline = await conflict.workflow.begin({ handle: conflict.handle, sourcePaths: ["paper.tex"] });
    const conflictProposal = await conflict.workflow.propose({
      handle: conflictBaseline.freshness.evidenceHandle,
      executionId: conflictBaseline.result.executionId,
      proposal: proposal(),
    });
    await writeFile(conflict.sourcePath, "prefix manual suffix\n");
    const preserved = await conflict.workflow.reconcile({
      handle: conflictProposal.freshness.evidenceHandle,
      executionId: conflictBaseline.result.executionId,
    });
    expect(preserved.result.outcomes[0]?.outcome).toMatchObject({
      classification: "conflict", action: "skip", authority: "manual",
    });
  });

  it("keeps the build command outside the service and verifies an observable clean structural PDF", async () => {
    const value = await fixture();
    const begun = await value.workflow.begin({ handle: value.handle, sourcePaths: ["paper.tex"] });
    const plan = await value.workflow.prepareCleanRebuild({
      handle: begun.freshness.evidenceHandle,
      executionId: begun.result.executionId,
      command: "tectonic paper.tex --outdir build",
      outputPath: "build/paper.pdf",
    });
    expect(plan.result).toMatchObject({
      command: "tectonic paper.tex --outdir build",
      outputPath: "build/paper.pdf",
    });
    expect(plan.result.instruction).toContain("does not execute");
    await expect(value.workflow.prepareCleanRebuild({
      handle: plan.freshness.evidenceHandle,
      executionId: begun.result.executionId,
      command: "tectonic paper.tex",
      outputPath: "paper.pdf",
    })).rejects.toThrow(/distinct from the annotation-bearing PDF/u);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(value.root, "build")));
    await writeFile(join(value.root, "build/paper.pdf"), await readFile(resolve("test/fixtures/pdfs/image-only.pdf")));
    const verified = await value.workflow.verifyCleanRebuild({
      handle: plan.freshness.evidenceHandle,
      executionId: begun.result.executionId,
      planId: plan.result.planId,
    });
    expect(verified.result).toMatchObject({
      structurallyObserved: true,
      reviewAnnotationsPresent: false,
      pageCount: 1,
    });
  }, 30_000);

  it("rejects inherited review annotations and blocks completion when live refresh fails", async () => {
    const dirty = await fixture({
      inspectRebuild: async () => ({
        pageCount: 1,
        pageFingerprints: ["page"],
        annotationSubtypes: ["highlight"],
        annotations: [{
          id: id(1), pageIndex: 0, subtype: "highlight", contents: "review",
          author: "Placekeeper", flags: [], hasNormalAppearance: true,
          rect: { origin: { x: 0, y: 0 }, size: { width: 1, height: 1 } },
          preservationFingerprint: "review",
        }],
        portableItems: [],
      }),
    });
    const begun = await dirty.workflow.begin({ handle: dirty.handle, sourcePaths: ["paper.tex"] });
    const plan = await dirty.workflow.prepareCleanRebuild({
      handle: begun.freshness.evidenceHandle,
      executionId: begun.result.executionId,
      command: "build",
      outputPath: "revised.pdf",
    });
    await writeFile(join(dirty.root, "revised.pdf"), "%PDF-1.7\n%%EOF");
    await expect(dirty.workflow.verifyCleanRebuild({
      handle: plan.freshness.evidenceHandle,
      executionId: begun.result.executionId,
      planId: plan.result.planId,
    })).rejects.toThrow(/review annotations/u);

    const current = await dirty.context.refresh({ taskSessionId });
    if (current.status !== "current") throw new Error("Expected current context");
    dirty.broker.taskBindings.revokeTask(taskSessionId);
    await expect(dirty.workflow.complete({
      handle: current.evidence.handle.value,
      executionId: begun.result.executionId,
      items: [{ itemId: id(1), status: "not-applied", explanation: "Not applied." }],
    })).rejects.toThrow(/handle|binding|unavailable/iu);
  });

  it(
    "rejects validated Placekeeper annotations but preserves author-only external annotations",
    async () => {
      const author = "Placekeeper";
      const owned = item(2);
      const appOwned = await fixture({
        inspectRebuild: async () => ({
          pageCount: 1,
          pageFingerprints: ["page"],
          annotationSubtypes: ["highlight"],
          annotations: [{
            id: owned.id, pageIndex: 0, subtype: "highlight", contents: "review",
            author, flags: [], hasNormalAppearance: true,
            rect: { origin: { x: 0, y: 0 }, size: { width: 1, height: 1 } },
            preservationFingerprint: "review",
          }],
          portableItems: [owned],
        }),
      });
      const begun = await appOwned.workflow.begin({
        handle: appOwned.handle,
        sourcePaths: ["paper.tex"],
      });
      const plan = await appOwned.workflow.prepareCleanRebuild({
        handle: begun.freshness.evidenceHandle,
        executionId: begun.result.executionId,
        command: "build",
        outputPath: "revised.pdf",
      });
      await writeFile(join(appOwned.root, "revised.pdf"), "%PDF-1.7\n%%EOF");
      await expect(appOwned.workflow.verifyCleanRebuild({
        handle: plan.freshness.evidenceHandle,
        executionId: begun.result.executionId,
        planId: plan.result.planId,
      })).rejects.toThrow(/review annotations/u);

      const external = await fixture({
        inspectRebuild: async () => ({
          pageCount: 1,
          pageFingerprints: ["page"],
          annotationSubtypes: ["highlight"],
          annotations: [{
            id: `external-${author}`, pageIndex: 0, subtype: "highlight", contents: "external",
            author, flags: [], hasNormalAppearance: true,
            rect: { origin: { x: 0, y: 0 }, size: { width: 1, height: 1 } },
            preservationFingerprint: "external",
          }],
          portableItems: [],
        }),
      });
      const externalBegun = await external.workflow.begin({
        handle: external.handle,
        sourcePaths: ["paper.tex"],
      });
      const externalPlan = await external.workflow.prepareCleanRebuild({
        handle: externalBegun.freshness.evidenceHandle,
        executionId: externalBegun.result.executionId,
        command: "build",
        outputPath: "revised.pdf",
      });
      await writeFile(join(external.root, "revised.pdf"), "%PDF-1.7\n%%EOF");
      await expect(external.workflow.verifyCleanRebuild({
        handle: externalPlan.freshness.evidenceHandle,
        executionId: externalBegun.result.executionId,
        planId: externalPlan.result.planId,
      })).resolves.toMatchObject({ result: { reviewAnnotationsPresent: false } });
    },
  );

  it("bounds retained task executions and evicts rebuild plans with their execution", async () => {
    let execution = 0;
    const value = await fixture({ executionId: () => `execution-${++execution}` });
    const first = await value.workflow.begin({ handle: value.handle, sourcePaths: ["paper.tex"] });
    const plan = await value.workflow.prepareCleanRebuild({
      handle: first.freshness.evidenceHandle,
      executionId: first.result.executionId,
      command: "build",
      outputPath: "build/paper.pdf",
    });
    let currentHandle = plan.freshness.evidenceHandle;
    for (let index = 0; index < 8; index += 1) {
      const begun = await value.workflow.begin({ handle: currentHandle, sourcePaths: ["paper.tex"] });
      currentHandle = begun.freshness.evidenceHandle;
    }
    await expect(value.workflow.verifyCleanRebuild({
      handle: currentHandle,
      executionId: first.result.executionId,
      planId: plan.result.planId,
    })).rejects.toThrow(/execution is unavailable/i);
  });
});
