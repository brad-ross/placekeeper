import { constants, readSync, openSync, mkdirSync, chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NativeQualificationObserver } from "../src/codex/native-qualification.js";
import { TaskBindingRegistry } from "../src/context/task-binding-registry.js";
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, openSync: vi.fn(fs.openSync), readSync: vi.fn(fs.readSync) };
});
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-observer-")); roots.push(root);
  const descriptor = { version: 1, runId: "a".repeat(32), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), salt: "s".repeat(43), observe: true };
  const path = join(root, "native-qualification.json");
  const write = () => writeFileSync(path, JSON.stringify(descriptor), { mode: 0o600 });
  const observer = new NativeQualificationObserver(root, "daemon");
  const records = () => readdirSync(join(root, "native-qualification", descriptor.runId)).flatMap(file => readFileSync(join(root, "native-qualification", descriptor.runId, file), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
  return { root, descriptor, path, write, observer, records };
}
it("is disabled by absence, invalid mode/schema, symlink and expiry", () => {
  const f = fixture(); expect(f.observer.invocation()).toBeUndefined(); f.write(); chmodSync(f.path, 0o644); expect(f.observer.invocation()).toBeUndefined(); chmodSync(f.path, 0o600);
  writeFileSync(f.path, JSON.stringify({ ...f.descriptor, controls: true })); expect(f.observer.invocation()).toBeUndefined();
  rmSync(f.path); writeFileSync(join(f.root, "target"), JSON.stringify(f.descriptor), { mode: 0o600 }); symlinkSync(join(f.root, "target"), f.path); expect(f.observer.invocation()).toBeUndefined();
  rmSync(f.path); f.descriptor.expiresAt = new Date(Date.now() - 1).toISOString(); f.write(); expect(f.observer.invocation()).toBeUndefined();
});
it("stores bounded closed records with domain-separated correlations and fresh private nonces", () => {
  const f = fixture(); f.write(); const first = f.observer.invocation()!, second = f.observer.invocation()!;
  expect(first.invocationNonce).not.toEqual(second.invocationNonce); expect(Object.keys(first).sort()).toEqual(["expiresAt", "invocationNonce", "runId"]);
  for (let i = 0; i < 400; i++) f.observer.record("claim-accepted", { taskSessionId: "private-task", reviewSessionId: "private-task", generation: 2, capability: "secret", arbitrary: "secret" } as never);
  const records = f.records(); expect(records.length).toBeGreaterThan(0); expect(records.length).toBeLessThanOrEqual(256);
  expect(records.find(r => r.event === "claim-accepted").taskHash).not.toEqual(records.find(r => r.event === "claim-accepted").reviewHash); expect(records.map(r => r.sequence)).toEqual(records.map((_, i) => i + 1));
  expect(JSON.stringify(records)).not.toMatch(/private-task|secret|capability|arbitrary/);
  expect(Buffer.byteLength(records.map(r => JSON.stringify(r) + "\n").join(""))).toBeLessThanOrEqual(32768);
});
it("drops failed sinks and invalid or excessive fields without throwing", () => {
  const f = fixture(); f.write(); writeFileSync(join(f.root, "native-qualification"), "occupied");
  expect(() => f.observer.record("claim-accepted", { taskSessionId: "x".repeat(10000) })).not.toThrow();
  expect(f.observer.invocation()).toBeUndefined();
});
it("limits a run to 64 reserved writers and rejects symlink directories and excessive lifetime", () => {
  const f = fixture(); f.write();
  for (let index = 0; index < 64; index++) expect(new NativeQualificationObserver(f.root, "server").invocation()).toBeDefined();
  expect(new NativeQualificationObserver(f.root, "hook").invocation()).toBeUndefined();
  expect(readdirSync(join(f.root, "native-qualification", f.descriptor.runId))).toHaveLength(64);
  const long = fixture(); long.descriptor.expiresAt = new Date(Date.now() + 31 * 60_000).toISOString(); long.write(); expect(long.observer.invocation()).toBeUndefined();
  const linked = fixture(); linked.write(); symlinkSync(f.root, join(linked.root, "native-qualification")); expect(linked.observer.invocation()).toBeUndefined();
});

it("records both simultaneous native ownership conflicts from the deciding state without changing claims", () => {
  const f = fixture(); f.write(); const registry = new TaskBindingRegistry({ qualification: f.observer });
  const claim = (taskSessionId: string, reviewSessionId: string, browserCapability: string, generation = 1) => {
    const bindProof = registry.issueBindProof({ reviewSessionId, documentGeneration: 1, browserCapability, native: true });
    return registry.claimNative({ taskSessionId, reviewSessionId, bindProof, documentGeneration: generation });
  };
  expect(claim("task-a", "review-a", "capability-a")).toMatchObject({ status: "pending" });
  expect(claim("task-b", "review-b", "capability-b")).toMatchObject({ status: "pending" });
  expect(claim("task-a", "review-b", "capability-conflict")).toEqual({ status: "denied" });
  const denials = f.records().map(record => record.denial);
  expect(denials).toContain("task-associated-other-review"); expect(denials).toContain("review-owned-other-task");
  expect(claim("task-c", "review-c", "capability-generation", 2)).toEqual({ status: "denied" });
  expect(registry.claimNative({ taskSessionId: "task-c", reviewSessionId: "review-c", bindProof: "missing-proof", documentGeneration: 1 })).toEqual({ status: "denied" });
  expect(f.records().map(record => record.denial)).toContain("generation-mismatch");
  expect(f.records().map(record => record.denial)).toContain("proof-missing-or-expired");
  expect(registry.activityCount()).toBe(2);
  expect(JSON.stringify(f.records())).not.toMatch(/"task-a"|"review-a"|capability-/);
});

it("disables a descriptor owned by a different uid", () => {
  const f = fixture(); f.write();
  vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
  expect(f.observer.invocation()).toBeUndefined();
});
it("retains app output-shape changes and clears polling deduplication for each run", () => {
  const f = fixture(); f.write();
  const fields = { runtimeId: "runtime-1", attemptId: "attempt-1", method: "watermark", status: "ok", uiResource: false, contentCount: 0 };
  f.observer.record("app-result", fields); f.observer.record("app-result", fields);
  f.observer.record("app-result", { ...fields, uiResource: true });
  f.observer.record("app-result", { ...fields, status: "denied", denial: "revoked" });
  f.observer.record("app-result", { ...fields, status: "denied", denial: "revoked" });
  expect(f.records().map(r => [r.status, r.uiResource])).toEqual([["ok", false], ["ok", true], ["denied", false], ["denied", false]]);
  f.descriptor.runId = "e".repeat(32); f.write(); f.observer.record("app-result", fields);
  expect(f.records()).toHaveLength(1); expect(f.records()[0].sequence).toBe(1);
});
it("fails soft for throwing diagnostic fields", () => {
  const f = fixture(); f.write();
  const fields = new Proxy({}, { get() { throw new Error("private diagnostic failure"); }, ownKeys() { throw new Error("private diagnostic failure"); } });
  expect(() => f.observer.record("app-result", fields)).not.toThrow();
  expect(() => f.observer.invocation(fields)).not.toThrow();
});

it("does not repeat exhausted writer allocation while revalidating each call and allowing a new run", () => {
  const f = fixture(); f.write();
  const parent = join(f.root, "native-qualification"), directory = join(parent, f.descriptor.runId);
  mkdirSync(parent, { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
  for (let slot = 0; slot < 64; slot++) writeFileSync(join(directory, `writer-${slot}.jsonl`), "", { mode: 0o600 });
  const opens = vi.mocked(openSync); opens.mockClear();
  expect(f.observer.invocation()).toBeUndefined();
  expect(opens.mock.calls.filter(call => typeof call[1] === "number" && (call[1] & constants.O_EXCL) !== 0)).toHaveLength(64);
  opens.mockClear();
  for (let index = 0; index < 200; index++) f.observer.record("claim-accepted", { taskSessionId: "private-task" });
  expect(opens.mock.calls.filter(call => typeof call[1] === "number" && (call[1] & constants.O_EXCL) !== 0)).toHaveLength(0);
  expect(opens.mock.calls.filter(call => call[0] === f.path)).toHaveLength(200);
  expect(readdirSync(directory)).toHaveLength(64);
  f.descriptor.runId = "f".repeat(32); f.write();
  expect(f.observer.invocation()).toBeDefined();
  expect(f.records()).toHaveLength(1);
});

import { NativeQualificationControls } from "../src/codex/native-qualification-controls.js";
import { linkSync } from "node:fs";
const controlTarget = { runId: "a".repeat(32), processNonce: "b".repeat(32), invocationNonce: "c".repeat(32), runtimeId: "runtime-1", attemptId: "attempt-1" };
function controlsFixture() {
  const f = fixture(), path = join(f.root, "native-qualification-controls.json");
  const descriptor = { version: 1, actionId: "d".repeat(32), action: "bridge-close", budget: 1, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), target: controlTarget };
  const write = (value: unknown = descriptor) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  const controls = new NativeQualificationControls(f.root);
  const remember = (consumer = controls, target = controlTarget) => consumer.remember({ runId: target.runId, invocationNonce: target.invocationNonce, expiresAt: descriptor.expiresAt }, target.runtimeId, target.attemptId, target.processNonce);
  remember();
  return { ...f, path, descriptor, write, controls, remember };
}
it("keeps controls absent and observe:true behavior disabled, and matches every exact selector", () => {
  const f = controlsFixture(); expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
  f.write({ ...f.descriptor, observe: true }); expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
  for (const key of Object.keys(controlTarget)) { f.write({ ...f.descriptor, target: { ...controlTarget, [key]: "e".repeat(32) } }); expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined(); }
  f.write(); expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toMatchObject({ actionId: f.descriptor.actionId, action: "bridge-close", budget: 1 });
  expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
  f.write({ ...f.descriptor, actionId: "f".repeat(32) }); const consumer = new NativeQualificationControls(f.root); f.remember(consumer); expect(consumer.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
});
it("rejects control descriptor schema, expiry, budget, unsupported actions, file mode, symlink and hardlinks", () => {
  const f = controlsFixture();
  for (const value of [{ ...f.descriptor, capability: "secret" }, { ...f.descriptor, target: { ...controlTarget, pid: 1 } }, { ...f.descriptor, budget: 2 }, { ...f.descriptor, action: "hook-delay" }, { ...f.descriptor, delayMs: 1 }, { ...f.descriptor, expiresAt: new Date(Date.now() - 1).toISOString() }, { ...f.descriptor, expiresAt: new Date(Date.now() + 31 * 60_000).toISOString() }]) { f.write(value); expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined(); }
  f.write(); chmodSync(f.path, 0o644); expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined(); chmodSync(f.path, 0o600);
  linkSync(f.path, join(f.root, "hardlink")); expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined(); rmSync(join(f.root, "hardlink"));
  const target = join(f.root, "descriptor-target"); writeFileSync(target, JSON.stringify(f.descriptor), { mode: 0o600 }); rmSync(f.path); symlinkSync(target, f.path); expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
});
it("atomically permits only one consumer across independently constructed controls", async () => {
  const f = controlsFixture(); f.write();
  const results = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => { const consumer = new NativeQualificationControls(f.root); f.remember(consumer); return consumer.shellGrant(controlTarget.runtimeId, controlTarget.attemptId); })));
  expect(results.filter(Boolean)).toHaveLength(1);
});
it("fails closed on symlinked consume directories and requires a retained own observed invocation for shell grants", () => {
  const f = controlsFixture(); f.write();
  expect(new NativeQualificationControls(f.root).shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
  expect(f.controls.shellGrant("runtime-peer", controlTarget.attemptId)).toBeUndefined();
  const other = fixture(); symlinkSync(other.root, join(f.root, "native-qualification-controls")); expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined(); rmSync(join(f.root, "native-qualification-controls"));
  expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toMatchObject({ action: "bridge-close", budget: 1, target: controlTarget });
  expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
});
it("refuses duplicate/ambiguous invocation identity and expired observations", () => {
  const f = controlsFixture(); f.write(); f.remember(); f.remember();
  expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
  const consumer = new NativeQualificationControls(f.root); consumer.remember({ runId: controlTarget.runId, invocationNonce: controlTarget.invocationNonce, expiresAt: new Date(Date.now() - 1).toISOString() }, controlTarget.runtimeId, controlTarget.attemptId, controlTarget.processNonce);
  expect(consumer.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
});

import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
it("uses an exclusive consume across concurrent real processes", async () => {
  const f = controlsFixture(); f.write();
  const moduleUrl = pathToFileURL(join(process.cwd(), "apps/service/src/codex/native-qualification-controls.ts")).href;
  const code = `import { NativeQualificationControls } from ${JSON.stringify(moduleUrl)}; const c = new NativeQualificationControls(process.argv[1]); const d = JSON.parse(process.argv[2]); c.remember({ runId: d.target.runId, invocationNonce: d.target.invocationNonce, expiresAt: d.expiresAt }, d.target.runtimeId, d.target.attemptId, d.target.processNonce); process.stdout.write(c.shellGrant(d.target.runtimeId, d.target.attemptId) === undefined ? "skipped" : "granted");`;
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code, f.root, JSON.stringify(f.descriptor)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; }); child.on("error", reject); child.on("close", status => status === 0 ? resolve(stdout) : reject(new Error(stderr)));
  })));
  expect(results.filter(result => result === "granted")).toHaveLength(1);
  expect(results.filter(result => result === "skipped")).toHaveLength(3);
});
it("rejects controls owned by another user and refuses an existing symlink tombstone", () => {
  const f = controlsFixture(); f.write();
  const uid = process.getuid!(); vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
  expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined(); vi.restoreAllMocks();
  const directory = join(f.root, "native-qualification-controls"); mkdirSync(directory, { mode: 0o700 }); symlinkSync(f.path, join(directory, `${controlTarget.runId}.consumed`));
  expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
});

