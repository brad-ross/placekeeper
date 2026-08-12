import { createHash, randomUUID } from "node:crypto";

import {
  createExecutionBaseline,
  createReconciliationOutcome,
  reviewSemanticDigest,
  type LiveExecutionBaselineV1,
  type ReconciliationOutcomeV1,
  type SourceFingerprint,
} from "../../../../packages/core/src/live-context.js";
import {
  projectStructuredReviewItem,
  type SourceHint,
  type StructuredReviewItem,
} from "../../../../packages/core/src/handoff.js";
import type { ReviewItem } from "../../../../packages/core/src/review-model.js";
import type { SessionBroker } from "../sessions/session-broker.js";
import { querySyncTexHintsForItems } from "../synctex/query.js";
import {
  canonicalSourceRoot,
  readScopedSource,
  type ScopedSourceRead,
} from "../files/source-scope.js";

const MAX_EXECUTIONS_PER_TASK = 8;
const MAX_PROPOSAL_TEXT_BYTES = 2 * 1024 * 1024;

export interface SourceReplacementProposalV1 {
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly baselineItemId: string;
  readonly path: string;
  readonly expectedText: string;
  readonly replacementText: string;
  readonly prefix?: string;
  readonly suffix?: string;
}

export interface AcceptedSourceProposal {
  readonly status: "accepted" | "replayed";
  readonly proposal: SourceReplacementProposalV1;
}

export interface SourceReconciliationDecision {
  readonly outcome: ReconciliationOutcomeV1;
  readonly path?: string;
  /** Digest to check again immediately before an ordinary Codex source edit. */
  readonly applyGuardSha256?: string;
}

export interface SourceReconciliationReportV1 {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly baselineDigest: string;
  readonly checkedAt: string;
  readonly outcomes: readonly SourceReconciliationDecision[];
  readonly laterItems: readonly StructuredReviewItem[];
}

interface BaselineSource extends ScopedSourceRead {}

interface ExecutionRecord {
  readonly taskSessionId: string;
  readonly reviewSessionId: string;
  readonly documentGeneration: number;
  readonly sourceRoot: string;
  readonly baseline: LiveExecutionBaselineV1;
  readonly sources: ReadonlyMap<string, BaselineSource>;
  readonly proposalsByKey: Map<string, { readonly digest: string; readonly proposal: SourceReplacementProposalV1 }>;
  readonly proposalKeyByItem: Map<string, string>;
}

export interface SourceReconciliationServiceOptions {
  readonly broker: SessionBroker;
  readonly now?: () => Date;
  readonly executionId?: () => string;
  readonly queryHints?: (input: {
    readonly items: readonly ReviewItem[];
    readonly sourceRoot: string;
    readonly pdfPath: string;
  }) => Promise<ReadonlyMap<string, SourceHint>>;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object" || value === undefined) throw new Error("Proposal is not serializable");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizedText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function occurrences(value: string, search: string): readonly number[] {
  if (search.length === 0) return [];
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= value.length - search.length) {
    const index = value.indexOf(search, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + Math.max(1, search.length);
  }
  return indexes;
}

function anchoredRegion(
  text: string,
  proposal: SourceReplacementProposalV1,
): { readonly status: "unique"; readonly text: string } | { readonly status: "none" | "ambiguous" } {
  if (proposal.prefix === undefined || proposal.suffix === undefined) return { status: "none" };
  const prefixes = occurrences(text, proposal.prefix);
  const regions: string[] = [];
  for (const prefixIndex of prefixes) {
    const start = prefixIndex + proposal.prefix.length;
    const end = text.indexOf(proposal.suffix, start);
    if (end !== -1) regions.push(text.slice(start, end));
  }
  if (regions.length === 0) return { status: "none" };
  if (regions.length > 1) return { status: "ambiguous" };
  return { status: "unique", text: regions[0]! };
}

function equivalentCurrentSource(
  baselineText: string,
  currentText: string,
  proposal: SourceReplacementProposalV1,
): boolean {
  const baselineTargets = occurrences(baselineText, proposal.expectedText);
  if (baselineTargets.length === 1) {
    const index = baselineTargets[0]!;
    const intended = baselineText.slice(0, index) + proposal.replacementText +
      baselineText.slice(index + proposal.expectedText.length);
    if (normalizedText(currentText) === normalizedText(intended)) return true;
  }
  const region = anchoredRegion(currentText, proposal);
  return region.status === "unique" &&
    normalizedText(region.text) === normalizedText(proposal.replacementText);
}

