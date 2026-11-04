import { describe, expect, it } from "vitest";
import { coordinateServiceSwitch } from "../src/host/upgrade-coordinator.js";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupRecoveryAndVerify, type CoordinateServiceSwitchOptions } from "../src/host/upgrade-coordinator.js";
import { establishPrivateDirectory } from "../src/platform/private-storage.js";
import { acquireLifecycleLock } from "../src/host/lifecycle-lock.js";
import { createServer } from "node:net";
import { vi } from "vitest";
import { PlacekeeperHost } from "../src/host/placekeeper-host.js";
import { startServiceDaemon } from "../src/host/service-daemon.js";

describe("explicit service switching", () => {
  it("does not back up or retire a busy incumbent", async () => {
    const events: string[] = [];
    await expect(coordinateServiceSwitch({
      candidate: { daemonIdentity: "candidate", installArtifactIdentity: "candidate" },
      recoveryCompatible: async () => { events.push("compatible"); return true; },
      backupAndVerify: async () => { events.push("backup"); },
      inspect: async () => ({ kind: "incompatible", status: { protocolVersion: 1, upgradePreparationVersion: 1, daemonIdentity: "old", lifecycle: "accepting", activity: { reviewPresence: 1, codexTasks: 0, transientWork: 0 } } }),
      shutdown: async () => { events.push("shutdown"); return { status: "accepted" }; },
      waitForRetirement: async () => { events.push("retired"); },
      replaceAndReady: async () => { events.push("ready"); },
    })).rejects.toMatchObject({ reason: "preparation-required" });
    expect(events).toEqual([]);
  });
  it("verifies backup after retirement and before candidate readiness", async () => {
    const events: string[] = [];
    await coordinateServiceSwitch({
      candidate: { daemonIdentity: "candidate", installArtifactIdentity: "candidate" },
      recoveryCompatible: async () => { events.push("compatible"); return true; },
      backupAndVerify: async () => { events.push("backup"); },
      inspect: async () => ({ kind: "absent" }),
      shutdown: async () => { events.push("shutdown"); return { status: "accepted" }; },
      waitForRetirement: async () => { events.push("retired"); },
      replaceAndReady: async () => { events.push("ready"); },
    });
    expect(events).toEqual(["compatible", "compatible", "backup", "ready"]);
  });
});

