/** The native page exchanges geometry and status only; editor authority stays in the daemon. */
export type NativeForwardState =
  | { readonly status: "idle" }
  | { readonly status: "pending" | "applied" | "failed"; readonly sequence: number; readonly reason?: NativeSyncTexFailure }
  | { readonly status: "ready"; readonly sequence: number; readonly generation: number; readonly pageIndex: number;
      readonly point: { readonly x: number; readonly y: number } };
export const NATIVE_SYNCTEX_FAILURES = ["missing", "ambiguous", "out-of-root", "unavailable-tool", "timeout", "failed", "stale", "editor-unavailable", "editor-refused", "editor-timeout", "editor-failed", "editor-location-unsupported"] as const;
export type NativeSyncTexFailure = typeof NATIVE_SYNCTEX_FAILURES[number];
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
export function nativeSyncTexRequest(method: "forwardSyncTex" | "reverseSyncTex", raw: unknown): unknown | undefined {
  if (!object(raw)) return undefined;
  if (method === "forwardSyncTex") {
    if (raw.action === "poll" && keys(raw, ["action"])) return { action: "poll" };
    if (raw.action === "ack" && keys(raw, ["action", "sequence", "generation", "outcome"]) && integer(raw.sequence) &&
      integer(raw.generation) && ["applied", "superseded", "failed"].includes(String(raw.outcome))) {
      return { action: "ack", sequence: raw.sequence, generation: raw.generation, outcome: raw.outcome };
    }
  } else if (keys(raw, ["pageIndex", "point"]) && integer(raw.pageIndex) && object(raw.point) && keys(raw.point, ["x", "y"]) &&
    typeof raw.point.x === "number" && Number.isFinite(raw.point.x) && typeof raw.point.y === "number" && Number.isFinite(raw.point.y)) {
    return { pageIndex: raw.pageIndex, point: { x: raw.point.x, y: raw.point.y } };
  }
  return undefined;
}
export function nativeSyncTexResponse(method: "forwardSyncTex" | "reverseSyncTex", raw: unknown): unknown | undefined {
  if (!object(raw)) return undefined;
  if (method === "reverseSyncTex") {
    if (!["opened", "setup-required", "failed", "stale"].includes(String(raw.status))) return undefined;
    return { status: raw.status, ...(NATIVE_SYNCTEX_FAILURES.includes(raw.reason as NativeSyncTexFailure) ? { reason: raw.reason } : {}) };
  }
  if (raw.status === "idle") return { status: "idle" };
  if (!integer(raw.sequence)) return undefined;
  if (["pending", "applied", "failed"].includes(String(raw.status))) return { status: raw.status, sequence: raw.sequence,
    ...(NATIVE_SYNCTEX_FAILURES.includes(raw.reason as NativeSyncTexFailure) ? { reason: raw.reason } : {}) };
  if (raw.status !== "ready" || !integer(raw.generation)) return undefined;
  const target = nativeSyncTexRequest("reverseSyncTex", { pageIndex: raw.pageIndex, point: raw.point });
  return target === undefined ? undefined : { status: "ready", sequence: raw.sequence, generation: raw.generation, ...target as object };
}
