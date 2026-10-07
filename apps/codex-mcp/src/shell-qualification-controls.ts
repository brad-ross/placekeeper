import { parseQualificationControlGrant, sameQualificationTarget, type QualificationControlGrant, type QualificationTarget } from "./qualification-controls-contract.js";
export type QualificationControlOutcome = "armed" | "requested" | "bridge-closed" | "failed" | "expired";
export interface QualificationControlObservation {
  actionId: string; action: QualificationControlGrant["action"]; target: QualificationTarget; at: string; outcome: QualificationControlOutcome;
}
/** One in-memory grant for this actual invocation; never retained authority. */
export class ShellQualificationControls {
  #grant: QualificationControlGrant | undefined;
  #used = false;
  #observation: QualificationControlObservation | undefined;
  constructor(readonly now: () => number = Date.now) {}
  arm(value: unknown, own: Omit<QualificationTarget, "processNonce">): boolean {
    const grant = parseQualificationControlGrant(value, this.now());
    if (this.#used || this.#grant !== undefined || grant === undefined || grant.target.runId !== own.runId || grant.target.invocationNonce !== own.invocationNonce || grant.target.runtimeId !== own.runtimeId || grant.target.attemptId !== own.attemptId) return false;
    this.#grant = grant; this.#record(grant, "armed"); return true;
  }
  available(own: Omit<QualificationTarget, "processNonce">): QualificationControlGrant | undefined {
    const grant = this.#grant;
    if (grant === undefined || this.#used) return undefined;
    if (parseQualificationControlGrant(grant, this.now()) === undefined) { this.#record(grant, "expired"); this.#grant = undefined; return undefined; }
    return sameQualificationTarget(grant.target, { ...own, processNonce: grant.target.processNonce }) ? grant : undefined;
  }
  /** Consume before awaiting SDK calls. Arming alone cannot execute an action. */
  async execute(own: Omit<QualificationTarget, "processNonce">, sdk: { requestTeardown(): Promise<void>; close(): Promise<void> }, stopLocal: () => void): Promise<boolean> {
    const grant = this.available(own);
    if (grant === undefined) return false;
    this.#used = true; this.#grant = undefined;
    try {
      if (grant.action === "request-teardown") { await sdk.requestTeardown(); this.#record(grant, "requested"); }
      else {
        // Stop/clear locally before closing. No authenticated detach: this probe
        // tests bridge loss and the existing service lease expiry.
        stopLocal(); await sdk.close(); this.#record(grant, "bridge-closed");
      }
    } catch { this.#record(grant, "failed"); }
    return true;
  }
  clear(): void { this.#grant = undefined; }
  snapshot(): QualificationControlObservation | undefined { return this.#observation === undefined ? undefined : { ...this.#observation, target: { ...this.#observation.target } }; }
  #record(grant: QualificationControlGrant, outcome: QualificationControlOutcome): void {
    this.#observation = { actionId: grant.actionId, action: grant.action, target: { ...grant.target }, at: new Date(this.now()).toISOString(), outcome };
  }
}
