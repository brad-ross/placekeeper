import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, linkSync, readdirSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { NativeQualificationExperiments, QualificationExperimentIncomplete } from "../src/codex/native-qualification-experiments.js";
import { parseQualificationExperiment } from "../../codex-mcp/src/qualification-experiments-contract.js";
import { createQualificationRecord } from "../src/codex/native-qualification-files.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const runId = "a".repeat(32), a = "b".repeat(32), b = "c".repeat(32);
const receipt = (index: number) => ({ protocolVersion: 1 as const, status: "pending" as const, receiptId: `receipt_${index}`, attemptId: `attempt_${index}`, generation: 1 });
function fixture(action = "paired-public-result-exchange", budget = 300) {
  const root = mkdtempSync(join(tmpdir(), "native-experiment-")); roots.push(root);
  const base = { version: 1, actionId: "d".repeat(32), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), budget: 1, action };
  const descriptor = action === "paired-public-result-exchange" ? { ...base, targets: [{ runId, processNonce: a }, { runId, processNonce: b }], rendezvousMs: budget } : { ...base, target: { runId, processNonce: a }, delayMs: 100 };
  const path = join(root, "native-qualification-experiments.json"); writeFileSync(path, JSON.stringify(descriptor), { mode: 0o600 });
  const invocation = (index: number) => ({ runId, invocationNonce: String(index).repeat(32), expiresAt: base.expiresAt });
  return { root, descriptor, path, invocation, dir: join(root, "native-qualification-experiments", runId) };
}
function worker(root: string, index: number, delay = 0, terminalReadFault = false) {
  const fault = terminalReadFault ? `import fs from "node:fs"; import {syncBuiltinESMExports} from "node:module";
const originalOpen=fs.openSync, decisionPath=${JSON.stringify(join(root, "native-qualification-experiments", runId, "decision.json"))};
fs.openSync=function(path,flags,...args){
  if(path===decisionPath && typeof flags==='number' && (flags & (fs.constants.O_WRONLY|fs.constants.O_RDWR))===0){
    const deadline=BigInt(JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "native-qualification-experiments", runId, "run.json"))},'utf8')).deadlineNs);
    fs.writeFileSync(${JSON.stringify(join(root, "native-qualification-experiments", runId, `fault-read-${index - 1}.json`))},JSON.stringify({category:'terminal-read-EACCES',deadlineReached:process.hrtime.bigint()>=deadline}),{mode:0o600});
    throw Object.assign(new Error('fixture-terminal-read-fault'),{code:'EACCES'});
  }
  return originalOpen.call(fs,path,flags,...args);
};syncBuiltinESMExports();` : "";
  const source = `${fault}
const {NativeQualificationExperiments}=await import(${JSON.stringify(resolve("apps/service/src/codex/native-qualification-experiments.ts"))});
await new Promise(r=>setTimeout(r,${delay}));
try { const result=await new NativeQualificationExperiments(${JSON.stringify(root)}).publicResult(${JSON.stringify(receipt(index))},${JSON.stringify({ runId, invocationNonce: String(index).repeat(32), expiresAt: new Date(Date.now() + 60000).toISOString() })},${JSON.stringify(index === 1 ? a : b)}); process.stdout.write(JSON.stringify({result})); } catch { process.stdout.write(JSON.stringify({incomplete:true})); }`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", stderr = ""; child.stdout.on("data", d => output += String(d)); child.stderr.on("data", d => stderr += String(d));
  const completed = new Promise<{ result?: ReturnType<typeof receipt>; incomplete?: true }>((resolve, reject) => child.once("close", code => {
    if (code !== 0) reject(new Error(`worker failed ${code}: ${stderr}`)); else { try { resolve(JSON.parse(output)); } catch { reject(new Error("invalid worker output")); } }
  }));
  return { child, completed };
}
it("rejects unknown fields, excess bounds, task identities, duplicate process targets and expiry", () => {
  const f = fixture(); expect(parseQualificationExperiment(f.descriptor, Date.now())).toBeDefined();
  for (const value of [{ ...f.descriptor, taskSessionId: "private" }, { ...f.descriptor, rendezvousMs: 5001 }, { ...f.descriptor, targets: [{ runId, processNonce: a }, { runId, processNonce: a }] }, { ...f.descriptor, expiresAt: new Date(Date.now() + 31 * 60000).toISOString() }]) expect(parseQualificationExperiment(value, Date.now())).toBeUndefined();
});
it("disabled and hostile descriptors leave original public output unchanged without blocking", async () => {
  const f = fixture(), controls = new NativeQualificationExperiments(f.root);
  for (const mode of [0o644, 0o600]) {
    chmodSync(f.path, mode); if (mode === 0o600) writeFileSync(f.path, "{}");
    expect(await controls.publicResult(receipt(1), f.invocation(mode), a)).toEqual(receipt(1));
  }
  rmSync(f.path); expect(await controls.publicResult(receipt(1), f.invocation(3), a)).toEqual(receipt(1));
  const target = join(f.root, "target"); writeFileSync(target, JSON.stringify(f.descriptor), { mode: 0o600 });
  symlinkSync(target, f.path); expect(await controls.publicResult(receipt(1), f.invocation(4), a)).toEqual(receipt(1));
  rmSync(f.path); linkSync(target, f.path); expect(await controls.publicResult(receipt(1), f.invocation(5), a)).toEqual(receipt(1));
  rmSync(f.path); execFileSync("mkfifo", [f.path]); chmodSync(f.path, 0o600);
  expect(await controls.publicResult(receipt(1), f.invocation(6), a)).toEqual(receipt(1));
});
it("commits actual concurrent processes to opposite public receipts", async () => {
  const f = fixture(undefined, 1000), one = worker(f.root, 1), two = worker(f.root, 2);
  const results = await Promise.all([one.completed, two.completed]);
  expect(results).toEqual([{ result: receipt(2) }, { result: receipt(1) }]);
  expect(JSON.parse(readFileSync(join(f.dir, "decision.json"), "utf8"))).toEqual({ outcome: "commit", receipts: [receipt(1), receipt(2)] });
  expect(readdirSync(f.dir).filter(v => v.startsWith("delivery-"))).toHaveLength(2);
  const all = readdirSync(f.dir).map(file => readFileSync(join(f.dir, file), "utf8")).join(" ");
  expect(all).not.toMatch(/capability|taskSession|pendingCapability|_meta|handoff/);
});
it("timeout commits one immutable abort; a late process returns normal, never one swapped outcome", async () => {
  const f = fixture(undefined, 80), results = await Promise.all([worker(f.root, 1).completed, worker(f.root, 2, 250).completed]);
  expect(results).toEqual([{ result: receipt(1) }, { result: receipt(2) }]);
  expect(JSON.parse(readFileSync(join(f.dir, "decision.json"), "utf8"))).toEqual({ outcome: "abort" });
  expect(readdirSync(f.dir).filter(v => v.startsWith("delivery-"))).toHaveLength(0);
});
it("real commit/abort boundary races never mix swapped and normal results", async () => {
  for (const delay of [25, 50, 75]) {
    const f = fixture(undefined, 60), results = await Promise.all([worker(f.root, 1).completed, worker(f.root, 2, delay).completed]);
    const decision = JSON.parse(readFileSync(join(f.dir, "decision.json"), "utf8"));
    expect(["abort", "commit"]).toContain(decision.outcome);
    results.forEach((result, slot) => {
      if (result.incomplete === true) {
        // Bounded uncertainty is allowed, but require its deciding-path evidence;
        // an unexplained worker failure cannot silently relax the invariant.
        expect(result).toEqual({ incomplete: true });
        expect(JSON.parse(readFileSync(join(f.dir, `incomplete-${slot}.json`), "utf8"))).toEqual({ slot });
      } else {
        expect(result).toEqual({ result: receipt(decision.outcome === "abort" ? slot + 1 : 2 - slot) });
      }
    });
    if (decision.outcome === "abort") expect(readdirSync(f.dir).filter(file => file.startsWith("delivery-"))).toHaveLength(0);
  }
});
it("immutable abort with deadline terminal-read failure permits incomplete plus own original, never swapped", async () => {
  const f = fixture(undefined, 100);
  mkdirSync(join(f.root, "native-qualification-experiments"), { mode: 0o700 }); mkdirSync(f.dir, { mode: 0o700 });
  mkdirSync(join(f.root, "native-qualification-controls"), { mode: 0o700 });
  createQualificationRecord(join(f.root, "native-qualification-controls", `${runId}.consumed`), { actionId: f.descriptor.actionId });
  createQualificationRecord(join(f.dir, "run.json"), { descriptor: f.descriptor, deadlineNs: String(process.hrtime.bigint() - 1n) });
  createQualificationRecord(join(f.dir, "initialized.json"), { state: "ready" });
  // Immutable election completed before either reader. Only A's terminal read
  // fails at the expired shared deadline; B reads exactly this same valid abort.
  createQualificationRecord(join(f.dir, "decision.json"), { outcome: "abort" });
  const results = await Promise.all([worker(f.root, 1, 0, true).completed, worker(f.root, 2).completed]);
  expect(results).toEqual([{ incomplete: true }, { result: receipt(2) }]);
  expect(JSON.parse(readFileSync(join(f.dir, "decision.json"), "utf8"))).toEqual({ outcome: "abort" });
  expect(JSON.parse(readFileSync(join(f.dir, "fault-read-0.json"), "utf8"))).toEqual({ category: "terminal-read-EACCES", deadlineReached: true });
  expect(JSON.parse(readFileSync(join(f.dir, "incomplete-0.json"), "utf8"))).toEqual({ slot: 0 });
  expect(readdirSync(f.dir)).not.toContain("incomplete-1.json");
  expect(readdirSync(f.dir).filter(file => file.startsWith("delivery-"))).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(f.dir, "slot-0.json"), "utf8")).receipt).toEqual(receipt(1));
  expect(JSON.parse(readFileSync(join(f.dir, "slot-1.json"), "utf8")).receipt).toEqual(receipt(2));
});
it("partial terminal writer crash and existing hostile terminal file produce bounded incomplete, never normal", async () => {
  const f = fixture(undefined, 150);
  mkdirSync(join(f.root, "native-qualification-experiments"), { mode: 0o700 }); mkdirSync(f.dir, { mode: 0o700 });
  createQualificationRecord(join(f.dir, "initialized.json"), { state: "ready" });
  createQualificationRecord(join(f.dir, "run.json"), { descriptor: f.descriptor, deadlineNs: String(process.hrtime.bigint() + 150000000n) });
  const writer = spawn(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(join(f.dir, "decision.json"))},'{"outcome":"com',{mode:0o600}); process.exit(9)`]);
  await new Promise(r => writer.once("close", r));
  expect(await worker(f.root, 1).completed).toEqual({ incomplete: true });
  const g = fixture(undefined, 150); mkdirSync(join(g.root, "native-qualification-experiments"), { mode: 0o700 }); mkdirSync(g.dir, { mode: 0o700 });
  createQualificationRecord(join(g.dir, "initialized.json"), { state: "ready" });
  createQualificationRecord(join(g.dir, "run.json"), { descriptor: g.descriptor, deadlineNs: String(process.hrtime.bigint() + 150000000n) });
  symlinkSync(g.path, join(g.dir, "decision.json")); expect(await worker(g.root, 1).completed).toEqual({ incomplete: true });
});
it("a committed pair cannot fall back when its peer crashed or delivery is late", async () => {
  const f = fixture(undefined, 1000); mkdirSync(join(f.root, "native-qualification-experiments"), { mode: 0o700 }); mkdirSync(f.dir, { mode: 0o700 });
  createQualificationRecord(join(f.dir, "initialized.json"), { state: "ready" });
  createQualificationRecord(join(f.dir, "run.json"), { descriptor: f.descriptor, deadlineNs: String(process.hrtime.bigint() + 1000000000n) });
  createQualificationRecord(join(f.dir, "slot-1.json"), { runId, processNonce: b, invocationNonce: "2".repeat(32), receipt: receipt(2) });
  createQualificationRecord(join(f.dir, "decision.json"), { outcome: "commit", receipts: [receipt(1), receipt(2)] });
  expect(await worker(f.root, 1).completed).toEqual({ result: receipt(2) });
  expect(readdirSync(f.dir).filter(v => v.startsWith("delivery-"))).toEqual(["delivery-0.json"]); // incomplete peer, never a pass
  expect(new NativeQualificationExperiments(f.root).publicResult(receipt(2), f.invocation(2), b)).rejects.toBeInstanceOf(QualificationExperimentIncomplete);
});
it("replays only an explicitly recorded issued public receipt, one fresh run once", async () => {
  const f = fixture("genuine-attestation-delay"), controls = new NativeQualificationExperiments(f.root);
  await controls.publicResult(receipt(1), f.invocation(1), a);
  const freshRun = "e".repeat(32), fresh = { runId: freshRun, invocationNonce: "3".repeat(32), expiresAt: f.invocation(1).expiresAt };
  const d = { version: 1, actionId: "f".repeat(32), createdAt: new Date().toISOString(), expiresAt: fresh.expiresAt, budget: 1, action: "old-public-result-on-fresh-display", target: { runId: freshRun, processNonce: a }, source: { runId, invocationNonce: "1".repeat(32) } };
  writeFileSync(f.path, JSON.stringify(d));
  expect(await controls.publicResult(receipt(3), fresh, a)).toEqual(receipt(1));
  expect(await controls.publicResult(receipt(4), { ...fresh, invocationNonce: "4".repeat(32) }, a)).toEqual(receipt(4));
});
it("genuine hook parser retains actual task/receipt and always sends normal attestation after one bounded delay", async () => {
  const f = fixture("genuine-attestation-delay"), controls = new NativeQualificationExperiments(f.root);
  await controls.publicResult(receipt(1), f.invocation(1), a);
  const event = { session_id: "actual-trusted-task", hook_event_name: "PostToolUse", tool_name: "mcp__placekeeper__display_review", tool_input: { handoff: "h".repeat(43) }, tool_response: { structuredContent: receipt(1) } };
  const source = `import ${JSON.stringify(resolve("apps/service/src/cli/context-command.ts"))};
import {runHookCommand} from ${JSON.stringify(resolve("apps/service/src/cli/hook-command.ts"))};
const input=${JSON.stringify(JSON.stringify(event))}; const calls=[];const start=performance.now();
await runHookCommand(['hook','--event'],input,async request=>{calls.push(request);return {kind:'codex-attestation',status:'accepted'}},()=>{});
const first=performance.now()-start;const again=performance.now();await runHookCommand(['hook','--event'],input,async request=>{calls.push(request);return {kind:'codex-attestation',status:'accepted'}},()=>{});
process.stdout.write(JSON.stringify({calls,first,second:performance.now()-again,input}));`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { env: { ...process.env, PLACEKEEPER_MAC_DEVELOPMENT_ROOT: f.root }, encoding: "utf8", timeout: 8000 });
  const result = JSON.parse(output);
  expect(result.calls).toEqual([{ kind: "codex-attest", taskSessionId: event.session_id, receipt: receipt(1) }, { kind: "codex-attest", taskSessionId: event.session_id, receipt: receipt(1) }]);
  expect(result.input).toBe(JSON.stringify(event)); expect(result.first).toBeGreaterThanOrEqual(90); expect(result.first).toBeLessThan(1500); expect(result.second).toBeLessThan(90);
  // Hostile scheduling state cannot suppress a normally parsed attestation.
  chmodSync(join(f.dir, "hook-consumed.json"), 0o644);
  expect(JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { env: { ...process.env, PLACEKEEPER_MAC_DEVELOPMENT_ROOT: f.root }, encoding: "utf8", timeout: 8000 })).calls).toEqual(result.calls);
});
it("failed reads after commit and expired delivery cannot return original results", async () => {
  for (const hostile of [true, false]) {
    const f = fixture(undefined, 200); mkdirSync(join(f.root, "native-qualification-experiments"), { mode: 0o700 }); mkdirSync(f.dir, { mode: 0o700 });
    createQualificationRecord(join(f.dir, "initialized.json"), { state: "ready" });
  createQualificationRecord(join(f.dir, "run.json"), { descriptor: f.descriptor, deadlineNs: String(process.hrtime.bigint() + (hostile ? 200000000n : -1n)) });
    createQualificationRecord(join(f.dir, "decision.json"), { outcome: "commit", receipts: [receipt(1), receipt(2)] });
    createQualificationRecord(join(f.dir, "slot-1.json"), { runId, processNonce: b, invocationNonce: "2".repeat(32), receipt: receipt(2) });
    if (hostile) chmodSync(join(f.dir, "decision.json"), 0o644);
    expect(await worker(f.root, 1).completed).toEqual({ incomplete: true });
    expect(readdirSync(f.dir).filter(v => v.startsWith("delivery-"))).toHaveLength(0);
  }
});
it("crashing a real selected participant after slot publication leaves abort with no substituted peer", async () => {
  const f = fixture(undefined, 200);
  const source = `import {NativeQualificationExperiments} from ${JSON.stringify(resolve("apps/service/src/codex/native-qualification-experiments.ts"))};
await new NativeQualificationExperiments(${JSON.stringify(f.root)}).publicResult(${JSON.stringify(receipt(2))},${JSON.stringify(f.invocation(2))},${JSON.stringify(b)},{record(event){if(event==='experiment-selected')process.exit(9)}});`;
  const crashed = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source]);
  expect(await new Promise(r => crashed.once("close", r))).toBe(9);
  // Its genuine selected fixture result was published, but no delivery occurred.
  expect(JSON.parse(readFileSync(join(f.dir, "slot-1.json"), "utf8")).receipt).toEqual(receipt(2));
  // Wait until the immutable shared deadline expired by starting late, rather
  // than extending/retrying the dead participant's selection.
  expect(await worker(f.root, 1, 220).completed).toEqual({ result: receipt(1) });
  expect(JSON.parse(readFileSync(join(f.dir, "decision.json"), "utf8"))).toEqual({ outcome: "abort" });
});
it("shares permanent v1 run consumption in both action orders despite descriptor replacement", async () => {
  const { NativeQualificationControls } = await import("../src/codex/native-qualification-controls.js");
  for (const v1First of [true, false]) {
    const f = fixture("genuine-attestation-delay"), v1 = new NativeQualificationControls(f.root), experiments = new NativeQualificationExperiments(f.root);
    const invocation = f.invocation(1);
    v1.remember(invocation, "runtime-1", "attempt-1", a);
    const close = { version: 1, actionId: "9".repeat(32), action: "bridge-close", createdAt: f.descriptor.createdAt, expiresAt: f.descriptor.expiresAt, budget: 1, target: { runId, processNonce: a, invocationNonce: invocation.invocationNonce, runtimeId: "runtime-1", attemptId: "attempt-1" } };
    if (v1First) {
      writeFileSync(join(f.root, "native-qualification-controls.json"), JSON.stringify(close), { mode: 0o600 });
      expect(v1.shellGrant("runtime-1", "attempt-1")).toBeDefined();
      rmSync(join(f.root, "native-qualification-controls.json"));
      expect(await experiments.publicResult(receipt(1), invocation, a)).toEqual(receipt(1));
      expect(JSON.parse(readFileSync(join(f.dir, "initialized.json"), "utf8"))).toEqual({ state: "blocked" });
    } else {
      await experiments.publicResult(receipt(1), invocation, a);
      rmSync(f.path);
      writeFileSync(join(f.root, "native-qualification-controls.json"), JSON.stringify(close), { mode: 0o600 });
      expect(v1.shellGrant("runtime-1", "attempt-1")).toBeUndefined();
      expect(JSON.parse(readFileSync(join(f.dir, "initialized.json"), "utf8"))).toEqual({ state: "ready" });
    }
  }
});
it("initializer interruption at reservation, tombstone and partial-ready boundaries remains incomplete", async () => {
  for (const boundary of ["reservation", "tombstone", "partial-ready"]) {
    const f = fixture(undefined, 100);
    mkdirSync(join(f.root, "native-qualification-experiments"), { mode: 0o700 }); mkdirSync(f.dir, { mode: 0o700 });
    createQualificationRecord(join(f.dir, "run.json"), { descriptor: f.descriptor, deadlineNs: String(process.hrtime.bigint() + 100000000n) });
    if (boundary !== "reservation") {
      mkdirSync(join(f.root, "native-qualification-controls"), { mode: 0o700 });
      createQualificationRecord(join(f.root, "native-qualification-controls", `${runId}.consumed`), {});
    }
    if (boundary === "partial-ready") writeFileSync(join(f.dir, "initialized.json"), '{"state":"rea', { mode: 0o600 });
    expect(await worker(f.root, 1).completed).toEqual({ incomplete: true });
    expect(readdirSync(f.dir).some(file => file.startsWith("slot-") || file.startsWith("delivery-"))).toBe(false);
    // No second initializer may repair/reuse the uncertain reservation.
    expect(await worker(f.root, 2).completed).toEqual({ incomplete: true });
  }
});

it("foreign receipts and insufficient elapsed hook budget cannot consume delay", async () => {
  const f = fixture("genuine-attestation-delay"), controls = new NativeQualificationExperiments(f.root);
  await controls.publicResult(receipt(1), f.invocation(1), a);
  await controls.delayAttestation(receipt(2));
  expect(readdirSync(f.dir)).not.toContain("hook-consumed.json");
  vi.spyOn(process, "uptime").mockReturnValue(2);
  await controls.delayAttestation(receipt(1));
  expect(readdirSync(f.dir)).not.toContain("hook-consumed.json");
});

it("rechecks fresh elapsed hook budget after consuming the one-shot delay slot", async () => {
  const f = fixture("genuine-attestation-delay"), controls = new NativeQualificationExperiments(f.root);
  await controls.publicResult(receipt(1), f.invocation(1), a);
  const uptime = vi.spyOn(process, "uptime").mockReturnValueOnce(0).mockReturnValue(2);
  const observer = { record: vi.fn() };
  await controls.delayAttestation(receipt(1), observer as never);
  expect(uptime).toHaveBeenCalledTimes(2);
  expect(readdirSync(f.dir)).toContain("hook-consumed.json");
  expect(observer.record).not.toHaveBeenCalled();
});

import { NativeQualificationOldAttempt } from "../src/codex/native-qualification-old-attempt.js";
it("public experiments and authenticated old-attempt grant share one permanent tombstone in both orders", async () => {
  for (const first of ["old", "public"] as const) {
    const f = fixture("genuine-attestation-delay"), old = new NativeQualificationOldAttempt(f.root);
    const target = { runId, processNonce: a, invocationNonce: "1".repeat(32), runtimeId: "runtime_1", attemptId: "attempt_1" };
    const descriptor = { version: 1, actionId: "e".repeat(32), action: "retire-own-attempt-then-probe-once", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), budget: 1, target };
    writeFileSync(join(f.root, "native-qualification-old-attempt.json"), JSON.stringify(descriptor), { mode: 0o600 });
    old.remember(f.invocation(1), target.runtimeId, target.attemptId, a);
    const experiments = new NativeQualificationExperiments(f.root);
    if (first === "old") {
      expect(old.shellGrant(target.runtimeId, target.attemptId)).toBeDefined();
      expect(await experiments.publicResult(receipt(1), f.invocation(1), a)).toEqual(receipt(1));
      expect(JSON.parse(readFileSync(join(f.dir, "initialized.json"), "utf8"))).toEqual({ state: "blocked" });
      expect(readdirSync(f.dir)).not.toContain("slot-0.json");
    } else {
      expect(await experiments.publicResult(receipt(1), f.invocation(1), a)).toEqual(receipt(1));
      expect(JSON.parse(readFileSync(join(f.dir, "initialized.json"), "utf8"))).toEqual({ state: "ready" });
      expect(readdirSync(f.dir)).toContain("slot-0.json");
      expect(old.shellGrant(target.runtimeId, target.attemptId)).toBeUndefined();
    }
  }
});

function readinessFixture(waitMs = 1000) {
  const f = fixture("genuine-attestation-delay");
  const { delayMs: _, ...base } = f.descriptor as typeof f.descriptor & { delayMs: number };
  const descriptor = { ...base, action: "genuine-attestation-after-readiness", waitMs };
  writeFileSync(f.path, JSON.stringify(descriptor));
  return { ...f, descriptor };
}
it("readiness scheduling descriptor is closed and capped at forty seconds", () => {
  const f = readinessFixture(40000);
  expect(parseQualificationExperiment(f.descriptor, Date.now())).toEqual(f.descriptor);
  for (const value of [{ ...f.descriptor, waitMs: 40001 }, { ...f.descriptor, waitMs: 0 }, { ...f.descriptor, taskSessionId: "private" }]) expect(parseQualificationExperiment(value, Date.now())).toBeUndefined();
});
it("selected genuine readiness hook holds its original receipt until the exact daemon marker", async () => {
  const f = readinessFixture(), controls = new NativeQualificationExperiments(f.root);
  // Issuance lifetime comes from the daemon, before public-result selection.
  controls.displayIssued(receipt(1), Date.now() + 60000);
  expect(await controls.publicResult(receipt(1), f.invocation(1), a)).toEqual(receipt(1));
  let released = false;
  const waiting = controls.delayAttestation(receipt(1)).then(() => { released = true; });
  await new Promise(r => setTimeout(r, 30)); expect(released).toBe(false);
  controls.authenticatedReady(receipt(2), Date.now() + 60000);
  expect(readdirSync(f.dir)).not.toContain("ready.json");
  controls.authenticatedReady(receipt(1), Date.now() + 60000);
  await waiting;
  expect(JSON.parse(readFileSync(join(f.dir, "hook-terminal.json"), "utf8")).outcome).toBe("ready");
  const terminal = readFileSync(join(f.dir, "hook-terminal.json"), "utf8");
  await controls.delayAttestation(receipt(1));
  expect(readFileSync(join(f.dir, "hook-terminal.json"), "utf8")).toBe(terminal);
});

it.each(["missing-expiry", "aged", "cancelled", "hostile-marker", "deadline", "backward-clock"])("readiness scheduling %s finishes once without suppressing ordinary attestation", async mode => {
  const f = readinessFixture(mode === "deadline" || mode === "backward-clock" ? 40 : 1000), controls = new NativeQualificationExperiments(f.root);
  if (mode === "backward-clock") writeFileSync(f.path, JSON.stringify({ ...f.descriptor, createdAt: new Date(Date.now() - 20000).toISOString() }));
  if (mode !== "missing-expiry") controls.displayIssued(receipt(1), Date.now() + (mode === "aged" ? 5000 : 60000));
  await controls.publicResult(receipt(1), f.invocation(1), a);
  let calls = 0;
  const start = performance.now();
  const waiting = controls.delayAttestation(receipt(1)).then(() => { calls++; });
  if (mode === "cancelled") rmSync(f.path);
  if (mode === "hostile-marker") writeFileSync(join(f.dir, "ready.json"), "{}", { mode: 0o644 });
  if (mode === "backward-clock") vi.spyOn(Date, "now").mockReturnValue(Date.now() - 10000);
  await waiting;
  expect(calls).toBe(1); expect(performance.now() - start).toBeLessThan(1000);
  const terminal = readFileSync(join(f.dir, "hook-terminal.json"), "utf8");
  expect(JSON.parse(terminal).outcome).not.toBe("ready");
  if (mode === "backward-clock") expect(JSON.parse(terminal).outcome).toBe("deadline");
  await controls.delayAttestation(receipt(1));
  expect(readFileSync(join(f.dir, "hook-terminal.json"), "utf8")).toBe(terminal);
});
it.each(["ready", "cancelled", "hostile"])("real genuine parsed hook readiness %s still sends unchanged normal attestation", async mode => {
  const f = readinessFixture(1500), controls = new NativeQualificationExperiments(f.root);
  controls.displayIssued(receipt(1), Date.now() + 60000);
  await controls.publicResult(receipt(1), f.invocation(1), a);
  const event = { session_id: "actual-trusted-task", hook_event_name: "PostToolUse", tool_name: "mcp__placekeeper__display_review", tool_input: { handoff: "h".repeat(43) }, tool_response: { structuredContent: receipt(1) } };
  const source = `import ${JSON.stringify(resolve("apps/service/src/cli/context-command.ts"))};
import {runHookCommand} from ${JSON.stringify(resolve("apps/service/src/cli/hook-command.ts"))};
await runHookCommand(['hook','--event'],${JSON.stringify(JSON.stringify(event))},async request=>{process.stdout.write(JSON.stringify(request));return {kind:'codex-attestation',status:'accepted'}},()=>{});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { env: { ...process.env, PLACEKEEPER_MAC_DEVELOPMENT_ROOT: f.root }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", d => output += String(d));
  const completed = new Promise(r => child.once("close", r));
  // Signal after the actual hook consumed the exact selection, never from logs.
  for (let check = 0; check < 100 && !readdirSync(f.dir).includes("hook-consumed.json"); check++) await new Promise(r => setTimeout(r, 10));
  expect(readdirSync(f.dir)).toContain("hook-consumed.json"); expect(output).toBe("");
  if (mode === "ready") controls.authenticatedReady(receipt(1), Date.now() + 60000);
  if (mode === "cancelled") rmSync(f.path);
  if (mode === "hostile") writeFileSync(join(f.dir, "ready.json"), "{}", { mode: 0o644 });
  expect(await completed).toBe(0);
  expect(JSON.parse(output)).toEqual({ kind: "codex-attest", taskSessionId: event.session_id, receipt: receipt(1) });
  expect(JSON.parse(readFileSync(join(f.dir, "hook-terminal.json"), "utf8")).outcome).toBe(mode === "ready" ? "ready" : mode === "cancelled" ? "cancelled" : "unavailable");
});

