import type { CodexAppRequest, CodexAppResponse, CodexAdmissionFailure } from "../../../packages/core/src/codex-mcp-protocol.js";
import { parseOldAttemptGrant, type OldAttemptGrant } from "./old-attempt-contract.js";
import type { QualificationTarget } from "./qualification-controls-contract.js";
import { verifiedAppReply } from "./lifecycle-diagnostics.js";
type Active = Extract<CodexAppResponse, { status: "active" }>;
type Identity = Pick<Active, "runtimeId" | "attemptId" | "generation" | "presentationCapability">;
type Own = Omit<QualificationTarget, "processNonce">;
export type OldAttemptPhase = "armed" | "retiring" | "retired" | "probing" | "completed" | "failed" | "expired" | "canceled" | "unsupported";
type Reply = { status: "denied"; reason: CodexAdmissionFailure } | { status: Exclude<CodexAppResponse["status"], "denied"> };
type Outcome = { method: "renew" | "detach"; result: "denied" | "unexpected-success" | "failed"; denial?: CodexAdmissionFailure; at: string };
export interface OldAttemptSdk {
  call(request: CodexAppRequest, options: { signal: AbortSignal; timeout: number; maxTotalTimeout: number }): Promise<unknown>;
}
/** Private authority stays in this controller and is never returned by snapshot. */
export class ShellOldAttempt {
  #grant: OldAttemptGrant | undefined;
  #identity: Identity | undefined;
  #used = false;
  #epoch = 0;
  #deadline = 0;
  #expiry: ReturnType<typeof setTimeout> | undefined;
  #requestExpiry: ReturnType<typeof setTimeout> | undefined;
  #abort: AbortController | undefined;
  #phase: OldAttemptPhase | undefined;
  #target: QualificationTarget | undefined;
  #outcomes: Outcome[] = [];
  constructor(readonly now: () => number = Date.now, readonly changed: () => void = () => {}) {}
  arm(value: unknown, own: Own, active: Active): boolean {
    const grant = parseOldAttemptGrant(value, this.now());
    if (this.#used || this.#grant !== undefined || grant === undefined || Object.entries(own).some(([key, value]) => grant.target[key as keyof Own] !== value) || active.runtimeId !== own.runtimeId || active.attemptId !== own.attemptId) return false;
    this.#grant = grant; this.#target = { ...grant.target }; this.#deadline = Date.parse(grant.expiresAt); this.#phase = "armed";
    this.#expiry = setTimeout(() => this.clear("expired"), Math.max(0, this.#deadline - this.now())); this.changed(); return true;
  }
  #live(): boolean { if (this.#grant === undefined) return false; if (this.now() >= this.#deadline) { this.clear("expired"); return false; } return true; }
  canRetire(): boolean { return this.#phase === "armed" && this.#live(); }
  canProbe(): boolean { return this.#phase === "retired" && this.#identity !== undefined && this.#live(); }
  retire(own: Own, active: Active, sdk: OldAttemptSdk, stopOrdinary: () => void): Promise<boolean> {
    if (!this.canRetire() || this.#grant === undefined || Object.entries(own).some(([key, value]) => this.#grant!.target[key as keyof Own] !== value) || active.runtimeId !== own.runtimeId || active.attemptId !== own.attemptId) return Promise.resolve(false);
    this.#used = true; this.#identity = { runtimeId: active.runtimeId, attemptId: active.attemptId, generation: active.generation, presentationCapability: active.presentationCapability };
    this.#deadline = Math.min(this.#deadline, this.now() + 120_000);
    if (this.#expiry !== undefined) clearTimeout(this.#expiry);
    this.#expiry = setTimeout(() => this.clear("expired"), Math.max(0, this.#deadline - this.now()));
    this.#phase = "retiring";
    return this.#finishRetire(sdk, stopOrdinary, this.#epoch);
  }
  async #finishRetire(sdk: OldAttemptSdk, stopOrdinary: () => void, epoch: number): Promise<boolean> {
    // Invalidate normal state before the sole ordinary authenticated detach.
    try { stopOrdinary(); this.changed(); const reply = await this.#send("detach", sdk);
      if (epoch !== this.#epoch || !this.#live()) return true;
      if (reply.status !== "ok") { this.clear("failed"); return true; }
      this.#phase = "retired"; this.changed();
    } catch { if (epoch === this.#epoch) this.clear("failed"); }
    return true;
  }
  async probe(sdk: OldAttemptSdk): Promise<boolean> {
    if (!this.canProbe()) return false;
    this.#phase = "probing"; const epoch = this.#epoch; this.changed();
    for (const method of ["renew", "detach"] as const) {
      if (epoch !== this.#epoch || !this.#live()) return true;
      try {
        const reply = await this.#send(method, sdk);
        if (epoch !== this.#epoch || !this.#live()) return true;
        this.#outcomes.push({ method, result: reply.status === "denied" ? "denied" : "unexpected-success", ...(reply.status === "denied" ? { denial: reply.reason } : {}), at: new Date(this.now()).toISOString() });
        this.changed();
      } catch { if (epoch === this.#epoch) { this.#outcomes.push({ method, result: "failed", at: new Date(this.now()).toISOString() }); this.clear("failed"); } return true; }
    }
    this.clear("completed"); return true;
  }
  #send(method: "renew" | "detach", sdk: OldAttemptSdk): Promise<Reply> {
    if (!this.#live() || this.#identity === undefined) return Promise.reject(new Error("inactive"));
    const identity = this.#identity;
    const request: CodexAppRequest = { protocolVersion: 1, authority: "presentation", method, runtimeId: identity.runtimeId, attemptId: identity.attemptId, generation: identity.generation, capability: identity.presentationCapability, requestId: crypto.randomUUID(), payload: {} };
    const abort = new AbortController(); this.#abort = abort;
    const timeout = Math.max(1, Math.min(5_000, this.#deadline - this.now()));
    // Deadline is enforced locally too: a missing or nonconforming SDK reply
    // cannot keep the experiment alive. Closure retains no identity/request.
    this.#requestExpiry = setTimeout(() => this.clear("failed"), timeout);
    return sdk.call(request, { signal: abort.signal, timeout, maxTotalTimeout: timeout }).then((result): Reply => { const response = verifiedAppReply(result); return response.status === "denied" ? { status: "denied", reason: response.reason } : { status: response.status }; }).finally(() => {
      if (this.#abort === abort) { this.#abort = undefined; if (this.#requestExpiry !== undefined) clearTimeout(this.#requestExpiry); this.#requestExpiry = undefined; }
    });
  }
  clear(phase: OldAttemptPhase = "canceled"): void {
    if (this.#grant === undefined) return;
    this.#epoch++; this.#identity = undefined;
    if (this.#expiry !== undefined) clearTimeout(this.#expiry);
    if (this.#requestExpiry !== undefined) clearTimeout(this.#requestExpiry);
    this.#expiry = undefined; this.#requestExpiry = undefined;
    this.#abort?.abort(); this.#abort = undefined;
    if (this.#grant !== undefined) this.#used = true;
    this.#grant = undefined;
    if (this.#target !== undefined) { this.#phase = phase; this.changed(); }
  }
  snapshot() {
    return this.#target === undefined ? undefined : { target: { ...this.#target }, phase: this.#phase, at: new Date(this.now()).toISOString(), outcomes: this.#outcomes.map(item => ({ ...item })) };
  }
}
