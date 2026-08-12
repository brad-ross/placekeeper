import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { extname } from "node:path";

import {
  createCompleteDisposition,
  type CompleteDispositionV1,
  type LiveDispositionItemV1,
} from "../../../../packages/core/src/disposition.js";
import {
  reviewSemanticDigest,
  type AtomicLiveContextObservationV1,
  type LiveExecutionBaselineV1,
} from "../../../../packages/core/src/live-context.js";
import type { ReviewItem } from "../../../../packages/core/src/review-model.js";
import {
  inspectPdfWithEmbedPdf,
  type InspectedPdf,
} from "../../../../packages/pdf-backends/src/embedpdf-adapter.js";
import {
  canonicalSourceRoot,
  resolveScopedOutputPath,
} from "../files/source-scope.js";
import type { SessionBroker } from "../sessions/session-broker.js";
import type { LiveContextService } from "./live-context-service.js";
import type { PdfEvidenceUnavailableReason } from "./pdf-evidence-service.js";
import {
  type AcceptedSourceProposal,
  type SourceReconciliationReportV1,
  type SourceReconciliationService,
  type SourceReplacementProposalV1,
} from "./source-reconciliation-service.js";

const MAX_BUILD_COMMAND_BYTES = 32 * 1024;
const MAX_REBUILT_PDF_BYTES = 512 * 1024 * 1024;
const MAX_EXECUTIONS_PER_TASK = 8;
const HASH_BUFFER_BYTES = 64 * 1024;

export interface SourceWorkflowFreshness {
  readonly identity: AtomicLiveContextObservationV1["identity"];
  readonly evidenceHandle: string;
}

export interface SourceWorkflowResult<T> {
  readonly freshness: SourceWorkflowFreshness;
  readonly result: T;
}

export interface CleanRebuildPlanV1 {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly executionId: string;
  readonly command: string;
  readonly workingDirectory: string;
  readonly outputPath: string;
  readonly priorOutputSha256?: string;
  readonly instruction: string;
}

export interface CleanRebuildVerificationV1 {
  readonly schemaVersion: 1;
  readonly verificationId: string;
  readonly planId: string;
  readonly executionId: string;
  readonly outputPath: string;
  readonly outputSha256: string;
  readonly pageCount: number;
  readonly annotationCount: number;
  readonly structurallyObserved: true;
  readonly reviewAnnotationsPresent: false;
}

interface RebuildPlanRecord {
  readonly taskSessionId: string;
  readonly executionId: string;
  readonly baselineItemIds: ReadonlySet<string>;
  readonly root: string;
  readonly outputPath: string;
  readonly relativeOutputPath: string;
  readonly priorOutputSha256?: string;
}

interface WorkflowExecution {
  readonly taskSessionId: string;
  readonly baseline: LiveExecutionBaselineV1;
  readonly guardedApplyByItem: Map<string, { readonly path: string; readonly sha256: string }>;
  readonly verifiedRebuilds: Set<string>;
}