it("rejects FIFO descriptors and a replaced FIFO sink without blocking a real child process", async () => {
  const observation = fixture(), controls = controlsFixture(), sink = fixture(); sink.write();
  execFileSync("/usr/bin/mkfifo", ["-m", "600", observation.path]); execFileSync("/usr/bin/mkfifo", ["-m", "600", controls.path]);
  const observerUrl = pathToFileURL(join(process.cwd(), "apps/service/src/codex/native-qualification.ts")).href;
  const controlsUrl = pathToFileURL(join(process.cwd(), "apps/service/src/codex/native-qualification-controls.ts")).href;
  const code = `import { NativeQualificationObserver } from ${JSON.stringify(observerUrl)}; import { NativeQualificationControls } from ${JSON.stringify(controlsUrl)}; import { readdirSync, rmSync } from "node:fs"; import { join } from "node:path"; import { execFileSync } from "node:child_process";
    const [observationRoot, controlsRoot, sinkRoot, descriptor] = JSON.parse(process.argv[1]);
    if (new NativeQualificationObserver(observationRoot, "server").invocation() !== undefined) throw new Error("FIFO observation accepted");
    const c = new NativeQualificationControls(controlsRoot); c.remember({ runId: descriptor.target.runId, invocationNonce: descriptor.target.invocationNonce, expiresAt: descriptor.expiresAt }, descriptor.target.runtimeId, descriptor.target.attemptId, descriptor.target.processNonce);
    if (c.shellGrant(descriptor.target.runtimeId, descriptor.target.attemptId) !== undefined) throw new Error("FIFO control accepted");
    const o = new NativeQualificationObserver(sinkRoot, "server"); if (o.invocation() === undefined) throw new Error("valid observation rejected");
    const directory = join(sinkRoot, "native-qualification", descriptor.target.runId), path = join(directory, readdirSync(directory)[0]); rmSync(path); execFileSync("/usr/bin/mkfifo", ["-m", "600", path]);
    o.record("claim-accepted"); process.stdout.write("completed");`;
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code, JSON.stringify([observation.root, controls.root, sink.root, controls.descriptor])], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    // Parent-side deadline remains runnable even if the child's sync open hangs.
    const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 3000);
    child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("error", error => { clearTimeout(deadline); reject(error); }); child.on("close", status => { clearTimeout(deadline); if (timedOut) reject(new Error("FIFO qualification child exceeded external deadline")); else if (status !== 0) reject(new Error(stderr)); else resolve(stdout); });
  });
  expect(result).toBe("completed");
});
it("bounds both descriptor reads when files grow after the initial stat and rejects oversized files", async () => {
  const original = await vi.importActual<typeof import("node:fs")>("node:fs");
  for (const type of ["observer", "controls"] as const) {
    const f = type === "observer" ? fixture() : controlsFixture(); f.write();
    const invoke = () => "controls" in f ? f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId) : f.observer.invocation();
    writeFileSync(f.path, " ".repeat(2049)); expect(invoke()).toBeUndefined(); f.write();
    let readBudget = 0;
    vi.mocked(readSync).mockImplementationOnce((...args: Parameters<typeof readSync>) => {
      original.appendFileSync(f.path, " ".repeat(1024 * 1024));
      readBudget = args[2]?.length ?? 0;
      return original.readSync(...args);
    });
    expect(invoke()).toBeUndefined(); expect(readBudget).toBe(2048);
  }
});

