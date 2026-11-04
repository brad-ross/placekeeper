import { describe, expect, it, vi } from "vitest";
import { DaemonLifecycleCoordinator } from "../src/host/daemon-lifecycle.js";
import { UpgradePreparationCoordinator } from "../src/host/upgrade-preparation.js";

const candidate = { daemonIdentity: "b".repeat(64), installArtifactIdentity: "c".repeat(64) };
function fixture(timeoutMs = 60_000) {
  const lifecycle = new DaemonLifecycleCoordinator({ activity: () => ({ reviewPresence: 0, codexTasks: 0, transientWork: 0 }), drain: async () => {} });
  const preparation = new UpgradePreparationCoordinator(lifecycle, timeoutMs);
  const participant = preparation.registerParticipant({ id: "electron:helper", revision: "revision-1" });
  const preview = preparation.preview("a".repeat(64), candidate);
  return { lifecycle, preparation, participant, preview, credentials: { attemptId: preview.attemptId, token: preview.token, candidate } };
}
describe("consent-bound upgrade preparation", () => {
  it("does not freeze admission until informed consent and rejects declined consent", () => {
    const f = fixture();
    expect(f.lifecycle.enterActivity()).toBeDefined();
    expect(f.preparation.begin(f.credentials, false).phase).toBe("canceled");
    expect(f.lifecycle.enterActivity()).toBeDefined();
  });
  it("freezes new admission but permits existing settlement", () => {
    const f = fixture(); f.preparation.begin(f.credentials, true);
    expect(f.lifecycle.enterActivity()).toBeUndefined();
    expect(f.lifecycle.enterActivity({ settlement: true })).toBeDefined();
    f.preparation.cancel(f.credentials);
    expect(f.lifecycle.enterActivity()).toBeDefined();
  });
  it("requires durable exact revision acknowledgement before committing closure", () => {
    const f = fixture(); f.preparation.begin(f.credentials, true);
    expect(() => f.preparation.commit(f.credentials)).toThrow("acknowledgements");
    f.preparation.acknowledge(f.participant, f.credentials, { revision: "revision-1", reviewRevisionDurable: true, protectedDraftDurable: true, pdfSaveSettled: true });
    expect(f.preparation.commit(f.credentials).phase).toBe("committed");
    expect(f.preparation.poll(f.participant)?.phase).toBe("committed");
    f.preparation.cancel(f.credentials);
  });
  it.each(["stale", "failed"])("cancels %s acknowledgement and restores admission", mode => {
    const f = fixture(); f.preparation.begin(f.credentials, true);
    f.preparation.acknowledge(f.participant, f.credentials, { revision: mode === "stale" ? "revision-0" : "revision-1", reviewRevisionDurable: true, protectedDraftDurable: mode !== "failed", pdfSaveSettled: true });
    expect(f.preparation.status(f.credentials).phase).toBe("canceled");
    expect(f.lifecycle.enterActivity()).toBeDefined();
  });
  it("invalidates consent when participants or revisions change", () => {
    const f = fixture(); f.preparation.begin(f.credentials, true);
    f.preparation.registerParticipant({ id: "chrome:tab", revision: "revision-1" });
    expect(f.preparation.status(f.credentials).phase).toBe("canceled");
    expect(f.lifecycle.enterActivity()).toBeDefined();
  });
  it("rejects copied token for a different candidate and serializes installers", () => {
    const f = fixture(); f.preparation.begin(f.credentials, true);
    expect(() => f.preparation.preview("a".repeat(64), candidate)).toThrow("in progress");
    expect(() => f.preparation.commit({ ...f.credentials, candidate: { ...candidate, installArtifactIdentity: "d".repeat(64) } })).toThrow("credentials");
    f.preparation.cancel(f.credentials);
  });
  it("automatically restores admission after installer disappearance", () => {
    vi.useFakeTimers();
    try {
      const f = fixture(100); f.preparation.begin(f.credentials, true);
      vi.advanceTimersByTime(101);
      expect(f.preparation.status(f.credentials).phase).toBe("canceled");
      expect(f.lifecycle.enterActivity()).toBeDefined();
      expect(() => f.preparation.commit(f.credentials)).toThrow();
    } finally { vi.useRealTimers(); }
  });
});