function proposalClassification(input: {
  readonly baseline: BaselineSource;
  readonly current: ScopedSourceRead;
  readonly proposal: SourceReplacementProposalV1;
  readonly guardedSha256?: string;
}): { readonly classification: "equivalent" | "independent" | "conflict" | "ambiguous"; readonly explanation: string } {
  const { baseline, current, proposal } = input;
  if (equivalentCurrentSource(baseline.text, current.text, proposal)) {
    return {
      classification: "equivalent",
      explanation: "The current manual source already satisfies the proposed semantic change; no duplicate edit is needed.",
    };
  }
  const guardChanged = input.guardedSha256 !== undefined &&
    input.guardedSha256 !== current.fingerprint.sha256;
  const baselineTargets = occurrences(baseline.text, proposal.expectedText);
  if (baselineTargets.length !== 1) {
    return {
      classification: "ambiguous",
      explanation: "The proposal target was not unique in the captured source baseline, so manual source state is preserved.",
    };
  }
  const currentTargets = occurrences(current.text, proposal.expectedText);
  const region = anchoredRegion(current.text, proposal);
  if (guardChanged) {
    return {
      classification: region.status === "ambiguous" || currentTargets.length > 1 ? "ambiguous" : "conflict",
      explanation: "The source changed after the prior reconciliation check; the later manual state takes precedence.",
    };
  }
  if (currentTargets.length === 1) {
    return {
      classification: "independent",
      explanation: current.fingerprint.sha256 === baseline.fingerprint.sha256
        ? "The unique proposal target still matches the captured source baseline."
        : "Manual source changes are outside the unique proposal target, so the proposed edit remains independent.",
    };
  }
  if (currentTargets.length > 1 || region.status === "ambiguous") {
    return {
      classification: "ambiguous",
      explanation: "The current manual source has more than one plausible target; it is preserved without guessing.",
    };
  }
  if (region.status === "unique") {
    return {
      classification: "conflict",
      explanation: "The manually edited target differs from both the captured and proposed text; the manual edit takes precedence.",
    };
  }
  return {
    classification: "ambiguous",
    explanation: "The proposal target can no longer be located reliably in current source; manual state is preserved.",
  };
}

function outcome(
  baselineItemId: string,
  classification: "equivalent" | "independent" | "conflict" | "ambiguous" | "removed",
  explanation: string,
): ReconciliationOutcomeV1 {
  if (classification === "equivalent") {
    return createReconciliationOutcome({
      baselineItemId, classification, action: "deduplicate", authority: "manual", explanation,
    });
  }
  if (classification === "independent") {
    return createReconciliationOutcome({
      baselineItemId, classification, action: "apply", authority: "codex", explanation,
    });
  }
  return createReconciliationOutcome({
    baselineItemId,
    classification,
    action: "skip",
    authority: "manual",
    explanation,
  });
}

function proposalBytes(proposal: SourceReplacementProposalV1): number {
  return Buffer.byteLength(proposal.expectedText) + Buffer.byteLength(proposal.replacementText) +
    Buffer.byteLength(proposal.prefix ?? "") + Buffer.byteLength(proposal.suffix ?? "");
}

function assertProposal(proposal: SourceReplacementProposalV1): void {
  if (proposal.schemaVersion !== 1 || proposal.idempotencyKey.trim().length === 0) {
    throw new Error("A versioned proposal with a non-empty idempotency key is required");
  }
  if (proposal.expectedText.length === 0 || proposalBytes(proposal) > MAX_PROPOSAL_TEXT_BYTES) {
    throw new Error("The proposal target must be non-empty and within the source-work size limit");
  }
}

export class SourceReconciliationService {
  readonly #broker: SessionBroker;
  readonly #now: () => Date;
  readonly #executionId: () => string;
  readonly #queryHints: NonNullable<SourceReconciliationServiceOptions["queryHints"]>;
  readonly #records = new Map<string, ExecutionRecord>();
  readonly #executionIdsByTask = new Map<string, string[]>();
  readonly #taskTails = new Map<string, Promise<void>>();

  constructor(options: SourceReconciliationServiceOptions) {
    this.#broker = options.broker;
    this.#now = options.now ?? (() => new Date());
    this.#executionId = options.executionId ?? randomUUID;
    this.#queryHints = options.queryHints ?? querySyncTexHintsForItems;
  }

