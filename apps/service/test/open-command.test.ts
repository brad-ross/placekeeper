import { lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodePlacekeeperLink } from "../../../packages/core/src/placekeeper-link.js";

import {
  INSTALLED_SMOKE_DAEMON_FLAG,
  INSTALLED_SMOKE_HTTP_PORT_FLAG,
  pathsForDirectDaemonLaunch,
  parseOpenLinkArguments,
  parseOpenArguments,
  runOpenLinkCommand,
  runOpenCommand,
} from "../src/cli/open-command.js";
import {
  DaemonUpgradeRequiredError,
  inspectDaemonCompatibility,
  MANAGEMENT_PROTOCOL_VERSION,
  managementShutdownResult,
  requestLaunch,
  requestLinkOpen,
  requestLinkPreflight,
  requestControl,
  startLaunchControlServer,
  type LaunchControlServer,
} from "../src/host/launch-control.js";
import { DaemonLifecycleCoordinator } from "../src/host/daemon-lifecycle.js";
import { acquireLifecycleLock } from "../src/host/lifecycle-lock.js";
import { PlacekeeperHost } from "../src/host/placekeeper-host.js";
import { coordinateUpgrade } from "../src/host/upgrade-coordinator.js";
import {
  initialDaemonIsAbsent,
} from "../src/cli/daemon-command.js";
import { defaultDaemonPaths } from "../src/host/service-daemon.js";
import { PLACEKEEPER_HTTP_PORT } from "../src/server/http-server.js";
import { DraftSnapshotStore } from "../src/recovery/draft-snapshot.js";

const roots: string[] = [];
const hosts: PlacekeeperHost[] = [];
const controls: LaunchControlServer[] = [];
const responders: Server[] = [];
const responderSockets = new Set<import("node:net").Socket>();

afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.close()));
  for (const socket of responderSockets) socket.destroy();
  responderSockets.clear();
  await Promise.all(responders.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("open command", () => {
  it("pins the packaged daemon to the exported fixed browser origin", () => {
    expect(defaultDaemonPaths().httpPort).toBe(PLACEKEEPER_HTTP_PORT);
  });

  it("isolates only the installed lifecycle smoke from the fixed browser origin", () => {
    expect(pathsForDirectDaemonLaunch([])?.httpPort).toBe(PLACEKEEPER_HTTP_PORT);
    expect(pathsForDirectDaemonLaunch([
      INSTALLED_SMOKE_DAEMON_FLAG,
      INSTALLED_SMOKE_HTTP_PORT_FLAG,
      "43210",
    ])?.httpPort).toBe(43_210);
    expect(() => pathsForDirectDaemonLaunch([
      INSTALLED_SMOKE_DAEMON_FLAG,
      INSTALLED_SMOKE_HTTP_PORT_FLAG,
      "0",
    ])).toThrow("invalid");
    expect(pathsForDirectDaemonLaunch([INSTALLED_SMOKE_DAEMON_FLAG, "extra"])).toBeUndefined();
    expect(pathsForDirectDaemonLaunch(["ensure-ready"])).toBeUndefined();
  });

  it("parses bounded app-link preflight and confirmed-open commands", () => {
    const link = "placekeeper:///tmp/Paper%20One.pdf#v=1&page=12";
    const recoveryOffer = {
      id: "opaque_recovery_offer_1234",
      expiresAt: "2026-08-21T20:00:00.000Z",
    };
    expect(parseOpenLinkArguments([
      "open-link", "--json", "--preflight", "--link", link,
    ])).toEqual({ operation: "preflight", link });
    expect(parseOpenLinkArguments([
      "open-link", "--json", "--confirmed", "--recovery", "resume",
      "--recovery-offer-id", recoveryOffer.id,
      "--recovery-offer-expires-at", recoveryOffer.expiresAt,
      "--recovery-operation-id", "operation_identifier_1234",
      "--surface", "codex", "--link", link,
    ])).toEqual({
      operation: "open",
      link,
      confirmed: true,
      recovery: "resume",
      recoveryOffer,
      recoveryOperationId: "operation_identifier_1234",
      surface: "codex",
    });
    expect(() => parseOpenLinkArguments(["open-link", "--json", "--link", link, "extra"]))
      .toThrow("one Placekeeper link");
    expect(() => parseOpenLinkArguments([
      "open-link", "--json", "--preflight", "--confirmed", "--link", link,
    ])).toThrow("preflight");
    expect(() => parseOpenLinkArguments([
      "open-link", "--json", "--recovery", "resume", "--link", link,
    ])).toThrow("offer and operation");
  });

  it("prints one bounded structured app-link response", async () => {
    const link = "placekeeper:///tmp/Paper%20One.pdf#v=1&page=12";
    const write = vi.fn();
    await expect(runOpenLinkCommand(
      ["open-link", "--json", "--preflight", "--link", link],
      async (request) => ({
        ok: true,
        kind: "link-preflight",
        path: request.link,
        confirmationRequired: true,
      }),
      write,
    )).resolves.toBe(0);
    expect(write).toHaveBeenCalledOnce();
    expect(JSON.parse(write.mock.calls[0]![0])).toMatchObject({
      ok: true,
      kind: "link-preflight",
      confirmationRequired: true,
    });
    expect(write.mock.calls[0]![0]).not.toMatch(/(?:cap=|taskSessionId|bindProof)/u);
  });

  it("atomically drains accepted work and cancels when new activity wins the final recheck", async () => {
    const drainStarted = Promise.withResolvers<void>();
    const releaseDrain = Promise.withResolvers<void>();
    let reviewPresence = 0;
    let transientWork = 1;
    const lifecycle = new DaemonLifecycleCoordinator({
      activity: () => ({ reviewPresence, codexTasks: 0, transientWork }),
      drain: async () => {
        drainStarted.resolve();
        await releaseDrain.promise;
        transientWork = 0;
      },
    });

    const shutdown = lifecycle.shutdownIfIdle();
    await drainStarted.promise;
    expect(lifecycle.status().lifecycle).toBe("draining");
    const activity = lifecycle.enterActivity();
    expect(activity).toBeDefined();
    reviewPresence = 1;
    activity!.complete();
    releaseDrain.resolve();

    await expect(shutdown).resolves.toMatchObject({ status: "refused" });
    expect(lifecycle.status()).toMatchObject({
      lifecycle: "accepting",
      activity: { reviewPresence: 1 },
    });
  });

  it("rejects activity after shutdown commit", async () => {
    const lifecycle = new DaemonLifecycleCoordinator({
      activity: () => ({ reviewPresence: 0, codexTasks: 0, transientWork: 0 }),
      drain: async () => {},
    });
    await expect(lifecycle.shutdownIfIdle()).resolves.toEqual({ status: "accepted" });
    expect(lifecycle.status().lifecycle).toBe("shutdown-committed");
    expect(lifecycle.enterActivity()).toBeUndefined();
  });

  it("accepts one explicit absolute PDF plus optional approved scope and fork", () => {
    const recoveryOffer = {
      id: "opaque_recovery_offer_1234",
      expiresAt: "2026-08-21T20:00:00.000Z",
    };
    expect(parseOpenArguments([
      "open", "--json", "--pdf", "/tmp/paper.pdf",
      "--source-root", "/tmp/source", "--recovery", "resume", "--surface", "vscode",
      "--recovery-offer-id", recoveryOffer.id,
      "--recovery-offer-expires-at", recoveryOffer.expiresAt,
      "--recovery-operation-id", "operation_identifier_1234",
    ])).toEqual({
      pdfPath: "/tmp/paper.pdf",
      sourceRootPath: "/tmp/source",
      recovery: "resume",
      recoveryOffer,
      recoveryOperationId: "operation_identifier_1234",
      surface: "vscode",
    });
    expect(() => parseOpenArguments(["open", "--json", "--pdf", "relative.pdf"]))
      .toThrow("absolute");
    expect(() => parseOpenArguments(["open", "--json", "--pdf", "/a.pdf", "/b.pdf"]))
      .toThrow("one explicit PDF");
    expect(() => parseOpenArguments([
      "open", "--json", "--pdf", "/a.pdf", "--recovery", "resume",
    ])).toThrow("offer and operation");
  });

  it("prints exactly one structured response and never logs a secret on errors", async () => {
    const write = vi.fn();
    const response = await runOpenCommand(
      ["open", "--json", "--pdf", "/missing.pdf"],
      async () => ({
        ok: false,
        error: {
          kind: "input-unavailable",
          message: "Unavailable",
          recoveryAction: "Choose one readable local PDF",
        },
      }),
      write,
    );
    expect(response).toBe(2);
    expect(write).toHaveBeenCalledOnce();
    expect(JSON.parse(write.mock.calls[0]![0])).toEqual({
      ok: false,
      error: {
        kind: "input-unavailable",
        message: "Unavailable",
        recoveryAction: "Choose one readable local PDF",
      },
    });
    expect(write.mock.calls[0]![0]).not.toContain("cap=");
  });

  it.each([
    ["review-presence", "Close Placekeeper tabs or windows, then retry"],
    ["codex-task", "End the bound Codex task or wait for its lease, then retry"],
    ["transient-busy", "Wait a moment, then retry"],
  ] as const)("presents bounded state-specific upgrade guidance for %s", async (reason, recoveryAction) => {
    const write = vi.fn();
    await runOpenCommand(
      ["open", "--json", "--pdf", "/tmp/paper.pdf"],
      async () => { throw new DaemonUpgradeRequiredError(reason); },
      write,
    );
    const response = JSON.parse(write.mock.calls[0]![0]) as {
      error: { kind: string; message: string; recoveryAction: string };
    };
    expect(response.error).toMatchObject({ kind: "upgrade-required", recoveryAction });
    expect(response.error.message.length).toBeLessThanOrEqual(240);
    expect(response.error.recoveryAction.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(response)).not.toMatch(/(?:cap=|taskSessionId|pdfPath|bindProof)/u);
  });

  it("serializes lifecycle owners and permits an explicit child handoff token", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-lock-"));
    roots.push(root);
    const lockPath = join(root, "lifecycle.lock");
    const first = await acquireLifecycleLock(lockPath, { timeoutMs: 100 });
    const waiting = acquireLifecycleLock(lockPath, { timeoutMs: 1_000, pollMs: 5 });
    let settled = false;
    void waiting.then(() => { settled = true; });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    expect(settled).toBe(false);

    const borrowed = await acquireLifecycleLock(lockPath, {
      timeoutMs: 100,
      inheritedToken: first.token,
    });
    expect(borrowed.borrowed).toBe(true);
    await borrowed.release();
    await first.release();
    const second = await waiting;
    expect(second.borrowed).toBe(false);
    await second.release();
  });

  it("does not let a paused stale reclaimer remove a later lifecycle owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-lock-race-"));
    roots.push(root);
    const lockPath = join(root, "lifecycle.lock");
    const staleToken = "stale_owner_token_00000000000000";
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, `owner-${staleToken}.json`),
      `${JSON.stringify({ version: 1, pid: 2_147_483_647, token: staleToken })}\n`,
    );
    const staleMarkerRemoved = Promise.withResolvers<void>();
    const resumeFirstReclaimer = Promise.withResolvers<void>();
    const artificialNow = () => Date.now() + 2_000;
    const firstContender = acquireLifecycleLock(lockPath, {
      timeoutMs: 2_000,
      pollMs: 5,
      now: artificialNow,
      afterStaleMarkerRemoved: async () => {
        staleMarkerRemoved.resolve();
        await resumeFirstReclaimer.promise;
      },
    });
    await staleMarkerRemoved.promise;

    const laterOwner = await acquireLifecycleLock(lockPath, {
      timeoutMs: 1_000,
      pollMs: 5,
      now: artificialNow,
    });
    let firstSettled = false;
    void firstContender.then(() => { firstSettled = true; });
    resumeFirstReclaimer.resolve();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    expect(firstSettled).toBe(false);

    await laterOwner.release();
    const firstOwner = await firstContender;
    await firstOwner.release();
  });

  it("fails closed on an initial reset and validates the complete shutdown response", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-management-parse-"));
    roots.push(root);
    const reset = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    const absent = Object.assign(new Error("absent"), { code: "ENOENT" });
    await expect(initialDaemonIsAbsent(reset, join(root, "control.sock"))).resolves.toBe(false);
    await expect(initialDaemonIsAbsent(absent, join(root, "control.sock"))).resolves.toBe(true);

    expect(managementShutdownResult({
      kind: "management",
      protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
      operation: "shutdown-if-idle",
      result: { status: "accepted" },
    })).toEqual({ status: "accepted" });
    expect(managementShutdownResult({
      kind: "management",
      protocolVersion: MANAGEMENT_PROTOCOL_VERSION + 1,
      operation: "shutdown-if-idle",
      result: { status: "accepted" },
    })).toBeUndefined();
    expect(managementShutdownResult({
      kind: "management",
      protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
      operation: "shutdown-if-idle",
      result: { status: "refused", activity: { reviewPresence: -1, codexTasks: 0, transientWork: 0 } },
    })).toBeUndefined();
  });

  it("does not accept an inherited web-assets override in default packaged paths", () => {
    const previous = process.env.PLACEKEEPER_WEB_ASSETS;
    process.env.PLACEKEEPER_WEB_ASSETS = "/tmp/untrusted-placekeeper-assets";
    try {
      expect(defaultDaemonPaths().webAssetsRoot).not.toBe("/tmp/untrusted-placekeeper-assets");
    } finally {
      if (previous === undefined) delete process.env.PLACEKEEPER_WEB_ASSETS;
      else process.env.PLACEKEEPER_WEB_ASSETS = previous;
    }
  });

  it("makes an identical complete artifact with an exact daemon a no-op without stopping it", async () => {
    const inspect = vi.fn(async () => ({
      kind: "exact" as const,
      status: {
        protocolVersion: 1 as const,
        daemonIdentity: "a".repeat(64),
        lifecycle: "accepting" as const,
        activity: { reviewPresence: 0, codexTasks: 0, transientWork: 0 },
      },
    }));
    const shutdown = vi.fn();
    const replaceAndReady = vi.fn();
    await expect(coordinateUpgrade({
      candidate: { daemonIdentity: "a".repeat(64), installArtifactIdentity: "b".repeat(64) },
      installed: { daemonIdentity: "a".repeat(64), installArtifactIdentity: "b".repeat(64) },
      inspect,
      shutdown,
      waitForRetirement: vi.fn(),
      replaceAndReady,
    })).resolves.toEqual({ status: "noop" });
    expect(inspect).toHaveBeenCalledOnce();
    expect(shutdown).not.toHaveBeenCalled();
    expect(replaceAndReady).not.toHaveBeenCalled();
  });

  it("retires an idle stale daemon without moving an already identical app", async () => {
    const shutdown = vi.fn(async () => ({ status: "accepted" as const }));
    const waitForRetirement = vi.fn(async () => {});
    const replaceAndReady = vi.fn();
    await expect(coordinateUpgrade({
      candidate: { daemonIdentity: "b".repeat(64), installArtifactIdentity: "c".repeat(64) },
      installed: { daemonIdentity: "b".repeat(64), installArtifactIdentity: "c".repeat(64) },
      inspect: async () => ({
        kind: "incompatible",
        status: {
          protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
          daemonIdentity: "a".repeat(64),
          lifecycle: "accepting",
          activity: { reviewPresence: 0, codexTasks: 0, transientWork: 0 },
        },
      }),
      shutdown,
      waitForRetirement,
      replaceAndReady,
    })).resolves.toEqual({ status: "noop" });
    expect(shutdown).toHaveBeenCalledOnce();
    expect(waitForRetirement).toHaveBeenCalledOnce();
    expect(replaceAndReady).not.toHaveBeenCalled();
  });

  it("defers active upgrades and drains idle daemons before replacement", async () => {
    const candidate = { daemonIdentity: "b".repeat(64), installArtifactIdentity: "c".repeat(64) };
    const replaceAndReady = vi.fn(async () => {});
    await expect(coordinateUpgrade({
      candidate,
      installed: { daemonIdentity: "a".repeat(64), installArtifactIdentity: "a".repeat(64) },
      inspect: async () => ({
        kind: "incompatible",
        status: {
          protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
          daemonIdentity: "a".repeat(64),
          lifecycle: "accepting",
          activity: { reviewPresence: 1, codexTasks: 0, transientWork: 0 },
        },
      }),
      shutdown: vi.fn(),
      waitForRetirement: vi.fn(),
      replaceAndReady,
    })).rejects.toMatchObject({ reason: "review-presence" });
    expect(replaceAndReady).not.toHaveBeenCalled();

    const order: string[] = [];
    await expect(coordinateUpgrade({
      candidate,
      installed: { daemonIdentity: "a".repeat(64), installArtifactIdentity: "a".repeat(64) },
      inspect: async () => ({
        kind: "incompatible",
        status: {
          protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
          daemonIdentity: "a".repeat(64),
          lifecycle: "accepting",
          activity: { reviewPresence: 0, codexTasks: 0, transientWork: 0 },
        },
      }),
      shutdown: async () => { order.push("shutdown"); return { status: "accepted" }; },
      waitForRetirement: async () => { order.push("retired"); },
      replaceAndReady: async () => { order.push("replace-ready"); },
    })).resolves.toEqual({ status: "installed" });
    expect(order).toEqual(["shutdown", "retired", "replace-ready"]);
  });

  it.each(["malformed", "timeout"] as const)(
    "defers a %s daemon before replacement",
    async (reason) => {
      const replaceAndReady = vi.fn();
      await expect(coordinateUpgrade({
        candidate: { daemonIdentity: "b".repeat(64), installArtifactIdentity: "c".repeat(64) },
        installed: { daemonIdentity: "a".repeat(64), installArtifactIdentity: "a".repeat(64) },
        inspect: async () => ({ kind: "uninspectable", reason }),
        shutdown: vi.fn(),
        waitForRetirement: vi.fn(),
        replaceAndReady,
      })).rejects.toMatchObject({ reason });
      expect(replaceAndReady).not.toHaveBeenCalled();
    },
  );

  it("retries transient durable work before accepting idle shutdown", async () => {
    let attempts = 0;
    await expect(coordinateUpgrade({
      candidate: { daemonIdentity: "b".repeat(64), installArtifactIdentity: "c".repeat(64) },
      installed: { daemonIdentity: "a".repeat(64), installArtifactIdentity: "a".repeat(64) },
      inspect: async () => ({
        kind: "incompatible",
        status: {
          protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
          daemonIdentity: "a".repeat(64),
          lifecycle: "accepting",
          activity: { reviewPresence: 0, codexTasks: 0, transientWork: 1 },
        },
      }),
      shutdown: async () => ++attempts < 3
        ? { status: "refused", activity: { reviewPresence: 0, codexTasks: 0, transientWork: 1 } }
        : { status: "accepted" },
      retryDelay: async () => {},
      waitForRetirement: async () => {},
      replaceAndReady: async () => {},
    })).resolves.toEqual({ status: "installed" });
    expect(attempts).toBe(3);
  });

  it("inspects management compatibility independently from launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-management-"));
    roots.push(root);
    const assets = join(root, "assets");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets } });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    const daemonIdentity = "a".repeat(64);
    controls.push(await startLaunchControlServer(host, socketPath, {
      protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
      daemonIdentity,
      lifecycle: "accepting",
      activity: { reviewPresence: 0, codexTasks: 0, transientWork: 0 },
    }));

    await expect(inspectDaemonCompatibility(socketPath, daemonIdentity)).resolves.toMatchObject({
      kind: "exact",
      status: {
        protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
        daemonIdentity,
        lifecycle: "accepting",
        activity: { reviewPresence: 0, codexTasks: 0, transientWork: 0 },
      },
    });
    await expect(inspectDaemonCompatibility(socketPath, "b".repeat(64))).resolves.toMatchObject({
      kind: "incompatible",
      status: { daemonIdentity },
    });
    await expect(lstat(socketPath)).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it("carries bounded link preflight and confirmed opening over the private control socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-link-control-"));
    roots.push(root);
    const assets = join(root, "assets");
    const pdf = join(root, "control-link.pdf");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await writeFile(pdf, "%PDF-1.7\nfixture\n%%EOF");
    const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets } });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    controls.push(await startLaunchControlServer(host, socketPath, { daemonIdentity: "a".repeat(64) }));
    const link = encodePlacekeeperLink({
      path: pdf,
      location: {
        kind: "destination",
        page: 12,
        mode: "fit-rectangle",
        params: [100, 200, 500, 700],
      },
    });

    await expect(requestLinkPreflight(socketPath, link)).resolves.toMatchObject({
      ok: true,
      kind: "link-preflight",
      path: pdf,
      confirmationRequired: true,
    });
    await expect(requestLinkOpen(socketPath, { link })).resolves.toEqual({
      ok: true,
      kind: "confirmation-required",
      path: pdf,
    });
    const opened = await requestLinkOpen(socketPath, {
      link,
      confirmed: true,
      surface: "codex",
    });
    expect(opened).toMatchObject({
      ok: true,
      kind: "opened",
      bindProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    if (!opened.ok || opened.kind !== "opened") throw new Error("Expected an opened exact link");
    const capability = new URL(opened.url).hash.slice("#cap=".length);
    expect(host.broker.exchangeBootstrapForHttp(opened.sessionId, capability)?.view?.locationFragment)
      .toBe("v=2&page=12&mode=fit-rectangle&params=100,200,500,700");
  });

  it("flushes an idle shutdown acknowledgement before closing HTTP and removing the socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-shutdown-"));
    roots.push(root);
    const assets = join(root, "assets");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets } });
    const socketPath = join(root, "control.sock");
    const daemonIdentity = "a".repeat(64);
    const control = await startLaunchControlServer(host, socketPath, { daemonIdentity });

    await expect(requestControl(socketPath, {
      kind: "management",
      protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
      operation: "shutdown-if-idle",
    })).resolves.toEqual({
      kind: "management",
      protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
      operation: "shutdown-if-idle",
      result: { status: "accepted" },
    });
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fetch(host.server.origin)).rejects.toThrow();
    await control.close();
  });

  it("retires the control socket even when clean recovery garbage collection fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pfs-cleanup-"));
    roots.push(root);
    const assets = join(root, "assets");
    const pdf = join(root, "clean.pdf");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await writeFile(pdf, "%PDF-1.7\nclean\n%%EOF");
    const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets } });
    const opened = await host.broker.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected a new review");
    host.broker.credentials.revokeSession(opened.launch.sessionId);
    const remove = vi.spyOn(DraftSnapshotStore.prototype, "remove").mockRejectedValueOnce(new Error("disk unavailable"));
    const socketPath = join(root, "c.sock");
    const control = await startLaunchControlServer(host, socketPath, { daemonIdentity: "a".repeat(64) });

    await expect(requestControl(socketPath, {
      kind: "management",
      protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
      operation: "shutdown-if-idle",
    })).resolves.toMatchObject({ result: { status: "accepted" } });
    await control.closed;
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    remove.mockRestore();
  });

  it("keeps the management socket until host shutdown has completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-shutdown-order-"));
    roots.push(root);
    const assets = join(root, "assets");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets } });
    hosts.push(host);
    const releaseClose = Promise.withResolvers<void>();
    const close = vi.spyOn(host, "close").mockImplementation(() => releaseClose.promise);
    const socketPath = join(root, "control.sock");
    const control = await startLaunchControlServer(host, socketPath, { daemonIdentity: "a".repeat(64) });

    await expect(requestControl(socketPath, {
      kind: "management",
      protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
      operation: "shutdown-if-idle",
    })).resolves.toMatchObject({ result: { status: "accepted" } });
    await expect(lstat(socketPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    releaseClose.resolve();
    await control.closed;
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    close.mockRestore();
  });

  it("refuses conditional shutdown with aggregate blockers and remains usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-shutdown-active-"));
    roots.push(root);
    const assets = join(root, "assets");
    const pdf = join(root, "paper.pdf");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await writeFile(pdf, "%PDF-1.7\nfixture\n%%EOF");
    const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets } });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    const daemonIdentity = "a".repeat(64);
    controls.push(await startLaunchControlServer(host, socketPath, { daemonIdentity }));
    const opened = await requestLaunch(socketPath, { pdfPath: pdf });
    expect(opened).toMatchObject({ ok: true, kind: "opened" });
    await expect(inspectDaemonCompatibility(socketPath, daemonIdentity)).resolves.toMatchObject({
      kind: "exact",
      status: {
        lifecycle: "accepting",
        activity: { reviewPresence: 1, codexTasks: 0, transientWork: 0 },
      },
    });

    await expect(requestControl(socketPath, {
      kind: "management",
      protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
      operation: "shutdown-if-idle",
    })).resolves.toMatchObject({
      kind: "management",
      operation: "shutdown-if-idle",
      result: {
        status: "refused",
        activity: { reviewPresence: 1, codexTasks: 0 },
      },
    });
    await expect(requestLaunch(socketPath, { pdfPath: pdf })).resolves.toMatchObject({
      ok: true,
      kind: "focused",
    });
  });

  it.each([
    ["invalid request", `${JSON.stringify({ kind: "error", reason: "invalid-request" })}\n`, "malformed"],
    ["malformed", "not-json\n", "malformed"],
    ["early close", "", "early-close"],
  ] as const)("fails closed for a %s management responder", async (_label, response, reason) => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-uninspectable-"));
    roots.push(root);
    const socketPath = join(root, "control.sock");
    const server = createServer((socket) => {
      responderSockets.add(socket);
      socket.once("close", () => responderSockets.delete(socket));
      socket.end(response);
    });
    responders.push(server);
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolveListen);
    });

    await expect(inspectDaemonCompatibility(socketPath, "a".repeat(64), { timeoutMs: 50 }))
      .resolves.toEqual({ kind: "uninspectable", reason });
  });

  it("fails closed when the management responder times out", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-timeout-"));
    roots.push(root);
    const socketPath = join(root, "control.sock");
    const server = createServer((socket) => {
      responderSockets.add(socket);
      socket.once("close", () => responderSockets.delete(socket));
    });
    responders.push(server);
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolveListen);
    });

    await expect(inspectDaemonCompatibility(socketPath, "a".repeat(64), { timeoutMs: 20 }))
      .resolves.toEqual({ kind: "uninspectable", reason: "timeout" });
  });

  it("fails closed when the management responder exceeds its byte budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-oversized-"));
    roots.push(root);
    const socketPath = join(root, "control.sock");
    const server = createServer((socket) => {
      responderSockets.add(socket);
      socket.once("close", () => responderSockets.delete(socket));
      socket.end("x".repeat(256));
    });
    responders.push(server);
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolveListen);
    });

    await expect(inspectDaemonCompatibility(socketPath, "a".repeat(64), {
      timeoutMs: 50,
      maxMessageBytes: 64,
    })).resolves.toEqual({ kind: "uninspectable", reason: "oversized" });
  });

  it("uses a private per-user socket to reach the same persistent broker", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-control-"));
    roots.push(root);
    const assets = join(root, "assets");
    const pdf = join(root, "paper.pdf");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await writeFile(pdf, "%PDF-1.7\nfixture\n%%EOF");
    const host = await PlacekeeperHost.start({
      recoveryRoot: join(root, "recovery"),
      webAssets: { root: assets },
    });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    const control = await startLaunchControlServer(host, socketPath);
    controls.push(control);

    expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
    const opened = await requestLaunch(socketPath, { pdfPath: pdf });
    const focused = await requestLaunch(socketPath, { pdfPath: pdf });
    expect(opened).toMatchObject({ ok: true, kind: "opened" });
    expect(focused).toMatchObject({ ok: true, kind: "focused" });
    if (
      opened.ok && opened.kind !== "recovery-offered" &&
      focused.ok && focused.kind !== "recovery-offered"
    ) expect(focused.sessionId).toBe(opened.sessionId);
  });

  it("carries hook claims, prompt refresh, and task revocation over the same private daemon", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-lifecycle-control-"));
    roots.push(root);
    const assets = join(root, "assets");
    const pdf = join(root, "paper.pdf");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await writeFile(pdf, "%PDF-1.7\nfixture\n%%EOF");
    const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets } });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    const control = await startLaunchControlServer(host, socketPath);
    controls.push(control);

    const opened = await requestLaunch(socketPath, { pdfPath: pdf, surface: "codex" });
    if (!opened.ok || opened.kind === "recovery-offered" || opened.bindProof === undefined) {
      throw new Error("Expected a bindable launch");
    }
    expect(await requestControl(socketPath, {
      kind: "claim-binding",
      taskSessionId: "task-a",
      reviewSessionId: opened.sessionId,
      documentGeneration: opened.documentGeneration,
      bindProof: opened.bindProof,
    })).toMatchObject({ kind: "binding", result: { status: "pending" } });
    const capability = new URL(opened.url).hash.slice("#cap=".length);
    expect(host.broker.exchangeBootstrap(opened.sessionId, capability)).toBeTypeOf("string");
    expect(host.broker.taskBindings.bindingForTask("task-a")).toMatchObject({ reviewSessionId: opened.sessionId });

    expect(await requestControl(socketPath, { kind: "refresh-context", taskSessionId: "task-a" }))
      .toMatchObject({ kind: "context" });
    expect(await requestControl(socketPath, { kind: "revoke-task", taskSessionId: "task-a" }))
      .toEqual({ kind: "revoked" });
    expect(host.broker.taskBindings.bindingForTask("task-a")).toBeUndefined();
  });
});
