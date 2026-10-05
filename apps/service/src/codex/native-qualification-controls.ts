import { qualificationDirectory, readQualificationDescriptor } from "./native-qualification-files.js";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { parseQualificationControlGrant, parseQualificationTarget, sameQualificationTarget, type QualificationControlGrant, type QualificationTarget } from "../../../codex-mcp/src/qualification-controls-contract.js";
import type { QualificationInvocation } from "./native-qualification.js";
/** Separate opt-in controls. Failures disable injection and never change admission. */
export class NativeQualificationControls {
  readonly #invocations = new Map<string, { target: QualificationTarget | undefined; expiresAt: string; consumed?: true }>();
  constructor(readonly root: string) {}
  #descriptor(now: number): QualificationControlGrant | undefined {
    try {
      const raw: unknown = JSON.parse(readQualificationDescriptor(join(this.root, "native-qualification-controls.json")));
      return parseQualificationControlGrant(raw, now);
    } catch { return undefined; }
  }
  #consume(target: QualificationTarget, now: number): QualificationControlGrant | undefined {
    try {
      const d = this.#descriptor(now);
      if (d === undefined || !sameQualificationTarget(d.target, target)) return undefined;
      const root = join(this.root, "native-qualification-controls"); qualificationDirectory(root);
      // Permanent one-shot tombstone for this run, across processes/actions. Never
      // remove a partial/stalled consume: uncertain state must fail closed.
      const fd = openSync(join(root, `${d.target.runId}.consumed`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      // Cache only actual exclusive creation, including uncertain later failure.
      // The filesystem tombstone remains the cross-process decision boundary.
      try {
        for (const value of this.#invocations.values()) if (value.target?.runId === d.target.runId) value.consumed = true;
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) return undefined;
      } finally { closeSync(fd); }
      if (Date.parse(d.expiresAt) <= Date.now()) return undefined;
      return d;
    } catch { return undefined; }
  }
  remember(invocation: QualificationInvocation | undefined, runtimeId: string, attemptId: string, processNonce: string): void {
    const now = Date.now();
    for (const [key, value] of this.#invocations) if (Date.parse(value.expiresAt) <= now) this.#invocations.delete(key);
    const target = invocation === undefined ? undefined : parseQualificationTarget({ runId: invocation.runId, processNonce, invocationNonce: invocation.invocationNonce, runtimeId, attemptId });
    if (target === undefined || invocation === undefined || Date.parse(invocation.expiresAt) <= now) return;
    const key = JSON.stringify([runtimeId, attemptId]);
    // A duplicate identity is ambiguous, never replace an observed invocation.
    if (this.#invocations.has(key)) { this.#invocations.set(key, { target: undefined, expiresAt: invocation.expiresAt }); return; }
    if (this.#invocations.size >= 256) return;
    this.#invocations.set(key, { target, expiresAt: invocation.expiresAt });
  }
  shellGrant(runtimeId: string, attemptId: string): QualificationControlGrant | undefined {
    const value = this.#invocations.get(JSON.stringify([runtimeId, attemptId])), now = Date.now();
    if (value === undefined || value.consumed === true || value.target === undefined || Date.parse(value.expiresAt) <= now) return undefined;
    const d = this.#consume(value.target, now);
    if (d === undefined) return undefined;
    return { version: 1, actionId: d.actionId, action: d.action, createdAt: d.createdAt, expiresAt: new Date(Math.min(Date.parse(d.expiresAt), Date.parse(value.expiresAt))).toISOString(), budget: 1, target: d.target };
  }
}