export interface LiveSourceWorkflowServiceOptions {
  readonly broker: SessionBroker;
  readonly context: LiveContextService;
  readonly reconciliation: SourceReconciliationService;
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly inspectPdf?: (bytes: Uint8Array) => Promise<InspectedPdf>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unavailable(reason: PdfEvidenceUnavailableReason): Error {
  return new Error(`The prompt-scoped PDF context handle is ${reason.replaceAll("_", " ")}`);
}

function freshness(observation: AtomicLiveContextObservationV1): SourceWorkflowFreshness {
  return {
    identity: observation.identity,
    evidenceHandle: observation.evidence.handle.value,
  };
}

function validateDispositionAgainstReconciliation(
  supplied: readonly LiveDispositionItemV1[],
  report: SourceReconciliationReportV1,
  execution: WorkflowExecution,
): void {
  const suppliedById = new Map(supplied.map((item) => [item.itemId, item]));
  for (const decision of report.outcomes) {
    const item = suppliedById.get(decision.outcome.baselineItemId);
    if (item === undefined) continue;
    switch (decision.outcome.classification) {
      case "equivalent":
        if (item.status === "already-satisfied") break;
        if (item.status === "applied") {
          const guarded = execution.guardedApplyByItem.get(item.itemId);
          if (guarded !== undefined && item.changedPaths?.includes(guarded.path) === true) break;
        }
        throw new Error(`Disposition ${item.itemId} must report already-satisfied unless a guarded Codex apply was observed`);
      case "independent":
        if (item.status === "not-applied") break;
        throw new Error(`Disposition ${item.itemId} cannot claim an unobserved source apply`);
      case "conflict":
        if (item.status === "skipped-conflict" || item.status === "adapted") break;
        throw new Error(`Disposition ${item.itemId} must preserve the conflicting manual state`);
      case "ambiguous":
        if (item.status === "skipped-ambiguous") break;
        throw new Error(`Disposition ${item.itemId} must preserve the ambiguous manual state`);
      case "removed":
        if (item.status === "removed-before-processing") break;
        throw new Error(`Disposition ${item.itemId} must report the removed Review Item`);
    }
  }
}

export class LiveSourceWorkflowService {
  readonly #broker: SessionBroker;
  readonly #context: LiveContextService;
  readonly #reconciliation: SourceReconciliationService;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #inspectPdf: (bytes: Uint8Array) => Promise<InspectedPdf>;
  readonly #executions = new Map<string, WorkflowExecution>();
  readonly #executionIdsByTask = new Map<string, string[]>();
  readonly #rebuildPlans = new Map<string, RebuildPlanRecord>();

  constructor(options: LiveSourceWorkflowServiceOptions) {
    this.#broker = options.broker;
    this.#context = options.context;
    this.#reconciliation = options.reconciliation;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
    this.#inspectPdf = options.inspectPdf ?? inspectPdfWithEmbedPdf;
  }

