import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ReviewItem } from "../../../packages/core/src/review-model.js";
import {
  SourceReconciliationService,
  type SourceReplacementProposalV1,
} from "../src/context/source-reconciliation-service.js";
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

interface Fixture {
  readonly directory: string;
  readonly sourcePath: string;
  readonly broker: SessionBroker;
  readonly launch: SessionLaunch;
  readonly service: SourceReconciliationService;
}

async function fixture(
  source = "prefix old suffix\nuntouched\n",
  items: readonly ReviewItem[] = [item(1)],
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "placekeeper-reconciliation-"));
  temporaryDirectories.push(directory);
  const pdfPath = join(directory, "paper.pdf");
  const sourcePath = join(directory, "paper.tex");
  await Promise.all([
    writeFile(pdfPath, "%PDF-1.7\nimmutable source\n%%EOF"),
    writeFile(sourcePath, source),
  ]);
  const broker = new SessionBroker({
    recoveryRoot: join(directory, "recovery"),
    portableReader: async () => [],
    rewriteAssessor: async () => ({ eligible: true }),
  });
  const opened = await broker.openReview({ pdfPath, sourceRootPath: directory, surface: "codex" });
  if (opened.kind !== "opened" || opened.launch.bindProof === undefined) {
    throw new Error("Expected a bindable Codex launch");
  }
  let revision = 0;
  for (const reviewItem of items) {
    await broker.acceptMutation(opened.launch.sessionId, {
      type: "add",
      expectedRevision: revision,
      item: reviewItem,
    });
    revision += 1;
  }
  const capability = opened.launch.fragment.slice("#cap=".length);
  expect(broker.taskBindings.claim({
    bindProof: opened.launch.bindProof,
    taskSessionId: "task-a",
    reviewSessionId: opened.launch.sessionId,
    documentGeneration: opened.launch.documentGeneration,
  }).status).toBe("pending");
  expect(broker.exchangeBootstrap(opened.launch.sessionId, capability)).toBeTypeOf("string");
  const service = new SourceReconciliationService({
    broker,
    now: () => new Date("2026-08-12T13:00:00.000Z"),
    executionId: () => "execution-a",
    queryHints: async ({ items: currentItems }) => new Map(
      currentItems.map(({ id: itemId }) => [
        itemId,
        { path: "paper.tex", line: 1, confidence: "high" as const, provenance: "synctex" as const },
      ]),
    ),
  });
  return { directory, sourcePath, broker, launch: opened.launch, service };
}

function proposal(
  suffix = 1,
  overrides: Partial<SourceReplacementProposalV1> = {},
): SourceReplacementProposalV1 {
  return {
    schemaVersion: 1,
    idempotencyKey: `proposal-${suffix}`,
    baselineItemId: id(suffix),
    path: "paper.tex",
    expectedText: "old",
    replacementText: "new",
    prefix: "prefix ",
    suffix: " suffix",
    ...overrides,
  };
}

async function baselineAndProposal(
  value: Fixture,
  sourceProposal = proposal(),
) {
  const baseline = await value.service.captureBaseline({
    taskSessionId: "task-a",
    sourcePaths: ["paper.tex"],
  });
  const accepted = await value.service.acceptProposal({
    taskSessionId: "task-a",
    executionId: baseline.executionId,
    proposal: sourceProposal,
  });
  return { baseline, accepted };
}