it("competing real hook processes consume one selected readiness wait exclusively", async () => {
  const f = readinessFixture(2000), controls = new NativeQualificationExperiments(f.root);
  controls.displayIssued(receipt(1), Date.now() + 60000);
  await controls.publicResult(receipt(1), f.invocation(1), a);
  const source = `import {NativeQualificationExperiments} from ${JSON.stringify(resolve("apps/service/src/codex/native-qualification-experiments.ts"))};
await new NativeQualificationExperiments(${JSON.stringify(f.root)}).delayAttestation(${JSON.stringify(receipt(1))});process.stdout.write('ordinary');`;
  const outputs: string[] = ["", ""];
  const children = [0, 1].map(index => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", data => outputs[index] += String(data));
    return { child, completed: new Promise(resolve => child.once("close", resolve)) };
  });
  for (let check = 0; check < 100 && outputs.filter(Boolean).length === 0; check++) await new Promise(r => setTimeout(r, 10));
  expect(outputs.filter(Boolean)).toEqual(["ordinary"]);
  expect(readdirSync(f.dir)).toContain("hook-consumed.json");
  expect(readdirSync(f.dir)).not.toContain("hook-terminal.json");
  controls.authenticatedReady(receipt(1), Date.now() + 60000);
  expect(await Promise.all(children.map(child => child.completed))).toEqual([0, 0]);
  expect(outputs).toEqual(["ordinary", "ordinary"]);
  expect(JSON.parse(readFileSync(join(f.dir, "hook-terminal.json"), "utf8")).outcome).toBe("ready");
});

