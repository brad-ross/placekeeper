/** Browser-safe identifiers shared by the packaged server and native shell. */
export const APP_TOOL = "review_app";
export const PENDING_META_KEY = "placekeeper/pending";
export const RESPONSE_META_KEY = "placekeeper/response";

export const QUALIFICATION_META_KEY = "placekeeper/qualification";

/** Nonauthority correlation only; never a selector or credential. */
export function parseQualificationInvocation(value: unknown, nowMs: number) {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    if (Object.keys(raw).sort().join(",") !== "expiresAt,invocationNonce,runId" ||
      typeof raw.runId !== "string" || !/^[a-f0-9]{32}$/u.test(raw.runId) ||
      typeof raw.invocationNonce !== "string" || !/^[a-f0-9]{32}$/u.test(raw.invocationNonce) ||
      typeof raw.expiresAt !== "string" || raw.expiresAt.length !== 24) return undefined;
    const expiry = Date.parse(raw.expiresAt);
    if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== raw.expiresAt || expiry <= nowMs || expiry - nowMs > 30 * 60_000) return undefined;
    return { runId: raw.runId, invocationNonce: raw.invocationNonce, expiresAt: raw.expiresAt };
  } catch { return undefined; }
}