  captureBaseline(input: {
    readonly taskSessionId: string;
    readonly sourcePaths?: readonly string[];
  }): Promise<LiveExecutionBaselineV1> {
    return this.#serializeTask(input.taskSessionId, async () => {
      const binding = this.#broker.taskBindings.bindingForTask(input.taskSessionId);
      if (binding === undefined) throw new Error("The Codex task has no active PDF binding");
      const capturedAt = this.#now().toISOString();
      const executionId = this.#executionId();
      const captured = await this.#broker.projectAtomicSession(binding.reviewSessionId, async (snapshot) => {
        if (snapshot.documentGeneration !== binding.documentGeneration) {
          throw new Error("The PDF generation changed before source-work baseline capture");
        }
        if (snapshot.sourceRootPath === undefined) {
          throw new Error("Source work requires an approved source root");
        }
        const root = await canonicalSourceRoot(snapshot.sourceRootPath);
        const hints = await this.#queryHints({
          items: snapshot.state.items,
          sourceRoot: root,
          pdfPath: snapshot.sourcePdfPath,
        });
        const requestedPaths = new Set([
          ...(input.sourcePaths ?? []),
          ...[...hints.values()].map(({ path }) => path),
        ]);
        const sources = new Map<string, BaselineSource>();
        for (const requestedPath of requestedPaths) {
          const source = await readScopedSource(root, requestedPath);
          if (sources.has(source.fingerprint.path)) continue;
          sources.set(source.fingerprint.path, source);
        }
        const structuredItems = snapshot.state.items.map((item) =>
          projectStructuredReviewItem(item, hints.get(item.id)),
        );
        const identity = {
          proofreaderSessionId: snapshot.sessionId,
          documentGeneration: snapshot.documentGeneration,
          source: { ...snapshot.state.source },
          reviewRevision: snapshot.state.revision,
          stateDigest: reviewSemanticDigest(snapshot.state.items),
        };
        const sourceFingerprints: SourceFingerprint[] = [...sources.values()].map(({ fingerprint }) => fingerprint);
        const baseline = createExecutionBaseline({
          executionId,
          capturedAt,
          identity,
          items: structuredItems,
          sourceFingerprints,
        });
        return { root, sources, baseline };
      });
      if (captured === undefined) throw new Error("The bound PDF session is no longer active");
      const record: ExecutionRecord = {
        taskSessionId: input.taskSessionId,
        reviewSessionId: binding.reviewSessionId,
        documentGeneration: binding.documentGeneration,
        sourceRoot: captured.root,
        baseline: captured.baseline,
        sources: captured.sources,
        proposalsByKey: new Map(),
        proposalKeyByItem: new Map(),
      };
      this.#records.set(executionId, record);
      const taskExecutions = this.#executionIdsByTask.get(input.taskSessionId) ?? [];
      taskExecutions.push(executionId);
      while (taskExecutions.length > MAX_EXECUTIONS_PER_TASK) {
        const expired = taskExecutions.shift();
        if (expired !== undefined) this.#records.delete(expired);
      }
      this.#executionIdsByTask.set(input.taskSessionId, taskExecutions);
      return captured.baseline;
    });
  }

  acceptProposal(input: {
    readonly taskSessionId: string;
    readonly executionId: string;
    readonly proposal: SourceReplacementProposalV1;
  }): Promise<AcceptedSourceProposal> {
    return this.#serializeTask(input.taskSessionId, async () => {
      const record = this.#record(input.taskSessionId, input.executionId);
      assertProposal(input.proposal);
      if (!record.baseline.items.some(({ id }) => id === input.proposal.baselineItemId)) {
        throw new Error("The proposal does not name an item in this execution baseline");
      }
      const source = record.sources.get(input.proposal.path);
      if (source === undefined) {
        throw new Error("The proposal path was not captured inside this execution's approved source scope");
      }
      const proposalDigest = digest(input.proposal);
      const prior = record.proposalsByKey.get(input.proposal.idempotencyKey);
      if (prior !== undefined) {
        if (prior.digest !== proposalDigest) throw new Error("An idempotency key cannot be reused for different source work");
        return { status: "replayed", proposal: prior.proposal };
      }
      const priorItemKey = record.proposalKeyByItem.get(input.proposal.baselineItemId);
      if (priorItemKey !== undefined) {
        throw new Error("Each baseline Review Item accepts one idempotent proposal per execution");
      }
      const canonicalProposal = { ...input.proposal, path: source.fingerprint.path };
      record.proposalsByKey.set(input.proposal.idempotencyKey, {
        digest: proposalDigest,
        proposal: canonicalProposal,
      });
      record.proposalKeyByItem.set(input.proposal.baselineItemId, input.proposal.idempotencyKey);
      return { status: "accepted", proposal: canonicalProposal };
    });
  }

  reconcile(input: {
    readonly taskSessionId: string;
    readonly executionId: string;
    /** Guards a second, immediately-before-apply check against the first check. */
    readonly expectedSourceSha256ByProposal?: Readonly<Record<string, string>>;
  }): Promise<SourceReconciliationReportV1> {
    return this.#serializeTask(input.taskSessionId, async () => {
      const record = this.#record(input.taskSessionId, input.executionId);
      const binding = this.#broker.taskBindings.bindingForTask(input.taskSessionId);
      if (
        binding === undefined || binding.reviewSessionId !== record.reviewSessionId ||
        binding.documentGeneration !== record.documentGeneration
      ) throw new Error("The execution no longer belongs to the task's active PDF generation");
      const checkedAt = this.#now().toISOString();
      const report = await this.#broker.projectAtomicSession(record.reviewSessionId, async (snapshot) => {
        if (snapshot.documentGeneration !== record.documentGeneration) {
          throw new Error("The PDF generation changed during reconciliation");
        }
        const currentById = new Map(snapshot.state.items.map((item) => [item.id, item]));
        const baselineIds = new Set(record.baseline.items.map(({ id }) => id));
        const currentSources = new Map<string, ScopedSourceRead>();
        for (const proposalRecord of record.proposalsByKey.values()) {
          const path = proposalRecord.proposal.path;
          if (!currentSources.has(path)) currentSources.set(path, await readScopedSource(record.sourceRoot, path));
        }
        const outcomes = record.baseline.items.map((baselineItem): SourceReconciliationDecision => {
          const currentItem = currentById.get(baselineItem.id);
          if (currentItem === undefined) {
            return {
              outcome: outcome(
                baselineItem.id,
                "removed",
                "The manual Review Item was removed after baseline capture and is preserved as removed.",
              ),
            };
          }
          const proposalKey = record.proposalKeyByItem.get(baselineItem.id);
          if (proposalKey === undefined) {
            return {
              outcome: outcome(
                baselineItem.id,
                "ambiguous",
                "No source proposal was registered for this baseline Review Item; no source change is inferred.",
              ),
            };
          }
          const proposal = record.proposalsByKey.get(proposalKey)!.proposal;
          const currentStructured = projectStructuredReviewItem(currentItem, baselineItem.sourceHint);
          if (digest(currentStructured) !== digest(baselineItem)) {
            return {
              path: proposal.path,
              outcome: outcome(
                baselineItem.id,
                "conflict",
                "The Review Item was manually edited after baseline capture; its current semantics take precedence.",
              ),
            };
          }
          const baselineSource = record.sources.get(proposal.path)!;
          const currentSource = currentSources.get(proposal.path)!;
          const classified = proposalClassification({
            baseline: baselineSource,
            current: currentSource,
            proposal,
            ...(input.expectedSourceSha256ByProposal?.[proposalKey] === undefined
              ? {}
              : { guardedSha256: input.expectedSourceSha256ByProposal[proposalKey] }),
          });
          const reconciled = outcome(baselineItem.id, classified.classification, classified.explanation);
          return {
            outcome: reconciled,
            path: proposal.path,
            ...(reconciled.classification === "independent"
              ? { applyGuardSha256: currentSource.fingerprint.sha256 }
              : {}),
          };
        });
        const laterItems = snapshot.state.items
          .filter(({ id }) => !baselineIds.has(id))
          .map((item) => projectStructuredReviewItem(item));
        return { outcomes, laterItems };
      });
      if (report === undefined) throw new Error("The bound PDF session ended during reconciliation");
      return {
        schemaVersion: 1,
        executionId: record.baseline.executionId,
        baselineDigest: record.baseline.baselineDigest,
        checkedAt,
        outcomes: report.outcomes,
        laterItems: report.laterItems,
      };
    });
  }

  discardTask(taskSessionId: string): void {
    for (const executionId of this.#executionIdsByTask.get(taskSessionId) ?? []) {
      this.#records.delete(executionId);
    }
    this.#executionIdsByTask.delete(taskSessionId);
  }

  #record(taskSessionId: string, executionId: string): ExecutionRecord {
    const record = this.#records.get(executionId);
    if (record === undefined || record.taskSessionId !== taskSessionId) {
      throw new Error("The source-work execution is unavailable to this task");
    }
    return record;
  }

  #serializeTask<T>(taskSessionId: string, work: () => Promise<T>): Promise<T> {
    const predecessor = this.#taskTails.get(taskSessionId) ?? Promise.resolve();
    const run = predecessor.then(work, work);
    const tail = run.then(() => undefined, () => undefined);
    this.#taskTails.set(taskSessionId, tail);
    return run.finally(() => {
      if (this.#taskTails.get(taskSessionId) === tail) this.#taskTails.delete(taskSessionId);
    });
  }
}