  async begin(input: {
    readonly handle: string;
    readonly sourcePaths?: readonly string[];
  }): Promise<SourceWorkflowResult<LiveExecutionBaselineV1>> {
    const taskSessionId = this.#authorize(input.handle);
    const before = await this.#refresh(taskSessionId);
    const baseline = await this.#reconciliation.captureBaseline({
      taskSessionId,
      ...(input.sourcePaths === undefined ? {} : { sourcePaths: input.sourcePaths }),
    });
    try {
      if (
        baseline.identity.documentGeneration !== before.identity.documentGeneration ||
        baseline.identity.stateDigest !== before.identity.stateDigest
      ) throw new Error("Review State changed during baseline capture; refresh and begin source work again");
      const after = await this.#refresh(taskSessionId);
      if (baseline.identity.stateDigest !== after.identity.stateDigest) {
        throw new Error("Review State changed during baseline capture; refresh and begin source work again");
      }
      this.#registerExecution(baseline.executionId, {
        taskSessionId,
        baseline,
        guardedApplyByItem: new Map(),
        verifiedRebuilds: new Set(),
      });
      return { freshness: freshness(after), result: baseline };
    } catch (error) {
      this.#reconciliation.discardExecution(taskSessionId, baseline.executionId);
      throw error;
    }
  }

  async propose(input: {
    readonly handle: string;
    readonly executionId: string;
    readonly proposal: SourceReplacementProposalV1;
  }): Promise<SourceWorkflowResult<AcceptedSourceProposal>> {
    const { taskSessionId } = this.#executionForHandle(input.handle, input.executionId);
    const observation = await this.#refresh(taskSessionId);
    const result = await this.#reconciliation.acceptProposal({
      taskSessionId,
      executionId: input.executionId,
      proposal: input.proposal,
    });
    return { freshness: freshness(observation), result };
  }

  async reconcile(input: {
    readonly handle: string;
    readonly executionId: string;
    readonly expectedSourceSha256ByProposal?: Readonly<Record<string, string>>;
  }): Promise<SourceWorkflowResult<SourceReconciliationReportV1>> {
    const execution = this.#executionForHandle(input.handle, input.executionId);
    const observation = await this.#refresh(execution.taskSessionId);
    const result = await this.#reconciliation.reconcile({
      taskSessionId: execution.taskSessionId,
      executionId: input.executionId,
      ...(input.expectedSourceSha256ByProposal === undefined
        ? {}
        : { expectedSourceSha256ByProposal: input.expectedSourceSha256ByProposal }),
    });
    this.#assertSameObservation(observation, result);
    if (input.expectedSourceSha256ByProposal !== undefined) {
      for (const decision of result.outcomes) {
        if (decision.outcome.classification !== "independent" || decision.applyGuardSha256 === undefined || decision.path === undefined) continue;
        execution.guardedApplyByItem.set(decision.outcome.baselineItemId, {
          path: decision.path,
          sha256: decision.applyGuardSha256,
        });
      }
    }
    return { freshness: freshness(observation), result };
  }

  async prepareCleanRebuild(input: {
    readonly handle: string;
    readonly executionId: string;
    readonly command: string;
    readonly outputPath: string;
  }): Promise<SourceWorkflowResult<CleanRebuildPlanV1>> {
    const execution = this.#executionForHandle(input.handle, input.executionId);
    if (
      input.command.trim().length === 0 ||
      Buffer.byteLength(input.command) > MAX_BUILD_COMMAND_BYTES ||
      extname(input.outputPath).toLowerCase() !== ".pdf"
    ) throw new Error("A bounded user-specified build command and relative PDF output are required");
    const observation = await this.#refresh(execution.taskSessionId);
    const report = await this.#reconciliation.reconcile({
      taskSessionId: execution.taskSessionId,
      executionId: input.executionId,
    });
    this.#assertSameObservation(observation, report);
    const scope = await this.#sourceScope(execution.taskSessionId);
    const output = await resolveScopedOutputPath(scope.root, input.outputPath);
    if (output.path === scope.sourcePdfPath) {
      throw new Error("A clean rebuild must use an output distinct from the annotation-bearing PDF");
    }
    const priorOutputSha256 = await this.#existingOutputDigest(output.path);
    const planId = this.#id();
    this.#rebuildPlans.set(planId, {
      taskSessionId: execution.taskSessionId,
      executionId: input.executionId,
      baselineItemIds: new Set(execution.baseline.items.map(({ id }) => id)),
      root: scope.root,
      outputPath: output.path,
      relativeOutputPath: output.relativePath,
      ...(priorOutputSha256 === undefined ? {} : { priorOutputSha256 }),
    });
    return {
      freshness: freshness(observation),
      result: {
        schemaVersion: 1,
        planId,
        executionId: input.executionId,
        command: input.command,
        workingDirectory: scope.root,
        outputPath: output.relativePath,
        ...(priorOutputSha256 === undefined ? {} : { priorOutputSha256 }),
        instruction: "Run the exact command with ordinary Codex shell tools in workingDirectory so its stdout, stderr, permissions, and approvals remain visible; then call rebuild-verify. The local service does not execute it.",
      },
    };
  }

  async verifyCleanRebuild(input: {
    readonly handle: string;
    readonly executionId: string;
    readonly planId: string;
  }): Promise<SourceWorkflowResult<CleanRebuildVerificationV1>> {
    const execution = this.#executionForHandle(input.handle, input.executionId);
    const plan = this.#rebuildPlans.get(input.planId);
    if (
      plan === undefined || plan.taskSessionId !== execution.taskSessionId ||
      plan.executionId !== input.executionId
    ) throw new Error("The clean rebuild plan is unavailable to this task execution");
    const observation = await this.#refresh(execution.taskSessionId);
    const report = await this.#reconciliation.reconcile({
      taskSessionId: execution.taskSessionId,
      executionId: input.executionId,
    });
    this.#assertSameObservation(observation, report);
    const output = await resolveScopedOutputPath(plan.root, plan.relativeOutputPath);
    if (output.path !== plan.outputPath) throw new Error("The clean rebuild output target changed");
    const handle = await open(output.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size <= 0 || info.size > MAX_REBUILT_PDF_BYTES) {
        throw new Error("The rebuilt PDF is missing, empty, or exceeds the verification limit");
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const outputSha256 = sha256(bytes);
    const binding = this.#broker.taskBindings.bindingForTask(execution.taskSessionId);
    if (binding === undefined) throw new Error("The Codex task has no active PDF binding");
    const source = await this.#broker.projectAtomicSession(
      binding.reviewSessionId,
      async (snapshot) => {
        if (snapshot.documentGeneration !== binding.documentGeneration) {
          throw new Error("The PDF generation changed during rebuild verification");
        }
        return snapshot.state.source.digest;
      },
    );
    if (source === undefined) throw new Error("The bound PDF session ended during rebuild verification");
    if (plan.priorOutputSha256 === outputSha256 || source === outputSha256) {
      throw new Error("The requested rebuild did not produce an observable PDF output change");
    }
    const inspected = await this.#inspectPdf(bytes);
    if (!Number.isSafeInteger(inspected.pageCount) || inspected.pageCount <= 0) {
      throw new Error("The rebuilt PDF could not be structurally observed");
    }
    const inheritedReview = inspected.portableItems.some(({ id }) => plan.baselineItemIds.has(id)) ||
      inspected.annotations.some((annotation) =>
        plan.baselineItemIds.has(annotation.id) ||
        annotation.author === "PDF Proofreader" ||
        annotation.subtype !== "link",
      );
    if (inheritedReview) throw new Error("The rebuilt PDF still contains review annotations");
    const verificationId = this.#id();
    execution.verifiedRebuilds.add(verificationId);
    return {
      freshness: freshness(observation),
      result: {
        schemaVersion: 1,
        verificationId,
        planId: input.planId,
        executionId: input.executionId,
        outputPath: plan.relativeOutputPath,
        outputSha256,
        pageCount: inspected.pageCount,
        annotationCount: inspected.annotations.length,
        structurallyObserved: true,
        reviewAnnotationsPresent: false,
      },
    };
  }

  async complete(input: {
    readonly handle: string;
    readonly executionId: string;
    readonly items: readonly LiveDispositionItemV1[];
    readonly rebuildVerificationId?: string;
  }): Promise<SourceWorkflowResult<CompleteDispositionV1>> {
    const execution = this.#executionForHandle(input.handle, input.executionId);
    if (
      input.rebuildVerificationId !== undefined &&
      !execution.verifiedRebuilds.has(input.rebuildVerificationId)
    ) throw new Error("The claimed clean rebuild was not verified for this task execution");
    const observation = await this.#refresh(execution.taskSessionId);
    const report = await this.#reconciliation.reconcile({
      taskSessionId: execution.taskSessionId,
      executionId: input.executionId,
    });
    this.#assertSameObservation(observation, report);
    validateDispositionAgainstReconciliation(input.items, report, execution);
    const currentItems = await this.#currentReviewItems(execution.taskSessionId, observation.identity.stateDigest);
    const baselineIds = new Set(execution.baseline.items.map(({ id }) => id));
    const laterItems = currentItems
      .filter(({ id }) => !baselineIds.has(id))
      .map((item) => ({
        item,
        status: "preserved-unprocessed" as const,
        explanation: "This Review Item was added after the execution baseline and was preserved without being processed by this run.",
      }));
    const result = createCompleteDisposition({
      baseline: execution.baseline,
      completedAt: this.#now().toISOString(),
      items: input.items,
      laterItems,
    });
    return { freshness: freshness(observation), result };
  }

  discardTask(taskSessionId: string): void {
    for (const [executionId, execution] of this.#executions) {
      if (execution.taskSessionId === taskSessionId) this.#executions.delete(executionId);
    }
    for (const [planId, plan] of this.#rebuildPlans) {
      if (plan.taskSessionId === taskSessionId) this.#rebuildPlans.delete(planId);
    }
    this.#executionIdsByTask.delete(taskSessionId);
  }

  #registerExecution(executionId: string, execution: WorkflowExecution): void {
    this.#executions.set(executionId, execution);
    const executionIds = this.#executionIdsByTask.get(execution.taskSessionId) ?? [];
    executionIds.push(executionId);
    while (executionIds.length > MAX_EXECUTIONS_PER_TASK) {
      const expired = executionIds.shift();
      if (expired === undefined) continue;
      this.#executions.delete(expired);
      for (const [planId, plan] of this.#rebuildPlans) {
        if (plan.executionId === expired) this.#rebuildPlans.delete(planId);
      }
    }
    this.#executionIdsByTask.set(execution.taskSessionId, executionIds);
  }

  #authorize(handle: string): string {
    const authorization = this.#context.evidence.authorizeHandle(handle);
    if (authorization.status === "unavailable") throw unavailable(authorization.reason);
    return authorization.taskSessionId;
  }

  #executionForHandle(handle: string, executionId: string): WorkflowExecution {
    const taskSessionId = this.#authorize(handle);
    const execution = this.#executions.get(executionId);
    if (execution === undefined || execution.taskSessionId !== taskSessionId) {
      throw new Error("The source-work execution is unavailable to this task");
    }
    return execution;
  }

  async #refresh(taskSessionId: string): Promise<AtomicLiveContextObservationV1> {
    const observation = await this.#context.refresh({ taskSessionId });
    if (observation.status !== "current") {
      throw new Error(`Live PDF context is ${observation.reason}; source-work completion is blocked`);
    }
    return observation;
  }

  #assertSameObservation(
    observation: AtomicLiveContextObservationV1,
    report: SourceReconciliationReportV1,
  ): void {
    if (
      report.identity.documentGeneration !== observation.identity.documentGeneration ||
      report.identity.stateDigest !== observation.identity.stateDigest
    ) throw new Error("Review State changed during reconciliation; refresh before continuing");
  }

  async #sourceScope(taskSessionId: string): Promise<{
    readonly root: string;
    readonly sourcePdfPath: string;
  }> {
    const binding = this.#broker.taskBindings.bindingForTask(taskSessionId);
    if (binding === undefined) throw new Error("The Codex task has no active PDF binding");
    const scope = await this.#broker.projectAtomicSession(binding.reviewSessionId, async (snapshot) => {
      if (
        snapshot.documentGeneration !== binding.documentGeneration ||
        snapshot.sourceRootPath === undefined
      ) throw new Error("Clean rebuild requires an approved source root");
      return {
        root: await canonicalSourceRoot(snapshot.sourceRootPath),
        sourcePdfPath: await realpath(snapshot.sourcePdfPath),
      };
    });
    if (scope === undefined) throw new Error("The bound PDF session is no longer active");
    return scope;
  }

  async #currentReviewItems(taskSessionId: string, expectedDigest: string): Promise<readonly ReviewItem[]> {
    const binding = this.#broker.taskBindings.bindingForTask(taskSessionId);
    if (binding === undefined) throw new Error("The Codex task has no active PDF binding");
    const items = await this.#broker.projectAtomicSession(binding.reviewSessionId, async (snapshot) => {
      if (
        snapshot.documentGeneration !== binding.documentGeneration ||
        reviewSemanticDigest(snapshot.state.items) !== expectedDigest
      ) throw new Error("Review State changed before disposition completion");
      return snapshot.state.items;
    });
    if (items === undefined) throw new Error("The bound PDF session ended before disposition completion");
    return items;
  }

  async #existingOutputDigest(path: string): Promise<string | undefined> {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) return undefined;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("The rebuild output is not a regular file");
    const physical = await realpath(path);
    if (physical !== path) throw new Error("The rebuild output does not resolve canonically");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
      let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      return hash.digest("hex");
    } finally {
      await handle.close();
    }
  }
}