it("skips descriptor and tombstone opens for retained consumed run records while a fresh run can arm later", () => {
  const f = controlsFixture(), peer = { ...controlTarget, invocationNonce: "e".repeat(32), runtimeId: "runtime-peer", attemptId: "attempt-peer" }; f.remember(f.controls, peer);
  const opens = vi.mocked(openSync); opens.mockClear();
  expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
  expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
  expect(opens.mock.calls.filter(call => call[0] === f.path)).toHaveLength(2);
  f.write(); expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeDefined();
  opens.mockClear();
  for (let i = 0; i < 200; i++) {
    expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
    expect(f.controls.shellGrant(peer.runtimeId, peer.attemptId)).toBeUndefined();
  }
  expect(opens).not.toHaveBeenCalled();
  const fresh = { ...controlTarget, runId: "f".repeat(32), invocationNonce: "f".repeat(32), runtimeId: "runtime-fresh", attemptId: "attempt-fresh" };
  f.remember(f.controls, fresh); f.write({ ...f.descriptor, target: fresh });
  expect(f.controls.shellGrant(fresh.runtimeId, fresh.attemptId)).toMatchObject({ target: fresh });
  expect(opens.mock.calls.filter(call => call[0] === f.path)).toHaveLength(1);
  expect(opens.mock.calls.filter(call => typeof call[0] === "string" && call[0].endsWith(`${fresh.runId}.consumed`))).toHaveLength(1);
});