it("does not disclose installer authority to review participants", () => {
  const f = fixture(); f.preparation.begin(f.credentials, true);
  expect(f.preparation.poll(f.participant)).not.toHaveProperty("token");
  const { token: _token, ...participantAttempt } = f.credentials;
  expect(f.preparation.acknowledge(f.participant, participantAttempt, { revision: "revision-1", reviewRevisionDurable: true, protectedDraftDurable: true, pdfSaveSettled: true })).not.toHaveProperty("token");
  f.preparation.cancel(f.credentials);
});
it("accepts a final trusted settlement revision but rejects its stale acknowledgement", () => {
  const f = fixture(); f.preparation.begin(f.credentials, true);
  f.preparation.updateParticipant(f.participant, "revision-2", { settlement: true });
  expect(f.preparation.status(f.credentials).participants[0]?.revision).toBe("revision-2");
  f.preparation.acknowledge(f.participant, f.credentials, { revision: "revision-1", reviewRevisionDurable: true, protectedDraftDurable: true, pdfSaveSettled: true });
  expect(f.preparation.status(f.credentials).phase).toBe("canceled");
});
it("does not turn a stale consent preview into admission freeze", () => {
  const f = fixture(); f.preparation.updateParticipant(f.participant, "revision-2");
  expect(() => f.preparation.begin(f.credentials, true)).toThrow("awaiting consent");
  expect(f.lifecycle.admissionAllowed()).toBe(true);
});
it("preparation wins the boundary against an already draining idle shutdown", async () => {
  const drain = Promise.withResolvers<void>();
  const lifecycle = new DaemonLifecycleCoordinator({ activity: () => ({ reviewPresence: 0, codexTasks: 0, transientWork: 0 }), drain: () => drain.promise });
  const shutdown = lifecycle.shutdownIfIdle();
  lifecycle.freezeAdmission(); drain.resolve();
  expect(await shutdown).toMatchObject({ status: "refused" });
  expect(lifecycle.admissionAllowed()).toBe(false);
  lifecycle.resumeAdmission();
});
it("restores a usable lifecycle after a drain write fails", async () => {
  const lifecycle = new DaemonLifecycleCoordinator({ activity: () => ({ reviewPresence: 0, codexTasks: 0, transientWork: 0 }), drain: async () => { throw new Error("disk full"); } });
  await expect(lifecycle.shutdownIfIdle()).rejects.toThrow("disk full");
  expect(lifecycle.status().lifecycle).toBe("accepting");
  expect(lifecycle.enterActivity()).toBeDefined();
});

