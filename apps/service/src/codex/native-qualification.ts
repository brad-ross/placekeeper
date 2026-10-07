import { qualificationDirectory, readQualificationDescriptor } from "./native-qualification-files.js";
import { REVIEW_RUNTIME_METHODS } from "../../../../packages/core/src/review-runtime-protocol.js";
import { createHmac, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

const EVENTS = Object.freeze(["claim-arrived", "claim-accepted", "claim-denied", "claim-conflict", "display-issued", "attestation-arrived", "attestation-accepted", "attestation-denied", "ready-accepted", "pending-denied", "promotion-accepted", "panel-expired", "panel-ended", "app-result", "invocation-issued", "hook-parsed", "hook-result", "experiment-selected", "experiment-delivery", "experiment-incomplete", "hook-delay-start", "hook-delay-end"] as const);
const DENIALS = Object.freeze(["proof-missing-or-expired", "task-associated-other-review", "review-owned-other-task", "generation-mismatch", "launch-not-current", "invalid", "expired", "replayed", "owner-mismatch", "stale-generation", "revoked", "unavailable"] as const);
const METHODS = Object.freeze(["ready", "status", "reconnect", "renew", "detach", "watermark", "bootstrap", "resource", ...REVIEW_RUNTIME_METHODS]);
const STATUSES = Object.freeze(["accepted", "denied", "pending", "active", "ok", "operation-error", "ignored", "claim", "attest", "refresh", "revoke"]);
const FIELDS = Object.freeze(["session_id", "hook_event_name", "tool_name", "tool_input", "tool_response", "prompt"]);
const nonce = () => randomBytes(16).toString("hex");
type Event = typeof EVENTS[number];
export interface QualificationFields {
  readonly taskSessionId?: string | undefined;
  readonly reviewSessionId?: string;
  readonly runtimeId?: string;
  readonly attemptId?: string;
  readonly receiptId?: string;
  readonly generation?: number;
  readonly method?: string;
  readonly status?: string;
  readonly denial?: string;
  readonly invocationNonce?: string;
  readonly envelope?: string;
  readonly uiResource?: boolean;
  readonly privateMetadata?: boolean;
  readonly contentCount?: number;
  readonly structuredKeyCount?: number;
  readonly panelExists?: boolean;
  readonly restarting?: boolean;
  readonly alreadyAttested?: boolean;
  readonly attemptMatch?: boolean;
  readonly generationMatch?: boolean;
  readonly ownerMatch?: boolean;
  readonly fieldShape?: readonly string[];
}
interface Descriptor { version: 1; runId: string; createdAt: string; expiresAt: string; salt: string; observe: true }
export interface QualificationInvocation { readonly runId: string; readonly expiresAt: string; readonly invocationNonce: string }
/** Local qualification only. Every observation revalidates the closed descriptor;
 * all failures drop records and can never enter the protocol decision path. */
export class NativeQualificationObserver {
  readonly #root: string;
  readonly #source: "daemon" | "hook" | "server";
  readonly #processNonce = nonce();
  #writer: { runId: string; path: string; sequence: number; bytes: number } | undefined;
  #failed = false;
  #exhaustedRun: string | undefined;
  // Correlation and closed output shape only; never authority or credentials.
  readonly #appResults = new Map<string, string>();
  constructor(appSupportRoot: string, source: "daemon" | "hook" | "server") { this.#root = appSupportRoot; this.#source = source; }
  /** Public correlation only; never runtime identity or admission authority. */
  get processNonce(): string { return this.#processNonce; }
  #descriptor(): Descriptor | undefined {
    if (this.#failed) return undefined;
    try {
      const raw: unknown = JSON.parse(readQualificationDescriptor(join(this.#root, "native-qualification.json")));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
      const d = raw as Descriptor;
      if (Object.keys(d).sort().join(",") !== "createdAt,expiresAt,observe,runId,salt,version" || d.version !== 1 || d.observe !== true ||
        typeof d.runId !== "string" || !/^[a-f0-9]{32}$/u.test(d.runId) || typeof d.salt !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(d.salt) ||
        typeof d.createdAt !== "string" || typeof d.expiresAt !== "string" || d.createdAt.length !== 24 || d.expiresAt.length !== 24) return undefined;
      const created = Date.parse(d.createdAt), expiry = Date.parse(d.expiresAt), now = Date.now();
      if (!Number.isFinite(created) || !Number.isFinite(expiry) || new Date(created).toISOString() !== d.createdAt || new Date(expiry).toISOString() !== d.expiresAt || created > now || expiry <= now || expiry <= created || expiry - created > 30 * 60_000) return undefined;
      return d;
    } catch { return undefined; }
  }
  invocation(fields: QualificationFields = {}): QualificationInvocation | undefined {
    try {
      const d = this.#descriptor();
      if (d === undefined) { this.#appResults.clear(); return undefined; }
      const invocationNonce = nonce();
      if (!this.#append(d, "invocation-issued", { ...fields, invocationNonce })) return undefined;
      return { runId: d.runId, expiresAt: d.expiresAt, invocationNonce };
    } catch { return undefined; }
  }
  record(event: Event, fields: QualificationFields = {}): void {
    try {
      const d = this.#descriptor();
      if (d === undefined) this.#appResults.clear();
      else if (EVENTS.includes(event)) this.#append(d, event, fields);
    } catch { /* Observation cannot affect callers. */ }
  }
  #append(d: Descriptor, event: Event, fields: QualificationFields): boolean {
    try {
      // The descriptor was revalidated by the caller. A new run can allocate,
      // but a full run must not retry 64 exclusive creates on every poll.
      if (this.#exhaustedRun === d.runId) return false;
      this.#exhaustedRun = undefined;
      if (this.#writer?.runId !== d.runId) {
        this.#appResults.clear();
        const parent = join(this.#root, "native-qualification"), root = join(parent, d.runId);
        qualificationDirectory(parent); qualificationDirectory(root);
        let path: string | undefined;
        for (let slot = 0; slot < 64; slot++) {
          const candidate = join(root, `writer-${slot}.jsonl`);
          try { closeSync(openSync(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); path = candidate; break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        }
        if (path === undefined) { this.#exhaustedRun = d.runId; return false; }
        this.#writer = { runId: d.runId, path, sequence: 0, bytes: 0 };
      }
      const writer = this.#writer;
      if (writer.sequence >= 256) return false;
      const out: Record<string, unknown> = { version: 1, runId: d.runId, source: this.#source, processNonce: this.#processNonce, sequence: writer.sequence + 1, at: new Date().toISOString(), event };
      const hash = (domain: string, value: string) => createHmac("sha256", d.salt).update(domain + "\0" + value).digest("hex");
      for (const [key, domain, value] of [["taskHash", "task", fields.taskSessionId], ["reviewHash", "review", fields.reviewSessionId], ["envelopeHash", "envelope", fields.envelope]] as const) {
        if (typeof value === "string" && value.length > 0 && value.length <= 2048) out[key] = hash(domain, value);
      }
      for (const key of ["runtimeId", "attemptId", "receiptId", "invocationNonce"] as const) {
        const value = fields[key]; if (typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/u.test(value)) out[key] = value;
      }
      if (Number.isSafeInteger(fields.generation) && fields.generation! >= 0) out.generation = fields.generation;
      if (METHODS.includes(fields.method!)) out.method = fields.method;
      if (STATUSES.includes(fields.status!)) out.status = fields.status;
      if (DENIALS.includes(fields.denial as typeof DENIALS[number])) out.denial = fields.denial;
      for (const key of ["uiResource", "privateMetadata", "panelExists", "restarting", "alreadyAttested", "attemptMatch", "generationMatch", "ownerMatch"] as const) if (typeof fields[key] === "boolean") out[key] = fields[key];
      for (const key of ["contentCount", "structuredKeyCount"] as const) if (Number.isSafeInteger(fields[key]) && fields[key]! >= 0 && fields[key]! <= 64) out[key] = fields[key];
      if (Array.isArray(fields.fieldShape)) out.fieldShape = fields.fieldShape.slice(0, 6).filter(v => typeof v === "string" && FIELDS.some(key => ["string", "object", "number", "boolean", "undefined"].some(type => v === `${key}:${type}`)));
      const appKey = event === "app-result" && out.runtimeId !== undefined && out.attemptId !== undefined && out.method !== undefined
        ? JSON.stringify([out.runtimeId, out.attemptId, out.method]) : undefined;
      const appShape = JSON.stringify([out.status, out.generation, out.uiResource, out.privateMetadata, out.contentCount, out.structuredKeyCount]);
      // Always retain denials and changes, including a successful recovery after
      // denial. Unchanged successful polling must not crowd out admission/expiry.
      if (appKey !== undefined && ["ok", "pending", "active"].includes(fields.status!) && this.#appResults.get(appKey) === appShape) return true;
      const line = JSON.stringify(out) + "\n", bytes = Buffer.byteLength(line);
      if (bytes > 2048 || writer.bytes + bytes > 32768) return false;
      const fd = openSync(writer.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 || stat.size !== writer.bytes) throw new Error("invalid-sink");
        if (writeSync(fd, line) !== bytes) throw new Error("partial-sink");
      } finally { closeSync(fd); }
      writer.sequence++; writer.bytes += bytes;
      if (appKey !== undefined && (this.#appResults.has(appKey) || this.#appResults.size < 256)) this.#appResults.set(appKey, appShape);
      return true;
    } catch { this.#failed = true; this.#writer = undefined; this.#appResults.clear(); return false; }
  }
}