import { NativeQualificationOldAttempt } from "../src/codex/native-qualification-old-attempt.js";
function oldControlsFixture() {
  const f = controlsFixture(), old = new NativeQualificationOldAttempt(f.root), path = join(f.root, "native-qualification-old-attempt.json");
  const descriptor = { ...f.descriptor, action: "retire-own-attempt-then-probe-once" };
  const remember = (c = old) => c.remember({ runId: controlTarget.runId, invocationNonce: controlTarget.invocationNonce, expiresAt: descriptor.expiresAt }, controlTarget.runtimeId, controlTarget.attemptId, controlTarget.processNonce);
  remember();
  return { ...f, old, oldPath: path, oldDescriptor: descriptor, oldRemember: remember, writeOld: (value: unknown = descriptor) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 }) };
}
it("old-attempt grants require exact genuine retained invocation and secure closed descriptor", () => {
  const f = oldControlsFixture();
  expect(f.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined(); f.writeOld();
  expect(new NativeQualificationOldAttempt(f.root).shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
  expect(f.old.shellGrant("runtime-peer", controlTarget.attemptId)).toBeUndefined();
  for (const value of [{ ...f.oldDescriptor, capability: "secret" }, { ...f.oldDescriptor, target: { ...controlTarget, taskId: "forged" } }, { ...f.oldDescriptor, budget: 2 }, { ...f.oldDescriptor, action: "bridge-close" }, { ...f.oldDescriptor, expiresAt: new Date(Date.now() - 1).toISOString() }]) {
    f.writeOld(value); expect(f.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
  }
  f.writeOld(); chmodSync(f.oldPath, 0o644); expect(f.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined(); chmodSync(f.oldPath, 0o600);
  const hard = join(f.root, "old-hardlink"); linkSync(f.oldPath, hard); expect(f.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined(); rmSync(hard);
  const copy = join(f.root, "old-target"); writeFileSync(copy, JSON.stringify(f.oldDescriptor), { mode: 0o600 }); rmSync(f.oldPath); symlinkSync(copy, f.oldPath); expect(f.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined(); rmSync(f.oldPath);
  f.writeOld(); chmodSync(f.root, 0o755); expect(f.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined(); chmodSync(f.root, 0o700);
  expect(f.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toMatchObject({ target: controlTarget, action: "retire-own-attempt-then-probe-once" });
  expect(f.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
});
it("permanent tombstone is shared in both orders between old-attempt and v1 close actions", () => {
  for (const first of ["old", "close"] as const) {
    const f = oldControlsFixture(); f.write(); f.writeOld();
    const winners = first === "old" ? [f.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId), f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)] : [f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId), f.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)];
    expect(winners[0]).toBeDefined(); expect(winners[1]).toBeUndefined();
    const fresh = new NativeQualificationOldAttempt(f.root); f.oldRemember(fresh); expect(fresh.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
  }
});
it("old-attempt refuses ambiguous invocation, oversized descriptors, FIFO and symlinked tombstone directory", () => {
  const f = oldControlsFixture(); f.writeOld(); f.oldRemember(); expect(f.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
  const g = oldControlsFixture(); writeFileSync(g.oldPath, " ".repeat(2049), { mode: 0o600 }); expect(g.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined(); rmSync(g.oldPath);
  execFileSync("/usr/bin/mkfifo", ["-m", "600", g.oldPath]); expect(g.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined(); rmSync(g.oldPath); g.writeOld();
  const other = fixture(); symlinkSync(other.root, join(g.root, "native-qualification-controls")); expect(g.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
});
it("old-attempt definite prior consumption stops repeated opens across retained run peers while a fresh run still grants", () => {
  const f = oldControlsFixture(), peer = { ...controlTarget, invocationNonce: "e".repeat(32), runtimeId: "runtime-peer", attemptId: "attempt-peer" };
  f.old.remember({ runId: peer.runId, invocationNonce: peer.invocationNonce, expiresAt: f.oldDescriptor.expiresAt }, peer.runtimeId, peer.attemptId, peer.processNonce);
  f.write(); f.writeOld(); expect(f.controls.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeDefined();
  const opens = vi.mocked(openSync); opens.mockClear();
  expect(f.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
  expect(opens.mock.calls.filter(call => call[0] === f.oldPath)).toHaveLength(1);
  expect(opens.mock.calls.filter(call => typeof call[0] === "string" && call[0].endsWith(`${controlTarget.runId}.consumed`))).toHaveLength(1);
  opens.mockClear();
  for (let index = 0; index < 200; index++) {
    expect(f.old.shellGrant(controlTarget.runtimeId, controlTarget.attemptId)).toBeUndefined();
    expect(f.old.shellGrant(peer.runtimeId, peer.attemptId)).toBeUndefined();
  }
  expect(opens).not.toHaveBeenCalled();
  const fresh = { ...controlTarget, runId: "f".repeat(32), invocationNonce: "f".repeat(32), runtimeId: "runtime-fresh", attemptId: "attempt-fresh" };
  f.old.remember({ runId: fresh.runId, invocationNonce: fresh.invocationNonce, expiresAt: f.oldDescriptor.expiresAt }, fresh.runtimeId, fresh.attemptId, fresh.processNonce);
  f.writeOld({ ...f.oldDescriptor, target: fresh });
  expect(f.old.shellGrant(fresh.runtimeId, fresh.attemptId)).toMatchObject({ target: fresh });
  expect(opens.mock.calls.filter(call => call[0] === f.oldPath)).toHaveLength(1);
  expect(opens.mock.calls.filter(call => typeof call[0] === "string" && call[0].endsWith(`${fresh.runId}.consumed`))).toHaveLength(1);
});

it("only the genuine async display hook receives the readiness scheduling host budget", () => {
  const config = JSON.parse(readFileSync("integrations/codex-plugin/hooks/hooks.json", "utf8"));
  const post = config.hooks.PostToolUse;
  const display = post.find((entry: { matcher: string }) => entry.matcher === "^mcp__placekeeper__display_review$").hooks[0];
  expect(display.async).toBe(true); expect(display.timeout).toBe(55);
  expect(post.find((entry: { matcher: string }) => entry.matcher === "^Bash$").hooks[0].timeout).toBe(8);
  expect(config.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(8);
  expect(config.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
});

it("observes the closed operation-error status without service payload or paths", () => {
  const f = fixture(); f.write();
  f.observer.record("app-result", { runtimeId: "runtime_1234", attemptId: "attempt_1234", method: "exportReviewedCopy", status: "operation-error", generation: 1 });
  const records = f.records();
  expect(records.at(-1)).toMatchObject({ event: "app-result", method: "exportReviewedCopy", status: "operation-error", generation: 1 });
  expect(JSON.stringify(records)).not.toMatch(/payload|path|presentationCapability/);
});
