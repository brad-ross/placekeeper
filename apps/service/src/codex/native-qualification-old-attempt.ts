import { join } from "node:path";
import { assertQualificationDirectory, createQualificationRecord, qualificationDirectory, readQualificationDescriptor } from "./native-qualification-files.js";
import { parseOldAttemptGrant, type OldAttemptGrant } from "../../../codex-mcp/src/old-attempt-contract.js";
import { parseQualificationTarget, sameQualificationTarget, type QualificationTarget } from "../../../codex-mcp/src/qualification-controls-contract.js";
import type { QualificationInvocation } from "./native-qualification.js";
/** Only public correlation is retained here; grants never contain authority. */
export class NativeQualificationOldAttempt {
  #invocations = new Map<string, { target: QualificationTarget | undefined; expiresAt: string; consumed?: true }>();
  constructor(readonly root: string) {}
  remember(invocation: QualificationInvocation | undefined, runtimeId: string, attemptId: string, processNonce: string): void {
    const now = Date.now();
    for (const [key, item] of this.#invocations) if (Date.parse(item.expiresAt) <= now) this.#invocations.delete(key);
    if (invocation === undefined || Date.parse(invocation.expiresAt) <= now) return;
    const target = parseQualificationTarget({ runId: invocation.runId, processNonce, invocationNonce: invocation.invocationNonce, runtimeId, attemptId });
    if (target === undefined) return;
    const key = JSON.stringify([runtimeId, attemptId]);
    if (this.#invocations.has(key)) { this.#invocations.set(key, { target: undefined, expiresAt: invocation.expiresAt }); return; }
    if (this.#invocations.size < 256) this.#invocations.set(key, { target, expiresAt: invocation.expiresAt });
  }
  shellGrant(runtimeId: string, attemptId: string): OldAttemptGrant | undefined {
    try {
      const now = Date.now(), item = this.#invocations.get(JSON.stringify([runtimeId, attemptId]));
      if (item?.consumed === true || item?.target === undefined || Date.parse(item.expiresAt) <= now) return undefined;
      assertQualificationDirectory(this.root);
      const grant = parseOldAttemptGrant(JSON.parse(readQualificationDescriptor(join(this.root, "native-qualification-old-attempt.json"))), now);
      if (grant === undefined || !sameQualificationTarget(grant.target, item.target)) return undefined;
      const directory = join(this.root, "native-qualification-controls"); qualificationDirectory(directory);
      // Shared permanent tombstone with close controls and public experiments.
      const created = createQualificationRecord(join(directory, `${grant.target.runId}.consumed`), { version: 1, action: grant.action });
      // Both exclusive creation and definite EEXIST permanently settle this run.
      // Other errors leave through the fail-closed catch without caching a grant.
      for (const value of this.#invocations.values()) if (value.target?.runId === grant.target.runId) value.consumed = true;
      if (!created) return undefined;
      const expiresAt = Math.min(Date.parse(grant.expiresAt), Date.parse(item.expiresAt));
      if (expiresAt <= Date.now()) return undefined;
      return { ...grant, expiresAt: new Date(expiresAt).toISOString() };
    } catch { return undefined; }
  }
}
