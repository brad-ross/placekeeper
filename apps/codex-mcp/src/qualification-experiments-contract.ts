import { qualificationTimestamp } from "./qualification-controls-contract.js";
/** Public process/run correlations select scheduling only; never chat authority. */
export interface ExperimentSelector { runId: string; processNonce: string }
interface Base { version: 1; actionId: string; createdAt: string; expiresAt: string; budget: 1 }
export type QualificationExperiment = Base & (
  | { action: "genuine-attestation-after-readiness"; target: ExperimentSelector; waitMs: number }
  | { action: "genuine-attestation-delay"; target: ExperimentSelector; delayMs: number }
  | { action: "paired-public-result-exchange"; targets: [ExperimentSelector, ExperimentSelector]; rendezvousMs: number }
  | { action: "old-public-result-on-fresh-display"; target: ExperimentSelector; source: { runId: string; invocationNonce: string } }
);
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const experimentNonce = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{32}$/u.test(v);
export function experimentSelector(v: unknown): ExperimentSelector | undefined {
  return object(v) && Object.keys(v).sort().join(",") === "processNonce,runId" && experimentNonce(v.runId) && experimentNonce(v.processNonce)
    ? { runId: v.runId, processNonce: v.processNonce } : undefined;
}
export function parseQualificationExperiment(v: unknown, now: number): QualificationExperiment | undefined {
  if (!object(v) || v.version !== 1 || v.budget !== 1 || !experimentNonce(v.actionId)) return undefined;
  const created = qualificationTimestamp(v.createdAt), expiry = qualificationTimestamp(v.expiresAt);
  if (created === undefined || expiry === undefined || created > now || expiry <= now || expiry <= created || expiry - created > 30 * 60_000) return undefined;
  const base: Base = { version: 1, actionId: v.actionId, createdAt: v.createdAt as string, expiresAt: v.expiresAt as string, budget: 1 };
  const keys = Object.keys(v).sort().join(",");
  if (v.action === "genuine-attestation-after-readiness" && keys === "action,actionId,budget,createdAt,expiresAt,target,version,waitMs") {
    const target = experimentSelector(v.target);
    if (target !== undefined && Number.isInteger(v.waitMs) && Number(v.waitMs) >= 1 && Number(v.waitMs) <= 40000) return { ...base, action: v.action, target, waitMs: v.waitMs as number };
  }
  if (v.action === "genuine-attestation-delay" && keys === "action,actionId,budget,createdAt,delayMs,expiresAt,target,version") {
    const target = experimentSelector(v.target);
    if (target !== undefined && Number.isInteger(v.delayMs) && Number(v.delayMs) >= 1 && Number(v.delayMs) <= 1000) return { ...base, action: v.action, target, delayMs: v.delayMs as number };
  }
  if (v.action === "paired-public-result-exchange" && keys === "action,actionId,budget,createdAt,expiresAt,rendezvousMs,targets,version" && Array.isArray(v.targets) && v.targets.length === 2) {
    const a = experimentSelector(v.targets[0]), b = experimentSelector(v.targets[1]);
    if (a !== undefined && b !== undefined && a.runId === b.runId && a.processNonce !== b.processNonce && Number.isInteger(v.rendezvousMs) && Number(v.rendezvousMs) >= 1 && Number(v.rendezvousMs) <= 5000) return { ...base, action: v.action, targets: [a, b], rendezvousMs: v.rendezvousMs as number };
  }
  if (v.action === "old-public-result-on-fresh-display" && keys === "action,actionId,budget,createdAt,expiresAt,source,target,version") {
    const target = experimentSelector(v.target), source = v.source;
    if (target !== undefined && object(source) && Object.keys(source).sort().join(",") === "invocationNonce,runId" && experimentNonce(source.runId) && experimentNonce(source.invocationNonce)) return { ...base, action: v.action, target, source: { runId: source.runId, invocationNonce: source.invocationNonce } };
  }
  return undefined;
}