it("enforces the preparation contract over the live private control socket and HTTP boundary", async () => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { PlacekeeperHost } = await import("../src/host/placekeeper-host.js");
  const { startLaunchControlServer, requestControl, inspectDaemonCompatibility } = await import("../src/host/launch-control.js");
  const root = await mkdtemp(join(tmpdir(), "pk-preparation-"));
  const assets = join(root, "assets"); await mkdir(assets);
  const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets }, port: 0 });
  const socketPath = join(root, "control.sock"); const identity = "a".repeat(64);
  const control = await startLaunchControlServer(host, socketPath, { daemonIdentity: identity });
  try {
    expect(await inspectDaemonCompatibility(socketPath, identity)).toMatchObject({ status: { protocolVersion: 1, upgradePreparationVersion: 1 } });
    expect(await requestControl(socketPath, { kind: "upgrade-preparation", request: { operation: "preview", installedDaemonIdentity: "d".repeat(64), candidate } })).toEqual({ kind: "error", reason: "invalid-request" });
    const participant = host.upgradePreparation.registerParticipant({ id: "test:trusted-host", revision: "revision-1" });
    const preview = await requestControl(socketPath, { kind: "upgrade-preparation", request: { operation: "preview", installedDaemonIdentity: identity, candidate } });
    if (preview.kind !== "upgrade-preparation" || !("token" in preview.result)) throw new Error("Expected installer credentials");
    const credentials = { attemptId: preview.result.attemptId, token: preview.result.token, candidate };
    await requestControl(socketPath, { kind: "upgrade-preparation", request: { operation: "begin", credentials, consent: true } });
    expect((await requestControl(socketPath, { kind: "management", protocolVersion: 1, operation: "shutdown-if-idle" }))).toMatchObject({ result: { status: "refused" } });
    const id = "00000000-0000-4000-8000-000000000000";
    expect((await fetch(`${host.server.origin}/s/${id}/bootstrap`)).status).toBe(503);
    const { request: httpRequest } = await import("node:http");
    const normalizedAdmission = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(host.server.origin, { path: `/s/${id}\\bootstrap` }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); });
      request.once("error", reject); request.end();
    });
    expect(normalizedAdmission).toBe(503);
    // Settlement reaches its existing authentication checks instead of being
    // rejected at lifecycle admission; this does not grant a session cookie.
    expect((await fetch(`${host.server.origin}/s/${id}/save/status`)).status).not.toBe(503);
    const poll = await requestControl(socketPath, { kind: "upgrade-preparation", request: { operation: "participant-poll", participant } });
    expect(poll).toMatchObject({ result: { phase: "preparing" } });
    expect(poll).not.toHaveProperty("result.token");
    await requestControl(socketPath, { kind: "upgrade-preparation", request: { operation: "participant-ack", participant, credentials: { attemptId: credentials.attemptId, candidate }, acknowledgement: { revision: "revision-1", reviewRevisionDurable: true, protectedDraftDurable: false, pdfSaveSettled: true } } });
    expect(host.lifecycle.admissionAllowed()).toBe(true);
    expect((await fetch(`${host.server.origin}/s/${id}/bootstrap`)).status).not.toBe(503);
    const next = host.upgradePreparation.preview(identity, candidate);
    const finalCredentials = { attemptId: next.attemptId, token: next.token, candidate };
    host.upgradePreparation.begin(finalCredentials, true);
    await host.prepareUpgradeTasks();
    host.upgradePreparation.acknowledge(participant, finalCredentials, { revision: "revision-1", reviewRevisionDurable: true, protectedDraftDurable: true, pdfSaveSettled: true });
    host.upgradePreparation.commit(finalCredentials);
    expect(await requestControl(socketPath, { kind: "management", protocolVersion: 1, operation: "shutdown-if-idle" })).toMatchObject({ result: { status: "refused" } });
    expect(await requestControl(socketPath, { kind: "management", protocolVersion: 1, operation: "shutdown-if-idle", preparation: { ...finalCredentials, candidate: { ...candidate, installArtifactIdentity: "e".repeat(64) } } })).toMatchObject({ result: { status: "refused" } });
    expect(await requestControl(socketPath, { kind: "management", protocolVersion: 1, operation: "shutdown-if-idle", preparation: finalCredentials })).toMatchObject({ result: { status: "accepted" } });
  } finally { await control.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});

it("keeps all peers open until trusted coverage accounts for every host and Codex task", () => {
  const lifecycle = new DaemonLifecycleCoordinator({ activity: () => ({ reviewPresence: 4, codexTasks: 1, transientWork: 0 }), drain: async () => {} });
  const preparation = new UpgradePreparationCoordinator(lifecycle);
  const participant = preparation.registerParticipant({ id: "electron:known-helper", revision: "revision-1" });
  const preview = preparation.preview("a".repeat(64), candidate);
  const credentials = { attemptId: preview.attemptId, token: preview.token, candidate };
  preparation.begin(credentials, true);
  preparation.acknowledge(participant, credentials, { revision: "revision-1", reviewRevisionDurable: true, protectedDraftDurable: true, pdfSaveSettled: true });
  expect(preparation.status(credentials)).toMatchObject({ phase: "preparing", reason: expect.stringContaining("no protected preparation participant") });
  expect(() => preparation.commit(credentials)).toThrow("coverage");
  expect(preparation.poll(participant)?.phase).toBe("preparing");
  preparation.cancel(credentials);
  expect(lifecycle.admissionAllowed()).toBe(true);
});
it("binds idle retirement to the still-committed attempt and rechecks cancellation during drain", async () => {
  const drain = Promise.withResolvers<void>();
  const lifecycle = new DaemonLifecycleCoordinator({ activity: () => ({ reviewPresence: 0, codexTasks: 0, transientWork: 0 }), drain: () => drain.promise });
  const preparation = new UpgradePreparationCoordinator(lifecycle);
  const preview = preparation.preview("a".repeat(64), candidate);
  const credentials = { attemptId: preview.attemptId, token: preview.token, candidate };
  preparation.begin(credentials, true); preparation.commit(credentials);
  expect(await lifecycle.shutdownIfIdle()).toMatchObject({ status: "refused" });
  const shutdown = lifecycle.shutdownIfIdle({ authorize: () => preparation.status(credentials).phase === "committed" });
  preparation.cancel(credentials); drain.resolve();
  expect(await shutdown).toMatchObject({ status: "refused" });
  expect(lifecycle.admissionAllowed()).toBe(true);
});

