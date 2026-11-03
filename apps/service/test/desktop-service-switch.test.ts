import { createServer } from "node:net";
import { lstat, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), request: vi.fn(), ready: vi.fn(), release: vi.fn() }));
vi.mock("../src/host/launch-control.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/host/launch-control.js")>(), inspectDaemonCompatibility: mocks.inspect, requestControl: mocks.request }));
vi.mock("../src/host/lifecycle-lock.js", () => ({ acquireLifecycleLock: async () => ({ token: "test-lease", release: mocks.release }) }));
vi.mock("../src/host/service-daemon.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/host/service-daemon.js")>(), ensureServiceDaemonReady: mocks.ready }));
vi.mock("../src/platform/runtime-layout.js", () => ({ resolvePackagedRuntime: async () => ({ webAssetsRoot: "/unused-web" }) }));
import { switchDesktopService } from "../src/cli/desktop-service-switch.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pk-switch-"));
  const resources = join(root, "candidate"); const recoveryRoot = join(root, "recovery");
  await mkdir(resources); await mkdir(recoveryRoot);
  await writeFile(join(resources, "runtime-manifest.json"), JSON.stringify({ daemonIdentity: "a".repeat(64), installArtifactIdentity: "b".repeat(64), recovery: { readableDraftSchemaVersions: [1, 2, 3], writtenDraftSchemaVersion: 3 } }));
  return { resources, backup: join(root, "backup"), receipt: join(root, "receipt"), paths: { appSupportRoot: root, recoveryRoot, socketPath: join(root, "control.sock"), webAssetsRoot: join(root, "web") } };
}
const status = (reviewPresence = 0) => ({ protocolVersion: 1, daemonIdentity: "c".repeat(64), lifecycle: "accepting", activity: { reviewPresence, codexTasks: 0, transientWork: 0 } });
beforeEach(() => vi.clearAllMocks());
describe("explicit candidate service switching and rollback", () => {
  it("does not retire an incumbent with a live review", async () => {
    mocks.inspect.mockResolvedValue({ kind: "incompatible", status: status(1) });
    await expect(switchDesktopService(await fixture())).rejects.toThrow("active reviews");
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.ready).not.toHaveBeenCalled(); expect(mocks.release).toHaveBeenCalled();
  });
  it("backs up exact recovery before starting the selected service under the same lease", async () => {
    const options = await fixture(); const snapshot = JSON.stringify({ payload: { schemaVersion: 3 } });
    await writeFile(join(options.paths.recoveryRoot, "draft.json"), snapshot);
    mocks.inspect.mockResolvedValue({ kind: "incompatible", status: status() });
    mocks.request.mockImplementation(async (_path, request) => {
      if (request.operation === "shutdown-if-idle") return { kind: "management", protocolVersion: 1, operation: "shutdown-if-idle", result: { status: "accepted" } };
      throw Object.assign(new Error("retired"), { code: "ENOENT" });
    });
    mocks.ready.mockImplementation(async (_paths, lease) => {
      expect(lease).toBe("test-lease"); expect(await readFile(join(options.backup, "draft.json"), "utf8")).toBe(snapshot);
    });
    await switchDesktopService(options);
    expect(mocks.ready).toHaveBeenCalledOnce(); expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("refuses rollback to a reader that cannot preserve a newer protected draft", async () => {
    const options = await fixture(); await writeFile(join(options.paths.recoveryRoot, "draft.json"), JSON.stringify({ payload: { schemaVersion: 99 } }));
    mocks.inspect.mockResolvedValue({ kind: "incompatible", status: status() });
    await expect(switchDesktopService(options)).rejects.toThrow("cannot read protected recovery");
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.ready).not.toHaveBeenCalled();
  });
});


it.skipIf(process.platform === "win32")("waits for endpoint disappearance after an acknowledged shutdown returns early EOF to a racing status probe", async () => {
  const options = await fixture();
  const actual = await vi.importActual<typeof import("../src/host/launch-control.js")>("../src/host/launch-control.js");
  const events: string[] = [];
  let retirementTimer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer(socket => {
    socket.setEncoding("utf8");
    socket.once("data", data => {
      const request = JSON.parse(String(data).trim()) as { operation: string };
      if (request.operation === "shutdown-if-idle") {
        events.push("shutdown-accepted");
        socket.end(JSON.stringify({ kind: "management", protocolVersion: 1, operation: "shutdown-if-idle", result: { status: "accepted" } }) + "\n");
      } else {
        events.push("status-ended-during-retirement");
        socket.end();
        retirementTimer ??= setTimeout(() => { server.close(() => { events.push("endpoint-retired"); }); }, 20);
      }
    });
  });
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(options.paths.socketPath, accept); });
  mocks.inspect.mockResolvedValue({ kind: "incompatible", status: status() });
  mocks.request.mockImplementation(actual.requestControl);
  mocks.ready.mockImplementation(async () => {
    expect(await lstat(options.paths.socketPath).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; })).toBe(false);
    events.push("candidate-ready");
  });
  try {
    await switchDesktopService(options);
    expect(events).toEqual(["shutdown-accepted", "status-ended-during-retirement", "endpoint-retired", "candidate-ready"]);
  } finally {
    clearTimeout(retirementTimer);
    await new Promise<void>(accept => { server.close(() => accept()); });
  }
});

