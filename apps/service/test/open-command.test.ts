import { lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseOpenArguments,
  runOpenCommand,
} from "../src/cli/open-command.js";
import {
  DaemonUpgradeRequiredError,
  inspectDaemonCompatibility,
  MANAGEMENT_PROTOCOL_VERSION,
  requestLaunch,
  requestControl,
  startLaunchControlServer,
  type LaunchControlServer,
} from "../src/host/launch-control.js";
import { DaemonLifecycleCoordinator } from "../src/host/daemon-lifecycle.js";
import { ProofreaderHost } from "../src/host/proofreader-host.js";

const roots: string[] = [];
const hosts: ProofreaderHost[] = [];
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
    expect(parseOpenArguments([
      "open", "--json", "--pdf", "/tmp/paper.pdf",
      "--source-root", "/tmp/source", "--recovery", "resume", "--surface", "vscode",
    ])).toEqual({
      pdfPath: "/tmp/paper.pdf",
      sourceRootPath: "/tmp/source",
      recovery: "resume",
      surface: "vscode",
    });
    expect(() => parseOpenArguments(["open", "--json", "--pdf", "relative.pdf"]))
      .toThrow("absolute");
    expect(() => parseOpenArguments(["open", "--json", "--pdf", "/a.pdf", "/b.pdf"]))
      .toThrow("one explicit PDF");
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

  it("prints a typed upgrade-required response for incompatible daemon protocols", async () => {
    const write = vi.fn();
    const code = await runOpenCommand(
      ["open", "--json", "--pdf", "/tmp/paper.pdf"],
      async () => { throw new DaemonUpgradeRequiredError("legacy"); },
      write,
    );

    expect(code).toBe(2);
    expect(JSON.parse(write.mock.calls[0]![0])).toEqual({
      ok: false,
      error: {
        kind: "upgrade-required",
        message: "PDF Proofreader is already running an incompatible service build. Existing reviews were preserved.",
        recoveryAction: "Close PDF Proofreader reviews and retry",
      },
    });
  });

  it("inspects management compatibility independently from launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-management-"));
    roots.push(root);
    const assets = join(root, "assets");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    const host = await ProofreaderHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets } });
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
    await expect(requestControl(socketPath, {
      kind: "management",
      protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
      operation: "shutdown-if-idle",
      candidateDaemonIdentity: daemonIdentity,
    })).resolves.toMatchObject({ result: { status: "refused" } });
    await expect(lstat(socketPath)).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it("flushes an idle shutdown acknowledgement before closing HTTP and removing the socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-shutdown-"));
    roots.push(root);
    const assets = join(root, "assets");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    const host = await ProofreaderHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets } });
    const socketPath = join(root, "control.sock");
    const daemonIdentity = "a".repeat(64);
    const control = await startLaunchControlServer(host, socketPath, { daemonIdentity });

    await expect(requestControl(socketPath, {
      kind: "management",
      protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
      operation: "shutdown-if-idle",
      candidateDaemonIdentity: "b".repeat(64),
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

  it("keeps the management socket until host shutdown has completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-shutdown-order-"));
    roots.push(root);
    const assets = join(root, "assets");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    const host = await ProofreaderHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets } });
    hosts.push(host);
    const releaseClose = Promise.withResolvers<void>();
    const close = vi.spyOn(host, "close").mockImplementation(() => releaseClose.promise);
    const socketPath = join(root, "control.sock");
    const control = await startLaunchControlServer(host, socketPath, { daemonIdentity: "a".repeat(64) });

    await expect(requestControl(socketPath, {
      kind: "management",
      protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
      operation: "shutdown-if-idle",
      candidateDaemonIdentity: "b".repeat(64),
    })).resolves.toMatchObject({ result: { status: "accepted" } });
    await expect(lstat(socketPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    releaseClose.resolve();
    await control.closed;
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    close.mockRestore();
  });

  it("refuses conditional shutdown with aggregate blockers and remains usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-shutdown-active-"));
    roots.push(root);
    const assets = join(root, "assets");
    const pdf = join(root, "paper.pdf");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await writeFile(pdf, "%PDF-1.7\nfixture\n%%EOF");
    const host = await ProofreaderHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets } });
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
      candidateDaemonIdentity: "b".repeat(64),
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
    ["legacy", `${JSON.stringify({ kind: "error", reason: "invalid-request" })}\n`, "legacy"],
    ["malformed", "not-json\n", "malformed"],
    ["early close", "", "early-close"],
  ] as const)("fails closed for a %s management responder", async (_label, response, reason) => {
    const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-uninspectable-"));
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
    const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-timeout-"));
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
    const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-oversized-"));
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
    const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-control-"));
    roots.push(root);
    const assets = join(root, "assets");
    const pdf = join(root, "paper.pdf");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await writeFile(pdf, "%PDF-1.7\nfixture\n%%EOF");
    const host = await ProofreaderHost.start({
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
    const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-lifecycle-control-"));
    roots.push(root);
    const assets = join(root, "assets");
    const pdf = join(root, "paper.pdf");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await writeFile(pdf, "%PDF-1.7\nfixture\n%%EOF");
    const host = await ProofreaderHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets } });
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