it("allows authenticated active Codex settlement while refusing new presentation admission", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const { PlacekeeperHost } = await import("../src/host/placekeeper-host.js");
  const { startLaunchControlServer, requestControl } = await import("../src/host/launch-control.js");
  const root = await mkdtemp(join(tmpdir(), "pk-codex-settlement-"));
  const assets = join(root, "assets"); await mkdir(assets);
  const pdf = join(root, "paper.pdf");
  const { copyFile } = await import("node:fs/promises");
  await copyFile("test/fixtures/pdfs/text-native.pdf", pdf);
  await writeFile(join(assets, "pdfium.wasm"), "engine");
  await writeFile(join(assets, "pdfium-codex-worker.js"), "worker");
  const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets }, port: 0 });
  const socketPath = join(root, "control.sock");
  const control = await startLaunchControlServer(host, socketPath, { daemonIdentity: "a".repeat(64) });
  try {
    const launch = await host.open({ pdfPath: pdf, surface: "codex-native" });
    if (!launch.ok || !("handoff" in launch)) throw new Error("Expected Codex launch");
    expect(host.codexRuntime.claimLaunch({ bindProof: launch.bindProof, reviewSessionId: launch.sessionId, documentGeneration: launch.documentGeneration, taskSessionId: "upgrade-settlement-task" })).toBe(true);
    const display = host.codexRuntime.display(launch.handoff.token);
    if (!display) throw new Error("Expected Codex display");
    expect(host.codexRuntime.attestDisplay(display.receipt, "upgrade-settlement-task")).toBe(true);
    const meta = display.privateMeta;
    const pending = { protocolVersion: 1 as const, runtimeId: meta.runtimeId, attemptId: meta.attemptId, requestId: randomUUID(), generation: meta.generation, capability: meta.pendingCapability, authority: "pending" as const, method: "ready" as const, payload: {} };
    const active = await host.codexRuntime.pending(pending);
    if (active.status !== "active") throw new Error("Expected active Codex panel");
    const presentation = { ...pending, runtimeId: active.runtimeId, attemptId: active.attemptId, generation: active.generation, capability: active.presentationCapability, authority: "presentation" as const };
    host.lifecycle.freezeAdmission();
    expect(await requestControl(socketPath, { kind: "codex-app", request: pending })).toEqual({ kind: "error", reason: "unavailable" });
    expect(await requestControl(socketPath, { kind: "codex-app", request: { ...pending, authority: "reconnect", method: "reconnect", capability: active.reconnectTicket } })).toEqual({ kind: "error", reason: "unavailable" });
    expect(await requestControl(socketPath, { kind: "codex-app", request: { ...presentation, requestId: randomUUID(), method: "bootstrap", capability: "z".repeat(43) } })).toMatchObject({ kind: "codex-app", response: { status: "denied" } });
    expect(await requestControl(socketPath, { kind: "codex-app", request: { ...presentation, requestId: randomUUID(), method: "bootstrap" } })).toMatchObject({ kind: "codex-app", response: { status: "ok" } });
    expect(await requestControl(socketPath, { kind: "codex-app", request: { ...presentation, requestId: randomUUID(), method: "detach" } })).toMatchObject({ kind: "codex-app", response: { status: "ok" } });
    expect(host.broker.taskBindings.bindingForTask("upgrade-settlement-task")).toBeUndefined();
  } finally { host.lifecycle.resumeAdmission(); await control.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});