it("does not tolerate early EOF while initially inspecting an unidentified incumbent", async () => {
  const actual = await vi.importActual<typeof import("../src/host/launch-control.js")>("../src/host/launch-control.js");
  mocks.inspect.mockRejectedValue(new actual.PlacekeeperControlProtocolError("early-close"));
  await expect(switchDesktopService(await fixture())).rejects.toThrow("early-close");
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.ready).not.toHaveBeenCalled();
});

it("does not treat repeated retirement EOF as proof that a surviving endpoint disappeared", async () => {
  const options = await fixture();
  await writeFile(options.paths.socketPath, "endpoint still owned");
  const actual = await vi.importActual<typeof import("../src/host/launch-control.js")>("../src/host/launch-control.js");
  mocks.inspect.mockResolvedValue({ kind: "incompatible", status: status() });
  mocks.request.mockImplementation(async (_path, request) => {
    if (request.operation === "shutdown-if-idle") return { kind: "management", protocolVersion: 1, operation: "shutdown-if-idle", result: { status: "accepted" } };
    throw new actual.PlacekeeperControlProtocolError("early-close");
  });
  const clock = vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1000).mockReturnValue(6001);
  try {
    await expect(switchDesktopService(options)).rejects.toMatchObject({ reason: "timeout" });
    expect(mocks.ready).not.toHaveBeenCalled();
    expect(await lstat(options.backup).then(() => true, () => false)).toBe(false);
    expect(await readFile(options.paths.socketPath, "utf8")).toBe("endpoint still owned");
  } finally { clock.mockRestore(); }
});

it("does not invent consent for a preparation-capable active service", async () => {
  mocks.inspect.mockResolvedValue({ kind: "incompatible", status: { ...status(1), upgradePreparationVersion: 1 } });
  await expect(switchDesktopService(await fixture())).rejects.toMatchObject({ reason: "preparation-required" });
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.ready).not.toHaveBeenCalled();
});
it("passes exact incumbent and candidate identities through consent preparation before idle shutdown", async () => {
  const options = await fixture(); const events: string[] = [];
  const incumbent = { ...status(1), upgradePreparationVersion: 1 };
  mocks.inspect.mockResolvedValue({ kind: "incompatible", status: incumbent });
  const prepare = vi.fn(async (installed: import("../src/host/control-protocol.js").DaemonManagementStatus, candidate: import("../src/host/upgrade-coordinator.js").PackagedBuildIdentity) => {
    expect(installed).toEqual(incumbent); expect(candidate.daemonIdentity).toBe("a".repeat(64));
    events.push("prepared");
    return { attemptId: "attempt", token: "token", candidate };
  });
  mocks.request.mockImplementation(async (_path, request) => {
    if (request.operation === "shutdown-if-idle") { events.push("shutdown"); return { kind: "management", protocolVersion: 1, operation: "shutdown-if-idle", result: { status: "accepted" } }; }
    throw Object.assign(new Error("retired"), { code: "ENOENT" });
  });
  mocks.ready.mockImplementation(async () => { events.push("ready"); });
  await switchDesktopService({ ...options, prepare });
  expect(events).toEqual(["prepared", "shutdown", "ready"]); expect(prepare).toHaveBeenCalledOnce();
});
it("keeps the installed service when the user refuses preparation", async () => {
  mocks.inspect.mockResolvedValue({ kind: "incompatible", status: { ...status(1), upgradePreparationVersion: 1 } });
  await expect(switchDesktopService({ ...await fixture(), prepare: async () => { throw new Error("User declined"); } })).rejects.toThrow("User declined");
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.ready).not.toHaveBeenCalled();
});
it("explains the actual manual legacy save, close and end-task actions", async () => {
  mocks.inspect.mockResolvedValue({ kind: "incompatible", status: status(1) });
  await expect(switchDesktopService(await fixture())).rejects.toMatchObject({ reason: "review-presence", recoveryAction: expect.stringMatching(/Save PDFs and drafts.*browser\/editor tabs.*end bound Codex tasks/u) });
  expect(mocks.request).not.toHaveBeenCalled();
});
it("refuses replacement if drain finishes a recovery format the candidate cannot read", async () => {
  const options = await fixture();
  mocks.inspect.mockResolvedValue({ kind: "incompatible", status: status() });
  mocks.request.mockImplementation(async (_path, request) => {
    if (request.operation === "shutdown-if-idle") {
      await writeFile(join(options.paths.recoveryRoot, "late.json"), JSON.stringify({ payload: { schemaVersion: 99 } }));
      return { kind: "management", protocolVersion: 1, operation: "shutdown-if-idle", result: { status: "accepted" } };
    }
    throw Object.assign(new Error("retired"), { code: "ENOENT" });
  });
  await expect(switchDesktopService(options)).rejects.toThrow("unsupported format while draining");
  expect(mocks.ready).not.toHaveBeenCalled();
  expect(await lstat(options.backup).then(() => true, () => false)).toBe(false);
});
