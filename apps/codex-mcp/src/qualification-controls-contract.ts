/** Qualification selectors are public correlations, never protocol authority. */
export const QUALIFICATION_CONTROLS_META_KEY = "placekeeper/qualification-controls";
export type QualificationAction = "request-teardown" | "bridge-close";
export interface QualificationTarget {
  runId: string; processNonce: string; invocationNonce: string; runtimeId: string; attemptId: string;
}
export interface QualificationControlGrant {
  version: 1; actionId: string; action: QualificationAction;
  createdAt: string; expiresAt: string; budget: 1; target: QualificationTarget;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export function qualificationTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length !== 24) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : undefined;
}
export function parseQualificationTarget(value: unknown): QualificationTarget | undefined {
  if (!object(value) || Object.keys(value).sort().join(",") !== "attemptId,invocationNonce,processNonce,runId,runtimeId") return undefined;
  for (const key of ["runId", "processNonce", "invocationNonce"] as const) if (typeof value[key] !== "string" || !/^[a-f0-9]{32}$/u.test(value[key])) return undefined;
  for (const key of ["runtimeId", "attemptId"] as const) if (typeof value[key] !== "string" || !/^[A-Za-z0-9_-]{8,64}$/u.test(value[key])) return undefined;
  return { runId: value.runId as string, processNonce: value.processNonce as string, invocationNonce: value.invocationNonce as string, runtimeId: value.runtimeId as string, attemptId: value.attemptId as string };
}
export function sameQualificationTarget(a: QualificationTarget, b: QualificationTarget): boolean {
  return a.runId === b.runId && a.processNonce === b.processNonce && a.invocationNonce === b.invocationNonce && a.runtimeId === b.runtimeId && a.attemptId === b.attemptId;
}
/** Shared closed fields; each named contract validates its own exact action. */
export function parseQualificationGrantFields(value: unknown, now: number): Omit<QualificationControlGrant, "action"> | undefined {
  try {
    if (!object(value) || Object.keys(value).sort().join(",") !== "action,actionId,budget,createdAt,expiresAt,target,version" || value.version !== 1 || value.budget !== 1 ||
      typeof value.actionId !== "string" || !/^[a-f0-9]{32}$/u.test(value.actionId)) return undefined;
    const target = parseQualificationTarget(value.target), created = qualificationTimestamp(value.createdAt), expiry = qualificationTimestamp(value.expiresAt);
    if (target === undefined || created === undefined || expiry === undefined || created > now || expiry <= now || expiry <= created || expiry - created > 30 * 60_000) return undefined;
    return { version: 1, actionId: value.actionId, createdAt: value.createdAt as string, expiresAt: value.expiresAt as string, budget: 1, target };
  } catch { return undefined; }
}
export function parseQualificationControlGrant(value: unknown, now: number): QualificationControlGrant | undefined {
  try {
    if (!object(value) || (value.action !== "request-teardown" && value.action !== "bridge-close")) return undefined;
    const fields = parseQualificationGrantFields(value, now);
    return fields === undefined ? undefined : { ...fields, action: value.action };
  } catch { return undefined; }
}
