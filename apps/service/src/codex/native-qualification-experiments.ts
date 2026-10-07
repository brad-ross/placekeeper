import { CONTROL_REQUEST_TIMEOUT_MS } from "../host/control-constants.js";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { parseCodexDisplayReceipt, type CodexDisplayReceipt } from "../../../../packages/core/src/codex-mcp-protocol.js";
import { experimentNonce, parseQualificationExperiment, type QualificationExperiment } from "../../../codex-mcp/src/qualification-experiments-contract.js";
import { assertQualificationDirectory, createQualificationRecord, qualificationDirectory, readQualificationDescriptor, readQualificationRecord } from "./native-qualification-files.js";
import type { QualificationInvocation, NativeQualificationObserver } from "./native-qualification.js";

const QUALIFICATION_HOST_HOOK_TIMEOUT_MS = 8_000;
const QUALIFICATION_HOOK_MARGIN_MS = 1_000;
/** Fresh Node elapsed time only; pre-Node host/shell overhead requires host evidence. */
function hasElapsedHookDelayBudget(delayMs: number): boolean {
  return process.uptime() * 1000 + delayMs + CONTROL_REQUEST_TIMEOUT_MS + QUALIFICATION_HOOK_MARGIN_MS < QUALIFICATION_HOST_HOOK_TIMEOUT_MS;
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sameReceipt = (a: CodexDisplayReceipt, b: CodexDisplayReceipt) => a.receiptId === b.receiptId && a.attemptId === b.attemptId && a.generation === b.generation;
interface Issued { runId: string; processNonce: string; invocationNonce: string; receipt: CodexDisplayReceipt }
function issued(v: unknown): Issued | undefined {
  if (!object(v) || Object.keys(v).sort().join(",") !== "invocationNonce,processNonce,receipt,runId" || !experimentNonce(v.runId) || !experimentNonce(v.processNonce) || !experimentNonce(v.invocationNonce)) return undefined;
  const receipt = parseCodexDisplayReceipt(v.receipt);
  return receipt === undefined ? undefined : { runId: v.runId, processNonce: v.processNonce, invocationNonce: v.invocationNonce, receipt };
}
/** Exception carries no input, path, receipt, capability or private metadata. */
export class QualificationExperimentIncomplete extends Error { constructor() { super("qualification-experiment-incomplete"); } }
/** Only closed public receipts enter this class. Private invocation envelopes never do. */
export class NativeQualificationExperiments {
  constructor(readonly root: string) {}
  #descriptor(): QualificationExperiment | undefined {
    try {
      assertQualificationDirectory(this.root);
      return parseQualificationExperiment(JSON.parse(readQualificationDescriptor(join(this.root, "native-qualification-experiments.json"))), Date.now());
    } catch { return undefined; }
  }
  #directory(runId: string): string {
    const parent = join(this.root, "native-qualification-experiments");
    qualificationDirectory(this.root); qualificationDirectory(parent);
    const dir = join(parent, runId); qualificationDirectory(dir); return dir;
  }
  #remember(record: Issued): void {
    const parent = join(this.root, "native-qualification-issued");
    qualificationDirectory(this.root); qualificationDirectory(parent);
    const dir = join(parent, record.runId); qualificationDirectory(dir);
    if (!createQualificationRecord(join(dir, `${record.invocationNonce}.json`), record)) throw new Error("duplicate-issued");
  }
  async publicResult(receipt: CodexDisplayReceipt, invocation: QualificationInvocation | undefined, processNonce: string, observer?: NativeQualificationObserver): Promise<CodexDisplayReceipt> {
    const actual = parseCodexDisplayReceipt(receipt);
    if (actual === undefined || invocation === undefined || !experimentNonce(invocation.runId) || !experimentNonce(invocation.invocationNonce) || !experimentNonce(processNonce) || Date.parse(invocation.expiresAt) <= Date.now()) return receipt;
    const record: Issued = { runId: invocation.runId, invocationNonce: invocation.invocationNonce, processNonce, receipt: actual };
    try { this.#remember(record); } catch { return receipt; }
    const d = this.#descriptor();
    if (d === undefined) return receipt;
    const targets = d.action === "paired-public-result-exchange" ? d.targets : [d.target];
    const slot = targets.findIndex(t => t.runId === record.runId && t.processNonce === processNonce);
    if (slot < 0) return receipt;
    // A permanent manifest is the run tombstone and fixes the descriptor and
    // same-host monotonic deadline before either result slot is created.
    const start = process.hrtime.bigint();
    let dir: string;
    try { dir = this.#directory(record.runId); } catch { return receipt; }
    const budget = d.action === "paired-public-result-exchange" ? d.rendezvousMs : d.action === "genuine-attestation-after-readiness" ? d.waitMs : 0;
    let created = false;
    try { created = createQualificationRecord(join(dir, "run.json"), { descriptor: d, deadlineNs: String(start + BigInt(budget) * 1_000_000n) }); }
    catch { if (d.action === "paired-public-result-exchange") throw new QualificationExperimentIncomplete(); return receipt; }
    if (!created && d.action !== "paired-public-result-exchange") return receipt;
    if (created) {
      try {
        // Share the v1 controls tombstone. A removed/replaced descriptor can
        // never authorize a second logical action in this observation run.
        const controls = join(this.root, "native-qualification-controls");
        qualificationDirectory(controls);
        const consumed = createQualificationRecord(join(controls, `${record.runId}.consumed`), { actionId: d.actionId });
        if (!createQualificationRecord(join(dir, "initialized.json"), { state: consumed ? "ready" : "blocked" })) throw new QualificationExperimentIncomplete();
      } catch {
        if (d.action === "paired-public-result-exchange") throw new QualificationExperimentIncomplete();
        return receipt;
      }
    }
    let manifest: unknown;
    try { manifest = readQualificationRecord(join(dir, "run.json")); }
    catch { if (d.action === "paired-public-result-exchange") throw new QualificationExperimentIncomplete(); return receipt; }
    if (!object(manifest) || Object.keys(manifest).sort().join(",") !== "deadlineNs,descriptor" || JSON.stringify(manifest.descriptor) !== JSON.stringify(d) || typeof manifest.deadlineNs !== "string" || !/^[0-9]{1,24}$/u.test(manifest.deadlineNs)) {
      if (d.action === "paired-public-result-exchange") throw new QualificationExperimentIncomplete();
      return receipt;
    }
    const shared = BigInt(manifest.deadlineNs), local = start + BigInt(budget) * 1_000_000n;
    const deadline = shared < local ? shared : local;
    try {
      let initialized: unknown;
      for (let check = 0; check <= 250; check++) {
        try { initialized = readQualificationRecord(join(dir, "initialized.json")); }
        catch { initialized = undefined; }
        if (initialized !== undefined) break;
        if (d.action !== "paired-public-result-exchange" || process.hrtime.bigint() >= deadline || check === 250) throw new QualificationExperimentIncomplete();
        await pause(10);
      }
      if (!object(initialized) || Object.keys(initialized).join(",") !== "state") throw new QualificationExperimentIncomplete();
      if (initialized.state === "blocked") return receipt;
      if (initialized.state !== "ready") throw new QualificationExperimentIncomplete();
      if (!createQualificationRecord(join(dir, `slot-${slot}.json`), record)) {
        if (d.action === "paired-public-result-exchange") {
          // Duplicate selection is ambiguous. Elect abort if still undecided;
          // never overwrite a decision that another participant already won.
          createQualificationRecord(join(dir, "ambiguous.json"), { slot });
          createQualificationRecord(join(dir, "decision.json"), { outcome: "abort" });
          throw new QualificationExperimentIncomplete();
        }
        return receipt;
      }
      observer?.record("experiment-selected", { ...actual, invocationNonce: record.invocationNonce, status: "pending" });
      if (d.action === "genuine-attestation-delay" || d.action === "genuine-attestation-after-readiness") return receipt;
      if (d.action === "old-public-result-on-fresh-display") {
        const parent = join(this.root, "native-qualification-issued"), sourceDir = join(parent, d.source.runId);
        qualificationDirectory(parent); qualificationDirectory(sourceDir);
        const source = issued(readQualificationRecord(join(sourceDir, `${d.source.invocationNonce}.json`)));
        if (source === undefined || source.runId !== d.source.runId || source.invocationNonce !== d.source.invocationNonce || sameReceipt(source.receipt, actual)) return receipt;
        if (!createQualificationRecord(join(dir, "delivery-0.json"), { receipt: source.receipt })) return receipt;
        observer?.record("experiment-delivery", { ...source.receipt, invocationNonce: record.invocationNonce, status: "ok" });
        return source.receipt;
      }
      return await this.#pair(dir, d, slot, actual, deadline, observer, record.invocationNonce);
    } catch {
      if (d.action === "paired-public-result-exchange") {
        try { createQualificationRecord(join(dir, `incomplete-${slot}.json`), { slot }); } catch { /* Best-effort public diagnostic only. */ }
        observer?.record("experiment-incomplete", { ...actual, invocationNonce: record.invocationNonce, status: "denied" });
        throw new QualificationExperimentIncomplete();
      }
      // A consumed single-action failure disables injection permanently.
      return receipt;
    }
  }
  async #pair(dir: string, d: Extract<QualificationExperiment, { action: "paired-public-result-exchange" }>, slot: number, original: CodexDisplayReceipt, deadline: bigint, observer: NativeQualificationObserver | undefined, invocationNonce: string): Promise<CodexDisplayReceipt> {
    const decisionPath = join(dir, "decision.json");
    // At most 251 checks and <=5 seconds measured on the same host monotonic
    // clock. Wall expiry is a separate additional guard, never a deadline extension.
    for (let check = 0; check <= 250; check++) {
      let decision: unknown;
      try { decision = readQualificationRecord(decisionPath); }
      catch {
        // Existing/partial/unreadable terminal state is uncertain, never normal.
        if (process.hrtime.bigint() >= deadline || check === 250) throw new QualificationExperimentIncomplete();
        await pause(10); continue;
      }
      if (decision !== undefined) {
        if (!object(decision)) throw new QualificationExperimentIncomplete();
        if (Object.keys(decision).join(",") === "outcome" && decision.outcome === "abort") return original;
        if (Object.keys(decision).sort().join(",") !== "outcome,receipts" || decision.outcome !== "commit" || !Array.isArray(decision.receipts) || decision.receipts.length !== 2) throw new QualificationExperimentIncomplete();
        const own = parseCodexDisplayReceipt(decision.receipts[slot]), peer = parseCodexDisplayReceipt(decision.receipts[1 - slot]);
        if (own === undefined || peer === undefined || !sameReceipt(own, original) || sameReceipt(own, peer)) throw new QualificationExperimentIncomplete();
        const ownSlot = issued(readQualificationRecord(join(dir, `slot-${slot}.json`))), peerSlot = issued(readQualificationRecord(join(dir, `slot-${1 - slot}.json`)));
        if (ownSlot === undefined || peerSlot === undefined || ownSlot.runId !== d.targets[slot]!.runId || ownSlot.processNonce !== d.targets[slot]!.processNonce || peerSlot.runId !== d.targets[1 - slot]!.runId || peerSlot.processNonce !== d.targets[1 - slot]!.processNonce || !sameReceipt(ownSlot.receipt, own) || !sameReceipt(peerSlot.receipt, peer)) throw new QualificationExperimentIncomplete();
        // A committed process that resumes after its deadline fails delivery. It
        // never substitutes a normal result. Missing intent means incomplete.
        if (process.hrtime.bigint() >= deadline || Date.parse(d.expiresAt) <= Date.now()) throw new QualificationExperimentIncomplete();
        if (!createQualificationRecord(join(dir, `delivery-${slot}.json`), { receipt: peer })) throw new QualificationExperimentIncomplete();
        observer?.record("experiment-delivery", { ...peer, invocationNonce, status: "ok" });
        return peer;
      }
      const expired = process.hrtime.bigint() >= deadline || Date.parse(d.expiresAt) <= Date.now() || check === 250;
      if (expired) { if (createQualificationRecord(decisionPath, { outcome: "abort" })) return original; continue; }
      const a = issued(readQualificationRecord(join(dir, "slot-0.json"))), b = issued(readQualificationRecord(join(dir, "slot-1.json")));
      if (a !== undefined && b !== undefined) {
        if (a.runId !== d.targets[0].runId || b.runId !== d.targets[1].runId || a.processNonce !== d.targets[0].processNonce || b.processNonce !== d.targets[1].processNonce || sameReceipt(a.receipt, b.receipt)) throw new QualificationExperimentIncomplete();
        // Recheck immediately before election. O_EXCL is the sole immutable
        // commit-or-abort decision. Interrupted writers leave uncertain evidence.
        if (process.hrtime.bigint() < deadline && Date.parse(d.expiresAt) > Date.now()) createQualificationRecord(decisionPath, { outcome: "commit", receipts: [a.receipt, b.receipt] });
        else createQualificationRecord(decisionPath, { outcome: "abort" });
        continue;
      }
      await pause(Math.min(20, Math.max(1, Number((deadline - process.hrtime.bigint()) / 1_000_000n))));
    }
    throw new QualificationExperimentIncomplete();
  }
  #issuanceDirectory(runId: string): string {
    const parent = join(this.#directory(runId), "issuance");
    qualificationDirectory(parent); return parent;
  }
  #issuanceRecord(value: unknown, d: Extract<QualificationExperiment, { action: "genuine-attestation-after-readiness" }>) {
    if (!object(value) || Object.keys(value).sort().join(",") !== "actionId,expiresAtMs,receipt,runId" || value.actionId !== d.actionId || value.runId !== d.target.runId || !Number.isSafeInteger(value.expiresAtMs)) return undefined;
    const receipt = parseCodexDisplayReceipt(value.receipt);
    return receipt === undefined ? undefined : { receipt, expiresAtMs: Number(value.expiresAtMs) };
  }
  /** Public scheduling lifetime only. The daemon cannot know the selected server
   * process yet: at most 64 exclusive immutable slots bound unrelated issuance. */
  displayIssued(receipt: CodexDisplayReceipt, expiresAtMs: number): void {
    const d = this.#descriptor();
    if (d?.action !== "genuine-attestation-after-readiness") return;
    try {
      const actual = parseCodexDisplayReceipt(receipt);
      if (actual === undefined || !Number.isSafeInteger(expiresAtMs)) return;
      const runDir = this.#directory(d.target.runId);
      const controls = join(this.root, "native-qualification-controls");
      try { assertQualificationDirectory(controls); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const consumedPath = join(controls, `${d.target.runId}.consumed`);
      if (readQualificationRecord(join(runDir, "run.json")) !== undefined || readQualificationRecord(consumedPath) !== undefined) return;
      const dir = this.#issuanceDirectory(d.target.runId);
      for (let slot = 0; slot < 64; slot++) {
        const path = join(dir, `slot-${slot}.json`), value = readQualificationRecord(path);
        if (value !== undefined) {
          const record = this.#issuanceRecord(value, d);
          if (record === undefined || sameReceipt(record.receipt, actual)) return;
          continue;
        }
        if (JSON.stringify(this.#descriptor()) !== JSON.stringify(d) || readQualificationRecord(join(runDir, "run.json")) !== undefined || readQualificationRecord(consumedPath) !== undefined) return;
        if (createQualificationRecord(path, { actionId: d.actionId, runId: d.target.runId, receipt: actual, expiresAtMs })) return;
        // Another daemon publisher won O_EXCL. Validate that immutable slot on
        // the next iteration; partial/hostile state must stop, never be skipped.
        const won = this.#issuanceRecord(readQualificationRecord(path), d);
        if (won === undefined || sameReceipt(won.receipt, actual)) return;
      }
    } catch { /* Scheduling files never change display behavior. */ }
  }
  #findExpiry(d: Extract<QualificationExperiment, { action: "genuine-attestation-after-readiness" }>, receipt: CodexDisplayReceipt) {
    const dir = this.#issuanceDirectory(d.target.runId);
    // One bounded lookup per consumed hook, then only this exact slot is read.
    for (let slot = 0; slot < 64; slot++) {
      const path = join(dir, `slot-${slot}.json`), value = readQualificationRecord(path);
      if (value === undefined) return undefined;
      const record = this.#issuanceRecord(value, d);
      if (record === undefined) return undefined;
      if (sameReceipt(record.receipt, receipt)) return { path, value, expiresAtMs: record.expiresAtMs };
    }
    return undefined;
  }
  #selection(d: Extract<QualificationExperiment, { action: "genuine-attestation-after-readiness" }>, receipt: CodexDisplayReceipt) {
    const dir = this.#directory(d.target.runId);
    const manifest = readQualificationRecord(join(dir, "run.json"));
    if (!object(manifest) || Object.keys(manifest).sort().join(",") !== "deadlineNs,descriptor" || JSON.stringify(manifest.descriptor) !== JSON.stringify(d) || typeof manifest.deadlineNs !== "string" || !/^[0-9]{1,24}$/u.test(manifest.deadlineNs)) return undefined;
    const initialized = readQualificationRecord(join(dir, "initialized.json"));
    assertQualificationDirectory(join(this.root, "native-qualification-controls"));
    const consumed = readQualificationRecord(join(this.root, "native-qualification-controls", `${d.target.runId}.consumed`));
    if (!object(initialized) || Object.keys(initialized).join(",") !== "state" || initialized.state !== "ready" || !object(consumed) || Object.keys(consumed).join(",") !== "actionId" || consumed.actionId !== d.actionId) return undefined;
    const selected = issued(readQualificationRecord(join(dir, "slot-0.json")));
    if (selected === undefined || selected.runId !== d.target.runId || selected.processNonce !== d.target.processNonce || !sameReceipt(selected.receipt, receipt)) return undefined;
    return { dir, selected, deadline: BigInt(manifest.deadlineNs), correlation: { actionId: d.actionId, ...selected } };
  }
  /** Runtime calls only after authenticated pending envelope/current/claim checks,
   * ready && !attested. This marker releases scheduling; it proves no authority. */
  authenticatedReady(receipt: CodexDisplayReceipt, expiresAtMs: number): void {
    const d = this.#descriptor();
    if (d?.action !== "genuine-attestation-after-readiness") return;
    try {
      const selection = this.#selection(d, receipt);
      if (selection === undefined || process.hrtime.bigint() >= selection.deadline || !Number.isSafeInteger(expiresAtMs)) return;
      createQualificationRecord(join(selection.dir, "ready.json"), { ...selection.correlation, outcome: "authenticated-ready-first", expiresAtMs });
    } catch { /* Marker publication never changes ordinary pending behavior. */ }
  }
  async #waitReady(d: Extract<QualificationExperiment, { action: "genuine-attestation-after-readiness" }>, receipt: CodexDisplayReceipt): Promise<void> {
    let terminal: { dir: string; correlation: unknown } | undefined;
    let outcome: "ready" | "cancelled" | "deadline" | "budget" | "unavailable" = "unavailable";
    try {
      const selection = this.#selection(d, receipt);
      if (selection === undefined || readQualificationRecord(join(selection.dir, "hook-terminal.json")) !== undefined) return;
      if (!createQualificationRecord(join(selection.dir, "hook-consumed.json"), selection.correlation)) return;
      terminal = selection;
      const expiry = this.#findExpiry(d, receipt);
      if (expiry === undefined) return;
      const now = process.hrtime.bigint(), wall = Date.now();
      // Freeze all wall-derived caps once. Backward wall jumps cannot extend them.
      // Reserve the unchanged five-second control call plus five seconds margin.
      const remaining = Math.min(d.waitMs, 40000, 55000 - process.uptime() * 1000 - CONTROL_REQUEST_TIMEOUT_MS - 5000, Date.parse(d.expiresAt) - wall - CONTROL_REQUEST_TIMEOUT_MS - 5000, Number(expiry.expiresAtMs) - wall - CONTROL_REQUEST_TIMEOUT_MS - 5000);
      if (remaining <= 0) { outcome = "budget"; return; }
      let deadline = now + BigInt(Math.floor(remaining)) * 1_000_000n;
      if (selection.deadline < deadline) deadline = selection.deadline;
      for (let check = 0; check <= 160; check++) {
        if (JSON.stringify(this.#descriptor()) !== JSON.stringify(d)) { outcome = "cancelled"; return; }
        assertQualificationDirectory(dirname(expiry.path));
        if (JSON.stringify(readQualificationRecord(expiry.path)) !== JSON.stringify(expiry.value)) return;
        const current = this.#selection(d, receipt);
        const hook = readQualificationRecord(join(selection.dir, "hook-consumed.json"));
        if (current === undefined || JSON.stringify(current.correlation) !== JSON.stringify(selection.correlation) || JSON.stringify(hook) !== JSON.stringify(selection.correlation)) return;
        if (process.hrtime.bigint() >= deadline || check === 160) { outcome = "deadline"; return; }
        const marker = readQualificationRecord(join(selection.dir, "ready.json"));
        if (marker !== undefined) {
          if (!object(marker) || Object.keys(marker).sort().join(",") !== "actionId,expiresAtMs,invocationNonce,outcome,processNonce,receipt,runId" || marker.outcome !== "authenticated-ready-first" || !Number.isSafeInteger(marker.expiresAtMs)) return;
          const { outcome: _, expiresAtMs, ...correlation } = marker;
          if (JSON.stringify(correlation) !== JSON.stringify(selection.correlation)) return;
          const cap = process.hrtime.bigint() + BigInt(Math.floor(Number(expiresAtMs) - Date.now() - CONTROL_REQUEST_TIMEOUT_MS - 5000)) * 1_000_000n;
          if (cap < deadline) deadline = cap;
          if (process.hrtime.bigint() >= deadline) { outcome = "budget"; return; }
          if (JSON.stringify(this.#descriptor()) !== JSON.stringify(d)) { outcome = "cancelled"; return; }
          assertQualificationDirectory(dirname(expiry.path));
          if (JSON.stringify(readQualificationRecord(expiry.path)) !== JSON.stringify(expiry.value)) return;
          outcome = "ready"; return;
        }
        await pause(Math.min(250, Math.max(1, Number((deadline - process.hrtime.bigint()) / 1_000_000n))));
      }
    } catch { /* Every caught scheduling failure proceeds to ordinary attestation. */ }
    finally {
      if (terminal !== undefined) {
        try { createQualificationRecord(join(terminal.dir, "hook-terminal.json"), { correlation: terminal.correlation, outcome }); } catch { /* Best effort immutable diagnostic. */ }
      }
    }
  }
  /** Called only after genuine trusted hook parsing. Receipt/task remain unchanged. */
  async delayAttestation(receipt: CodexDisplayReceipt, observer?: NativeQualificationObserver): Promise<void> {
    const d = this.#descriptor();
    if (d?.action === "genuine-attestation-after-readiness") { await this.#waitReady(d, receipt); return; }
    if (d?.action !== "genuine-attestation-delay") return;
    try {
      const dir = this.#directory(d.target.runId), manifest = readQualificationRecord(join(dir, "run.json"));
      if (!object(manifest) || JSON.stringify(manifest.descriptor) !== JSON.stringify(d)) return;
      const initialized = readQualificationRecord(join(dir, "initialized.json"));
      if (!object(initialized) || Object.keys(initialized).join(",") !== "state" || initialized.state !== "ready") return;
      const selected = issued(readQualificationRecord(join(dir, "slot-0.json")));
      if (selected === undefined || selected.runId !== d.target.runId || selected.processNonce !== d.target.processNonce || !sameReceipt(selected.receipt, receipt)) return;
      // Existing host timeout 8s, service budget 5s, reserved margin 1s.
      // process.uptime includes actual hook startup; fail closed when insufficient.
      if (!hasElapsedHookDelayBudget(d.delayMs)) return;
      if (!createQualificationRecord(join(dir, "hook-consumed.json"), { receipt })) return;
      if (!hasElapsedHookDelayBudget(d.delayMs) || Date.parse(d.expiresAt) <= Date.now()) return;
      observer?.record("hook-delay-start", { ...receipt, status: "pending" });
      await pause(d.delayMs);
      observer?.record("hook-delay-end", { ...receipt, status: "ok" });
    } catch { /* Qualification failure never skips ordinary attestation. */ }
  }
}