it("absent descriptor and foreign exact tuples never consume a readiness action", async () => {
  const f = readinessFixture(), controls = new NativeQualificationExperiments(f.root);
  controls.displayIssued(receipt(1), Date.now() + 60000);
  await controls.publicResult(receipt(1), f.invocation(1), a);
  for (const foreign of [receipt(2), { ...receipt(1), attemptId: "another" }, { ...receipt(1), generation: 2 }]) await controls.delayAttestation(foreign);
  expect(readdirSync(f.dir)).not.toContain("hook-consumed.json");
  rmSync(f.path); await controls.delayAttestation(receipt(1));
  expect(readdirSync(f.dir)).not.toContain("hook-consumed.json");
});
it("low host budget consumes no retry and records incomplete readiness", async () => {
  const f = readinessFixture(), controls = new NativeQualificationExperiments(f.root);
  controls.displayIssued(receipt(1), Date.now() + 60000);
  await controls.publicResult(receipt(1), f.invocation(1), a);
  vi.spyOn(process, "uptime").mockReturnValue(46);
  await controls.delayAttestation(receipt(1));
  expect(JSON.parse(readFileSync(join(f.dir, "hook-terminal.json"), "utf8")).outcome).toBe("budget");
});
it("readiness issuance storage stays finite across unrelated displays and stops after selection", async () => {
  const f = readinessFixture(), controls = new NativeQualificationExperiments(f.root);
  for (let index = 0; index < 300; index++) controls.displayIssued(receipt(index), Date.now() + 60000);
  const jsonFiles = () => readdirSync(f.root, { recursive: true }).filter(file => String(file).endsWith(".json"));
  expect(jsonFiles().length).toBeLessThanOrEqual(65); // descriptor plus 64 fixed issuance slots
  const count = jsonFiles().length;
  await controls.publicResult(receipt(299), f.invocation(1), a);
  const selectedCount = jsonFiles().length;
  controls.displayIssued(receipt(300), Date.now() + 60000);
  expect(jsonFiles().length).toBe(selectedCount);
  await controls.delayAttestation(receipt(299));
  expect(JSON.parse(readFileSync(join(f.dir, "hook-terminal.json"), "utf8")).outcome).toBe("unavailable");
  expect(count).toBe(65);
});
it.each(["partial", "hostile", "wrong-action"])("uncertain %s issuance slots stop publication and matching lookup", async mode => {
  const f = readinessFixture(), controls = new NativeQualificationExperiments(f.root);
  controls.displayIssued(receipt(1), Date.now() + 60000);
  const dir = join(f.dir, "issuance"), path = join(dir, "slot-0.json");
  if (mode === "partial") writeFileSync(path, "{");
  if (mode === "hostile") chmodSync(path, 0o644);
  if (mode === "wrong-action") writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), actionId: "e".repeat(32) }));
  controls.displayIssued(receipt(2), Date.now() + 60000);
  expect(readdirSync(dir)).toEqual(["slot-0.json"]);
  await controls.publicResult(receipt(2), f.invocation(1), a);
  await controls.delayAttestation(receipt(2));
  expect(JSON.parse(readFileSync(join(f.dir, "hook-terminal.json"), "utf8")).outcome).toBe("unavailable");
});
it("default issuance writes nothing and consumed controls prevent new readiness slots", async () => {
  const f = readinessFixture(), controls = new NativeQualificationExperiments(f.root);
  rmSync(f.path); controls.displayIssued(receipt(1), Date.now() + 60000);
  expect(readdirSync(f.root)).toEqual([]);
  writeFileSync(f.path, JSON.stringify(f.descriptor), { mode: 0o600 });
  mkdirSync(join(f.root, "native-qualification-controls"), { mode: 0o700 });
  createQualificationRecord(join(f.root, "native-qualification-controls", `${runId}.consumed`), { actionId: "e".repeat(32) });
  controls.displayIssued(receipt(1), Date.now() + 60000);
  expect(readdirSync(f.dir)).not.toContain("issuance");
});
it("chosen immutable issuance slot becoming hostile cancels its active hook wait", async () => {
  const f = readinessFixture(), controls = new NativeQualificationExperiments(f.root);
  controls.displayIssued(receipt(1), Date.now() + 60000);
  await controls.publicResult(receipt(1), f.invocation(1), a);
  const waiting = controls.delayAttestation(receipt(1));
  chmodSync(join(f.dir, "issuance", "slot-0.json"), 0o644);
  await waiting;
  expect(JSON.parse(readFileSync(join(f.dir, "hook-terminal.json"), "utf8")).outcome).toBe("unavailable");
});
it("competing daemon publishers cannot exceed fixed immutable issuance slots", async () => {
  const f = readinessFixture();
  const tasks = [0, 1000].map(offset => {
    const source = `import {NativeQualificationExperiments} from ${JSON.stringify(resolve("apps/service/src/codex/native-qualification-experiments.ts"))};
const controls=new NativeQualificationExperiments(${JSON.stringify(f.root)});
for(let n=0;n<100;n++) controls.displayIssued({protocolVersion:1,status:'pending',receiptId:'receipt_'+(n+${offset}),attemptId:'attempt_'+(n+${offset}),generation:1},Date.now()+60000);`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "pipe"] });
    return new Promise(resolve => child.once("close", resolve));
  });
  expect(await Promise.all(tasks)).toEqual([0, 0]);
  const files = readdirSync(join(f.dir, "issuance"));
  expect(files.length).toBeGreaterThan(0); expect(files.length).toBeLessThanOrEqual(64);
  files.forEach(file => expect(file).toMatch(/^slot-(?:[0-9]|[1-5][0-9]|6[0-3])\.json$/));
});

it("issuance parent replaced by a symlink during genuine wait cannot release readiness", async () => {
  const f = readinessFixture(), controls = new NativeQualificationExperiments(f.root);
  controls.displayIssued(receipt(1), Date.now() + 60000);
  await controls.publicResult(receipt(1), f.invocation(1), a);
  const waiting = controls.delayAttestation(receipt(1));
  const issuance = join(f.dir, "issuance"), moved = join(f.dir, "moved-issuance");
  renameSync(issuance, moved); symlinkSync(moved, issuance);
  controls.authenticatedReady(receipt(1), Date.now() + 60000);
  await waiting;
  expect(JSON.parse(readFileSync(join(f.dir, "hook-terminal.json"), "utf8")).outcome).toBe("unavailable");
});