describe("manual-precedence source reconciliation", () => {
  it("deduplicates identical manual application and replays an identical proposal idempotently", async () => {
    const value = await fixture();
    const { baseline, accepted } = await baselineAndProposal(value);
    expect(accepted.status).toBe("accepted");
    expect((await value.service.acceptProposal({
      taskSessionId: "task-a",
      executionId: baseline.executionId,
      proposal: proposal(),
    })).status).toBe("replayed");

    await writeFile(value.sourcePath, "prefix new suffix\nuntouched\n");
    const report = await value.service.reconcile({ taskSessionId: "task-a", executionId: baseline.executionId });
    expect(report.outcomes[0]).toMatchObject({
      outcome: { classification: "equivalent", action: "deduplicate", authority: "manual" },
    });
    await expect(value.service.acceptProposal({
      taskSessionId: "task-a",
      executionId: baseline.executionId,
      proposal: proposal(1, { replacementText: "different" }),
    })).rejects.toThrow(/idempotency key/i);
  });

  it("deduplicates whitespace-equivalent and anchor-stable manual source work", async () => {
    const value = await fixture();
    const { baseline } = await baselineAndProposal(value, proposal(1, { replacementText: "new value" }));
    await writeFile(value.sourcePath, "manual header\nprefix   new\n value   suffix\nuntouched\n");

    const report = await value.service.reconcile({ taskSessionId: "task-a", executionId: baseline.executionId });
    expect(report.outcomes[0]?.outcome.classification).toBe("equivalent");
  });

  it("preserves a divergent manual edit at the same target", async () => {
    const value = await fixture();
    const { baseline } = await baselineAndProposal(value);
    await writeFile(value.sourcePath, "prefix manual suffix\nuntouched\n");

    const report = await value.service.reconcile({ taskSessionId: "task-a", executionId: baseline.executionId });
    expect(report.outcomes[0]).toMatchObject({
      outcome: { classification: "conflict", action: "skip", authority: "manual" },
    });
  });

  it("allows an independent target while preserving unrelated manual edits", async () => {
    const value = await fixture();
    const { baseline } = await baselineAndProposal(value);
    await writeFile(value.sourcePath, "prefix old suffix\nmanually changed elsewhere\n");

    const report = await value.service.reconcile({ taskSessionId: "task-a", executionId: baseline.executionId });
    expect(report.outcomes[0]).toMatchObject({
      path: "paper.tex",
      outcome: { classification: "independent", action: "apply", authority: "codex" },
      applyGuardSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("does not treat a lone target moved away from its baseline anchor as independent", async () => {
    const value = await fixture("prefix old suffix\nkeep\n");
    const { baseline } = await baselineAndProposal(value);
    await writeFile(value.sourcePath, "prefix manual suffix\nkeep old\n");

    const report = await value.service.reconcile({ taskSessionId: "task-a", executionId: baseline.executionId });
    expect(report.outcomes[0]).toMatchObject({
      outcome: { classification: "conflict", action: "skip", authority: "manual" },
    });
    expect(report.outcomes[0]).not.toHaveProperty("applyGuardSha256");
  });

  it("preserves a copied target as ambiguous instead of guessing which occurrence to edit", async () => {
    const value = await fixture();
    const { baseline } = await baselineAndProposal(value);
    await writeFile(value.sourcePath, "prefix old suffix\ncopy old here\n");

    const report = await value.service.reconcile({ taskSessionId: "task-a", executionId: baseline.executionId });
    expect(report.outcomes[0]).toMatchObject({
      outcome: { classification: "ambiguous", action: "skip", authority: "manual" },
    });
  });

  it("keeps the anchored target independent when unrelated baseline text is deleted", async () => {
    const value = await fixture("prefix old suffix\nremove this unrelated paragraph\n");
    const { baseline } = await baselineAndProposal(value);
    await writeFile(value.sourcePath, "prefix old suffix\n");

    const report = await value.service.reconcile({ taskSessionId: "task-a", executionId: baseline.executionId });
    expect(report.outcomes[0]).toMatchObject({
      outcome: { classification: "independent", action: "apply", authority: "codex" },
      applyGuardSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("preserves edited and removed baseline items and reports later annotations separately and exhaustively", async () => {
    const value = await fixture("prefix old suffix\n", [item(1), item(2), item(3)]);
    const baseline = await value.service.captureBaseline({ taskSessionId: "task-a", sourcePaths: ["paper.tex"] });
    await value.service.acceptProposal({
      taskSessionId: "task-a", executionId: baseline.executionId, proposal: proposal(1),
    });
    await value.service.acceptProposal({
      taskSessionId: "task-a", executionId: baseline.executionId,
      proposal: proposal(2, { idempotencyKey: "proposal-2" }),
    });
    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "edit", expectedRevision: 3, id: id(1),
      updatedAt: "2026-08-12T13:01:00.000Z", payload: { proposedText: "manual annotation edit" },
    });
    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "remove", expectedRevision: 4, id: id(2),
    });
    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "add", expectedRevision: 5, item: item(4),
    });
    await rm(value.sourcePath);

    const report = await value.service.reconcile({ taskSessionId: "task-a", executionId: baseline.executionId });
    expect(report.outcomes).toHaveLength(3);
    expect(new Set(report.outcomes.map(({ outcome: result }) => result.baselineItemId))).toEqual(
      new Set(baseline.items.map(({ id: itemId }) => itemId)),
    );
    expect(report.outcomes.map(({ outcome: result }) => result.classification)).toEqual([
      "conflict", "removed", "ambiguous",
    ]);
    expect(report.laterItems.map(({ id: itemId }) => itemId)).toEqual([id(4)]);
  });

  it("rejects proposal paths outside the captured scope and source roots reached through symlinks", async () => {
    const value = await fixture();
    const baseline = await value.service.captureBaseline({ taskSessionId: "task-a", sourcePaths: ["paper.tex"] });
    await expect(value.service.acceptProposal({
      taskSessionId: "task-a",
      executionId: baseline.executionId,
      proposal: proposal(1, { path: "other.tex" }),
    })).rejects.toThrow(/approved source scope/i);

    const external = await mkdtemp(join(tmpdir(), "placekeeper-external-source-"));
    temporaryDirectories.push(external);
    await writeFile(join(external, "outside.tex"), "outside");
    await symlink(external, join(value.directory, "linked"));
    await expect(value.service.captureBaseline({
      taskSessionId: "task-a",
      sourcePaths: ["linked/outside.tex"],
    })).rejects.toThrow(/symbolic-link ancestor/i);
    await expect(value.service.captureBaseline({
      taskSessionId: "task-a",
      sourcePaths: ["../outside.tex"],
    })).rejects.toThrow(/contained relative path/i);
  });

  it("fails a guarded apply closed when source changes between reconciliation and apply", async () => {
    const value = await fixture();
    const { baseline } = await baselineAndProposal(value);
    const first = await value.service.reconcile({ taskSessionId: "task-a", executionId: baseline.executionId });
    const guard = first.outcomes[0]?.applyGuardSha256;
    expect(guard).toMatch(/^[0-9a-f]{64}$/u);

    await writeFile(value.sourcePath, "prefix old suffix\nlate manual edit\n");
    const checkedAgain = await value.service.reconcile({
      taskSessionId: "task-a",
      executionId: baseline.executionId,
      expectedSourceSha256ByProposal: { "proposal-1": guard! },
    });
    expect(checkedAgain.outcomes[0]).toMatchObject({
      outcome: { classification: "conflict", action: "skip", authority: "manual" },
    });
    expect(checkedAgain.outcomes[0]).not.toHaveProperty("applyGuardSha256");
  });

  it("keeps executions task-local", async () => {
    const value = await fixture();
    const baseline = await value.service.captureBaseline({ taskSessionId: "task-a", sourcePaths: ["paper.tex"] });
    await expect(value.service.acceptProposal({
      taskSessionId: "task-b",
      executionId: baseline.executionId,
      proposal: proposal(),
    })).rejects.toThrow(/unavailable to this task/i);
  });

  it("can discard a partially registered workflow execution", async () => {
    const value = await fixture();
    const baseline = await value.service.captureBaseline({
      taskSessionId: "task-a",
      sourcePaths: ["paper.tex"],
    });
    value.service.discardExecution("task-a", baseline.executionId);
    await expect(value.service.acceptProposal({
      taskSessionId: "task-a",
      executionId: baseline.executionId,
      proposal: proposal(),
    })).rejects.toThrow(/unavailable to this task/i);
  });
});
