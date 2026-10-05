import { parseCodexAppResponse, type CodexAdmissionFailure } from "../../../packages/core/src/codex-mcp-protocol.js";
import { RESPONSE_META_KEY, parseQualificationInvocation } from "./transport-contract.js";

const STORAGE_KEY = "placekeeper.native-lifecycle.v1";
const MAX_TRACE_ENTRIES = 24;
const MAX_STORAGE_BYTES = 8192;
const events = ["started", "connected", "invocation", "ready", "pending", "active", "verified", "renewed", "mode-request", "mode-confirmed", "teardown", "failed"] as const;
const failures = ["transport", "tool-error", "response-metadata-missing", "response-metadata-invalid", "stale-reply", "incarnation-mismatch", "unexpected-status", "unclassified", "service-denied-invalid", "service-denied-expired", "service-denied-replayed", "service-denied-owner-mismatch", "service-denied-stale-generation", "service-denied-revoked", "service-denied-unavailable"] as const;
type Event = typeof events[number];
export type DiagnosticFailure = typeof failures[number];
type Mode = "inline" | "fullscreen" | "pip";
type TraceEntry = { instance: string; at: string; event: Event; mode?: Mode; failure?: DiagnosticFailure };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
function mode(value: unknown): Mode | undefined { return value === "inline" || value === "fullscreen" || value === "pip" ? value : undefined; }
function entry(value: unknown): TraceEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["instance", "at", "event", "mode", "failure"].includes(key)) ||
    typeof raw.instance !== "string" || !uuid.test(raw.instance) || typeof raw.at !== "string" ||
    raw.at.length !== 24 || !Number.isFinite(Date.parse(raw.at)) || new Date(raw.at).toISOString() !== raw.at || !events.includes(raw.event as Event) ||
    (raw.mode !== undefined && mode(raw.mode) === undefined) ||
    (raw.failure !== undefined && !failures.includes(raw.failure as DiagnosticFailure))) return undefined;
  return { instance: raw.instance, at: raw.at, event: raw.event as Event,
    ...(raw.mode === undefined ? {} : { mode: mode(raw.mode)! }),
    ...(raw.failure === undefined ? {} : { failure: raw.failure as DiagnosticFailure }) };
}

/** Safe categories only: exception messages and tool result values never enter diagnostics. */
export class NativeDiagnosticError extends Error {
  constructor(readonly category: DiagnosticFailure) { super(category); }
}
export function diagnosticFailure(error: unknown): DiagnosticFailure {
  return error instanceof NativeDiagnosticError && failures.includes(error.category) ? error.category : "unclassified";
}
export function deniedFailure(reason: CodexAdmissionFailure): NativeDiagnosticError {
  return new NativeDiagnosticError(`service-denied-${reason}`);
}
export function verifiedAppReply(result: unknown) {
  const raw = typeof result === "object" && result !== null ? result as Record<string, unknown> : undefined;
  if (raw?.isError === true) throw new NativeDiagnosticError("tool-error");
  const metadata = raw?._meta;
  if (typeof metadata !== "object" || metadata === null || !Object.hasOwn(metadata, RESPONSE_META_KEY)) throw new NativeDiagnosticError("response-metadata-missing");
  const response = parseCodexAppResponse((metadata as Record<string, unknown>)[RESPONSE_META_KEY]);
  if (response === undefined) throw new NativeDiagnosticError("response-metadata-invalid");
  return response;
}

/** Non-authoritative, bounded observations only. Storage never supplies runtime credentials or state. */
export class LifecycleDiagnostics {
  readonly instance: string;
  readonly startedAt: string;
  readonly #now: () => Date;
  readonly #storage: Storage | undefined;
  #trace: TraceEntry[] = [];
  #qualification: ReturnType<typeof parseQualificationInvocation>;
  #storageAvailable = false;
  #phase: Event = "started";
  #lastRenewal: string | undefined;
  #lastFailure: DiagnosticFailure | undefined;
  #modeRequest: { mode: Mode; at: string } | undefined;
  constructor(instance: string, now: () => Date, storage?: Storage) {
    this.instance = uuid.test(instance) ? instance : "00000000-0000-0000-0000-000000000000";
    this.#now = now; this.startedAt = now().toISOString(); this.#storage = storage;
    try {
      const stored = storage?.getItem(STORAGE_KEY);
      if (stored !== null && stored !== undefined && stored.length <= MAX_STORAGE_BYTES) {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length <= MAX_TRACE_ENTRIES) {
          const entries = parsed.map(entry);
          if (entries.every((item) => item !== undefined)) this.#trace = entries;
        }
      }
    } catch { /* Host storage may be unavailable. It never participates in authority. */ }
    this.record("started");
  }
  record(event: Event, options: { mode?: unknown; failure?: DiagnosticFailure } = {}): void {
    if (!events.includes(event)) return;
    const at = this.#now().toISOString(), displayMode = mode(options.mode);
    const failure = failures.includes(options.failure!) ? options.failure : undefined;
    if (event !== "mode-request" && event !== "mode-confirmed") this.#phase = event;
    if (event === "renewed") this.#lastRenewal = at;
    if (failure !== undefined) this.#lastFailure = failure;
    if (event === "mode-request" && displayMode !== undefined) this.#modeRequest = { mode: displayMode, at };
    this.#trace = [...this.#trace, { instance: this.instance, at, event,
      ...(displayMode === undefined ? {} : { mode: displayMode }), ...(failure === undefined ? {} : { failure }) }].slice(-MAX_TRACE_ENTRIES);
    try { this.#storage?.setItem(STORAGE_KEY, JSON.stringify(this.#trace)); this.#storageAvailable = this.#storage !== undefined; }
    catch { this.#storageAvailable = false; }
  }
  observeInvocation(value: unknown): void {
    this.#qualification = parseQualificationInvocation(value, this.#now().getTime());
  }
  snapshot() {
    const observedAt = this.#now();
    this.#qualification = parseQualificationInvocation(this.#qualification, observedAt.getTime());
    return { ...(this.#qualification === undefined ? {} : { qualification: { ...this.#qualification } }), instance: this.instance, startedAt: this.startedAt, phase: this.#phase, observedAt: observedAt.toISOString(),
      lastFailure: this.#lastFailure ?? null,
      lastSuccessfulRenewal: this.#lastRenewal ?? "never",
      renewalAgeSeconds: this.#lastRenewal === undefined ? null : Math.max(0, Math.floor((observedAt.getTime() - Date.parse(this.#lastRenewal)) / 1000)),
      modeRequest: this.#modeRequest ?? null, traceStorage: this.#storageAvailable ? "available" : "unavailable",
      trace: this.#trace.map((item) => ({ ...item })) };
  }
}