function fixture(events: string[]): CoordinateServiceSwitchOptions {
  return {
    candidate: { daemonIdentity: "candidate", installArtifactIdentity: "candidate" },
    recoveryCompatible: async () => { events.push("compatible"); return true; },
    backupAndVerify: async () => { events.push("backup"); },
    inspect: async () => ({ kind: "incompatible", status: { protocolVersion: 1, upgradePreparationVersion: 1, daemonIdentity: "old", lifecycle: "accepting", activity: { reviewPresence: 0, codexTasks: 0, transientWork: 0 } } }),
    shutdown: async () => { events.push("shutdown"); return { status: "accepted" }; },
    waitForRetirement: async () => { events.push("retired"); },
    replaceAndReady: async () => { events.push("ready"); },
  };
}
it("requires recovery compatibility before retiring the incumbent", async () => {
  const events: string[] = []; const options = fixture(events);
  await expect(coordinateServiceSwitch({ ...options, recoveryCompatible: async () => false })).rejects.toThrow("cannot read");
  expect(events).toEqual([]);
});
it("rechecks idleness at shutdown when activity arrives after inspection", async () => {
  const events: string[] = []; const options = fixture(events);
  await expect(coordinateServiceSwitch({ ...options, shutdown: async () => ({ status: "refused", activity: { reviewPresence: 1, codexTasks: 0, transientWork: 0 } }) })).rejects.toThrow("active reviews");
  expect(events).toEqual(["compatible"]);
});
it("does not start the candidate without proven incumbent retirement", async () => {
  const events: string[] = []; const options = fixture(events);
  await expect(coordinateServiceSwitch({ ...options, waitForRetirement: async () => { throw new Error("not retired"); } })).rejects.toThrow("not retired");
  expect(events).toEqual(["compatible", "shutdown"]);
});
it("does not start the candidate when backup verification fails", async () => {
  const events: string[] = []; const options = fixture(events);
  await expect(coordinateServiceSwitch({ ...options, backupAndVerify: async () => { throw new Error("bad backup"); } })).rejects.toThrow("bad backup");
  expect(events).toEqual(["compatible", "shutdown", "retired", "compatible"]);
});
it("failed readiness propagates after retirement and backup without launching another writer", async () => {
  const events: string[] = []; const options = fixture(events);
  await expect(coordinateServiceSwitch({ ...options, replaceAndReady: async () => { events.push("candidate"); throw new Error("not ready"); } })).rejects.toThrow("not ready");
  expect(events).toEqual(["compatible", "shutdown", "retired", "compatible", "backup", "candidate"]);
});
it("copies and verifies nested recovery without altering canonical bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-backup-"));
  try {
    const source = join(root, "recovery"); await mkdir(join(source, "drafts"), { recursive: true });
    await writeFile(join(source, "drafts", "snapshot.json"), '{"schemaVersion":3}');
    const backup = join(root, "backup"); await backupRecoveryAndVerify(source, backup);
    expect(await readFile(join(backup, "drafts", "snapshot.json"), "utf8")).toBe('{"schemaVersion":3}');
    expect(await readFile(join(source, "drafts", "snapshot.json"), "utf8")).toBe('{"schemaVersion":3}');
    await expect(backupRecoveryAndVerify(source, backup)).rejects.toThrow("already exists");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.skipIf(process.platform === "win32")("refuses recovery symlinks rather than backing up outside authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-backup-"));
  try {
    const source = join(root, "recovery"); await mkdir(source);
    await writeFile(join(root, "outside"), "secret"); await symlink(join(root, "outside"), join(source, "link"));
    await expect(backupRecoveryAndVerify(source, join(root, "backup"))).rejects.toThrow("refuses links");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not borrow a stale owner's token after the coordinating process died", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-lease-"));
  await establishPrivateDirectory(root);
  try {
    const lock = join(root, "lifecycle.lock"); await mkdir(lock, { mode: 0o700 });
    const token = "a".repeat(32);
    await writeFile(join(lock, `owner-${token}.json`), JSON.stringify({ version: 1, pid: 2147483647, token }), { mode: 0o600 });
    await expect(acquireLifecycleLock(lock, { inheritedToken: token, timeoutMs: 0 })).rejects.toThrow("busy");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === "win32")("does not open canonical recovery while a control listener is live", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-live-"));
  const path = join(root, "control.sock"); const listener = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => listener.listen(path, resolve));
  const start = vi.spyOn(PlacekeeperHost, "start").mockRejectedValue(new Error("unexpected second writer"));
  try {
    await expect(startServiceDaemon({ appSupportRoot: root, recoveryRoot: join(root, "recovery"), socketPath: path, webAssetsRoot: join(root, "assets"), httpPort: 0 })).rejects.toThrow("already running");
    expect(start).not.toHaveBeenCalled();
  } finally { start.mockRestore(); await new Promise<void>((resolve) => listener.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
it("holds lifecycle exclusion until a startup borrower releases participation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-borrower-")); await establishPrivateDirectory(root);
  try {
    const path = join(root, "lifecycle.lock");
    const owner = await acquireLifecycleLock(path);
    const child = await acquireLifecycleLock(path, { inheritedToken: owner.token });
    await owner.release();
    await expect(acquireLifecycleLock(path, { timeoutMs: 0 })).rejects.toThrow("busy");
    await child.release();
    const successor = await acquireLifecycleLock(path, { timeoutMs: 100 }); await successor.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("reclaims an abandoned borrower without deleting a live successor lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-borrower-dead-")); await establishPrivateDirectory(root);
  try {
    const path = join(root, "lifecycle.lock"); await mkdir(path, { mode: 0o700 });
    const token = "a".repeat(32); const nonce = "b".repeat(32);
    await writeFile(join(path, `borrower-${token}-${nonce}.json`), JSON.stringify({ version: 1, pid: 2147483647, token }), { mode: 0o600 });
    const successor = await acquireLifecycleLock(path, { timeoutMs: 2000, now: () => Date.now() + 2000 });
    await expect(acquireLifecycleLock(path, { timeoutMs: 0 })).rejects.toThrow("busy");
    await successor.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
