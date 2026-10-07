import { parseQualificationGrantFields, type QualificationTarget } from "./qualification-controls-contract.js";
export const OLD_ATTEMPT_META_KEY = "placekeeper/qualification-old-attempt";
export interface OldAttemptGrant {
  version: 1; actionId: string; action: "retire-own-attempt-then-probe-once";
  createdAt: string; expiresAt: string; budget: 1; target: QualificationTarget;
}
/** Separate named contract; the v1 close control action allowlist remains unchanged. */
export function parseOldAttemptGrant(value: unknown, now: number): OldAttemptGrant | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !("action" in value) || value.action !== "retire-own-attempt-then-probe-once") return undefined;
    const parsed = parseQualificationGrantFields(value, now);
    return parsed === undefined ? undefined : { ...parsed, action: "retire-own-attempt-then-probe-once" };
  } catch { return undefined; }
}
